"""
Stage 3: turn each clause into one or more retrieval-ready chunks.

Two techniques combined here, both grounded in things discussed earlier:

1. Legal-boundary chunking - the chunk boundary IS the clause boundary
   (paragraph, or sub-clause if the paragraph is long). Never a fixed token
   window. This is what stops a rule from being cut mid-sentence and losing
   its meaning, which was the original concern.

2. Contextual prefixing - Anthropic's "Contextual Retrieval" technique
   prepends a short LLM-written context sentence to each chunk before
   embedding, because a bare chunk like "shall not exceed 5 per cent" means
   nothing on its own. We get the same benefit WITHOUT an LLM call: since
   the structural parser already knows the exact chapter/section/document
   this clause sits in, the context sentence can be template-generated
   deterministically. This is strictly cheaper and, for a template-drafted
   corpus like RBI's, at least as accurate as an LLM guessing the same
   thing from scratch.

   Recent work (CRAwLeR, arXiv 2506.21676, 2026) found that contextual
   embedding alone still under-performs on legal cross-reference-dependent
   queries - a chunk about a "prescribed ceiling" that only makes sense
   together with the paragraph it cross-references. So cross-reference
   text is appended into the prefix too, not just chapter/section context.

3. Embedding: no LLM/embedding-model server is reachable from this sandbox
   (no Ollama, no Hugging Face host in the network allowlist), so this
   module computes TF-IDF vectors as a stand-in and documents the swap
   point clearly. The chunking/prefixing/storage design is what matters for
   the architecture and doesn't change when a real embedding model (e.g.
   nomic-embed-text via local Ollama, per your existing setup) is dropped in.
"""
from dataclasses import dataclass


@dataclass
class Chunk:
    clause_uri: str
    chunk_text: str              # the contextualized text that gets embedded
    raw_text: str                 # the original clause text, unprefixed
    chunk_index: int
    boundary_type: str            # 'paragraph' | 'sub_clause'


def build_context_prefix(doc_title: str, chapter_title: str, section_title: str,
                          paragraph_number, cross_ref_targets: list[str] | None = None) -> str:
    parts = [f"From: {doc_title}."]
    if chapter_title:
        parts.append(f"Chapter: {chapter_title}.")
    if section_title:
        parts.append(f"Section: {section_title}.")
    parts.append(f"Paragraph {paragraph_number}.")
    if cross_ref_targets:
        parts.append(f"Cross-referenced with paragraph(s): {', '.join(cross_ref_targets)}.")
    return " ".join(parts)


def chunk_paragraph(clause_uri: str, paragraph, doc_title: str,
                     cross_ref_targets: list[str] | None = None,
                     max_chars: int = 1200) -> list[Chunk]:
    """A paragraph becomes ONE chunk unless it's unusually long (has many
    sub-clauses pushing it past max_chars), in which case each sub-clause
    becomes its own chunk - still boundary-aligned, never mid-sentence."""
    prefix = build_context_prefix(
        doc_title, paragraph.chapter_title, paragraph.section_title,
        paragraph.number, cross_ref_targets)

    full_text = paragraph.text
    if paragraph.subclauses:
        full_text += " " + " ".join(f"({n}) {t}" for n, t, _ in paragraph.subclauses)

    if len(full_text) <= max_chars or not paragraph.subclauses:
        return [Chunk(
            clause_uri=clause_uri, chunk_text=f"{prefix} {full_text}",
            raw_text=full_text, chunk_index=0, boundary_type="paragraph",
        )]

    chunks = []
    if paragraph.text.strip():
        chunks.append(Chunk(
            clause_uri=clause_uri, chunk_text=f"{prefix} {paragraph.text}",
            raw_text=paragraph.text, chunk_index=0, boundary_type="paragraph",
        ))
    for i, (sub_no, sub_text, _) in enumerate(paragraph.subclauses, start=1):
        sub_uri = f"{clause_uri}/{sub_no}"
        chunks.append(Chunk(
            clause_uri=sub_uri,
            chunk_text=f"{prefix} Sub-clause ({sub_no}): {sub_text}",
            raw_text=sub_text, chunk_index=i, boundary_type="sub_clause",
        ))
    return chunks


# ---------------------------------------------------------------------------
# TF-IDF stand-in for a real embedding model (see module docstring).
# ---------------------------------------------------------------------------

class TfidfVectorStore:
    """Minimal, swappable placeholder for pgvector/HNSW. Same interface shape
    (add texts keyed by clause_uri, search by query) so the rest of the
    pipeline doesn't need to change when this is replaced with real
    embeddings + a proper ANN index."""

    def __init__(self):
        from sklearn.feature_extraction.text import TfidfVectorizer
        self.vectorizer = TfidfVectorizer(max_features=20000, ngram_range=(1, 2))
        self.uris: list[str] = []
        self.texts: list[str] = []
        self.matrix = None

    def build(self, uri_text_pairs: list[tuple[str, str]]):
        self.uris = [u for u, _ in uri_text_pairs]
        self.texts = [t for _, t in uri_text_pairs]
        self.matrix = self.vectorizer.fit_transform(self.texts)

    def search(self, query: str, top_k: int = 5) -> list[tuple[str, float]]:
        from sklearn.metrics.pairwise import cosine_similarity
        q_vec = self.vectorizer.transform([query])
        sims = cosine_similarity(q_vec, self.matrix)[0]
        ranked = sorted(zip(self.uris, sims), key=lambda x: -x[1])
        return ranked[:top_k]
