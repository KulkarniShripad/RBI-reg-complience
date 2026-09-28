/**
 * Runs every document in sample-data/manifest.json through the automatic
 * compliance check and compares the result with the expectations stored in
 * the manifest (figures read, detected profile, rule verdicts, disclosures).
 *
 *   npm run eval:disclosures            deterministic only (no LLM)
 *   npm run eval:disclosures -- --llm   also use the LLM where configured
 *
 * Works on a temporary copy of the database, so banks, uploads and runs
 * created here do not appear in the app.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const useLlm = process.argv.includes("--llm");
const verbose = process.argv.includes("--verbose");

const env = require("../src/config/env");
const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "urcc-eval-")), "urcc_ef.db");
fs.copyFileSync(env.db.relationalPath, tmp);
process.env.RELATIONAL_DB_PATH = tmp;
env.db.relationalPath = tmp;

const service = require("../src/services/disclosure/disclosureService");

const SAMPLES = path.resolve(__dirname, "..", "..", "sample-data");

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, "manifest.json"), "utf8"));
  let ok = 0;
  let total = 0;
  const failures = [];
  const expect = (file, what, actual, expected) => {
    total++;
    const pass = typeof expected === "number" ? Math.abs(Number(actual) - expected) < 1e-6 : actual === expected;
    if (pass) ok++;
    else failures.push(`${file}: ${what} = ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    if (verbose) console.log(`  ${pass ? "ok  " : "FAIL"} ${what}: ${JSON.stringify(actual)}`);
  };

  for (const s of manifest.samples) {
    const c = s.checks || {};
    const file = path.join(SAMPLES, s.file);
    if (verbose) console.log(`\n${s.file}`);
    const a = await service.analyse({ filePath: file, fileName: path.basename(file), useLlm, force: true });
    for (const [k, v] of Object.entries(c.figures || {})) expect(s.file, `figure ${k}`, a.metrics[k]?.value ?? null, v);
    for (const [k, v] of Object.entries(c.profile || {})) expect(s.file, `profile ${k}`, a.profile[k] ?? null, v);
    const { report } = await service.run(a.upload_id, { useLlm, includeQualitative: false, persist: false });
    if (c.overall) expect(s.file, "overall", report.overall, c.overall);
    for (const [k, v] of Object.entries(c.rules || {})) {
      expect(s.file, `rule ${k}`, report.rule_results.find((r) => r.rule_key === k)?.status ?? "(not applied)", v);
    }
    const disc = new Map(report.disclosures.items.map((d) => [d.key.replace(/^disclosure_/, ""), d.status]));
    for (const k of c.disclosures_missing || []) expect(s.file, `disclosure ${k}`, disc.get(k) ?? "(not checked)", "LIKELY_MISSING");
    for (const k of c.disclosures_present || []) expect(s.file, `disclosure ${k}`, disc.get(k) ?? "(not checked)", "PRESENT");
  }

  console.log(`\n${ok}/${total} expectations hold across ${manifest.samples.length} sample documents${useLlm ? " (LLM enabled)" : " (deterministic)"}.`);
  if (failures.length) {
    console.log("\nFailures:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(path.dirname(tmp), { recursive: true, force: true }));
