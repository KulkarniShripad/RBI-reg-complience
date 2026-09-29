const { decisionOf, withDecisions } = require("./decisions");
const db = require("../config/db");
const embedding = require("./embeddingService");
const gemini = require("./geminiService");

/**
 * Subsystem 2: does the bank's own governance text (board minutes, policy
 * manuals, audit notes) show that it meets each qualitative obligation?
 *
 * 1. Obligations applicable to the bank's category are taken round-robin
 *    across the applicable directions (one from each direction in turn), so
 *    a sample of N covers many directions instead of the first N paragraphs
 *    of one document (the old behaviour: mostly titles and definitions).
 *    Only clauses classified as obligations are used - not definitions,
 *    short titles, repeal clauses or deleted paragraphs.
 * 2. The bank's evidence texts are ranked against each obligation with the
 *    same BGE embeddings used for search (cosine similarity).
 * 3. If the best evidence clears `similarityThreshold`, Gemini judges
 *    whether it demonstrates compliance (full / partial / none). Without a
 *    usable match the obligation is a LIKELY_GAP; if the LLM call fails it is
 *    NEEDS_REVIEW - never silently COVERED.
 */
function sampleObligations(institutionCategory, sampleLimit) {
  const rows = db
    .prepare(
      `SELECT cr.clause_uri, cr.clause_text, cr.page_number, cr.paragraph_number, cr.doc_id, d.rbi_ref, d.title AS doc_title
       FROM clause_registry cr
       JOIN documents d ON cr.doc_id = d.doc_id
       WHERE d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)
         AND cr.clause_role = 'obligation' AND cr.clause_type IN ('qualitative', 'relational')
         AND length(cr.clause_text) BETWEEN 80 AND 4000
       ORDER BY d.title, cr.seq`
    )
    .all(institutionCategory);
  const byDoc = new Map();
  for (const r of rows) {
    if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []);
    byDoc.get(r.doc_id).push(r);
  }
  const queues = [...byDoc.values()];
  const out = [];
  for (let i = 0; out.length < sampleLimit && queues.some((q) => i < q.length); i++) {
    for (const q of queues) {
      if (i < q.length && out.length < sampleLimit) out.push(q[i]);
    }
  }
  return { sample: out, total: rows.length };
}

async function checkQualitative({ institutionCategory, bankId, sampleLimit = 40, similarityThreshold = 0.6 }) {
  const { sample: clauses, total } = sampleObligations(institutionCategory, sampleLimit);
  const evidenceRows = db
    .prepare(`SELECT evidence_id, evidence_text FROM bank_qual_evidence WHERE bank_id = ?`)
    .all(bankId);

  const base = (c) => ({
    clause_uri: c.clause_uri,
    clause_text: c.clause_text,
    page_number: c.page_number,
    paragraph: c.paragraph_number,
    rbi_ref: c.rbi_ref,
    doc_title: c.doc_title,
    applicable_obligations_total: total,
  });

  if (evidenceRows.length === 0) {
    return clauses.map((c) => ({
      ...base(c),
      best_evidence_text: null,
      similarity_score: null,
      status: "LIKELY_GAP",
      llm_judgment: null,
      note: "No qualitative evidence submitted for this bank yet.",
      decision: decisionOf("LIKELY_GAP"),
    }));
  }

  // Embed the evidence once, then score every obligation against it.
  let evidenceVecs = null;
  try {
    evidenceVecs = await embedding.embedPassages(evidenceRows.map((e) => e.evidence_text));
  } catch (err) {
    evidenceVecs = null;
  }

  const results = [];
  for (const c of clauses) {
    let best = null;
    let bestScore = null;
    if (evidenceVecs) {
      try {
        const [cv] = await embedding.embedPassages([c.clause_text]);
        evidenceVecs.forEach((v, i) => {
          const s = embedding.dot(cv, v);
          if (bestScore === null || s > bestScore) {
            bestScore = s;
            best = evidenceRows[i];
          }
        });
      } catch (_) {
        /* fall through: no match */
      }
    }

    const bestEvidenceText = bestScore !== null && bestScore >= similarityThreshold ? best?.evidence_text ?? null : null;
    let judgment = null;
    let status;
    if (!evidenceVecs) {
      status = "NEEDS_REVIEW";
      judgment = { error: "embedding model unavailable - evidence could not be matched" };
    } else if (!bestEvidenceText) {
      status = "LIKELY_GAP";
    } else {
      try {
        judgment = await gemini.judgeQualitativeCoverage({
          rbiRef: c.rbi_ref,
          page: c.page_number,
          clauseText: c.clause_text,
          evidenceText: bestEvidenceText,
        });
        status =
          judgment.coverage === "full" ? "COVERED" : judgment.coverage === "partial" ? "PARTIAL" : "LIKELY_GAP";
      } catch (err) {
        status = "NEEDS_REVIEW"; // LLM call failed - don't silently mark COVERED
        judgment = { error: err.message };
      }
    }

    results.push({
      ...base(c),
      best_evidence_text: bestEvidenceText,
      evidence_id: bestEvidenceText ? best.evidence_id : null,
      similarity_score: bestScore === null ? null : Number(bestScore.toFixed(4)),
      status,
      llm_judgment: judgment,
      justification: judgment && judgment.justification ? judgment.justification : null,
    });
  }
  return withDecisions(results);
}

function insertEvidence({ bankId, evidenceText, sourceType, periodLabel }) {
  // Idempotency guard: re-submitting identical evidence text (e.g. running
  // a demo/seed script twice) silently duplicates rows and inflates the
  // evidence pool with no new information - this directly breaks the
  // router's small-pool absolute-score logic (see routingService.js
  // THRESHOLDS comment). Skip an exact-text duplicate for this bank
  // instead of blindly inserting.
  const existing = db
    .prepare(`SELECT evidence_id FROM bank_qual_evidence WHERE bank_id = ? AND evidence_text = ?`)
    .get(bankId, evidenceText);
  if (existing) {
    return { lastInsertRowid: existing.evidence_id, skipped: true };
  }
  return db
    .prepare(
      `INSERT INTO bank_qual_evidence (bank_id, evidence_text, source_type, period_label)
       VALUES (?, ?, ?, ?)`
    )
    .run(bankId, evidenceText, sourceType || null, periodLabel || null);
}

module.exports = { checkQualitative, insertEvidence, sampleObligations };
