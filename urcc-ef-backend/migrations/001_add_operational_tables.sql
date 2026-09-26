-- Additive only. Nothing here alters or drops a table from db_builder.py's
-- SCHEMA. Run once against urcc_ef.db via `npm run migrate`.

-- ---------------------------------------------------------------------
-- Banks + manual data entry (the "how do I input bank data" answer)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS banks (
    bank_id               TEXT PRIMARY KEY,        -- e.g. 'RRB-DEMO-001', or a real bank code later
    bank_name             TEXT NOT NULL,
    institution_category  TEXT NOT NULL,            -- must match documents.institution_category values
    created_at            TEXT DEFAULT (datetime('now'))
);

-- One row per (bank, rule_atom, reporting period). This is the manual-entry
-- table your dashboard writes to. In production this is what the "bridge
-- table" from CIMS/XBRL would populate automatically instead.
CREATE TABLE IF NOT EXISTS bank_quant_submissions (
    submission_id  INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id        TEXT NOT NULL REFERENCES banks(bank_id),
    rule_id        INTEGER NOT NULL REFERENCES rule_atoms(rule_id),
    reported_value REAL NOT NULL,
    period_label   TEXT NOT NULL,                   -- e.g. 'Q1-FY2026-27'
    source_note    TEXT,                             -- e.g. 'manual entry', 'CIMS field XYZ' later
    submitted_at   TEXT DEFAULT (datetime('now')),
    UNIQUE(bank_id, rule_id, period_label)
);

-- Free-text governance evidence (board minutes, policy manuals, audit
-- notes) - what Subsystem 2 retrieves against.
CREATE TABLE IF NOT EXISTS bank_qual_evidence (
    evidence_id   INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id       TEXT NOT NULL REFERENCES banks(bank_id),
    evidence_text TEXT NOT NULL,
    source_type   TEXT,                              -- 'board_minutes' | 'policy_manual' | 'audit_note' | ...
    period_label  TEXT,
    submitted_at  TEXT DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Compliance run history (so the dashboard can show trends, not just
-- "the latest check")
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS compliance_runs (
    run_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id        TEXT NOT NULL REFERENCES banks(bank_id),
    period_label   TEXT NOT NULL,
    run_at         TEXT DEFAULT (datetime('now')),
    summary_json   TEXT NOT NULL,                    -- generate_compliance_report() output, frozen at run time
    quant_checked  INTEGER,
    quant_breach   INTEGER,
    qual_checked   INTEGER,
    qual_gap       INTEGER
);

CREATE TABLE IF NOT EXISTS compliance_run_details (
    detail_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES compliance_runs(run_id),
    clause_uri    TEXT NOT NULL,
    check_type    TEXT NOT NULL CHECK (check_type IN ('quantitative','qualitative')),
    status        TEXT NOT NULL,
    detail_json   TEXT NOT NULL                      -- the full QuantResult/QualResult row, frozen
);
CREATE INDEX IF NOT EXISTS idx_run_details_run ON compliance_run_details(run_id);

-- ---------------------------------------------------------------------
-- Document version tracking, for the RBI-update-detection feature.
-- Additive columns on `documents` (SQLite allows ADD COLUMN; guarded
-- because re-running this file must be a no-op the second time).
-- ---------------------------------------------------------------------
-- (Run migrations/run_migrations.js, which checks column existence before
--  issuing ALTER TABLE - SQLite has no "ADD COLUMN IF NOT EXISTS".)

CREATE TABLE IF NOT EXISTS document_versions (
    version_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id           TEXT NOT NULL REFERENCES documents(doc_id),
    source_url       TEXT NOT NULL,
    updated_as_on    TEXT,                            -- raw string scraped from RBI's title, e.g. 'July 01, 2026'
    pdf_hash         TEXT,                             -- sha256 of the downloaded PDF bytes
    detected_at      TEXT DEFAULT (datetime('now')),
    reingested       INTEGER DEFAULT 0                 -- 0 until db_builder.py has processed this version
);
CREATE INDEX IF NOT EXISTS idx_docver_doc ON document_versions(doc_id);

CREATE TABLE IF NOT EXISTS rbi_watch_list (
    watch_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    rbi_doc_id     TEXT UNIQUE NOT NULL,               -- the `id=` query param from BS_ViewMasDirections.aspx
    department     TEXT,
    institution_category TEXT,
    title          TEXT,
    pdf_url        TEXT,
    last_updated_label TEXT,                           -- last-seen "(Updated as on ...)" string
    last_checked_at TEXT DEFAULT (datetime('now'))
);
