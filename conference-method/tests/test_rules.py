from regcomp.obligations import is_operational
from regcomp.rules import extract_rules


def rules(text):
    return [r.as_dict() for r in extract_rules("t:1", text)]


def test_small_account_thresholds_and_proviso():
    t = ("The small account shall be subject to the following conditions: (a) the aggregate of all credits in a financial "
         "year does not exceed Rupees One Lakh; (b) the aggregate of all withdrawals and transfers in a month does not exceed "
         "₹10,000; and (c) the balance at any point of time does not exceed ₹50,000. Provided that the bank shall not consider "
         "this limit on balance when making deposits through Government grants, welfare benefits and payment against procurements.")
    rs = {r["field"]: r for r in rules(t) if r["kind"] == "threshold"}
    assert rs["credits"]["value"] == 100000 and rs["credits"]["period"] == "financial_year" and rs["credits"]["op"] == "<="
    assert rs["debits"]["value"] == 10000 and rs["debits"]["period"] == "month"
    assert rs["balance"]["value"] == 50000 and rs["balance"]["exceptions"][0]["exclude_credit_sources"] == ["govt_grant", "welfare", "procurement"]
    assert all(r["conditions"] == {"account_type": "small"} for r in rs.values())


def test_temporal_window_with_anchor_and_target():
    t = "The bank shall upload onto CKYCR within 10 days of commencement of an account-based relationship with the customer."
    r = [r for r in rules(t) if r["kind"] == "temporal"][0]
    assert (r["anchor"], r["target"], r["window"], r["unit"]) == (["account_opened"], "ckycr_uploaded", 10, "days")


def test_working_days_latest_anchor_and_penalty():
    t = ("Any request for closure of a credit card shall be honoured within seven working days by the credit card-issuer. "
         "In case of outstanding dues, the prescribed timeline of seven working days shall be calculated after excluding the "
         "number of days taken by the cardholder to clear the outstanding dues. Failure on the part of the card-issuer to complete "
         "the process of closure within seven working days shall result in a penalty of ₹500 per calendar day of delay.")
    r = [r for r in rules(t) if r["kind"] == "temporal"][0]
    assert r["unit"] == "working_days" and r["window"] == 7 and r["target"] == "card_closed"
    assert set(r["anchor"]) == {"closure_requested", "dues_cleared"} and r["anchor_mode"] == "latest"
    assert r["remediation"]["per_day"] == 500


def test_cardinality_with_sub_condition():
    t = "Subsequent to the due date, the bank shall give at least three reminders, including at least one reminder by letter."
    r = [r for r in rules(t) if r["kind"] == "cardinality"][0]
    assert (r["field"], r["op"], r["value"], r["when"]) == ("reminders", ">=", 3, "after_due")
    assert r["sub"] == {"filter": {"mode": "letter"}, "op": ">=", "value": 1}


def test_implicit_minimum_and_coordinated_values():
    rs = rules("A bank shall maintain a minimum Capital to Risk Weighted Assets Ratio (CRAR) of 9 per cent on an ongoing basis.")
    assert any(r["op"] == ">=" and r["value"] == 9 and r["unit"] == "percent" for r in rs)
    rs = rules("The minimum leverage ratio for a D-SIB shall be 4 per cent and 3.5 per cent for other banks.")
    assert {r["value"] for r in rs if r["kind"] == "threshold"} >= {4, 3.5}


def test_permission_sets_no_limit():
    assert not [r for r in rules("Differential rates of interest may be provided for any balance exceeding ₹1 lakh.") if r["kind"] == "threshold"]


def test_set_requires_every_item_grounded():
    t = ("The bank shall obtain the following documents in such cases: (1) Claim form signed by the nominee; "
         "(2) Death certificate of the deceased depositor; and (3) Officially Valid Document of the nominee.")
    assert not [r for r in rules(t) if r["kind"] == "set"]


def test_obligation_detector():
    assert is_operational("The bank shall upload onto CKYCR within 10 days of commencement of an account-based relationship.")
    assert not is_operational("These Directions shall come into force with immediate effect.")
