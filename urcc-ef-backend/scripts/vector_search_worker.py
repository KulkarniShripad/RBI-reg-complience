"""
Thin CLI wrapper around vector_db_builder.search_vector_db() so the Node
backend can shell out and get JSON back, instead of reimplementing the
TF-IDF/SVD embedding logic in JavaScript. See vectorSearchService.js for
the calling side and why this boundary exists.

Usage:
  python3 vector_search_worker.py --query "liquidity coverage ratio" --top_k 5 [--institution_category Regional_Rural_Bank]

Prints a single JSON array to stdout. All diagnostic output goes to stderr
so stdout stays parseable.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from vector_db_builder import search_vector_db  # noqa: E402

DATA_DIR = os.environ.get("URCC_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--query", required=True)
    ap.add_argument("--top_k", type=int, default=5)
    ap.add_argument("--institution_category", default=None)
    args = ap.parse_args()

    vector_db_path = os.path.join(DATA_DIR, "urcc_ef_vectors.db")
    model_path = os.path.join(DATA_DIR, "vector_model.pkl")

    if not os.path.exists(vector_db_path) or not os.path.exists(model_path):
        print(json.dumps({"error": "vector DB or model not built yet - run npm run ingest:build-vectors"}))
        sys.exit(1)

    try:
        results = search_vector_db(
            vector_db_path, model_path, args.query,
            top_k=args.top_k, institution_category=args.institution_category
        )
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

    out = [
        {
            "clause_uri": r[0], "raw_text": r[1], "clause_type": r[2],
            "institution_category": r[3], "page_number": r[4],
            "rbi_ref": r[5], "distance": float(r[6]),
        }
        for r in results
    ]
    print(json.dumps(out))


if __name__ == "__main__":
    main()
