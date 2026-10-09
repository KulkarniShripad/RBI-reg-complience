"""Domain lexicon: regulatory phrases -> canonical names in the unified record schema.

The rule grammar (rules.py) is generic - comparators, deadlines, counts, lists,
provisos. What it cannot know is which column of the bank's records a phrase
such as "the aggregate of all credits in a financial year" refers to. This
lexicon supplies that grounding. It is part of the method and must be reported
with the paper (its size is printed by `python -m regcomp.lexicon`); a rule
whose subject is not covered is extracted with `field: null` and its validator
cannot run, which the evaluation counts as a miss.

Entries are regular expressions, tried longest-first.
"""
from __future__ import annotations

import re

# threshold subjects: phrase -> (field, aggregate)
FIELDS = [
    (r"aggregate of all withdrawals and transfers|aggregate of (?:all )?(?:withdrawals|debits)|withdrawals and transfers|total (?:withdrawals|debits)", ("debits", "sum")),
    (r"aggregate of all credits|aggregate of (?:all )?credits|total credits|credits", ("credits", "sum")),
    (r"\bbalance\b", ("balance", "max")),
    (r"cash (?:deposits?|transactions?)", ("cash", "sum")),
    (r"(?:amount|value) of (?:the|a|each|any) (?:transaction|transfer)|transaction amount", ("amount", "none")),
]

PERIODS = [
    (r"in a financial year|per financial year|during a financial year|in a year|per annum", "financial_year"),
    (r"in a month|per month|in any month|during a month|monthly", "month"),
    (r"at any point of time|at any time", "any_time"),
    (r"in a day|per day|daily", "day"),
]

# scope conditions found anywhere in the clause
CONDITIONS = [
    (r"small accounts?", {"account_type": "small"}),
    (r"cross-border wire transfers?", {"cross_border": True}),
    (r"basic savings bank deposit accounts?", {"account_type": "bsbda"}),
]

# categorical values (exceptions, per-category windows)
CREDIT_SOURCES = [
    (r"government grants?", "govt_grant"),
    (r"welfare benefits?", "welfare"),
    (r"payments? against procurements?", "procurement"),
]
CATEGORIES = [
    (r"high[- ]risk", ("risk", "high")),
    (r"medium[- ]risk", ("risk", "medium")),
    (r"low[- ]risk", ("risk", "low")),
]

# items of required-content lists
SET_ITEMS = [
    (r"name of the originator|originator'?s? name", "originator_name"),
    (r"originator'?s? account number", "originator_account"),
    (r"originator'?s? address|address of the originator", "originator_address"),
    (r"national identity number", "originator_national_id"),
    (r"customer identification number", "originator_customer_id"),
    (r"date and place of birth", "originator_dob_pob"),
    (r"name of the beneficiary|beneficiary'?s? name", "beneficiary_name"),
    (r"beneficiary'?s? account number", "beneficiary_account"),
    (r"unique transaction reference(?: number)?", "txn_ref"),
    (r"proof of possession of aadhaar(?: number)?|aadhaar number|\baadhaar\b", "aadhaar"),
    (r"\bOVDs?\b|officially valid documents?", "ovd"),
    (r"KYC identifier", "kyc_identifier"),
    (r"\bPAN\b", "pan"),
    (r"form no\.? ?60", "form60"),
    (r"photograph", "photograph"),
]

# set items that are kept as a list of documents obtained, not as record fields
DOCUMENT_ITEMS = {"aadhaar", "ovd", "kyc_identifier", "pan", "form60", "photograph"}

# events (temporal anchors / targets)
EVENTS = [
    (r"upload(?:ed)? (?:onto|to|on) (?:the )?CKYCR", "ckycr_uploaded"),
    (r"furnish(?:ed)? the updated information to CKYCR|update(?:d)? (?:the )?(?:KYC )?records? (?:in|on) CKYCR", "ckycr_updated"),
    (r"obtains? additional or updated information|updated information from (?:any|the) customer", "updated_info_obtained"),
    (r"commencement of an account-based relationship|opening of (?:the|an) account|account opening", "account_opened"),
    (r"last KYC updation|last updation", "last_kyc_update"),
    (r"periodic updation(?: of KYC)?|updation of KYC", "kyc_updated"),
    (r"request for closure|closure request", "closure_requested"),
    (r"clear(?:ing)? the outstanding dues", "dues_cleared"),
    (r"updated with the Credit Information Compan(?:y|ies)(?:/ies)?|reported? to (?:the )?CICs?", "cic_updated"),
    (r"be honoured|closure of (?:the )?card account|card account shall be closed|closure of (?:a |the )?credit card", "card_closed"),
    (r"(?:final )?decision is communicated to the complainant|communicated to the complainant", "decision_communicated"),
    (r"receipt of (?:the )?complaint", "complaint_received"),
    (r"reported by the (?:bank|RE|NBFC|AIFI|CIC) to (?:the )?(?:RBI|Reserve Bank)|reported to (?:the )?(?:RBI|Reserve Bank)", "incident_reported_rbi"),
    (r"\bdetection\b", "incident_detected"),
]

# count nouns for cardinality rules
COUNT_FIELDS = [
    (r"advance intimations?", "advance_intimations"),
    (r"reminders?", "reminders"),
    (r"(?:KYC )?documents?", "documents"),
]
MODES = [(r"by letter", "letter"), (r"by (?:e-?mail|email)", "email"), (r"by SMS", "sms")]


def _compile(entries):
    return [(re.compile(p, re.I), v) for p, v in sorted(entries, key=lambda e: -len(e[0]))]


C_FIELDS = _compile(FIELDS)
C_PERIODS = _compile(PERIODS)
C_CONDITIONS = _compile(CONDITIONS)
C_SOURCES = _compile(CREDIT_SOURCES)
C_CATEGORIES = _compile(CATEGORIES)
C_SET_ITEMS = [(re.compile(p, re.I), v) for p, v in SET_ITEMS]  # order matters: specific before generic
C_EVENTS = [(re.compile(p, re.I), v) for p, v in EVENTS]
C_COUNT_FIELDS = _compile(COUNT_FIELDS)
C_MODES = _compile(MODES)


def first(entries, text: str):
    """Value of the first (longest-pattern) entry matching `text`, else None."""
    for rx, v in entries:
        if rx.search(text):
            return v
    return None


def all_matches(entries, text: str) -> list[tuple[int, int, object]]:
    """Non-overlapping matches (start, end, value), earliest first; specific patterns win ties."""
    found = []
    taken: list[tuple[int, int]] = []
    for rx, v in entries:
        for m in rx.finditer(text):
            if any(not (m.end() <= s or m.start() >= e) for s, e in taken):
                continue
            taken.append((m.start(), m.end()))
            found.append((m.start(), m.end(), v))
    return sorted(found)


def size() -> int:
    return sum(len(x) for x in (FIELDS, PERIODS, CONDITIONS, CREDIT_SOURCES, CATEGORIES, SET_ITEMS, EVENTS, COUNT_FIELDS, MODES))


if __name__ == "__main__":
    print(f"lexicon entries: {size()}")
