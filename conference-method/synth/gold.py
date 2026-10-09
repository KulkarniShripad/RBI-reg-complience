"""Ground-truth labels for evidence units, written directly from the regulation text.

Deliberately independent of regcomp/: no shared code with the validators and
no use of extracted rule parameters. Each function encodes one gold rule
(data/gold_rules.yaml) by hand; the system must reach the same verdict from
the clause text through extraction, linking and generic validators.

label(unit) -> {gold_rule_id: True if violated else False}, for the gold rules
that apply to the unit (absent = not applicable).
"""
from __future__ import annotations

import collections
from datetime import date, datetime, timedelta

AS_OF = date(2026, 9, 30)
EXEMPT_SOURCES = {"govt_grant", "welfare", "procurement"}
HOLIDAYS_MD = {(1, 26), (8, 15), (10, 2)}


def _d(s):
    return date.fromisoformat(s[:10]) if s else None


def _is_bank_holiday(x: date) -> bool:
    if x.weekday() == 6:                                   # Sunday
        return True
    if x.weekday() == 5 and (x.day - 1) // 7 in (1, 3):    # 2nd and 4th Saturday
        return True
    return (x.month, x.day) in HOLIDAYS_MD


def _plus_working_days(start: date, n: int) -> date:
    x, left = start, n
    while left:
        x += timedelta(days=1)
        if not _is_bank_holiday(x):
            left -= 1
    return x


def _add_years(x: date, n: int) -> date:
    try:
        return x.replace(year=x.year + n)
    except ValueError:                                     # 29 Feb
        return x.replace(year=x.year + n, day=28)


def _late(done, deadline, as_of=AS_OF) -> bool:
    """Violated if done after the deadline, or not done and the deadline has passed."""
    return (done > deadline) if done is not None else (as_of > deadline)


# ── per rule ──

def small_account(d: dict) -> dict:
    out = {}
    credits = sum(t["amount"] for t in d["txns"] if t["direction"] == "credit")
    out["G01_small_credits"] = credits > 100000
    months = collections.defaultdict(float)
    for t in d["txns"]:
        if t["direction"] == "debit":
            months[t["date"][:7]] += t["amount"]
    out["G02_small_debits"] = any(v > 10000 for v in months.values())
    # balance limit; deposits through Government grants, welfare benefits and
    # procurement payments are not considered
    bal = d.get("opening_balance", 0)
    peak = bal
    for t in d["txns"]:
        if t["direction"] == "credit":
            if t.get("source") not in EXEMPT_SOURCES:
                bal += t["amount"]
        else:
            bal -= t["amount"]
        peak = max(peak, bal)
    out["G03_small_balance"] = peak > 50000
    return out


def wire(d: dict) -> dict:
    if not d.get("cross_border"):
        return {}
    has = lambda *ks: any(d.get(k) for k in ks)
    if d.get("batch"):
        originator_ok = has("originator_account", "txn_ref")
    else:
        originator_ok = (has("originator_name") and has("originator_account", "txn_ref")
                         and has("originator_address", "originator_national_id", "originator_customer_id", "originator_dob_pob"))
    beneficiary_ok = has("beneficiary_name") and has("beneficiary_account", "txn_ref")
    return {"G04_wire_information": not (originator_ok and beneficiary_ok)}


def kyc_onboarding(d: dict) -> dict:
    e = d["events"]
    opened = _d(e["account_opened"])
    docs = set(d.get("documents") or [])
    return {
        "G05_ckycr_upload": _late(_d(e.get("ckycr_uploaded")), opened + timedelta(days=10)),
        "G07_cdd_documents": not (docs & {"aadhaar", "ovd", "kyc_identifier"} and docs & {"pan", "form60"}),
    }


def kyc_info_update(d: dict) -> dict:
    e = d["events"]
    return {"G06_ckycr_update": _late(_d(e.get("ckycr_updated")), _d(e["updated_info_obtained"]) + timedelta(days=7))}


def kyc_periodic(d: dict) -> dict:
    e = d["events"]
    base = max(x for x in (_d(e.get("last_kyc_update")), _d(e.get("account_opened"))) if x)
    years = {"high": 2, "medium": 8, "low": 10}[d["risk"]]
    due = _add_years(base, years)
    deadline = due
    if d["risk"] == "low" and d.get("customer_type") == "individual":
        deadline = max(_add_years(due, 1), date(2026, 6, 30))       # whichever is later
    updated = _d(e.get("kyc_updated"))
    out = {}
    if due <= AS_OF or (updated and updated <= AS_OF):
        out["G08_periodic_updation"] = _late(updated, deadline)
    comms = d.get("communications") or []
    if due <= AS_OF:
        adv = [c for c in comms if c["kind"] == "advance_intimation" and _d(c["date"]) < due]
        out["G09_advance_intimations"] = len(adv) < 3 or not any(c.get("mode") == "letter" for c in adv)
    if due <= AS_OF and (updated is None or updated > due):
        end = min(updated, AS_OF) if updated else AS_OF
        rem = [c for c in comms if c["kind"] == "reminder" and due < _d(c["date"]) <= end]
        out["G10_reminders"] = len(rem) < 3 or not any(c.get("mode") == "letter" for c in rem)
    return out


def card_closure(d: dict) -> dict:
    e = d["events"]
    start = max(x for x in (_d(e["closure_requested"]), _d(e.get("dues_cleared"))) if x)
    closed = _d(e.get("card_closed"))
    out = {"G11_card_closure": _late(closed, _plus_working_days(start, 7))}
    if closed:
        out["G12_card_cic_update"] = _late(_d(e.get("cic_updated")), closed + timedelta(days=30))
    return out


def complaint(d: dict) -> dict:
    e = d["events"]
    return {"G13_io_decision": _late(_d(e.get("decision_communicated")), _d(e["complaint_received"]) + timedelta(days=30))}


def cyber(d: dict) -> dict:
    e = d["events"]
    det = datetime.fromisoformat(e["incident_detected"])
    rep = datetime.fromisoformat(e["incident_reported_rbi"]) if e.get("incident_reported_rbi") else None
    deadline = det + timedelta(hours=6)
    return {"G14_cyber_reporting": (rep > deadline) if rep else (datetime.combine(AS_OF, datetime.min.time()) > deadline)}


LABELLERS = {
    "small_account_year": small_account,
    "wire_transfer": wire,
    "kyc_onboarding": kyc_onboarding,
    "kyc_info_update": kyc_info_update,
    "kyc_periodic": kyc_periodic,
    "card_closure": card_closure,
    "complaint": complaint,
    "cyber_incident": cyber,
    "payment": lambda d: {},
}


def label(unit_type: str, data: dict) -> dict:
    return LABELLERS[unit_type](data)
