const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const store = require("../services/graph/graphStore");
const graphRules = require("../services/graph/graphRules");
const graphService = require("../services/graph/graphComplianceService");
const categoryService = require("../services/categoryService");

const SCENARIO_FILE = path.join(__dirname, "..", "..", "eval", "graph_scenarios.json");
let scenarioCache = null;
function scenarios() {
  if (!scenarioCache) scenarioCache = JSON.parse(fs.readFileSync(SCENARIO_FILE, "utf8"));
  return scenarioCache;
}

const asList = (body, key) => (Array.isArray(body) ? body : Array.isArray(body?.[key]) ? body[key] : body ? [body] : []);
const flag = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : v === true || v === "true" || v === 1 || v === "1");

function vocabulary(req, res) {
  res.json(store.VOCABULARY);
}

function listRules(req, res) {
  const category = req.query.category ? categoryService.normalise(req.query.category) : null;
  res.json({ rules: graphRules.catalog(category) });
}

function listScenarios(req, res) {
  const data = scenarios();
  res.json({
    note: data._note,
    scenarios: data.scenarios.map(({ id, title, category, description, profile }) => ({ id, title, category, description, profile })),
  });
}

/**
 * Load a synthetic sample network. Without bank_id a demo bank of the
 * scenario's category is created (or reused); with bank_id the network
 * replaces that bank's network (its category must match unless force=true).
 */
function loadScenario(req, res) {
  const sc = scenarios().scenarios.find((s) => s.id === req.params.scenarioId);
  if (!sc) return res.status(404).json({ error: "scenario not found" });
  const periodLabel = req.body.period_label;
  if (!periodLabel) return res.status(400).json({ error: "period_label is required" });
  let bankId = req.body.bank_id;
  if (bankId) {
    const bank = db.prepare("SELECT * FROM banks WHERE bank_id = ?").get(bankId);
    if (!bank) return res.status(404).json({ error: "bank not found" });
    if (bank.institution_category !== sc.category && !flag(req.body.force, false)) {
      return res.status(409).json({
        error: `This sample is written for ${sc.category.replace(/_/g, " ")}; ${bank.bank_name} is ${bank.institution_category.replace(/_/g, " ")}. Its limits would not apply as described.`,
        code: "category_mismatch",
      });
    }
  } else {
    bankId = `DEMO-${sc.id.toUpperCase().replace(/_/g, "-")}`.slice(0, 40);
    db.prepare(
      `INSERT INTO banks (bank_id, bank_name, institution_category) VALUES (?, ?, ?)
       ON CONFLICT(bank_id) DO UPDATE SET bank_name = excluded.bank_name, institution_category = excluded.institution_category`
    ).run(bankId, `Demo – ${sc.title}`.slice(0, 120), sc.category);
  }
  const imported = store.importBundle(
    bankId,
    periodLabel,
    { entities: sc.entities, edges: sc.edges.map((e) => ({ ...e, source: "scenario" })), exposures: sc.exposures, capital: sc.capital, profile: sc.profile },
    { replace: true }
  );
  res.json({ bank_id: bankId, scenario: sc.id, period_label: periodLabel, imported, bank: db.prepare("SELECT * FROM banks WHERE bank_id = ?").get(bankId) });
}

function getNetwork(req, res) {
  res.json(store.getNetwork(req.params.bankId, req.query.period_label || null));
}

function upsertEntities(req, res) {
  res.json(store.upsertEntities(req.params.bankId, asList(req.body, "entities")));
}

function deleteEntity(req, res) {
  res.json(store.deleteEntity(req.params.bankId, req.params.entityId));
}

function upsertEdges(req, res) {
  res.json(store.upsertEdges(req.params.bankId, asList(req.body, "edges")));
}

function reviewEdge(req, res) {
  res.json(store.reviewEdge(req.params.bankId, Number(req.params.edgeId), req.body || {}));
}

function deleteEdge(req, res) {
  res.json(store.deleteEdge(req.params.bankId, Number(req.params.edgeId)));
}

function upsertExposures(req, res) {
  res.json(store.upsertExposures(req.params.bankId, req.body?.period_label, asList(req.body, "exposures")));
}

function deleteExposure(req, res) {
  res.json(store.deleteExposure(req.params.bankId, Number(req.params.exposureId)));
}

function setCapital(req, res) {
  res.json(store.setCapital(req.params.bankId, req.body?.period_label, req.body || {}));
}

function setProfile(req, res) {
  res.json(store.setProfile(req.params.bankId, req.body || {}));
}

function importNetwork(req, res) {
  const { period_label, replace, ...bundle } = req.body || {};
  res.json(store.importBundle(req.params.bankId, period_label, bundle, { replace: flag(replace, false) }));
}

function exportNetwork(req, res) {
  res.json(store.exportBundle(req.params.bankId, req.query.period_label || null));
}

function runCheck(req, res) {
  const { period_label, include_flagged, persist } = req.body || {};
  res.json(
    graphService.runGraphCheck({
      bankId: req.params.bankId,
      periodLabel: period_label,
      includeFlagged: flag(include_flagged, true),
      persist: flag(persist, false),
    })
  );
}

function listRuns(req, res) {
  res.json(graphService.listGraphRuns(req.params.bankId));
}

function getRun(req, res) {
  const run = graphService.getGraphRun({ graphRunId: Number(req.params.graphRunId) });
  if (!run) return res.status(404).json({ error: "network check run not found" });
  res.json(run);
}

module.exports = {
  vocabulary, listRules, listScenarios, loadScenario, getNetwork, upsertEntities, deleteEntity,
  upsertEdges, reviewEdge, deleteEdge, upsertExposures, deleteExposure, setCapital, setProfile,
  importNetwork, exportNetwork, runCheck, listRuns, getRun,
};
