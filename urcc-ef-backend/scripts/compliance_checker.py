"""
This is the part of the system that was never actually built until now -
everything before this file only built the regulation side (PDF -> clause
DB + vector DB). This is where a bank's submitted data actually gets
checked against it.

THE MAPPING PROBLEM, STATED HONESTLY: for a quantitative check to run at
all, something has to know that "rule_id 273" corresponds to "the bank's
reported HTM-category investment percentage for this quarter." That
mapping - between an extracted rule_atom and the specific field in a real
CIMS/XBRL return that reports its variable - is NOT solved by this code.
It's a data-engineering problem that needs either RBI-side deployment with
real CIMS field codes, or a human compliance officer doing the mapping
once per rule. This file assumes that mapping already exists (see
bank_submission_demo.py, which hand-maps 3 real rule_ids to sample
values) and implements everything downstream of it: applicability
filtering, evaluation, evidence retrieval, and report generation.
"""
import sqlite3
import numpy as np
import pickle
import os
from dataclasses import dataclass, field


@dataclass
class QuantResult:
    rule_id: int
    clause_uri: str
    operator: str
    threshold_value: float
    threshold_unit: str
    variable_text: str
    reported_value: float | None
    status: str                 # 'PASS' | 'BREACH' | 'NOT_REPORTED'
    clause_text: str
    page_number: int
    rbi_ref: str


@dataclass
class QualResult:
    clause_uri: str
    clause_text: str
    page_number: int
    rbi_ref: str
    best_evidence_text: str | None
    similarity_score: float
    status: str                 # 'LIKELY_COVERED' | 'LIKELY_GAP' | 'NEEDS_LLM_REVIEW'
    llm_prompt_used: str        # the exact prompt a real LLM call would receive


OPERATORS = {
    "<=": lambda v, t: v <= t,
    ">=": lambda v, t: v >= t,
    "within_days": lambda v, t: v <= t,   # "reported turnaround" must be within the cap
}


# ---------------------------------------------------------------------------
# Subsystem 1: deterministic quantitative check
# ---------------------------------------------------------------------------

def check_quantitative_compliance(db_path: str, institution_category: str,
                                   submitted_data: dict[int, float]) -> list[QuantResult]:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT ra.rule_id, ra.clause_uri, ra.operator, ra.threshold_value, ra.threshold_unit,
               ra.variable_text, cr.clause_text, cr.page_number, d.rbi_ref
        FROM rule_atoms ra
        JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri
        JOIN documents d ON cr.doc_id = d.doc_id
        WHERE d.institution_category = ?
    """, (institution_category,)).fetchall()
    conn.close()

    results = []
    for r in rows:
        reported = submitted_data.get(r["rule_id"])
        if reported is None:
            status = "NOT_REPORTED"
        else:
            evaluator = OPERATORS.get(r["operator"])
            status = "PASS" if evaluator and evaluator(reported, r["threshold_value"]) else "BREACH"
        results.append(QuantResult(
            rule_id=r["rule_id"], clause_uri=r["clause_uri"], operator=r["operator"],
            threshold_value=r["threshold_value"], threshold_unit=r["threshold_unit"],
            variable_text=r["variable_text"], reported_value=reported, status=status,
            clause_text=r["clause_text"], page_number=r["page_number"], rbi_ref=r["rbi_ref"],
        ))
    return results


# ---------------------------------------------------------------------------
# Subsystem 2: qualitative check via real vector-DB evidence retrieval,
# with an honestly-stubbed LLM judgment step (see prompt below).
# ---------------------------------------------------------------------------

LLM_JUDGMENT_PROMPT_TEMPLATE = """You are auditing a bank's internal governance documentation against a specific RBI regulatory requirement.

REGULATORY REQUIREMENT (from {rbi_ref}, page {page}):
"{clause_text}"

BANK'S SUBMITTED EVIDENCE (retrieved as the closest semantic match):
"{evidence_text}"

Does the submitted evidence demonstrate that the bank has actually complied with this
specific requirement? Respond in strict JSON:
{{
  "coverage": "full" | "partial" | "none",
  "justification": "<one sentence, grounded only in the evidence text above>",
  "confidence": "high" | "low"
}}
Do not use any knowledge beyond the two texts above. If the evidence does not clearly
address the requirement, say so - do not infer compliance from an unrelated but
plausible-sounding excerpt."""


def _load_vector_model(model_path: str):
    with open(model_path, "rb") as f:
        return pickle.load(f)


def _embed(texts: list[str], model: dict) -> np.ndarray:
    tfidf = model["vectorizer"].transform(texts)
    dense = model["svd"].transform(tfidf)
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1
    return (dense / norms).astype(np.float32)


def check_qualitative_compliance(relational_db_path: str, vector_db_path: str, model_path: str,
                                  institution_category: str, policy_texts: list[str],
                                  similarity_threshold: float = 0.35,
                                  sample_limit: int = 40) -> list[QualResult]:
    """
    For each qualitative regulatory clause applicable to this institution
    category, find the bank's submitted policy excerpt that's the closest
    semantic match (real vector search against urcc_ef_vectors.db), then
    show - but do not fabricate the output of - the LLM judgment call that
    would make the actual compliance determination. Without a reachable
    LLM in this sandbox, the status is set by a similarity threshold as an
    honest PLACEHOLDER, clearly distinguished from a real judgment.

    sample_limit caps how many regulatory clauses get checked, since a
    single institution category can have several thousand qualitative
    clauses - a real deployment would run this over the full set (or a
    risk-prioritized subset), not just the first N.
    """
    conn = sqlite3.connect(relational_db_path)
    conn.row_factory = sqlite3.Row
    clauses = conn.execute("""
        SELECT cr.clause_uri, cr.clause_text, cr.page_number, d.rbi_ref
        FROM clause_registry cr
        JOIN documents d ON cr.doc_id = d.doc_id
        WHERE d.institution_category = ? AND cr.clause_type = 'qualitative'
        LIMIT ?
    """, (institution_category, sample_limit)).fetchall()
    conn.close()

    model = _load_vector_model(model_path)
    policy_vecs = _embed(policy_texts, model)
    clause_vecs = _embed([c["clause_text"] for c in clauses], model)

    # cosine similarity matrix (vectors already L2-normalized -> dot product)
    sims = clause_vecs @ policy_vecs.T  # shape: (n_clauses, n_policy_texts)

    results = []
    for i, c in enumerate(clauses):
        best_j = int(np.argmax(sims[i]))
        best_score = float(sims[i][best_j])
        best_evidence = policy_texts[best_j] if best_score >= similarity_threshold else None

        prompt = LLM_JUDGMENT_PROMPT_TEMPLATE.format(
            rbi_ref=c["rbi_ref"], page=c["page_number"], clause_text=c["clause_text"],
            evidence_text=best_evidence or "(no evidence above similarity threshold)"
        )

        if best_evidence is None:
            status = "LIKELY_GAP"
        else:
            # PLACEHOLDER ONLY - a real deployment sends `prompt` to an LLM
            # and uses its structured "coverage" field here instead.
            status = "NEEDS_LLM_REVIEW"

        results.append(QualResult(
            clause_uri=c["clause_uri"], clause_text=c["clause_text"],
            page_number=c["page_number"], rbi_ref=c["rbi_ref"],
            best_evidence_text=best_evidence, similarity_score=round(best_score, 4),
            status=status, llm_prompt_used=prompt,
        ))
    return results


# ---------------------------------------------------------------------------
# Confluence merge: unify both subsystems' output into one report
# ---------------------------------------------------------------------------

def generate_compliance_report(bank_profile: dict, quant_results: list[QuantResult],
                                 qual_results: list[QualResult]) -> dict:
    breaches = [r for r in quant_results if r.status == "BREACH"]
    not_reported = [r for r in quant_results if r.status == "NOT_REPORTED"]
    passes = [r for r in quant_results if r.status == "PASS"]
    gaps = [r for r in qual_results if r.status == "LIKELY_GAP"]
    needs_review = [r for r in qual_results if r.status == "NEEDS_LLM_REVIEW"]

    return {
        "bank": bank_profile,
        "summary": {
            "quantitative_checked": len(quant_results),
            "quantitative_pass": len(passes),
            "quantitative_breach": len(breaches),
            "quantitative_not_reported": len(not_reported),
            "qualitative_checked": len(qual_results),
            "qualitative_likely_gap": len(gaps),
            "qualitative_needs_llm_review": len(needs_review),
        },
        "breaches": [
            {"clause_uri": r.clause_uri, "rbi_ref": r.rbi_ref, "page": r.page_number,
             "rule": f"{r.operator} {r.threshold_value}{r.threshold_unit}",
             "reported": r.reported_value, "clause_text": r.clause_text}
            for r in breaches
        ],
        "qualitative_gaps": [
            {"clause_uri": r.clause_uri, "rbi_ref": r.rbi_ref, "page": r.page_number,
             "clause_text": r.clause_text}
            for r in gaps
        ],
    }
