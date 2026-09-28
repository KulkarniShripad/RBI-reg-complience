# URCC-EF — RBI Regulatory Comprehension & Compliance

| Folder | What it is |
|---|---|
| `circulars/` | the source corpus: RBI Master Directions (PDF), one folder per institution type |
| `urcc-ef-backend/` | extraction pipeline (Python) + API (Node): search, grounded chat, uploads, compliance checks — see its [README](urcc-ef-backend/README.md) |
| `rbi-clarity-frontend-compliance/` | the dashboard (React/Vite): chat, upload, topics, rules, compliance checker, exposure network |
| `docs/COMPLIANCE_FLOW.md` | how the compliance checker works end to end |
| `docs/AUTO_CHECK.md` | **automatic compliance check**: upload a bank's annual report / Pillar 3 disclosure / figures file, get a compliance report |
| `sample-data/` | test documents: real published bank figures (with sources) and fictional test cases with known results — see its [README](sample-data/README.md) |
| `docs/NETWORK_GRAPH.md` | the counterparty network (graph) subsystem: data model, algorithms, rules, API |

## Run it

```bash
# backend (first time: builds the database and the embeddings)
cd urcc-ef-backend
npm install && pip install -r scripts/requirements.txt
cp .env.example .env            # add GEMINI_API_KEY for AI-written answers (optional)
npm run setup                   # build:corpus (~1 min) + build:vectors (~15-25 min, first time only)
npm start                       # http://localhost:4002

# frontend
cd ../rbi-clarity-frontend-compliance
npm install
npm run dev                     # http://localhost:8080 (set VITE_API_BASE_URL if the API is not on :4002)
```

Then open **Compliance Check** in the dashboard and upload a bank's Pillar 3
disclosure, annual report or a spreadsheet of figures (test documents are in
`sample-data/`).

Rebuilding the database keeps your banks, submitted figures, evidence,
counterparty networks and run history. Check extraction quality any time with `npm run audit`, retrieval
quality with `npm run eval:retrieval`, the document check with
`npm run eval:disclosures` and the network check with `npm run eval:graph`
(all in `urcc-ef-backend/`).
