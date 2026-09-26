import axios from "axios";

const api = axios.create({
  baseURL: "http://localhost:4002",
  headers: { "Content-Type": "application/json" },
});

// ── Types ──

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  metadata?: ChatResponseData;
}

export interface ChatResponseData {
  query: string;
  answer: string;
  relevant_rule_ids: string[];
  source_circulars: string[];
  confidence: "high" | "medium" | "low";
  sources_used: number;
  rules_matched: number;
  fallback_used: boolean;
  rules_detail?: RuleDetail[];
  error?: string;
}

export interface RuleDetail {
  rule_id: string;
  title: string;
  topic: string;
  subtopic: string;
  is_active: boolean;
  tags: string[];
  plain_language_summary: string;
  source_circular_id: string;
  effective_date?: string;
  requirements: Requirement[];
  conditions: any[];
  exceptions: any[];
  penalties: any[];
  related_rule_ids: string[];
  section_number?: string;
  visualization_meta?: { cluster_color: string; node_label: string; cluster: string };
}

export interface Requirement {
  type: string;
  field: string;
  value: number;
  currency: string | null;
  description: string;
}

export interface TopicData {
  topic_id: string;
  label: string;
  subtopics: string[];
  related_topics: string[];
  rule_count: number;
  active_rule_count?: number;
  circular_ids: string[];
  visualization_meta?: { cluster_color: string };
}

export interface CircularData {
  circular_id: string;
  title: string;
  topic: string;
  topics: string[];
  rule_ids: string[];
  date?: string;
  is_active: boolean;
  issuing_authority?: string;
}

export interface ComplianceResult {
  overall_status: "COMPLIANT" | "NON_COMPLIANT" | "INSUFFICIENT_DATA";
  input_parsed: Record<string, any>;
  topic_checked: string;
  rules_evaluated: number;
  violations_count: number;
  passed_count: number;
  skipped_count: number;
  violations: ComplianceCheck[];
  passed: ComplianceCheck[];
  summary: string;
  checked_at: string;
}

export interface ComplianceCheck {
  rule_id: string;
  title: string;
  topic: string;
  subtopic: string;
  status: string;
  violations: string[];
  passed: string[];
  summary: string;
  source: string;
}

export interface RulesResponse {
  rules: RuleDetail[];
  total: number;
  page: number;
  per_page: number;
  pages: number;
}

export interface UploadResult {
  success: boolean;
  circular_id: string;
  title: string;
  topic: string;
  rules_extracted: number;
  chunks_embedded: number;
  word_count: number;
  note?: string;
  error?: string;
  duplicate?: boolean;
}

// ── Topic taxonomy (static fallback) ──

export const FOLDER_SUBTOPICS: Record<string, string[]> = {
  commercial_banks:                 ["credit","deposits","NPA","capital_adequacy","interest_rate"],
  NBFC:                             ["registration","prudential_norms","fair_practices","systemic_risk"],
  payment_banks:                    ["operations","deposit_limits","KYC","digital_payments"],
  small_financial_banks:            ["lending","priority_sector","deposits","KYC"],
  Regional_Rural_Bank:              ["agricultural_credit","priority_sector","refinance"],
  local_area_banks:                 ["operations","capital","lending"],
  Urban_Cooperative_Bank:           ["governance","audit","deposits","lending"],
  Rural_Cooperative_Bank:           ["agricultural_credit","governance","audit"],
  All_India_Financial_Institutions: ["long_term_finance","infrastructure","bonds"],
  Asset_Reconstruction_Companies:   ["securitisation","NPA_acquisition","resolution"],
  Credit_Information_Services:      ["credit_report","data_submission","dispute_resolution"],
  KYC:                              ["small_account","re_kyc","video_kyc","aadhaar_kyc"],
  AML:                              ["suspicious_transactions","cash_transactions","STR","CTR"],
  PMLA:                             ["record_keeping","beneficial_ownership","reporting"],
  forex:                            ["FEMA","remittance","import_export","ECB"],
  governance:                       ["board_composition","audit","disclosure","risk_management"],
  general:                          ["miscellaneous"],
};

// ── API Calls ──

export const askQuery = async (query: string, topic?: string): Promise<ChatResponseData> => {
  const params: Record<string, string> = { query };
  if (topic) params.topic = topic;
  const res = await api.get("/ask", { params });
  return res.data;
};

export const uploadCircular = async (
  file: File,
  topic: string = "general",
  title?: string
): Promise<UploadResult> => {
  const form = new FormData();
  form.append("file", file);
  form.append("topic", topic);
  if (title) form.append("title", title);
  const res = await api.post("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return res.data;
};

export const getTopics = async (): Promise<{ topics: TopicData[]; total: number }> => {
  const res = await api.get("/topics");
  return res.data;
};

export const getRules = async (params: {
  topic?: string;
  subtopic?: string;
  tag?: string;
  search?: string;
  page?: number;
  per_page?: number;
}): Promise<RulesResponse> => {
  const res = await api.get("/rules", { params });
  return res.data;
};

export const checkCompliance = async (data: {
  data: string;
  topic?: string;
  entity_type?: string;
}): Promise<ComplianceResult> => {
  const res = await api.post("/compliance", data);
  return res.data;
};

export const testServices = async () => {
  const res = await api.get("/test");
  return res.data;
};

// ════════════════════════════════════════════════════════════════
// Compliance workflow (bank → period → quant data → qual evidence → run)
// All compliance statuses are computed by the backend. The frontend only
// displays them and never recalculates or overrides a status.
// ════════════════════════════════════════════════════════════════

export interface Bank {
  bank_id: string;
  bank_name: string;
  institution_category: string;
  created_at?: string | null;
}

export interface BankInput {
  bank_id: string;
  bank_name: string;
  institution_category: string;
}

export type MappingStatus = "verified" | "unverified" | string;

export interface ApplicableRule {
  rule_id: number;
  operator: string;
  threshold_value: number | string | null;
  threshold_unit?: string | null;
  variable_text?: string | null;
  clause_text?: string | null;
  page_number?: number | string | null;
  rbi_ref?: string | null;
  form_label?: string | null;
  mapping_status?: MappingStatus | null;
  already_submitted?: boolean;
}

/** An anomaly flag returned by the backend. Shape is not fixed, so both forms are accepted. */
export type SubmissionFlag =
  | string
  | { code?: string; message?: string; severity?: string; detail?: string; [key: string]: unknown };

export interface QuantitativeSubmissionInput {
  rule_id: number;
  reported_value: number;
  period_label: string;
  source_note?: string;
}

export interface QuantitativeSubmissionResult {
  ok: boolean;
  rule_id: number;
  period_label?: string;
  flags?: SubmissionFlag[] | null;
  error?: string | null;
  detail?: string | null;
}

export interface QuantitativeSubmission {
  id?: number;
  submission_id?: number;
  rule_id: number;
  reported_value: number | string | null;
  period_label: string;
  source_note?: string | null;
  flags?: SubmissionFlag[] | null;
  submitted_at?: string | null;
  created_at?: string | null;
}

export const QUAL_SOURCE_TYPES = [
  "policy_manual",
  "board_minutes",
  "audit_note",
  "internal_control_document",
  "other",
] as const;
export type QualSourceType = (typeof QUAL_SOURCE_TYPES)[number] | string;

export interface QualitativeEvidenceInput {
  evidence_text: string;
  source_type: QualSourceType;
  period_label: string;
}

export interface QualitativeEvidence extends QualitativeEvidenceInput {
  id?: number;
  evidence_id?: number;
  created_at?: string | null;
  submitted_at?: string | null;
}

export type QuantStatus = "PASS" | "BREACH" | "NOT_REPORTED";
export type QualStatus = "COVERED" | "PARTIAL" | "LIKELY_GAP" | "NEEDS_REVIEW";

export interface QuantitativeResult {
  rule_id: number;
  status: QuantStatus | string;
  reported_value?: number | string | null;
  operator?: string | null;
  threshold_value?: number | string | null;
  threshold_unit?: string | null;
  clause_text?: string | null;
  variable_text?: string | null;
  form_label?: string | null;
  rbi_ref?: string | null;
  page_number?: number | string | null;
  mapping_status?: MappingStatus | null;
  mapping_warning?: string | null;
  llm_mapping_warning?: string | null;
}

export interface QualitativeResult {
  rule_id?: number | string;
  requirement_id?: number | string;
  status: QualStatus | string;
  requirement_text?: string | null;
  rbi_requirement?: string | null;
  clause_text?: string | null;
  evidence_text?: string | null;
  evidence_excerpt?: string | null;
  justification?: string | null;
  confidence?: number | string | null;
  source_reference?: string | null;
  rbi_ref?: string | null;
  page_number?: number | string | null;
}

export interface ComplianceSummary {
  quant_checked: number;
  quant_pass: number;
  quant_breach: number;
  quant_not_reported: number;
  qual_checked: number;
  qual_covered: number;
  qual_partial: number;
  qual_gap: number;
  mapping_warnings: number;
}

/** The saved report. Its exact shape is backend-defined; known keys are typed, the rest kept. */
export interface ComplianceReport {
  summary?: Partial<ComplianceSummary> & Record<string, unknown>;
  quant_results?: QuantitativeResult[];
  qual_results?: QualitativeResult[];
  [key: string]: unknown;
}

export interface ComplianceRunRequest {
  period_label: string;
  use_llm_mapping_check: boolean;
  submitted_field_labels: Record<string, string>;
  qual_sample_limit: number;
  persist: boolean;
}

export interface ComplianceRunResponse {
  run_id: number | null;
  report: ComplianceReport;
  quant_results: QuantitativeResult[];
  qual_results: QualitativeResult[];
  error?: string;
}

export interface ComplianceRun {
  run_id: number;
  bank_id?: string;
  period_label: string;
  created_at?: string | null;
  run_at?: string | null;
  report?: ComplianceReport | null;
  [key: string]: unknown;
}

export interface ComplianceRunDetail extends ComplianceRun {
  quant_results: QuantitativeResult[];
  qual_results: QualitativeResult[];
}

// ── Response normalisation ──
// The backend may return bare arrays or wrap them ({ banks: [...] }). Accept both.

const toArray = <T>(data: unknown, keys: string[]): T[] => {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    for (const k of [...keys, "data", "items", "results"]) {
      if (Array.isArray(obj[k])) return obj[k] as T[];
    }
  }
  return [];
};

const throwIfBodyError = (data: unknown) => {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const err = (data as { error?: unknown }).error;
    if (typeof err === "string" && err.trim()) throw new Error(err);
  }
};

const enc = encodeURIComponent;

// ── Compliance API calls (share the single Axios instance above) ──

export const getBanks = async (): Promise<Bank[]> => {
  const res = await api.get("/api/banks");
  return toArray<Bank>(res.data, ["banks"]);
};

export const createBank = async (bank: BankInput): Promise<Bank> => {
  const res = await api.post("/api/banks", bank);
  throwIfBodyError(res.data);
  const data = res.data as Partial<Bank> & { bank?: Bank };
  return data?.bank ?? { ...bank, ...(data?.bank_id ? data : {}) };
};

export const getBank = async (bankId: string): Promise<Bank> => {
  const res = await api.get(`/api/banks/${enc(bankId)}`);
  throwIfBodyError(res.data);
  return (res.data?.bank ?? res.data) as Bank;
};

export const getApplicableRules = async (bankId: string, periodLabel: string): Promise<ApplicableRule[]> => {
  const res = await api.get(`/api/banks/${enc(bankId)}/applicable-rules`, {
    params: { period_label: periodLabel },
  });
  throwIfBodyError(res.data);
  return toArray<ApplicableRule>(res.data, ["rules", "applicable_rules"]);
};

export const submitQuantitativeData = async (
  bankId: string,
  submissions: QuantitativeSubmissionInput[],
): Promise<QuantitativeSubmissionResult[]> => {
  const res = await api.post(`/api/banks/${enc(bankId)}/quant-submissions`, submissions);
  const list = toArray<QuantitativeSubmissionResult>(res.data, ["submissions"]);
  if (list.length) return list;
  // Single-object response
  if (res.data && typeof res.data === "object" && "rule_id" in res.data) {
    return [res.data as QuantitativeSubmissionResult];
  }
  throwIfBodyError(res.data);
  return [];
};

export const getQuantitativeSubmissions = async (bankId: string): Promise<QuantitativeSubmission[]> => {
  const res = await api.get(`/api/banks/${enc(bankId)}/quant-submissions`);
  throwIfBodyError(res.data);
  return toArray<QuantitativeSubmission>(res.data, ["submissions"]);
};

export const submitQualitativeEvidence = async (
  bankId: string,
  evidence: QualitativeEvidenceInput,
): Promise<QualitativeEvidence> => {
  const res = await api.post(`/api/banks/${enc(bankId)}/qual-evidence`, evidence);
  throwIfBodyError(res.data);
  return { ...evidence, ...(res.data && typeof res.data === "object" ? res.data : {}) } as QualitativeEvidence;
};

export const getQualitativeEvidence = async (bankId: string): Promise<QualitativeEvidence[]> => {
  const res = await api.get(`/api/banks/${enc(bankId)}/qual-evidence`);
  throwIfBodyError(res.data);
  return toArray<QualitativeEvidence>(res.data, ["evidence"]);
};

export const runComplianceCheck = async (
  bankId: string,
  body: ComplianceRunRequest,
): Promise<ComplianceRunResponse> => {
  // LLM mapping checks can take a while; allow a generous timeout.
  const res = await api.post(`/api/compliance/${enc(bankId)}/run`, body, { timeout: 300_000 });
  throwIfBodyError(res.data);
  const d = (res.data ?? {}) as Partial<ComplianceRunResponse>;
  const report = (d.report ?? {}) as ComplianceReport;
  return {
    run_id: d.run_id ?? null,
    report,
    quant_results: d.quant_results ?? report.quant_results ?? [],
    qual_results: d.qual_results ?? report.qual_results ?? [],
  };
};

export const getComplianceRuns = async (bankId: string): Promise<ComplianceRun[]> => {
  const res = await api.get(`/api/compliance/${enc(bankId)}/runs`);
  throwIfBodyError(res.data);
  return toArray<ComplianceRun>(res.data, ["runs"]);
};

export const getComplianceRun = async (runId: number | string): Promise<ComplianceRunDetail> => {
  const res = await api.get(`/api/compliance/runs/${enc(String(runId))}`);
  throwIfBodyError(res.data);
  const d = (res.data?.run ?? res.data ?? {}) as Partial<ComplianceRunDetail>;
  let report = d.report ?? {};
  if (typeof report === "string") {
    try { report = JSON.parse(report) as ComplianceReport; } catch { report = {}; }
  }
  const r = report as ComplianceReport;
  return {
    ...d,
    run_id: d.run_id ?? Number(runId),
    period_label: d.period_label ?? "",
    report: r,
    quant_results: d.quant_results ?? r.quant_results ?? [],
    qual_results: d.qual_results ?? r.qual_results ?? [],
  } as ComplianceRunDetail;
};

export default api;
