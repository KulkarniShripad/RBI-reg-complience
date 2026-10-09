"""Regulatory document processing (paper Sec. III, stage 1).

RBI PDFs -> pages (pypdf, the maintained successor of PyPDF2) -> cleaned lines
-> numbered clauses with stable identifiers and sentence splits.

Cleaning, all deterministic:
  * page numbers, contents-page lines (dot leaders) and repeated running
    headers / footers (same line at the top or bottom of >= 40% of pages);
  * Hindi (Devanagari) masthead lines and lines garbled by the PDF's font
    encoding (U+FFFD) are dropped - the operative text of RBI directions is English;
  * footnote / deletion markers such as "1[*****]" and the "3" in '(3) 3"Eligible';
  * Unicode NFKC normalisation and typographic cleanup;
  * words split by the PDF text layer ("concentrati on") are re-joined when the
    joined form is a frequent corpus word and a part is not (corpus-level pass).

Clauses: a line starting "N." with N continuing the paragraph sequence opens a
paragraph; "Chapter ..." / "A. Heading" lines update the section path; "Annex"
headings open annex clauses. Text before paragraph 1 is the preamble.

  python -m regcomp.ingest --pdfs ../circulars --out data/corpus
  -> data/corpus/docs.jsonl, data/corpus/clauses.jsonl
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import os
import re
import sys
from dataclasses import asdict, dataclass, field

from .text import normalize, script_of, split_sentences

RE_PAGE_NO = re.compile(r"^\s*(?:page\s*)?-?\s*\d{1,4}\s*-?(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.I)
RE_TOC = re.compile(r"\.{5,}\s*\d{1,4}\s*$")
RE_PARA = re.compile(r"^(\d{1,3})\.\s+(?=\S)")
RE_CHAPTER = re.compile(r"^(Chapter\s*[-–]?\s*[IVXLC]+[A-Z]?)\b(.*)$", re.I)
RE_SECTION = re.compile(r"^([A-Z])\.\s+([A-Z][^.]{2,90})$")
RE_SUBSECTION = re.compile(r"^[A-Z]\.\d{1,2}(?:\.\d{1,2})?\s+[A-Z][^.]{2,90}$")
RE_ANNEX = re.compile(r"^(Annex(?:ure)?\s*[-–]?\s*[IVXLC0-9]*)\b\s*[-–:]?\s*(.{0,90})$", re.I)
RE_RBI_REF = re.compile(r"RBI/[A-Za-z]+(?:/[A-Za-z]+)?/\d{4}-\d{2}/\d+")
RE_DATE = re.compile(r"\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s*\d{4}\b")
RE_FOOTNOTE_DEL = re.compile(r"\d{0,2}\[\*+\]")
RE_FOOTNOTE_QUOTE = re.compile(r"(?<=[)\s])\d{1,2}(?=\")")
RE_FOOTNOTE_BRACKET = re.compile(r"(?<=\s)\d{1,2}(?=\[[A-Za-z(])")


@dataclass
class Clause:
    clause_id: str
    doc_id: str
    key: str                      # "15", "annex-I", "preamble"
    kind: str                     # paragraph | annex | preamble
    section: list[str] = field(default_factory=list)
    page_start: int = 0
    page_end: int = 0
    text: str = ""
    sentences: list[str] = field(default_factory=list)


@dataclass
class Document:
    doc_id: str
    path: str
    title: str
    rbi_ref: str | None
    date: str | None
    category: str | None
    pages: int
    lines_kept: int
    lines_dropped: dict


def _doc_id(path: str) -> str:
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:10]


def read_pages(pdf_path: str) -> list[str]:
    import pypdf  # imported here so the rest of the package works without it

    reader = pypdf.PdfReader(pdf_path)
    return [(p.extract_text() or "") for p in reader.pages]


def _strip_markers(line: str) -> str:
    line = RE_FOOTNOTE_DEL.sub("", line)
    line = RE_FOOTNOTE_QUOTE.sub("", line)
    line = RE_FOOTNOTE_BRACKET.sub("", line)
    return re.sub(r"\s{2,}", " ", line).strip()


def clean_pages(pages: list[str]) -> tuple[list[list[str]], dict]:
    """Per-page cleaned lines plus counts of what was dropped and why."""
    raw = [[normalize(l) for l in p.splitlines()] for p in pages]
    raw = [[l for l in p if l] for p in raw]
    # running headers / footers: lines (digits masked) seen at the page edges on >= 40% of pages
    edge = collections.Counter()
    for p in raw:
        seen = set()
        for l in p[:3] + p[-3:]:
            k = re.sub(r"\d+", "#", l.lower())
            if k not in seen and len(k) > 3:
                seen.add(k)
                edge[k] += 1
    n = max(1, len(raw))
    repeated = {k for k, c in edge.items() if c >= 3 and c / n >= 0.4}
    dropped = collections.Counter()
    out = []
    for p in raw:
        kept = []
        for i, l in enumerate(p):
            at_edge = i < 3 or i >= len(p) - 3
            if RE_PAGE_NO.match(l):
                dropped["page_number"] += 1
            elif RE_TOC.search(l):
                dropped["contents"] += 1
            elif script_of(l) != "latin":
                dropped["devanagari_or_garbled"] += 1
            elif at_edge and re.sub(r"\d+", "#", l.lower()) in repeated:
                dropped["header_footer"] += 1
            else:
                s = _strip_markers(l)
                if s:
                    kept.append(s)
        out.append(kept)
    return out, dict(dropped)


def _title_ref_date(first_lines: list[str]) -> tuple[str, str | None, str | None]:
    blob = " ".join(first_lines[:40])
    ref = RE_RBI_REF.search(blob)
    date = RE_DATE.search(blob)
    title = ""
    for i, l in enumerate(first_lines[:40]):
        if re.search(r"(Directions|Master Direction|Guidelines|Circular)\b", l) and not RE_RBI_REF.search(l):
            title = l
            nxt = first_lines[i + 1] if i + 1 < len(first_lines) else ""
            if nxt and not RE_DATE.search(nxt) and len(title) < 140 and not nxt.lower().startswith(("table of contents", "chapter", "1.")):
                title = f"{title} {nxt}"
            break
        if l.startswith("Reserve Bank of India (") or l.startswith("Master Direction"):
            title = " ".join(first_lines[i:i + 2])
            break
    return (title.strip() or (first_lines[0] if first_lines else "")), (ref.group(0) if ref else None), (date.group(0) if date else None)


def segment(doc_id: str, page_lines: list[list[str]]) -> list[Clause]:
    clauses: list[Clause] = []
    section: list[str] = []
    last = 0
    cur: Clause | None = None
    preamble = Clause(f"{doc_id}:preamble", doc_id, "preamble", "preamble", [], 1, 1, "")
    annex_n = 0
    keys = collections.Counter()

    def close():
        nonlocal cur
        if cur is not None and cur.text.strip():
            clauses.append(cur)
        cur = None

    for pno, lines in enumerate(page_lines, start=1):
        for l in lines:
            ch = RE_CHAPTER.match(l)
            an = RE_ANNEX.match(l)
            pm = RE_PARA.match(l)
            se = RE_SECTION.match(l)
            if ch and len(l) < 120:
                close()
                section = [l]
                continue
            if an and len(l) < 100 and last > 0 and not l.rstrip().endswith((",", ";")):
                close()
                annex_n += 1
                key = f"annex-{annex_n}"
                cur = Clause(f"{doc_id}:{key}", doc_id, key, "annex", [l], pno, pno, "")
                section = [l]
                continue
            if pm:
                n = int(pm.group(1))
                if last < n <= last + 5 or (last == 0 and n == 1):
                    close()
                    last = n
                    key = str(n)
                    keys[key] += 1
                    if keys[key] > 1:
                        key = f"{n}-{keys[key]}"
                    cur = Clause(f"{doc_id}:{key}", doc_id, key, "paragraph", list(section), pno, pno, l[pm.end():])
                    continue
            # section / sub-section headings ("C. Governance Framework", "C.1 Outsourcing
            # Policy") label the paragraphs that follow; they are not clause text
            if (se or RE_SUBSECTION.match(l)) and len(l) < 100 and not l.rstrip().endswith((".", ";", ",")):
                section = section[:1] + [l]
                continue
            target = cur if cur is not None else preamble
            if target is preamble and not preamble.text:
                preamble.page_start = pno
            target.text = f"{target.text}\n{l}" if target.text else l
            target.page_end = pno
    close()
    if preamble.text.strip():
        clauses.insert(0, preamble)
    return clauses


def repair_split_words(clauses: list[Clause], min_freq: int = 3) -> int:
    """Corpus-level repair of words split by the PDF text layer."""
    vocab = collections.Counter()
    for c in clauses:
        vocab.update(w.lower() for w in re.findall(r"[A-Za-z]+", c.text))
    fixed = 0

    def should_join(a: str, b: str) -> bool:
        if not (a.isalpha() and b.isalpha() and b[:1].islower()):
            return False
        j = vocab.get((a + b).lower(), 0)
        rarer = min(vocab.get(a.lower(), 0), vocab.get(b.lower(), 0))
        # the joined word must be common and clearly more common than the rarer
        # fragment (fragments of a broken word recur, so "rare" alone is not enough)
        return j >= min_freq and j >= 5 * max(rarer, 1)

    def repair(text: str) -> str:
        nonlocal fixed
        # hyphenated compounds broken at the wrap: "high- risk", "up -to-date"
        text, n1 = re.subn(r"(?<=[A-Za-z])-[ \n](?=[a-z])", "-", text)
        text, n2 = re.subn(r"(?<=[A-Za-z]) -(?=[a-z]{2,})", "-", text)  # "low -risk": space before, none after
        fixed += n1 + n2
        # alternating [word, separator, word, ...]; a join removes the separator,
        # including a line break (words split across PDF lines)
        parts = re.split(r"([ \n]+)", text)
        out: list[str] = []
        i = 0
        while i < len(parts):
            a = parts[i]
            if i + 2 < len(parts):
                ma = re.match(r"^(\W*)([A-Za-z]+)$", a)
                mb = re.match(r"^([a-z]+)(\W*)$", parts[i + 2])
                if ma and mb and should_join(ma.group(2), mb.group(1)):
                    parts[i + 2] = ma.group(1) + ma.group(2) + mb.group(1) + mb.group(2)
                    fixed += 1
                    i += 2
                    continue
            out.append(a)
            i += 1
        return "".join(out)

    for c in clauses:
        c.text = repair(c.text)
    return fixed


def category_of(path: str) -> str | None:
    parts = os.path.normpath(path).split(os.sep)
    return parts[-2] if len(parts) >= 2 and parts[-2] != "circulars" else None


def ingest(pdf_paths: list[str], root: str | None = None) -> tuple[list[Document], list[Clause], dict]:
    docs, clauses = [], []
    for path in pdf_paths:
        rel = os.path.relpath(path, root) if root else path
        try:
            pages = read_pages(path)
        except Exception as e:  # unreadable PDF: report, continue
            print(f"[ingest] skipped {rel}: {e}", file=sys.stderr)
            continue
        page_lines, dropped = clean_pages(pages)
        flat = [l for p in page_lines for l in p]
        title, ref, date = _title_ref_date(flat)
        did = _doc_id(rel)
        cl = segment(did, page_lines)
        docs.append(Document(did, rel, title, ref, date, category_of(rel), len(pages), len(flat), dropped))
        clauses.extend(cl)
    fixed = repair_split_words(clauses)
    for c in clauses:
        c.text = re.sub(r"[ \t]+", " ", c.text).strip()
        c.sentences = split_sentences(c.text)
    stats = {"documents": len(docs), "clauses": len(clauses), "split_words_repaired": fixed,
             "paragraph_clauses": sum(c.kind == "paragraph" for c in clauses)}
    return docs, clauses, stats


def write_jsonl(path: str, rows) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for r in rows:
            f.write(json.dumps(asdict(r) if hasattr(r, "__dataclass_fields__") else r, ensure_ascii=False) + "\n")


def read_jsonl(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdfs", required=True, help="folder with RBI PDFs (searched recursively)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    a = ap.parse_args(argv)
    paths = sorted(os.path.join(d, f) for d, _, fs in os.walk(a.pdfs) for f in fs if f.lower().endswith(".pdf"))
    if a.limit:
        paths = paths[: a.limit]
    docs, clauses, stats = ingest(paths, root=a.pdfs)
    os.makedirs(a.out, exist_ok=True)
    write_jsonl(os.path.join(a.out, "docs.jsonl"), docs)
    write_jsonl(os.path.join(a.out, "clauses.jsonl"), clauses)
    with open(os.path.join(a.out, "stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    print(json.dumps(stats))


if __name__ == "__main__":
    main()
