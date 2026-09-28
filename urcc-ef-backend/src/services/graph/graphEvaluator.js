/**
 * Evaluates a bank's counterparty network against the rules in
 * graphRules.js. Pure: takes the network, exposures, capital and the
 * resolved rules; returns one result row per check, plus the groups and a
 * graph payload for the dashboard. graphComplianceService.js does the I/O.
 *
 * Statuses
 *   PASS                  within the regulatory limit
 *   PASS_WITH_CONDITIONS  above the base limit but within headroom the rule
 *                         allows (Board-approved excess / infrastructure)
 *   BREACH                above every limit that applies
 *   POTENTIAL_BREACH      a breach that exists only if FLAGGED (unconfirmed)
 *                         links are real - needs a human decision
 *   PROHIBITED            exposure to a party the bank may not lend to
 *   NEEDS_REVIEW          cannot be decided: capital base missing, rule
 *                         source not found in the corpus, exception claimed,
 *                         or a related-party link that is only flagged
 *   ASSESSMENT_REQUIRED   exposure large enough that RBI requires an
 *                         economic-interdependence assessment, none recorded
 *   REPORTABLE            large exposure that must be reported to RBI
 *   INFO                  informational (e.g. NBFC-BL: Board policy only)
 */
const engine = require("./graphEngine");
const { capitalAmount, VALUE_RULE, LEF_EXCLUDES_INTRAGROUP } = require("./graphRules");

const SEVERITY = [
  "PROHIBITED", "BREACH", "POTENTIAL_BREACH", "NEEDS_REVIEW", "ASSESSMENT_REQUIRED",
  "REPORTABLE", "PASS_WITH_CONDITIONS", "PASS", "INFO",
];
const worst = (statuses) => statuses.sort((a, b) => SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0] || null;

const round = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x) ? null : Math.round(x * 10 ** d) / 10 ** d);

function sourceOf(rule) {
  const s = rule.source_resolved || {};
  return s.verified
    ? {
        clause_uri: s.clause_uri, doc_id: s.doc_id, doc_title: s.doc_title, rbi_ref: s.rbi_ref,
        paragraph: s.paragraph, page_number: s.page_number, excerpt: s.excerpt, verified: true,
      }
    : { verified: false, reason: s.reason, doc_title: s.doc_title };
}

function counterpartyClass(entity) {
  const a = engine.attrs(entity);
  if (entity?.entity_type === "nbfc" && a.gold_loan_nbfc) return ["gold_nbfc", "nbfc", "default"];
  if (entity?.entity_type === "nbfc") return ["nbfc", "default"];
  if (entity?.entity_type === "bank") return ["bank", "default"];
  return ["default"];
}

function pickRule(rules, classes) {
  for (const c of classes) {
    const r = rules.find((x) => x.counterparty === c);
    if (r) return r;
  }
  return null;
}

/**
 * Limit arithmetic shared by single-counterparty and group checks.
 */
function checkLimit(rule, { amount, infra = 0, boardApproved = false, base, profile }) {
  const reasons = [];
  let limit = rule.limit;
  if (rule.limit_by_rating) {
    const rating = profile?.rcb_rating;
    limit = rating ? rule.limit_by_rating[rating] : undefined;
    if (limit === undefined) {
      return { status: "NEEDS_REVIEW", reasons: ["NABARD inspection rating not set in the bank profile - unit-wise limit depends on it"] };
    }
    reasons.push(`NABARD rating ${rating}: limit ${limit}% of capital fund`);
  }
  if (!rule.source_resolved?.verified) {
    return {
      status: "NEEDS_REVIEW",
      reasons: [`limit not applied: ${rule.source_resolved?.reason || "source paragraph not verified"}`],
    };
  }
  if (!base || base <= 0) {
    return { status: "NEEDS_REVIEW", reasons: [`${rule.base_label} for this period is not entered - cannot compute the limit`] };
  }
  const pct = (amount / base) * 100;
  let allowed = limit;
  let status = pct <= limit ? "PASS" : null;
  if (!status) {
    if (rule.infra_extension && infra > 0) {
      const extra = Math.min(rule.infra_extension, (infra / base) * 100);
      allowed += extra;
      reasons.push(`+${round(extra)}% for infrastructure loans / investment (up to +${rule.infra_extension}%)`);
    }
    if (rule.board_extension) {
      if (boardApproved) {
        allowed += rule.board_extension;
        reasons.push(`+${rule.board_extension}% allowed by the Board (exceptional case; Board policy required)`);
      }
    }
    if (rule.cap) allowed = Math.min(allowed, rule.cap);
    status = pct <= allowed ? "PASS_WITH_CONDITIONS" : "BREACH";
    if (status === "BREACH" && rule.board_extension && !boardApproved && pct <= Math.min(limit + rule.board_extension, rule.cap || Infinity)) {
      reasons.push(`would be within the additional ${rule.board_extension}% if the Board approves it for this counterparty (mark the exposure "Board-approved excess")`);
    }
  }
  return {
    status,
    exposure_pct: round(pct),
    limit_pct: limit,
    allowed_pct: round(allowed),
    headroom: round((allowed / 100) * base - amount),
    reasons,
  };
}

function evaluateNetwork({ category, profile = {}, capital = {}, network, exposures, rules, includeFlagged = true }) {
  const idx = engine.buildIndex(network, { includeFlagged: false });
  const idxP = includeFlagged ? engine.buildIndex(network, { includeFlagged: true }) : null;
  const name = (id) => engine.nameOf(idx, id);
  const byKind = (k) => rules.filter((r) => r.kind === k);
  const results = [];
  const notes = [];
  let seq = 0;
  const push = (rule, row) => {
    const source = sourceOf(rule);
    results.push({
      id: `R${++seq}`,
      rule_key: rule.key,
      rule_label: rule.label,
      kind: rule.kind,
      clause_uri: source.clause_uri || null,
      source,
      base_label: rule.base_label || null,
      provisional: false,
      reasons: [],
      ...row,
    });
  };

  const bankGroup = engine.bankGroupEntities(idx);
  const exp = engine.aggregateExposures(exposures, { valueRule: VALUE_RULE[category] || "amount", index: idx });
  exp.delete(engine.SELF);
  const lefExcluded = LEF_EXCLUDES_INTRAGROUP.has(category) ? new Set(bankGroup.keys()) : new Set();
  if (lefExcluded.size) {
    notes.push(
      `${lefExcluded.size} group entit${lefExcluded.size === 1 ? "y is" : "ies are"} checked under the intra-group limits and excluded from the large-exposure limits`
    );
  }
  const baseFor = (rule) => capitalAmount(rule.base, capital);
  const entityOf = (id) => idx.entities.get(id) || { entity_id: id, name: id, entity_type: "other" };

  // ── single counterparty limits ──────────────────────────────────────────
  const singleRules = byKind("single_limit");
  if (singleRules.length) {
    for (const [id, e] of exp) {
      if (e.total <= 0 || lefExcluded.has(id)) continue;
      const entity = entityOf(id);
      const rule = pickRule(singleRules, counterpartyClass(entity));
      if (!rule) continue;
      const r = checkLimit(rule, {
        amount: e.total, infra: e.infrastructure, boardApproved: e.board_approved_excess, base: baseFor(rule), profile,
      });
      push(rule, {
        status: r.status,
        subject: { type: "counterparty", id, name: entity.name, entity_type: entity.entity_type },
        exposure: round(e.total), base_amount: baseFor(rule),
        exposure_pct: r.exposure_pct ?? null, limit_pct: r.limit_pct ?? rule.limit ?? null, allowed_pct: r.allowed_pct ?? null,
        headroom: r.headroom ?? null,
        reasons: [
          ...(e.crm_received ? [`includes ₹${round(e.crm_received)} cr recognised as exposure to this entity as credit protection provider`] : []),
          ...(e.exempt ? [`₹${round(e.exempt)} cr exempted (${e.exempt_reasons.join(", ")}) and not counted`] : []),
          ...r.reasons,
        ],
      });
    }
  }

  // ── groups of connected counterparties ──────────────────────────────────
  const groupRules = byKind("group_limit");
  const confirmed = engine.connectedGroups(idx);
  notes.push(...confirmed.notes);
  const provisional = idxP ? engine.connectedGroups(idxP) : { groups: [], notes: [] };
  const sameMembers = (a, b) => a.members.length === b.members.length && a.members.every((m) => b.members.includes(m));
  const provisionalOnly = provisional.groups.filter((g) => !confirmed.groups.some((c) => sameMembers(c, g)));
  const controlDef = rules.find((r) => r.kind === "definition");

  const evalGroup = (g, isProvisional) => {
    const members = g.members.map((id) => ({
      id, name: name(id), entity_type: entityOf(id).entity_type,
      exposure: round(lefExcluded.has(id) ? 0 : exp.get(id)?.total || 0),
      reason: g.reasons[id],
      excluded: lefExcluded.has(id) ? "intra-group (checked separately)" : null,
    }));
    const total = members.reduce((s, m) => s + (m.exposure || 0), 0);
    const infra = g.members.reduce((s, id) => s + (lefExcluded.has(id) ? 0 : exp.get(id)?.infrastructure || 0), 0);
    if (total <= 0) return null;
    const hasNbfc = g.members.some((id) => entityOf(id).entity_type === "nbfc");
    const rule = pickRule(groupRules, hasNbfc ? ["nbfc", "default"] : ["default"]);
    if (!rule) return null;
    const r = checkLimit(rule, { amount: total, infra, base: baseFor(rule), profile });
    let status = r.status;
    const reasons = [...r.reasons];
    if (isProvisional) {
      if (status !== "BREACH") return null;
      status = "POTENTIAL_BREACH";
      reasons.unshift("breach exists only if the flagged (unconfirmed) links below are real - review them");
    }
    const extra = controlDef ? [sourceOf(controlDef)] : [];
    return {
      rule, row: {
        status,
        provisional: isProvisional,
        subject: { type: "group", id: g.group_id, name: g.name, basis: g.basis, members },
        exposure: round(total), base_amount: baseFor(rule),
        exposure_pct: r.exposure_pct ?? null, limit_pct: r.limit_pct ?? rule.limit, allowed_pct: r.allowed_pct ?? null,
        headroom: r.headroom ?? null,
        links: g.links.map((l) => ({ label: l.label, status: l.status, edge_type: l.edge_type })),
        reasons,
        extra_sources: extra.filter((s) => s.verified),
      },
    };
  };
  if (groupRules.length) {
    for (const g of confirmed.groups) {
      const out = evalGroup(g, false);
      if (out) push(out.rule, out.row);
    }
    for (const g of provisionalOnly) {
      const out = evalGroup(g, true);
      if (out) push(out.rule, out.row);
    }
  }

  // ── large-exposure reporting ────────────────────────────────────────────
  for (const rule of byKind("le_reporting")) {
    const base = baseFor(rule);
    if (!base) continue;
    const threshold = (rule.threshold / 100) * base;
    for (const [id, e] of exp) {
      const all = e.total + e.exempt;
      if (all >= threshold && !lefExcluded.has(id)) {
        push(rule, {
          status: "REPORTABLE",
          subject: { type: "counterparty", id, name: entityOf(id).name, entity_type: entityOf(id).entity_type },
          exposure: round(all), base_amount: base, exposure_pct: round((all / base) * 100), limit_pct: rule.threshold,
          reasons: [e.exempt ? "includes exempted exposure - exempted exposures are reported too" : "single counterparty large exposure"],
        });
      }
    }
    for (const g of confirmed.groups) {
      const total = g.members.reduce((s, id) => s + (lefExcluded.has(id) ? 0 : exp.get(id)?.total || 0), 0);
      if (total >= threshold) {
        push(rule, {
          status: "REPORTABLE",
          subject: { type: "group", id: g.group_id, name: g.name, members: g.members.map((id) => ({ id, name: name(id) })) },
          exposure: round(total), base_amount: base, exposure_pct: round((total / base) * 100), limit_pct: rule.threshold,
          reasons: ["group of connected counterparties large exposure"],
        });
      }
    }
  }

  // ── economic-interdependence assessment trigger ─────────────────────────
  for (const rule of byKind("econ_assessment")) {
    const base = baseFor(rule);
    if (!base) continue;
    for (const [id, e] of exp) {
      if (lefExcluded.has(id) || e.total <= (rule.threshold / 100) * base) continue;
      const entity = entityOf(id);
      const assessed =
        engine.attrs(entity).econ_assessed ||
        network.edges.some(
          (x) => x.edge_type === "ECONOMIC_DEPENDENCE" && (x.from_entity === id || x.to_entity === id)
        );
      push(rule, {
        status: assessed ? "PASS" : "ASSESSMENT_REQUIRED",
        subject: { type: "counterparty", id, name: entity.name, entity_type: entity.entity_type },
        exposure: round(e.total), base_amount: base, exposure_pct: round((e.total / base) * 100), limit_pct: rule.threshold,
        reasons: [
          assessed
            ? "economic-interdependence assessment recorded"
            : "no economic-interdependence assessment recorded: record the dependencies found (or mark the counterparty as assessed)",
        ],
      });
    }
  }

  // ── intra-group exposures ───────────────────────────────────────────────
  const iteExposure = (id) => {
    const e = exp.get(id);
    return e ? Math.max(e.total - e.equity, 0) : 0;
  };
  for (const rule of byKind("ite_single")) {
    for (const [id, info] of bankGroup) {
      const entity = entityOf(id);
      const cls = engine.iteClassOf(entity);
      if (!rule.ite_classes.includes(cls)) continue;
      const amount = iteExposure(id);
      if (amount <= 0) continue;
      const r = checkLimit(rule, { amount, base: baseFor(rule), profile });
      push(rule, {
        status: r.status,
        subject: { type: "counterparty", id, name: entity.name, entity_type: entity.entity_type, group_relation: info.relation, ite_class: cls },
        exposure: round(amount), base_amount: baseFor(rule), exposure_pct: r.exposure_pct ?? null, limit_pct: rule.limit,
        allowed_pct: r.allowed_pct ?? null, headroom: r.headroom ?? null,
        reasons: [`group entity (${info.relation.replace(/_/g, " ")}): ${info.via.join("; ")}`, "equity and capital instruments excluded", ...r.reasons],
      });
    }
  }
  for (const rule of byKind("ite_aggregate")) {
    const members = [...bankGroup.keys()].filter((id) => !rule.ite_classes || rule.ite_classes.includes(engine.iteClassOf(entityOf(id))));
    const amount = members.reduce((s, id) => s + iteExposure(id), 0);
    if (amount <= 0) continue;
    const r = checkLimit(rule, { amount, base: baseFor(rule), profile });
    push(rule, {
      status: r.status,
      subject: { type: "aggregate", id: rule.key, name: rule.ite_classes ? "Non-financial and unregulated group entities" : "All group entities",
        members: members.map((id) => ({ id, name: name(id), exposure: round(iteExposure(id)) })) },
      exposure: round(amount), base_amount: baseFor(rule), exposure_pct: r.exposure_pct ?? null, limit_pct: rule.limit,
      allowed_pct: r.allowed_pct ?? null, headroom: r.headroom ?? null, reasons: r.reasons,
    });
  }

  // ── related parties ─────────────────────────────────────────────────────
  for (const rule of byKind("related_party")) {
    const found = engine.restrictedParties(idx, [rule.variant]);
    const foundP = idxP ? engine.restrictedParties(idxP, [rule.variant]) : new Map();
    const emit = (id, hits, flaggedOnly) => {
      const e = exp.get(id);
      const amount = e ? e.total + e.exempt : 0;
      if (amount <= 0) return;
      const entity = entityOf(id);
      let status = "PROHIBITED";
      const reasons = [];
      if (!rule.source_resolved?.verified) {
        status = "NEEDS_REVIEW";
        reasons.push(`rule not applied: ${rule.source_resolved?.reason}`);
      } else if (flaggedOnly) {
        status = "NEEDS_REVIEW";
        reasons.push("related only through a flagged (unconfirmed) link - confirm or rebut it");
      } else if (e.section20_exception) {
        status = "NEEDS_REVIEW";
        reasons.push(`exception claimed: ${e.section20_exception} - verify it against the exceptions in the direction`);
      }
      const shortest = hits.sort((a, b) => a.edges.length - b.edges.length)[0];
      push(rule, {
        status,
        provisional: flaggedOnly,
        subject: { type: "counterparty", id, name: entity.name, entity_type: entity.entity_type },
        exposure: round(amount),
        path: shortest.path,
        reasons: [...reasons, `connection to the bank: ${shortest.path.join(" → ")}`],
      });
    };
    for (const [id, hits] of found) emit(id, hits, false);
    for (const [id, hits] of foundP) if (!found.has(id)) emit(id, hits, true);
  }

  for (const rule of byKind("policy_only")) {
    push(rule, {
      status: "INFO",
      subject: { type: "bank", id: engine.SELF, name: "Bank" },
      reasons: ["no regulatory ceiling for this layer - check exposures against the Board-approved limits"],
    });
  }

  // ── graph payload for the dashboard ─────────────────────────────────────
  const statusByEntity = new Map();
  const note = (id, s) => {
    if (!statusByEntity.has(id)) statusByEntity.set(id, []);
    statusByEntity.get(id).push(s);
  };
  for (const r of results) {
    if (r.subject?.type === "counterparty") note(r.subject.id, r.status);
    if (r.subject?.type === "group") r.subject.members.forEach((m) => note(m.id, r.status));
  }
  const groupIds = new Map();
  [...confirmed.groups, ...provisionalOnly].forEach((g) => g.members.forEach((m) => {
    if (!groupIds.has(m)) groupIds.set(m, []);
    groupIds.get(m).push(g.group_id + (provisionalOnly.includes(g) ? "?" : ""));
  }));
  const primaryBase = capitalAmount(rules.find((r) => r.base)?.base, capital);
  const nodes = [...idx.entities.values()].map((e) => {
    const x = exp.get(e.entity_id);
    return {
      id: e.entity_id,
      name: e.name,
      entity_type: e.entity_type,
      exposure: round(x?.total || 0),
      exempt: round(x?.exempt || 0),
      exposure_pct: primaryBase && x ? round((x.total / primaryBase) * 100) : null,
      status: worst(statusByEntity.get(e.entity_id) || []),
      group_ids: groupIds.get(e.entity_id) || [],
      bank_group: bankGroup.get(e.entity_id)?.relation || null,
    };
  });
  const edges = network.edges.map((e) => ({
    id: e.edge_id ?? `${e.from_entity}-${e.edge_type}-${e.to_entity}`,
    source: e.from_entity, target: e.to_entity, edge_type: e.edge_type, status: e.status || "confirmed",
    label: engine.edgeLabel(idxP || idx, e),
  }));

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] || 0) + 1;
  const largest = [...exp.entries()]
    .map(([id, e]) => ({ id, name: name(id), exposure: round(e.total + e.exempt), exposure_pct: primaryBase ? round(((e.total + e.exempt) / primaryBase) * 100) : null }))
    .filter((x) => x.exposure > 0)
    .sort((a, b) => b.exposure - a.exposure)
    .slice(0, 20);

  return {
    summary: {
      counterparties: [...exp.values()].filter((e) => e.total + e.exempt > 0).length,
      groups: confirmed.groups.length,
      provisional_groups: provisionalOnly.length,
      bank_group_entities: bankGroup.size,
      total_exposure: round([...exp.values()].reduce((s, e) => s + e.total + e.exempt, 0)),
      status_counts: counts,
      overall: worst(results.map((r) => r.status)),
      largest_exposures: largest,
    },
    results,
    groups: [
      ...confirmed.groups.map((g) => ({ ...g, provisional: false })),
      ...provisionalOnly.map((g) => ({ ...g, group_id: `${g.group_id}?`, provisional: true })),
    ].map((g) => ({
      group_id: g.group_id, name: g.name, basis: g.basis, provisional: g.provisional,
      members: g.members.map((id) => ({ id, name: name(id), reason: g.reasons[id], exposure: round(exp.get(id)?.total || 0) })),
      links: g.links.map((l) => ({ label: l.label, status: l.status, edge_type: l.edge_type })),
    })),
    bank_group: [...bankGroup.entries()].map(([id, v]) => ({ id, name: name(id), relation: v.relation, via: v.via, ite_class: engine.iteClassOf(entityOf(id)) })),
    graph: { nodes, edges },
    notes: [...new Set(notes)],
  };
}

module.exports = { evaluateNetwork, checkLimit, SEVERITY, worst };
