#!/usr/bin/env node
/**
 * Plain-language simplification (journal Sec. V.H, RQ4), measured.
 *
 * Sample: obligation clauses stratified by requirement category A–G (up to 40
 * each, seed 7). For each clause, simplifyService.simplify (rule-based; Gemini
 * with --llm when configured) and:
 *   FKGL                 Flesch-Kincaid grade level, original vs simplified
 *   words / sentence     mean sentence length
 *   guard pass           the simplified text keeps every number, the
 *                        obligation / prohibition polarity and every exception
 *                        marker of the original (simplifyService.preserves)
 *   rule re-extraction   the extraction pipeline (classifier.py) run on both
 *                        texts yields the same (operator, value, unit) atoms -
 *                        the rule a machine reads is unchanged
 *   semantic similarity  cosine of the two texts' BGE embeddings
 *   verbatim sentences   share of sentences the guard kept in the original wording
 *
 *   node scripts/eval_simplification.js [--llm]   → eval/results/simplification_eval.{json,md}
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const db = require("../src/config/db");
const embedding = require("../src/services/embeddingService");
const simplifier = require("../src/services/simplifyService");
const { classifyRule } = require("../src/services/router/ruleTaxonomy");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "eval", "results");
const PER_TYPE = 40;
const USE_LLM = process.argv.includes("--llm");

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sample() {
  const rows = db
    .prepare(
      `SELECT cr.clause_uri, cr.clause_text, cr.clause_type, d.title,
              (SELECT operator FROM rule_atoms ra WHERE ra.clause_uri = cr.clause_uri AND ra.atom_kind = 'requirement' ORDER BY rule_id LIMIT 1) AS operator,
              (SELECT threshold_unit FROM rule_atoms ra WHERE ra.clause_uri = cr.clause_uri AND ra.atom_kind = 'requirement' ORDER BY rule_id LIMIT 1) AS threshold_unit,
              (SELECT sentence FROM rule_atoms ra WHERE ra.clause_uri = cr.clause_uri AND ra.atom_kind = 'requirement' ORDER BY rule_id LIMIT 1) AS sentence
       FROM clause_registry cr JOIN documents d ON d.doc_id = cr.doc_id
       WHERE cr.clause_role = 'obligation' AND length(cr.clause_text) BETWEEN 80 AND 2500
       ORDER BY cr.clause_uri`
    )
    .all();
  const byType = {};
  for (const r of rows) {
    const t = classifyRule({ clause_text: r.clause_text, clause_type: r.clause_type, doc_title: r.title, atom: r.operator ? r : null }).rule_type;
    (byType[t] ||= []).push(r);
  }
  const rnd = mulberry32(7);
  const out = [];
  for (const t of Object.keys(byType).sort()) {
    const pool = byType[t].slice();
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.slice(0, PER_TYPE).forEach((r) => out.push({ ...r, rule_type: t }));
  }
  return out;
}

/** (operator, value, unit) atoms of each text, from the extraction pipeline itself. */
function extractAtoms(texts) {
  const py = `
import json, sys
sys.path.insert(0, ${JSON.stringify(path.join(ROOT, "scripts"))})
from classifier import extract_rule_atoms
out = []
for t in json.load(sys.stdin):
    out.append(sorted({f"{a.operator}|{round(float(a.threshold_value), 4)}|{a.threshold_unit}" for a in extract_rule_atoms(t) if a.threshold_value is not None}))
print(json.dumps(out))
`;
  return JSON.parse(execFileSync("python3", ["-c", py], { input: JSON.stringify(texts), maxBuffer: 64 * 1024 * 1024 }).toString());
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const wordsPerSentence = (t) => {
  const s = simplifier.splitProvisions(t);
  const w = String(t).match(/[A-Za-z0-9][A-Za-z0-9'%.-]*/g) || [];
  return s.length ? w.length / s.length : null;
};

async function main() {
  const rows = sample();
  console.error(`[eval:simplification] ${rows.length} clauses, llm=${USE_LLM}`);
  for (const r of rows) {
    const s = await simplifier.simplify(r.clause_text, { useLlm: USE_LLM });
    r.simplified = s.text;
    r.method = s.method;
    r.verbatim = s.fallbacks ?? 0;
    r.sentences = s.sentences ? s.sentences.length : simplifier.splitProvisions(s.text).length;
    r.guard_ok = simplifier.preserves(r.clause_text, s.text).ok;
    r.fkgl_before = simplifier.fkgl(r.clause_text);
    r.fkgl_after = simplifier.fkgl(s.text);
    r.wps_before = wordsPerSentence(r.clause_text);
    r.wps_after = wordsPerSentence(s.text);
  }
  const atomsBefore = extractAtoms(rows.map((r) => r.clause_text));
  const atomsAfter = extractAtoms(rows.map((r) => r.simplified));
  for (let i = 0; i < rows.length; i += 32) {
    const batch = rows.slice(i, i + 32);
    const va = await embedding.embedPassages(batch.map((r) => r.clause_text));
    const vb = await embedding.embedPassages(batch.map((r) => r.simplified));
    batch.forEach((r, k) => (r.similarity = embedding.dot(va[k], vb[k])));
  }
  rows.forEach((r, i) => {
    r.atoms_before = atomsBefore[i];
    r.atoms_after = atomsAfter[i];
    r.has_atoms = atomsBefore[i].length > 0;
    r.atoms_same = JSON.stringify(atomsBefore[i]) === JSON.stringify(atomsAfter[i]);
  });

  const summarize = (arr) => {
    const withAtoms = arr.filter((r) => r.has_atoms);
    const fk = arr.filter((r) => r.fkgl_before !== null && r.fkgl_after !== null);
    return {
      n: arr.length,
      fkgl_before: +mean(fk.map((r) => r.fkgl_before)).toFixed(2),
      fkgl_after: +mean(fk.map((r) => r.fkgl_after)).toFixed(2),
      words_per_sentence_before: +mean(arr.map((r) => r.wps_before).filter((x) => x !== null)).toFixed(1),
      words_per_sentence_after: +mean(arr.map((r) => r.wps_after).filter((x) => x !== null)).toFixed(1),
      guard_pass: +mean(arr.map((r) => (r.guard_ok ? 1 : 0))).toFixed(3),
      clauses_with_atoms: withAtoms.length,
      rule_reextraction_agreement: withAtoms.length ? +mean(withAtoms.map((r) => (r.atoms_same ? 1 : 0))).toFixed(3) : null,
      semantic_similarity: +mean(arr.map((r) => r.similarity)).toFixed(3),
      verbatim_sentence_share: +(arr.reduce((a, r) => a + r.verbatim, 0) / Math.max(1, arr.reduce((a, r) => a + r.sentences, 0))).toFixed(3),
    };
  };
  const types = [...new Set(rows.map((r) => r.rule_type))].sort();
  const report = {
    method: USE_LLM ? "llm (guarded), rules fallback" : "rules (guarded)",
    overall: summarize(rows),
    by_rule_type: Object.fromEntries(types.map((t) => [t, summarize(rows.filter((r) => r.rule_type === t))])),
    atom_disagreements: rows.filter((r) => r.has_atoms && !r.atoms_same).slice(0, 15).map((r) => ({ clause_uri: r.clause_uri, before: r.atoms_before, after: r.atoms_after })),
    examples: rows.filter((r) => r.clause_text.length < 420 && r.simplified !== r.clause_text).slice(0, 4).map((r) => ({ clause_uri: r.clause_uri, rule_type: r.rule_type, original: r.clause_text, simplified: r.simplified })),
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "simplification_eval.json"), JSON.stringify(report, null, 1));
  const row = (k, m) =>
    `| ${k} | ${m.n} | ${m.fkgl_before} → ${m.fkgl_after} | ${m.words_per_sentence_before} → ${m.words_per_sentence_after} | ${(m.guard_pass * 100).toFixed(1)}% | ${m.rule_reextraction_agreement === null ? "n/a" : `${(m.rule_reextraction_agreement * 100).toFixed(1)}% (${m.clauses_with_atoms})`} | ${m.semantic_similarity} | ${(m.verbatim_sentence_share * 100).toFixed(1)}% |`;
  const L = [
    "# Plain-language simplification (RQ4)",
    "",
    `Method: ${report.method}. Sample stratified by requirement category (up to ${PER_TYPE} obligation clauses each, seed 7).`,
    "",
    "| Category | n | FKGL | Words / sentence | Guard pass | Rule re-extraction agreement (clauses with atoms) | Semantic similarity | Sentences kept verbatim |",
    "|---|---|---|---|---|---|---|---|",
    row("All", report.overall),
    ...types.map((t) => row(t, report.by_rule_type[t])),
    "",
  ];
  fs.writeFileSync(path.join(OUT, "simplification_eval.md"), L.join("\n"));
  console.log(L.join("\n"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
