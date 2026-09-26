"""
The full flow, run for real: bank submission -> quantitative check against
rule_atoms -> qualitative check against the vector DB -> unified report.
"""
import os
import json
from bank_submission_demo import BANK_PROFILE, SUBMITTED_QUANTITATIVE_DATA, SUBMITTED_POLICY_TEXT
from compliance_checker import (check_quantitative_compliance, check_qualitative_compliance,
                                  generate_compliance_report)

BASE = os.path.dirname(__file__)
DATA_DIR = os.path.abspath(os.path.join(BASE, "..", "data"))
DB = os.path.join(DATA_DIR, "urcc_ef.db")
VDB = os.path.join(DATA_DIR, "urcc_ef_vectors.db")
MODEL = os.path.join(DATA_DIR, "vector_model.pkl")

print(f"=== Compliance check: {BANK_PROFILE['bank_name']} ({BANK_PROFILE['institution_category']}) ===\n")

print("--- Subsystem 1: Deterministic quantitative check ---")
quant_results = check_quantitative_compliance(
    DB, BANK_PROFILE["institution_category"], SUBMITTED_QUANTITATIVE_DATA)
for r in quant_results:
    print(f"[{r.status:12s}] rule {r.rule_id}: {r.operator} {r.threshold_value}{r.threshold_unit}  "
          f"reported={r.reported_value}  ({r.rbi_ref} p.{r.page_number})")
    print(f"             \"{r.clause_text[:110]}\"")

print(f"\n--- Subsystem 2: Qualitative check via vector-DB evidence retrieval (sample of 40 clauses) ---")
qual_results = check_qualitative_compliance(
    DB, VDB, MODEL, BANK_PROFILE["institution_category"], SUBMITTED_POLICY_TEXT,
    similarity_threshold=0.35, sample_limit=40)

shown = [r for r in qual_results if r.status != "LIKELY_GAP"] or qual_results[:3]
for r in shown[:5]:
    print(f"\n[{r.status}] {r.rbi_ref} p.{r.page_number}  (similarity={r.similarity_score})")
    print(f"  requirement: \"{r.clause_text[:110]}\"")
    if r.best_evidence_text:
        print(f"  best evidence: \"{r.best_evidence_text[:110]}\"")

print(f"\n(One real LLM prompt that would be sent for a NEEDS_LLM_REVIEW case:)")
review_cases = [r for r in qual_results if r.status == "NEEDS_LLM_REVIEW"]
if review_cases:
    print(review_cases[0].llm_prompt_used)

print("\n\n=== Confluence Merge: unified report ===")
report = generate_compliance_report(BANK_PROFILE, quant_results, qual_results)
print(json.dumps(report, indent=2))
