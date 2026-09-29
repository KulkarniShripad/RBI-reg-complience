/**
 * The reasoning modalities the router chooses between (journal Sec. VIII),
 * each taking a (rule, evidence) pair and returning a decision plus the
 * evidence trace:
 *
 *   DETERMINISTIC  the rule engine (operator / threshold / Boolean / condition,
 *                  version-aware, with conflict detection across sources); for
 *                  multi-entity rules (category G) the deterministic engine is
 *                  the network (graph) evaluator
 *   RAG_LLM        the rule's clause from the knowledge base + the evidence,
 *                  judged by the LLM (or the offline surrogate judge); cites the
 *                  rule's clause
 *   LLM_ONLY       baseline B2: no link to the rule in the knowledge base, the
 *                  judge must find the provision itself among the directions of
 *                  the bank's category (its citation can be wrong)
 *   HUMAN          escalation: REQUIRES_HUMAN_REVIEW
 *
 * Input shape (the benchmark case shape, also built for live data):
 *   rule:  {rule_type, operator, threshold, unit, field, metric, clause_uri, clause_text,
 *           category, required_fields, versioned?}
 *   input: {structured:{...}, sources?:[{...}], narrative?:string, expectation?, as_of_date?}
 */
const versioned = require("./versionedRules");
const { decisionOf } = require("../decisions");

const OPS = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, ">": (v, t) => v > t, "<": (v, t) => v < t, within_days: (v, t) => v <= t };

// ── deterministic ──

function thresholdFor(rule, input) {
  if (rule.versioned) {
    const sched = versioned.schedule(rule.versioned.category || rule.category, rule.versioned.rule);
    const asOf = input.structured?.as_of_date || input.as_of_date;
    if (!sched) return { error: "versioned rule not found in the corpus" };
    if (!asOf) return { error: "as-of date missing for a date-dependent rule" };
    const v = versioned.versionAt(sched, asOf);
    if (!v) return { error: `no version of the rule in force on ${asOf}` };
    return { threshold: v.threshold, version: v.version, effective_from: v.effective_from };
  }
  return { threshold: rule.threshold };
}

function evalValue(rule, value, input) {
  if (value === null || value === undefined || value === "") return { decision: "INSUFFICIENT_DATA", reason: `${rule.metric || rule.field} not reported` };
  if (typeof value === "boolean") return { decision: value ? "COMPLIANT" : "NON_COMPLIANT", reason: `requirement_met = ${value}` };
  const th = thresholdFor(rule, input);
  if (th.error) return { decision: "INSUFFICIENT_DATA", reason: th.error };
  const op = OPS[rule.operator];
  if (!op || th.threshold === null || th.threshold === undefined) return { decision: "INSUFFICIENT_DATA", reason: "rule has no evaluable operator / threshold" };
  const ok = op(Number(value), Number(th.threshold));
  return { decision: ok ? "COMPLIANT" : "NON_COMPLIANT", reason: `${value} ${rule.operator} ${th.threshold}${th.version ? ` (version ${th.version}, from ${th.effective_from})` : ""}: ${ok ? "met" : "not met"}` };
}

function ruleEngine(rule, input) {
  const t0 = process.hrtime.bigint();
  const done = (r) => ({ ...r, modality: "RULE_ENGINE", cited_clause: rule.clause_uri, latency_ms: Number(process.hrtime.bigint() - t0) / 1e6 });
  const st = input.structured || {};
  if (rule.rule_type === "C") {
    if (st.condition_met === undefined || st.condition_met === null) return done({ decision: "INSUFFICIENT_DATA", reason: "whether the rule's condition applies is not reported" });
    if (st.condition_met === false) return done({ decision: "COMPLIANT", reason: "condition not met: requirement not triggered" });
  }
  if (rule.field === "requirement_met" || rule.field === "narrative" || !rule.field) {
    if (typeof st.requirement_met === "boolean") return done(evalValue(rule, st.requirement_met, input));
    return done({ decision: "INSUFFICIENT_DATA", reason: "no structured field the rule engine can test (requirement needs interpretation)" });
  }
  // conflict detection across sources (journal Table II, layer 9)
  if (Array.isArray(input.sources) && input.sources.length > 1) {
    const verdicts = input.sources.map((s) => evalValue(rule, s[rule.field], { ...input, structured: { ...st, ...s } }));
    const kinds = new Set(verdicts.map((v) => v.decision));
    if (kinds.size > 1) return done({ decision: "REQUIRES_HUMAN_REVIEW", reason: `sources disagree: ${verdicts.map((v) => v.reason).join(" / ")}` });
  }
  return done(evalValue(rule, st[rule.field], input));
}

const scenarioCache = new Map();
function graphEngine(rule, input) {
  const t0 = process.hrtime.bigint();
  const { runScenario, checkExpectation } = require("../../../scripts/eval_graph");
  const scenarios = require("../../../eval/graph_scenarios.json").scenarios;
  const id = input.structured?.network_scenario;
  const sc = scenarios.find((s) => s.id === id);
  let decision = "INSUFFICIENT_DATA";
  let reason = "no network data";
  if (sc && input.expectation) {
    if (!scenarioCache.has(id)) scenarioCache.set(id, runScenario(sc, { offline: true }));
    const out = scenarioCache.get(id);
    const rows = out.results.filter((r) => r.rule_key === input.expectation.rule_key).filter((r) => {
      const e = input.expectation;
      if (e.subject) return r.subject?.id === e.subject;
      if (e.members_include) return e.members_include.every((m) => (r.subject?.members || []).some((x) => x.id === m));
      return true;
    });
    const row = rows[0];
    decision = row ? decisionOf(row.status) : "COMPLIANT";
    reason = row ? `${row.rule_label}: ${row.status}` : "nothing in the network triggers the rule";
  }
  return { decision, reason, modality: "GRAPH", cited_clause: rule.clause_uri, latency_ms: Number(process.hrtime.bigint() - t0) / 1e6 };
}

function deterministic(rule, input) {
  return rule.rule_type === "G" ? graphEngine(rule, input) : ruleEngine(rule, input);
}

// ── LLM paths ──

/** What the LLM is shown as evidence: structured fields as text, then the narrative. */
function evidenceText(rule, input) {
  const st = input.structured || {};
  const lines = [];
  for (const [k, v] of Object.entries(st)) {
    if (k === "network_scenario") continue;
    if (k === "requirement_met") lines.push(`Requirement met (as reported by the bank): ${v ? "yes" : "no"}.`);
    else if (k === "condition_met") lines.push(`Condition applies to the bank: ${v ? "yes" : "no"}.`);
    else if (k === "as_of_date") lines.push(`Reporting date: ${v}.`);
    else lines.push(`Reported ${k === rule.field ? rule.metric : k}: ${v}${rule.unit === "%" ? "%" : rule.unit === "days" || rule.unit === "working_days" ? " days" : rule.unit ? ` ${rule.unit}` : ""}.`);
  }
  for (const s of input.sources || []) {
    lines.push(`${s.source}: ${rule.metric} ${s[rule.field]}${rule.unit === "%" ? "%" : ""}.`);
  }
  if (input.narrative) lines.push(input.narrative);
  return lines.join(" ");
}

async function ragLlm(rule, input, judge) {
  const ev = evidenceText(rule, input);
  const r = await judge.fn({ clauseText: rule.clause_text, evidenceText: ev, asOf: input.structured?.as_of_date });
  return {
    decision: r.decision,
    reason: r.justification,
    modality: "RAG_LLM",
    cited_clause: rule.clause_uri, // grounded: the rule's clause from the knowledge base
    judge: judge.name,
    latency_ms: r.latency_ms,
    prompt_chars: (rule.clause_text || "").length + ev.length,
  };
}

/**
 * Baseline B2: the judge gets the evidence and must locate the provision among
 * the directions of the bank's category itself (no rule linkage, no retrieval
 * grounding). `locate` returns {clause_uri, clause_text} of its best guess.
 */
async function llmOnly(rule, input, judge, locate) {
  const ev = evidenceText(rule, input);
  const found = await locate(rule, ev);
  const r = await judge.fn({ clauseText: found?.clause_text || "", evidenceText: ev, asOf: input.structured?.as_of_date });
  return {
    decision: r.decision,
    reason: r.justification,
    modality: "LLM_ONLY",
    cited_clause: found?.clause_uri || null,
    judge: judge.name,
    latency_ms: r.latency_ms,
    prompt_chars: 12000 + ev.length, // whole directions in context (capped budget)
  };
}

function human() {
  return { decision: "REQUIRES_HUMAN_REVIEW", reason: "escalated to a human reviewer", modality: "HUMAN", cited_clause: null, latency_ms: 0 };
}

module.exports = { deterministic, ruleEngine, graphEngine, ragLlm, llmOnly, human, evidenceText, OPS };
