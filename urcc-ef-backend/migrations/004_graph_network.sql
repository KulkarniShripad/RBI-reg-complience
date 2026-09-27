-- Network Topology Mapper (graph subsystem): the counterparty network a bank
-- reports, and the results of checking it against RBI's concentration-risk
-- and related-party rules. Additive and safe to apply repeatedly.
--
-- The graph lives in plain tables (entities = nodes, graph_edges = typed
-- edges); the algorithms run in Node over the whole per-bank graph, which is
-- small (hundreds to a few thousand counterparties). Neo4j would be the
-- production choice at much larger scale; the tables map 1:1 onto
-- (:Entity)-[:TYPE {props}]->(:Entity).

-- Nodes. One namespace per bank: every bank describes its own counterparties.
-- The bank itself is the reserved node 'SELF' (created automatically), so
-- directors, promoters and shareholders of the bank are edges into SELF.
CREATE TABLE IF NOT EXISTS graph_entities (
    bank_id        TEXT NOT NULL REFERENCES banks(bank_id),
    entity_id      TEXT NOT NULL,                  -- bank's own key: PAN / CIN / LEI / customer id
    name           TEXT NOT NULL,
    entity_type    TEXT NOT NULL,                  -- company | individual | firm | trust | bank | nbfc | government | ccp | fund | self | other
    ite_class      TEXT,                           -- regulated_financial | unregulated_financial | non_financial (intra-group limits)
    group_relation TEXT,                           -- the bank's own group: subsidiary | associate | joint_venture | related_party | promoter | nofhc | common_brand
    attributes     TEXT,                           -- JSON: gold_loan_nbfc, section8_company, government_company, non_strategic_investor, identifiers, sector, ...
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bank_id, entity_id)
);

-- Typed, directed edges.
--   OWNS                  from owner -> owned, ownership_pct (voting)
--   CONTROLS              from controller -> controlled, basis (voting_agreement | board_appointment | management_influence | accounting_standard | other)
--   COMMON_MANAGEMENT     undirected in effect (horizontal group, same shareholders / managers)
--   ECONOMIC_DEPENDENCE   from dependent -> depends_on, criterion 1..7 (the RBI list), bidirectional 0/1
--   DIRECTOR_OF           person -> company (or -> SELF: a director of the bank)
--   INTERESTED_IN         person -> firm / company / individual, role (partner | manager | employee | guarantor | managing_agent | substantial_interest)
--   RELATIVE_OF           person -> person, relation (spouse | minor_child | dependent_child | other)
--   PROMOTER_OF           person / company -> SELF
-- status: confirmed (asserted by the bank), flagged (possible link awaiting
-- review - never treated as fact), rebutted (the bank has shown RBI the link
-- does not create a single risk; ignored for grouping).
CREATE TABLE IF NOT EXISTS graph_edges (
    edge_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id        TEXT NOT NULL REFERENCES banks(bank_id),
    from_entity    TEXT NOT NULL,
    to_entity      TEXT NOT NULL,
    edge_type      TEXT NOT NULL,
    ownership_pct  REAL,
    basis          TEXT,
    criterion      INTEGER,
    role           TEXT,
    relation       TEXT,
    bidirectional  INTEGER DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed','flagged','rebutted')),
    evidence       TEXT,
    source         TEXT,                           -- manual | csv_import | scenario | ...
    review_note    TEXT,
    reviewed_at    TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    UNIQUE (bank_id, from_entity, to_entity, edge_type)
);
CREATE INDEX IF NOT EXISTS idx_graph_edges_bank ON graph_edges(bank_id);

-- Exposures of the bank to each counterparty for a reporting period, in ₹ crore.
CREATE TABLE IF NOT EXISTS graph_exposures (
    exposure_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id          TEXT NOT NULL REFERENCES banks(bank_id),
    period_label     TEXT NOT NULL,
    entity_id        TEXT NOT NULL,
    exposure_kind    TEXT NOT NULL DEFAULT 'fund_based', -- fund_based | non_fund_based | investment | equity | interbank | derivative
    amount           REAL NOT NULL,                -- exposure value (outstanding / credit equivalent)
    sanctioned_limit REAL,                         -- used where limit-or-outstanding applies (UCBs)
    crm_amount       REAL DEFAULT 0,               -- eligible credit risk mitigation
    crm_provider     TEXT,                         -- entity providing the CRM (exposure shifts to it)
    infrastructure   INTEGER DEFAULT 0,            -- 1 = on account of infrastructure loan / investment
    exempt_reason    TEXT,                         -- sovereign | rbi | goi_guaranteed | intraday_interbank | food_credit | qccp_clearing | psl_deposit
    board_approved_excess INTEGER DEFAULT 0,       -- 1 = Board allowed the additional single-counterparty headroom
    section20_exception   TEXT,                    -- reason the director-lending prohibition does not apply (needs review)
    note             TEXT,
    created_at       TEXT DEFAULT (datetime('now')),
    UNIQUE (bank_id, period_label, entity_id, exposure_kind)
);
CREATE INDEX IF NOT EXISTS idx_graph_exposures_bank ON graph_exposures(bank_id, period_label);

-- Capital bases the limits are expressed against, per period, in ₹ crore.
CREATE TABLE IF NOT EXISTS graph_capital (
    bank_id                   TEXT NOT NULL REFERENCES banks(bank_id),
    period_label              TEXT NOT NULL,
    tier1_capital             REAL,               -- eligible capital base (CB, NBFC, AIFI, UCB)
    tier2_capital             REAL,               -- capital funds = Tier 1 + Tier 2 (SFB, LAB, gold-loan NBFC limit)
    owned_funds               REAL,               -- RRBs
    paid_up_capital_reserves  REAL,               -- SFB intra-group limits; RCB capital fund
    updated_at                TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bank_id, period_label)
);

-- Attributes of the reporting bank that select which limits apply.
CREATE TABLE IF NOT EXISTS graph_bank_profile (
    bank_id      TEXT PRIMARY KEY REFERENCES banks(bank_id),
    nbfc_layer   TEXT,                             -- BL | ML | UL (NBFCs only)
    nbfc_is_ifc  INTEGER DEFAULT 0,                -- NBFC-Infrastructure Finance Company
    rcb_rating   TEXT,                             -- NABARD inspection rating: A | B+ | B | C | D (rural co-operative banks)
    updated_at   TEXT DEFAULT (datetime('now'))
);

-- Frozen results of each network check.
CREATE TABLE IF NOT EXISTS graph_check_runs (
    graph_run_id      INTEGER PRIMARY KEY AUTOINCREMENT,
    bank_id           TEXT NOT NULL REFERENCES banks(bank_id),
    period_label      TEXT NOT NULL,
    compliance_run_id INTEGER,                     -- set when run as part of /api/compliance/:bankId/run
    run_at            TEXT DEFAULT (datetime('now')),
    summary_json      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS graph_check_results (
    result_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    graph_run_id  INTEGER NOT NULL REFERENCES graph_check_runs(graph_run_id),
    rule_key      TEXT NOT NULL,
    clause_uri    TEXT,
    status        TEXT NOT NULL,
    detail_json   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_graph_results_run ON graph_check_results(graph_run_id);
