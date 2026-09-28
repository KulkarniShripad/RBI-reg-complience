import api, { API_BASE_URL } from "@/lib/api";
import type { NetworkCheck } from "@/lib/network";

// ── Automatic compliance check from a bank's published document ──

export interface SourceRef {
  verified: boolean;
  reason?: string;
  clause_uri?: string;
  doc_id?: string;
  doc_title?: string;
  rbi_ref?: string | null;
  paragraph?: string;
  page_number?: number | null;
  excerpt?: string;
}

export interface Figure {
  metric_key: string;
  label?: string;
  value: number;
  unit: string;
  basis: string | null;
  page: number | null;
  snippet: string | null;
  method: "table" | "text" | "structured" | "llm" | "manual" | string;
  confidence: "high" | "medium" | "low" | string;
  alternatives: { value: number; page: number | null; snippet: string | null; basis: string | null }[];
  why?: string[];
  unit_note?: string | null;
}

export interface DetectedProfile {
  bank_name: string | null;
  bank_id: string | null;
  registered: boolean;
  institution_category: string | null;
  institution_label: string | null;
  as_of_date: string | null;
  period_label: string | null;
  doc_type: string;
  doc_type_label: string;
  is_dsib: boolean;
  ucb_tier?: number | null;
  detected_by: string;
  evidence: Record<string, unknown>;
  notes?: string[];
  llm_used?: { profile: boolean; metrics: string[] };
}

export interface UploadAnalysis {
  upload_id: number;
  file_name: string;
  format: string;
  page_count: number;
  status: string;
  created_at: string;
  has_file: boolean;
  duplicate?: boolean;
  profile: DetectedProfile;
  metrics: Record<string, Figure>;
  expected_metrics: { key: string; label: string; unit: string | null; found: boolean; checked_by_rule: boolean }[];
  catalog: { key: string; label: string; unit: string }[];
}

export interface RuleResult {
  id: string;
  rule_key: string;
  metric_key: string;
  metric_label: string;
  label: string;
  level: "minimum" | "buffer" | "target" | string;
  operator: string;
  threshold: number | null;
  reported_value: number | null;
  unit: string;
  status: string;
  origin: "anchored" | "discovered";
  note?: string | null;
  rule_note?: string | null;
  source: SourceRef;
  figure?: { page: number | null; snippet: string | null; method: string; confidence: string; basis?: string | null };
}

export interface DisclosureItem {
  key: string;
  label: string;
  status: "PRESENT" | "LIKELY_MISSING" | string;
  found: { page: number; snippet: string } | null;
  source: SourceRef;
}

export interface ObligationResult {
  clause_uri: string;
  clause_text: string;
  paragraph: string;
  page_number: number | null;
  doc_title: string;
  rbi_ref: string | null;
  evidence_text: string;
  evidence_page: number;
  similarity_score: number;
  status: string;
  justification?: string | null;
}

export interface AutoSummary {
  rules_applicable: number;
  rules_evaluated: number;
  pass: number;
  breach: number;
  buffer_shortfall: number;
  target_shortfall: number;
  not_disclosed: number;
  needs_review: number;
  candidate_rules?: number;
  discovered_rules: number;
  disclosures_checked: number;
  disclosures_present: number;
  disclosures_missing: number;
  obligations_matched: number;
  obligations_covered: number;
  obligations_partial: number;
  figures_found: number;
  submissions_backfilled: number;
}

export interface AutoReport {
  mode: "auto";
  run_id?: number;
  generated_at: string;
  overall: "BREACH" | "ATTENTION" | "PASS" | "INSUFFICIENT_DATA" | string;
  bank: { bank_id: string; bank_name: string; institution_category: string; institution_label: string; created: boolean };
  period_label: string;
  as_of_date: string | null;
  document: { upload_id: number; file_name: string; format: string; page_count: number; doc_type: string; doc_type_label: string };
  profile: { is_dsib: boolean; ucb_tier: number | null; detected_by: string };
  summary: AutoSummary;
  figures: Figure[];
  rule_results: RuleResult[];
  disclosures: { applicable: boolean; set?: string; reason?: string | null; items: DisclosureItem[] };
  qualitative: { applicable: boolean; reason?: string | null; results: ObligationResult[] };
  /** counterparty network check, when the bank's network is entered for the period */
  network?: (Pick<NetworkCheck, "results" | "groups" | "summary" | "notes"> & { has_data?: boolean; message?: string | null }) | null;
  executive_summary: string;
  executive_summary_by: "llm" | "template";
  method: { llm_configured: boolean; llm_requested: boolean; deterministic: string[]; llm: string[] };
  notes: string[];
}

export interface SampleDoc {
  file: string;
  title: string;
  bank: string;
  category: string;
  doc_type: string;
  period: string;
  kind: "public" | "test";
  source_url?: string;
  expect?: Record<string, string>;
  size: number;
}

export interface UploadListItem {
  upload_id: number;
  bank_id: string | null;
  bank_name: string | null;
  file_name: string;
  format: string;
  page_count: number;
  doc_type: string;
  period_label: string | null;
  status: string;
  created_at: string;
}

export const DOC_TYPES: { id: string; label: string }[] = [
  { id: "pillar3", label: "Basel III Pillar 3 disclosure" },
  { id: "annual_report", label: "Annual report / financial statements" },
  { id: "financial_results", label: "Quarterly / annual financial results" },
  { id: "figures", label: "Figures (spreadsheet / structured data)" },
  { id: "board_minutes", label: "Board / committee minutes" },
  { id: "policy", label: "Policy document" },
  { id: "other", label: "Other bank document" },
];

export const ACCEPTED_FILES = ".pdf,.xlsx,.xlsm,.csv,.tsv,.txt,.md,.html,.htm,.json";

const enc = encodeURIComponent;

export const getSamples = async (): Promise<SampleDoc[]> => (await api.get("/api/disclosures/samples")).data;

export const getUploads = async (): Promise<UploadListItem[]> => (await api.get("/api/disclosures")).data;

export const analyseFile = async (file: File, useLlm: boolean, force = false): Promise<UploadAnalysis> => {
  const form = new FormData();
  form.append("file", file);
  form.append("use_llm", String(useLlm));
  form.append("force", String(force));
  const res = await api.post("/api/disclosures/analyze", form, {
    headers: { "Content-Type": "multipart/form-data" },
    timeout: 300_000,
  });
  return res.data;
};

export const analyseSample = async (file: string, useLlm: boolean, force = false): Promise<UploadAnalysis> =>
  (await api.post("/api/disclosures/samples/analyze", { file, use_llm: useLlm, force }, { timeout: 300_000 })).data;

export const getUpload = async (id: number): Promise<UploadAnalysis> => (await api.get(`/api/disclosures/${id}`)).data;

export const updateUpload = async (
  id: number,
  patch: { profile?: Partial<Pick<DetectedProfile, "bank_name" | "bank_id" | "institution_category" | "as_of_date" | "period_label" | "doc_type" | "is_dsib" | "ucb_tier">>; metrics?: Record<string, number | null> },
): Promise<UploadAnalysis> => (await api.patch(`/api/disclosures/${id}`, patch)).data;

export const runAutoCheck = async (
  id: number,
  opts: { use_llm: boolean; include_qualitative: boolean; persist?: boolean },
): Promise<{ run_id: number | null; report: AutoReport }> =>
  (await api.post(`/api/disclosures/${id}/run`, { persist: true, ...opts }, { timeout: 600_000 })).data;

export const reportHtmlUrl = (runId: number, download = false) =>
  `${API_BASE_URL}/api/disclosures/runs/${enc(String(runId))}/report.html${download ? "?download=1" : ""}`;

export const uploadFileUrl = (uploadId: number, page?: number | null, format?: string) =>
  `${API_BASE_URL}/api/disclosures/${enc(String(uploadId))}/file${page && format === "pdf" ? `#page=${page}` : ""}`;

export const formatFigure = (v: number | null | undefined, unit?: string | null) => {
  if (v === null || v === undefined) return "—";
  const n = Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 });
  return unit === "%" ? `${n}%` : unit ? `${n} ${unit}` : n;
};

export const operatorText = (op: string) => ({ ">=": "≥", "<=": "≤", ">": ">", "<": "<" })[op] ?? op;

/** RBI reporting quarter of an ISO date (Apr–Jun = Q1 of the FY starting in April). */
export const periodOfDate = (iso: string): string | null => {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  if (!m) return null;
  const y = Number(m[1]);
  const mon = Number(m[2]);
  const fy = mon >= 4 ? y : y - 1;
  const q = mon >= 4 ? Math.floor((mon - 4) / 3) + 1 : 4;
  return `Q${q}-FY${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
};
