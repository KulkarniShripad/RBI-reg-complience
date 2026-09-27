/**
 * NETWORK TOPOLOGY MAPPER - graph algorithms (Subsystem 3).
 *
 * Pure functions over one bank's counterparty network: no database, no I/O,
 * so every rule below can be unit-tested against RBI's own worked examples
 * (test/graph.test.js).
 *
 * What the graph answers that row-by-row rules cannot:
 *   1. Groups of connected counterparties (Large Exposures Framework): who
 *      must be aggregated into one exposure because of CONTROL (direct or
 *      indirect, >50% voting rights = automatic) or ECONOMIC INTERDEPENDENCE
 *      (one-way / two-way dependence, downstream and upstream contagion).
 *   2. Related-party paths: is a borrower the bank's director, a firm or
 *      company the director is interested in (Section 20, BR Act), a
 *      relative, a promoter, a >=10% shareholder or an entity they control?
 *   3. The bank's own group (intra-group exposure limits): subsidiaries,
 *      associates, parents / promoters and entities they control.
 *
 * Edge semantics are documented in migrations/004_graph_network.sql.
 * Rebutted edges are ignored (the bank has demonstrated to RBI that the link
 * does not create a single risk). Flagged edges are used only when
 * `includeFlagged` is set, and everything that depends on one is reported
 * as provisional - a flagged link is never treated as established fact.
 */

const SELF = "SELF";

const ECON_CRITERIA = {
  1: "50% or more of gross receipts / expenditures derived from transactions with the other counterparty",
  2: "guarantee or other liability so significant that the guarantor is likely to default if a claim occurs",
  3: "significant part of output sold to the other counterparty, not easily replaced",
  4: "same expected source of funds to repay the loans, no independent source of income",
  5: "financial problems of one likely to cause repayment difficulties for the other",
  6: "insolvency or default of one likely to be associated with the other's",
  7: "reliance on the same source for the majority of funding, no alternative provider",
};

const SECTION20_ROLES = new Set(["partner", "manager", "employee", "guarantor", "managing_agent", "substantial_interest"]);
const FIRM_ROLES = new Set(["partner", "manager", "employee", "guarantor"]);
const INDIVIDUAL_ROLES = new Set(["partner", "guarantor"]);
const CLOSE_RELATIVES = new Set(["spouse", "minor_child", "dependent_child"]);

function attrs(entity) {
  if (!entity) return {};
  if (typeof entity.attributes === "string") {
    try {
      return JSON.parse(entity.attributes) || {};
    } catch (_) {
      return {};
    }
  }
  return entity.attributes || {};
}

function isSovereign(entity) {
  if (!entity) return false;
  const a = attrs(entity);
  return entity.entity_type === "government" || a.sovereign === true || a.rbi === true;
}

function isFinancialType(type) {
  return ["bank", "nbfc", "fund", "ccp", "insurer"].includes(type);
}

/** Default intra-group class when the bank did not set one. */
function iteClassOf(entity) {
  if (!entity) return "non_financial";
  if (entity.ite_class) return entity.ite_class;
  if (["bank", "nbfc", "insurer", "ccp"].includes(entity.entity_type)) return "regulated_financial";
  if (entity.entity_type === "fund") return "unregulated_financial";
  return "non_financial";
}

function nameOf(index, id) {
  if (id === SELF) return index.entities.get(SELF)?.name || "the bank";
  return index.entities.get(id)?.name || id;
}

function edgeLabel(index, e) {
  const a = nameOf(index, e.from_entity);
  const b = nameOf(index, e.to_entity);
  const flag = e.status === "flagged" ? " [flagged, unconfirmed]" : "";
  switch (e.edge_type) {
    case "OWNS":
      return `${a} owns ${e.ownership_pct}% of ${b}${Number(e.ownership_pct) > 50 ? " (>50% of voting rights: control)" : ""}${flag}`;
    case "CONTROLS":
      return `${a} controls ${b}${e.basis ? ` (${String(e.basis).replace(/_/g, " ")})` : ""}${flag}`;
    case "COMMON_MANAGEMENT":
      return `${a} and ${b} have common owners / management (horizontal group)${flag}`;
    case "ECONOMIC_DEPENDENCE": {
      const crit = e.criterion && ECON_CRITERIA[e.criterion] ? `: ${ECON_CRITERIA[e.criterion]}` : "";
      return `${a} is economically dependent on ${b}${e.bidirectional ? " (two-way)" : ""}${crit}${flag}`;
    }
    case "DIRECTOR_OF":
      return `${a} is a director of ${b}${flag}`;
    case "INTERESTED_IN":
      return `${a} is interested in ${b} as ${String(e.role || "interested party").replace(/_/g, " ")}${flag}`;
    case "RELATIVE_OF":
      return `${a} is a relative of ${b}${e.relation ? ` (${String(e.relation).replace(/_/g, " ")})` : ""}${flag}`;
    case "PROMOTER_OF":
      return `${a} is a promoter of ${b}${flag}`;
    default:
      return `${a} -[${e.edge_type}]-> ${b}${flag}`;
  }
}

/**
 * Index the network. `includeFlagged` decides whether flagged edges count.
 * @param {{entities: object[], edges: object[]}} network
 */
function buildIndex(network, { includeFlagged = false } = {}) {
  const entities = new Map(network.entities.map((e) => [e.entity_id, e]));
  if (!entities.has(SELF)) entities.set(SELF, { entity_id: SELF, name: "Reporting bank", entity_type: "self" });
  const edges = network.edges.filter(
    (e) => e.status !== "rebutted" && (e.status !== "flagged" || includeFlagged)
  );
  const out = new Map();
  const inc = new Map();
  for (const e of edges) {
    if (!out.has(e.from_entity)) out.set(e.from_entity, []);
    if (!inc.has(e.to_entity)) inc.set(e.to_entity, []);
    out.get(e.from_entity).push(e);
    inc.get(e.to_entity).push(e);
  }
  return { entities, edges, out, inc, includeFlagged };
}

const isControlEdge = (e) =>
  e.edge_type === "CONTROLS" || (e.edge_type === "OWNS" && Number(e.ownership_pct) > 50);

// ---------------------------------------------------------------------------
// 1. Groups of connected counterparties
// ---------------------------------------------------------------------------

/**
 * Control children of every entity, excluding links that must not create a
 * group: anything touching the bank itself, and control exercised by a
 * sovereign (entities controlled by the Government are not connected merely
 * because of that - RBI LEF "sovereign exemption").
 */
function controlChildren(index) {
  const children = new Map();
  const sovereignSkips = [];
  for (const e of index.edges) {
    if (!isControlEdge(e) || e.from_entity === SELF || e.to_entity === SELF) continue;
    if (isSovereign(index.entities.get(e.from_entity))) {
      sovereignSkips.push(e);
      continue;
    }
    if (!children.has(e.from_entity)) children.set(e.from_entity, []);
    children.get(e.from_entity).push(e);
  }
  return { children, sovereignSkips };
}

function descendants(children, root) {
  const members = new Set();
  const links = [];
  const stack = [root];
  while (stack.length) {
    const x = stack.pop();
    for (const e of children.get(x) || []) {
      links.push(e);
      if (!members.has(e.to_entity) && e.to_entity !== root) {
        members.add(e.to_entity);
        stack.push(e.to_entity);
      }
    }
  }
  return { members, links };
}

/**
 * @returns {{groups: Array<{group_id, anchor, members: string[], links: object[], reasons: Record<string,string>, basis: string[], provisional: boolean}>, notes: string[]}}
 */
function connectedGroups(index) {
  const { children, sovereignSkips } = controlChildren(index);
  const notes = sovereignSkips.map(
    (e) => `${nameOf(index, e.from_entity)} is a sovereign: entities it controls are not grouped through it`
  );
  const controlled = new Set();
  for (const list of children.values()) for (const e of list) controlled.add(e.to_entity);

  const groups = [];
  const newGroup = (anchor) => {
    const g = { anchor, members: new Set([anchor]), links: [], reasons: { [anchor]: "anchor" }, basis: new Set() };
    groups.push(g);
    return g;
  };
  const addMembers = (g, ids, link, why) => {
    let added = false;
    for (const id of ids) {
      if (!g.members.has(id)) {
        g.members.add(id);
        g.reasons[id] = why(id);
        added = true;
      }
    }
    if (link && !g.links.includes(link)) g.links.push(link);
    return added;
  };

  // (a) control: every ultimate controller with everything it controls,
  //     directly or indirectly. Controllers inside cycles get their own root.
  const roots = [...children.keys()].filter((id) => !controlled.has(id));
  const covered = new Set();
  const seedControl = (root) => {
    const { members, links } = descendants(children, root);
    if (!members.size) return;
    const g = newGroup(root);
    g.basis.add("control");
    for (const l of links) {
      addMembers(g, [l.to_entity], l, () => `controlled: ${edgeLabel(index, l)}`);
    }
    for (const m of g.members) covered.add(m);
  };
  roots.forEach(seedControl);
  for (const id of children.keys()) if (!covered.has(id)) seedControl(id);

  // (b) horizontal groups: common owners / management merge groups.
  for (const e of index.edges) {
    if (e.edge_type !== "COMMON_MANAGEMENT" || e.from_entity === SELF || e.to_entity === SELF) continue;
    const hit = groups.filter((g) => g.members.has(e.from_entity) || g.members.has(e.to_entity));
    const target = hit[0] || newGroup(e.from_entity);
    target.basis.add("control");
    for (const other of hit.slice(1)) {
      for (const m of other.members) addMembers(target, [m], null, () => other.reasons[m] || "merged horizontal group");
      other.links.forEach((l) => target.links.includes(l) || target.links.push(l));
      groups.splice(groups.indexOf(other), 1);
    }
    for (const id of [e.from_entity, e.to_entity]) {
      addMembers(target, [id], e, () => `common management: ${edgeLabel(index, e)}`);
    }
  }

  // (c) economic interdependence. D depends on P: D (and, by downstream
  //     contagion, everything D controls) joins every group containing P.
  //     Upstream contagion needs no special case: a controller of D joins
  //     only if it is itself recorded as dependent on D, which this same
  //     rule then picks up. Iterate to a fixpoint (chains of dependence).
  const deps = [];
  for (const e of index.edges) {
    if (e.edge_type !== "ECONOMIC_DEPENDENCE" || e.from_entity === SELF || e.to_entity === SELF) continue;
    deps.push({ dependent: e.from_entity, provider: e.to_entity, edge: e });
    if (Number(e.bidirectional) === 1) deps.push({ dependent: e.to_entity, provider: e.from_entity, edge: e });
  }
  for (let iter = 0, changed = true; changed && iter < index.entities.size + 5; iter++) {
    changed = false;
    for (const { dependent, provider, edge } of deps) {
      let hit = groups.filter((g) => g.members.has(provider));
      if (!hit.length) hit = [newGroup(provider)];
      const { members: downstream, links: downLinks } = descendants(children, dependent);
      for (const g of hit) {
        g.basis.add("economic_interdependence");
        const added = addMembers(g, [dependent], edge, () => `economically dependent: ${edgeLabel(index, edge)}`);
        let addedDown = false;
        for (const l of downLinks) {
          if (downstream.has(l.to_entity)) {
            addedDown =
              addMembers(g, [l.to_entity], l, () =>
                `downstream contagion via ${nameOf(index, dependent)}: ${edgeLabel(index, l)}`
              ) || addedDown;
          }
        }
        changed = changed || added || addedDown;
      }
    }
  }

  // Drop duplicates and groups wholly contained in a larger group (the
  // larger aggregate is the binding one); keep groups that overlap.
  const sorted = groups.filter((g) => g.members.size > 1).sort((a, b) => b.members.size - a.members.size);
  const kept = [];
  for (const g of sorted) {
    if (kept.some((k) => [...g.members].every((m) => k.members.has(m)))) continue;
    kept.push(g);
  }
  return {
    groups: kept.map((g, i) => ({
      group_id: `G${i + 1}`,
      anchor: g.anchor,
      name: `${nameOf(index, g.anchor)} group`,
      members: [...g.members],
      links: g.links.map((l) => ({ ...l, label: edgeLabel(index, l) })),
      reasons: g.reasons,
      basis: [...g.basis],
      provisional: g.links.some((l) => l.status === "flagged"),
    })),
    notes,
  };
}

// ---------------------------------------------------------------------------
// 2. Exposures
// ---------------------------------------------------------------------------

/**
 * Net exposure per counterparty. Eligible credit risk mitigation reduces the
 * exposure to the original counterparty and is recognised as an exposure to
 * the CRM provider instead (substitution). Exempted exposures are kept apart:
 * they do not count against limits but still have to be reported.
 *
 * @param {object[]} exposures rows of graph_exposures
 * @param {{valueRule?: 'amount'|'limit_or_outstanding', index?: object}} opts
 */
function aggregateExposures(exposures, { valueRule = "amount", index = null } = {}) {
  const by = new Map();
  const get = (id) => {
    if (!by.has(id)) {
      by.set(id, {
        entity_id: id, total: 0, infrastructure: 0, exempt: 0, equity: 0, crm_received: 0,
        exempt_reasons: new Set(), board_approved_excess: false, section20_exception: null, kinds: {},
      });
    }
    return by.get(id);
  };
  for (const x of exposures) {
    const raw = Number(x.amount) || 0;
    const value = valueRule === "limit_or_outstanding" ? Math.max(raw, Number(x.sanctioned_limit) || 0) : raw;
    const crm = Math.min(Math.max(Number(x.crm_amount) || 0, 0), value);
    const net = Math.max(value - crm, 0);
    const row = get(x.entity_id);
    const entity = index?.entities.get(x.entity_id);
    const exemptReason = x.exempt_reason || (isSovereign(entity) ? "sovereign" : null);
    if (exemptReason) {
      row.exempt += net;
      row.exempt_reasons.add(exemptReason);
    } else {
      row.total += net;
      if (Number(x.infrastructure) === 1) row.infrastructure += net;
      if (x.exposure_kind === "equity") row.equity += net;
    }
    row.kinds[x.exposure_kind || "fund_based"] = (row.kinds[x.exposure_kind || "fund_based"] || 0) + net;
    if (Number(x.board_approved_excess) === 1) row.board_approved_excess = true;
    if (x.section20_exception) row.section20_exception = x.section20_exception;
    if (crm > 0 && x.crm_provider) {
      const p = get(x.crm_provider);
      const pEntity = index?.entities.get(x.crm_provider);
      if (isSovereign(pEntity)) {
        p.exempt += crm;
        p.exempt_reasons.add("sovereign");
      } else {
        p.total += crm;
      }
      p.crm_received += crm;
      p.kinds.crm_substitution = (p.kinds.crm_substitution || 0) + crm;
    }
  }
  for (const r of by.values()) r.exempt_reasons = [...r.exempt_reasons];
  return by;
}

// ---------------------------------------------------------------------------
// 3. The bank's own group (intra-group transactions and exposures)
// ---------------------------------------------------------------------------

/**
 * Group entities of the bank: entities the bank marked as such, entities it
 * holds 20%+ of or controls, entities holding 20%+ of / controlling / promoting
 * the bank, and entities those parents / promoters hold 20%+ of or control.
 * @returns {Map<string, {relation: string, via: string[]}>}
 */
function bankGroupEntities(index) {
  const group = new Map();
  const add = (id, relation, via) => {
    if (id === SELF || group.has(id)) return;
    group.set(id, { relation, via });
  };
  for (const [id, e] of index.entities) {
    if (e.group_relation) add(id, e.group_relation, [`marked by the bank as ${e.group_relation.replace(/_/g, " ")}`]);
  }
  for (const e of index.out.get(SELF) || []) {
    if (e.edge_type === "OWNS" && Number(e.ownership_pct) >= 20) {
      add(e.to_entity, Number(e.ownership_pct) > 50 ? "subsidiary" : "associate", [edgeLabel(index, e)]);
    } else if (e.edge_type === "CONTROLS") {
      add(e.to_entity, "subsidiary", [edgeLabel(index, e)]);
    }
  }
  const parents = [];
  for (const e of index.inc.get(SELF) || []) {
    const qualifies =
      e.edge_type === "PROMOTER_OF" || e.edge_type === "CONTROLS" ||
      (e.edge_type === "OWNS" && Number(e.ownership_pct) >= 20);
    if (!qualifies) continue;
    add(e.from_entity, e.edge_type === "PROMOTER_OF" ? "promoter" : "parent", [edgeLabel(index, e)]);
    parents.push(e.from_entity);
  }
  for (const [id, info] of group) if (["promoter", "parent", "nofhc"].includes(info.relation) && !parents.includes(id)) parents.push(id);
  for (const p of parents) {
    for (const e of index.out.get(p) || []) {
      if (e.to_entity === SELF) continue;
      if (e.edge_type === "CONTROLS" || (e.edge_type === "OWNS" && Number(e.ownership_pct) >= 20)) {
        add(e.to_entity, "promoter_group_entity", [edgeLabel(index, e)]);
      }
    }
  }
  return group;
}

// ---------------------------------------------------------------------------
// 4. Related parties the bank may not lend to
// ---------------------------------------------------------------------------

function companyExcluded(index, id, bankGroup) {
  const e = index.entities.get(id);
  const a = attrs(e);
  if (bankGroup.get(id)?.relation === "subsidiary") return "a subsidiary of the bank";
  if (a.section8_company) return "a Section 8 company";
  if (a.government_company || e?.entity_type === "government") return "a Government company";
  return null;
}

/**
 * Who the bank may not lend to, and the path that proves it.
 *  - section20: directors; firms they are partner / manager / employee /
 *    guarantor of; companies they are director / manager / employee /
 *    guarantor / managing agent of or hold substantial interest in, and the
 *    subsidiary or holding company of such a company; individuals they are
 *    partner or guarantor of.
 *  - relatives: spouse and minor / dependent children of directors.
 *  - promoters: promoters and their relatives, shareholders with 10%+ of the
 *    bank, and entities any of them control or significantly influence
 *    (20%+ voting power or control).
 * @returns {Map<string, Array<{variant: string, path: string[], edges: object[]}>>}
 */
function restrictedParties(index, variants = ["section20", "relatives", "promoters"]) {
  const bankGroup = bankGroupEntities(index);
  const result = new Map();
  const mark = (id, variant, edges, exclusionCheck = true) => {
    if (id === SELF) return;
    if (exclusionCheck) {
      const t = index.entities.get(id)?.entity_type;
      if (["company", "bank", "nbfc"].includes(t) && companyExcluded(index, id, bankGroup)) return;
    }
    if (!result.has(id)) result.set(id, []);
    const list = result.get(id);
    if (list.some((r) => r.variant === variant && r.edges.length <= edges.length)) return;
    list.push({ variant, edges, path: edges.map((e) => edgeLabel(index, e)) });
  };
  const directors = (index.inc.get(SELF) || []).filter((e) => e.edge_type === "DIRECTOR_OF");

  if (variants.includes("section20")) {
    for (const d of directors) {
      const dir = d.from_entity;
      mark(dir, "section20", [d], false);
      for (const e of index.out.get(dir) || []) {
        if (e.to_entity === SELF) continue;
        const target = index.entities.get(e.to_entity);
        const type = target?.entity_type;
        let hit = false;
        if (e.edge_type === "DIRECTOR_OF" && type !== "individual") hit = true;
        if (e.edge_type === "INTERESTED_IN") {
          const role = String(e.role || "").toLowerCase();
          if (type === "individual") hit = INDIVIDUAL_ROLES.has(role);
          else if (type === "firm") hit = FIRM_ROLES.has(role);
          else hit = SECTION20_ROLES.has(role);
        }
        if (!hit) continue;
        mark(e.to_entity, "section20", [d, e]);
        if (type === "individual" || type === "firm") continue;
        // subsidiary or holding company of such a company
        for (const c of index.out.get(e.to_entity) || []) {
          if (isControlEdge(c) && c.to_entity !== SELF) mark(c.to_entity, "section20", [d, e, c]);
        }
        for (const c of index.inc.get(e.to_entity) || []) {
          if (isControlEdge(c) && c.from_entity !== SELF) mark(c.from_entity, "section20", [d, e, c]);
        }
      }
    }
  }

  if (variants.includes("relatives")) {
    for (const d of directors) {
      const dir = d.from_entity;
      const rel = [...(index.out.get(dir) || []), ...(index.inc.get(dir) || [])].filter(
        (e) => e.edge_type === "RELATIVE_OF" && CLOSE_RELATIVES.has(String(e.relation || "").toLowerCase())
      );
      for (const e of rel) mark(e.from_entity === dir ? e.to_entity : e.from_entity, "relatives", [d, e], false);
    }
  }

  if (variants.includes("promoters")) {
    const heads = [];
    for (const e of index.inc.get(SELF) || []) {
      const holder = index.entities.get(e.from_entity);
      if (e.edge_type === "PROMOTER_OF") heads.push({ id: e.from_entity, edges: [e] });
      if (e.edge_type === "OWNS" && Number(e.ownership_pct) >= 10) {
        const a = attrs(holder);
        const nonStrategic = a.non_strategic_investor && isFinancialType(holder?.entity_type);
        if (!nonStrategic) heads.push({ id: e.from_entity, edges: [e] });
      }
    }
    const withRelatives = [...heads];
    for (const h of heads) {
      for (const e of [...(index.out.get(h.id) || []), ...(index.inc.get(h.id) || [])]) {
        if (e.edge_type !== "RELATIVE_OF") continue;
        const other = e.from_entity === h.id ? e.to_entity : e.from_entity;
        withRelatives.push({ id: other, edges: [...h.edges, e] });
      }
    }
    for (const h of withRelatives) {
      mark(h.id, "promoters", h.edges, false);
      for (const e of index.out.get(h.id) || []) {
        if (e.to_entity === SELF) continue;
        if (e.edge_type === "CONTROLS" || (e.edge_type === "OWNS" && Number(e.ownership_pct) >= 20)) {
          mark(e.to_entity, "promoters", [...h.edges, e], false);
        }
      }
    }
  }
  return result;
}

module.exports = {
  SELF,
  ECON_CRITERIA,
  attrs,
  isSovereign,
  iteClassOf,
  buildIndex,
  edgeLabel,
  nameOf,
  connectedGroups,
  aggregateExposures,
  bankGroupEntities,
  restrictedParties,
};
