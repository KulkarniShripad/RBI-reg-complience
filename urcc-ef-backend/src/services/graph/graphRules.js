/**
 * The RBI rules the network check evaluates, per institution category.
 *
 * Every rule carries a locator for the paragraph it comes from (document
 * title, paragraph number, and a regex the paragraph text must match -
 * including the number itself). At run time the locator is resolved against
 * the extracted corpus (clause_registry):
 *   - found and the text still says what the rule encodes -> verified; the
 *     result links to the clause (clause_uri, page, text) like every other
 *     compliance result;
 *   - not found, or the text no longer matches (e.g. a newer version of the
 *     direction changed the limit) -> the rule is NOT applied and its results
 *     come back as NEEDS_REVIEW, rather than checking against a stale number.
 *
 * The limits were read from the Master Directions in ../circulars (Nov 2025
 * Concentration Risk Management and Credit Risk Management directions of
 * each category).
 */
// Loaded lazily so the pure evaluator can be used (and tested) without a database.
const getDb = () => require("../../config/db");

const T = (s) => new RegExp(s.replace(/ - /g, "\\s*[-–]\\s*"), "i");
const CRM = (cat) => T(`\\(${cat} - Concentration Risk Management\\)`);
const CREDIT = (cat) => T(`\\(${cat} [-–]? ?Credit Risk Management\\)`);

// base: which capital figure the limit is a percentage of
const BASES = {
  tier1: "Tier 1 capital (eligible capital base)",
  capital_funds: "capital funds (Tier 1 + Tier 2)",
  owned_funds: "owned funds",
  paid_up_capital_reserves: "paid-up capital and reserves",
  capital_fund_rcb: "capital fund (paid-up capital + free reserves)",
};

const RULES = [
  // ── Commercial banks: Large Exposures Framework ──────────────────────────
  {
    key: "cb_single", category: "commercial_banks", kind: "single_limit", counterparty: "default",
    label: "Single counterparty: 20% of eligible capital base (Board may allow +5%)",
    base: "tier1", limit: 20, board_extension: 5, cap: 25,
    source: { title: CRM("Commercial Banks"), para: "15", text: /single counterparty shall not be higher than 20 ?per ?cent/i },
  },
  {
    key: "cb_interbank", category: "commercial_banks", kind: "single_limit", counterparty: "bank",
    label: "Interbank exposure: 25% of Tier 1 capital",
    base: "tier1", limit: 25,
    source: { title: CRM("Commercial Banks"), para: "62", text: /interbank exposures.*25 ?per ?cent of a bank.s Tier 1/i },
  },
  {
    key: "cb_nbfc_single", category: "commercial_banks", kind: "single_limit", counterparty: "nbfc",
    label: "Exposure to a single NBFC: 20% of eligible capital base",
    base: "tier1", limit: 20, board_extension: 5, cap: 25,
    source: { title: CRM("Commercial Banks"), para: "79", text: /single NBFC will be restricted to 20 ?per ?cent/i },
  },
  {
    key: "cb_gold_nbfc", category: "commercial_banks", kind: "single_limit", counterparty: "gold_nbfc",
    label: "Gold-loan NBFC: 7.5% of capital funds (12.5% if the excess is on-lent to infrastructure)",
    base: "capital_funds", limit: 7.5, infra_extension: 5, cap: 12.5,
    source: { title: CRM("Commercial Banks"), para: "80", text: /shall not exceed 7\.5 ?per ?cent of the bank.s capital funds/i },
  },
  {
    key: "cb_group", category: "commercial_banks", kind: "group_limit", counterparty: "default",
    label: "Group of connected counterparties: 25% of eligible capital base",
    base: "tier1", limit: 25,
    source: { title: CRM("Commercial Banks"), para: "16", text: /group of connected counterparties.*shall not be higher than 25 ?per ?cent/i },
  },
  {
    key: "cb_connected_nbfc", category: "commercial_banks", kind: "group_limit", counterparty: "nbfc",
    label: "Group of connected NBFCs / group with NBFCs: 25% of Tier 1 capital",
    base: "tier1", limit: 25,
    source: { title: CRM("Commercial Banks"), para: "81", text: /group of connected NBFCs.*25 ?per ?cent of its Tier I/i },
  },
  {
    key: "cb_large_exposure", category: "commercial_banks", kind: "le_reporting",
    label: "Large exposure (>= 10% of eligible capital base) must be reported to RBI (DOS, CO)",
    base: "tier1", threshold: 10,
    source: { title: CRM("Commercial Banks"), para: "14", text: /equal to or above 10 ?per ?cent of the bank.s eligible capital/i },
  },
  {
    key: "cb_econ_assessment", category: "commercial_banks", kind: "econ_assessment",
    label: "Economic interdependence must be assessed where exposure exceeds 5% of eligible capital base",
    base: "tier1", threshold: 5,
    source: { title: CRM("Commercial Banks"), para: "28", text: /exceeds five ?per ?cent of the eligible capital base/i },
  },
  {
    key: "cb_control_definition", category: "commercial_banks", kind: "definition",
    label: "Control is automatic above 50% of voting rights; groups by control and by economic interdependence",
    source: { title: CRM("Commercial Banks"), para: "21", text: /owns more than 50 ?per ?cent of the voting rights/i },
  },
  // Intra-group exposures (bank's own group) - Chapter VI
  {
    key: "cb_ite_single_nonfin", category: "commercial_banks", kind: "ite_single", ite_classes: ["non_financial", "unregulated_financial"],
    label: "Single group entity (non-financial / unregulated financial): 5% of eligible capital base",
    base: "tier1", limit: 5,
    source: { title: CRM("Commercial Banks"), para: "116", text: /five ?per ?cent of eligible capital base in case of non-financial/i },
  },
  {
    key: "cb_ite_single_fin", category: "commercial_banks", kind: "ite_single", ite_classes: ["regulated_financial"],
    label: "Single group entity (regulated financial): 10% of eligible capital base",
    base: "tier1", limit: 10,
    source: { title: CRM("Commercial Banks"), para: "116", text: /10 ?per ?cent of eligible capital base in case of regulated financial/i },
  },
  {
    key: "cb_ite_agg_nonfin", category: "commercial_banks", kind: "ite_aggregate", ite_classes: ["non_financial", "unregulated_financial"],
    label: "All non-financial and unregulated financial group entities together: 10% of eligible capital base",
    base: "tier1", limit: 10,
    source: { title: CRM("Commercial Banks"), para: "116", text: /10 ?per ?cent of eligible capital base in case of all non-financial/i },
  },
  {
    key: "cb_ite_agg_all", category: "commercial_banks", kind: "ite_aggregate", ite_classes: null,
    label: "All group entities together: 20% of eligible capital base",
    base: "tier1", limit: 20,
    source: { title: CRM("Commercial Banks"), para: "116", text: /20 ?per ?cent of eligible capital base in case of the group/i },
  },
  // Related parties
  {
    key: "cb_section20", category: "commercial_banks", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in (Section 20, BR Act)",
    source: { title: CREDIT("Commercial Banks"), para: "14", text: /Section 20\(1\)\(b\)/i },
  },
  {
    key: "cb_director_relatives", category: "commercial_banks", kind: "related_party", variant: "relatives",
    label: "Section 20 also covers spouse and minor / dependent children of directors",
    source: { title: CREDIT("Commercial Banks"), para: "42G", text: /spouse and minor \/ dependent children of the directors/i },
  },
  {
    key: "cb_promoters", category: "commercial_banks", kind: "related_party", variant: "promoters",
    label: "No exposure to promoters, their relatives, 10%+ shareholders, or entities they control / significantly influence",
    source: { title: CREDIT("Commercial Banks"), para: "42H", text: /shareholding of 10 ?per ?cent or more/i },
  },

  // ── Small finance banks ──────────────────────────────────────────────────
  {
    key: "sfb_single", category: "small_finance_banks", kind: "single_limit", counterparty: "default",
    label: "Single obligor: 10% of capital funds", base: "capital_funds", limit: 10,
    source: { title: CRM("Small Finance Banks"), para: "10", text: /single and group obligor shall not be higher than 10 per ?cent and 15 per ?cent/i },
  },
  {
    key: "sfb_group", category: "small_finance_banks", kind: "group_limit", counterparty: "default",
    label: "Group obligor: 15% of capital funds", base: "capital_funds", limit: 15,
    source: { title: CRM("Small Finance Banks"), para: "10", text: /single and group obligor shall not be higher than 10 per ?cent and 15 per ?cent/i },
  },
  {
    key: "sfb_nbfc_single", category: "small_finance_banks", kind: "single_limit", counterparty: "nbfc",
    label: "Single NBFC: 10% of capital funds", base: "capital_funds", limit: 10,
    source: { title: CRM("Small Finance Banks"), para: "14", text: /single NBFC and group NBFC obligor shall not be higher than 10 per ?cent and 15 per ?cent/i },
  },
  {
    key: "sfb_nbfc_group", category: "small_finance_banks", kind: "group_limit", counterparty: "nbfc",
    label: "Group NBFC obligor: 15% of capital funds", base: "capital_funds", limit: 15,
    source: { title: CRM("Small Finance Banks"), para: "14", text: /single NBFC and group NBFC obligor shall not be higher than 10 per ?cent and 15 per ?cent/i },
  },
  {
    key: "sfb_ite_single_nonfin", category: "small_finance_banks", kind: "ite_single", ite_classes: ["non_financial", "unregulated_financial"],
    label: "Single group entity (non-financial / unregulated financial): 5% of paid-up capital and reserves",
    base: "paid_up_capital_reserves", limit: 5,
    source: { title: CRM("Small Finance Banks"), para: "48", text: /five per ?cent of Paid-up Capital and Reserves in case of non-financial/i },
  },
  {
    key: "sfb_ite_single_fin", category: "small_finance_banks", kind: "ite_single", ite_classes: ["regulated_financial"],
    label: "Single group entity (regulated financial): 10% of paid-up capital and reserves",
    base: "paid_up_capital_reserves", limit: 10,
    source: { title: CRM("Small Finance Banks"), para: "48", text: /10 per ?cent of Paid-up Capital and Reserves in case of regulated/i },
  },
  {
    key: "sfb_ite_agg_nonfin", category: "small_finance_banks", kind: "ite_aggregate", ite_classes: ["non_financial", "unregulated_financial"],
    label: "Non-financial and unregulated group entities together: 10% of paid-up capital and reserves",
    base: "paid_up_capital_reserves", limit: 10,
    source: { title: CRM("Small Finance Banks"), para: "48", text: /10 per ?cent of Paid-up Capital and Reserves in case of all non-financial/i },
  },
  {
    key: "sfb_ite_agg_all", category: "small_finance_banks", kind: "ite_aggregate", ite_classes: null,
    label: "All group entities together: 20% of paid-up capital and reserves",
    base: "paid_up_capital_reserves", limit: 20,
    source: { title: CRM("Small Finance Banks"), para: "48", text: /20 per ?cent of Paid-up Capital and Reserves in case of the group/i },
  },
  {
    key: "sfb_section20", category: "small_finance_banks", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in (Section 20, BR Act)",
    source: { title: CREDIT("Small Finance Banks"), para: "14", text: /Section 20\(1\)\(b\)/i },
  },
  {
    key: "sfb_promoters", category: "small_finance_banks", kind: "related_party", variant: "promoters",
    label: "No exposure to promoters, their relatives, 10%+ shareholders, or entities they control / significantly influence",
    source: { title: CREDIT("Small Finance Banks"), para: "42H", text: /shareholding of 10 ?per ?cent or more/i },
  },

  // ── Local area banks ─────────────────────────────────────────────────────
  {
    key: "lab_single", category: "local_area_banks", kind: "single_limit", counterparty: "default",
    label: "Single borrower: 15% of capital funds", base: "capital_funds", limit: 15,
    source: { title: CRM("Local Area Banks"), para: "7", text: /single and group borrower shall not be higher than 15 ?percent and 40 ?percent/i },
  },
  {
    key: "lab_group", category: "local_area_banks", kind: "group_limit", counterparty: "default",
    label: "Group borrower: 40% of capital funds", base: "capital_funds", limit: 40,
    source: { title: CRM("Local Area Banks"), para: "7", text: /single and group borrower shall not be higher than 15 ?percent and 40 ?percent/i },
  },
  {
    key: "lab_nbfc_single", category: "local_area_banks", kind: "single_limit", counterparty: "nbfc",
    label: "Single NBFC: 10% of capital funds", base: "capital_funds", limit: 10,
    source: { title: CRM("Local Area Banks"), para: "10", text: /single NBFC and group NBFC borrower shall not be higher than 10 ?percent and 15 ?percent/i },
  },
  {
    key: "lab_nbfc_group", category: "local_area_banks", kind: "group_limit", counterparty: "nbfc",
    label: "Group NBFC borrower: 15% of capital funds", base: "capital_funds", limit: 15,
    source: { title: CRM("Local Area Banks"), para: "10", text: /single NBFC and group NBFC borrower shall not be higher than 10 ?percent and 15 ?percent/i },
  },
  {
    key: "lab_section20", category: "local_area_banks", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in (Section 20, BR Act)",
    source: { title: CREDIT("Local Area Banks"), para: "7", text: /Section 20\(1\)\(b\)/i },
  },
  {
    key: "lab_promoters", category: "local_area_banks", kind: "related_party", variant: "promoters",
    label: "No exposure to promoters, their relatives, 10%+ shareholders, or entities they control / significantly influence",
    source: { title: CREDIT("Local Area Banks"), para: "16H", text: /shareholding of 10 ?per ?cent or more/i },
  },

  // ── Regional rural banks ─────────────────────────────────────────────────
  {
    key: "rrb_single", category: "regional_rural_banks", kind: "single_limit", counterparty: "default",
    label: "Single borrower / party: 15% of owned funds", base: "owned_funds", limit: 15,
    source: { title: CRM("Regional Rural Banks"), para: "7", text: /not be higher than 15 per ?cent and 40 per ?cent of its owned funds/i },
  },
  {
    key: "rrb_group", category: "regional_rural_banks", kind: "group_limit", counterparty: "default",
    label: "Group borrower / party: 40% of owned funds", base: "owned_funds", limit: 40,
    source: { title: CRM("Regional Rural Banks"), para: "7", text: /not be higher than 15 per ?cent and 40 per ?cent of its owned funds/i },
  },
  {
    key: "rrb_section20", category: "regional_rural_banks", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in (Section 20, BR Act)",
    source: { title: CREDIT("Regional Rural Banks"), para: "7", text: /Section 20\(1\)\(b\)/i },
  },

  // ── Urban co-operative banks ─────────────────────────────────────────────
  {
    key: "ucb_single", category: "urban_cooperative_banks", kind: "single_limit", counterparty: "default",
    label: "Individual borrower: 15% of Tier-I capital (sanctioned limit or outstanding, whichever is higher)",
    base: "tier1", limit: 15,
    source: { title: CRM("Urban Co-operative Banks"), para: "6", text: /individual borrower does not exceed 15 per ?cent of Tier-I capital/i },
  },
  {
    key: "ucb_group", category: "urban_cooperative_banks", kind: "group_limit", counterparty: "default",
    label: "Group of connected borrowers / parties: 25% of Tier-I capital",
    base: "tier1", limit: 25,
    source: { title: CRM("Urban Co-operative Banks"), para: "6", text: /group of connected borrowers \/ parties does not exceed 25 per ?cent of Tier-I capital/i },
  },
  {
    key: "ucb_section20", category: "urban_cooperative_banks", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in (Section 20 read with Section 56, BR Act)",
    source: { title: CREDIT("Urban Co-operative Banks"), para: "7A", text: /Section 20\(1\)\(b\)/i },
  },

  // ── NBFCs (limits depend on the regulatory layer) ────────────────────────
  {
    key: "nbfc_bl_policy", category: "nbfc", kind: "policy_only", profile: { nbfc_layer: "BL" },
    label: "NBFC-BL: no regulatory ceiling - Board-approved single / group concentration limits apply",
    source: { title: CRM("Non-Banking Financial Companies"), para: "8", text: /internal Board-approved policy for credit \/ investment concentration limits/i },
  },
  {
    key: "nbfc_ml_single", category: "nbfc", kind: "single_limit", counterparty: "default", profile: { nbfc_layer: "ML", nbfc_is_ifc: 0 },
    label: "NBFC-ML single party: 25% of Tier 1 (+5% if the excess is infrastructure)",
    base: "tier1", limit: 25, infra_extension: 5,
    source: { title: CRM("Non-Banking Financial Companies"), para: "13", text: /25 per ?cent of its Tier 1 capital to a single party/i },
  },
  {
    key: "nbfc_ml_group", category: "nbfc", kind: "group_limit", counterparty: "default", profile: { nbfc_layer: "ML", nbfc_is_ifc: 0 },
    label: "NBFC-ML single group of parties: 40% of Tier 1 (+10% if the excess is infrastructure)",
    base: "tier1", limit: 40, infra_extension: 10,
    source: { title: CRM("Non-Banking Financial Companies"), para: "13", text: /40 per ?cent of its Tier 1 capital to a single group of parties/i },
  },
  {
    key: "nbfc_ifc_single", category: "nbfc", kind: "single_limit", counterparty: "default", profile: { nbfc_layer: "ML", nbfc_is_ifc: 1 },
    label: "NBFC-IFC single party: 30% of Tier 1", base: "tier1", limit: 30,
    source: { title: CRM("Non-Banking Financial Companies"), para: "14", text: /30 per ?cent of its Tier 1 capital to a single party/i },
  },
  {
    key: "nbfc_ifc_group", category: "nbfc", kind: "group_limit", counterparty: "default", profile: { nbfc_layer: "ML", nbfc_is_ifc: 1 },
    label: "NBFC-IFC single group of parties: 50% of Tier 1", base: "tier1", limit: 50,
    source: { title: CRM("Non-Banking Financial Companies"), para: "14", text: /50 per ?cent of its Tier 1 capital to a single group of parties/i },
  },
  {
    key: "nbfc_ul_single", category: "nbfc", kind: "single_limit", counterparty: "default", profile: { nbfc_layer: "UL", nbfc_is_ifc: 0 },
    label: "NBFC-UL single counterparty: 20% of eligible capital base (+5% Board or infrastructure; never above 25%)",
    base: "tier1", limit: 20, board_extension: 5, infra_extension: 5, cap: 25,
    source: { title: CRM("Non-Banking Financial Companies"), para: "33", text: /single counterparty shall not be higher than 20 per ?cent/i },
  },
  {
    key: "nbfc_ul_ifc_single", category: "nbfc", kind: "single_limit", counterparty: "default", profile: { nbfc_layer: "UL", nbfc_is_ifc: 1 },
    label: "NBFC-UL (IFC) single counterparty: 25% of eligible capital base (+5% with Board approval; never above 30%)",
    base: "tier1", limit: 25, board_extension: 5, cap: 30,
    source: { title: CRM("Non-Banking Financial Companies"), para: "34", text: /30 per ?cent for NBFC-IFC/i },
  },
  {
    key: "nbfc_ul_group", category: "nbfc", kind: "group_limit", counterparty: "default", profile: { nbfc_layer: "UL", nbfc_is_ifc: 0 },
    label: "NBFC-UL group of connected counterparties: 25% of eligible capital base (+10% if infrastructure)",
    base: "tier1", limit: 25, infra_extension: 10,
    source: { title: CRM("Non-Banking Financial Companies"), para: "35", text: /group of connected counterparties shall not be higher than 25 per ?cent/i },
  },
  {
    key: "nbfc_ul_ifc_group", category: "nbfc", kind: "group_limit", counterparty: "default", profile: { nbfc_layer: "UL", nbfc_is_ifc: 1 },
    label: "NBFC-UL (IFC) group of connected counterparties: 35% of eligible capital base",
    base: "tier1", limit: 35,
    source: { title: CRM("Non-Banking Financial Companies"), para: "35", text: /IFC may exceed the exposure limit by 10 per ?cent/i },
  },
  {
    key: "nbfc_ul_large_exposure", category: "nbfc", kind: "le_reporting", profile: { nbfc_layer: "UL" },
    label: "Exposures >= 10% of Tier 1 are reported in the Return on Large Exposures",
    base: "tier1", threshold: 10,
    source: { title: CRM("Non-Banking Financial Companies"), para: "Annex I", text: /equal to or above 10 per ?cent of Tier I Capital/i },
  },

  // ── All-India financial institutions ─────────────────────────────────────
  {
    key: "aifi_single", category: "all_india_financial_institutions", kind: "single_limit", counterparty: "default",
    label: "Single counterparty: 20% of eligible capital base (+5% with Board approval, +5% infrastructure)",
    base: "tier1", limit: 20, board_extension: 5, infra_extension: 5, cap: 30,
    source: { title: CRM("All India Financial Institutions"), para: "11", text: /single counterparty shall not be higher than 20 per ?cent/i },
  },
  {
    key: "aifi_group", category: "all_india_financial_institutions", kind: "group_limit", counterparty: "default",
    label: "Group of connected counterparties: 25% of eligible capital base (+10% if infrastructure)",
    base: "tier1", limit: 25, infra_extension: 10,
    source: { title: CRM("All India Financial Institutions"), para: "12", text: /group of connected counterparties shall not be higher than 25 per ?cent/i },
  },
  {
    key: "aifi_control_definition", category: "all_india_financial_institutions", kind: "definition",
    label: "Control is automatic above 50% of voting rights",
    source: { title: CRM("All India Financial Institutions"), para: "15", text: /owns more than 50 per ?cent of the voting rights/i },
  },
  {
    key: "aifi_section20", category: "all_india_financial_institutions", kind: "related_party", variant: "section20",
    label: "No loans to directors or firms / companies they are interested in",
    source: { title: CREDIT("All India Financial Institutions"), para: "17B", text: /any firm in which any of its directors is interested/i },
  },

  // ── Rural co-operative banks: unit-wise limit by NABARD rating ───────────
  {
    key: "rcb_unit", category: "rural_cooperative_banks", kind: "single_limit", counterparty: "default",
    label: "Unit-wise exposure: % of capital fund by NABARD inspection rating (A 60, B/B+ 50, C 45, D 40)",
    base: "capital_fund_rcb", limit_by_rating: { A: 60, "B+": 50, B: 50, C: 45, D: 40 },
    source: { title: CRM("Rural Co-operative Banks"), para: "14", text: /Unit-wise exposure/i },
  },
];

// Which capital figure each base uses (columns of graph_capital).
function capitalAmount(base, capital) {
  if (!capital) return null;
  const n = (v) => (v === null || v === undefined || v === "" ? null : Number(v));
  switch (base) {
    case "tier1":
      return n(capital.tier1_capital);
    case "capital_funds":
      return n(capital.tier1_capital) === null ? null : n(capital.tier1_capital) + (n(capital.tier2_capital) || 0);
    case "owned_funds":
      return n(capital.owned_funds);
    case "paid_up_capital_reserves":
    case "capital_fund_rcb":
      return n(capital.paid_up_capital_reserves);
    default:
      return null;
  }
}

// Exposure value convention per category (UCB: sanctioned limit or
// outstanding, whichever is higher - paragraph 4(1)(i)).
const VALUE_RULE = { urban_cooperative_banks: "limit_or_outstanding" };
// Commercial banks: intra-group exposures are governed by Chapter VI and
// exempted from the LEF (paragraph 8(7)).
const LEF_EXCLUDES_INTRAGROUP = new Set(["commercial_banks"]);

const cache = new Map();

function resolveSource(rule) {
  const cacheKey = rule.key;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  let resolved = { verified: false, reason: "the source direction is not in the corpus" };
  try {
    const db = getDb();
    const docs = db
      .prepare(
        `SELECT d.doc_id, d.title, d.rbi_ref FROM documents d
         WHERE d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)`
      )
      .all(rule.category)
      .filter((d) => rule.source.title.test(d.title));
    for (const d of docs) {
      const clauses = db
        .prepare(
          `SELECT clause_uri, paragraph_number, page_number, clause_text, heading_path FROM clause_registry
           WHERE doc_id = ? ORDER BY paragraph_number = ? DESC, seq`
        )
        .all(d.doc_id, rule.source.para);
      const hit = clauses.find((c) => rule.source.text.test(c.clause_text.replace(/\s+/g, " ")));
      if (hit) {
        resolved = {
          verified: true,
          clause_uri: hit.clause_uri,
          paragraph: hit.paragraph_number,
          page_number: hit.page_number,
          heading_path: hit.heading_path,
          doc_id: d.doc_id,
          doc_title: d.title,
          rbi_ref: d.rbi_ref,
          excerpt: excerpt(hit.clause_text, rule.source.text),
          moved: hit.paragraph_number !== rule.source.para,
        };
        break;
      }
      resolved = {
        verified: false,
        reason: `the paragraph stating this limit was not found in "${d.title}" - the direction may have changed`,
        doc_id: d.doc_id,
        doc_title: d.title,
      };
    }
  } catch (err) {
    resolved = { verified: false, reason: `corpus lookup failed: ${err.message}` };
  }
  cache.set(cacheKey, resolved);
  return resolved;
}

function excerpt(clauseText, re) {
  const flat = clauseText.replace(/\s+/g, " ");
  const m = re.exec(flat);
  if (!m) return flat.slice(0, 400);
  const start = Math.max(0, flat.lastIndexOf(".", m.index) + 1);
  const end = flat.indexOf(". ", m.index + m[0].length);
  const text = flat.slice(start, end === -1 ? flat.length : end + 1).trim();
  return text.length > 700 ? `${text.slice(0, 700).replace(/\s+\S*$/, "")} …` : text;
}

function profileMatches(rule, profile) {
  if (!rule.profile) return true;
  return Object.entries(rule.profile).every(([k, v]) => {
    const actual = profile?.[k];
    if (k === "nbfc_is_ifc") return Number(actual || 0) === Number(v);
    return actual === v;
  });
}

/** Rules that apply to a bank of this category and profile, with resolved sources. */
function rulesFor(category, profile = {}) {
  return RULES.filter((r) => r.category === category && profileMatches(r, profile)).map((r) => ({
    ...r,
    base_label: r.base ? BASES[r.base] : null,
    source_resolved: resolveSource(r),
  }));
}

/** Every rule (for the catalog screen), resolved. */
function catalog(category = null) {
  return RULES.filter((r) => !category || r.category === category).map((r) => {
    const s = resolveSource(r);
    const { source, ...rest } = r;
    return {
      ...rest,
      base_label: r.base ? BASES[r.base] : null,
      source_hint: { paragraph: source.para },
      source: s,
    };
  });
}

/** clause_uris the network check decides (used by the adaptive router). */
function coveredClauseUris(category) {
  return new Set(
    RULES.filter((r) => r.category === category)
      .map((r) => resolveSource(r))
      .filter((s) => s.verified)
      .map((s) => s.clause_uri)
  );
}

function resetCache() {
  cache.clear();
}

module.exports = {
  RULES,
  BASES,
  VALUE_RULE,
  LEF_EXCLUDES_INTRAGROUP,
  capitalAmount,
  rulesFor,
  catalog,
  coveredClauseUris,
  resolveSource,
  resetCache,
};
