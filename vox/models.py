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
from __future__ import annotations

import threading
import time

import numpy as np

from . import config

LANGUAGES = {"en": "English", "es": "Spanish", "ja": "Japanese"}

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
    step = seconds * config.TARGET_SR
    return [y[i:i + step] for i in range(0, max(len(y), 1), step)] or [y]


def _join(parts: list[str], lang: str | None) -> str:
    sep = "" if lang == "ja" else " "          # Japanese is written without spaces
    return sep.join(p.strip() for p in parts if p.strip()).strip()


class ASRModel:
    name = "base"

    def default_language(self):
        return MODEL_INFO[self.name]["langs"][0]

    def transcribe_batch(self, waves, language=None, task="transcribe") -> list[dict]:
        raise NotImplementedError

    def transcribe(self, y, language=None, task="transcribe") -> dict:
        return self.transcribe_batch([y], language, task)[0]


class _HFChunkedModel(ASRModel):
    """Shared long-audio handling: split >30 s audio, batch chunks, re-join."""
    batch_size = 8

    def transcribe_batch(self, waves, language=None, task="transcribe"):
        flat, owner = [], []
        for i, y in enumerate(waves):
            for c in _chunks(y):
                flat.append(c if len(c) else np.zeros(config.TARGET_SR // 10, np.float32))
                owner.append(i)
        outs = []
        for s in range(0, len(flat), self.batch_size):
            outs += self._infer(flat[s:s + self.batch_size], language, task)
        texts = [[] for _ in waves]
        langs = [[] for _ in waves]
        for i, (t, lg) in zip(owner, outs):
            texts[i].append(t)
            langs[i].append(lg)
        res = []
        for t, lg in zip(texts, langs):
            lang = max(set(lg), key=lg.count) if lg else language
            res.append({"text": _join(t, lang), "language": lang})
        return res


class WhisperModel(_HFChunkedModel):
    def __init__(self, name):
        import torch
        from transformers import WhisperForConditionalGeneration, WhisperProcessor
        self.name, self.torch = name, torch
        repo = MODEL_INFO[name]["hf"]
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = WhisperProcessor.from_pretrained(repo)
        self.model = WhisperForConditionalGeneration.from_pretrained(repo).to(self.device).eval()

    def _detect(self, feats) -> list[str | None]:
        """Whisper language identification: one decoder step over the
        language tokens, returning e.g. ['ja', 'es', ...] per input."""
        g = self.model.generation_config
        id2lang = {v: k.strip("<|>") for k, v in getattr(g, "lang_to_id", {}).items()}
        with self.torch.inference_mode():
            ids = self.model.detect_language(feats)
        return [id2lang.get(int(i)) for i in ids.reshape(-1)]

    def _infer(self, batch, language=None, task="transcribe"):
        feats = self.processor(batch, sampling_rate=config.TARGET_SR,
                               return_tensors="pt").input_features.to(self.device)
        # None -> detect the language of every clip first, then decode each
        # language group with the right <|lang|> prompt token.
        langs = [language] * len(batch) if language else self._detect(feats)
        out = [None] * len(batch)
        for lg in dict.fromkeys(langs):
            idx = [i for i, x in enumerate(langs) if x == lg]
            kw = {"task": task, "max_new_tokens": 220}
            if lg:
                kw["language"] = lg
            with self.torch.inference_mode():
                ids = self.model.generate(feats[idx], **kw)
            for i, t in zip(idx, self.processor.batch_decode(ids, skip_special_tokens=True)):
                out[i] = (t.strip(), lg)
        return out


class Wav2Vec2Model(_HFChunkedModel):
    def __init__(self, name):
        import torch
        from transformers import Wav2Vec2ForCTC, Wav2Vec2Processor
        self.name, self.torch = name, torch
        repo = MODEL_INFO[name]["hf"]
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.processor = Wav2Vec2Processor.from_pretrained(repo)
        self.model = Wav2Vec2ForCTC.from_pretrained(repo).to(self.device).eval()
        self.lang = MODEL_INFO[name]["langs"][0]

    def _infer(self, batch, language=None, task="transcribe"):
        inp = self.processor(batch, sampling_rate=config.TARGET_SR, return_tensors="pt",
                             padding=True)
        with self.torch.inference_mode():
            logits = self.model(inp.input_values.to(self.device),
                                attention_mask=getattr(inp, "attention_mask", None)).logits
        ids = logits.argmax(dim=-1)                     # greedy CTC decoding
        return [(t.lower(), self.lang) for t in self.processor.batch_decode(ids)]


class PocketSphinxModel(ASRModel):
    def __init__(self, name="pocketsphinx"):
        from pocketsphinx import Decoder
        self.name = name
        self.decoder = Decoder(samprate=config.TARGET_SR, loglevel="FATAL")
        # PocketSphinx adapts its cepstral mean (CMN) across utterances; we
        # reset it before each file so results don't depend on file order
        # (otherwise Spark partitioning would change the transcripts).

    def transcribe_batch(self, waves, language=None, task="transcribe"):
        out = []
        for y in waves:
            pcm = (np.clip(y, -1, 1) * 32767).astype("<i2").tobytes()
            self.decoder.reinit_feat()          # fresh CMN state per file
            self.decoder.start_utt()
            self.decoder.process_raw(pcm, full_utt=True)
            self.decoder.end_utt()
            hyp = self.decoder.hyp()
            out.append({"text": hyp.hypstr if hyp else "", "language": "en"})
        return out


_BACKENDS = {"whisper": WhisperModel, "wav2vec2": Wav2Vec2Model,
             "pocketsphinx": PocketSphinxModel}
_CACHE: dict[str, ASRModel] = {}
_LOCK = threading.Lock()
LOAD_TIMES: dict[str, float] = {}


def set_torch_threads(n: int):
    try:
        import torch
        torch.set_num_threads(max(1, n))
    except Exception:
        pass


def get_model(name: str) -> ASRModel:
    """Load (once per process) and return an ASR model by registry name."""
    if name not in MODEL_INFO:
        raise ValueError(f"Unknown model '{name}'. Choose from {list(MODEL_INFO)}")
    with _LOCK:
        if name not in _CACHE:
            t0 = time.perf_counter()
            _CACHE[name] = _BACKENDS[MODEL_INFO[name]["family"]](name)
            LOAD_TIMES[name] = time.perf_counter() - t0
        return _CACHE[name]


def check_language(name: str, language: str | None, task: str = "transcribe"):
    """Raise a clear error if the model cannot handle the requested language."""
    info = MODEL_INFO[name]
    if task == "translate" and not info["multilingual"]:
        raise ValueError(f"{name} cannot translate - choose a Whisper model.")
    if language and language not in info["langs"]:
        raise ValueError(f"{name} only supports {', '.join(LANGUAGES[l] for l in info['langs'])}. "
                         f"Choose a Whisper model for {LANGUAGES.get(language, language)}.")


def available_models() -> list[dict]:
    """Which backends can run in this environment (dependency check only)."""
    import importlib.util as iu
    has_hf = iu.find_spec("torch") is not None and iu.find_spec("transformers") is not None
    has_ps = iu.find_spec("pocketsphinx") is not None
    res = []
    for k, v in MODEL_INFO.items():
        ok = has_ps if v["family"] == "pocketsphinx" else has_hf
        res.append({"name": k, "available": ok, "loaded": k in _CACHE, **v})
    return res
