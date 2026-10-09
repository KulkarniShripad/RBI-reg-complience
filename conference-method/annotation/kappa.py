"""Inter-annotator agreement and adjudication.

python annotation/kappa.py              κ per task; writes <task>_adjudicate.csv with the disagreements
python annotation/kappa.py --finalise   merges agreements + adjudicated items into <task>_gold.csv
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
from regcomp.metrics import cohen_kappa  # noqa: E402

TASKS = {"obligation": ["label"], "rules": ["whole_rule_correct"], "marathi": ["adequacy_1to5", "fluency_1to5"]}


def read(path):
    with open(path, encoding="utf-8") as f:
        return list(csv.DictReader(f))


def weighted_kappa(a, b, k=5):
    """Quadratic-weighted κ for 1..k ratings."""
    import numpy as np
    a, b = np.array(a, dtype=int) - 1, np.array(b, dtype=int) - 1
    O = np.zeros((k, k))
    for x, y in zip(a, b):
        O[x, y] += 1
    W = np.array([[(i - j) ** 2 / (k - 1) ** 2 for j in range(k)] for i in range(k)])
    E = np.outer(O.sum(1), O.sum(0)) / O.sum()
    return 1 - (W * O).sum() / (W * E).sum()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--finalise", action="store_true")
    a = ap.parse_args()
    report = {}
    for task, cols in TASKS.items():
        pa, pb = os.path.join(HERE, f"{task}_A.csv"), os.path.join(HERE, f"{task}_B.csv")
        if not (os.path.exists(pa) and os.path.exists(pb)):
            continue
        A, B = read(pa), read(pb)
        for col in cols:
            pairs = [(x[col].strip(), y[col].strip()) for x, y in zip(A, B) if x[col].strip() and y[col].strip()]
            if not pairs:
                continue
            xa, xb = [p[0] for p in pairs], [p[1] for p in pairs]
            k = weighted_kappa(xa, xb) if col.endswith("1to5") else cohen_kappa(xa, xb)
            report[f"{task}.{col}"] = {"n": len(pairs), "kappa": round(float(k), 3), "weighted": col.endswith("1to5"),
                                       "raw_agreement": round(sum(x == y for x, y in pairs) / len(pairs), 3)}
        key = cols[0]
        adj = os.path.join(HERE, f"{task}_adjudicate.csv")
        if not a.finalise:
            dis = [(x, y) for x, y in zip(A, B) if x[key].strip() != y[key].strip()]
            with open(adj, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(list(A[0].keys()) + ["label_B", "final"])
                for x, y in dis:
                    w.writerow(list(x.values()) + [y[key], ""])
        else:
            final = {}
            if os.path.exists(adj):
                for r in read(adj):
                    if r["final"].strip():
                        final[r["item"]] = r["final"].strip()
            out = os.path.join(HERE, f"{task}_gold.csv")
            id_col = [c for c in A[0] if c.endswith("_id")][0]
            with open(out, "w", newline="", encoding="utf-8") as f:
                w = csv.writer(f)
                w.writerow(["item", id_col, "label" if task == "obligation" else key])
                missing = 0
                for x, y in zip(A, B):
                    v = x[key].strip() if x[key].strip() == y[key].strip() else final.get(x["item"])
                    if v is None:
                        missing += 1
                        continue
                    w.writerow([x["item"], x[id_col], v])
            print(f"{out} written ({missing} disagreements not yet adjudicated)")
    print(json.dumps(report, indent=1))
    with open(os.path.join(HERE, "agreement.json"), "w") as f:
        json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
