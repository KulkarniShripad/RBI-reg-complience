/**
 * query_demo.py rebuilt the FTS5 index in memory on every single script
 * run - fine for a CLI demo, wrong for an API server serving many
 * requests. This builds it ONCE into urcc_ef.db itself (FTS5 virtual
 * tables persist fine in a SQLite file) so queryController.hybridQuery can
 * just query it directly. Re-run this after any re-ingestion
 * (npm run ingest:build-db) to pick up new/changed chunks.
 *
 * Run with: node migrations/002_build_fts_index.js
 */
const Database = require("better-sqlite3");
const env = require("../src/config/env");

const db = new Database(env.db.relationalPath);
db.pragma("journal_mode = WAL");

console.log("[fts] dropping old index (if any)...");
db.exec("DROP TABLE IF EXISTS chunks_fts");
db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(clause_uri, chunk_text)");

const rows = db.prepare("SELECT clause_uri, chunk_text FROM semantic_chunks").all();
console.log(`[fts] indexing ${rows.length} chunks...`);

const insert = db.prepare("INSERT INTO chunks_fts (clause_uri, chunk_text) VALUES (?, ?)");
const txn = db.transaction((rows) => {
  for (const r of rows) insert.run(r.clause_uri, r.chunk_text);
});
txn(rows);

console.log("[fts] done.");
db.close();
