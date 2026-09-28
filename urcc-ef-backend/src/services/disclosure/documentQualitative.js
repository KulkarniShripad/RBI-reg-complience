/**
 * Qualitative obligations a document speaks to.
 *
 * The manual qualitative check starts from a sample of obligations and looks
 * for evidence; on a public document that would call most obligations "gaps"
 * simply because an annual report does not describe them. Here it runs the
 * other way round: governance passages of the document (board, committees,
 * policies, risk management, KYC, grievances, ...) are matched to the
 * obligations of the bank's category with the same BGE embeddings as search,
 * and only obligations with a close passage are judged:
 *
 *   COVERED / PARTIAL / NOT_DEMONSTRATED   LLM judgement of the passage
 *   EVIDENCE_FOUND                         no LLM configured - match only
 *
 * Obligations the document does not mention are not reported as gaps.
 */
const db = require("../../config/db");
const embedding = require("../embeddingService");
const vectorStore = require("../vectorStore");
const gemini = require("../geminiService");

const GOVERNANCE = /\b(board|committee|policy|policies|audit|risk management|compliance|kyc|know your customer|anti[\s-]*money|grievance|ombudsman|complaint|outsourc|fraud|cyber|information security|whistle|fair practice|recovery agent|customer service|internal control|credit risk|liquidity risk|interest rate risk|operational risk|concentration|related part|remuneration|nomination|director)/gi;

// Specific subjects of governance obligations. Generic words (board, policy, committee) are not subjects.
const TOPICS = {
  kyc: /know\s+your\s+customer|\bkyc\b|customer\s+due\s+diligence|anti[\s-]*money\s+laundering|\baml\b|\bfiu\b/i,
  grievance: /grievance|complaint|internal\s+ombudsman|ombudsman/i,
  outsourcing: /outsourc/i,
  cyber: /cyber|information\s+security|information\s+technology\s+policy/i,
  fraud: /\bfrauds?\b/i,
  audit: /audit\s+committee|internal\s+audit|concurrent\s+audit|risk\s+based\s+internal\s+audit|\brbia\b/i,
  concentration: /concentration\s+risk|single\s+counterparty|connected\s+counterpart|large\s+exposure/i,
  liquidity: /liquidity\s+risk/i,
  credit_risk: /credit\s+risk\s+management|credit\s+risk\s+policy/i,
  customer_service: /customer\s+service\s+committee|customer\s+service/i,
  remuneration: /remuneration|compensation\s+policy|nomination/i,
  recovery: /recovery\s+agent/i,
  whistle: /whistle[\s-]*blow|vigil\s+mechanism/i,
  related_party: /related\s+part/i,
  unauthorised_debit: /unauthori[sz]ed\s+(?:electronic\s+)?(?:banking\s+)?(?:transactions?|debits?)|customer\s+liability/i,
};
const topicsOf = (t) => Object.entries(TOPICS).filter(([, re]) => re.test(t)).map(([k]) => k);


function passages(pages, { max = 60 } = {}) {
  // running headers / footers repeat on many pages; they are not content
  const freq = new Map();
  for (const p of pages) for (const l of new Set(p.lines)) freq.set(l, (freq.get(l) || 0) + 1);
  const repeated = (l) => pages.length >= 2 && freq.get(l) >= Math.max(2, Math.ceil(pages.length * 0.4));
  const out = [];
  for (const p of pages) {
    // narrative lines only: table rows (cells), short numeric lines and running headers are skipped
    const text = p.lines
      .filter((l) => !l.includes(" | ") && /[a-z]{4,}/.test(l) && !repeated(l))
      .join(" ")
      .replace(/\s+/g, " ");
    const sentences = text.split(/(?<=[.;])\s+(?=[A-Z(])/);
    let cur = "";
    for (const s of sentences) {
      // short passages (2-4 sentences) keep one subject each, so matches stay specific
      if ((cur + " " + s).length > 480 && cur.length > 160) {
        out.push({ page: p.page, text: cur.trim() });
        cur = "";
      }
      cur += ` ${s}`;
    }
    if (cur.trim().length > 160) out.push({ page: p.page, text: cur.trim() });
  }
  return out
    .map((x) => ({ ...x, hits: (x.text.match(GOVERNANCE) || []).length }))
    .map((x) => ({ ...x, topics: topicsOf(x.text) }))
    .filter((x) => x.hits >= 1 && x.topics.length)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, max);
}

async function obligationsInDocument({ category, pages, useLlm, maxObligations = 15, minScore = 0.74 }) {
  const chosen = passages(pages);
  if (!chosen.length) {
    return { applicable: false, reason: "The document has no narrative passages on governance, policies or risk management.", results: [] };
  }
  let st = vectorStore.status();
  if (!st.vectors) {
    try {
      vectorStore.load();
      st = vectorStore.status();
    } catch (_) {
      /* reported below */
    }
  }
  if (!st.vectors) return { applicable: false, reason: "The vector index is not available (run npm run build:vectors).", results: [] };

  let vecs;
  try {
    vecs = await embedding.embedPassages(chosen.map((c) => c.text));
  } catch (err) {
    return { applicable: false, reason: `The embedding model is not available: ${err.message}`, results: [] };
  }
  const docFilter = new Set(
    db.prepare("SELECT doc_id FROM document_categories WHERE category = ?").all(category).map((r) => r.doc_id)
  );
  const clauseOf = db.prepare(
    `SELECT sc.parent_clause_uri AS clause_uri, cr.clause_text, cr.clause_role, cr.clause_type, cr.page_number, cr.paragraph_number,
            d.doc_id, d.title AS doc_title, d.rbi_ref
     FROM semantic_chunks sc JOIN clause_registry cr ON cr.clause_uri = sc.parent_clause_uri JOIN documents d ON d.doc_id = sc.doc_id
     WHERE sc.chunk_id = ?`
  );

  const best = new Map(); // clause_uri -> {score, passage, clause}
  vecs.forEach((v, i) => {
    for (const hit of vectorStore.search(v, 5, docFilter)) {
      if (hit.score < minScore) continue;
      const c = clauseOf.get(hit.chunk_id);
      if (!c || c.clause_role !== "obligation" || c.clause_type === "quantitative" || c.clause_text.length < 80) continue;
      // disclosure formats are covered by the disclosure checklist; tables are not obligations to evidence
      if (/Financial Statements\s*:\s*Presentation and Disclosures/i.test(c.doc_title)) continue;
      if ((c.clause_text.match(/\|/g) || []).length >= 3 || (c.clause_text.match(/\(\s*[ivx]+\s*\)/g) || []).length >= 6) continue;
      // semantic closeness alone matches "policy approved by the Board" to any policy: the passage and the
      // obligation must be about the same specific subject (KYC, grievances, outsourcing, ...)
      const common = topicsOf(c.clause_text).filter((t) => chosen[i].topics.includes(t));
      if (!common.length) continue;
      const prev = best.get(c.clause_uri);
      if (!prev || hit.score > prev.score) best.set(c.clause_uri, { score: hit.score, passage: chosen[i], clause: c });
    }
  });
  const top = [...best.values()].sort((a, b) => b.score - a.score).slice(0, maxObligations);
  const llm = useLlm && gemini.isConfigured();
  const results = [];
  for (const m of top) {
    const base = {
      clause_uri: m.clause.clause_uri,
      clause_text: m.clause.clause_text,
      paragraph: m.clause.paragraph_number,
      page_number: m.clause.page_number,
      doc_id: m.clause.doc_id,
      doc_title: m.clause.doc_title,
      rbi_ref: m.clause.rbi_ref,
      evidence_text: m.passage.text,
      evidence_page: m.passage.page,
      similarity_score: Number(m.score.toFixed(4)),
    };
    if (!llm) {
      results.push({ ...base, status: "EVIDENCE_FOUND", justification: "The document has a closely matching passage; not judged (no LLM configured)." });
      continue;
    }
    try {
      const j = await gemini.judgeQualitativeCoverage({
        rbiRef: m.clause.rbi_ref,
        page: m.clause.page_number,
        clauseText: m.clause.clause_text.slice(0, 3000),
        evidenceText: m.passage.text,
      });
      results.push({
        ...base,
        status: j.coverage === "full" ? "COVERED" : j.coverage === "partial" ? "PARTIAL" : "NOT_DEMONSTRATED",
        justification: j.justification || null,
        llm_judgment: j,
      });
    } catch (err) {
      results.push({ ...base, status: "NEEDS_REVIEW", justification: `LLM judgement failed: ${err.message}` });
    }
  }
  return { applicable: true, passages_considered: chosen.length, results };
}

module.exports = { obligationsInDocument, passages };
