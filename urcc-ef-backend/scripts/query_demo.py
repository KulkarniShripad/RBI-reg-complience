"""
Demo of the hybrid retrieval flow discussed earlier, run against the real
extracted database - not a toy example. Shows:

  1. Lexical search (SQLite FTS5, standing in for Postgres tsvector/GIN)
  2. Vector search (TF-IDF, standing in for pgvector/HNSW - see chunker.py
     for the exact swap point when a real embedding model is available)
  3. Reciprocal Rank Fusion of the two ranked lists
  4. A join back to rule_atoms for any quantitative clause in the results,
     so the answer carries an exact machine-checked number, not a
     paraphrase of one.

Run: python3 query_demo.py "your question here"
"""
import sqlite3
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
from chunker import TfidfVectorStore


def build_indices(db_path: str):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row

    # Lexical index (FTS5) - built once, in-memory, from semantic_chunks
    conn.execute("DROP TABLE IF EXISTS chunks_fts")
    conn.execute("CREATE VIRTUAL TABLE chunks_fts USING fts5("
                 "clause_uri, chunk_text)")
    rows = conn.execute("SELECT clause_uri, chunk_text FROM semantic_chunks").fetchall()
    conn.executemany("INSERT INTO chunks_fts (clause_uri, chunk_text) VALUES (?,?)",
                      [(r["clause_uri"], r["chunk_text"]) for r in rows])
    conn.commit()

    # Vector index (TF-IDF stand-in)
    store = TfidfVectorStore()
    store.build([(r["clause_uri"], r["chunk_text"]) for r in rows])
    return conn, store


def reciprocal_rank_fusion(lexical_ranked: list, vector_ranked: list, k: int = 60) -> list:
    scores: dict[str, float] = {}
    for rank, uri in enumerate(lexical_ranked, start=1):
        scores[uri] = scores.get(uri, 0) + 1.0 / (k + rank)
    for rank, (uri, _) in enumerate(vector_ranked, start=1):
        scores[uri] = scores.get(uri, 0) + 1.0 / (k + rank)
    return sorted(scores.items(), key=lambda x: -x[1])


def answer_query(conn, store, query: str, top_k: int = 5):
    # Lexical
    lex_rows = conn.execute(
        "SELECT clause_uri FROM chunks_fts WHERE chunk_text MATCH ? LIMIT 15",
        (query.replace('"', ' '),)
    ).fetchall() if query.strip() else []
    lexical_ranked = [r["clause_uri"] for r in lex_rows]

    # Vector
    vector_ranked = store.search(query, top_k=15)

    fused = reciprocal_rank_fusion(lexical_ranked, vector_ranked)[:top_k]

    results = []
    for uri, score in fused:
        clause = conn.execute(
            "SELECT * FROM clause_registry WHERE clause_uri = ?", (uri,)
        ).fetchone()
        if not clause:
            continue
        doc = conn.execute("SELECT title, rbi_ref FROM documents WHERE doc_id = ?",
                            (clause["doc_id"],)).fetchone()
        rule = conn.execute("SELECT * FROM rule_atoms WHERE clause_uri = ?", (uri,)).fetchone()
        results.append({
            "clause_uri": uri, "fusion_score": round(score, 5),
            "clause_type": clause["clause_type"], "page": clause["page_number"],
            "doc_title": doc["title"] if doc else None, "rbi_ref": doc["rbi_ref"] if doc else None,
            "clause_text": clause["clause_text"][:300],
            "exact_rule": dict(rule) if rule else None,
        })
    return results


if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) or "liquidity coverage ratio requirement"
    conn, store = build_indices(os.path.join(os.path.dirname(__file__), "urcc_ef.db"))
    results = answer_query(conn, store, query)
    print(f'Query: "{query}"\n')
    for i, r in enumerate(results, 1):
        print(f"[{i}] score={r['fusion_score']}  type={r['clause_type']}  "
              f"{r['rbi_ref']}  p.{r['page']}")
        print(f"    {r['doc_title']}")
        print(f"    {r['clause_text']}")
        if r["exact_rule"]:
            ra = r["exact_rule"]
            print(f"    >> exact rule_atom: {ra['operator']} {ra['threshold_value']}{ra['threshold_unit']} "
                  f"(var: {ra['variable_text']})")
        print()
