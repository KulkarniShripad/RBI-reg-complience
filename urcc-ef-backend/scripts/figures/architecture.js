/**
 * Architecture figures (black and white): the whole system and one detailed
 * diagram per subsystem. Content follows the code as implemented.
 */
const { doc, text, box, store, diamond, pill, arrow, line, INK, MUTED } = require("./svg");

// ── Fig. 1: whole system ──
function systemOverview() {
  const W = 1300;
  const b = [];
  const c = W / 2;
  // sources
  b.push(box(60, 30, 360, 70, "RBI Master Directions & Circulars", ["264 PDF directions, by institution category"]));
  b.push(box(470, 30, 360, 70, "Bank Documents", ["annual reports, Pillar 3 (PDF / XLSX / CSV / JSON)"]));
  b.push(box(880, 30, 360, 70, "Bank Data", ["reported figures, policy evidence, counterparty network"]));
  // processing modules
  b.push(box(60, 150, 560, 96, "Rule Extraction Pipeline", ["layout-aware PDF text · structure parsing · clause classification", "rule atoms · definitions · cross-references · clause-aligned chunks"], { tag: "Fig. 2" }));
  b.push(box(680, 150, 560, 96, "Bank Evidence Processing", ["document parsing · bank / category / period detection", "figure extraction · anomaly checks · network validation"], { tag: "Fig. 4" }));
  b.push(arrow([[240, 100], [240, 146]]));
  b.push(arrow([[650, 100], [650, 120], [960, 120], [960, 146]]));
  b.push(arrow([[1060, 100], [1060, 146]]));
  // knowledge base
  b.push(store(260, 290, 780, 96, "Shared Regulatory Knowledge Base (SQLite)", ["documents · clauses · rule atoms · definitions · cross-references · versions", "keyword index (FTS5) · vector index (BGE, 384-d) · bank and network tables · audit log"]));
  b.push(arrow([[340, 246], [340, 292]]));
  b.push(arrow([[960, 246], [960, 292]]));
  // comprehension + query pair
  b.push(box(60, 436, 470, 96, "Regulatory Comprehension", ["hybrid retrieval · grounded Q&A with citations", "source viewer · plain-language restatement"], { tag: "Fig. 3" }));
  b.push(box(620, 436, 620, 96, "(rule, evidence) pairs", ["applicable rules with category A–G, risk level and version in force", "+ normalised bank evidence and its completeness"]));
  b.push(arrow([[400, 386], [400, 432]]));
  b.push(arrow([[930, 386], [930, 432]]));
  b.push(arrow([[1240, 198], [1270, 198], [1270, 484], [1244, 484]]));
  // router
  b.push(box(160, 580, 980, 110, "Adaptive Reasoning-Modality Router", ["ρ(r, E) → m ∈ {Rule Engine, Graph Evaluator, RAG + LLM, Human Review}", "m* = argmin  α·P(error | m, f)·risk + β·cost(m) + γ·latency(m)   subject to accuracy ≥ τ", "gates: no evidence → INSUFFICIENT_DATA · thin evidence → Human · complete, uncontradicted → Rule Engine"], { strong: true, tag: "Fig. 5" }));
  b.push(arrow([[930, 532], [930, 576]]));
  // routes
  const routes = [
    ["Rule Engine", ["deterministic", "A · C · D · B (flag)"]],
    ["Graph Evaluator", ["connected counterparties", "G · Fig. 6"]],
    ["RAG + LLM", ["retrieval-grounded judgment", "E · F · B"]],
    ["Human Review", ["escalation", "low confidence / conflict"]],
  ];
  const rw = 250;
  const gap = (W - 120 - 4 * rw) / 3;
  routes.forEach(([t, ls], i) => {
    const x = 60 + i * (rw + gap);
    b.push(box(x, 740, rw, 86, t, ls, { dashed: i === 3 }));
    b.push(arrow([[x + rw / 2, 690], [x + rw / 2, 736]]));
    b.push(arrow([[x + rw / 2, 826], [x + rw / 2, 872]]));
  });
  // decision + audit
  b.push(box(60, 876, 1180, 80, "Compliance Decision + Evidence-Grounded Audit Trail", ["every decision cites its RBI paragraph, the evidence used, the modality and the routing reasons · recommended action for breaches"]));
  const dec = ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"];
  dec.forEach((d, i) => {
    const x = 60 + 118 + i * 236;
    b.push(pill(x, 1000, d, { w: 212 }));
  });
  b.push(arrow([[c, 956], [c, 984]]));
  // interfaces
  b.push(box(60, 1044, 1180, 56, "", ["Interfaces:  Auto Check report  ·  Bank Explorer  ·  Regulatory chat and source viewer  ·  REST API"], { lineSize: 12.5 }));
  return doc(W, 1120, b.join("\n"), { title: "URCC-EF system architecture" });
}

// ── Fig. 2: rule extraction pipeline ──
function extractionPipeline() {
  const W = 1300;
  const b = [];
  const stages = [
    ["0", "Acquisition", "rbi_scraper.py", ["change detection on RBI's Master Directions page", "(title suffix “Updated as on …”), download"]],
    ["1", "Layout-aware text", "pdf_text.py (PyMuPDF)", ["per-span font size, bold and superscript flags", "drop page numbers, running headers, footnote markers"]],
    ["2", "Structure parsing", "parser.py", ["preamble · chapters · numbered paragraphs", "sub-clauses · provisos · annexes · footnotes"]],
    ["3", "Classification & rule atoms", "classifier.py", ["clause role (obligation, definition, …) and type", "atoms: variable · operator · threshold · unit · base"]],
    ["4", "Definitions & cross-references", "classifier.py · db_builder.py", ["defined terms per document", "“paragraph 12(3)”, “Annex II” resolved to clauses"]],
    ["5", "Clause-aligned chunking", "chunker.py", ["boundaries only at paragraphs / sub-clauses", "context prefix + repeated lead-in sentence"]],
    ["6", "Indexing", "db_builder.py · build_vectors.js", ["institution categories, applicability", "FTS5 keyword index · BGE-small embeddings"]],
  ];
  const x = 60;
  const w = 720;
  const h = 78;
  const g = 26;
  stages.forEach(([n, t, mod, ls], i) => {
    const y = 30 + i * (h + g);
    b.push(`<circle cx="${x + 26}" cy="${y + h / 2}" r="15" fill="#ffffff" stroke="${INK}" stroke-width="1.4"/>` + text(x + 26, y + h / 2 + 5, n, { size: 13, weight: 700, anchor: "middle" }));
    b.push(box(x + 54, y, w - 54, h, "", [], {}));
    b.push(text(x + 72, y + 26, t, { size: 14, weight: 700 }));
    b.push(text(x + w - 14, y + 26, mod, { size: 11, italic: true, anchor: "end", fill: MUTED }));
    ls.forEach((l, k) => b.push(text(x + 72, y + 48 + k * 17, l, { size: 11.5, fill: "#222222" })));
    if (i < stages.length - 1) b.push(arrow([[x + 54 + (w - 54) / 2, y + h], [x + 54 + (w - 54) / 2, y + h + g - 2]]));
  });
  // outputs (right column)
  const ox = 870;
  const ow = 370;
  b.push(text(ox, 44, "Outputs (knowledge base, SQLite)", { size: 13, weight: 700 }));
  const outputs = [
    [2, "documents · clause_registry", "21,632 clauses, heading paths, pages"],
    [3, "rule_atoms", "4,544 atoms (1,222 requirements)"],
    [4, "definitions · cross_references", "2,433 definitions · 7,516 references"],
    [5, "semantic_chunks", "39,863 clause-aligned chunks"],
    [6, "FTS5 index · vector store", "keyword + 384-d BGE vectors"],
  ];
  outputs.forEach(([si, t, sub]) => {
    const y = 30 + si * (h + g);
    b.push(store(ox, y - 4, ow, h + 8, t, [sub], { lineSize: 11 }));
    b.push(arrow([[x + w, y + h / 2], [ox - 4, y + h / 2]]));
  });
  // post-extraction layer
  const py = 30 + 7 * (h + g) + 6;
  b.push(box(60, py, 560, 110, "Rule typing (on read)", ["ruleTaxonomy.js: category A–G, semantic interpretation,", "risk level (high / medium / low)", "versionedRules.js: version in force on a date", "(CRR phase-down, UCB net-worth glide path)"], { align: "left" }));
  b.push(box(680, py, 560, 110, "Quality control", ["audit_extraction.py: structural audit against the PDFs", "gold set of 62 hand-verified rules:", "85.5% exact recall · 100% operator accuracy", "carry-over of rule ids across rebuilds"], { align: "left" }));
  b.push(arrow([[x + 54 + (w - 54) / 2, 30 + 6 * (h + g) + h], [x + 54 + (w - 54) / 2, py - 14], [340, py - 14], [340, py - 4]]));
  return doc(W, py + 140, b.join("\n"), { title: "Rule extraction pipeline" });
}

// ── Fig. 3: comprehension ──
function comprehension() {
  const W = 1300;
  const b = [];
  b.push(pill(650, 40, "User question (chat)", { w: 260 }));
  b.push(box(390, 84, 520, 84, "Query analysis", ["follow-up rewritten as a stand-alone question", "institution category · abbreviation expansion (corpus glossary) · intent"]));
  b.push(arrow([[650, 54], [650, 80]]));
  b.push(box(190, 222, 400, 84, "Keyword search", ["SQLite FTS5 over clause-aligned chunks", "expanded query terms"]));
  b.push(box(710, 222, 400, 84, "Semantic search", ["BGE-small query embedding", "cosine similarity over chunk vectors"]));
  b.push(arrow([[520, 168], [520, 195], [390, 195], [390, 218]]));
  b.push(arrow([[780, 168], [780, 195], [910, 195], [910, 218]]));
  b.push(box(330, 356, 640, 96, "Fusion and ranking", ["reciprocal-rank fusion of both lists", "boosts: detected category, paragraph role · one result per clause, capped per document", "fallbacks: retry without category filter, then the definitions table"]));
  b.push(arrow([[390, 306], [390, 352]]));
  b.push(arrow([[910, 306], [910, 352]]));
  b.push(store(40, 356, 230, 96, "Knowledge base", ["clauses · chunks", "FTS5 · vectors"]));
  b.push(arrow([[270, 404], [326, 404]], { both: true }));
  b.push(box(330, 502, 640, 96, "Grounded answer", ["LLM writes from the full text of the top clauses, citing [1], [2], …", "retry with wider context if the model reports insufficient sources", "no LLM available → extractive answer from the best sentences (labelled)"]));
  b.push(arrow([[650, 452], [650, 498]]));
  b.push(box(1030, 502, 230, 96, "Gemini", ["optional"], { dashed: true }));
  b.push(arrow([[1030, 550], [974, 550]], { dashed: true }));
  b.push(box(330, 648, 640, 70, "Answer + sources", ["clause text, document, RBI reference, paragraph and page for every citation"]));
  b.push(arrow([[650, 598], [650, 644]]));
  b.push(box(130, 768, 500, 110, "Source viewer", ["full provision with the cited passage highlighted", "original PDF at the page · extracted rule atoms", "cross-references (navigable) · neighbouring paragraphs"], { align: "left" }));
  b.push(box(670, 768, 500, 110, "Plain-language restatement", ["legalese replaced, provisions split into short sentences", "meaning guard: numbers, obligation / prohibition,", "exceptions must survive, else the original is kept"], { align: "left" }));
  b.push(arrow([[520, 718], [520, 740], [380, 740], [380, 764]]));
  b.push(arrow([[630, 823], [666, 823]]));
  return doc(W, 900, b.join("\n"), { title: "Regulatory comprehension subsystem" });
}

// ── Fig. 4: compliance checking ──
function complianceChecking() {
  const W = 1300;
  const b = [];
  // Auto Check column
  b.push(text(60, 36, "A.  Automatic check from a public document (Auto Check)", { size: 14, weight: 700 }));
  const ax = 60;
  const aw = 560;
  const steps = [
    ["Upload", "PDF · XLSX · CSV · HTML · JSON; tables kept as rows"],
    ["Profile detection", "bank, institution category, as-of date, document type"],
    ["Figure extraction", "CRAR, CET1, Tier 1, LCR, NSFR, leverage, NPA, PSL …; LLM only for gaps, verified"],
    ["Review", "user confirms or corrects figures; alternatives listed"],
  ];
  steps.forEach(([t, s], i) => {
    const y = 56 + i * 76;
    b.push(box(ax, y, aw, 56, t, [s], { lineSize: 11 }));
    if (i < steps.length - 1) b.push(arrow([[ax + aw / 2, y + 56], [ax + aw / 2, y + 74]]));
  });
  const cy = 56 + 4 * 76;
  const checks = [
    ["Anchored rules", ["26 verified rules,", "version in force"]],
    ["Rule discovery", ["corpus atoms for", "other figures"]],
    ["Disclosures", ["required notes and", "Pillar 3 tables"]],
    ["Qualitative", ["obligations the", "document covers"]],
  ];
  const cw = (aw - 3 * 12) / 4;
  checks.forEach(([t, ls], i) => {
    const x = ax + i * (cw + 12);
    b.push(box(x, cy + 20, cw, 78, t, ls, { titleSize: 12.5, lineSize: 10.5 }));
    b.push(line(x + cw / 2, cy + 2, x + cw / 2, cy + 16));
    b.push(arrow([[x + cw / 2, cy + 2], [x + cw / 2, cy + 16]]));
    b.push(line(x + cw / 2, cy + 98, x + cw / 2, cy + 116));
  });
  b.push(line(ax + cw / 2, cy + 2, ax + aw - cw / 2, cy + 2));
  b.push(line(ax + aw / 2, cy - 20, ax + aw / 2, cy + 2));
  b.push(line(ax + cw / 2, cy + 116, ax + aw - cw / 2, cy + 116));
  // Bank Explorer column
  const bx = 680;
  const bw = 560;
  b.push(text(bx, 36, "B.  Bank Explorer (stored bank data)", { size: 14, weight: 700 }));
  const inputs = [
    ["Reported figures", ["bank_quant_submissions", "+ anomaly checks"]],
    ["Policy evidence", ["bank_qual_evidence", "statements per bank"]],
    ["Counterparty network", ["entities · edges", "exposures · capital"]],
  ];
  const iw = (bw - 2 * 14) / 3;
  inputs.forEach(([t, ls], i) => {
    const x = bx + i * (iw + 14);
    b.push(store(x, 56, iw, 92, t, ls, { lineSize: 10.5 }));
  });
  b.push(box(bx, 196, bw, 66, "Applicable rules", ["obligations of the bank's category · A–G type · risk · version on the as-of date"], { lineSize: 11 }));
  inputs.forEach((_, i) => b.push(arrow([[bx + i * (iw + 14) + iw / 2, 148], [bx + i * (iw + 14) + iw / 2, 192]])));
  b.push(box(bx, 300, bw, 78, "Adaptive router (Algorithm 1, Fig. 5)", ["features → gates → hard override → cost-aware argmin", "falls back to the heuristic router if not adopted"], { strong: true, lineSize: 11 }));
  b.push(arrow([[bx + bw / 2, 262], [bx + bw / 2, 296]]));
  const mods = [["Rule engine", ["quantitative", "check"]], ["Graph", ["network", "check"]], ["RAG + LLM", ["qualitative", "check"]], ["Human", ["review", "queue"]]];
  const mw = (bw - 3 * 12) / 4;
  mods.forEach(([t, ls], i) => {
    const x = bx + i * (mw + 12);
    b.push(box(x, 416, mw, 78, t, ls, { titleSize: 12.5, lineSize: 10.5, dashed: i === 3 }));
    b.push(arrow([[x + mw / 2, 396], [x + mw / 2, 412]]));
    b.push(line(x + mw / 2, 494, x + mw / 2, 512));
  });
  b.push(line(bx + mw / 2, 396, bx + bw - mw / 2, 396));
  b.push(line(bx + bw / 2, 378, bx + bw / 2, 396));
  b.push(line(bx + mw / 2, 512, bx + bw - mw / 2, 512));
  // shared output
  const oy = 560;
  b.push(box(60, oy, 1180, 96, "Decision layer (decisions.js)", ["engine status → one of five decisions · evidence completeness · citation of the governing paragraph", "recommended action for breaches (gap to threshold, counterparty to reduce) · routing reasons in the audit log"], { strong: false }));
  b.push(arrow([[ax + aw / 2, cy + 116], [ax + aw / 2, oy - 4]]));
  b.push(arrow([[bx + bw / 2, 512], [bx + bw / 2, oy - 4]]));
  const dec = ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"];
  dec.forEach((d, i) => b.push(pill(178 + i * 236, oy + 136, d, { w: 212 })));
  b.push(arrow([[650, oy + 96], [650, oy + 120]]));
  b.push(box(60, oy + 180, 560, 56, "Compliance report", ["decisions, figures, citations; HTML / PDF export"], { lineSize: 11 }));
  b.push(box(680, oy + 180, 560, 56, "Run history", ["stored runs per bank and period; comparison of routers"], { lineSize: 11 }));
  return doc(W, oy + 256, b.join("\n"), { title: "Compliance checking subsystem" });
}

// ── Fig. 5: adaptive router (Algorithm 1) ──
function router() {
  const W = 1300;
  const b = [];
  const cx = 470;
  b.push(pill(cx, 36, "rule r , evidence E", { w: 240 }));
  b.push(box(cx - 260, 72, 520, 118, "Feature vector f (Table V)", ["category A–G · semantic interpretation · risk level", "structured-field availability · evidence completeness", "rule-engine applicability · retrieval confidence (BGE)", "historical accuracy per route · source conflict", "text–structured conflict · uncertainty cue"], { lineSize: 11 }));
  b.push(arrow([[cx, 50], [cx, 68]]));
  // decisions
  const d1 = 262;
  const d2 = 382;
  const d3 = 512;
  b.push(diamond(cx, d1, 280, 76, ["evidence", "completeness = 0 ?"]));
  b.push(diamond(cx, d2, 280, 76, ["completeness", "< MIN_EVIDENCE ?"]));
  b.push(diamond(cx, d3, 320, 96, ["rule-engine applicable", "∧ completeness = 1", "∧ no text conflict ?"]));
  b.push(arrow([[cx, 190], [cx, d1 - 40]]));
  b.push(arrow([[cx, d1 + 38], [cx, d2 - 40]], { label: "no", at: [cx + 8, d1 + 58] }));
  b.push(arrow([[cx, d2 + 38], [cx, d3 - 50]], { label: "no", at: [cx + 8, d2 + 62] }));
  // yes exits
  const ex = 920;
  b.push(pill(ex, d1, "INSUFFICIENT_DATA (declined)", { w: 290 }));
  b.push(pill(ex, d2, "HUMAN REVIEW", { w: 290 }));
  b.push(pill(ex, d3, "DETERMINISTIC (hard override)", { w: 290, strong: true }));
  b.push(arrow([[cx + 140, d1], [ex - 149, d1]], { label: "yes", at: [cx + 150, d1 - 8] }));
  b.push(arrow([[cx + 140, d2], [ex - 149, d2]], { label: "yes", at: [cx + 150, d2 - 8] }));
  b.push(arrow([[cx + 160, d3], [ex - 149, d3]], { label: "yes", at: [cx + 170, d3 - 8] }));
  // cost
  const cyb = 616;
  b.push(box(cx - 330, cyb, 660, 120, "Cost-aware selection", ["for m ∈ {DETERMINISTIC, RAG + LLM, HUMAN}:", "C(m) = α · P̂(error | m, f) · risk(r) + β · USD(m) + γ · latency(m)", "m* = argmin C(m)"], { strong: true, lineSize: 12.5 }));
  b.push(arrow([[cx, d3 + 48], [cx, cyb - 4]], { label: "no", at: [cx + 8, d3 + 72] }));
  // learned model (offline)
  b.push(box(40, 800, 420, 150, "Error model (offline)", ["P̂(error | m, f): logistic regression or decision", "tree per modality, chosen by validation log-loss", "trained on the benchmark's training rules", "human error rate from the cost model"], { dashed: true, lineSize: 11 }));
  b.push(box(480, 800, 420, 150, "Tuning (offline, validation split)", ["grid over β, γ, MIN_EVIDENCE (α = 1)", "cheapest setting with end-to-end", "accuracy ≥ τ = 0.95", "adopted only if it beats the heuristic router"], { dashed: true, lineSize: 11 }));
  b.push(arrow([[250, 800], [250, 740]], { dashed: true }));
  b.push(arrow([[690, 800], [690, 740]], { dashed: true }));
  // modality execution
  const mx = 1110;
  b.push(box(mx - 150, 616, 300, 120, "Execute m*", ["DETERMINISTIC → rule engine,", "or graph evaluator for G", "RAG + LLM · HUMAN"], { lineSize: 11.5 }));
  b.push(arrow([[cx + 330, 676], [mx - 154, 676]]));
  b.push(arrow([[ex + 145, d3], [mx, d3], [mx, 612]]));
  b.push(box(mx - 150, 800, 300, 150, "Output", ["one of five decisions", "cited paragraph", "routing reasons and", "expected costs logged", "(routing_decisions)"], { lineSize: 11.5 }));
  b.push(arrow([[mx, 736], [mx, 796]]));
  return doc(W, 980, b.join("\n"), { title: "Adaptive reasoning-modality router (Algorithm 1)" });
}

// ── Fig. 6: graph subsystem ──
function graphSubsystem() {
  const W = 1300;
  const b = [];
  const ins = [
    ["Entities", ["borrowers, firms, persons,", "the bank and its group"]],
    ["Edges", ["ownership %, control, economic", "dependence, director, relative,", "promoter (rebutted / flagged)"]],
    ["Exposures", ["funded + non-funded,", "per counterparty and period"]],
    ["Capital & profile", ["Tier 1 / eligible capital base,", "NBFC layer, IFC, UCB rating"]],
  ];
  const iw = 272;
  const ig = (W - 120 - 4 * iw) / 3;
  ins.forEach(([t, ls], i) => {
    const x = 60 + i * (iw + ig);
    b.push(store(x, 30, iw, 110, t, ls, { lineSize: 11 }));
    b.push(arrow([[x + iw / 2, 140], [x + iw / 2, 176]]));
  });
  b.push(box(60, 180, 1180, 70, "Graph store (graphStore.js)", ["validation with row-level errors · CSV / JSON import and export · synthetic sample scenarios"]));
  // engine
  b.push(`<rect x="44" y="270" width="1212" height="184" rx="8" fill="none" stroke="${INK}" stroke-width="1" stroke-dasharray="3 4"/>`);
  b.push(text(450, 292, "Graph engine (graphEngine.js)", { size: 12.5, weight: 700, anchor: "middle" }));
  const eng = [
    ["Connected-counterparty groups", ["control: > 50% voting rights (automatic),", "direct or indirect", "economic interdependence: one-way /", "two-way dependence, contagion"]],
    ["Related-party paths", ["director, firm or company the director", "is interested in (Sec. 20, BR Act),", "relative, promoter, ≥ 10% shareholder,", "entities they control"]],
    ["Bank's own group", ["subsidiaries, associates,", "parents / promoters and", "entities they control", "(intra-group exposure)"]],
  ];
  const ew = 380;
  const eg = (1180 - 3 * ew) / 2;
  eng.forEach(([t, ls], i) => {
    const x = 60 + i * (ew + eg);
    b.push(box(x, 308, ew, 130, t, ls, { lineSize: 11 }));
    b.push(arrow([[x + ew / 2, 250], [x + ew / 2, 304]]));
  });
  // rules + evaluator
  b.push(store(60, 494, 360, 120, "Network rules (graphRules.js)", ["53 rules: single / group limits,", "intra-group, related party, reporting", "each resolved to its RBI paragraph"], { lineSize: 11 }));
  b.push(box(470, 494, 770, 120, "Evaluator (graphEvaluator.js)", ["aggregate exposure per counterparty / group vs. limit × capital base", "headroom the rule allows (Board-approved excess, infrastructure)", "PASS · PASS_WITH_CONDITIONS · BREACH · PROHIBITED · REPORTABLE · ASSESSMENT_REQUIRED"], { strong: true, lineSize: 11 }));
  b.push(arrow([[420, 554], [466, 554]]));
  eng.forEach((_, i) => {
    const ex = 60 + i * (ew + eg) + ew / 2;
    b.push(ex > 470 ? arrow([[ex, 438], [ex, 490]]) : arrow([[ex, 438], [ex, 470], [560, 470], [560, 490]]));
  });
  b.push(box(60, 664, 1180, 70, "Graph compliance service (graphComplianceService.js)", ["run per bank and period · flagged links only on request (results then provisional) · frozen result snapshots"]));
  b.push(arrow([[855, 614], [855, 660]]));
  const outs = [
    ["Findings", ["per counterparty / group:", "exposure %, limit %, status"]],
    ["Decisions", ["five labels + recommended", "reduction for each breach"]],
    ["Network view", ["groups and paths for the", "Bank Explorer dashboard"]],
    ["Router route G", ["DETERMINISTIC for multi-", "entity (category G) rules"]],
  ];
  outs.forEach(([t, ls], i) => {
    const x = 60 + i * (iw + ig);
    b.push(box(x, 784, iw, 80, t, ls, { lineSize: 11 }));
    b.push(arrow([[x + iw / 2, 734], [x + iw / 2, 780]]));
  });
  return doc(W, 890, b.join("\n"), { title: "Network (graph) compliance subsystem" });
}

// ── Fig. 7: benchmark and evaluation methodology ──
function methodology() {
  const W = 1300;
  const b = [];
  const src = [
    ["Anchored figure rules", "26 verified"],
    ["Rule atoms", "A · C · D"],
    ["Obligations", "B · E · F"],
    ["Versioned rules", "CRR · UCB NW"],
    ["Network scenarios", "G (hand-authored)"],
  ];
  const sw = 216;
  const sg = (W - 120 - 5 * sw) / 4;
  src.forEach(([t, s], i) => {
    const x = 60 + i * (sw + sg);
    b.push(box(x, 30, sw, 62, t, [s], { titleSize: 13, lineSize: 11 }));
    b.push(arrow([[x + sw / 2, 92], [x + sw / 2, 128]]));
  });
  b.push(box(60, 132, 1180, 84, "Case generator (build_benchmark.js, seed 7)", ["compliant · non-compliant · boundary · near-boundary · missing data · adversarial · contradictory · ambiguous · cross-version", "each case: entity, rule + clause, structured fields, sources, narrative, expected and acceptable decisions, reason"], { lineSize: 11 }));
  b.push(store(430, 256, 440, 84, "Benchmark", ["1,393 cases · 215 rules"]));
  b.push(arrow([[650, 216], [650, 258]]));
  b.push(text(664, 356, "split by rule (hash of the rule key): no test rule is seen in training or tuning", { size: 11.5, italic: true, fill: MUTED }));
  const sp = [
    ["Train · 840 cases", ["error models P̂(error | m, f)", "historical accuracy (leave-one-out)"]],
    ["Validation · 259 cases", ["estimator choice (log-loss)", "α, β, γ, MIN_EVIDENCE; R2 θ", "error analysis → new features"]],
    ["Test · 294 cases", ["all systems, once", "B1–B4 · R0–R2 · R4 · Oracle"]],
  ];
  const pw = 360;
  const pg = (1180 - 3 * pw) / 2;
  sp.forEach(([t, ls], i) => {
    const x = 60 + i * (pw + pg);
    b.push(box(x, 392, pw, 100, t, ls, { lineSize: 11, strong: i === 2 }));
    b.push(arrow([[650, 340], [650, 366], [x + pw / 2, 366], [x + pw / 2, 388]]));
  });
  b.push(arrow([[60 + pw, 442], [60 + pw + pg - 4, 442]]));
  b.push(arrow([[60 + 2 * pw + pg, 442], [60 + 2 * pw + 2 * pg - 4, 442]]));
  b.push(box(60, 540, 1180, 84, "Measures", ["accuracy (acceptable set) · end-to-end accuracy · macro-F1 · FPR / FNR · escalation · LLM calls · citation accuracy", "hallucination rate · USD and latency per case · cluster-bootstrap CI and McNemar test · ablations · Pareto frontier"], { lineSize: 11 }));
  b.push(arrow([[60 + 2 * (pw + pg) + pw / 2, 492], [60 + 2 * (pw + pg) + pw / 2, 536]]));
  b.push(box(60, 664, 570, 70, "Separate real-data evaluations", ["11 public bank disclosures · 62-rule extraction gold set"], { dashed: true, lineSize: 11 }));
  b.push(box(670, 664, 570, 70, "Comprehension evaluations", ["115 retrieval questions vs. fixed windows · 272-clause simplification"], { dashed: true, lineSize: 11 }));
  return doc(W, 760, b.join("\n"), { title: "Benchmark construction and evaluation protocol" });
}

module.exports = { systemOverview, extractionPipeline, comprehension, complianceChecking, router, graphSubsystem, methodology };
