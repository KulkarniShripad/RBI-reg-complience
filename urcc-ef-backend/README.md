# URCC-EF Backend (Node.js API layer)

This is the API layer that sits on top of your existing Python ingestion
pipeline. **The Python scripts didn't get rewritten** — they were moved into
`scripts/` unchanged (plus two small new worker scripts) and the Node
backend calls into the SQLite databases they produce, plus shells out to
Python for the two things that are genuinely Python's job here (vector
math, PDF scraping).

## How the pieces fit together

```
scripts/                    <- your original pipeline, unchanged, + additions
  parser.py                 (unchanged)
  classifier.py              (unchanged)
  chunker.py                  (unchanged)
  db_builder.py             (ONE LINE PATCHED - see note below - otherwise
                             unchanged; run this for a full fresh rebuild)
  incremental_ingest.py      (NEW - safe way to add one new circular
                              without rebuilding/destroying the whole DB)
  build_vectors.py            (NEW - wraps vector_db_builder.py with a
                               small-corpus dimension guard, see below)
  vector_db_builder.py             (unchanged - run this to build urcc_ef_vectors.db)
  query_demo.py                     (unchanged - kept as a CLI reference/debug tool)
  compliance_checker.py              (unchanged - kept as reference; Node reimplements
                                       its logic in src/services/ so it can call Gemini
                                       for real instead of stubbing)
  bank_submission_demo.py             (unchanged - kept as reference/seed data)
  run_compliance_check.py              (unchanged - kept as CLI reference)
  vector_search_worker.py              (NEW - thin CLI bridge, called by Node)
  vector_rank_worker.py                (NEW - thin CLI bridge, called by Node)
  rbi_scraper.py                        (NEW - the "keep the DB updated" scraper)
  requirements.txt

data/                        <- put urcc_ef.db, urcc_ef_vectors.db, vector_model.pkl here
migrations/                  <- additive SQL + a persisted FTS5 index builder
src/
  config/                     env.js, db.js
  services/                   geminiService.js, quantComplianceService.js,
                               qualComplianceService.js, vectorSearchService.js,
                               reportService.js
  controllers/                bankController.js, complianceController.js,
                               documentController.js, queryController.js,
                               ingestController.js
  routes/                     one file per resource, mounted under /api/*
  server.js                   Express app + cron job for scheduled RBI checks
```

## Quick start — this exact repo already has a working demo database in it

`data/urcc_ef.db`, `data/urcc_ef_vectors.db`, and `data/vector_model.pkl` in
this zip are **real, already-built** databases — not placeholders. They
were produced by actually running `parser.py` → `classifier.py` →
`chunker.py` → the ingestion pipeline against two synthetic-but-realistic
RBI-style circulars (see `scripts/circulars/`), the same way your real
266-document corpus would be ingested. This means you can run the full
demo immediately without building anything first:

```bash
cd urcc-ef-backend
npm install
pip install -r scripts/requirements.txt --break-system-packages
cp .env.example .env   # add GEMINI_API_KEY if you want real qualitative judgments;
                        # the demo below still works without one - see note in step 6
npm start
```

In a second terminal:
```bash
bash scripts/demo/seed_and_test.sh
```

That one script registers a bank, shows the applicable-rules form data,
submits synthetic quantitative + qualitative data, then runs **all three**
compliance check flavors (fixed-hybrid baseline, adaptive router, and a
side-by-side comparison) and prints everything. Read
`scripts/demo/sample_bank_data.json` first — it documents exactly what
each submitted value is testing for (one intentional breach, two passes,
one boundary-adjacent pass) and why.

**Without a `GEMINI_API_KEY` set**, qualitative clauses will correctly
come back as `NEEDS_REVIEW` with an `{error: "..."}` judgment instead of a
fabricated verdict — this is the honest-failure path in
`qualComplianceService.js` working as designed, not a bug. Add a real key
to see actual `COVERED`/`PARTIAL`/`LIKELY_GAP` judgments.

---

## Setup from scratch (building your own corpus instead of the demo one)

```bash
cd urcc-ef-backend
npm install
pip install -r scripts/requirements.txt --break-system-packages   # or use a venv

cp .env.example .env
# edit .env: set GEMINI_API_KEY at minimum

# Copy your already-built databases in (from the original project), or build fresh:
cp /path/to/urcc_ef.db data/
cp /path/to/urcc_ef_vectors.db data/
cp /path/to/vector_model.pkl data/
# --- OR, to build from scratch against your circulars.zip corpus ---
# edit the paths at the bottom of scripts/db_builder.py, then:
npm run ingest:build-db
npm run ingest:build-vectors

npm run migrate       # adds banks/submissions/compliance_runs/document_versions tables
npm run migrate:fts   # builds the persisted full-text search index

npm start             # or npm run dev for auto-restart
```

Server listens on `http://localhost:4000` by default.

---

## Adding a new circular / updating the DB when RBI publishes something new

**Do not just re-run `scripts/db_builder.py` against a live system.** It
deletes and rebuilds `urcc_ef.db` from scratch on every run (`os.remove
(db_path)` at the top) — fine for the very first ingest, but it will
silently destroy every bank, submission, compliance run, and routing
decision you've accumulated since. Use `incremental_ingest.py` instead:

```bash
# 1. Get the new PDF into the right category folder (rbi_scraper.py --mode
#    apply does this automatically when run for real; see below)
cp new_circular.pdf scripts/circulars/Regional_Rural_Bank/

# 2. Add ONLY the new/changed documents - safe to run anytime, anti-idempotent
#    re-runs are no-ops (already-ingested doc_ids are skipped, logged, not
#    reprocessed)
cd scripts
python3 incremental_ingest.py circulars --db ../data/urcc_ef.db

# 3. Re-embed (cheap at real corpus scale - only re-embeds what changed if
#    you extend build_vectors.py to diff, or just re-run fully like this
#    for now) and refresh full-text search
python3 build_vectors.py
cd .. && npm run migrate:fts
```

This was tested during development exactly this way: a second synthetic
circular (`scripts/circulars/NBFC/sample_nbfc_capital_directions.pdf`) was
added to a database that already had a registered bank, 4 quantitative
submissions, 2 qualitative evidence rows, and 20 logged routing decisions
— all of which survived untouched, confirmed by row-count comparison
before/after. `incremental_ingest.py`'s docstring also states the one
real limitation this doesn't solve: if an amendment shifts paragraph
numbers, that document's `clause_uri`s change, which can orphan
`rule_field_mappings`/`bank_quant_submissions` tied to the old numbering —
the script deletes and re-inserts only that one document's rows and prints
the old `rule_id`s so a human can review what to do about them, rather
than attempting automatic rule migration.

### Automating the RBI-side detection of "something changed"

```bash
# Check-only: refreshes rbi_watch_list by diffing RBI's own "(Updated as
# on ...)" title labels - cheap, no downloads. Also runs automatically on
# the cron schedule in .env (RBI_UPDATE_CRON).
curl -X POST http://localhost:4000/api/ingest/scan

# See what changed
curl http://localhost:4000/api/ingest/pending-updates

# Apply: downloads the changed PDFs into scripts/circulars/<category>/
curl -X POST "http://localhost:4000/api/ingest/scan?apply=true"

# Then run steps 2-3 above (incremental_ingest.py -> build_vectors.py -> migrate:fts)
```
Remember: `rbi_scraper.py` needs `rbi.org.in` reachable, which this
sandbox's network allowlist doesn't include — run it from your own
machine, not from inside this development environment.

---

## The routing algorithm — how it actually decides, and how to see it decide

`src/services/routingService.js` implements the adaptive modality router
from `URCC-EF_Research_Blueprint.md` §5. For every clause applicable to a
bank, it picks one of four routes and — critically for the research
angle — **records exactly why**:

| Route | Fires when |
|---|---|
| `RULE_ENGINE` | clause is quantitative, extraction confidence is `high`, and a clean `rule_atom` exists — never trusts a rule_atom alone if the classifier itself flagged low confidence |
| `GRAPH` | clause is relational AND real ownership/exposure graph data exists for the bank (never fires in this codebase — no real data source, see blueprint §7; the gate is real, just never satisfied) |
| `RAG_LLM` | vector-retrieval confidence is high — either a large score gap between the best and second-best evidence match (large evidence pools), or a high absolute top score when the evidence pool is too small (<3 documents) for a relative gap to mean anything |
| `HUMAN` | nothing else met its bar, or a rule has a history of routes disagreeing on it |

**This exact router surfaced and fixed a real bug during development,** worth
knowing about since it's a genuine finding, not a hypothetical: with only 2
qualitative evidence documents submitted, the *relative gap* between the
top-1 and top-2 retrieval scores collapsed to 0.000 even when the top
match was a clearly strong 0.89 absolute similarity — because with only 2
candidates, "how much better is the best match than the second-best" stops
being a meaningful signal. The router now uses an absolute-score floor
instead of relative spread when the evidence pool is small
(`THRESHOLDS.SMALL_POOL_SIZE` in `routingService.js`). This is exactly the
kind of measured, reported finding the blueprint's ablation-study section
wants — consider writing this up as a concrete example in your methods
section rather than smoothing it out of the story.

**See it decide, live:**
```bash
# Run the adaptive router and see route + reasons per clause
curl -X POST http://localhost:4000/api/compliance/RRB-DEMO-001/run-routed \
  -H "Content-Type: application/json" -d '{"period_label": "Q2-FY2026-27"}' | python3 -m json.tool

# Compare it against the fixed-hybrid baseline on the same data (RQ1 experiment)
curl -X POST http://localhost:4000/api/compliance/RRB-DEMO-001/compare \
  -H "Content-Type: application/json" -d '{"period_label": "Q2-FY2026-27"}' | python3 -m json.tool
```

Every routing decision is also logged to the `routing_decisions` table
(added by `migrations/004_routing_decisions.sql`) so you can query
route-distribution and agreement-rate statistics across many runs later
for the paper's experiments, not just inspect one run's JSON output.

---

## Setup from scratch (building your own corpus instead of the demo one)

### Corpus browsing (read-only, over your existing 266-doc ingest)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/documents/stats` | corpus-wide counts (docs, clauses by type, rule atoms, etc.) |
| GET | `/api/documents/institution-categories` | valid category values + doc counts, for populating a dropdown |
| GET | `/api/documents?institution_category=&limit=&offset=` | list documents |
| GET | `/api/documents/:docId` | one document + clause count |
| GET | `/api/documents/:docId/clauses?clause_type=` | clauses within a document |
| GET | `/api/documents/clauses/by-uri/:clauseUri` | a single clause + its rule_atoms + cross_references |
| GET | `/api/query?q=...&top_k=5&institution_category=` | hybrid lexical+vector search (the chatbot backend) |

### Banks — **this is how you input bank data**
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/banks` | register a bank: `{bank_id, bank_name, institution_category}` |
| GET | `/api/banks` | list banks |
| GET | `/api/banks/:bankId/applicable-rules?period_label=` | every quantitative rule that applies to this bank's category, with `already_submitted` flags — **use this to render the manual-entry form** |
| POST | `/api/banks/:bankId/quant-submissions` | submit one or an array of `{rule_id, reported_value, period_label, source_note?}` — response includes `flags[]` from deterministic range + trend-anomaly checks (see `anomalyCheckService.js`); flags never block the write, they're a review signal |
| GET | `/api/banks/:bankId/quant-submissions` | list what's been submitted |
| POST | `/api/banks/:bankId/qual-evidence` | submit one or an array of `{evidence_text, source_type?, period_label?}` (board minutes, policy excerpts, audit notes) |
| GET | `/api/banks/:bankId/qual-evidence` | list submitted evidence |

**Manual entry workflow for the dashboard:**
1. `POST /api/banks` once to register the bank.
2. `GET /api/banks/:bankId/applicable-rules` to get the list of fields to show on a form.
3. User fills in the form → `POST /api/banks/:bankId/quant-submissions` (bulk array).
4. Paste in board minutes / policy text → `POST /api/banks/:bankId/qual-evidence`.
5. Run the check (below).

### Rule field mapping curation — **this is how you actually guarantee correctness**

See the chat discussion: RBI's real reporting formats (XBRL/CIMS, return
codes like `R089`, `DNBS-02`, etc.) are the authoritative source of "which
figure is which," not runtime LLM inference. This workflow curates that
mapping **once per rule, with a human approval gate**, instead of guessing
per submission.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/rule-mappings?approved_only=true` | list curated mappings |
| POST | `/api/rule-mappings/:ruleId/suggest` | Gemini proposes a canonical label + possible CIMS return code/tag — **inert until approved** |
| PUT | `/api/rule-mappings/:ruleId/approve` | human approval: `{canonical_label, cims_return_code?, cims_field_tag?, approved_by}` — only after this does `applicable-rules` serve `mapping_status: "approved"` for that rule |

`GET /api/banks/:bankId/applicable-rules` now returns `form_label` and
`mapping_status` per rule (`"approved"` vs `"unverified"`) — render
unverified fields with a visible warning on the dashboard until curated.

### Compliance checking
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/compliance/:bankId/run` | fixed-hybrid baseline: quant→rule engine, qual→LLM always, no routing decisions made |
| POST | `/api/compliance/:bankId/run-routed` | **adaptive router** — see "The routing algorithm" section above |
| POST | `/api/compliance/:bankId/compare` | runs both on the same data, returns per-clause agreement — the RQ1 experiment endpoint |
| GET | `/api/compliance/:bankId/runs` | run history (for trend charts) |
| GET | `/api/compliance/runs/:runId` | full detail of one past run |

`POST .../run` body:
```json
{
  "period_label": "Q1-FY2026-27",
  "use_llm_mapping_check": false,
  "submitted_field_labels": { "273": "HTM investment %, per treasury MIS" },
  "qual_sample_limit": 40,
  "persist": true
}
```
- `use_llm_mapping_check` is **optional and off by default** — see the design
  note at the top of `complianceController.js` for why quantitative
  arithmetic itself never goes through the LLM, only this secondary
  plausibility flag does.
- Qualitative judgment (Subsystem 2) always calls Gemini for real now —
  the honest stub in the original `compliance_checker.py` is fully wired.

### Keeping the DB updated from live RBI
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/ingest/watch-list` | everything the scraper has seen on RBI's site |
| GET | `/api/ingest/pending-updates` | docs where RBI's label differs from what's ingested |
| POST | `/api/ingest/scan?apply=true\|false` | runs `rbi_scraper.py`; `apply=true` also downloads changed PDFs |

A cron job (`RBI_UPDATE_CRON` in `.env`, default daily 3am) runs the
check-only scan automatically. `apply` is never automatic — re-ingestion
should be a reviewed action (see `rbi_scraper.py` docstring for why: RBI's
`(Updated as on ...)` label is the cheap, reliable diff signal, and this is
confirmed against the live page structure, not guessed).

**Important:** `rbi_scraper.py` needs `rbi.org.in` / `rbidocs.rbi.org.in`
reachable, which is outside this sandbox's network allowlist. It's written
and structurally verified against the real page (fetched during this
session), but run it from your own machine or a server with normal
internet access, not from inside this sandboxed environment.

## What's genuinely NOT untouched, and why

`db_builder.py`'s single `INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?)`
line was changed to name its 9 columns explicitly. This was required, not
optional: `migrations/001_add_operational_tables.sql` adds 3 columns to
`documents` (`source_url`, `last_updated_label`, `superseded_by`), and a
positional `INSERT ... VALUES` with only 9 placeholders against a
12-column table fails outright once those migrations have run. Confirmed
by actually hitting this error during development (see git history / the
chat this was built in) — this is not a hypothetical fix.

## What's deliberately NOT built yet
- **Auth.** Every endpoint above is open. Add a real auth layer (JWT scaffold
  is in `.env.example`) before this touches real bank data.
- **Network Topology Mapper (Subsystem 3).** No graph DB wired in — see the
  chat response for the feasibility discussion on why this needs MCA
  registry data you don't have yet.
- **CIMS/XBRL bridge.** `quant-submissions` is manual entry by design; wiring
  it to a real bank return format is the unsolved mapping problem your
  original `compliance_checker.py` docstring already names honestly.
