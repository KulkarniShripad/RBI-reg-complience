/**
 * Storage for the counterparty network (graph_* tables): validation,
 * create / update / delete, and bulk import. Validation errors carry the row
 * they came from so a CSV / JSON import can be fixed and re-sent.
 */
const db = require("../../config/db");
const { SELF } = require("./graphEngine");

const ENTITY_TYPES = ["company", "individual", "firm", "trust", "bank", "nbfc", "insurer", "government", "ccp", "fund", "other"];
const ITE_CLASSES = ["regulated_financial", "unregulated_financial", "non_financial"];
const GROUP_RELATIONS = ["subsidiary", "associate", "joint_venture", "related_party", "promoter", "nofhc", "common_brand"];
const EDGE_TYPES = ["OWNS", "CONTROLS", "COMMON_MANAGEMENT", "ECONOMIC_DEPENDENCE", "DIRECTOR_OF", "INTERESTED_IN", "RELATIVE_OF", "PROMOTER_OF"];
const CONTROL_BASES = ["voting_agreement", "board_appointment", "management_influence", "accounting_standard", "other"];
const ROLES = ["partner", "manager", "employee", "guarantor", "managing_agent", "substantial_interest", "trustee", "other"];
const RELATIONS = ["spouse", "minor_child", "dependent_child", "other"];
const EDGE_STATUSES = ["confirmed", "flagged", "rebutted"];
const EXPOSURE_KINDS = ["fund_based", "non_fund_based", "investment", "equity", "interbank", "derivative"];
const EXEMPT_REASONS = ["sovereign", "rbi", "goi_guaranteed", "intraday_interbank", "food_credit", "qccp_clearing", "psl_deposit", "other"];
// Edges that may point at / start from the bank itself.
const INTO_SELF = new Set(["DIRECTOR_OF", "PROMOTER_OF", "OWNS", "CONTROLS"]);
const FROM_SELF = new Set(["OWNS", "CONTROLS"]);

class GraphInputError extends Error {
  constructor(message, details = []) {
    super(message);
    this.status = 400;
    this.code = "invalid_network_data";
    this.details = details;
  }
}

const str = (v) => (v === undefined || v === null ? "" : String(v).trim());
const num = (v) => (v === undefined || v === null || str(v) === "" ? null : Number(v));
const bool = (v) => (["1", "true", "yes", "y"].includes(str(v).toLowerCase()) || v === true ? 1 : 0);
const lower = (v) => str(v).toLowerCase().replace(/[\s-]+/g, "_");

function ensureBank(bankId) {
  const bank = db.prepare("SELECT * FROM banks WHERE bank_id = ?").get(bankId);
  if (!bank) {
    const err = new Error("bank not found");
    err.status = 404;
    throw err;
  }
  db.prepare(
    `INSERT INTO graph_entities (bank_id, entity_id, name, entity_type) VALUES (?, ?, ?, 'self')
     ON CONFLICT(bank_id, entity_id) DO UPDATE SET name = excluded.name`
  ).run(bankId, SELF, bank.bank_name);
  return bank;
}

// ── validation ──────────────────────────────────────────────────────────────

function normaliseEntity(raw, i) {
  const errors = [];
  const attributes = { ...(typeof raw.attributes === "object" && raw.attributes ? raw.attributes : {}) };
  for (const flag of ["gold_loan_nbfc", "section8_company", "government_company", "non_strategic_investor", "econ_assessed", "sovereign"]) {
    if (raw[flag] !== undefined && str(raw[flag]) !== "") attributes[flag] = !!bool(raw[flag]);
  }
  for (const key of ["pan", "cin", "lei", "sector"]) if (str(raw[key])) attributes[key] = str(raw[key]);
  const e = {
    entity_id: str(raw.entity_id ?? raw.id),
    name: str(raw.name),
    entity_type: lower(raw.entity_type ?? raw.type) || "company",
    ite_class: lower(raw.ite_class) || null,
    group_relation: lower(raw.group_relation) || null,
    attributes,
  };
  if (!e.entity_id) errors.push({ row: i, field: "entity_id", message: "entity_id is required" });
  if (e.entity_id === SELF) errors.push({ row: i, field: "entity_id", message: "SELF is reserved for the reporting bank" });
  if (!e.name) errors.push({ row: i, field: "name", message: "name is required" });
  if (!ENTITY_TYPES.includes(e.entity_type)) errors.push({ row: i, field: "entity_type", message: `entity_type must be one of ${ENTITY_TYPES.join(", ")}` });
  if (e.ite_class && !ITE_CLASSES.includes(e.ite_class)) errors.push({ row: i, field: "ite_class", message: `ite_class must be one of ${ITE_CLASSES.join(", ")}` });
  if (e.group_relation && !GROUP_RELATIONS.includes(e.group_relation)) errors.push({ row: i, field: "group_relation", message: `group_relation must be one of ${GROUP_RELATIONS.join(", ")}` });
  return { value: e, errors };
}

function normaliseEdge(raw, i, known) {
  const errors = [];
  const e = {
    from_entity: str(raw.from_entity ?? raw.from),
    to_entity: str(raw.to_entity ?? raw.to),
    edge_type: str(raw.edge_type ?? raw.type).toUpperCase().replace(/[\s-]+/g, "_"),
    ownership_pct: num(raw.ownership_pct ?? raw.pct),
    basis: lower(raw.basis) || null,
    criterion: num(raw.criterion),
    role: lower(raw.role) || null,
    relation: lower(raw.relation) || null,
    bidirectional: bool(raw.bidirectional),
    status: lower(raw.status) || "confirmed",
    evidence: str(raw.evidence) || null,
    source: str(raw.source) || "manual",
  };
  const where = (field, message) => errors.push({ row: i, field, message });
  if (!EDGE_TYPES.includes(e.edge_type)) where("edge_type", `edge_type must be one of ${EDGE_TYPES.join(", ")}`);
  if (!e.from_entity) where("from_entity", "from_entity is required");
  if (!e.to_entity) where("to_entity", "to_entity is required");
  if (e.from_entity && e.from_entity === e.to_entity) where("to_entity", "an edge cannot connect an entity to itself");
  for (const [field, id] of [["from_entity", e.from_entity], ["to_entity", e.to_entity]]) {
    if (id && id !== SELF && known && !known.has(id)) where(field, `unknown entity '${id}' - add it to the entities first`);
  }
  if (e.to_entity === SELF && !INTO_SELF.has(e.edge_type)) where("to_entity", `${e.edge_type} cannot point at the bank itself`);
  if (e.from_entity === SELF && !FROM_SELF.has(e.edge_type)) where("from_entity", `${e.edge_type} cannot start from the bank itself`);
  if (e.edge_type === "OWNS" && (e.ownership_pct === null || !(e.ownership_pct > 0 && e.ownership_pct <= 100))) {
    where("ownership_pct", "OWNS needs ownership_pct between 0 and 100");
  }
  if (e.edge_type === "CONTROLS" && e.basis && !CONTROL_BASES.includes(e.basis)) where("basis", `basis must be one of ${CONTROL_BASES.join(", ")}`);
  if (e.edge_type === "ECONOMIC_DEPENDENCE" && e.criterion !== null && !(e.criterion >= 1 && e.criterion <= 7)) {
    where("criterion", "criterion must be 1-7 (the economic interdependence criteria)");
  }
  if (e.edge_type === "INTERESTED_IN" && !ROLES.includes(e.role || "")) where("role", `INTERESTED_IN needs role: ${ROLES.join(", ")}`);
  if (e.edge_type === "RELATIVE_OF" && e.relation && !RELATIONS.includes(e.relation)) where("relation", `relation must be one of ${RELATIONS.join(", ")}`);
  if (!EDGE_STATUSES.includes(e.status)) where("status", `status must be one of ${EDGE_STATUSES.join(", ")}`);
  return { value: e, errors };
}

function normaliseExposure(raw, i, known) {
  const errors = [];
  const x = {
    entity_id: str(raw.entity_id ?? raw.counterparty),
    exposure_kind: lower(raw.exposure_kind ?? raw.kind) || "fund_based",
    amount: num(raw.amount),
    sanctioned_limit: num(raw.sanctioned_limit),
    crm_amount: num(raw.crm_amount) || 0,
    crm_provider: str(raw.crm_provider) || null,
    infrastructure: bool(raw.infrastructure),
    exempt_reason: lower(raw.exempt_reason) || null,
    board_approved_excess: bool(raw.board_approved_excess),
    section20_exception: str(raw.section20_exception) || null,
    note: str(raw.note) || null,
  };
  const where = (field, message) => errors.push({ row: i, field, message });
  if (!x.entity_id) where("entity_id", "entity_id is required");
  else if (x.entity_id === SELF) where("entity_id", "the bank cannot have an exposure to itself");
  else if (known && !known.has(x.entity_id)) where("entity_id", `unknown entity '${x.entity_id}'`);
  if (x.amount === null || Number.isNaN(x.amount) || x.amount < 0) where("amount", "amount (₹ crore) must be a number >= 0");
  if (x.sanctioned_limit !== null && (Number.isNaN(x.sanctioned_limit) || x.sanctioned_limit < 0)) where("sanctioned_limit", "must be >= 0");
  if (Number.isNaN(x.crm_amount) || x.crm_amount < 0) where("crm_amount", "must be >= 0");
  if (x.crm_provider && known && !known.has(x.crm_provider)) where("crm_provider", `unknown entity '${x.crm_provider}'`);
  if (!EXPOSURE_KINDS.includes(x.exposure_kind)) where("exposure_kind", `exposure_kind must be one of ${EXPOSURE_KINDS.join(", ")}`);
  if (x.exempt_reason && !EXEMPT_REASONS.includes(x.exempt_reason)) where("exempt_reason", `exempt_reason must be one of ${EXEMPT_REASONS.join(", ")}`);
  return { value: x, errors };
}

// ── reads ───────────────────────────────────────────────────────────────────

function parseEntity(row) {
  return { ...row, attributes: row.attributes ? JSON.parse(row.attributes) : {} };
}

function knownIds(bankId) {
  return new Set(db.prepare("SELECT entity_id FROM graph_entities WHERE bank_id = ?").all(bankId).map((r) => r.entity_id));
}

function getNetwork(bankId, periodLabel) {
  const bank = ensureBank(bankId);
  const entities = db.prepare("SELECT * FROM graph_entities WHERE bank_id = ? ORDER BY entity_type = 'self' DESC, name").all(bankId).map(parseEntity);
  const edges = db.prepare("SELECT * FROM graph_edges WHERE bank_id = ? ORDER BY edge_id").all(bankId);
  const exposures = periodLabel
    ? db.prepare("SELECT * FROM graph_exposures WHERE bank_id = ? AND period_label = ? ORDER BY amount DESC").all(bankId, periodLabel)
    : [];
  const capital = periodLabel
    ? db.prepare("SELECT * FROM graph_capital WHERE bank_id = ? AND period_label = ?").get(bankId, periodLabel) || null
    : null;
  const profile = db.prepare("SELECT * FROM graph_bank_profile WHERE bank_id = ?").get(bankId) || null;
  const periods = db
    .prepare("SELECT period_label, COUNT(*) AS exposures FROM graph_exposures WHERE bank_id = ? GROUP BY period_label ORDER BY period_label DESC")
    .all(bankId);
  return { bank, entities, edges, exposures, capital, profile, periods };
}

function hasGraphData(bankId, periodLabel) {
  try {
    const n = db.prepare("SELECT COUNT(*) AS n FROM graph_exposures WHERE bank_id = ? AND period_label = ?").get(bankId, periodLabel).n;
    return n > 0;
  } catch (_) {
    return false;
  }
}

// ── writes ──────────────────────────────────────────────────────────────────

const upsertEntityStmt = () =>
  db.prepare(
    `INSERT INTO graph_entities (bank_id, entity_id, name, entity_type, ite_class, group_relation, attributes)
     VALUES (@bank_id, @entity_id, @name, @entity_type, @ite_class, @group_relation, @attributes)
     ON CONFLICT(bank_id, entity_id) DO UPDATE SET name = excluded.name, entity_type = excluded.entity_type,
       ite_class = excluded.ite_class, group_relation = excluded.group_relation, attributes = excluded.attributes,
       updated_at = datetime('now')`
  );
const upsertEdgeStmt = () =>
  db.prepare(
    `INSERT INTO graph_edges (bank_id, from_entity, to_entity, edge_type, ownership_pct, basis, criterion, role, relation,
       bidirectional, status, evidence, source)
     VALUES (@bank_id, @from_entity, @to_entity, @edge_type, @ownership_pct, @basis, @criterion, @role, @relation,
       @bidirectional, @status, @evidence, @source)
     ON CONFLICT(bank_id, from_entity, to_entity, edge_type) DO UPDATE SET ownership_pct = excluded.ownership_pct,
       basis = excluded.basis, criterion = excluded.criterion, role = excluded.role, relation = excluded.relation,
       bidirectional = excluded.bidirectional, status = excluded.status, evidence = excluded.evidence, source = excluded.source`
  );
const upsertExposureStmt = () =>
  db.prepare(
    `INSERT INTO graph_exposures (bank_id, period_label, entity_id, exposure_kind, amount, sanctioned_limit, crm_amount,
       crm_provider, infrastructure, exempt_reason, board_approved_excess, section20_exception, note)
     VALUES (@bank_id, @period_label, @entity_id, @exposure_kind, @amount, @sanctioned_limit, @crm_amount,
       @crm_provider, @infrastructure, @exempt_reason, @board_approved_excess, @section20_exception, @note)
     ON CONFLICT(bank_id, period_label, entity_id, exposure_kind) DO UPDATE SET amount = excluded.amount,
       sanctioned_limit = excluded.sanctioned_limit, crm_amount = excluded.crm_amount, crm_provider = excluded.crm_provider,
       infrastructure = excluded.infrastructure, exempt_reason = excluded.exempt_reason,
       board_approved_excess = excluded.board_approved_excess, section20_exception = excluded.section20_exception, note = excluded.note`
  );

function validateAll(rows, fn, known, label) {
  const values = [];
  const errors = [];
  (rows || []).forEach((raw, i) => {
    const { value, errors: e } = fn(raw || {}, i + 1, known);
    values.push(value);
    errors.push(...e.map((x) => ({ ...x, table: label })));
  });
  return { values, errors };
}

function upsertEntities(bankId, rows) {
  ensureBank(bankId);
  const { values, errors } = validateAll(rows, normaliseEntity, null, "entities");
  if (errors.length) throw new GraphInputError("Some entities are invalid", errors);
  const stmt = upsertEntityStmt();
  db.transaction(() => values.forEach((v) => stmt.run({ ...v, bank_id: bankId, attributes: JSON.stringify(v.attributes) })))();
  return { upserted: values.length };
}

function deleteEntity(bankId, entityId) {
  if (entityId === SELF) throw new GraphInputError("The bank node cannot be deleted");
  const r = db.transaction(() => {
    const edges = db.prepare("DELETE FROM graph_edges WHERE bank_id = ? AND (from_entity = ? OR to_entity = ?)").run(bankId, entityId, entityId).changes;
    const exposures = db.prepare("DELETE FROM graph_exposures WHERE bank_id = ? AND entity_id = ?").run(bankId, entityId).changes;
    db.prepare("UPDATE graph_exposures SET crm_provider = NULL WHERE bank_id = ? AND crm_provider = ?").run(bankId, entityId);
    const entity = db.prepare("DELETE FROM graph_entities WHERE bank_id = ? AND entity_id = ?").run(bankId, entityId).changes;
    return { entity, edges, exposures };
  })();
  if (!r.entity) {
    const err = new Error("entity not found");
    err.status = 404;
    throw err;
  }
  return r;
}

function upsertEdges(bankId, rows) {
  ensureBank(bankId);
  const { values, errors } = validateAll(rows, normaliseEdge, knownIds(bankId), "edges");
  if (errors.length) throw new GraphInputError("Some relationships are invalid", errors);
  const stmt = upsertEdgeStmt();
  db.transaction(() => values.forEach((v) => stmt.run({ ...v, bank_id: bankId })))();
  return { upserted: values.length };
}

function reviewEdge(bankId, edgeId, { status, review_note }) {
  const s = lower(status);
  if (!EDGE_STATUSES.includes(s)) throw new GraphInputError(`status must be one of ${EDGE_STATUSES.join(", ")}`);
  const r = db
    .prepare("UPDATE graph_edges SET status = ?, review_note = ?, reviewed_at = datetime('now') WHERE bank_id = ? AND edge_id = ?")
    .run(s, str(review_note) || null, bankId, edgeId);
  if (!r.changes) {
    const err = new Error("relationship not found");
    err.status = 404;
    throw err;
  }
  return db.prepare("SELECT * FROM graph_edges WHERE edge_id = ?").get(edgeId);
}

function deleteEdge(bankId, edgeId) {
  const r = db.prepare("DELETE FROM graph_edges WHERE bank_id = ? AND edge_id = ?").run(bankId, edgeId);
  if (!r.changes) {
    const err = new Error("relationship not found");
    err.status = 404;
    throw err;
  }
  return { deleted: r.changes };
}

function requirePeriod(periodLabel) {
  if (!str(periodLabel)) throw new GraphInputError("period_label is required");
}

function upsertExposures(bankId, periodLabel, rows) {
  requirePeriod(periodLabel);
  ensureBank(bankId);
  const { values, errors } = validateAll(rows, normaliseExposure, knownIds(bankId), "exposures");
  if (errors.length) throw new GraphInputError("Some exposures are invalid", errors);
  const stmt = upsertExposureStmt();
  db.transaction(() => values.forEach((v) => stmt.run({ ...v, bank_id: bankId, period_label: periodLabel })))();
  return { upserted: values.length };
}

function deleteExposure(bankId, exposureId) {
  const r = db.prepare("DELETE FROM graph_exposures WHERE bank_id = ? AND exposure_id = ?").run(bankId, exposureId);
  if (!r.changes) {
    const err = new Error("exposure not found");
    err.status = 404;
    throw err;
  }
  return { deleted: r.changes };
}

function setCapital(bankId, periodLabel, values) {
  requirePeriod(periodLabel);
  ensureBank(bankId);
  const v = {
    tier1_capital: num(values.tier1_capital),
    tier2_capital: num(values.tier2_capital),
    owned_funds: num(values.owned_funds),
    paid_up_capital_reserves: num(values.paid_up_capital_reserves),
  };
  const errors = Object.entries(v)
    .filter(([, x]) => x !== null && (Number.isNaN(x) || x < 0))
    .map(([field]) => ({ field, message: "must be a number >= 0 (₹ crore)" }));
  if (errors.length) throw new GraphInputError("Invalid capital figures", errors);
  db.prepare(
    `INSERT INTO graph_capital (bank_id, period_label, tier1_capital, tier2_capital, owned_funds, paid_up_capital_reserves)
     VALUES (@bank_id, @period_label, @tier1_capital, @tier2_capital, @owned_funds, @paid_up_capital_reserves)
     ON CONFLICT(bank_id, period_label) DO UPDATE SET tier1_capital = excluded.tier1_capital, tier2_capital = excluded.tier2_capital,
       owned_funds = excluded.owned_funds, paid_up_capital_reserves = excluded.paid_up_capital_reserves, updated_at = datetime('now')`
  ).run({ ...v, bank_id: bankId, period_label: periodLabel });
  return db.prepare("SELECT * FROM graph_capital WHERE bank_id = ? AND period_label = ?").get(bankId, periodLabel);
}

function setProfile(bankId, values) {
  ensureBank(bankId);
  const layer = str(values.nbfc_layer).toUpperCase() || null;
  const rating = str(values.rcb_rating).toUpperCase() || null;
  const errors = [];
  if (layer && !["BL", "ML", "UL"].includes(layer)) errors.push({ field: "nbfc_layer", message: "nbfc_layer must be BL, ML or UL" });
  if (rating && !["A", "B+", "B", "C", "D"].includes(rating)) errors.push({ field: "rcb_rating", message: "rcb_rating must be A, B+, B, C or D" });
  if (errors.length) throw new GraphInputError("Invalid profile", errors);
  db.prepare(
    `INSERT INTO graph_bank_profile (bank_id, nbfc_layer, nbfc_is_ifc, rcb_rating) VALUES (?, ?, ?, ?)
     ON CONFLICT(bank_id) DO UPDATE SET nbfc_layer = excluded.nbfc_layer, nbfc_is_ifc = excluded.nbfc_is_ifc,
       rcb_rating = excluded.rcb_rating, updated_at = datetime('now')`
  ).run(bankId, layer, bool(values.nbfc_is_ifc), rating);
  return db.prepare("SELECT * FROM graph_bank_profile WHERE bank_id = ?").get(bankId);
}

/**
 * Import a whole network in one transaction. Everything is validated first;
 * nothing is written if any row is invalid.
 * @param {{entities?, edges?, exposures?, capital?, profile?}} bundle
 * @param {{replace?: boolean}} opts replace = delete this bank's network (and
 *   this period's exposures) first
 */
function importBundle(bankId, periodLabel, bundle, { replace = false } = {}) {
  ensureBank(bankId);
  if ((bundle.exposures?.length || bundle.capital) && !str(periodLabel)) {
    throw new GraphInputError("period_label is required to import exposures or capital");
  }
  const existing = replace ? new Set() : knownIds(bankId);
  const ents = validateAll(bundle.entities, normaliseEntity, null, "entities");
  const known = new Set([...existing, ...ents.values.map((e) => e.entity_id), SELF]);
  const edges = validateAll(bundle.edges, normaliseEdge, known, "edges");
  const exps = validateAll(bundle.exposures, normaliseExposure, known, "exposures");
  const errors = [...ents.errors, ...edges.errors, ...exps.errors];
  const dupIds = ents.values.map((e) => e.entity_id).filter((id, i, a) => id && a.indexOf(id) !== i);
  dupIds.forEach((id) => errors.push({ table: "entities", field: "entity_id", message: `duplicate entity_id '${id}'` }));
  if (errors.length) throw new GraphInputError(`Import rejected: ${errors.length} problem${errors.length === 1 ? "" : "s"}`, errors);

  db.transaction(() => {
    if (replace) {
      db.prepare("DELETE FROM graph_edges WHERE bank_id = ?").run(bankId);
      db.prepare("DELETE FROM graph_entities WHERE bank_id = ? AND entity_id <> ?").run(bankId, SELF);
      if (periodLabel) db.prepare("DELETE FROM graph_exposures WHERE bank_id = ? AND period_label = ?").run(bankId, periodLabel);
    }
    const se = upsertEntityStmt();
    ents.values.forEach((v) => se.run({ ...v, bank_id: bankId, attributes: JSON.stringify(v.attributes) }));
    const sg = upsertEdgeStmt();
    edges.values.forEach((v) => sg.run({ ...v, bank_id: bankId }));
    const sx = upsertExposureStmt();
    exps.values.forEach((v) => sx.run({ ...v, bank_id: bankId, period_label: periodLabel }));
  })();
  if (bundle.capital) setCapital(bankId, periodLabel, bundle.capital);
  if (bundle.profile) setProfile(bankId, bundle.profile);
  return { entities: ents.values.length, edges: edges.values.length, exposures: exps.values.length, replaced: !!replace };
}

function exportBundle(bankId, periodLabel) {
  const n = getNetwork(bankId, periodLabel);
  return {
    entities: n.entities
      .filter((e) => e.entity_id !== SELF)
      .map(({ entity_id, name, entity_type, ite_class, group_relation, attributes }) => ({ entity_id, name, entity_type, ite_class, group_relation, attributes })),
    edges: n.edges.map(({ from_entity, to_entity, edge_type, ownership_pct, basis, criterion, role, relation, bidirectional, status, evidence }) =>
      ({ from_entity, to_entity, edge_type, ownership_pct, basis, criterion, role, relation, bidirectional, status, evidence })),
    exposures: n.exposures.map(({ entity_id, exposure_kind, amount, sanctioned_limit, crm_amount, crm_provider, infrastructure, exempt_reason, board_approved_excess, section20_exception, note }) =>
      ({ entity_id, exposure_kind, amount, sanctioned_limit, crm_amount, crm_provider, infrastructure, exempt_reason, board_approved_excess, section20_exception, note })),
    capital: n.capital && {
      tier1_capital: n.capital.tier1_capital, tier2_capital: n.capital.tier2_capital,
      owned_funds: n.capital.owned_funds, paid_up_capital_reserves: n.capital.paid_up_capital_reserves,
    },
    profile: n.profile && { nbfc_layer: n.profile.nbfc_layer, nbfc_is_ifc: n.profile.nbfc_is_ifc, rcb_rating: n.profile.rcb_rating },
  };
}

const VOCABULARY = {
  entity_types: ENTITY_TYPES,
  ite_classes: ITE_CLASSES,
  group_relations: GROUP_RELATIONS,
  edge_types: EDGE_TYPES,
  control_bases: CONTROL_BASES,
  roles: ROLES,
  relations: RELATIONS,
  edge_statuses: EDGE_STATUSES,
  exposure_kinds: EXPOSURE_KINDS,
  exempt_reasons: EXEMPT_REASONS,
};

module.exports = {
  GraphInputError,
  VOCABULARY,
  getNetwork,
  hasGraphData,
  upsertEntities,
  deleteEntity,
  upsertEdges,
  reviewEdge,
  deleteEdge,
  upsertExposures,
  deleteExposure,
  setCapital,
  setProfile,
  importBundle,
  exportBundle,
  normaliseEntity,
  normaliseEdge,
  normaliseExposure,
};
