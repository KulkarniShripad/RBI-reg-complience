const { spawn } = require("child_process");
const db = require("../config/db");
const env = require("../config/env");

function listWatchList(req, res) {
  res.json(db.prepare(`SELECT * FROM rbi_watch_list ORDER BY last_checked_at DESC`).all());
}

function listPendingUpdates(req, res) {
  // Docs where the scraper saw a different "(Updated as on ...)" label than
  // what's currently reflected in `documents.last_updated_label`.
  const rows = db
    .prepare(
      `SELECT w.rbi_doc_id, w.title, w.institution_category, w.pdf_url,
              w.last_updated_label as scraped_label, d.last_updated_label as ingested_label, d.doc_id
       FROM rbi_watch_list w
       LEFT JOIN documents d ON d.source_url = w.pdf_url
       WHERE d.doc_id IS NULL OR IFNULL(d.last_updated_label,'') != IFNULL(w.last_updated_label,'')`
    )
    .all();
  res.json(rows);
}

/**
 * Kicks off scripts/rbi_scraper.py as a child process. Runs the CHECK-ONLY
 * step (populates/refreshes rbi_watch_list by diffing "(Updated as on...)"
 * labels) - it does NOT auto-download+reingest by default, since that
 * should be a reviewed action, not silent. Pass ?apply=true to also
 * download+reparse+rebuild the DB for changed documents.
 */
function triggerRbiScan(req, res) {
  const apply = req.query.apply === "true";
  const args = [`${env.python.scriptsDir}/rbi_scraper.py`, "--mode", apply ? "apply" : "check"];
  const proc = spawn(env.python.bin, args, { cwd: env.python.scriptsDir });

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d) => (stdout += d));
  proc.stderr.on("data", (d) => (stderr += d));
  proc.on("close", (code) => {
    if (code !== 0) {
      return res.status(500).json({ error: "rbi_scraper.py failed", stderr: stderr.slice(-2000) });
    }
    res.json({ ok: true, mode: apply ? "apply" : "check", output_tail: stdout.slice(-2000) });
  });
}

module.exports = { listWatchList, listPendingUpdates, triggerRbiScan };
