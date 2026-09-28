const db = require("../config/db");
const graphRules = require("../services/graph/graphRules");
const quantService = require("../services/quantComplianceService");
const qualService = require("../services/qualComplianceService");
const anomalyService = require("../services/anomalyCheckService");
const categoryService = require("../services/categoryService");

function listBanks(req, res) {
  const rows = db.prepare(`SELECT * FROM banks ORDER BY created_at DESC`).all();
  res.json(rows);
}

function createBank(req, res) {
  const { bank_id, bank_name, institution_category } = req.body;
  if (!bank_id || !bank_name || !institution_category) {
    return res.status(400).json({ error: "bank_id, bank_name, institution_category are required" });
  }
  // Accept any spelling of a known category ("small financial banks",
  // "SFB", "small_finance_banks") and store the canonical id.
  const category = categoryService.normalise(institution_category);
  if (!category || category === "multiple") {
    return res.status(400).json({
      error: `institution_category '${institution_category}' is not a known institution type.`,
      valid_categories: categoryService.all().filter((c) => c.id !== "multiple").map((c) => ({ id: c.id, label: c.label })),
    });
  }
  db.prepare(
    `INSERT INTO banks (bank_id, bank_name, institution_category) VALUES (?, ?, ?)
     ON CONFLICT(bank_id) DO UPDATE SET bank_name = excluded.bank_name, institution_category = excluded.institution_category`
  ).run(bank_id, bank_name, category);
  res.status(201).json({ bank_id, bank_name, institution_category: category, institution_label: categoryService.label(category) });
}

function getBank(req, res) {
  const bank = db.prepare(`SELECT * FROM banks WHERE bank_id = ?`).get(req.params.bankId);
  if (!bank) return res.status(404).json({ error: "bank not found" });
  res.json(bank);
}

// --- Manual quantitative data entry ---
// This is the direct answer to "how do I input the bank's data manually":
// POST one submission per (rule_id, period) at a time, or POST an array
// for bulk entry (e.g. a dashboard form that submits several fields at once).
function submitQuantData(req, res) {
  const { bankId } = req.params;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  for (const item of items) {
    const { rule_id, reported_value, period_label, source_note } = item;
    if (rule_id === undefined || reported_value === undefined || !period_label) {
      results.push({ error: "rule_id, reported_value, period_label are required", item });
      continue;
    }
    const rule = db.prepare(`SELECT rule_id FROM rule_atoms WHERE rule_id = ?`).get(rule_id);
    if (!rule) {
      results.push({ error: `rule_id ${rule_id} not found in rule_atoms`, item });
      continue;
    }
    // Deterministic sanity/anomaly flags - see anomalyCheckService.js.
    // These do NOT block the submission; they're returned so the entry
    // form (or a reviewer) can catch a wrong-field/wrong-value entry
    // before it silently feeds a compliance run.
    const flags = anomalyService.checkSubmission({
      bankId,
      ruleId: rule_id,
      reportedValue: reported_value,
      periodLabel: period_label,
    });
    quantService.upsertSubmission({
      bankId,
      ruleId: rule_id,
      reportedValue: reported_value,
      periodLabel: period_label,
      sourceNote: source_note,
    });
    results.push({ ok: true, rule_id, period_label, flags });
  }
  res.status(201).json(results);
}

function listQuantSubmissions(req, res) {
  const rows = db
    .prepare(`SELECT * FROM bank_quant_submissions WHERE bank_id = ? ORDER BY submitted_at DESC`)
    .all(req.params.bankId);
  res.json(rows);
}

// --- Manual qualitative evidence entry ---
function submitQualEvidence(req, res) {
  const { bankId } = req.params;
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const results = [];
  for (const item of items) {
    const { evidence_text, source_type, period_label } = item;
    if (!evidence_text) {
      results.push({ error: "evidence_text is required", item });
      continue;
    }
    const info = qualService.insertEvidence({ bankId, evidenceText: evidence_text, sourceType: source_type, periodLabel: period_label });
    results.push({ ok: true, evidence_id: info.lastInsertRowid });
  }
  res.status(201).json(results);
}

function listQualEvidence(req, res) {
  const rows = db
    .prepare(`SELECT * FROM bank_qual_evidence WHERE bank_id = ? ORDER BY submitted_at DESC`)
    .all(req.params.bankId);
  res.json(rows);
}

// Convenience: which rules apply to this bank's category, with a flag for
// whether they've been reported yet this period - useful for a dashboard
// "form" screen that shows the bank all fields it needs to fill in.
function applicableQuantRules(req, res) {
  const { bankId } = req.params;
  const { period_label } = req.query;
  const bank = db.prepare(`SELECT * FROM banks WHERE bank_id = ?`).get(bankId);
  if (!bank) return res.status(404).json({ error: "bank not found" });

  const rules = db
    .prepare(
      `SELECT ra.rule_id, ra.operator, ra.threshold_value, ra.threshold_unit, ra.threshold_base, ra.variable_text,
              ra.confidence, ra.sentence, cr.clause_uri, cr.clause_text, cr.page_number, cr.paragraph_number,
              d.rbi_ref, d.title AS doc_title, d.doc_id,
              m.canonical_label, m.approved_by, m.cims_return_code, m.cims_field_tag
       FROM rule_atoms ra
       JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri
       JOIN documents d ON cr.doc_id = d.doc_id
       LEFT JOIN rule_field_mappings m ON m.rule_id = ra.rule_id
       WHERE d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)
         AND ra.atom_kind = 'requirement'
       ORDER BY ra.confidence = 'high' DESC, d.title, cr.seq`
    )
    .all(bank.institution_category);

  // Prefer the human-approved canonical_label for the form; fall back to
  // the raw heuristic variable_text with an explicit warning so the UI can
  // visually flag "this field hasn't been curated yet, verify manually" -
  // see rule_mapping curation workflow in ruleMappingController.js.
  // Concentration limits and related-party rules are computed from the
  // counterparty network (Network tab) - the form marks them so nobody types
  // a single figure for "exposure to a group of connected counterparties".
  const networkCovered = graphRules.coveredClauseUris(bank.institution_category);
  for (const r of rules) {
    r.computed_by_network = networkCovered.has(r.clause_uri);
    if (!r.approved_by) {
      r.form_label = r.variable_text;
      r.mapping_status = "unverified";
    } else {
      r.form_label = r.canonical_label;
      r.mapping_status = "approved";
    }
  }

  if (period_label) {
    const submitted = new Set(
      db
        .prepare(`SELECT rule_id FROM bank_quant_submissions WHERE bank_id = ? AND period_label = ?`)
        .all(bankId, period_label)
        .map((r) => r.rule_id)
    );
    for (const r of rules) r.already_submitted = submitted.has(r.rule_id);
  }
  res.json(rules);
}

module.exports = {
  listBanks,
  createBank,
  getBank,
  submitQuantData,
  listQuantSubmissions,
  submitQualEvidence,
  listQualEvidence,
  applicableQuantRules,
};
