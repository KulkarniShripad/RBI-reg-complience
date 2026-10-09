"""Compliance verification: the hybrid method against oracles and baselines.

Systems (all scored on the test split; τ is chosen on the validation split, never on test):
  hybrid            retrieval top-k (sim ≥ τ) + extracted rules + validators   (the method)
  + oracle params   retrieval + hand-written gold parameters (extraction upper bound)
  oracle link       gold clauses + extracted rules (linking upper bound)
  oracle both       gold clauses + gold parameters
  rule-only         every extracted rule of every in-scope clause, no linking
  semantic-only     classifiers on the unit description (TF-IDF or embeddings + LR / SVM / RF),
                    trained on the train split with the gold labels, one per gold rule

Metrics: unit-level (does the unit violate anything?) and pair-level (unit, rule) P/R/F1
with 1,000-sample bootstrap 95% CIs over units; English vs Marathi descriptions; the
precision/recall trade-off over τ; validator calls and time per unit.

python experiments/eval_verification.py --encoders tfidf,bge-onnx
"""
from __future__ import annotations

import argparse
import collections
import os
import time

import numpy as np

from common import CORPUS, SYNTH, ci, hardware, need, pct, save

from regcomp.metrics import evaluate, match_gold, signature
from regcomp.pipeline import Pipeline
from regcomp.records import read_units


def predictions(p: Pipeline, outcomes: list[dict], tau: float) -> dict:
    """unit -> violated rule keys (gold id when the extracted rule matches one)."""
    rule_of = {(cid, r["rule_id"]): r for cid, rs in p.rules.items() for r in rs}
    gold = p.gold["rules"]
    pred = collections.defaultdict(set)
    for o in outcomes:
        if o["status"] == "VIOLATION" and o["similarity"] >= tau:
            r = rule_of[(o["clause_id"], o["rule_id"])]
            pred[o["unit_id"]].add(r["rule_id"] if r["rule_id"] in {g["id"] for g in gold} else (match_gold(r, gold) or repr(signature(r))))
    return pred


def by_split(units, s):
    return [u for u in units if u.split == s]


def score(units, pred, n_boot) -> dict:
    return {"all": evaluate(units, pred, n_boot), "en": evaluate([u for u in units if u.lang == "en"], pred, n_boot),
            "mr": evaluate([u for u in units if u.lang == "mr"], pred, n_boot)}


def choose_tau(p, outcomes, dev_units) -> tuple[float, list[dict]]:
    sims = sorted({round(o["similarity"], 4) for o in outcomes})
    grid = sorted(set([0.0] + [float(np.quantile(sims, q)) for q in np.linspace(0, 0.98, 50)])) if sims else [0.0]
    sweep = []
    for tau in grid:
        ev = evaluate(dev_units, predictions(p, outcomes, tau), n_boot=0)
        sweep.append({"tau": tau, "dev_pair_f1": ev["pair"]["f1"], "dev_pair_p": ev["pair"]["precision"], "dev_pair_r": ev["pair"]["recall"]})
    best = max(sweep, key=lambda x: (round(x["dev_pair_f1"], 6), -x["tau"]))
    return best["tau"], sweep


def semantic_only(units, vec_name: str, vectors, clf_name: str) -> dict:
    """One binary classifier per gold rule on the unit description vectors."""
    from sklearn.ensemble import RandomForestClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.svm import LinearSVC
    make = {"lr": lambda: LogisticRegression(max_iter=2000, C=4.0, class_weight="balanced"),
            "svm": lambda: LinearSVC(C=1.0, class_weight="balanced"),
            "rf": lambda: RandomForestClassifier(n_estimators=100, max_depth=10, class_weight="balanced", random_state=0, n_jobs=-1)}[clf_name]
    idx = {u.unit_id: i for i, u in enumerate(units)}
    train = [u for u in units if u.split == "train"]
    test = [u for u in units if u.split == "test"]
    gold_ids = sorted({g for u in units for g in u.truth})
    pred = collections.defaultdict(set)
    X = vectors
    for g in gold_ids:
        y = np.array([1 if u.truth.get(g) else 0 for u in train])
        if y.sum() == 0 or y.sum() == len(y):
            continue
        m = make().fit(X[[idx[u.unit_id] for u in train]], y)
        yh = m.predict(X[[idx[u.unit_id] for u in test]])
        for u, v in zip(test, yh):
            if v:
                pred[u.unit_id].add(g)
    return pred


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoders", default="tfidf,bge-onnx")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--tag", default="", help="suffix for the results file (e.g. gpu)")
    ap.add_argument("--no-baselines", action="store_true")
    a = ap.parse_args()
    need(os.path.join(SYNTH, "units.jsonl"), "python -m synth.generate --out work/synth")
    units = read_units(os.path.join(SYNTH, "units.jsonl"))
    dev, test = by_split(units, "validation"), by_split(units, "test")
    assert dev and test, "units.jsonl needs validation and test splits"
    systems = []

    def add(name, encoder, p, outcomes, tau, secs, sweep=None):
        pred = predictions(p, outcomes, tau)
        systems.append({"system": name, "encoder": encoder, "tau": tau, "test": score(test, pred, a.boot),
                        "validator_calls_per_unit": p.timings.get("validator_calls", 0) / len(units),
                        "validate_ms_per_unit": 1000 * p.timings.get("validate_s", 0) / len(units),
                        "seconds": round(secs, 1), "sweep": sweep})
        print(f"{name:28s} {encoder:10s} τ={tau:.3f} pair F1 {systems[-1]['test']['all']['pair']['f1']:.3f}")

    # encoder-independent systems
    for name, link, params in [("oracle link", "oracle", "extracted"), ("oracle link + params", "oracle", "gold"), ("rule-only (no linking)", "all", "extracted")]:
        t = time.time()
        p = Pipeline(CORPUS, link=link, params=params, log=lambda *x: None)
        add(name, "–", p, p.check(units), 0.0, time.time() - t)

    vectors_for_baseline = {}
    for enc in a.encoders.split(","):
        try:
            t = time.time()
            p = Pipeline(CORPUS, encoder=enc, k=a.k, log=print)
            p.build_index()
            links = p.link(units)
            out = p.check(units, links)
            secs = time.time() - t
            tau, sweep = choose_tau(p, out, dev)
            for s in sweep:       # test-side curve, for the trade-off figure only
                ev = evaluate(test, predictions(p, out, s["tau"]), n_boot=0)
                s.update(test_pair_f1=ev["pair"]["f1"], test_pair_p=ev["pair"]["precision"], test_pair_r=ev["pair"]["recall"])
            add("hybrid", enc, p, out, tau, secs, sweep)
            pg = Pipeline(CORPUS, encoder=enc, k=a.k, params="gold", log=lambda *x: None)
            pg.encoder, pg.index = p.encoder, p.index
            outg = pg.check(units, links)
            add("hybrid + oracle params", enc, pg, outg, tau, secs)
            if not a.no_baselines:
                vectors_for_baseline[enc] = p.encoder.encode_queries([u.text for u in units]) if not p.encoder.sparse else None
        except (ImportError, OSError, ValueError) as e:
            print(f"skipping {enc}: {type(e).__name__}: {e}")
            systems.append({"system": "hybrid", "encoder": enc, "skipped": f"{type(e).__name__}: {e}"})

    if not a.no_baselines:
        from sklearn.feature_extraction.text import TfidfVectorizer
        tf = TfidfVectorizer(ngram_range=(1, 2), sublinear_tf=True, min_df=2).fit([u.text for u in units if u.split == "train"])
        feats = {"tfidf": tf.transform([u.text for u in units])}
        for enc, v in vectors_for_baseline.items():
            if v is not None:
                feats[enc] = v
        for fname, X in feats.items():
            for clf in ("lr", "svm", "rf"):
                if clf == "rf" and fname != "tfidf":
                    continue
                t = time.time()
                pred = semantic_only(units, fname, X, clf)
                systems.append({"system": f"semantic-only ({clf.upper()})", "encoder": fname, "tau": None,
                                "test": score(test, pred, a.boot), "seconds": round(time.time() - t, 1), "trained_on": "train split, gold labels"})
                print(f"semantic-only {clf} on {fname}: pair F1 {systems[-1]['test']['all']['pair']['f1']:.3f}")

    md = [f"# Compliance verification (test split: {len(test)} units, {sum(len(u.truth) for u in test)} unit–rule checks, "
          f"{sum(sum(u.truth.values()) for u in test)} violations)", "",
          "Pair = (unit, rule). τ chosen on the validation split. 95% bootstrap CIs over units.", "",
          "| System | Encoder | τ | Pair P | Pair R | Pair F1 [95% CI] | Unit F1 [95% CI] | F1 en | F1 mr | Validator calls / unit | Validation ms / unit |",
          "|---|---|---:|---:|---:|---|---|---:|---:|---:|---:|"]
    for s in systems:
        if "skipped" in s:
            md.append(f"| {s['system']} | {s['encoder']} | | | | not run ({s['skipped'][:60]}) | | | | | |")
            continue
        T = s["test"]
        tau_s = "" if s["tau"] is None else f"{s['tau']:.3f}"
        cost = f"{s['validator_calls_per_unit']:.1f} | {s['validate_ms_per_unit']:.2f} |" if "validator_calls_per_unit" in s else "– | – |"
        md.append(f"| {s['system']} | {s['encoder']} | {tau_s} | "
                  f"{pct(T['all']['pair']['precision'])} | {pct(T['all']['pair']['recall'])} | {ci(T['all']['pair'], 'f1')} | "
                  f"{ci(T['all']['unit'], 'f1')} | {pct(T['en']['pair']['f1'])} | {pct(T['mr']['pair']['f1'])} | " + cost)
    md += ["", "Semantic-only rows are supervised (trained on the train split's gold labels); the hybrid uses no training data.",
           "Validator calls / unit: rules evaluated per evidence unit (linking restricts them to the top-k clauses)."]
    md += ["", "## Confusion on the test checks (unit, applicable gold rule)", "",
           "| System | Encoder | TP | FP | FN | TN | Violations of non-gold rules | Units TP / FP / FN / TN |", "|---|---|---:|---:|---:|---:|---:|---|"]
    for s in systems:
        if "skipped" in s:
            continue
        c = s["test"]["all"]["confusion"]
        cp, cu = c["pair"], c["unit"]
        md.append(f"| {s['system']} | {s['encoder']} | {cp.get('tp', 0)} | {cp.get('fp', 0)} | {cp.get('fn', 0)} | {cp.get('tn', 0)} | "
                  f"{cp.get('fp_other_rules', 0)} | {cu.get('tp', 0)} / {cu.get('fp', 0)} / {cu.get('fn', 0)} / {cu.get('tn', 0)} |")
    for s in systems:
        if s.get("sweep"):
            md += ["", f"## τ sweep — {s['encoder']}", "", "| τ | val P | val R | val F1 | test P | test R | test F1 |", "|---:|---:|---:|---:|---:|---:|---:|"]
            step = max(1, len(s["sweep"]) // 12)
            for x in s["sweep"][::step]:
                md.append(f"| {x['tau']:.3f} | {pct(x['dev_pair_p'])} | {pct(x['dev_pair_r'])} | {pct(x['dev_pair_f1'])} | "
                          f"{pct(x['test_pair_p'])} | {pct(x['test_pair_r'])} | {pct(x['test_pair_f1'])} |")
    save("verification" + (f"_{a.tag}" if a.tag else ""), {"k": a.k, "systems": systems, "hardware": hardware()}, md)


if __name__ == "__main__":
    main()
