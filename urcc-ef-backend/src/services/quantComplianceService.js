const { decisionOf } = require("./decisions");
const db = require("../config/db");
const gemini = require("./geminiService");

const OPERATORS = {
  "<=": (v, t) => v <= t,
  ">=": (v, t) => v >= t,
  "<": (v, t) => v < t,
  ">": (v, t) => v > t,
  within_days: (v, t) => v <= t,
};

// Documents that apply to an institution category. A document can apply to
// several categories (document_categories), e.g. a direction addressed to
// "Scheduled Commercial Banks including Small Finance Banks".
const APPLIES_TO = "d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)";

/**
 * Deterministic evaluation - a direct port of compliance_checker.py's
 * check_quantitative_compliance(). This is the part of the system that
 * MUST stay deterministic (see design note in complianceController.js).
 *
 * @param {string} institutionCategory
 * @param {string} bankId
 * @param {string} periodLabel
 */
function checkQuantitative(institutionCategory, bankId, periodLabel) {
  const rules = db
    .prepare(
      `SELECT ra.rule_id, ra.clause_uri, ra.operator, ra.threshold_value, ra.threshold_unit, ra.threshold_base,
              ra.variable_text, ra.confidence, ra.sentence, cr.clause_text, cr.page_number, cr.paragraph_number,
              d.rbi_ref, d.title AS doc_title, d.doc_id
       FROM rule_atoms ra
       JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri
       JOIN documents d ON cr.doc_id = d.doc_id
       WHERE ${APPLIES_TO} AND ra.atom_kind = 'requirement'
       ORDER BY ra.confidence = 'high' DESC, d.title, cr.seq`
    )
    .all(institutionCategory);

  const submissions = db
    .prepare(
      `SELECT rule_id, reported_value FROM bank_quant_submissions
       WHERE bank_id = ? AND period_label = ?`
    )
    .all(bankId, periodLabel);
  const submittedByRule = new Map(submissions.map((s) => [s.rule_id, s.reported_value]));

  return rules.map((r) => {
    const reported = submittedByRule.has(r.rule_id) ? submittedByRule.get(r.rule_id) : null;
    let status;
    if (reported === null) {
      status = "NOT_REPORTED";
    } else {
      const evaluator = OPERATORS[r.operator];
      status = evaluator && evaluator(reported, r.threshold_value) ? "PASS" : "BREACH";
    }
    return {
      rule_id: r.rule_id,
      clause_uri: r.clause_uri,
      operator: r.operator,
      threshold_value: r.threshold_value,
      threshold_unit: r.threshold_unit,
      variable_text: r.variable_text,
      threshold_base: r.threshold_base,
      extraction_confidence: r.confidence,
      sentence: r.sentence,
      paragraph: r.paragraph_number,
      doc_id: r.doc_id,
      doc_title: r.doc_title,
      reported_value: reported,
      status,
      decision: decisionOf(status),
      evidence_completeness: reported === null ? 0 : 1,
      clause_text: r.clause_text,
      page_number: r.page_number,
      rbi_ref: r.rbi_ref,
    };
  });
}

/**
 * Optional secondary pass: for each rule that HAS a submission, ask Gemini
 * whether the submitted field's label plausibly maps to what the clause's
 * variable_text describes. This never changes PASS/BREACH/NOT_REPORTED -
 * it only adds a `mapping_warning` flag for a human reviewer. Call this
 * separately from checkQuantitative() since it costs LLM calls and time;
 * don't put it on the hot path of every check by default.
 */
async function verifyMappings(quantResults, submittedFieldLabels) {
  const withWarnings = [];
  for (const r of quantResults) {
    if (r.status === "NOT_REPORTED") {
      withWarnings.push({ ...r, mapping_check: null });
      continue;
    }
    const fieldLabel = submittedFieldLabels?.[r.rule_id] || `(no field label provided for rule ${r.rule_id})`;
    try {
      const verdict = await gemini.verifyVariableMapping({
        clauseText: r.clause_text,
        variableText: r.variable_text,
        operator: r.operator,
        thresholdValue: r.threshold_value,
        thresholdUnit: r.threshold_unit,
        submittedFieldLabel: fieldLabel,
      });
      withWarnings.push({ ...r, mapping_check: verdict });
    } catch (err) {
      // Fail open on the LLM warning layer specifically - a broken mapping
      // check must never block or mask the deterministic verdict.
      withWarnings.push({ ...r, mapping_check: { error: err.message } });
    }
  }
  return withWarnings;
}

function upsertSubmission({ bankId, ruleId, reportedValue, periodLabel, sourceNote }) {
  return db
    .prepare(
      `INSERT INTO bank_quant_submissions (bank_id, rule_id, reported_value, period_label, source_note)
       VALUES (@bankId, @ruleId, @reportedValue, @periodLabel, @sourceNote)
       ON CONFLICT(bank_id, rule_id, period_label)
       DO UPDATE SET reported_value = excluded.reported_value, source_note = excluded.source_note,
                     submitted_at = datetime('now')`
    )
    .run({ bankId, ruleId, reportedValue, periodLabel, sourceNote: sourceNote || null });
}

module.exports = { checkQuantitative, verifyMappings, upsertSubmission };
