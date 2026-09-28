#!/usr/bin/env bash
# Downloads the ORIGINAL published documents behind the extracts in public/
# (and a few more), into sample-data/originals/. Run it on your own machine:
#
#   bash sample-data/fetch_originals.sh
#
# Then upload any of them in the app (Compliance Checker → Auto Check) or run
#   curl -F file=@sample-data/originals/<file>.pdf http://localhost:4002/api/disclosures/analyze
#
# Bank websites change their links often; if a download fails, search the
# bank's "Investor Relations" / "Regulatory Disclosures" page for the same
# document name. Some sites refuse requests without a browser user agent,
# hence the -A below.
set -u
cd "$(dirname "$0")"
mkdir -p originals
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

fetch() {
  local name="$1" url="$2"
  if [ -s "originals/$name" ]; then echo "have  $name"; return; fi
  if curl -fsSL -A "$UA" --retry 2 -o "originals/$name" "$url"; then
    echo "got   $name"
  else
    echo "FAIL  $name  <- $url"
    rm -f "originals/$name"
  fi
}

# Commercial banks - Basel III Pillar 3 disclosures (quarterly, KM1 key metrics)
fetch idfc-first-pillar3-2025-06-30.pdf "https://www.idfcfirst.bank.in/content/dam/idfcfirstbank/pdf/regulatory-disclosures/Basel-Pillar-3-Disclosures-as-on-June-30-2025.pdf"
fetch idfc-first-lcr-2025-06-30.pdf     "https://www.idfcfirst.bank.in/content/dam/idfcfirstbank/pdf/regulatory-disclosures/Disclosure-on-Liquidity-Coverage-Ratio-as-at-June-2025.pdf"
fetch hdfc-bank-pillar3-2026-06-30.pdf  "https://www.hdfc.bank.in/content/dam/hdfcbankpws/in/en/pdf/about-us/regulatory-disclosures/2026/basel-III-pillar-3-disclosures-as-at-june-30-2026.pdf"
fetch federal-bank-pillar3-2025-09-30.pdf "https://www.federal.bank.in/documents/10180/1124358025/BASEL+III-+Disclosure-Sep'25+(1).pdf/d31eaeeb-1e45-c3ba-a421-3c7926267bd4?t=1761554976945"
fetch federal-bank-lcr-nsfr-2025-06-30.pdf "https://www.federal.bank.in/documents/10180/1124358025/LCR_NSFR_Disclosure_June+2025.pdf/b1b42131-61eb-1b6c-3936-cdb5435c4795?t=1754134620048"
fetch citibank-india-pillar3-2025-06.pdf "https://citigroup.com/rcs/citigpa/storage/public/India/basel/basel-disclosures-jun-2025.pdf"

# Commercial banks - results / presentations
fetch federal-bank-q2fy26-presentation.pdf "https://www.federal.bank.in/documents/10180/1131213536/Q2FY26+Quarterly+Presentation.pdf/83d92b57-ebd4-4c80-12df-7d22f384cabe?t=1760780308714"
fetch sbi-q1fy26-analyst-presentation.pdf  "https://sbi.bank.in/documents/17836/53469043/SBI+Analyst+Presentation+Q1FY26.pdf/c6e887f7-3ad0-71bb-ff0d-01d5b5a538d1"

# Small finance banks
fetch equitas-sfb-pillar3-2025-03-31.pdf  "https://ir.equitas.bank.in/wp-content/uploads/2025/04/Pillar-III-Disclosure-Q4FY25.pdf"
fetch ujjivan-sfb-pillar3-2025-09-30.pdf  "https://www.ujjivansfb.bank.in/sites/default/files/2025-11/Pillar-III-disclosures-as-at-September-30-2025-Final.pdf"
fetch utkarsh-sfb-pillar3-2025-09-30.pdf  "https://www.utkarsh.bank.in/uploads/pdf/our-policy/template_ten/Basel_III%E2%80%93Pillar_3_Disclosures_as_on_September_30_2025.pdf"
fetch jana-sfb-pillar3-2025-03-31.pdf     "https://www.jana.bank.in/images/Notice/pillar-3-disclosure-31-march-2025.pdf"

# Urban co-operative bank - annual report (large file)
fetch saraswat-annual-report-2024-25.pdf  "https://www.saraswat.bank.in/Assets/Annual%20Report%20-%202024-25_15072025_0537.pdf"

# All-India financial institution (category all_india_financial_institutions)
fetch nhb-pillar3-2025-06-30.pdf "https://www.nhb.org.in/wp-content/uploads/2025/09/BASEL-III-Pillar-III-Disclosures-QE-30_06_2025-FINAL-ENG-1.pdf"

echo "done - files are in $(pwd)/originals"
