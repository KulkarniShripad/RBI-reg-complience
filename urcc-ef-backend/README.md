# URCC-EF Backend

Extraction pipeline (Python) + API (Node) for the RBI regulatory comprehension
and compliance system:

- **Extraction**: the RBI Master Direction PDFs in `../circulars` are parsed into
  paragraphs, annexes and footnotes, classified, and their numeric thresholds
  extracted into rule atoms (`scripts/`).
- **Search & chat**: hybrid retrieval (BM25 full-text + BGE semantic embeddings)
  over every paragraph, and a grounded chat that cites the exact paragraphs it
  used (`src/services/retrievalService.js`, `answerService.js`).
- **Compliance**: deterministic checks of a bank's figures against extracted
  thresholds, and LLM-judged checks of its governance evidence against
  qualitative obligations — see [`../docs/COMPLIANCE_FLOW.md`](../docs/COMPLIANCE_FLOW.md).
- **Counterparty network** (graph subsystem): groups of connected
  counterparties, related-party lending and intra-group exposure, checked
  against RBI's concentration-risk and Section 20 rules — see
  [`../docs/NETWORK_GRAPH.md`](../docs/NETWORK_GRAPH.md).

## Setup

Requirements: Node ≥ 18, Python ≥ 3.10.

```bash
cd urcc-ef-backend
npm install
pip install -r scripts/requirements.txt        # PyMuPDF, requests, beautifulsoup4
cp .env.example .env                            # add GEMINI_API_KEY (optional, see below)

npm run build:corpus    # ~1 min: parse all PDFs in ../circulars -> data/urcc_ef.db
npm run build:vectors   # embed every chunk -> data/urcc_ef_vectors.db
                        #   ~15-25 min on a 4-core CPU the first time; later runs only embed new chunks.
                        #   Downloads the embedding model (~130 MB) to ./models on first use.
npm start               # http://localhost:4002
```

- `build:corpus` builds into a temporary file and swaps it in only when it
  succeeds. If `data/urcc_ef.db` already exists, banks, submissions, evidence,
  run history and approved rule mappings are **carried over**, and submissions
  are re-pointed to the new rule ids where the same rule is found again.
- If you start the server before `build:vectors` has finished (or after
  uploads), chunks without an embedding are embedded in the background; until
  then those chunks are still found by keyword search.
- Without `GEMINI_API_KEY` everything still runs: chat answers are assembled
  from the most relevant sentences of the retrieved paragraphs (and say so),
  and qualitative compliance items come back as `NEEDS_REVIEW`.
- The server refuses to start on a database from the previous pipeline and
  tells you to run `npm run build:corpus`.

Other commands:

| Command | What it does |
|---|---|
| `npm run audit` | verifies the built DB against the PDFs (coverage, cut-off clauses, numbering gaps, boundary fidelity) |
| `npm run eval:retrieval` | retrieval quality on `eval/retrieval_eval.json` (Hit@k, MRR) |
| `npm run eval:graph` | network check on the synthetic scenarios in `eval/graph_scenarios.json` (expected vs actual) |
| `npm test` | Python pipeline tests + API tests on throw-away databases (uploads, categories, topics, chat fallback, network check, ...) |
| `npm run build:vectors:rebuild` | re-embed everything from scratch |
| `bash scripts/demo/seed_and_test.sh` | end-to-end compliance demo against a running server |

## Pipeline

```
PDF ─► pdf_text.py ─► parser.py ─► classifier.py ─► chunker.py ─► db_builder.py ─► urcc_ef.db
       layout lines    structure    roles, types,    legal-boundary   documents, clauses,
       (fonts, x/y)    (chapters,   rule atoms,      chunks with      rule atoms, definitions,
       footnotes out   sections,    definitions,     context prefix   cross-refs, annexes,
       page nos out    paragraphs,  cross-refs                        footnotes, chunks, FTS5
                       annexes)
                                                        build_vectors.js ─► urcc_ef_vectors.db (BGE, 384-d)
```

- **`pdf_text.py`** reads each page with PyMuPDF, keeping font size, bold and
  position per span. It merges spans on the same baseline ("4." + "(1) In these
  Directions ..."), drops footnote reference markers (superscript digits),
  moves footnote text into its own table, and removes page numbers and running
  headers.
- **`parser.py`** segments the body: chapter / "Section I" / "Part" headings,
  lettered sections (`A.`, `B.2`, `C.3.1`), numbered paragraphs (flat `12.`,
  undotted `12 ` with hanging indent, decimal `3.1.2`, inserted `9A.`),
  annexes, and the preamble. Paragraph numbers must continue the sequence and
  sit at the left margin in body-size type — that is what keeps numbered
  table rows and wrapped references ("... Paragraph\n53)") from becoming
  clauses. Numbering that restarts under a new heading opens a new scope
  (`II.3`). No text is ever discarded: anything that is not a paragraph lands
  in the preamble, an unnumbered block (`12.u1`) or an annex.
- **`classifier.py`** assigns a role to every clause (`obligation`,
  `definition`, `applicability`, `short_title`, `repeal`, `deleted`,
  `information`, `annex`, `preamble`) and extracts rule atoms sentence by
  sentence. Each atom is a `requirement` (governed by shall / should / must)
  or a `condition` (a threshold that only defines scope, e.g. "loans up to
  ₹20 lakh").
- **`categories.py`** is the single source of truth for institution categories
  (the regulated-entity types on RBI's Master Directions page) and their
  aliases, and derives each document's topic and subject family from its title.
  A document can apply to several categories (`document_categories`).
- **`chunker.py`** makes one chunk per paragraph, or per sub-clause /
  definition when a paragraph is long, each repeating the paragraph's lead-in
  sentence and prefixed with document, entity type and heading path.
- **`db_builder.py`**: `build` (whole corpus, parallel, content-hash
  de-duplication, atomic swap, carry-over) and `ingest` (one uploaded PDF).

`doc_id` is the first 16 hex characters of the PDF's SHA-256, so the same file
always gets the same id on any machine and is never ingested twice.
`clause_uri` = `rbi://<category-slug>/<doc_id>/para<N>` (also `/annexI`,
`/preamble`).

## Measured quality

All numbers below were measured on the 266 PDFs in `../circulars`
(264 distinct files) with `scripts/audit_extraction.py` and
`scripts/eval_retrieval.js`, comparing the previous database with the rebuilt
one.

### Extraction

| | Previous pipeline | Current pipeline |
|---|---|---|
| Documents with zero clauses | 16 | **0** |
| Mean share of PDF words stored | 70.5 % | **99.7 %** |
| Documents below 50 % coverage | 65 | **0** |
| Clauses ending mid-sentence ¹ | 27.5 % | **7.1 %** |
| Clauses with a page number glued on | 1,838 | **0** |
| Duplicate documents | 3 groups | **0** |
| Documents filed as `uncategorized` | 17 | **0** |
| Boundary check, 400 random paragraphs: recall / precision ² | 0.939 / 0.995 | **0.996 / 1.000** |

¹ The remaining 7 % mostly end in a table cell, a signature block or a list
item ending "; and" — not truncations. ² Words between "N." and the next
paragraph number in the raw PDF text vs. the stored clause (for the old DB this
is measured only on paragraphs it kept at all).

Rule atoms: 1,112 requirements + 3,116 conditions (previously 387 atoms with no
requirement/condition distinction). Manual check of 30 random high-confidence
requirements: operator, value and unit correct 30/30; requirement-vs-condition
label correct 29/30. Small sample — expect errors, especially in
`variable_text`.

### Retrieval

36 hand-written questions (`eval/retrieval_eval.json`), each with a regex for the
correct clause. "Previous system" is the original `searchHybrid` (raw-question
FTS5 + TF-IDF/SVD vectors) run on the previous database.

| | Hit@1 | Hit@3 | Hit@5 | MRR@10 |
|---|---|---|---|---|
| Previous system | 0.167 | 0.194 | 0.250 | 0.196 |
| New: keyword only (BM25) | 0.611 | 0.806 | 0.833 | 0.721 |
| New: semantic only (BGE) | 0.611 | 0.667 | 0.806 | 0.675 |
| **New: hybrid (used by chat)** | **0.722** | **0.778** | **0.833** | **0.768** |

In the previous system 28 of the 36 questions made the full-text query fail
(FTS5 syntax errors from punctuation such as `?`, silently swallowed), so it
ran on TF-IDF vectors alone — and it sent Gemini only 400-character snippets.
That is why simple questions came back "not enough context".
Still missed in the top 5: the HTM ceiling phrased as "held to maturity
category", NBFC minimum NOF, primary-dealer eligibility, a specific definition
and a table-based threshold.

## API

### Chat, topics, rules, upload (used by the dashboard)
| Method | Path | Purpose |
|---|---|---|
| POST / GET | `/ask` | `{query, history?, category?}` → answer with `[n]` citations, `sources[]` (full clause text, document, RBI ref, paragraph, page, extracted rules), confidence, answer mode |
| GET | `/topics` | topics computed from the DB: `topics` (by institution type) and `families` (by subject), each with its documents |
| GET | `/categories` | canonical institution categories with document counts |
| GET | `/rules?topic=&kind=requirement\|condition\|all&search=&page=` | extracted rule atoms |
| POST | `/upload` | multipart `file`, `category` (id, alias or `auto`), `title?`, `replace?` → 201 added / 409 `duplicate` / 409 `possible_update` / 400 `not_pdf` / 400 `unknown_category` / 422 `no_text` |
| POST | `/upload/check` | `{sha256}` → is this exact file already ingested? |

### Documents
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/documents?category=&family=&search=` | list documents |
| GET | `/api/documents/:docId` | one document with counts, categories, annexes |
| GET | `/api/documents/:docId/clauses` | its clauses in reading order |
| GET | `/api/documents/:docId/pdf` | the original PDF (append `#page=N` in a browser) |
| GET | `/api/documents/clauses/by-uri/:clauseUri` | one clause + document, rule atoms, resolved cross-references, footnotes, previous/next |
| GET | `/api/documents/stats` | corpus counts |
| GET | `/api/query?q=&category=` | raw hybrid retrieval with scores and match reasons (debugging) |
| GET | `/api/health` | corpus version, vector index status, LLM configuration |

### Counterparty network (`/api/graph`)
Entities, relationships, exposures, capital, import / export, the network
check and sample networks — full table in
[`../docs/NETWORK_GRAPH.md`](../docs/NETWORK_GRAPH.md#7-api-apigraph).

### Banks, compliance, rule mappings, RBI updates
Unchanged in shape; see [`../docs/COMPLIANCE_FLOW.md`](../docs/COMPLIANCE_FLOW.md) for the full flow.

| Method | Path |
|---|---|
| POST/GET | `/api/banks`, GET `/api/banks/:bankId` |
| GET | `/api/banks/:bankId/applicable-rules?period_label=` |
| POST/GET | `/api/banks/:bankId/quant-submissions`, `/api/banks/:bankId/qual-evidence` |
| POST | `/api/compliance/:bankId/run`, `/run-routed`, `/compare` |
| GET | `/api/compliance/:bankId/runs`, `/api/compliance/runs/:runId` |
| GET/POST/PUT | `/api/rule-mappings`, `/:ruleId/suggest`, `/:ruleId/approve` |
| GET/POST | `/api/ingest/watch-list`, `/pending-updates`, `/scan?apply=` (needs rbi.org.in reachable) |

### Automatic check from bank documents
Upload an annual report, Pillar 3 disclosure, results, or an xlsx / csv / json of
figures; the bank, category, period, figures and applicable rules are detected
and a report is produced. Full description: [`../docs/AUTO_CHECK.md`](../docs/AUTO_CHECK.md).

| Method | Path |
|---|---|
| POST | `/api/disclosures/analyze` (multipart `file`), `/api/disclosures/samples/analyze` `{file}` |
| GET/PATCH | `/api/disclosures/:id` (review / correct profile and figures) |
| POST | `/api/disclosures/:id/run` → `{run_id, report}` |
| GET | `/api/disclosures/samples`, `/api/disclosures/:id/file`, `/api/disclosures/runs/:runId/report.html` |

`npm run eval:disclosures` runs every document in `../sample-data/` against its
expected results (142/142, no LLM needed).

## Known limitations

- Scanned (image-only) PDFs are rejected; there is no OCR step.
- Rule atoms come from deterministic patterns. `variable_text` is the weakest
  field; recall of all numeric requirements in the corpus has not been measured.
- Applicability below the category level (e.g. NBFC-UL only, deposit-taking
  NBFCs only) is not modelled.
- Tables are kept as text rows (`cell | cell`), not as structured tables.
- The retrieval evaluation set is small (36 questions) and was written by the
  developer; treat the numbers as indicative, and extend `eval/` with your own
  questions.
- SQLite stands in for PostgreSQL; the vector index is exact search in memory
  (fine at ~40k chunks; use pgvector/an ANN index at much larger scale).
- No authentication.
- The network check is evaluated on synthetic networks only; ownership,
  directorship and dependence data have to come from the bank (no registry
  feed). See [`../docs/NETWORK_GRAPH.md`](../docs/NETWORK_GRAPH.md#9-limits).
