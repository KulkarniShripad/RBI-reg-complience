/**
 * The regulatory chat: question in, grounded answer + verifiable sources out.
 *
 * Layers, each with a fallback so the user always gets something useful and
 * never an invented rule:
 *
 *   1. Small talk ("hi", "what can you do") is answered directly.
 *   2. Follow-ups ("what about NBFCs?") are rewritten into a stand-alone
 *      question using the conversation (Gemini if available, otherwise by
 *      carrying over the previous question's subject).
 *   3. Hybrid retrieval (retrievalService). If it finds nothing convincing,
 *      it retries without the entity-type filter, then tries the
 *      definitions table directly.
 *   4. Gemini writes the answer from the FULL text of the top clauses (not
 *      400-character snippets) and must cite them as [1], [2] ...
 *      If Gemini claims the sources are insufficient while retrieval was
 *      confident, it is asked once more with a wider context.
 *   5. If Gemini is unavailable (no key, quota, outage) the answer is built
 *      extractively from the most relevant sentences of the retrieved
 *      clauses, clearly labelled as such.
 *
 * Every response carries the sources with full clause text, document,
 * RBI reference, page and paragraph, so the UI can show exactly where each
 * statement comes from.
 */
const gemini = require("./geminiService");
const retrieval = require("./retrievalService");
const qa = require("./queryAnalyzer");
const categoryService = require("./categoryService");

const MAX_CONTEXT_CHARS = 16000;
const MAX_CLAUSE_CHARS = 3500;

const SMALLTALK_ANSWER =
  "Hello! I answer questions about the RBI Master Directions and circulars in this knowledge base - for example " +
  "*\"What is the minimum CRAR for small finance banks?\"*, *\"How often must KYC be updated for high-risk customers?\"* " +
  "or *\"Within how many days must a bank reverse an unauthorised electronic transaction?\"*. " +
  "Mention the type of institution (commercial bank, SFB, NBFC, UCB, ...) for the most precise answer. " +
  "Every answer links to the exact paragraphs it is based on.";

const INSUFFICIENT = /\b(insufficient|not (?:enough|sufficient) (?:context|information)|do(?:es)? not (?:contain|provide|mention|specify|include|address)|no (?:relevant )?information|not (?:covered|mentioned|specified|addressed) in the (?:provided )?sources|cannot (?:be )?(?:determine|answer)d?)\b/i;

/**
 * How sure retrieval is that the top result answers the question. With
 * embeddings: the cosine similarity of the best clause (BGE scale) and
 * whether keyword search agreed. Without embeddings (index still building):
 * the share of the question's content words the best clause contains.
 */
function confidenceOf(results) {
  if (!results.length) return "low";
  const top = results[0];
  if (top.semantic_score === null || top.semantic_score === undefined) {
    const cov = top.lexical_coverage ?? 0;
    if (cov >= 0.75) return "high";
    if (cov >= 0.5) return "medium";
    return "low";
  }
  const s = top.semantic_score;
  const both = top.lexical_rank !== null && top.semantic_rank !== null && top.lexical_rank < 15 && top.semantic_rank < 15;
  if (s >= 0.8 || (s >= 0.74 && both)) return "high";
  if (s >= 0.68 || both) return "medium";
  return "low";
}

function formatHistory(history) {
  return (history || [])
    .slice(-6)
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${String(m.content || "").replace(/\s+/g, " ").slice(0, 400)}`)
    .join("\n");
}

function shortTitle(t) {
  return String(t || "").replace(/^Reserve Bank of India\s*/i, "").replace(/\s+/g, " ").trim();
}

function clauseForPrompt(r) {
  let text = r.clause_text || "";
  if (text.length > MAX_CLAUSE_CHARS) {
    // Keep the part the retriever matched, plus the paragraph's lead-in.
    const lead = text.slice(0, 500);
    const idx = r.snippet ? text.indexOf(r.snippet.slice(0, 80)) : -1;
    const mid = idx > 500 ? text.slice(idx, idx + MAX_CLAUSE_CHARS - 600) : text.slice(500, MAX_CLAUSE_CHARS - 100);
    text = `${lead} [...] ${mid} [...]`;
  }
  return text;
}

function buildSources(results) {
  let used = 0;
  const blocks = [];
  results.forEach((r, i) => {
    const cats = (r.categories || []).map((c) => c.label || c.category).filter(Boolean).join(", ");
    const req = (r.rule_atoms || [])
      .filter((a) => a.atom_kind === "requirement")
      .slice(0, 4)
      .map((a) => `${a.variable_text || "value"} ${a.operator} ${a.threshold_value}${a.threshold_unit === "%" ? "%" : ` ${a.threshold_unit}`}${a.threshold_base ? ` of ${a.threshold_base}` : ""}`);
    const block = [
      `[${i + 1}] ${shortTitle(r.doc_title)}${r.rbi_ref ? ` (${r.rbi_ref})` : ""}`,
      `Applies to: ${cats || "not stated"} | Paragraph ${r.paragraph} | Page ${r.page}${r.heading_path ? ` | ${r.heading_path}` : ""}`,
      req.length ? `Extracted numeric requirements: ${req.join("; ")}` : null,
      `Text: ${clauseForPrompt(r)}`,
    ]
      .filter(Boolean)
      .join("\n");
    if (used + block.length > MAX_CONTEXT_CHARS && blocks.length >= 3) return;
    used += block.length;
    blocks.push(block);
  });
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extractive fallback (no LLM)
// ---------------------------------------------------------------------------
function sentences(text) {
  return String(text || "")
    .replace(/\n/g, " ; ")
    .split(/(?<=[.;])\s+(?=[A-Z(\[‘'"])/)
    .map((s) => s.replace(/^[;\s]+|[;\s]+$/g, ""))
    .filter((s) => s.length > 25);
}

function extractiveAnswer(analysis, results, reason) {
  const terms = new Set([...analysis.terms, ...analysis.expansions.flatMap((e) => qa.contentTerms(e.expansion))]);
  const lines = [];
  results.slice(0, 4).forEach((r, i) => {
    const scored = sentences(r.clause_text)
      .map((s, idx) => {
        const low = s.toLowerCase();
        let score = [...terms].filter((t) => low.includes(t)).length;
        if (analysis.intent.numeric && /\d/.test(s)) score += 1.5;
        if (/\b(shall|must|should|required)\b/i.test(s)) score += 0.5;
        return { s, idx, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .sort((a, b) => a.idx - b.idx);
    if (!scored.length) return;
    const where = `${shortTitle(r.doc_title)}, para ${r.paragraph}`;
    lines.push(`- **${where}** [${i + 1}]: ${scored.map((x) => x.s).join(" … ")}`);
  });
  const header =
    "Here are the provisions that most closely match your question" +
    (reason ? ` (an AI-written summary is unavailable right now: ${reason})` : "") +
    ":";
  return `${header}\n\n${lines.join("\n")}\n\nOpen a source below to read the full paragraph.`;
}

function notFoundAnswer(analysis, nearest) {
  const suggestions = nearest
    .slice(0, 3)
    .map((r) => `- ${shortTitle(r.doc_title)}${r.rbi_ref ? ` (${r.rbi_ref})` : ""}`)
    .join("\n");
  return (
    "I could not find a provision in the ingested RBI directions that answers this question" +
    (analysis.categories.length ? ` for ${analysis.categories.map(categoryService.label).join(", ")}` : "") +
    ". It may be covered by a circular that has not been uploaded yet, or it may be phrased differently." +
    (suggestions ? `\n\nThe closest documents I found are:\n${suggestions}` : "") +
    "\n\nTry naming the type of institution or the specific requirement (for example a ratio, limit or time period)."
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
/**
 * @param {object} args
 * @param {string} args.query
 * @param {{role:string, content:string}[]} [args.history]
 * @param {string} [args.category] explicit entity-type filter from the UI
 */
async function answer({ query, history = [], category = null }) {
  const started = Date.now();
  const original = String(query || "").trim();
  let analysis = qa.analyze(original, { history });

  if (analysis.smalltalk) {
    return respond({ query: original, answer: SMALLTALK_ANSWER, mode: "smalltalk", results: [], analysis, started });
  }

  // Follow-ups: rewrite into a stand-alone question.
  let rewritten = null;
  if (analysis.follow_up) {
    if (gemini.isConfigured()) {
      try {
        rewritten = await gemini.rewriteFollowUp({ question: original, history: formatHistory(history) });
      } catch (_) {
        rewritten = null;
      }
    }
    if (!rewritten) rewritten = `${original} (context: ${analysis.previous_query})`;
    const carried = qa.analyze(rewritten);
    // Keep the entity type from the previous question unless a new one is named.
    if (!carried.categories.length && analysis.previous_query) {
      carried.categories = qa.analyze(analysis.previous_query).categories;
    }
    analysis = { ...carried, follow_up: true, previous_query: analysis.previous_query };
  }

  const explicit = category ? categoryService.normalise(category) : null;
  const searchQuery = rewritten || original;
  let res = await retrieval.search(searchQuery, {
    topK: 8,
    analysis,
    categories: explicit ? [explicit] : undefined,
  });
  let results = res.results;
  const fallbacks = [];

  // "Nothing convincing": no semantic match worth reading and no clause that
  // covers at least a third of the question's content words.
  const weak = (rs) =>
    !rs.length ||
    ((rs[0].semantic_score ?? 0) < 0.6 && (rs[0].lexical_coverage ?? 0) < 0.34);
  if (weak(results) && explicit) {
    const wide = await retrieval.search(searchQuery, { topK: 8, analysis });
    if (!weak(wide.results)) {
      results = wide.results;
      fallbacks.push("searched all institution types (nothing strong under the selected one)");
    }
  }
  if (analysis.intent.definition) {
    const defs = retrieval.lookupDefinitions(analysis);
    if (defs.length && !results.some((r) => defs.some((d) => d.clause_uri === r.clause_uri))) {
      fallbacks.push("added matching definitions");
      const extra = await retrieval.search(`${defs[0].term} means`, { topK: 3, analysis: qa.analyze(`${defs[0].term} means`) });
      results = [...results.slice(0, 6), ...extra.results.filter((r) => !results.some((x) => x.clause_uri === r.clause_uri))].slice(0, 8);
    }
  }

  const confidence = confidenceOf(results);
  if (!results.length || (confidence === "low" && weak(results))) {
    return respond({
      query: original, rewritten, answer: notFoundAnswer(analysis, results), mode: "not_found",
      results: [], analysis, confidence: "low", fallbacks, diagnostics: res.diagnostics, started, nearest: results,
    });
  }

  const entityNote = explicit
    ? `The user selected the institution type: ${categoryService.label(explicit)}.`
    : analysis.categories.length
      ? `The question is about: ${analysis.categories.map(categoryService.label).join(", ")}.`
      : "The question does not name an institution type; if the requirement differs by type, list the types separately.";

  if (!gemini.isConfigured()) {
    return respond({
      query: original, rewritten, answer: extractiveAnswer(analysis, results, "GEMINI_API_KEY is not configured"),
      mode: "extractive", results, analysis, confidence, fallbacks, diagnostics: res.diagnostics, started,
      error: "GEMINI_API_KEY is not configured",
    });
  }

  try {
    let out = await gemini.answerRegulatoryQuestion({
      query: searchQuery, sources: buildSources(results), history: formatHistory(history), entityNote,
    });
    let text = out.text;
    if (INSUFFICIENT.test(text.slice(0, 300)) && confidence !== "low") {
      // Retrieval was confident but the model balked - widen the context once.
      const wide = await retrieval.search(searchQuery, { topK: 12, perDoc: 4, analysis });
      const merged = [...results, ...wide.results.filter((r) => !results.some((x) => x.clause_uri === r.clause_uri))].slice(0, 12);
      out = await gemini.answerRegulatoryQuestion({
        query: searchQuery, sources: buildSources(merged), history: formatHistory(history), entityNote, retry: true,
      });
      text = out.text;
      results = merged;
      fallbacks.push("re-asked with a wider set of provisions");
    }
    return respond({
      query: original, rewritten, answer: text, mode: "llm", model: out.model, results, analysis, confidence,
      fallbacks, diagnostics: res.diagnostics, started,
    });
  } catch (err) {
    return respond({
      query: original, rewritten, answer: extractiveAnswer(analysis, results, "the language model could not be reached"),
      mode: "extractive", results, analysis, confidence, fallbacks, diagnostics: res.diagnostics, started,
      error: err.message,
    });
  }
}

function respond({ query, rewritten = null, answer, mode, model = null, results, analysis, confidence = "low",
  fallbacks = [], diagnostics = null, started, error = null, nearest = [] }) {
  const sources = results.map((r, i) => ({
    id: i + 1,
    clause_uri: r.clause_uri,
    doc_id: r.doc_id,
    doc_title: r.doc_title,
    rbi_ref: r.rbi_ref,
    doc_date: r.doc_date,
    categories: r.categories,
    institution_category: r.institution_category,
    paragraph: r.paragraph,
    heading_path: r.heading_path,
    page: r.page,
    page_end: r.page_end,
    clause_role: r.clause_role,
    clause_text: r.clause_text,
    snippet: r.snippet,
    score: r.score,
    semantic_score: r.semantic_score,
    why: r.why,
    rule_atoms: r.rule_atoms,
  }));
  const requirementIds = [...new Set(results.flatMap((r) => (r.rule_atoms || []).filter((a) => a.atom_kind === "requirement").map((a) => String(a.rule_id))))];
  return {
    query,
    rewritten_query: rewritten,
    answer,
    answer_mode: mode,
    model,
    sources,
    nearest_documents: nearest.slice(0, 3).map((r) => ({ doc_id: r.doc_id, doc_title: r.doc_title, rbi_ref: r.rbi_ref })),
    detected_categories: analysis.categories.map((c) => ({ id: c, label: categoryService.label(c) })),
    expansions: analysis.expansions,
    confidence,
    fallback_used: mode !== "llm" && mode !== "smalltalk",
    fallbacks,
    error,
    diagnostics,
    elapsed_ms: Date.now() - started,
    // fields kept for the existing UI
    relevant_rule_ids: requirementIds,
    source_circulars: [...new Set(results.map((r) => r.rbi_ref).filter(Boolean))],
    sources_used: sources.length,
    rules_matched: requirementIds.length,
  };
}

module.exports = { answer, extractiveAnswer, confidenceOf, buildSources };
