import os

import pytest

from common import CORPUS, SYNTH

pytestmark = pytest.mark.skipif(not os.path.exists(os.path.join(CORPUS, "clauses.jsonl")) or not os.path.exists(os.path.join(SYNTH, "units.jsonl")),
                                reason="needs work/corpus and work/synth (see README)")


def test_oracle_link_reproduces_gold_and_findings_carry_a_trail():
    from regcomp.metrics import evaluate, match_gold
    from regcomp.pipeline import Pipeline
    from regcomp.records import read_units
    units = [u for u in read_units(os.path.join(SYNTH, "units.jsonl")) if u.split == "test"]
    p = Pipeline(CORPUS, link="oracle", log=lambda *x: None)
    out = p.check(units)
    rule_of = {(c, r["rule_id"]): r for c, rs in p.rules.items() for r in rs}
    pred = {}
    for o in out:
        if o["status"] == "VIOLATION":
            pred.setdefault(o["unit_id"], set()).add(match_gold(rule_of[(o["clause_id"], o["rule_id"])], p.gold["rules"]) or o["rule_id"])
    ev = evaluate(units, pred, n_boot=0)
    assert ev["pair"]["f1"] > 0.99
    f = p.findings(out)[0]
    assert f["source"]["quote"] and f["source"]["clause_id"] and f["trail"]["pipeline_version"] and f["validator"]
