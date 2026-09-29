/**
 * Journal-alignment modules: decision labels, A–G taxonomy, versioned rules,
 * P(error) estimators, the adaptive router (Algorithm 1) and the
 * simplification meaning guard. Pure functions - no corpus needed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urcc-router-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  RELATIONAL_DB_PATH: path.join(tmp, "urcc_ef.db"),
  VECTOR_DB_PATH: path.join(tmp, "urcc_ef_vectors.db"),
  EMBEDDING_MODEL_DIR: path.join(tmp, "no-model"),
  EMBEDDING_ALLOW_REMOTE: "false",
  EMBED_MISSING_ON_START: "false",
  GEMINI_API_KEY: "",
});

const decisions = require("../src/services/decisions");
const { classifyRule } = require("../src/services/router/ruleTaxonomy");
const { versionAt } = require("../src/services/router/versionedRules");
const logistic = require("../src/services/router/logistic");
const tree = require("../src/services/router/tree");
const R = require("../src/services/router/adaptiveRouter");
const simplify = require("../src/services/simplifyService");

test("decisions: every status maps to one of the five journal decisions", () => {
  const five = new Set(Object.values(decisions.DECISIONS));
  assert.equal(five.size, 5);
  for (const [status, d] of Object.entries(decisions.STATUS_TO_DECISION)) assert.ok(five.has(d), status);
  assert.equal(decisions.decisionOf("BREACH"), "NON_COMPLIANT");
  assert.equal(decisions.decisionOf("PASS"), "COMPLIANT");
  assert.equal(decisions.decisionOf("NOT_REPORTED"), "INSUFFICIENT_DATA");
  assert.equal(decisions.decisionOf("NEEDS_REVIEW"), "REQUIRES_HUMAN_REVIEW");
  const counts = decisions.decisionCounts(decisions.withDecisions([{ status: "PASS" }, { status: "BREACH" }, { status: "BREACH" }]));
  assert.equal(counts.NON_COMPLIANT, 2);
});

test("decisions: a breach gets a quantified recommendation, a pass none", () => {
  const rec = decisions.recommendForRule({ status: "BREACH", reported_value: 8.2, threshold: 9, operator: ">=", unit: "%", label: "CRAR" });
  assert.match(rec, /at least 9/);
  assert.match(rec, /0\.8 percentage points/);
  assert.equal(decisions.recommendForRule({ status: "PASS", reported_value: 12, threshold: 9, operator: ">=", unit: "%" }), null);
});

test("taxonomy: A–G categories from clause text and atoms", () => {
  const t = (clause_text, atom = null, extra = {}) => classifyRule({ clause_text, atom, ...extra }).rule_type;
  assert.equal(t("CRAR shall be at least 9 per cent.", { operator: ">=", threshold_unit: "%" }), "A");
  assert.equal(t("If the bank is a scheduled bank, CRAR shall be at least 9 per cent.", { operator: ">=", threshold_unit: "%", sentence: "If the bank is a scheduled bank, CRAR shall be at least 9 per cent." }), "C");
  assert.equal(t("The bank shall report the fraud within 7 days.", { operator: "within_days", threshold_unit: "days" }), "D");
  assert.equal(t("The bank shall put in place a Board-approved policy on outsourcing."), "B");
  assert.equal(t("Loans to relatives of directors shall not be granted."), "F");
  assert.equal(t("Exposure to a group of connected counterparties shall not exceed 25 per cent.", { operator: "<=", threshold_unit: "%" }), "G");
  assert.equal(t("The bank shall exercise adequate due diligence."), "E");
  const c = classifyRule({ clause_text: "Capital adequacy shall be maintained.", doc_title: "Prudential Norms on Capital Adequacy" });
  assert.equal(c.risk_level, "high");
});

test("versioned rules: the version in force on a date", () => {
  const sched = { versions: [{ effective_from: "2025-09-06", value: 3.75 }, { effective_from: "2025-10-04", value: 3.5 }, { effective_from: "2025-11-29", value: 3.0 }] };
  assert.equal(versionAt(sched, "2025-09-01"), null);
  assert.equal(versionAt(sched, "2025-10-10").value, 3.5);
  assert.equal(versionAt(sched, "2026-01-01").value, 3.0);
});

test("estimators: logistic and tree learn a separable error pattern", () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 200; i++) {
    const a = i % 2;
    X.push([a, (i % 7) / 7]);
    y.push(a);
  }
  const lr = logistic.train(X, y);
  assert.ok(logistic.predict(lr, [1, 0.5]) > 0.8);
  assert.ok(logistic.predict(lr, [0, 0.5]) < 0.2);
  const tr = tree.train(X, y);
  assert.ok(tree.predict(tr, [1, 0.5]) > 0.9);
  assert.ok(tree.predict(tr, [0, 0.5]) < 0.1);
});

function features(over = {}) {
  return { ...Object.fromEntries(R.FEATURE_NAMES.map((k) => [k, 0])), historical_accuracy_deterministic: 0.5, historical_accuracy_rag_llm: 0.5, risk_level: 1, ...over };
}
const constModel = (pDet, pRag) => ({
  human_error_rate: 0.02,
  cost_model: JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "cost_model.json"), "utf8")),
  error_models: { DETERMINISTIC: { kind: "tree", root: { leaf: true, p: pDet } }, RAG_LLM: { kind: "tree", root: { leaf: true, p: pRag } } },
  params: { alpha: 1, beta: 1, gamma: 0, min_evidence: 0.5 },
});

test("router: Algorithm 1 gates, hard override and argmin", () => {
  const m = constModel(0.3, 0.1);
  assert.equal(R.routeAdaptive(features({ evidence_completeness: 0 }), m).decision, "INSUFFICIENT_DATA");
  assert.equal(R.routeAdaptive(features({ evidence_completeness: 0.25 }), m).route, "HUMAN");
  // complete structured evidence for a deterministic rule → rule engine, whatever P(error) says
  assert.equal(R.routeAdaptive(features({ evidence_completeness: 1, rule_engine_applicability: 1 }), m).route, "DETERMINISTIC");
  // ... unless the narrative contradicts the structured evidence
  assert.equal(R.routeAdaptive(features({ evidence_completeness: 1, rule_engine_applicability: 1, text_structured_conflict: 1 }), m).route, "RAG_LLM");
  // otherwise argmin of expected cost: the lower error route wins
  assert.equal(R.routeAdaptive(features({ evidence_completeness: 0.75 }), constModel(0.05, 0.4)).route, "DETERMINISTIC");
  // a no-human operating point never escalates
  const auto = R.routeAdaptive(features({ evidence_completeness: 0.25 }), constModel(0.9, 0.9), { params: { no_human: true } });
  assert.notEqual(auto.route, "HUMAN");
});

test("router: features from rule and evidence", () => {
  const rule = { rule_type: "A", field: "crar", required_fields: ["crar"], risk_level: "high" };
  const f = R.buildFeatures(rule, { structured: { crar: 12 }, narrative: "CRAR was 12 per cent. However, the inspection found it was not computed correctly." }, { relevance: 0.8 });
  assert.equal(f.rule_type_A, 1);
  assert.equal(f.evidence_completeness, 1);
  assert.equal(f.rule_engine_applicability, 1);
  assert.equal(f.text_structured_conflict, 1);
  const g = R.buildFeatures(rule, { structured: {}, narrative: null }, { relevance: 0 });
  assert.equal(g.evidence_completeness, 0);
  assert.equal(g.rule_engine_applicability, 0);
});

test("router: policy falls back to the heuristic router without an adopted model", () => {
  const prev = process.env.ROUTER_POLICY;
  delete process.env.ROUTER_POLICY;
  assert.equal(R.activePolicy(null), "heuristic");
  assert.equal(R.activePolicy({ error_models: {}, adopted_in_system: false }), "heuristic");
  assert.equal(R.activePolicy({ error_models: {}, adopted_in_system: true }), "adaptive");
  process.env.ROUTER_POLICY = "heuristic";
  assert.equal(R.activePolicy({ error_models: {}, adopted_in_system: true }), "heuristic");
  if (prev === undefined) delete process.env.ROUTER_POLICY;
  else process.env.ROUTER_POLICY = prev;
});

test("simplification: numbers, polarity and exceptions are preserved", () => {
  const src = "The carrying value of investments sold out of HTM shall not exceed five per cent of the opening carrying value, provided that the Board approves the sale in terms of its policy.";
  const out = simplify.simplifyRules(src);
  assert.match(out.text, /must not exceed 5%/);
  assert.match(out.text, /provided that/i);
  assert.ok(simplify.preserves(src, out.text).ok);
  assert.equal(simplify.preserves(src, "It must not exceed 6% of the opening value.").ok, false);
  assert.equal(simplify.preserves("A bank shall not lend to X.", "A bank can lend to X.").ok, false);
  assert.ok(simplify.fkgl(src) > 5);
});
