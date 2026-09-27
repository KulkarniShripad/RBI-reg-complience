"""
Layout-aware text extraction for RBI PDFs (stage 0 of the pipeline).

Why this exists: the original pipeline read `pdftotext -layout` output line
by line. That output has no font information, so it could not tell a page
number from a paragraph number, a footnote from body text, or a bold chapter
heading from a sentence that happens to start with "Chapter VII of these
Directions...". Measured against the corpus, that caused ~1,800 clauses to
end with a stray page number and whole documents to be dropped (see
audit_extraction.py).

PyMuPDF exposes, per text span: position, font size, bold flag and
superscript flag. With those, this module produces clean *visual lines*:

  - spans on the same baseline are merged in x-order, so "4." (x=72) and
    "(1) In these Directions ..." (x=108) become one line;
  - footnote reference markers (superscript / much smaller digits glued to
    text, e.g. the "1" in "1[(iiia) ...") are removed;
  - footnote text (small font, bottom of page) is split out and kept
    separately rather than merged into the clause above it;
  - page numbers and running headers/footers are dropped;
  - table-like rows (cells separated by wide horizontal gaps) are joined
    with " | " so they read as rows instead of run-on text.

No LLM is used here; everything is deterministic and inspectable.
"""
from __future__ import annotations

import collections
import re
from dataclasses import dataclass, field

import pymupdf

PAGE_NO = re.compile(r"^\s*(?:page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(?:\s*(?:of|/)\s*\d{1,4})?\s*$", re.I)
MARKER_TEXT = re.compile(r"^\s*[\d*†‡#]{1,3}\s*$")
DEVANAGARI = re.compile(r"[ऀ-ॿ]")


@dataclass
class Line:
    page: int                  # 1-based page number
    y: float                   # baseline-ish top coordinate
    x0: float                  # left edge of the first span
    text: str
    size: float                # dominant font size of the line
    bold: bool                 # majority of characters bold
    is_table_row: bool = False
    leading_marker: bool = False   # line began with a (removed) footnote marker


@dataclass
class ExtractedDocument:
    lines: list[Line]
    footnotes: list[tuple[int, str]]          # (page, text)
    page_count: int
    body_size: float
    left_margin: float
    raw_page_text: list[str] = field(default_factory=list)


def _is_bold(span) -> bool:
    return bool(span["flags"] & 16) or "bold" in span["font"].lower() or "black" in span["font"].lower()


def _raw_rows(page):
    """PyMuPDF lines -> spans with footnote markers removed, then merged
    into visual rows by baseline (so "4." at x=72 and "(1) In these ..." at
    x=108 become one row)."""
    lines = []
    for block in page.get_text("dict")["blocks"]:
        for line in block.get("lines", []):
            if abs(line["dir"][1]) > 0.2:      # rotated text (stamps, margins) is never body text
                continue
            spans = [s for s in line["spans"] if s["text"].strip()]
            if not spans:
                continue
            biggest = max(s["size"] for s in spans)
            kept = []
            first_x = min(s["bbox"][0] for s in spans)
            lead = False
            for s in spans:
                # A footnote reference marker is a short digit/symbol span
                # that is superscript, or clearly smaller than the text it
                # is attached to ("1" in "1[(iiia) ...", "2" in "2013.2").
                if MARKER_TEXT.match(s["text"]) and (s["flags"] & 1 or (len(spans) > 1 and s["size"] <= biggest * 0.8)):
                    if s["bbox"][0] <= first_x + 0.5:
                        lead = True
                    continue
                kept.append(s)
            if kept:
                kept[0] = dict(kept[0], _lead=lead)
                lines.append(kept)

    lines.sort(key=lambda ss: (round(max(s["bbox"][3] for s in ss), 0), ss[0]["bbox"][0]))
    rows: list[list] = []
    for ss in lines:
        bottom = max(s["bbox"][3] for s in ss)
        size = max(s["size"] for s in ss)
        if rows and abs(max(s["bbox"][3] for s in rows[-1]) - bottom) <= max(2.5, size * 0.3):
            rows[-1].extend(ss)
        else:
            rows.append(list(ss))

    out = []
    for row in rows:
        row.sort(key=lambda s: s["bbox"][0])
        parts = []
        prev_end = None
        for s in row:
            if prev_end is not None:
                gap = s["bbox"][0] - prev_end
                parts.append(" | " if gap > max(24.0, s["size"] * 2.2) else ("" if gap < 0.8 else " "))
            parts.append(s["text"])
            prev_end = s["bbox"][2]
        text = re.sub(r"[ \t\u00a0]+", " ", "".join(parts)).strip()
        if not text:
            continue
        weight = collections.Counter()
        bold_chars = 0
        for s in row:
            n = len(s["text"].strip())
            weight[round(s["size"], 1)] += n
            if _is_bold(s):
                bold_chars += n
        total = sum(weight.values()) or 1
        out.append(Line(
            page=page.number + 1, y=min(s["bbox"][1] for s in row), x0=row[0]["bbox"][0],
            text=text, size=weight.most_common(1)[0][0], bold=bold_chars / total > 0.6,
            is_table_row=" | " in text, leading_marker=bool(row[0].get("_lead")),
        ))
    return out


def _prose_font_size(pages) -> float:
    """Dominant font size of running prose (long, non-table lines). Using
    all characters instead would let a table-heavy document (financial
    statement formats) report its table font as the body size."""
    sizes = collections.Counter()
    for lines, _ in pages:
        for ln in lines:
            if len(ln.text) >= 50 and not ln.is_table_row:
                sizes[round(ln.size)] += len(ln.text)
    if not sizes:
        for lines, _ in pages:
            for ln in lines:
                sizes[round(ln.size)] += len(ln.text)
    return float(sizes.most_common(1)[0][0]) if sizes else 12.0


def _normalise(text: str) -> str:
    return re.sub(r"\d+", "#", text.lower()).strip()


def extract(pdf_path: str) -> ExtractedDocument:
    with pymupdf.open(pdf_path) as doc:
        pages = [(_raw_rows(p), p.rect.height) for p in doc]
        raw_page_text = [p.get_text("text") for p in doc]
        page_count = len(doc)

    # Running headers/footers: identical (digit-normalised) text in the top
    # or bottom 9% of the page on several pages.
    body_size = _prose_font_size(pages)
    edge_counts = collections.Counter()
    for lines, height in pages:
        seen = set()
        for ln in lines:
            if ln.y < height * 0.09 or ln.y > height * 0.91:
                key = _normalise(ln.text)
                if key not in seen:
                    seen.add(key)
                    edge_counts[key] += 1
    repeated = {k for k, c in edge_counts.items() if c >= 3 and c >= 0.3 * page_count}

    all_lines: list[Line] = []
    footnotes: list[tuple[int, str]] = []
    for lines, height in pages:
        # Footnote block: begins at a small-font line that starts with a
        # footnote marker, in the lower part of the page, with no body-size
        # text after it. Small table text without a marker is NOT a footnote.
        kept_lines = [ln for ln in lines if not (PAGE_NO.match(ln.text) and (
            ln.y < height * 0.09 or ln.y > height * 0.88 or len(ln.text) <= 4))]
        fn_start = None
        for idx, ln in enumerate(kept_lines):
            if ln.leading_marker and ln.size <= body_size - 1.5 and ln.y > height * 0.45 \
                    and all(o.size <= body_size - 1.5 for o in kept_lines[idx:]):
                fn_start = idx
                break
        cur_note = None
        for idx, ln in enumerate(kept_lines):
            near_edge = ln.y < height * 0.09 or ln.y > height * 0.91
            if near_edge and _normalise(ln.text) in repeated:
                continue
            if DEVANAGARI.search(ln.text) and ln.page == 1:
                continue  # Hindi masthead on the cover page
            if fn_start is not None and idx >= fn_start:
                if ln.leading_marker or cur_note is None:
                    cur_note = [ln.page, ln.text]
                    footnotes.append(cur_note)
                else:
                    cur_note[1] += " " + ln.text
                continue
            all_lines.append(ln)

    # Left margin: the leftmost x position that carries a meaningful share
    # (>=10%) of long prose lines. Stray marginal text or stamps do not move it.
    prose = [ln for ln in all_lines if len(ln.text) >= 40 and not ln.is_table_row]
    x_counts = collections.Counter(round(ln.x0) for ln in prose)
    total = sum(x_counts.values()) or 1
    candidates = [x for x, c in x_counts.items() if c / total >= 0.10]
    left_margin = float(min(candidates)) if candidates else 72.0
    return ExtractedDocument(
        lines=all_lines, footnotes=[(p, t.strip()) for p, t in footnotes],
        page_count=page_count, body_size=body_size, left_margin=left_margin,
        raw_page_text=raw_page_text,
    )


if __name__ == "__main__":
    import sys
    ex = extract(sys.argv[1])
    print(f"pages={ex.page_count} body_size={ex.body_size} left_margin={ex.left_margin} "
          f"lines={len(ex.lines)} footnotes={len(ex.footnotes)}")
    lo = int(sys.argv[2]) if len(sys.argv) > 2 else 1
    hi = int(sys.argv[3]) if len(sys.argv) > 3 else 3
    for ln in ex.lines:
        if lo <= ln.page <= hi:
            print(f"p{ln.page:<3} x={ln.x0:5.1f} s={ln.size:4.1f} {'B' if ln.bold else ' '}{'T' if ln.is_table_row else ' '} {ln.text[:120]}")
    for p, t in ex.footnotes[:8]:
        print(f"  [fn p{p}] {t[:120]}")
