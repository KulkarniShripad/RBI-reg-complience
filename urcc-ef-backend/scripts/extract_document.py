"""
Text extraction for a bank's own documents (annual reports, Basel III Pillar 3
disclosures, quarterly results, policies) - the input side of the automatic
compliance check (src/services/disclosure/).

Unlike pdf_text.py, which is tuned to RBI circulars, this keeps everything on
the page and reconstructs table rows: words on the same baseline are joined
left to right, and cells separated by a wide horizontal gap are joined with
" | " so that a row such as

    5   Common Equity Tier 1 ratio (%)   13.34   13.12   14.02

comes out as "5 | Common Equity Tier 1 ratio (%) | 13.34 | 13.12 | 14.02".

Usage: python3 extract_document.py <file.pdf>   -> JSON on stdout
No LLM is used here; everything is deterministic.
"""
from __future__ import annotations

import json
import sys

import pymupdf

CELL_GAP = 11.0      # points of empty space that separate two table cells
ROW_TOLERANCE = 2.8  # words whose vertical centres differ by less are one row


def page_rows(page) -> list[str]:
    words = page.get_text("words")  # x0, y0, x1, y1, text, block, line, word
    if not words:
        return []
    words.sort(key=lambda w: ((w[1] + w[3]) / 2, w[0]))
    rows: list[list[tuple]] = []
    centres: list[float] = []
    for w in words:
        c = (w[1] + w[3]) / 2
        if rows and abs(c - centres[-1]) <= ROW_TOLERANCE:
            rows[-1].append(w)
        else:
            rows.append([w])
            centres.append(c)
    out = []
    for row in rows:
        row.sort(key=lambda w: w[0])
        parts: list[str] = []
        prev_x1 = None
        for w in row:
            if prev_x1 is None:
                parts.append(w[4])
            elif w[0] - prev_x1 > CELL_GAP:
                parts.append(" | " + w[4])
            else:
                parts.append(" " + w[4])
            prev_x1 = w[2]
        line = "".join(parts).strip()
        if line:
            out.append(line)
    return out


def main(path: str) -> None:
    doc = pymupdf.open(path)
    pages = []
    chars = 0
    for i, page in enumerate(doc):
        lines = page_rows(page)
        chars += sum(len(l) for l in lines)
        pages.append({"page": i + 1, "lines": lines})
    meta = doc.metadata or {}
    json.dump(
        {
            "format": "pdf",
            "page_count": doc.page_count,
            "title": meta.get("title") or None,
            "text_chars": chars,
            # A scanned PDF has pages but (almost) no text layer; OCR is not
            # available here, so the caller reports this instead of guessing.
            "scanned": doc.page_count > 0 and chars < 40 * doc.page_count,
            "pages": pages,
        },
        sys.stdout,
        ensure_ascii=False,
    )


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: extract_document.py <file.pdf>", file=sys.stderr)
        sys.exit(2)
    try:
        main(sys.argv[1])
    except Exception as exc:  # reported to the API caller as a 422
        print(f"could not read PDF: {exc}", file=sys.stderr)
        sys.exit(1)
