"""Clause simplification: readability and faithfulness.

For every operational clause in scope that yields at least one testable rule:
  original   the rule sentences of the clause
  template   regcomp.simplify.render_clause (deterministic rendering of the extracted rules;
             as faithful as the extraction, see eval_extraction.py)
  t5         flan-T5 paraphrase (only with --t5 and transformers installed), then the guard
Reported: Flesch-Kincaid grade, length, the guard's verdict (numbers, negations, exceptions,
modal kept), and how often the guard rejects T5 output. A random sample is written to
annotation/simplification_sample.csv for human ratings of faithfulness and clarity.

python experiments/eval_simplification.py [--t5 google/flan-t5-base] [--sample 60]
"""
from __future__ import annotations

import argparse
import csv
import os
import random
import statistics as st

from common import CORPUS, ROOT, need, save

from regcomp.pipeline import Pipeline
from regcomp.simplify import T5Simplifier, guard, render_clause
from regcomp.text import fkgl


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--t5", default=None, help="e.g. google/flan-t5-base (needs transformers + torch)")
    ap.add_argument("--sample", type=int, default=60)
    a = ap.parse_args()
    need(os.path.join(CORPUS, "clauses.jsonl"), "python -m regcomp.ingest --pdfs ../circulars --out work/corpus")
    p = Pipeline(CORPUS, log=lambda *x: None)
    items = []
    for cid, rules in p.rules.items():
        rendered = render_clause(rules)
        if not rendered:
            continue
        source = " ".join(dict.fromkeys(r["sentence"] for r in rules))
        items.append({"clause_id": cid, "source": source, "template": rendered})
    t5 = T5Simplifier(a.t5) if a.t5 else None
    if t5:
        outs = []
        for i in range(0, len(items), 16):
            outs += t5([x["source"] for x in items[i:i + 16]])
        for x, o in zip(items, outs):
            x["t5"] = o
    rows = {}
    for name in ["source", "template"] + (["t5"] if t5 else []):
        grades = [g for g in (fkgl(x[name]) for x in items) if g is not None]
        words = [len(x[name].split()) for x in items]
        r = {"fkgl_mean": st.mean(grades), "fkgl_median": st.median(grades), "words_mean": st.mean(words)}
        if name == "t5":            # the template is rendered from the extracted parameters: faithful to them by construction
            verdicts = [guard(x["source"], x[name]) for x in items]
            r["guard_pass"] = sum(ok for ok, _ in verdicts) / len(verdicts)
            issues = {}
            for ok, iss in verdicts:
                for i in iss:
                    k = i.split(":")[0]
                    issues[k] = issues.get(k, 0) + 1
            r["guard_issues"] = issues
        rows[name] = r
    rnd = random.Random(0)
    sample = rnd.sample(items, min(a.sample, len(items)))
    os.makedirs(os.path.join(ROOT, "annotation"), exist_ok=True)
    path = os.path.join(ROOT, "annotation", "simplification_sample.csv")
    key_path = path.replace(".csv", "_key.csv")
    sheet = []
    for x in sample:
        systems = ["template"] + (["t5"] if t5 else [])
        rnd.shuffle(systems)            # annotators do not see which system produced the text
        sheet += [(x, s_) for s_ in systems]
    with open(path, "w", newline="", encoding="utf-8") as f, open(key_path, "w", newline="", encoding="utf-8") as fk:
        w, wk = csv.writer(f), csv.writer(fk)
        w.writerow(["item", "clause_id", "source", "simplified", "faithful_1to5", "clear_1to5", "annotator", "notes"])
        wk.writerow(["item", "system"])
        for k, (x, s_) in enumerate(sheet, 1):
            w.writerow([k, x["clause_id"], x["source"], x[s_], "", "", "", ""])
            wk.writerow([k, s_])
    md = [f"# Simplification ({len(items)} clauses with testable rules)", "",
          "| Text | FKGL mean | FKGL median | Words | Guard pass | Guard issues |", "|---|---:|---:|---:|---:|---|"]
    for name, r in rows.items():
        md.append(f"| {name} | {r['fkgl_mean']:.1f} | {r['fkgl_median']:.1f} | {r['words_mean']:.0f} | "
                  f"{'' if 'guard_pass' not in r else format(100 * r['guard_pass'], '.1f') + '%'} | "
                  f"{r.get('guard_issues', '')} |")
    if not t5:
        md += ["", "T5 not run here (no model weights offline). Run with `--t5 google/flan-t5-base` on a machine with the "
                   "Hugging Face hub; the guard then decides, per clause, whether the T5 text or the template text is shown."]
    md += ["", f"Human rating sheet: annotation/simplification_sample.csv ({len(sample)} clauses; the producing system is hidden, "
               "the key is in simplification_sample_key.csv)."]
    save("simplification", {"n": len(items), "systems": rows, "t5_model": a.t5, "examples": items[:10]}, md)


if __name__ == "__main__":
    main()
