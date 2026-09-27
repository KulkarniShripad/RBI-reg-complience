/**
 * Rebuilds the full-text index (chunks_fts) from semantic_chunks.
 *
 * scripts/db_builder.py already maintains chunks_fts on every build and
 * upload, so this is only needed if the index was dropped or you edited
 * semantic_chunks by hand.
 *
 * Run with: npm run migrate:fts
 */
const Database = require("better-sqlite3");
const env = require("../src/config/env");

const db = new Database(env.db.relationalPath);
db.pragma("journal_mode = WAL");

db.exec("DROP TABLE IF EXISTS chunks_fts");
db.exec(
  "CREATE VIRTUAL TABLE chunks_fts USING fts5(chunk_text, clause_uri UNINDEXED, doc_id UNINDEXED, tokenize = 'porter unicode61')"
);
const rows = db.prepare("SELECT chunk_id, parent_clause_uri, doc_id, chunk_text FROM semantic_chunks").all();
console.log(`[fts] indexing ${rows.length} chunks...`);
const insert = db.prepare("INSERT INTO chunks_fts (rowid, chunk_text, clause_uri, doc_id) VALUES (?, ?, ?, ?)");
db.transaction(() => {
  for (const r of rows) insert.run(r.chunk_id, r.chunk_text, r.parent_clause_uri, r.doc_id);
})();
console.log("[fts] done.");
db.close();
