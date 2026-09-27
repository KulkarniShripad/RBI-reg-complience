# How the compliance checker works

This describes the compliance checking system end to end: what the user does
on the dashboard, which API each step calls, what the backend computes, where
the data lives, and what is (and is not) automated. The counterparty-network
check (Subsystem 3) is summarised here and described in full in
[NETWORK_GRAPH.md](NETWORK_GRAPH.md).

## 1. The big picture

```
 RBI PDFs ──► extraction pipeline (Python) ──► urcc_ef.db
                                                 ├─ documents + document_categories   (which entity types a direction applies to)
                                                 ├─ clause_registry                   (every paragraph, with role: obligation / definition / ...)
                                                 └─ rule_atoms                        (numeric thresholds: operator, value, unit, requirement|condition)

 Bank (dashboard)                     Backend (Node, /api/...)                      Stored in urcc_ef.db
 ─────────────────                    ─────────────────────────                     ────────────────────
 1 Bank Setup ───────────────────────► POST /banks                                 banks
 2 Quantitative form ◄──────────────── GET  /banks/:id/applicable-rules            (reads rule_atoms for the bank's category)
   enter figures ────────────────────► POST /banks/:id/quant-submissions  ──────► bank_quant_submissions  (+ anomaly flags returned)
 3 Qualitative evidence ─────────────► POST /banks/:id/qual-evidence      ──────► bank_qual_evidence
 3b Network (counterparties, links,  ► /api/graph/:id/...               ──────► graph_entities, graph_edges,
    exposures, capital)                                                          graph_exposures, graph_capital
 4 Run check ────────────────────────► POST /compliance/:id/run
                                          ├─ Subsystem 1: deterministic rule engine (no LLM)
                                          ├─ optional: LLM field-mapping warning (advisory only)
                                          ├─ Subsystem 2: embeddings + Gemini judgement
                                          ├─ Subsystem 3: counterparty network (graph algorithms, no LLM)
                                          └─ report + persist ───────────────────► compliance_runs, compliance_run_details,
                                                                                   graph_check_runs, graph_check_results
 5 History ◄───────────────────────── GET  /compliance/:id/runs, /compliance/runs/:runId
```

Two further endpoints exist for the research experiments: `run-routed` (the
adaptive router) and `compare` (fixed pipeline vs router on the same data).

## 2. Step by step

### Step 1 — Register the bank (Bank Setup tab)
`BankSetup.tsx` → `POST /api/banks {bank_id, bank_name, institution_category}`.

The category list comes from the backend (`GET /categories`), and the backend
normalises whatever it receives (`small financial banks`, `SFB`,
`small_finance_banks` → `small_finance_banks`). An unknown value is rejected
with the list of valid ones. The category decides which directions (and
therefore which rules) apply to the bank.

### Step 2 — Enter quantitative figures (Quantitative tab)
`QuantitativeForm.tsx` → `GET /api/banks/:id/applicable-rules?period_label=Q1-FY2026-27`.

The backend (`bankController.applicableQuantRules`) returns every rule atom
that is:
- extracted from a document that applies to the bank's category
  (`document_categories`, so a direction addressed to "SCBs including SFBs"
  applies to both), and
- a **requirement** (a modal verb governs it: "shall not exceed 25 per cent"),
  not a **condition** ("loans exceeding ₹5 crore shall ...", which only
  defines scope).

Each row shows the threshold (`≤ 25 % of total investments`), the source
paragraph and page, the extraction confidence, and the form label. The label is
the human-approved `canonical_label` if someone curated the rule
(`rule_field_mappings`), otherwise the extracted `variable_text` marked
**unverified**.

Saving calls `POST /api/banks/:id/quant-submissions` with
`[{rule_id, reported_value, period_label, source_note}]`. Before storing,
`anomalyCheckService` adds non-blocking flags:
- **range check** by unit: a `%` outside 0–100, a negative day count, etc.;
- **trend check**: a z-score against the bank's own history for the same rule
  (flags a value > 3 standard deviations from its recent periods — the typical
  signature of a figure typed into the wrong field).

One value is stored per (bank, rule, period); re-saving overwrites it.

### Step 3 — Add qualitative evidence (Qualitative tab)
`QualitativeEvidence.tsx` → `POST /api/banks/:id/qual-evidence
{evidence_text, source_type, period_label}`. This is the bank's own text:
board minutes, policy manuals, audit notes. Exact duplicates are ignored.

### Step 3b — Enter the counterparty network (Network tab)
`NetworkPanel.tsx` → `/api/graph/:bankId/...`. The bank records its
counterparties, how they are connected (ownership, control, common
management, economic dependence, directors, relatives, promoters), its
exposures for the period and its capital base — by hand, from CSV / JSON, or
by opening a synthetic sample network. Links can be confirmed, flagged
(suspected) or rebutted (shown to RBI not to create a single risk). The
network check runs on every change, so the graph and findings are always
current. Details: [NETWORK_GRAPH.md](NETWORK_GRAPH.md).

### Step 4 — Run the check (Run & Results tab)
`RunCheck.tsx` → `POST /api/compliance/:id/run {period_label, use_llm_mapping_check, qual_sample_limit, persist}`.
`complianceController.runComplianceCheck` does four things:

**a) Subsystem 1 — deterministic rule engine** (`quantComplianceService.checkQuantitative`).
For every applicable requirement:

| Situation | Status |
|---|---|
| no figure submitted for this period | `NOT_REPORTED` |
| figure satisfies the operator (`<=`, `>=`, `<`, `>`, `within_days`) | `PASS` |
| figure violates it | `BREACH` |

Pure arithmetic, no LLM, fully reproducible. Each result carries the clause
text, RBI reference, page, and the sentence the threshold came from.

**b) Optional LLM mapping check** (`use_llm_mapping_check`). For rules that have
a figure, Gemini is asked only whether the *label* the figure was entered
under plausibly refers to the rule's variable. It can add a warning; it can
never change PASS/BREACH/NOT_REPORTED.

**c) Subsystem 2 — qualitative obligations** (`qualComplianceService.checkQualitative`).
1. **Which obligations:** paragraphs classified as `obligation` (not
   definitions, titles, repeal clauses or deleted text) from the directions that
   apply to the category. Assessing thousands with an LLM on every run is not
   practical, so `qual_sample_limit` obligations are taken **round-robin across
   directions** (one from each direction in turn), so the sample covers many
   directions rather than the first paragraphs of one. The response also says
   how many obligations apply in total.
2. **Find the best evidence:** every evidence text and the obligation are
   embedded with the same BGE model used by search; cosine similarity picks the
   closest evidence.
3. **Judge:** if the best similarity is ≥ 0.6, Gemini reads the obligation and
   that evidence and answers `full / partial / none` with a one-sentence
   justification grounded only in the two texts.

| Situation | Status |
|---|---|
| no evidence submitted, or nothing similar enough | `LIKELY_GAP` |
| Gemini: full | `COVERED` |
| Gemini: partial | `PARTIAL` |
| Gemini: none | `LIKELY_GAP` |
| Gemini call failed / no API key / embeddings unavailable | `NEEDS_REVIEW` (never silently `COVERED`) |

**c2) Subsystem 3 — counterparty network** (`services/graph/`), only when
the bank has exposures for the period. Groups of connected counterparties are
built over control and economic-dependence links (with RBI's downstream /
upstream contagion rules), related parties are found by path from the bank's
directors, promoters and major shareholders, and the bank's own group is
derived from ownership. Each is checked against the limit of the bank's
category — the rule is applied only if its source paragraph is found in the
corpus with the same number:

| Situation | Status |
|---|---|
| within the limit | `PASS` |
| above the base limit but within Board-approved / infrastructure headroom | `PASS_WITH_CONDITIONS` |
| above every limit | `BREACH` |
| a breach only if flagged (unconfirmed) links are real | `POTENTIAL_BREACH` |
| exposure to a director-, relative-, promoter- or major-shareholder-linked party | `PROHIBITED` |
| capital base missing, rule source not verified, exception claimed | `NEEDS_REVIEW` |
| > 5% of capital and no economic-interdependence assessment recorded | `ASSESSMENT_REQUIRED` |
| ≥ 10% of capital (large exposure) | `REPORTABLE` |

**d) Report and history** (`reportService`). Counts per status, the list of
breaches (with rule, reported value, clause), mapping warnings, and gaps. With
`persist=true` the run is stored in `compliance_runs` (summary) and
`compliance_run_details` (one row per rule/obligation, frozen at run time), so
later changes to rules do not rewrite history.

### Step 5 — History tab
`RunHistory.tsx` → `GET /api/compliance/:id/runs` (list) and
`GET /api/compliance/runs/:runId` (one run with `report`, `quant_results`,
`qual_results`, and `graph_results` when the network was checked).

## 3. The adaptive router (research endpoints)

`POST /api/compliance/:id/run-routed` sends each applicable obligation/rule to
one of four "routes" and records why (`routingService.js`, logged in
`routing_decisions`):

| Route | When |
|---|---|
| `RULE_ENGINE` | a high-confidence requirement rule atom exists and a figure was submitted |
| `GRAPH` | the clause is one the network check decides (a concentration limit or related-party prohibition whose paragraph resolved in the corpus) **and** the bank has network data for the period — takes precedence over the rule engine, because the value is an aggregate over the graph |
| `RAG_LLM` | evidence retrieval is confident (clear gap between best and second-best evidence, or a high absolute score when there are < 3 evidence texts) |
| `HUMAN` | nothing met its bar |
| *(no route)* `INSUFFICIENT_DATA` | nothing submitted for that clause |

`POST /api/compliance/:id/compare` runs the fixed pipeline and the router on
the same bank and period and returns the per-clause agreement rate.

## 4. Curating the rule ↔ return-field mapping

The unsolved part of automation is knowing *which figure in the bank's
returns* a rule refers to. `POST /api/rule-mappings/:ruleId/suggest` asks
Gemini for a canonical label (and a CIMS return code only if the clause names
one) — stored but inert. `PUT /api/rule-mappings/:ruleId/approve` records a
human's approved label/code; only then does the form show the rule as
`approved`. This is curation once per rule, not an LLM guess per submission.

## 5. Tables involved

| Table | Written by | Purpose |
|---|---|---|
| `documents`, `document_categories` | extraction pipeline | which directions apply to which entity type |
| `clause_registry` | extraction pipeline | every paragraph, its role and type |
| `rule_atoms` | extraction pipeline | thresholds; `atom_kind` requirement/condition; `confidence` |
| `banks` | Bank Setup | bank → category |
| `bank_quant_submissions` | Quantitative form | one figure per bank/rule/period |
| `bank_qual_evidence` | Qualitative tab | the bank's governance text |
| `compliance_runs`, `compliance_run_details` | Run check | frozen results |
| `routing_decisions` | run-routed | audit trail of router choices |
| `rule_field_mappings` | curation endpoints | approved labels / return codes |
| `graph_entities`, `graph_edges`, `graph_exposures`, `graph_capital`, `graph_bank_profile` | Network tab | the counterparty network per bank / period |
| `graph_check_runs`, `graph_check_results` | network check / compliance run | frozen network findings |

A corpus rebuild (`npm run build:corpus`) re-extracts rules, so rule ids can
change. The build carries bank data over from the previous database and
re-points submissions and approved mappings to the new rule ids where the same
rule (same RBI reference, paragraph, operator, value and unit) is found; it
reports anything it could not re-point.

## 6. What is solid and what is not (measured / known)

Solid:
- The quantitative verdict is deterministic arithmetic on stored thresholds.
- Every result traces to a document, paragraph and page (the chat's source
  viewer can open the original PDF at that page).
- Failures degrade to `NEEDS_REVIEW` or `NOT_REPORTED`, never to a fabricated
  pass.

Limits to keep in mind:
- **Rule extraction.** 1,112 requirement atoms (+ 3,116 conditions) are
  extracted by deterministic patterns. On a random sample of 30 high-confidence
  requirements, operator/value/unit were right in 30/30 and the
  requirement-vs-condition label in 29/30 (small sample — treat as roughly
  95%+, not a guarantee). `variable_text` (what the threshold constrains) is
  the weakest field; that is why labels start as "unverified". Recall (how many
  of all numeric requirements in the corpus are captured) has not been
  measured.
- **Applicability within a category** is not modelled: a direction for
  NBFCs may apply only to NBFC-UL or only to deposit-taking NBFCs, but the
  checker lists all of its requirements for every NBFC. Expect many
  `NOT_REPORTED` rows that simply don't apply to a given bank.
- **Figures are entered manually.** There is no CIMS/XBRL feed.
- **Qualitative results depend on Gemini.** Without a working key every matched
  obligation is `NEEDS_REVIEW`. The 0.6 similarity cut-off has not been
  calibrated on labelled bank evidence.
- **Qualitative coverage is a sample** (`qual_sample_limit`), not every
  obligation.
- **The network check has only been evaluated on synthetic networks**
  (40 / 40 expected outcomes on 6 scenarios). Ownership, directorship and
  dependence data must come from the bank; there is no registry feed.
