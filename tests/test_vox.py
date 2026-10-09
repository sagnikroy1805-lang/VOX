"""VOX test-suite.   Run:  python -m pytest -q tests"""
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from vox import audio, datasets, engines, metrics, pipeline  # noqa: E402

SAMPLES = ROOT / "data" / "samples" / "manifest.csv"


# ------------------------------------------------------------- metrics
@pytest.mark.parametrize("ref,hyp", [
    ("the cat sat on the mat", "the cat sat on mat"),
    ("the cat sat on the mat", "a cat sat on the hat today"),
    ("hello world", ""),
    ("one two three four", "four three two one"),
])
def test_wer_cer_match_jiwer(ref, hyp):
    jiwer = pytest.importorskip("jiwer")
    assert metrics.wer(ref, hyp, normalize=False) == pytest.approx(jiwer.wer(ref, hyp) if hyp else 1.0)
    if hyp:
        assert metrics.cer(ref, hyp, normalize=False) == pytest.approx(jiwer.cer(ref, hyp))


def test_wer_counts():
    d = metrics.wer_details("a b c d", "a x c d e")
    assert (d["S"], d["D"], d["I"], d["N"]) == (1, 0, 1, 4)


def test_normalisation():
    assert metrics.normalize_text("Hello, Mr. Smith! It's 1923.") == \
        "hello mister smith it's one thousand nine hundred twenty three"
    assert metrics.wer("HELLO WORLD", "Hello, world!") == 0.0


# --------------------------------------------------------------- audio
def test_resample_length():
    y = np.random.randn(44100).astype(np.float32)
    assert len(audio.resample(y, 44100)) == 16000


def test_trim_removes_silence():
    sr = 16000
    tone = np.sin(2 * np.pi * 440 * np.arange(sr) / sr).astype(np.float32)
    y = np.concatenate([np.zeros(sr), tone, np.zeros(sr)])
    t = audio.trim_silence(y)
    assert 0.9 * sr < len(t) < 1.1 * sr


def test_add_noise_snr():
    y = np.sin(np.linspace(0, 1000, 16000)).astype(np.float32)
    noisy = audio.add_noise(y, 10.0, seed=1)
    snr = 10 * np.log10(np.mean(y ** 2) / np.mean((noisy - y) ** 2))
    assert snr == pytest.approx(10.0, abs=0.3)


def test_log_mel_shape_and_filters():
    lm = audio.log_mel_spectrogram(np.random.randn(16000).astype(np.float32))
    assert lm.shape == (80, 98)
    assert (audio.mel_filterbank().sum(axis=1) > 0).all()     # no empty filter


def test_preprocess_sample():
    rec = datasets.load_manifest(SAMPLES, limit=1)[0]
    y, info = audio.preprocess(rec["path"])
    assert info["processed_s"] < info["duration_s"]            # silence trimmed
    assert np.abs(y).max() == pytest.approx(0.95, abs=1e-3)    # peak-normalised


# ------------------------------------------------------------ pipeline
def test_pipeline_handles_bad_file(tmp_path):
    pytest.importorskip("pocketsphinx")
    bad = tmp_path / "broken.wav"
    bad.write_bytes(b"not audio")
    good = datasets.load_manifest(SAMPLES, limit=1)[0]
    out = pipeline.process_records([good, {"id": "bad", "path": str(bad), "reference": "x"}],
                                   "pocketsphinx")
    assert out[0]["error"] is None and out[0]["hypothesis"]
    assert out[1]["error"].startswith("preprocess")


@pytest.mark.skipif(not engines.java_available(), reason="Java not installed")
def test_spark_equals_single_node():
    pytest.importorskip("pocketsphinx")
    recs = datasets.load_manifest(SAMPLES, limit=6)
    a, _ = engines.LocalEngine().run(recs, "pocketsphinx")
    b, s = engines.SparkEngine("local[2]").run(recs, "pocketsphinx")
    engines.stop_spark()
    a, b = a.sort_values("id"), b.sort_values("id")
    assert list(a["hypothesis"]) == list(b["hypothesis"])      # identical transcripts
    assert s["files"] == 6 and s["failed"] == 0


# ------------------------------------------------------- multilingual
def test_spanish_normalisation_keeps_accents():
    assert metrics.normalize_text("¿Cómo estás, señor? ¡Muy bien!", "es") == "cómo estás señor muy bien"
    assert metrics.wer("El perro corre.", "el perro corre", lang="es") == 0.0


def test_japanese_scored_per_character_in_kana():
    pytest.importorskip("pykakasi")
    # same sentence, different scripts (kanji vs hiragana) -> no errors
    assert metrics.wer("わたしはがくせいです。", "私は学生です", lang="ja") == 0.0
    d = metrics.wer_details("すしがすきです", "すしがきらいです", lang="ja")
    assert d["N"] == 7 and d["errors"] > 0          # tokens are characters


def test_language_guard():
    from vox import models
    models.check_language("whisper-tiny", "ja")      # ok
    with pytest.raises(ValueError):
        models.check_language("wav2vec2-base", "es")
    with pytest.raises(ValueError):
        models.check_language("pocketsphinx", None, "translate")
