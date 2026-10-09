"""Metrics: rule matching against the gold parameters, P/R/F1 with bootstrap
confidence intervals, ranking metrics, Cohen's kappa."""
from __future__ import annotations

import collections
import math

import numpy as np


# ── rule matching ──

def _f(x):
    return None if x is None else float(x)


def signature(r: dict) -> tuple:
    """The parameters that decide a verdict; two rules with the same signature test the same obligation."""
    k = r.get("kind")
    if k == "threshold":
        return (k, r.get("field"), r.get("op"), _f(r.get("value")), r.get("period"))
    if k == "temporal":
        pc = r.get("per_category")
        win = tuple(sorted((c, float(v)) for c, v in pc["values"].items())) if pc else _f(r.get("window"))
        return (k, r.get("target"), frozenset(r.get("anchor") or []), win, r.get("unit"))
    if k == "cardinality":
        return (k, r.get("field"), r.get("op"), _f(r.get("value")), r.get("when"))
    if k == "set":
        return (k, frozenset(frozenset(g) for g in r.get("required") or []))
    return (k,)


def match_gold(rule: dict, gold_rules: list[dict]) -> str | None:
    """Id of the gold rule this (extracted) rule is equivalent to, if any."""
    sig = signature(rule)
    for g in gold_rules:
        if signature(g["params"]) == sig:
            return g["id"]
    return None


PARAM_KEYS = {
    "threshold": ["field", "aggregate", "period", "op", "value", "conditions", "exceptions"],
    "temporal": ["anchor", "target", "window", "unit", "per_category", "grace", "remediation"],
    "cardinality": ["field", "op", "value", "sub", "when"],
    "set": ["required", "conditions", "exceptions"],
}


def _canon(key, v):
    if v in (None, [], {}):
        return None
    if key == "anchor":
        return frozenset(v)
    if key == "required":
        return frozenset(frozenset(g) for g in v)
    if key in ("value", "window"):
        return float(v)
    if key == "per_category":
        return (v["field"], tuple(sorted((c, float(x)) for c, x in v["values"].items())))
    if key == "grace":
        until = str(v.get("until"))
        if not until[:4].isdigit():
            from .validators import _parse_long_date
            until = str(_parse_long_date(until))
        return (tuple(sorted(v.get("when", {}).items())), float(v.get("extra") or 0), until, v.get("combine"))
    if key == "sub":
        return (tuple(sorted(v.get("filter", {}).items())), v.get("op"), float(v.get("value")))
    if key == "remediation":
        return float(v.get("per_day"))
    if isinstance(v, dict):
        return repr(sorted((k, repr(x)) for k, x in v.items()))
    if isinstance(v, list):
        return repr(v)
    return v


def param_agreement(extracted: dict, gold_params: dict) -> dict:
    """Per-parameter agreement between an extracted rule and its gold rule (keys the gold rule defines or the extractor set)."""
    keys = PARAM_KEYS.get(gold_params["kind"], [])
    out = {}
    for k in keys:
        g, e = _canon(k, gold_params.get(k)), _canon(k, extracted.get(k))
        if g is None and e is None:
            continue
        out[k] = g == e
    return out


# ── classification ──

def prf(tp: int, fp: int, fn: int) -> dict:
    p = tp / (tp + fp) if tp + fp else 0.0
    r = tp / (tp + fn) if tp + fn else 0.0
    f = 2 * p * r / (p + r) if p + r else 0.0
    return {"precision": p, "recall": r, "f1": f, "tp": tp, "fp": fp, "fn": fn}


def bootstrap_prf(per_item: list[tuple[int, int, int]], n: int = 1000, seed: int = 0, alpha: float = 0.05) -> dict:
    """Percentile CIs for P/R/F1 by resampling items (units) with replacement.
    per_item: (tp, fp, fn) contributed by each item."""
    a = np.asarray(per_item, dtype=np.int64).reshape(-1, 3)
    base = prf(*a.sum(0).tolist())
    if len(a) == 0 or n <= 0:
        return dict(base, ci={})
    rng = np.random.default_rng(seed)
    stats = {"precision": [], "recall": [], "f1": []}
    for _ in range(n):
        s = a[rng.integers(0, len(a), len(a))].sum(0)
        m = prf(*s.tolist())
        for k in stats:
            stats[k].append(m[k])
    ci = {k: (float(np.quantile(v, alpha / 2)), float(np.quantile(v, 1 - alpha / 2))) for k, v in stats.items()}
    return dict(base, ci=ci)


def evaluate(units, predicted: dict, n_boot: int = 1000, seed: int = 0) -> dict:
    """predicted: unit_id -> set of violated rule keys (gold ids where matched, other signatures otherwise).
    Gold: unit.truth {gold_id: violated}. Returns unit-level and pair-level P/R/F1 with CIs."""
    unit_items, pair_items = [], []
    conf = {"unit": collections.Counter(), "pair": collections.Counter()}
    for u in units:
        gold = {g for g, v in u.truth.items() if v}
        pred = predicted.get(u.unit_id, set())
        pu, gu = bool(pred), bool(gold)
        unit_items.append((int(pu and gu), int(pu and not gu), int(gu and not pu)))
        conf["unit"]["tp" if pu and gu else "fp" if pu else "fn" if gu else "tn"] += 1
        tp = len(pred & gold)
        pair_items.append((tp, len(pred) - tp, len(gold) - tp))
        # confusion over the checks the gold labels define (unit, applicable gold rule),
        # plus violations of rules outside the gold set
        for g, v in u.truth.items():
            conf["pair"]["tp" if v and g in pred else "fn" if v else "fp" if g in pred else "tn"] += 1
        conf["pair"]["fp_other_rules"] += len(pred - set(u.truth))
    return {"unit": bootstrap_prf(unit_items, n_boot, seed), "pair": bootstrap_prf(pair_items, n_boot, seed), "n_units": len(units),
            "confusion": {k: dict(v) for k, v in conf.items()}}


# ── ranking ──

def recall_at_k(ranks: list[int | None], k: int) -> float:
    return sum(1 for r in ranks if r is not None and r <= k) / len(ranks) if ranks else 0.0


def mrr(ranks: list[int | None]) -> float:
    return sum(1.0 / r for r in ranks if r) / len(ranks) if ranks else 0.0


def bootstrap_mean(values: list[float], n: int = 1000, seed: int = 0, alpha: float = 0.05) -> tuple[float, float, float]:
    v = np.asarray(values, dtype=float)
    if len(v) == 0:
        return 0.0, 0.0, 0.0
    rng = np.random.default_rng(seed)
    means = v[rng.integers(0, len(v), (n, len(v)))].mean(1)
    return float(v.mean()), float(np.quantile(means, alpha / 2)), float(np.quantile(means, 1 - alpha / 2))


# ── agreement ──

def cohen_kappa(a: list, b: list) -> float:
    assert len(a) == len(b) and a
    labels = sorted(set(a) | set(b), key=str)
    n = len(a)
    po = sum(x == y for x, y in zip(a, b)) / n
    pe = sum((a.count(l) / n) * (b.count(l) / n) for l in labels)
    return 1.0 if pe == 1 else (po - pe) / (1 - pe)


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return 0.0, 0.0
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (c - h) / d, (c + h) / d
