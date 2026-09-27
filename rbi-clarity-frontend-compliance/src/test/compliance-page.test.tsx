import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import * as api from "@/lib/api";
import CompliancePage from "@/pages/CompliancePage";

vi.mock("@/lib/api", async (orig) => {
  const actual = await orig<typeof import("@/lib/api")>();
  return {
    ...actual,
    getBanks: vi.fn(),
    createBank: vi.fn(),
    getApplicableRules: vi.fn(),
    getQuantitativeSubmissions: vi.fn(),
    submitQuantitativeData: vi.fn(),
    getQualitativeEvidence: vi.fn(),
    submitQualitativeEvidence: vi.fn(),
    runComplianceCheck: vi.fn(),
    getComplianceRuns: vi.fn(),
    getComplianceRun: vi.fn(),
    getCategories: vi.fn().mockResolvedValue([]),
  };
});

const m = vi.mocked(api);

const bank = { bank_id: "BANK-001", bank_name: "Example Bank", institution_category: "commercial_banks" };
const rules: api.ApplicableRule[] = [
  {
    rule_id: 11, operator: ">=", threshold_value: 9, threshold_unit: "%", variable_text: "capital to risk weighted assets ratio",
    clause_text: "Banks shall maintain a minimum CRAR of 9 per cent.", page_number: 4, rbi_ref: "DOR.CAP.REC.1",
    form_label: "CRAR", mapping_status: "verified", already_submitted: false,
  },
  {
    rule_id: 12, operator: "<=", threshold_value: 25, threshold_unit: "%", variable_text: "single borrower exposure",
    clause_text: null, page_number: 7, rbi_ref: "DOR.LE.1", form_label: null, mapping_status: "unverified", already_submitted: false,
  },
];

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/dashboard/compliance" element={<CompliancePage />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.getBanks.mockResolvedValue([bank]);
  m.getApplicableRules.mockResolvedValue(rules);
  m.getQuantitativeSubmissions.mockResolvedValue([
    { rule_id: 11, reported_value: 12.5, period_label: "Q1-FY2026-27", source_note: "ALM return" },
    { rule_id: 11, reported_value: 99, period_label: "Q4-FY2025-26" },
  ]);
  m.getQualitativeEvidence.mockResolvedValue([]);
  m.getComplianceRuns.mockResolvedValue([]);
});

describe("CompliancePage", () => {
  it("loads rules, restores saved values for the period and labels unverified mappings", async () => {
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=quant");
    expect(await screen.findByText("CRAR")).toBeInTheDocument();
    // form_label missing → falls back to variable_text
    expect(screen.getByText("single borrower exposure")).toBeInTheDocument();
    expect(screen.getByText("Unverified mapping")).toBeInTheDocument();
    expect(m.getApplicableRules).toHaveBeenCalledWith("BANK-001", "Q1-FY2026-27");
    await waitFor(() => expect(screen.getByLabelText("Reported value for CRAR")).toHaveValue("12.5"));
    expect(screen.getByLabelText("Source note for CRAR")).toHaveValue("ALM return");
  });

  it("submits changed values and shows field errors and anomaly flags", async () => {
    m.submitQuantitativeData.mockResolvedValue([
      { ok: true, rule_id: 11, period_label: "Q1-FY2026-27", flags: ["Value differs 40% from previous period"] },
      { ok: false, rule_id: 12, period_label: "Q1-FY2026-27", error: "Value out of plausible range" },
    ]);
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=quant");
    const crar = await screen.findByLabelText("Reported value for CRAR");
    await waitFor(() => expect(crar).toHaveValue("12.5"));
    fireEvent.change(crar, { target: { value: "8" } });
    fireEvent.change(screen.getByLabelText("Reported value for single borrower exposure"), { target: { value: "300" } });
    fireEvent.click(screen.getByRole("button", { name: /save 2 values/i }));

    await waitFor(() => expect(m.submitQuantitativeData).toHaveBeenCalledTimes(1));
    expect(m.submitQuantitativeData).toHaveBeenCalledWith("BANK-001", [
      { rule_id: 11, reported_value: 8, period_label: "Q1-FY2026-27", source_note: "ALM return" },
      { rule_id: 12, reported_value: 300, period_label: "Q1-FY2026-27", source_note: "Manual entry" },
    ]);
    expect(await screen.findByText("Value out of plausible range")).toBeInTheDocument();
    expect(screen.getByText(/Value differs 40% from previous period/)).toBeInTheDocument();
    // Rejected value is preserved
    expect(screen.getByLabelText("Reported value for single borrower exposure")).toHaveValue("300");
  });

  it("blocks invalid numbers inline without calling the API", async () => {
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=quant");
    const input = await screen.findByLabelText("Reported value for single borrower exposure");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: /save 1 value/i }));
    expect(await screen.findByText("Enter a valid number")).toBeInTheDocument();
    expect(m.submitQuantitativeData).not.toHaveBeenCalled();
  });

  it("keeps entered values when the whole request fails", async () => {
    m.submitQuantitativeData.mockRejectedValue(new Error("Network down"));
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=quant");
    const input = await screen.findByLabelText("Reported value for single borrower exposure");
    fireEvent.change(input, { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /save 1 value/i }));
    await waitFor(() => expect(m.submitQuantitativeData).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByRole("button", { name: /save 1 value/i })).not.toBeDisabled());
    expect(input).toHaveValue("20");
  });

  it("shows a retry action when rules fail to load", async () => {
    m.getApplicableRules.mockRejectedValueOnce(new Error("Backend exploded"));
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=quant");
    expect(await screen.findByText("Backend exploded")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByText("CRAR")).toBeInTheDocument();
  });

  it("runs a check and displays backend statuses verbatim (no client-side recomputation)", async () => {
    m.runComplianceCheck.mockResolvedValue({
      run_id: 77,
      report: { summary: { quant_rules_checked: 2, quant_breaches: 1 } },
      quant_results: [
        // Reported 5 vs ≥ 9 would "look" like a breach — backend says PASS, UI must show PASS.
        { rule_id: 11, status: "PASS", reported_value: 5, operator: ">=", threshold_value: 9, threshold_unit: "%", form_label: "CRAR", rbi_ref: "DOR.CAP.REC.1", page_number: 4 },
        { rule_id: 12, status: "BREACH", reported_value: 30, operator: "<=", threshold_value: 25, threshold_unit: "%", variable_text: "single borrower exposure", mapping_warning: "Label may refer to group exposure" },
      ],
      qual_results: [
        { status: "LIKELY_GAP", rbi_requirement: "Board-approved AML policy", evidence_excerpt: "AML policy exists", justification: "No board approval found", confidence: 0.62, source_reference: "KYC MD s.4" },
      ],
    });
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=run");
    const runBtn = await screen.findByRole("button", { name: /run compliance check/i });
    fireEvent.click(runBtn);

    expect(await screen.findByText("Run #77 · Q1-FY2026-27")).toBeInTheDocument();
    expect(m.runComplianceCheck).toHaveBeenCalledWith("BANK-001", {
      period_label: "Q1-FY2026-27", use_llm_mapping_check: false, submitted_field_labels: {}, qual_sample_limit: 40, persist: true,
    });
    const results = screen.getByRole("region", { name: "Compliance results" });
    const crarItem = within(results).getByText("CRAR").closest("li")!;
    expect(within(crarItem).getByText("Pass")).toBeInTheDocument();
    expect(within(results).getByText("≥ 9 %")).toBeInTheDocument();
    expect(screen.getByText(/Mapping warning \(advisory\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /qualitative \(1\)/i }));
    expect(screen.getByText("Board-approved AML policy")).toBeInTheDocument();
    expect(screen.getByText("No board approval found")).toBeInTheDocument();
    expect(screen.getByText("Confidence: 62%")).toBeInTheDocument();
  });

  it("lists history and opens a saved run", async () => {
    m.getComplianceRuns.mockResolvedValue([
      { run_id: 5, period_label: "Q1-FY2026-27", created_at: "2026-07-01T10:00:00Z", report: { summary: { quant_checked: 10, quant_breach: 2, qual_checked: 4, qual_gap: 1 } } },
    ]);
    m.getComplianceRun.mockResolvedValue({
      run_id: 5, period_label: "Q1-FY2026-27", created_at: "2026-07-01T10:00:00Z", report: {},
      quant_results: [{ rule_id: 11, status: "NOT_REPORTED", form_label: "CRAR" }], qual_results: [],
    });
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=history");
    expect(await screen.findByText("#5")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText("Run #5 · Q1-FY2026-27")).toBeInTheDocument();
    expect(m.getComplianceRun).toHaveBeenCalledWith(5);
    const results = screen.getByRole("region", { name: "Compliance results" });
    const crarItem = within(results).getByText("CRAR").closest("li")!;
    expect(within(crarItem).getByText("Not reported")).toBeInTheDocument();
  });

  it("validates the bank form inline", async () => {
    renderAt("/dashboard/compliance?tab=setup");
    fireEvent.click(await screen.findByRole("button", { name: /create bank/i }));
    expect(await screen.findByText("Bank ID is required")).toBeInTheDocument();
    expect(screen.getByText("Bank name is required")).toBeInTheDocument();
    expect(screen.getByText("Select an institution category")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Bank ID"), { target: { value: "BANK-001" } });
    fireEvent.click(screen.getByRole("button", { name: /create bank/i }));
    expect(await screen.findByText(/already exists/)).toBeInTheDocument();
    expect(m.createBank).not.toHaveBeenCalled();
  });

  it("submits qualitative evidence and keeps failed drafts", async () => {
    m.submitQualitativeEvidence.mockRejectedValueOnce(new Error("Evidence store unavailable"));
    renderAt("/dashboard/compliance?bank=BANK-001&period=Q1-FY2026-27&tab=qual");
    const box = await screen.findByLabelText("Evidence text");
    const text = "The bank's board-approved AML policy requires CTR filing within 15 days.";
    fireEvent.change(box, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: /save evidence/i }));
    expect(await screen.findByText("Evidence store unavailable")).toBeInTheDocument();
    expect(screen.getByLabelText("Evidence text")).toHaveValue(text);
    expect(m.submitQualitativeEvidence).toHaveBeenCalledWith("BANK-001", {
      evidence_text: text, source_type: "policy_manual", period_label: "Q1-FY2026-27",
    });
  });
});
