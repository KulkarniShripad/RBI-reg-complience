"""Rule extraction: operational clause -> machine-testable rules (paper Sec. III, Task 1b).

A rule is one of four kinds, each with the parameters its validator needs:

  threshold    field, aggregate (sum|max|none), period, op, value, unit
  temporal     anchor event(s), target event, window + unit, optional per-category
               windows (e.g. by risk) and a grace clause
  cardinality  counted field, op, value, optional sub-condition (e.g. "at least one by letter")
  set          required groups of fields (each group: any-of)
plus, for every kind: scope conditions (e.g. small accounts, cross-border
transfers), exceptions from provisos, the source sentence and the clause id.

The grammar below is generic (comparators, "within N days of X", "once in every
N years for Y", "at least N ... including at least M ... by letter", lists after
"shall be accompanied by / shall obtain the following"). Phrases are grounded
to schema fields and events through lexicon.py.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field as dc_field

from . import lexicon as L
from .text import amounts_in, parse_number, split_sentences

NUMW = r"(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty-five|sixty|ninety)"
MONTHS = r"(?:January|February|March|April|May|June|July|August|September|October|November|December)"
MODAL = re.compile(r"\b(?:shall|must|is required to|are required to|should)\b", re.I)

COMPARATORS = [
    (r"shall not be (?:less|lower) than|should not be (?:less|lower) than|not (?:be )?less than|not lower than|not below|at least|a minimum of|minimum of", ">="),
    (r"shall not exceed|should not exceed|does not exceed|do not exceed|not exceeding|not to exceed|shall not be (?:more|higher|greater) than|should not be (?:more|higher|greater) than|not (?:be )?(?:more|higher|greater) than|up to|upto|a maximum of|maximum of|capped at|ceiling of", "<="),
    (r"less than|lower than|below", "<"),
    (r"more than|higher than|greater than|above|exceeding|in excess of|exceeds", ">"),
]
C_COMP = re.compile("|".join(f"(?P<c{i}>{p})" for i, (p, _) in enumerate(COMPARATORS)), re.I)

WINDOW = re.compile(
    rf"within (?:a period of )?(?P<n>{NUMW}) (?P<wd>working |calendar )?(?P<u>days?|hours?|weeks?|months?|years?)"
    r"(?:\s+(?:of|from|after)\s+(?P<anchor>[^.;]{0,160}))?",
    re.I,
)
EVERY = re.compile(rf"once in every (?P<n>{NUMW}) (?P<u>years?|months?) for (?P<cat>[^,;.]{{0,40}}?(?:customers?|accounts?))", re.I)
EVERY_TAIL = re.compile(r"(?:from|since) (?:the date of )?(?P<anchor>[^.;]{0,120})", re.I)
GRACE = re.compile(
    rf"within (?P<n>{NUMW}) (?P<u>years?|months?) of its falling due[^.]{{0,80}}?up to (?P<date>{MONTHS}\s+\d{{1,2}},\s*\d{{4}}),?\s*whichever is later",
    re.I,
)
CARD = re.compile(
    rf"(?P<cmp>at least|not more than|not less than|a minimum of|a maximum of) (?P<n>{NUMW}) (?P<noun>advance intimations?|reminders?|(?:KYC )?documents?)"
    rf"(?:,? including at least (?P<sn>{NUMW}) (?:intimations?|reminders?|documents?) (?P<mode>by (?:letter|e-?mail|SMS)))?",
    re.I,
)
SET_TRIGGER = re.compile(r"(?:shall be accompanied by|shall contain|shall include|shall obtain the following|shall submit the following|the following(?: information| details| documents)?)[^:]{0,220}:", re.I)
EXTEND_ANCHOR = re.compile(
    rf"(?:timeline|period) of (?P<n>{NUMW}) (?P<wd>working |calendar )?days? shall be calculated after excluding the number of days taken by [^.]{{0,40}}? to (?P<ev>[^.]{{0,80}})",
    re.I,
)
PENALTY = re.compile(r"penalty of (?:₹|Rs\.?)\s*(?P<amt>\d[\d,]*) per (?:calendar )?day", re.I)
PROVISO = re.compile(r"\bprovided that\b", re.I)
ACCOUNT_FIELDS = {"credits", "debits", "balance", "cash"}


@dataclass
class Rule:
    rule_id: str
    clause_id: str
    kind: str
    sentence: str
    field: str | None = None
    aggregate: str | None = None
    period: str | None = None
    op: str | None = None
    value: float | None = None
    unit: str | None = None
    role: str = "limit"                       # limit | condition (a comparator that scopes, not constrains)
    anchor: list[str] = dc_field(default_factory=list)
    anchor_mode: str | None = None            # latest | earliest (several anchors)
    target: str | None = None
    window: float | None = None
    per_category: dict | None = None          # {"field": "risk", "values": {...}}
    grace: dict | None = None
    sub: dict | None = None                   # cardinality sub-condition
    when: str | None = None                   # before_due | after_due
    required: list[list[str]] = dc_field(default_factory=list)
    conditions: dict = dc_field(default_factory=dict)
    exceptions: list[dict] = dc_field(default_factory=list)
    remediation: dict | None = None

    def as_dict(self) -> dict:
        return asdict(self)


def _num(tok: str) -> float | None:
    return parse_number(tok)


def _unit(u: str, working: str | None) -> str:
    u = u.lower().rstrip("s")
    if u == "day":
        return "working_days" if working and working.strip().lower() == "working" else "days"
    return {"hour": "hours", "week": "weeks", "month": "months", "year": "years"}[u]


def _events(text: str) -> list[tuple[int, int, str]]:
    return L.all_matches(L.C_EVENTS, text)


def _clause_conditions(text: str) -> dict:
    cond = {}
    for rx, v in L.C_CONDITIONS:
        if rx.search(text):
            cond.update(v)
    return cond


# ── threshold ──

def _comparator_at(s: str):
    for m in C_COMP.finditer(s):
        for i, (_, op) in enumerate(COMPARATORS):
            if m.group(f"c{i}"):
                return m, op
    return None, None


def extract_thresholds(sentence: str) -> list[dict]:
    """(op, value, unit, subject, role) for every comparator followed by an amount or a percentage."""
    out = []
    prev_ends: list[int] = []
    modal = MODAL.search(sentence)
    for m in C_COMP.finditer(sentence):
        op = next(o for i, (_, o) in enumerate(COMPARATORS) if m.group(f"c{i}"))
        tail = sentence[m.end(): m.end() + 60]
        amt = amounts_in(tail)
        pct = re.match(r"\s*(\d+(?:\.\d+)?)\s*(?:per ?cent|%)", tail, re.I)
        if amt and amt[0][1] <= 3:
            value, unit, vend = amt[0][0], "INR", m.end() + amt[0][2]
        elif pct:
            value, unit, vend = float(pct.group(1)), "percent", m.end() + pct.end()
        else:
            continue
        seg_start = max([0] + [x.end() for x in re.finditer(r";|\(\w{1,4}\)\s|:\s", sentence[: m.start()])] + [p for p in prev_ends if p <= m.start()])
        subject = re.sub(r"^\s*(?:\(\w{1,4}\)\s*)+", "", sentence[seg_start: m.start()]).strip()
        role = "condition" if modal and m.start() < modal.start() else "limit"
        prev_ends.append(vend)
        out.append({"op": op, "value": value, "unit": unit, "subject": subject[-160:], "role": role,
                    "segment": sentence[seg_start: min(len(sentence), vend + 80)], "span": (m.start(), vend)})
    # implicit comparators: "maintain a minimum CRAR of 9 per cent", "the minimum leverage ratio ... shall be 4 per cent"
    for m in IMPLICIT.finditer(sentence):
        if any(a <= m.start("val") < b for _, _, (a, b) in ((None, None, t["span"]) for t in out)):
            continue
        val = _value_at(sentence, m.start("val"))
        if not val:
            continue
        value, unit, vend = val
        op = "<=" if m.group("kw").lower() == "maximum" else ">="
        out.append({"op": op, "value": value, "unit": unit, "subject": m.group("np").strip(), "role": "limit",
                    "segment": sentence[m.start(): min(len(sentence), vend + 80)], "span": (m.start(), vend)})
    # coordinated values inherit the comparator: "shall be 4 per cent and 3.5 per cent for other banks"
    for t in list(out):
        rest = sentence[t["span"][1]:]
        co = re.match(r"\s*(?:,|and|or)\s+(?:a |an )?(?=[₹\d]|Rs)", rest)
        if co:
            val = _value_at(sentence, t["span"][1] + co.end())
            if val and val[1] == t["unit"]:
                out.append(dict(t, value=val[0], span=(t["span"][1] + co.end(), val[2])))
    return out


IMPLICIT = re.compile(
    r"\b(?P<kw>minimum|maximum|maintain)\b(?P<np>(?:\s+(?!(?:shall|should|of|is|be|which|that|and)\b)[\w()/-]+){0,12}?)"
    r"\s+(?:of|shall be|should be|is|at)\s+(?P<val>(?=[₹\d]|Rs))",
    re.I,
)


def _value_at(s: str, pos: int):
    """(value, unit, end) of an amount or a percentage starting at pos."""
    tail = s[pos: pos + 60]
    pct = re.match(r"(\d+(?:\.\d+)?)\s*(?:per ?cent|%)", tail, re.I)
    if pct:
        return float(pct.group(1)), "percent", pos + pct.end()
    amt = amounts_in(tail)
    if amt and amt[0][1] == 0:
        return amt[0][0], "INR", pos + amt[0][2]
    return None


# ── set ──

def _split_items(body: str) -> list[tuple[str, str]]:
    """Top-level list items of `body` as (text, joiner-to-next: 'or'|'and').

    Markers must run in sequence - (1), (2), (3) or (a), (b), (c) - so a "(1)" inside
    "sub-section (1)" is not a new item; the list ends with the first item that
    ends a sentence."""
    first = re.search(r"\((\d{1,2}|[a-h])\)\s", body)
    if not first:
        return []
    digits = first.group(1).isdigit()
    label = int(first.group(1)) if digits else ord(first.group(1))
    starts = [(first.start(), first.end())]
    pos = first.end()
    while True:
        label += 1
        nxt = str(label) if digits else chr(label)
        m = re.search(rf"\({re.escape(nxt)}\)\s", body[pos:])
        if not m:
            break
        starts.append((pos + m.start(), pos + m.end()))
        pos = pos + m.end()
    items = []
    for i, (st, en) in enumerate(starts):
        txt = body[en: starts[i + 1][0] if i + 1 < len(starts) else len(body)]
        end = re.search(r"\.\s+(?=[A-Z(])", txt)                 # item ends a sentence: list is over
        last = bool(end) or i + 1 == len(starts)
        if end:
            txt = txt[: end.start() + 1]
        txt = re.split(r"\s\((?:ii|iii|iv|v|vi)\)\s|\bProvided that\b", txt)[0]
        joiner = "or" if re.search(r"(?:;|,)?\s*or\s*$", txt.strip(), re.I) else "and"
        items.append((txt.strip(), joiner))
        if last:
            break
    return items


def _list_tail(body: str, items: list[tuple[str, str]]) -> str:
    """The sentence right after the list (e.g. "In the absence of an account, ...")."""
    if not items:
        return ""
    last = items[-1][0]
    i = body.find(last)
    if i < 0:
        return ""
    rest = body[i + len(last):].strip()
    m = re.match(r"[^.]{0,300}\.", rest)
    return m.group(0) if m else ""


def extract_set(text: str) -> list[dict]:
    out = []
    for trig in SET_TRIGGER.finditer(text):
        items = _split_items(text[trig.end(): trig.end() + 4000])
        # "using any one of the following:" - one item suffices
        any_one = re.search(r"\b(?:any(?: one)? of|one of|either of)\s*$", text[max(0, trig.start() - 40): trig.start()], re.I)
        groups: list[list[str]] = []
        open_or = False
        grounded = True
        for txt, joiner in items:
            if re.search(r"\bmay\b", txt, re.I):              # optional items ("as may be required by the bank")
                open_or = False
                continue
            fields = [v for _, _, v in L.all_matches(L.C_SET_ITEMS, txt)]
            fields = list(dict.fromkeys(fields))
            if not fields:
                grounded = False                                # an item the record schema cannot observe
                break
            if open_or and groups:
                groups[-1] = list(dict.fromkeys(groups[-1] + fields))
            elif fields not in groups:
                groups.append(fields)
            open_or = joiner == "or"
        if not grounded:
            continue        # a list is testable only if every required item maps to a record field
        if any_one and groups:
            groups = [list(dict.fromkeys(f for g in groups for f in g))]
        # "In the absence of an account, a unique transaction reference number should be
        # included": an alternative for every item about that thing
        tail = _list_tail(text[trig.end(): trig.end() + 4000], items)
        ab = re.match(r"\s*In the absence of (?:an?|the) (\w+)", tail, re.I)
        if ab:
            alts = [v for _, _, v in L.all_matches(L.C_SET_ITEMS, tail)]
            for g in groups:
                if any(ab.group(1).lower() in f for f in g):
                    g.extend(a for a in alts if a not in g)
        if groups:
            out.append({"required": groups, "span": (trig.start(), trig.end())})
    return out


# ── main entry ──

def extract_rules(clause_id: str, text: str) -> list[Rule]:
    text = re.sub(r"\s+", " ", text).strip()
    sents = split_sentences(text)
    cond = _clause_conditions(text)
    rules: list[Rule] = []

    def new(kind, sentence, **kw) -> Rule:
        r = Rule(f"{clause_id}#{len(rules) + 1}", clause_id, kind, sentence, conditions=dict(cond), **kw)
        rules.append(r)
        return r

    for s in sents:
        # temporal: grace clause first (suppresses a plain window on the same sentence)
        g = GRACE.search(s)
        if g:
            when = {}
            if re.search(r"\bindividual\b", s, re.I):
                when["customer_type"] = "individual"
            cat = L.first(L.C_CATEGORIES, s)
            if cat:
                when[cat[0]] = cat[1]
            date = g.group("date")
            new("grace", s, grace={"when": when, "extra": _num(g.group("n")), "unit": _unit(g.group("u"), None), "until": date, "combine": "later"})
            continue
        every = list(EVERY.finditer(s))
        if every:
            vals, fieldname, unit = {}, None, None
            for m in every:
                cat = L.first(L.C_CATEGORIES, m.group("cat"))
                if cat:
                    fieldname = cat[0]
                    vals[cat[1]] = _num(m.group("n"))
                    unit = _unit(m.group("u"), None)
            tail = EVERY_TAIL.search(s[every[-1].end():])
            anchors = [v for _, _, v in _events(tail.group("anchor"))] if tail else []
            before = s[: every[0].start()]
            targets = [v for _, _, v in _events(before)]
            new("temporal", s, anchor=anchors, anchor_mode="latest" if len(anchors) > 1 else None,
                target=targets[-1] if targets else None, unit=unit,
                per_category={"field": fieldname, "values": vals} if vals else None)
            continue
        for w in ([] if PENALTY.search(s) else WINDOW.finditer(s)):
            ev = _events(s)
            modal = MODAL.search(s)
            anchor_txt = w.group("anchor") or ""
            anchors = [v for _, _, v in _events(anchor_txt)]
            a_span = (w.start("anchor"), w.end("anchor")) if w.group("anchor") else (None, None)
            in_anchor = lambda st: a_span[0] is not None and a_span[0] <= st < a_span[1]
            if not anchors:
                # "Any request for closure ... shall be honoured within ..." / "whenever the bank obtains ..., shall within ..."
                cut = modal.start() if modal else w.start()
                anchors = [v for st, en, v in ev if en <= cut]
            targets = [(st, v) for st, _, v in ev if not in_anchor(st) and v not in anchors]
            if modal:
                after = [t for t in targets if t[0] > modal.start()]
                targets = after or targets
            target = min(targets, key=lambda t: abs(t[0] - w.start()))[1] if targets else None
            new("temporal", s, anchor=anchors[:2], anchor_mode="latest" if len(anchors) > 1 else None,
                target=target, window=_num(w.group("n")), unit=_unit(w.group("u"), w.group("wd")))
        for c in CARD.finditer(s):
            op = {"at least": ">=", "not less than": ">=", "a minimum of": ">=", "not more than": "<=", "a maximum of": "<="}[c.group("cmp").lower()]
            fieldname = L.first(L.C_COUNT_FIELDS, c.group("noun"))
            sub = None
            if c.group("sn"):
                sub = {"filter": {"mode": L.first(L.C_MODES, c.group("mode"))}, "op": ">=", "value": _num(c.group("sn"))}
            when = "after_due" if re.search(r"(?:subsequent to|after) the due date", s, re.I) else "before_due" if re.search(r"\badvance\b", c.group("noun"), re.I) else None
            new("cardinality", s, field=fieldname, op=op, value=_num(c.group("n")), unit="count", sub=sub, when=when)
        if PROVISO.match(s.strip()):
            continue  # provisos refine other rules (handled below), they do not create thresholds
        if re.search(r"\bmay\b", s, re.I) and not MODAL.search(s):
            continue  # a permission ("... may be provided for balances exceeding ...") sets no limit
        for t in extract_thresholds(s):
            f = L.first(L.C_FIELDS, t["subject"])
            if f and f[0] in ACCOUNT_FIELDS and not cond and not re.search(r"\baccounts?\b", t["segment"], re.I):
                f = None    # an account-level limit needs an account population ("small accounts", "deposit accounts")
            per = L.first(L.C_PERIODS, t["segment"])
            new("threshold", s, field=f[0] if f else None, aggregate=f[1] if f else None, period=per,
                op=t["op"], value=t["value"], unit=t["unit"], role=t["role"])

    for st in extract_set(text):
        new("set", text[st["span"][0]: st["span"][0] + 400], required=st["required"])

    # ── clause-level refinements ──
    for s in sents:
        if PROVISO.search(s) and re.search(r"not (?:consider|apply)|shall not be (?:considered|reckoned)|exempt", s, re.I):
            srcs = [v for _, _, v in L.all_matches(L.C_SOURCES, s)]
            f = L.first(L.C_FIELDS, s)
            for r in rules:
                if r.kind == "threshold" and srcs and f and r.field == f[0]:
                    r.exceptions.append({"exclude_credit_sources": srcs})
        if re.search(r"\bbatch\b", s, re.I) and re.search(r"exempt", s, re.I):
            inc = re.search(r"provided that they include (?P<x>[^,.;]{0,160})", s, re.I)
            if inc:
                alts = [v for _, _, v in L.all_matches(L.C_SET_ITEMS, inc.group("x"))]
                key = "originator_any_of" if re.search(r"originator information", s, re.I) else "any_of"
                for r in rules:
                    if r.kind == "set":
                        r.exceptions.append({"when": {"batch": True}, key: list(dict.fromkeys(alts))})
        ext = EXTEND_ANCHOR.search(s)
        if ext:
            extra = [v for _, _, v in _events(ext.group("ev"))]
            for r in rules:
                if r.kind == "temporal" and r.window == _num(ext.group("n")) and extra:
                    r.anchor = list(dict.fromkeys(r.anchor + extra))
                    r.anchor_mode = "latest"
        pen = PENALTY.search(s)
        if pen:
            for r in rules:
                if r.kind == "temporal" and r.target == "card_closed":
                    r.remediation = {"per_day": float(pen.group("amt").replace(",", "")), "unit": "INR"}

    # a grace clause belongs to the per-category temporal rule of the same clause
    graces = [r for r in rules if r.kind == "grace"]
    for g in graces:
        host = next((r for r in rules if r.kind == "temporal" and r.per_category), None)
        if host:
            host.grace = g.grace
        rules.remove(g)
    return rules


def extract_corpus(clauses: list[dict], only_operational: bool = True) -> list[dict]:
    from .obligations import is_operational

    out = []
    for c in clauses:
        if only_operational and not is_operational(c["text"], c.get("kind", "paragraph")):
            continue
        out.extend(r.as_dict() for r in extract_rules(c["clause_id"], c["text"]))
    return out
