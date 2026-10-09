"""Create the annotation sheets (see GUIDELINES.md).

  obligation_{A,B}.csv   clauses for Task 1, stratified by the rule-based detector's decision
                         (so both precision and recall can be estimated); the detector's
                         decision is only in obligation_key.csv
  rules_{A,B}.csv        extracted rules for Task 2
  marathi_{A,B}.csv      English / Marathi description pairs for Task 3

python annotation/make_sheets.py [--per-stratum 200] [--rules 100] [--marathi 60]
"""
from __future__ import annotations

import argparse
import csv
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "experiments"))
from common import CORPUS, SYNTH, need  # noqa: E402

from regcomp.ingest import read_jsonl  # noqa: E402
from regcomp.obligations import is_operational  # noqa: E402
from regcomp.records import Unit, read_units, verbalize  # noqa: E402
from regcomp.rules import extract_rules  # noqa: E402

PARAMS = ["kind", "field", "op", "value", "period", "anchor", "target", "window", "unit", "required", "conditions", "exceptions"]


def write_pair(name: str, header: list[str], rows: list[list]) -> None:
    for who in ("A", "B"):
        with open(os.path.join(HERE, f"{name}_{who}.csv"), "w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(header)
            w.writerows(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-stratum", type=int, default=200)
    ap.add_argument("--rules", type=int, default=100)
    ap.add_argument("--marathi", type=int, default=60)
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()
    need(os.path.join(CORPUS, "clauses.jsonl"), "python -m regcomp.ingest --pdfs ../circulars --out work/corpus")
    rnd = random.Random(a.seed)
    docs = {d["doc_id"]: d for d in read_jsonl(os.path.join(CORPUS, "docs.jsonl"))}
    clauses = [c for c in read_jsonl(os.path.join(CORPUS, "clauses.jsonl")) if len(c["text"].split()) >= 8]
    pos = [c for c in clauses if is_operational(c["text"], c.get("kind", "paragraph"))]
    neg = [c for c in clauses if not is_operational(c["text"], c.get("kind", "paragraph"))]
    sample = [(c, 1) for c in rnd.sample(pos, min(a.per_stratum, len(pos)))] + [(c, 0) for c in rnd.sample(neg, min(a.per_stratum, len(neg)))]
    rnd.shuffle(sample)
    rows = [[i + 1, c["clause_id"], docs[c["doc_id"]]["title"], c.get("key"), c["text"], "", "", ""] for i, (c, _) in enumerate(sample)]
    write_pair("obligation", ["item", "clause_id", "direction", "paragraph", "text", "label", "annotator", "notes"], rows)
    with open(os.path.join(HERE, "obligation_key.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["item", "clause_id", "detector", "stratum_size"])
        for i, (c, d) in enumerate(sample):
            w.writerow([i + 1, c["clause_id"], d, len(pos) if d else len(neg)])

    rules = []
    for c in rnd.sample(pos, min(len(pos), 4 * a.rules)):
        rules += [(c, r.as_dict()) for r in extract_rules(c["clause_id"], c["text"])]
    rules = rnd.sample(rules, min(a.rules, len(rules)))
    rows = []
    for i, (c, r) in enumerate(rules):
        shown = {k: r.get(k) for k in PARAMS if r.get(k) not in (None, [], {}, "")}
        rows.append([i + 1, r["rule_id"], r["sentence"], json.dumps(shown, ensure_ascii=False)] + [""] * len(PARAMS) + ["", "", ""])
    write_pair("rules", ["item", "rule_id", "sentence", "parameters"] + PARAMS + ["whole_rule_correct", "annotator", "notes"], rows)

    if os.path.exists(os.path.join(SYNTH, "units.jsonl")):
        mr = [u for u in read_units(os.path.join(SYNTH, "units.jsonl")) if u.lang == "mr"]
        rows = []
        for i, u in enumerate(rnd.sample(mr, min(a.marathi, len(mr)))):
            en = verbalize(Unit(u.unit_id, u.unit_type, u.institution_category, u.data), "en", 0)
            rows.append([i + 1, u.unit_id, en, u.text, "", "", "", "", ""])
        write_pair("marathi", ["item", "unit_id", "english", "marathi", "adequacy_1to5", "fluency_1to5", "corrected_text", "annotator", "notes"], rows)
    print(f"sheets written to {HERE}: {len(sample)} clauses, {len(rules)} rules, Marathi pairs: {a.marathi}")


if __name__ == "__main__":
    main()
