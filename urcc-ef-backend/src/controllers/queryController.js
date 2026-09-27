const retrieval = require("../services/retrievalService");
const categoryService = require("../services/categoryService");

/**
 * GET /api/query?q=...&top_k=8&institution_category=...
 * Raw hybrid retrieval (no LLM): the ranked clauses with full text, scores
 * and the reason each one matched. Useful for debugging answers.
 */
async function hybridQuery(req, res) {
  const { q, top_k = 8, institution_category, category } = req.query;
  if (!q) return res.status(400).json({ error: "query param 'q' is required" });
  const cat = category || institution_category;
  const normalised = cat ? categoryService.normalise(cat) : null;
  if (cat && !normalised) return res.status(400).json({ error: `unknown category '${cat}'` });
  const out = await retrieval.search(String(q), {
    topK: Math.min(Number(top_k) || 8, 30),
    categories: normalised ? [normalised] : undefined,
  });
  res.json({ query: out.query, analysis: out.analysis, diagnostics: out.diagnostics, results: out.results });
}

module.exports = { hybridQuery };
