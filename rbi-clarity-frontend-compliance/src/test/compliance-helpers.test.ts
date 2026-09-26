import { describe, expect, it } from "vitest";
import {
  formatPeriod,
  formatThreshold,
  parsePeriod,
  periodForDate,
  resolveSummary,
  ruleLabel,
  statusClass,
  validateNumber,
} from "@/lib/compliance";

describe("reporting periods", () => {
  it("formats and parses Indian FY quarter labels", () => {
    expect(formatPeriod({ quarter: 1, fyStart: 2026 })).toBe("Q1-FY2026-27");
    expect(formatPeriod({ quarter: 4, fyStart: 2099 })).toBe("Q4-FY2099-00");
    expect(parsePeriod("Q3-FY2025-26")).toEqual({ quarter: 3, fyStart: 2025 });
    expect(parsePeriod("Q3-FY2025-27")).toBeNull();
    expect(parsePeriod("bad")).toBeNull();
  });

  it("derives the current quarter from a date (FY starts in April)", () => {
    expect(periodForDate(new Date(2026, 8, 27))).toEqual({ quarter: 2, fyStart: 2026 });
    expect(periodForDate(new Date(2027, 1, 1))).toEqual({ quarter: 4, fyStart: 2026 });
    expect(periodForDate(new Date(2026, 3, 1))).toEqual({ quarter: 1, fyStart: 2026 });
  });
});

describe("display helpers", () => {
  it("prefers form_label, falls back to variable_text, never invents a label", () => {
    expect(ruleLabel({ rule_id: 1, form_label: "CRAR", variable_text: "crar" })).toBe("CRAR");
    expect(ruleLabel({ rule_id: 1, form_label: " ", variable_text: "capital ratio" })).toBe("capital ratio");
    expect(ruleLabel({ rule_id: 7, form_label: null, variable_text: null })).toBe("Rule 7");
  });

  it("formats thresholds", () => {
    expect(formatThreshold(">=", 9, "%")).toBe("≥ 9 %");
    expect(formatThreshold("between", 1, null)).toBe("between 1");
    expect(formatThreshold(">=", null, "%")).toBe("—");
  });

  it("validates numeric input", () => {
    expect(validateNumber("")).toBeNull();
    expect(validateNumber("15.5")).toBeNull();
    expect(validateNumber("1,50,000")).toBeNull();
    expect(validateNumber("-3")).toBeNull();
    expect(validateNumber("12a")).toBe("Enter a valid number");
  });

  it("uses only the existing status palette", () => {
    expect(statusClass("PASS")).toContain("green-100");
    expect(statusClass("BREACH")).toContain("red-100");
    expect(statusClass("PARTIAL")).toContain("yellow-100");
    expect(statusClass("NEEDS_REVIEW")).toContain("bg-muted");
    expect(statusClass("SOMETHING_NEW")).toContain("bg-muted");
  });
});

describe("resolveSummary", () => {
  it("prefers backend summary numbers", () => {
    const s = resolveSummary([{ summary: { quant_breaches: 5, qual_gaps: 2 } }], [], []);
    expect(s.quant_breach).toBe(5);
    expect(s.qual_gap).toBe(2);
    expect(s.quant_checked).toBe(0);
  });

  it("tallies backend statuses when summary counts are absent", () => {
    const s = resolveSummary(
      [{}],
      [
        { rule_id: 1, status: "PASS" },
        { rule_id: 2, status: "BREACH", mapping_warning: "check" },
        { rule_id: 3, status: "NOT_REPORTED" },
      ],
      [{ status: "COVERED" }, { status: "LIKELY_GAP" }, { status: "PARTIAL" }],
    );
    expect(s).toMatchObject({
      quant_checked: 3, quant_pass: 1, quant_breach: 1, quant_not_reported: 1,
      qual_checked: 3, qual_covered: 1, qual_partial: 1, qual_gap: 1, mapping_warnings: 1,
    });
  });

  it("returns null (not zero) when nothing is known", () => {
    expect(resolveSummary([{ run_id: 1 }]).quant_breach).toBeNull();
  });
});
