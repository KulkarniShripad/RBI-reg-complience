/**
 * The vector database: one 384-dim embedding per semantic chunk, persisted
 * in its own SQLite file (data/urcc_ef_vectors.db) and held in memory as a
 * single Float32Array for exact (brute-force) cosine search.
 *
 * Why exact search: ~40k chunks x 384 dims is ~60 MB and a full scan takes
 * ~15 ms in Node, so an approximate index would add complexity and recall
 * loss for no user-visible gain at this corpus size. The storage format
 * (chunk_id -> float32 blob) maps directly onto pgvector if the project
 * moves to PostgreSQL.
 *
 * Integrity: every stored vector carries a SHA-1 of the exact chunk text it
 * was computed from. On load, vectors whose chunk no longer exists or whose
 * text changed (e.g. after a corpus rebuild) are ignored, and the missing
 * chunks are reported (and optionally embedded in the background), so the
 * index can never silently return a vector for the wrong text.
 */
const crypto = require("crypto");
const fs = require("fs");
const Database = require("better-sqlite3");
const env = require("../config/env");
const db = require("../config/db");
const embedding = require("./embeddingService");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chunk_embeddings (
  chunk_id   INTEGER PRIMARY KEY,
  doc_id     TEXT NOT NULL,
  text_sha1  TEXT NOT NULL,
  embedding  BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emb_doc ON chunk_embeddings(doc_id);
`;

const state = {
  ready: false,
  loading: null,
  ids: new Int32Array(0),
  docIds: [],
  matrix: new Float32Array(0),
  dim: embedding.DIM,
  missing: [],
  backfill: null,
  error: null,
};

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function openVectorDb() {
  const vdb = new Database(env.db.vectorPath);
  vdb.pragma("journal_mode = WAL");
  // A vector DB from the old TF-IDF pipeline has a different layout; start a
  // fresh one rather than misreading it.
  const tables = vdb.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all().map((r) => r.name);
  if (tables.includes("chunk_vectors") && !tables.includes("chunk_embeddings")) {
    vdb.close();
    fs.renameSync(env.db.vectorPath, env.db.vectorPath + ".tfidf-legacy");
    return openVectorDb();
  }
  vdb.exec(SCHEMA);
  return vdb;
}

function metaGet(vdb, key) {
  return vdb.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

function load() {
  const vdb = openVectorDb();
  const model = metaGet(vdb, "model_id");
  if (model && model !== env.embedding.modelId) {
    state.error = `vector DB was built with ${model}, but EMBEDDING_MODEL_ID is ${env.embedding.modelId}; run npm run build:vectors`;
    console.warn(`[vectors] ${state.error}`);
  }
  const chunks = db.prepare("SELECT chunk_id, doc_id, chunk_text FROM semantic_chunks").all();
  const current = new Map(chunks.map((c) => [c.chunk_id, c]));
  const rows = vdb.prepare("SELECT chunk_id, doc_id, text_sha1, embedding FROM chunk_embeddings").all();
  vdb.close();

  const valid = [];
  for (const r of rows) {
    const c = current.get(r.chunk_id);
    if (c && sha1(c.chunk_text) === r.text_sha1 && r.embedding.length === state.dim * 4) valid.push(r);
  }
  const have = new Set(valid.map((r) => r.chunk_id));
  state.missing = chunks.filter((c) => !have.has(c.chunk_id)).map((c) => c.chunk_id);

  state.ids = new Int32Array(valid.length);
  state.docIds = new Array(valid.length);
  state.matrix = new Float32Array(valid.length * state.dim);
  valid.forEach((r, i) => {
    state.ids[i] = r.chunk_id;
    state.docIds[i] = r.doc_id;
    state.matrix.set(new Float32Array(r.embedding.buffer, r.embedding.byteOffset, state.dim), i * state.dim);
  });
  state.ready = valid.length > 0 && !state.error;
  console.log(
    `[vectors] loaded ${valid.length} embeddings (${state.missing.length} chunks not embedded` +
      `${rows.length - valid.length ? `, ${rows.length - valid.length} stale vectors ignored` : ""})`
  );
  return status();
}

/** Write vectors for the given chunk rows ({chunk_id, doc_id, chunk_text}) and add them to memory. */
async function upsertChunks(chunkRows, { batchSize = 32, onProgress } = {}) {
  if (!chunkRows.length) return 0;
  const vdb = openVectorDb();
  const insert = vdb.prepare(
    "INSERT OR REPLACE INTO chunk_embeddings (chunk_id, doc_id, text_sha1, embedding) VALUES (?, ?, ?, ?)"
  );
  let done = 0;
  const added = [];
  // Batch chunks of similar length together: a batch is padded to its
  // longest member, so mixing a 40-token and a 500-token chunk wastes most
  // of the compute.
  const ordered = [...chunkRows].sort((a, b) => a.chunk_text.length - b.chunk_text.length);
  for (let i = 0; i < ordered.length; i += batchSize) {
    const batch = ordered.slice(i, i + batchSize);
    const vecs = await embedding.embedPassages(batch.map((c) => c.chunk_text), batchSize);
    const txn = vdb.transaction(() => {
      batch.forEach((c, j) => {
        insert.run(c.chunk_id, c.doc_id, sha1(c.chunk_text), Buffer.from(vecs[j].buffer));
        added.push([c.chunk_id, c.doc_id, vecs[j]]);
      });
    });
    txn();
    done += batch.length;
    if (onProgress) onProgress(done, chunkRows.length);
  }
  for (const [k, v] of Object.entries({
    model_id: env.embedding.modelId,
    dim: String(state.dim),
    pooling: "cls",
    normalized: "true",
    updated_at: new Date().toISOString(),
  })) {
    vdb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(k, v);
  }
  vdb.close();
  addToMemory(added);
  return done;
}

function addToMemory(entries) {
  if (!entries.length) return;
  const replace = new Set(entries.map((e) => e[0]));
  const keep = [];
  for (let i = 0; i < state.ids.length; i++) if (!replace.has(state.ids[i])) keep.push(i);
  const n = keep.length + entries.length;
  const ids = new Int32Array(n);
  const docIds = new Array(n);
  const matrix = new Float32Array(n * state.dim);
  keep.forEach((src, dst) => {
    ids[dst] = state.ids[src];
    docIds[dst] = state.docIds[src];
    matrix.set(state.matrix.subarray(src * state.dim, (src + 1) * state.dim), dst * state.dim);
  });
  entries.forEach(([id, docId, vec], k) => {
    const dst = keep.length + k;
    ids[dst] = id;
    docIds[dst] = docId;
    matrix.set(vec, dst * state.dim);
  });
  Object.assign(state, { ids, docIds, matrix, ready: n > 0 && !state.error });
  const added = new Set(entries.map((e) => e[0]));
  state.missing = state.missing.filter((id) => !added.has(id));
}

function removeChunks(chunkIds) {
  if (!chunkIds || !chunkIds.length) return;
  const vdb = openVectorDb();
  const del = vdb.prepare("DELETE FROM chunk_embeddings WHERE chunk_id = ?");
  vdb.transaction(() => chunkIds.forEach((id) => del.run(id)))();
  vdb.close();
  const drop = new Set(chunkIds);
  const keep = [];
  for (let i = 0; i < state.ids.length; i++) if (!drop.has(state.ids[i])) keep.push(i);
  const ids = new Int32Array(keep.length);
  const docIds = new Array(keep.length);
  const matrix = new Float32Array(keep.length * state.dim);
  keep.forEach((src, dst) => {
    ids[dst] = state.ids[src];
    docIds[dst] = state.docIds[src];
    matrix.set(state.matrix.subarray(src * state.dim, (src + 1) * state.dim), dst * state.dim);
  });
  Object.assign(state, { ids, docIds, matrix });
  state.missing = state.missing.filter((id) => !drop.has(id));
}

/**
 * Exact top-k by cosine similarity (vectors are L2-normalised, so dot product).
 * @param {Float32Array} q
 * @param {number} k
 * @param {Set<string>|null} docFilter restrict to these doc_ids
 * @returns {{chunk_id:number, doc_id:string, score:number}[]}
 */
function search(q, k = 20, docFilter = null) {
  const n = state.ids.length;
  const dim = state.dim;
  const top = []; // small sorted array, ascending by score
  for (let i = 0; i < n; i++) {
    if (docFilter && !docFilter.has(state.docIds[i])) continue;
    let s = 0;
    const off = i * dim;
    for (let j = 0; j < dim; j++) s += state.matrix[off + j] * q[j];
    if (top.length < k) {
      top.push([s, i]);
      top.sort((a, b) => a[0] - b[0]);
    } else if (s > top[0][0]) {
      top[0] = [s, i];
      top.sort((a, b) => a[0] - b[0]);
    }
  }
  return top
    .sort((a, b) => b[0] - a[0])
    .map(([score, i]) => ({ chunk_id: state.ids[i], doc_id: state.docIds[i], score }));
}

/** Embed chunks that have no (valid) vector yet, in the background. */
function startBackfill() {
  if (state.backfill || !state.missing.length) return state.backfill;
  const ids = [...state.missing];
  const rows = [];
  const stmt = db.prepare("SELECT chunk_id, doc_id, chunk_text FROM semantic_chunks WHERE chunk_id = ?");
  for (const id of ids) {
    const r = stmt.get(id);
    if (r) rows.push(r);
  }
  const started = Date.now();
  console.log(`[vectors] embedding ${rows.length} missing chunks in the background ...`);
  state.backfill = upsertChunks(rows, {
    onProgress: (done, total) => {
      if (done % 1024 === 0 || done === total) {
        console.log(`[vectors] backfill ${done}/${total} (${Math.round((Date.now() - started) / 1000)}s)`);
      }
    },
  })
    .then((n) => {
      state.error = null;
      state.ready = state.ids.length > 0;
      console.log(`[vectors] backfill complete: ${n} chunks embedded`);
    })
    .catch((err) => {
      state.error = `embedding backfill failed: ${err.message}`;
      console.error(`[vectors] ${state.error}`);
    })
    .finally(() => {
      state.backfill = null;
    });
  return state.backfill;
}

function status() {
  return {
    ready: state.ready,
    vectors: state.ids.length,
    missing_chunks: state.missing.length,
    backfill_running: !!state.backfill,
    error: state.error,
    embedding: embedding.status(),
  };
}

function missingChunkIds() {
  return [...state.missing];
}

module.exports = { load, search, upsertChunks, removeChunks, startBackfill, status, missingChunkIds, sha1 };
