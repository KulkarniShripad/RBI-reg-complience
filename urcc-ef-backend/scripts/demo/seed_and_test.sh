#!/bin/bash
# Loads scripts/demo/sample_bank_data.json into a running backend, then runs
# all three compliance check flavors so you can see the fixed-hybrid
# baseline, the adaptive router, and their side-by-side comparison in one
# pass. Requires the server already running (npm start, in another shell).
#
# Usage: bash scripts/demo/seed_and_test.sh [BASE_URL]
set -e
BASE_URL="${1:-http://localhost:4000}"
BANK_ID="RRB-DEMO-001"
PERIOD="Q2-FY2026-27"
QUAL_SAMPLE_LIMIT="${QUAL_SAMPLE_LIMIT:-3}"

echo "=== 1. Register bank ==="
curl -s -X POST "$BASE_URL/api/banks" -H "Content-Type: application/json" -d "{
  \"bank_id\": \"$BANK_ID\",
  \"bank_name\": \"Uttar Pradesh Grameen Bank (fictional demo entity)\",
  \"institution_category\": \"Regional_Rural_Bank\"
}"
echo -e "\n"

echo "=== 2. Applicable rules for this bank (what a dashboard form would render) ==="
curl -s "$BASE_URL/api/banks/$BANK_ID/applicable-rules?period_label=$PERIOD" | python3 -m json.tool
echo -e "\n"

echo "=== 3. Submit quantitative data (bulk) ==="
curl -s -X POST "$BASE_URL/api/banks/$BANK_ID/quant-submissions" -H "Content-Type: application/json" -d "[
  {\"rule_id\": 273, \"reported_value\": 27.3, \"period_label\": \"$PERIOD\", \"source_note\": \"treasury MIS export\"},
  {\"rule_id\": 279, \"reported_value\": 3.2,  \"period_label\": \"$PERIOD\", \"source_note\": \"treasury MIS export\"},
  {\"rule_id\": 284, \"reported_value\": 91.0, \"period_label\": \"$PERIOD\", \"source_note\": \"treasury MIS export\"}
]" | python3 -m json.tool
echo -e "\n"

echo "=== 4. Submit qualitative evidence ==="
curl -s -X POST "$BASE_URL/api/banks/$BANK_ID/qual-evidence" -H "Content-Type: application/json" -d '[
  {"evidence_text": "Minutes of the Board meeting, September 2026: The Board reviewed the investment policy for the year and directed the treasury desk to strengthen counterparty due diligence procedures ahead of the next investment cycle.", "source_type": "board_minutes"},
  {"evidence_text": "Risk Management Committee note, August 2026: The Committee discussed the current risk culture framework and agreed to formalise a monitoring dashboard for investment-related exposures by year end.", "source_type": "board_minutes"}
]' | python3 -m json.tool
echo -e "\n"

echo "=== 5. FIXED-HYBRID compliance check (baseline) ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/run" -H "Content-Type: application/json" -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" | python3 -m json.tool
echo -e "\n"

echo "=== 6. ADAPTIVE ROUTER compliance check ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/run-routed" -H "Content-Type: application/json" -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" | python3 -m json.tool
echo -e "\n"

echo "=== 7. Side-by-side comparison (fixed-hybrid vs adaptive router) ==="
curl -sS -X POST "$BASE_URL/api/compliance/$BANK_ID/compare" -H "Content-Type: application/json" -d "{\"period_label\": \"$PERIOD\", \"qual_sample_limit\": $QUAL_SAMPLE_LIMIT}" | python3 -m json.tool
