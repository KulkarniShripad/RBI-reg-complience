"""Fine-tune transformer classifiers for obligation detection (operational vs not).

Labels: annotation/obligation_gold.csv (adjudicated human labels, see annotation/GUIDELINES.md).
Protocol (paper Sec. IV-B): 5 epochs, learning rate 2e-5, batch size 16, AdamW (weight decay
0.01), linear warm-up over the first 10% of steps, max length 256, 3 seeds; 5-fold stratified
cross-validation over the labelled clauses, so every clause is scored once per seed by a
model that never saw it. The rule-based detector and classical baselines on the same folds
are in eval_obligations.py.

Needs a GPU machine with requirements-gpu.txt (Colab: see experiments/colab_gpu.ipynb).

python experiments/finetune_classifier.py --models mahabert,indicbert,xlmr
"""
from __future__ import annotations

import argparse
import csv
import os
import random

import numpy as np

from common import CORPUS, ROOT, hardware, need, pct, save

from regcomp.ingest import read_jsonl

MODELS = {"mahabert": "l3cube-pune/marathi-bert-v2", "indicbert": "ai4bharat/IndicBERTv2-MLM-only", "xlmr": "xlm-roberta-base",
          "muril": "google/muril-base-cased"}


def load_labels() -> tuple[list[str], np.ndarray, list[str]]:
    path = os.path.join(ROOT, "annotation", "obligation_gold.csv")
    need(path, "annotate annotation/obligation_A.csv and _B.csv, then python annotation/kappa.py (see annotation/GUIDELINES.md)")
    text = {c["clause_id"]: c["text"] for c in read_jsonl(os.path.join(CORPUS, "clauses.jsonl"))}
    ids, y = [], []
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            if r["label"] in ("OPERATIONAL", "NON_OPERATIONAL") and r["clause_id"] in text:
                ids.append(r["clause_id"])
                y.append(1 if r["label"] == "OPERATIONAL" else 0)
    return [text[i] for i in ids], np.array(y), ids


def train_eval(model_name: str, Xtr, ytr, Xte, seed: int, epochs=5, lr=2e-5, bs=16, warmup=0.1, max_len=256) -> np.ndarray:
    import torch
    from torch.optim import AdamW
    from transformers import AutoModelForSequenceClassification, AutoTokenizer, get_linear_schedule_with_warmup
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    dev = "cuda" if torch.cuda.is_available() else "cpu"
    tok = AutoTokenizer.from_pretrained(model_name)
    model = AutoModelForSequenceClassification.from_pretrained(model_name, num_labels=2).to(dev)
    opt = AdamW(model.parameters(), lr=lr, weight_decay=0.01)
    steps = epochs * ((len(Xtr) + bs - 1) // bs)
    sched = get_linear_schedule_with_warmup(opt, int(warmup * steps), steps)
    model.train()
    for _ in range(epochs):
        order = np.random.permutation(len(Xtr))
        for i in range(0, len(order), bs):
            b = order[i:i + bs]
            enc = tok([Xtr[j] for j in b], truncation=True, max_length=max_len, padding=True, return_tensors="pt").to(dev)
            out = model(**enc, labels=torch.tensor(ytr[b]).to(dev))
            out.loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            opt.step()
            sched.step()
            opt.zero_grad()
    model.eval()
    preds = []
    with torch.no_grad():
        for i in range(0, len(Xte), 64):
            enc = tok(Xte[i:i + 64], truncation=True, max_length=max_len, padding=True, return_tensors="pt").to(dev)
            preds.append(model(**enc).logits.argmax(-1).cpu().numpy())
    del model
    torch.cuda.empty_cache() if torch.cuda.is_available() else None
    return np.concatenate(preds) if preds else np.array([])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--models", default="mahabert,indicbert,xlmr")
    ap.add_argument("--seeds", default="0,1,2")
    ap.add_argument("--folds", type=int, default=5)
    a = ap.parse_args()
    from sklearn.metrics import accuracy_score, f1_score, precision_score, recall_score
    from sklearn.model_selection import StratifiedKFold
    X, y, ids = load_labels()
    res = {}
    for m in a.models.split(","):
        per_seed = []
        for seed in [int(s) for s in a.seeds.split(",")]:
            pred = np.zeros_like(y)
            for tr, te in StratifiedKFold(a.folds, shuffle=True, random_state=seed).split(X, y):
                pred[te] = train_eval(MODELS.get(m, m), [X[i] for i in tr], y[tr], [X[i] for i in te], seed)
            per_seed.append({"precision": precision_score(y, pred), "recall": recall_score(y, pred), "f1": f1_score(y, pred),
                             "accuracy": accuracy_score(y, pred)})
            print(m, seed, per_seed[-1])
        res[m] = {k: (float(np.mean([s[k] for s in per_seed])), float(np.std([s[k] for s in per_seed]))) for k in per_seed[0]}
    md = [f"# Obligation detection: fine-tuned transformers ({len(y)} labelled clauses, {y.sum()} operational; "
          f"{a.folds}-fold CV × {len(a.seeds.split(','))} seeds)", "", "| Model | P | R | F1 | Accuracy |", "|---|---:|---:|---:|---:|"]
    for m, r in res.items():
        md.append(f"| {m} | " + " | ".join(f"{pct(r[k][0])} ± {pct(r[k][1])}" for k in ("precision", "recall", "f1", "accuracy")) + " |")
    save("obligations_finetuned", {"n": len(y), "results": res, "hardware": hardware()}, md)


if __name__ == "__main__":
    main()
