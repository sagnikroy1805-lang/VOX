"""Evaluation metrics: Word Error Rate (WER) and Character Error Rate (CER).

WER = (S + D + I) / N
    S = substitutions, D = deletions, I = insertions,
    N = number of words in the reference transcript.
CER is the same formula computed over characters.

The alignment is the classic Levenshtein dynamic programme, implemented here
from scratch so every step can be explained (jiwer gives identical numbers).
"""
from __future__ import annotations

import re
import unicodedata

# Languages written without spaces between words: "WER" is computed over
# characters for them (the convention used for Japanese/Chinese benchmarks).
NO_SPACE_LANGS = {"ja", "zh"}

_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
         "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
         "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]


def _num_to_words(n: int) -> str:
    if n < 20:
        return _ONES[n]
    if n < 100:
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:
        rest = n % 100
        return _ONES[n // 100] + " hundred" + ("" if rest == 0 else " " + _num_to_words(rest))
    if n < 1_000_000:
        rest = n % 1000
        return _num_to_words(n // 1000) + " thousand" + ("" if rest == 0 else " " + _num_to_words(rest))
    return str(n)


_KAKASI = None


def to_hiragana(text: str) -> str:
    """Kanji/katakana -> hiragana reading (pykakasi), so that '天気' and
    'てんき' count as the same characters. Without this, a correct answer
    written in a different script would be scored as an error."""
    global _KAKASI
    try:
        if _KAKASI is None:
            import pykakasi
            _KAKASI = pykakasi.kakasi()
        return "".join(t["hira"] for t in _KAKASI.convert(text))
    except ImportError:
        return text


def _strip_punct(text: str) -> str:
    """Replace every Unicode punctuation/symbol char (、。¿¡「」…) by a space."""
    return "".join(" " if unicodedata.category(c)[0] in "PS" and c != "'" else c for c in text)


def normalize_text(text: str, lang: str | None = "en") -> str:
    """Make hypothesis and reference comparable.

    English: Whisper writes "Hello, Mr. Smith! It's 1923." while LibriSpeech
    references read "HELLO MISTER SMITH IT'S NINETEEN TWENTY THREE"; without
    normalisation punctuation and casing alone would inflate WER.
    Spanish: lower-case, drop punctuation (¿¡.,) but KEEP accents (á é ñ).
    Japanese: NFKC (full-width -> half-width), drop punctuation (、。「」)
    and all spaces, then convert kanji/katakana to hiragana readings.
    """
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = text.replace("’", "'").replace("‘", "'")
    if lang and lang != "en":
        text = _strip_punct(text).replace("'", " ")
        if lang in NO_SPACE_LANGS:
            text = re.sub(r"\s+", "", text)
            return to_hiragana(text) if lang == "ja" else text
        return re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\bmr\.?\b", "mister", text)
    text = re.sub(r"\bmrs\.?\b", "missus", text)
    text = re.sub(r"\bdr\.?\b", "doctor", text)
    text = re.sub(r"(\d+)%", r"\1 percent", text)
    text = re.sub(r"\d+", lambda m: _num_to_words(int(m.group())), text)
    text = re.sub(r"[^a-z0-9' ]+", " ", text)      # drop punctuation
    text = re.sub(r"(?<![a-z])'|'(?![a-z])", " ", text)  # stray quotes
    return re.sub(r"\s+", " ", text).strip()


def tokens(text: str, lang: str | None = "en") -> list[str]:
    """Words for space-delimited languages, characters for Japanese."""
    return list(text) if lang in NO_SPACE_LANGS else text.split()


def edit_ops(ref: list, hyp: list) -> dict:
    """Levenshtein alignment returning counts of S, D, I and hits."""
    n, m = len(ref), len(hyp)
    # dp[i][j] = (cost, S, D, I) for ref[:i] vs hyp[:j]
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):
        cur = [(i, 0, i, 0)] + [None] * m
        for j in range(1, m + 1):
            if ref[i - 1] == hyp[j - 1]:
                cur[j] = prev[j - 1]
                continue
            sub, dele, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min(sub[0], dele[0], ins[0])
            if sub[0] == best:
                cur[j] = (sub[0] + 1, sub[1] + 1, sub[2], sub[3])
            elif dele[0] == best:
                cur[j] = (dele[0] + 1, dele[1], dele[2] + 1, dele[3])
            else:
                cur[j] = (ins[0] + 1, ins[1], ins[2], ins[3] + 1)
        prev = cur
    cost, s, d, ins = prev[m]
    return {"errors": cost, "S": s, "D": d, "I": ins, "N": n, "H": n - s - d}


def wer_details(reference: str, hypothesis: str, normalize: bool = True,
                lang: str | None = "en") -> dict:
    r = normalize_text(reference, lang) if normalize else reference
    h = normalize_text(hypothesis, lang) if normalize else hypothesis
    return edit_ops(tokens(r, lang), tokens(h, lang))


def wer(reference: str, hypothesis: str, normalize: bool = True, lang: str | None = "en") -> float:
    d = wer_details(reference, hypothesis, normalize, lang)
    return d["errors"] / d["N"] if d["N"] else float(d["errors"] > 0)


def cer(reference: str, hypothesis: str, normalize: bool = True, lang: str | None = "en") -> float:
    r = normalize_text(reference, lang) if normalize else reference
    h = normalize_text(hypothesis, lang) if normalize else hypothesis
    d = edit_ops(list(r), list(h))
    return d["errors"] / d["N"] if d["N"] else float(d["errors"] > 0)


def corpus_scores(refs: list[str], hyps: list[str], langs: list | None = None) -> dict:
    """Corpus-level WER/CER = total errors / total reference length.

    (Not the mean of per-file WERs - longer utterances weigh more, which is
    the standard way LibriSpeech/Common Voice results are reported.)
    """
    langs = langs or ["en"] * len(refs)
    w = {"errors": 0, "N": 0, "S": 0, "D": 0, "I": 0}
    c = {"errors": 0, "N": 0}
    for r, h, lg in zip(refs, hyps, langs):
        if r is None or str(r).strip() == "":
            continue
        lg = lg or "en"
        rn, hn = normalize_text(r, lg), normalize_text(h or "", lg)
        dw = edit_ops(tokens(rn, lg), tokens(hn, lg))
        dc = edit_ops(list(rn), list(hn))
        for k in w:
            w[k] += dw[k]
        c["errors"] += dc["errors"]
        c["N"] += dc["N"]
    return {
        "wer": w["errors"] / w["N"] if w["N"] else None,
        "cer": c["errors"] / c["N"] if c["N"] else None,
        "substitutions": w["S"], "deletions": w["D"], "insertions": w["I"],
        "ref_words": w["N"], "ref_chars": c["N"],
    }
