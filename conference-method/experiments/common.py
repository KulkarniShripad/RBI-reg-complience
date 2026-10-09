"""Shared paths and helpers for the experiment scripts.

Data locations (override with environment variables):
  REGCOMP_PDFS    regulatory PDFs                 default ../circulars
  REGCOMP_WORK    generated data                  default ./work
      corpus/     python -m regcomp.ingest output
      synth/      python -m synth.generate output
      anomaly/    python -m synth.anomaly output
Results are written to ./results/<experiment>.json and .md.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import platform
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

PDFS = os.environ.get("REGCOMP_PDFS", os.path.join(ROOT, "..", "circulars"))
WORK = os.environ.get("REGCOMP_WORK", os.path.join(ROOT, "work"))
CORPUS = os.path.join(WORK, "corpus")
SYNTH = os.path.join(WORK, "synth")
ANOMALY = os.path.join(WORK, "anomaly")
RESULTS = os.path.join(ROOT, "results")


def hardware() -> dict:
    info = {"python": platform.python_version(), "platform": platform.platform(), "cpus": os.cpu_count()}
    try:
        with open("/proc/cpuinfo") as f:
            info["cpu"] = next((l.split(":", 1)[1].strip() for l in f if l.startswith("model name")), None)
        with open("/proc/meminfo") as f:
            info["ram_gb"] = round(int(next(l for l in f if l.startswith("MemTotal")).split()[1]) / 1024 / 1024, 1)
    except (OSError, StopIteration):
        info["cpu"] = platform.processor()
    try:
        import torch
        info["gpu"] = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except ImportError:
        info["gpu"] = None
    return info


def save(name: str, result: dict, markdown: list[str]) -> None:
    os.makedirs(RESULTS, exist_ok=True)
    result = dict(result, generated_at=dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))
    with open(os.path.join(RESULTS, f"{name}.json"), "w", encoding="utf-8") as f:
        json.dump(result, f, indent=1, ensure_ascii=False, default=str)
    with open(os.path.join(RESULTS, f"{name}.md"), "w", encoding="utf-8") as f:
        f.write("\n".join(markdown) + "\n")
    print("\n".join(markdown))
    print(f"\n→ results/{name}.json, results/{name}.md")


def pct(x: float | None, d: int = 1) -> str:
    return "–" if x is None else f"{100 * x:.{d}f}"


def ci(m: dict, key: str) -> str:
    """'91.2 [88.0, 94.1]' from a bootstrap_prf result."""
    lo, hi = (m.get("ci") or {}).get(key, (None, None))
    return f"{pct(m[key])} [{pct(lo)}, {pct(hi)}]" if lo is not None else pct(m[key])


def need(path: str, how: str) -> None:
    if not os.path.exists(path):
        sys.exit(f"missing {path}\n  create it with: {how}")
