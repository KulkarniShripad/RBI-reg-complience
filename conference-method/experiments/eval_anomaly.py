"""Monitoring clause (KYC para 40) without a programmatic condition: Isolation Forest and
One-Class SVM over account-month behaviour, against static red-flag rules.

Detectors are fitted on the train accounts without labels; the alert threshold is the
95th percentile of scores on the validation accounts (a 5% review budget, no labels used); scores
on the test accounts are compared with the injected patterns. Isolation Forest is repeated
over 5 seeds.

python experiments/eval_anomaly.py
"""
from __future__ import annotations

import os

import numpy as np

from common import ANOMALY, CORPUS, hardware, need, pct, save

from regcomp.anomaly import FEATURES, Monitor, account_months, matrix, read_rows, review_findings
from regcomp.metrics import prf

BUDGET = 0.05
PATTERNS = ["unusual_large", "high_turnover", "third_party_cash"]


def static_rules(F: dict, ids: list[str]) -> np.ndarray:
    """Red flags with thresholds fixed in advance (not fitted): largest transaction > 5x the
    customer's usual largest, turnover > 10x the average balance, or > 70% of third-party
    cheque credits withdrawn in cash within 3 days."""
    return np.array([F[i]["max_txn_to_history"] > 5 or F[i]["turnover_to_balance"] > 10 or F[i]["cheque_then_cash"] > 0.7 for i in ids])


def report(pred: np.ndarray, scores, y: np.ndarray, pat: list, benign: np.ndarray) -> dict:
    from sklearn.metrics import average_precision_score, roc_auc_score
    tp = int((pred & y).sum())
    out = prf(tp, int((pred & ~y).sum()), int((~pred & y).sum()))
    if scores is not None:
        out["roc_auc"] = float(roc_auc_score(y, scores))
        out["avg_precision"] = float(average_precision_score(y, scores))
    out["recall_by_pattern"] = {p: float(pred[np.array([x == p for x in pat])].mean()) for p in PATTERNS}
    out["benign_irregular_flag_rate"] = float(pred[benign & ~y].mean()) if (benign & ~y).any() else None
    out["normal_flag_rate"] = float(pred[~benign & ~y].mean())
    return out


def main():
    need(os.path.join(ANOMALY, "transactions.jsonl"), "python -m synth.anomaly --out work/anomaly")
    rows = read_rows(os.path.join(ANOMALY, "transactions.jsonl"))
    labels = {l["unit_id"]: l for l in read_rows(os.path.join(ANOMALY, "labels.jsonl"))}
    F = account_months(rows)
    ids = {s: sorted(u for u in F if labels[u]["split"] == s) for s in ("train", "validation", "test")}
    X = {s: matrix(F, ids[s]) for s in ids}
    y = np.array([labels[u]["anomalous"] for u in ids["test"]])
    pat = [labels[u]["pattern"] for u in ids["test"]]
    benign = np.array([bool(labels[u]["benign_irregularity"]) for u in ids["test"]])

    results = {}
    for method, seeds in (("iforest", range(5)), ("ocsvm", [0])):
        runs = []
        for seed in seeds:
            m = Monitor(method, seed=seed).fit(X["train"])
            m.calibrate(X["validation"], 1 - BUDGET)
            s = m.score(X["test"])
            runs.append(report(s >= m.threshold, s, y, pat, benign))
        agg = {k: float(np.mean([r[k] for r in runs])) for k in ("precision", "recall", "f1", "roc_auc", "avg_precision", "normal_flag_rate")}
        agg["std_f1"] = float(np.std([r["f1"] for r in runs]))
        agg["recall_by_pattern"] = {p: float(np.mean([r["recall_by_pattern"][p] for r in runs])) for p in PATTERNS}
        agg["benign_irregular_flag_rate"] = float(np.mean([r["benign_irregular_flag_rate"] for r in runs]))
        agg["seeds"] = len(runs)
        results[method] = agg
    results["static_rules"] = report(static_rules(F, ids["test"]), None, y, pat, benign)

    # example REVIEW findings with the clause and the explanation
    from regcomp.ingest import read_jsonl
    from regcomp.pipeline import load_gold
    gold = load_gold()["anomaly_clause"]
    clause = {"id": gold["id"], "quote": gold["quote"], "direction": gold["title_contains"]}
    if os.path.exists(os.path.join(CORPUS, "clauses.jsonl")):
        hit = next((c for c in read_jsonl(os.path.join(CORPUS, "clauses.jsonl")) if gold["quote"].lower() in c["text"].lower()), None)
        if hit:
            clause.update(clause_id=hit["clause_id"], paragraph=hit.get("key"))
    m = Monitor("iforest", seed=0).fit(X["train"])
    m.calibrate(X["validation"], 1 - BUDGET)
    examples = review_findings(m, F, ids["test"], X["test"], clause)[:5]
    for e in examples:
        e["truth"] = labels[e["unit_id"]]["pattern"] or labels[e["unit_id"]]["benign_irregularity"] or "normal"

    n = {s: len(ids[s]) for s in ids}
    md = [f"# Monitoring without a programmatic rule (KYC para 40)", "",
          f"Account-months: train {n['train']}, validation {n['validation']}, test {n['test']} ({int(y.sum())} anomalous in test). "
          f"Review budget {int(BUDGET * 100)}% (threshold from unlabelled validation scores).", "",
          "| Detector | P | R | F1 | ROC-AUC | AP | Unusual large | High turnover | 3rd-party cheque → cash | Benign irregular flagged | Normal flagged |",
          "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name, r in results.items():
        f1 = f"{pct(r['f1'])}" + (f" ± {pct(r['std_f1'])}" if r.get("seeds", 1) > 1 else "")
        md.append(f"| {name} | {pct(r['precision'])} | {pct(r['recall'])} | {f1} | {r.get('roc_auc', float('nan')):.3f} | "
                  f"{r.get('avg_precision', float('nan')):.3f} | {pct(r['recall_by_pattern']['unusual_large'])} | "
                  f"{pct(r['recall_by_pattern']['high_turnover'])} | {pct(r['recall_by_pattern']['third_party_cash'])} | "
                  f"{pct(r['benign_irregular_flag_rate'])} | {pct(r['normal_flag_rate'])} |")
    md += ["", "Static rules use thresholds fixed in advance; the detectors use no labels.", "", "## Example REVIEW findings", ""]
    for e in examples:
        md.append(f"- `{e['unit_id']}` score {e['score']} (threshold {e['threshold']}), truth: {e['truth']}; "
                  + ", ".join(f"{x['feature']} = {x['value']} (z {x['robust_z']})" for x in e["explanation"]))
    save("anomaly", {"budget": BUDGET, "sizes": n, "features": FEATURES, "results": results, "examples": examples, "hardware": hardware()}, md)


if __name__ == "__main__":
    main()
