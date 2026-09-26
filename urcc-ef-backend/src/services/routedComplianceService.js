/**
 * Runs the ADAPTIVE ROUTER (routingService.js) across every clause
 * applicable to a bank, as opposed to complianceController's fixed
 * pipeline (which always sends quantitative clauses to the rule engine
 * and qualitative clauses to Gemini — that fixed pipeline IS your
 * "fixed hybrid" baseline from the blueprint's §5.4 baseline list).
 *
 * Comparing this service's output against complianceController's output,
 * on the same bank+period, is the RQ1 experiment from the blueprint.
 */
const db = require("../config/db");
const routing = require("./routingService");
const quantService = require("./quantComplianceService");
const qualService = require("./qualComplianceService");
const vectorSearch = require("./vectorSearchService");

const OPERATORS = {
  "<=": (v, t) => v <= t,
  ">=": (v, t) => v >= t,
  within_days: (v, t) => v <= t,
};

async function runRoutedCompliance({ bankId, periodLabel, graphDataAvailable = false, qualSampleLimit = 40 }) {
  const bank = db.prepare(`SELECT * FROM banks WHERE bank_id = ?`).get(bankId);
  if (!bank) throw new Error("bank not found");

  // Every clause applicable to this bank's category - both quant and qual,
  // in ONE pool, because the whole point of the router is that clause
  // TYPE is a signal it reasons about, not a pre-sorted queue.
  const allClauses = db
    .prepare(
      `SELECT cr.clause_uri, cr.clause_type, cr.confidence, cr.needs_llm_refinement,
              cr.clause_text, cr.page_number, d.rbi_ref,
              ra.rule_id, ra.operator, ra.threshold_value, ra.threshold_unit
       FROM clause_registry cr
       JOIN documents d ON cr.doc_id = d.doc_id
       LEFT JOIN rule_atoms ra ON ra.clause_uri = cr.clause_uri
       WHERE d.institution_category = ?`
    )
    .all(bank.institution_category);

  // Keep routed runs bounded for interactive use. Quantitative and other
  // structured clauses are retained; qualitative clauses use the same
  // sample-size contract as the fixed-hybrid endpoint.
  const clauses = [
    ...allClauses.filter((clause) => clause.rule_id != null),
    ...allClauses.filter((clause) => clause.clause_type === "qualitative").slice(0, qualSampleLimit),
  ];

  const evidenceRows = db
    .prepare(`SELECT evidence_text FROM bank_qual_evidence WHERE bank_id = ?`)
    .all(bankId)
    .map((r) => r.evidence_text);

  // Qualitative retrieval and judgment are run once for the selected sample.
  // Re-running the whole sample for every clause creates quadratic work and
  // repeatedly starts Python workers for the same evidence pool.
  const qualitativeResults = evidenceRows.length
    ? await qualService.checkQualitative({
        institutionCategory: bank.institution_category,
        bankId,
        sampleLimit: qualSampleLimit,
      })
    : [];

  const results = [];

  for (const clause of clauses) {
    const ruleAtom = clause.rule_id
      ? { operator: clause.operator, threshold_value: clause.threshold_value, threshold_unit: clause.threshold_unit }
      : null;

    // --- gather routing signals ---
    let evidenceAvailable = false;
    let reportedValue = null;
    if (ruleAtom) {
      const sub = db
        .prepare(
          `SELECT reported_value FROM bank_quant_submissions WHERE bank_id = ? AND rule_id = ? AND period_label = ?`
        )
        .get(bankId, clause.rule_id, periodLabel);
      evidenceAvailable = !!sub;
      reportedValue = sub?.reported_value ?? null;
    } else if (clause.clause_type === "qualitative") {
      evidenceAvailable = evidenceRows.length > 0;
    } else {
      evidenceAvailable = true; // relational/procedural clauses with no data requirement yet - don't short-circuit
    }

    let retrievalTopScore = null;
    let retrievalSecondScore = null;
    if (clause.clause_type === "qualitative" && evidenceRows.length > 0) {
      try {
        const ranked = await vectorSearch.rankTexts(clause.clause_text, evidenceRows);
        retrievalTopScore = ranked[0]?.score ?? null;
        retrievalSecondScore = ranked[1]?.score ?? null;
      } catch (e) {
        // leave scores null - router treats this as "no retrieval score available"
      }
    }

    // Prior agreement: has this clause_uri previously disagreed between
    // routes across past runs? Cheap heuristic using routing_decisions
    // history - real disagreement detection would compare final_status
    // across route types for the same clause; kept simple here.
    const priorRow = db
      .prepare(
        `SELECT chosen_route, final_status FROM routing_decisions
         WHERE bank_id = ? AND clause_uri = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(bankId, clause.clause_uri);
    const priorAgreement = priorRow ? "NO_HISTORY" : "NO_HISTORY"; // v0: disagreement detection needs 2+ distinct routes tried; left as NO_HISTORY until that data exists

    const riskTier = clause.clause_type === "quantitative" ? "high" : "standard";

    const decision = routing.route(
      { clause_type: clause.clause_type, confidence: clause.confidence, needs_llm_refinement: clause.needs_llm_refinement },
      ruleAtom,
      {
        evidenceAvailable,
        graphDataAvailable,
        retrievalTopScore,
        retrievalSecondScore,
        evidencePoolSize: evidenceRows.length,
        priorAgreement,
        riskTier,
      }
    );

    // --- execute the chosen route ---
    let finalStatus = decision.decision;
    let detail = {};

    if (decision.route === routing.ROUTES.RULE_ENGINE) {
      const evaluator = OPERATORS[ruleAtom.operator];
      finalStatus = evaluator && evaluator(reportedValue, ruleAtom.threshold_value) ? "PASS" : "BREACH";
      detail = { reported_value: reportedValue, rule: `${ruleAtom.operator} ${ruleAtom.threshold_value}${ruleAtom.threshold_unit}` };
    } else if (decision.route === routing.ROUTES.RAG_LLM) {
      const match = qualitativeResults.find((r) => r.clause_uri === clause.clause_uri);
      finalStatus = match?.status ?? "NEEDS_REVIEW";
      detail = { llm_judgment: match?.llm_judgment ?? null, best_evidence_text: match?.best_evidence_text ?? null };
    } else if (decision.route === routing.ROUTES.GRAPH) {
      finalStatus = "NOT_IMPLEMENTED"; // design-only per blueprint §7 - never reached while graphDataAvailable stays false
    }
    // HUMAN and INSUFFICIENT_DATA already have finalStatus set from decision.decision

    db.prepare(
      `INSERT INTO routing_decisions (bank_id, clause_uri, clause_type, chosen_route, decision, reasons_json, final_status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(bankId, clause.clause_uri, clause.clause_type, decision.route, decision.decision, JSON.stringify(decision.reasons), finalStatus);

    results.push({
      clause_uri: clause.clause_uri,
      rbi_ref: clause.rbi_ref,
      page_number: clause.page_number,
      clause_type: clause.clause_type,
      clause_text: clause.clause_text,
      route: decision.route,
      routing_reasons: decision.reasons,
      status: finalStatus,
      detail,
    });
  }

  return results;
}

module.exports = { runRoutedCompliance };
