"""
Ranks a list of candidate texts (piped in as JSON on stdin) against a query
by cosine similarity, using the SAME persisted TF-IDF/SVD model as the main
vector DB (vector_model.pkl) - so "similarity" means the same thing here as
it does everywhere else in the system. Used for clause-vs-submitted-evidence
matching where the candidates (a bank's submitted text) aren't, and
shouldn't be, pre-indexed into urcc_ef_vectors.db.

Usage:
  echo '{"candidates": ["text1", "text2"]}' | python3 vector_rank_worker.py --query "some clause text"
"""
import argparse
import json
import os
import pickle
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from vector_db_builder import embed_texts  # noqa: E402

DATA_DIR = os.environ.get("URCC_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    args = ap.parse_args()

    payload = json.loads(sys.stdin.read())
    candidates = payload["candidates"]

    model_path = os.path.join(DATA_DIR, "vector_model.pkl")
    if not os.path.exists(model_path):
        print(json.dumps({"error": "vector model not built yet"}))
        sys.exit(1)

    with open(model_path, "rb") as f:
        m = pickle.load(f)

    q_vec, _, _ = embed_texts([args.query], fit=False, vectorizer=m["vectorizer"], svd=m["svd"])
    c_vecs, _, _ = embed_texts(candidates, fit=False, vectorizer=m["vectorizer"], svd=m["svd"])

    sims = (c_vecs @ q_vec[0].T).astype(float)  # already L2-normalized -> dot product == cosine sim
    ranked = sorted(
        [{"index": i, "score": float(s)} for i, s in enumerate(sims)],
        key=lambda x: -x["score"],
    )
    print(json.dumps(ranked))


if __name__ == "__main__":
    main()
