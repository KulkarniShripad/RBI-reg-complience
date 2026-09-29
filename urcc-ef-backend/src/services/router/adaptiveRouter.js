/**
 * Adaptive reasoning-modality router (journal Sec. VIII, Algorithm 1).
 *
 *   ρ(r, E) → m ∈ {DETERMINISTIC, RAG_LLM, HUMAN}
 *
 *   1. features ← Table V feature vector of (rule, evidence)
 *   2. evidence_completeness = 0            → INSUFFICIENT_DATA (decline; no modality)
 *      evidence_completeness < MIN_EVIDENCE → HUMAN
 *   3. HARD OVERRIDE: rule_engine_applicability = 1 and evidence_completeness = 1
 *      and no narrative contradicting the structured evidence
 *                                          → DETERMINISTIC (correct by construction)
 *   4. otherwise m* = argmin_m  α·P(error | m, f)·risk_weight + β·money(m) + γ·latency_s(m)
 *      with P(error | m, f) from a logistic model trained on the benchmark's
 *      training split, and α, β, γ, MIN_EVIDENCE chosen on the validation split
 *      subject to accuracy ≥ τ_acc.
 *
 * DETERMINISTIC is the rule engine, or the network (graph) evaluator for
 * multi-entity rules (category G).
 *
 * Also here: the baseline routers R1 (static rule-first), R2 (confidence
 * threshold), R3 (fixed hybrid table) and R0 (the earlier hand-written router,
 * routingService.js), so every router is evaluated through the same code path.
 */
const fs = require("fs");
const path = require("path");
const logistic = require("./logistic");
const tree = require("./tree");
const { RISK_WEIGHT } = require("./ruleTaxonomy");
const legacyRouter = require("../routingService");

const MODEL_PATH = path.join(__dirname, "..", "..", "..", "eval", "router_model.json");
const TYPES = ["A", "B", "C", "D", "E", "F", "G"];
const ROUTES = ["DETERMINISTIC", "RAG_LLM", "HUMAN"];

const FEATURE_NAMES = [
  ...TYPES.map((t) => `rule_type_${t}`),
  "requires_semantic_interpretation",
  "structured_field_availability",
  "retrieval_confidence",
  "rule_engine_applicability",
  "evidence_completeness",
  "historical_accuracy_deterministic",
  "historical_accuracy_rag_llm",
  "risk_level",
  "source_conflict",
  "narrative_present",
  "text_structured_conflict",
  "text_uncertainty_cue",
];

// cues read from the narrative (no model): a contrast followed by a negation,
// or in-progress / intention wording
const CONTRAST_NEG = /\b(?:however|but|whereas|on the other hand)\b[^.]{0,200}\b(?:not|no|never|failed to|yet to|without|lack(?:s|ing)?)\b/i;
const UNCERTAIN = /\b(?:plans? to|intends? to|proposes? to|in due course|under preparation|draft|partially|started work|expected to be completed|in the process|being considered|awaited|under watch|flagged)\b/i;

const DETERMINISTIC_TYPES = new Set(["A", "C", "D", "G"]);

/**
 * Table V features for a (rule, evidence) pair.
 * @param {object} rule   {rule_type, requires_semantic_interpretation, risk_level, field, required_fields}
 * @param {object} input  {structured, sources, narrative}
 * @param {{relevance:number, numericInText:boolean, history?:object}} ctx
 */
function buildFeatures(rule, input, ctx) {
  const st = input.structured || {};
  const has = (k) => st[k] !== undefined && st[k] !== null && st[k] !== "";
  const required = [...(rule.required_fields || [rule.field])];
  if (rule.rule_type === "C" && !required.includes("condition_met")) required.push("condition_met");
  if (rule.rule_type === "G") required.splice(0, required.length, "network_scenario");
  const structuredReq = required.filter((k) => k !== "narrative");
  const structuredAvail = structuredReq.length ? structuredReq.filter(has).length / structuredReq.length : 0;
  const relevant = (ctx.relevance ?? 0) >= 0.6;
  const perField = required.map((k) => {
    if (k === "narrative") return relevant && input.narrative ? 1 : 0;
    if (has(k)) return 1;
    // stated only in text: partial evidence
    if (relevant && (k === "requirement_met" || ctx.numericInText)) return 0.5;
    return 0;
  });
  const completeness = perField.length ? perField.reduce((a, b) => a + b, 0) / perField.length : 0;
  const deterministicRule = DETERMINISTIC_TYPES.has(rule.rule_type) || (rule.rule_type === "B" && has("requirement_met"));
  const ruleEngineApplicable = deterministicRule && structuredReq.length > 0 && structuredAvail === 1 ? 1 : 0;
  const hist = ctx.history || {};
  const f = {
    ...Object.fromEntries(TYPES.map((t) => [`rule_type_${t}`, rule.rule_type === t ? 1 : 0])),
    requires_semantic_interpretation: rule.requires_semantic_interpretation ? 1 : 0,
    structured_field_availability: structuredAvail,
    retrieval_confidence: Math.max(0, Math.min(1, ctx.relevance ?? 0)),
    rule_engine_applicability: ruleEngineApplicable,
    evidence_completeness: Number(completeness.toFixed(3)),
    historical_accuracy_deterministic: hist[`${rule.rule_type}:DETERMINISTIC`] ?? 0.5,
    historical_accuracy_rag_llm: hist[`${rule.rule_type}:RAG_LLM`] ?? 0.5,
    risk_level: (RISK_WEIGHT[rule.risk_level] || 2) / 3,
    source_conflict: ctx.sourceConflict ? 1 : 0,
    narrative_present: input.narrative ? 1 : 0,
    // structured evidence present, yet the narrative contradicts it
    text_structured_conflict: structuredAvail > 0 && CONTRAST_NEG.test(input.narrative || "") ? 1 : 0,
    text_uncertainty_cue: UNCERTAIN.test(input.narrative || "") ? 1 : 0,
  };
  return f;
}

const vec = (f) => FEATURE_NAMES.map((k) => Number(f[k]) || 0);

// ── cost model ──

function expectedCost(route, f, costModel, promptChars = 1500) {
  if (route === "DETERMINISTIC") return { money: costModel.rule_engine.usd_per_case, latency_s: costModel.rule_engine.latency_ms / 1000 };
  if (route === "RAG_LLM") {
    const tin = costModel.llm.prompt_overhead_tokens + promptChars / 4;
    const money = (tin * costModel.llm.usd_per_1m_input + costModel.llm.output_tokens * costModel.llm.usd_per_1m_output) / 1e6;
    return { money, latency_s: (costModel.llm.latency_ms + costModel.retrieval.latency_ms) / 1000 };
  }
  return { money: costModel.human.usd_per_case, latency_s: costModel.human.latency_ms / 1000 };
}

function perror(model, route, x) {
  if (route === "HUMAN") return model.human_error_rate;
  const m = model.error_models[route];
  if (!m) return 0.5;
  return m.kind === "tree" ? tree.predict(m, x) : logistic.predict(m, x);
}

/**
 * Algorithm 1.
 * @returns {{route:string|null, decision:string|null, reasons:string[], costs?:object}}
 */
function routeAdaptive(f, model, { promptChars, costModel, params } = {}) {
  const p = { ...model.params, ...(params || {}) };
  const cm = costModel || model.cost_model;
  const reasons = [];
  if (p.completeness_gate !== false) {
    if (f.evidence_completeness === 0) {
      reasons.push("no required evidence field is present: declined (INSUFFICIENT_DATA)");
      return { route: null, decision: "INSUFFICIENT_DATA", reasons };
    }
    if (f.evidence_completeness < p.min_evidence && !p.no_human) {
      reasons.push(`evidence completeness ${f.evidence_completeness} < ${p.min_evidence}: human review`);
      return { route: "HUMAN", decision: "REQUIRES_HUMAN_REVIEW", reasons };
    }
  }
  if (p.hard_override !== false && f.rule_engine_applicability === 1 && f.evidence_completeness === 1 && !f.text_structured_conflict) {
    reasons.push("hard override: fully deterministic rule with complete, uncontradicted structured evidence → deterministic engine");
    return { route: "DETERMINISTIC", decision: null, reasons };
  }
  const x = vec(f);
  const costs = {};
  for (const r of ROUTES.filter((x) => !(p.no_human && x === "HUMAN"))) {
    const pe = p.learned === false ? 1 - (r === "DETERMINISTIC" ? f.historical_accuracy_deterministic : r === "RAG_LLM" ? f.historical_accuracy_rag_llm : 1 - model.human_error_rate) : perror(model, r, x);
    const c = expectedCost(r, f, cm, promptChars);
    const risk = f.risk_level * 3;
    costs[r] = { p_error: Number(pe.toFixed(4)), money: c.money, latency_s: c.latency_s, cost: p.alpha * pe * risk + p.beta * c.money + p.gamma * c.latency_s };
  }
  const best = Object.keys(costs).reduce((a, b) => (costs[b].cost < costs[a].cost ? b : a));
  reasons.push(`argmin cost: ${Object.keys(costs).map((r) => `${r}=${costs[r].cost.toFixed(4)} (p_err ${costs[r].p_error})`).join(", ")}`);
  return { route: best, decision: best === "HUMAN" ? "REQUIRES_HUMAN_REVIEW" : null, reasons, costs };
}

// ── baseline routers ──

/** R1: always try the rule engine; fall back to RAG+LLM only when structured inputs are missing. */
function routeStatic(f) {
  return { route: f.rule_engine_applicability === 1 ? "DETERMINISTIC" : "RAG_LLM", decision: null, reasons: ["R1 static rule-first"] };
}
/** R2: single confidence threshold. */
function routeThreshold(f, theta) {
  if (f.rule_engine_applicability === 1) return { route: "DETERMINISTIC", decision: null, reasons: ["R2: rule engine applicable"] };
  if (f.retrieval_confidence >= theta) return { route: "RAG_LLM", decision: null, reasons: [`R2: retrieval confidence ≥ ${theta}`] };
  return { route: "HUMAN", decision: "REQUIRES_HUMAN_REVIEW", reasons: [`R2: retrieval confidence < ${theta}`] };
}
/** R3 (= baseline B4): hand-authored rule_type → route table. */
function routeFixed(ruleType) {
  return { route: ["A", "B", "C", "D", "G"].includes(ruleType) ? "DETERMINISTIC" : "RAG_LLM", decision: null, reasons: [`R3 fixed table: type ${ruleType}`] };
}
/** R0: the hand-written router already in the system (routingService.js), fed the same case. */
function routeLegacy(rule, f, ctx) {
  const clauseType = ["A", "C", "D"].includes(rule.rule_type) ? "quantitative" : rule.rule_type === "F" || rule.rule_type === "G" ? "relational" : "qualitative";
  const r = legacyRouter.route(
    { clause_type: clauseType, confidence: "high", needs_llm_refinement: 0 },
    ["A", "C", "D"].includes(rule.rule_type) && f.rule_engine_applicability ? { operator: rule.operator, threshold_value: rule.threshold, threshold_unit: rule.unit } : null,
    {
      evidenceAvailable: f.evidence_completeness > 0,
      graphDataAvailable: rule.rule_type === "G",
      graphCovers: rule.rule_type === "G",
      retrievalTopScore: ctx.relevance ?? null,
      retrievalSecondScore: ctx.secondRelevance ?? null,
      evidencePoolSize: ctx.sentences ?? 1,
      priorAgreement: "NO_HISTORY",
      riskTier: rule.risk_level === "high" ? "high" : "standard",
    }
  );
  const map = { RULE_ENGINE: "DETERMINISTIC", GRAPH: "DETERMINISTIC", RAG_LLM: "RAG_LLM", HUMAN: "HUMAN" };
  return { route: r.route ? map[r.route] : null, decision: r.decision || null, reasons: r.reasons };
}

// ── use in the running system ──

/**
 * Router policy of the running system: "adaptive" when the trained model says
 * it was adopted (it beat the earlier heuristic router in evaluation), else
 * "heuristic". ROUTER_POLICY=adaptive|heuristic overrides.
 */
function activePolicy(model = loadModel()) {
  const env = String(process.env.ROUTER_POLICY || "").toLowerCase();
  if (env === "heuristic") return "heuristic";
  if (!model || !model.error_models) return "heuristic";
  if (env === "adaptive") return "adaptive";
  return model.adopted_in_system ? "adaptive" : "heuristic";
}

/**
 * Algorithm 1 for one clause of a routed run.
 * @param {object} clause  {clause_text, clause_type, title, rule_id, operator, threshold_unit}
 * @param {{hasStructuredValue:boolean, graphCovers:boolean, graphData:boolean,
 *          narrative:string|null, retrievalTopScore:number|null}} s
 * @returns {{route:'DETERMINISTIC'|'RAG_LLM'|'HUMAN'|null, decision:string|null, reasons:string[], rule_type:string}}
 */
function routeClause(clause, s, model = loadModel()) {
  const { classifyRule } = require("./ruleTaxonomy");
  const tax = classifyRule({
    clause_text: clause.clause_text,
    clause_type: clause.clause_type,
    doc_title: clause.title,
    atom: clause.rule_id ? { operator: clause.operator, threshold_unit: clause.threshold_unit, sentence: clause.sentence } : null,
    graphCovered: s.graphCovers,
  });
  const field = tax.rule_type === "G" ? "network_scenario" : clause.rule_id ? `atom_${clause.rule_id}` : "narrative";
  const structured = {};
  if (tax.rule_type === "G" && s.graphData) structured.network_scenario = 1;
  else if (clause.rule_id && s.hasStructuredValue) structured[field] = 1;
  // conditional limits: whether the condition applies is not held as data
  const rule = { ...tax, field, required_fields: [field] };
  const f = buildFeatures(rule, { structured, narrative: s.narrative || null }, {
    relevance: s.retrievalTopScore ?? 0,
    numericInText: false,
    history: model.history,
  });
  const out = routeAdaptive(f, model, { promptChars: 1500 });
  return { ...out, rule_type: tax.rule_type, features: f };
}

// ── model persistence ──

function loadModel(file = MODEL_PATH) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return null;
  }
}

function saveModel(model, file = MODEL_PATH) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(model, null, 1));
}

module.exports = {
  FEATURE_NAMES,
  ROUTES,
  TYPES,
  buildFeatures,
  vec,
  expectedCost,
  routeAdaptive,
  routeStatic,
  routeThreshold,
  routeFixed,
  routeLegacy,
  loadModel,
  saveModel,
  MODEL_PATH,
  activePolicy,
  routeClause,
};
