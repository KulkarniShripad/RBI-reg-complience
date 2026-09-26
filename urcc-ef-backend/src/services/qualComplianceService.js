const db = require("../config/db");
const vectorSearch = require("./vectorSearchService");
const gemini = require("./geminiService");

/**
 * For each qualitative clause applicable to this institution category
 * (capped at sampleLimit - see the same caveat as the original
 * compliance_checker.py: a full production run should cover the full set
 * or a risk-prioritized subset, not just the first N), find the bank's
 * best-matching submitted evidence text via vector search, then get a REAL
 * Gemini judgment (this is the piece that was an honest stub before).
 */
async function checkQualitative({ institutionCategory, bankId, sampleLimit = 40, similarityThreshold = 0.35 }) {
  const clauses = db
    .prepare(
      `SELECT cr.clause_uri, cr.clause_text, cr.page_number, d.rbi_ref
       FROM clause_registry cr
       JOIN documents d ON cr.doc_id = d.doc_id
       WHERE d.institution_category = ? AND cr.clause_type = 'qualitative'
       LIMIT ?`
    )
    .all(institutionCategory, sampleLimit);

  const evidenceRows = db
    .prepare(`SELECT evidence_id, evidence_text FROM bank_qual_evidence WHERE bank_id = ?`)
    .all(bankId);

  if (evidenceRows.length === 0) {
    return clauses.map((c) => ({
      clause_uri: c.clause_uri,
      clause_text: c.clause_text,
      page_number: c.page_number,
      rbi_ref: c.rbi_ref,
      best_evidence_text: null,
      similarity_score: null,
      status: "LIKELY_GAP",
      llm_judgment: null,
      note: "No qual evidence submitted for this bank yet.",
    }));
  }

  const results = [];
  for (const c of clauses) {
    // Vector search scoped by the clause's own text as the query - finds
    // which submitted evidence chunk is semantically closest. Note: this
    // searches the REGULATION vector DB structure conceptually but here we
    // want nearest EVIDENCE to a CLAUSE, so we do a lightweight in-process
    // TF-IDF-free proxy: ask the Python worker to rank evidence rows by
    // similarity to clause text using the same embedding pipeline.
    let best = null;
    let bestScore = -1;
    try {
      const ranked = await vectorSearch.rankTexts(c.clause_text, evidenceRows.map((e) => e.evidence_text));
      if (ranked && ranked.length) {
        best = evidenceRows[ranked[0].index];
        bestScore = ranked[0].score;
      }
    } catch (err) {
      // fall through with no match rather than crash the whole check
    }

    const bestEvidenceText = bestScore >= similarityThreshold ? best?.evidence_text ?? null : null;

    let judgment = null;
    let status;
    if (!bestEvidenceText) {
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
      clause_uri: c.clause_uri,
      clause_text: c.clause_text,
      page_number: c.page_number,
      rbi_ref: c.rbi_ref,
      best_evidence_text: bestEvidenceText,
      similarity_score: bestScore === -1 ? null : Number(bestScore.toFixed(4)),
      status,
      llm_judgment: judgment,
    });
  }
  return results;
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

module.exports = { checkQualitative, insertEvidence };
