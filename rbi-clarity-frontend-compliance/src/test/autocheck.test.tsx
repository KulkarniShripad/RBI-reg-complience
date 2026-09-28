import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AutoReportView } from "@/components/autocheck/AutoReportView";
import { formatFigure, periodOfDate, type AutoReport } from "@/lib/disclosures";

describe("disclosure helpers", () => {
  it("maps a date to the RBI reporting quarter", () => {
    expect(periodOfDate("2025-06-30")).toBe("Q1-FY2025-26");
    expect(periodOfDate("2025-12-31")).toBe("Q3-FY2025-26");
    expect(periodOfDate("2026-03-31")).toBe("Q4-FY2025-26");
    expect(periodOfDate("bad")).toBeNull();
  });
  it("formats figures with their unit", () => {
    expect(formatFigure(14.2, "%")).toBe("14.2%");
    expect(formatFigure(39211, "₹ crore")).toBe("39,211 ₹ crore");
    expect(formatFigure(null, "%")).toBe("—");
  });
});

const source = { verified: true, clause_uri: "rbi://sfb/x/para10", rbi_ref: "RBI/DOR/2025-26/0", paragraph: "10", page_number: 14, excerpt: "at least 15 per cent" };

const report: AutoReport = {
  mode: "auto",
  run_id: 5,
  generated_at: "2026-01-01T00:00:00Z",
  overall: "BREACH",
  bank: { bank_id: "EX-SFB", bank_name: "Example Small Finance Bank Limited", institution_category: "small_finance_banks", institution_label: "Small Finance Banks", created: true },
  period_label: "Q2-FY2025-26",
  as_of_date: "2025-09-30",
  document: { upload_id: 3, file_name: "ex.pdf", format: "pdf", page_count: 1, doc_type: "pillar3", doc_type_label: "Basel III Pillar 3 disclosure" },
  profile: { is_dsib: false, ucb_tier: null, detected_by: "rules" },
  summary: {
    rules_applicable: 2, rules_evaluated: 2, pass: 1, breach: 1, buffer_shortfall: 0, target_shortfall: 0, not_disclosed: 0, needs_review: 0,
    discovered_rules: 0, disclosures_checked: 0, disclosures_present: 0, disclosures_missing: 0, obligations_matched: 0, obligations_covered: 0,
    obligations_partial: 0, figures_found: 2, submissions_backfilled: 0,
  },
  figures: [{ metric_key: "crar", label: "CRAR", value: 14.2, unit: "%", basis: null, page: 1, snippet: "7 Total capital ratio (%) | 14.20", method: "table", confidence: "high", alternatives: [] }],
  rule_results: [
    { id: "rule:sfb_nsfr", rule_key: "sfb_nsfr", metric_key: "nsfr", metric_label: "NSFR", label: "NSFR of at least 100%", level: "minimum", operator: ">=", threshold: 100, reported_value: 108.3, unit: "%", status: "PASS", origin: "anchored", source },
    { id: "rule:sfb_crar", rule_key: "sfb_crar", metric_key: "crar", metric_label: "CRAR", label: "Minimum total capital (CRAR) of 15% of RWAs", level: "minimum", operator: ">=", threshold: 15, reported_value: 14.2, unit: "%", status: "BREACH", origin: "anchored", source, figure: { page: 1, snippet: null, method: "table", confidence: "high" } },
  ],
  disclosures: { applicable: false, reason: "Figures-only document.", items: [] },
  qualitative: { applicable: false, reason: "Figures-only document.", results: [] },
  executive_summary: "One breach found.",
  executive_summary_by: "template",
  method: { llm_configured: false, llm_requested: true, deterministic: ["arithmetic"], llm: ["summary"] },
  notes: ["A note."],
};

describe("AutoReportView", () => {
  it("lists findings first with reported vs required values, the RBI paragraph and a download link", () => {
    render(<AutoReportView report={report} />);
    expect(screen.getByText("Example Small Finance Bank Limited")).toBeInTheDocument();
    expect(screen.getByText("One breach found.")).toBeInTheDocument();
    const rows = screen.getAllByText(/Minimum total capital|NSFR of at least/).map((e) => e.textContent);
    expect(rows[0]).toMatch(/Minimum total capital/); // the breach comes before the pass
    expect(screen.getByText("14.2%")).toBeInTheDocument();
    expect(screen.getAllByText("≥ 15%").length).toBe(1);
    expect(screen.getAllByRole("button", { name: /Open RBI\/DOR\/2025-26\/0 para 10/ }).length).toBe(2);
    expect(screen.getByRole("link", { name: /Download/ }).getAttribute("href")).toMatch(/runs\/5\/report\.html\?download=1/);
  });

  it("explains why a section is empty", () => {
    render(<AutoReportView report={report} />);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Disclosures/ }));
    expect(screen.getByText("Figures-only document.")).toBeInTheDocument();
  });
});
