/**
 * Runs the network check for one bank and period: loads the network from
 * the graph_* tables, resolves the applicable rules against the corpus,
 * evaluates, and (optionally) stores a frozen copy of the results.
 */
const db = require("../../config/db");
const store = require("./graphStore");
const graphRules = require("./graphRules");
const { evaluateNetwork, worst } = require("./graphEvaluator");

function runGraphCheck({ bankId, periodLabel, includeFlagged = true, persist = false, complianceRunId = null }) {
  if (!periodLabel) {
    const err = new Error("period_label is required");
    err.status = 400;
    throw err;
  }
  const network = store.getNetwork(bankId, periodLabel);
  const { bank, capital, profile } = network;
  const rules = graphRules.rulesFor(bank.institution_category, profile || {});
  const ruleSummary = rules.map((r) => ({
    key: r.key, kind: r.kind, label: r.label, base_label: r.base_label,
    verified: !!r.source_resolved?.verified, clause_uri: r.source_resolved?.clause_uri || null,
    reason: r.source_resolved?.verified ? null : r.source_resolved?.reason,
  }));

  const base = {
    bank_id: bankId,
    period_label: periodLabel,
    institution_category: bank.institution_category,
    capital,
    profile,
    rules: ruleSummary,
  };
  if (!rules.length) {
    return {
      ...base, has_data: network.exposures.length > 0, applicable: false,
      message: "No counterparty-concentration or related-party rules were found in the corpus for this institution category.",
      summary: null, results: [], groups: [], graph: { nodes: [], edges: [] }, notes: [],
    };
  }
  if (!network.exposures.length) {
    return {
      ...base, has_data: false, applicable: true,
      message: `No exposures entered for ${periodLabel}. Add counterparties and exposures (or load a sample network) to run the network check.`,
      summary: null, results: [], groups: [], graph: { nodes: [], edges: [] }, notes: [],
    };
  }

  const out = evaluateNetwork({
    category: bank.institution_category,
    profile: profile || {},
    capital: capital || {},
    network: { entities: network.entities, edges: network.edges },
    exposures: network.exposures,
    rules,
    includeFlagged,
  });

  const result = { ...base, graph_run_id: null, has_data: true, applicable: true, include_flagged: includeFlagged, ...out };
  if (persist) result.graph_run_id = persistGraphRun(result, complianceRunId);
  return result;
}

/** Store a frozen copy of a network check (optionally linked to a compliance run). */
function persistGraphRun(out, complianceRunId = null) {
  if (!out?.has_data || !out.summary) return null;
  return db.transaction(() => {
    const info = db
      .prepare(`INSERT INTO graph_check_runs (bank_id, period_label, compliance_run_id, summary_json) VALUES (?, ?, ?, ?)`)
      .run(out.bank_id, out.period_label, complianceRunId, JSON.stringify({ ...out.summary, group_list: out.groups, notes: out.notes, graph: out.graph }));
    const stmt = db.prepare(
      `INSERT INTO graph_check_results (graph_run_id, rule_key, clause_uri, status, detail_json) VALUES (?, ?, ?, ?, ?)`
    );
    for (const r of out.results) stmt.run(info.lastInsertRowid, r.rule_key, r.clause_uri, r.status, JSON.stringify(r));
    return info.lastInsertRowid;
  })();
}

function listGraphRuns(bankId) {
  return db
    .prepare(
      `SELECT graph_run_id, period_label, compliance_run_id, run_at, summary_json FROM graph_check_runs
       WHERE bank_id = ? ORDER BY run_at DESC, graph_run_id DESC`
    )
    .all(bankId)
    .map((r) => {
      const s = JSON.parse(r.summary_json);
      return { graph_run_id: r.graph_run_id, period_label: r.period_label, compliance_run_id: r.compliance_run_id, run_at: r.run_at,
        overall: s.overall, status_counts: s.status_counts, counterparties: s.counterparties, groups: s.groups };
    });
}

function getGraphRun({ graphRunId = null, complianceRunId = null }) {
  const run = graphRunId
    ? db.prepare("SELECT * FROM graph_check_runs WHERE graph_run_id = ?").get(graphRunId)
    : db.prepare("SELECT * FROM graph_check_runs WHERE compliance_run_id = ? ORDER BY graph_run_id DESC").get(complianceRunId);
  if (!run) return null;
  const results = db
    .prepare("SELECT detail_json FROM graph_check_results WHERE graph_run_id = ? ORDER BY result_id")
    .all(run.graph_run_id)
    .map((r) => JSON.parse(r.detail_json));
  const summary = JSON.parse(run.summary_json);
  const { group_list: groups = [], notes = [], graph = { nodes: [], edges: [] }, ...counts } = summary;
  return { graph_run_id: run.graph_run_id, bank_id: run.bank_id, period_label: run.period_label, run_at: run.run_at,
    compliance_run_id: run.compliance_run_id, has_data: true, summary: counts, groups, notes, graph, results };
}

/** clause_uri -> worst status, for the adaptive router's GRAPH route. */
function statusByClause(results) {
  const m = new Map();
  for (const r of results) {
    if (!r.clause_uri) continue;
    if (!m.has(r.clause_uri)) m.set(r.clause_uri, []);
    m.get(r.clause_uri).push(r);
  }
  return new Map([...m].map(([uri, rows]) => [uri, { status: worst(rows.map((r) => r.status)), results: rows }]));
}

module.exports = { runGraphCheck, persistGraphRun, listGraphRuns, getGraphRun, statusByClause };
