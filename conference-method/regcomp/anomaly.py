"""Unsupervised monitoring for clauses without a programmatic condition (paper Sec. III).

KYC Directions para 40 asks the bank to monitor transactions "inconsistent with the normal
and expected activity of the customer", "high account turnover inconsistent with the size of
the balance maintained" and "third-party cheques ... followed by cash withdrawals for large
amounts". None of these has a numeric limit, so a validator cannot test them. Instead each
account-month is described by behavioural features and scored by Isolation Forest or a
One-Class SVM; units above the threshold become REVIEW findings (never VIOLATION) citing
the clause, with the features that deviate most as the explanation.
"""
from __future__ import annotations

import collections
import json
import math
from datetime import date

import numpy as np

FEATURES = [
    "log_turnover",            # credits + debits in the month
    "turnover_to_balance",     # (credits + debits) / average daily balance
    "max_txn_to_history",      # largest transaction / median monthly largest transaction in earlier months
    "max_txn_to_income",       # largest transaction / usual monthly salary credit
    "n_txn",
    "n_counterparties",
    "cash_withdrawal_share",   # cash debits / all debits
    "cheque_then_cash",        # cash withdrawn within 3 days after cheque credits from others / those credits
    "credit_debit_symmetry",   # min(credits, debits) / max(credits, debits)
]


def account_months(rows: list[dict]) -> dict[str, dict]:
    """Behavioural features per account-month, from raw transaction rows only."""
    by_acc = collections.defaultdict(list)
    for r in rows:
        by_acc[r["account_id"]].append(r)
    out = {}
    for acc, txs in by_acc.items():
        txs.sort(key=lambda r: (r["date"], r["direction"] != "opening", r["direction"] != "credit"))
        bal = 0.0
        history_max, salary = [], []
        months = collections.OrderedDict()
        for r in txs:
            months.setdefault(r["date"][:7], []).append(r)
        for mon, ms in months.items():
            daily = []
            credits = debits = cash_out = 0.0
            cps = set()
            mx = 0.0
            cheque_in = []
            cash_after = 0.0
            for r in ms:
                a = r["amount"]
                if r["direction"] == "opening":
                    bal = a
                    continue
                if r["direction"] == "credit":
                    bal += a
                    credits += a
                    if r["mode"] == "cheque":
                        cheque_in.append((date.fromisoformat(r["date"]), a))
                    if r["mode"] == "neft" and r.get("counterparty") == "EMPLOYER" and r["date"][8:10] <= "03":
                        salary.append(a)
                else:
                    bal -= a
                    debits += a
                    if r["mode"] == "cash":
                        cash_out += a
                        d = date.fromisoformat(r["date"])
                        if any(0 <= (d - cd).days <= 3 for cd, _ in cheque_in):
                            cash_after += a
                if r.get("counterparty"):
                    cps.add(r["counterparty"])
                mx = max(mx, a)
                daily.append(bal)
            if not daily:
                continue
            avg_bal = max(float(np.mean(daily)), 1000.0)
            hist = float(np.median(history_max)) if history_max else mx
            inc = float(np.median(salary)) if salary else max(credits, 1.0)
            cheque_total = sum(a for _, a in cheque_in)
            out[f"acct_month:{acc}:{mon}"] = {
                "account_id": acc, "month": mon,
                "log_turnover": math.log1p(credits + debits),
                "turnover_to_balance": (credits + debits) / avg_bal,
                "max_txn_to_history": mx / max(hist, 1.0),
                "max_txn_to_income": mx / max(inc, 1.0),
                "n_txn": len(daily),
                "n_counterparties": len(cps),
                "cash_withdrawal_share": cash_out / debits if debits else 0.0,
                "cheque_then_cash": min(cash_after / cheque_total, 2.0) if cheque_total else 0.0,
                "credit_debit_symmetry": min(credits, debits) / max(credits, debits) if max(credits, debits) else 0.0,
            }
            history_max.append(mx)
    return out


def matrix(feats: dict[str, dict], ids: list[str]) -> np.ndarray:
    X = np.array([[feats[i][f] for f in FEATURES] for i in ids], dtype=float)
    return np.sign(X) * np.log1p(np.abs(X))          # compress heavy tails


class Monitor:
    """Isolation Forest or One-Class SVM over standardised account-month features."""

    def __init__(self, method: str = "iforest", seed: int = 0, nu: float = 0.05):
        from sklearn.ensemble import IsolationForest
        from sklearn.preprocessing import RobustScaler
        from sklearn.svm import OneClassSVM
        self.method = method
        self.scaler = RobustScaler()
        if method == "iforest":
            self.model = IsolationForest(n_estimators=300, contamination="auto", random_state=seed)
        elif method == "ocsvm":
            self.model = OneClassSVM(kernel="rbf", gamma="scale", nu=nu)
        else:
            raise ValueError(method)
        self.threshold = None

    def fit(self, X: np.ndarray) -> "Monitor":
        Z = self.scaler.fit_transform(X)
        self.model.fit(Z)
        self.center = np.median(X, axis=0)
        # robust spread, floored so that features which are almost always 0 do not explode
        self.spread = np.maximum(1.4826 * np.median(np.abs(X - self.center), axis=0), 0.5 * X.std(axis=0)) + 1e-6
        return self

    def score(self, X: np.ndarray) -> np.ndarray:
        """Higher = more anomalous."""
        return -self.model.decision_function(self.scaler.transform(X))

    def calibrate(self, X: np.ndarray, quantile: float) -> float:
        """Threshold = the given quantile of scores on (unlabelled) calibration data."""
        self.threshold = float(np.quantile(self.score(X), quantile))
        return self.threshold

    def explain(self, x: np.ndarray, top: int = 3) -> list[tuple[str, float]]:
        z = (x - self.center) / self.spread
        order = np.argsort(-np.abs(z))[:top]
        return [(FEATURES[i], round(float(z[i]), 2)) for i in order]


def review_findings(monitor: Monitor, feats: dict[str, dict], ids: list[str], X: np.ndarray, clause: dict) -> list[dict]:
    s = monitor.score(X)
    out = []
    for uid, x, sc in zip(ids, X, s):
        if sc < monitor.threshold:
            continue
        out.append({"unit_id": uid, "status": "REVIEW", "detector": monitor.method, "score": round(float(sc), 4),
                    "threshold": round(monitor.threshold, 4),
                    "explanation": [{"feature": f, "robust_z": z, "value": round(feats[uid][f], 3)} for f, z in monitor.explain(x)],
                    "source": clause})
    return sorted(out, key=lambda f: -f["score"])


def read_rows(path: str) -> list[dict]:
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]
