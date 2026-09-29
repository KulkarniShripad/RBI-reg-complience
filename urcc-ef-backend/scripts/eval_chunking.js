#!/usr/bin/env node
/**
 * Structure-aware vs generic chunking (journal RQ2, baseline C3), measured.
 *
 * The system retrieves over clause-aligned chunks (a paragraph with its
 * provisos, split only at clause boundaries). The C3 baseline is the usual
 * generic pipeline: each document's text cut into fixed-length windows
 * (800 characters, 200 overlap) with no regard for paragraph boundaries,
 * searched with BM25, with the same embedding model, and with both fused (RRF).
 *
 * Questions:
 *   hand-written   eval/retrieval_eval.json (36 questions, relevance regex)
 *   generated      one templated question per hand-verified gold rule
 *                  (src/services/disclosure/regulatoryRules.js and
 *                  graph/graphRules.js); the numbers are removed from the
 *                  question, and a passage is relevant when it states the rule
 *                  (the rule's verified source regex) in a document applying
 *                  to the rule's category.
 *
 * Metrics: Hit@1, Hit@3, Hit@5 (Top-5 recall), MRR@10. A window counts as
 * relevant only if the whole provision falls inside it, so provisions split
 * across windows are the cost C3 pays.
 *
 *   node scripts/eval_chunking.js     → eval/results/chunking_eval.{json,md}
 *   (window embeddings are cached in eval/.cache/, git-ignored)
 */
const fs = require("fs");
const path = require("path");
const db = require("../src/config/db");
const vectorStore = require("../src/services/vectorStore");
const embedding = require("../src/services/embeddingService");
const retrieval = require("../src/services/retrievalService");
const qa = require("../src/services/queryAnalyzer");
const regulatoryRules = require("../src/services/disclosure/regulatoryRules");
const graphRules = require("../src/services/graph/graphRules");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "eval", "results");
const CACHE = path.join(ROOT, "eval", ".cache");
const WINDOW = 800;
const OVERLAP = 200;

const CATEGORY_NAME = {
  commercial_banks: "a commercial bank",
  small_finance_banks: "a small finance bank",
  payments_banks: "a payments bank",
  regional_rural_banks: "a regional rural bank",
  urban_cooperative_banks: "an urban co-operative bank",
  rural_cooperative_banks: "a rural co-operative bank",
  local_area_banks: "a local area bank",
  nbfc: "an NBFC",
  nbfcs: "an NBFC",
  all_india_financial_institutions: "an all-India financial institution",
};

const norm = (s) => String(s || "").replace(/\s+/g, " ");
const catsOf = db.prepare("SELECT category FROM document_categories WHERE doc_id = ?");
const inCategory = (docId, cat) => !cat || catsOf.all(docId).some((r) => r.category === cat || (cat.startsWith("nbfc") && r.category.startsWith("nbfc")));

// ── questions ──

function generatedQuestions() {
  const out = [];
  const strip = (label) =>
    label
      .replace(/\([^)]*\d[^)]*\)/g, "")
      .replace(/\b(?:of|at|to|up to|within)?\s*₹?\s*\d+(?:\.\d+)?\s*(?:%|per ?cent|crore|lakh)?/gi, "")
      .replace(/[:;,]\s*$/, "")
      .replace(/\s+/g, " ")
      .trim();
  for (const r of regulatoryRules.RULES) {
    const src = regulatoryRules.resolveSource(r);
    if (!src.verified || !r.source?.text) continue;
    out.push({
      id: `gold:${r.key}`,
      q: `What ${r.level === "buffer" ? "buffer" : r.op === "<=" ? "maximum" : "minimum"} does RBI require for ${strip(r.label).toLowerCase()} in ${CATEGORY_NAME[r.category] || r.category.replace(/_/g, " ")}?`,
      relevant: r.source.text,
      category: r.category,
      gold_clause: src.clause_uri,
    });
  }
  for (const r of graphRules.RULES) {
    const src = graphRules.resolveSource(r);
    if (!src?.verified || !r.source?.text) continue;
    out.push({
      id: `gold:${r.key}`,
      q: `What is the exposure limit for ${strip(r.label.split(":")[0]).toLowerCase()} for ${CATEGORY_NAME[r.category] || r.category.replace(/_/g, " ")}?`,
      relevant: r.source.text,
      category: r.category,
      gold_clause: src.clause_uri,
    });
  }
  return out;
}

function handQuestions() {
  return require(path.join(ROOT, "eval", "retrieval_eval.json")).questions.map((q) => ({ ...q, relevant: new RegExp(q.relevant, "is") }));
}

// ── C3: fixed-length windows ──

function buildWindows() {
  const docs = db.prepare("SELECT doc_id FROM documents ORDER BY doc_id").all();
  const textOf = db.prepare("SELECT clause_text FROM clause_registry WHERE doc_id = ? ORDER BY seq");
  const windows = [];
  for (const { doc_id } of docs) {
    const text = norm(textOf.all(doc_id).map((r) => r.clause_text).join(" "));
    for (let start = 0; start < text.length; start += WINDOW - OVERLAP) {
      windows.push({ doc_id, text: text.slice(start, start + WINDOW) });
      if (start + WINDOW >= text.length) break;
    }
  }
  return windows;
}

const TOKEN = /[a-z0-9]+(?:\.[0-9]+)?/g;
const STOP = new Set("the a an of to in and or for is are be shall by on with as at from that this which any its it such has have what does do how rbi".split(" "));
const tokens = (s) => (String(s).toLowerCase().match(TOKEN) || []).filter((t) => !STOP.has(t));

function bm25Index(windows) {
  const df = new Map();
  const docs = windows.map((w) => {
    const tf = new Map();
    for (const t of tokens(w.text)) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: [...tf.values()].reduce((a, b) => a + b, 0) };
  });
  const avg = docs.reduce((a, d) => a + d.len, 0) / docs.length;
  const N = docs.length;
  const post = new Map();
  docs.forEach((d, i) => {
    for (const [t, f] of d.tf) {
      if (!post.has(t)) post.set(t, []);
      post.get(t).push([i, f]);
    }
  });
  return {
    search(q, k = 60) {
      const score = new Map();
      for (const t of new Set(tokens(q))) {
        const p = post.get(t);
        if (!p) continue;
        const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
        for (const [i, f] of p) score.set(i, (score.get(i) || 0) + (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (docs[i].len / avg))));
      }
      return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([i]) => i);
    },
  };
}

async function windowVectors(windows) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, `c3_windows_${WINDOW}_${OVERLAP}_${windows.length}.f32`);
  const D = embedding.DIM;
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    const all = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (all.length === windows.length * D) return (i) => all.subarray(i * D, (i + 1) * D);
  }
  const all = new Float32Array(windows.length * D);
  const B = 64;
  for (let i = 0; i < windows.length; i += B) {
    const vs = await embedding.embedPassages(windows.slice(i, i + B).map((w) => w.text));
    vs.forEach((v, k) => all.set(v, (i + k) * D));
    if ((i / B) % 20 === 0) process.stderr.write(`  embedded ${i}/${windows.length}\n`);
  }
  fs.writeFileSync(file, Buffer.from(all.buffer));
  return (i) => all.subarray(i * D, (i + 1) * D);
}

// ── scoring ──

function scoreRanked(passages, q) {
  const idx = passages.findIndex((p) => q.relevant.test(norm(p.text)) && inCategory(p.doc_id, q.category));
  return { hit1: idx === 0 ? 1 : 0, hit3: idx >= 0 && idx < 3 ? 1 : 0, hit5: idx >= 0 && idx < 5 ? 1 : 0, rr: idx >= 0 && idx < 10 ? 1 / (idx + 1) : 0 };
}
const agg = (arr) => ({
  n: arr.length,
  hit1: +(arr.reduce((a, b) => a + b.hit1, 0) / arr.length).toFixed(3),
  hit3: +(arr.reduce((a, b) => a + b.hit3, 0) / arr.length).toFixed(3),
  hit5: +(arr.reduce((a, b) => a + b.hit5, 0) / arr.length).toFixed(3),
  mrr10: +(arr.reduce((a, b) => a + b.rr, 0) / arr.length).toFixed(3),
});
const rrf = (lists, k = 60) => {
  const s = new Map();
  for (const l of lists) l.forEach((id, r) => s.set(id, (s.get(id) || 0) + 1 / (k + r + 1)));
  return [...s.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
};

const clauseOfChunk = db.prepare(
  `SELECT sc.parent_clause_uri AS clause_uri, sc.doc_id, cr.clause_text AS text FROM semantic_chunks sc
   JOIN clause_registry cr ON cr.clause_uri = sc.parent_clause_uri WHERE sc.chunk_id = ?`
);
function clausesOf(chunkIds, limit = 10) {
  const out = [];
  const seen = new Set();
  for (const id of chunkIds) {
    const c = clauseOfChunk.get(id);
    if (!c || seen.has(c.clause_uri)) continue;
    seen.add(c.clause_uri);
    out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

async function main() {
  vectorStore.load();
  const sets = { "hand-written": handQuestions(), "generated from gold rules": generatedQuestions() };
  const windows = buildWindows();
  console.error(`[eval:chunking] ${windows.length} fixed windows (${WINDOW}/${OVERLAP}); questions: ${Object.entries(sets).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
  const bm25 = bm25Index(windows);
  const wv = await windowVectors(windows);
  const semWindows = (qv, k = 60) => {
    const top = [];
    for (let i = 0; i < windows.length; i++) {
      const s = embedding.dot(qv, wv(i));
      if (top.length < k || s > top[top.length - 1][1]) {
        top.push([i, s]);
        top.sort((a, b) => b[1] - a[1]);
        if (top.length > k) top.pop();
      }
    }
    return top.map(([i]) => i);
  };

  const SYSTEMS = [
    "Structure-aware: keyword (C1)",
    "Structure-aware: semantic",
    "Structure-aware: hybrid (proposed)",
    "Fixed windows: BM25 (C3)",
    "Fixed windows: semantic (C3)",
    "Fixed windows: hybrid RRF (C3)",
  ];
  const report = { window_chars: WINDOW, overlap_chars: OVERLAP, windows: windows.length, sets: {} };
  for (const [name, qs] of Object.entries(sets)) {
    const acc = Object.fromEntries(SYSTEMS.map((s) => [s, []]));
    for (const q of qs) {
      const analysis = qa.analyze(q.q);
      const qv = await embedding.embedQuery(analysis.expanded_query);
      const lex = clausesOf(retrieval.lexicalSearch(analysis, 60).map((r) => r.chunk_id));
      const sem = clausesOf(vectorStore.search(qv, 60).map((r) => r.chunk_id));
      const hyb = (await retrieval.search(q.q, { topK: 10, analysis })).results.map((r) => ({ ...r, text: r.clause_text }));
      const wl = bm25.search(analysis.expanded_query || q.q);
      const ws = semWindows(qv);
      const wh = rrf([wl, ws]);
      const asPassages = (ids) => ids.slice(0, 10).map((i) => windows[i]);
      const scored = [lex, sem, hyb, asPassages(wl), asPassages(ws), asPassages(wh)].map((p) => scoreRanked(p, q));
      SYSTEMS.forEach((s, k) => acc[s].push(scored[k]));
    }
    report.sets[name] = Object.fromEntries(SYSTEMS.map((s) => [s, agg(acc[s])]));
  }

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "chunking_eval.json"), JSON.stringify(report, null, 1));
  const L = [
    "# Structure-aware vs generic chunking (RQ2)",
    "",
    `C3 = fixed ${WINDOW}-character windows with ${OVERLAP}-character overlap over each document (${windows.length} windows), same embedding model (BGE-small). A passage is relevant only if it contains the whole provision.`,
    "",
  ];
  for (const [name, res] of Object.entries(report.sets)) {
    L.push(`## Questions: ${name} (n = ${Object.values(res)[0].n})`, "", "| Retrieval | Hit@1 | Hit@3 | Top-5 recall | MRR@10 |", "|---|---|---|---|---|");
    for (const [s, m] of Object.entries(res)) L.push(`| ${s} | ${(m.hit1 * 100).toFixed(1)}% | ${(m.hit3 * 100).toFixed(1)}% | ${(m.hit5 * 100).toFixed(1)}% | ${m.mrr10.toFixed(3)} |`);
    L.push("");
  }
  fs.writeFileSync(path.join(OUT, "chunking_eval.md"), L.join("\n"));
  console.log(L.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
