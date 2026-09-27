#!/bin/bash
# End-to-end demo against a running backend (npm start in another shell):
# registers a fictional Regional Rural Bank, submits figures for three REAL
# rules extracted from the RRB directions, adds two evidence texts, then runs
# the fixed pipeline, the adaptive router and their comparison.
#
# Rule ids are looked up by the rule's text (they change when the corpus is
# rebuilt), so this script keeps working after `npm run build:corpus`.
#
# Usage: bash scripts/demo/seed_and_test.sh [BASE_URL]
set -euo pipefail
BASE_URL="${1:-http://localhost:4002}"
BANK_ID="RRB-DEMO-001"
PERIOD="Q2-FY2026-27"
QUAL_SAMPLE_LIMIT="${QUAL_SAMPLE_LIMIT:-5}"

echo "=== 1. Register bank ==="
curl -sS -X POST "$BASE_URL/api/banks" -H "Content-Type: application/json" -d "{
  \"bank_id\": \"$BANK_ID\",
  \"bank_name\": \"Demo Grameen Bank (fictional)\",
  \"institution_category\": \"regional_rural_banks\"
}"
echo -e "\n"

echo "=== 2. Applicable requirement rules for this bank (what the form renders) ==="
RULES_JSON=$(curl -sS "$BASE_URL/api/banks/$BANK_ID/applicable-rules?period_label=$PERIOD")
echo "$RULES_JSON" | python3 -c "import json,sys; r=json.load(sys.stdin); print(len(r), 'requirement rules apply; first 5:'); [print(' ', x['rule_id'], x['operator'], x['threshold_value'], x['threshold_unit'], '-', (x['variable_text'] or '')[:70]) for x in r[:5]]"

# Pick three real rules by their text:
#   HTM investments <= 25% of total investments      -> report 27.3  (expected BREACH)
#   single-broker transactions <= 5%                 -> report 3.2   (expected PASS)
#   daily CRR >= 90% of required CRR                 -> report 91.0  (expected PASS)
SUBMISSIONS=$(echo "$RULES_JSON" | python3 -c "
import json, re, sys
rules = json.load(sys.stdin)
def find(pattern):
    for r in rules:
        if re.search(pattern, (r.get('sentence') or r.get('clause_text') or ''), re.I):
            return r['rule_id']
    raise SystemExit(f'rule not found: {pattern}')
subs = [
    (find(r'Investments under HTM category shall not exceed 25 per cent'), 27.3),
    (find(r'individual broker.{0,40}5 per cent'), 3.2),
    (find(r'minimum CRR of not less than 90 per ?cent'), 91.0),
]
print(json.dumps([{'rule_id': rid, 'reported_value': v, 'period_label': '$PERIOD', 'source_note': 'treasury MIS export'} for rid, v in subs]))
")
echo -e "\n=== 3. Submit quantitative data ==="
curl -sS -X POST "$BASE_URL/api/banks/$BANK_ID/quant-submissions" -H "Content-Type: application/json" -d "$SUBMISSIONS" | python3 -m json.tool
echo -e "\n"

echo "=== 4. Submit qualitative evidence ==="
curl -sS -X POST "$BASE_URL/api/banks/$BANK_ID/qual-evidence" -H "Content-Type: application/json" -d '[
  {"evidence_text": "Minutes of the Board meeting, September 2026: The Board reviewed and approved the investment policy for the year, including limits on HTM holdings and broker-wise transaction limits, and directed the treasury desk to strengthen counterparty due diligence.", "source_type": "board_minutes"},
  {"evidence_text": "Risk Management Committee note, August 2026: The Committee reviewed the KYC policy, confirmed periodic updation of customer records on a risk basis, and agreed to formalise a monitoring dashboard for investment exposures by year end.", "source_type": "board_minutes"}
]' | python3 -m json.tool
echo -e "\n"

echo "=== 5. FIXED-HYBRID compliance check (baseline) ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/run" -H "Content-Type: application/json" \
  -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d['report']['summary'], indent=2)); [print('BREACH:', b['rule'], 'reported', b['reported'], '|', b['rbi_ref'], 'p', b['page']) for b in d['report']['breaches']]"
echo -e "\n"

echo "=== 6. ADAPTIVE ROUTER compliance check ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/run-routed" -H "Content-Type: application/json" \
  -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('route distribution:', d['route_distribution'])"
echo -e "\n"

echo "=== 7. Side-by-side comparison (fixed-hybrid vs adaptive router) ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/compare" -H "Content-Type: application/json" \
  -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('agreement rate:', d['agreement_rate'], 'over', len(d['comparison']), 'clauses')"
