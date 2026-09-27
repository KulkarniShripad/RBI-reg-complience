"""
Regression tests for the deterministic extraction logic.
Run: python3 -m unittest scripts/test_pipeline.py  (from urcc-ef-backend/)

Every case here is a sentence taken from the real corpus whose correct
reading was checked by hand.
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import categories as CAT  # noqa: E402
import classifier as C  # noqa: E402
import parser as P  # noqa: E402


def atoms(text):
    return [(a.atom_kind, a.operator, a.threshold_value, a.threshold_unit) for a in C.classify_clause(text).rule_atoms]


class RuleAtoms(unittest.TestCase):
    def test_ceiling_with_modal_in_operator(self):
        self.assertEqual(atoms("Investments under HTM category shall not exceed 25 per cent of an RRB's total investments."),
                         [("requirement", "<=", 25.0, "%")])

    def test_minimum_x_of_value(self):
        a = C.classify_clause("A Small Finance Bank shall maintain a minimum capital adequacy ratio (CRAR) of 15 per cent "
                              "of its risk weighted assets on a continuous basis.").rule_atoms
        self.assertEqual((a[0].atom_kind, a[0].operator, a[0].threshold_value), ("requirement", ">=", 15.0))
        self.assertIn("CRAR", a[0].variable_text)

    def test_money_minimum(self):
        self.assertEqual(atoms("An NBFC shall have a minimum Net Owned Fund of ₹10 crore."),
                         [("requirement", ">=", 10.0, "₹ crore")])

    def test_deadline_names_the_action(self):
        a = C.classify_clause("The bank shall report the fraud to the Reserve Bank within 14 days from the date of classification.").rule_atoms
        self.assertEqual((a[0].operator, a[0].threshold_value, a[0].threshold_unit), ("within_days", 14.0, "days"))
        self.assertIn("report the fraud", a[0].variable_text)

    def test_scope_thresholds_are_conditions(self):
        for text in [
            "Banks are mandated not to accept collateral security in the case of loans up to ₹20 lakh extended to units in the MSE sector.",
            "The above instruction shall be applicable to cases where the balance in the account does not exceed ₹ 50,000/- or the amount of relief granted.",
            "If a complainant does not get satisfactory response from a UCB within 30 days from the date of lodging the compliant, the complainant will have the option to approach the Ombudsman.",
            "A bank shall obtain minimum two Independent valuation reports for properties valued at ₹50 crore or above.",
            "For the purpose of this sub-paragraph the term significant shall be interpreted as at least 20 per cent.",
        ]:
            with self.subTest(text=text[:50]):
                self.assertTrue(all(k == "condition" for k, *_ in atoms(text)), atoms(text))

    def test_two_thresholds_in_one_sentence(self):
        got = atoms("The Tier 1 capital shall be at least 7.5 per cent of RWAs, of which CET1 shall be at least 6 per cent.")
        self.assertEqual([(o, v) for _, o, v, _ in got], [(">=", 7.5), (">=", 6.0)])

    def test_roles(self):
        self.assertEqual(C.classify_role("These Directions shall be called the Reserve Bank of India (X) Directions, 2025.", []), "short_title")
        self.assertEqual(C.classify_role("*****", []), "deleted")
        self.assertEqual(C.classify_role("A bank shall put in place a Board approved policy.", ["Chapter II: Policies"]), "obligation")


class Categories(unittest.TestCase):
    def test_folder_and_form_aliases(self):
        for value, expected in [("small financial banks", "small_finance_banks"), ("Non-Banking", "nbfc"),
                                ("Credit_Information_Services", "credit_information_companies"),
                                ("commercial_banks", "commercial_banks"), ("payment banks", "payments_banks"),
                                ("KYC", None)]:
            self.assertEqual(CAT.normalise_category(value), expected, value)

    def test_title_category_and_topic(self):
        t = "Reserve Bank of India (Non-Banking Financial Companies - Internal Ombudsman) Directions, 2026"
        self.assertEqual(CAT.category_from_title(t), "nbfc")
        self.assertEqual(CAT.topic_from_title(t), "Internal Ombudsman")
        self.assertEqual(CAT.topic_from_title("Reserve Bank of India (Priority Sector Lending – Targets and Classification) Directions, 2025"),
                         "Priority Sector Lending – Targets and Classification")

    def test_applicability_exclusions(self):
        self.assertEqual(CAT.categories_from_applicability(
            "The provisions of these Directions shall apply to Scheduled Commercial Banks {including Small Finance Banks (SFBs) "
            "and excluding Regional Rural Banks(RRBs)}"), ["commercial_banks", "small_finance_banks"])
        self.assertEqual(CAT.categories_from_applicability(
            "shall apply to every Scheduled Bank (excluding Payments Banks, State Co-operative Banks and District Central "
            "Co-operative Banks) and all Non-Banking Financial Companies (NBFCs) operating in India."), ["nbfc"])


class ParserPatterns(unittest.TestCase):
    def test_section_heading_needs_a_period(self):
        self.assertIsNone(P.RE_SECTION.match("A CDS creates a notional long position"))
        self.assertIsNotNone(P.RE_SECTION.match("A. Short title and Commencement"))
        self.assertIsNotNone(P.RE_SECTION.match("C.3.1 Zero Liability of a Customer"))

    def test_wrapped_reference_is_not_a_paragraph(self):
        self.assertIsNone(P.RE_FLAT_PARA.match("53), for instance, or any objective parameter"))


if __name__ == "__main__":
    unittest.main()
