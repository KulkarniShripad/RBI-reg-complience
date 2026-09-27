#!/usr/bin/env node
/**
 * Retrieval evaluation: runs every question in eval/retrieval_eval.json
 * through lexical-only, semantic-only and the full hybrid retriever and
 * reports Hit@1 / Hit@3 / Hit@5 and MRR@10 (clause level).
 *
 *   node scripts/eval_retrieval.js [--verbose]
 *
 * A result is relevant when its clause text matches the question's
 * `relevant` regex and - if the question names an entity type - its
 * document applies to that entity type.
 */
const path = require("path");
const db = require("../src/config/db");
const vectorStore = require("../src/services/vectorStore");
const embedding = require("../src/services/embeddingService");
const retrieval = require("../src/services/retrievalService");
const qa = require("../src/services/queryAnalyzer");

const evalSet = require(path.join(__dirname, "..", "eval", "retrieval_eval.json"));
const verbose = process.argv.includes("--verbose");

const clauseOfChunk = db.prepare(
  `SELECT sc.parent_clause_uri AS clause_uri, sc.doc_id, cr.clause_text FROM semantic_chunks sc
   JOIN clause_registry cr ON cr.clause_uri = sc.parent_clause_uri WHERE sc.chunk_id = ?`
);
const catsOf = db.prepare("SELECT category FROM document_categories WHERE doc_id = ?");

function isRelevant(q, clause) {
  if (!new RegExp(q.relevant, "is").test(clause.clause_text || "")) return false;
  if (q.category && !catsOf.all(clause.doc_id).some((r) => r.category === q.category)) return false;
  return true;
}

function dedupeClauses(chunkIds, limit = 10) {
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

function score(ranked, q) {
  const idx = ranked.findIndex((c) => isRelevant(q, c));
  return {
    hit1: idx === 0 ? 1 : 0,
    hit3: idx >= 0 && idx < 3 ? 1 : 0,
    hit5: idx >= 0 && idx < 5 ? 1 : 0,
    rr: idx >= 0 && idx < 10 ? 1 / (idx + 1) : 0,
    rank: idx >= 0 ? idx + 1 : null,
  };
}

async function main() {
  vectorStore.load();
  const modes = { lexical: [], semantic: [], hybrid: [] };
  const rows = [];
  for (const q of evalSet.questions) {
    const analysis = qa.analyze(q.q);
    const lex = dedupeClauses(retrieval.lexicalSearch(analysis, 60).map((r) => r.chunk_id));
    const qv = await embedding.embedQuery(analysis.expanded_query);
    const sem = dedupeClauses(vectorStore.search(qv, 60).map((r) => r.chunk_id));
    const hyb = (await retrieval.search(q.q, { topK: 10, analysis })).results;
    const s = { lexical: score(lex, q), semantic: score(sem, q), hybrid: score(hyb, q) };
    for (const m of Object.keys(modes)) modes[m].push(s[m]);
    rows.push({ id: q.id, lexical: s.lexical.rank, semantic: s.semantic.rank, hybrid: s.hybrid.rank });
    if (verbose && s.hybrid.rank !== 1) {
      console.log(`\n[${q.id}] ${q.q}  -> hybrid rank ${s.hybrid.rank}`);
      hyb.slice(0, 3).forEach((r, i) => console.log(`   ${i + 1}. ${r.rbi_ref} p${r.paragraph}: ${r.clause_text.slice(0, 110).replace(/\n/g, " ")}`));
    }
  }
  const agg = (arr) => ({
    "Hit@1": +(arr.reduce((a, b) => a + b.hit1, 0) / arr.length).toFixed(3),
    "Hit@3": +(arr.reduce((a, b) => a + b.hit3, 0) / arr.length).toFixed(3),
    "Hit@5": +(arr.reduce((a, b) => a + b.hit5, 0) / arr.length).toFixed(3),
    "MRR@10": +(arr.reduce((a, b) => a + b.rr, 0) / arr.length).toFixed(3),
  });
  console.log(`\nQuestions: ${evalSet.questions.length}`);
  console.table(Object.fromEntries(Object.entries(modes).map(([m, arr]) => [m, agg(arr)])));
  if (verbose) console.table(rows);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
