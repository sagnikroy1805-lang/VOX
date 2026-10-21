"""Pretrained ASR model backends.

    whisper-*         OpenAI Whisper - attention encoder-decoder (Transformer),
                      trained on 680k h of weakly-supervised MULTILINGUAL audio
                      (99 languages). Can auto-detect the language and can also
                      translate speech in any language directly into English.
    wav2vec2-base     Meta wav2vec 2.0 - self-supervised Transformer encoder +
                      CTC head, fine-tuned on 960 h English LibriSpeech.
    wav2vec2-xlsr-es  wav2vec 2.0 XLSR-53 (pre-trained on 53 languages)
    wav2vec2-xlsr-ja  fine-tuned with CTC on Spanish / Japanese Common Voice.
    pocketsphinx      CMU PocketSphinx - classical HMM-GMM recogniser with an
                      n-gram language model (English, offline baseline).

Every backend exposes transcribe_batch(waves, language, task) -> list[dict]
with keys {"text", "language"}. Models are cached per Python process, so a
Spark worker loads a model ONCE and reuses it for every partition it handles.
"""
# WHAT THIS FILE DOES: STAGE 2 of the pipeline. Wraps every speech-recognition
# model behind ONE common function, transcribe_batch(waves, language, task),
# so the rest of VOX never needs to know which model it is using.

from __future__ import annotations   # allows modern type hints

import threading        # a Lock so two threads never load the same model at once
import time             # measure how long model loading takes

import numpy as np      # waveforms are numpy arrays

from . import config    # TARGET_SR = 16000

# Languages VOX supports: code -> display name
LANGUAGES = {"en": "English", "es": "Spanish", "ja": "Japanese"}

# Registry of every model choice: HuggingFace repo, family (which class runs it),
# size, languages it supports, and a one-line architecture description.
MODEL_INFO = {
    "whisper-tiny": {"hf": "openai/whisper-tiny", "family": "whisper", "params": "39M",
                     "langs": ["en", "es", "ja"], "multilingual": True,
                     "arch": "Transformer encoder-decoder (attention, seq2seq)"},
    "whisper-base": {"hf": "openai/whisper-base", "family": "whisper", "params": "74M",
                     "langs": ["en", "es", "ja"], "multilingual": True,
                     "arch": "Transformer encoder-decoder (attention, seq2seq)"},
    "whisper-small": {"hf": "openai/whisper-small", "family": "whisper", "params": "244M",
                      "langs": ["en", "es", "ja"], "multilingual": True,
                      "arch": "Transformer encoder-decoder (attention, seq2seq)"},
    "wav2vec2-base": {"hf": "facebook/wav2vec2-base-960h", "family": "wav2vec2", "params": "95M",
                      "langs": ["en"], "multilingual": False,
                      "arch": "Self-supervised CNN+Transformer encoder with CTC head"},
    "wav2vec2-xlsr-es": {"hf": "jonatasgrosman/wav2vec2-large-xlsr-53-spanish",
                         "family": "wav2vec2", "params": "315M", "langs": ["es"],
                         "multilingual": False,
                         "arch": "XLSR-53 cross-lingual wav2vec 2.0 + CTC (Spanish)"},
    "wav2vec2-xlsr-ja": {"hf": "jonatasgrosman/wav2vec2-large-xlsr-53-japanese",
                         "family": "wav2vec2", "params": "315M", "langs": ["ja"],
                         "multilingual": False,
                         "arch": "XLSR-53 cross-lingual wav2vec 2.0 + CTC (Japanese)"},
    "pocketsphinx": {"hf": None, "family": "pocketsphinx", "params": "~10M (GMM)",
                     "langs": ["en"], "multilingual": False,
                     "arch": "Classical HMM-GMM + 3-gram LM (non-deep baseline)"},
}

CHUNK_S = 30  # Whisper's receptive window is exactly 30 s


def _chunks(y: np.ndarray, seconds: int = CHUNK_S):
    # Split long audio into 30-second pieces (Whisper can only see 30 s at a time).
    step = seconds * config.TARGET_SR                   # 30 s x 16000 = 480,000 samples
    return [y[i:i + step] for i in range(0, max(len(y), 1), step)] or [y]


def _join(parts: list[str], lang: str | None) -> str:
    # Join the texts of the 30 s pieces back into one transcript.
    sep = "" if lang == "ja" else " "          # Japanese is written without spaces
    return sep.join(p.strip() for p in parts if p.strip()).strip()


class ASRModel:
    # Base class: every model type below inherits from this and must
    # implement transcribe_batch(). This gives all models the same interface.
    name = "base"

    def default_language(self):
        # First language the model supports (e.g. "en")
        return MODEL_INFO[self.name]["langs"][0]

    def transcribe_batch(self, waves, language=None, task="transcribe") -> list[dict]:
        # Must be written by each subclass: list of waveforms -> list of {text, language}
        raise NotImplementedError

    def transcribe(self, y, language=None, task="transcribe") -> dict:
        # Convenience for ONE waveform (used by the Transcribe tab): a batch of size 1
        return self.transcribe_batch([y], language, task)[0]


class _HFChunkedModel(ASRModel):
    """Shared long-audio handling: split >30 s audio, batch chunks, re-join."""
    batch_size = 8      # how many 30 s chunks go through the neural network at once

    def transcribe_batch(self, waves, language=None, task="transcribe"):
        flat, owner = [], []                    # all chunks in one list + which file each came from
        for i, y in enumerate(waves):
            for c in _chunks(y):
                # an empty chunk becomes 0.1 s of silence so the model does not crash
                flat.append(c if len(c) else np.zeros(config.TARGET_SR // 10, np.float32))
                owner.append(i)                 # remember: this chunk belongs to file i
        outs = []
        for s in range(0, len(flat), self.batch_size):     # 8 chunks at a time
            outs += self._infer(flat[s:s + self.batch_size], language, task)   # -> [(text, lang), ...]
        texts = [[] for _ in waves]             # one list of texts per file
        langs = [[] for _ in waves]             # one list of languages per file
        for i, (t, lg) in zip(owner, outs):     # give each chunk's result back to its file
            texts[i].append(t)
            langs[i].append(lg)
        res = []
        for t, lg in zip(texts, langs):
            lang = max(set(lg), key=lg.count) if lg else language   # most common language among the chunks
            res.append({"text": _join(t, lang), "language": lang})  # final result for this file
        return res


class WhisperModel(_HFChunkedModel):
    # OpenAI Whisper: encoder-decoder Transformer that writes text token by token.
    def __init__(self, name):
        import torch                                     # PyTorch runs the neural network
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        self.name, self.torch = name, torch
        repo = MODEL_INFO[name]["hf"]                    # e.g. "openai/whisper-tiny"
        self.device = "cuda" if torch.cuda.is_available() else "cpu"   # use a GPU if there is one
        # processor = turns audio into the 80 x 3000 log-mel input, and tokens back into text
        self.processor = WhisperProcessor.from_pretrained(repo)
        # the model itself (weights downloaded once into models_cache/); eval() = inference mode
        self.model = WhisperForConditionalGeneration.from_pretrained(repo).to(self.device).eval()

    def _detect(self, feats) -> list[str | None]:
        """Whisper language identification: one decoder step over the
        language tokens, returning e.g. ['ja', 'es', ...] per input."""
        g = self.model.generation_config
        # map token ids back to language codes, e.g. id of "<|ja|>" -> "ja"
        id2lang = {v: k.strip("<|>") for k, v in getattr(g, "lang_to_id", {}).items()}
        with self.torch.inference_mode():                # no gradients needed (we never train)
            ids = self.model.detect_language(feats)      # most likely language token per clip
        return [id2lang.get(int(i)) for i in ids.reshape(-1)]

    def _infer(self, batch, language=None, task="transcribe"):
        # 1. waveforms -> 80 x 3000 log-mel features (padded to 30 s), moved to CPU/GPU
        feats = self.processor(batch, sampling_rate=config.TARGET_SR,
                               return_tensors="pt").input_features.to(self.device)
        # None -> detect the language of every clip first, then decode each
        # language group with the right <|lang|> prompt token.
        langs = [language] * len(batch) if language else self._detect(feats)
        out = [None] * len(batch)                        # result slot for every clip
        for lg in dict.fromkeys(langs):                  # each distinct language once
            idx = [i for i, x in enumerate(langs) if x == lg]   # clips in this language
            kw = {"task": task, "max_new_tokens": 220}   # task = "transcribe" or "translate"
            if lg:
                kw["language"] = lg                      # tell the decoder which language to write
            with self.torch.inference_mode():
                ids = self.model.generate(feats[idx], **kw)    # 2. decoder writes token ids (greedy)
            # 3. token ids -> text, without special tokens like <|en|>
            for i, t in zip(idx, self.processor.batch_decode(ids, skip_special_tokens=True)):
                out[i] = (t.strip(), lg)
        return out                                       # [(text, language), ...]


class Wav2Vec2Model(_HFChunkedModel):
    # Meta wav2vec 2.0 / XLSR: Transformer encoder + CTC (one character per 20 ms frame).
    def __init__(self, name):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        self.name, self.torch = name, torch
        repo = MODEL_INFO[name]["hf"]                    # e.g. "facebook/wav2vec2-base-960h"
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = Wav2Vec2Processor.from_pretrained(repo)   # normalises audio, decodes characters
        self.model = Wav2Vec2ForCTC.from_pretrained(repo).to(self.device).eval()
        self.lang = MODEL_INFO[name]["langs"][0]         # each wav2vec2 model knows one language

    def _infer(self, batch, language=None, task="transcribe"):
        # raw waveforms in (no spectrogram); padding makes all clips in the batch equal length
        inp = self.processor(batch, sampling_rate=config.TARGET_SR, return_tensors="pt",
                             padding=True)
        with self.torch.inference_mode():
            # logits = a score for every character (+ blank) in every 20 ms frame
            logits = self.model(inp.input_values.to(self.device),
                                attention_mask=getattr(inp, "attention_mask", None)).logits
        ids = logits.argmax(dim=-1)                     # greedy CTC decoding
        # batch_decode merges repeated characters and removes blanks -> text (lower-cased)
        return [(t.lower(), self.lang) for t in self.processor.batch_decode(ids)]


class PocketSphinxModel(ASRModel):
    # CMU PocketSphinx: classical (non-deep-learning) HMM-GMM recogniser, the baseline.
    def __init__(self, name="pocketsphinx"):
        from pocketsphinx import Decoder
        self.name = name
        self.decoder = Decoder(samprate=config.TARGET_SR, loglevel="FATAL")   # 16 kHz, no log spam
        # PocketSphinx adapts its cepstral mean (CMN) across utterances; we
        # reset it before each file so results don't depend on file order
        # (otherwise Spark partitioning would change the transcripts).

    def transcribe_batch(self, waves, language=None, task="transcribe"):
        out = []
        for y in waves:                                  # PocketSphinx does one file at a time
            pcm = (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()   # float -> 16-bit PCM bytes
            self.decoder.reinit_feat()          # fresh CMN state per file
            self.decoder.start_utt()                     # start an utterance
            self.decoder.process_raw(pcm, full_utt=True) # feed the whole audio
            self.decoder.end_utt()                       # finish -> run the Viterbi search
            hyp = self.decoder.hyp()                     # best hypothesis (may be None)
            out.append({"text": hyp.hypstr if hyp else "", "language": "en"})
        return out


# family name -> class that runs it
_BACKENDS = {"whisper": WhisperModel, "wav2vec2": Wav2Vec2Model,
             "pocketsphinx": PocketSphinxModel}
_CACHE: dict[str, ASRModel] = {}    # models already loaded in THIS Python process
_LOCK = threading.Lock()            # protects _CACHE when several threads ask at once
LOAD_TIMES: dict[str, float] = {}   # how many seconds each model took to load


def set_torch_threads(n: int):
    # How many CPU threads PyTorch may use. Spark workers use 1 each (no over-subscription).
    try:
        import torch
        torch.set_num_threads(max(1, n))
    except Exception:
        pass                         # PyTorch not installed (e.g. PocketSphinx only) -> ignore


def get_model(name: str) -> ASRModel:
    """Load (once per process) and return an ASR model by registry name."""
    if name not in MODEL_INFO:       # unknown name -> clear error message
        raise ValueError(f"Unknown model '{name}'. Choose from {list(MODEL_INFO)}")
    with _LOCK:                      # only one thread may load at a time
        if name not in _CACHE:       # first request in this process -> load it now
            t0 = time.perf_counter()
            _CACHE[name] = _BACKENDS[MODEL_INFO[name]["family"]](name)   # create the right class
            LOAD_TIMES[name] = time.perf_counter() - t0                  # remember load time
        return _CACHE[name]          # every later call returns the already-loaded model


def check_language(name: str, language: str | None, task: str = "transcribe"):
    """Raise a clear error if the model cannot handle the requested language."""
    info = MODEL_INFO[name]
    if task == "translate" and not info["multilingual"]:     # only Whisper can translate
        raise ValueError(f"{name} cannot translate - choose a Whisper model.")
    if language and language not in info["langs"]:           # e.g. wav2vec2-base + Japanese
        raise ValueError(f"{name} only supports {', '.join(LANGUAGES[l] for l in info['langs'])}. "
                         f"Choose a Whisper model for {LANGUAGES.get(language, language)}.")


def available_models() -> list[dict]:
    """Which backends can run in this environment (dependency check only)."""
    import importlib.util as iu
    # are the libraries installed? (checks without importing them, so it is fast)
    has_hf = iu.find_spec("torch") is not None and iu.find_spec("transformers") is not None
    has_ps = iu.find_spec("pocketsphinx") is not None
    res = []
    for k, v in MODEL_INFO.items():
        ok = has_ps if v["family"] == "pocketsphinx" else has_hf
        # one entry per model for the website dropdown (available? already loaded?)
        res.append({"name": k, "available": ok, "loaded": k in _CACHE, **v})
    return res
