"""
This is "the vector DB" as its own thing - a separate file from urcc_ef.db,
matching the architecture: relational store (clause_registry, rule_atoms)
in one system, embeddings of EVERY clause (quantitative and qualitative
both) in another.

Uses sqlite-vec (a real ANN-search SQLite extension, the closest available
analogue to pgvector in this sandbox) rather than recomputing TF-IDF in
memory on every query, like the earlier query_demo.py did. That in-memory
approach was fine for a quick demo but isn't what "a vector db" means - a
real one persists vectors to disk and answers nearest-neighbor queries
against the index directly.

Embedding model note (same caveat as before): this sandbox can't reach
Ollama or a Hugging Face model host, so vectors here are TF-IDF reduced to
a dense 200-dim representation via TruncatedSVD, not a real semantic
embedding model. The STORAGE and SEARCH mechanics are real; only the
vectors' semantic quality is a stand-in. Swapping in real embeddings later
means replacing embed_texts() below with a real model call - nothing else
in this file changes.
"""
import sqlite3
import sqlite_vec
import numpy as np
import pickle
import os

VECTOR_DIM = 200


def embed_texts(texts: list[str], fit: bool = True, vectorizer=None, svd=None):
    """Stand-in embedding function. Swap point for a real model."""
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.decomposition import TruncatedSVD

    if fit:
        vectorizer = TfidfVectorizer(max_features=30000, ngram_range=(1, 2))
        tfidf = vectorizer.fit_transform(texts)
        svd = TruncatedSVD(n_components=VECTOR_DIM, random_state=42)
        dense = svd.fit_transform(tfidf)
    else:
        tfidf = vectorizer.transform(texts)
        dense = svd.transform(tfidf)

    # L2-normalize so cosine similarity == dot product (what sqlite-vec's
    # distance functions expect for a fair nearest-neighbor comparison)
    norms = np.linalg.norm(dense, axis=1, keepdims=True)
    norms[norms == 0] = 1
    dense = dense / norms
    return dense.astype(np.float32), vectorizer, svd


def build_vector_db(source_db_path: str, vector_db_path: str, model_path: str):
    src = sqlite3.connect(source_db_path)
    src.row_factory = sqlite3.Row
    rows = src.execute(
        "SELECT sc.clause_uri, sc.chunk_text, sc.raw_text, sc.boundary_type, "
        "cr.clause_type, d.institution_category, cr.page_number, d.rbi_ref "
        "FROM semantic_chunks sc "
        "JOIN clause_registry cr ON sc.clause_uri = cr.clause_uri OR sc.clause_uri LIKE cr.clause_uri || '/%' "
        "JOIN documents d ON sc.doc_id = d.doc_id"
    ).fetchall()
    src.close()

    print(f"Embedding {len(rows)} chunks (all clause types - quantitative AND qualitative)...")
    texts = [r["chunk_text"] for r in rows]
    vectors, vectorizer, svd = embed_texts(texts, fit=True)

    with open(model_path, "wb") as f:
        pickle.dump({"vectorizer": vectorizer, "svd": svd}, f)

    if os.path.exists(vector_db_path):
        os.remove(vector_db_path)
    conn = sqlite3.connect(vector_db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    conn.execute(f"""
        CREATE VIRTUAL TABLE chunk_vectors USING vec0(
            embedding FLOAT[{VECTOR_DIM}]
        )
    """)
    conn.execute("""
        CREATE TABLE chunk_metadata (
            rowid INTEGER PRIMARY KEY,
            clause_uri TEXT NOT NULL,
            chunk_text TEXT NOT NULL,
            raw_text TEXT NOT NULL,
            boundary_type TEXT,
            clause_type TEXT,
            institution_category TEXT,
            page_number INTEGER,
            rbi_ref TEXT
        )
    """)
    conn.execute("CREATE INDEX idx_meta_uri ON chunk_metadata(clause_uri)")
    conn.execute("CREATE INDEX idx_meta_type ON chunk_metadata(clause_type)")

    for i, (r, vec) in enumerate(zip(rows, vectors)):
        conn.execute("INSERT INTO chunk_vectors (rowid, embedding) VALUES (?, ?)",
                     (i, vec.tobytes()))
        conn.execute(
            "INSERT INTO chunk_metadata VALUES (?,?,?,?,?,?,?,?,?)",
            (i, r["clause_uri"], r["chunk_text"], r["raw_text"], r["boundary_type"],
             r["clause_type"], r["institution_category"], r["page_number"], r["rbi_ref"])
        )
    conn.commit()
    conn.close()
    return len(rows)


def search_vector_db(vector_db_path: str, model_path: str, query: str, top_k: int = 5,
                      institution_category: str | None = None):
    with open(model_path, "rb") as f:
        m = pickle.load(f)
    q_vec, _, _ = embed_texts([query], fit=False, vectorizer=m["vectorizer"], svd=m["svd"])

    conn = sqlite3.connect(vector_db_path)
    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)

    sql = """
        SELECT cm.clause_uri, cm.raw_text, cm.clause_type, cm.institution_category,
               cm.page_number, cm.rbi_ref, cv.distance
        FROM chunk_vectors cv
        JOIN chunk_metadata cm ON cv.rowid = cm.rowid
        WHERE cv.embedding MATCH ? AND k = ?
        ORDER BY cv.distance
    """
    params = [q_vec[0].tobytes(), top_k * 5 if institution_category else top_k]
    results = conn.execute(sql, params).fetchall()
    conn.close()

    if institution_category:
        results = [r for r in results if r[3] == institution_category][:top_k]
    return results


if __name__ == "__main__":
    base = os.path.dirname(__file__)
    n = build_vector_db(
        os.path.join(base, "urcc_ef.db"),
        os.path.join(base, "urcc_ef_vectors.db"),
        os.path.join(base, "vector_model.pkl"),
    )
    print(f"Vector DB built: {n} chunks embedded and persisted to urcc_ef_vectors.db")

    print("\n--- quick sanity search ---")
    results = search_vector_db(
        os.path.join(base, "urcc_ef_vectors.db"), os.path.join(base, "vector_model.pkl"),
        "liquidity coverage ratio requirement", top_k=3
    )
    for r in results:
        print(f"dist={r[6]:.4f}  [{r[2]}]  {r[1][:120]}")
