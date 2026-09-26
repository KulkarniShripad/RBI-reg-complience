require("dotenv").config();
const path = require("path");

function req(name, fallback) {
  const v = process.env[name] ?? fallback;
  if (v === undefined) {
    throw new Error(`Missing required env var: ${name}. Did you copy .env.example to .env?`);
  }
  return v;
}

module.exports = {
  port: parseInt(process.env.PORT || "4000", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  corsOrigin: process.env.CORS_ORIGIN || "*",

  gemini: {
    apiKey: process.env.GEMINI_API_KEY || "", // validated lazily in geminiService, not at boot,
    model: process.env.GEMINI_MODEL || "gemini-2.0-flash",
    modelHeavy: process.env.GEMINI_MODEL_HEAVY || "gemini-2.5-pro",
  },

  db: {
    relationalPath: path.resolve(process.env.RELATIONAL_DB_PATH || "./data/urcc_ef.db"),
    vectorPath: path.resolve(process.env.VECTOR_DB_PATH || "./data/urcc_ef_vectors.db"),
    vectorModelPath: path.resolve(process.env.VECTOR_MODEL_PATH || "./data/vector_model.pkl"),
  },

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
    pdfStorageDir: path.resolve(process.env.RBI_PDF_STORAGE_DIR || "./scripts/circulars"),
  },
};
