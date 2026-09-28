import axios from "axios";
import { API_BASE_URL } from "@/lib/api";

/**
 * Client for the Network Topology Mapper (graph subsystem): a bank's
 * counterparties, the relationships between them, its exposures and the
 * network check against RBI's concentration-risk and related-party rules.
 * All amounts are ₹ crore.
 */
const api = axios.create({ baseURL: API_BASE_URL, headers: { "Content-Type": "application/json" } });

export const SELF = "SELF";

export interface NetworkEntity {
  entity_id: string;
  name: string;
  entity_type: string;
  ite_class?: string | null;
  group_relation?: string | null;
  attributes?: Record<string, unknown>;
}

export interface NetworkEdge {
  edge_id?: number;
  from_entity: string;
  to_entity: string;
  edge_type: string;
  ownership_pct?: number | null;
  basis?: string | null;
  criterion?: number | null;
  role?: string | null;
  relation?: string | null;
  bidirectional?: number | boolean | null;
  status?: "confirmed" | "flagged" | "rebutted";
  evidence?: string | null;
  review_note?: string | null;
  reviewed_at?: string | null;
}

export interface NetworkExposure {
  exposure_id?: number;
  entity_id: string;
  exposure_kind?: string;
  amount: number;
  sanctioned_limit?: number | null;
  crm_amount?: number | null;
  crm_provider?: string | null;
  infrastructure?: number | boolean;
  exempt_reason?: string | null;
  board_approved_excess?: number | boolean;
  section20_exception?: string | null;
  note?: string | null;
}

export interface NetworkCapital {
  tier1_capital?: number | null;
  tier2_capital?: number | null;
  owned_funds?: number | null;
  paid_up_capital_reserves?: number | null;
}

export interface NetworkProfile {
  nbfc_layer?: string | null;
  nbfc_is_ifc?: number | boolean | null;
  rcb_rating?: string | null;
}

export interface NetworkData {
  bank: { bank_id: string; bank_name: string; institution_category: string };
  entities: NetworkEntity[];
  edges: NetworkEdge[];
  exposures: NetworkExposure[];
  capital: NetworkCapital | null;
  profile: NetworkProfile | null;
  periods: { period_label: string; exposures: number }[];
}

export interface Vocabulary {
  entity_types: string[];
  ite_classes: string[];
  group_relations: string[];
  edge_types: string[];
  control_bases: string[];
  roles: string[];
  relations: string[];
  edge_statuses: string[];
  exposure_kinds: string[];
  exempt_reasons: string[];
}

export interface RuleSource {
  verified: boolean;
  clause_uri?: string;
  doc_id?: string;
  doc_title?: string;
  rbi_ref?: string;
  paragraph?: string;
  page_number?: number;
  excerpt?: string;
  reason?: string;
}

export interface NetworkRule {
  key: string;
  category: string;
  kind: string;
  label: string;
  base_label?: string | null;
  limit?: number;
  source: RuleSource;
}

export interface GroupMember {
  id: string;
  name: string;
  entity_type?: string;
  exposure?: number;
  reason?: string;
  excluded?: string | null;
}

export interface NetworkResult {
  id: string;
  rule_key: string;
  rule_label: string;
  kind: string;
  status: string;
  provisional?: boolean;
  clause_uri: string | null;
  source: RuleSource;
  extra_sources?: RuleSource[];
  subject: {
    type: "counterparty" | "group" | "aggregate" | "bank";
    id: string;
    name: string;
    entity_type?: string;
    members?: GroupMember[];
    basis?: string[];
    group_relation?: string;
    ite_class?: string;
  };
  exposure?: number;
  base_amount?: number | null;
  base_label?: string | null;
  exposure_pct?: number | null;
  limit_pct?: number | null;
  allowed_pct?: number | null;
  headroom?: number | null;
  path?: string[];
  links?: { label: string; status: string; edge_type: string }[];
  reasons: string[];
}

export interface NetworkGroup {
  group_id: string;
  name: string;
  basis: string[];
  provisional: boolean;
  members: GroupMember[];
  links: { label: string; status: string; edge_type: string }[];
}

export interface GraphNode {
  id: string;
  name: string;
  entity_type: string;
  exposure: number;
  exempt: number;
  exposure_pct: number | null;
  status: string | null;
  group_ids: string[];
  bank_group: string | null;
}

export interface GraphLink {
  id: string | number;
  source: string;
  target: string;
  edge_type: string;
  status: string;
  label: string;
}

export interface NetworkCheck {
  bank_id: string;
  period_label: string;
  institution_category: string;
  has_data: boolean;
  applicable: boolean;
  message?: string;
  graph_run_id?: number | null;
  capital: NetworkCapital | null;
  profile: NetworkProfile | null;
  rules: { key: string; kind: string; label: string; base_label: string | null; verified: boolean; clause_uri: string | null; reason: string | null }[];
  summary: {
    counterparties: number;
    groups: number;
    provisional_groups: number;
    bank_group_entities: number;
    total_exposure: number;
    status_counts: Record<string, number>;
    overall: string | null;
    largest_exposures: { id: string; name: string; exposure: number; exposure_pct: number | null }[];
  } | null;
  results: NetworkResult[];
  groups: NetworkGroup[];
  bank_group?: { id: string; name: string; relation: string; via: string[]; ite_class: string }[];
  graph: { nodes: GraphNode[]; edges: GraphLink[] };
  notes: string[];
}

export interface Scenario {
  id: string;
  title: string;
  category: string;
  description: string;
}

export interface ValidationDetail {
  table?: string;
  row?: number;
  field?: string;
  message: string;
}

const enc = encodeURIComponent;

export const getVocabulary = async (): Promise<Vocabulary> => (await api.get("/api/graph/vocabulary")).data;

export const getNetworkRules = async (category?: string): Promise<NetworkRule[]> =>
  (await api.get("/api/graph/rules", { params: category ? { category } : {} })).data.rules ?? [];

export const getScenarios = async (): Promise<{ note: string; scenarios: Scenario[] }> => (await api.get("/api/graph/scenarios")).data;

export const loadScenario = async (scenarioId: string, body: { period_label: string; bank_id?: string; force?: boolean }) =>
  (await api.post(`/api/graph/scenarios/${enc(scenarioId)}/load`, body)).data as {
    bank_id: string;
    bank: { bank_id: string; bank_name: string; institution_category: string };
    imported: { entities: number; edges: number; exposures: number };
  };

export const getNetwork = async (bankId: string, period: string): Promise<NetworkData> =>
  (await api.get(`/api/graph/${enc(bankId)}`, { params: { period_label: period } })).data;

export const saveEntities = async (bankId: string, entities: NetworkEntity[]) =>
  (await api.post(`/api/graph/${enc(bankId)}/entities`, { entities })).data;

export const deleteEntity = async (bankId: string, entityId: string) =>
  (await api.delete(`/api/graph/${enc(bankId)}/entities/${enc(entityId)}`)).data;

export const saveEdges = async (bankId: string, edges: NetworkEdge[]) =>
  (await api.post(`/api/graph/${enc(bankId)}/edges`, { edges })).data;

export const reviewEdge = async (bankId: string, edgeId: number, status: string, review_note?: string) =>
  (await api.patch(`/api/graph/${enc(bankId)}/edges/${edgeId}`, { status, review_note })).data as NetworkEdge;

export const deleteEdge = async (bankId: string, edgeId: number) =>
  (await api.delete(`/api/graph/${enc(bankId)}/edges/${edgeId}`)).data;

export const saveExposures = async (bankId: string, period: string, exposures: NetworkExposure[]) =>
  (await api.post(`/api/graph/${enc(bankId)}/exposures`, { period_label: period, exposures })).data;

export const deleteExposure = async (bankId: string, exposureId: number) =>
  (await api.delete(`/api/graph/${enc(bankId)}/exposures/${exposureId}`)).data;

export const saveCapital = async (bankId: string, period: string, capital: NetworkCapital) =>
  (await api.put(`/api/graph/${enc(bankId)}/capital`, { period_label: period, ...capital })).data as NetworkCapital;

export const saveProfile = async (bankId: string, profile: NetworkProfile) =>
  (await api.put(`/api/graph/${enc(bankId)}/profile`, profile)).data as NetworkProfile;

export const importNetwork = async (
  bankId: string,
  period: string,
  bundle: { entities?: unknown[]; edges?: unknown[]; exposures?: unknown[]; capital?: unknown; profile?: unknown },
  replace: boolean,
) => (await api.post(`/api/graph/${enc(bankId)}/import`, { period_label: period, replace, ...bundle })).data;

export const exportNetwork = async (bankId: string, period: string) =>
  (await api.get(`/api/graph/${enc(bankId)}/export`, { params: { period_label: period } })).data;

export const runNetworkCheck = async (bankId: string, period: string, opts: { include_flagged?: boolean; persist?: boolean } = {}): Promise<NetworkCheck> =>
  (await api.post(`/api/graph/${enc(bankId)}/check`, { period_label: period, ...opts })).data;

/** Row-level validation problems from a 400 response, if any. */
export const validationDetails = (err: unknown): ValidationDetail[] => {
  const data = axios.isAxiosError(err) ? (err.response?.data as { details?: ValidationDetail[] } | undefined) : undefined;
  return Array.isArray(data?.details) ? data.details : [];
};

// ── labels ─────────────────────────────────────────────────────────────────

export const human = (s: string | null | undefined) => (s ?? "").replace(/_/g, " ").replace(/\b\w/, (c) => c.toUpperCase());

export const EDGE_LABELS: Record<string, string> = {
  OWNS: "Owns (shareholding %)",
  CONTROLS: "Controls",
  COMMON_MANAGEMENT: "Common owners / management",
  ECONOMIC_DEPENDENCE: "Economically dependent on",
  DIRECTOR_OF: "Director of",
  INTERESTED_IN: "Interested in (partner, guarantor, …)",
  RELATIVE_OF: "Relative of",
  PROMOTER_OF: "Promoter of",
};

export const ECON_CRITERIA: Record<number, string> = {
  1: "≥ 50% of gross receipts / expenditure from the other",
  2: "Guarantee large enough to cause the guarantor's default",
  3: "Major part of output sold to the other, not replaceable",
  4: "Same source of repayment, no independent income",
  5: "Problems of one likely to cause repayment difficulty for the other",
  6: "Insolvency / default of one likely linked to the other",
  7: "Same main funding source, no alternative provider",
};

export const CAPITAL_FIELDS: { key: keyof NetworkCapital; label: string; hint: string }[] = [
  { key: "tier1_capital", label: "Tier 1 capital", hint: "Eligible capital base (commercial banks, NBFCs, AIFIs, UCBs)" },
  { key: "tier2_capital", label: "Tier 2 capital", hint: "Capital funds = Tier 1 + Tier 2 (SFBs, LABs, gold-loan NBFC limit)" },
  { key: "owned_funds", label: "Owned funds", hint: "Regional rural banks" },
  { key: "paid_up_capital_reserves", label: "Paid-up capital + reserves", hint: "SFB intra-group limits; rural co-operative banks' capital fund" },
];

/** Which capital figures matter for a category (the rest stay optional). */
export const capitalFieldsFor = (category: string): (keyof NetworkCapital)[] => {
  switch (category) {
    case "commercial_banks":
      return ["tier1_capital", "tier2_capital"];
    case "small_finance_banks":
      return ["tier1_capital", "tier2_capital", "paid_up_capital_reserves"];
    case "local_area_banks":
      return ["tier1_capital", "tier2_capital"];
    case "regional_rural_banks":
      return ["owned_funds"];
    case "rural_cooperative_banks":
      return ["paid_up_capital_reserves"];
    default:
      return ["tier1_capital"];
  }
};
