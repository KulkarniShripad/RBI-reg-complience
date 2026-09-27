/**
 * Real semantic embeddings, computed in-process (no Python, no network at
 * query time).
 *
 * Model: BAAI bge-small-en-v1.5 (384-dim, CLS pooling, L2-normalised),
 * run through ONNX Runtime by @huggingface/transformers. It replaces the
 * TF-IDF + TruncatedSVD stand-in, which only matched surface words: a
 * question phrased differently from the circular ("how much capital must
 * an SFB keep") could not find the clause ("minimum total capital of 15 per
 * cent of RWAs"). See README "Retrieval evaluation" for measured numbers.
 *
 * Model files are looked up in EMBEDDING_MODEL_DIR first
 * (<dir>/Xenova/bge-small-en-v1.5/...). If they are not there and
 * EMBEDDING_ALLOW_REMOTE is not "false", they are downloaded once from
 * Hugging Face into that directory's cache and reused afterwards.
 *
 * Passages are embedded as-is; queries get the instruction prefix BGE was
 * trained with for retrieval.
 */
const path = require("path");
const env = require("../config/env");

const QUERY_INSTRUCTION = "Represent this sentence for searching relevant passages: ";

let extractorPromise = null;
let lastError = null;

async function loadExtractor() {
  const tf = await import("@huggingface/transformers");
  tf.env.localModelPath = env.embedding.modelDir.endsWith(path.sep) ? env.embedding.modelDir : env.embedding.modelDir + path.sep;
  tf.env.cacheDir = path.join(env.embedding.modelDir, ".cache");
  tf.env.allowLocalModels = true;
  tf.env.allowRemoteModels = env.embedding.allowRemote;
  return tf.pipeline("feature-extraction", env.embedding.modelId, { dtype: "fp32" });
}

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = loadExtractor().catch((err) => {
      lastError = err;
      extractorPromise = null; // allow a retry on the next call
      throw err;
    });
  }
  return extractorPromise;
}

function toVectors(tensor) {
  const [n, dim] = tensor.dims;
  const data = tensor.data;
  const out = [];
  for (let i = 0; i < n; i++) out.push(Float32Array.from(data.subarray(i * dim, (i + 1) * dim)));
  return out;
}

/** @param {string[]} texts @returns {Promise<Float32Array[]>} */
async function embedPassages(texts, batchSize = 32) {
  const extractor = await getExtractor();
  const out = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const t = await extractor(texts.slice(i, i + batchSize), { pooling: "cls", normalize: true });
    out.push(...toVectors(t));
  }
  return out;
}

/** @param {string} text @returns {Promise<Float32Array>} */
async function embedQuery(text) {
  const extractor = await getExtractor();
  const t = await extractor([QUERY_INSTRUCTION + text], { pooling: "cls", normalize: true });
  return toVectors(t)[0];
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/**
 * Rank candidate texts (e.g. a bank's submitted evidence) against a query
 * text (e.g. a regulatory clause) by cosine similarity. Used by the
 * qualitative compliance check; candidates are not indexed anywhere.
 * @returns {Promise<{index:number, score:number}[]>} best first
 */
async function rankTexts(queryText, candidateTexts, { asQuery = false } = {}) {
  if (!candidateTexts.length) return [];
  const [q] = asQuery ? [await embedQuery(queryText)] : await embedPassages([queryText]);
  const vecs = await embedPassages(candidateTexts);
  return vecs.map((v, index) => ({ index, score: dot(q, v) })).sort((a, b) => b.score - a.score);
}

function status() {
  return {
    model_id: env.embedding.modelId,
    model_dir: env.embedding.modelDir,
    allow_remote: env.embedding.allowRemote,
    loaded: !!extractorPromise && !lastError,
    last_error: lastError ? lastError.message : null,
  };
}

module.exports = { embedPassages, embedQuery, rankTexts, dot, status, QUERY_INSTRUCTION, DIM: 384 };
