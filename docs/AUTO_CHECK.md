# Automatic compliance check from bank documents

**Dashboard → Auto Compliance Check** (`/dashboard/auto-check`), API `/api/disclosures`.

The manual Compliance Checker needs a person to type one number per rule. The automatic check starts from what a bank already produces: an annual report, a Basel III Pillar 3 disclosure, quarterly results, an investor presentation, or a spreadsheet / CSV / JSON of figures. It works out the rest itself.

```
 document ──► 1 read ──► 2 who / when ──► 3 figures ──► 4 which rules apply ──► 5 check ──► 6 report
   PDF, xlsx,   text +       bank, category,   CRAR, CET1, LCR,   rules of the bank's    arithmetic   HTML / JSON,
   csv, json,   table rows   period, D-SIB,    NPA, deposits…     category + profile,    only         saved in History
   txt, html                 UCB tier          with page + line   each tied to its para
```

The user sees the result of steps 2 and 3 before the check runs, and can correct any value. Every figure shows the page and line it was read from, and every result links to the paragraph of the Master Direction it comes from.

## 1. Reading the document

- PDFs are read by `scripts/extract_document.py` (PyMuPDF). Words on the same baseline are joined, and cells separated by a wide gap are joined with ` | `, so table rows stay rows: `5 | Common Equity Tier 1 ratio (%) | 13.34 | 13.12`.
- Excel: every sheet becomes a page and every row a line. CSV, JSON, text and HTML are read directly.
- A scanned PDF (no text layer) is refused with a message to run OCR first.

## 2. Who and when (`profileDetector.js`)

| Item | How it is found | LLM fallback |
|---|---|---|
| Bank name | The most frequent "… Bank [Limited]" in the document (RBI itself excluded; "Bank of Baroda", "State Bank of India" handled) | Yes, if none is found; the answer must appear on the first pages |
| Category | From the name: Small Finance Bank, Payments Bank, Co-operative / Sahakari, Gramin, Local Area Bank, NHB/NABARD/SIDBI/EXIM, otherwise commercial bank | Yes; the answer must be a known category id |
| Date → period | The most frequent "as on / as at / quarter ended / year ended <date>", preferring quarter ends and the first pages; "Annual Report 2024-25" → 31 March 2025. Converted to the RBI quarter (Apr–Jun = Q1). | Yes, only a date written in the text |
| Document type | Keyword scores: Pillar 3 / KM1 / DF tables, annual report / Notes to Accounts, financial results / Regulation 33, minutes, policy | – |
| D-SIB | SBI, HDFC Bank, ICICI Bank (RBI's D-SIB list). Selects the 4% leverage ratio instead of 3.5%. | – |
| UCB tier | From total deposits (Licensing Directions para 2: ≤ ₹100 cr Tier 1, ≤ ₹1,000 cr Tier 2, ≤ ₹10,000 cr Tier 3, above that Tier 4) | – |

If the bank isn't registered yet, it is registered automatically when the check runs, using the bank ID proposed on the review screen.

## 3. Figures (`metricCatalog.js`, `metricExtractor.js`)

The system recognises 16 figures:
- CRAR, CET1, Tier 1 and Tier 2 ratios
- leverage ratio, LCR, NSFR
- gross and net NPA %, PCR
- priority sector lending % of ANBC, return on assets
- deposits, advances, net worth, net profit

For each line and each label found in it, the first plausible number **after** the label is a candidate. In tables that is the current-period column. Candidates are scored:
- **More points:** a table row, a "%" sign, a key-metrics (KM1) page, standalone figures.
- **Fewer points:** a regulatory minimum nearby ("minimum CRAR of 9%"), consolidated figures, a number far from its label.

Amounts are converted to ₹ crore using the unit on the line or page (lakh, million, billion, thousand). In narrative text, "from 2.88% to 2.25%" gives 2.25. A low-confidence reading can never produce a breach on its own; it becomes *Needs review*.

**LLM fallback:** core figures that were not found are asked of the LLM, using the document lines that mention them. The answer is accepted only if the quoted line exists in the document and contains the number, so a made-up figure cannot enter the report.

## 4. Which rules apply (`regulatoryRules.js`, `ruleDiscovery.js`)

**Anchored rules.** There are 26 requirements for 7 categories. Each is tied to the paragraph that states it and is checked against the corpus at runtime: the direction's title must match and a paragraph must contain the wording *with the number*. If the paragraph isn't found, the rule is reported as *Needs review* instead of being applied with a possibly stale threshold.

| Category | Requirements (Master Direction, paragraph) |
|---|---|
| Commercial banks | CRAR ≥ 9, CET1 ≥ 5.5, Tier 1 ≥ 7 (Capital Adequacy para 11); with the 2.5% CCB: CRAR ≥ 11.5, CET1 ≥ 8 (para 251, *buffer*); leverage ≥ 4 for a D-SIB, ≥ 3.5 for others (para 262); LCR ≥ 100 (ALM para 102); NSFR ≥ 100 (ALM para 211); PSL ≥ 40% of ANBC (PSL para 7.1, *target*) |
| Small finance banks | CRAR ≥ 15, CET1 ≥ 6, Tier 1 ≥ 7.5 (para 10); leverage ≥ 4.5 (para 199); LCR ≥ 100; NSFR ≥ 100 |
| Payments banks | CRAR ≥ 15, CET1 ≥ 6, Tier 1 ≥ 7.5 (para 8); leverage ≥ 3 (para 84) |
| Urban co-operative banks | CRAR ≥ 9 for Tier 1, ≥ 12 for Tiers 2–4 (para 9); net worth ≥ ₹5 crore, with the 50%-by-2026 / 100%-by-2028 glide path (para 6) |
| RRBs | CRAR ≥ 9 (para 6), Tier 1 ≥ 7 (para 10) |
| Local area banks, rural co-operative banks | CRAR ≥ 9 |

**Discovered rules.** For figures no anchored rule covers (e.g. NPA ratios for an SFB), extracted rule atoms of the bank's category whose wording names the figure and whose unit matches are found by search.
- **With an LLM:** each candidate is judged on whether the paragraph imposes that number on this figure for this category. Many don't: "net NPA not above 6%" is often an *eligibility* condition, e.g. for paying dividends. Confirmed rules are then compared by arithmetic.
- **Without an LLM:** they are listed as *Possible rule* with no verdict, and they don't affect the overall result.

## 5. Checking

The pass/fail comparison is always plain arithmetic.

| Status | Meaning |
|---|---|
| Pass | The requirement is met |
| Breach | Below a regulatory minimum |
| Buffer shortfall | Above the minimum but inside the capital conservation buffer: distribution constraints apply |
| Target shortfall | A lending target is missed (e.g. PSL): RIDF allocation, not a breach |
| Pass (conditions) | Allowed by a transition in the same paragraph (UCB net worth glide path) |
| Not in document | The figure isn't in this document. This is not a finding against the bank; upload the document that has it or enter it. |
| Needs review | The anchor isn't in the corpus, the reading has low confidence, or (UCB) the tier is unknown and the value lies between 9% and 12% |

Overall result: **Breach** if any minimum is breached. Otherwise **Needs attention** if there is a shortfall, an item to review or a missing disclosure. Otherwise **Pass** for what could be checked, or **Insufficient data**.

## 6. Other checks in the same run

- **Disclosure completeness** (`disclosureChecklist.js`):
  - Annual report → the Notes-to-Accounts items of the category's *Financial Statements: Presentation and Disclosures* direction.
  - Pillar 3 document → DF tables of the Capital Adequacy direction.
  - An item is applied only if its heading exists in that category's direction (e.g. 23 items for commercial banks, 17 for UCBs). A missing item is *Likely missing*, since it may be published elsewhere.
- **Obligations the document addresses** (`documentQualitative.js`):
  - Short governance passages (board committees, KYC, grievances / Internal Ombudsman, outsourcing, cyber security, frauds, …) are matched with BGE embeddings to obligations of the category.
  - Only pairs about the same subject are kept.
  - With an LLM each pair is judged Covered / Partial / Not demonstrated; without one it is *Evidence found*.
  - Obligations the document doesn't mention are not called gaps, because a public document isn't expected to describe everything.
- **Feeding the manual checker:** figures are stored per bank and period (`bank_metric_values`). Where an extracted rule atom states the same threshold in the same paragraph, the value is also written to the manual per-rule table (source note `auto: …`). Matched passages are saved as qualitative evidence.

## 7. Report

- The report is saved as a compliance run and shows in **History** with an "auto" badge and the overall result.
- It can be opened or downloaded as a self-contained HTML page (`/api/disclosures/runs/:id/report.html`, print to PDF from the browser).
- The executive summary is written by the LLM from the findings only. Without an LLM, a template summary is used.

## Where the LLM is used, and where it is not

| Deterministic (always) | LLM (only when configured and needed; every answer checked) |
|---|---|
| Reading the file, rebuilding table rows | Figures the patterns did not find (quote + number must be in the document) |
| Recognising figures, units, current-period column | Bank / category / date when not detectable (must appear in the text / be a known category) |
| Selecting the rules for the category and profile | Whether a rule found by search really constrains the figure |
| Anchoring each rule to its paragraph | Whether a governance passage demonstrates an obligation |
| Pass / fail arithmetic, disclosure completeness | The executive summary (from the findings only) |

## API

| Method | Path | |
|---|---|---|
| POST | `/api/disclosures/analyze` | multipart `file`, optional `use_llm`, `force`; returns profile, figures (page, line, confidence, alternatives), expected figures |
| GET | `/api/disclosures/samples` | documents in `sample-data/manifest.json` |
| POST | `/api/disclosures/samples/analyze` | `{file}` |
| GET / PATCH | `/api/disclosures/:id` | read / correct `{profile: {...}, metrics: {key: value \| null}}` |
| POST | `/api/disclosures/:id/run` | `{use_llm, include_qualitative, discover_rules, persist}` → `{run_id, report}` |
| GET | `/api/disclosures/:id/file` | the uploaded file (PDF opens at `#page=N`) |
| GET | `/api/disclosures/runs/:runId/report.html` | `?download=1` |

```bash
curl -F file=@sample-data/test-cases/example-sfb-pillar3-sep-2025.pdf http://localhost:4002/api/disclosures/analyze
curl -X POST http://localhost:4002/api/disclosures/<upload_id>/run -H 'Content-Type: application/json' -d '{}'
```

## Evaluation

- `npm run eval:disclosures` runs every document in `sample-data/` and checks 142 expectations: figures, profile, rule verdicts and disclosures. Result: **142/142**, deterministic, no LLM.
- `test/disclosures.test.js` covers the API end to end on a corpus built from three real directions. This includes a duplicate upload, corrections, missing profile fields, refused files, and the rejection of an LLM figure that isn't in the document.

## Limits

- **Public documents only.** They carry summary figures. Borrower-level limits (single / group exposure, related-party lending) need the bank's internal data (the network / graph check, on the `graph-subsystem` branch).
- **Rule coverage.** Anchored rules cover capital, leverage, liquidity and PSL. Other figure-based rules come from discovery and are only as good as the extracted rule atoms, plus the LLM when configured.
- **Tested layouts.** Real-bank samples are re-typeset extracts, because bank websites could not be reached from the build environment. Run `sample-data/fetch_originals.sh` and test with the original PDFs; the report shows the page and line of every figure so a misreading is easy to spot and correct.
- **D-SIB list.** It is kept in code (it isn't part of the corpus) and can be changed on the review screen.
