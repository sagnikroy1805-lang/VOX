"""Dataset handling: manifests, LibriSpeech download, folder scanning.

A *manifest* is a CSV with columns  id, path, reference
(path may be relative to the manifest's folder; reference may be empty).
Manifests are what get turned into Spark DataFrames - one row per utterance.
"""
from __future__ import annotations

import csv
import io
import tarfile
import urllib.request
from pathlib import Path

from . import config

AUDIO_EXT = {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".webm", ".opus", ".aiff", ".aif"}


def load_manifest(manifest: str | Path, limit: int | None = None) -> list[dict]:
    manifest = Path(manifest)
    base = manifest.parent
    rows = []
    with open(manifest, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            p = Path(r["path"])
            if not p.is_absolute():
                p = (base / p).resolve()
            rows.append({"id": r.get("id") or p.stem, "path": str(p),
                         "reference": (r.get("reference") or "").strip(),
                         "language": (r.get("language") or "").strip()})
            if limit and len(rows) >= limit:
                break
    return rows


def write_manifest(rows: list[dict], manifest: Path) -> Path:
    manifest.parent.mkdir(parents=True, exist_ok=True)
    with open(manifest, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["id", "path", "reference", "language"])
        w.writeheader()
        for r in rows:
            w.writerow({"id": r["id"], "path": r["path"], "reference": r.get("reference", ""),
                        "language": r.get("language", "")})
    return manifest


def scan_folder(folder: str | Path) -> list[dict]:
    """Build records from a folder of audio files.

    References are picked up from LibriSpeech *.trans.txt files or from a
    sidecar <name>.txt next to each audio file, when present.
    """
    folder = Path(folder)
    refs = {}
    for t in folder.rglob("*.trans.txt"):
        for line in t.read_text(encoding="utf-8").splitlines():
            if " " in line:
                k, v = line.split(" ", 1)
                refs[k] = v
    rows = []
    for p in sorted(folder.rglob("*")):
        if p.suffix.lower() in AUDIO_EXT:
            side = p.with_suffix(".txt")
            ref = refs.get(p.stem) or (side.read_text(encoding="utf-8").strip()
                                       if side.exists() else "")
            rows.append({"id": p.stem, "path": str(p.resolve()), "reference": ref})
    return rows


# ------------------------------------------------------------------ download
def download_librispeech_dummy(dest: Path | None = None) -> Path:
    """73 real LibriSpeech utterances (~9 MB) from the HuggingFace Hub."""
    import pandas as pd
    from huggingface_hub import HfApi, hf_hub_download

    repo = "hf-internal-testing/librispeech_asr_dummy"
    dest = Path(dest or config.DATA_DIR / "librispeech_dummy")
    dest.mkdir(parents=True, exist_ok=True)
    api = HfApi()
    revision = None
    files = [f for f in api.list_repo_files(repo, repo_type="dataset") if f.endswith(".parquet")]
    if not files:
        revision = "refs/convert/parquet"
        files = [f for f in api.list_repo_files(repo, repo_type="dataset", revision=revision)
                 if f.endswith(".parquet")]
    files = [f for f in files if "clean" in f] or files
    rows = []
    for f in files:
        local = hf_hub_download(repo, f, repo_type="dataset", revision=revision)
        df = pd.read_parquet(local)
        for _, r in df.iterrows():
            uid = str(r.get("id") or Path(r["audio"]["path"]).stem)
            out = dest / f"{uid}.flac"
            if not out.exists():
                out.write_bytes(r["audio"]["bytes"])
            rows.append({"id": uid, "path": out.name, "reference": r["text"]})
    return write_manifest(rows, dest / "manifest.csv")


def download_librispeech(subset: str = "test-clean", limit: int | None = None,
                         dest: Path | None = None) -> Path:
    """Stream a LibriSpeech subset from openslr.org (test-clean is ~346 MB).

    `limit` stops after N utterances so you don't have to extract everything.
    """
    url = f"https://www.openslr.org/resources/12/{subset}.tar.gz"
    dest = Path(dest or config.DATA_DIR / f"librispeech_{subset}")
    dest.mkdir(parents=True, exist_ok=True)
    refs, written = {}, []
    print(f"Downloading {url} (streaming) ...")
    with urllib.request.urlopen(url) as resp, tarfile.open(fileobj=resp, mode="r|gz") as tar:
        for m in tar:
            if m.name.endswith(".trans.txt"):
                for line in tar.extractfile(m).read().decode().splitlines():
                    k, v = line.split(" ", 1)
                    refs[k] = v
            elif m.name.endswith(".flac") and not (limit and len(written) >= limit):
                out = dest / Path(m.name).name
                out.write_bytes(tar.extractfile(m).read())
                written.append(out)
            # transcripts come after their chapter's audio in the tar, so
            # after reaching `limit` keep reading until every file has one.
            if limit and len(written) >= limit and all(p.stem in refs for p in written):
                break
    rows = [{"id": p.stem, "path": p.name, "reference": refs.get(p.stem, "")} for p in written]
    return write_manifest(rows, dest / "manifest.csv")


FLEURS_CONFIGS = {"es": "es_419", "ja": "ja_jp", "en": "en_us"}


def download_fleurs(lang: str = "es", split: str = "test", limit: int | None = 100,
                    dest: Path | None = None) -> Path:
    """Google FLEURS (read Wikipedia sentences, 102 languages, 16 kHz).

    The standard multilingual ASR benchmark used in the Whisper paper. Audio
    is streamed from the HuggingFace Hub and extraction stops after `limit`
    utterances, so the full archive never has to be stored.
    """
    cfg = FLEURS_CONFIGS[lang]
    base = f"https://huggingface.co/datasets/google/fleurs/resolve/main/data/{cfg}"
    dest = Path(dest or config.DATA_DIR / f"fleurs_{lang}")
    dest.mkdir(parents=True, exist_ok=True)
    refs = {}
    with urllib.request.urlopen(f"{base}/{split}.tsv") as r:
        for line in r.read().decode("utf-8").splitlines():
            cols = line.split("\t")
            if len(cols) >= 3:
                refs[cols[1]] = cols[2]            # file_name -> raw transcription
    rows = []
    print(f"Streaming FLEURS {cfg}/{split} audio ...")
    with urllib.request.urlopen(f"{base}/audio/{split}.tar.gz") as resp, \
            tarfile.open(fileobj=resp, mode="r|gz") as tar:
        for m in tar:
            name = Path(m.name).name
            if not name.endswith(".wav") or name not in refs:
                continue
            (dest / name).write_bytes(tar.extractfile(m).read())
            rows.append({"id": Path(name).stem, "path": name, "reference": refs[name],
                         "language": lang})
            if limit and len(rows) >= limit:
                break
    return write_manifest(rows, dest / "manifest.csv")


def demo_manifest() -> Path:
    return config.DATA_DIR / "samples" / "manifest.csv"


def list_manifests() -> list[dict]:
    out = []
    for m in sorted(config.DATA_DIR.rglob("manifest.csv")):
        try:
            with open(m, newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
        except OSError:
            continue
        langs = sorted({(r.get("language") or "en") for r in rows})
        out.append({"name": m.parent.name, "path": str(m), "count": len(rows),
                    "languages": langs})
    return out
