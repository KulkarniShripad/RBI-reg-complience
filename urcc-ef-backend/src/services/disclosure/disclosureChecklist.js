/**
 * Does the document contain the disclosures RBI requires in it?
 *
 *   annual report   the "Notes to Accounts" items of the category's Financial
 *                   Statements: Presentation and Disclosures Directions
 *   Pillar 3        the DF tables of the category's Capital Adequacy Directions
 *
 * Each item is applied only if its heading is found in that direction for the
 * bank's category (so an item a category is not asked for is never reported
 * missing), and it is searched for in the uploaded document by its usual
 * headings. A missing item is LIKELY_MISSING, not a breach: the item may be
 * published in another document (e.g. Pillar 3 on the website), which the
 * report says.
 */
const db = require("../../config/db");
const { excerptAround } = require("./regulatoryRules");

const FS_TITLE = /Financial Statements\s*:\s*Presentation and Disclosures/i;
const CAPITAL_TITLE = /Prudential Norms on Capital Adequacy/i;

const NOTES_ITEMS = [
  { key: "regulatory_capital", label: "Regulatory capital (composition, CRAR)", corpus: /\(1\)\s*Regulatory capital|Composition of Regulatory Capital/i, doc: /regulatory\s+capital|capital\s+adequacy|\bcrar\b/i },
  { key: "alm_maturity", label: "Maturity pattern of assets and liabilities", corpus: /Maturity pattern of certain items of assets and liabilities/i, doc: /maturity\s+pattern|maturity\s+profile/i },
  { key: "lcr", label: "Liquidity coverage ratio", corpus: /Liquidity coverage ratio \(LCR\)/i, doc: /liquidity\s+coverage\s+ratio|\bLCR\b/i },
  { key: "nsfr", label: "Net stable funding ratio", corpus: /\bNSFR\b/, doc: /net\s+stable\s+funding|\bNSFR\b/i },
  { key: "investments", label: "Composition of investment portfolio", corpus: /Composition of investment portfolio/i, doc: /composition\s+of\s+investment|investment\s+portfolio/i },
  { key: "asset_classification", label: "Classification of advances and provisions held", corpus: /Classification of advances and provisions held/i, doc: /classification\s+of\s+advances|non[\s-]*performing\s+(?:assets|advances)|\bNPAs?\b/i },
  { key: "sector_npa", label: "Sector-wise advances and gross NPAs", corpus: /Sector-wise advances and Gross NPAs/i, doc: /sector[\s-]*wise\s+(?:advances|npa)/i },
  { key: "divergence", label: "Divergence in asset classification and provisioning", corpus: /Divergence in asset classification and provisioning/i, doc: /divergence/i },
  { key: "frauds", label: "Frauds (number, amount, provisions)", corpus: /number and amount of frauds/i, doc: /\bfrauds?\b/i },
  { key: "real_estate", label: "Exposure to real estate sector", corpus: /Exposure to real estate sector/i, doc: /real\s+estate/i },
  { key: "capital_market", label: "Exposure to capital market", corpus: /Exposure to capital market/i, doc: /capital\s+market\s+exposure|exposure\s+to\s+capital\s+market/i },
  { key: "concentration", label: "Concentration of deposits, advances, exposures and NPAs", corpus: /Concentration of deposits, advances, exposures and NPAs/i, doc: /concentration\s+of\s+(?:deposits|advances|exposures)|(?:twenty|20)\s+largest/i },
  { key: "derivatives", label: "Derivatives", corpus: /\(7\)\s*Derivatives/i, doc: /derivative/i },
  { key: "securitisation", label: "Securitisation", corpus: /Disclosures relating to securitisation/i, doc: /securiti[sz]ation/i },
  { key: "dea_fund", label: "Transfers to the Depositor Education and Awareness Fund", corpus: /Transfers to Depositor Education and Awareness Fund|DEA Fund/i, doc: /depositor\s+education\s+and\s+awareness|\bDEA\s*F(?:und)?\b/i },
  { key: "complaints", label: "Customer complaints", corpus: /Disclosure of complaints/i, doc: /complaints/i },
  { key: "penalties", label: "Penalties imposed by the RBI", corpus: /penalties imposed by the RBI/i, doc: /penalt(?:y|ies)\s+(?:imposed|levied)/i },
  { key: "remuneration", label: "Remuneration", corpus: /Disclosures on remuneration/i, doc: /remuneration/i },
  { key: "business_ratios", label: "Business ratios", corpus: /Business ratios/i, doc: /business\s+ratios|return\s+on\s+assets|profit\s+per\s+employee/i },
  { key: "bancassurance", label: "Bancassurance fees", corpus: /Bancassurance business/i, doc: /bancassurance|insurance\s+(?:broking|agency|business)/i },
  { key: "provisions", label: "Provisions and contingencies", corpus: /Provisions and contingencies/i, doc: /provisions\s+and\s+contingencies/i },
  { key: "dicgc", label: "Payment of DICGC insurance premium", corpus: /DICGC Insurance Premium|insurance premium/i, doc: /\bDICGC\b|deposit\s+insurance/i },
  { key: "related_party", label: "Related party disclosures", corpus: /related part(?:y|ies)/i, doc: /related\s+part(?:y|ies)/i },
];

const PILLAR3_ITEMS = [
  { key: "df1", label: "DF-1 Scope of application", corpus: /Table DF-1\b/i, doc: /DF[\s-]*1\b(?!\d)|scope\s+of\s+application/i },
  { key: "df2", label: "DF-2 Capital adequacy", corpus: /Table DF-2\b/i, doc: /DF[\s-]*2\b(?!\d)|capital\s+adequacy/i },
  { key: "df3", label: "DF-3 Credit risk", corpus: /Table DF-3\b/i, doc: /DF[\s-]*3\b(?!\d)|credit\s+risk/i },
  { key: "df5", label: "DF-5 Credit risk mitigation", corpus: /Table DF-5\b/i, doc: /DF[\s-]*5\b(?!\d)|credit\s+risk\s+mitigation/i },
  { key: "df7", label: "DF-7 Market risk in trading book", corpus: /Table DF-7\b/i, doc: /DF[\s-]*7\b(?!\d)|market\s+risk/i },
  { key: "df8", label: "DF-8 Operational risk", corpus: /Table DF-8\b/i, doc: /DF[\s-]*8\b(?!\d)|operational\s+risk/i },
  { key: "df9", label: "DF-9 Interest rate risk in the banking book", corpus: /Table DF-9\b/i, doc: /DF[\s-]*9\b(?!\d)|interest\s+rate\s+risk\s+in\s+(?:the\s+)?banking\s+book|\bIRRBB\b/i },
  { key: "df11", label: "DF-11 Composition of capital", corpus: /Table DF-11\b/i, doc: /DF[\s-]*11\b|composition\s+of\s+capital/i },
  { key: "df18", label: "DF-18 Leverage ratio", corpus: /Table DF-18\b|leverage ratio common disclosure/i, doc: /DF[\s-]*18\b|leverage\s+ratio/i },
];

const itemCache = new Map();

function anchorFor(category, titleRe, item) {
  const key = `${category}:${titleRe.source}:${item.key}`;
  if (itemCache.has(key)) return itemCache.get(key);
  let result = null;
  const docs = db
    .prepare(`SELECT d.doc_id, d.title, d.rbi_ref FROM documents d JOIN document_categories dc ON dc.doc_id = d.doc_id WHERE dc.category = ?`)
    .all(category)
    .filter((d) => titleRe.test(d.title));
  for (const d of docs) {
    const hit = db
      .prepare(`SELECT clause_uri, paragraph_number, page_number, clause_text FROM clause_registry WHERE doc_id = ? ORDER BY seq`)
      .all(d.doc_id)
      .find((c) => item.corpus.test(c.clause_text));
    if (hit) {
      result = {
        verified: true,
        clause_uri: hit.clause_uri,
        doc_id: d.doc_id,
        doc_title: d.title,
        rbi_ref: d.rbi_ref,
        paragraph: hit.paragraph_number,
        page_number: hit.page_number,
        excerpt: excerptAround(hit.clause_text, item.corpus),
      };
      break;
    }
  }
  itemCache.set(key, result);
  return result;
}

/**
 * @param {string} category
 * @param {string} docType
 * @param {{page:number,lines:string[]}[]} pages
 */
function checkDisclosures(category, docType, pages) {
  const set = docType === "annual_report" ? { items: NOTES_ITEMS, title: FS_TITLE, name: "Notes to Accounts" }
    : docType === "pillar3" ? { items: PILLAR3_ITEMS, title: CAPITAL_TITLE, name: "Pillar 3 disclosure tables" }
      : null;
  if (!set) return { applicable: false, reason: "Disclosure completeness is checked for annual reports and Pillar 3 disclosures.", items: [] };

  const results = [];
  for (const item of set.items) {
    const source = anchorFor(category, set.title, item);
    if (!source) continue; // not required of this category
    let found = null;
    for (const p of pages) {
      const line = p.lines.find((l) => item.doc.test(l));
      if (line) {
        found = { page: p.page, snippet: line.slice(0, 240) };
        break;
      }
    }
    results.push({
      key: `disclosure_${item.key}`,
      label: item.label,
      status: found ? "PRESENT" : "LIKELY_MISSING",
      found,
      source,
    });
  }
  return {
    applicable: results.length > 0,
    set: set.name,
    reason: results.length ? null : "No disclosure requirements of this kind were found for this category in the corpus.",
    items: results,
  };
}

module.exports = { checkDisclosures, NOTES_ITEMS, PILLAR3_ITEMS };
