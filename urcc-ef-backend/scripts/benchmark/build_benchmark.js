#!/usr/bin/env node
/**
 * Rule-grounded synthetic compliance benchmark (journal Sec. XII.A-E, Table VI).
 *
 * Every case is derived from a rule that exists in the corpus (so every case
 * traces to a rule id and its source clause) and has a ground-truth decision
 * by construction:
 *
 *   rule pools                                   case types generated
 *   A  26 anchored rules (paragraph-verified)     compliant, non_compliant, boundary,
 *      + extracted % requirements (high conf.)    near_boundary x2, missing_data,
 *   D  "within N days" requirements               adversarial, contradictory, ambiguous
 *   C  % requirements inside conditional clauses  compliant, non_compliant, not-triggered,
 *                                                 missing_data, adversarial
 *   B  existence obligations (policy, committee)  compliant, non_compliant, missing_data,
 *   E  qualitative obligations                    ambiguous, adversarial, contradictory
 *   G  graph scenarios (eval/graph_scenarios.json) one case per stated expectation
 *   cross_version  CRR phase-down (7 categories) and UCB net-worth glide path:
 *                  the same fact pattern before / after an effective date
 *
 * Splits are by RULE (60/20/20 train/validation/test), so a rule seen while
 * training the router never appears in the test split.
 *
 *   node scripts/benchmark/build_benchmark.js [--out eval/compliance_benchmark.json] [--seed 7]
 *
 * generation_method is recorded per case ("template" or "hand-authored"), as the
 * journal requires for honest reporting of synthetic data.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const args = process.argv.slice(2);
const argOf = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = path.resolve(argOf("--out", path.join(__dirname, "..", "..", "eval", "compliance_benchmark.json")));
const SEED = Number(argOf("--seed", 7));

const db = require("../../src/config/db");
const { classifyRule } = require("../../src/services/router/ruleTaxonomy");
const regulatoryRules = require("../../src/services/disclosure/regulatoryRules");
const catalog = require("../../src/services/disclosure/metricCatalog");
const versioned = require("../../src/services/router/versionedRules");
const { decisionOf } = require("../../src/services/decisions");

// ── deterministic randomness ──
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const r2 = (x) => Math.round(x * 100) / 100;
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function splitOf(ruleKey) {
  const h = crypto.createHash("sha1").update(`${SEED}:${ruleKey}`).digest().readUInt32BE(0) / 2 ** 32;
  return h < 0.6 ? "train" : h < 0.8 ? "validation" : "test";
}

const CATEGORY_NAMES = {
  commercial_banks: "Example Commercial Bank",
  small_finance_banks: "Example Small Finance Bank",
  payments_banks: "Example Payments Bank",
  urban_cooperative_banks: "Example Urban Co-operative Bank",
  regional_rural_banks: "Example Gramin Bank",
  local_area_banks: "Example Local Area Bank",
  rural_cooperative_banks: "Example State Co-operative Bank",
  nbfc: "Example Finance Limited",
  all_india_financial_institutions: "Example Development Finance Institution",
};
const entity = (category, i) => ({ bank_id: `SYN-${category.slice(0, 3).toUpperCase()}-${String(i).padStart(4, "0")}`, name: CATEGORY_NAMES[category] || "Example Regulated Entity", category });

const DIFFICULTY = {
  compliant: "easy", non_compliant: "easy", missing_data: "medium", boundary: "medium", near_boundary: "hard",
  ambiguous: "hard", adversarial: "hard", contradictory: "hard", cross_version: "hard",
};

const cases = [];
let seq = 0;
function addCase(rule, caseType, input, expected, reason, extra = {}) {
  seq++;
  const acceptable = extra.acceptable || [expected];
  cases.push({
    case_id: `C${String(seq).padStart(5, "0")}`,
    entity_info: entity(rule.category, seq),
    rule_id: rule.rule_key,
    rule: {
      rule_key: rule.rule_key,
      clause_uri: rule.clause_uri,
      rbi_ref: rule.rbi_ref,
      paragraph: rule.paragraph,
      category: rule.category,
      rule_type: rule.rule_type,
      requires_semantic_interpretation: rule.requires_semantic_interpretation,
      risk_level: rule.risk_level,
      operator: rule.operator ?? null,
      threshold: rule.threshold ?? null,
      unit: rule.unit ?? null,
      metric: rule.metric ?? null,
      required_fields: rule.required_fields,
      clause_text: rule.clause_text,
      versioned: rule.versioned || null,
    },
    input_data: input,
    relevant_documents: [rule.clause_uri],
    expected_decision: expected,
    acceptable_decisions: acceptable,
    expected_reason: reason,
    difficulty_level: DIFFICULTY[caseType] || "medium",
    case_type: caseType,
    regulation_version: extra.regulation_version || "corpus-2025-26",
    generation_method: extra.generation_method || "template",
    split: extra.split || splitOf(rule.rule_key),
  });
}

// ── numeric helpers ──
const OPS = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, ">": (v, t) => v > t, "<": (v, t) => v < t };
const satisfies = (op, v, t) => OPS[op](v, t);
const unitText = (u) => (u === "%" ? "%" : u === "days" ? " days" : u === "working_days" ? " working days" : ` ${u}`);
const fmtVal = (v, u) => `${v}${unitText(u)}`;
const sideValue = (op, t, satisfy, lo, hi) => {
  const up = op === ">=" || op === ">";
  const rel = between(lo, hi);
  const f = satisfy === up ? 1 + rel : 1 - rel;
  let v = t * f;
  if (Math.abs(v - t) < 0.01) v = satisfy === up ? t + 0.01 : t - 0.01;
  return r2(Math.max(0, v));
};
const intDays = (op, t, satisfy, lo, hi) => {
  const v = Math.round(sideValue(op, t, satisfy, lo, hi));
  if (satisfy && !satisfies(op, v, t)) return op.startsWith("<") || op === "within_days" ? t : t;
  if (!satisfy && satisfies(op, v, t)) return op.startsWith("<") || op === "within_days" ? t + 1 : t - 1;
  return v;
};

const NEUTRAL_NARRATIVES = [
  "During the quarter the Bank opened 12 new branches and expanded its digital channels.",
  "The Board reviewed the business plan and the customer acquisition strategy for the next year.",
  "The Bank completed the migration of its core banking system to a new data centre.",
];

// Quantitative-style cases (A, D and the value part of C / cross-version)
function numericCases(rule, { integer = false, when = "as on 30 September 2025" } = {}) {
  const op = rule.operator === "within_days" ? "<=" : rule.operator;
  const t = rule.threshold;
  const u = rule.unit;
  const m = rule.metric;
  const val = (sat, lo, hi) => (integer ? intDays(op, t, sat, lo, hi) : sideValue(op, t, sat, lo, hi));
  const statement = (v) => pick([
    `The ${m} stood at ${fmtVal(v, u)} ${when}.`,
    `For the reporting period the ${m} was ${fmtVal(v, u)}.`,
    `As reported in the return, ${m}: ${fmtVal(v, u)}.`,
  ]);
  const structured = (v) => ({ [rule.field]: v });

  const vc = val(true, 0.1, 0.4);
  addCase(rule, "compliant", { structured: structured(vc), narrative: statement(vc) }, "COMPLIANT", `${fmtVal(vc, u)} satisfies ${rule.operator} ${fmtVal(t, u)}`);
  const vn = val(false, 0.05, 0.3);
  addCase(rule, "non_compliant", { structured: structured(vn), narrative: statement(vn) }, "NON_COMPLIANT", `${fmtVal(vn, u)} fails ${rule.operator} ${fmtVal(t, u)}`);
  const bd = satisfies(op, t, t) ? "COMPLIANT" : "NON_COMPLIANT";
  addCase(rule, "boundary", { structured: structured(t), narrative: statement(t) }, bd, `value exactly at the threshold; ${op} ${t} is ${bd === "COMPLIANT" ? "met" : "not met"} at equality`);
  const n1 = val(true, 0.01, 0.05);
  addCase(rule, "near_boundary", { structured: structured(n1), narrative: statement(n1) }, "COMPLIANT", `${fmtVal(n1, u)} is just inside ${op} ${fmtVal(t, u)}`);
  const n2 = val(false, 0.01, 0.05);
  addCase(rule, "near_boundary", { structured: structured(n2), narrative: statement(n2) }, "NON_COMPLIANT", `${fmtVal(n2, u)} is just outside ${op} ${fmtVal(t, u)}`);
  addCase(rule, "missing_data", { structured: {}, narrative: pick(NEUTRAL_NARRATIVES) }, "INSUFFICIENT_DATA", `the ${m} is not reported`);
  // adversarial: qualitative language contradicting the number; the number must dominate
  if (rnd() < 0.5) {
    const va = val(false, 0.05, 0.25);
    addCase(rule, "adversarial", {
      structured: structured(va),
      narrative: `${statement(va)} ${pick([
        `The Bank remains comfortably compliant with the ${m} requirement and well within the regulatory norm.`,
        `Management confirms that the position on ${m} is fully in line with RBI directions.`,
      ])}`,
    }, "NON_COMPLIANT", "the reported figure fails the threshold despite the reassuring narrative");
  } else {
    const va = val(true, 0.05, 0.25);
    addCase(rule, "adversarial", {
      structured: structured(va),
      narrative: `${statement(va)} ${pick([
        `Concerns were raised in the audit committee about the adequacy of the ${m}, which remains under watch.`,
        `The ${m} is a matter of serious concern and has been flagged for close monitoring.`,
      ])}`,
    }, "COMPLIANT", "the reported figure meets the threshold despite the alarming narrative");
  }
  // contradictory: two sources straddle the threshold
  const s1 = val(true, 0.02, 0.15);
  const s2 = val(false, 0.02, 0.15);
  addCase(rule, "contradictory", {
    structured: { [rule.field]: s1 },
    sources: [{ source: "regulatory return", [rule.field]: s1 }, { source: "audited annual report", [rule.field]: s2 }],
    narrative: `The regulatory return reports ${fmtVal(s1, u)} while the audited annual report states ${fmtVal(s2, u)} for the same date.`,
  }, "REQUIRES_HUMAN_REVIEW", "two sources disagree on which side of the threshold the figure lies", { acceptable: ["REQUIRES_HUMAN_REVIEW", "AMBIGUOUS"] });
  // ambiguous: only an approximate range that straddles the threshold
  if (!integer) {
    const lo = val(false, 0.02, 0.08);
    const hi = val(true, 0.02, 0.08);
    const [a, b] = lo < hi ? [lo, hi] : [hi, lo];
    addCase(rule, "ambiguous", { structured: {}, narrative: `The ${m} was estimated to be in the range of ${fmtVal(a, u)} to ${fmtVal(b, u)}; the final figure is awaited.` }, "AMBIGUOUS",
      "only a range straddling the threshold is available", { acceptable: ["AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"] });
  }
}

// ── rule pools ──
const categoriesOf = (docId) => db.prepare("SELECT category FROM document_categories WHERE doc_id = ?").all(docId).map((r) => r.category).filter((c) => c !== "multiple");

function poolAnchored() {
  const out = [];
  for (const r of regulatoryRules.RULES) {
    const src = regulatoryRules.resolveSource(r);
    if (!src.verified || typeof r.threshold !== "number") continue;
    const metric = catalog.get(r.metric);
    const clause = db.prepare("SELECT clause_text FROM clause_registry WHERE clause_uri = ?").get(src.clause_uri);
    const tax = classifyRule({ clause_text: src.excerpt, atom: { operator: r.op, threshold_unit: "%" }, doc_title: src.doc_title });
    out.push({
      rule_key: `anchored:${r.key}`, category: r.category, clause_uri: src.clause_uri, rbi_ref: src.rbi_ref, paragraph: src.paragraph,
      clause_text: (clause?.clause_text || src.excerpt).slice(0, 1500), operator: r.op, threshold: r.threshold, unit: metric.unit,
      metric: metric.label, field: r.metric, required_fields: [r.metric], ...tax, rule_type: "A",
    });
  }
  return out;
}

function poolAtoms(where, n, type) {
  const rows = db.prepare(
    `SELECT ra.rule_id, ra.clause_uri, ra.operator, ra.threshold_value, ra.threshold_unit, ra.variable_text, ra.sentence,
            cr.clause_text, cr.clause_type, cr.paragraph_number, d.doc_id, d.rbi_ref, d.title
     FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri JOIN documents d ON d.doc_id = cr.doc_id
     WHERE ra.atom_kind = 'requirement' AND ra.confidence = 'high' AND ${where}
     ORDER BY ra.rule_id`
  ).all();
  const good = rows.filter((r) => {
    const vt = String(r.variable_text || "").trim();
    return vt.length >= 6 && vt.length <= 110 && !/^(not|be|of|in|to|and|or|the)\b/i.test(vt) && !/\|/.test(r.sentence || "") && categoriesOf(r.doc_id).length;
  });
  const seenClause = new Set();
  const out = [];
  for (const r of shuffle(good)) {
    if (seenClause.has(r.clause_uri)) continue;
    seenClause.add(r.clause_uri);
    const tax = classifyRule({ clause_text: r.clause_text, clause_type: r.clause_type, atom: r, doc_title: r.title });
    if (type && tax.rule_type !== type) continue;
    out.push({
      rule_key: `atom:${r.rule_id}`, category: categoriesOf(r.doc_id)[0], clause_uri: r.clause_uri, rbi_ref: r.rbi_ref, paragraph: r.paragraph_number,
      clause_text: r.clause_text.slice(0, 1500), operator: r.operator, threshold: r.threshold_value, unit: r.threshold_unit,
      metric: r.variable_text.trim().replace(/\s+/g, " "), field: `atom_${r.rule_id}`, required_fields: [`atom_${r.rule_id}`], sentence: r.sentence, ...tax,
    });
    if (out.length >= n) break;
  }
  return out;
}

// obligation clauses for B / E: one "shall" sentence each
function obligationSentence(text) {
  const sents = String(text).replace(/\s+/g, " ").split(/(?<=[.;])\s+(?=[A-Z(])/);
  return sents.find((s) => /\bshall\b/.test(s) && s.length >= 60 && s.length <= 320 && !/\|/.test(s)) || null;
}
function poolObligations(type, n) {
  const rows = db.prepare(
    `SELECT cr.clause_uri, cr.clause_text, cr.clause_type, cr.paragraph_number, d.doc_id, d.rbi_ref, d.title
     FROM clause_registry cr JOIN documents d ON d.doc_id = cr.doc_id
     WHERE cr.clause_role = 'obligation' AND cr.clause_type IN ('qualitative','hybrid') AND length(cr.clause_text) BETWEEN 80 AND 1200
       AND cr.clause_uri NOT IN (SELECT clause_uri FROM rule_atoms)
     ORDER BY cr.clause_uri`
  ).all();
  const out = [];
  const perDoc = new Map();
  for (const r of shuffle(rows)) {
    if (!categoriesOf(r.doc_id).length) continue;
    const tax = classifyRule({ clause_text: r.clause_text, clause_type: r.clause_type, doc_title: r.title });
    if (tax.rule_type !== type) continue;
    const sentence = obligationSentence(r.clause_text);
    if (!sentence) continue;
    const action = actionOf(sentence);
    if (!action) continue;
    if ((perDoc.get(r.doc_id) || 0) >= 3) continue; // spread across directions
    perDoc.set(r.doc_id, (perDoc.get(r.doc_id) || 0) + 1);
    out.push({
      rule_key: `clause:${r.clause_uri}`, category: categoriesOf(r.doc_id)[0], clause_uri: r.clause_uri, rbi_ref: r.rbi_ref, paragraph: r.paragraph_number,
      clause_text: r.clause_text.slice(0, 1500), sentence, action, field: "requirement_met",
      required_fields: type === "B" ? ["requirement_met"] : ["narrative"], ...tax,
    });
    if (out.length >= n) break;
  }
  return out;
}

// "... shall ensure that X" -> action "ensure that X"
function actionOf(sentence) {
  const m = /\bshall\s+(?!not\b)(.+?)[.;]?$/.exec(sentence);
  if (!m) return null;
  let a = m[1].replace(/\s+/g, " ").trim();
  if (a.length > 220) a = a.slice(0, 220).replace(/\s+\S*$/, "");
  return a;
}
// "ensure that X" -> "ensures that X"; "be responsible" -> "is responsible"; "have" -> "has"
function third(action) {
  const [first, ...rest] = action.split(" ");
  const irregular = { be: "is", have: "has", do: "does" };
  let v = irregular[first.toLowerCase()] || (/(s|sh|ch|x|z)$/i.test(first) ? `${first}es` : /[^aeiou]y$/i.test(first) ? `${first.slice(0, -1)}ies` : `${first}s`);
  return [v, ...rest].join(" ");
}

function textCases(rule, { structuredBoolean }) {
  const act = rule.action;
  const s = (b) => (structuredBoolean ? { requirement_met: b } : {});
  const affirm = pick([
    `In line with its Board-approved practice, the Bank ${third(act)}. Compliance was reviewed by the Board on 14 May 2026.`,
    `The Bank confirms that it ${third(act)}, and the internal auditor verified this during the year.`,
    `During the year the Bank continued to ${act}, as recorded in the minutes of the Audit Committee.`,
  ]);
  const deny = pick([
    `The internal audit for the year observed that the Bank does not ${act}; corrective action is pending.`,
    `The inspection found that the Bank has failed to ${act}.`,
    `There is currently no arrangement under which the Bank would ${act}.`,
  ]);
  addCase(rule, "compliant", { structured: s(true), narrative: affirm }, "COMPLIANT", "the evidence states the obligation is met");
  addCase(rule, "non_compliant", { structured: s(false), narrative: deny }, "NON_COMPLIANT", "the evidence states the obligation is not met");
  // unrelated evidence
  addCase(rule, "missing_data", { structured: {}, narrative: pick(NEUTRAL_NARRATIVES) }, "INSUFFICIENT_DATA", "no evidence addresses the obligation");
  addCase(rule, "ambiguous", {
    structured: {},
    narrative: pick([
      `The Bank has started work to ${act}; this is partially implemented and is expected to be completed next year.`,
      `A draft framework intended to ${act} is under preparation and is yet to be placed before the Board.`,
    ]),
  }, "AMBIGUOUS", "the evidence shows partial / in-progress implementation", { acceptable: ["AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"] });
  // adversarial: compliant-sounding but only an intention / restatement
  addCase(rule, "adversarial", {
    structured: s(false),
    narrative: pick([
      `The Bank is fully aware that it is required to ${act} and plans to take this up in a future review.`,
      `The Bank remains committed to the highest standards and intends to ${act} in due course.`,
    ]),
  }, "NON_COMPLIANT", "awareness or intention is not compliance");
  addCase(rule, "contradictory", {
    structured: s(true),
    narrative: `${affirm} However, the RBI inspection report for the same period records that the Bank does not ${act}.`,
  }, "REQUIRES_HUMAN_REVIEW", "the bank's statement and the inspection finding disagree", { acceptable: ["REQUIRES_HUMAN_REVIEW", "AMBIGUOUS"] });
}

// conditional: "% requirement ... if / provided that ..."
function conditionalCases(rule) {
  const t = rule.threshold;
  const op = rule.operator;
  const cond = (/\b(if|provided that|unless|where|in case)\b[^,.;]{5,120}/i.exec(rule.sentence || rule.clause_text) || [""])[0] || "the stated condition applies";
  const f = rule.field;
  const ok = sideValue(op, t, true, 0.1, 0.3);
  const bad = sideValue(op, t, false, 0.1, 0.3);
  const st = (met, v) => ({ structured: { condition_met: met, [f]: v }, narrative: `Condition (${cond.trim()}): ${met ? "applies" : "does not apply"} to the Bank. The ${rule.metric} was ${fmtVal(v, rule.unit)}.` });
  addCase(rule, "compliant", st(true, ok), "COMPLIANT", "condition met and requirement satisfied");
  addCase(rule, "non_compliant", st(true, bad), "NON_COMPLIANT", "condition met and requirement failed");
  addCase(rule, "boundary", st(false, bad), "COMPLIANT", "the condition does not apply, so the requirement is not triggered");
  addCase(rule, "missing_data", { structured: { [f]: bad }, narrative: `The ${rule.metric} was ${fmtVal(bad, rule.unit)}. Whether the condition applies is not stated.` }, "INSUFFICIENT_DATA", "whether the condition applies is unknown");
  addCase(rule, "adversarial", { ...st(false, bad), narrative: `${st(false, bad).narrative} The auditors described the ${rule.metric} as a serious breach.` }, "COMPLIANT", "not triggered, whatever the narrative says");
}

// cross-version: CRR schedule and UCB net worth
function crossVersionCases() {
  const CATS = ["commercial_banks", "small_finance_banks", "payments_banks", "urban_cooperative_banks", "regional_rural_banks", "local_area_banks", "rural_cooperative_banks"];
  for (const cat of CATS) {
    const sch = versioned.schedule(cat, "crr");
    if (!sch) continue;
    const clause = db.prepare("SELECT clause_text FROM clause_registry WHERE clause_uri = ?").get(sch.source.clause_uri);
    const rule = {
      rule_key: `versioned:crr:${cat}`, category: cat, clause_uri: sch.source.clause_uri, rbi_ref: sch.source.rbi_ref, paragraph: sch.source.paragraph,
      clause_text: clause.clause_text.slice(0, 1500), operator: ">=", threshold: null, unit: "%", metric: "Cash Reserve Ratio (average daily balance as % of NDTL)",
      field: "crr_pct", required_fields: ["crr_pct", "as_of_date"], versioned: { rule: "crr", category: cat },
      ...classifyRule({ clause_text: clause.clause_text, atom: { operator: ">=", threshold_unit: "%" } }), rule_type: "A",
    };
    // the same value before and after a step-down
    for (let i = 0; i < sch.versions.length - 1; i++) {
      const hi = sch.versions[i].threshold;
      const lo = sch.versions[i + 1].threshold;
      const v = r2(between(lo + 0.01, hi - 0.01));
      const dBefore = sch.versions[i].effective_from.replace(/-(\d\d)$/, (x, d) => `-${String(Number(d) + 7).padStart(2, "0")}`);
      const dAfter = sch.versions[i + 1].effective_from.replace(/-(\d\d)$/, (x, d) => `-${String(Number(d) + 7).padStart(2, "0")}`);
      for (const [date, ok, req] of [[dBefore, false, hi], [dAfter, true, lo]]) {
        addCase(rule, "cross_version", {
          structured: { crr_pct: v, as_of_date: date },
          narrative: `For the fortnight covering ${date} the Bank maintained an average CRR balance of ${v}% of NDTL.`,
        }, ok ? "COMPLIANT" : "NON_COMPLIANT", `${v}% against the ${req}% in force on ${date}`,
        { regulation_version: `crr-v${ok ? i + 2 : i + 1}`, split: splitOf(`${rule.rule_key}:${i}`) });
      }
    }
  }
  const nw = versioned.schedule("urban_cooperative_banks", "ucb_net_worth");
  if (nw) {
    const clause = db.prepare("SELECT clause_text FROM clause_registry WHERE clause_uri = ?").get(nw.source.clause_uri);
    const rule = {
      rule_key: "versioned:ucb_net_worth", category: "urban_cooperative_banks", clause_uri: nw.source.clause_uri, rbi_ref: nw.source.rbi_ref, paragraph: nw.source.paragraph,
      clause_text: clause.clause_text.slice(0, 1500), operator: ">=", threshold: null, unit: "₹ crore", metric: "net worth",
      field: "net_worth", required_fields: ["net_worth", "as_of_date"], versioned: { rule: "ucb_net_worth", category: "urban_cooperative_banks" },
      ...classifyRule({ clause_text: clause.clause_text, atom: { operator: ">=", threshold_unit: "₹ crore" } }), rule_type: "A",
    };
    for (const v of [3.2, 4.4]) {
      for (const [date, ok] of [["2026-06-30", true], ["2028-06-30", false]]) {
        addCase(rule, "cross_version", { structured: { net_worth: v, as_of_date: date }, narrative: `The Bank's net worth as on ${date} was ₹${v} crore.` },
          ok ? "COMPLIANT" : "NON_COMPLIANT", `₹${v} crore against ₹${ok ? 2.5 : 5} crore required on ${date}`, { regulation_version: `ucb-nw-v${ok ? 1 : 2}` });
      }
    }
  }
}

// G: graph scenarios -> one case per expectation
function graphCases() {
  const file = path.join(__dirname, "..", "..", "eval", "graph_scenarios.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const graphRules = require("../../src/services/graph/graphRules");
  for (const sc of data.scenarios) {
    for (const exp of sc.expected) {
      if (exp.absent) continue;
      const gr = graphRules.RULES.find((r) => r.key === exp.rule_key);
      const expected = decisionOf(exp.status);
      const rule = {
        rule_key: `graph:${exp.rule_key}`, category: sc.category, clause_uri: `graph-rule:${exp.rule_key}`, rbi_ref: null, paragraph: null,
        clause_text: gr ? `${gr.label}. ${gr.note || ""}`.trim() : exp.rule_key, operator: "<=", threshold: gr?.limit ?? null, unit: "%",
        metric: gr?.label || exp.rule_key, field: "network", required_fields: ["network"], rule_type: "G",
        requires_semantic_interpretation: false, risk_level: "high", deterministic: true,
      };
      const caseType = exp.status === "POTENTIAL_BREACH" ? "ambiguous" : ["PASS", "INFO", "REPORTABLE"].includes(exp.status) ? "compliant" : expected === "INSUFFICIENT_DATA" ? "missing_data" : "non_compliant";
      addCase(rule, caseType, { structured: { network_scenario: sc.id }, expectation: exp, narrative: sc.description || sc.title },
        expected, `${exp.rule_key} ${exp.subject || (exp.members_include ? `group{${exp.members_include.join(",")}}` : "")}: ${exp.status}`,
        { generation_method: "hand-authored", split: splitOf(`scenario:${sc.id}`), acceptable: expected === "AMBIGUOUS" ? ["AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"] : [expected] });
    }
  }
}

function main() {
  const anchored = poolAnchored();
  const atomsA = poolAtoms("ra.threshold_unit = '%' AND ra.operator IN ('>=','<=') AND (ra.sentence LIKE '%shall not exceed%' OR ra.sentence LIKE '%at least%' OR ra.sentence LIKE '%not less than%' OR ra.sentence LIKE '%minimum%' OR ra.sentence LIKE '%shall not be more than%' OR ra.sentence LIKE '%not more than%')", 24, "A");
  const atomsC = poolAtoms("ra.threshold_unit = '%' AND ra.operator IN ('>=','<=') AND (ra.sentence LIKE '%if %' OR ra.sentence LIKE '%provided that%' OR ra.sentence LIKE '%unless%' OR ra.sentence LIKE '%where %')", 16, "C");
  const atomsD = poolAtoms("ra.operator = 'within_days'", 24, "D");
  const oblB = poolObligations("B", 36);
  const oblE = poolObligations("E", 48);
  const oblF = poolObligations("F", 16);

  for (const r of [...anchored, ...atomsA]) numericCases(r);
  for (const r of atomsD) numericCases({ ...r, metric: `number of days taken to ${r.metric.replace(/^(be\s+)/i, "")}` }, { integer: true });
  for (const r of atomsC) conditionalCases(r);
  for (const r of oblB) textCases(r, { structuredBoolean: true });
  for (const r of oblE) textCases(r, { structuredBoolean: false });
  for (const r of oblF) textCases(r, { structuredBoolean: false });
  crossVersionCases();
  graphCases();

  const by = (k) => cases.reduce((acc, c) => ((acc[c[k]] = (acc[c[k]] || 0) + 1), acc), {});
  const byType = cases.reduce((acc, c) => ((acc[c.rule.rule_type] = (acc[c.rule.rule_type] || 0) + 1), acc), {});
  const out = {
    name: "URCC-EF rule-grounded synthetic compliance benchmark",
    version: 1,
    seed: SEED,
    generated_at: new Date().toISOString(),
    description:
      "Every case is derived from a rule in the RBI corpus (rule id + source clause) with a ground-truth decision by construction. Bank entities and figures are synthetic. See scripts/benchmark/build_benchmark.js.",
    counts: { total: cases.length, by_case_type: by("case_type"), by_rule_type: byType, by_split: by("split"), by_generation_method: by("generation_method"), distinct_rules: new Set(cases.map((c) => c.rule_id)).size },
    cases,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${cases.length} cases (${out.counts.distinct_rules} rules) to ${path.relative(process.cwd(), OUT)}`);
  console.log(JSON.stringify(out.counts, null, 1));
}

main();
