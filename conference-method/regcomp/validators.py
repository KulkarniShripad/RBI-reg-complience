"""Generic validators (paper Sec. III, hybrid validation).

Each validator reads only the extracted rule parameters and the evidence unit's
structured data. It never sees the gold labels or the scenario that produced
the unit. Outcomes:

  VIOLATION       the unit fails the rule
  COMPLIANT       the unit meets the rule (including a deadline not yet passed)
  NOT_APPLICABLE  the rule's scope, fields or events are absent from the unit,
                  so it cannot be tested on it (no alert is raised)
"""
from __future__ import annotations

import collections
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta

from .calendar import add_working_days
from .lexicon import DOCUMENT_ITEMS

OPS = {"<=": lambda v, t: v <= t, "<": lambda v, t: v < t, ">=": lambda v, t: v >= t, ">": lambda v, t: v > t}
MONTHS = {m: i for i, m in enumerate(["january", "february", "march", "april", "may", "june", "july", "august", "september",
                                      "october", "november", "december"], start=1)}


@dataclass
class Outcome:
    status: str
    validator: str
    detail: dict = field(default_factory=dict)


def _date(x) -> date | None:
    if not x:
        return None
    return date.fromisoformat(str(x)[:10])


def _dt(x) -> datetime | None:
    if not x:
        return None
    s = str(x)
    return datetime.fromisoformat(s if "T" in s else s + "T00:00")


def _parse_long_date(s: str) -> date | None:
    try:
        mon, rest = s.strip().split(" ", 1)
        day, year = rest.replace(",", " ").split()[:2]
        return date(int(year), MONTHS[mon.lower()], int(day))
    except Exception:
        return None


def _add(d: date, n: float, unit: str) -> date:
    if unit == "days":
        return d + timedelta(days=n)
    if unit == "working_days":
        return add_working_days(d, int(n))
    if unit == "weeks":
        return d + timedelta(weeks=n)
    if unit == "months":
        m = d.month - 1 + int(n)
        y = d.year + m // 12
        m = m % 12 + 1
        return date(y, m, min(d.day, 28))
    if unit == "years":
        try:
            return d.replace(year=d.year + int(n))
        except ValueError:
            return d.replace(year=d.year + int(n), day=28)
    raise ValueError(unit)


# ── scope ──

def in_scope(rule: dict, unit_type: str, data: dict) -> tuple[bool, str]:
    """The rule's scope conditions must be verifiably true of the unit."""
    for k, v in (rule.get("conditions") or {}).items():
        if k not in data:
            return False, f"scope field {k!r} not in the evidence"
        if data[k] != v:
            return False, f"scope {k}={v!r} not met ({data[k]!r})"
    return True, ""


# ── threshold ──

def threshold(rule: dict, unit_type: str, data: dict, as_of: date) -> Outcome:
    f, op, val = rule.get("field"), rule.get("op"), rule.get("value")
    if rule.get("role") == "condition" or not f or op not in OPS or val is None:
        return Outcome("NOT_APPLICABLE", "threshold", {"reason": "rule has no testable field / limit"})
    txns = data.get("txns")
    if txns is None:
        if f in data and isinstance(data[f], (int, float)):
            v = data[f]
            return Outcome("COMPLIANT" if OPS[op](v, val) else "VIOLATION", "threshold", {"value": v, "limit": val, "op": op})
        return Outcome("NOT_APPLICABLE", "threshold", {"reason": f"field {f!r} not in the evidence"})
    excluded = set()
    for ex in rule.get("exceptions") or []:
        excluded |= set(ex.get("exclude_credit_sources") or [])
    period = rule.get("period")
    if f == "credits":
        groups = collections.defaultdict(float)
        for t in txns:
            if t["direction"] == "credit" and t.get("source") not in excluded:
                groups[_period_key(t["date"], period)] += t["amount"]
        observed = max(groups.values(), default=0.0)
    elif f == "debits":
        groups = collections.defaultdict(float)
        for t in txns:
            if t["direction"] == "debit":
                groups[_period_key(t["date"], period)] += t["amount"]
        observed = max(groups.values(), default=0.0)
    elif f == "balance":
        bal = peak = float(data.get("opening_balance") or 0)
        for t in txns:
            if t["direction"] == "credit":
                if t.get("source") not in excluded:
                    bal += t["amount"]
            else:
                bal -= t["amount"]
            peak = max(peak, bal)
        observed = peak
    else:
        return Outcome("NOT_APPLICABLE", "threshold", {"reason": f"no aggregation defined for {f!r}"})
    ok = OPS[op](observed, val)
    detail = {"field": f, "aggregate": rule.get("aggregate"), "period": period, "observed": round(observed, 2), "op": op,
              "limit": val, "excluded_sources": sorted(excluded)}
    if not ok and val:
        detail["exceedance_pct"] = round(100 * (observed - val) / val, 1)
    return Outcome("COMPLIANT" if ok else "VIOLATION", "threshold", detail)


def _period_key(d: str, period: str | None) -> str:
    if period == "month":
        return d[:7]
    if period == "financial_year":
        y, m = int(d[:4]), int(d[5:7])
        return str(y if m >= 4 else y - 1)
    if period == "day":
        return d[:10]
    return "all"


# ── temporal ──

def _due(rule: dict, data: dict) -> tuple[date | datetime | None, str]:
    events = data.get("events") or {}
    anchors = [events.get(a) for a in rule.get("anchor") or []]
    anchors = [a for a in anchors if a]
    if not anchors:
        return None, "anchor event not in the evidence"
    unit = rule.get("unit")
    if unit == "hours":
        start = max(_dt(a) for a in anchors) if rule.get("anchor_mode") != "earliest" else min(_dt(a) for a in anchors)
        return start + timedelta(hours=rule["window"]), ""
    start = max(_date(a) for a in anchors) if rule.get("anchor_mode") != "earliest" else min(_date(a) for a in anchors)
    window = rule.get("window")
    if rule.get("per_category"):
        pc = rule["per_category"]
        cat = data.get(pc.get("field"))
        if cat not in (pc.get("values") or {}):
            return None, f"category {pc.get('field')}={cat!r} not covered by the rule"
        window = pc["values"][cat]
    if window is None or unit is None:
        return None, "rule has no window"
    return _add(start, window, unit), ""


def temporal(rule: dict, unit_type: str, data: dict, as_of: date) -> Outcome:
    if not rule.get("target"):
        return Outcome("NOT_APPLICABLE", "temporal", {"reason": "rule has no target event"})
    events = data.get("events")
    if events is None or rule["target"] not in events:
        return Outcome("NOT_APPLICABLE", "temporal", {"reason": f"target event {rule['target']!r} is not part of this evidence"})
    due, why = _due(rule, data)
    if due is None:
        return Outcome("NOT_APPLICABLE", "temporal", {"reason": why})
    deadline = due
    g = rule.get("grace")
    if g and all(data.get(k) == v for k, v in (g.get("when") or {}).items()):
        extra = _add(due, g.get("extra") or 0, g.get("unit") or "years") if isinstance(due, date) else due
        until = _parse_long_date(g["until"]) if isinstance(g.get("until"), str) and not g["until"][:4].isdigit() else _date(g.get("until"))
        cands = [extra] + ([until] if until else [])
        deadline = max(cands) if g.get("combine") == "later" else min(cands)
    done_raw = events.get(rule["target"])
    if isinstance(deadline, datetime):
        done = _dt(done_raw)
        now = datetime.combine(as_of, datetime.min.time())
    else:
        done = _date(done_raw)
        now = as_of
    if done is not None:
        late = done > deadline
    else:
        late = now > deadline
    detail = {"deadline": str(deadline), "done": str(done) if done else None, "window": rule.get("window"), "unit": rule.get("unit")}
    if late:            # exceedance: how late (to completion, or to the evaluation date when still pending)
        gap = (done or now) - deadline
        detail["late_by"] = f"{gap.total_seconds() / 3600:.1f} hours" if isinstance(deadline, datetime) else f"{gap.days} days"
        detail["pending"] = done is None
    if late and rule.get("remediation") and done is not None and isinstance(deadline, date):
        days = (done - deadline).days
        detail["remediation"] = {"penalty_due": days * rule["remediation"]["per_day"], "days_late": days}
    return Outcome("VIOLATION" if late else "COMPLIANT", "temporal", detail)


# ── cardinality ──

def cardinality(rule: dict, unit_type: str, data: dict, as_of: date, siblings: list[dict]) -> Outcome:
    comms = data.get("communications")
    if comms is None or rule.get("field") not in ("advance_intimations", "reminders"):
        return Outcome("NOT_APPLICABLE", "cardinality", {"reason": "counted items not in the evidence"})
    kind = {"advance_intimations": "advance_intimation", "reminders": "reminder"}[rule["field"]]
    host = next((s for s in siblings if s.get("kind") == "temporal" and s.get("per_category")), None)
    if host is None:
        return Outcome("NOT_APPLICABLE", "cardinality", {"reason": "no due date rule in the clause"})
    due, why = _due(host, data)
    if due is None:
        return Outcome("NOT_APPLICABLE", "cardinality", {"reason": why})
    if due > as_of:
        return Outcome("NOT_APPLICABLE", "cardinality", {"reason": "not yet due", "due": str(due)})
    done = _date((data.get("events") or {}).get(host.get("target")))
    if rule.get("when") == "after_due":
        if done is not None and done <= due:
            return Outcome("NOT_APPLICABLE", "cardinality", {"reason": "complied by the due date"})
        end = min(done, as_of) if done else as_of
        items = [c for c in comms if c["kind"] == kind and due < _date(c["date"]) <= end]
    else:
        items = [c for c in comms if c["kind"] == kind and _date(c["date"]) < due]
    n = len(items)
    ok = OPS[rule["op"]](n, rule["value"])
    sub = rule.get("sub")
    n_sub = None
    if sub:
        flt = sub.get("filter") or {}
        n_sub = sum(1 for c in items if all(c.get(k) == v for k, v in flt.items()))
        ok = ok and OPS[sub["op"]](n_sub, sub["value"])
    detail = {"counted": n, "required": f"{rule['op']} {rule['value']}", "sub_counted": n_sub, "due": str(due)}
    if not ok and rule["op"] in (">=", ">"):
        detail["shortfall"] = max(0, int(rule["value"]) - n)
    return Outcome("COMPLIANT" if ok else "VIOLATION", "cardinality", detail)


# ── set ──

def required_set(rule: dict, unit_type: str, data: dict, as_of: date) -> Outcome:
    groups = [list(g) for g in rule.get("required") or []]
    if not groups:
        return Outcome("NOT_APPLICABLE", "set", {"reason": "no required items"})
    docs = set(data.get("documents") or [])
    # testable only if the evidence records at least one of the listed items
    observable = lambda f: f in data or ("documents" in data and f in DOCUMENT_ITEMS)
    if not any(observable(f) for g in groups for f in g):
        return Outcome("NOT_APPLICABLE", "set", {"reason": "none of the required items is part of this evidence type"})
    for ex in rule.get("exceptions") or []:
        when = ex.get("when") or {}
        if when and all(data.get(k) == v for k, v in when.items()):
            alt = ex.get("originator_any_of") or ex.get("any_of")
            if alt:
                if "originator_any_of" in ex:   # the originator items are replaced by the alternative
                    groups = [g for g in groups if not any(f.startswith("originator_") for f in g)]
                groups.insert(0, list(alt))
    present = lambda f: (f in docs) or bool(data.get(f))
    missing = [g for g in groups if not any(present(f) for f in g)]
    return Outcome("VIOLATION" if missing else "COMPLIANT", "set", {"missing_groups": missing, "groups": groups})


def validate(rule: dict, unit_type: str, data: dict, as_of: date, siblings: list[dict] | None = None) -> Outcome:
    ok, why = in_scope(rule, unit_type, data)
    if not ok:
        return Outcome("NOT_APPLICABLE", rule.get("kind", "?"), {"reason": why})
    k = rule.get("kind")
    if k == "threshold":
        return threshold(rule, unit_type, data, as_of)
    if k == "temporal":
        return temporal(rule, unit_type, data, as_of)
    if k == "cardinality":
        return cardinality(rule, unit_type, data, as_of, siblings or [])
    if k == "set":
        return required_set(rule, unit_type, data, as_of)
    return Outcome("NOT_APPLICABLE", str(k), {"reason": "unknown rule kind"})
