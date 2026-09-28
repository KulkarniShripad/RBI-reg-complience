/**
 * Network Topology Mapper (graph subsystem) tests.
 *
 * 1. Engine: RBI's own grouping illustrations (Commercial Banks -
 *    Concentration Risk Management Directions, paragraphs 20-30) and the
 *    Section 20 related-party rules, on small hand-built graphs.
 * 2. Evaluator: every expectation in eval/graph_scenarios.json.
 * 3. API: on a throw-away corpus built from the two real commercial-bank
 *    directions the rules cite, so rule sources are resolved for real.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const PDFS = [
  path.join(REPO, "circulars", "commercial banks", "file_17.pdf"), // Concentration Risk Management
  path.join(REPO, "circulars", "commercial banks", "file_16.pdf"), // Credit Risk Management
];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urcc-graph-"));
Object.assign(process.env, {
  NODE_ENV: "test",
  RELATIONAL_DB_PATH: path.join(tmp, "urcc_ef.db"),
  VECTOR_DB_PATH: path.join(tmp, "urcc_ef_vectors.db"),
  CIRCULARS_ROOT: path.join(tmp, "circulars"),
  EMBEDDING_MODEL_DIR: path.join(tmp, "no-model"),
  EMBEDDING_ALLOW_REMOTE: "false",
  EMBED_MISSING_ON_START: "false",
  GEMINI_API_KEY: "",
});

const engine = require("../src/services/graph/graphEngine");
const { checkLimit } = require("../src/services/graph/graphEvaluator");
const { runScenario, checkExpectation } = require("../scripts/eval_graph");

const co = (id) => ({ entity_id: id, name: id, entity_type: "company" });
const person = (id) => ({ entity_id: id, name: id, entity_type: "individual" });
let n = 0;
const edge = (from, type, to, extra = {}) => ({ edge_id: ++n, from_entity: from, to_entity: to, edge_type: type, status: "confirmed", ...extra });
const groupsOf = (entities, edges, opts) =>
  engine.connectedGroups(engine.buildIndex({ entities, edges }, opts)).groups.map((g) => [...g.members].sort().join(","));

// ── 1. engine ──────────────────────────────────────────────────────────────

test("control is transitive and >50% ownership is control; 50% is not", () => {
  const ents = ["A", "A1", "A2", "X"].map(co);
  const groups = groupsOf(ents, [
    edge("A", "OWNS", "A1", { ownership_pct: 51 }),
    edge("A1", "OWNS", "A2", { ownership_pct: 60 }),
    edge("A", "OWNS", "X", { ownership_pct: 50 }),
  ]);
  assert.deepEqual(groups, ["A,A1,A2"]);
});

test("RBI one-way dependence: B1 belongs to both A's group and B's group (para 30(1))", () => {
  const ents = ["A", "A1", "A2", "B", "B1"].map(co);
  const groups = groupsOf(ents, [
    edge("A", "CONTROLS", "A1"),
    edge("A", "CONTROLS", "A2"),
    edge("B", "CONTROLS", "B1"),
    edge("B1", "ECONOMIC_DEPENDENCE", "A2", { criterion: 3 }),
  ]);
  assert.deepEqual(groups.sort(), ["A,A1,A2,B1", "B,B1"]);
});

test("RBI downstream contagion: entities controlled by the dependent entity join too (para 30(2)(i))", () => {
  const ents = ["A", "A2", "B", "B1", "B2", "B3"].map(co);
  const groups = groupsOf(ents, [
    edge("A", "CONTROLS", "A2"),
    edge("B", "CONTROLS", "B1"),
    edge("B1", "CONTROLS", "B2"),
    edge("B1", "CONTROLS", "B3"),
    edge("B1", "ECONOMIC_DEPENDENCE", "A2"),
  ]);
  assert.ok(groups.includes("A,A2,B1,B2,B3"), groups.join(" | "));
  assert.ok(groups.includes("B,B1,B2,B3"));
});

test("RBI upstream contagion only when the controller itself depends on the link (para 30(2)(ii))", () => {
  const ents = ["A", "A2", "B", "B1"].map(co);
  const base = [edge("A", "CONTROLS", "A2"), edge("B", "CONTROLS", "B1"), edge("B1", "ECONOMIC_DEPENDENCE", "A2")];
  assert.ok(!groupsOf(ents, base).some((g) => g.split(",").includes("A") && g.split(",").includes("B")));
  const withUpstream = groupsOf(ents, [...base, edge("B", "ECONOMIC_DEPENDENCE", "B1")]);
  assert.ok(withUpstream.includes("A,A2,B,B1"), withUpstream.join(" | "));
});

test("two-way dependence links both ways", () => {
  const groups = groupsOf(["M", "N"].map(co), [edge("M", "ECONOMIC_DEPENDENCE", "N", { bidirectional: 1 })]);
  assert.deepEqual(groups, ["M,N"]);
});

test("sovereign control does not connect counterparties (para 9)", () => {
  const ents = [{ entity_id: "GOI", name: "GoI", entity_type: "government" }, co("P1"), co("P2")];
  const groups = groupsOf(ents, [edge("GOI", "OWNS", "P1", { ownership_pct: 100 }), edge("GOI", "OWNS", "P2", { ownership_pct: 100 })]);
  assert.deepEqual(groups, []);
});

test("rebutted links are ignored; flagged links count only when asked", () => {
  const ents = ["O", "S", "M", "N"].map(co);
  const edges = [edge("O", "CONTROLS", "S", { status: "rebutted" }), edge("N", "ECONOMIC_DEPENDENCE", "M", { status: "flagged" })];
  assert.deepEqual(groupsOf(ents, edges), []);
  assert.deepEqual(groupsOf(ents, edges, { includeFlagged: true }), ["M,N"]);
});

test("common management merges a horizontal group", () => {
  const groups = groupsOf(["U2", "U3", "U4"].map(co), [edge("U2", "COMMON_MANAGEMENT", "U3"), edge("U3", "COMMON_MANAGEMENT", "U4")]);
  assert.deepEqual(groups, ["U2,U3,U4"]);
});

test("Section 20: director's companies, their subsidiaries and firms; Section 8 and bank subsidiaries excluded", () => {
  const ents = [
    person("D"), co("X"), co("XS"), co("K"), co("SUB"), { entity_id: "F", name: "F", entity_type: "firm" },
    { entity_id: "K8", name: "K8", entity_type: "company", attributes: { section8_company: true } }, person("W"),
  ];
  const idx = engine.buildIndex({
    entities: ents,
    edges: [
      edge("D", "DIRECTOR_OF", "SELF"),
      edge("D", "DIRECTOR_OF", "X"),
      edge("X", "OWNS", "XS", { ownership_pct: 80 }),
      edge("D", "INTERESTED_IN", "F", { role: "partner" }),
      edge("D", "DIRECTOR_OF", "K8"),
      edge("D", "DIRECTOR_OF", "SUB"),
      edge("SELF", "OWNS", "SUB", { ownership_pct: 100 }),
      edge("D", "INTERESTED_IN", "W", { role: "guarantor" }),
      edge("D", "INTERESTED_IN", "K", { role: "other" }),
    ],
  });
  const r = engine.restrictedParties(idx, ["section20"]);
  assert.deepEqual([...r.keys()].sort(), ["D", "F", "W", "X", "XS"]);
  assert.match(r.get("XS")[0].path.join(" / "), /director of X.*owns 80% of XS/);
});

test("promoters: 10%+ shareholders and what they control, not a non-strategic mutual fund", () => {
  const ents = [co("P"), co("P1"), co("H"), co("H1"), { entity_id: "MF", name: "MF", entity_type: "fund", attributes: { non_strategic_investor: true } }, co("MF1"), co("L"), co("L1")];
  const idx = engine.buildIndex({
    entities: ents,
    edges: [
      edge("P", "PROMOTER_OF", "SELF"), edge("P", "OWNS", "P1", { ownership_pct: 20 }),
      edge("H", "OWNS", "SELF", { ownership_pct: 10 }), edge("H", "CONTROLS", "H1"),
      edge("MF", "OWNS", "SELF", { ownership_pct: 11 }), edge("MF", "OWNS", "MF1", { ownership_pct: 90 }),
      edge("L", "OWNS", "SELF", { ownership_pct: 9.9 }), edge("L", "OWNS", "L1", { ownership_pct: 90 }),
    ],
  });
  assert.deepEqual([...engine.restrictedParties(idx, ["promoters"]).keys()].sort(), ["H", "H1", "P", "P1"]);
});

test("credit protection moves exposure to the protection provider; sovereign exposure is exempt", () => {
  const idx = engine.buildIndex({ entities: [co("Q"), { entity_id: "G", name: "G", entity_type: "bank" }, { entity_id: "GOI", name: "GoI", entity_type: "government" }], edges: [] });
  const exp = engine.aggregateExposures(
    [{ entity_id: "Q", amount: 260, crm_amount: 100, crm_provider: "G" }, { entity_id: "GOI", amount: 50 }],
    { index: idx }
  );
  assert.equal(exp.get("Q").total, 160);
  assert.equal(exp.get("G").total, 100);
  assert.equal(exp.get("GOI").total, 0);
  assert.equal(exp.get("GOI").exempt, 50);
});

test("limit arithmetic: Board excess, infrastructure headroom and the hard cap", () => {
  const rule = { limit: 20, board_extension: 5, infra_extension: 5, cap: 25, base_label: "Tier 1", source_resolved: { verified: true } };
  assert.equal(checkLimit(rule, { amount: 200, base: 1000 }).status, "PASS");
  assert.equal(checkLimit(rule, { amount: 230, base: 1000 }).status, "BREACH");
  assert.equal(checkLimit(rule, { amount: 230, base: 1000, boardApproved: true }).status, "PASS_WITH_CONDITIONS");
  assert.equal(checkLimit(rule, { amount: 230, infra: 40, base: 1000 }).status, "PASS_WITH_CONDITIONS");
  assert.equal(checkLimit(rule, { amount: 280, infra: 50, base: 1000, boardApproved: true }).status, "BREACH"); // cap 25%
  assert.equal(checkLimit(rule, { amount: 10, base: null }).status, "NEEDS_REVIEW");
  assert.equal(checkLimit({ ...rule, source_resolved: { verified: false, reason: "x" } }, { amount: 1, base: 10 }).status, "NEEDS_REVIEW");
});

// ── 2. scenarios ───────────────────────────────────────────────────────────

test("every expectation in the synthetic scenarios holds", () => {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "graph_scenarios.json"), "utf8"));
  const failures = [];
  for (const sc of data.scenarios) {
    const out = runScenario(sc, { offline: true });
    for (const exp of sc.expected) {
      const { ok, got } = checkExpectation(out, exp);
      if (!ok) failures.push(`${sc.id}: ${JSON.stringify(exp)} got ${got}`);
    }
  }
  assert.deepEqual(failures, []);
});

// ── 3. API on a real two-document corpus ───────────────────────────────────

const havePdfs = PDFS.every((p) => fs.existsSync(p));
let base;
let server;
const P = "Q1-FY2026-27";

test.before(async () => {
  if (!havePdfs) return;
  const dir = path.join(tmp, "circulars", "commercial banks");
  fs.mkdirSync(dir, { recursive: true });
  PDFS.forEach((p) => fs.copyFileSync(p, path.join(dir, path.basename(p))));
  execFileSync("python3", [
    path.join(__dirname, "..", "scripts", "db_builder.py"), "build",
    "--circulars", path.join(tmp, "circulars"), "--db", process.env.RELATIONAL_DB_PATH, "--workers", "1",
  ], { stdio: "pipe" });
  const { app } = require("../src/server");
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const post = async (url, body, method = "POST") => {
  const res = await fetch(`${base}${url}`, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

test("commercial-bank rules resolve to the real paragraphs", { skip: !havePdfs }, async () => {
  const { rules } = await (await fetch(`${base}/api/graph/rules?category=commercial_banks`)).json();
  const single = rules.find((r) => r.key === "cb_single");
  assert.equal(single.source.verified, true);
  assert.equal(single.source.paragraph, "15");
  assert.match(single.source.excerpt, /20 percent/);
  assert.ok(rules.every((r) => r.source.verified), rules.filter((r) => !r.source.verified).map((r) => r.key).join(","));
});

test("load a sample network, run the check, and find the group breach with its source", { skip: !havePdfs }, async () => {
  const load = await post("/api/graph/scenarios/cb_control_and_dependence/load", { period_label: P });
  assert.equal(load.status, 200);
  const bankId = load.body.bank_id;
  const { body } = await post(`/api/graph/${bankId}/check`, { period_label: P, persist: true });
  const group = body.results.find((r) => r.rule_key === "cb_group");
  assert.equal(group.status, "BREACH");
  assert.equal(group.exposure, 290);
  assert.equal(group.source.page_number, 11);
  assert.ok(group.links.some((l) => /economically dependent/.test(l.label)));
  assert.ok(body.graph.nodes.some((nd) => nd.id === "SELF"));
  assert.ok(body.graph_run_id);

  // the regular compliance run includes the network check and keeps it in history
  const run = await post(`/api/compliance/${bankId}/run`, { period_label: P, qual_sample_limit: 1 });
  assert.equal(run.body.report.summary.network_breach, 2);
  const hist = await (await fetch(`${base}/api/compliance/runs/${run.body.run_id}`)).json();
  assert.equal(hist.graph_results.results.length, run.body.graph_results.results.length);

  // the adaptive router now routes these clauses to the graph
  const routed = await post(`/api/compliance/${bankId}/run-routed`, { period_label: P, qual_sample_limit: 1 });
  const g = routed.body.results.filter((r) => r.route === "GRAPH");
  assert.ok(g.some((r) => r.clause_uri.endsWith("/para16") && r.status === "BREACH"));
});

test("reviewing a link changes the grouping", { skip: !havePdfs }, async () => {
  const bankId = "DEMO-CB-CONTROL-AND-DEPENDENCE";
  const net = await (await fetch(`${base}/api/graph/${bankId}?period_label=${P}`)).json();
  const upstream = net.edges.find((e) => e.from_entity === "B" && e.edge_type === "ECONOMIC_DEPENDENCE");
  const r = await post(`/api/graph/${bankId}/edges/${upstream.edge_id}`, { status: "rebutted", review_note: "alternative buyers exist" }, "PATCH");
  assert.equal(r.body.status, "rebutted");
  const { body } = await post(`/api/graph/${bankId}/check`, { period_label: P });
  const groups = body.results.filter((x) => x.rule_key === "cb_group");
  assert.ok(groups.every((x) => x.status === "PASS"), JSON.stringify(groups.map((x) => [x.subject.name, x.exposure, x.status])));
});

test("invalid network data is rejected with row-level details and nothing is written", { skip: !havePdfs }, async () => {
  const bank = await post("/api/banks", { bank_id: "NET-TEST", bank_name: "Network Test Bank", institution_category: "commercial_banks" });
  assert.ok([200, 201].includes(bank.status), JSON.stringify(bank.body));
  const bad = await post("/api/graph/NET-TEST/import", {
    period_label: P,
    entities: [{ entity_id: "A", name: "A", entity_type: "company" }, { entity_id: "A", name: "dup", entity_type: "company" }],
    edges: [{ from_entity: "A", to_entity: "Z", edge_type: "OWNS", ownership_pct: 150 }],
    exposures: [{ entity_id: "A", amount: -1 }],
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, "invalid_network_data");
  assert.ok(bad.body.details.length >= 4);
  const net = await (await fetch(`${base}/api/graph/NET-TEST?period_label=${P}`)).json();
  assert.equal(net.entities.filter((e) => e.entity_id !== "SELF").length, 0);

  // a category mismatch is refused unless forced
  const mismatch = await post("/api/graph/scenarios/ucb_group_and_directors/load", { period_label: P, bank_id: "NET-TEST" });
  assert.equal(mismatch.status, 409);
});

test("without exposures the check says what to enter", { skip: !havePdfs }, async () => {
  const { body } = await post("/api/graph/NET-TEST/check", { period_label: P });
  assert.equal(body.has_data, false);
  assert.match(body.message, /No exposures/);
});
