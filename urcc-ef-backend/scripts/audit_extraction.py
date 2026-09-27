"""
Extraction audit: verifies a built urcc_ef.db against the actual PDFs in
the circulars folder, so extraction quality is MEASURED, not assumed.

What it reports (per document and corpus-wide):
  - coverage        share of the PDF's words (TOC and page numbers excluded)
                    that made it into the database in any searchable form
                    (clauses, annexes, preamble, footnotes). Low coverage
                    means text was silently dropped.
  - zero-clause docs documents that produced no clauses at all
  - numbering gaps   paragraph numbers missing from an otherwise continuous
                    1..N sequence (dropped or merged paragraphs)
  - cut-off clauses  clauses whose text ends mid-sentence
  - page-number /   PDF furniture that leaked into clause text
    footnote leakage
  - duplicates       the same PDF (by content hash) ingested more than once
  - categories       every institution category value present in the DB

Works against both the original schema and the rebuilt one. Documents are
matched to PDFs by content hash when the DB stores one (pdf_sha256), else
by file name.

Usage:
  python3 audit_extraction.py --db ../data/urcc_ef.db --circulars ../../circulars [--json out.json] [--worst 15]
"""
import argparse
import collections
import glob
import hashlib
import json
import os
import re
import sqlite3
import sys

import pymupdf

WORD = re.compile(r"[a-z][a-z0-9]{2,}")
DOTTED_LEADER = re.compile(r"(\.\s?){4,}\s*\d{0,4}\s*$|…{2,}")
PAGE_NO = re.compile(r"^\s*(page\s*)?\d{1,4}(\s*(of|/)\s*\d{1,4})?\s*$", re.I)
FOOTNOTE_LEAK = re.compile(
    r"\b(inserted|substituted|deleted|amended|added)\s+(vide|with effect|w\.e\.f)", re.I)
TRAILING_PAGE_NO = re.compile(r"[.;:]\s+\d{1,3}$")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def pdf_words(path):
    """Word multiset of the PDF body, excluding TOC leader lines and bare page numbers."""
    counts = collections.Counter()
    with pymupdf.open(path) as doc:
        for page in doc:
            for line in page.get_text("text").splitlines():
                if not line.strip() or DOTTED_LEADER.search(line) or PAGE_NO.match(line):
                    continue
                counts.update(WORD.findall(line.lower()))
    return counts


def table_exists(conn, name):
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?", (name,)
    ).fetchone() is not None


def columns(conn, table):
    return {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}


def stored_text_by_doc(conn):
    """All searchable text the DB holds for each document, whatever the schema."""
    text = collections.defaultdict(list)
    has_heads = "heading_path" in columns(conn, "clause_registry")
    sql = "SELECT doc_id, clause_text" + (", heading_path" if has_heads else ", ''") + " FROM clause_registry"
    heads_seen = set()
    for doc_id, t, h in conn.execute(sql):
        text[doc_id].append(t or "")
        for part in (h or "").split(" > "):         # headings are stored once per document
            if part and (doc_id, part) not in heads_seen:
                heads_seen.add((doc_id, part))
                text[doc_id].append(part)
    for extra in ("annexes", "footnotes"):
        if table_exists(conn, extra):
            col = "annex_text" if extra == "annexes" else "footnote_text"
            for doc_id, t in conn.execute(f"SELECT doc_id, {col} FROM {extra}"):
                text[doc_id].append(t or "")
    return text


def numbering_gaps(numbers):
    ints = sorted({int(n) for n in numbers if re.fullmatch(r"\d{1,3}", str(n))})
    if len(ints) < 3:
        return []
    return [n for n in range(1, ints[-1] + 1) if n not in set(ints)]


def ends_mid_sentence(text):
    t = (text or "").rstrip()
    if not t:
        return True
    return t[-1].isalpha() or t[-1] in ",-–(" or bool(TRAILING_PAGE_NO.search(t))


def boundary_fidelity(conn, doc_pdf: dict, sample: int, seed: int = 13):
    """For a random sample of flat-numbered paragraphs N, find "N." and the
    next paragraph's number in the raw PDF text and compare the words in
    between with the stored clause (recall = share of the PDF span's words
    present in the stored clause; precision = share of stored words found
    in that span). Independent of the parser's own line handling."""
    import random
    rows = conn.execute(
        "SELECT cr.doc_id, cr.paragraph_number, cr.clause_text, cr.page_number FROM clause_registry cr "
        "WHERE cr.paragraph_number GLOB '[0-9]*' AND cr.paragraph_number NOT GLOB '*[^0-9]*'").fetchall()
    cols = columns(conn, "clause_registry")
    has_seq = "seq" in cols and "heading_path" in cols
    numbers = collections.defaultdict(set)
    for d, n, _, _ in rows:
        numbers[d].add(int(n))
    rng = random.Random(seed)
    rng.shuffle(rows)
    results = []
    cache = {}
    for doc_id, num, text, page in rows:
        if len(results) >= sample or doc_id not in doc_pdf:
            continue
        n = int(num)
        nxt = min((m for m in numbers[doc_id] if m > n), default=None)
        if nxt is None:
            continue
        if doc_id not in cache:
            with pymupdf.open(doc_pdf[doc_id]) as d:
                texts = [p.get_text("text") for p in d]
            offsets, pos = [], 0
            for t in texts:
                offsets.append(pos)
                pos += len(t) + 1
            cache[doc_id] = ("\n".join(texts), offsets)
        full, offsets = cache[doc_id]
        starts = [m.start() for m in re.finditer(rf"(?m)^\s*\[?\s*{n}\.\s", full)]
        if not starts:
            continue
        # The same number also appears in TOCs, annex forms and tables; take
        # the occurrence on the page where the paragraph is recorded (or the
        # nearest one) - otherwise the check measures the wrong span.
        page_of = lambda off: max(i for i, o in enumerate(offsets) if o <= off) + 1
        start = min(starts, key=lambda s: abs(page_of(s) - (page or 1)))
        ends = [start + 3 + m.start() for m in re.finditer(rf"(?m)^\s*\[?\s*{nxt}\.\s", full[start + 3:])]
        if not ends:
            continue
        nxt_page = conn.execute("SELECT page_number FROM clause_registry WHERE doc_id = ? AND paragraph_number = ?",
                                (doc_id, str(nxt))).fetchone()
        end = min(ends, key=lambda e: abs(page_of(e) - ((nxt_page[0] if nxt_page else None) or page_of(ends[0]))))
        span = full[start:end]
        if has_seq:
            # Text the parser kept between N and N+1 in other places still
            # counts as kept: unnumbered blocks (N.u1 ...) and the headings of
            # paragraph N+1 (stored in heading_path).
            extra = conn.execute(
                "SELECT clause_text, heading_path, paragraph_number FROM clause_registry WHERE doc_id = ? AND seq > "
                "(SELECT seq FROM clause_registry WHERE doc_id = ? AND paragraph_number = ?) AND seq <= "
                "(SELECT seq FROM clause_registry WHERE doc_id = ? AND paragraph_number = ?)",
                (doc_id, doc_id, str(n), doc_id, str(nxt))).fetchall()
            kept_elsewhere = " ".join((h or "") + (" " + t if p != str(nxt) else "") for t, h, p in extra)
        else:
            kept_elsewhere = ""
        span = "\n".join(l for l in span.splitlines() if not PAGE_NO.match(l))
        want = collections.Counter(WORD.findall(span.lower()))
        own = collections.Counter(WORD.findall((text or "").lower()))
        kept = own + collections.Counter(WORD.findall(kept_elsewhere.lower()))
        if sum(want.values()) < 5:
            continue
        recall = sum(min(c, kept[w]) for w, c in want.items()) / sum(want.values())
        precision = sum(min(c, want[w]) for w, c in own.items()) / max(sum(own.values()), 1)
        results.append({"doc_id": doc_id, "paragraph": n, "recall": recall, "precision": precision})
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--circulars", required=True)
    ap.add_argument("--json", help="write the full per-document report here")
    ap.add_argument("--worst", type=int, default=15, help="how many lowest-coverage docs to print")
    ap.add_argument("--boundary-sample", type=int, default=0,
                    help="also check N random numbered paragraphs against the PDF text between 'N.' and the next number")
    args = ap.parse_args()

    conn = sqlite3.connect(args.db)
    doc_cols = columns(conn, "documents")
    has_hash = "pdf_sha256" in doc_cols

    pdfs = glob.glob(os.path.join(args.circulars, "**", "*.[Pp][Dd][Ff]"), recursive=True)
    by_hash, by_name = {}, collections.defaultdict(list)
    for p in pdfs:
        by_hash.setdefault(sha256_file(p), p)
        by_name[os.path.basename(p)].append(p)

    docs = conn.execute(
        f"SELECT doc_id, file_path, institution_category, rbi_ref, title"
        f"{', pdf_sha256' if has_hash else ''} FROM documents").fetchall()
    stored = stored_text_by_doc(conn)
    clauses_by_doc = collections.defaultdict(list)
    for doc_id, num, t in conn.execute(
            "SELECT doc_id, paragraph_number, clause_text FROM clause_registry"):
        clauses_by_doc[doc_id].append((num, t))

    # --- duplicates: same bytes ingested more than once ---
    doc_hash = {}
    for d in docs:
        if has_hash and d[5]:
            doc_hash[d[0]] = d[5]
        else:
            cands = by_name.get(os.path.basename(d[1]), [])
            doc_hash[d[0]] = sha256_file(cands[0]) if cands else None
    hash_groups = collections.defaultdict(list)
    for doc_id, h in doc_hash.items():
        if h:
            hash_groups[h].append(doc_id)
    duplicates = [ids for ids in hash_groups.values() if len(ids) > 1]

    report = []
    for d in docs:
        doc_id, fpath, cat, ref, title = d[:5]
        pdf = by_hash.get(doc_hash.get(doc_id)) if doc_hash.get(doc_id) else None
        clauses = clauses_by_doc.get(doc_id, [])
        row = {
            "doc_id": doc_id, "category": cat, "rbi_ref": ref,
            "title": (title or "")[:120], "file": os.path.basename(fpath),
            "clauses": len(clauses),
            "cut_off_clauses": sum(1 for _, t in clauses if ends_mid_sentence(t)),
            "page_number_leaks": sum(1 for _, t in clauses if TRAILING_PAGE_NO.search((t or "").rstrip())),
            "footnote_leaks": sum(1 for _, t in clauses if FOOTNOTE_LEAK.search(t or "")),
            "numbering_gaps": numbering_gaps([n for n, _ in clauses]),
            "pdf_found": bool(pdf), "coverage": None,
        }
        if pdf:
            want = pdf_words(pdf)
            have = collections.Counter(WORD.findall(" ".join(stored.get(doc_id, [])).lower()))
            total = sum(want.values())
            got = sum(min(c, have[w]) for w, c in want.items())
            row["coverage"] = round(got / total, 4) if total else None
        report.append(row)

    n = len(report)
    all_clauses = sum(r["clauses"] for r in report)
    covs = [r["coverage"] for r in report if r["coverage"] is not None]
    categories = collections.Counter(r["category"] for r in report)
    summary = {
        "documents_in_db": n,
        "pdfs_in_folder": len(pdfs),
        "distinct_pdfs_in_folder": len(by_hash),
        "docs_matched_to_a_pdf": sum(1 for r in report if r["pdf_found"]),
        "docs_without_matching_pdf": [r["file"] for r in report if not r["pdf_found"]],
        "duplicate_doc_groups": duplicates,
        "zero_clause_docs": sum(1 for r in report if r["clauses"] == 0),
        "clauses": all_clauses,
        "cut_off_clause_pct": round(100 * sum(r["cut_off_clauses"] for r in report) / max(all_clauses, 1), 2),
        "page_number_leak_clauses": sum(r["page_number_leaks"] for r in report),
        "footnote_leak_clauses": sum(r["footnote_leaks"] for r in report),
        "docs_with_numbering_gaps": sum(1 for r in report if r["numbering_gaps"]),
        "mean_coverage_pct": round(100 * sum(covs) / len(covs), 2) if covs else None,
        "docs_below_80pct_coverage": sum(1 for c in covs if c < 0.8),
        "docs_below_50pct_coverage": sum(1 for c in covs if c < 0.5),
        "categories": dict(categories),
    }

    if args.boundary_sample:
        doc_pdf = {}
        for d in docs:
            h = doc_hash.get(d[0])
            if h and h in by_hash:
                doc_pdf[d[0]] = by_hash[h]
        res = boundary_fidelity(conn, doc_pdf, args.boundary_sample)
        if res:
            summary["boundary_sample"] = {
                "paragraphs_checked": len(res),
                "mean_recall": round(sum(r["recall"] for r in res) / len(res), 4),
                "mean_precision": round(sum(r["precision"] for r in res) / len(res), 4),
                "recall_below_0.9": sum(1 for r in res if r["recall"] < 0.9),
                "precision_below_0.9": sum(1 for r in res if r["precision"] < 0.9),
            }
            summary["boundary_worst"] = sorted(res, key=lambda r: min(r["recall"], r["precision"]))[:8]
    print(json.dumps(summary, indent=2))
    print(f"\nLowest-coverage documents (worst {args.worst}):")
    for r in sorted([r for r in report if r["coverage"] is not None], key=lambda r: r["coverage"])[: args.worst]:
        gaps = r["numbering_gaps"]
        print(f"  {100 * r['coverage']:5.1f}%  clauses={r['clauses']:4d}  gaps={len(gaps):3d}  "
              f"[{r['category']}] {r['rbi_ref'] or '-'}  {r['title'][:70]}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"summary": summary, "documents": report}, f, indent=2)
        print(f"\nfull report written to {args.json}")


if __name__ == "__main__":
    sys.exit(main())
