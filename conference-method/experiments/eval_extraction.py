"""Obligation detection and rule extraction against hand-written gold parameters.

Three test sets:
  A  development set: the 14 gold rules of data/gold_rules.yaml (9 clauses). The extractor
     was developed while looking at these clauses, so this is a development score.
  B  parallel held-out set: the same provisions as they appear in the directions for other
     institution categories (NBFCs, small finance banks, co-operative banks, ...), found by
     the gold quote; expected parameters are the gold parameters. Not used in development.
  C  numeric set: 62 limits verified by hand for the main system before regcomp existed
     (data/numeric_gold.json); a limit counts as recovered when a threshold rule with the
     same operator and value is extracted from its paragraph. C1 (26 requirements on
     published figures) was used for error analysis once; C2 (36 network limits) was never
     inspected and is the held-out score.

python experiments/eval_extraction.py
"""
from __future__ import annotations

import collections
import json
import os
import re

from common import CORPUS, ROOT, need, pct, save

from regcomp.ingest import read_jsonl
from regcomp.metrics import param_agreement, signature, wilson
from regcomp.obligations import is_operational
from regcomp.pipeline import doc_in_scope, load_gold, locate_gold
from regcomp.rules import extract_rules
from regcomp.text import normalize


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def best_candidate(gold_params: dict, rules: list[dict]) -> tuple[dict | None, dict]:
    same = [r for r in rules if r["kind"] == gold_params["kind"]]
    if not same:
        return None, {}
    scored = [(sum(param_agreement(r, gold_params).values()), r) for r in same]
    r = max(scored, key=lambda x: x[0])[1]
    return r, param_agreement(r, gold_params)


def score_rules(gold_rules: list[dict], clause_of: dict, clause_text: dict) -> dict:
    rows = []
    per_param = collections.defaultdict(lambda: [0, 0])
    extracted_in = {}
    for g in gold_rules:
        cid = clause_of[g["id"]]
        if cid not in extracted_in:
            extracted_in[cid] = [r.as_dict() for r in extract_rules(cid, clause_text[cid])]
        rules = extracted_in[cid]
        exact = any(signature(r) == signature(g["params"]) for r in rules)
        cand, agree = best_candidate(g["params"], rules)
        for k, ok in agree.items():
            per_param[k][0] += ok
            per_param[k][1] += 1
        rows.append({"gold": g["id"], "clause": cid, "kind": g["params"]["kind"], "exact": exact,
                     "operational": is_operational(clause_text[cid]), "params": agree,
                     "candidate": {k: v for k, v in (cand or {}).items() if k != "sentence" and v not in (None, [], {}, "")}})
    gold_sigs = {signature(g["params"]) for g in gold_rules}
    extra = [r for rs in extracted_in.values() for r in rs if signature(r) not in gold_sigs]
    n_ex = sum(len(rs) for rs in extracted_in.values())
    return {"rows": rows, "exact": sum(r["exact"] for r in rows), "n": len(rows),
            "per_param": {k: v[0] / v[1] for k, v in sorted(per_param.items())},
            "operational_recall": sum(r["operational"] for r in rows) / len(rows) if rows else None,
            "extracted": n_ex, "extra": [{k: v for k, v in r.items() if v not in (None, [], {}, "")} for r in extra]}


def main():
    need(os.path.join(CORPUS, "clauses.jsonl"), "python -m regcomp.ingest --pdfs ../circulars --out work/corpus")
    docs = {d["doc_id"]: d for d in read_jsonl(os.path.join(CORPUS, "docs.jsonl"))}
    clauses = read_jsonl(os.path.join(CORPUS, "clauses.jsonl"))
    text = {c["clause_id"]: c["text"] for c in clauses}
    gold = load_gold()
    scoped = [c for c in clauses if doc_in_scope(docs[c["doc_id"]], gold["category"])]
    clause_of = locate_gold(gold, docs, scoped)

    # A: development set
    A = score_rules(gold["rules"], clause_of, text)

    # B: parallel clauses in other categories' directions
    B_rows = []
    for g in gold["rules"]:
        q = _norm(g["quote"])
        for c in clauses:
            d = docs[c["doc_id"]]
            if doc_in_scope(d, gold["category"]) or q not in _norm(c["text"]):
                continue
            B_rows.append((g, c, d))
    B_gold, B_clause = [], {}
    for i, (g, c, d) in enumerate(B_rows):
        gid = f"{g['id']}@{c['clause_id']}"
        B_gold.append(dict(g, id=gid))
        B_clause[gid] = c["clause_id"]
    B = score_rules(B_gold, B_clause, text)
    by_cat = collections.defaultdict(lambda: [0, 0])
    for (g, c, d), row in zip(B_rows, B["rows"]):
        cat = d.get("category") or "cross-sector"
        by_cat[cat][0] += row["exact"]
        by_cat[cat][1] += 1
        row["category"] = cat
        row["direction"] = d["title"]

    # C: numeric gold from the main system
    with open(os.path.join(ROOT, "data", "numeric_gold.json"), encoding="utf-8") as f:
        numeric = json.load(f)["rules"]
    C_rows = []
    for r in numeric:
        # regcomp's ingestion normalises dashes and quotes (regcomp.text.normalize); do the same to the patterns
        title_re = re.compile(normalize(r["title_regex"]).replace("\\s*-\\s*", "\\s*-\\s*"), re.I)
        text_re = re.compile(normalize(r["text_regex"]), re.I | re.S) if r.get("text_regex") else None
        hits = [c for c in clauses if title_re.search(docs[c["doc_id"]]["title"] or "")
                and ((text_re and text_re.search(re.sub(r"\s+", " ", c["text"]))) or (not text_re and c.get("key") == r.get("para")))]
        if not hits:
            C_rows.append({"key": r["key"], "set": r["set"], "located": False})
            continue
        c = hits[0]
        th = [x.as_dict() for x in extract_rules(c["clause_id"], c["text"]) if x.kind == "threshold"]
        unit_ok = lambda x: x.get("unit") == ("percent" if r["unit"] == "%" else "INR")
        scale = 1e7 if "crore" in r["unit"] else 1e5 if "lakh" in r["unit"] else 1.0      # gold "₹ crore" values -> rupees
        val = [x for x in th if any(abs((x.get("value") or -1) - v * scale) < 1e-6 for v in r["values"]) and unit_ok(x)]
        strict = [x for x in val if x["op"] == r["operator"]]
        lenient = [x for x in val if x["op"] == r["operator"] or (r["operator"], x["op"]) in (("<=", "<"), (">=", ">"))]
        C_rows.append({"key": r["key"], "set": r["set"], "located": True, "clause": c["clause_id"],
                       "operational": is_operational(c["text"]), "value": bool(val), "strict": bool(strict), "lenient": bool(lenient),
                       "extracted_thresholds": len(th)})
    loc = [x for x in C_rows if x["located"]]
    main_sys = None
    p = os.path.join(ROOT, "..", "urcc-ef-backend", "eval", "results", "extraction_gold.json")
    if os.path.exists(p):
        with open(p) as f:
            main_sys = json.load(f)["overall"]

    C = {"n": len(numeric), "located": len(loc),
         "value_recall": sum(x["value"] for x in loc) / max(len(loc), 1),
         "strict_recall": sum(x["strict"] for x in loc) / max(len(loc), 1),
         "lenient_recall": sum(x["lenient"] for x in loc) / max(len(loc), 1),
         "operational_recall": sum(x["operational"] for x in loc) / max(len(loc), 1),
         "by_set": {s: {"n": sum(1 for x in loc if x["set"] == s), "strict": sum(x["strict"] for x in loc if x["set"] == s)} for s in ("figures", "network")},
         "rows": C_rows, "main_system": main_sys}

    md = ["# Rule extraction", "",
          "| Test set | Rules | Exact match | 95% CI (Wilson) | Clause detected as operational |", "|---|---:|---:|---|---:|"]
    for name, S in [("A. Development (gold, 9 clauses)", A), ("B. Parallel held-out (other categories)", B)]:
        lo, hi = wilson(S["exact"], S["n"])
        md.append(f"| {name} | {S['n']} | {pct(S['exact'] / max(S['n'], 1))}% | [{pct(lo)}, {pct(hi)}] | {pct(S['operational_recall'])}% |")
    for s_name, label in [("figures", "C1. Numeric, figure requirements (used for error analysis)"),
                          ("network", "C2. Numeric, network limits (held-out: never inspected)")]:
        rows = [x for x in loc if x["set"] == s_name]
        k = sum(x["strict"] for x in rows)
        lo, hi = wilson(k, len(rows))
        n_all = sum(1 for x in C_rows if x["set"] == s_name)
        md.append(f"| {label} | {len(rows)} of {n_all} located | {pct(k / max(len(rows), 1))}% "
                  f"(value {pct(sum(x['value'] for x in rows) / max(len(rows), 1))}%) | [{pct(lo)}, {pct(hi)}] | "
                  f"{pct(sum(x['operational'] for x in rows) / max(len(rows), 1))}% |")
    if main_sys:
        md += ["", f"Main system's extractor on set C (its own segmentation): exact {pct(main_sys['exact_recall'])}%, "
                   f"value {pct(main_sys['value_recall'])}% of {main_sys['n']}."]
    md += ["", "## Parameter agreement (development set A)", "", "| Parameter | Agreement |", "|---|---:|"]
    md += [f"| {k} | {pct(v)}% |" for k, v in A["per_param"].items()]
    md += ["", f"Rules extracted from the 9 gold clauses: {A['extracted']}; matching a gold rule: {A['exact']}; "
               f"others: {len(A['extra'])} (an upper bound on spurious rules: some state real obligations the gold set does not cover).", "",
           "## Parallel set B by institution category", "", "| Category | Exact / clauses |", "|---|---:|"]
    md += [f"| {c} | {v[0]} / {v[1]} |" for c, v in sorted(by_cat.items())]
    misses = [r for r in A["rows"] + B["rows"] if not r["exact"]]
    if misses:
        md += ["", "## Misses", "", "| Gold rule | Clause | Disagreeing parameters |", "|---|---|---|"]
        md += [f"| {r['gold']} | {r['clause']} | {', '.join(k for k, ok in r['params'].items() if not ok) or 'no rule of this kind'} |" for r in misses]
    save("extraction", {"A_development": A, "B_parallel": B, "B_by_category": by_cat, "C_numeric": C}, md)


if __name__ == "__main__":
    main()
