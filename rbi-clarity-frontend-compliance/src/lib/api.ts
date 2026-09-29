import axios from "axios";
import type { NetworkCheck } from "@/lib/network";

/** Backend URL. Override with VITE_API_BASE_URL in .env.local (e.g. http://localhost:4000). */
export const API_BASE_URL: string =
  (import.meta.env?.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") || "http://localhost:4002";

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: { "Content-Type": "application/json" },
});

// ── Chat ──

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  metadata?: ChatResponseData;
  error?: boolean;
  createdAt?: string;
}

export interface RuleAtomSummary {
  rule_id: number;
  operator: string;
  threshold_value: number;
  threshold_unit: string | null;
  threshold_base?: string | null;
  variable_text?: string | null;
  atom_kind?: "requirement" | "condition" | string;
  confidence?: string;
}

export interface CategoryRef {
  id?: string;
  category?: string;
  label: string;
}

/** One retrieved provision the answer is based on. `clause_text` is the full paragraph. */
export interface ChatSource {
  id: number;
  clause_uri: string;
  doc_id: string;
  doc_title: string;
  rbi_ref?: string | null;
  doc_date?: string | null;
  categories?: CategoryRef[];
  paragraph: string;
  heading_path?: string | null;
  page?: number | null;
  page_end?: number | null;
  clause_role?: string | null;
  clause_text: string;
  snippet?: string | null;
  score?: number;
  semantic_score?: number | null;
  why?: string[];
  rule_atoms?: RuleAtomSummary[];
}

export type AnswerMode = "llm" | "extractive" | "not_found" | "smalltalk";

export interface ChatResponseData {
  query: string;
  answer: string;
  answer_mode?: AnswerMode;
  rewritten_query?: string | null;
  sources?: ChatSource[];
  detected_categories?: { id: string; label: string }[];
  relevant_rule_ids: string[];
  source_circulars: string[];
  confidence: "high" | "medium" | "low";
  sources_used: number;
  rules_matched: number;
  fallback_used: boolean;
  fallbacks?: string[];
  model?: string | null;
  rules_detail?: RuleDetail[];
  error?: string | null;
  elapsed_ms?: number;
}

export interface RuleDetail {
  rule_id: string;
  title: string;
  topic: string;
  topic_label?: string;
  subtopic: string;
  is_active: boolean;
  tags: string[];
  plain_language_summary: string;
  source_circular_id: string;
  document_title?: string;
  doc_id?: string;
  effective_date?: string;
  requirements: Requirement[];
  conditions: unknown[];
  exceptions: unknown[];
  penalties: unknown[];
  related_rule_ids: string[];
  section_number?: string;
  clause_uri?: string;
  page?: number | null;
  clause_text?: string;
  atom_kind?: string;
  confidence?: string;
  visualization_meta?: { cluster_color: string; node_label: string; cluster: string };
}

export interface Requirement {
  type: string;
  field: string;
  value: number;
  unit?: string | null;
  currency: string | null;
  description: string;
}

// ── Categories & topics (served by the backend; never hard-coded) ──

export interface CategoryOption {
  id: string;
  label: string;
  document_count?: number;
}

export interface TopicDocument {
  doc_id: string;
  title: string;
  rbi_ref?: string | null;
  topic?: string | null;
  date?: string | null;
  categories: { id: string; label: string }[];
  families: { id: string; label: string }[];
  clause_count: number;
  rule_count: number;
  uploaded?: boolean;
}

export interface TopicData {
  topic_id: string;
  label: string;
  kind?: "institution" | "subject";
  subtopics: string[];
  related_topics: string[];
  rule_count: number;
  active_rule_count?: number;
  document_count?: number;
  clause_count?: number;
  circular_ids: string[];
  documents?: TopicDocument[];
  visualization_meta?: { cluster_color: string };
}

export interface TopicsResponse {
  topics: TopicData[];
  families?: TopicData[];
  total: number;
  documents?: number;
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

// ── Documents / clauses (for verifying a source) ──

export interface ClauseDetail {
  clause_uri: string;
  doc_id: string;
  paragraph_number: string;
  heading_path?: string | null;
  clause_text: string;
  clause_role?: string | null;
  clause_type?: string | null;
  page_number?: number | null;
  page_end?: number | null;
  document: {
    doc_id: string;
    title: string;
    rbi_ref?: string | null;
    doc_date?: string | null;
    last_updated_label?: string | null;
    categories?: { id: string; label: string }[];
    pdf_available?: boolean;
  } | null;
  rule_atoms: (RuleAtomSummary & { sentence?: string | null })[];
  cross_references: {
    ref_type: string;
    target_paragraph?: string | null;
    target_annex?: string | null;
    target_text?: string | null;
    resolved_target_clause_uri?: string | null;
    target_clause_text?: string | null;
    target_doc_title?: string | null;
  }[];
  definitions: { term: string; definition_text: string }[];
  footnotes: { page_number: number; footnote_text: string }[];
  previous: { clause_uri: string; paragraph_number: string; preview: string } | null;
  next: { clause_uri: string; paragraph_number: string; preview: string } | null;
}

export interface DocumentClause {
  clause_uri: string;
  paragraph_number: string;
  heading_path?: string | null;
  clause_text: string;
  clause_role?: string | null;
  page_number?: number | null;
}

export interface ComplianceResult {
  overall_status: "COMPLIANT" | "NON_COMPLIANT" | "INSUFFICIENT_DATA";
  input_parsed: Record<string, unknown>;
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
  status?: "added" | "replaced";
  circular_id: string;
  doc_id?: string;
  title: string;
  rbi_ref?: string | null;
  topic: string;
  institution_category?: string;
  categories?: { id: string; label: string }[];
  clauses?: number;
  rules_extracted: number;
  conditions_extracted?: number;
  definitions?: number;
  chunks_embedded: number;
  word_count?: number;
  note?: string;
  warnings?: string[];
  error?: string;
  duplicate?: boolean;
}

export interface ExistingDocument {
  doc_id: string;
  title?: string | null;
  rbi_ref?: string | null;
  file_path?: string | null;
  last_updated_label?: string | null;
}

/** Error body returned by POST /upload (409 duplicate / possible_update, 400, 422 ...). */
export interface UploadErrorBody {
  success: false;
  error: string;
  code: "duplicate" | "duplicate_in_progress" | "possible_update" | "not_pdf" | "unknown_category" | "no_text" | string;
  duplicate?: boolean;
  existing?: ExistingDocument | ExistingDocument[];
  incoming?: { title: string; rbi_ref: string; last_updated_label?: string };
}

// ── API Calls ──

export const askQuery = async (
  query: string,
  opts: { history?: { role: string; content: string }[]; category?: string | null } = {},
): Promise<ChatResponseData> => {
  const res = await api.post(
    "/ask",
    { query, history: opts.history ?? [], category: opts.category || undefined },
    { timeout: 120_000 },
  );
  return res.data;
};

export const uploadCircular = async (
  file: File,
  category: string = "auto",
  title?: string,
  replace = false,
): Promise<UploadResult> => {
  const form = new FormData();
  form.append("file", file);
  form.append("category", category);
  if (title) form.append("title", title);
  if (replace) form.append("replace", "true");
  const res = await api.post("/upload", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 600_000,
  });
  return res.data;
};

/** SHA-256 of a file in the browser, to detect duplicates before uploading. */
export const sha256OfFile = async (file: File): Promise<string | null> => {
  try {
    if (!globalThis.crypto?.subtle || typeof file.arrayBuffer !== "function") return null;
    const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
};

export const checkDuplicate = async (sha256: string): Promise<{ duplicate: boolean; existing: ExistingDocument | null }> => {
  const res = await api.post("/upload/check", { sha256 });
  return res.data;
};

export const getTopics = async (): Promise<TopicsResponse> => {
  const res = await api.get("/topics");
  return res.data;
};

export const getCategories = async (): Promise<CategoryOption[]> => {
  const res = await api.get("/categories");
  return Array.isArray(res.data?.categories) ? res.data.categories : [];
};

export const getRules = async (params: {
  topic?: string;
  subtopic?: string;
  tag?: string;
  search?: string;
  page?: number;
  per_page?: number;
  kind?: string;
}): Promise<RulesResponse> => {
  const res = await api.get("/rules", { params });
  return res.data;
};

export const getClause = async (clauseUri: string): Promise<ClauseDetail> => {
  const res = await api.get(`/api/documents/clauses/by-uri/${encodeURIComponent(clauseUri)}`);
  return res.data;
};

export interface ClauseSimplification {
  clause_uri: string;
  original: string;
  simplified: string;
  method: string;
  fkgl_original: number | null;
  fkgl_simplified: number | null;
  meaning_check: { ok: boolean; problems: string[] };
}

/** Plain-language restatement of a clause (kept only where numbers, polarity and exceptions survive). */
export const simplifyClause = async (clauseUri: string): Promise<ClauseSimplification> => {
  const res = await api.get(`/api/documents/clauses/simplify/by-uri/${encodeURIComponent(clauseUri)}`);
  return res.data;
};

export const getDocumentClauses = async (docId: string): Promise<DocumentClause[]> => {
  const res = await api.get(`/api/documents/${encodeURIComponent(docId)}/clauses`, { params: { limit: 2000 } });
  return Array.isArray(res.data) ? res.data : [];
};

/** URL of the original PDF, opened at a page. */
export const pdfUrl = (docId: string, page?: number | null) =>
  `${API_BASE_URL}/api/documents/${encodeURIComponent(docId)}/pdf${page ? `#page=${page}` : ""}`;

export const checkCompliance = async (data: {
  data: string;
  topic?: string;
  entity_type?: string;
}): Promise<ComplianceResult> => {
  const res = await api.post("/compliance", data);
  return res.data;
};

export const testServices = async () => {
  const res = await api.get("/api/health");
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
  /** Evaluated by the counterparty-network check (concentration / related-party rule). */
  computed_by_network?: boolean;
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
  /** Counterparty-network check (graph subsystem); null when no exposures were entered for the period. */
  graph_results?: NetworkCheck | null;
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
  graph_results?: NetworkCheck | null;
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
    graph_results: d.graph_results ?? null,
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
