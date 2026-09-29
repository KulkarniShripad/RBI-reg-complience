#!/usr/bin/env node
/**
 * Rule-extraction quality against a hand-verified gold set (journal RQ3,
 * Table IX), measured, not assumed.
 *
 * Gold set: the rules whose paragraph, operator and number were verified by
 * hand while building the anchored rule sets -
 *   - 26 requirements on published figures (src/services/disclosure/regulatoryRules.js)
 *   - the numeric limits of the 53 network rules (src/services/graph/graphRules.js)
 * each located in the corpus by its paragraph text.
 *
 * For every gold rule: did the extraction pipeline (classifier.py → rule_atoms)
 * produce an atom in that paragraph with the same operator and threshold?
 *   recall            gold rules recovered exactly (operator + value + unit)
 *   value recall      gold threshold value present in some atom of the paragraph
 *   operator accuracy among value matches, the operator is right
 *   atom precision    atoms extracted from the gold paragraphs whose value is a
 *                     gold value of that paragraph (a lower bound: a paragraph
 *                     can state other, legitimate numbers)
 * plus agreement of the A–G taxonomy with the gold category of each rule.
 *
 *   node scripts/eval_extraction_gold.js      → eval/results/extraction_gold.{json,md}
 */
const fs = require("fs");
const path = require("path");
const db = require("../src/config/db");
const regulatoryRules = require("../src/services/disclosure/regulatoryRules");
const graphRules = require("../src/services/graph/graphRules");
const { classifyRule } = require("../src/services/router/ruleTaxonomy");

const OUT = path.join(__dirname, "..", "eval", "results");

function gold() {
  const out = [];
  for (const r of regulatoryRules.RULES) {
    const src = regulatoryRules.resolveSource(r);
    if (!src.verified) continue;
    const value = typeof r.threshold === "number" ? r.threshold : null;
    const values = value !== null ? [value] : r.bounds || [];
    // buffer rules state 2.5% above the minimum: the paragraph's own number is 2.5
    const stated = r.level === "buffer" ? [2.5] : values;
    out.push({ key: r.key, set: "figures", category: r.category, clause_uri: src.clause_uri, operator: r.op, values: stated, unit: r.unit || "%", gold_type: "A" });
  }
  for (const r of graphRules.RULES) {
    const src = graphRules.resolveSource(r);
    if (!src?.verified || typeof r.limit !== "number") continue;
    // gold category by kind of rule, fixed before the classifier was evaluated
    const GOLD = { single_limit: ["A"], group_limit: ["G"], ite_single: ["F", "G"], ite_aggregate: ["G"], related_party: ["F"], le_reporting: ["A", "D"], policy_only: ["B"], econ_assessment: ["G", "B"] };
    out.push({ key: r.key, set: "network", category: r.category, clause_uri: src.clause_uri, operator: "<=", values: [r.limit], unit: "%", gold_type: (GOLD[r.kind] || ["G"])[0], gold_types: GOLD[r.kind] || ["G"], kind: r.kind });
  }
  return out;
}

const near = (a, b) => Math.abs(Number(a) - Number(b)) < 1e-6;

function main() {
  const g = gold();
  const atomsAt = db.prepare("SELECT operator, threshold_value, threshold_unit, atom_kind, variable_text, sentence FROM rule_atoms WHERE clause_uri = ?");
  const clauseAt = db.prepare("SELECT cr.clause_text, cr.clause_type, d.title FROM clause_registry cr JOIN documents d ON d.doc_id = cr.doc_id WHERE cr.clause_uri = ?");
  const rows = [];
  const paraSeen = new Map();
  for (const r of g) {
    const atoms = atomsAt.all(r.clause_uri);
    const unitOk = (u) => (r.unit === "%" ? u === "%" || !u : /crore|₹/.test(String(u || "")));
    const valueHits = atoms.filter((a) => r.values.some((v) => near(a.threshold_value, v)) && unitOk(a.threshold_unit));
    const exact = valueHits.filter((a) => a.operator === r.operator || (r.operator === "<=" && a.operator === "<") || (r.operator === ">=" && a.operator === ">"));
    const clause = clauseAt.get(r.clause_uri);
    const tax = clause ? classifyRule({ clause_text: clause.clause_text, clause_type: clause.clause_type, doc_title: clause.title, atom: exact[0] || valueHits[0] || null, graphCovered: false }) : null; // gold type is not given to the classifier
    // a paragraph that states both a single and a group limit is legitimately A or G
    const both = clause && /single[^.;]{0,40}\b(?:and|&)\s+group\b/i.test(clause.clause_text);
    const acceptable = new Set([...(r.gold_types || [r.gold_type]), ...(both ? ["A", "G"] : [])]);
    rows.push({ ...r, acceptable: [...acceptable], atoms: atoms.length, value_recovered: valueHits.length > 0, exact_recovered: exact.length > 0, operator_right: valueHits.length ? exact.length > 0 : null, predicted_type: tax?.rule_type || null });
    const p = paraSeen.get(r.clause_uri) || { atoms, gold_values: new Set() };
    r.values.forEach((v) => p.gold_values.add(v));
    paraSeen.set(r.clause_uri, p);
  }
  let atomTotal = 0;
  let atomGold = 0;
  for (const p of paraSeen.values()) {
    const reqAtoms = p.atoms.filter((a) => a.threshold_unit === "%");
    atomTotal += reqAtoms.length;
    atomGold += reqAtoms.filter((a) => [...p.gold_values].some((v) => near(a.threshold_value, v))).length;
  }
  const rate = (arr, k) => (arr.length ? arr.filter((x) => x[k]).length / arr.length : 0);
  const summarize = (arr) => ({
    n: arr.length,
    exact_recall: +rate(arr, "exact_recovered").toFixed(3),
    value_recall: +rate(arr, "value_recovered").toFixed(3),
    operator_accuracy: +(arr.filter((x) => x.value_recovered).length ? arr.filter((x) => x.operator_right).length / arr.filter((x) => x.value_recovered).length : 0).toFixed(3),
    taxonomy_agreement: +rate(arr.map((x) => ({ ok: x.acceptable.includes(x.predicted_type) })), "ok").toFixed(3),
  });
  const report = {
    gold_rules: g.length,
    distinct_paragraphs: paraSeen.size,
    overall: summarize(rows),
    by_set: { figures: summarize(rows.filter((r) => r.set === "figures")), network: summarize(rows.filter((r) => r.set === "network")) },
    by_gold_type: Object.fromEntries(["A", "F", "G"].map((t) => [t, summarize(rows.filter((r) => r.gold_type === t))])),
    atom_precision_lower_bound: +(atomTotal ? atomGold / atomTotal : 0).toFixed(3),
    atoms_in_gold_paragraphs: atomTotal,
    types: rows.map((r) => ({ key: r.key, kind: r.kind || "figure", gold: r.acceptable, predicted: r.predicted_type })),
    misses: rows.filter((r) => !r.exact_recovered).map((r) => ({ key: r.key, clause_uri: r.clause_uri, expected: `${r.operator} ${r.values.join("/")}%`, value_recovered: r.value_recovered })),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "extraction_gold.json"), JSON.stringify(report, null, 1));
  const L = [
    "# Rule extraction against the hand-verified gold set (RQ3)",
    "",
    `${report.gold_rules} gold rules in ${report.distinct_paragraphs} paragraphs.`,
    "",
    "| Subset | n | Exact recall (op + value) | Value recall | Operator accuracy | A–G taxonomy agreement |",
    "|---|---|---|---|---|---|",
    ...[["All", report.overall], ["Figure requirements (A)", report.by_set.figures], ["Network limits (F/G)", report.by_set.network]].map(
      ([k, m]) => `| ${k} | ${m.n} | ${(m.exact_recall * 100).toFixed(1)}% | ${(m.value_recall * 100).toFixed(1)}% | ${(m.operator_accuracy * 100).toFixed(1)}% | ${(m.taxonomy_agreement * 100).toFixed(1)}% |`
    ),
    "",
    `Atom precision in the gold paragraphs (lower bound): ${(report.atom_precision_lower_bound * 100).toFixed(1)}% of ${report.atoms_in_gold_paragraphs} percentage atoms carry a gold value.`,
    "",
  ];
  fs.writeFileSync(path.join(OUT, "extraction_gold.md"), L.join("\n"));
  console.log(L.join("\n"));
  console.log(`misses: ${report.misses.length}`);
}

main();
