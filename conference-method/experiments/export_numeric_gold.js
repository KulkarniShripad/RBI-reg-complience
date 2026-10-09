#!/usr/bin/env node
/**
 * Export the main system's hand-verified numeric rules (62 limits: 26 requirements on
 * published figures + 36 network limits) as a held-out test for regcomp's threshold
 * extraction. These rules were written and verified for the main system before
 * regcomp existed, so regcomp was never tuned on them.
 *
 *   node experiments/export_numeric_gold.js   → data/numeric_gold.json
 * (run from conference-method/, needs the main system's database: urcc-ef-backend/data/urcc_ef.db)
 */
const fs = require("fs");
const path = require("path");
const backend = path.join(__dirname, "..", "..", "urcc-ef-backend");
const regulatoryRules = require(path.join(backend, "src/services/disclosure/regulatoryRules"));
const graphRules = require(path.join(backend, "src/services/graph/graphRules"));

const out = [];
for (const r of regulatoryRules.RULES) {
  const src = regulatoryRules.resolveSource(r);
  if (!src.verified) continue;
  const values = typeof r.threshold === "number" ? [r.threshold] : r.bounds || [];
  out.push({ key: r.key, set: "figures", category: r.category, doc_title: src.doc_title, title_regex: r.source.title.source,
    text_regex: r.source.text.source, operator: r.op, values: r.level === "buffer" ? [2.5] : values, unit: r.unit || "%" });
}
for (const r of graphRules.RULES) {
  const src = graphRules.resolveSource(r);
  if (!src?.verified || typeof r.limit !== "number") continue;
  out.push({ key: r.key, set: "network", category: r.category, doc_title: src.doc_title, title_regex: r.source.title.source,
    text_regex: r.source.text ? r.source.text.source : null, para: r.source.para || null, clause_text: src.clause_text || null,
    operator: "<=", values: [r.limit], unit: "%" });
}
const file = path.join(__dirname, "..", "data", "numeric_gold.json");
fs.writeFileSync(file, JSON.stringify({ source: "urcc-ef-backend regulatoryRules.js + graphRules.js (verified sources only)", n: out.length, rules: out }, null, 1));
console.log(`${out.length} rules → ${file}`);
