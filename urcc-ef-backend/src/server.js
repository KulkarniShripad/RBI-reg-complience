require("express-async-errors"); // lets async controller errors reach errorHandler without try/catch everywhere
const express = require("express");
const cors = require("cors");
const cron = require("node-cron");
const { spawn } = require("child_process");

const env = require("./config/env");
const errorHandler = require("./middleware/errorHandler");

const documentsRoutes = require("./routes/documents.routes");
const banksRoutes = require("./routes/banks.routes");
const complianceRoutes = require("./routes/compliance.routes");
const queryRoutes = require("./routes/query.routes");
const ingestRoutes = require("./routes/ingest.routes");
const ruleMappingsRoutes = require("./routes/ruleMappings.routes");
const legacyRoutes = require("./routes/legacy.routes");
const graphRoutes = require("./routes/graph.routes");

const db = require("./config/db");
const vectorStore = require("./services/vectorStore");
const geminiService = require("./services/geminiService");
const queryAnalyzer = require("./services/queryAnalyzer");

const app = express();
const allowedOrigins = new Set([
  ...env.corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean),
  "http://localhost:5173",
  "http://localhost:8080",
]);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.has(origin)) return callback(null, true);
    return callback(new Error(`CORS origin not allowed: ${origin}`));
  },
}));
app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => {
  const vs = vectorStore.status();
  let corpus = {};
  try {
    corpus = Object.fromEntries(db.prepare("SELECT key, value FROM corpus_meta").all().map((r) => [r.key, r.value]));
  } catch (_) {
    corpus = { error: "corpus tables missing - run npm run build:corpus" };
  }
  res.json({
    ok: true,
    env: env.nodeEnv,
    corpus,
    vectors: vs,
    llm: { configured: geminiService.isConfigured(), model: env.gemini.model, fallbacks: env.gemini.fallbackModels },
  });
});

// Compatibility surface for the original frontend. These handlers read the
// new SQLite/vector corpus; they do not access the retired MongoDB backend.
app.use("/", legacyRoutes);

app.use("/api/documents", documentsRoutes);
app.use("/api/banks", banksRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/query", queryRoutes);
app.use("/api/ingest", ingestRoutes);
app.use("/api/rule-mappings", ruleMappingsRoutes);
app.use("/api/graph", graphRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

function warmUp() {
  try {
    queryAnalyzer.init();
    const st = vectorStore.load();
    if (st.missing_chunks && env.embedding.embedMissingOnStart) {
      // Chunks without a (valid) vector are embedded in the background; until
      // then those chunks are still found by keyword search.
      vectorStore.startBackfill();
    } else if (st.missing_chunks) {
      console.warn(`[vectors] ${st.missing_chunks} chunks have no embedding - run npm run build:vectors`);
    }
  } catch (err) {
    console.error("[startup] could not load the corpus / vector index:", err.message);
  }
}

if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`[server] URCC-EF backend listening on :${env.port} (${env.nodeEnv})`);
    warmUp();
  });
}

module.exports = { app, warmUp };

// Scheduled RBI change-check job (check-only, never auto-applies - see
// ingestController.triggerRbiScan for why "apply" stays a manual action).
if (env.nodeEnv !== "test" && require.main === module) {
  cron.schedule(env.rbi.updateCron, () => {
    console.log("[cron] running scheduled RBI Master Directions check...");
    const proc = spawn(env.python.bin, [`${env.python.scriptsDir}/rbi_scraper.py`, "--mode", "check"], {
      cwd: env.python.scriptsDir,
    });
    proc.stdout.on("data", (d) => process.stdout.write(`[rbi_scraper] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[rbi_scraper] ${d}`));
  });
}
