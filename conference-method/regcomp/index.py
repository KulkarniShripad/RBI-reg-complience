"""Nearest-clause search: FAISS inner-product index over normalised vectors
(numpy fallback when faiss is not installed), sparse matrix product for TF-IDF."""
from __future__ import annotations

import numpy as np

try:
    import faiss
except ImportError:          # pragma: no cover
    faiss = None


class ClauseIndex:
    def __init__(self, vectors, ids: list[str]):
        self.ids = list(ids)
        self.sparse = hasattr(vectors, "tocsr")
        if self.sparse:
            self.mat = vectors.tocsr()
            self.backend = "sparse"
        elif faiss is not None:
            self.index = faiss.IndexFlatIP(vectors.shape[1])
            self.index.add(np.ascontiguousarray(vectors, dtype=np.float32))
            self.backend = "faiss"
        else:
            self.mat = np.asarray(vectors, dtype=np.float32)
            self.backend = "numpy"

    def __len__(self):
        return len(self.ids)

    def search(self, queries, k: int) -> tuple[np.ndarray, np.ndarray]:
        """Top-k (scores, row indices) for every query, best first."""
        k = min(k, len(self.ids))
        if self.backend == "faiss":
            return self.index.search(np.ascontiguousarray(queries, dtype=np.float32), k)
        sims = (queries @ self.mat.T)
        sims = sims.toarray() if hasattr(sims, "toarray") else np.asarray(sims)
        idx = np.argpartition(-sims, k - 1, axis=1)[:, :k]
        part = np.take_along_axis(sims, idx, axis=1)
        order = np.argsort(-part, axis=1)
        return np.take_along_axis(part, order, axis=1), np.take_along_axis(idx, order, axis=1)
