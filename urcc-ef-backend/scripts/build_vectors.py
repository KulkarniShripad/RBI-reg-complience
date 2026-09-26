"""
Wraps vector_db_builder.build_vector_db() with one adjustment: TruncatedSVD
requires n_components < n_samples. Your real corpus (266+ documents,
28,000+ chunks) never hits this. A small demo/test corpus (like the single
synthetic circular used for local testing) can. This script auto-caps
VECTOR_DIM to fit the actual chunk count instead of erroring, and prints
which case it hit so it's never a silent surprise.

Usage: python3 build_vectors.py
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(__file__))
import vector_db_builder as V

DATA_DIR = os.environ.get("URCC_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))
DB_PATH = os.path.join(DATA_DIR, "urcc_ef.db")
VDB_PATH = os.path.join(DATA_DIR, "urcc_ef_vectors.db")
MODEL_PATH = os.path.join(DATA_DIR, "vector_model.pkl")

conn = sqlite3.connect(DB_PATH)
n_chunks = conn.execute("SELECT COUNT(*) FROM semantic_chunks").fetchone()[0]
conn.close()

DEFAULT_DIM = 200
safe_dim = min(DEFAULT_DIM, max(2, n_chunks - 1))
if safe_dim < DEFAULT_DIM:
    print(f"[build_vectors] {n_chunks} chunks in corpus - capping embedding "
          f"dimension to {safe_dim} (production default is {DEFAULT_DIM}, "
          f"only reachable with a real multi-document corpus).")
V.VECTOR_DIM = safe_dim

n = V.build_vector_db(DB_PATH, VDB_PATH, MODEL_PATH)
print(f"[build_vectors] embedded {n} chunks at {safe_dim}-dim into {VDB_PATH}")
