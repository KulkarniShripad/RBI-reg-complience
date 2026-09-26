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

app.get("/api/health", (req, res) => res.json({ ok: true, env: env.nodeEnv }));

// Compatibility surface for the original frontend. These handlers read the
// new SQLite/vector corpus; they do not access the retired MongoDB backend.
app.use("/", legacyRoutes);

app.use("/api/documents", documentsRoutes);
app.use("/api/banks", banksRoutes);
app.use("/api/compliance", complianceRoutes);
app.use("/api/query", queryRoutes);
app.use("/api/ingest", ingestRoutes);
app.use("/api/rule-mappings", ruleMappingsRoutes);

app.use((req, res) => res.status(404).json({ error: "Not found" }));
app.use(errorHandler);

app.listen(env.port, () => {
  console.log(`[server] URCC-EF backend listening on :${env.port} (${env.nodeEnv})`);
});

// Scheduled RBI change-check job (check-only, never auto-applies - see
// ingestController.triggerRbiScan for why "apply" stays a manual action).
if (env.nodeEnv !== "test") {
  cron.schedule(env.rbi.updateCron, () => {
    console.log("[cron] running scheduled RBI Master Directions check...");
    const proc = spawn(env.python.bin, [`${env.python.scriptsDir}/rbi_scraper.py`, "--mode", "check"], {
      cwd: env.python.scriptsDir,
    });
    proc.stdout.on("data", (d) => process.stdout.write(`[rbi_scraper] ${d}`));
    proc.stderr.on("data", (d) => process.stderr.write(`[rbi_scraper] ${d}`));
  });
}
