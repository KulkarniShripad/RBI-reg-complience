const path = require("path");
// Resolve paths against the backend folder, not the shell's cwd, so
// `node src/server.js` works from anywhere.
const ROOT = path.resolve(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}. Did you copy .env.example to .env?`);
  }
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || "4002", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "", // validated lazily in geminiService, not at boot,
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    // Tried in order when the primary model is unavailable (404 / quota / overload).
    fallbackModels: (process.env.GEMINI_FALLBACK_MODELS || "gemini-2.5-flash,gemini-2.0-flash")
      .split(",").map((m) => m.trim()).filter(Boolean),
    modelHeavy: process.env.GEMINI_MODEL_HEAVY || "gemini-2.5-pro",
    timeoutMs: parseInt(process.env.GEMINI_TIMEOUT_MS || "45000", 10),
  },

  db: {
    relationalPath: path.resolve(ROOT, process.env.RELATIONAL_DB_PATH || "./data/urcc_ef.db"),
    vectorPath: path.resolve(ROOT, process.env.VECTOR_DB_PATH || "./data/urcc_ef_vectors.db"),
  },

  // Semantic embeddings (see src/services/embeddingService.js)
  embedding: {
    modelId: process.env.EMBEDDING_MODEL_ID || "Xenova/bge-small-en-v1.5",
    modelDir: path.resolve(ROOT, process.env.EMBEDDING_MODEL_DIR || "./models"),
    allowRemote: (process.env.EMBEDDING_ALLOW_REMOTE || "true").toLowerCase() !== "false",
    embedMissingOnStart: (process.env.EMBED_MISSING_ON_START || "true").toLowerCase() !== "false",
  },

  // Where the source PDFs live (document viewer + uploads)
  circularsRoot: path.resolve(ROOT, process.env.CIRCULARS_ROOT || "../circulars"),

  python: {
    bin: process.env.PYTHON_BIN || "python3",
    scriptsDir: path.resolve(__dirname, "..", "..", "scripts"),
  },

  rbi: {
    baseUrl: process.env.RBI_BASE_URL || "https://rbi.org.in",
    masterDirectionsUrl:
      process.env.RBI_MASTER_DIRECTIONS_URL ||
      "https://rbi.org.in/scripts/BS_ViewMasterDirections.aspx",
    updateCron: process.env.RBI_UPDATE_CRON || "0 3 * * *",
    pdfStorageDir: path.resolve(ROOT, process.env.RBI_PDF_STORAGE_DIR || "../circulars"),
  },
};
