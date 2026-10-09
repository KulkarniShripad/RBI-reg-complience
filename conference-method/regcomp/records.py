"""Unified record schema, standardisation into evidence units, and verbalisation
(paper Sec. III, "semantic compliance verification").

Raw operational logs (synth/generate.py writes them; a bank would export them):
  transactions.jsonl  one row per transaction
  kyc.jsonl           one row per customer (KYC / CKYCR life-cycle and documents)
  audit.jsonl         one row per audit-trail event, grouped by case_id
                      (card closures, complaints, cyber incidents, KYC communications)

Evidence units are what gets linked to clauses and validated:
  wire_transfer        one cross-border wire transfer
  small_account_year   one small account over one financial year (all its transactions)
  kyc_onboarding       one customer's account opening: documents, CKYCR upload
  kyc_info_update      one update of customer information and its CKYCR update
  kyc_periodic         one customer's periodic KYC updation and the communications around it
  card_closure         one credit-card closure case
  complaint            one complaint case
  cyber_incident       one cyber incident reported through a service provider
  payment              a routine domestic payment (no rule under test applies)

Each unit carries structured `data` (what validators read) and a natural-language
`text` (what the encoders embed), in English or Marathi.
"""
from __future__ import annotations

import collections
import json
import os
from dataclasses import asdict, dataclass, field


@dataclass
class Unit:
    unit_id: str
    unit_type: str
    institution_category: str
    data: dict
    text: str = ""
    lang: str = "en"
    split: str = ""
    truth: dict = field(default_factory=dict)      # {gold_rule_id: True (violated) | False}
    tags: list[str] = field(default_factory=list)  # scenario tags (boundary, exception, ...), for analysis only

    def as_dict(self) -> dict:
        return asdict(self)


def fy_of(date: str) -> str:
    y, m = int(date[:4]), int(date[5:7])
    start = y if m >= 4 else y - 1
    return f"{start}-{str(start + 1)[2:]}"


def _rows(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


# event fields of each case type (unified schema: an event that has not happened is None)
CASE_EVENTS = {
    "card_closure": ["closure_requested", "dues_cleared", "card_closed", "cic_updated"],
    "complaint": ["complaint_received", "decision_communicated"],
    "cyber_incident": ["incident_detected", "incident_reported_rbi"],
}


def build_units(raw_dir: str, category: str = "commercial_banks") -> list[Unit]:
    """Standardise raw logs into evidence units."""
    tx = _rows(os.path.join(raw_dir, "transactions.jsonl"))
    kyc = _rows(os.path.join(raw_dir, "kyc.jsonl"))
    audit = _rows(os.path.join(raw_dir, "audit.jsonl"))
    units: list[Unit] = []

    small = collections.defaultdict(list)
    for t in tx:
        if t.get("kind") == "wire":
            keys = ["amount", "date", "cross_border", "batch", "originator_name", "originator_account", "originator_address",
                    "originator_national_id", "originator_customer_id", "originator_dob_pob", "beneficiary_name",
                    "beneficiary_account", "txn_ref", "currency", "customer_id"]
            units.append(Unit(f"wire:{t['txn_id']}", "wire_transfer", category, {k: t.get(k) for k in keys}))
        elif t.get("account_type") == "small":
            small[(t["account_id"], fy_of(t["date"]))].append(t)
        elif t.get("kind") == "payment":
            units.append(Unit(f"pay:{t['txn_id']}", "payment", category,
                              {k: t.get(k) for k in ("amount", "date", "channel", "customer_id", "payee", "purpose", "account_type")}))
    for (acc, fy), rows in sorted(small.items()):
        rows = sorted(rows, key=lambda r: (r["date"], r["txn_id"]))
        units.append(Unit(f"small:{acc}:{fy}", "small_account_year", category, {
            "account_id": acc, "customer_id": rows[0]["customer_id"], "account_type": "small", "fy": fy,
            "opening_balance": rows[0].get("opening_balance", 0),
            "txns": [{k: r.get(k) for k in ("date", "direction", "kind", "channel", "amount", "source")} for r in rows],
        }))

    for k in kyc:
        cid = k["customer_id"]
        if k.get("onboarding"):
            units.append(Unit(f"kyc_on:{cid}", "kyc_onboarding", category, {
                "customer_id": cid, "customer_type": k.get("customer_type"),
                "events": {"account_opened": k.get("account_opened"), "ckycr_uploaded": k.get("ckycr_uploaded")},
                "documents": sorted(k.get("documents") or []),
            }))
        if k.get("updated_info_obtained"):
            units.append(Unit(f"kyc_upd:{cid}", "kyc_info_update", category, {
                "customer_id": cid,
                "events": {"updated_info_obtained": k["updated_info_obtained"], "ckycr_updated": k.get("ckycr_updated")},
            }))
        if k.get("periodic"):
            comms = [a for a in audit if a.get("case_type") == "kyc_comm" and a.get("entity_id") == cid]
            units.append(Unit(f"kyc_per:{cid}", "kyc_periodic", category, {
                "customer_id": cid, "customer_type": k.get("customer_type"), "risk": k.get("risk"),
                "events": {"account_opened": k.get("account_opened"), "last_kyc_update": k.get("last_kyc_update"),
                           "kyc_updated": k.get("kyc_updated")},
                "communications": [{"date": a["timestamp"][:10], "kind": a["event"], "mode": (a.get("attrs") or {}).get("mode")}
                                   for a in sorted(comms, key=lambda a: a["timestamp"])],
            }))

    cases = collections.defaultdict(list)
    for a in audit:
        if a.get("case_type") in ("card_closure", "complaint", "cyber_incident"):
            cases[(a["case_type"], a["case_id"])].append(a)
    for (ctype, cid), evs in sorted(cases.items()):
        events = {k: None for k in CASE_EVENTS[ctype]}
        events.update({e["event"]: e["timestamp"] for e in evs})
        attrs = {}
        for e in evs:
            attrs.update(e.get("attrs") or {})
        units.append(Unit(f"{ctype}:{cid}", ctype, category, {"case_id": cid, "entity_id": evs[0].get("entity_id"),
                                                               "events": events, "attrs": attrs}))
    return units


# ── verbalisation ──

def _inr(x) -> str:
    """Indian digit grouping: 1234567 -> 12,34,567."""
    if x is None:
        return "-"
    n = int(round(float(x)))
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    return ("-" if n < 0 else "") + s


def _d(x) -> str:
    return x if x else "-"


RISK_MR = {"high": "उच्च", "medium": "मध्यम", "low": "कमी"}
MODE_MR = {"letter": "पत्र", "sms": "एसएमएस", "email": "ईमेल"}
DOC_EN = {"aadhaar": "Aadhaar", "ovd": "officially valid document", "kyc_identifier": "KYC identifier", "pan": "PAN",
          "form60": "Form 60", "photograph": "photograph"}
DOC_MR = {"aadhaar": "आधार", "ovd": "अधिकृत वैध कागदपत्र", "kyc_identifier": "KYC ओळख क्रमांक", "pan": "पॅन",
          "form60": "फॉर्म 60", "photograph": "छायाचित्र"}


def _small_stats(d: dict) -> dict:
    credits = sum(t["amount"] for t in d["txns"] if t["direction"] == "credit")
    by_month = collections.Counter()
    for t in d["txns"]:
        if t["direction"] == "debit":
            by_month[t["date"][:7]] += t["amount"]
    bal, peak = d.get("opening_balance", 0), d.get("opening_balance", 0)
    for t in d["txns"]:
        bal += t["amount"] if t["direction"] == "credit" else -t["amount"]
        peak = max(peak, bal)
    m = by_month.most_common(1)[0] if by_month else ("-", 0)
    return {"credits": credits, "debit_month": m[0], "debits": m[1], "peak": peak, "n": len(d["txns"])}


def verbalize(u: Unit, lang: str = "en", variant: int = 0) -> str:
    d = u.data
    t = u.unit_type
    v = variant % 2
    if t == "small_account_year":
        s = _small_stats(d)
        if lang == "mr":
            return (f"लहान खाते {d['account_id']} (ग्राहक {d['customer_id']}): आर्थिक वर्ष {d['fy']} मध्ये {s['n']} व्यवहार; एकूण जमा ₹{_inr(s['credits'])}; "
                    f"एका महिन्यातील सर्वाधिक पैसे काढणे व हस्तांतरण ₹{_inr(s['debits'])}; सर्वाधिक शिल्लक ₹{_inr(s['peak'])}.")
        return [
            f"Small account {d['account_id']} of customer {d['customer_id']}: {s['n']} transactions in FY {d['fy']}; total credits Rs. {_inr(s['credits'])}; "
            f"highest monthly withdrawals and transfers Rs. {_inr(s['debits'])} ({s['debit_month']}); peak balance Rs. {_inr(s['peak'])}.",
            f"In financial year {d['fy']} the small account {d['account_id']} (customer {d['customer_id']}) received credits of Rs. {_inr(s['credits'])}, "
            f"its withdrawals and transfers reached Rs. {_inr(s['debits'])} in {s['debit_month']}, and the balance peaked at Rs. {_inr(s['peak'])}.",
        ][v]
    if t == "wire_transfer":
        parts_en = []
        parts_mr = []
        for k, en, mr in [("originator_name", "originator", "पाठवणारा"), ("originator_account", "originator account", "पाठवणाऱ्याचे खाते"),
                          ("originator_address", "originator address", "पाठवणाऱ्याचा पत्ता"), ("originator_national_id", "national ID", "राष्ट्रीय ओळख क्रमांक"),
                          ("originator_customer_id", "customer ID", "ग्राहक ओळख क्रमांक"), ("originator_dob_pob", "date and place of birth", "जन्मतारीख व जन्मस्थान"),
                          ("beneficiary_name", "beneficiary", "लाभार्थी"), ("beneficiary_account", "beneficiary account", "लाभार्थी खाते"),
                          ("txn_ref", "reference", "संदर्भ क्रमांक")]:
            if d.get(k):
                parts_en.append(f"{en} {d[k]}")
                parts_mr.append(f"{mr}: {d[k]}")
        batch_en = " as part of a batch file" if d.get("batch") else ""
        if lang == "mr":
            batch_mr = " (बॅच फाइलमधून)" if d.get("batch") else ""
            return f"{d['date']} रोजी ग्राहक {d.get('customer_id')} यांनी परदेशात ₹{_inr(d['amount'])} चे वायर ट्रान्सफर{batch_mr} केले; " + "; ".join(parts_mr) + "."
        return [
            f"Cross-border wire transfer of Rs. {_inr(d['amount'])} on {d['date']}{batch_en} by customer {d.get('customer_id')}; details sent: " + "; ".join(parts_en) + ".",
            f"On {d['date']} customer {d.get('customer_id')} sent Rs. {_inr(d['amount'])} abroad by SWIFT wire transfer{batch_en}, carrying " + ", ".join(parts_en) + ".",
        ][v]
    if t == "kyc_onboarding":
        e = d["events"]
        docs_en = ", ".join(DOC_EN.get(x, x) for x in d["documents"]) or "none"
        docs_mr = ", ".join(DOC_MR.get(x, x) for x in d["documents"]) or "काहीही नाही"
        up_en = f"KYC records uploaded to CKYCR on {e['ckycr_uploaded']}" if e.get("ckycr_uploaded") else "KYC records not yet uploaded to CKYCR"
        up_mr = f"KYC नोंदी CKYCR वर {e['ckycr_uploaded']} रोजी अपलोड केल्या" if e.get("ckycr_uploaded") else "KYC नोंदी अद्याप CKYCR वर अपलोड केलेल्या नाहीत"
        if lang == "mr":
            return f"ग्राहक {d['customer_id']} यांचे खाते {e['account_opened']} रोजी उघडले; {up_mr}; सादर केलेली कागदपत्रे: {docs_mr}."
        return [
            f"Customer {d['customer_id']} opened an account on {e['account_opened']}; {up_en}; documents obtained: {docs_en}.",
            f"Account opening for customer {d['customer_id']} on {e['account_opened']} with documents ({docs_en}); {up_en}.",
        ][v]
    if t == "kyc_info_update":
        e = d["events"]
        upd_en = f"CKYCR records updated on {e['ckycr_updated']}" if e.get("ckycr_updated") else "CKYCR records not yet updated"
        upd_mr = f"CKYCR वरील नोंदी {e['ckycr_updated']} रोजी अद्ययावत केल्या" if e.get("ckycr_updated") else "CKYCR वरील नोंदी अद्याप अद्ययावत केलेल्या नाहीत"
        if lang == "mr":
            return f"ग्राहक {d['customer_id']} यांच्याकडून {e['updated_info_obtained']} रोजी अद्ययावत माहिती मिळाली; {upd_mr}."
        return [
            f"Updated KYC information obtained from customer {d['customer_id']} on {e['updated_info_obtained']}; {upd_en}.",
            f"Customer {d['customer_id']} furnished changed KYC details on {e['updated_info_obtained']}; {upd_en}.",
        ][v]
    if t == "kyc_periodic":
        e = d["events"]
        adv = [c for c in d["communications"] if c["kind"] == "advance_intimation"]
        rem = [c for c in d["communications"] if c["kind"] == "reminder"]
        modes = lambda cs, M=None: ", ".join(((M or {}).get(c["mode"], c["mode"]) or "-") for c in cs) or ("-" if M is None else "-")
        last = e.get("last_kyc_update") or e.get("account_opened")
        done_en = f"KYC updated on {e['kyc_updated']}" if e.get("kyc_updated") else "KYC not updated since"
        if lang == "mr":
            done_mr = f"KYC {e['kyc_updated']} रोजी अद्ययावत केले" if e.get("kyc_updated") else "त्यानंतर KYC अद्ययावत केलेले नाही"
            return (f"{RISK_MR.get(d['risk'], d['risk'])} जोखीम श्रेणीतील ग्राहक {d['customer_id']}: शेवटचे KYC अद्ययावतीकरण {last}; {done_mr}; "
                    f"मुदतीपूर्वी पाठवलेल्या सूचना: {len(adv)} ({modes(adv, MODE_MR)}); मुदतीनंतरची स्मरणपत्रे: {len(rem)} ({modes(rem, MODE_MR)}).")
        return [
            f"{d['risk'].capitalize()}-risk {d.get('customer_type', 'individual')} customer {d['customer_id']}: last KYC updation {last}; {done_en}; "
            f"{len(adv)} advance intimations ({modes(adv)}); {len(rem)} reminders after the due date ({modes(rem)}).",
            f"Periodic KYC updation for {d['risk']}-risk customer {d['customer_id']} (last updated {last}): {done_en}; advance intimations sent {len(adv)} "
            f"by {modes(adv)}; reminders sent {len(rem)} by {modes(rem)}.",
        ][v]
    if t == "card_closure":
        e, a = d["events"], d.get("attrs", {})
        dues = f"; outstanding dues cleared on {e['dues_cleared']}" if e.get("dues_cleared") else ""
        closed = f"card closed on {e['card_closed']}" if e.get("card_closed") else "card not yet closed"
        cic = f"; closure reported to the credit information company on {e['cic_updated']}" if e.get("cic_updated") else ("; closure not yet reported to the credit information company" if e.get("card_closed") else "")
        if lang == "mr":
            dues_mr = f"; थकबाकी {e['dues_cleared']} रोजी भरली" if e.get("dues_cleared") else ""
            closed_mr = f"कार्ड {e['card_closed']} रोजी बंद केले" if e.get("card_closed") else "कार्ड अद्याप बंद केलेले नाही"
            cic_mr = f"; क्रेडिट माहिती कंपनीला {e['cic_updated']} रोजी कळवले" if e.get("cic_updated") else ""
            return f"कार्डधारक {d['entity_id']} यांनी {e['closure_requested']} रोजी क्रेडिट कार्ड बंद करण्याची विनंती केली{dues_mr}; {closed_mr}{cic_mr}."
        return [
            f"Cardholder {d['entity_id']} requested closure of credit card {a.get('card', d['case_id'])} on {e['closure_requested']}{dues}; {closed}{cic}.",
            f"Credit card closure request from {d['entity_id']} received {e['closure_requested']}{dues}; {closed}{cic}.",
        ][v]
    if t == "complaint":
        e = d["events"]
        dec = f"final decision communicated to the complainant on {e['decision_communicated']}" if e.get("decision_communicated") else "no final decision communicated yet"
        if lang == "mr":
            dec_mr = f"अंतिम निर्णय तक्रारदाराला {e['decision_communicated']} रोजी कळवला" if e.get("decision_communicated") else "अंतिम निर्णय अद्याप कळवलेला नाही"
            return f"तक्रार {d['case_id']} बँकेला {e['complaint_received']} रोजी मिळाली; {dec_mr}."
        return [
            f"Complaint {d['case_id']} received by the bank on {e['complaint_received']}; {dec}.",
            f"Customer complaint {d['case_id']} lodged {e['complaint_received']}: {dec}.",
        ][v]
    if t == "cyber_incident":
        e = d["events"]
        rep = f"reported to RBI at {e['incident_reported_rbi']}" if e.get("incident_reported_rbi") else "not yet reported to RBI"
        if lang == "mr":
            rep_mr = f"बँकेने RBI ला {e['incident_reported_rbi']} रोजी कळवले" if e.get("incident_reported_rbi") else "अद्याप RBI ला कळवलेले नाही"
            return f"सेवा प्रदात्याने {e['incident_detected']} रोजी सायबर घटना शोधली ({d['case_id']}); {rep_mr}."
        return [
            f"Cyber incident {d['case_id']} detected by the IT service provider at {e['incident_detected']}; {rep}.",
            f"Service provider detected cyber incident {d['case_id']} at {e['incident_detected']}; the bank {rep}.",
        ][v]
    if t == "payment":
        if lang == "mr":
            return f"ग्राहक {d['customer_id']} यांनी {d['date']} रोजी {d['channel']} द्वारे {d.get('payee')} यांना ₹{_inr(d['amount'])} भरले ({d.get('purpose')})."
        return [
            f"Customer {d['customer_id']} paid Rs. {_inr(d['amount'])} to {d.get('payee')} by {d['channel']} on {d['date']} ({d.get('purpose')}).",
            f"{d['channel']} payment of Rs. {_inr(d['amount'])} on {d['date']} from customer {d['customer_id']} to {d.get('payee')} for {d.get('purpose')}.",
        ][v]
    raise ValueError(f"unknown unit type {t}")


def write_units(path: str, units: list[Unit]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for u in units:
            f.write(json.dumps(u.as_dict(), ensure_ascii=False) + "\n")


def read_units(path: str) -> list[Unit]:
    with open(path, encoding="utf-8") as f:
        return [Unit(**json.loads(l)) for l in f if l.strip()]
