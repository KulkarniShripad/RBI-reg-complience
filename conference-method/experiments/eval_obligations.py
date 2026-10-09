"""Obligation detection against the adjudicated human labels (annotation/obligation_gold.csv).

The annotated clauses were sampled in two strata by the rule-based detector's decision
(annotation/make_sheets.py), so the detector's corpus-level precision, recall and F1 are
estimated by re-weighting each stratum by its size. Baselines, scored by 5-fold
cross-validation on the labelled clauses (unweighted):
  keyword only    "shall / must / required to" anywhere in the clause (the naive baseline)
  TF-IDF + LR     L2, C = 1
  TF-IDF + SVM    linear kernel, C = 1
  TF-IDF + RF     100 trees, max depth 10
Fine-tuned transformers: experiments/finetune_classifier.py (GPU).

python experiments/eval_obligations.py
"""
from __future__ import annotations

import csv
import os
import re

import numpy as np

from common import CORPUS, ROOT, need, pct, save

from regcomp.ingest import read_jsonl
from regcomp.metrics import prf
from regcomp.obligations import is_operational

KEYWORD = re.compile(r"\b(?:shall|must|required to)\b", re.I)


def main():
    gold_p = os.path.join(ROOT, "annotation", "obligation_gold.csv")
    need(gold_p, "annotate annotation/obligation_A.csv and _B.csv, then python annotation/kappa.py --finalise (see annotation/GUIDELINES.md)")
    with open(gold_p, encoding="utf-8") as f:
        gold = {r["clause_id"]: r["label"] for r in csv.DictReader(f) if r["label"] in ("OPERATIONAL", "NON_OPERATIONAL")}
    with open(os.path.join(ROOT, "annotation", "obligation_key.csv"), encoding="utf-8") as f:
        key = {r["clause_id"]: (int(r["detector"]), int(r["stratum_size"])) for r in csv.DictReader(f)}
    clauses = {c["clause_id"]: c for c in read_jsonl(os.path.join(CORPUS, "clauses.jsonl"))}
    ids = [i for i in gold if i in key and i in clauses]
    y = np.array([gold[i] == "OPERATIONAL" for i in ids])
    X = [clauses[i]["text"] for i in ids]

    # detector, stratum-weighted
    det = np.array([is_operational(clauses[i]["text"], clauses[i].get("kind", "paragraph")) for i in ids])
    w = {}
    for d in (0, 1):
        m = np.array([key[i][0] == d for i in ids])
        w[d] = key[ids[int(np.argmax(m))]][1] / m.sum() if m.any() else 0.0
    weight = np.array([w[key[i][0]] for i in ids])
    tp = float((weight * (det & y)).sum())
    fp = float((weight * (det & ~y)).sum())
    fn = float((weight * (~det & y)).sum())
    tn = float((weight * (~det & ~y)).sum())
    detector = dict(prf(tp, fp, fn), accuracy=(tp + tn) / (tp + fp + fn + tn), weighted=True)

    from sklearn.ensemble import RandomForestClassifier
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold
    from sklearn.pipeline import make_pipeline
    from sklearn.svm import LinearSVC
    rows = {"rule-based detector (stratum-weighted)": detector}
    kw = np.array([bool(KEYWORD.search(t)) for t in X])
    rows["keyword only (sample)"] = dict(prf(int((kw & y).sum()), int((kw & ~y).sum()), int((~kw & y).sum())), accuracy=float((kw == y).mean()))
    rows["rule-based detector (sample)"] = dict(prf(int((det & y).sum()), int((det & ~y).sum()), int((~det & y).sum())), accuracy=float((det == y).mean()))
    for name, clf in [("TF-IDF + LR", lambda: LogisticRegression(C=1.0, max_iter=2000)),
                      ("TF-IDF + SVM", lambda: LinearSVC(C=1.0)),
                      ("TF-IDF + RF", lambda: RandomForestClassifier(n_estimators=100, max_depth=10, random_state=0))]:
        pred = np.zeros_like(y)
        for tr, te in StratifiedKFold(5, shuffle=True, random_state=0).split(X, y):
            m = make_pipeline(TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=2), clf()).fit([X[i] for i in tr], y[tr])
            pred[te] = m.predict([X[i] for i in te])
        rows[f"{name} (5-fold CV)"] = dict(prf(int((pred & y).sum()), int((pred & ~y).sum()), int((~pred & y).sum())), accuracy=float((pred == y).mean()))
    agree = os.path.join(ROOT, "annotation", "agreement.json")
    kappa = None
    if os.path.exists(agree):
        import json
        kappa = json.load(open(agree)).get("obligation.label")
    md = [f"# Obligation detection ({len(ids)} adjudicated clauses, {int(y.sum())} operational)", ""]
    if kappa:
        md += [f"Inter-annotator agreement before adjudication: Cohen's κ = {kappa['kappa']} on {kappa['n']} clauses.", ""]
    md += ["| System | P | R | F1 | Accuracy |", "|---|---:|---:|---:|---:|"]
    md += [f"| {k} | {pct(v['precision'])} | {pct(v['recall'])} | {pct(v['f1'])} | {pct(v['accuracy'])} |" for k, v in rows.items()]
    md += ["", "Supervised baselines learn from the labelled sample; the rule-based detector uses no labels. "
               "The stratum-weighted row estimates corpus-level performance."]
    save("obligations", {"n": len(ids), "results": rows, "kappa": kappa}, md)


if __name__ == "__main__":
    main()
