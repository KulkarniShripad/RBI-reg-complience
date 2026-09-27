"""
Stage 2: classify each clause and extract structured data from it.
Deterministic (regex + simple sentence logic); no LLM calls.

What changed from the first version, and why (measured on the corpus):
  * Rule atoms are extracted per SENTENCE and a clause can yield several
    (the old code stopped at the first match per clause, so a paragraph with
    an HTM ceiling and an SLR carve-out produced one atom).
  * Many more phrasings: "minimum X of N per cent", "up to", "ceiling of",
    "capped at", "limited to", "at least", "N per cent or more", money
    amounts (Rs / ₹ crore / lakh), months and working days.
  * Every atom is labelled `requirement` (a modal verb - shall / should /
    must / is required to - governs it, so a bank can breach it) or
    `condition` ("loans exceeding ₹5 crore shall ...": a scope trigger, not
    something to comply with). Only requirements feed compliance checks.
  * Clause roles (definition, applicability, obligation, deleted, ...) so
    that qualitative compliance checks and search can ignore boiler-plate
    like "These Directions shall be called ...".
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

NUM = r"(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)"
PCT = r"\s*(?:per\s*cent(?:age\s+points?)?|percent|%)"
MONEY_UNIT = r"\s*(crores?|lakhs?|lacs?|million|billion)?"
MONEY = rf"(?:₹|Rs\.?|INR|Rupees)\s*{NUM}{MONEY_UNIT}"
DUR = rf"{NUM}\s*(working\s+days?|business\s+days?|calendar\s+days?|days?|months?|years?|weeks?)"

MODAL = re.compile(
    r"\b(shall|should|must|will\s+have\s+to|is\s+required\s+to|are\s+required\s+to|has\s+to|have\s+to|"
    r"is\s+to\s+be|are\s+to\s+be|may\s+not|cannot|can\s+not|is\s+not\s+permitted|are\s+not\s+permitted|"
    r"is\s+prohibited|are\s+prohibited|are\s+advised\s+to|is\s+advised\s+to|mandated|required)\b", re.I)

UPPER = r"(?:shall\s+not\s+exceed|should\s+not\s+exceed|must\s+not\s+exceed|will\s+not\s+exceed|not\s+to\s+exceed|" \
        r"shall\s+not\s+be\s+more\s+than|should\s+not\s+be\s+more\s+than|not\s+exceeding|does\s+not\s+exceed|" \
        r"do\s+not\s+exceed|not\s+more\s+than|no\s+more\s+than|up\s*to|upto|a\s+maximum\s+of|maximum\s+of|" \
        r"ceiling\s+of|capped\s+at|cap\s+of|limited\s+to|restricted\s+to|within\s+(?:a|the)\s+(?:limit|ceiling)\s+of|" \
        r"at\s+(?:the\s+)?most|less\s+than\s+or\s+equal\s+to)"
LOWER = r"(?:not\s+less\s+than|no\s+less\s+than|at\s+least|a\s+minimum\s+of|minimum\s+of|not\s+below|" \
        r"not\s+lower\s+than|shall\s+be\s+at\s+least|greater\s+than\s+or\s+equal\s+to)"
STRICT_LOWER = r"(?:more\s+than|greater\s+than|exceeding|in\s+excess\s+of|above|over)"
STRICT_UPPER = r"(?:less\s+than|below|lower\s+than)"

VALUE = rf"(?:{MONEY}|{NUM}{PCT}|{DUR}|{NUM}\s*(?:times|bps|basis\s+points))"

VAR = r"[A-Za-z][\w\s\-/()'’&,]{1,80}?"
TEMPLATES = [
    # (regex, operator, strength) - ordered: most specific first.
    # strength: 'strong' phrases are explicit limits; 'weak' ones ("up to",
    # "or more", "exceeding") usually describe scope and only count as a
    # requirement when a modal verb governs them directly.
    (re.compile(rf"(?P<op>minimum|maximum)\s+(?P<var>[^.;]{{2,120}}?)\s+(?:shall|should|must|will)\s+be\s+(?P<val>{VALUE})", re.I), "minmax", "strong"),
    (re.compile(rf"(?P<op>{LOWER})\s+(?:(?:a|an|the)\s+)?(?P<var>{VAR})\s+of\s+(?P<val>{VALUE})", re.I), ">=", "strong"),
    (re.compile(rf"(?P<op>minimum)\s+(?P<var>{VAR})\s+(?:of|at)\s+(?P<val>{VALUE})", re.I), ">=", "strong"),
    (re.compile(rf"(?P<op>maximum|ceiling|cap|limit)\s+(?:(?:on|of|for)\s+)?(?P<var>{VAR})\s+(?:of|at)\s+(?P<val>{VALUE})", re.I), "<=", "strong"),
    # "maintain a Liquidity Coverage Ratio of not less than 100 per cent"
    (re.compile(rf"(?:maintain|hold|keep|have|achieve)\s+(?:a|an|the)?\s*(?P<var>{VAR})\s+of\s+(?P<op>{LOWER}|{UPPER})\s+(?P<val>{VALUE})", re.I), "phrase", "strong"),
    (re.compile(rf"(?P<op>up\s*to|upto)\s+(?P<val>{VALUE})", re.I), "<=", "weak"),
    (re.compile(rf"(?P<op>{UPPER})\s+(?P<val>{VALUE})", re.I), "<=", "strong"),
    (re.compile(rf"(?P<op>{LOWER})\s+(?P<val>{VALUE})", re.I), ">=", "strong"),
    (re.compile(rf"(?P<val>{VALUE})\s+(?P<op>or\s+(?:more|above|higher))", re.I), ">=", "weak"),
    (re.compile(rf"(?P<val>{VALUE})\s+(?P<op>or\s+(?:less|below|lower))", re.I), "<=", "weak"),
    (re.compile(rf"(?P<op>within|not\s+later\s+than|no\s+later\s+than|within\s+a\s+period\s+of|within\s+a\s+maximum\s+period\s+of)\s+(?P<val>{DUR})", re.I), "within", "deadline"),
    (re.compile(rf"(?P<op>not\s+(?:be\s+)?(?:less|lower)\s+than|atleast)\s+(?P<val>{VALUE})", re.I), ">=", "strong"),
    (re.compile(rf"(?P<op>{STRICT_UPPER})\s+(?P<val>{VALUE})", re.I), "<", "weak"),
    (re.compile(rf"(?P<op>{STRICT_LOWER})\s+(?P<val>{VALUE})", re.I), ">", "weak"),
]
UPPER = UPPER.replace(r"up\s*to|upto|", "")

QUANT_SIGNAL = re.compile(rf"{NUM}{PCT}|{MONEY}|\b{DUR}\b|\bratio\b|\bbps\b|basis\s+points", re.I)

RELATIONAL_KEYWORDS = [
    "group of connected counterparties", "connected counterparties", "beneficial owner",
    "single borrower", "single counterparty", "group exposure", "aggregate exposure",
    "related party", "related parties", "subsidiary", "holding company", "parent entity",
    "common control", "economic interdependence", "group entities",
]

KNOWN_VARIABLES = [
    (r"liquidity coverage ratio|\bLCR\b", "liquidity_coverage_ratio"),
    (r"net stable funding ratio|\bNSFR\b", "nsfr"),
    (r"capital to risk[- ]weighted assets ratio|\bCRAR\b|capital adequacy ratio", "crar"),
    (r"common equity tier 1|\bCET\s?1\b", "cet1_ratio"),
    (r"tier[ -]?(?:1|I) capital", "tier1_capital"),
    (r"tier[ -]?(?:2|II) capital", "tier2_capital"),
    (r"leverage ratio", "leverage_ratio"),
    (r"statutory liquidity ratio|\bSLR\b", "slr"),
    (r"cash reserve ratio|\bCRR\b", "crr"),
    (r"net owned fund|\bNOF\b", "net_owned_fund"),
    (r"priority sector", "psl_target"),
    (r"gross NPA|gross non-performing", "gross_npa_ratio"),
    (r"net NPA|net non-performing", "net_npa_ratio"),
    (r"held to maturity|\bHTM\b", "htm_share"),
    (r"single (?:borrower|counterparty)", "single_counterparty_exposure"),
    (r"group of (?:connected )?(?:borrowers|counterparties)", "group_exposure"),
    (r"paid-up (?:equity )?capital", "paid_up_capital"),
    (r"loan[- ]to[- ]value|\bLTV\b", "ltv_ratio"),
    (r"provision coverage", "provision_coverage_ratio"),
    (r"dividend payout", "dividend_payout_ratio"),
]
_KNOWN = [(re.compile(p, re.I), name) for p, name in KNOWN_VARIABLES]

ACTOR = re.compile(r"^(?:every|each|all|any|the|a|an)?\s*(?:applicable\s+|such\s+|scheduled\s+)?(?:bank|banks|nbfcs?|rrbs?|ucbs?|sfbs?|entity|entities|"
                   r"company|companies|institution|institutions|lender|lenders|res?|regulated entit(?:y|ies)|aifis?|arcs?|cics?)$", re.I)

UNIT_MAP = {
    "day": "days", "days": "days", "working day": "working_days", "working days": "working_days",
    "business day": "working_days", "business days": "working_days", "calendar day": "days", "calendar days": "days",
    "month": "months", "months": "months", "year": "years", "years": "years", "week": "weeks", "weeks": "weeks",
}


@dataclass
class RuleAtom:
    operator: str
    threshold_value: float
    threshold_unit: str
    threshold_base: str | None
    variable_text: str
    variable_name: str | None
    value_source: str
    match_evidence: str
    sentence: str
    atom_kind: str          # 'requirement' | 'condition'
    confidence: str         # 'high' | 'low'


@dataclass
class ClauseClassification:
    clause_type: str                 # 'quantitative' | 'qualitative' | 'relational' | 'hybrid'
    clause_role: str                 # see classify_role()
    confidence: str                  # 'high' | 'low'
    is_obligation: bool
    rule_atoms: list = field(default_factory=list)
    needs_llm_refinement: bool = False

    @property
    def rule_atom(self):             # compatibility with callers expecting one atom
        return self.rule_atoms[0] if self.rule_atoms else None


# ---------------------------------------------------------------------------
# Sentences
# ---------------------------------------------------------------------------
ABBREV = r"(?:Rs|No|Nos|Sr|viz|i\.e|e\.g|etc|Ltd|Co|Dr|Mr|Ms|vs|para|Para|Sec|Cl|Govt|Dept|approx|w\.e\.f|p\.a)"


def split_sentences(text: str) -> list[str]:
    t = re.sub(r"\s+", " ", text.replace("\n", " ; ")).strip()
    t = re.sub(rf"\b({ABBREV})\.", lambda m: m.group(1) + "<DOT>", t)
    t = re.sub(r"(\d)\.(\d)", r"\1<DOT>\2", t)
    parts = re.split(r"(?<=[.;?!])\s+(?=[\[(A-Z‘'\"])", t)
    return [p.replace("<DOT>", ".").strip(" ;") for p in parts if len(p.strip(" ;")) > 3]


def _to_float(s: str) -> float:
    return float(s.replace(",", ""))


def _parse_value(val: str) -> tuple[float, str] | None:
    m = re.match(MONEY, val, re.I)
    if m:
        unit = (m.group(2) or "").lower()
        unit = "₹ crore" if unit.startswith("crore") else "₹ lakh" if unit.startswith(("lakh", "lac")) else \
            f"₹ {unit}" if unit else "₹"
        return _to_float(m.group(1)), unit
    m = re.match(rf"{NUM}{PCT}", val, re.I)
    if m:
        return _to_float(m.group(1)), "%"
    m = re.match(DUR, val, re.I)
    if m:
        return _to_float(m.group(1)), UNIT_MAP.get(re.sub(r"\s+", " ", m.group(2).lower()), m.group(2).lower())
    m = re.match(rf"{NUM}\s*(times|bps|basis\s+points)", val, re.I)
    if m:
        u = m.group(2).lower()
        return _to_float(m.group(1)), "bps" if u.startswith(("bps", "basis")) else "times"
    return None


def _clean_variable(s: str) -> str:
    s = re.sub(r"^\s*(?:\(?[a-z0-9ivx]{1,4}\)|[a-z]\.)\s+", "", s.strip())     # leading "(a)" / "iii)"
    prev = None
    while prev != s:
        prev = s
        s = re.sub(r"^(?:that|the|an|a|its|their|any|such|of|and|or|in|which|where|if|provided\s+that)\s+", "", s, flags=re.I)
    s = re.sub(r"\s+(?:is|are|shall|should|must|will|be|was|were|has|have|of|to|at|by)\s*$", "", s, flags=re.I)
    s = re.sub(r"\s+(?:is|are|shall|should|must|will|be|was|were|has|have|of|to|at|by)\s*$", "", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip(" ,;:-–")


def _subject_before(sentence: str, pos: int, max_words: int = 14) -> str:
    """The quantity a threshold constrains is normally the subject just
    before the operator ("Investments under HTM category shall not exceed
    25 per cent"). Bounded to the current clause of the sentence."""
    prefix = sentence[:pos]
    cut = max(prefix.rfind(";"), prefix.rfind(":"), prefix.rfind(" – "))
    for m in re.finditer(r",\s+(?:and\s+|or\s+|of\s+which\s+|while\s+|whereas\s+|but\s+|provided\s+that\s+|where\s+|if\s+|which\s+)", prefix):
        cut = max(cut, m.start())
    prefix = prefix[cut + 1:] if cut >= 0 else prefix
    prefix = MODAL.split(prefix)[0] if MODAL.search(prefix) else prefix
    words = re.findall(r"[\w₹%\-/()'’&.]+", prefix)
    return _clean_variable(" ".join(words[-max_words:]))


def _base_after(sentence: str, end: int) -> str | None:
    m = re.match(r"\s+of\s+(?:the\s+|its\s+|their\s+|a\s+)?([^,;.()]{3,90})", sentence[end:])
    if not m:
        return None
    base = re.split(r"\s+(?:shall|should|must|which|as\s+on|as\s+at|at\s+any|in\s+respect|during|for\s+the|subject)\b",
                    m.group(1))[0]
    return base.strip() or None


def _canonical(var_text: str, sentence: str) -> str | None:
    for rx, name in _KNOWN:
        if rx.search(var_text):
            return name
    for rx, name in _KNOWN:
        if rx.search(sentence):
            return name
    return None


def extract_rule_atoms(text: str, is_relational: bool = False) -> list[RuleAtom]:
    atoms: list[RuleAtom] = []
    seen = set()
    for sent in split_sentences(text):
        if not QUANT_SIGNAL.search(sent):
            continue
        n_values = len(re.findall(VALUE, sent, re.I))
        claimed: list[tuple[int, int]] = []
        for rx, op, strength in TEMPLATES:
            for m in rx.finditer(sent):
                vs, ve = m.span("val")
                if any(a <= vs < b for a, b in claimed):
                    continue
                parsed = _parse_value(m.group("val"))
                if not parsed:
                    continue
                value, unit = parsed
                if unit == "%" and value > 100 and "point" not in m.group("val").lower():
                    continue
                if unit in ("years",) and value > 1900:           # a year, not a duration
                    continue
                claimed.append((vs, ve))
                operator = op
                if op == "minmax":
                    operator = ">=" if m.group("op").lower() == "minimum" else "<="
                if op == "phrase":
                    operator = ">=" if re.match(LOWER, m.group("op"), re.I) else "<="
                if op == "within":
                    operator = "within_days" if unit in ("days", "working_days") else "<="
                before = sent[:m.start()]
                var = _clean_variable(m.group("var")) if "var" in rx.groupindex and m.group("var") else ""
                if var and re.search(r"^(?:\d+|one|two|three|four|five|six|ten)\b|\b(valued|amounting|for\s+(?:loans|properties|accounts|amounts))\b",
                                     var, re.I):
                    claimed.pop()
                    continue            # "minimum two valuation reports for properties valued at ₹50 crore"
                if not var and strength == "deadline":
                    # "The bank shall report the fraud to RBI within 14 days" -> "report the fraud to RBI"
                    modals = list(MODAL.finditer(before))
                    if modals:
                        var = _clean_variable(before[modals[-1].end():])
                if not var:
                    var = _subject_before(sent, m.start())
                if ACTOR.match(var):
                    # "Every applicable NBFC shall maintain a minimum capital
                    # ratio ... which shall not be less than 15 per cent":
                    # the subject is the regulated entity, the constrained
                    # quantity is the object of the verb.
                    modals = list(MODAL.finditer(before))
                    if modals:
                        obj = before[modals[0].end():]
                        obj = re.sub(r"^\s*(?:not\s+)?(?:maintain|have|hold|keep|ensure\s+that|ensure|achieve|be)\s+", "", obj, flags=re.I)
                        obj = re.split(r"\s+(?:which|that)\s+(?:shall|should|must|is|are)\b", obj)[0]
                        obj = _clean_variable(" ".join(obj.split()[:14]))
                        if len(obj.split()) >= 2:
                            var = obj
                base = _base_after(sent, ve) if unit in ("%", "times") else None

                # Requirement vs condition. Strong limit phrases and deadlines
                # are requirements when a modal verb appears earlier in the
                # sentence; weak phrases only when the modal governs them
                # directly ("shall be less than", "should not be more than").
                near_modal = re.search(r"\b(shall|should|must|will|is\s+required\s+to|are\s+required\s+to)\s+(?:not\s+)?"
                                       r"(?:be\s+)?(?:\w+\s+){0,2}$", before, re.I)
                # A threshold inside a conditional / scope phrase is a
                # condition even when the sentence has a modal verb:
                # "applicable to cases where the balance does not exceed
                # ₹50,000", "If a complainant does not get a response within
                # 30 days", "properties valued at ₹50 crore or above".
                last_modal = list(MODAL.finditer(before))
                tail = before[last_modal[-1].end():] if last_modal else before
                in_condition = bool(re.search(
                    r"\b(if|where|whereas|in\s+case|in\s+cases|cases\s+where|provided|unless|when|in\s+the\s+absence|"
                    r"valued\s+at|value\s+of|amounting\s+to|having|with\s+(?:a|an)\s+\w+\s+of)\b", tail, re.I)) \
                    or bool(re.search(r"^\s*(?:if|where|in\s+case|when|unless)\b", sent, re.I) and not last_modal)
                definitional = bool(re.search(r"\b(shall\s+be\s+interpreted\s+as|shall\s+mean|means|is\s+defined\s+as)\b",
                                              before, re.I))
                modal_in_op = bool(MODAL.search(m.group("op")))
                if strength in ("strong", "deadline"):
                    kind = "requirement" if (MODAL.search(before) or modal_in_op or near_modal or op in ("minmax",)) else "condition"
                else:
                    kind = "requirement" if (near_modal or modal_in_op) else "condition"
                if op in (">", "<") and re.search(r"\b(shall|should|must)\s+not\s+(?:\w+\s+){0,3}$", before, re.I):
                    kind = "requirement"
                    operator = "<=" if op == ">" else ">="
                if (in_condition and not modal_in_op) or definitional:
                    kind = "condition"

                confidence = "high" if (kind == "requirement" and var and len(var.split()) >= 2
                                        and n_values <= 3) else "low"
                key = (operator, value, unit, var.lower())
                if key in seen:
                    continue
                seen.add(key)
                atoms.append(RuleAtom(
                    operator=operator, threshold_value=value, threshold_unit=unit, threshold_base=base,
                    variable_text=var[:200], variable_name=_canonical(var, sent),
                    value_source="graph_aggregate" if is_relational else "direct_report",
                    match_evidence=m.group(0)[:200], sentence=sent[:1200], atom_kind=kind, confidence=confidence,
                ))
    return atoms


# ---------------------------------------------------------------------------
# Roles and types
# ---------------------------------------------------------------------------
DEONTIC = re.compile(
    r"\b(shall|must|should|required\s+to|is\s+prohibited|are\s+prohibited|not\s+permitted|may\s+not|"
    r"are\s+advised\s+to|is\s+advised\s+to|ensure|mandatory|obligat\w+|directed\s+to)\b", re.I)
DEFINITION_ITEM = re.compile(
    r"[‘'“\"]([^’'”\"]{2,150})[’'”\"]\s*(?:\([^)]{1,40}\)\s*)?(means|shall\s+mean|shall\s+have\s+the\s+(?:same\s+)?meaning|"
    r"includes|shall\s+include|refers?\s+to|is\s+defined)", re.I)
DELETED = re.compile(r"^[\s\[\]*.]*(?:deleted|omitted|\*{3,})[\s\[\]*.]*$", re.I)


def classify_role(text: str, heading_path: list[str], is_annex=False, is_preamble=False) -> str:
    if is_preamble:
        return "preamble"
    if is_annex:
        return "annex"
    t = text.strip()
    if DELETED.match(t) or re.fullmatch(r"[\s\[\]*]*", t):
        return "deleted"
    heads = " ".join(heading_path).lower()
    first = t[:300].lower()
    if "definition" in heads or len(DEFINITION_ITEM.findall(t)) >= 2 or \
            re.match(r"^(in these directions|for the purpose of these directions)[^.]{0,80}(requires|otherwise)", first):
        return "definition"
    if re.search(r"shall be called|shall come into (force|effect)|come into force|short title", first):
        return "short_title"
    if "applicab" in heads or re.search(r"shall (?:be )?(?:applicable|apply) to|these directions (?:are|shall be) applicable", first):
        return "applicability"
    if "repeal" in heads or re.search(r"stand(?:s)? repealed|hereby repealed", first):
        return "repeal"
    if DEONTIC.search(t):
        return "obligation"
    return "information"


def classify_clause(clause_text: str, heading_path: list[str] | None = None,
                    is_annex=False, is_preamble=False) -> ClauseClassification:
    text = clause_text.strip()
    role = classify_role(text, heading_path or [], is_annex=is_annex, is_preamble=is_preamble)
    is_relational = any(kw in text.lower() for kw in RELATIONAL_KEYWORDS)
    atoms = [] if role in ("deleted", "preamble", "short_title") else extract_rule_atoms(text, is_relational)
    quant = bool(QUANT_SIGNAL.search(text)) and role not in ("deleted",)
    has_req = any(a.atom_kind == "requirement" for a in atoms)

    if quant or has_req:
        clause_type = "hybrid" if is_relational else "quantitative"
    elif is_relational:
        clause_type = "relational"
    else:
        clause_type = "qualitative"

    high = any(a.atom_kind == "requirement" and a.confidence == "high" for a in atoms)
    needs_refinement = clause_type in ("quantitative", "hybrid") and not high and role in ("obligation", "information")
    confidence = "high" if (clause_type == "qualitative" or high) else "low"
    return ClauseClassification(
        clause_type=clause_type, clause_role=role, confidence=confidence,
        is_obligation=role == "obligation", rule_atoms=atoms, needs_llm_refinement=needs_refinement,
    )


# ---------------------------------------------------------------------------
# Definitions
# ---------------------------------------------------------------------------
ITEM_SPLIT = re.compile(r"\n(?=\[?\s*(?:\((?:\d{1,2}|[ivxlc]{1,6}[a-z]?|[a-z]{1,2})\)|(?:[a-z]|[ivx]{1,4})\))\s)")


def extract_definitions(text: str) -> list[dict]:
    """One entry per defined term found in a definitions clause."""
    out = []
    items = ITEM_SPLIT.split(text) if "\n" in text else [text]
    for idx, item in enumerate(items):
        flat = re.sub(r"\s+", " ", item).strip()
        m = DEFINITION_ITEM.search(flat)
        if not m or m.start() > 60:
            m2 = re.match(r"^\s*\[?\s*(?:\([^)]{1,6}\)|[a-z]{1,4}\))\s*(?:The\s+)?([A-Z][^,;]{2,80}?)\s+(means|shall mean)\b", flat)
            if not m2:
                continue
            term = m2.group(1)
        else:
            term = m.group(1)
        marker = re.match(r"^\s*\[?\s*\(?([0-9ivxlca-z]{1,6})\)", flat)
        out.append({
            "term": term.strip(" ‘’'\"“”"), "definition_text": flat[:4000],
            "sub_clause_number": marker.group(1) if marker else str(idx),
        })
    return out


# ---------------------------------------------------------------------------
# Cross references
# ---------------------------------------------------------------------------
RE_CROSSREF = re.compile(
    r"\b[Pp]ara(?:graph)?s?\s+(\d{1,3}[A-Z]?(?:\.\d{1,3}){0,3})(?:\s*\((\d{1,2}|[a-z]{1,3}|[ivx]{1,5})\))?"
    r"(?:\s*(?:to|and|-|–)\s*(\d{1,3}[A-Z]?(?:\.\d{1,3}){0,3}))?")
RE_ANNEX_REF = re.compile(r"\bAnnex(?:ure)?[\s\-–]*([IVXLC]+|\d{1,2})\b")
RE_DOC_REF = re.compile(r"Reserve Bank of India \(([^()]+(?:\([^()]*\))?[^()]*)\) (?:Directions|Guidelines),? \d{4}")


def extract_cross_references(clause_text: str, own_key: str) -> list[dict]:
    refs = []
    for m in RE_CROSSREF.finditer(clause_text):
        target = m.group(1)
        if target == str(own_key):
            continue
        refs.append({"ref_type": "paragraph", "target_paragraph": target,
                     "target_sub_clause": m.group(2), "range_end": m.group(3)})
    for m in RE_ANNEX_REF.finditer(clause_text):
        refs.append({"ref_type": "annex", "target_annex": m.group(1)})
    for m in RE_DOC_REF.finditer(clause_text):
        refs.append({"ref_type": "document", "target_text": m.group(0)})
    return refs
