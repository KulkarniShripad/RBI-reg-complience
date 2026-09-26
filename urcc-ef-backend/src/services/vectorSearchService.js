/**
 * The vector store (chunker.py / vector_db_builder.py) uses scikit-learn's
 * TfidfVectorizer + TruncatedSVD, fit once and pickled. Reimplementing that
 * in JS would mean either shipping a second, drifting copy of the model
 * logic, or losing fidelity - neither is worth it for what is explicitly a
 * placeholder embedding (see the handoff doc §6, item 4). So Node shells
 * out to a small Python worker script that loads the same pickle and
 * returns JSON. When a real embedding model (Ollama/nomic-embed-text or a
 * Gemini embedding endpoint) replaces TF-IDF, this file's contract
 * (query -> ranked [{clause_uri, distance, ...}]) does not need to change,
 * only vector_search_worker.py's internals do.
 */
const { spawn } = require("child_process");
const path = require("path");
const env = require("../config/env");

function runPython(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.python.bin, args, { cwd: env.python.scriptsDir });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`python exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`python worker returned non-JSON: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

/**
 * @param {string} query
 * @param {number} topK
 * @param {string|null} institutionCategory
 */
async function search(query, topK = 5, institutionCategory = null) {
  const args = [
    path.join(env.python.scriptsDir, "vector_search_worker.py"),
    "--query",
    query,
    "--top_k",
    String(topK),
  ];
  if (institutionCategory) args.push("--institution_category", institutionCategory);
  return runPython(args);
}

/**
 * Rank a small list of candidate texts (e.g. a bank's submitted evidence
 * excerpts) by similarity to a query text (e.g. a regulatory clause),
 * using the same TF-IDF/SVD model as the main vector DB, without needing
 * those candidates to be pre-indexed in urcc_ef_vectors.db. Used by
 * qualComplianceService for clause -> best-evidence matching.
 *
 * @param {string} queryText
 * @param {string[]} candidateTexts
 * @returns {Promise<{index:number, score:number}[]>} sorted descending by score
 */
async function rankTexts(queryText, candidateTexts) {
  if (!candidateTexts.length) return [];
  const args = [path.join(env.python.scriptsDir, "vector_rank_worker.py"), "--query", queryText];
  return new Promise((resolve, reject) => {
    const proc = spawn(env.python.bin, args, { cwd: env.python.scriptsDir });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    proc.stdin.write(JSON.stringify({ candidates: candidateTexts }));
    proc.stdin.end();
    proc.on("close", (code) => {
      if (code !== 0) return reject(new Error(`python exited ${code}: ${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (e) {
        reject(new Error(`python rank worker returned non-JSON: ${stdout.slice(0, 300)}`));
      }
    });
  });
}

module.exports = { search, rankTexts };
