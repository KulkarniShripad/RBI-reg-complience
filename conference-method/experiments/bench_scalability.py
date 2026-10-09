"""Throughput and scaling of each stage, on the machine it runs on (hardware is recorded).

  ingestion          pages/s over a sample of PDFs (pypdf, cleaning, segmentation)
  extraction         clauses/s for obligation detection + rule extraction over the whole corpus
  encoding           texts/s per encoder
  search             FAISS exact inner-product search, ms per query, for 1k-200k vectors
  end to end         link + validate time per evidence unit as the number of units grows,
                     against rule-only (every rule on every unit)

python experiments/bench_scalability.py [--encoders tfidf,bge-onnx] [--pdfs 20]
"""
from __future__ import annotations

import argparse
import glob
import os
import random
import tempfile
import time

import numpy as np

from common import CORPUS, PDFS, hardware, need, save

from regcomp.encoders import get_encoder
from regcomp.ingest import ingest, read_jsonl
from regcomp.obligations import is_operational
from regcomp.pipeline import Pipeline
from regcomp.records import read_units
from regcomp.rules import extract_rules


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--encoders", default="tfidf,bge-onnx")
    ap.add_argument("--pdfs", type=int, default=20)
    ap.add_argument("--scales", default="1,4,16")
    a = ap.parse_args()
    need(os.path.join(CORPUS, "clauses.jsonl"), "python -m regcomp.ingest --pdfs ../circulars --out work/corpus")
    res = {"hardware": hardware()}

    # ingestion
    pdfs = sorted(glob.glob(os.path.join(PDFS, "**", "*.pdf"), recursive=True) + glob.glob(os.path.join(PDFS, "**", "*.PDF"), recursive=True))
    pdfs = sorted(set(pdfs))
    if pdfs:
        sample = random.Random(0).sample(pdfs, min(a.pdfs, len(pdfs)))
        t = time.time()
        docs, clauses, _ = ingest(sample, root=PDFS)
        secs = time.time() - t
        pages = sum(d.pages for d in docs)
        res["ingestion"] = {"pdfs": len(sample), "pages": pages, "clauses": len(clauses), "seconds": secs, "pages_per_s": pages / secs}

    # extraction over the whole corpus
    clauses = read_jsonl(os.path.join(CORPUS, "clauses.jsonl"))
    t = time.time()
    op = [c for c in clauses if is_operational(c["text"], c.get("kind", "paragraph"))]
    t_det = time.time() - t
    t = time.time()
    n_rules = sum(len(extract_rules(c["clause_id"], c["text"])) for c in op)
    t_ext = time.time() - t
    res["extraction"] = {"clauses": len(clauses), "operational": len(op), "rules": n_rules,
                         "detect_clauses_per_s": len(clauses) / t_det, "extract_clauses_per_s": len(op) / t_ext}

    # encoding throughput
    texts = [c["text"] for c in random.Random(1).sample(clauses, 300)]
    res["encoding"] = {}
    for spec in a.encoders.split(","):
        try:
            enc = get_encoder(spec)
            if enc.sparse:
                enc.fit([c["text"] for c in clauses])
            t = time.time()
            enc.encode_docs(texts)
            res["encoding"][spec] = {"texts_per_s": len(texts) / (time.time() - t)}
        except (ImportError, OSError, ValueError) as e:
            res["encoding"][spec] = {"skipped": f"{type(e).__name__}: {e}"}

    # FAISS search scaling
    import faiss
    rng = np.random.default_rng(0)
    res["search"] = []
    for dim in (384, 768):
        q = rng.standard_normal((1000, dim)).astype(np.float32)
        q /= np.linalg.norm(q, axis=1, keepdims=True)
        for n in (1_000, 10_000, 50_000, 200_000):
            x = rng.standard_normal((n, dim)).astype(np.float32)
            x /= np.linalg.norm(x, axis=1, keepdims=True)
            idx = faiss.IndexFlatIP(dim)
            idx.add(x)
            t = time.time()
            idx.search(q, 10)
            res["search"].append({"dim": dim, "vectors": n, "ms_per_query": 1000 * (time.time() - t) / len(q)})
            del x, idx

    # end to end over growing evidence volumes (TF-IDF linking, so it runs anywhere)
    from synth.generate import generate
    res["end_to_end"] = []
    p = Pipeline(CORPUS, encoder="tfidf", k=5, log=lambda *x: None)
    p.build_index()
    p_all = Pipeline(CORPUS, link="all", log=lambda *x: None)
    for sc in [float(s) for s in a.scales.split(",")]:
        with tempfile.TemporaryDirectory() as d:
            generate(d, seed=7, scale=sc)
            units = read_units(os.path.join(d, "units.jsonl"))
        t = time.time()
        links = p.link(units)
        t_link = time.time() - t
        p.check(units, links)
        row = {"scale": sc, "units": len(units), "link_ms_per_unit": 1000 * t_link / len(units),
               "validate_ms_per_unit": 1000 * p.timings["validate_s"] / len(units), "validator_calls_per_unit": p.timings["validator_calls"] / len(units)}
        if sc <= 4:
            p_all.check(units)
            row.update(rule_only_ms_per_unit=1000 * p_all.timings["validate_s"] / len(units),
                       rule_only_calls_per_unit=p_all.timings["validator_calls"] / len(units))
        res["end_to_end"].append(row)
        print(row)

    hw = res["hardware"]
    md = [f"# Scalability ({hw.get('cpu')}, {hw.get('cpus')} CPUs, {hw.get('ram_gb')} GB RAM, GPU: {hw.get('gpu') or 'none'})", ""]
    if "ingestion" in res:
        g = res["ingestion"]
        md += [f"Ingestion: {g['pdfs']} PDFs, {g['pages']} pages in {g['seconds']:.1f}s ({g['pages_per_s']:.1f} pages/s).", ""]
    e = res["extraction"]
    md += [f"Obligation detection: {e['detect_clauses_per_s']:.0f} clauses/s over {e['clauses']} clauses; rule extraction: "
           f"{e['extract_clauses_per_s']:.0f} operational clauses/s ({e['operational']} clauses → {e['rules']} rules).", "",
           "| Encoder | Texts/s |", "|---|---:|"]
    md += [f"| {k} | {v['texts_per_s']:.1f} |" if "texts_per_s" in v else f"| {k} | not run ({v['skipped'][:60]}) |" for k, v in res["encoding"].items()]
    md += ["", "| Vectors | dim 384: ms/query | dim 768: ms/query |", "|---:|---:|---:|"]
    for n in sorted({s["vectors"] for s in res["search"]}):
        v = {s["dim"]: s["ms_per_query"] for s in res["search"] if s["vectors"] == n}
        md.append(f"| {n:,} | {v[384]:.3f} | {v[768]:.3f} |")
    md += ["", "| Units | Link ms/unit | Validate ms/unit | Validator calls/unit | Rule-only ms/unit | Rule-only calls/unit |", "|---:|---:|---:|---:|---:|---:|"]
    for r in res["end_to_end"]:
        md.append(f"| {r['units']:,} | {r['link_ms_per_unit']:.2f} | {r['validate_ms_per_unit']:.3f} | {r['validator_calls_per_unit']:.1f} | "
                  f"{r.get('rule_only_ms_per_unit', float('nan')):.3f} | {r.get('rule_only_calls_per_unit', float('nan')):.0f} |")
    save("scalability", res, md)


if __name__ == "__main__":
    main()
