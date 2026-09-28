import axios from "axios";
import { API_BASE_URL } from "@/lib/api";
import type {
  ApplicableRule,
  ComplianceSummary,
  QualitativeResult,
  QuantitativeResult,
  SubmissionFlag,
} from "@/lib/api";

// Institution categories are loaded from the backend - see src/lib/categories.ts.

export const formatLabel = (s: string | null | undefined) =>
  (s ?? "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

// ── Reporting periods: Indian financial year (April–March), e.g. Q1-FY2026-27 ──

export interface Period {
  quarter: 1 | 2 | 3 | 4;
  fyStart: number;
}

export const formatPeriod = ({ quarter, fyStart }: Period) =>
  `Q${quarter}-FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;

export const parsePeriod = (label: string | null | undefined): Period | null => {
  const m = /^Q([1-4])-FY(\d{4})-(\d{2})$/.exec((label ?? "").trim());
  if (!m) return null;
  const fyStart = Number(m[2]);
  if ((fyStart + 1) % 100 !== Number(m[3])) return null;
  return { quarter: Number(m[1]) as Period["quarter"], fyStart };
};

export const periodForDate = (d: Date): Period => {
  const month = d.getMonth(); // 0 = Jan
  const fyStart = month >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  const quarter = (month >= 3 ? Math.floor((month - 3) / 3) + 1 : 4) as Period["quarter"];
  return { quarter, fyStart };
};

export const QUARTER_MONTHS: Record<number, string> = {
  1: "Apr–Jun",
  2: "Jul–Sep",
  3: "Oct–Dec",
  4: "Jan–Mar",
};

export const fyOptions = (today = new Date()) => {
  const current = periodForDate(today).fyStart;
  const years: number[] = [];
  for (let y = current + 1; y >= current - 4; y--) years.push(y);
  return years;
};

// ── Display helpers ──

export const ruleLabel = (r: Pick<ApplicableRule, "rule_id" | "form_label" | "variable_text">) =>
  r.form_label?.trim() || r.variable_text?.trim() || `Rule ${r.rule_id}`;

const OPERATOR_SYMBOLS: Record<string, string> = {
  ">=": "≥", "=>": "≥", gte: "≥", ge: "≥", min: "≥",
  "<=": "≤", "=<": "≤", lte: "≤", le: "≤", max: "≤",
  ">": ">", gt: ">",
  "<": "<", lt: "<",
  "==": "=", "=": "=", eq: "=",
  "!=": "≠", ne: "≠",
};

export const operatorSymbol = (op: string | null | undefined) => {
  if (!op) return "";
  return OPERATOR_SYMBOLS[op.trim().toLowerCase()] ?? op;
};

export const formatThreshold = (
  op: string | null | undefined,
  value: number | string | null | undefined,
  unit: string | null | undefined,
) => {
  if (value === null || value === undefined || value === "") return "—";
  return [operatorSymbol(op), String(value), unit ?? ""].filter(Boolean).join(" ");
};

export const formatValue = (v: number | string | null | undefined, unit?: string | null) => {
  if (v === null || v === undefined || v === "") return "—";
  return unit ? `${v} ${unit}` : String(v);
};

export const formatDateTime = (s: string | null | undefined) => {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

export const flagText = (f: SubmissionFlag): string => {
  if (typeof f === "string") return f;
  return f.message || f.detail || f.code || JSON.stringify(f);
};

export const formatConfidence = (c: number | string | null | undefined) => {
  if (c === null || c === undefined || c === "") return null;
  if (typeof c === "number") return c <= 1 ? `${Math.round(c * 100)}%` : `${Math.round(c)}%`;
  return c;
};

// ── Status badge styles — the same palette ChatPage (confidence) and RulesPage (active) already use ──

const GOOD = "bg-green-100 text-green-800 border-green-300";
const WARN = "bg-yellow-100 text-yellow-800 border-yellow-300";
const BAD = "bg-red-100 text-red-800 border-red-300";
const NEUTRAL = "bg-muted text-muted-foreground border-border";

const ORANGE = "bg-orange-100 text-orange-800 border-orange-300";
const BLUE = "bg-blue-100 text-blue-800 border-blue-300";

export const STATUS_STYLES: Record<string, string> = {
  PASS: GOOD,
  COVERED: GOOD,
  BREACH: BAD,
  LIKELY_GAP: BAD,
  PARTIAL: WARN,
  NOT_REPORTED: NEUTRAL,
  NEEDS_REVIEW: NEUTRAL,
  // automatic document check
  PASS_WITH_CONDITIONS: GOOD,
  BUFFER_SHORTFALL: ORANGE,
  TARGET_SHORTFALL: ORANGE,
  NOT_DISCLOSED: NEUTRAL,
  CANDIDATE: NEUTRAL,
  PRESENT: GOOD,
  LIKELY_MISSING: ORANGE,
  NOT_DEMONSTRATED: ORANGE,
  EVIDENCE_FOUND: BLUE,
  ATTENTION: ORANGE,
  INSUFFICIENT_DATA: NEUTRAL,
  // network check (graph subsystem)
  PROHIBITED: BAD,
  POTENTIAL_BREACH: WARN,
  ASSESSMENT_REQUIRED: WARN,
  REPORTABLE: "bg-blue-50 text-blue-800 border-blue-200",
  INFO: NEUTRAL,
};

export const statusClass = (status: string | null | undefined) =>
  STATUS_STYLES[(status ?? "").toUpperCase()] ?? NEUTRAL;

export const WARNING_BADGE = WARN;

export const STATUS_LABELS: Record<string, string> = {
  PASS: "Pass",
  BREACH: "Breach",
  NOT_REPORTED: "Not reported",
  COVERED: "Covered",
  PARTIAL: "Partial",
  LIKELY_GAP: "Likely gap",
  NEEDS_REVIEW: "Needs review",
  PASS_WITH_CONDITIONS: "Pass (conditions)",
  BUFFER_SHORTFALL: "Buffer shortfall",
  TARGET_SHORTFALL: "Target shortfall",
  NOT_DISCLOSED: "Not in document",
  CANDIDATE: "Possible rule",
  PRESENT: "Present",
  LIKELY_MISSING: "Likely missing",
  NOT_DEMONSTRATED: "Not demonstrated",
  EVIDENCE_FOUND: "Evidence found",
  ATTENTION: "Needs attention",
  INSUFFICIENT_DATA: "Insufficient data",
  PROHIBITED: "Prohibited",
  POTENTIAL_BREACH: "Potential breach",
  ASSESSMENT_REQUIRED: "Assessment required",
  REPORTABLE: "Reportable",
  INFO: "Info",
};

export const statusLabel = (s: string | null | undefined) =>
  STATUS_LABELS[(s ?? "").toUpperCase()] ?? formatLabel((s ?? "Unknown").toLowerCase());

// ── Mapping warnings (LLM check output is advisory only) ──

export const mappingWarningText = (q: QuantitativeResult): string | null => {
  const text = q.mapping_warning || q.llm_mapping_warning;
  if (text && String(text).trim()) return String(text);
  if ((q.mapping_status ?? "").toLowerCase() === "unverified")
    return "Field mapping for this rule is unverified.";
  return null;
};

// ── Summary: prefer backend-supplied counts; otherwise tally backend-returned statuses ──

const SUMMARY_ALIASES: Record<keyof ComplianceSummary, string[]> = {
  quant_checked: ["quant_checked", "quant_rules_checked", "quant_total", "quantitative_checked", "total_quant_rules"],
  quant_pass: ["quant_pass", "quant_passes", "quant_passed", "passes", "pass_count"],
  quant_breach: ["quant_breach", "quant_breaches", "breaches", "breach_count"],
  quant_not_reported: ["quant_not_reported", "not_reported", "not_reported_count"],
  qual_checked: ["qual_checked", "qual_rules_checked", "qual_total", "qualitative_checked", "total_qual_rules"],
  qual_covered: ["qual_covered", "covered", "covered_count"],
  qual_partial: ["qual_partial", "partial", "partial_count"],
  qual_gap: ["qual_gap", "qual_gaps", "gaps", "likely_gap", "likely_gaps", "gap_count"],
  mapping_warnings: ["mapping_warnings", "mapping_warning_count", "llm_mapping_warnings"],
};

const asCount = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  if (Array.isArray(v)) return v.length;
  return null;
};

const lookup = (sources: unknown[], key: keyof ComplianceSummary): number | null => {
  for (const src of sources) {
    if (!src || typeof src !== "object") continue;
    const obj = src as Record<string, unknown>;
    for (const alias of SUMMARY_ALIASES[key]) {
      const n = asCount(obj[alias]);
      if (n !== null) return n;
    }
  }
  return null;
};

export type PartialSummary = { [K in keyof ComplianceSummary]: number | null };

/**
 * Resolve summary numbers. `sources` are objects searched in order (e.g. report.summary, report, run row).
 * When results arrays are available, missing values are tallied from backend statuses (never recomputed).
 */
export const resolveSummary = (
  sources: unknown[],
  quant?: QuantitativeResult[] | null,
  qual?: QualitativeResult[] | null,
): PartialSummary => {
  const expanded: unknown[] = [];
  for (const s of sources) {
    expanded.push(s);
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      if (o.summary && typeof o.summary === "object") expanded.unshift(o.summary);
    }
  }
  const count = <T extends { status: string }>(arr: T[] | null | undefined, status: string) =>
    arr ? arr.filter((r) => (r.status ?? "").toUpperCase() === status).length : null;

  const fallback: PartialSummary = {
    quant_checked: quant ? quant.length : null,
    quant_pass: count(quant, "PASS"),
    quant_breach: count(quant, "BREACH"),
    quant_not_reported: count(quant, "NOT_REPORTED"),
    qual_checked: qual ? qual.length : null,
    qual_covered: count(qual, "COVERED"),
    qual_partial: count(qual, "PARTIAL"),
    qual_gap: count(qual, "LIKELY_GAP"),
    mapping_warnings: quant ? quant.filter((q) => mappingWarningText(q) !== null).length : null,
  };

  const out = {} as PartialSummary;
  (Object.keys(SUMMARY_ALIASES) as (keyof ComplianceSummary)[]).forEach((k) => {
    out[k] = lookup(expanded, k) ?? fallback[k];
  });
  return out;
};

// ── Error messages ──

export const getErrorMessage = (err: unknown, fallback = "Something went wrong."): string => {
  if (axios.isAxiosError(err)) {
    if (!err.response) {
      if (err.code === "ECONNABORTED") return "The request timed out. The backend may still be processing.";
      return `Cannot reach the backend at ${API_BASE_URL}. Check that it is running.`;
    }
    const data = err.response.data as unknown;
    if (typeof data === "string" && data.trim()) return data;
    if (data && typeof data === "object") {
      const d = data as Record<string, unknown>;
      const detail = d.detail ?? d.error ?? d.message;
      if (typeof detail === "string") return detail;
      if (Array.isArray(detail)) {
        return detail
          .map((x) => (x && typeof x === "object" && "msg" in x ? String((x as { msg: unknown }).msg) : String(x)))
          .join("; ");
      }
    }
    return `Request failed (${err.response.status}).`;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
};

export const BANK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const validateNumber = (raw: string): string | null => {
  const t = raw.trim();
  if (t === "") return null;
  if (!/^-?\d+(\.\d+)?$/.test(t.replace(/,/g, ""))) return "Enter a valid number";
  return null;
};

export const parseNumber = (raw: string) => Number(raw.trim().replace(/,/g, ""));
