-- Routing audit trail used by the adaptive compliance endpoint.
-- Additive and safe to apply repeatedly.
CREATE TABLE IF NOT EXISTS routing_decisions (
    routing_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id        TEXT NOT NULL REFERENCES banks(bank_id),
    clause_uri     TEXT NOT NULL,
    clause_type    TEXT NOT NULL,
    chosen_route   TEXT,
    decision       TEXT,
    reasons_json   TEXT NOT NULL,
    final_status   TEXT,
    created_at     TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_routing_bank_clause
    ON routing_decisions(bank_id, clause_uri);

CREATE INDEX IF NOT EXISTS idx_routing_route
    ON routing_decisions(chosen_route);

-- Human-curated mapping between an extracted rule atom and a bank-return
-- field. Suggestions remain unapproved until a reviewer confirms them.
CREATE TABLE IF NOT EXISTS rule_field_mappings (
    mapping_id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id                    INTEGER NOT NULL REFERENCES rule_atoms(rule_id),
    canonical_label            TEXT,
    llm_suggested_label        TEXT,
    llm_suggested_return_code  TEXT,
    llm_suggested_tag          TEXT,
    cims_return_code           TEXT,
    cims_field_tag             TEXT,
    approved_by                TEXT,
    approved_at                TEXT,
    created_at                 TEXT DEFAULT (datetime('now')),
    UNIQUE(rule_id)
);

CREATE INDEX IF NOT EXISTS idx_rule_mapping_rule
    ON rule_field_mappings(rule_id);