"""Synthetic operational data for the compliance-verification experiments.

Real bank transaction data is confidential, so evidence is generated - but not
labelled by the system under test:

  1. raw logs are generated (transactions, KYC records, audit trails) from
     scenario recipes: compliant, violating, exact boundary, near boundary,
     proviso exemptions, batch transfers, grace periods, weekend / holiday
     deadlines, pending cases whose deadline has not passed, and distractor
     payments to which no rule under test applies;
  2. regcomp.records.build_units standardises them into evidence units;
  3. synth/gold.py labels every unit from hand-written readings of the 14 gold
     rules (independent of the system's extraction and validators);
  4. every unit is described in English or Marathi (two English phrasings);
  5. units are split 70/15/15 (train/validation/test), stratified by unit type
     and by whether the unit violates any rule.

  python -m synth.generate --out data/synth --seed 7 [--mr 0.3] [--scale 1.0]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
from datetime import date, datetime, timedelta

from regcomp.records import build_units, verbalize, write_units

from . import gold

AS_OF = gold.AS_OF
FY_START, FY_END = date(2025, 4, 1), date(2026, 3, 31)

FIRST = ["Aarav", "Vivaan", "Aditi", "Ananya", "Rohan", "Sneha", "Kabir", "Isha", "Arjun", "Meera", "Siddharth", "Pooja",
         "Rahul", "Neha", "Vikram", "Kavya", "Omkar", "Sakshi", "Tanvi", "Yash"]
LAST = ["Patil", "Kulkarni", "Deshmukh", "Joshi", "Shinde", "Pawar", "Sharma", "Iyer", "Reddy", "Nair", "Gupta", "Mehta"]
CITIES = ["Pune", "Mumbai", "Nagpur", "Nashik", "Dubai", "London", "Singapore", "New York", "Toronto", "Sydney"]


def pick(rng, weighted: list[tuple[str, float]]) -> str:
    r, acc = rng.random(), 0.0
    for k, w in weighted:
        acc += w
        if r < acc:
            return k
    return weighted[-1][0]


def rdate(rng, a: date, b: date) -> date:
    return a + timedelta(days=rng.randint(0, (b - a).days))


def name(rng) -> str:
    return f"{rng.choice(FIRST)} {rng.choice(LAST)}"


class Gen:
    def __init__(self, seed: int, scale: float):
        self.rng = random.Random(seed)
        self.scale = scale
        self.tx, self.kyc, self.audit = [], [], []
        self.tags = {}            # unit_id -> scenario tags
        self.n = 0

    def nid(self, p: str) -> str:
        self.n += 1
        return f"{p}{self.n:06d}"

    def count(self, base: int) -> int:
        return max(1, int(round(base * self.scale)))

    # ── small accounts (G01-G03) ──
    def small_accounts(self, n: int):
        rng = self.rng
        plan = [("compliant", .38), ("credits_over", .08), ("credits_boundary", .05), ("debits_over", .08), ("debits_boundary", .05),
                ("balance_over", .08), ("balance_boundary", .04), ("balance_exempt", .08), ("balance_exempt_over", .04),
                ("credits_and_balance_over", .04), ("near_limits", .08)]
        for _ in range(n):
            sc = pick(rng, plan)
            for _attempt in range(400):
                rows, ok = self._small_candidate(sc)
                if ok:
                    break
            else:
                raise RuntimeError(f"could not generate small-account scenario {sc}")
            acc, cust = rows[0]["account_id"], rows[0]["customer_id"]
            self.tx.extend(rows)
            self.tags[f"small:{acc}:2025-26"] = [sc]

    BALANCE_FAMILY = ("balance_over", "balance_boundary", "balance_exempt", "balance_exempt_over", "credits_and_balance_over")

    def _small_candidate(self, sc):
        rng = self.rng
        acc, cust = self.nid("SA"), self.nid("C")
        opening = rng.choice([0, 0, 500, 1000, 2500])
        months = [(2025, m) for m in range(4, 13)] + [(2026, m) for m in range(1, 4)]
        credits, debits = [], []                    # (date, amount, source) / (date, amount)
        if sc in self.BALANCE_FAMILY:
            peak_month = rng.randint(4, 9)
            peak = {"balance_over": rng.randint(50_001, 75_000), "balance_boundary": 50_000, "balance_exempt": rng.randint(30_000, 49_000),
                    "balance_exempt_over": rng.randint(50_001, 65_000), "credits_and_balance_over": rng.randint(52_000, 80_000)}[sc]
            # non-exempt credits up to the peak month, no debits before it
            need = peak - opening
            w = [rng.random() + 0.3 for _ in range(peak_month + 1)]
            parts = [int(need * x / sum(w)) for x in w]
            parts[-1] += need - sum(parts)
            for i, amt in enumerate(parts):
                y, m = months[i]
                credits.append((date(y, m, rng.randint(1, 10)), amt, "other"))
            if sc in ("balance_exempt", "balance_exempt_over"):
                y, m = months[peak_month]
                credits.append((date(y, m, 12), rng.randint(15_000, 40_000), rng.choice(["govt_grant", "welfare", "procurement"])))
            # after the peak: credits never exceed that month's debits, so the peak stays the peak
            room = (rng.randint(101_000, 125_000) if sc == "credits_and_balance_over" else rng.randint(peak, 99_000)) - need
            for i in range(peak_month + 1, len(months)):
                y, m = months[i]
                d = rng.randint(4_000, 9_900)
                c = max(0, min(d, room // max(1, len(months) - i)))
                if sc == "credits_and_balance_over":
                    c = max(0, room // max(1, len(months) - i))
                room -= c
                # debits early in the month, credits later: the balance never climbs back above the peak
                debits.append((date(y, m, rng.randint(1, 5)), max(d, c)))
                if c:
                    credits.append((date(y, m, rng.randint(15, 28)), c, "other"))
        else:
            target_total = {"credits_over": rng.randint(100_001, 125_000), "credits_boundary": 100_000,
                            "near_limits": rng.randint(95_000, 99_999)}.get(sc, rng.randint(30_000, 92_000))
            w = [rng.random() + 0.3 for _ in months]
            amounts = [int(target_total * x / sum(w)) for x in w]
            amounts[-1] += target_total - sum(amounts)
            bal = opening
            over_month = rng.randrange(len(months))
            for i, ((y, m), amt) in enumerate(zip(months, amounts)):
                credits.append((date(y, m, rng.randint(1, 10)), amt, "other"))
                bal += amt
                if sc == "debits_over" and i == over_month:
                    d = rng.randint(10_001, 14_000)
                elif sc == "debits_boundary" and i == over_month:
                    d = 10_000
                elif sc == "near_limits":
                    d = min(9_999, max(0, bal - 1_000)) if bal > 30_000 else rng.randint(9_000, 9_999) if bal > 10_000 else 0
                else:
                    d = min(9_900, max(0, bal - rng.randint(5_000, 30_000)))
                if d > 0:
                    debits.append((date(y, m, rng.randint(15, 28)), d))
                    bal -= d
        rows = []
        for dt, amt, src in credits:
            rows.append({"txn_id": self.nid("T"), "account_id": acc, "customer_id": cust, "account_type": "small", "date": dt.isoformat(),
                         "direction": "credit", "kind": "deposit", "channel": "DBT" if src != "other" else rng.choice(["CASH", "NEFT", "UPI"]),
                         "amount": float(amt), "source": src, "opening_balance": opening})
        for dt, amt in debits:
            a1 = round(amt * rng.uniform(0.3, 0.7))      # a month's debits: a withdrawal and a transfer
            for part, kind in ((a1, "withdrawal"), (amt - a1, "transfer")):
                if part > 0:
                    rows.append({"txn_id": self.nid("T"), "account_id": acc, "customer_id": cust, "account_type": "small", "date": dt.isoformat(),
                                 "direction": "debit", "kind": kind, "channel": "ATM" if kind == "withdrawal" else "UPI", "amount": float(part),
                                 "source": None, "opening_balance": opening})
        rows.sort(key=lambda r: (r["date"], 0 if r["direction"] == "credit" else 1))
        lab = gold.small_account({"txns": rows, "opening_balance": opening})
        want = {
            "compliant": (False, False, False), "near_limits": (False, False, False), "credits_boundary": (False, False, False),
            "debits_boundary": (False, False, False), "balance_boundary": (False, False, False), "balance_exempt": (False, False, False),
            "credits_over": (True, False, False), "debits_over": (False, True, False), "balance_over": (False, False, True),
            "balance_exempt_over": (False, False, True), "credits_and_balance_over": (True, False, True),
        }[sc]
        got = (lab["G01_small_credits"], lab["G02_small_debits"], lab["G03_small_balance"])
        if sc == "balance_exempt":
            b, raw_peak = opening, opening
            for r in rows:
                b += r["amount"] if r["direction"] == "credit" else -r["amount"]
                raw_peak = max(raw_peak, b)
            if raw_peak <= 50_000:                       # the exempt credit must take the raw balance over the limit
                return rows, False
        if sc == "credits_boundary" and abs(sum(r["amount"] for r in rows if r["direction"] == "credit") - 100_000) > 0.5:
            return rows, False
        return rows, got == want

    # ── wire transfers (G04) ──
    def wires(self, n: int):
        rng = self.rng
        plan = [("complete", .38), ("address_alternative", .10), ("missing_originator_name", .07), ("account_replaced_by_ref", .06),
                ("missing_account_and_ref", .06), ("missing_all_identity", .07), ("missing_beneficiary_name", .06),
                ("beneficiary_ref_only", .04), ("batch_ref_only", .07), ("batch_missing", .05), ("batch_missing_beneficiary", .04)]
        for _ in range(n):
            sc = pick(rng, plan)
            t = {"txn_id": self.nid("W"), "kind": "wire", "customer_id": self.nid("C"), "date": rdate(rng, date(2025, 4, 1), date(2026, 9, 25)).isoformat(),
                 "amount": float(rng.choice([rng.randint(25_000, 99_999), rng.randint(100_000, 2_500_000)])), "currency": rng.choice(["USD", "AED", "GBP", "SGD"]),
                 "cross_border": True, "batch": sc.startswith("batch"), "originator_name": name(rng), "originator_account": str(rng.randint(10**10, 10**11)),
                 "originator_address": f"{rng.randint(1, 400)}, {rng.choice(['MG Road', 'FC Road', 'Station Road', 'Link Road'])}, {rng.choice(CITIES[:4])}",
                 "originator_national_id": None, "originator_customer_id": None, "originator_dob_pob": None,
                 "beneficiary_name": name(rng), "beneficiary_account": rng.choice(["GB", "AE", "SG", "US"]) + str(rng.randint(10**12, 10**13)), "txn_ref": None}
            if sc == "address_alternative":
                t["originator_address"] = None
                k = rng.choice(["originator_national_id", "originator_customer_id", "originator_dob_pob"])
                t[k] = {"originator_national_id": f"XXXX-XXXX-{rng.randint(1000, 9999)}", "originator_customer_id": f"CIF{rng.randint(10**6, 10**7)}",
                        "originator_dob_pob": f"{rng.randint(1960, 2000)}-0{rng.randint(1, 9)}-1{rng.randint(0, 9)}, {rng.choice(CITIES[:4])}"}[k]
            elif sc == "missing_originator_name":
                t["originator_name"] = None
            elif sc == "account_replaced_by_ref":
                t["originator_account"], t["txn_ref"] = None, f"UTR{rng.randint(10**9, 10**10)}"
            elif sc == "missing_account_and_ref":
                t["originator_account"] = None
            elif sc == "missing_all_identity":
                t["originator_address"] = None
            elif sc == "missing_beneficiary_name":
                t["beneficiary_name"] = None
            elif sc == "beneficiary_ref_only":
                t["beneficiary_account"], t["txn_ref"] = None, f"UTR{rng.randint(10**9, 10**10)}"
            elif sc == "batch_ref_only":
                t.update(originator_name=None, originator_account=None, originator_address=None, txn_ref=f"BATCH{rng.randint(10**6, 10**7)}")
            elif sc == "batch_missing":
                t.update(originator_name=None, originator_account=None, originator_address=None)
            elif sc == "batch_missing_beneficiary":
                t.update(originator_name=None, originator_address=None, beneficiary_name=None)
            self.tx.append(t)
            self.tags[f"wire:{t['txn_id']}"] = [sc]

    # ── KYC (G05-G10) ──
    def kyc_new(self, n: int):
        rng = self.rng
        up_plan = [("on_time", .55), ("boundary_day_10", .10), ("late", .20), ("not_uploaded_overdue", .10), ("not_uploaded_pending", .05)]
        doc_ok = [["ovd", "pan"], ["aadhaar", "pan"], ["kyc_identifier", "pan"], ["ovd", "form60"], ["aadhaar", "form60", "photograph"], ["ovd", "pan", "photograph"]]
        doc_bad = [["ovd"], ["aadhaar", "photograph"], ["pan"], ["form60"], ["photograph"], []]
        for _ in range(n):
            cid = self.nid("C")
            sc = pick(rng, up_plan)
            if sc == "not_uploaded_pending":
                opened = AS_OF - timedelta(days=rng.randint(1, 9))
            else:
                opened = rdate(rng, date(2025, 1, 1), AS_OF - timedelta(days=45))
            uploaded = {"on_time": opened + timedelta(days=rng.randint(0, 9)), "boundary_day_10": opened + timedelta(days=10),
                        "late": opened + timedelta(days=rng.randint(11, 40))}.get(sc)
            bad_docs = rng.random() < 0.25
            docs = rng.choice(doc_bad if bad_docs else doc_ok)
            self.kyc.append({"customer_id": cid, "customer_type": "individual", "onboarding": True, "account_opened": opened.isoformat(),
                             "ckycr_uploaded": uploaded.isoformat() if uploaded else None, "documents": docs})
            self.tags[f"kyc_on:{cid}"] = [sc, "documents_missing" if bad_docs else "documents_ok"]

    def kyc_updates(self, n: int):
        rng = self.rng
        plan = [("on_time", .55), ("boundary_day_7", .10), ("late", .22), ("not_updated_overdue", .08), ("not_updated_pending", .05)]
        for _ in range(n):
            cid = self.nid("C")
            sc = pick(rng, plan)
            got = AS_OF - timedelta(days=rng.randint(1, 6)) if sc == "not_updated_pending" else rdate(rng, date(2025, 1, 1), AS_OF - timedelta(days=30))
            upd = {"on_time": got + timedelta(days=rng.randint(0, 6)), "boundary_day_7": got + timedelta(days=7), "late": got + timedelta(days=rng.randint(8, 30))}.get(sc)
            self.kyc.append({"customer_id": cid, "customer_type": "individual", "updated_info_obtained": got.isoformat(), "ckycr_updated": upd.isoformat() if upd else None})
            self.tags[f"kyc_upd:{cid}"] = [sc]

    def kyc_periodic(self, n: int):
        rng = self.rng
        for _ in range(n):
            cid = self.nid("C")
            risk = pick(rng, [("high", .3), ("medium", .35), ("low", .35)])
            ctype = "individual" if rng.random() < 0.8 else "legal_entity"
            years = {"high": 2, "medium": 8, "low": 10}[risk]
            sc = pick(rng, [("not_yet_due", .12), ("updated_on_time", .33), ("updated_late", .20), ("not_updated", .25), ("grace_window", .10)])
            if sc == "not_yet_due":
                due = AS_OF + timedelta(days=rng.randint(30, 600))
            elif sc == "grace_window":
                risk, ctype, years = "low", rng.choice(["individual", "individual", "legal_entity"]), 10
                due = rdate(rng, date(2025, 10, 5), date(2026, 4, 30))
            else:
                due = rdate(rng, date(2022, 1, 1), AS_OF - timedelta(days=200))
            base = gold._add_years(due, -years)
            opened = base if rng.random() < 0.4 else gold._add_years(base, -rng.randint(1, 6))
            last = None if opened == base else base
            updated = None
            if sc == "updated_on_time":
                updated = due - timedelta(days=rng.randint(0, 60))
            elif sc == "updated_late":
                updated = min(AS_OF - timedelta(days=5), due + timedelta(days=rng.randint(130, 700)))
            elif sc == "grace_window" and rng.random() < 0.3:
                updated = min(AS_OF - timedelta(days=3), due + timedelta(days=rng.randint(130, 300)))
            comms = []
            if due <= AS_OF:
                adv = pick(rng, [("ok", .6), ("no_letter", .15), ("two", .15), ("none", .10)])
                k = {"ok": rng.randint(3, 4), "no_letter": 3, "two": 2, "none": 0}[adv]
                modes = ["letter"] + [rng.choice(["sms", "email", "letter"]) for _ in range(k - 1)] if adv == "ok" else \
                        [rng.choice(["sms", "email"]) for _ in range(k)] if adv == "no_letter" else [rng.choice(["sms", "email", "letter"]) for _ in range(k)]
                for i, m in enumerate(modes):
                    comms.append(("advance_intimation", due - timedelta(days=90 - 25 * i), m))
                if updated is None or updated > due:
                    rem = pick(rng, [("ok", .6), ("no_letter", .15), ("few", .2), ("none", .05)])
                    k = {"ok": rng.randint(3, 4), "no_letter": 3, "few": rng.randint(1, 2), "none": 0}[rem]
                    modes = ["letter"] + [rng.choice(["sms", "email", "letter"]) for _ in range(k - 1)] if rem == "ok" else \
                            [rng.choice(["sms", "email"]) for _ in range(k)] if rem == "no_letter" else [rng.choice(["sms", "email", "letter"]) for _ in range(k)]
                    end = updated or AS_OF
                    span = max(30, (end - due).days - 5)
                    for i, m in enumerate(modes):
                        comms.append(("reminder", due + timedelta(days=10 + i * (span // max(1, k))), m))
            self.kyc.append({"customer_id": cid, "customer_type": ctype, "risk": risk, "periodic": True, "account_opened": opened.isoformat(),
                             "last_kyc_update": last.isoformat() if last else None, "kyc_updated": updated.isoformat() if updated else None})
            for kind, dt, mode in comms:
                self.audit.append({"event_id": self.nid("E"), "case_id": f"KYC-{cid}", "case_type": "kyc_comm", "entity_id": cid, "event": kind,
                                   "timestamp": f"{dt.isoformat()}T10:00:00", "attrs": {"mode": mode}})
            self.tags[f"kyc_per:{cid}"] = [sc, f"risk_{risk}", ctype]

    # ── audit-trail cases (G11-G14) ──
    def card_closures(self, n: int):
        rng = self.rng
        for _ in range(n):
            case, holder = self.nid("CC"), self.nid("C")
            sc = pick(rng, [("on_time", .45), ("boundary_7th_working_day", .10), ("late", .25), ("not_closed_overdue", .05),
                            ("not_closed_pending", .05), ("dues_shift_on_time", .10)])
            req = AS_OF - timedelta(days=rng.randint(1, 4)) if sc == "not_closed_pending" else rdate(rng, date(2025, 1, 1), AS_OF - timedelta(days=60))
            dues = req + timedelta(days=rng.randint(3, 20)) if sc == "dues_shift_on_time" or rng.random() < 0.15 else None
            start = max(req, dues) if dues else req
            closed = {"on_time": gold._plus_working_days(start, rng.randint(1, 6)), "boundary_7th_working_day": gold._plus_working_days(start, 7),
                      "late": gold._plus_working_days(start, rng.randint(8, 20)),
                      "dues_shift_on_time": gold._plus_working_days(start, rng.randint(2, 7))}.get(sc)
            ev = [("closure_requested", req)]
            if dues:
                ev.append(("dues_cleared", dues))
            if closed:
                ev.append(("card_closed", closed))
                cs = pick(rng, [("on_time", .7), ("boundary", .05), ("late", .15), ("none_overdue", .07), ("none_pending", .03)])
                if cs == "none_pending":
                    pass
                cic = {"on_time": closed + timedelta(days=rng.randint(1, 29)), "boundary": closed + timedelta(days=30),
                       "late": closed + timedelta(days=rng.randint(31, 75))}.get(cs)
                if cic and cic <= AS_OF:
                    ev.append(("cic_updated", cic))
            for k, dt in ev:
                self.audit.append({"event_id": self.nid("E"), "case_id": case, "case_type": "card_closure", "entity_id": holder, "event": k,
                                   "timestamp": dt.isoformat(), "attrs": {"card": f"XXXX-{rng.randint(1000, 9999)}"}})
            self.tags[f"card_closure:{case}"] = [sc]

    def complaints(self, n: int):
        rng = self.rng
        for _ in range(n):
            case = self.nid("CMP")
            sc = pick(rng, [("on_time", .5), ("boundary_day_30", .10), ("late", .28), ("no_decision_overdue", .06), ("no_decision_pending", .06)])
            rec = AS_OF - timedelta(days=rng.randint(1, 20)) if sc == "no_decision_pending" else rdate(rng, date(2025, 1, 1), AS_OF - timedelta(days=45))
            dec = {"on_time": rec + timedelta(days=rng.randint(3, 29)), "boundary_day_30": rec + timedelta(days=30), "late": rec + timedelta(days=rng.randint(31, 90))}.get(sc)
            ev = [("complaint_received", rec)] + ([("decision_communicated", dec)] if dec else [])
            for k, dt in ev:
                self.audit.append({"event_id": self.nid("E"), "case_id": case, "case_type": "complaint", "entity_id": self.nid("C"), "event": k,
                                   "timestamp": dt.isoformat(), "attrs": {}})
            self.tags[f"complaint:{case}"] = [sc]

    def cyber(self, n: int):
        rng = self.rng
        for _ in range(n):
            case = self.nid("CY")
            sc = pick(rng, [("on_time", .55), ("boundary_6h", .10), ("late", .28), ("not_reported", .07)])
            det = datetime.combine(rdate(rng, date(2025, 1, 1), AS_OF - timedelta(days=5)), datetime.min.time()) + timedelta(minutes=rng.randint(0, 24 * 60 - 1))
            rep = {"on_time": det + timedelta(minutes=rng.randint(20, 359)), "boundary_6h": det + timedelta(hours=6),
                   "late": det + timedelta(minutes=rng.randint(361, 60 * 48))}.get(sc)
            ev = [("incident_detected", det)] + ([("incident_reported_rbi", rep)] if rep else [])
            for k, dt in ev:
                self.audit.append({"event_id": self.nid("E"), "case_id": case, "case_type": "cyber_incident", "entity_id": f"SP{rng.randint(1, 20):02d}",
                                   "event": k, "timestamp": dt.isoformat(timespec="minutes"), "attrs": {}})
            self.tags[f"cyber_incident:{case}"] = [sc]

    def payments(self, n: int):
        rng = self.rng
        for _ in range(n):
            t = {"txn_id": self.nid("P"), "kind": "payment", "customer_id": self.nid("C"), "account_type": "savings",
                 "date": rdate(rng, date(2025, 4, 1), date(2026, 9, 25)).isoformat(), "channel": rng.choice(["UPI", "NEFT", "IMPS", "RTGS"]),
                 "amount": float(rng.choice([rng.randint(100, 9_999), rng.randint(10_000, 200_000)])), "payee": name(rng),
                 "purpose": rng.choice(["rent", "school fees", "electricity bill", "loan EMI", "insurance premium", "groceries"])}
            self.tx.append(t)
            self.tags[f"pay:{t['txn_id']}"] = ["distractor"]


def _split_of(unit_id: str, stratum: str, seed: int) -> str:
    h = int(hashlib.sha1(f"{seed}:{stratum}:{unit_id}".encode()).hexdigest()[:8], 16) / 0xFFFFFFFF
    return "train" if h < 0.70 else "validation" if h < 0.85 else "test"


def generate(out: str, seed: int = 7, mr: float = 0.3, scale: float = 1.0) -> dict:
    g = Gen(seed, scale)
    g.small_accounts(g.count(300))
    g.wires(g.count(300))
    g.kyc_new(g.count(400))
    g.kyc_updates(g.count(200))
    g.kyc_periodic(g.count(300))
    g.card_closures(g.count(250))
    g.complaints(g.count(200))
    g.cyber(g.count(150))
    g.payments(g.count(300))
    raw = os.path.join(out, "raw")
    os.makedirs(raw, exist_ok=True)
    for fname, rows in (("transactions.jsonl", g.tx), ("kyc.jsonl", g.kyc), ("audit.jsonl", g.audit)):
        with open(os.path.join(raw, fname), "w", encoding="utf-8") as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    units = build_units(raw)
    lr = random.Random(seed + 1)
    for u in units:
        u.truth = gold.label(u.unit_type, u.data)
        u.lang = "mr" if lr.random() < mr else "en"
        u.text = verbalize(u, u.lang, lr.randint(0, 1))
        u.tags = g.tags.get(u.unit_id, [])
        u.split = _split_of(u.unit_id, f"{u.unit_type}:{any(u.truth.values())}", seed)
    write_units(os.path.join(out, "units.jsonl"), units)
    stats = {"units": len(units), "by_type": {}, "violating_units": sum(1 for u in units if any(u.truth.values())),
             "rule_checks": sum(len(u.truth) for u in units), "rule_violations": sum(sum(u.truth.values()) for u in units),
             "by_split": {s: sum(1 for u in units if u.split == s) for s in ("train", "validation", "test")},
             "by_lang": {l: sum(1 for u in units if u.lang == l) for l in ("en", "mr")},
             "raw_rows": {"transactions": len(g.tx), "kyc": len(g.kyc), "audit": len(g.audit)}, "seed": seed, "as_of": AS_OF.isoformat()}
    for u in units:
        s = stats["by_type"].setdefault(u.unit_type, {"units": 0, "violating": 0})
        s["units"] += 1
        s["violating"] += int(any(u.truth.values()))
    per_rule = {}
    for u in units:
        for r, v in u.truth.items():
            p = per_rule.setdefault(r, {"checks": 0, "violations": 0})
            p["checks"] += 1
            p["violations"] += int(v)
    stats["by_rule"] = dict(sorted(per_rule.items()))
    with open(os.path.join(out, "stats.json"), "w") as f:
        json.dump(stats, f, indent=1)
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default="data/synth")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--mr", type=float, default=0.3, help="share of units described in Marathi")
    ap.add_argument("--scale", type=float, default=1.0, help="multiply all unit counts")
    a = ap.parse_args(argv)
    print(json.dumps(generate(a.out, a.seed, a.mr, a.scale), indent=1))


if __name__ == "__main__":
    main()
