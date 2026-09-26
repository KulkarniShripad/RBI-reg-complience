/**
 * DESIGN NOTE (read before changing checkFull): quantitative arithmetic
 * (checkQuantitative) is intentionally deterministic and NEVER routed
 * through an LLM - see geminiService.js's file docstring for the full
 * reasoning. The `use_llm_mapping_check` flag below only ever ADDS a
 * warning annotation; it can never change PASS/BREACH/NOT_REPORTED.
 */
const db = require("../config/db");
const quantService = require("../services/quantComplianceService");
const qualService = require("../services/qualComplianceService");
const reportService = require("../services/reportService");
const routedService = require("../services/routedComplianceService");

async function runComplianceCheck(req, res) {
  const { bankId } = req.params;
  const {
    period_label,
    use_llm_mapping_check = false,
    submitted_field_labels = {}, // { [rule_id]: "human label of what was submitted" }
    qual_sample_limit = 40,
    persist = true,
  } = req.body;

  if (!period_label) return res.status(400).json({ error: "period_label is required" });

  const bank = db.prepare(`SELECT * FROM banks WHERE bank_id = ?`).get(bankId);
  if (!bank) return res.status(404).json({ error: "bank not found" });

  let quantResults = quantService.checkQuantitative(bank.institution_category, bankId, period_label);
  if (use_llm_mapping_check) {
    quantResults = await quantService.verifyMappings(quantResults, submitted_field_labels);
  }

  const qualResults = await qualService.checkQualitative({
    institutionCategory: bank.institution_category,
    bankId,
    sampleLimit: qual_sample_limit,
  });

  const report = reportService.generateReport(bank, quantResults, qualResults);

  let runId = null;
  if (persist) {
    runId = reportService.persistRun({ bankId, periodLabel: period_label, report, quantResults, qualResults });
  }

  res.json({ run_id: runId, report, quant_results: quantResults, qual_results: qualResults });
}

function listRuns(req, res) {
  res.json(reportService.listRuns(req.params.bankId));
}

function getRun(req, res) {
  const run = reportService.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: "run not found" });
  res.json(run);
}

/**
 * Runs the ADAPTIVE ROUTER (blueprint §5) instead of the fixed
 * quant→rule-engine / qual→LLM pipeline above. This is Route condition
 * "5" from the blueprint's baseline table (§5.4); runComplianceCheck
 * above IS baseline condition "4" (fixed hybrid) when you always call it
 * with the same quant/qual split. Compare their outputs on the same
 * bank+period to run the RQ1 experiment.
 */
async function runRoutedComplianceCheck(req, res) {
  const { bankId } = req.params;
  const { period_label, graph_data_available = false, qual_sample_limit = 40 } = req.body;
  if (!period_label) return res.status(400).json({ error: "period_label is required" });

  const results = await routedService.runRoutedCompliance({
    bankId,
    periodLabel: period_label,
    graphDataAvailable: graph_data_available,
    qualSampleLimit: qual_sample_limit,
  });

  const routeCounts = results.reduce((acc, r) => {
    acc[r.route || "SHORT_CIRCUIT"] = (acc[r.route || "SHORT_CIRCUIT"] || 0) + 1;
    return acc;
  }, {});

  res.json({
    bank_id: bankId,
    period_label,
    route_distribution: routeCounts,
    results,
  });
}

/**
 * Convenience endpoint for RQ1: runs BOTH the fixed-hybrid pipeline and
 * the adaptive router on the same bank+period and returns them side by
 * side with a per-clause agreement flag, so you don't have to manually
 * diff two separate API calls while writing up results.
 */
async function compareRoutingStrategies(req, res) {
  const { bankId } = req.params;
  const { period_label, qual_sample_limit = 40 } = req.body;
  if (!period_label) return res.status(400).json({ error: "period_label is required" });

  const bank = db.prepare(`SELECT * FROM banks WHERE bank_id = ?`).get(bankId);
  if (!bank) return res.status(404).json({ error: "bank not found" });

  const quantResults = quantService.checkQuantitative(bank.institution_category, bankId, period_label);
  const qualResults = await qualService.checkQualitative({ institutionCategory: bank.institution_category, bankId });
  const fixedByUri = new Map(
    [...quantResults.map((r) => [r.clause_uri, r.status]), ...qualResults.map((r) => [r.clause_uri, r.status])]
  );

  const routedResults = await routedService.runRoutedCompliance({
    bankId,
    periodLabel: period_label,
    qualSampleLimit: qual_sample_limit,
  });

  const comparison = routedResults.map((r) => {
    const fixedStatus = fixedByUri.get(r.clause_uri) ?? null;
    return {
      clause_uri: r.clause_uri,
      clause_type: r.clause_type,
      fixed_hybrid_status: fixedStatus,
      adaptive_router_route: r.route,
      adaptive_router_status: r.status,
      agree: fixedStatus === r.status,
    };
  });

  const agreementRate = comparison.length
    ? comparison.filter((c) => c.agree).length / comparison.length
    : null;

  res.json({ bank_id: bankId, period_label, agreement_rate: agreementRate, comparison });
}

module.exports = { runComplianceCheck, listRuns, getRun, runRoutedComplianceCheck, compareRoutingStrategies };
