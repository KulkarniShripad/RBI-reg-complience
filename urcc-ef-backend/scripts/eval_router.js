#!/usr/bin/env node
/**
 * Adaptive Compliance Checking evaluation (journal Sec. XII, XIV.A, XV.A,
 * XVI.A, XVII.A) on the rule-grounded synthetic benchmark.
 *
 *   1. run every modality on every case: deterministic engine, RAG + LLM,
 *      LLM-only (baseline B2) and human escalation
 *   2. Table V features for every case; historical accuracy per (rule type,
 *      modality) from the TRAINING split only (leave-one-out inside it)
 *   3. train P(error | modality, features) (logistic regression) on TRAIN
 *   4. tune R2's threshold and R4's α, β, γ, MIN_EVIDENCE on VALIDATION,
 *      subject to end-to-end accuracy ≥ τ_acc
 *   5. report on TEST: baselines B1-B4, routers R0-R4 and an oracle, ablations,
 *      the accuracy-cost-latency frontier, per case type and per rule type
 *
 *   npm run eval:router                   offline surrogate judge (reproducible, no key)
 *   npm run eval:router -- --judge gemini the real LLM judge (needs GEMINI_API_KEY)
 *
 * Writes eval/router_model.json and eval/results/router_eval.{json,md}, frontier.{csv,svg}.
 * Works on a temporary copy of the database.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const JUDGE = argOf("--judge", "surrogate");
const TAU = Number(argOf("--tau", 0.95));
const LIMIT = Number(argOf("--limit", 0));

const env = require("../src/config/env");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "urcc-router-")), "urcc_ef.db");
fs.copyFileSync(env.db.relationalPath, tmp);
process.env.RELATIONAL_DB_PATH = tmp;
env.db.relationalPath = tmp;

const db = require("../src/config/db");
const vectorStore = require("../src/services/vectorStore");
const modalities = require("../src/services/router/modalities");
const judges = require("../src/services/router/judges");
const logistic = require("../src/services/router/logistic");
const tree = require("../src/services/router/tree");
const R = require("../src/services/router/adaptiveRouter");
const embedding = require("../src/services/embeddingService");

const ROOT = path.join(__dirname, "..");
const RESULTS = path.join(ROOT, "eval", "results");
const DECISIONS = ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"];

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pct = (x) => Number((100 * x).toFixed(1));
const r4 = (x) => Number(x.toFixed(4));

// ── 1. modality outcomes ──

const docFilters = new Map();
function docFilter(category) {
  if (!docFilters.has(category)) {
    docFilters.set(category, new Set(db.prepare("SELECT doc_id FROM document_categories WHERE category = ?").all(category).map((r) => r.doc_id)));
  }
  return docFilters.get(category);
}
const chunkClause = db.prepare(
  "SELECT sc.parent_clause_uri AS clause_uri, cr.clause_text FROM semantic_chunks sc JOIN clause_registry cr ON cr.clause_uri = sc.parent_clause_uri WHERE sc.chunk_id = ?"
);
async function locate(rule, evidence) {
  const [v] = await judges.embedCached([evidence.slice(0, 1500)]);
  const hit = vectorStore.search(v, 1, docFilter(rule.category))[0];
  return hit ? chunkClause.get(hit.chunk_id) : null;
}

function llmMoney(chars, cm) {
  const tin = cm.llm.prompt_overhead_tokens + chars / 4;
  return (tin * cm.llm.usd_per_1m_input + cm.llm.output_tokens * cm.llm.usd_per_1m_output) / 1e6;
}

async function prepare(cases, judge, cm) {
  const out = [];
  let i = 0;
  for (const c of cases) {
    i++;
    if (i % 100 === 0) process.stderr.write(`  ${i}/${cases.length}\n`);
    const rule = { ...c.rule, field: c.rule.required_fields?.[0] === "narrative" ? "narrative" : c.rule.versioned ? (c.rule.required_fields[0]) : c.rule.required_fields?.[0], clause_text: c.rule.clause_text };
    const input = c.input_data;
    const ev = modalities.evidenceText(rule, input);
    // relevance of the evidence to the clause (retrieval_confidence)
    const cs = judges.splitSentences(rule.clause_text).slice(0, 12);
    const es = judges.splitSentences(ev);
    let relevance = 0;
    let second = 0;
    if (cs.length && es.length) {
      const vs = await judges.embedCached([...cs, ...es]);
      const scores = es.map((_, k) => Math.max(...cs.map((_, j) => embedding.dot(vs[j], vs[cs.length + k])))).sort((a, b) => b - a);
      relevance = scores[0] ?? 0;
      second = scores[1] ?? 0;
    }
    const det = modalities.deterministic(rule, input);
    const rag = await modalities.ragLlm(rule, input, judge);
    const only = await modalities.llmOnly(rule, input, judge, locate);
    const hum = modalities.human();
    const judgeLatency = (m) => (judge.name === "gemini" ? m.latency_ms : cm.llm.latency_ms);
    const outcomes = {
      DETERMINISTIC: { ...det, money: 0, latency_ms: det.latency_ms },
      RAG_LLM: { ...rag, money: llmMoney(rag.prompt_chars, cm), latency_ms: judgeLatency(rag) + cm.retrieval.latency_ms },
      LLM_ONLY: { ...only, money: llmMoney(cm.llm_only_context_chars + ev.length, cm), latency_ms: judgeLatency(only) * 1.5 },
      HUMAN: { ...hum, money: cm.human.usd_per_case, latency_ms: cm.human.latency_ms },
    };
    for (const o of Object.values(outcomes)) o.correct = c.acceptable_decisions.includes(o.decision);
    out.push({
      c,
      rule,
      input,
      ctx: {
        relevance,
        secondRelevance: second,
        sentences: es.length,
        numericInText: /\d+(?:\.\d+)?\s*(?:%|per ?cent|days)/i.test(input.narrative || ""),
        sourceConflict: det.decision === "REQUIRES_HUMAN_REVIEW" && /sources disagree/.test(det.reason || ""),
      },
      promptChars: rag.prompt_chars,
      outcomes,
    });
  }
  return out;
}

// ── 2-3. history and learned error models ──

function historyFrom(train, exclude = null) {
  const acc = {};
  const n = {};
  for (const p of train) {
    if (p === exclude) continue;
    for (const route of ["DETERMINISTIC", "RAG_LLM"]) {
      const k = `${p.rule.rule_type}:${route}`;
      acc[k] = (acc[k] || 0) + (p.outcomes[route].correct ? 1 : 0);
      n[k] = (n[k] || 0) + 1;
    }
  }
  return Object.fromEntries(Object.keys(n).map((k) => [k, acc[k] / n[k]]));
}

// ── 4-5. running a router over prepared cases ──

function run(prepared, choose, cm) {
  return prepared.map((p) => {
    const r = choose(p);
    if (!r.route) {
      return { p, route: "NONE", decision: r.decision, correct: p.c.acceptable_decisions.includes(r.decision), money: 0, latency_ms: 0, cited: p.rule.clause_uri };
    }
    const o = p.outcomes[r.route];
    return { p, route: r.route, decision: o.decision, correct: o.correct, money: o.money, latency_ms: o.latency_ms, cited: o.cited_clause, modality: o.modality };
  });
}

function metrics(rows) {
  const n = rows.length;
  const acc = mean(rows.map((r) => (r.correct ? 1 : 0)));
  const e2e = mean(rows.map((r) => (r.route === "HUMAN" ? 1 : r.correct ? 1 : 0)));
  // macro F1 over the five decisions (a prediction in the acceptable set counts as the expected label)
  const f1s = DECISIONS.map((d) => {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const r of rows) {
      const gold = r.p.c.expected_decision;
      const pred = r.p.c.acceptable_decisions.includes(r.decision) ? gold : r.decision;
      if (pred === d && gold === d) tp++;
      else if (pred === d) fp++;
      else if (gold === d) fn++;
    }
    const prec = tp + fp ? tp / (tp + fp) : 0;
    const rec = tp + fn ? tp / (tp + fn) : 0;
    return { d, prec, rec, f1: prec + rec ? (2 * prec * rec) / (prec + rec) : 0, support: tp + fn };
  });
  const present = f1s.filter((x) => x.support > 0);
  const nc = f1s.find((x) => x.d === "NON_COMPLIANT");
  const gComp = rows.filter((r) => r.p.c.expected_decision === "COMPLIANT");
  const gNon = rows.filter((r) => r.p.c.expected_decision === "NON_COMPLIANT");
  const decided = rows.filter((r) => r.route !== "HUMAN" && r.route !== "NONE");
  const wrongCite = decided.filter((r) => r.cited !== r.p.rule.clause_uri);
  const lat = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
  const auto = rows.filter((r) => r.route !== "HUMAN").map((r) => r.latency_ms).sort((a, b) => a - b);
  return {
    n,
    accuracy: r4(acc),
    end_to_end_accuracy: r4(e2e),
    macro_f1: r4(mean(present.map((x) => x.f1))),
    non_compliant_precision: r4(nc.prec),
    non_compliant_recall: r4(nc.rec),
    non_compliant_f1: r4(nc.f1),
    false_positive_rate: r4(gComp.length ? gComp.filter((r) => r.decision === "NON_COMPLIANT").length / gComp.length : 0),
    false_negative_rate: r4(gNon.length ? gNon.filter((r) => r.decision !== "NON_COMPLIANT" && r.route !== "HUMAN").length / gNon.length : 0),
    escalation_rate: r4(rows.filter((r) => r.route === "HUMAN").length / n),
    llm_call_rate: r4(rows.filter((r) => r.route === "RAG_LLM" || r.route === "LLM_ONLY").length / n),
    citation_accuracy: r4(decided.length ? 1 - wrongCite.length / decided.length : 1),
    hallucination_rate: r4(n ? wrongCite.length / n : 0),
    usd_per_case: r4(mean(rows.map((r) => r.money))),
    usd_per_case_automated: r4(mean(rows.filter((r) => r.route !== "HUMAN").map((r) => r.money))),
    mean_latency_ms: Number(mean(lat).toFixed(1)),
    median_latency_automated_ms: Number((auto[Math.floor(auto.length / 2)] ?? 0).toFixed(2)),
    route_mix: rows.reduce((acc, r) => ((acc[r.route] = (acc[r.route] || 0) + 1), acc), {}),
  };
}

// ── significance: paired cluster bootstrap by rule (cases of one rule are not
// independent) and an exact McNemar test on the discordant cases ──
function significance(rowsA, rowsB, { endToEnd = false, B = 2000, seed = 11 } = {}) {
  const ok = (r) => (endToEnd && r.route === "HUMAN" ? 1 : r.correct ? 1 : 0);
  const byRule = new Map();
  rowsA.forEach((a, i) => {
    const k = a.p.c.rule_id;
    if (!byRule.has(k)) byRule.set(k, []);
    byRule.get(k).push([ok(a), ok(rowsB[i])]);
  });
  const clusters = [...byRule.values()];
  const diffOf = (cs) => {
    let n = 0;
    let d = 0;
    for (const c of cs) for (const [a, b] of c) {
      n++;
      d += a - b;
    }
    return d / n;
  };
  let st = seed >>> 0;
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296);
  const boots = [];
  for (let b = 0; b < B; b++) boots.push(diffOf(clusters.map(() => clusters[Math.floor(rnd() * clusters.length)])));
  boots.sort((x, y) => x - y);
  // exact two-sided McNemar (binomial on discordant pairs)
  let n01 = 0;
  let n10 = 0;
  rowsA.forEach((a, i) => {
    const x = ok(a);
    const y = ok(rowsB[i]);
    if (x && !y) n10++;
    if (!x && y) n01++;
  });
  const nd = n01 + n10;
  const k = Math.min(n01, n10);
  let tail = 0;
  let logC = 0; // log C(nd, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(nd - i + 1) - Math.log(i);
    tail += Math.exp(logC - nd * Math.LN2);
  }
  return {
    difference: r4(diffOf(clusters)),
    ci95: [r4(boots[Math.floor(0.025 * B)]), r4(boots[Math.floor(0.975 * B) - 1])],
    a_only_correct: n10,
    b_only_correct: n01,
    mcnemar_p: nd ? Number(Math.min(1, 2 * tail).toExponential(2)) : 1,
    clusters: clusters.length,
  };
}

const breakdown = (rows, key) => {
  const g = {};
  for (const r of rows) (g[key(r)] = g[key(r)] || []).push(r);
  return Object.fromEntries(Object.entries(g).sort().map(([k, v]) => [k, { n: v.length, accuracy: r4(mean(v.map((x) => (x.correct ? 1 : 0)))) }]));
};

function referenceRoute(p) {
  if (p.outcomes.DETERMINISTIC.correct) return "DETERMINISTIC";
  if (p.outcomes.RAG_LLM.correct) return "RAG_LLM";
  return "HUMAN";
}

function frontierSvg(points, file) {
  const W = 720;
  const H = 440;
  const pad = 60;
  const xs = points.map((p) => p.usd);
  const ys = points.map((p) => p.acc);
  const lx = (v) => Math.log10(Math.max(v, 1e-6));
  const x0 = Math.min(...xs.map(lx));
  const x1 = Math.max(...xs.map(lx));
  const y0 = Math.min(...ys) - 0.02;
  const y1 = Math.min(1, Math.max(...ys) + 0.02);
  const X = (v) => pad + ((lx(v) - x0) / (x1 - x0 || 1)) * (W - 2 * pad);
  const Y = (v) => H - pad - ((v - y0) / (y1 - y0 || 1)) * (H - 2 * pad);
  const front = points.filter((p) => p.frontier).sort((a, b) => a.usd - b.usd);
  const dots = points
    .map((p) => `<circle cx="${X(p.usd).toFixed(1)}" cy="${Y(p.acc).toFixed(1)}" r="${p.named ? 6 : 3}" fill="${p.named ? "#1d4ed8" : p.frontier ? "#0f766e" : "#94a3b8"}"/>${p.named ? `<text x="${(X(p.usd) + 8).toFixed(1)}" y="${(Y(p.acc) - 6).toFixed(1)}" font-size="12">${p.named}</text>` : ""}`)
    .join("");
  const line = front.map((p, i) => `${i ? "L" : "M"}${X(p.usd).toFixed(1)},${Y(p.acc).toFixed(1)}`).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="Arial, sans-serif"><rect width="100%" height="100%" fill="#fff"/>
<text x="${W / 2}" y="24" text-anchor="middle" font-size="14" font-weight="bold">Accuracy vs cost per case (test split)</text>
<line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#334155"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#334155"/>
<text x="${W / 2}" y="${H - 18}" text-anchor="middle" font-size="12">USD per case (log scale)</text>
<text x="18" y="${H / 2}" transform="rotate(-90 18 ${H / 2})" text-anchor="middle" font-size="12">end-to-end accuracy</text>
<text x="${pad - 6}" y="${Y(y0) + 4}" text-anchor="end" font-size="10">${y0.toFixed(2)}</text><text x="${pad - 6}" y="${Y(y1) + 4}" text-anchor="end" font-size="10">${y1.toFixed(2)}</text>
<text x="${pad}" y="${H - pad + 14}" font-size="10">$${(10 ** x0).toExponential(1)}</text><text x="${W - pad}" y="${H - pad + 14}" text-anchor="end" font-size="10">$${(10 ** x1).toExponential(1)}</text>
<path d="${line}" fill="none" stroke="#0f766e" stroke-width="1.5"/>${dots}</svg>`;
  fs.writeFileSync(file, svg);
}

async function main() {
  const bench = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "compliance_benchmark.json"), "utf8"));
  const cm = JSON.parse(fs.readFileSync(path.join(ROOT, "eval", "cost_model.json"), "utf8"));
  const judge = judges.judgeFor(JUDGE);
  vectorStore.load();
  let cases = bench.cases;
  if (LIMIT) cases = cases.slice(0, LIMIT);
  console.error(`[eval:router] ${cases.length} cases, judge=${judge.name}`);
  const prepared = await prepare(cases, judge, cm);

  // measured deterministic latency replaces the assumption
  cm.rule_engine.latency_ms = Number(mean(prepared.filter((p) => p.rule.rule_type !== "G").map((p) => p.outcomes.DETERMINISTIC.latency_ms)).toFixed(4));
  cm.graph.latency_ms = Number(mean(prepared.filter((p) => p.rule.rule_type === "G").map((p) => p.outcomes.DETERMINISTIC.latency_ms)).toFixed(4));

  const split = (s) => prepared.filter((p) => p.c.split === s);
  const train = split("train");
  const val = split("validation");
  const test = split("test");

  // history (LOO on train) and features
  const histAll = historyFrom(train);
  for (const p of prepared) {
    const history = p.c.split === "train" ? historyFrom(train, p) : histAll;
    p.f = R.buildFeatures(p.rule, p.input, { ...p.ctx, history });
    p.x = R.vec(p.f);
  }

  // learned P(error | m, f): logistic regression or decision tree, chosen per
  // modality by log-loss on the validation split
  const errorModels = {};
  const estimatorChoice = {};
  const logloss = (m, rows, route) =>
    mean(rows.map((p) => {
      const q = m.kind === "tree" ? tree.predict(m, p.x) : logistic.predict(m, p.x);
      const y = p.outcomes[route].correct ? 0 : 1;
      return -(y * Math.log(q + 1e-9) + (1 - y) * Math.log(1 - q + 1e-9));
    }));
  for (const route of ["DETERMINISTIC", "RAG_LLM"]) {
    const X = train.map((p) => p.x);
    const y = train.map((p) => (p.outcomes[route].correct ? 0 : 1));
    const lr = { kind: "logistic", ...logistic.train(X, y) };
    const tr = tree.train(X, y);
    const l1 = logloss(lr, val, route);
    const l2 = logloss(tr, val, route);
    errorModels[route] = l2 < l1 ? tr : lr;
    estimatorChoice[route] = { logistic_val_logloss: r4(l1), tree_val_logloss: r4(l2), chosen: errorModels[route].kind };
  }
  const baseModel = { error_models: errorModels, human_error_rate: cm.human.error_rate, cost_model: cm, params: {} };

  // ── tuning on validation ──
  const r2Grid = [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85];
  const r2Scores = r2Grid.map((t) => ({ t, m: metrics(run(val, (p) => R.routeThreshold(p.f, t), cm)) }));
  const r2Best = r2Scores.sort((a, b) => b.m.end_to_end_accuracy - a.m.end_to_end_accuracy || a.m.usd_per_case - b.m.usd_per_case)[0];

  const grid = [];
  for (const beta of [0.1, 0.3, 1, 3, 10, 30]) {
    for (const gamma of [0, 1e-4, 1e-3, 1e-2]) {
      for (const minEv of [0.5, 0.75, 1.0]) grid.push({ alpha: 1, beta, gamma, min_evidence: minEv });
    }
  }
  const scored = grid.map((params) => ({ params, m: metrics(run(val, (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params }), cm)) }));
  const feasible = scored.filter((s) => s.m.end_to_end_accuracy >= TAU);
  const chosen = (feasible.length ? feasible.sort((a, b) => a.m.usd_per_case - b.m.usd_per_case || a.m.mean_latency_ms - b.m.mean_latency_ms || b.m.accuracy - a.m.accuracy) : scored.sort((a, b) => b.m.end_to_end_accuracy - a.m.end_to_end_accuracy))[0];
  const model = { ...baseModel, params: chosen.params };

  // two further operating points, also chosen on validation:
  //  cost-matched  - best accuracy at no more than the earlier router's (R0) cost
  //  automated     - no human escalation at all (β, γ tuned for accuracy)
  const r0Val = metrics(run(val, (p) => R.routeLegacy(p.rule, p.f, p.ctx), cm));
  const byAcc = (a, b) => b.m.end_to_end_accuracy - a.m.end_to_end_accuracy || b.m.accuracy - a.m.accuracy || a.m.usd_per_case - b.m.usd_per_case;
  const costMatched = scored.filter((x) => x.m.usd_per_case <= r0Val.usd_per_case + 1e-9).sort(byAcc)[0] || chosen;
  const autoScored = grid.map((params) => ({ params: { ...params, no_human: true }, m: metrics(run(val, (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params: { ...params, no_human: true } }), cm)) }));
  const automated = autoScored.sort((a, b) => b.m.accuracy - a.m.accuracy || a.m.usd_per_case - b.m.usd_per_case)[0];

  // error analysis on the validation split only (the test split stays unseen)
  if (process.env.VAL_ERRORS) {
    const rows = run(val, (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params: automated.params }), cm);
    const errs = rows.filter((r) => !r.correct).map((r) => ({
      case_id: r.p.c.case_id, case_type: r.p.c.case_type, rule_type: r.p.rule.rule_type, route: r.route, decision: r.decision, expected: r.p.c.acceptable_decisions,
      det: r.p.outcomes.DETERMINISTIC.decision, rag: r.p.outcomes.RAG_LLM.decision, f: r.p.f, narrative: r.p.input.narrative, structured: r.p.input.structured,
    }));
    fs.writeFileSync(process.env.VAL_ERRORS, JSON.stringify(errs, null, 1));
  }

  // ── test ──
  const systems = {
    "B1 Rule-only": (p) => ({ route: "DETERMINISTIC" }),
    "B2 LLM-only (no retrieval)": (p) => ({ route: "LLM_ONLY" }),
    "B3 RAG+LLM": (p) => ({ route: "RAG_LLM" }),
    "B4 / R3 Fixed hybrid": (p) => R.routeFixed(p.rule.rule_type),
    "R0 Earlier heuristic router": (p) => R.routeLegacy(p.rule, p.f, p.ctx),
    "R1 Static rule-first": (p) => R.routeStatic(p.f),
    [`R2 Confidence threshold (θ=${r2Best.t})`]: (p) => R.routeThreshold(p.f, r2Best.t),
    "R4 Proposed adaptive": (p) => R.routeAdaptive(p.f, model, { promptChars: p.promptChars }),
    "R4 at R0's cost budget": (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params: costMatched.params }),
    "R4 fully automated (no human)": (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params: automated.params }),
    "Oracle (cheapest correct route)": (p) => ({ route: referenceRoute(p) }),
  };
  const results = {};
  const rowsBy = {};
  for (const [name, fn] of Object.entries(systems)) {
    rowsBy[name] = run(test, fn, cm);
    results[name] = metrics(rowsBy[name]);
  }
  const r4Rows = rowsBy["R4 Proposed adaptive"];
  const sigPairs = [
    ["R4 Proposed adaptive", "R0 Earlier heuristic router"],
    ["R4 Proposed adaptive", "B4 / R3 Fixed hybrid"],
    ["R4 Proposed adaptive", "R1 Static rule-first"],
    ["R4 Proposed adaptive", "B3 RAG+LLM"],
    ["R4 fully automated (no human)", "R1 Static rule-first"],
    ["R4 fully automated (no human)", "B4 / R3 Fixed hybrid"],
  ];
  const significanceTests = sigPairs.map(([a, b]) => ({
    a,
    b,
    accuracy: significance(rowsBy[a], rowsBy[b]),
    end_to_end: significance(rowsBy[a], rowsBy[b], { endToEnd: true }),
  }));
  const routingAccuracy = Object.fromEntries(
    Object.entries(rowsBy).map(([k, rows]) => [k, r4(mean(rows.map((r) => (r.route === referenceRoute(r.p) || (r.route === "NONE" && r.correct) ? 1 : 0))))])
  );

  const ablations = {
    "Full proposed system": results["R4 Proposed adaptive"],
    "− adaptive routing (→ B4)": results["B4 / R3 Fixed hybrid"],
    "− rule engine (→ B3)": results["B3 RAG+LLM"],
    "− evidence grounding (→ B2)": results["B2 LLM-only (no retrieval)"],
    "− hard override": metrics(run(test, (p) => R.routeAdaptive(p.f, model, { promptChars: p.promptChars, params: { hard_override: false } }), cm)),
    "− learned error model (historical accuracy only)": metrics(run(test, (p) => R.routeAdaptive(p.f, model, { promptChars: p.promptChars, params: { learned: false } }), cm)),
    "− evidence-completeness gate": metrics(run(test, (p) => R.routeAdaptive(p.f, model, { promptChars: p.promptChars, params: { completeness_gate: false } }), cm)),
  };

  // frontier (test): every grid configuration, plus the named routers
  const pts = grid.map((params) => {
    const m = metrics(run(test, (p) => R.routeAdaptive(p.f, baseModel, { promptChars: p.promptChars, params }), cm));
    return { beta: params.beta, gamma: params.gamma, min_evidence: params.min_evidence, acc: m.end_to_end_accuracy, auto_acc: m.accuracy, usd: m.usd_per_case, latency_ms: m.mean_latency_ms };
  });
  for (const [name, m] of Object.entries(results)) {
    if (name.startsWith("Oracle")) continue;
    pts.push({ named: name.split(" ")[0], acc: m.end_to_end_accuracy, auto_acc: m.accuracy, usd: m.usd_per_case, latency_ms: m.mean_latency_ms });
  }
  for (const p of pts) p.frontier = !pts.some((q) => q !== p && q.acc >= p.acc && q.usd <= p.usd && (q.acc > p.acc || q.usd < p.usd));
  fs.mkdirSync(RESULTS, { recursive: true });
  fs.writeFileSync(path.join(RESULTS, "frontier.csv"), ["label,beta,gamma,min_evidence,end_to_end_accuracy,automated_accuracy,usd_per_case,mean_latency_ms,pareto", ...pts.map((p) => [p.named || "R4-config", p.beta ?? "", p.gamma ?? "", p.min_evidence ?? "", p.acc, p.auto_acc, p.usd, p.latency_ms, p.frontier].join(","))].join("\n"));
  frontierSvg(pts, path.join(RESULTS, "frontier.svg"));

  // per case type / rule type (Table X)
  const byCase = {};
  const byType = {};
  for (const name of ["B2 LLM-only (no retrieval)", "B3 RAG+LLM", "B4 / R3 Fixed hybrid", "R0 Earlier heuristic router", "R4 Proposed adaptive", "R4 at R0's cost budget"]) {
    byCase[name] = breakdown(rowsBy[name], (r) => r.p.c.case_type);
    byType[name] = breakdown(rowsBy[name], (r) => r.p.rule.rule_type);
  }
  const hallByCase = breakdown(
    rowsBy["B2 LLM-only (no retrieval)"].map((r) => ({ ...r, correct: r.cited !== r.p.rule.clause_uri })),
    (r) => r.p.c.case_type
  );

  // modality accuracy on test, for the paper's discussion
  const modalityAcc = Object.fromEntries(["DETERMINISTIC", "RAG_LLM", "LLM_ONLY"].map((m) => [m, breakdown(test.map((p) => ({ p, correct: p.outcomes[m].correct })), (r) => r.p.rule.rule_type)]));

  // adopt the adaptive router in the running system only if an operating point
  // chosen on validation (τ first, then cost-matched) is at least as accurate as
  // the router it would replace (R0), on both accuracies and at no more than
  // 5% extra cost, on the validation AND the test split - so escalating more
  // cannot buy the improvement
  const r0R = results["R0 Earlier heuristic router"];
  const noWorse = (m, ref) => m.end_to_end_accuracy >= ref.end_to_end_accuracy && m.accuracy >= ref.accuracy && m.usd_per_case <= ref.usd_per_case * 1.05;
  const candidates = [
    { name: "tau", params: chosen.params, val: chosen.m, test: results["R4 Proposed adaptive"] },
    { name: "cost_matched", params: costMatched.params, val: costMatched.m, test: results["R4 at R0's cost budget"] },
  ];
  const adoptedPoint = candidates.find((c) => noWorse(c.val, r0Val) && noWorse(c.test, r0R)) || null;
  const adopt = !!adoptedPoint;

  const saved = {
    ...model,
    params: adopt ? adoptedPoint.params : model.params,
    adopted_operating_point: adoptedPoint ? adoptedPoint.name : null,
    operating_points: { tau: chosen.params, cost_matched: costMatched.params, automated: automated.params },
    estimator_choice: estimatorChoice,
    feature_names: R.FEATURE_NAMES,
    history: histAll,
    judge: judge.name,
    tau_acc: TAU,
    trained_on: { benchmark: "eval/compliance_benchmark.json", seed: bench.seed, train: train.length, validation: val.length, test: test.length },
    validation: { chosen: chosen.m, feasible_configs: feasible.length, grid_size: grid.length },
    adopted_in_system: adopt,
    trained_at: new Date().toISOString(),
  };
  R.saveModel(saved);

  const report = {
    judge: judge.name,
    judge_note: judge.name === "surrogate" ? "RAG+LLM and LLM-only outcomes use the offline surrogate judge (deterministic reading heuristics standing in for the LLM); LLM cost and latency are modelled from Gemini 2.5 Flash list prices and an assumed latency. Re-run with --judge gemini to measure the real model." : "RAG+LLM and LLM-only outcomes measured with Gemini.",
    tau_acc: TAU,
    cost_model: cm,
    benchmark: bench.counts,
    splits: { train: train.length, validation: val.length, test: test.length },
    r2_theta: r2Best.t,
    r4_params: chosen.params,
    r4_cost_matched_params: costMatched.params,
    r4_automated_params: automated.params,
    estimator_choice: estimatorChoice,
    error_model_rules: Object.fromEntries(Object.entries(errorModels).filter(([, m]) => m.kind === "tree").map(([k, m]) => [k, tree.describe(m, R.FEATURE_NAMES)])),
    r4_validation: chosen.m,
    results,
    routing_accuracy_vs_reference: routingAccuracy,
    llm_calls_avoided_vs_B3: r4(1 - results["R4 Proposed adaptive"].llm_call_rate / Math.max(1e-9, results["B3 RAG+LLM"].llm_call_rate)),
    ablations,
    by_case_type: byCase,
    by_rule_type: byType,
    b2_wrong_citation_by_case_type: hallByCase,
    modality_accuracy_by_rule_type: modalityAcc,
    error_model_weights: Object.fromEntries(Object.entries(errorModels).filter(([, m]) => m.kind === "logistic").map(([k, m]) => [k, Object.fromEntries(R.FEATURE_NAMES.map((f, i) => [f, r4(m.w[i])]).concat([["bias", r4(m.b)]]))])),
    significance: significanceTests,
    // for the figures: decision confusion (expected vs produced; an escalation
    // counts as REQUIRES_HUMAN_REVIEW) and the route mix per category, test split
    confusion: Object.fromEntries(["R4 Proposed adaptive", "R0 Earlier heuristic router", "B3 RAG+LLM"].map((name) => {
      const m = Object.fromEntries(DECISIONS.map((d) => [d, Object.fromEntries(DECISIONS.map((e) => [e, 0]))]));
      for (const r of rowsBy[name]) m[r.p.c.expected_decision][r.route === "HUMAN" ? "REQUIRES_HUMAN_REVIEW" : r.decision || "INSUFFICIENT_DATA"]++;
      return [name, m];
    })),
    route_mix_by_rule_type: Object.fromEntries(["R4 Proposed adaptive", "R0 Earlier heuristic router"].map((name) => {
      const g = {};
      for (const r of rowsBy[name]) {
        const t = r.p.rule.rule_type;
        g[t] = g[t] || { DETERMINISTIC: 0, RAG_LLM: 0, HUMAN: 0, NONE: 0 };
        g[t][r.route] = (g[t][r.route] || 0) + 1;
      }
      return [name, g];
    })),
    adopted_in_system: adopt,
    adopted_operating_point: adoptedPoint ? adoptedPoint.name : null,
    r0_validation: r0Val,
    examples: r4Rows.slice(0, 5).map((r) => ({ case_id: r.p.c.case_id, case_type: r.p.c.case_type, rule_type: r.p.rule.rule_type, route: r.route, decision: r.decision, expected: r.p.c.expected_decision })),
  };
  fs.writeFileSync(path.join(RESULTS, "router_eval.json"), JSON.stringify(report, null, 1));
  fs.writeFileSync(path.join(RESULTS, "router_eval.md"), markdown(report));
  console.log(markdown(report));
}

function markdown(r) {
  const L = [];
  L.push(`# Adaptive Compliance Checking - measured results (test split, n = ${r.splits.test})`, "");
  L.push(`Judge for the LLM paths: **${r.judge}**. ${r.judge_note}`, "");
  L.push(`Error-model estimator chosen on validation: ${Object.entries(r.estimator_choice).map(([k, v]) => `${k} → ${v.chosen} (val log-loss logistic ${v.logistic_val_logloss}, tree ${v.tree_val_logloss})`).join("; ")}.`, "");
  L.push(`Benchmark: ${r.benchmark.total} cases from ${r.benchmark.distinct_rules} rules; splits train ${r.splits.train} / validation ${r.splits.validation} / test ${r.splits.test} (by rule). τ_acc = ${r.tau_acc}. R4 parameters chosen on validation: α = ${r.r4_params.alpha}, β = ${r.r4_params.beta}, γ = ${r.r4_params.gamma}, MIN_EVIDENCE = ${r.r4_params.min_evidence}; R2 θ = ${r.r2_theta}.`, "");
  L.push("## Systems (Tables VII / X / XI)", "");
  L.push("| System | Accuracy | End-to-end acc. | Macro-F1 | NC F1 | FPR | FNR | Escalated | LLM calls | Citation acc. | Halluc. rate | USD / case | Mean latency (ms) |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const [k, m] of Object.entries(r.results)) {
    L.push(`| ${k} | ${pct(m.accuracy)}% | ${pct(m.end_to_end_accuracy)}% | ${m.macro_f1.toFixed(3)} | ${m.non_compliant_f1.toFixed(3)} | ${pct(m.false_positive_rate)}% | ${pct(m.false_negative_rate)}% | ${pct(m.escalation_rate)}% | ${pct(m.llm_call_rate)}% | ${pct(m.citation_accuracy)}% | ${pct(m.hallucination_rate)}% | ${m.usd_per_case.toFixed(5)} | ${m.mean_latency_ms} |`);
  }
  L.push("", `LLM calls avoided by R4 relative to B3: **${pct(r.llm_calls_avoided_vs_B3)}%**.`, "");
  L.push("Accuracy = the decision is in the case's acceptable set; end-to-end accuracy additionally counts an escalation as resolved correctly by the human reviewer (cost and latency of the reviewer are charged).", "");
  L.push("## Routing accuracy against the reference route (cheapest correct modality)", "");
  L.push("| Router | Routing accuracy |", "|---|---|");
  for (const [k, v] of Object.entries(r.routing_accuracy_vs_reference)) L.push(`| ${k} | ${pct(v)}% |`);
  L.push("", "## Accuracy by case type (Table X)", "");
  const sys = Object.keys(r.by_case_type);
  L.push(`| Case type | ${sys.join(" | ")} | B2 wrong-citation rate |`, `|---|${sys.map(() => "---").join("|")}|---|`);
  for (const ct of Object.keys(r.by_case_type[sys[0]])) {
    L.push(`| ${ct} | ${sys.map((s) => `${pct(r.by_case_type[s][ct]?.accuracy ?? 0)}%`).join(" | ")} | ${pct(r.b2_wrong_citation_by_case_type[ct]?.accuracy ?? 0)}% |`);
  }
  L.push("", "## Accuracy by requirement category", "");
  L.push(`| Category | ${sys.join(" | ")} |`, `|---|${sys.map(() => "---").join("|")}|`);
  for (const t of Object.keys(r.by_rule_type[sys[0]])) L.push(`| ${t} | ${sys.map((s) => `${pct(r.by_rule_type[s][t]?.accuracy ?? 0)}%`).join(" | ")} |`);
  L.push("", "## Ablations (Table XV)", "");
  L.push("| Configuration | Accuracy | End-to-end acc. | Halluc. rate | USD / case | Mean latency (ms) |", "|---|---|---|---|---|---|");
  for (const [k, m] of Object.entries(r.ablations)) L.push(`| ${k} | ${pct(m.accuracy)}% | ${pct(m.end_to_end_accuracy)}% | ${pct(m.hallucination_rate)}% | ${m.usd_per_case.toFixed(5)} | ${m.mean_latency_ms} |`);
  L.push("", "## Significance (test split; paired cluster bootstrap by rule, 2,000 resamples; exact McNemar)", "", "| Comparison | Δ accuracy [95% CI] | McNemar p | Δ end-to-end [95% CI] | McNemar p |", "|---|---|---|---|---|");
  const pp = (x) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)} pp`;
  for (const t of r.significance) L.push(`| ${t.a} vs ${t.b} | ${pp(t.accuracy.difference)} [${pp(t.accuracy.ci95[0])}, ${pp(t.accuracy.ci95[1])}] | ${t.accuracy.mcnemar_p} | ${pp(t.end_to_end.difference)} [${pp(t.end_to_end.ci95[0])}, ${pp(t.end_to_end.ci95[1])}] | ${t.end_to_end.mcnemar_p} |`);
  L.push("", `Adaptive router adopted in the running system (routed endpoint): **${r.adopted_in_system ? `yes (${r.adopted_operating_point} operating point)` : "no"}** (adopted only if an operating point chosen on validation is at least as accurate as the earlier heuristic router R0, on both accuracies and at ≤ 5% extra cost, on the validation and the test split).`, "");
  return L.join("\n");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(path.dirname(tmp), { recursive: true, force: true }));
