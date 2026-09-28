#!/usr/bin/env node
/**
 * Proof-of-concept evaluation of the network check on the SYNTHETIC
 * scenarios in eval/graph_scenarios.json (every entity and figure invented).
 * Each scenario lists the outcome RBI's text implies; this script runs the
 * evaluator with the rules resolved against the real corpus and reports
 * which expectations hold.
 *
 *   node scripts/eval_graph.js            (uses data/urcc_ef.db for rule sources)
 *   node scripts/eval_graph.js --offline  (skip corpus lookup; rules assumed verified)
 *
 * Limitation (state it next to any number this prints): evaluated on
 * synthetic ownership data; real deployment requires the bank's counterparty
 * data and registry (MCA) integration, not available in this study.
 */
const path = require("path");
const fs = require("fs");

const SCENARIOS = path.join(__dirname, "..", "eval", "graph_scenarios.json");

function rulesForScenario(sc, offline) {
  const graphRules = require("../src/services/graph/graphRules");
  if (offline) {
    return graphRules.RULES.filter((r) => r.category === sc.category)
      .filter((r) => !r.profile || Object.entries(r.profile).every(([k, v]) => (k === "nbfc_is_ifc" ? Number(sc.profile?.[k] || 0) === Number(v) : sc.profile?.[k] === v)))
      .map((r) => ({ ...r, base_label: graphRules.BASES[r.base] || null, source_resolved: { verified: true, clause_uri: `offline://${r.key}` } }));
  }
  return graphRules.rulesFor(sc.category, sc.profile || {});
}

function runScenario(sc, { offline = false } = {}) {
  const { evaluateNetwork } = require("../src/services/graph/graphEvaluator");
  const rules = rulesForScenario(sc, offline);
  return evaluateNetwork({
    category: sc.category,
    profile: sc.profile || {},
    capital: sc.capital || {},
    network: {
      entities: [{ entity_id: "SELF", name: "Reporting bank", entity_type: "self" }, ...sc.entities],
      edges: sc.edges.map((e, i) => ({ edge_id: i + 1, status: "confirmed", ...e })),
    },
    exposures: sc.exposures,
    rules,
    includeFlagged: true,
  });
}

/** Does one expectation hold? Returns {ok, got}. */
function checkExpectation(out, exp) {
  const rows = out.results.filter((r) => r.rule_key === exp.rule_key).filter((r) => {
    if (exp.subject) return r.subject?.id === exp.subject;
    if (exp.members_include) {
      const ids = (r.subject?.members || []).map((m) => m.id);
      return exp.members_include.every((m) => ids.includes(m));
    }
    return true;
  });
  if (exp.absent) return { ok: rows.length === 0, got: rows.length ? rows.map((r) => r.status).join(",") : "absent" };
  const hit = rows.find((r) => r.status === exp.status && (exp.exposure === undefined || Math.abs(r.exposure - exp.exposure) < 0.01));
  return { ok: !!hit, got: rows.length ? rows.map((r) => `${r.status}${r.exposure !== undefined ? ` @${r.exposure}` : ""}`).join(",") : "no result" };
}

function main() {
  const offline = process.argv.includes("--offline");
  const data = JSON.parse(fs.readFileSync(SCENARIOS, "utf8"));
  let pass = 0;
  let total = 0;
  for (const sc of data.scenarios) {
    const out = runScenario(sc, { offline });
    console.log(`\n${sc.id} (${sc.category}) - ${sc.title}`);
    for (const exp of sc.expected) {
      const { ok, got } = checkExpectation(out, exp);
      total += 1;
      pass += ok ? 1 : 0;
      const what = exp.subject || (exp.members_include ? `group{${exp.members_include.join(",")}}` : "aggregate");
      console.log(`  ${ok ? "ok  " : "FAIL"} ${exp.rule_key.padEnd(24)} ${what.padEnd(28)} expected ${exp.absent ? "absent" : exp.status}${exp.exposure !== undefined ? ` @${exp.exposure}` : ""}  got ${got}`);
    }
    const unverified = out.results.filter((r) => r.source && !r.source.verified);
    if (unverified.length) console.log(`  note: ${unverified.length} result(s) could not verify their rule source in the corpus`);
  }
  console.log(`\n${pass}/${total} expectations hold on ${data.scenarios.length} synthetic scenarios${offline ? " (offline: rule sources not checked)" : ""}.`);
  console.log("Evaluated on synthetic ownership data; real deployment requires the bank's counterparty data and MCA registry integration.");
  process.exit(pass === total ? 0 : 1);
}

if (require.main === module) main();

module.exports = { runScenario, checkExpectation };
