"""End-to-end compliance verification (paper Fig. 1).

  ingested clauses ──► scope to the institution's category ──► obligation detection
        ──► rule extraction (cached) ──► clause embeddings ──► FAISS index
  evidence units ──► unit descriptions ──► embeddings ──► top-k clauses (sim ≥ τ)
        ──► validators on the rules of each linked clause ──► findings + audit trail

Linking modes (for the ablations):
  retrieval   top-k nearest clauses above τ (the method)
  oracle      the clauses of the gold rules for the unit's evidence type (upper bound for linking)
  all         every rule of every in-scope clause, no linking (rule-only baseline)
Parameter modes:
  extracted   rules extracted from the clause text (the method)
  gold        hand-written parameters for the gold clauses (upper bound for extraction)

python -m regcomp.pipeline --corpus <ingest out> --units <units.jsonl> --encoder tfidf --tau 0.2 --out results/run
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import hashlib
import json
import os
import re
import time

import numpy as np
import yaml

from . import __version__
from .encoders import get_encoder
from .index import ClauseIndex
from .ingest import read_jsonl
from .obligations import is_operational
from .records import read_units
from .rules import extract_rules
from .validators import validate

HERE = os.path.dirname(os.path.abspath(__file__))
GOLD_PATH = os.path.join(HERE, "..", "data", "gold_rules.yaml")
SECTOR_IN_TITLE = re.compile(r"\(([A-Z][A-Za-z -]{2,80}?) - ")


def _norm_ws(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().lower()


def doc_in_scope(doc: dict, category: str) -> bool:
    """A direction applies to the institution if it is filed under its category, names its
    sector in the title, or is a cross-sector direction (no category, no sector in the title)."""
    name = category.replace("_", " ").lower()
    if (doc.get("category") or "").replace("_", " ").lower() == name:
        return True
    m = SECTOR_IN_TITLE.search(doc.get("title") or "")
    if m:
        return m.group(1).lower() == name
    return doc.get("category") is None


def load_gold(path: str = GOLD_PATH) -> dict:
    with open(path, encoding="utf-8") as f:
        return yaml.safe_load(f)


def locate_gold(gold: dict, docs: dict, clauses: list[dict]) -> dict:
    """gold rule id -> clause id, by the exact quote inside a document whose title matches."""
    out = {}
    entries = list(gold["rules"]) + ([gold["anomaly_clause"]] if gold.get("anomaly_clause") else [])
    for g in entries:
        q = _norm_ws(g["quote"])
        hits = [c["clause_id"] for c in clauses
                if g["title_contains"].lower() in (docs[c["doc_id"]]["title"] or "").lower() and q in _norm_ws(c["text"])]
        if len(hits) != 1:
            raise ValueError(f"gold {g['id']}: quote found in {len(hits)} clauses")
        out[g["id"]] = hits[0]
    return out


class Pipeline:
    def __init__(self, corpus: str, category: str = "commercial_banks", encoder: str = "tfidf", k: int = 5,
                 tau: float = 0.0, link: str = "retrieval", params: str = "extracted", as_of: str | None = None,
                 gold_path: str = GOLD_PATH, cache: str | None = None, log=print):
        self.cfg = dict(category=category, encoder=encoder, k=k, tau=tau, link=link, params=params)
        self.log = log
        self.gold = load_gold(gold_path)
        self.as_of = dt.date.fromisoformat(as_of or self.gold["as_of"])
        self.docs = {d["doc_id"]: d for d in read_jsonl(os.path.join(corpus, "docs.jsonl"))}
        all_clauses = read_jsonl(os.path.join(corpus, "clauses.jsonl"))
        scoped = [c for c in all_clauses if doc_in_scope(self.docs[c["doc_id"]], category)]
        self.clauses = [c for c in scoped if is_operational(c["text"], c.get("kind", "paragraph"))]
        self.by_id = {c["clause_id"]: c for c in self.clauses}
        self.gold_clause = locate_gold(self.gold, self.docs, scoped)
        missing = [g for g, c in self.gold_clause.items() if c not in self.by_id and not g.startswith("A")]
        if missing:
            self.log(f"warning: gold clauses not detected as operational: {missing}")
        self.cache = cache or os.path.join(corpus, "cache")
        os.makedirs(self.cache, exist_ok=True)
        self.rules = self._rules(corpus, category)
        if params == "gold":
            for gid, cid in self.gold_clause.items():
                self.rules.pop(cid, None)
            for g in self.gold["rules"]:
                cid = self.gold_clause[g["id"]]
                self.rules.setdefault(cid, []).append(dict(g["params"], rule_id=g["id"], clause_id=cid, sentence=g["quote"]))
        self.n_scoped_docs = len({c["doc_id"] for c in scoped})
        self.encoder = None
        self.index = None
        self.timings = {}

    # ── rules ──

    def _rules(self, corpus: str, category: str) -> dict:
        code = hashlib.sha1(b"".join(open(os.path.join(HERE, f), "rb").read() for f in ("rules.py", "lexicon.py", "obligations.py", "text.py"))).hexdigest()[:10]
        path = os.path.join(self.cache, f"rules_{category}_v{__version__}_{code}.json")
        if os.path.exists(path) and os.path.getmtime(path) > os.path.getmtime(os.path.join(corpus, "clauses.jsonl")):
            with open(path, encoding="utf-8") as f:
                return json.load(f)
        t = time.time()
        out = {}
        for c in self.clauses:
            rs = [r.as_dict() for r in extract_rules(c["clause_id"], c["text"])]
            if rs:
                out[c["clause_id"]] = rs
        with open(path, "w", encoding="utf-8") as f:
            json.dump(out, f, ensure_ascii=False)
        self.log(f"extracted {sum(map(len, out.values()))} rules from {len(out)} of {len(self.clauses)} operational clauses "
                 f"in {time.time() - t:.1f}s")
        return out

    # ── linking ──

    def clause_text(self, c: dict) -> str:
        d = self.docs[c["doc_id"]]
        sec = " > ".join(c.get("section") or [])
        return f"{sec}. {c['text']}" if sec else c["text"]

    def build_index(self, encoder=None):
        t = time.time()
        self.encoder = encoder or get_encoder(self.cfg["encoder"])
        texts = [self.clause_text(c) for c in self.clauses]
        if self.encoder.sparse:
            self.encoder.fit(texts)
            vecs = self.encoder.encode_docs(texts)
        else:
            key = hashlib.sha1(("\n".join(c["clause_id"] for c in self.clauses) + self.encoder.name).encode()).hexdigest()[:12]
            path = os.path.join(self.cache, f"emb_{self.encoder.name}_{key}.npy")
            if os.path.exists(path):
                vecs = np.load(path)
            else:
                vecs = self.encoder.encode_docs(texts)
                np.save(path, vecs)
        self.index = ClauseIndex(vecs, [c["clause_id"] for c in self.clauses])
        self.timings["index_s"] = time.time() - t
        self.log(f"indexed {len(self.clauses)} clauses with {self.encoder.name} ({self.index.backend}) in {self.timings['index_s']:.1f}s")

    def link(self, units, k: int | None = None) -> list[list[tuple[str, float, int]]]:
        """For every unit, its candidate clauses as (clause_id, similarity, rank)."""
        k = k or self.cfg["k"]
        mode = self.cfg["link"]
        if mode == "oracle":
            by_type = collections.defaultdict(list)
            for g in self.gold["rules"]:
                cid = self.gold_clause[g["id"]]
                if cid not in by_type[g["unit_type"]]:
                    by_type[g["unit_type"]].append(cid)
            return [[(c, 1.0, i + 1) for i, c in enumerate(by_type.get(u.unit_type, []))] for u in units]
        if mode == "all":
            ids = list(self.rules)
            return [[(c, 1.0, 0) for c in ids] for _ in units]
        if self.index is None:
            self.build_index()
        t = time.time()
        q = self.encoder.encode_queries([u.text for u in units])
        scores, idx = self.index.search(q, k)
        self.timings["link_s"] = time.time() - t
        return [[(self.index.ids[j], float(s), r + 1) for r, (s, j) in enumerate(zip(srow, irow)) if j >= 0]
                for srow, irow in zip(scores, idx)]

    # ── validation ──

    def check(self, units, links=None) -> list[dict]:
        """Validator outcomes for every (unit, linked clause, rule). Filter by similarity ≥ τ afterwards."""
        links = links if links is not None else self.link(units)
        t = time.time()
        out = []
        calls = 0
        for u, cands in zip(units, links):
            for cid, sim, rank in cands:
                rules = self.rules.get(cid) or []
                for r in rules:
                    calls += 1
                    o = validate(r, u.unit_type, u.data, self.as_of, rules)
                    if o.status == "NOT_APPLICABLE":
                        continue
                    out.append({"unit_id": u.unit_id, "unit_type": u.unit_type, "lang": u.lang, "split": u.split,
                                "clause_id": cid, "rule_id": r["rule_id"], "similarity": sim, "rank": rank,
                                "status": o.status, "validator": o.validator, "detail": o.detail})
        self.timings["validate_s"] = time.time() - t
        self.timings["validator_calls"] = calls
        return out

    def findings(self, outcomes: list[dict], tau: float | None = None) -> list[dict]:
        """VIOLATION outcomes above τ, with their audit trail."""
        tau = self.cfg["tau"] if tau is None else tau
        now = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
        rule_of = {(cid, r["rule_id"]): r for cid, rs in self.rules.items() for r in rs}
        out = []
        for o in outcomes:
            if o["status"] != "VIOLATION" or o["similarity"] < tau:
                continue
            c = self.by_id.get(o["clause_id"]) or {}
            d = self.docs.get(c.get("doc_id"), {})
            r = rule_of[(o["clause_id"], o["rule_id"])]
            params = {k: v for k, v in r.items() if k not in ("rule_id", "clause_id", "sentence") and v not in (None, [], {}, "")}
            out.append({
                "unit_id": o["unit_id"], "unit_type": o["unit_type"], "status": "VIOLATION",
                "rule_id": o["rule_id"], "params": params, "validator": o["validator"], "detail": o["detail"],
                "remediation": (o["detail"] or {}).get("remediation") or r.get("remediation"),
                "source": {"clause_id": o["clause_id"], "direction": d.get("title"), "rbi_ref": d.get("rbi_ref"), "date": d.get("date"),
                           "paragraph": c.get("key"), "section": c.get("section"), "pages": [c.get("page_start"), c.get("page_end")],
                           "quote": r.get("sentence")},
                "trail": {"similarity": round(o["similarity"], 4), "rank": o["rank"], "tau": tau, "encoder": self.cfg["encoder"],
                          "link_mode": self.cfg["link"], "param_mode": self.cfg["params"], "as_of": str(self.as_of),
                          "pipeline_version": __version__, "checked_at": now},
            })
        return out


def write_report(findings: list[dict], units, path: str, title: str = "Compliance findings", limit: int = 200) -> None:
    """Markdown audit report: summary by provision, then one entry per finding with its trail."""
    text_of = {u.unit_id: u.text for u in units}
    by_rule = collections.Counter((f["source"]["direction"], f["source"]["paragraph"], f["source"]["quote"]) for f in findings)
    lines = [f"# {title}", "", f"{len(findings)} violations in {len({f['unit_id'] for f in findings})} of {len(units)} records.", "",
             "| Direction | Para | Provision | Violations |", "|---|---|---|---:|"]
    for (doc, para, quote), n in by_rule.most_common():
        q = (quote or "").replace("|", "/")
        lines.append(f"| {doc} | {para} | {q[:140]}{'…' if len(q) > 140 else ''} | {n} |")
    lines += ["", "## Findings", ""]
    for f in findings[:limit]:
        s, t = f["source"], f["trail"]
        lines += [
            f"### {f['unit_id']} — {f['rule_id']}",
            f"- **Evidence:** {text_of.get(f['unit_id'], '')}",
            f"- **Provision:** {s['direction']}, para {s['paragraph']} (pp. {s['pages'][0]}–{s['pages'][1]}; {s['rbi_ref'] or '-'})",
            f"- **Quote:** \"{s['quote']}\"",
            f"- **Test:** {f['validator']} {json.dumps(f['params'], ensure_ascii=False)}",
            f"- **Result:** {json.dumps(f['detail'], ensure_ascii=False, default=str)}",
        ]
        if f.get("remediation"):
            lines.append(f"- **Remediation:** {json.dumps(f['remediation'], ensure_ascii=False)}")
        lines += [f"- **Trail:** similarity {t['similarity']} (rank {t['rank']}, τ = {t['tau']}), encoder {t['encoder']}, "
                  f"linking {t['link_mode']}, parameters {t['param_mode']}, as of {t['as_of']}, v{t['pipeline_version']}, {t['checked_at']}", ""]
    if len(findings) > limit:
        lines.append(f"_{len(findings) - limit} further findings are in findings.jsonl._")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--corpus", required=True)
    ap.add_argument("--units", required=True)
    ap.add_argument("--encoder", default="tfidf")
    ap.add_argument("--k", type=int, default=5)
    ap.add_argument("--tau", type=float, default=0.0)
    ap.add_argument("--link", default="retrieval", choices=["retrieval", "oracle", "all"])
    ap.add_argument("--params", default="extracted", choices=["extracted", "gold"])
    ap.add_argument("--split", default=None, help="only units of this split (train/dev/test)")
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    units = read_units(a.units)
    if a.split:
        units = [u for u in units if u.split == a.split]
    p = Pipeline(a.corpus, encoder=a.encoder, k=a.k, tau=a.tau, link=a.link, params=a.params)
    outcomes = p.check(units)
    fs = p.findings(outcomes)
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, "findings.jsonl"), "w", encoding="utf-8") as f:
        for x in fs:
            f.write(json.dumps(x, ensure_ascii=False, default=str) + "\n")
    write_report(fs, units, os.path.join(a.out, "report.md"))
    print(f"{len(fs)} violations; report: {os.path.join(a.out, 'report.md')}")


if __name__ == "__main__":
    main()
