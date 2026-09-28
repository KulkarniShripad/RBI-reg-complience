/**
 * "Which other rules apply to this figure?" - for figures the anchored rule
 * set (regulatoryRules.js) does not cover for the bank's category.
 *
 * 1. Candidates: requirement rule atoms extracted from the directions that
 *    apply to the category (rule_atoms), with a compatible unit, whose
 *    constrained variable / sentence names the metric.
 * 2. With an LLM configured, each candidate is judged: does the paragraph
 *    impose this number directly on the reported quantity for this category?
 *    (Many do not: "GNPA below 7%" is an eligibility condition for issuing
 *    bonds, not a limit on GNPA.) Confirmed rules are then evaluated by plain
 *    arithmetic - the LLM never decides pass / fail.
 * 3. Without an LLM, candidates are listed as CANDIDATE (possible
 *    requirement, needs review) with no verdict.
 */
const db = require("../../config/db");
const gemini = require("../geminiService");
const catalog = require("./metricCatalog");

const TERMS = {
  crar: ["crar", "capital to risk", "capital adequacy ratio"],
  cet1_ratio: ["cet1", "cet 1", "common equity tier 1"],
  tier1_ratio: ["tier 1 capital ratio", "tier 1 crar", "tier i crar", "tier 1 capital of", "tier 1 capital shall"],
  leverage_ratio: ["leverage ratio"],
  lcr: ["liquidity coverage ratio", " lcr"],
  nsfr: ["net stable funding ratio", "nsfr"],
  gross_npa_pct: ["gross npa", "gnpa", "gross non-performing"],
  net_npa_pct: ["net npa", "nnpa", "net non-performing"],
  pcr: ["provision coverage", "provisioning coverage"],
  psl_anbc_pct: ["priority sector", "anbc"],
  roa: ["return on assets"],
  net_worth: ["net worth", "net owned fund"],
};

const unitOk = (metric, unit) => {
  const u = String(unit || "").toLowerCase();
  return metric.unit === "%" ? u === "%" : /crore/.test(u);
};

function candidatesFor(category, metricKey, excludeUris) {
  const metric = catalog.get(metricKey);
  const terms = TERMS[metricKey];
  if (!metric || !terms) return [];
  const like = terms.map(() => "(lower(ra.variable_text) LIKE ? OR lower(ra.sentence) LIKE ?)").join(" OR ");
  const params = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
  const rows = db
    .prepare(
      `SELECT ra.rule_id, ra.clause_uri, ra.operator, ra.threshold_value, ra.threshold_unit, ra.threshold_base, ra.variable_text,
              ra.sentence, ra.confidence, cr.paragraph_number, cr.page_number, cr.clause_text, d.doc_id, d.title AS doc_title, d.rbi_ref
       FROM rule_atoms ra
       JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri
       JOIN documents d ON d.doc_id = cr.doc_id
       WHERE d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)
         AND ra.atom_kind = 'requirement' AND ra.operator IN ('>=', '<=', '>', '<')
         AND (${like})`
    )
    .all(category, ...params)
    .filter((r) => unitOk(metric, r.threshold_unit) && !excludeUris.has(r.clause_uri))
    // table fragments extracted as rules ("No. Status (Yes / No) CRAR") are not usable requirements
    .filter((r) => !/\byes\s*\/\s*no\b|\bstatus\b|\|/i.test(`${r.variable_text} ${r.sentence}`) && String(r.variable_text || "").length >= 4);
  const score = (r) => {
    const v = String(r.variable_text || "").toLowerCase();
    return terms.some((t) => v.includes(t)) ? 3 : 1;
  };
  const seen = new Set();
  return rows
    .map((r) => ({ ...r, score: score(r) + (r.confidence === "high" ? 1 : 0) }))
    .sort((a, b) => b.score - a.score)
    .filter((r) => {
      const k = `${r.clause_uri}|${r.operator}|${r.threshold_value}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
}

const cmp = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t, ">": (v, t) => v > t, "<": (v, t) => v < t };

/**
 * @param {string} category
 * @param {Object<string,{value:number}>} metrics  key -> extracted figure
 * @param {Set<string>} coveredMetricKeys           metrics already checked by anchored rules
 * @param {Set<string>} anchoredUris                clause URIs already used
 * @param {{useLlm:boolean}} opts
 */
async function discoverRules(category, metrics, coveredMetricKeys, anchoredUris, { useLlm }) {
  const out = [];
  const llm = useLlm && gemini.isConfigured();
  for (const [key, m] of Object.entries(metrics)) {
    if (coveredMetricKeys.has(key) || m.value === null || m.value === undefined) continue;
    const metric = catalog.get(key);
    for (const c of candidatesFor(category, key, anchoredUris)) {
      const base = {
        id: `discovered:${c.rule_id}`,
        rule_key: `atom_${c.rule_id}`,
        metric_key: key,
        metric_label: metric.label,
        reported_value: m.value,
        unit: metric.unit,
        operator: c.operator,
        threshold: c.threshold_value,
        level: "minimum",
        label: `${c.variable_text || metric.label} ${c.operator} ${c.threshold_value}${c.threshold_unit === "%" ? "%" : ` ${c.threshold_unit}`}`,
        origin: "discovered",
        source: {
          verified: true,
          clause_uri: c.clause_uri,
          doc_id: c.doc_id,
          doc_title: c.doc_title,
          rbi_ref: c.rbi_ref,
          paragraph: c.paragraph_number,
          page_number: c.page_number,
          excerpt: (c.sentence || c.clause_text || "").slice(0, 700),
        },
        figure: { page: m.page, snippet: m.snippet, method: m.method, confidence: m.confidence },
      };
      if (!llm) {
        out.push({ ...base, status: "CANDIDATE", note: "Possible requirement found by text match. Configure GEMINI_API_KEY to have it confirmed, or review it manually." });
        continue;
      }
      try {
        const v = await gemini.judgeMetricRuleApplicability({
          metric,
          value: m.value,
          category,
          clauseText: c.clause_text.slice(0, 3000),
          operator: c.operator,
          threshold: c.threshold_value,
          unit: c.threshold_unit,
          rbiRef: c.rbi_ref,
        });
        if (!v || v.applies !== true) continue; // the LLM says this paragraph does not constrain the figure
        const ok = cmp[c.operator](m.value, c.threshold_value);
        out.push({
          ...base,
          status: ok ? "PASS" : "BREACH",
          llm_applicability: v,
          note: `Rule matched to this figure by the LLM (${v.confidence} confidence): ${v.reasoning} The comparison itself is arithmetic.`,
        });
      } catch (err) {
        out.push({ ...base, status: "CANDIDATE", note: `LLM check failed (${err.message}); review manually.` });
      }
    }
  }
  return out;
}

module.exports = { discoverRules, candidatesFor };
