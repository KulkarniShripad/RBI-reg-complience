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

if (!fs.existsSync(env.db.relationalPath)) {
  console.warn(
    `[db] WARNING: relational DB not found at ${env.db.relationalPath}. ` +
      `Run "npm run ingest:build-db" first, or copy an existing urcc_ef.db into ./data/`
  );
}

const db = new Database(env.db.relationalPath, {
  fileMustExist: false,
  verbose: env.nodeEnv === "development" ? undefined : undefined,
});
db.pragma("journal_mode = WAL"); // lets reads and the ingestion job coexist without locking readers out
db.pragma("foreign_keys = ON");

module.exports = db;
