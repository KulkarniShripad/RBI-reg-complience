/**
 * The figures a bank publishes that RBI rules constrain, and how to recognise
 * them in a document.
 *
 * Banks publish these in:
 *   - Basel III Pillar 3 disclosures (quarterly; template KM1 "Key metrics"
 *     carries CET1 / Tier 1 / total capital ratios, leverage ratio, LCR, NSFR),
 *   - quarterly financial results (SEBI Reg. 33 "analytical ratios": capital
 *     adequacy ratio, CET1, gross / net NPA %, ...),
 *   - the annual report ("Notes to Accounts" prescribed by RBI's Financial
 *     Statements: Presentation and Disclosures Directions).
 *
 * Every metric has label patterns (matched on the text BEFORE the number),
 * patterns that rule a label out (e.g. "Tier 1" inside "Common Equity Tier
 * 1"), a unit and a plausible range. Spreadsheet / JSON / CSV column names are
 * matched with `aliases`.
 */

const PCT = "%";
const CRORE = "₹ crore";

/**
 * @typedef {{key:string,label:string,unit:string,kind:'ratio'|'amount',range:[number,number],labels:RegExp[],
 *   pctOnly?:RegExp[],exclude?:RegExp,aliases:string[],description:string,informational?:boolean}} Metric
 * `pctOnly` labels are too generic on their own ("Net NPA" is also an amount
 * row); a number after them counts only when it carries a "%" sign.
 */

/** @type {Metric[]} */
const METRICS = [
  {
    key: "crar",
    label: "Capital to Risk-weighted Assets Ratio (CRAR)",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [
      /\bcrar\b/i,
      /capital\s+to\s+risk[\s-]*(?:weighted)?\s*assets?\s+ratio/i,
      /capital\s+adequacy\s+ratio/i,
      /\btotal\s+capital\s+(?:\(?crar\)?\s*)?ratio/i,
      /\bcar\b\s*(?:\(%\)|%|-|–|\(basel)/i,
      /total\s+capital\s+(?:to\s+)?rwa/i,
    ],
    // tested on the label plus the 25 characters before it, so "Tier 1 capital
    // adequacy ratio" is not read as CRAR but "CRAR (Tier I + Tier II)" is
    exclude: /(?:tier[\s-]*(?:1|i|ii|2)|\bcet\s*1|common\s+equity|additional)\W{0,3}(?:capital\s+)?(?:adequacy\s+ratio|crar|car|to\s+risk)|minimum|buffer|required|requirement/i,
    aliases: ["crar", "car", "capital adequacy ratio", "total capital ratio", "capital to risk weighted assets ratio"],
    description: "total regulatory capital as a percentage of risk-weighted assets",
  },
  {
    key: "cet1_ratio",
    label: "Common Equity Tier 1 (CET1) ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/common\s+equity\s+tier[\s-]*(?:1|i)\b(?:\s*\(cet\s*1\))?\s*(?:capital\s*)?(?:ratio|crar|%|\(%\))/i, /\bcet[\s-]*1\s*(?:capital\s*)?(?:ratio|crar|%|\(%\))/i, /\bcet[\s-]*1\b/i],
    exclude: /minimum|buffer|trigger|available\s+after|surplus/i,
    aliases: ["cet1", "cet1 ratio", "common equity tier 1 ratio", "cet 1 ratio"],
    description: "common equity tier 1 capital as a percentage of risk-weighted assets",
  },
  {
    key: "tier1_ratio",
    label: "Tier 1 capital ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/\btier[\s-]*(?:1|i)\b\s*(?:capital\s*)?(?:ratio|crar|car|%|\(%\))/i, /\btier[\s-]*(?:1|i)\b\s*(?:capital\s*)?(?:adequacy\s+)?ratio/i, /\btier[\s-]*(?:1|i)\s+at\b/i],
    exclude: /common\s+equity|\bcet\s*1|additional\s+tier|\bat\s*1\b|minimum|buffer|leverage|\bucb\b/i,
    aliases: ["tier 1 ratio", "tier1 ratio", "tier i ratio", "tier 1 crar", "tier 1 capital ratio"],
    description: "tier 1 capital as a percentage of risk-weighted assets",
  },
  {
    key: "tier2_ratio",
    label: "Tier 2 capital ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/\btier[\s-]*(?:2|ii)\b\s*(?:capital\s*)?(?:ratio|crar|car|%|\(%\)|at\b)/i],
    exclude: /minimum|maximum|limit/i,
    aliases: ["tier 2 ratio", "tier ii ratio", "tier 2 crar"],
    description: "tier 2 capital as a percentage of risk-weighted assets",
    informational: true,
  },
  {
    key: "leverage_ratio",
    label: "Leverage ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/leverage\s+ratio/i],
    exclude: /exposure\s+measure|minimum|capital\s+measure\s*$/i,
    aliases: ["leverage ratio", "basel iii leverage ratio"],
    description: "tier 1 capital as a percentage of the leverage exposure measure",
  },
  {
    key: "lcr",
    label: "Liquidity Coverage Ratio (LCR)",
    unit: PCT,
    kind: "ratio",
    range: [0, 2000],
    labels: [/liquidity\s+coverage\s+ratio/i, /\blcr\b/i],
    exclude: /minimum|requirement|total\s+(?:hqla|net\s+cash)/i,
    aliases: ["lcr", "liquidity coverage ratio"],
    description: "stock of high quality liquid assets over net cash outflows in the next 30 days",
  },
  {
    key: "nsfr",
    label: "Net Stable Funding Ratio (NSFR)",
    unit: PCT,
    kind: "ratio",
    range: [0, 1000],
    labels: [/net\s+stable\s+funding\s+ratio/i, /\bnsfr\b/i],
    exclude: /minimum|requirement|available\s+stable\s+funding\s*$|required\s+stable\s+funding\s*$/i,
    aliases: ["nsfr", "net stable funding ratio"],
    description: "available stable funding over required stable funding",
  },
  {
    key: "gross_npa_pct",
    label: "Gross NPA ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/gross\s+npas?\s*(?:ratio|%|\(%\)|to\s+gross\s+advances)/i, /%\s*of\s+gross\s+npas?/i, /\bgnpa\s*(?:ratio|%|\(%\))?/i, /gross\s+non[\s-]*performing\s+assets?\s*(?:ratio|%|\(%\)|to)/i],
    exclude: /\bnet\b(?!\s+advances)|provision|sector|top|largest|movement/i,
    pctOnly: [/\bgross\s+npas?\b/i, /\bgross\s+non[\s-]*performing\s+assets?\b/i],
    aliases: ["gross npa", "gross npa %", "gnpa", "gross npa ratio", "gross npa to gross advances"],
    description: "gross non-performing assets as a percentage of gross advances",
  },
  {
    key: "net_npa_pct",
    label: "Net NPA ratio",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/net\s+npas?\s*(?:ratio|%|\(%\)|to\s+net\s+advances)/i, /%\s*of\s+net\s+npas?/i, /\bnnpa\s*(?:ratio|%|\(%\))?/i, /net\s+non[\s-]*performing\s+assets?\s*(?:ratio|%|\(%\)|to)/i],
    exclude: /\bgross\b|provision|movement/i,
    pctOnly: [/\bnet\s+npas?\b/i, /\bnet\s+non[\s-]*performing\s+assets?\b/i],
    aliases: ["net npa", "net npa %", "nnpa", "net npa ratio", "net npa to net advances"],
    description: "net non-performing assets as a percentage of net advances",
  },
  {
    key: "pcr",
    label: "Provision Coverage Ratio (PCR)",
    unit: PCT,
    kind: "ratio",
    range: [0, 100],
    labels: [/provision(?:ing)?\s+coverage\s+ratio/i, /\bpcr\b/i],
    exclude: /including\s+(?:technical|write)|incl\.?\s*(?:auca|technical|tw)/i,
    aliases: ["pcr", "provision coverage ratio", "provisioning coverage ratio"],
    description: "provisions held against NPAs as a percentage of gross NPAs",
    informational: true,
  },
  {
    key: "psl_anbc_pct",
    label: "Priority sector lending (% of ANBC)",
    unit: PCT,
    kind: "ratio",
    range: [0, 200],
    labels: [/priority\s+sector.{0,60}(?:%|per\s*cent)\s*of\s*anbc/i, /priority\s+sector\s+(?:lending\s+)?(?:achievement|advances)\s*(?:\(%|%|as\s+%)/i],
    exclude: /target|required|shortfall/i,
    aliases: ["psl achievement", "priority sector % of anbc", "psl % anbc", "priority sector lending"],
    description: "priority sector lending achieved as a percentage of adjusted net bank credit",
  },
  {
    key: "roa",
    label: "Return on assets",
    unit: PCT,
    kind: "ratio",
    range: [-50, 50],
    labels: [/return\s+on\s+(?:average\s+)?assets/i, /\broaa?\b/i],
    exclude: /equity/i,
    aliases: ["roa", "return on assets"],
    description: "net profit as a percentage of average total assets",
    informational: true,
  },
  {
    key: "total_deposits",
    label: "Total deposits",
    unit: CRORE,
    kind: "amount",
    range: [0.01, 1e8],
    labels: [/^(?:\d+\.?\s*\|?\s*)?total\s+deposits\b/i, /^(?:\d+\.?\s*\|?\s*)?deposits\b(?!\s+(?:of|from|with|held|placed|insurance|interest))/i, /\bdeposits\s+(?:stood\s+at|grew|increased|rose|of)\b/i],
    exclude: /\bratio\b|%|interest\s+on|cost\s+of|casa|term\s+deposits|saving|current\s+deposits|placed|with\s+banks|twenty\s+largest|20\s+largest|insurance/i,
    aliases: ["total deposits", "deposits"],
    description: "total deposits (balance sheet)",
  },
  {
    key: "total_advances",
    label: "Total advances",
    unit: CRORE,
    kind: "amount",
    range: [0.01, 1e8],
    labels: [/^(?:\d+\.?\s*\|?\s*)?(?:net\s+|gross\s+|total\s+)?advances\b/i, /\badvances\s+(?:stood\s+at|grew|increased|rose|of)\b/i],
    exclude: /\bratio\b|%|npa|non[\s-]*performing|priority|sector|twenty\s+largest|20\s+largest|to\s+deposits|interest/i,
    aliases: ["advances", "total advances", "net advances", "gross advances", "loans and advances"],
    description: "advances (balance sheet)",
    informational: true,
  },
  {
    key: "net_worth",
    label: "Net worth",
    unit: CRORE,
    kind: "amount",
    range: [-1e7, 1e8],
    labels: [/^(?:\d+\.?\s*\|?\s*)?net\s+worth\b/i, /\bnet\s+worth\s+(?:stood\s+at|of|was)\b/i, /\bnet\s+owned\s+funds\b/i],
    exclude: /\bratio\b|%|minimum|return\s+on/i,
    aliases: ["net worth", "networth", "net owned funds"],
    description: "paid-up capital plus free reserves",
  },
  {
    key: "net_profit",
    label: "Net profit",
    unit: CRORE,
    kind: "amount",
    range: [-1e7, 1e7],
    labels: [/^(?:\d+\.?\s*\|?\s*)?net\s+profit\b/i, /\bprofit\s+after\s+tax\b/i, /\bnet\s+profit\s+(?:stood\s+at|of|was|rose|grew)\b/i],
    exclude: /\bratio\b|margin|%|per\s+employee|before/i,
    aliases: ["net profit", "profit after tax", "pat"],
    description: "net profit for the period",
    informational: true,
  },
];

const BY_KEY = new Map(METRICS.map((m) => [m.key, m]));

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();

/** Metric for a spreadsheet / JSON / CSV column name, or null. */
function metricForAlias(name) {
  const n = norm(name).replace(/\s*%$/, "").replace(/\bin\b.*$/, "").trim();
  if (!n) return null;
  if (BY_KEY.has(n.replace(/ /g, "_"))) return BY_KEY.get(n.replace(/ /g, "_"));
  for (const m of METRICS) if (m.aliases.some((a) => norm(a) === n)) return m;
  // label text such as "Common Equity Tier 1 ratio (%)"
  for (const m of METRICS) {
    if (m.exclude && m.exclude.test(name)) continue;
    if (m.labels.some((re) => re.test(name))) return m;
  }
  return null;
}

module.exports = { METRICS, BY_KEY, metricForAlias, get: (k) => BY_KEY.get(k) || null, PCT, CRORE };
