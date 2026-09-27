#!/usr/bin/env node
/**
 * Build / update the vector database (data/urcc_ef_vectors.db) from the
 * semantic_chunks table of the relational database.
 *
 *   node scripts/build_vectors.js            embed only chunks that have no valid vector yet
 *   node scripts/build_vectors.js --rebuild  drop all vectors and embed everything again
 *
 * Every vector is stored with a SHA-1 of the chunk text it came from, so a
 * corpus rebuild never leaves a vector attached to the wrong text (the API
 * ignores such vectors and re-embeds them). Safe to interrupt and re-run:
 * work is committed in batches and a re-run continues where it stopped.
 */
const fs = require("fs");
const env = require("../src/config/env");

async function main() {
  if (process.argv.includes("--rebuild")) {
    for (const f of [env.db.vectorPath, env.db.vectorPath + "-wal", env.db.vectorPath + "-shm"]) {
      if (fs.existsSync(f)) fs.rmSync(f);
    }
    console.log("[build_vectors] removed existing vector DB");
  }
  const db = require("../src/config/db");
  const vectorStore = require("../src/services/vectorStore");
  vectorStore.load();

  const ids = new Set(vectorStore.missingChunkIds());
  const total = db.prepare("SELECT COUNT(*) AS n FROM semantic_chunks").get().n;
  console.log(`[build_vectors] ${total} chunks in corpus, ${ids.size} need embedding (model ${env.embedding.modelId})`);
  if (!ids.size) return;

  const rows = db
    .prepare("SELECT chunk_id, doc_id, chunk_text FROM semantic_chunks ORDER BY chunk_id")
    .all()
    .filter((r) => ids.has(r.chunk_id));

  const t0 = Date.now();
  await vectorStore.upsertChunks(rows, {
    batchSize: 32,
    onProgress: (done, n) => {
      if (done % 512 === 0 || done === n) {
        const secs = (Date.now() - t0) / 1000;
        const rate = done / Math.max(secs, 0.001);
        console.log(`[build_vectors] ${done}/${n}  ${rate.toFixed(1)} chunks/s  eta ${Math.round((n - done) / rate)}s`);
      }
    },
  });
  console.log(`[build_vectors] done in ${Math.round((Date.now() - t0) / 1000)}s -> ${env.db.vectorPath}`);
}

main().catch((err) => {
  console.error("[build_vectors] failed:", err);
  process.exit(1);
});
