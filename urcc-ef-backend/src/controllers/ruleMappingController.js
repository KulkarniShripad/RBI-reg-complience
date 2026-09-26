/**
 * DESIGN NOTE: this is the ONLY place Gemini touches the rule <-> reported
 * figure mapping. It runs once per rule_atom, produces a SUGGESTION, and
 * that suggestion is inert (`approved_by IS NULL`) until a human calls
 * PUT .../approve. quantComplianceService and the bank-facing
 * applicable-rules endpoint only ever read approved mappings. This is the
 * structural fix discussed in chat: guarantee-by-curation, not
 * guarantee-by-runtime-inference.
 */
const db = require("../config/db");
const gemini = require("../services/geminiService");

function listMappings(req, res) {
  const { approved_only } = req.query;
  let sql = `SELECT m.*, ra.operator, ra.threshold_value, ra.threshold_unit, cr.clause_text, d.rbi_ref
             FROM rule_field_mappings m
             JOIN rule_atoms ra ON m.rule_id = ra.rule_id
             JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri
             JOIN documents d ON cr.doc_id = d.doc_id`;
  if (approved_only === "true") sql += ` WHERE m.approved_by IS NOT NULL`;
  res.json(db.prepare(sql).all());
}

async function suggestMapping(req, res) {
  const { ruleId } = req.params;
  const rule = db
    .prepare(
      `SELECT ra.*, cr.clause_text FROM rule_atoms ra
       JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri WHERE ra.rule_id = ?`
    )
    .get(ruleId);
  if (!rule) return res.status(404).json({ error: "rule not found" });

  const suggestion = await gemini.suggestFieldMapping({
    clauseText: rule.clause_text,
    variableText: rule.variable_text,
    thresholdUnit: rule.threshold_unit,
  });

  db.prepare(
    `INSERT INTO rule_field_mappings (rule_id, canonical_label, llm_suggested_label, llm_suggested_return_code, llm_suggested_tag)
     VALUES (@ruleId, @label, @label, @returnCode, @tag)
     ON CONFLICT(rule_id) DO UPDATE SET
       llm_suggested_label = excluded.llm_suggested_label,
       llm_suggested_return_code = excluded.llm_suggested_return_code,
       llm_suggested_tag = excluded.llm_suggested_tag`
  ).run({
    ruleId,
    label: suggestion.canonical_label,
    returnCode: suggestion.suggested_return_code,
    tag: suggestion.suggested_field_tag,
  });

  res.json({ rule_id: Number(ruleId), suggestion, approved: false });
}

// A human compliance officer calls this after reviewing the suggestion
// (and, per the LLM prompt's own instruction, after checking the actual
// RBI return schema when needs_human_lookup was true) - THIS is what
// makes the mapping usable by live compliance checks.
function approveMapping(req, res) {
  const { ruleId } = req.params;
  const { canonical_label, cims_return_code, cims_field_tag, approved_by } = req.body;
  if (!canonical_label || !approved_by) {
    return res.status(400).json({ error: "canonical_label and approved_by are required" });
  }
  db.prepare(
    `INSERT INTO rule_field_mappings (rule_id, canonical_label, cims_return_code, cims_field_tag, approved_by, approved_at)
     VALUES (@ruleId, @label, @returnCode, @tag, @approvedBy, datetime('now'))
     ON CONFLICT(rule_id) DO UPDATE SET
       canonical_label = excluded.canonical_label,
       cims_return_code = excluded.cims_return_code,
       cims_field_tag = excluded.cims_field_tag,
       approved_by = excluded.approved_by,
       approved_at = datetime('now')`
  ).run({
    ruleId,
    label: canonical_label,
    returnCode: cims_return_code || null,
    tag: cims_field_tag || null,
    approvedBy: approved_by,
  });
  res.json({ ok: true, rule_id: Number(ruleId) });
}

module.exports = { listMappings, suggestMapping, approveMapping };
