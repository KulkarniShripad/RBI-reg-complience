"""
Stage 2 of the pipeline: classify each parsed clause and extract structured
data from it. Everything here is deterministic (regex-based pattern
matching), matching the design principle discussed earlier - LLM refinement
is reserved for the minority of clauses this stage marks low-confidence, and
is implemented as a stubbed interface (see llm_refiner.py) rather than
actually called, since this sandbox has no access to a local model server.
"""
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Classification signals
# ---------------------------------------------------------------------------

QUANT_PATTERNS = [
    re.compile(r'(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE),
    re.compile(r'(\d+(?:\.\d+)?)\s*%'),
    re.compile(r'within\s+(\d+)\s+(business\s+)?days', re.IGNORECASE),
    re.compile(r'not\s+later\s+than\s+(\d+)\s+(business\s+)?days', re.IGNORECASE),
    re.compile(r'(?:rs\.?|inr|₹)\s*[\d,]+(?:\.\d+)?\s*(crore|lakh|lakhs|crores)?', re.IGNORECASE),
    re.compile(r'\bratio\b', re.IGNORECASE),
]

RELATIONAL_KEYWORDS = [
    "group of connected counterparties", "connected counterparties", "beneficial owner",
    "single borrower", "single counterparty", "group exposure", "aggregate exposure",
    "related party", "subsidiary", "holding company", "parent entity", "common control",
    "economic interdependence",
]

# Operator templates, ordered most-specific first. Each entry:
#   (regex, operator, unit_hint)
RULE_ATOM_TEMPLATES = [
    (re.compile(r'shall\s+not\s+exceed\s+(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE), '<=', '%'),
    (re.compile(r'shall\s+not\s+exceed\s+(\d+(?:\.\d+)?)\s*%', re.IGNORECASE), '<=', '%'),
    (re.compile(r'not\s+exceed(?:ing)?\s+(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE), '<=', '%'),
    (re.compile(r'shall\s+be\s+at\s+least\s+(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE), '>=', '%'),
    (re.compile(r'not\s+less\s+than\s+(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE), '>=', '%'),
    (re.compile(r'not\s+more\s+than\s+(\d+(?:\.\d+)?)\s*per\s*cent', re.IGNORECASE), '<=', '%'),
    (re.compile(r'within\s+(\d+)\s+business\s+days', re.IGNORECASE), 'within_days', 'business_days'),
    (re.compile(r'within\s+(\d+)\s+days', re.IGNORECASE), 'within_days', 'days'),
    (re.compile(r'not\s+later\s+than\s+(\d+)\s+business\s+days', re.IGNORECASE), 'within_days', 'business_days'),
]

# A small, honestly-incomplete dictionary of known regulatory variable names.
# Anything not in here stays as free text ("variable_text") for human/LLM
# normalization later - fabricating a canonical name we're not sure of would
# violate the accuracy-first design principle.
KNOWN_VARIABLES = {
    "liquidity coverage ratio": "liquidity_coverage_ratio",
    "capital to risk weighted assets ratio": "crar",
    "capital adequacy ratio": "crar",
    "net stable funding ratio": "nsfr",
    "statutory liquidity ratio": "slr",
    "cash reserve ratio": "crr",
    "priority sector lending": "psl_target",
    "net owned fund": "net_owned_fund",
    "tier i capital": "tier1_capital",
    "tier 1 capital": "tier1_capital",
}


@dataclass
class ClauseClassification:
    clause_type: str                 # 'quantitative' | 'qualitative' | 'relational' | 'hybrid'
    confidence: str                  # 'high' | 'low'
    rule_atom: dict | None = None    # populated only for high-confidence quantitative matches
    needs_llm_refinement: bool = False
    match_evidence: str = ""         # the matched substring, for audit/debug


def classify_clause(clause_text: str) -> ClauseClassification:
    text = clause_text.strip()
    is_relational = any(kw in text.lower() for kw in RELATIONAL_KEYWORDS)
    quant_hit = any(p.search(text) for p in QUANT_PATTERNS)

    if not quant_hit and not is_relational:
        return ClauseClassification(clause_type="qualitative", confidence="high")

    # Try to extract a clean rule_atom via template match
    for pattern, operator, unit in RULE_ATOM_TEMPLATES:
        m = pattern.search(text)
        if m:
            threshold = float(m.group(1))
            variable_text = _guess_variable(text, m.start())
            canonical = KNOWN_VARIABLES.get(variable_text.lower().strip(), None)
            clause_type = "hybrid" if is_relational else "quantitative"
            return ClauseClassification(
                clause_type=clause_type,
                confidence="high",
                rule_atom={
                    "operator": operator,
                    "threshold_value": threshold,
                    "threshold_unit": unit,
                    "variable_text": variable_text,
                    "variable_name": canonical,       # None if not in KNOWN_VARIABLES
                    "value_source": "graph_aggregate" if is_relational else "direct_report",
                },
                match_evidence=m.group(0),
            )

    # Quantitative/relational signal present, but no clean template matched -
    # e.g. compound conditions, cross-referenced thresholds, tables. Flag for
    # LLM refinement rather than force a low-quality guess.
    clause_type = "relational" if is_relational and not quant_hit else "hybrid" if is_relational else "quantitative"
    return ClauseClassification(clause_type=clause_type, confidence="low", needs_llm_refinement=True)


def _guess_variable(text: str, match_start: int, window_words: int = 8) -> str:
    """Heuristic: the variable being constrained is usually the clause's own
    subject, sitting just before the operator phrase ('X shall not exceed
    Y%'). Bound the search window to the last sentence/list-item delimiter
    before the match, not just a fixed word count - otherwise a match deep
    in a table or multi-sentence paragraph pulls in unrelated preceding
    text (confirmed on real extraction output: unbounded windows produced
    nonsense like 'network as applicable b in all other cases'). This is
    still a heuristic, not a claim of correctness - low-confidence variable
    text is exactly what gets queued for LLM refinement downstream."""
    prefix = text[:match_start]
    # last sentence/list-item boundary: '.', ';', or a "N." list marker
    boundary_matches = list(re.finditer(r'[.;]\s|(?<=\s)\d{1,2}\.\s', prefix))
    if boundary_matches:
        prefix = prefix[boundary_matches[-1].end():]
    words = re.findall(r"[A-Za-z][A-Za-z\-']*", prefix)
    candidate = " ".join(words[-window_words:])
    candidate = re.sub(r'^(the|an|a|of|its|their|and|or)\s+', '', candidate, flags=re.IGNORECASE)
    return candidate.strip()


# ---------------------------------------------------------------------------
# Definitions extraction (Stage 2b) - separate from rule_atoms entirely.
# ---------------------------------------------------------------------------

RE_DEFINITION_ENTRY = re.compile(
    r'^[\u2018\u2019\'\u201c\u201d"]([^\u2018\u2019\'\u201c\u201d"]{2,150})[\u2018\u2019\'\u201c\u201d"]\s*'
    r'(?:\([^)]{1,20}\)\s*)?(means|shall mean|shall have the (?:same )?meaning[^.]*)\s*(.*)$',
    re.IGNORECASE
)


def extract_definitions(paragraph) -> list[dict]:
    """Only called on paragraphs already flagged is_definitions_paragraph by
    the structural parser. Each sub-clause of a Definitions paragraph is
    typically one defined term."""
    out = []
    for sub_no, sub_text, page in paragraph.subclauses:
        m = RE_DEFINITION_ENTRY.match(sub_text.strip())
        if m:
            term = m.group(1).strip()
            definition_text = (m.group(2) + " " + m.group(3)).strip()
            out.append({
                "term": term, "definition_text": definition_text,
                "sub_clause_number": sub_no, "page": page,
            })
        else:
            # still store it, unparsed, rather than silently drop a
            # definitions sub-clause just because the 'X means Y' template
            # didn't match this particular sentence's phrasing
            out.append({
                "term": None, "definition_text": sub_text.strip(),
                "sub_clause_number": sub_no, "page": page,
            })
    return out


# ---------------------------------------------------------------------------
# Cross-reference extraction (Stage 2c)
# ---------------------------------------------------------------------------

RE_CROSSREF = re.compile(
    r'[Pp]aragraphs?\s+(\d{1,3})(?:\((\d{1,2})\))?(?:\s+(?:to|and)\s+(\d{1,3}))?')
RE_ANNEX_REF = re.compile(r'Annex[\s-]?([IVXLCDM]+)', re.IGNORECASE)


def extract_cross_references(clause_text: str, own_paragraph_number: int | str) -> list[dict]:
    refs = []
    for m in RE_CROSSREF.finditer(clause_text):
        target = int(m.group(1))
        if str(target) == str(own_paragraph_number):
            continue  # a paragraph mentioning its own number isn't a cross-reference
        refs.append({
            "target_paragraph": target,
            "target_sub_clause": int(m.group(2)) if m.group(2) else None,
            "range_end": int(m.group(3)) if m.group(3) else None,
            "ref_type": "paragraph",
        })
    for m in RE_ANNEX_REF.finditer(clause_text):
        refs.append({"target_annex": m.group(1), "ref_type": "annex"})
    return refs
