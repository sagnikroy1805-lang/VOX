"""Evaluation metrics: Word Error Rate (WER) and Character Error Rate (CER).

WER = (S + D + I) / N
    S = substitutions, D = deletions, I = insertions,
    N = number of words in the reference transcript.
CER is the same formula computed over characters.

The alignment is the classic Levenshtein dynamic programme, implemented here
from scratch so every step can be explained (jiwer gives identical numbers).
"""
# WHAT THIS FILE DOES: STAGE 3 of the pipeline. Compares the model's text
# (hypothesis) with the correct text (reference) and counts the mistakes.
# Used per file by pipeline.py, for the whole dataset by engines.summarize(),
# and for the Transcribe tab by web/app.py.

from __future__ import annotations

import re              # regular expressions for cleaning text
import unicodedata     # Unicode tools: NFKC normalisation, punctuation categories

# Languages written without spaces between words: "WER" is computed over
# characters for them (the convention used for Japanese/Chinese benchmarks).
NO_SPACE_LANGS = {"ja", "zh"}

# Word lists for turning numbers into words ("42" -> "forty two")
_ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
         "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
         "sixteen", "seventeen", "eighteen", "nineteen"]
_TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
         "eighty", "ninety"]


def _num_to_words(n: int) -> str:
    # Spell out a number so "1923" in the model's text matches words in the reference.
    if n < 20:                                   # 0-19 have their own words
        return _ONES[n]
    if n < 100:                                  # 20-99: tens word + ones word
        return _TENS[n // 10] + ("" if n % 10 == 0 else " " + _ONES[n % 10])
    if n < 1000:                                 # 100-999: "x hundred" + the rest
        rest = n % 100
        return _ONES[n // 100] + " hundred" + ("" if rest == 0 else " " + _num_to_words(rest))
    if n < 1_000_000:                            # thousands, calling itself for each part
        rest = n % 1000
        return _num_to_words(n // 1000) + " thousand" + ("" if rest == 0 else " " + _num_to_words(rest))
    return str(n)                                # very large numbers stay as digits


_KAKASI = None   # the Japanese converter, created on first use (it is slow to load)


def to_hiragana(text: str) -> str:
    """Kanji/katakana -> hiragana reading (pykakasi), so that '天気' and
    'てんき' count as the same characters. Without this, a correct answer
    written in a different script would be scored as an error."""
    global _KAKASI
    try:
        if _KAKASI is None:
            import pykakasi
            _KAKASI = pykakasi.kakasi()          # load the converter once
        # convert piece by piece and keep the hiragana reading of each piece
        return "".join(t["hira"] for t in _KAKASI.convert(text))
    except ImportError:
        return text                              # pykakasi missing -> compare as written


def _strip_punct(text: str) -> str:
    """Replace every Unicode punctuation/symbol char (、。¿¡「」…) by a space."""
    # category "P..." = punctuation, "S..." = symbol; apostrophes are kept
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
    # NFKC turns full-width characters into normal ones; lower() makes W and w the same
    text = unicodedata.normalize("NFKC", text or "").lower()
    text = text.replace("’", "'").replace("‘", "'")     # curly quotes -> straight apostrophe
    if lang and lang != "en":                           # ---- Spanish / Japanese rules ----
        text = _strip_punct(text).replace("'", " ")     # remove all punctuation
        if lang in NO_SPACE_LANGS:                      # Japanese: no spaces at all
            text = re.sub(r"\s+", "", text)
            return to_hiragana(text) if lang == "ja" else text   # kanji/katakana -> hiragana
        return re.sub(r"\s+", " ", text).strip()        # Spanish: single spaces, accents kept
    # ---- English rules ----
    text = re.sub(r"\bmr\.?\b", "mister", text)          # abbreviations -> full words
    text = re.sub(r"\bmrs\.?\b", "missus", text)
    text = re.sub(r"\bdr\.?\b", "doctor", text)
    text = re.sub(r"(\d+)%", r"\1 percent", text)       # "50%" -> "50 percent"
    text = re.sub(r"\d+", lambda m: _num_to_words(int(m.group())), text)   # digits -> words
    text = re.sub(r"[^a-z0-9' ]+", " ", text)      # drop punctuation
    text = re.sub(r"(?<![a-z])'|'(?![a-z])", " ", text)  # stray quotes
    return re.sub(r"\s+", " ", text).strip()            # collapse repeated spaces


def tokens(text: str, lang: str | None = "en") -> list[str]:
    """Words for space-delimited languages, characters for Japanese."""
    return list(text) if lang in NO_SPACE_LANGS else text.split()


def edit_ops(ref: list, hyp: list) -> dict:
    """Levenshtein alignment returning counts of S, D, I and hits."""
    n, m = len(ref), len(hyp)               # n reference tokens, m hypothesis tokens
    # dp[i][j] = (cost, S, D, I) for ref[:i] vs hyp[:j]
    # first row: turning an empty reference into j hypothesis words = j insertions
    prev = [(j, 0, 0, j) for j in range(m + 1)]
    for i in range(1, n + 1):               # one row per reference word
        cur = [(i, 0, i, 0)] + [None] * m   # first column: i reference words, no hypothesis = i deletions
        for j in range(1, m + 1):           # one column per hypothesis word
            if ref[i - 1] == hyp[j - 1]:    # words match -> no extra cost (a "hit")
                cur[j] = prev[j - 1]
                continue
            # three ways to get here: substitute, delete a reference word, insert a hypothesis word
            sub, dele, ins = prev[j - 1], prev[j], cur[j - 1]
            best = min(sub[0], dele[0], ins[0])          # cheapest of the three
            if sub[0] == best:                           # substitution: +1 cost, +1 S
                cur[j] = (sub[0] + 1, sub[1] + 1, sub[2], sub[3])
            elif dele[0] == best:                        # deletion: +1 cost, +1 D
                cur[j] = (dele[0] + 1, dele[1], dele[2] + 1, dele[3])
            else:                                        # insertion: +1 cost, +1 I
                cur[j] = (ins[0] + 1, ins[1], ins[2], ins[3] + 1)
        prev = cur                          # only two rows are kept in memory
    cost, s, d, ins = prev[m]               # bottom-right cell = minimum number of edits
    return {"errors": cost, "S": s, "D": d, "I": ins, "N": n, "H": n - s - d}   # H = correct words


def wer_details(reference: str, hypothesis: str, normalize: bool = True,
                lang: str | None = "en") -> dict:
    # Normalise both texts, split into tokens, and count S / D / I (used for the alignment view).
    r = normalize_text(reference, lang) if normalize else reference
    h = normalize_text(hypothesis, lang) if normalize else hypothesis
    return edit_ops(tokens(r, lang), tokens(h, lang))


def wer(reference: str, hypothesis: str, normalize: bool = True, lang: str | None = "en") -> float:
    # Word Error Rate = (S + D + I) / N  (characters instead of words for Japanese)
    d = wer_details(reference, hypothesis, normalize, lang)
    return d["errors"] / d["N"] if d["N"] else float(d["errors"] > 0)   # empty reference: 0 or 1


def cer(reference: str, hypothesis: str, normalize: bool = True, lang: str | None = "en") -> float:
    # Character Error Rate: the same formula over individual characters
    r = normalize_text(reference, lang) if normalize else reference
    h = normalize_text(hypothesis, lang) if normalize else hypothesis
    d = edit_ops(list(r), list(h))          # list("abc") = ["a", "b", "c"]
    return d["errors"] / d["N"] if d["N"] else float(d["errors"] > 0)


def corpus_scores(refs: list[str], hyps: list[str], langs: list | None = None) -> dict:
    """Corpus-level WER/CER = total errors / total reference length.

    (Not the mean of per-file WERs - longer utterances weigh more, which is
    the standard way LibriSpeech/Common Voice results are reported.)
    """
    langs = langs or ["en"] * len(refs)                  # default: everything is English
    w = {"errors": 0, "N": 0, "S": 0, "D": 0, "I": 0}    # running totals for words
    c = {"errors": 0, "N": 0}                            # running totals for characters
    for r, h, lg in zip(refs, hyps, langs):              # one file at a time
        if r is None or str(r).strip() == "":            # no reference text -> cannot score
            continue
        lg = lg or "en"
        rn, hn = normalize_text(r, lg), normalize_text(h or "", lg)
        dw = edit_ops(tokens(rn, lg), tokens(hn, lg))    # word-level errors for this file
        dc = edit_ops(list(rn), list(hn))                # character-level errors
        for k in w:
            w[k] += dw[k]                                # add to the totals
        c["errors"] += dc["errors"]
        c["N"] += dc["N"]
    return {
        "wer": w["errors"] / w["N"] if w["N"] else None,     # total errors / total words
        "cer": c["errors"] / c["N"] if c["N"] else None,
        "substitutions": w["S"], "deletions": w["D"], "insertions": w["I"],
        "ref_words": w["N"], "ref_chars": c["N"],
    }
