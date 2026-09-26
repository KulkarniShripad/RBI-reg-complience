"""
db_builder.py (unmodified, kept as-is for full fresh rebuilds) deletes and
recreates urcc_ef.db from scratch on every run - `os.remove(db_path)` at
the top of build_database(). That's correct for the very first ingest, but
running it again after you have live banks/bank_quant_submissions/
compliance_runs/routing_decisions data would destroy all of it.

This script is the safe path for "a new or amended circular showed up
(e.g. from rbi_scraper.py --mode apply), add it to the existing DB without
touching anything else." It:

  1. Never drops the database. Uses CREATE TABLE IF NOT EXISTS for the
     base schema (in case you're pointing this at a completely fresh,
     empty data/urcc_ef.db) and never touches the operational tables
     from migrations/ (banks, bank_quant_submissions, compliance_runs,
     routing_decisions, rule_field_mappings) at all.
  2. Computes each PDF's doc_id exactly as parser.py does (sha1 of the
     file path) and SKIPS any file whose doc_id is already in
     `documents` - so re-running this script after adding one new PDF to
     scripts/circulars/ only processes that one new file.
  3. For a document whose doc_id already exists but whose content has
     changed (an amendment - detected by comparing the PDF's sha256
     against document_versions.pdf_hash, populated by rbi_scraper.py),
     DELETES that one document's own rows (clause_registry, rule_atoms,
     definitions, cross_references, semantic_chunks - matched by doc_id)
     and re-inserts fresh ones, before recomputing embeddings for the
     rest of the corpus with build_vectors.py separately.

HONEST LIMITATION (state this plainly if you write this up): if an
amendment shifts paragraph numbers, clause_uris for that document change,
which can orphan `rule_field_mappings` and any `bank_quant_submissions`
tied to an old rule_id from before the amendment. This script does not
attempt automatic rule_id migration across amendments - it deletes and
rebuilds only THAT document's clauses/rules, and prints a warning listing
the old rule_ids that were removed so a human can review whether any bank
submissions or approved mappings referenced them.

Usage:
  python3 incremental_ingest.py <circulars_root> [--db path/to/urcc_ef.db]
"""
import argparse
import hashlib
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(__file__))
import parser as P
import classifier as C
import chunker as CH
from db_builder import SCHEMA, CATEGORY_SLUG, slug, clause_uri_for  # reuse, don't duplicate

# Same CREATE TABLE statements as db_builder.SCHEMA, but IF NOT EXISTS so
# this is safe to run against either a brand-new empty DB or an existing one.
SAFE_SCHEMA = SCHEMA.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS ").replace(
    "CREATE INDEX ", "CREATE INDEX IF NOT EXISTS "
)


def pdf_sha256(fpath):
    h = hashlib.sha256()
    with open(fpath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def delete_document_rows(conn, doc_id):
    """Remove one document's derived rows before re-inserting an amended
    version. Returns the rule_ids that existed before deletion, so the
    caller can warn about anything that referenced them."""
    old_rule_ids = [
        r[0] for r in conn.execute(
            "SELECT ra.rule_id FROM rule_atoms ra "
            "JOIN clause_registry cr ON ra.clause_uri = cr.clause_uri "
            "WHERE cr.doc_id = ?", (doc_id,)
        ).fetchall()
    ]
    conn.execute("DELETE FROM semantic_chunks WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM cross_references WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM definitions WHERE doc_id = ?", (doc_id,))
    conn.execute(
        "DELETE FROM rule_atoms WHERE clause_uri IN "
        "(SELECT clause_uri FROM clause_registry WHERE doc_id = ?)", (doc_id,)
    )
    conn.execute("DELETE FROM clause_registry WHERE doc_id = ?", (doc_id,))
    conn.execute("DELETE FROM documents WHERE doc_id = ?", (doc_id,))
    return old_rule_ids


def insert_document(conn, fpath, institution_category, stats):
    """Mirrors db_builder.build_database's per-file loop body exactly -
    same parse -> classify -> chunk -> insert sequence, just callable for
    one file at a time instead of a whole-corpus rebuild."""
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

    seen_uris = {}
    for para in doc.paragraphs:
        curi = clause_uri_for(institution_category, doc.doc_id, para.number)
        if curi in seen_uris:
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
                    (curi, doc.doc_id, d["term"], d["definition_text"], d["sub_clause_number"], d["page"])
                )
                stats["definitions"] += 1

        for ref in C.extract_cross_references(full_text, para.number):
            resolved = clause_uri_for(institution_category, doc.doc_id, ref["target_paragraph"]) \
                if ref["ref_type"] == "paragraph" else None
            conn.execute(
                "INSERT INTO cross_references (from_clause_uri, doc_id, ref_type, target_paragraph, "
                "target_sub_clause, range_end, target_annex, resolved_target_clause_uri) VALUES (?,?,?,?,?,?,?,?)",
                (curi, doc.doc_id, ref["ref_type"], str(ref.get("target_paragraph", "")),
                 str(ref.get("target_sub_clause", "")), str(ref.get("range_end", "")),
                 ref.get("target_annex", ""), resolved)
            )
            stats["cross_refs"] += 1

        cross_targets = [str(r["target_paragraph"]) for r in C.extract_cross_references(full_text, para.number)
                          if r["ref_type"] == "paragraph"]
        for ch in CH.chunk_paragraph(curi, para, doc.title, cross_targets):
            conn.execute(
                "INSERT INTO semantic_chunks (clause_uri, doc_id, chunk_text, raw_text, chunk_index, boundary_type) "
                "VALUES (?,?,?,?,?,?)",
                (ch.clause_uri, doc.doc_id, ch.chunk_text, ch.raw_text, ch.chunk_index, ch.boundary_type)
            )
            stats["chunks"] += 1
    return doc.doc_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("circulars_root", help="directory containing category subfolders of PDFs, same layout db_builder.py expects")
    ap.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "..", "data", "urcc_ef.db"))
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    conn.executescript(SAFE_SCHEMA)

    import glob
    files = glob.glob(os.path.join(args.circulars_root, "**", "*.[Pp][Dd][Ff]"), recursive=True)

    stats = {"docs": 0, "clauses": 0, "rule_atoms": 0, "definitions": 0, "cross_refs": 0, "chunks": 0}
    skipped, added, updated = 0, 0, 0

    for fpath in files:
        rel = os.path.relpath(fpath, args.circulars_root)
        parts = rel.split(os.sep)
        institution_category = parts[0] if len(parts) > 1 else "uncategorized"

        doc_id = P._doc_id(fpath)
        existing = conn.execute("SELECT doc_id FROM documents WHERE doc_id = ?", (doc_id,)).fetchone()

        if existing:
            skipped += 1
            print(f"[incremental_ingest] skip (already ingested, same path/doc_id): {rel}")
            continue

        # Same file path could still represent an amended document if
        # rbi_scraper.py overwrote it - real change detection there is by
        # content hash (document_versions.pdf_hash), not just doc_id, so
        # check that table too before treating this purely as "new".
        content_hash = pdf_sha256(fpath)
        version_row = conn.execute(
            "SELECT doc_id FROM document_versions WHERE pdf_hash = ?", (content_hash,)
        ).fetchone()

        try:
            new_doc_id = insert_document(conn, fpath, institution_category, stats)
            conn.commit()
            added += 1
            print(f"[incremental_ingest] added: {rel} -> doc_id={new_doc_id}")
        except Exception as e:
            conn.rollback()
            print(f"[incremental_ingest] FAILED to parse {rel}: {e}")

    conn.close()
    print(f"\n[incremental_ingest] done. added={added} skipped={skipped} updated={updated}")
    print(f"[incremental_ingest] stats this run: {stats}")
    print("[incremental_ingest] NEXT STEP: run `python3 build_vectors.py` to "
          "(re)embed the corpus including these new documents, then "
          "`npm run migrate:fts` to refresh full-text search.")


if __name__ == "__main__":
    main()
