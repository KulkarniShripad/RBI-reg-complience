"""
Canonical institution categories and topic families.

The problem this fixes: the database held a mix of folder names
("commercial banks", "small financial banks", "Non-Banking", "uncategorized"),
the frontend hard-coded a different list ("commercial_banks",
"small_financial_banks", "KYC", "forex", ...), and uploads created new
categories from whatever string the dropdown sent. Filters and compliance
checks silently matched nothing when the strings differed.

Now every category string - folder name, upload form value, bank record -
goes through `normalise_category()` to one of the ids below. The ids follow
the regulated-entity types on RBI's Master Directions page. Subject areas
such as KYC or governance are *topics*, not institution categories, and are
derived per document by `topics_for_title()`.

This module is the single source of truth: the Node API reads the same
table (`categories`) that db_builder.py writes from CATEGORIES.
"""
from __future__ import annotations

import re

# id, label, clause_uri slug, aliases (lower-case; matched after normalising
# separators), title phrases (regex, matched against document titles)
CATEGORIES = [
    ("commercial_banks", "Commercial Banks", "cb",
     ["commercial banks", "commercial bank", "scheduled commercial banks", "scbs", "scb", "cb", "cbs", "universal banks"],
     [r"commercial banks?", r"universal banks?", r"\bSCBs?\b", r"foreign banks?"]),
    ("small_finance_banks", "Small Finance Banks", "sfb",
     ["small finance banks", "small financial banks", "small finance bank", "sfb", "sfbs"],
     [r"small finance banks?"]),
    ("payments_banks", "Payments Banks", "pb",
     ["payments banks", "payment banks", "payments bank", "payment bank", "pb", "pbs"],
     [r"payments? banks?"]),
    ("local_area_banks", "Local Area Banks", "lab",
     ["local area banks", "local area bank", "lab", "labs"],
     [r"local area banks?"]),
    ("regional_rural_banks", "Regional Rural Banks", "rrb",
     ["regional rural banks", "regional rural bank", "rrb", "rrbs"],
     [r"regional rural banks?", r"\bRRBs?\b"]),
    ("urban_cooperative_banks", "Urban Co-operative Banks", "ucb",
     ["urban cooperative banks", "urban co operative banks", "urban cooperative bank", "ucb", "ucbs",
      "primary urban cooperative banks"],
     [r"urban co-?operative banks?", r"\bUCBs?\b"]),
    ("rural_cooperative_banks", "Rural Co-operative Banks", "rcb",
     ["rural cooperative banks", "rural co operative banks", "rural cooperative bank", "rcb", "rcbs",
      "state cooperative banks", "district central cooperative banks", "stcbs", "dccbs"],
     [r"rural co-?operative banks?", r"state co-?operative banks?", r"district central co-?operative banks?"]),
    ("all_india_financial_institutions", "All India Financial Institutions", "aifi",
     ["all india financial institutions", "all india financial institution", "aifi", "aifis"],
     [r"all india financial institutions?", r"\bAIFIs?\b"]),
    ("nbfc", "Non-Banking Financial Companies", "nbfc",
     ["nbfc", "nbfcs", "non banking", "non banking financial companies", "non banking financial company",
      "housing finance companies", "hfc", "hfcs", "core investment companies", "standalone primary dealers",
      "mortgage guarantee companies", "non operative financial holding company"],
     [r"non-?banking financial compan(y|ies)", r"\bNBFCs?\b", r"housing finance compan(y|ies)",
      r"core investment compan(y|ies)", r"standalone primary dealers?", r"mortgage guarantee compan(y|ies)",
      r"non-operative financial holding compan(y|ies)", r"\bNBFC sector\b"]),
    ("asset_reconstruction_companies", "Asset Reconstruction Companies", "arc",
     ["asset reconstruction companies", "asset reconstruction company", "arc", "arcs"],
     [r"asset reconstruction compan(y|ies)"]),
    ("credit_information_companies", "Credit Information Companies", "cic",
     ["credit information companies", "credit information services", "credit information company", "cic", "cics"],
     [r"credit information compan(y|ies)"]),
    ("non_bank_ppi_issuers", "Non-bank PPI Issuers", "ppi",
     ["non bank ppi issuers", "ppi issuers", "non bank prepaid payment instruments issuers", "ppi"],
     [r"non-?bank prepaid payment instruments? issuers?", r"\bPPI issuers?\b"]),
    ("primary_dealers", "Primary Dealers", "pd",
     ["primary dealers", "primary dealer", "pds"],
     [r"(?<!standalone )primary dealers?"]),
    ("multiple", "Multiple Regulated Entities", "multi",
     ["multiple", "all", "all regulated entities", "regulated entities", "general", "uncategorized",
      "uncategorised", "cross cutting"],
     [r"regulated entities"]),
]

CATEGORY_IDS = [c[0] for c in CATEGORIES]
LABELS = {c[0]: c[1] for c in CATEGORIES}
SLUGS = {c[0]: c[2] for c in CATEGORIES}
_ALIASES = {}
for cid, label, slug, aliases, _ in CATEGORIES:
    for a in [cid, label, slug, *aliases]:
        _ALIASES[re.sub(r"[^a-z0-9]+", " ", a.lower()).strip()] = cid
_TITLE_PATTERNS = [(cid, [re.compile(p, re.I) for p in pats]) for cid, _, _, _, pats in CATEGORIES]


def normalise_category(value: str | None) -> str | None:
    """Map any folder name / form value / legacy DB value to a canonical id,
    or None if it is not recognisable (callers must then reject or ask)."""
    if not value:
        return None
    key = re.sub(r"[^a-z0-9]+", " ", str(value).lower()).strip()
    if key in _ALIASES:
        return _ALIASES[key]
    for cid, pats in _TITLE_PATTERNS:
        if any(p.search(value) for p in pats):
            return cid
    return None


def category_from_title(title: str) -> str | None:
    """'Reserve Bank of India (Small Finance Banks – Licensing) Guidelines'
    -> small_finance_banks. Looks at the entity named before the dash inside
    the title's parentheses first (the drafting convention of the 2025
    Directions), then anywhere in the title."""
    if not title:
        return None
    m = re.search(r"\(([^()]*?(?:\([^()]*\))?[^()]*?)\s*[-–—:]\s*[^()]+\)", title)
    head = m.group(1) if m else ""
    for text in (head, title):
        if not text:
            continue
        for cid, pats in _TITLE_PATTERNS:
            if cid == "multiple":
                continue
            if any(p.search(text) for p in pats):
                return cid
    if re.search(r"regulated entities", title, re.I):
        return "multiple"
    return None


EXCLUSION = re.compile(r"\b(exclud\w*|other\s+than|except)\b", re.I)


def _excluded(before: str) -> bool:
    """Is a mention preceded by an open 'excluding / other than / except'
    phrase? A closing parenthesis after the keyword ends the phrase:
    '(excluding Payments Banks, ...) and all NBFCs' -> NBFCs are included."""
    hits = list(EXCLUSION.finditer(before))
    if not hits:
        return False
    tail = before[hits[-1].end():]
    if ")" in tail or "}" in tail:
        return False
    if re.search(r"\bincluding\b", tail, re.I):
        return False
    return len(tail) < 160


def categories_from_applicability(text: str) -> list[str]:
    """Categories named as covered in an applicability statement, skipping any
    named inside an 'excluding / other than / except ...' phrase:
    'Scheduled Commercial Banks {including Small Finance Banks (SFBs) and
    excluding Regional Rural Banks (RRBs)}' -> [commercial_banks,
    small_finance_banks]."""
    found = []
    if not text:
        return found
    for cid, pats in _TITLE_PATTERNS:
        if cid == "multiple":
            continue
        for p in pats:
            if any(not _excluded(text[max(0, m.start() - 200):m.start()]) for m in p.finditer(text)):
                if cid not in found:
                    found.append(cid)
                break
    return found


# ---------------------------------------------------------------------------
# Topics (subject areas). A document's topic string is taken from its title
# ("(Commercial Banks – Credit Risk Management)" -> "Credit Risk Management")
# and mapped to one or more families. Families are what the Topics page
# groups by; new uploads are placed automatically, and a title that matches
# no family still shows up under its own topic string ("Other").
# ---------------------------------------------------------------------------
TOPIC_FAMILIES = [
    ("kyc_aml", "KYC & Anti-Money Laundering",
     r"know your customer|\bkyc\b|money laundering|\bpmla\b|\bcft\b|beneficial owner"),
    ("capital_adequacy", "Capital Adequacy & Capital Raising",
     r"capital adequacy|capital requirement|basel|leverage ratio|resource raising|capital instruments|prudential norms on capital"),
    ("asset_quality", "Asset Classification & Provisioning",
     r"income recognition|asset classification|provisioning|non-?performing"),
    ("credit_risk", "Credit Facilities & Credit Risk",
     r"credit facilities|credit risk|concentration risk|large exposure|exposure norms|lending to related|interest rates? on advances|wilful defaulter|credit information reporting"),
    ("stressed_assets", "Stressed Assets, Resolution & Securitisation",
     r"stressed assets|resolution|securiti[sz]ation|transfer and distribution of credit risk|sale of loan|restructur|asset reconstruction"),
    ("liquidity_alm", "Liquidity, ALM & Reserve Requirements",
     r"liquidity|asset liability|\balm\b|cash reserve ratio|statutory liquidity|\bcrr\b|\bslr\b"),
    ("investments", "Investments & Market Operations",
     r"investment portfolio|classification, valuation|operation of investment|primary dealers?|government securities|relief/savings bonds|savings bonds|market risk|derivative"),
    ("governance", "Governance, Ownership & Management",
     r"governance|board|directors?|remuneration|acquisition (and holding )?of shar|voting rights|shareholding|fit and proper|holding company"),
    ("licensing", "Licensing, Authorisation & Structure",
     r"licens|registration|authoris|branch|amalgamation|wholly owned subsidiar|setting up|scheduling|regulatory classification|undertaking of financial services|exemptions"),
    ("customer_protection", "Customer Service & Grievance Redressal",
     r"ombudsman|grievance|responsible business conduct|customer service|fair practice|customer protection|complaint"),
    ("deposits", "Deposits & Interest Rates",
     r"deposits?|interest rates? on deposits"),
    ("cards_payments", "Cards, Payments & Digital Banking",
     r"credit cards?|debit cards?|payment|prepaid|digital banking|account aggregator|peer to peer"),
    ("outsourcing_it", "IT, Cyber & Outsourcing",
     r"outsourcing|information technology|\bit framework\b|cyber"),
    ("fraud_risk", "Fraud & Operational Risk",
     r"fraud|operational risk"),
    ("reporting", "Financial Statements, Reporting & Audit",
     r"financial statements|disclosures?|returns?|reporting|auditor|audit"),
    ("dividends", "Dividends & Profit Distribution",
     r"dividend|profit remittance"),
    ("priority_sector", "Priority Sector & Financial Inclusion",
     r"priority sector|msme|micro, small|agricultur|natural calamit|relief measures|financial inclusion|microfinance"),
    ("climate", "Climate & Sustainable Finance",
     r"climate|sustainab|green"),
    ("entity_frameworks", "Entity-specific Regulatory Frameworks",
     r"^(housing finance|core investment|mortgage guarantee|credit information|asset reconstruction|non-operative financial holding)\s+compan|^standalone primary dealers|^operational guidelines for primary dealers"),
    ("miscellaneous", "Miscellaneous & Forthcoming Instructions",
     r"miscellaneous|forthcoming instructions"),
]
_FAMILY_RE = [(fid, label, re.compile(p, re.I)) for fid, label, p in TOPIC_FAMILIES]
FAMILY_LABELS = {fid: label for fid, label, _ in TOPIC_FAMILIES}
FAMILY_LABELS["other"] = "Other Topics"


SEP = r"(?:\s*[–—]\s*|\s+-\s*|-\s+|:\s+)"      # a hyphen only counts with a space next to it ("Non-Banking" is one word)


def _split_parenthetical(title: str):
    """'Reserve Bank of India (Commercial Banks – Credit Risk Management)
    Directions' -> ('Commercial Banks', 'Credit Risk Management')."""
    m = re.search(r"Reserve Bank of India\s*[\[(](.+?)[\])]\s*(?:Directions?|Guidelines|Master|$)", title, re.I) \
        or re.search(r"[\[(]((?:[^()\[\]]|\([^()]*\))+)[\])]\s*(?:Directions?|Guidelines)", title, re.I)
    if not m:
        return None, None
    inner = m.group(1).strip()
    if inner.lower() == "reserve bank":          # "... Returns (Reserve Bank) Directions, 2016"
        return None, None
    parts = re.split(SEP, inner, maxsplit=1)
    if len(parts) == 2 and category_from_title(parts[0]) and category_from_title(parts[0]) != "multiple":
        return parts[0].strip(), parts[1].strip()
    return None, inner


def topic_from_title(title: str) -> str:
    """The subject of a document, as written in its title."""
    t = re.sub(r"\s+", " ", title or "").strip()
    _, topic = _split_parenthetical(t)
    if not topic:
        topic = re.sub(r"^\s*Master\s+Directions?\s*(on\b|[-–—:])?\s*", "", t, flags=re.I)
        topic = re.sub(r"\((Reserve Bank)\)", "", topic)
        for cid, pats in _TITLE_PATTERNS:          # "Non-Banking Financial Company Returns" -> "Returns"
            for p in pats:
                stripped = p.sub("", topic).strip(" -–—:,")
                if stripped and stripped != topic.strip() and cid != "multiple" and len(stripped) > 3:
                    topic = stripped
                    break
    topic = re.sub(r"\s*\((?:including|excluding)[^)]*\)", "", topic, flags=re.I)
    topic = re.sub(r"\s*\(\s*[A-Z]{2,6}s?\s*\)", "", topic)
    topic = re.sub(r"\s+(in|for|of|to)\s*$", "", re.sub(r"\s{2,}", " ", topic).strip())
    topic = re.sub(r"\b(Directions?|Guidelines),?\s*\d{4}.*$", "", topic, flags=re.I)
    topic = re.sub(r"\s*[-–—]\s*(SCBs|RRBs|UCBs)\s*$", "", topic)
    topic = re.sub(r"^(for|on|in)\s+(the\s+)?", "", topic.strip(" -–—:,."), flags=re.I)
    return topic.strip(" -–—:,.") or t


def topic_families(title: str, topic: str | None = None) -> list[str]:
    topic = topic or topic_from_title(title)
    fams = [fid for fid, _, rx in _FAMILY_RE if rx.search(topic)]
    if not fams:
        fams = [fid for fid, _, rx in _FAMILY_RE if rx.search(title or "")]
    return fams or ["other"]


if __name__ == "__main__":
    import sys
    for arg in sys.argv[1:]:
        print(arg, "->", normalise_category(arg), category_from_title(arg), topic_from_title(arg), topic_families(arg))
