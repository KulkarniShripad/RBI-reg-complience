"""Operational-obligation detection (paper Sec. III, stage 2, Task 1a).

A clause is OPERATIONAL when it obliges or prohibits something of the
regulated entity that can be tested against operational records: a monetary
or numeric limit, a deadline, a minimum / maximum count, or mandatory content
(documents, fields, information). Definitions, scope and applicability,
purpose statements, repeal and commencement clauses, and policy-level duties
with no checkable condition ("shall have a Board-approved policy") are
NON-OPERATIONAL. The annotation guidelines (annotation/GUIDELINES.md) define
the same two classes for the human labels.

The rule-based detector below is the paper's keyword + numbering extractor:
obligation keywords ("shall", "must", "is required to", prohibitions) inside a
numbered paragraph, plus at least one testability cue. Trainable baselines
(TF-IDF + LR / SVM / RF) and fine-tuned transformers are in experiments/.
"""
from __future__ import annotations

import re

MODAL = re.compile(
    r"\b(shall|must|is required to|are required to|should|is prohibited|are prohibited|shall not|may not|is not permitted|are not permitted|is mandatory|shall be honoured|shall be closed|shall be reported)\b",
    re.I,
)
NON_OPERATIONAL = [
    re.compile(r"\b(?:shall mean|means|shall have the meaning|unless the context (?:otherwise )?requires|in these directions,? unless)\b", re.I),
    re.compile(r"\b(?:shall (?:be applicable|apply) to|applicable to all|these directions shall apply)\b", re.I),
    re.compile(r"\b(?:may be called|shall come into (?:force|effect)|hereby repealed|stand repealed|issued in exercise of)\b", re.I),
]
TESTABLE = [
    re.compile(r"(?:₹|Rs\.?|INR|Rupees?)\s*[\d,]+|\b\d[\d,]*(?:\.\d+)?\s*(?:lakh|crore)\b", re.I),               # amounts
    re.compile(r"\b\d+(?:\.\d+)?\s*(?:per ?cent|%)", re.I),                                                       # percentages
    re.compile(r"\bwithin\s+(?:a period of\s+)?(?:\d+|one|two|three|four|five|six|seven|eight|ten|fifteen|thirty|sixty|ninety)\s+(?:working\s+|calendar\s+)?(?:days?|hours?|weeks?|months?|years?)\b", re.I),
    re.compile(r"\b(?:not later than|no later than|on or before|before the expiry of|by the \d+(?:st|nd|rd|th)? (?:day )?of)\b", re.I),
    re.compile(r"\bonce in every\s+\w+\s+(?:years?|months?)\b", re.I),
    re.compile(r"\b(?:at least|not more than|not less than|minimum of|maximum of)\s+(?:\d+|one|two|three|four|five|six|seven|eight|ten)\b", re.I),
    re.compile(r"\b(?:shall be accompanied by|shall contain|shall include|following (?:information|details|documents)|mandatory (?:fields?|information))\b", re.I),
    re.compile(r"\b(?:shall not (?:grant|open|allow|permit|issue|accept|charge|levy|disburse)|is prohibited from)\b", re.I),
]
NUMBERED = re.compile(r"^\s*(?:\(?\d{1,3}[.)]|\([a-z]{1,3}\)|\([ivx]{1,5}\))")


def features(text: str, kind: str = "paragraph") -> dict:
    return {
        "modal": bool(MODAL.search(text)),
        "non_operational": any(p.search(text[:400]) for p in NON_OPERATIONAL),
        "testable_cues": sum(1 for p in TESTABLE if p.search(text)),
        "numbered": kind == "paragraph" or bool(NUMBERED.match(text)),
    }


def is_operational(text: str, kind: str = "paragraph") -> bool:
    """Rule-based decision: obligation keyword + numbered unit + testable cue, not a definition / scope / repeal clause."""
    f = features(text, kind)
    if not f["modal"] or not f["numbered"]:
        return False
    if f["non_operational"] and f["testable_cues"] < 2:
        return False
    return f["testable_cues"] >= 1


def operational_sentences(text: str) -> list[str]:
    """Sentences of a clause that carry an obligation keyword and a testable cue."""
    from .text import split_sentences

    out = []
    for s in split_sentences(text):
        if MODAL.search(s) and any(p.search(s) for p in TESTABLE):
            out.append(s)
    return out
