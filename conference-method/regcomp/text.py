"""Text utilities shared by ingestion, extraction and evaluation."""
from __future__ import annotations

import re
import unicodedata

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
REPLACEMENT = "�"

# Abbreviations whose trailing dot is not a sentence end.
ABBREV = r"(?:Rs|No|Nos|viz|i\.e|e\.g|etc|Sr|Dr|Mr|Mrs|Ms|Co|Ltd|Pvt|Govt|Dept|para|paras|Cl|Art|Sec|vol|approx|Annex|Fig|cf|w\.e\.f|u/s|A\.P|U\.P)"


def normalize(text: str) -> str:
    """Unicode NFKC normalisation plus typographic cleanup (quotes, dashes, spaces)."""
    t = unicodedata.normalize("NFKC", text)
    t = t.replace("‘", "'").replace("’", "'").replace("“", '"').replace("”", '"')
    t = t.replace("–", "-").replace("—", "-").replace("−", "-")
    t = t.replace(" ", " ").replace("​", "")
    return re.sub(r"[ \t]+", " ", t).strip()


def script_of(line: str) -> str:
    """'devanagari' if most letters are Devanagari, 'garbled' for replacement chars, else 'latin'."""
    if REPLACEMENT in line:
        return "garbled"
    letters = [c for c in line if c.isalpha()]
    if not letters:
        return "latin"
    dev = sum(1 for c in letters if DEVANAGARI.match(c))
    return "devanagari" if dev / len(letters) > 0.5 else "latin"


def split_sentences(text: str) -> list[str]:
    """Rule-based English sentence segmentation that protects abbreviations,
    decimals, list markers and amounts ("Rs. 10,000")."""
    t = re.sub(r"\s+", " ", text).strip()
    t = re.sub(rf"\b({ABBREV})\.", lambda m: m.group(1) + "<DOT>", t)
    t = re.sub(r"(\d)\.(\d)", r"\1<DOT>\2", t)
    t = re.sub(r"\b([A-Z])\.(?=\s?[A-Z]\.)", r"\1<DOT>", t)  # initials
    parts = re.split(r"(?<=[.;?!])\s+(?=[\"'(\[]?[A-Z(])", t)
    out = [p.replace("<DOT>", ".").strip() for p in parts]
    return [p for p in out if len(p) > 3]


# ── amounts (Indian conventions) ──

WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9,
    "ten": 10, "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20, "twenty-five": 25, "thirty": 30,
    "forty": 40, "forty-five": 45, "fifty": 50, "sixty": 60, "seventy": 70, "ninety": 90, "hundred": 100,
}
SCALE = {"thousand": 1e3, "lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "crore": 1e7, "crores": 1e7, "million": 1e6, "billion": 1e9}

AMOUNT_RE = re.compile(
    r"(?:₹|Rs\.?|INR|Rupees?)\s*"
    r"(?P<num>\d[\d,]*(?:\.\d+)?|" + "|".join(sorted(WORD_NUMBERS, key=len, reverse=True)) + r")"
    r"(?:\s*(?P<scale>thousand|lakhs?|lac|crores?|million|billion))?",
    re.I,
)


def parse_number(tok: str) -> float | None:
    tok = tok.strip().lower()
    if tok in WORD_NUMBERS:
        return float(WORD_NUMBERS[tok])
    tok = tok.replace(",", "")
    try:
        return float(tok)
    except ValueError:
        return None


def amounts_in(text: str) -> list[tuple[float, int, int]]:
    """All rupee amounts in `text` as (value_in_rupees, start, end)."""
    out = []
    for m in AMOUNT_RE.finditer(text):
        n = parse_number(m.group("num"))
        if n is None:
            continue
        scale = SCALE.get((m.group("scale") or "").lower(), 1)
        out.append((n * scale, m.start(), m.end()))
    return out


def number_word_or_digit(tok: str) -> float | None:
    return parse_number(tok)


def fkgl(text: str) -> float | None:
    """Flesch-Kincaid grade level."""
    sents = [s for s in re.split(r"[.!?;:]+(?:\s|$)", text) if re.search(r"[A-Za-z]", s)]
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", text)
    if not sents or not words:
        return None

    def syl(w: str) -> int:
        w = re.sub(r"[^a-z]", "", w.lower())
        if len(w) <= 3:
            return 1
        w = re.sub(r"(?:[^laeiouy]es|ed|[^laeiouy]e)$", "", w)
        w = re.sub(r"^y", "", w)
        return max(1, len(re.findall(r"[aeiouy]{1,2}", w)))

    return 0.39 * len(words) / len(sents) + 11.8 * sum(syl(w) for w in words) / len(words) - 15.59
