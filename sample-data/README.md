# Test data for the automatic compliance check

These documents are inputs for **Compliance Check** in the dashboard: upload any of them.

| Folder | What it is |
|---|---|
| `public/` | **Real figures published by Indian banks**, with the source URL printed on each document and listed in `manifest.json`. They are re-typeset as short PDF extracts because the original files could not be downloaded into the repository. |
| `test-cases/` | **Fictional banks** ("Example … Bank"). They were built to test the checker: breaches, buffer shortfalls, missing disclosures, a UCB whose tier comes from its deposits, and the Excel / CSV / JSON input formats. |
| `manifest.json` | For every file: the bank, category, period, source URL and the **expected results**, checked by `npm run eval:disclosures`. |
| `generate_samples.py` | Rebuilds `public/`, `test-cases/` and the manifest (`python3 generate_samples.py`). |
| `fetch_originals.sh` | Downloads the **original** bank PDFs behind the extracts, plus several more, into `originals/`. Run it on your own machine. |

## The samples

| File | Bank (category) | Document | What the check should show |
|---|---|---|---|
| `public/idfc-first-bank-pillar3-jun-2025.pdf` | IDFC FIRST Bank (commercial) | Pillar 3, 30 Jun 2025 | CRAR 15.88%, CET1 13.34%, LCR 118%: all pass. Tier 1, leverage and NSFR are "not in document". |
| `public/federal-bank-results-q2-fy26.pdf` | Federal Bank (commercial) | Q2 FY26 results | CRAR 16.54%, Tier 1 14.15%, LCR ~121%: pass. GNPA 1.83%, NNPA 0.48%, PCR 73% are read. |
| `public/sbi-results-q1-fy26.pdf` | State Bank of India (commercial, **D-SIB**) | Q1 FY26 results | CRAR 14.63% passes. Recognised as a D-SIB, so the 4% leverage rule is selected instead of 3.5%. |
| `public/equitas-sfb-pillar3-mar-2025.pdf` | Equitas SFB (small finance bank) | Pillar III, 31 Mar 2025 | CRAR 20.60% vs 15%, Tier 1 17.84% vs 7.5%, average LCR 156.52% vs 100%: all pass. |
| `public/ujjivan-sfb-highlights-sep-2025.pdf` | Ujjivan SFB (small finance bank) | 30 Sep 2025 | CRAR 21.4%, Tier 1 19.9%: pass. Deposits ₹39,211 crore are read. |
| `public/saraswat-cooperative-bank-annual-report-2024-25.pdf` | Saraswat Co-op Bank (urban co-operative) | Annual report 2024-25 (key figures) | CRAR 17.43% is above both the 9% and 12% UCB minimums. Net worth is not in the extract. Most Notes-to-Accounts items are "likely missing" because this is only an extract. |
| `test-cases/example-sfb-pillar3-sep-2025.pdf` | fictional SFB | Pillar 3 KM1, 3 quarters | **Breaches**: CRAR 14.20 < 15, leverage 4.20 < 4.5, LCR 96.4 < 100. The current-quarter column is used. The "15%" in the text is not taken as the bank's figure. |
| `test-cases/example-commercial-bank-annual-report-2025-26.pdf` | fictional commercial bank | Annual report with governance narrative and Notes to Accounts | CRAR 10.80 and CET1 7.60 are **buffer shortfalls** (above the minimum, below minimum + 2.5% CCB). PSL 38.2% is a **target shortfall** (< 40%). Seven required disclosures are missing. KYC, outsourcing, audit committee and Internal Ombudsman passages are matched to RBI obligations. |
| `test-cases/example-ucb-figures-mar-2026.xlsx` | fictional UCB | Excel sheet of figures | Deposits ₹850 crore make it **Tier 2**, so CRAR must be ≥ 12%: 11.2% is a **breach**. Net worth ₹4.1 crore is under ₹5 crore but on the glide path (pass with conditions). |
| `test-cases/example-payments-bank-figures-sep-2025.csv` | fictional payments bank | CSV of figures | Leverage 2.6 < 3%: **breach**. Capital ratios pass. |
| `test-cases/example-rrb-figures-dec-2025.json` | fictional RRB | JSON of figures | CRAR 8.4 < 9 and Tier 1 6.9 < 7: **breaches**. |

Check them all at once:

```bash
cd urcc-ef-backend
npm run eval:disclosures            # deterministic, no LLM needed
npm run eval:disclosures -- --llm   # also uses Gemini where the code could not decide
```

## Input formats the system accepts

- **PDF** (text-based): annual reports, Basel III Pillar 3 disclosures, quarterly results, investor presentations, policies, board minutes. Scanned PDFs need OCR first, e.g. `ocrmypdf in.pdf out.pdf`.
- **Excel (.xlsx)**: any sheet where a row has a label and then a value, e.g. `CRAR (%) | 11.2`.
- **CSV / TSV**: `metric,value[,unit]` rows, or any label-value layout.
- **JSON**: `{"bank_name": "...", "institution_category": "...", "as_of_date": "YYYY-MM-DD", "metrics": {"crar": 15.2, "lcr": 110}}`. Any key or common label ("CRAR", "Tier 1 ratio", "Gross NPA %") works. This is the format a bank's reporting system or a CIMS / XBRL export script would send.
- **Text / HTML / Markdown**: press releases, web pages, pasted notes.

## Where to get more real data

| Source | What you get | Where |
|---|---|---|
| **Basel III Pillar 3 disclosures** (best source) | KM1 key metrics every quarter: CET1, Tier 1, total capital ratio, leverage ratio, LCR, NSFR, plus DF tables | Every bank's website → *Investor Relations* / *Regulatory Disclosures* / *Basel III Disclosures* |
| **LCR / NSFR disclosures** | Quarterly liquidity ratios | Same page, often a separate PDF |
| **Quarterly financial results** (SEBI Reg. 33) | "Analytical ratios": capital adequacy ratio, CET1, gross / net NPA %, return on assets | Bank website, or BSE (bseindia.com → company → Financial Results) / NSE |
| **Investor presentations** | CRAR, Tier 1, GNPA, NNPA, PCR, LCR, deposits | Bank website → Investor Relations |
| **Annual reports** | Notes to Accounts (all RBI-mandated disclosures), corporate governance, board committees, policies. This is what exercises the disclosure-completeness and qualitative checks. | Bank website; BSE / NSE annual-report filings |
| **Co-operative bank annual reports** | CRAR, NPAs, deposits (for the UCB tier), net worth | Bank websites (Saraswat, Cosmos, SVC, Abhyudaya, …) |
| **RBI publications** | Sector-wide ratios for realistic ranges (not one bank) | dbie.rbi.org.in, *Statistical Tables relating to Banks in India*, *Financial Stability Report* |

When you test with real originals, compare the "Figures read from the document" table in the report with the PDF page it cites. Every figure shows the page and the exact line it was read from.
