/**
 * Automatic compliance check from bank documents, end to end through the
 * API, on a throw-away corpus built from three real Master Directions
 * (Small Finance Banks capital adequacy and ALM, Urban Co-operative Banks
 * capital adequacy) and the documents in sample-data/.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const PDFS = [
  ["small financial banks", "182MD.PDF"],
  ["small financial banks", "194MD.PDF"],
  ["Urban_Cooperative_Bank", "275MD3D20366A706C4C13B4FA21A3DC0451A1.PDF"],
].map(([dir, f]) => [dir, path.join(REPO, "circulars", dir, f)]);
const SAMPLES = path.join(REPO, "sample-data");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urcc-disc-"));
const circulars = path.join(tmp, "circulars");
for (const [dir, file] of PDFS) {
  if (!fs.existsSync(file)) continue;
  fs.mkdirSync(path.join(circulars, dir), { recursive: true });
  fs.copyFileSync(file, path.join(circulars, dir, path.basename(file)));
}

Object.assign(process.env, {
  NODE_ENV: "test",
  RELATIONAL_DB_PATH: path.join(tmp, "urcc_ef.db"),
  VECTOR_DB_PATH: path.join(tmp, "urcc_ef_vectors.db"),
  CIRCULARS_ROOT: circulars,
  EMBEDDING_MODEL_DIR: path.join(tmp, "no-model"),
  EMBEDDING_ALLOW_REMOTE: "false",
  EMBED_MISSING_ON_START: "false",
  GEMINI_API_KEY: "",
});

const ready = PDFS.every(([, f]) => fs.existsSync(f)) && fs.existsSync(path.join(SAMPLES, "manifest.json"));
let base;
let server;

test.before(async () => {
  if (!ready) return;
  execFileSync("python3", [
    path.join(__dirname, "..", "scripts", "db_builder.py"), "build",
    "--circulars", circulars, "--db", process.env.RELATIONAL_DB_PATH, "--workers", "1",
  ], { stdio: "pipe" });
  const { app } = require("../src/server");
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (method, url, body) =>
  fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({
    status: r.status,
    body: await r.json(),
  }));

async function upload(file, name = path.basename(file), fields = {}) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), name);
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const r = await fetch(`${base}/api/disclosures/analyze`, { method: "POST", body: form });
  return { status: r.status, body: await r.json() };
}

test("sample documents are listed with their expectations", { skip: !ready }, async () => {
  const r = await json("GET", "/api/disclosures/samples");
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 10);
  assert.ok(r.body.some((s) => s.kind === "public" && s.source_url));
  assert.ok(r.body.every((s) => s.size > 0));
});

test("a Pillar 3 PDF is read, the bank registered and breaches found against the cited paragraphs", { skip: !ready }, async () => {
  const a = await json("POST", "/api/disclosures/samples/analyze", { file: "test-cases/example-sfb-pillar3-sep-2025.pdf" });
  assert.equal(a.status, 201);
  const p = a.body.profile;
  assert.equal(p.bank_name, "Example Small Finance Bank Limited");
  assert.equal(p.institution_category, "small_finance_banks");
  assert.equal(p.period_label, "Q2-FY2025-26");
  assert.equal(p.doc_type, "pillar3");
  // current-quarter column, not the regulatory 15% stated in the text
  assert.equal(a.body.metrics.crar.value, 14.2);
  assert.equal(a.body.metrics.lcr.value, 96.4);
  assert.equal(a.body.metrics.crar.page, 1);

  const r = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  assert.equal(r.status, 200);
  const rep = r.body.report;
  assert.equal(rep.overall, "BREACH");
  assert.equal(rep.bank.created, true);
  const byKey = Object.fromEntries(rep.rule_results.map((x) => [x.rule_key, x]));
  assert.equal(byKey.sfb_crar.status, "BREACH");
  assert.equal(byKey.sfb_crar.threshold, 15);
  assert.equal(byKey.sfb_crar.source.verified, true);
  assert.match(byKey.sfb_crar.source.excerpt, /at least 15 per cent/);
  assert.equal(byKey.sfb_leverage.status, "BREACH");
  assert.equal(byKey.sfb_lcr.status, "BREACH");
  assert.equal(byKey.sfb_nsfr.status, "PASS");
  assert.equal(byKey.sfb_cet1.status, "PASS");
  assert.ok(rep.executive_summary.includes("Example Small Finance Bank"));
  assert.equal(rep.executive_summary_by, "template");

  // persisted: listed as an automatic run, full report returned, HTML export
  const runs = await json("GET", `/api/compliance/${rep.bank.bank_id}/runs`);
  assert.equal(runs.body[0].mode, "auto");
  assert.equal(runs.body[0].overall, "BREACH");
  const run = await json("GET", `/api/compliance/runs/${r.body.run_id}`);
  assert.equal(run.body.auto_report.rule_results.length, rep.rule_results.length);
  const html = await fetch(`${base}/api/disclosures/runs/${r.body.run_id}/report.html`).then((x) => x.text());
  assert.match(html, /Example Small Finance Bank Limited/);
  assert.match(html, /Breach/);

  // the manual per-rule form is filled where a rule atom states the same threshold
  assert.ok(rep.summary.submissions_backfilled > 0);
  const subs = await json("GET", `/api/banks/${rep.bank.bank_id}/quant-submissions`);
  assert.ok(subs.body.some((s) => /auto: /.test(s.source_note)));
});

test("re-uploading the same file returns the earlier analysis", { skip: !ready }, async () => {
  const file = path.join(SAMPLES, "test-cases", "example-ucb-figures-mar-2026.xlsx");
  const first = await upload(file);
  assert.equal(first.status, 201);
  const again = await upload(file);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.upload_id, first.body.upload_id);
});

test("a UCB spreadsheet: tier from deposits decides the CRAR minimum; net worth glide path", { skip: !ready }, async () => {
  const a = await upload(path.join(SAMPLES, "test-cases", "example-ucb-figures-mar-2026.xlsx"), "ucb.xlsx", { force: "true" });
  assert.equal(a.body.profile.institution_category, "urban_cooperative_banks");
  assert.equal(a.body.profile.ucb_tier, 2);
  assert.equal(a.body.metrics.total_deposits.value, 850);
  const r = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  const byKey = Object.fromEntries(r.body.report.rule_results.map((x) => [x.rule_key, x]));
  assert.equal(byKey.ucb_crar.status, "BREACH");
  assert.equal(byKey.ucb_crar.threshold, 12);
  assert.equal(byKey.ucb_net_worth.status, "PASS_WITH_CONDITIONS");
});

test("a CSV of figures, corrected on the review screen, is re-checked", { skip: !ready }, async () => {
  const csv = "metric,value\nBank name,Sample Small Finance Bank Limited\nAs on,30-06-2025\nCRAR,14.9\nTier 1 ratio,12.1\n";
  const f = path.join(tmp, "figures.csv");
  fs.writeFileSync(f, csv);
  const a = await upload(f);
  assert.equal(a.status, 201);
  assert.equal(a.body.metrics.crar.value, 14.9);
  const r1 = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, { persist: false });
  assert.equal(r1.body.report.rule_results.find((x) => x.rule_key === "sfb_crar").status, "BREACH");
  assert.equal(r1.body.run_id, null);

  const bad = await json("PATCH", `/api/disclosures/${a.body.upload_id}`, { metrics: { crar: 900 } });
  assert.equal(bad.status, 400);
  const fixed = await json("PATCH", `/api/disclosures/${a.body.upload_id}`, { metrics: { crar: 15.4 } });
  assert.equal(fixed.status, 200);
  assert.equal(fixed.body.metrics.crar.method, "manual");
  assert.equal(fixed.body.metrics.crar.alternatives[0].value, 14.9);
  const r2 = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  assert.equal(r2.body.report.rule_results.find((x) => x.rule_key === "sfb_crar").status, "PASS");
});

test("missing profile fields must be confirmed before a run; bad files are refused", { skip: !ready }, async () => {
  const f = path.join(tmp, "nameless.txt");
  fs.writeFileSync(f, "Key ratios\nCRAR (%) | 16.2\nLeverage ratio (%) | 5.0\n");
  const a = await upload(f);
  assert.equal(a.status, 201);
  assert.equal(a.body.profile.bank_name, null);
  const r = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  assert.equal(r.status, 400);
  assert.deepEqual(r.body.details.missing.sort(), ["bank_id", "bank_name", "institution_category", "period_label"].sort());
  const bad = await json("PATCH", `/api/disclosures/${a.body.upload_id}`, { profile: { institution_category: "spaceships" } });
  assert.equal(bad.status, 400);
  const ok = await json("PATCH", `/api/disclosures/${a.body.upload_id}`, {
    profile: { bank_name: "Nameless Small Finance Bank", bank_id: "NAMELESS-SFB", institution_category: "SFB", as_of_date: "2025-12-31" },
  });
  assert.equal(ok.body.profile.period_label, "Q3-FY2025-26");
  const r2 = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  assert.equal(r2.status, 200);
  assert.equal(r2.body.report.rule_results.find((x) => x.rule_key === "sfb_crar").status, "PASS");

  const exe = path.join(tmp, "x.exe");
  fs.writeFileSync(exe, "MZ");
  assert.equal((await upload(exe)).status, 415);
  const empty = path.join(tmp, "empty.txt");
  fs.writeFileSync(empty, " \n ");
  assert.equal((await upload(empty)).status, 422);
});

test("LLM-read figures are accepted only when the quoted line and number are in the document", { skip: !ready }, async () => {
  const gemini = require("../src/services/geminiService");
  const orig = { isConfigured: gemini.isConfigured, extract: gemini.extractDisclosureMetrics, profile: gemini.detectDisclosureProfile };
  gemini.isConfigured = () => true;
  gemini.detectDisclosureProfile = async () => ({});
  gemini.extractDisclosureMetrics = async () => ({
    crar: { value: 17.25, page: 1, quote: "Our capital position stayed strong with capital funds at seventeen point two five, i.e. 17.25" },
    lcr: { value: 250, page: 1, quote: "LCR stood at 250" }, // not in the document: must be rejected
  });
  try {
    const f = path.join(tmp, "narrative.txt");
    fs.writeFileSync(f, "Demo Small Finance Bank Limited\nAs on 31 March 2026\nOur capital position stayed strong with capital funds at seventeen point two five, i.e. 17.25\n");
    const a = await upload(f);
    assert.equal(a.body.metrics.crar?.value, 17.25);
    assert.equal(a.body.metrics.crar.method, "llm");
    assert.equal(a.body.metrics.lcr, undefined);
    assert.deepEqual(a.body.profile.llm_used.metrics, ["crar"]);
  } finally {
    gemini.isConfigured = orig.isConfigured;
    gemini.extractDisclosureMetrics = orig.extract;
    gemini.detectDisclosureProfile = orig.profile;
  }
});

test("when the bank's counterparty network is entered, the automatic check includes it", { skip: !ready }, async () => {
  const a = await json("POST", "/api/disclosures/samples/analyze", { file: "test-cases/example-sfb-pillar3-sep-2025.pdf", force: true });
  const bankId = a.body.profile.bank_id;
  const imp = await json("POST", `/api/graph/${bankId}/import`, {
    period_label: a.body.profile.period_label,
    replace: true,
    capital: { tier1_capital: 100, tier2_capital: 10 },
    entities: [
      { entity_id: "A", name: "Apex Ltd", entity_type: "company" },
      { entity_id: "B", name: "Apex Subsidiary Ltd", entity_type: "company" },
    ],
    edges: [{ from_entity: "A", to_entity: "B", edge_type: "OWNS", ownership_pct: 80 }],
    exposures: [{ entity_id: "A", amount: 30 }, { entity_id: "B", amount: 20 }],
  });
  assert.ok([200, 201].includes(imp.status), JSON.stringify(imp.body));
  const r = await json("POST", `/api/disclosures/${a.body.upload_id}/run`, {});
  assert.equal(r.status, 200);
  assert.ok(r.body.report.network, "network section present");
  assert.ok(r.body.report.network.results.length > 0);
  assert.equal(typeof r.body.report.summary.network_checked, "number");
  const html = await fetch(`${base}/api/disclosures/runs/${r.body.run_id}/report.html`).then((x) => x.text());
  assert.match(html, /Counterparty network/);
});
