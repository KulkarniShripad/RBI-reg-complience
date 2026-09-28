-- Automatic compliance check from a bank's own documents (annual reports,
-- Basel III Pillar 3 disclosures, quarterly results, spreadsheets of figures).
-- Additive; safe to apply repeatedly (config/db.js applies it on start).

-- One row per uploaded document. The parsed text is kept so the document can
-- be re-analysed (e.g. after the metric catalogue improves) without the file.
CREATE TABLE IF NOT EXISTS disclosure_uploads (
    upload_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id        TEXT REFERENCES banks(bank_id),      -- null until the bank is confirmed / registered
    file_name      TEXT NOT NULL,
    stored_path    TEXT,                                -- original file, served back for page viewing
    sha256         TEXT NOT NULL,
    format         TEXT NOT NULL,                       -- pdf | xlsx | csv | txt | html | json | md
    page_count     INTEGER,
    doc_type       TEXT,                                -- pillar3 | annual_report | financial_results | ...
    period_label   TEXT,
    as_of_date     TEXT,                                -- ISO date the figures relate to
    detection_json TEXT NOT NULL,                       -- profile detection: bank, category, period, doc type + evidence
    pages_json     TEXT NOT NULL,                       -- [{page, lines[]}]
    status         TEXT NOT NULL DEFAULT 'analysed',    -- analysed | checked
    created_at     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_disclosure_uploads_bank ON disclosure_uploads(bank_id);
CREATE INDEX IF NOT EXISTS idx_disclosure_uploads_sha ON disclosure_uploads(sha256);

-- Figures found in (or confirmed for) an upload. `method` records how the
-- value was obtained so the report can say how far to trust it.
CREATE TABLE IF NOT EXISTS disclosure_metric_values (
    value_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    upload_id     INTEGER NOT NULL REFERENCES disclosure_uploads(upload_id) ON DELETE CASCADE,
    metric_key    TEXT NOT NULL,
    value         REAL,
    unit          TEXT,
    basis         TEXT,                                 -- standalone | consolidated | null
    page          INTEGER,
    snippet       TEXT,
    method        TEXT NOT NULL,                        -- table | text | spreadsheet | json | llm | manual
    confidence    TEXT NOT NULL,                        -- high | medium | low
    alternatives_json TEXT,                             -- other candidate readings, for review
    UNIQUE(upload_id, metric_key)
);

-- Figures per bank and period, whatever document they came from. This is the
-- "bank data" table of the automatic check (the manual per-rule form writes
-- bank_quant_submissions instead).
CREATE TABLE IF NOT EXISTS bank_metric_values (
    bank_id       TEXT NOT NULL REFERENCES banks(bank_id),
    period_label  TEXT NOT NULL,
    metric_key    TEXT NOT NULL,
    value         REAL NOT NULL,
    unit          TEXT,
    upload_id     INTEGER REFERENCES disclosure_uploads(upload_id) ON DELETE SET NULL,
    page          INTEGER,
    method        TEXT,
    confidence    TEXT,
    updated_at    TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bank_id, period_label, metric_key)
);
