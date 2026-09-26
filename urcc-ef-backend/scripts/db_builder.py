"""
Stage 4: populate the actual databases from the parsed + classified corpus.

SQLite is used here (not PostgreSQL) purely because this sandbox has no
database server available - the schema is written in portable SQL and maps
directly onto the PostgreSQL schema from the architecture document (same
table names, same columns, same clause_uri binding key). Swapping the
DB-API calls for psycopg2 at deployment is a mechanical change, not a
redesign.
"""
import sqlite3
import json
import re
import sys
import glob
import os

sys.path.insert(0, os.path.dirname(__file__))
import parser as P
import classifier as C
import chunker as CH

SCHEMA = """
CREATE TABLE documents (
    doc_id              TEXT PRIMARY KEY,
    file_path            TEXT NOT NULL,
    institution_category   TEXT NOT NULL,
    rbi_ref                 TEXT,
    dept_code                TEXT,
    doc_date                  TEXT,
    title                      TEXT,
    template_variant            TEXT,
    total_pages                  INTEGER
);

CREATE TABLE clause_registry (
    clause_uri           TEXT PRIMARY KEY,
    doc_id                 TEXT NOT NULL REFERENCES documents(doc_id),
    chapter_roman            TEXT,
    chapter_title              TEXT,
    section_letter               TEXT,
    section_title                  TEXT,
    paragraph_number                 TEXT NOT NULL,
    clause_text                        TEXT NOT NULL,
    clause_type                          TEXT CHECK (clause_type IN
                                          ('quantitative','qualitative','relational','hybrid')),
    confidence                             TEXT CHECK (confidence IN ('high','low')),
    needs_llm_refinement                     INTEGER DEFAULT 0,
    page_number                                INTEGER,
    is_definitions_paragraph                     INTEGER DEFAULT 0,
    is_proviso_continuation                        INTEGER DEFAULT 0
);

CREATE TABLE rule_atoms (
    rule_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri             TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    operator                 TEXT,
    threshold_value             REAL,
    threshold_unit                TEXT,
    variable_text                   TEXT,
    variable_name                     TEXT,
    value_source                        TEXT CHECK (value_source IN ('direct_report','graph_aggregate')),
    match_evidence                        TEXT
);

CREATE TABLE definitions (
    def_id               INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri              TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    doc_id                    TEXT NOT NULL REFERENCES documents(doc_id),
    term                        TEXT,
    definition_text               TEXT NOT NULL,
    sub_clause_number               INTEGER,
    page_number                        INTEGER
);

CREATE TABLE cross_references (
    ref_id                INTEGER PRIMARY KEY AUTOINCREMENT,
    from_clause_uri          TEXT NOT NULL REFERENCES clause_registry(clause_uri),
    doc_id                      TEXT NOT NULL REFERENCES documents(doc_id),
    ref_type                      TEXT,
    target_paragraph                TEXT,
    target_sub_clause                  TEXT,
    range_end                            TEXT,
    target_annex                           TEXT,
    resolved_target_clause_uri               TEXT
);

CREATE TABLE semantic_chunks (
    chunk_id              INTEGER PRIMARY KEY AUTOINCREMENT,
    clause_uri               TEXT NOT NULL,
    doc_id                      TEXT NOT NULL REFERENCES documents(doc_id),
    chunk_text                    TEXT NOT NULL,
    raw_text                        TEXT NOT NULL,
    chunk_index                       INTEGER,
    boundary_type                       TEXT
);

CREATE INDEX idx_clause_doc ON clause_registry(doc_id);
CREATE INDEX idx_clause_type ON clause_registry(clause_type);
CREATE INDEX idx_ruleatoms_clause ON rule_atoms(clause_uri);
CREATE INDEX idx_definitions_doc ON definitions(doc_id);
CREATE INDEX idx_crossref_from ON cross_references(from_clause_uri);
CREATE INDEX idx_chunks_clause ON semantic_chunks(clause_uri);
"""

CATEGORY_SLUG = {
    "Regional_Rural_Bank": "rrb", "Urban_Cooperative_Bank": "ucb",
    "Rural_Cooperative_Bank": "rcb", "NBFC": "nbfc",
    "All_India_Financial_Institutions": "aifi", "Asset_Reconstruction_Companies": "arc",
    "Credit_Information_Services": "cic", "Non-Banking": "nb",
    "commercial banks": "cb", "local area banks": "lab",
    "payment banks": "pb", "small financial banks": "sfb",
}


def slug(cat: str) -> str:
    return CATEGORY_SLUG.get(cat, re.sub(r'[^a-z0-9]+', '-', cat.lower()).strip('-'))


def clause_uri_for(cat: str, doc_id: str, para_number) -> str:
    return f"rbi://{slug(cat)}/{doc_id}/para{para_number}"


def build_database(circulars_root: str, db_path: str):
    if os.path.exists(db_path):
        os.remove(db_path)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)

    files = glob.glob(os.path.join(circulars_root, "**", "*.[Pp][Dd][Ff]"), recursive=True)
    stats = {"docs": 0, "clauses": 0, "rule_atoms": 0, "definitions": 0,
              "cross_refs": 0, "chunks": 0, "quant": 0, "qual": 0, "rel": 0, "hybrid": 0,
              "low_confidence": 0}

    for fpath in files:
        rel = os.path.relpath(fpath, circulars_root)
        parts = rel.split(os.sep)
        institution_category = parts[0] if len(parts) > 1 else "uncategorized"

        pages = P._pdftotext_pages(fpath)
        is_legacy = P.is_legacy_template(pages)
        doc = P.parse_document(fpath, institution_category)

        conn.execute(
            "INSERT INTO documents (doc_id, file_path, institution_category, rbi_ref, dept_code, "
            "doc_date, title, template_variant, total_pages) VALUES (?,?,?,?,?,?,?,?,?)",
            (doc.doc_id, doc.file_path, institution_category, doc.rbi_ref,
             doc.dept_code, doc.date, doc.title,
             "legacy_decimal" if is_legacy else "directions", len(doc.raw_pages))
        )
        stats["docs"] += 1

        chunk_rows = []
        seen_uris: dict[str, int] = {}
        for para in doc.paragraphs:
            curi = clause_uri_for(institution_category, doc.doc_id, para.number)
            if curi in seen_uris:
                # Defensive de-duplication: a small number of source PDFs
                # produce a repeated paragraph number (e.g. a footnote marker
                # misread as a new top-level paragraph). Rather than crash
                # the whole document's ingestion on a UNIQUE constraint, or
                # silently drop the repeat, disambiguate it - and this is
                # exactly the kind of case that should be flagged for human
                # review in a production system.
                seen_uris[curi] += 1
                curi = f"{curi}-dup{seen_uris[curi]}"
            else:
                seen_uris[curi] = 0
            full_text = para.text
            if para.subclauses:
                full_text += " " + " ".join(f"({n}) {t}" for n, t, _ in para.subclauses)

            cls = C.classify_clause(full_text)
            conn.execute(
                "INSERT INTO clause_registry VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (curi, doc.doc_id, para.chapter_roman, para.chapter_title,
                 para.section_letter, para.section_title, str(para.number),
                 full_text, cls.clause_type, cls.confidence,
                 int(cls.needs_llm_refinement), para.page,
                 int(para.is_definitions_paragraph), int(para.is_proviso_continuation))
            )
            stats["clauses"] += 1
            type_key_map = {"quantitative": "quant", "qualitative": "qual",
                             "relational": "rel", "hybrid": "hybrid"}
            stats[type_key_map[cls.clause_type]] += 1
            if cls.confidence == "low":
                stats["low_confidence"] += 1

            if cls.rule_atom:
                ra = cls.rule_atom
                conn.execute(
                    "INSERT INTO rule_atoms (clause_uri, operator, threshold_value, "
                    "threshold_unit, variable_text, variable_name, value_source, match_evidence) "
                    "VALUES (?,?,?,?,?,?,?,?)",
                    (curi, ra["operator"], ra["threshold_value"], ra["threshold_unit"],
                     ra["variable_text"], ra["variable_name"], ra["value_source"], cls.match_evidence)
                )
                stats["rule_atoms"] += 1

            if para.is_definitions_paragraph:
                for d in C.extract_definitions(para):
                    conn.execute(
                        "INSERT INTO definitions (clause_uri, doc_id, term, definition_text, "
                        "sub_clause_number, page_number) VALUES (?,?,?,?,?,?)",
                        (curi, doc.doc_id, d["term"], d["definition_text"],
                         d["sub_clause_number"], d["page"])
                    )
                    stats["definitions"] += 1

            for ref in C.extract_cross_references(full_text, para.number):
                resolved = None
                if ref["ref_type"] == "paragraph":
                    resolved = clause_uri_for(institution_category, doc.doc_id, ref["target_paragraph"])
                conn.execute(
                    "INSERT INTO cross_references (from_clause_uri, doc_id, ref_type, "
                    "target_paragraph, target_sub_clause, range_end, target_annex, "
                    "resolved_target_clause_uri) VALUES (?,?,?,?,?,?,?,?)",
                    (curi, doc.doc_id, ref["ref_type"],
                     str(ref.get("target_paragraph", "")), str(ref.get("target_sub_clause", "")),
                     str(ref.get("range_end", "")), ref.get("target_annex", ""), resolved)
                )
                stats["cross_refs"] += 1

            cross_targets = [str(r["target_paragraph"]) for r in
                              C.extract_cross_references(full_text, para.number)
                              if r["ref_type"] == "paragraph"]
            for ch in CH.chunk_paragraph(curi, para, doc.title, cross_targets):
                conn.execute(
                    "INSERT INTO semantic_chunks (clause_uri, doc_id, chunk_text, raw_text, "
                    "chunk_index, boundary_type) VALUES (?,?,?,?,?,?)",
                    (ch.clause_uri, doc.doc_id, ch.chunk_text, ch.raw_text,
                     ch.chunk_index, ch.boundary_type)
                )
                stats["chunks"] += 1

    conn.commit()
    conn.close()
    return stats


if __name__ == "__main__":
    stats = build_database(
        "/home/claude/circulars/circulars",
        "/home/claude/rbi_pipeline/urcc_ef.db"
    )
    print(json.dumps(stats, indent=2))
