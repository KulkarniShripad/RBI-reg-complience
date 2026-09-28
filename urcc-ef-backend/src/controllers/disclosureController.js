const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require("../config/db");
const service = require("../services/disclosure/disclosureService");
const { renderReport } = require("../services/disclosure/reportRenderer");
const { DocumentError } = require("../services/disclosure/documentParser");

// Sample documents for testing (real published figures + test cases), see
// sample-data/README.md at the repository root.
const SAMPLE_DIR = path.resolve(__dirname, "..", "..", "..", process.env.SAMPLE_DATA_DIR || "sample-data");

function sampleManifest() {
  const file = path.join(SAMPLE_DIR, "manifest.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return { samples: [] };
  }
}

function listSamples(req, res) {
  const m = sampleManifest();
  res.json(
    (m.samples || [])
      .filter((s) => fs.existsSync(path.join(SAMPLE_DIR, s.file)))
      .map((s) => ({ ...s, size: fs.statSync(path.join(SAMPLE_DIR, s.file)).size }))
  );
}

const flag = (v, dflt) => (v === undefined || v === null || v === "" ? dflt : !["false", "0", "no", false, 0].includes(v));

async function analyseUpload(req, res) {
  if (!req.file) return res.status(400).json({ error: "Attach the document as multipart field \"file\"." });
  try {
    const result = await service.analyse({
      filePath: req.file.path,
      fileName: req.file.originalname,
      useLlm: flag(req.body?.use_llm, true),
      force: flag(req.body?.force, false),
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  } finally {
    fs.unlink(req.file.path, () => {});
  }
}

async function analyseSample(req, res) {
  const entry = (sampleManifest().samples || []).find((s) => s.file === req.body?.file);
  const full = entry && path.join(SAMPLE_DIR, entry.file);
  if (!entry || !full.startsWith(SAMPLE_DIR) || !fs.existsSync(full)) return res.status(404).json({ error: "sample not found" });
  const result = await service.analyse({ filePath: full, fileName: path.basename(entry.file), useLlm: flag(req.body?.use_llm, true), force: flag(req.body?.force, false) });
  res.status(result.duplicate ? 200 : 201).json(result);
}

function getUpload(req, res) {
  const u = service.getUpload(Number(req.params.uploadId), { withPages: flag(req.query.pages, false) });
  if (!u) return res.status(404).json({ error: "upload not found" });
  res.json(u);
}

function listUploads(req, res) {
  res.json(service.listUploads(Math.min(Number(req.query.limit) || 50, 200)));
}

function updateUpload(req, res) {
  res.json(service.updateUpload(Number(req.params.uploadId), req.body || {}));
}

async function runCheck(req, res) {
  const b = req.body || {};
  const out = await service.run(Number(req.params.uploadId), {
    persist: flag(b.persist, true),
    useLlm: flag(b.use_llm, true),
    includeQualitative: flag(b.include_qualitative, true),
    discover: flag(b.discover_rules, true),
  });
  res.json(out);
}

function uploadFile(req, res) {
  const u = service.storedFile(Number(req.params.uploadId));
  if (!u) return res.status(404).json({ error: "file not available" });
  const types = { pdf: "application/pdf", csv: "text/csv", txt: "text/plain", html: "text/html", json: "application/json", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" };
  res.setHeader("Content-Type", types[u.format] || "application/octet-stream");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(u.file_name)}"`);
  if (u.format === "html") res.setHeader("Content-Security-Policy", "sandbox"); // never run a bank page's scripts
  fs.createReadStream(u.stored_path).pipe(res);
}

function reportHtml(req, res) {
  const run = db.prepare("SELECT summary_json FROM compliance_runs WHERE run_id = ?").get(Number(req.params.runId));
  if (!run) return res.status(404).json({ error: "run not found" });
  const report = JSON.parse(run.summary_json);
  if (report.mode !== "auto") return res.status(400).json({ error: "This run was not an automatic document check." });
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (flag(req.query.download, false)) {
    const name = `compliance-report-${report.bank.bank_id}-${report.period_label}-run${run.run_id || req.params.runId}.html`;
    res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  }
  res.send(renderReport(report));
}

// multer error / parser error → JSON with a helpful status
function handleErrors(err, req, res, next) {
  if (err instanceof DocumentError || err instanceof service.DisclosureError) {
    return res.status(err.status).json({ error: err.message, code: err.code, ...(err.details ? { details: err.details } : {}) });
  }
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File too large (limit 60 MB)." });
  return next(err);
}

const uploadDir = path.join(os.tmpdir(), "urcc-disclosures");
fs.mkdirSync(uploadDir, { recursive: true });

module.exports = { listSamples, analyseUpload, analyseSample, getUpload, listUploads, updateUpload, runCheck, uploadFile, reportHtml, handleErrors, uploadDir };
