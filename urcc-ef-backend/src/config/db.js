/**
 * Single shared connection to urcc_ef.db (the relational store built by
 * scripts/db_builder.py). better-sqlite3 is synchronous by design - this is
 * the right call for SQLite specifically (it's not a network DB, so async
 * driver overhead buys nothing, and sync code here is much easier to reason
 * about for a compliance-critical read path).
 *
 * NOTE on the Postgres migration path mentioned in the handoff doc: when you
 * swap to Postgres, this file is the ONLY place that changes shape (swap for
 * a `pg` Pool + async query wrapper). Every controller below calls through
 * db.js, never sqlite3 directly, so the blast radius of that swap is exactly
 * this one file plus turning the call sites `await`-aware.
 */
const Database = require("better-sqlite3");
const fs = require("fs");
const env = require("./env");

const HOW_TO_BUILD = 'Build it with "npm run build:corpus" (about 1 minute), then "npm run build:vectors".';

if (!fs.existsSync(env.db.relationalPath)) {
  console.warn(`[db] WARNING: relational DB not found at ${env.db.relationalPath}. ${HOW_TO_BUILD}`);
} else {
  // A Git LFS pointer (a ~130-byte text file) is what you get when the repo is
  // cloned without git-lfs; SQLite would only report "malformed".
  const head = Buffer.alloc(64);
  const fd = fs.openSync(env.db.relationalPath, "r");
  fs.readSync(fd, head, 0, 64, 0);
  fs.closeSync(fd);
  if (head.toString("utf8").startsWith("version https://git-lfs")) {
    throw new Error(
      `[db] ${env.db.relationalPath} is a Git LFS pointer, not a database (the repo was cloned without git-lfs). ${HOW_TO_BUILD}`
    );
  }
}

const db = new Database(env.db.relationalPath, {
  fileMustExist: false,
  verbose: env.nodeEnv === "development" ? undefined : undefined,
});
db.pragma("journal_mode = WAL"); // lets reads and the ingestion job coexist without locking readers out
db.pragma("foreign_keys = ON");

// The API needs a corpus built by the current extraction pipeline (v2+:
// canonical categories, clause roles, chunks_fts, ...). A database from the
// old pipeline would only fail later with confusing SQL errors.
function extractionVersion() {
  try {
    return db.prepare("SELECT value FROM corpus_meta WHERE key = 'extraction_version'").get()?.value ?? null;
  } catch (_) {
    return null;
  }
}
const version = extractionVersion();
if (!version || parseFloat(version) < 2) {
  const msg =
    `[db] ${env.db.relationalPath} was not built by the current extraction pipeline ` +
    `(extraction_version=${version ?? "none"}). ${HOW_TO_BUILD} ` +
    "Rebuilding keeps your banks, submissions, evidence and run history (they are carried over).";
  if (process.env.NODE_ENV === "test") console.warn(msg);
  else throw new Error(msg);
}

// Operational tables (banks, submissions, runs, uploaded disclosures) are
// additive CREATE ... IF NOT EXISTS migrations, so applying them on every
// start is safe and means a freshly built corpus works without "npm run migrate".
function applyMigrations() {
  const dir = require("path").join(__dirname, "..", "..", "migrations");
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'clause_registry'").get()) return;
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) {
      db.exec(fs.readFileSync(require("path").join(dir, f), "utf8"));
    }
  } catch (err) {
    console.warn(`[db] could not apply migrations: ${err.message}`);
  }
}
applyMigrations();

module.exports = db;
