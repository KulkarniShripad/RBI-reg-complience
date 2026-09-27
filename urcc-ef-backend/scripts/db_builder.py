"""
Stage 4: build / update the relational store (urcc_ef.db).

Two entry points:

  build   Full rebuild from the circulars folder. Parses every PDF (in
          parallel), de-duplicates by content hash, writes a NEW database
          file and swaps it in atomically, so a failed build never leaves a
          half-written DB behind. Bank data (banks, submissions, evidence,
          run history, curated mappings) can be carried over from the
          previous database with --carry-over; submissions are re-pointed to
          the new rule ids where the same rule is found again.

  ingest  Add ONE PDF to the live database (the upload path). Rejects exact
          duplicates by SHA-256, reports a probable newer version of an
          existing circular (same RBI reference, different bytes) instead of
          silently adding a second copy, and replaces it only if asked.

Usage:
  python3 db_builder.py build  --circulars ../../circulars --db ../data/urcc_ef.db [--carry-over ../data/urcc_ef.db] [--workers 4]
  python3 db_builder.py ingest path/to/file.pdf --db ../data/urcc_ef.db [--category small_finance_banks] [--replace] [--circulars-root ../../circulars]

`ingest` prints one JSON object on stdout (the Node API parses it).

SQLite stands in for PostgreSQL (no DB server in the development sandbox);
table and column names are kept portable.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import sqlite3
import sys
import time
from collections import Counter, defaultdict
from multiprocessing import Pool

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import categories as CAT  # noqa: E402
import chunker as CH  # noqa: E402
import classifier as C  # noqa: E402
import parser as P  # noqa: E402

EXTRACTION_VERSION = "2.0"
HERE = os.path.dirname(os.path.abspath(__file__))
MIGRATIONS_DIR = os.path.join(HERE, "..", "migrations")

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
    category_id   TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    slug          TEXT NOT NULL,
    sort_order    INTEGER,
    aliases       TEXT,                              -- JSON: lower-case names / abbreviations
    patterns      TEXT                               -- JSON: regexes used to spot the entity in text
);

CREATE TABLE IF NOT EXISTS topic_families (
    family_id  TEXT PRIMARY KEY,
    label      TEXT NOT NULL,
    pattern    TEXT,
    sort_order INTEGER
);

CREATE TABLE IF NOT EXISTS documents (
    doc_id                TEXT PRIMARY KEY,          -- first 16 hex chars of the PDF's SHA-256
    pdf_sha256            TEXT NOT NULL UNIQUE,
    file_path             TEXT NOT NULL,             -- relative to the circulars root when possible
    file_name             TEXT,
    institution_category  TEXT NOT NULL,             -- primary canonical category id (see categories)
    rbi_ref               TEXT,
    dept_code             TEXT,
    doc_date              TEXT,
    title                 TEXT,
    topic                 TEXT,
    topic_families        TEXT,                      -- JSON array of family ids
    last_updated_label    TEXT,
    template_variant      TEXT,
    total_pages           INTEGER,
    source                TEXT DEFAULT 'corpus',     -- corpus | upload
    extraction_version    TEXT,
    ingested_at           TEXT DEFAULT (datetime('now')),
    source_url            TEXT,
    superseded_by         TEXT
);

CREATE TABLE IF NOT EXISTS document_files (       -- every path seen with the same bytes
    pdf_sha256   TEXT NOT NULL,
    file_path    TEXT NOT NULL,
    PRIMARY KEY (pdf_sha256, file_path)
);

CREATE TABLE IF NOT EXISTS document_categories (
    doc_id     TEXT NOT NULL REFERENCES documents(doc_id),
    category   TEXT NOT NULL,
    source     TEXT NOT NULL,                       -- title | folder | user | applicability | inferred
    PRIMARY KEY (doc_id, category)
);

CREATE TABLE IF NOT EXISTS clause_registry (
    clause_uri               TEXT PRIMARY KEY,
    doc_id                   TEXT NOT NULL REFERENCES documents(doc_id),
    seq                      INTEGER,               -- reading order within the document
    chapter_roman            TEXT,
    chapter_title            TEXT,
    section_letter           TEXT,
    section_title            TEXT,
    heading_path             TEXT,                  -- "Chapter I: Preliminary > C. Definitions"
    paragraph_number         TEXT NOT NULL,
    clause_text              TEXT NOT NULL,
    clause_role              TEXT,                  -- obligation | definition | applicability | short_title | repeal | information | annex | preamble | deleted
    clause_type              TEXT CHECK (clause_type IN ('quantitative','qualitative','relational','hybrid')),
    confidence               TEXT CHECK (confidence IN ('high','low')),
    needs_llm_refinement     INTEGER DEFAULT 0,
    is_obligation            INTEGER DEFAULT 0,
    page_number              INTEGER,
    page_end                 INTEGER,
    is_definitions_paragraph INTEGER DEFAULT 0,
    is_proviso_continuation  INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rule_atoms (
    rule_id          INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri       TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    operator         TEXT,
    threshold_value  REAL,
    threshold_unit   TEXT,
    threshold_base   TEXT,                           -- "of NDTL", "of risk weighted assets" ...
    variable_text    TEXT,
    variable_name    TEXT,
    value_source     TEXT CHECK (value_source IN ('direct_report','graph_aggregate')),
    match_evidence   TEXT,
    sentence         TEXT,
    atom_kind        TEXT DEFAULT 'requirement',     -- requirement | condition
    confidence       TEXT DEFAULT 'high'
);

CREATE TABLE IF NOT EXISTS definitions (
    def_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri         TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    doc_id             TEXT NOT NULL REFERENCES documents(doc_id),
    term               TEXT,
    definition_text    TEXT NOT NULL,
    sub_clause_number  TEXT,
    page_number        INTEGER
);

CREATE TABLE IF NOT EXISTS cross_references (
    ref_id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    from_clause_uri             TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    doc_id                      TEXT NOT NULL REFERENCES documents(doc_id),
    ref_type                    TEXT,                -- paragraph | annex | document
    target_paragraph            TEXT,
    target_sub_clause           TEXT,
    range_end                   TEXT,
    target_annex                TEXT,
    target_text                 TEXT,
    resolved_target_clause_uri  TEXT,
    resolved_target_doc_id      TEXT
);

CREATE TABLE IF NOT EXISTS annexes (
    annex_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id       TEXT NOT NULL REFERENCES documents(doc_id),
    clause_uri   TEXT NOT NULL,
    annex_key    TEXT,
    title        TEXT,
    annex_text   TEXT,
    page_number  INTEGER,
    page_end     INTEGER
);

CREATE TABLE IF NOT EXISTS footnotes (
    footnote_id    INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_id         TEXT NOT NULL REFERENCES documents(doc_id),
    page_number    INTEGER,
    footnote_text  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS semantic_chunks (
    chunk_id           INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri         TEXT NOT NULL,
    parent_clause_uri  TEXT NOT NULL,
    doc_id             TEXT NOT NULL REFERENCES documents(doc_id),
    chunk_text         TEXT NOT NULL,
    raw_text           TEXT NOT NULL,
    chunk_index        INTEGER,
    boundary_type      TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_text, clause_uri UNINDEXED, doc_id UNINDEXED, tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS corpus_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE INDEX IF NOT EXISTS idx_clause_doc ON clause_registry(doc_id);
CREATE INDEX IF NOT EXISTS idx_clause_type ON clause_registry(clause_type);
CREATE INDEX IF NOT EXISTS idx_clause_role ON clause_registry(clause_role);
CREATE INDEX IF NOT EXISTS idx_ruleatoms_clause ON rule_atoms(clause_uri);
CREATE INDEX IF NOT EXISTS idx_definitions_doc ON definitions(doc_id);
CREATE INDEX IF NOT EXISTS idx_definitions_term ON definitions(term COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_crossref_from ON cross_references(from_clause_uri);
CREATE INDEX IF NOT EXISTS idx_chunks_clause ON semantic_chunks(parent_clause_uri);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON semantic_chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_doccat_cat ON document_categories(category);
CREATE INDEX IF NOT EXISTS idx_docs_ref ON documents(rbi_ref);
"""


def slug(category_id: str) -> str:
    return CAT.SLUGS.get(category_id, re.sub(r"[^a-z0-9]+", "-", category_id.lower()).strip("-"))


def clause_uri_for(category_id: str, doc_id: str, key: str) -> str:
    return f"rbi://{slug(category_id)}/{doc_id}/{key}"


def para_uri(category_id, doc_id, para_key):
    return clause_uri_for(category_id, doc_id, f"para{para_key}")


def rel_path(path: str, root: str | None) -> str:
    if root:
        try:
            rp = os.path.relpath(os.path.abspath(path), os.path.abspath(root))
            if not rp.startswith(".."):
                return rp.replace(os.sep, "/")
        except ValueError:
            pass
    return os.path.abspath(path)


def folder_category(path_rel: str) -> str | None:
    parts = path_rel.split("/")
    return CAT.normalise_category(parts[0]) if len(parts) > 1 else None


# ---------------------------------------------------------------------------
# Category inference
# ---------------------------------------------------------------------------
APPLIES = re.compile(
    r"(these|this|the\s+provisions\s+of\s+these)\s+(?:master\s+)?directions?\b[^.]{0,120}?\b(shall|will|are|is)\b[^.]{0,60}?\b(apply|applicable)\s+to",
    re.I)


def applicability_text(doc: P.ParsedDocument) -> str:
    """Only statements about who the directions apply to, plus the addressee
    block of a cover letter - not every sentence that mentions an entity."""
    parts = []
    for p in doc.paragraphs[:25]:
        flat = re.sub(r"\s+", " ", p.text)
        m = APPLIES.search(flat)
        if m:
            parts.append(flat[m.start():m.start() + 1500])
    head = doc.preamble[:1500]
    salutation = re.search(r"(Madam|Dear\s+Sir|Sir\s*/\s*Madam|Sir,)", head)
    if salutation:
        parts.append(head[:salutation.start()])
    return " ".join(parts)

def infer_categories(doc: P.ParsedDocument, hints: list[tuple[str, str]]):
    """hints: [(category_id, source)] from folders or the upload form.
    Returns (primary, [(category, source), ...])."""
    cats: list[tuple[str, str]] = []

    def add(c, s):
        if c and c not in [x for x, _ in cats]:
            cats.append((c, s))

    title_cat = CAT.category_from_title(doc.title)
    if title_cat and title_cat != "multiple":
        add(title_cat, "title")
    for c, s in hints:
        if c and c != "multiple":
            add(c, s)
    if not cats:
        # No entity in the title and no folder: read the applicability
        # statement and the letter's addressee block ("All Scheduled
        # Commercial Banks (including SFBs, excluding RRBs)").
        app = applicability_text(doc)
        for c in CAT.categories_from_applicability(app):
            add(c, "applicability")
        # "every Scheduled Bank", "every bank operating in India": covers
        # several bank types that are not named individually.
        if cats and re.search(r"\b(every|all)\s+(scheduled\s+)?banks?\b|\bscheduled\s+banks?\b", app, re.I):
            cats.append(("multiple", "inferred"))
            return "multiple", cats
    if not cats:
        return "multiple", [("multiple", "inferred")]
    primary = cats[0][0]
    if len({c for c, _ in cats}) > 1 and (not title_cat or title_cat == "multiple"):
        cats.append(("multiple", "inferred"))
        primary = "multiple"
    return primary, cats


# ---------------------------------------------------------------------------
# Insert one parsed document
# ---------------------------------------------------------------------------
def _short_title(title: str) -> str:
    t = re.sub(r"^Reserve Bank of India\s*", "RBI ", title or "").strip()
    return t[:160]


def insert_document(conn, doc: P.ParsedDocument, primary: str, cats, file_paths: list[str], source: str) -> dict:
    stats = Counter()
    topic = CAT.topic_from_title(doc.title)
    families = CAT.topic_families(doc.title, topic)
    conn.execute(
        "INSERT INTO documents (doc_id, pdf_sha256, file_path, file_name, institution_category, rbi_ref, dept_code, "
        "doc_date, title, topic, topic_families, last_updated_label, template_variant, total_pages, source, "
        "extraction_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (doc.doc_id, doc.pdf_sha256, file_paths[0], os.path.basename(file_paths[0]), primary, doc.rbi_ref,
         doc.dept_code, doc.date, doc.title, topic, json.dumps(families), doc.last_updated_label,
         doc.template_variant, doc.page_count, source, EXTRACTION_VERSION))
    for fp in file_paths:
        conn.execute("INSERT OR IGNORE INTO document_files VALUES (?,?)", (doc.pdf_sha256, fp))
    for c, s in cats:
        conn.execute("INSERT OR IGNORE INTO document_categories VALUES (?,?,?)", (doc.doc_id, c, s))

    cat_label = ", ".join(CAT.LABELS.get(c, c) for c, _ in cats if c != "multiple") or CAT.LABELS["multiple"]
    doc_label = f"{_short_title(doc.title)}{f' ({doc.rbi_ref})' if doc.rbi_ref else ''}"
    seq = 0

    def add_clause(uri, key, text, page, page_end, heading_path, role_hint=None, para=None):
        nonlocal seq
        seq += 1
        cls = C.classify_clause(text, heading_path, is_annex=role_hint == "annex", is_preamble=role_hint == "preamble")
        conn.execute(
            "INSERT INTO clause_registry (clause_uri, doc_id, seq, chapter_roman, chapter_title, section_letter, "
            "section_title, heading_path, paragraph_number, clause_text, clause_role, clause_type, confidence, "
            "needs_llm_refinement, is_obligation, page_number, page_end, is_definitions_paragraph, "
            "is_proviso_continuation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (uri, doc.doc_id, seq, para.chapter_roman if para else "", para.chapter_title if para else "",
             para.section_letter if para else "", para.section_title if para else "", " > ".join(heading_path),
             key, text, cls.clause_role, cls.clause_type, cls.confidence, int(cls.needs_llm_refinement),
             int(cls.is_obligation), page, page_end, int(cls.clause_role == "definition"),
             int(bool(re.search(r"\bProvided (that|further)", text)))))
        stats["clauses"] += 1
        stats[f"type_{cls.clause_type}"] += 1
        stats[f"role_{cls.clause_role}"] += 1
        for a in cls.rule_atoms:
            conn.execute(
                "INSERT INTO rule_atoms (clause_uri, operator, threshold_value, threshold_unit, threshold_base, "
                "variable_text, variable_name, value_source, match_evidence, sentence, atom_kind, confidence) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (uri, a.operator, a.threshold_value, a.threshold_unit, a.threshold_base, a.variable_text,
                 a.variable_name, a.value_source, a.match_evidence, a.sentence, a.atom_kind, a.confidence))
            stats["rule_atoms"] += 1
            stats[f"atoms_{a.atom_kind}"] += 1
        defs = C.extract_definitions(text) if cls.clause_role == "definition" else []
        for d in defs:
            conn.execute(
                "INSERT INTO definitions (clause_uri, doc_id, term, definition_text, sub_clause_number, page_number) "
                "VALUES (?,?,?,?,?,?)", (uri, doc.doc_id, d["term"], d["definition_text"], d["sub_clause_number"], page))
            stats["definitions"] += 1
        if role_hint not in ("annex", "preamble"):
            for ref in C.extract_cross_references(text, key):
                conn.execute(
                    "INSERT INTO cross_references (from_clause_uri, doc_id, ref_type, target_paragraph, "
                    "target_sub_clause, range_end, target_annex, target_text) VALUES (?,?,?,?,?,?,?,?)",
                    (uri, doc.doc_id, ref["ref_type"], ref.get("target_paragraph"), ref.get("target_sub_clause"),
                     ref.get("range_end"), ref.get("target_annex"), ref.get("target_text")))
                stats["cross_refs"] += 1
        return cls, defs

    def add_chunks(chunks):
        for ch in chunks:
            cur = conn.execute(
                "INSERT INTO semantic_chunks (clause_uri, parent_clause_uri, doc_id, chunk_text, raw_text, "
                "chunk_index, boundary_type) VALUES (?,?,?,?,?,?,?)",
                (ch.clause_uri, ch.parent_clause_uri, doc.doc_id, ch.chunk_text, ch.raw_text, ch.chunk_index,
                 ch.boundary_type))
            conn.execute("INSERT INTO chunks_fts (rowid, chunk_text, clause_uri, doc_id) VALUES (?,?,?,?)",
                         (cur.lastrowid, ch.chunk_text, ch.parent_clause_uri, doc.doc_id))
            stats["chunks"] += 1

    if doc.preamble.strip():
        uri = clause_uri_for(primary, doc.doc_id, "preamble")
        add_clause(uri, "preamble", doc.preamble, doc.preamble_page, doc.preamble_page, [], role_hint="preamble")
        add_chunks(CH.chunk_block(uri, doc.preamble, f"{doc_label} | Applies to: {cat_label} | Preamble", "preamble"))

    for p in doc.paragraphs:
        uri = para_uri(primary, doc.doc_id, p.key)
        cls, defs = add_clause(uri, p.key, p.text, p.page, p.page_end or p.page, p.heading_path, para=p)
        if cls.clause_role == "deleted":
            continue                                    # searchable text would only be "*****"
        prefix = CH.context_prefix(doc_label, cat_label, p.heading_path, f"Para {p.key}")
        add_chunks(CH.chunk_paragraph(uri, p.text, prefix, p.subclauses, defs))

    for a in doc.annexes:
        key = re.sub(r"[^A-Za-z0-9]+", "", a.key or "") or "X"
        uri = clause_uri_for(primary, doc.doc_id, f"annex{key}")
        n = 1
        while conn.execute("SELECT 1 FROM clause_registry WHERE clause_uri = ?", (uri,)).fetchone():
            n += 1
            uri = clause_uri_for(primary, doc.doc_id, f"annex{key}-{n}")
        text = (a.title + "\n" + a.text).strip() if a.title else a.text
        heading = [f"Annex {a.key}: {a.title}".strip(": ")]
        add_clause(uri, f"Annex {a.key}", text, a.page, a.page_end or a.page, heading, role_hint="annex")
        conn.execute("INSERT INTO annexes (doc_id, clause_uri, annex_key, title, annex_text, page_number, page_end) "
                     "VALUES (?,?,?,?,?,?,?)", (doc.doc_id, uri, a.key, a.title, a.text, a.page, a.page_end or a.page))
        stats["annexes"] += 1
        if not C.DELETED.match(a.text.strip() or "*****"):
            add_chunks(CH.chunk_block(uri, text, f"{doc_label} | Applies to: {cat_label} | {heading[0]}", "annex"))

    for page, text in doc.footnotes:
        conn.execute("INSERT INTO footnotes (doc_id, page_number, footnote_text) VALUES (?,?,?)",
                     (doc.doc_id, page, text))
        stats["footnotes"] += 1
    return stats


def resolve_cross_references(conn, doc_ids=None):
    """Point paragraph/annex references at real clause URIs in the same
    document, and document references at the document they name."""
    where = "" if doc_ids is None else f" AND cr.doc_id IN ({','.join('?' * len(doc_ids))})"
    params = [] if doc_ids is None else list(doc_ids)
    rows = conn.execute(
        "SELECT cr.ref_id, cr.doc_id, cr.ref_type, cr.target_paragraph, cr.target_annex, cr.target_text "
        f"FROM cross_references cr WHERE 1=1{where}", params).fetchall()
    titles = {re.sub(r"[^a-z0-9]+", " ", (t or "").lower()).strip(): d
              for d, t in conn.execute("SELECT doc_id, title FROM documents")}
    for ref_id, doc_id, rtype, tpara, tannex, ttext in rows:
        target_uri, target_doc = None, None
        if rtype == "paragraph" and tpara:
            r = conn.execute("SELECT clause_uri FROM clause_registry WHERE doc_id = ? AND paragraph_number = ?",
                             (doc_id, tpara)).fetchone()
            target_uri = r[0] if r else None
        elif rtype == "annex" and tannex:
            r = conn.execute("SELECT clause_uri FROM annexes WHERE doc_id = ? AND annex_key = ?", (doc_id, tannex)).fetchone()
            target_uri = r[0] if r else None
        elif rtype == "document" and ttext:
            key = re.sub(r"[^a-z0-9]+", " ", ttext.lower()).strip()
            key = re.sub(r"\s+(directions|guidelines)\s+\d{4}$", "", key)
            for t, d in titles.items():
                if t.startswith(key[:80]) and d != doc_id:
                    target_doc = d
                    break
        conn.execute("UPDATE cross_references SET resolved_target_clause_uri = ?, resolved_target_doc_id = ? "
                     "WHERE ref_id = ?", (target_uri, target_doc, ref_id))


def apply_operational_schema(conn):
    """Tables owned by the Node API (banks, submissions, runs, ...). Same SQL
    files `npm run migrate` applies, so either order works."""
    for f in sorted(glob.glob(os.path.join(MIGRATIONS_DIR, "*.sql"))):
        with open(f) as fh:
            conn.executescript(fh.read())
    cols = {r[1] for r in conn.execute("PRAGMA table_info(documents)")}
    for col in ("source_url", "last_updated_label", "superseded_by"):
        if col not in cols:
            conn.execute(f"ALTER TABLE documents ADD COLUMN {col} TEXT")


def write_meta(conn):
    counts = {
        "documents": conn.execute("SELECT COUNT(*) FROM documents").fetchone()[0],
        "clauses": conn.execute("SELECT COUNT(*) FROM clause_registry").fetchone()[0],
        "rule_atoms": conn.execute("SELECT COUNT(*) FROM rule_atoms").fetchone()[0],
        "chunks": conn.execute("SELECT COUNT(*) FROM semantic_chunks").fetchone()[0],
    }
    for k, v in {"extraction_version": EXTRACTION_VERSION, "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                 **{f"count_{k}": str(v) for k, v in counts.items()}}.items():
        conn.execute("INSERT OR REPLACE INTO corpus_meta VALUES (?,?)", (k, str(v)))


def seed_categories(conn):
    cols = {r[1] for r in conn.execute("PRAGMA table_info(categories)")}
    for col in ("aliases", "patterns"):
        if col not in cols:
            conn.execute(f"ALTER TABLE categories ADD COLUMN {col} TEXT")
    for i, (cid, label, slug_, aliases, patterns) in enumerate(CAT.CATEGORIES):
        conn.execute("INSERT OR REPLACE INTO categories (category_id, label, slug, sort_order, aliases, patterns) "
                     "VALUES (?,?,?,?,?,?)", (cid, label, slug_, i, json.dumps(aliases), json.dumps(patterns)))
    for i, (fid, label, pattern) in enumerate(CAT.TOPIC_FAMILIES):
        conn.execute("INSERT OR REPLACE INTO topic_families VALUES (?,?,?,?)", (fid, label, pattern, i))
    conn.execute("INSERT OR REPLACE INTO topic_families VALUES (?,?,?,?)",
                 ("other", CAT.FAMILY_LABELS["other"], None, len(CAT.TOPIC_FAMILIES)))


# ---------------------------------------------------------------------------
# Carry-over of bank / operational data from a previous database
# ---------------------------------------------------------------------------
OPERATIONAL_TABLES = ["banks", "bank_qual_evidence", "compliance_runs", "compliance_run_details",
                      "routing_decisions", "rbi_watch_list",
                      # counterparty network (graph subsystem) - no rule ids inside, copied as is
                      "graph_entities", "graph_edges", "graph_exposures", "graph_capital", "graph_bank_profile",
                      "graph_check_runs", "graph_check_results"]


def carry_over(conn, old_path: str) -> dict:
    report = {"copied": {}, "remapped_rules": {}, "dropped_submissions": [], "dropped_mappings": []}
    conn.execute("ATTACH DATABASE ? AS old", (old_path,))
    old_tables = {r[0] for r in conn.execute("SELECT name FROM old.sqlite_master WHERE type='table'")}
    for t in OPERATIONAL_TABLES:
        if t not in old_tables:
            continue
        cols = [r[1] for r in conn.execute(f"PRAGMA old.table_info({t})")]
        new_cols = {r[1] for r in conn.execute(f"PRAGMA main.table_info({t})")}
        cols = [c for c in cols if c in new_cols]
        conn.execute(f"INSERT OR IGNORE INTO main.{t} ({','.join(cols)}) SELECT {','.join(cols)} FROM old.{t}")
        report["copied"][t] = conn.execute(f"SELECT COUNT(*) FROM main.{t}").fetchone()[0]
    for bank_id, cat in conn.execute("SELECT bank_id, institution_category FROM banks").fetchall():
        norm = CAT.normalise_category(cat)
        if norm and norm != cat:
            conn.execute("UPDATE banks SET institution_category = ? WHERE bank_id = ?", (norm, bank_id))

    # Re-point rule ids: same RBI reference + paragraph + operator + value + unit.
    if "rule_atoms" in old_tables:
        old_rules = conn.execute(
            "SELECT ra.rule_id, d.rbi_ref, cr.paragraph_number, ra.operator, ra.threshold_value, ra.threshold_unit "
            "FROM old.rule_atoms ra JOIN old.clause_registry cr ON cr.clause_uri = ra.clause_uri "
            "JOIN old.documents d ON d.doc_id = cr.doc_id").fetchall()
        for rid, ref, para, op, val, unit in old_rules:
            cands = conn.execute(
                "SELECT ra.rule_id FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri "
                "JOIN documents d ON d.doc_id = cr.doc_id WHERE d.rbi_ref = ? AND cr.paragraph_number = ? "
                "AND ra.operator = ? AND ra.threshold_value = ? AND ra.threshold_unit = ?",
                (ref, str(para), op, val, unit)).fetchall()
            if len(cands) == 1:
                report["remapped_rules"][rid] = cands[0][0]
    for table, bucket in (("bank_quant_submissions", "dropped_submissions"), ("rule_field_mappings", "dropped_mappings")):
        if table not in old_tables:
            continue
        cols = [r[1] for r in conn.execute(f"PRAGMA old.table_info({table})")]
        key = "submission_id" if table == "bank_quant_submissions" else "mapping_id"
        for row in conn.execute(f"SELECT * FROM old.{table}").fetchall():
            rec = dict(zip(cols, row))
            new_rid = report["remapped_rules"].get(rec["rule_id"])
            if new_rid is None:
                report[bucket].append(rec)
                continue
            rec["rule_id"] = new_rid
            rec.pop(key, None)
            conn.execute(f"INSERT OR IGNORE INTO {table} ({','.join(rec)}) VALUES ({','.join('?' * len(rec))})",
                         list(rec.values()))
    conn.commit()
    conn.execute("DETACH DATABASE old")
    report["remapped_rules"] = {str(k): v for k, v in report["remapped_rules"].items()}
    return report


# ---------------------------------------------------------------------------
# Full build
# ---------------------------------------------------------------------------
def _is_sqlite(path):
    try:
        with open(path, "rb") as f:
            return f.read(16) == b"SQLite format 3\x00"
    except OSError:
        return False


def _parse(path):
    try:
        return path, P.parse_document(path), None
    except Exception as e:                                   # never let one bad PDF kill the build
        return path, None, f"{type(e).__name__}: {e}"


def build_database(circulars_root: str, db_path: str, carry_over_from: str | None = None, workers: int = 4) -> dict:
    t0 = time.time()
    files = sorted(glob.glob(os.path.join(circulars_root, "**", "*.[Pp][Dd][Ff]"), recursive=True))
    print(f"[build] parsing {len(files)} PDFs with {workers} workers ...", file=sys.stderr)
    with Pool(workers) as pool:
        parsed = pool.map(_parse, files, chunksize=2)

    failures = [(p, err) for p, d, err in parsed if err]
    by_hash: dict[str, list] = defaultdict(list)
    for path, doc, _ in parsed:
        if doc:
            by_hash[doc.pdf_sha256].append((path, doc))

    tmp = db_path + ".building"
    for f in (tmp, tmp + "-wal", tmp + "-shm"):
        if os.path.exists(f):
            os.remove(f)
    conn = sqlite3.connect(tmp)
    conn.executescript(SCHEMA)
    seed_categories(conn)
    totals = Counter()
    duplicates = []
    for sha, entries in by_hash.items():
        rels = [rel_path(p, circulars_root) for p, _ in entries]
        # Prefer a copy that lives in a category folder over a root-level copy.
        order = sorted(range(len(entries)), key=lambda i: (folder_category(rels[i]) is None, len(rels[i])))
        rels = [rels[i] for i in order]
        doc = entries[order[0]][1]
        if len(entries) > 1:
            duplicates.append(rels)
        hints = [(folder_category(r), "folder") for r in rels]
        primary, cats = infer_categories(doc, hints)
        stats = insert_document(conn, doc, primary, cats, rels, "corpus")
        totals.update(stats)
        totals["documents"] += 1
    resolve_cross_references(conn)
    apply_operational_schema(conn)
    write_meta(conn)
    conn.commit()

    carry = None
    if carry_over_from and _is_sqlite(carry_over_from):
        carry = carry_over(conn, carry_over_from)
    elif carry_over_from and os.path.exists(carry_over_from):
        print(f"[build] {carry_over_from} is not a SQLite database (Git LFS pointer?) - nothing to carry over",
              file=sys.stderr)
    conn.execute("PRAGMA journal_mode = DELETE")
    conn.close()

    for f in (db_path + "-wal", db_path + "-shm"):
        if os.path.exists(f):
            os.remove(f)
    os.replace(tmp, db_path)
    return {
        "seconds": round(time.time() - t0, 1), "pdf_files": len(files), "distinct_pdfs": len(by_hash),
        "duplicate_files": duplicates, "parse_failures": failures, "totals": dict(totals),
        "carry_over": carry,
    }


# ---------------------------------------------------------------------------
# Single-file ingest (uploads)
# ---------------------------------------------------------------------------
def delete_document(conn, doc_id: str) -> dict:
    chunk_ids = [r[0] for r in conn.execute("SELECT chunk_id FROM semantic_chunks WHERE doc_id = ?", (doc_id,))]
    rule_ids = [r[0] for r in conn.execute(
        "SELECT ra.rule_id FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri "
        "WHERE cr.doc_id = ?", (doc_id,))]
    sha = conn.execute("SELECT pdf_sha256 FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()
    conn.execute(f"DELETE FROM chunks_fts WHERE rowid IN ({','.join('?' * len(chunk_ids))})", chunk_ids)
    for t in ("semantic_chunks", "cross_references", "definitions", "annexes", "footnotes", "document_categories"):
        conn.execute(f"DELETE FROM {t} WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM rule_atoms WHERE clause_uri IN (SELECT clause_uri FROM clause_registry WHERE doc_id = ?)",
                 (doc_id,))
    conn.execute("DELETE FROM clause_registry WHERE doc_id = ?", (doc_id,))
    if sha:
        conn.execute("DELETE FROM document_files WHERE pdf_sha256 = ?", (sha[0],))
    conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
    return {"removed_chunk_ids": chunk_ids, "removed_rule_ids": rule_ids}


def ingest_file(db_path: str, pdf_path: str, category: str | None = None, replace: bool = False,
                circulars_root: str | None = None, source: str = "upload") -> dict:
    sha = P.sha256_file(pdf_path)
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    seed_categories(conn)

    existing = conn.execute("SELECT doc_id, title, rbi_ref, file_path FROM documents WHERE pdf_sha256 = ?",
                            (sha,)).fetchone()
    if existing:
        conn.close()
        return {"status": "duplicate", "reason": "identical_file", "doc_id": existing[0], "title": existing[1],
                "rbi_ref": existing[2], "file_path": existing[3], "pdf_sha256": sha}

    doc = P.parse_document(pdf_path)
    if not doc.paragraphs and len(doc.preamble) < 200:
        conn.close()
        return {"status": "rejected", "reason": "no_text",
                "detail": "No extractable text was found. Scanned (image-only) PDFs need OCR before upload."}

    replaced = None
    same_ref = conn.execute(
        "SELECT doc_id, title, rbi_ref, file_path, last_updated_label FROM documents WHERE rbi_ref != '' AND rbi_ref = ?",
        (doc.rbi_ref,)).fetchall() if doc.rbi_ref else []
    if same_ref:
        if not replace:
            conn.close()
            return {"status": "possible_update", "reason": "same_rbi_reference", "rbi_ref": doc.rbi_ref,
                    "title": doc.title, "last_updated_label": doc.last_updated_label,
                    "existing": [dict(zip(("doc_id", "title", "rbi_ref", "file_path", "last_updated_label"), r))
                                 for r in same_ref]}
        replaced = {}
        for r in same_ref:
            replaced[r[0]] = delete_document(conn, r[0])

    cat = CAT.normalise_category(category) if category else None
    hints = [(cat, "user")] if cat else []
    rp = rel_path(pdf_path, circulars_root)
    if not cat:
        fc = folder_category(rp)
        if fc:
            hints.append((fc, "folder"))
    primary, cats = infer_categories(doc, hints)
    stats = insert_document(conn, doc, primary, cats, [rp], source)
    resolve_cross_references(conn, [doc.doc_id])
    write_meta(conn)
    conn.commit()
    chunk_ids = [r[0] for r in conn.execute("SELECT chunk_id FROM semantic_chunks WHERE doc_id = ?", (doc.doc_id,))]
    conn.close()
    return {
        "status": "replaced" if replaced else "added", "doc_id": doc.doc_id, "pdf_sha256": sha,
        "title": doc.title, "rbi_ref": doc.rbi_ref, "institution_category": primary,
        "categories": [c for c, _ in cats], "topic": CAT.topic_from_title(doc.title),
        "counts": dict(stats), "chunk_ids": chunk_ids, "replaced": replaced,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build")
    b.add_argument("--circulars", required=True)
    b.add_argument("--db", required=True)
    b.add_argument("--carry-over", dest="carry_over")
    b.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 2)))
    i = sub.add_parser("ingest")
    i.add_argument("pdf")
    i.add_argument("--db", required=True)
    i.add_argument("--category")
    i.add_argument("--replace", action="store_true")
    i.add_argument("--circulars-root")
    args = ap.parse_args()

    if args.cmd == "build":
        report = build_database(args.circulars, args.db, args.carry_over, args.workers)
        print(json.dumps(report, indent=2, default=str))
        print("[build] done. Next: `npm run build:vectors` to (re)embed, then restart the API server.", file=sys.stderr)
    else:
        try:
            print(json.dumps(ingest_file(args.db, args.pdf, args.category, args.replace, args.circulars_root)))
        except Exception as e:
            print(json.dumps({"status": "error", "detail": f"{type(e).__name__}: {e}"}))
            sys.exit(1)


if __name__ == "__main__":
    main()
