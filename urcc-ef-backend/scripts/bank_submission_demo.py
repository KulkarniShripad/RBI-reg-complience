"""
A synthetic bank's submitted compliance package - standing in for what a
real bank would submit via CIMS. This is what's genuinely not obtainable in
this environment (no real CIMS access), so it's built by hand, but the
RULES being checked against are 100% real, pulled straight out of
urcc_ef.db from documents you actually uploaded.

In production this dict would instead be populated by the "bridge table"
discussed earlier - mapping each rule_atom.variable_name to the actual
XBRL/CIMS return field that reports it. That mapping problem is still
unsolved here (see compliance_checker.py docstring) - this file skips
straight to "suppose we already know which reported number answers which
rule", which is the honest scope of what's demonstrable without real bank
data access.
"""

BANK_PROFILE = {
    "bank_id": "RRB-DEMO-001",
    "bank_name": "Uttar Pradesh Grameen Bank (fictional demo entity)",
    "institution_category": "Regional_Rural_Bank",
}

# {rule_id: reported_value} - rule_ids below are real rows in rule_atoms,
# pulled from RBI/DOR/2025-26/260 (RRB Investment Portfolio Directions) and
# RBI/DOR/2025-26/250 (CRR Directions), both in your uploaded corpus.
SUBMITTED_QUANTITATIVE_DATA = {
    273: 27.3,   # HTM investments: rule caps at <=25% of total investments -> BANK BREACHES THIS
    279: 3.2,    # single-broker transaction concentration: rule caps at <=5% -> bank passes
    284: 91.0,   # CRR maintenance: rule requires >=90% of required CRR -> bank passes
}

# Synthetic board-minutes / policy text excerpts, standing in for the
# unstructured documents Subsystem 2 would ingest. Deliberately mixed:
# one topic is well-covered, one is only partially covered, to make the
# qualitative-check demo show a non-trivial result rather than a trivial
# pass-everything case.
SUBMITTED_POLICY_TEXT = [
    "Minutes of the Risk Management Committee, Q2 2026: The Committee reviewed "
    "the bank's early warning indicators for liquidity stress, including high "
    "frequency market data on deposit withdrawal patterns and interbank funding "
    "spreads. The Committee noted no material stress signals for the quarter "
    "and directed the treasury desk to continue daily monitoring.",

    "Minutes of the Board meeting, March 2026: The Board was briefed on the "
    "status of the cyber crisis management plan. Implementation is ongoing; "
    "a full tabletop exercise has not yet been scheduled for this financial year.",

    "Internal Audit Note, Feb 2026: KYC periodic updation for high-risk customers "
    "was reviewed for a sample of 40 accounts. Documentation was found complete "
    "for 38 of 40 accounts; two accounts flagged for follow-up.",
]
