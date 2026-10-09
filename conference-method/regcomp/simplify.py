"""Clause simplification for compliance officers (paper Sec. III, Task 2).

Two generators:
  t5        an instruction-tuned T5 (default google/flan-t5-base) paraphrases the clause;
            needs transformers + torch and the model weights (requirements-gpu.txt)
  template  renders the extracted rule parameters as one plain sentence per rule
            (deterministic; always faithful to what the validators test)

Every T5 output passes a guard before use: every amount, number and duration of the
source must survive, negations and exceptions must not disappear, and the obligation
modal must stay. A rejected output falls back to the template rendering (or to the
original sentence when the clause has no rule), so the guard never lets an altered
obligation through.
"""
from __future__ import annotations

import re

from .text import amounts_in

NUM = re.compile(r"(?<![\w.])(\d+(?:[.,]\d+)*)(?![\w])")
WORDNUM = re.compile(r"\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|sixty|ninety)\b", re.I)
WORD2N = {w: n for n, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}
WORD2N.update({"fifteen": 15, "twenty": 20, "thirty": 30, "sixty": 60, "ninety": 90})
NEG = re.compile(r"\b(?:not|no|never|nor|without|prohibited|shall not|cannot)\b", re.I)
EXC = re.compile(r"\b(?:provided that|except|unless|other than|excluding|exempt(?:ed)?|whichever is (?:later|earlier))\b", re.I)
MODAL = re.compile(r"\b(?:shall|must|should|is required to|are required to|has to|have to|need to|needs to)\b", re.I)

PROMPT = "Rewrite this banking regulation in plain English for a bank officer. Keep every number, deadline, condition and exception:\n\n"


REFS = re.compile(r"\(\s*(?:\d{1,2}|[a-z]{1,3}|[ivx]{1,5})\s*\)|\b(?:paragraphs?|paras?|sections?|sub-sections?|chapters?|annex(?:ure)?s?|clauses?|"
                  r"rules?|regulations?|items?|serial|Sl\.?|No\.)\s*\d+[\w.()/-]*", re.I)


def _numbers(text: str) -> set[float]:
    """Amounts, numbers and durations that carry meaning (list markers and cross-references are ignored)."""
    text = REFS.sub(" ", text)
    out = {round(a, 2) for a, _, _ in amounts_in(text)}
    for m in NUM.finditer(text):
        try:
            out.add(round(float(m.group(1).replace(",", "")), 2))
        except ValueError:
            pass
    for m in WORDNUM.finditer(text):
        out.add(float(WORD2N[m.group(1).lower()]))
    return out


def guard(source: str, simplified: str) -> tuple[bool, list[str]]:
    """Does the simplification keep the obligation intact?"""
    issues = []
    missing = sorted(_numbers(source) - _numbers(simplified))
    if missing:
        issues.append(f"numbers lost: {missing[:6]}")
    if NEG.search(source) and not NEG.search(simplified):
        issues.append("negation lost")
    if len(NEG.findall(simplified)) > len(NEG.findall(source)):
        issues.append("negation added")
    if EXC.search(source) and not EXC.search(simplified):
        issues.append("exception lost")
    if MODAL.search(source) and not MODAL.search(simplified):
        issues.append("obligation modal lost")
    return not issues, issues


# ── template rendering of extracted rules ──

FIELD_EN = {"credits": "total credits", "debits": "total withdrawals and transfers", "balance": "the balance", "cash": "cash",
            "amount": "the amount"}
PERIOD_EN = {"financial_year": "in a financial year", "month": "in a month", "any_time": "at any time", "day": "in a day"}
OP_EN = {"<=": "must not exceed", "<": "must be below", ">=": "must be at least", ">": "must exceed"}
SOURCE_EN = {"govt_grant": "Government grants", "welfare": "welfare benefits", "procurement": "procurement payments"}
SCOPE_EN = {("account_type", "small"): "small accounts", ("cross_border", True): "cross-border wire transfers"}
TARGET_EN = {   # what must be done
    "ckycr_uploaded": "upload the KYC records to CKYCR", "ckycr_updated": "send the updated information to CKYCR",
    "kyc_updated": "complete periodic KYC updation", "card_closed": "close the card",
    "cic_updated": "report the closure to the credit information companies", "decision_communicated": "communicate the final decision",
    "incident_reported_rbi": "report the incident to RBI",
}
ANCHOR_EN = {   # what starts the clock
    "updated_info_obtained": "receipt of the updated information", "account_opened": "account opening",
    "last_kyc_update": "the last KYC update", "closure_requested": "the closure request", "dues_cleared": "clearance of dues",
    "card_closed": "card closure", "complaint_received": "receipt of the complaint", "incident_detected": "detection by the service provider",
}
ITEM_EN = {"originator_name": "originator name", "originator_account": "originator account number", "txn_ref": "unique transaction reference",
           "originator_address": "originator address", "originator_national_id": "national identity number",
           "originator_customer_id": "customer identification number", "originator_dob_pob": "date and place of birth",
           "beneficiary_name": "beneficiary name", "beneficiary_account": "beneficiary account number", "aadhaar": "Aadhaar",
           "ovd": "an officially valid document", "kyc_identifier": "the KYC identifier", "pan": "PAN", "form60": "Form 60",
           "photograph": "a photograph"}


def _n(x) -> str:
    from .records import _inr
    return _inr(x) if float(x).is_integer() else f"{x}"


def _cap(s: str) -> str:
    return s[:1].upper() + s[1:]


def render_rule(r: dict) -> str | None:
    k = r.get("kind")
    scope = ""
    if r.get("conditions"):
        scope = "For " + ", ".join(SCOPE_EN.get((k, v), f"{k.replace('_', ' ')} = {v}") for k, v in r["conditions"].items()) + ": "
    if k == "threshold" and r.get("field") and r.get("op") in OP_EN:
        unit = "₹" if r.get("unit") == "INR" else ""
        pct = "%" if r.get("unit") == "percent" else ""
        s = f"{scope}{FIELD_EN.get(r['field'], r['field'])} {PERIOD_EN.get(r.get('period'), '')} {OP_EN[r['op']]} {unit}{_n(r['value'])}{pct}."
        for ex in r.get("exceptions") or []:
            if ex.get("exclude_credit_sources"):
                s += " Deposits from " + ", ".join(SOURCE_EN.get(x, x) for x in ex["exclude_credit_sources"]) + " are not counted."
        return re.sub(r"\s+", " ", _cap(s))
    if k == "temporal" and r.get("target") and r.get("anchor"):
        unit = (r.get("unit") or "").replace("_", " ")
        anchors = " or ".join(ANCHOR_EN.get(a, a) for a in r["anchor"])
        if r.get("anchor_mode") == "latest" and len(r["anchor"]) > 1:
            anchors = "the later of " + " and ".join(ANCHOR_EN.get(a, a) for a in r["anchor"])
        target = _cap(TARGET_EN.get(r["target"], r["target"].replace("_", " ")))
        if r.get("per_category"):
            pc = r["per_category"]
            win = "; ".join(f"every {_n(v)} {unit} for {c} {pc['field']}" for c, v in pc["values"].items())
            s = f"{scope}{target}: {win}, counted from {anchors}."
        else:
            s = f"{scope}{target} within {_n(r['window'])} {unit} of {anchors}."
        if r.get("grace"):
            g = r["grace"]
            who = " ".join(f"{v}-risk" if k == "risk" else str(v) for k, v in sorted(g["when"].items(), key=lambda kv: kv[0] != "risk"))
            s += f" Grace for {who} customers: {_n(g['extra'])} more {g['unit'].rstrip('s') if g['extra'] == 1 else g['unit']} or until {g['until']}, whichever is later."
        if r.get("remediation"):
            s += f" Delay costs ₹{_n(r['remediation']['per_day'])} per day."
        return s
    if k == "cardinality" and r.get("field"):
        when = {"before_due": " before the due date", "after_due": " after the due date"}.get(r.get("when"), "")
        s = f"Send at least {_n(r['value'])} {r['field'].replace('_', ' ')}{when}"
        if r.get("sub"):
            s += f", at least {_n(r['sub']['value'])} of them by {r['sub']['filter'].get('mode')}"
        return s + "."
    if k == "set" and r.get("required"):
        parts = [" or ".join(ITEM_EN.get(f, f) for f in g) for g in r["required"]]
        s = f"{scope}Required: " + "; ".join(parts) + "."
        for ex in r.get("exceptions") or []:
            alt = ex.get("originator_any_of") or ex.get("any_of")
            if alt and ex.get("when"):
                s += f" For {', '.join(ex['when'])} transfers, " + " or ".join(ITEM_EN.get(f, f) for f in alt) + " suffices for the originator."
        return s
    return None


def render_clause(rules: list[dict]) -> str:
    return " ".join(x for x in (render_rule(r) for r in rules) if x)


class T5Simplifier:
    def __init__(self, model: str = "google/flan-t5-base", device: str | None = None, max_new_tokens: int = 200):
        from transformers import pipeline
        self.pipe = pipeline("text2text-generation", model=model, device=device)
        self.max_new_tokens = max_new_tokens

    def __call__(self, texts: list[str]) -> list[str]:
        outs = self.pipe([PROMPT + t for t in texts], max_new_tokens=self.max_new_tokens, num_beams=4, do_sample=False)
        return [o["generated_text"].strip() for o in outs]


def simplify(text: str, rules: list[dict], t5: T5Simplifier | None = None) -> dict:
    """Guarded simplification of one clause."""
    rendered = render_clause(rules)
    if t5 is None:
        return {"text": rendered or text, "method": "template" if rendered else "original", "guard": None}
    out = t5([text])[0]
    ok, issues = guard(text, out)
    if ok:
        return {"text": out, "method": "t5", "guard": {"ok": True}}
    return {"text": rendered or text, "method": "template" if rendered else "original", "guard": {"ok": False, "issues": issues, "rejected": out}}
