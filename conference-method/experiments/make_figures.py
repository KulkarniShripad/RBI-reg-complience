"""Paper figures (black and white SVG) drawn from results/*.json, so every plotted number
comes from an experiment run. Writes results/figures/*.svg.

python experiments/make_figures.py
"""
from __future__ import annotations

import json
import os

from common import RESULTS

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

plt.rcParams.update({"font.family": "serif", "font.size": 9, "axes.spines.top": False, "axes.spines.right": False,
                     "svg.fonttype": "none", "axes.edgecolor": "black", "axes.labelcolor": "black",
                     "xtick.color": "black", "ytick.color": "black"})
OUT = os.path.join(RESULTS, "figures")
HATCH = ["", "///", "...", "xxx", "\\\\\\", "ooo", "---", "+++"]
GREYS = ["#ffffff", "#d9d9d9", "#a6a6a6", "#737373", "#404040", "#000000"]


def load(name):
    p = os.path.join(RESULTS, f"{name}.json")
    return json.load(open(p)) if os.path.exists(p) else None


def save(fig, name):
    os.makedirs(OUT, exist_ok=True)
    fig.savefig(os.path.join(OUT, f"{name}.svg"), bbox_inches="tight")
    plt.close(fig)
    print(f"results/figures/{name}.svg")


def verification(v):
    keep = lambda s: (s["system"] in ("oracle link", "rule-only (no linking)", "hybrid")
                      or (s["system"].startswith("semantic-only") and s["encoder"] == "tfidf" and "SVM" in s["system"]))
    rows = [s for s in v["systems"] if "skipped" not in s and keep(s)]
    short = {"oracle link": "oracle link", "rule-only (no linking)": "rule-only", "hybrid": "hybrid", "semantic-only (SVM)": "semantic-only\nSVM"}
    labels = [short.get(s["system"], s["system"]) + (f"\n{s['encoder']}" if s["encoder"] != "–" else "") for s in rows]
    fig, ax = plt.subplots(figsize=(6, 2.8))
    x = range(len(rows))
    w = 0.38
    for j, (lang, h) in enumerate([("en", ""), ("mr", "///")]):
        vals = [100 * s["test"][lang]["pair"]["f1"] for s in rows]
        ax.bar([i + (j - 0.5) * w for i in x], vals, w, color="white" if j == 0 else "#bfbfbf", edgecolor="black", hatch=h,
               label={"en": "English descriptions", "mr": "Marathi descriptions"}[lang])
    for i, s in enumerate(rows):
        lo, hi = s["test"]["all"]["pair"]["ci"]["f1"]
        ax.plot([i, i], [100 * lo, 100 * hi], color="black", lw=0.8)
        ax.plot(i, 100 * s["test"]["all"]["pair"]["f1"], marker="_", color="black", ms=10)
    ax.set_xticks(list(x))
    ax.set_xticklabels(labels, fontsize=8)
    ax.set_ylabel("Pair-level F1 (%)")
    ax.set_ylim(0, 105)
    ax.legend(frameon=False, fontsize=7, loc="upper right")
    ax.set_title("Compliance verification on the test split (bar: per language; line: all, 95% CI)", fontsize=8)
    save(fig, "fig_verification")


def sweep(v):
    rows = [s for s in v["systems"] if s.get("sweep")]
    if not rows:
        return
    fig, axes = plt.subplots(1, len(rows), figsize=(3.3 * len(rows), 2.5), squeeze=False)
    for ax, s in zip(axes[0], rows):
        t = [x["tau"] for x in s["sweep"]]
        ax.plot(t, [100 * x["test_pair_p"] for x in s["sweep"]], "k-", label="precision")
        ax.plot(t, [100 * x["test_pair_r"] for x in s["sweep"]], "k--", label="recall")
        ax.plot(t, [100 * x["test_pair_f1"] for x in s["sweep"]], "k:", lw=1.6, label="F1")
        ax.axvline(s["tau"], color="black", lw=0.6)
        ax.text(s["tau"], 3, f" τ = {s['tau']:.2f}\n (validation)", fontsize=7, va="bottom")
        ax.set_title(f"{s['encoder']}", fontsize=8)
        ax.set_xlabel("similarity threshold τ")
        ax.set_ylim(0, 105)
    axes[0][0].set_ylabel("test pair-level (%)")
    axes[0][-1].legend(frameon=False, fontsize=7)
    save(fig, "fig_threshold_sweep")


def linking(l):
    rows = [r for r in l["results"] if "skipped" not in r]
    if not rows:
        return
    fig, ax = plt.subplots(figsize=(4.8, 2.6))
    ks = [1, 3, 5, 10]
    styles = ["-", "--", ":", "-."]
    markers = ["o", "s", "^", "D"]
    for i, r in enumerate(rows):
        for lang, mfc in (("en", "black"), ("mr", "white")):
            ax.plot(ks, [100 * r["groups"][lang][f"R@{k}"] for k in ks], styles[i % 4], color="black", marker=markers[i % 4],
                    mfc=mfc, ms=4, label=f"{r['encoder']} ({lang})")
    ax.set_xticks(ks)
    ax.set_xlabel("k")
    ax.set_ylabel("Recall@k (%)")
    ax.set_ylim(0, 105)
    ax.legend(frameon=False, fontsize=6, ncol=2, loc="center right")
    ax.set_title("Evidence → clause linking (filled: English, open: Marathi)", fontsize=8)
    save(fig, "fig_linking_recall")


def scalability(s):
    e = s["end_to_end"]
    fig, axes = plt.subplots(1, 2, figsize=(7, 2.5))
    n = [r["units"] for r in e]
    axes[0].plot(n, [r["link_ms_per_unit"] + r["validate_ms_per_unit"] for r in e], "ko-", label="hybrid (TF-IDF link + validate)")
    ro = [r for r in e if "rule_only_ms_per_unit" in r]
    axes[0].plot([r["units"] for r in ro], [r["rule_only_ms_per_unit"] for r in ro], "ks--", mfc="white", label="rule-only (validate all rules)")
    axes[0].set_xscale("log")
    axes[0].set_xticks(n)
    axes[0].set_xticklabels([f"{x:,}" for x in n])
    axes[0].minorticks_off()
    axes[0].set_ylim(0, None)
    axes[0].set_xlabel("evidence units")
    axes[0].set_ylabel("ms per unit")
    axes[0].legend(frameon=False, fontsize=7, loc="center right")
    sr = s["search"]
    for dim, st in ((384, "ko-"), (768, "ks--")):
        pts = [x for x in sr if x["dim"] == dim]
        axes[1].plot([x["vectors"] for x in pts], [x["ms_per_query"] for x in pts], st, mfc="white" if dim == 768 else "black", label=f"dim {dim}")
    axes[1].set_xscale("log")
    axes[1].set_yscale("log")
    axes[1].set_xlabel("indexed clause vectors (FAISS flat IP)")
    axes[1].set_ylabel("ms per query")
    axes[1].legend(frameon=False, fontsize=7)
    hw = s["hardware"]
    fig.suptitle(f"Scaling on {hw.get('cpus')} CPU cores ({hw.get('cpu')}), no GPU", fontsize=8)
    save(fig, "fig_scalability")


def anomaly(a):
    r = a["results"]
    names = list(r)
    pats = ["unusual_large", "high_turnover", "third_party_cash"]
    fig, ax = plt.subplots(figsize=(5, 2.5))
    w = 0.8 / len(names)
    for j, nm in enumerate(names):
        vals = [100 * r[nm]["recall_by_pattern"][p] for p in pats] + [100 * (r[nm]["benign_irregular_flag_rate"] or 0)]
        ax.bar([i + (j - (len(names) - 1) / 2) * w for i in range(4)], vals, w, color=GREYS[j * 2 % 6], edgecolor="black", hatch=HATCH[j], label=nm)
    ax.set_xticks(range(4))
    ax.set_xticklabels(["unusual large", "high turnover", "3rd-party\ncheque → cash", "benign irregular\n(false alarms)"], fontsize=7)
    ax.set_ylabel("flagged (%)")
    ax.set_ylim(0, 105)
    ax.legend(frameon=False, fontsize=7, ncol=3, loc="upper center", bbox_to_anchor=(0.5, -0.22))
    ax.set_title(f"KYC para 40 monitoring at a {int(100 * a['budget'])}% review budget", fontsize=8)
    save(fig, "fig_anomaly")


def main():
    v, l, s, a = load("verification"), load("linking"), load("scalability"), load("anomaly")
    if v:
        verification(v)
        sweep(v)
    if l:
        linking(l)
    if s:
        scalability(s)
    if a:
        anomaly(a)


if __name__ == "__main__":
    main()
