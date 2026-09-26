# RBI Return Formats — Verification + Compliance-Engine Capability Analysis

## 1. Verification of the formats you pasted

Checked against RBI's own live "List of Returns under XBRL" (rbi.org.in, DBR/DBS departments) and current master circulars. Verdict: **mostly accurate, with a few corrections.**

| Your source said | Verified status | Correction / detail |
|---|---|---|
| Form A (Section 42(2)) — CRR, fortnightly | ✅ Correct | Confirmed live. Provisional return due within 7 days of fortnight-end, final within 20 days. Also has a **Memorandum to Form A** (paid-up capital, reserves, time-deposit maturity split) and **Annex A/B** (FX liabilities, differential-reserve deposits) that your summary didn't mention — included in the synthetic file. |
| Form VIII (Section 24 BR Act) — SLR | ✅ Correct, but description was too vague | RBI's own listing calls it "Statement of demand and time liabilities and investments for calculation of SLR," not an annual-only filing — commercial banks file it more frequently; UCBs file annually per BR Act (AACS) Sec 18 & 24. |
| Form IX — described as "annual check ensuring final accounts match declarations" | ⚠️ **Inaccurate description** | RBI's live listing defines Form IX as the **"Statement showing unclaimed deposits required to be listed as statutory list"** — nothing to do with reconciling audited financials. Your source conflated it with a generic year-end filing. Corrected in the synthetic set; a real "audited balance sheet" filing exists but isn't called Form IX. |
| CRILC — monthly, ₹5 cr+ exposure | ✅ Correct | Confirmed structure: **CRILC-Main** (quarterly/monthly, 4 sections — Large Borrowers Global Ops, Technically/Prudentially Written-off, Current-Account Credit Balances, Non-Cooperative Borrowers) plus **CRILC-SMA2/JLF** (as-and-when, triggered at 61+ days overdue). UCBs ≥₹500 cr assets file a separate quarterly CRILC-UCB via XBRL. Your source's "monthly/weekly" framing was roughly right but collapsed two distinct sub-returns into one. |
| RCA2 — Return on Capital Adequacy | ⚠️ **Version is stale** | RBI's current live XBRL return list shows the active return as **RCA3**, not RCA2. RCA2 appears to be a superseded label from an older reporting cycle. Used RCA3 in the synthetic set. |
| ALM Returns — "time-bucket cash flows" | ⚠️ **Not a single return** | "ALM" is the umbrella framework, not one return code. It's actually filed as separate returns: **SSL** (Statement of Structural Liquidity — the time-bucket cash-flow statement you described) and **IRS/SIR** (Interest Rate Sensitivity, Rupee / Forex, a *separate* repricing-gap statement). Split into its correct components in the synthetic set. |
| "Return on Connected Lending & Exposures" | ~✅ Directionally correct | The live return list's actual code for this is **RLC / RLE** ("Report on Large Credit" / "Report on Large Exposure"), not a return literally named "Connected Lending." |
| LRS Return — monthly, purpose-coded | ✅ Correct | Confirmed migrated fully to CIMS from XBRL. Applies specifically to Authorized Dealer banks remitting for resident individuals — flagged as an edge case for an RRB in the synthetic file. |
| PSL Returns — quarterly, sector-wise | ✅ Correct | Structure (ANBC-relative targets: 40%/75% overall depending on bank type, with agriculture/MSE/weaker-section sub-targets) confirmed against current PSL master directions. |
| Digital Payment Security & Card Statistics | ✅ Broadly correct, no single return code | This is reported across several distinct returns/ombudsman-scheme disclosures rather than one filing, but the field set you listed is directionally right. |

**Additional real returns found but missing from your list** (from RBI's own XBRL return index, DBR/DBS departments): **Form B** (fortnightly Section-42 return for scheduled banks other than SCBs), **Form I / Form II** (UCB-specific SLR/CRR compliance detail), **ALO** (Asset-Liability Exposure, Overseas), **CME** (Country Maturity Exposure), **PC&I** (Problem Credit and Investments), **ROF** (Report on Fraud), **ROP** (Return on Profitability), **DSB Return** (the NBFC-specific quarterly/annual return, distinct from bank returns entirely). I didn't build synthetic files for all of these — happy to add specific ones on request, but the ones already built cover every *category* your framework's Subsystems 1–3 care about (statutory ratio, credit-risk/borrower-level, capital adequacy, ALM/time-bucket, sector-target, qualitative/narrative).

## 2. What's now in `/synthetic_dataset/`

| File | RBI return it mimics | Data shape |
|---|---|---|
| `form_a_crr_synthetic.csv` | Form A (CRR) + Memorandum + Annex A | flat key-value, single period |
| `form_viii_slr_synthetic.csv` | Form VIII (SLR) | flat key-value, single period |
| `crilc_main_synthetic.csv` | CRILC-Main (Sections 1, 3, 4) | **borrower-level table**, multiple rows per bank |
| `rca3_capital_adequacy_synthetic.csv` | RCA3 | flat key-value, single period |
| `alm_ssl_synthetic.csv` | SSL (Statement of Structural Liquidity) | **time-bucketed table**, 10 maturity buckets |
| `psl_synthetic.csv` | PSL quarterly return | **sector-wise table** against ANBC |
| `lrs_and_digital_payments_synthetic.csv` | LRS + digital payment/card stats | purpose-coded table + flat key-value |
| `qualitative_evidence_synthetic.json` | board minutes / policy excerpts (Subsystem 2 input) | flat list of free-text strings |
| `rule_atom_submission_synthetic.json` | the bridge into your actual code | `{rule_id: float}` dict — the *only* shape your check functions accept today |

## 3. What your current compliance-checking code can actually check — traced through the real logic

I read `compliance_checker.py`, `quantComplianceService.js`, `qualComplianceService.js`, `routingService.js`, and the `rule_atoms` schema in `db_builder.py`. Here's the honest capability boundary:

### ✅ Can check today
- **A single scalar percentage/day-count/ratio against a single threshold**, where that threshold was already extracted into `rule_atoms` (operator, threshold_value, threshold_unit) by `classifier.py`'s regex templates.
- Concretely: **Form A's CRR%**, **Form VIII's SLR%**, **RCA3's CRAR%**, single HTM/AFS/single-borrower-concentration percentages — anything that reduces to `submitted_value <op> threshold`.
- This is exactly the shape `rule_atom_submission_synthetic.json` is built in.
- Qualitative narrative text (`qualitative_evidence_synthetic.json`) **can** be checked, but only via vector-similarity retrieval + an LLM judgment call (`qualComplianceService.js` → `geminiService.js`) — this works today in the Node backend (Python `compliance_checker.py` still has it stubbed).

### ❌ Cannot check today (would silently fail, get dropped, or need new code)
1. **Borrower-level / relational data (CRILC)** — there's no table for individual borrower rows, no per-entity threshold, and no linkage across borrowers into a "group of connected counterparties." This is exactly **Subsystem 3 (Network Topology Mapper)**, which the handoff doc marks as *designed but not built*. `crilc_main_synthetic.csv` cannot be fed into `check_quantitative_compliance()` at all — it isn't a `{rule_id: float}` shape and never could be without new schema (a `borrower_exposures` table + graph edges).
2. **Time-bucketed / multi-dimensional data (ALM/SSL)** — `alm_ssl_synthetic.csv` has 10 buckets × 2 flows; the rule engine only compares one number to one threshold. A real SSL check ("cumulative mismatch in the 1–14 day bucket shall not exceed X% of outflows") would need a new rule-atom type keyed by `(bucket, metric)`, which `classifier.py`'s current templates don't extract (the regex set has no bucket-awareness).
3. **Categorical/enum fields** (asset classification: Standard/SMA-0/SMA-1/SMA-2/NPA, JLF-formed Yes/No) — `classifier.py`'s `QUANT_PATTERNS`/`RULE_ATOM_TEMPLATES` only match numeric-threshold language ("shall not exceed X per cent"); categorical compliance rules ("an account classified SMA-2 shall be reported to CRILC within N days") get classified `relational`/`hybrid` and flagged `needs_llm_refinement`, never auto-evaluated.
4. **Cross-referenced / compound thresholds** (e.g., "group exposure shall not exceed 25% of eligible capital, aggregated across all connected counterparties") — same story: flagged `relational`, deferred, no evaluator exists yet (again Subsystem 3).
5. **Sector-wise multi-row targets (PSL)** — `psl_synthetic.csv` has 5 sector rows each needing its own threshold; today's schema has no way to say "this rule_atom applies to the *agriculture* sub-target specifically." It would need a `variable_name` taxonomy `classifier.py` doesn't have (`KNOWN_VARIABLES` has no PSL entries at all).
6. **Structured XML/XBRL submissions** — the whole pipeline only ever parses **PDF circular text** (`parser.py`, `pdftotext`-based). There is no ingestion path for a bank's actual XBRL/CIMS submission file (the returns above are filed as CIMS element data, not PDFs) — that's the unsolved "bridge table" problem the handoff doc names explicitly in §6, item 6.
7. **Anything not already curated into `rule_atoms`** — even for a pure percentage rule, `bank_submission_demo.py`'s own docstring says the `rule_id ↔ CIMS field` mapping is hand-done and unsolved at scale; `rule_field_mappings` + `ruleMappingController.js` exist as a human-in-the-loop approval workflow for exactly this reason, and nothing auto-populates it from a real return.

### One-line summary
Your engine can check **scalar ratio/day-count rules with an existing curated `rule_id`** (Form A/VIII/RCA3-style single numbers) and **free-text narrative evidence** (via LLM judgment). Everything with structure below "one number" — borrower rows (CRILC), time buckets (ALM), sector rows (PSL), categorical states (asset classification) — is outside what any current file can evaluate, and matches almost exactly the "Subsystem 3 not built" + "~90% of quant clauses deferred to LLM refinement" gaps your own handoff doc already flags.
