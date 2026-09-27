/**
 * Hybrid retrieval over the regulatory corpus.
 *
 *   lexical   SQLite FTS5 (BM25, Porter stemming) over chunk text. The query
 *             is rebuilt from content words + abbreviation expansions and
 *             OR-ed, with each term quoted. (The previous version passed the
 *             raw question to MATCH: "What is KYC?" is a syntax error in
 *             FTS5 and a plain question requires EVERY word - "what", "is" -
 *             to appear, so lexical search silently returned nothing for most
 *             natural questions.)
 *   semantic  BGE embeddings, exact cosine search (vectorStore.js).
 *   fusion    Reciprocal Rank Fusion of both lists, then small, explainable
 *             boosts: entity type named in the question, definition chunks for
 *             "what is X" questions, clauses carrying numeric requirements for
 *             "how much / within how many days" questions, and a penalty for
 *             boiler-plate (short title, repeal, preamble).
 *   results   one entry per clause (best chunk wins), at most `perDoc`
 *             clauses per document so one long circular cannot crowd out the
 *             rest.
 *
 * Every result carries the FULL clause text plus location (document, RBI
 * reference, page, paragraph, heading path), so the answer layer never has
 * to work from a truncated snippet.
 */
const db = require("../config/db");
const vectorStore = require("./vectorStore");
const embedding = require("./embeddingService");
const qa = require("./queryAnalyzer");

const RRF_K = 60;

function ftsQuery(analysis) {
  const terms = new Set(analysis.terms.filter((t) => !/^\d+$/.test(t) || t.length > 1));
  for (const e of analysis.expansions) for (const w of qa.contentTerms(e.expansion)) terms.add(w);
  const parts = [...terms].slice(0, 24).map((t) => `"${t.replace(/"/g, "")}"`);
  return parts.join(" OR ");
}

function lexicalSearch(analysis, limit = 60, docFilter = null) {
  const match = ftsQuery(analysis);
  if (!match) return [];
  let rows;
  try {
    rows = db
      .prepare(
        `SELECT rowid AS chunk_id, doc_id, bm25(chunks_fts) AS score FROM chunks_fts
         WHERE chunks_fts MATCH ? ORDER BY score LIMIT ?`
      )
      .all(match, docFilter ? limit * 6 : limit);
  } catch (e) {
    console.warn("[retrieval] lexical search failed:", e.message);
    return [];
  }
  if (docFilter) rows = rows.filter((r) => docFilter.has(r.doc_id)).slice(0, limit);
  // Re-rank by how many distinct query terms a chunk contains, so a chunk
  // that mentions "liquidity coverage ratio" beats one that says "ratio" 40 times.
  const terms = [...new Set([...analysis.terms, ...analysis.expansions.flatMap((e) => qa.contentTerms(e.expansion))])];
  const getText = db.prepare("SELECT chunk_text FROM semantic_chunks WHERE chunk_id = ?");
  return rows
    .map((r, i) => {
      const text = (getText.get(r.chunk_id)?.chunk_text || "").toLowerCase();
      const covered = terms.filter((t) => text.includes(t)).length;
      return { ...r, coverage: terms.length ? covered / terms.length : 0, bm25_rank: i };
    })
    .sort((a, b) => b.coverage - a.coverage || a.bm25_rank - b.bm25_rank);
}

async function semanticSearch(analysis, limit = 60, docFilter = null) {
  const st = vectorStore.status();
  if (!st.vectors) return { results: [], error: st.error || "vector index is empty" };
  try {
    const q = await embedding.embedQuery(analysis.expanded_query);
    return { results: vectorStore.search(q, limit, docFilter) };
  } catch (e) {
    return { results: [], error: `embedding failed: ${e.message}` };
  }
}

function docsForCategories(categories) {
  if (!categories || !categories.length) return null;
  const rows = db
    .prepare(
      `SELECT DISTINCT doc_id FROM document_categories WHERE category IN (${categories.map(() => "?").join(",")})`
    )
    .all(...categories);
  return new Set(rows.map((r) => r.doc_id));
}

const chunkStmt = () =>
  db.prepare(
    `SELECT sc.chunk_id, sc.clause_uri AS chunk_uri, sc.parent_clause_uri, sc.doc_id, sc.raw_text, sc.boundary_type,
            cr.paragraph_number, cr.clause_text, cr.clause_role, cr.clause_type, cr.page_number, cr.page_end,
            cr.heading_path, d.title AS doc_title, d.rbi_ref, d.institution_category, d.doc_date, d.last_updated_label
     FROM semantic_chunks sc
     JOIN clause_registry cr ON cr.clause_uri = sc.parent_clause_uri
     JOIN documents d ON d.doc_id = sc.doc_id
     WHERE sc.chunk_id = ?`
  );

function requirementAtoms(clauseUri) {
  return db
    .prepare(
      `SELECT rule_id, operator, threshold_value, threshold_unit, threshold_base, variable_text, atom_kind, confidence
       FROM rule_atoms WHERE clause_uri = ? ORDER BY atom_kind = 'requirement' DESC, rule_id`
    )
    .all(clauseUri);
}

function docCategories(docId) {
  return db
    .prepare(
      `SELECT dc.category, c.label FROM document_categories dc LEFT JOIN categories c ON c.category_id = dc.category
       WHERE dc.doc_id = ? ORDER BY dc.rowid`
    )
    .all(docId);
}

/**
 * @param {string} query
 * @param {object} opts
 * @param {number} [opts.topK=8]
 * @param {string[]} [opts.categories]   hard filter (explicit user choice)
 * @param {object} [opts.analysis]       precomputed queryAnalyzer.analyze() output
 * @param {number} [opts.perDoc=3]
 * @param {boolean} [opts.boostDetectedCategories=true]
 */
async function search(query, opts = {}) {
  const analysis = opts.analysis || qa.analyze(query);
  const topK = opts.topK || 8;
  const perDoc = opts.perDoc || 3;
  const hardDocs = docsForCategories(opts.categories);
  const boostDocs = opts.boostDetectedCategories === false ? null : docsForCategories(analysis.categories);

  const [lex, sem] = await Promise.all([
    Promise.resolve(lexicalSearch(analysis, 60, hardDocs)),
    semanticSearch(analysis, 60, hardDocs),
  ]);

  const scores = new Map();
  const add = (id, rank, weight, field, value) => {
    const e = scores.get(id) || {
      chunk_id: id, fused: 0, lexical_rank: null, semantic_rank: null, semantic_score: null, lexical_coverage: null,
    };
    e.fused += weight / (RRF_K + rank + 1);
    e[field] = rank;
    if (value !== undefined) e.semantic_score = value;
    scores.set(id, e);
  };
  lex.forEach((r, i) => {
    add(r.chunk_id, i, 1.0, "lexical_rank");
    scores.get(r.chunk_id).lexical_coverage = r.coverage;
  });
  sem.results.forEach((r, i) => add(r.chunk_id, i, 1.0, "semantic_rank", r.score));

  const getChunk = chunkStmt();
  const hasReq = db.prepare(`SELECT 1 FROM rule_atoms WHERE clause_uri = ? AND atom_kind = 'requirement' LIMIT 1`);
  const candidates = [];
  for (const e of scores.values()) {
    const c = getChunk.get(e.chunk_id);
    if (!c) continue;
    let boost = 1;
    const why = [];
    if (boostDocs && boostDocs.has(c.doc_id)) {
      boost *= 1.6;
      why.push("entity type named in question");
    } else if (boostDocs && !hardDocs) {
      boost *= 0.75;
    }
    if (analysis.intent.definition && (c.boundary_type === "definition" || c.clause_role === "definition")) {
      boost *= 1.5;
      why.push("definition");
    }
    if (analysis.intent.numeric && hasReq.get(c.parent_clause_uri)) {
      boost *= 1.25;
      why.push("carries a numeric requirement");
    }
    if (["short_title", "repeal", "preamble", "deleted"].includes(c.clause_role)) boost *= 0.55;
    if (e.lexical_rank !== null && e.semantic_rank !== null) why.push("matched by keywords and meaning");
    candidates.push({ ...c, ...e, score: e.fused * boost, why });
  }
  candidates.sort((a, b) => b.score - a.score);

  // One result per clause (best chunk), capped per document.
  const seenClause = new Set();
  const perDocCount = new Map();
  const results = [];
  for (const c of candidates) {
    if (seenClause.has(c.parent_clause_uri)) continue;
    const n = perDocCount.get(c.doc_id) || 0;
    if (n >= perDoc) continue;
    seenClause.add(c.parent_clause_uri);
    perDocCount.set(c.doc_id, n + 1);
    results.push(c);
    if (results.length >= topK) break;
  }

  const out = results.map((c) => ({
    clause_uri: c.parent_clause_uri,
    chunk_id: c.chunk_id,
    doc_id: c.doc_id,
    doc_title: c.doc_title,
    rbi_ref: c.rbi_ref,
    doc_date: c.doc_date,
    last_updated_label: c.last_updated_label,
    institution_category: c.institution_category,
    categories: docCategories(c.doc_id),
    paragraph: c.paragraph_number,
    heading_path: c.heading_path,
    page: c.page_number,
    page_end: c.page_end,
    clause_role: c.clause_role,
    clause_type: c.clause_type,
    clause_text: c.clause_text,
    snippet: c.raw_text,
    boundary_type: c.boundary_type,
    score: Number(c.score.toFixed(5)),
    semantic_score: c.semantic_score === null ? null : Number(c.semantic_score.toFixed(4)),
    lexical_rank: c.lexical_rank,
    lexical_coverage: c.lexical_coverage === null ? null : Number(c.lexical_coverage.toFixed(3)),
    semantic_rank: c.semantic_rank,
    why: c.why,
    rule_atoms: requirementAtoms(c.parent_clause_uri),
  }));

  return {
    query: analysis.query,
    analysis,
    results: out,
    diagnostics: {
      lexical_hits: lex.length,
      semantic_hits: sem.results.length,
      semantic_error: sem.error || null,
      category_filter: opts.categories || null,
      category_boost: analysis.categories,
    },
  };
}

/** Definitions whose term matches the query (for "what is X" questions). */
function lookupDefinitions(analysis, limit = 5) {
  const words = analysis.terms.filter((t) => t.length > 2);
  if (!words.length) return [];
  const phrase = analysis.query
    .replace(/^(what\s+(is|are|does)\s+(a|an|the)?|define|meaning\s+of|what\s+is\s+meant\s+by)\s*/i, "")
    .replace(/[?.!'"‘’“”]/g, "")
    .trim()
    .toLowerCase();
  const rows = db
    .prepare(
      `SELECT d.term, d.definition_text, d.clause_uri, d.page_number, doc.title AS doc_title, doc.rbi_ref, doc.doc_id,
              doc.institution_category
       FROM definitions d JOIN documents doc ON doc.doc_id = d.doc_id
       WHERE lower(d.term) = ? OR lower(d.term) LIKE ? LIMIT 50`
    )
    .all(phrase, `%${phrase}%`);
  return rows.slice(0, limit);
}

module.exports = { search, lookupDefinitions, lexicalSearch, ftsQuery, docsForCategories, docCategories };
