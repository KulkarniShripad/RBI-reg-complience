"""Evidence-to-clause linking: Recall@k and MRR per encoder, English vs Marathi descriptions.

For every (evidence unit, applicable gold rule) pair, the relevant clauses are the gold
rule's clause and any other in-scope clause whose extracted rules test the same obligation
(same rule signature, e.g. a superseded direction repeating it). The rank is that of the
first relevant clause among the encoder's nearest clauses.

python experiments/eval_linking.py --encoders tfidf,bge-onnx            (CPU, offline)
python experiments/eval_linking.py --encoders mahabert,indicbert,xlmr,mpnet   (needs HF models)
"""
from __future__ import annotations

import argparse
import collections
import os
import time

from common import CORPUS, SYNTH, hardware, need, pct, save

from regcomp.metrics import bootstrap_mean, mrr, recall_at_k, signature
from regcomp.pipeline import Pipeline
from regcomp.records import read_units

KS = (1, 3, 5, 10)


def relevant_sets(p: Pipeline) -> dict[str, set[str]]:
    """gold rule id -> clause ids that state the same obligation."""
    by_sig = collections.defaultdict(set)
    for cid, rules in p.rules.items():
        for r in rules:
            by_sig[signature(r)].add(cid)
    out = {}
    for g in p.gold["rules"]:
        out[g["id"]] = {p.gold_clause[g["id"]]} | by_sig.get(signature(g["params"]), set())
    return out


def run(encoder: str, units, k: int, log=print) -> dict:
    p = Pipeline(CORPUS, encoder=encoder, k=k, log=log)
    t = time.time()
    p.build_index()
    links = p.link(units, k=k)
    secs = time.time() - t
    rel = relevant_sets(p)
    rows = []
    for u, cands in zip(units, links):
        ids = [c for c, _, _ in cands]
        for g in u.truth:
            rank = next((i + 1 for i, c in enumerate(ids) if c in rel[g]), None)
            rows.append({"unit": u.unit_id, "type": u.unit_type, "lang": u.lang, "gold": g, "rank": rank})
    res = {"encoder": encoder, "n_pairs": len(rows), "seconds_index_and_link": round(secs, 1), "groups": {}}
    groups = {"all": rows, "en": [r for r in rows if r["lang"] == "en"], "mr": [r for r in rows if r["lang"] == "mr"]}
    for t_ in sorted({r["type"] for r in rows}):
        groups[f"type:{t_}"] = [r for r in rows if r["type"] == t_]
    for name, rs in groups.items():
        ranks = [r["rank"] for r in rs]
        g = {"n": len(rs), "mrr": mrr(ranks)}
        for kk in KS:
            g[f"R@{kk}"] = recall_at_k(ranks, kk)
        m, lo, hi = bootstrap_mean([1.0 / r if r else 0.0 for r in ranks])
        g["mrr_ci"] = (lo, hi)
        m5, lo5, hi5 = bootstrap_mean([1.0 if r and r <= 5 else 0.0 for r in ranks])
        g["R@5_ci"] = (lo5, hi5)
        res["groups"][name] = g
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoders", default="tfidf,bge-onnx")
    ap.add_argument("--split", default="test")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--tag", default="", help="suffix for the results file (e.g. gpu)")
    a = ap.parse_args()
    need(os.path.join(SYNTH, "units.jsonl"), "python -m synth.generate --out work/synth")
    units = [u for u in read_units(os.path.join(SYNTH, "units.jsonl")) if a.split in ("all", u.split) and u.truth]
    results = []
    for enc in a.encoders.split(","):
        try:
            results.append(run(enc, units, a.k))
        except (ImportError, OSError, ValueError) as e:
            print(f"skipping {enc}: {type(e).__name__}: {e}")
            results.append({"encoder": enc, "skipped": f"{type(e).__name__}: {e}"})
    md = [f"# Linking: evidence description → clause ({a.split} split, {len(units)} units)", "",
          "| Encoder | Lang | Pairs | R@1 | R@3 | R@5 [95% CI] | R@10 | MRR [95% CI] |", "|---|---|---:|---:|---:|---|---:|---|"]
    for r in results:
        if "skipped" in r:
            md.append(f"| {r['encoder']} | – | – | not run: {r['skipped'][:80]} | | | | |")
            continue
        for lang in ("all", "en", "mr"):
            g = r["groups"][lang]
            md.append(f"| {r['encoder']} | {lang} | {g['n']} | {pct(g['R@1'])} | {pct(g['R@3'])} | {pct(g['R@5'])} "
                      f"[{pct(g['R@5_ci'][0])}, {pct(g['R@5_ci'][1])}] | {pct(g['R@10'])} | {g['mrr']:.3f} [{g['mrr_ci'][0]:.3f}, {g['mrr_ci'][1]:.3f}] |")
    md += ["", "## R@5 by evidence type", "", "| Encoder | " + " | ".join(t.split(":")[1] for t in sorted(k for k in (results[0].get("groups") or {}) if k.startswith("type:"))) + " |"]
    types = sorted(k for k in (results[0].get("groups") or {}) if k.startswith("type:"))
    md.append("|---|" + "---:|" * len(types))
    for r in results:
        if "skipped" not in r:
            md.append(f"| {r['encoder']} | " + " | ".join(pct(r["groups"][t]["R@5"]) for t in types) + " |")
    save("linking" + (f"_{a.tag}" if a.tag else ""), {"split": a.split, "k": a.k, "results": results, "hardware": hardware()}, md)


if __name__ == "__main__":
    main()
