import tempfile
from datetime import date

import yaml

from regcomp.pipeline import GOLD_PATH
from regcomp.records import read_units
from regcomp.validators import validate
from synth.generate import generate

AS_OF = date(2026, 9, 30)


def test_temporal_working_days_and_pending():
    rule = {"kind": "temporal", "anchor": ["closure_requested"], "target": "card_closed", "window": 7, "unit": "working_days"}
    ev = {"events": {"closure_requested": "2025-08-11", "card_closed": None}}
    assert validate(rule, "card_closure", ev, AS_OF).status == "VIOLATION"
    # Mon 11 Aug 2025 + 7 working days: 12, 13, 14, (15 Aug holiday), 16 (3rd Saturday, working), (17 Sunday), 18, 19, 20
    ev["events"]["card_closed"] = "2025-08-20"
    assert validate(rule, "card_closure", ev, AS_OF).status == "COMPLIANT"
    ev["events"]["card_closed"] = "2025-08-21"
    assert validate(rule, "card_closure", ev, AS_OF).status == "VIOLATION"


def test_scope_and_evidence_type_gate():
    rule = {"kind": "threshold", "field": "credits", "op": "<=", "value": 100000, "period": "financial_year",
            "conditions": {"account_type": "small"}}
    assert validate(rule, "wire_transfer", {"amount": 5}, AS_OF).status == "NOT_APPLICABLE"
    rule2 = {"kind": "temporal", "anchor": ["account_opened"], "target": "ckycr_uploaded", "window": 10, "unit": "days"}
    assert validate(rule2, "kyc_periodic", {"events": {"account_opened": "2020-01-01", "kyc_updated": None}}, AS_OF).status == "NOT_APPLICABLE"


def test_validators_agree_with_independent_gold_labeller():
    """Validators fed the hand-written gold parameters must reproduce the independent labeller (synth/gold.py)."""
    gold = yaml.safe_load(open(GOLD_PATH))["rules"]
    with tempfile.TemporaryDirectory() as d:
        generate(d, seed=3, scale=0.25)
        units = read_units(f"{d}/units.jsonl")
    checked = 0
    for u in units:
        params = [dict(g["params"], rule_id=g["id"]) for g in gold if g["unit_type"] == u.unit_type]
        for g, p in zip([g for g in gold if g["unit_type"] == u.unit_type], params):
            o = validate(p, u.unit_type, u.data, AS_OF, params)
            if g["id"] in u.truth:
                assert (o.status == "VIOLATION") == u.truth[g["id"]], (u.unit_id, g["id"], o)
                checked += 1
            else:
                assert o.status != "VIOLATION", (u.unit_id, g["id"], o)
    assert checked > 300
