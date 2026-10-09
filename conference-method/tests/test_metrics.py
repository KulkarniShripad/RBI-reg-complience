from regcomp.metrics import bootstrap_prf, cohen_kappa, match_gold, prf, signature


def test_prf_and_kappa():
    m = prf(8, 2, 2)
    assert abs(m["f1"] - 0.8) < 1e-9
    assert cohen_kappa(["a", "b", "a", "b"], ["a", "b", "a", "b"]) == 1.0
    r = bootstrap_prf([(1, 0, 0)] * 10 + [(0, 1, 0)] * 2, n=200)
    lo, hi = r["ci"]["precision"]
    assert lo <= r["precision"] <= hi


def test_signature_matching_ignores_order_and_types():
    g = [{"id": "G", "params": {"kind": "temporal", "anchor": ["b", "a"], "target": "t", "window": 7, "unit": "days"}}]
    assert match_gold({"kind": "temporal", "anchor": ["a", "b"], "target": "t", "window": 7.0, "unit": "days"}, g) == "G"
    assert match_gold({"kind": "temporal", "anchor": ["a"], "target": "t", "window": 7.0, "unit": "days"}, g) is None
    assert signature({"kind": "set", "required": [["x", "y"], ["z"]]}) == signature({"kind": "set", "required": [["z"], ["y", "x"]]})
