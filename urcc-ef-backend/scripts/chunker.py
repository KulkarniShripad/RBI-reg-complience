"""
Stage 3: turn clauses into retrieval chunks.

Legal-boundary chunking: a chunk boundary is always a paragraph, a
top-level sub-clause "(1)", a definition item, or (for very long parts) a
list item / sentence boundary - never a fixed token window that cuts a rule
in half. Each chunk is embedded together with a short, template-generated
context prefix (document title, entity type, chapter/section path,
paragraph number) - the "contextual retrieval" idea without an LLM call,
since the parser already knows this context exactly.

When a long paragraph is split, every piece repeats the paragraph's
lead-in sentence ("In these Directions, unless the context otherwise
requires,") so a piece never loses the sentence that gives it meaning.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

MAX_CHARS = 1400        # a whole paragraph up to this size stays one chunk
PIECE_CHARS = 1100      # target size when a long part has to be split
LEAD_IN_CHARS = 280


@dataclass
class Chunk:
    clause_uri: str             # uri of the unit this chunk represents (paragraph or sub-clause)
    parent_clause_uri: str      # the paragraph / annex / preamble clause it belongs to
    chunk_text: str             # context prefix + text: what gets embedded and full-text indexed
    raw_text: str               # the text itself, without prefix
    chunk_index: int
    boundary_type: str          # paragraph | sub_clause | definition | window | annex | preamble


def context_prefix(doc_title: str, category_label: str, heading_path: list[str], label: str) -> str:
    parts = [doc_title.strip()]
    if category_label:
        parts.append(f"Applies to: {category_label}")
    parts.extend(h for h in heading_path if h)
    if label:
        parts.append(label)
    return " | ".join(p for p in parts if p)


def _split_long(text: str, limit: int = PIECE_CHARS) -> list[str]:
    """Split at list-item lines first, then sentences; pack pieces up to limit."""
    units = [u for u in re.split(r"\n", text) if u.strip()]
    if len(units) <= 1:
        units = re.split(r"(?<=[.;])\s+(?=[A-Z(\[‘'\"])", text)
    pieces, cur = [], ""
    for u in units:
        u = u.strip()
        if len(u) > limit * 1.6:                       # one enormous unit (e.g. a table row dump)
            if cur:
                pieces.append(cur)
                cur = ""
            for i in range(0, len(u), limit):
                pieces.append(u[i:i + limit])
            continue
        if cur and len(cur) + len(u) + 1 > limit:
            pieces.append(cur)
            cur = u
        else:
            cur = f"{cur}\n{u}" if cur else u
    if cur:
        pieces.append(cur)
    return pieces


def _lead_in(text: str) -> str:
    first = re.split(r"\n\s*\[?\s*\((?:\d{1,2}|[ivxlc]{1,6}|[a-z])\)\s", text, maxsplit=1)[0]
    first = first.strip()
    return first[:LEAD_IN_CHARS] + ("…" if len(first) > LEAD_IN_CHARS else "")


def chunk_paragraph(clause_uri: str, text: str, prefix: str, subclauses: list, definitions: list | None = None,
                    ) -> list[Chunk]:
    text = text.strip()
    if not text:
        return []
    out: list[Chunk] = []

    # Definitions: one chunk per defined term so "what is X" finds exactly it.
    if definitions and len(definitions) >= 2:
        lead = _lead_in(text)
        for i, d in enumerate(definitions):
            body = d["definition_text"]
            out.append(Chunk(
                clause_uri=f"{clause_uri}/def-{d['sub_clause_number']}".replace(" ", ""),
                parent_clause_uri=clause_uri,
                chunk_text=f"{prefix} | Definition: {d['term']}\n{body}",
                raw_text=body, chunk_index=i, boundary_type="definition",
            ))
        return out

    if len(text) <= MAX_CHARS:
        return [Chunk(clause_uri, clause_uri, f"{prefix}\n{text}", text, 0, "paragraph")]

    lead = _lead_in(text)
    parts = subclauses if subclauses else [("", p) for p in _split_long(text)]
    idx = 0
    for marker, part in parts:
        pieces = [part] if len(part) <= MAX_CHARS else _split_long(part)
        for j, piece in enumerate(pieces):
            uri = f"{clause_uri}/{marker}" if marker else clause_uri
            body = piece if (idx == 0 or piece.startswith(lead[:60])) else f"{lead}\n{piece}"
            out.append(Chunk(
                clause_uri=uri if j == 0 else f"{uri}~{j + 1}",
                parent_clause_uri=clause_uri,
                chunk_text=f"{prefix}{f' ({marker})' if marker else ''}\n{body}",
                raw_text=piece, chunk_index=idx,
                boundary_type="sub_clause" if marker else "window",
            ))
            idx += 1
    return out


def chunk_block(clause_uri: str, text: str, prefix: str, boundary_type: str) -> list[Chunk]:
    """Annexes and preambles: line-boundary windows."""
    text = text.strip()
    if not text:
        return []
    pieces = [text] if len(text) <= MAX_CHARS else _split_long(text)
    return [Chunk(clause_uri, clause_uri, f"{prefix}\n{p}", p, i, boundary_type) for i, p in enumerate(pieces)]
