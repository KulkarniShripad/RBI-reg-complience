const db = require("../config/db");
const vectorSearch = require("../services/vectorSearchService");

function reciprocalRankFusion(lexicalRanked, vectorRanked, k = 60) {
  const scores = new Map();
  lexicalRanked.forEach((uri, i) => scores.set(uri, (scores.get(uri) || 0) + 1 / (k + i + 1)));
  vectorRanked.forEach((r, i) => scores.set(r.clause_uri, (scores.get(r.clause_uri) || 0) + 1 / (k + i + 1)));
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * Hybrid retrieval: lexical (SQLite FTS5) + vector (Python bridge) fused
 * via RRF, then joined against rule_atoms for an exact figure when one
 * exists. Direct port of query_demo.py's flow for the API surface.
 */
async function searchHybrid(q, topK = 5, institutionCategory = null) {
  // chunks_fts is built once via `npm run migrate:fts` (see that file for
  // why this isn't rebuilt in-memory per request like query_demo.py did).
  let lexicalRanked = [];
  try {
    lexicalRanked = db
      .prepare(`SELECT clause_uri FROM chunks_fts WHERE chunks_fts MATCH ? LIMIT 15`)
      .all(q.replace(/"/g, " "))
      .map((r) => r.clause_uri);
  } catch (e) {
    // fts5 table missing - fall back to vector-only, don't 500 the request
  }

  const vectorRanked = await vectorSearch.search(q, 15, institutionCategory || null);
  const fused = reciprocalRankFusion(lexicalRanked, vectorRanked).slice(0, Number(topK));

  const results = fused.map(([uri, score]) => {
    const clause = db.prepare(`SELECT * FROM clause_registry WHERE clause_uri = ?`).get(uri);
    if (!clause) return null;
    const doc = db.prepare(`SELECT title, rbi_ref FROM documents WHERE doc_id = ?`).get(clause.doc_id);
    const rule = db.prepare(`SELECT * FROM rule_atoms WHERE clause_uri = ?`).get(uri);
    return {
      clause_uri: uri,
      fusion_score: Number(score.toFixed(5)),
      clause_type: clause.clause_type,
      page: clause.page_number,
      doc_title: doc?.title,
      rbi_ref: doc?.rbi_ref,
      clause_text: clause.clause_text.slice(0, 400),
      exact_rule: rule || null,
    };
  }).filter(Boolean);

  return { query: q, results };
}

async function hybridQuery(req, res) {
  const { q, top_k = 5, institution_category } = req.query;
  if (!q) return res.status(400).json({ error: "query param 'q' is required" });
  res.json(await searchHybrid(q, top_k, institution_category || null));
}

module.exports = { hybridQuery, searchHybrid };
