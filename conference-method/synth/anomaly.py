"""Synthetic transaction histories for the monitoring clause (KYC Directions para 40:
"the bank shall necessarily monitor ... (1) large and complex transactions ... inconsistent
with the normal and expected activity of the customer ... (3) high account turnover
inconsistent with the size of the balance maintained ... (4) deposit of third-party cheques
... followed by cash withdrawals for large amounts").

Writes raw transactions (one row per transaction) for savings accounts over several months,
with a small share of account-months carrying one of the three patterns, plus benign
irregularities (festival spending, one-off bonuses, fixed-deposit maturities) that a
detector should not flag. Labels go to a separate file; regcomp/anomaly.py computes its
features from the raw rows only.

python -m synth.anomaly --out <dir> --accounts 2000 --months 6 --rate 0.04
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from datetime import date, timedelta

PATTERNS = ["unusual_large", "high_turnover", "third_party_cash"]


def _split(acc: str) -> str:
    h = int(hashlib.sha1(acc.encode()).hexdigest(), 16) % 100
    return "train" if h < 70 else "validation" if h < 85 else "test"


def generate(out: str, accounts: int = 2000, months: int = 6, rate: float = 0.04, seed: int = 11) -> dict:
    rnd = random.Random(seed)
    os.makedirs(out, exist_ok=True)
    rows, labels = [], []
    start = date(2025, 10, 1)
    for a in range(accounts):
        acc = f"SB{a:05d}"
        income = rnd.choice([15000, 25000, 40000, 60000, 90000, 150000]) * rnd.uniform(0.8, 1.2)
        balance = income * rnd.uniform(0.5, 3.0)
        rows.append({"account_id": acc, "date": start.isoformat(), "direction": "opening", "amount": round(balance, 2),
                     "mode": "opening", "counterparty": None})
        for m in range(months):
            first = date(start.year + (start.month - 1 + m) // 12, (start.month - 1 + m) % 12 + 1, 1)
            day = lambda lo=1, hi=27: first + timedelta(days=rnd.randint(lo, hi) - 1)
            month_rows = []
            add = lambda d, direction, amt, mode, cp=None: month_rows.append(
                {"account_id": acc, "date": d.isoformat(), "direction": direction, "amount": round(amt, 2), "mode": mode, "counterparty": cp})
            # normal activity
            add(day(1, 3), "credit", income * rnd.uniform(0.97, 1.03), "neft", "EMPLOYER")
            for _ in range(rnd.randint(4, 14)):
                add(day(), "debit", income * rnd.uniform(0.01, 0.12), rnd.choice(["upi", "upi", "card", "neft"]), f"M{rnd.randint(1, 400)}")
            if rnd.random() < 0.5:
                add(day(), "debit", income * rnd.uniform(0.05, 0.25), "cash")
            if rnd.random() < 0.15:
                add(day(), "credit", income * rnd.uniform(0.05, 0.3), "cheque", f"P{rnd.randint(1, 900)}")
            # benign irregularities (hard negatives)
            benign = None
            r = rnd.random()
            if r < 0.04:
                benign = "bonus"
                add(day(), "credit", income * rnd.uniform(1.5, 3.0), "neft", "EMPLOYER")
            elif r < 0.07:
                benign = "fd_maturity"
                add(day(), "credit", income * rnd.uniform(2, 6), "internal", "OWN_FD")
            elif r < 0.10:
                benign = "festival"
                for _ in range(rnd.randint(5, 10)):
                    add(day(), "debit", income * rnd.uniform(0.03, 0.08), "card", f"M{rnd.randint(1, 400)}")
            # injected patterns
            pattern = None
            if m >= 2 and rnd.random() < rate:          # history first, so "normal activity" is defined
                pattern = rnd.choice(PATTERNS)
                if pattern == "unusual_large":
                    amt = income * rnd.uniform(4, 12)
                    d = day()
                    add(d, "credit", amt, "rtgs", f"X{rnd.randint(1, 50)}")
                    add(d + timedelta(days=rnd.randint(0, 2)), "debit", amt * rnd.uniform(0.9, 1.0), "rtgs", f"Y{rnd.randint(1, 50)}")
                elif pattern == "high_turnover":
                    for _ in range(rnd.randint(6, 15)):
                        amt = income * rnd.uniform(0.3, 0.8)
                        d = day()
                        cp = f"Z{rnd.randint(1, 200)}"
                        add(d, "credit", amt, rnd.choice(["upi", "imps", "neft"]), cp)
                        add(d + timedelta(days=rnd.randint(0, 1)), "debit", amt * rnd.uniform(0.95, 1.0), rnd.choice(["upi", "imps", "neft"]), f"W{rnd.randint(1, 200)}")
                else:
                    for _ in range(rnd.randint(1, 2)):
                        amt = income * rnd.uniform(0.8, 2.5)
                        d = day(1, 24)
                        add(d, "credit", amt, "cheque", f"T{rnd.randint(1, 900)}")
                        add(d + timedelta(days=rnd.randint(1, 3)), "debit", amt * rnd.uniform(0.8, 1.0), "cash")
            month_rows.sort(key=lambda x: (x["date"], x["direction"] != "credit"))
            rows.extend(month_rows)
            labels.append({"unit_id": f"acct_month:{acc}:{first.isoformat()[:7]}", "account_id": acc, "month": first.isoformat()[:7],
                           "anomalous": pattern is not None, "pattern": pattern, "benign_irregularity": benign, "split": _split(acc)})
    with open(os.path.join(out, "transactions.jsonl"), "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    with open(os.path.join(out, "labels.jsonl"), "w") as f:
        for r in labels:
            f.write(json.dumps(r) + "\n")
    stats = {"accounts": accounts, "months": months, "account_months": len(labels), "transactions": len(rows),
             "anomalous": sum(l["anomalous"] for l in labels),
             "by_pattern": {p: sum(l["pattern"] == p for l in labels) for p in PATTERNS},
             "benign_irregular": sum(bool(l["benign_irregularity"]) for l in labels), "seed": seed}
    with open(os.path.join(out, "stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    return stats


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--accounts", type=int, default=2000)
    ap.add_argument("--months", type=int, default=6)
    ap.add_argument("--rate", type=float, default=0.04)
    ap.add_argument("--seed", type=int, default=11)
    a = ap.parse_args()
    print(json.dumps(generate(a.out, a.accounts, a.months, a.rate, a.seed), indent=1))
