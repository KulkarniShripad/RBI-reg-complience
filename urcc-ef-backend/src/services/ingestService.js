/**
 * Uploading a circular into the live knowledge base.
 *
 * Guarantees:
 *   - Only real PDFs are accepted (extension AND "%PDF-" magic bytes).
 *   - Exact duplicates are rejected before anything is written: the SHA-256
 *     of the file is compared with every ingested document (the document id
 *     itself is derived from that hash), and with uploads still in progress.
 *   - A different file carrying the same RBI reference (e.g. an "Updated as
 *     on ..." re-issue) is reported as a possible new version; it replaces
 *     the old one only when the caller confirms with replace=true.
 *   - An existing file is never overwritten because two circulars share a
 *     file name ("4.PDF").
 *   - Only the new document is parsed, indexed and embedded; the rest of the
 *     corpus is untouched. Uploads are processed one at a time.
 *   - Any failure removes the stored file again, so a failed upload leaves no
 *     half-ingested state behind.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const env = require("../config/env");
const db = require("../config/db");
const vectorStore = require("./vectorStore");
const categoryService = require("./categoryService");
const qa = require("./queryAnalyzer");

let queue = Promise.resolve();
const inFlight = new Set();

class UploadError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

function isPdf(file) {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(1024);
  const n = fs.readSync(fd, buf, 0, 1024, 0);
  fs.closeSync(fd);
  return buf.subarray(0, n).includes(Buffer.from("%PDF-"));
}

function findDuplicate(sha) {
  return db
    .prepare("SELECT doc_id, title, rbi_ref, file_path, institution_category, ingested_at FROM documents WHERE pdf_sha256 = ?")
    .get(sha);
}

/** Existing folder for a category (the corpus uses legacy names like "small financial banks"). */
function folderFor(categoryId) {
  if (!categoryId) return "uploads";
  if (fs.existsSync(env.circularsRoot)) {
    for (const name of fs.readdirSync(env.circularsRoot)) {
      const full = path.join(env.circularsRoot, name);
      if (fs.statSync(full).isDirectory() && categoryService.normalise(name) === categoryId) return name;
    }
  }
  return categoryId;
}

function safeName(original, sha) {
  const base = path.basename(original).replace(/\.pdf$/i, "").replace(/[^\w.\- ()]+/g, "_").slice(0, 120) || "circular";
  return { base, withHash: `${base}_${sha.slice(0, 8)}.pdf`, plain: `${base}.pdf` };
}

function runIngest(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.python.bin, [path.join(env.python.scriptsDir, "db_builder.py"), "ingest", ...args], {
      cwd: env.python.scriptsDir,
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", reject);
    proc.on("close", () => {
      const line = out.trim().split("\n").pop();
      try {
        resolve(JSON.parse(line));
      } catch (_) {
        reject(new Error(`ingest produced no result: ${(err || out).slice(-800)}`));
      }
    });
  });
}

function bankRefsToRules(ruleIds) {
  if (!ruleIds || !ruleIds.length) return [];
  try {
    return db
      .prepare(
        `SELECT DISTINCT bank_id, rule_id FROM bank_quant_submissions WHERE rule_id IN (${ruleIds.map(() => "?").join(",")})`
      )
      .all(...ruleIds);
  } catch (_) {
    return [];
  }
}

async function processUpload({ tempPath, originalName, category, title, replace }) {
  if (path.extname(originalName || "").toLowerCase() !== ".pdf" || !isPdf(tempPath)) {
    throw new UploadError(400, "not_pdf", "Only PDF files are accepted (the file does not look like a PDF).");
  }
  const sha = await sha256File(tempPath);
  const dup = findDuplicate(sha);
  if (dup) {
    throw new UploadError(409, "duplicate", `This exact file is already in the knowledge base: "${dup.title || dup.file_path}".`, {
      existing: dup,
    });
  }
  if (inFlight.has(sha)) {
    throw new UploadError(409, "duplicate_in_progress", "This file is already being processed.");
  }

  let categoryId = null;
  if (category && !["auto", "general", ""].includes(String(category).toLowerCase())) {
    categoryId = categoryService.normalise(category);
    if (!categoryId) {
      throw new UploadError(400, "unknown_category", `Unknown institution category "${category}".`, {
        valid_categories: categoryService.all().map((c) => ({ id: c.id, label: c.label })),
      });
    }
  }

  inFlight.add(sha);
  const folder = path.join(env.circularsRoot, folderFor(categoryId));
  fs.mkdirSync(folder, { recursive: true });
  const names = safeName(originalName, sha);
  let target = path.join(folder, names.plain);
  if (fs.existsSync(target)) target = path.join(folder, names.withHash); // never overwrite a different circular
  fs.copyFileSync(tempPath, target);

  try {
    const args = [target, "--db", env.db.relationalPath, "--circulars-root", env.circularsRoot];
    if (categoryId) args.push("--category", categoryId);
    if (replace) args.push("--replace");
    const result = await runIngest(args);

    if (result.status === "duplicate") {
      throw new UploadError(409, "duplicate", `This exact file is already in the knowledge base: "${result.title}".`, {
        existing: result,
      });
    }
    if (result.status === "possible_update") {
      throw new UploadError(
        409,
        "possible_update",
        `A different version of ${result.rbi_ref} is already in the knowledge base. Upload again with "replace" to swap it for this file.`,
        { existing: result.existing, incoming: { title: result.title, rbi_ref: result.rbi_ref, last_updated_label: result.last_updated_label } }
      );
    }
    if (result.status === "rejected") throw new UploadError(422, result.reason, result.detail);
    if (result.status === "error" || !["added", "replaced"].includes(result.status)) {
      throw new UploadError(500, "ingest_failed", result.detail || "The document could not be processed.");
    }

    // Replaced documents: drop their old vectors; report bank data that pointed at old rules.
    const orphaned = [];
    for (const info of Object.values(result.replaced || {})) {
      vectorStore.removeChunks(info.removed_chunk_ids);
      orphaned.push(...bankRefsToRules(info.removed_rule_ids));
    }
    if (title) db.prepare("UPDATE documents SET title = ? WHERE doc_id = ? AND (title IS NULL OR title = '')").run(title, result.doc_id);

    // Embed only the new document's chunks.
    const rows = db.prepare("SELECT chunk_id, doc_id, chunk_text FROM semantic_chunks WHERE doc_id = ?").all(result.doc_id);
    let embedded = 0;
    let embedError = null;
    try {
      embedded = await vectorStore.upsertChunks(rows);
    } catch (e) {
      embedError = e.message; // keyword search still works; the server re-tries missing vectors on start
    }
    qa.reset();
    categoryService.reset();

    const counts = result.counts || {};
    return {
      success: true,
      status: result.status,
      circular_id: result.doc_id,
      doc_id: result.doc_id,
      title: result.title,
      rbi_ref: result.rbi_ref,
      topic: result.topic,
      institution_category: result.institution_category,
      categories: (result.categories || []).map((c) => ({ id: c, label: categoryService.label(c) })),
      clauses: counts.clauses || 0,
      rules_extracted: counts.atoms_requirement || 0,
      conditions_extracted: counts.atoms_condition || 0,
      definitions: counts.definitions || 0,
      chunks_embedded: embedded,
      file_path: path.relative(env.circularsRoot, target),
      warnings: [
        ...(embedError ? [`Embedding failed (${embedError}); keyword search works and embedding will be retried on restart.`] : []),
        ...(orphaned.length
          ? [`${orphaned.length} bank submission(s) referenced rules from the replaced version; re-enter them against the new rules.`]
          : []),
      ],
      note: result.status === "replaced" ? "Replaced the earlier version of this circular." : "Circular added and indexed.",
    };
  } catch (err) {
    fs.rmSync(target, { force: true });
    throw err;
  } finally {
    inFlight.delete(sha);
  }
}

/** Serialise uploads: parsing + DB writes + embedding happen one at a time. */
function enqueueUpload(args) {
  const job = queue.then(() => processUpload(args));
  queue = job.catch(() => {});
  return job.finally(() => fs.rmSync(args.tempPath, { force: true }));
}

module.exports = { enqueueUpload, UploadError, sha256File, findDuplicate };
