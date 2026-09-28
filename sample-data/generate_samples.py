"""
Builds the test documents in this folder (python3 generate_samples.py).

Two kinds of documents:

  public/   Figures that Indian banks have PUBLISHED (Basel III Pillar 3
            disclosures, quarterly results, annual reports), re-typeset as a
            short PDF extract because the original files could not be
            downloaded into this repository. Every figure is as published;
            the source URL is printed on the document and listed in
            manifest.json. Run ./fetch_originals.sh on your own machine to
            download the original PDFs and test with those too.

  test-cases/  FICTIONAL banks ("Example ... Bank") built to exercise the
            checker: breaches, buffer shortfalls, a missing-disclosure annual
            report with governance narrative, a UCB whose tier follows from its
            deposits, and the spreadsheet / CSV / JSON input formats.

Requires PyMuPDF (already needed by the backend) and openpyxl for the .xlsx.
"""
from __future__ import annotations

import json
import os

import pymupdf

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, "public")
TESTS = os.path.join(HERE, "test-cases")

PAGE_W, PAGE_H = 595, 842
LEFT, RIGHT, TOP, BOTTOM = 50, 545, 60, 790


class Writer:
    """Minimal flowing PDF writer: headings, paragraphs and column tables."""

    def __init__(self, banner: str | None = None):
        self.doc = pymupdf.open()
        self.banner = banner
        self.page = None
        self.y = TOP
        self.new_page()

    def new_page(self):
        self.page = self.doc.new_page(width=PAGE_W, height=PAGE_H)
        self.y = TOP
        if self.banner:
            rect = pymupdf.Rect(LEFT, 20, RIGHT, 52)
            self.page.insert_textbox(rect, self.banner, fontsize=6.5, fontname="helv", color=(0.45, 0.2, 0.1))

    def need(self, h: float):
        if self.y + h > BOTTOM:
            self.new_page()

    def heading(self, text: str, size: float = 13):
        self.need(size + 12)
        self.page.insert_text((LEFT, self.y + size), text, fontsize=size, fontname="hebo")
        self.y += size + 10

    def para(self, text: str, size: float = 9.5):
        # wrap by measuring words
        words = text.split()
        lines, cur = [], ""
        for w in words:
            t = f"{cur} {w}".strip()
            if pymupdf.get_text_length(t, fontname="helv", fontsize=size) > RIGHT - LEFT:
                lines.append(cur)
                cur = w
            else:
                cur = t
        if cur:
            lines.append(cur)
        for line in lines:
            self.need(size + 4)
            self.page.insert_text((LEFT, self.y + size), line, fontsize=size, fontname="helv")
            self.y += size + 3.5
        self.y += 6

    def table(self, header: list[str], rows: list[list[str]], widths: list[float], size: float = 8.5):
        def row(cells, bold=False):
            self.need(size + 6)
            x = LEFT
            for i, c in enumerate(cells):
                w = widths[i]
                txt = str(c)
                if i == 0:
                    self.page.insert_text((x, self.y + size), txt, fontsize=size, fontname="hebo" if bold else "helv")
                else:  # right-align numbers
                    tl = pymupdf.get_text_length(txt, fontname="hebo" if bold else "helv", fontsize=size)
                    self.page.insert_text((x + w - tl - 4, self.y + size), txt, fontsize=size, fontname="hebo" if bold else "helv")
                x += w
            self.y += size + 5

        row(header, bold=True)
        for r in rows:
            row(r)
        self.y += 8

    def save(self, path: str):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.doc.set_metadata({"title": os.path.basename(path), "producer": "URCC-EF sample generator"})
        self.doc.save(path, garbage=3, deflate=True)


def banner(url: str) -> str:
    return (
        "TEST EXTRACT for URCC-EF - figures as published by the bank, re-typeset (not the original layout). "
        f"Source: {url}"
    )


SAMPLES = []


# Machine-checked expectations (urcc-ef-backend: npm run eval:disclosures)
CHECKS = {
    "public/idfc-first-bank-pillar3-jun-2025.pdf": {
        "profile": {
            "institution_category": "commercial_banks",
            "period_label": "Q1-FY2025-26",
            "doc_type": "pillar3"
        },
        "rules": {
            "cb_crar": "PASS",
            "cb_cet1": "PASS",
            "cb_crar_ccb": "PASS",
            "cb_cet1_ccb": "PASS",
            "cb_lcr": "PASS",
            "cb_tier1": "NOT_DISCLOSED",
            "cb_nsfr": "NOT_DISCLOSED"
        },
        "figures": {
            "crar": 15.88,
            "cet1_ratio": 13.34,
            "lcr": 118
        }
    },
    "public/federal-bank-results-q2-fy26.pdf": {
        "profile": {
            "institution_category": "commercial_banks",
            "period_label": "Q2-FY2025-26",
            "doc_type": "financial_results"
        },
        "rules": {
            "cb_crar": "PASS",
            "cb_tier1": "PASS",
            "cb_lcr": "PASS",
            "cb_cet1": "NOT_DISCLOSED"
        },
        "figures": {
            "crar": 16.54,
            "tier1_ratio": 14.15,
            "gross_npa_pct": 1.83,
            "net_npa_pct": 0.48,
            "pcr": 73,
            "lcr": 121
        }
    },
    "public/sbi-results-q1-fy26.pdf": {
        "profile": {
            "bank_name": "State Bank of India",
            "is_dsib": True,
            "period_label": "Q1-FY2025-26"
        },
        "rules": {
            "cb_crar": "PASS",
            "cb_crar_ccb": "PASS",
            "cb_leverage_dsib": "NOT_DISCLOSED"
        },
        "figures": {
            "crar": 14.63,
            "net_npa_pct": 0.47,
            "pcr": 74.49
        }
    },
    "public/equitas-sfb-pillar3-mar-2025.pdf": {
        "profile": {
            "institution_category": "small_finance_banks",
            "period_label": "Q4-FY2024-25"
        },
        "rules": {
            "sfb_crar": "PASS",
            "sfb_tier1": "PASS",
            "sfb_lcr": "PASS"
        },
        "figures": {
            "crar": 20.6,
            "tier1_ratio": 17.84,
            "lcr": 156.52,
            "gross_npa_pct": 2.89,
            "net_npa_pct": 0.98,
            "pcr": 66.83
        }
    },
    "public/ujjivan-sfb-highlights-sep-2025.pdf": {
        "profile": {
            "institution_category": "small_finance_banks",
            "period_label": "Q2-FY2025-26"
        },
        "rules": {
            "sfb_crar": "PASS",
            "sfb_tier1": "PASS",
            "sfb_lcr": "NOT_DISCLOSED"
        },
        "figures": {
            "crar": 21.4,
            "tier1_ratio": 19.9,
            "gross_npa_pct": 2.45,
            "net_npa_pct": 0.67,
            "total_deposits": 39211
        }
    },
    "public/saraswat-cooperative-bank-annual-report-2024-25.pdf": {
        "profile": {
            "institution_category": "urban_cooperative_banks",
            "period_label": "Q4-FY2024-25",
            "doc_type": "annual_report"
        },
        "rules": {
            "ucb_crar": "PASS",
            "ucb_net_worth": "NOT_DISCLOSED"
        },
        "figures": {
            "crar": 17.43,
            "gross_npa_pct": 2.25,
            "net_npa_pct": 0
        }
    },
    "test-cases/example-sfb-pillar3-sep-2025.pdf": {
        "profile": {
            "institution_category": "small_finance_banks",
            "period_label": "Q2-FY2025-26"
        },
        "overall": "BREACH",
        "rules": {
            "sfb_crar": "BREACH",
            "sfb_cet1": "PASS",
            "sfb_tier1": "PASS",
            "sfb_leverage": "BREACH",
            "sfb_lcr": "BREACH",
            "sfb_nsfr": "PASS"
        },
        "figures": {
            "crar": 14.2,
            "cet1_ratio": 11.9,
            "tier1_ratio": 13.1,
            "leverage_ratio": 4.2,
            "lcr": 96.4,
            "nsfr": 108.3
        }
    },
    "test-cases/example-commercial-bank-annual-report-2025-26.pdf": {
        "profile": {
            "institution_category": "commercial_banks",
            "period_label": "Q4-FY2025-26",
            "doc_type": "annual_report",
            "is_dsib": False
        },
        "overall": "ATTENTION",
        "rules": {
            "cb_crar": "PASS",
            "cb_crar_ccb": "BUFFER_SHORTFALL",
            "cb_cet1": "PASS",
            "cb_cet1_ccb": "BUFFER_SHORTFALL",
            "cb_tier1": "PASS",
            "cb_leverage": "PASS",
            "cb_lcr": "PASS",
            "cb_nsfr": "PASS",
            "cb_psl": "TARGET_SHORTFALL"
        },
        "disclosures_missing": [
            "divergence",
            "securitisation",
            "dea_fund",
            "remuneration",
            "bancassurance",
            "provisions"
        ],
        "disclosures_present": [
            "regulatory_capital",
            "lcr",
            "nsfr",
            "concentration",
            "complaints",
            "penalties",
            "business_ratios",
            "dicgc"
        ],
        "figures": {
            "crar": 10.8,
            "cet1_ratio": 7.6,
            "tier1_ratio": 8.9,
            "leverage_ratio": 3.9,
            "lcr": 104.2,
            "nsfr": 101.5,
            "gross_npa_pct": 4.1,
            "net_npa_pct": 1.6,
            "pcr": 71.2,
            "psl_anbc_pct": 38.2
        }
    },
    "test-cases/example-ucb-figures-mar-2026.xlsx": {
        "profile": {
            "institution_category": "urban_cooperative_banks",
            "period_label": "Q4-FY2025-26",
            "ucb_tier": 2
        },
        "overall": "BREACH",
        "rules": {
            "ucb_crar": "BREACH",
            "ucb_net_worth": "PASS_WITH_CONDITIONS"
        },
        "figures": {
            "crar": 11.2,
            "net_worth": 4.1,
            "total_deposits": 850
        }
    },
    "test-cases/example-payments-bank-figures-sep-2025.csv": {
        "profile": {
            "institution_category": "payments_banks",
            "period_label": "Q2-FY2025-26"
        },
        "overall": "BREACH",
        "rules": {
            "pb_crar": "PASS",
            "pb_cet1": "PASS",
            "pb_tier1": "PASS",
            "pb_leverage": "BREACH"
        },
        "figures": {
            "crar": 38.5,
            "leverage_ratio": 2.6
        }
    },
    "test-cases/example-rrb-figures-dec-2025.json": {
        "profile": {
            "institution_category": "regional_rural_banks",
            "period_label": "Q3-FY2025-26"
        },
        "overall": "BREACH",
        "rules": {
            "rrb_crar": "BREACH",
            "rrb_tier1": "BREACH"
        },
        "figures": {
            "crar": 8.4,
            "tier1_ratio": 6.9
        }
    }
}


def add(file, **meta):
    SAMPLES.append({"file": file, **meta, "checks": CHECKS.get(file, {})})


# ─────────────────────────── public (real published figures) ───────────────────────────

def idfc_first_pillar3():
    url = "https://www.idfcfirst.bank.in/content/dam/idfcfirstbank/pdf/regulatory-disclosures/Basel-Pillar-3-Disclosures-as-on-June-30-2025.pdf"
    w = Writer(banner(url))
    w.heading("IDFC FIRST Bank Limited")
    w.heading("BASEL III - PILLAR 3 DISCLOSURES AS AT June 30, 2025", 11)
    w.heading("Capital Adequacy", 11)
    w.para(
        "As per Basel III guidelines, the minimum regulatory Capital to Risk Weighted Assets Ratio (CRAR) to be "
        "maintained by the Bank as on 30th June 2025 is 9% [11.50% including Capital Conservation Buffer (CCB) of 2.50%] "
        "with minimum Common Equity Tier 1 (CET1) of 5.5% (8% including CCB)."
    )
    w.heading("Key prudential ratios (Standalone)", 11)
    w.table(
        ["Particulars", "June 30, 2025"],
        [
            ["Common Equity Tier 1 ratio (%)", "13.34"],
            ["Total capital ratio - CRAR (%)", "15.88"],
            ["Liquidity Coverage Ratio (%)", "118"],
        ],
        [360, 135],
    )
    w.para("Tier 1 ratio, leverage ratio and NSFR are published in the full disclosure (see source URL) and were not transcribed here.")
    path = "public/idfc-first-bank-pillar3-jun-2025.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="IDFC FIRST Bank - Basel III Pillar 3, 30 Jun 2025 (extract)", bank="IDFC FIRST Bank Limited",
        category="commercial_banks", doc_type="pillar3", period="Q1-FY2025-26", kind="public", source_url=url,
        expect={"crar": "PASS (15.88 vs 9 and 11.5 with CCB)", "cet1_ratio": "PASS", "lcr": "PASS",
                "tier1_ratio / leverage / nsfr": "NOT_DISCLOSED in this extract"})


def federal_bank_results():
    url = "https://www.federal.bank.in/documents/10180/1131213536/Q2FY26+Quarterly+Presentation.pdf"
    w = Writer(banner(url + " ; https://www.business-standard.com/amp/companies/quarterly-results/federal-bank-s-net-profit-falls-9-6-y-o-y-125101800603_1.html"))
    w.heading("The Federal Bank Limited")
    w.heading("Financial results for the quarter ended September 30, 2025 (Q2 FY26)", 11)
    w.heading("Analytical ratios (Standalone)", 11)
    w.table(
        ["Particulars", "Quarter ended 30.09.2025"],
        [
            ["Capital Adequacy Ratio (%) - Basel III", "16.54"],
            ["Tier 1 capital ratio (%)", "14.15"],
            ["% of Gross NPA", "1.83"],
            ["% of Net NPA", "0.48"],
            ["Provision Coverage Ratio (%)", "73"],
            ["Liquidity Coverage Ratio (%) (approx.)", "121"],
        ],
        [360, 135],
    )
    w.para("Adjusted for the half-year profits, capital adequacy would have been 17.36% (as stated by the bank).")
    path = "public/federal-bank-results-q2-fy26.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Federal Bank - Q2 FY26 results, 30 Sep 2025 (extract)", bank="The Federal Bank Limited",
        category="commercial_banks", doc_type="financial_results", period="Q2-FY2025-26", kind="public", source_url=url,
        expect={"crar": "PASS", "tier1_ratio": "PASS", "lcr": "PASS", "cet1_ratio": "NOT_DISCLOSED"})


def sbi_results():
    url = "https://sbi.bank.in/documents/17836/53469043/SBI+Analyst+Presentation+Q1FY26.pdf"
    w = Writer(banner(url))
    w.heading("State Bank of India")
    w.heading("Quarterly results Q1FY26 - quarter ended June 30, 2025", 11)
    w.table(
        ["Key metrics (Standalone)", "Q1FY26"],
        [
            ["Capital Adequacy Ratio (CAR) (%)", "14.63"],
            ["Net NPA ratio (%)", "0.47"],
            ["Provision Coverage Ratio (PCR) (%)", "74.49"],
            ["PCR incl. AUCA (%)", "91.71"],
            ["Return on Assets (ROA) (%)", "1.14"],
            ["Net Profit (Rs. in crore)", "19,160"],
        ],
        [360, 135],
    )
    w.para("State Bank of India is a Domestic Systemically Important Bank (D-SIB).")
    path = "public/sbi-results-q1-fy26.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="State Bank of India - Q1 FY26 results, 30 Jun 2025 (extract)", bank="State Bank of India",
        category="commercial_banks", doc_type="financial_results", period="Q1-FY2025-26", kind="public", source_url=url,
        expect={"crar": "PASS (14.63 vs 9; vs 11.5 with CCB)", "d-sib": "detected - leverage 4% rule selected (not disclosed here)"})


def equitas_pillar3():
    url = "https://ir.equitas.bank.in/wp-content/uploads/2025/04/Pillar-III-Disclosure-Q4FY25.pdf"
    w = Writer(banner(url + " ; https://ir.equitas.bank.in/wp-content/uploads/2025/04/ESFB_IR-Q4FY25-Investor-Presentation-.pdf"))
    w.heading("Equitas Small Finance Bank Limited")
    w.heading("Pillar III Disclosure - March 31, 2025", 11)
    w.heading("Capital adequacy", 11)
    w.table(
        ["Particulars", "31.03.2025"],
        [
            ["Capital Adequacy Ratio - CRAR (%)", "20.60"],
            ["Tier I capital ratio (%)", "17.84"],
            ["Tier II capital ratio (%)", "2.76"],
        ],
        [360, 135],
    )
    w.heading("Liquidity Coverage Ratio", 11)
    w.para(
        "The average LCR for the quarter ended Mar 31, 2025 is 156.52% as against RBI minimum requirement of 100% on a daily basis."
    )
    w.heading("Asset quality", 11)
    w.table(
        ["Particulars", "31.03.2025"],
        [
            ["Gross NPA (%)", "2.89"],
            ["Net NPA (%)", "0.98"],
            ["Provision Coverage Ratio (%)", "66.83"],
            ["PCR including technical write-offs (%)", "82.01"],
        ],
        [360, 135],
    )
    path = "public/equitas-sfb-pillar3-mar-2025.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Equitas Small Finance Bank - Pillar III, 31 Mar 2025 (extract)", bank="Equitas Small Finance Bank Limited",
        category="small_finance_banks", doc_type="pillar3", period="Q4-FY2024-25", kind="public", source_url=url,
        expect={"crar": "PASS (20.60 vs 15)", "tier1_ratio": "PASS (17.84 vs 7.5)", "lcr": "PASS (156.52 vs 100)"})


def ujjivan_results():
    url = "https://www.ujjivansfb.bank.in/sites/default/files/2025-11/Pillar-III-disclosures-as-at-September-30-2025-Final.pdf"
    w = Writer(banner(url + " ; https://www.ujjivansfb.bank.in/press-release/Profit-increases-to-rupees122-Crore-up-18-2percentage-17-oct-2025"))
    w.heading("Ujjivan Small Finance Bank Limited")
    w.heading("Key highlights as on September 30, 2025", 11)
    w.table(
        ["Particulars", "30.09.2025"],
        [
            ["Capital adequacy ratio - CRAR (%)", "21.4"],
            ["Tier I ratio (%)", "19.9"],
            ["Gross NPA (%)", "2.45"],
            ["Net NPA (%)", "0.67"],
            ["Total deposits (Rs. crore)", "39,211"],
            ["Gross loan book (Rs. crore)", "34,588"],
        ],
        [360, 135],
    )
    w.para("The Bank computes and maintains its Liquidity Coverage Ratio above the regulatory minimum; the figure is in the full Pillar III document.")
    path = "public/ujjivan-sfb-highlights-sep-2025.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Ujjivan Small Finance Bank - highlights, 30 Sep 2025 (extract)", bank="Ujjivan Small Finance Bank Limited",
        category="small_finance_banks", doc_type="pillar3", period="Q2-FY2025-26", kind="public", source_url=url,
        expect={"crar": "PASS (21.4 vs 15)", "tier1_ratio": "PASS", "lcr": "NOT_DISCLOSED"})


def saraswat_annual():
    url = "https://www.saraswat.bank.in/Assets/Annual%20Report%20-%202024-25_15072025_0537.pdf"
    w = Writer(banner(url))
    w.heading("Saraswat Co-operative Bank Ltd.")
    w.heading("Annual Report 2024-25 - key figures for the year ended March 31, 2025", 11)
    w.table(
        ["Particulars", "31.03.2025", "31.03.2024"],
        [
            ["Capital to Risk-weighted Assets Ratio - CRAR (%)", "17.43", "17.28"],
            ["Gross NPA (%)", "2.25", "2.88"],
            ["Net NPA (%)", "0.00", "0.00"],
        ],
        [300, 97, 98],
    )
    w.para("The Bank has maintained zero Net NPA for the third consecutive year. The full annual report (see source URL) contains the Notes to Accounts; this extract contains the key ratios only.")
    path = "public/saraswat-cooperative-bank-annual-report-2024-25.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Saraswat Co-operative Bank - Annual Report 2024-25 (key figures extract)", bank="Saraswat Co-operative Bank Limited",
        category="urban_cooperative_banks", doc_type="annual_report", period="Q4-FY2024-25", kind="public", source_url=url,
        expect={"crar": "PASS (17.43 is above both 9% and 12%, so the tier does not matter)", "net_worth": "NOT_DISCLOSED",
                "disclosures": "most Notes-to-Accounts items LIKELY_MISSING because this is only an extract"})


# ─────────────────────────── test cases (fictional) ───────────────────────────

FICTIONAL = "FICTIONAL TEST DOCUMENT for URCC-EF - the bank and all figures are invented."


def demo_sfb_pillar3():
    w = Writer(FICTIONAL)
    w.heading("Example Small Finance Bank Limited")
    w.heading("Basel III Pillar 3 Disclosures as at September 30, 2025", 11)
    w.para("The Bank is required to maintain a minimum CRAR of 15% and a minimum CET1 ratio of 6% on an ongoing basis. "
           "The minimum leverage ratio is 4.5%.")
    w.heading("Template KM1: Key metrics (Standalone)", 11)
    w.table(
        ["", "Sep 30, 2025", "Jun 30, 2025", "Mar 31, 2025"],
        [
            ["5 Common Equity Tier 1 ratio (%)", "11.90", "12.40", "12.80"],
            ["6 Tier 1 ratio (%)", "13.10", "13.60", "14.00"],
            ["7 Total capital ratio (%)", "14.20", "15.30", "15.90"],
            ["14 Basel III leverage ratio (%)", "4.20", "4.60", "4.90"],
            ["17 LCR (%)", "96.40", "112.00", "121.50"],
            ["20 NSFR (%)", "108.30", "110.20", "111.70"],
        ],
        [215, 95, 95, 90],
    )
    path = "test-cases/example-sfb-pillar3-sep-2025.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Example SFB - Pillar 3 KM1 with breaches (fictional)", bank="Example Small Finance Bank Limited",
        category="small_finance_banks", doc_type="pillar3", period="Q2-FY2025-26", kind="test",
        expect={"crar": "BREACH (14.20 < 15)", "cet1_ratio": "PASS (11.90 >= 6)", "tier1_ratio": "PASS",
                "leverage_ratio": "BREACH (4.20 < 4.5)", "lcr": "BREACH (96.40 < 100)", "nsfr": "PASS",
                "note": "first column (current quarter) must be read, not the earlier quarters; the 15% minimum in the text must not be read as the bank's CRAR"})


def demo_cb_annual():
    w = Writer(FICTIONAL)
    w.heading("Example Commercial Bank Limited")
    w.heading("Annual Report 2025-26", 12)
    w.heading("Directors' Report", 11)
    w.para("The Board of Directors of Example Commercial Bank Limited presents the annual report together with the audited "
           "financial statements for the year ended March 31, 2026.")
    w.heading("Corporate governance", 11)
    w.para("The Audit Committee of the Board met six times during the year and reviewed the internal audit and concurrent "
           "audit reports, the compliance function and the status of implementation of the Risk Based Internal Audit. "
           "The Risk Management Committee of the Board reviewed credit risk, market risk, liquidity risk and operational "
           "risk, and approved the revised concentration risk management policy, including the limits on exposure to a "
           "single counterparty and to groups of connected counterparties.")
    w.para("The Board approved the Know Your Customer and Anti-Money Laundering policy, which requires customer due diligence "
           "at account opening, periodic updation of KYC based on the risk category of the customer and reporting of "
           "suspicious transactions to FIU-IND. The policy is reviewed by the Board annually.")
    w.para("The Bank has a Board-approved customer grievance redressal policy. Complaints are acknowledged within one working "
           "day and the Customer Service Committee of the Board reviews complaint trends every quarter. The Bank has appointed "
           "an Internal Ombudsman who examines every complaint that is partly or wholly rejected by the Bank before the "
           "decision is conveyed to the customer.")
    w.para("The outsourcing policy approved by the Board sets out the criteria for selecting service providers, the due "
           "diligence to be performed and the Bank's continued responsibility for outsourced activities. A cyber security "
           "policy, distinct from the information technology policy, has been approved by the Board, and the Special "
           "Committee of the Board for Monitoring and Follow-up of cases of Frauds reviews all frauds of Rs. 1 crore and above.")
    w.heading("Schedule 18 - Notes to Accounts", 11)
    w.heading("(1) Regulatory capital - Composition of Regulatory Capital", 10)
    w.table(
        ["Particulars (Rs. in crore)", "31.03.2026", "31.03.2025"],
        [
            ["Common Equity Tier 1 capital", "6,080", "6,300"],
            ["Tier 1 capital", "7,120", "7,050"],
            ["Total capital", "8,640", "8,700"],
            ["Total risk weighted assets", "80,000", "72,500"],
            ["CET1 Ratio (%)", "7.60", "8.69"],
            ["Tier 1 Ratio (%)", "8.90", "9.72"],
            ["Total Capital Ratio - CRAR (%)", "10.80", "12.00"],
            ["Leverage Ratio (%)", "3.90", "4.10"],
        ],
        [300, 97, 98],
    )
    w.heading("(2) Asset liability management - Maturity pattern of certain items of assets and liabilities", 10)
    w.para("The maturity pattern of deposits, advances, investments, borrowings and foreign currency assets and liabilities is "
           "given in the table below, bucketed from day 1 to over 5 years.")
    w.heading("Liquidity coverage ratio (LCR) and Net Stable Funding Ratio (NSFR)", 10)
    w.table(["Particulars", "Q4 FY26", "Q3 FY26"], [["Liquidity Coverage Ratio (%)", "104.20", "109.80"], ["Net Stable Funding Ratio (%)", "101.50", "103.10"]], [300, 97, 98])
    w.heading("(3) Investments - Composition of investment portfolio", 10)
    w.para("Government securities, other approved securities, shares, debentures and bonds, subsidiaries and joint ventures.")
    w.heading("(4) Asset quality - Classification of advances and provisions held", 10)
    w.table(
        ["Particulars", "31.03.2026", "31.03.2025"],
        [
            ["Gross NPA to Gross Advances (%)", "4.10", "3.60"],
            ["Net NPA to Net Advances (%)", "1.60", "1.20"],
            ["Provision coverage ratio (%)", "71.20", "74.00"],
        ],
        [300, 97, 98],
    )
    w.para("Sector-wise advances and Gross NPAs: agriculture and allied activities, industry, services and personal loans.")
    w.heading("(5) Exposures", 10)
    w.para("Exposure to real estate sector and exposure to capital market are within the Board-approved limits.")
    w.heading("(6) Concentration of deposits, advances, exposures and NPAs", 10)
    w.para("Deposits of the twenty largest depositors constitute 6.2% of total deposits of the bank.")
    w.heading("(7) Derivatives", 10)
    w.para("The Bank undertakes forward rate agreements and interest rate swaps for hedging its balance sheet.")
    w.heading("(11) Disclosure of complaints", 10)
    w.para("Number of complaints received during the year: 4,812; complaints pending at the end of the year: 57.")
    w.heading("(12) Disclosure of penalties imposed by the RBI", 10)
    w.para("No penalty was imposed by the Reserve Bank of India on the Bank during the year.")
    w.heading("(14) Other disclosures - Business ratios", 10)
    w.table(["Particulars", "2025-26", "2024-25"], [["Return on Assets (%)", "0.62", "0.81"], ["Profit per employee (Rs. in lakh)", "9.8", "12.1"]], [300, 97, 98])
    w.heading("Priority sector lending", 10)
    w.table(["Particulars", "2025-26"], [["Priority sector advances as % of ANBC", "38.20"]], [360, 135])
    w.para("Payment of DICGC insurance premium: the Bank has paid the deposit insurance premium to DICGC in time. "
           "Related party disclosures are made as per Accounting Standard 18.")
    path = "test-cases/example-commercial-bank-annual-report-2025-26.pdf"
    w.save(os.path.join(HERE, path))
    add(path, title="Example Commercial Bank - Annual Report 2025-26 (fictional)", bank="Example Commercial Bank Limited",
        category="commercial_banks", doc_type="annual_report", period="Q4-FY2025-26", kind="test",
        expect={"crar": "PASS vs 9%, BUFFER_SHORTFALL vs 11.5% (10.80)", "cet1_ratio": "PASS vs 5.5%, BUFFER_SHORTFALL vs 8% (7.60)",
                "tier1_ratio": "PASS", "leverage_ratio": "PASS (3.90 >= 3.5, not a D-SIB)", "lcr": "PASS", "nsfr": "PASS",
                "psl_anbc_pct": "TARGET_SHORTFALL (38.20 < 40)",
                "disclosures": "LIKELY_MISSING: divergence, frauds, securitisation, DEA Fund, remuneration, bancassurance, provisions and contingencies",
                "qualitative": "KYC, grievance / Internal Ombudsman, outsourcing, audit committee passages matched to obligations"})


def demo_ucb_xlsx():
    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Key figures"
    rows = [
        ["Example Urban Co-operative Bank Ltd.", None],
        [FICTIONAL, None],
        ["As on", "31-03-2026"],
        ["Particulars", "Value"],
        ["Total deposits (Rs. in crore)", 850],
        ["CRAR (%)", 11.2],
        ["Net worth (Rs. in crore)", 4.1],
        ["Gross NPA (%)", 6.2],
        ["Net NPA (%)", 2.4],
    ]
    for r in rows:
        ws.append(r)
    ws.column_dimensions["A"].width = 42
    path = "test-cases/example-ucb-figures-mar-2026.xlsx"
    os.makedirs(os.path.join(HERE, "test-cases"), exist_ok=True)
    wb.save(os.path.join(HERE, path))
    add(path, title="Example Urban Co-operative Bank - key figures spreadsheet (fictional)", bank="Example Urban Co-operative Bank Limited",
        category="urban_cooperative_banks", doc_type="figures", period="Q4-FY2025-26", kind="test",
        expect={"ucb_tier": "2 (deposits Rs. 850 crore)", "crar": "BREACH (11.2 < 12 for Tier 2)",
                "net_worth": "PASS_WITH_CONDITIONS (4.1 < 5 but above the 50% interim level due 31 Mar 2026)"})


def demo_pb_csv():
    path = "test-cases/example-payments-bank-figures-sep-2025.csv"
    rows = [
        ["metric", "value", "unit"],
        ["Bank name", "Example Payments Bank Limited", ""],
        ["As on", "30-09-2025", ""],
        ["CRAR", "38.5", "%"],
        ["CET1 ratio", "38.5", "%"],
        ["Tier 1 ratio", "38.5", "%"],
        ["Leverage ratio", "2.6", "%"],
        ["Net worth", "412", "Rs. crore"],
    ]
    with open(os.path.join(HERE, path), "w", encoding="utf-8") as f:
        f.write("# " + FICTIONAL + "\n")
        for r in rows:
            f.write(",".join(r) + "\n")
    add(path, title="Example Payments Bank - figures CSV (fictional)", bank="Example Payments Bank Limited",
        category="payments_banks", doc_type="figures", period="Q2-FY2025-26", kind="test",
        expect={"crar": "PASS (38.5 vs 15)", "leverage_ratio": "BREACH (2.6 < 3)"})


def demo_rrb_json():
    path = "test-cases/example-rrb-figures-dec-2025.json"
    data = {
        "_note": FICTIONAL,
        "bank_name": "Example Gramin Bank",
        "institution_category": "regional_rural_banks",
        "as_of_date": "2025-12-31",
        "metrics": {"crar": 8.4, "tier1_ratio": 6.9, "gross_npa_pct": 7.8, "net_npa_pct": 3.1},
    }
    with open(os.path.join(HERE, path), "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    add(path, title="Example Gramin Bank (RRB) - figures JSON (fictional)", bank="Example Gramin Bank",
        category="regional_rural_banks", doc_type="figures", period="Q3-FY2025-26", kind="test",
        expect={"crar": "BREACH (8.4 < 9)", "tier1_ratio": "BREACH (6.9 < 7)"})


if __name__ == "__main__":
    for fn in (idfc_first_pillar3, federal_bank_results, sbi_results, equitas_pillar3, ujjivan_results, saraswat_annual,
               demo_sfb_pillar3, demo_cb_annual, demo_ucb_xlsx, demo_pb_csv, demo_rrb_json):
        fn()
    with open(os.path.join(HERE, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"generated_by": "generate_samples.py", "samples": SAMPLES}, f, indent=2, ensure_ascii=False)
    print(f"wrote {len(SAMPLES)} samples")
