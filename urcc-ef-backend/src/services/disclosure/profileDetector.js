/**
 * Who published a document, what kind of institution it is, what date the
 * figures relate to and what kind of document it is - read from the text
 * (deterministic; the caller asks the LLM only for what this cannot find).
 *
 *   bank name      the most frequent "<Name> Bank [Limited]" in the document,
 *                  RBI itself excluded
 *   category       from the name ("Small Finance Bank", "Co-operative Bank",
 *                  "Gramin Bank", "Payments Bank", ...), else commercial bank
 *   as-of date     the most frequent "as on / as at / quarter ended / year
 *                  ended <date>", preferring the first pages
 *   period         the RBI reporting quarter of that date: Apr-Jun = Q1 of
 *                  the financial year that starts in April
 *   document type  Pillar 3 disclosure, annual report, financial results,
 *                  board minutes, policy, figures (spreadsheet / JSON)
 *   D-SIB          State Bank of India, HDFC Bank, ICICI Bank are RBI's
 *                  Domestic Systemically Important Banks (leverage ratio 4%)
 */

const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";

// RBI's list of Domestic Systemically Important Banks (press release on the
// D-SIB list; not part of the Master Directions corpus, so kept here and shown
// as an editable profile flag).
const DSIB = [/state\s+bank\s+of\s+india/i, /\bhdfc\s+bank\b/i, /\bicici\s+bank\b/i];

const DOC_TYPES = [
  { id: "pillar3", label: "Basel III Pillar 3 disclosure", re: /pillar[\s-]*(?:3|iii)\b|\bKM1\b|\bDF-\d{1,2}\b|basel\s+iii\s+disclosures?|market\s+discipline/gi },
  { id: "annual_report", label: "Annual report / financial statements", re: /annual\s+report|directors'?\s+report|notes\s+(?:to|forming\s+part\s+of\s+the)\s+(?:the\s+)?accounts|schedule\s+1[78]\b|significant\s+accounting\s+policies|auditors?'?\s+report/gi },
  { id: "financial_results", label: "Quarterly / annual financial results", re: /(?:un)?audited\s+(?:standalone\s+|consolidated\s+)?financial\s+results|regulation\s+33|analytical\s+ratios|segment\s+(?:wise\s+)?results|quarter\s+ended/gi },
  { id: "board_minutes", label: "Board / committee minutes", re: /minutes\s+of\s+the|board\s+meeting|resolved\s+that|the\s+board\s+(?:noted|approved|reviewed)/gi },
  { id: "policy", label: "Policy document", re: /\bpolicy\b.{0,40}\b(?:approved\s+by\s+the\s+board|review(?:ed)?\s+annually|objective|scope)|this\s+policy/gi },
];

const CATEGORY_FROM_NAME = [
  [/small\s+finance\s+bank/i, "small_finance_banks"],
  [/payments?\s+bank/i, "payments_banks"],
  [/(?:state|district\s+central)\s+co-?\s?operative\s+bank|\bdccb\b|\bstcb\b/i, "rural_cooperative_banks"],
  [/co-?\s?operative\s+bank|sahakari\s+bank|\bco-?op\.?\s+bank|urban\s+bank/i, "urban_cooperative_banks"],
  [/gramin\s+bank|grameen\s+bank|regional\s+rural\s+bank|gramin\s+vikas\s+bank/i, "regional_rural_banks"],
  [/local\s+area\s+bank/i, "local_area_banks"],
  [/national\s+housing\s+bank|\bnabard\b|national\s+bank\s+for\s+agriculture|\bsidbi\b|small\s+industries\s+development\s+bank|export[\s-]import\s+bank|exim\s+bank|national\s+bank\s+for\s+financing\s+infrastructure/i, "all_india_financial_institutions"],
  [/\bbank\b/i, "commercial_banks"],
  [/finance\s+(?:ltd|limited|company)|financial\s+services\s+(?:ltd|limited)|housing\s+finance|\bnbfc\b|capital\s+(?:ltd|limited)/i, "nbfc"],
];

const BANK_NAME = /\b((?:[A-Z][A-Za-z&.'’-]*|of|and|the|&)(?:\s+(?:[A-Z][A-Za-z&.'’-]*|of|and|the|&)){0,7}\s+(?:Small\s+Finance\s+Bank|Payments?\s+Bank|Co-?\s?operative\s+Bank|Sahakari\s+Bank|Gramin\s+Bank|Grameen\s+Bank|Bank)(?:\s+of\s+(?:India|Baroda|Maharashtra|Mysore|Travancore|Hyderabad|Patiala|Bikaner\s+and\s+Jaipur))?)(?:\s+(?:Limited|Ltd\.?))?/g;
// "Bank of Baroda", "Bank of India", "Bank of Maharashtra" (no word before "Bank")
const BANK_OF = /(?<![A-Za-z]\s?)\bBank\s+of\s+(?:India|Baroda|Maharashtra)\b(?:\s+(?:Limited|Ltd\.?))?/g;
const NOT_A_BANK_NAME = /^(?:the\s+)?(?:reserve\s+bank|world\s+bank|the\s+bank|our\s+bank|a\s+bank|each\s+bank|any\s+bank|such\s+bank|other\s+bank|scheduled\s+commercial\s+bank|commercial\s+bank|central\s+bank|foreign\s+bank|parent\s+bank|sponsor\s+bank|this\s+bank|of\s+the\s+bank|payments\s+bank|small\s+finance\s+bank|co-?operative\s+bank)$/i;

function toIso(y, m, d) {
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDateText(s) {
  const t = String(s || "").trim();
  let m = new RegExp(`^(\\d{1,2})(?:st|nd|rd|th)?\\s*${MONTH_RE}\\.?,?\\s*(\\d{4})`, "i").exec(t);
  if (m) return toIso(+m[3], MONTH_NUM[m[2].slice(0, 3).toLowerCase()], +m[1]);
  m = new RegExp(`^${MONTH_RE}\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})`, "i").exec(t);
  if (m) return toIso(+m[3], MONTH_NUM[m[1].slice(0, 3).toLowerCase()], +m[2]);
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(t);
  if (m) return toIso(+m[3], +m[2], +m[1]);
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return toIso(+m[1], +m[2], +m[3]);
  return null;
}

/** RBI reporting quarter of a date: Apr-Jun = Q1 of FY(April start). */
function periodForDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || "");
  if (!m) return null;
  const y = +m[1];
  const mon = +m[2];
  const fyStart = mon >= 4 ? y : y - 1;
  const q = mon >= 4 ? Math.floor((mon - 4) / 3) + 1 : 4;
  return `Q${q}-FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

function periodEnd(periodLabel) {
  const m = /^Q([1-4])-FY(\d{4})-\d{2}$/.exec(periodLabel || "");
  if (!m) return null;
  const q = +m[1];
  const fy = +m[2];
  return [`${fy}-06-30`, `${fy}-09-30`, `${fy}-12-31`, `${fy + 1}-03-31`][q - 1];
}

const DATE_PHRASE = new RegExp(
  `(?:as\\s+(?:on|at|of)|quarter\\s+ended|period\\s+ended|year\\s+ended|half[\\s-]*year\\s+ended|ended|as\\s+on\\s+date)[\\s:|]*` +
    `((?:\\d{1,2}(?:st|nd|rd|th)?\\s*${MONTH_RE}\\.?,?\\s*\\d{4})|(?:${MONTH_RE}\\.?\\s*\\d{1,2}(?:st|nd|rd|th)?,?\\s*\\d{4})|(?:\\d{1,2}[./-]\\d{1,2}[./-]\\d{4}))`,
  "gi"
);

const QUARTER_END = /-(?:03-31|06-30|09-30|12-31)$/;

function detectDate(pages) {
  const counts = new Map();
  pages.forEach((p, pi) => {
    const text = p.lines.join(" \n ");
    let m;
    DATE_PHRASE.lastIndex = 0;
    while ((m = DATE_PHRASE.exec(text))) {
      const iso = parseDateText(m[1]);
      if (!iso) continue;
      // the cover / first pages state the reporting date; reporting dates are quarter ends
      const weight = (pi < 3 ? 3 : 1) + (QUARTER_END.test(iso) ? 2 : 0);
      const c = counts.get(iso) || { iso, n: 0, first: `p.${p.page}: ${m[0].trim()}` };
      c.n += weight;
      counts.set(iso, c);
    }
  });
  // a bare date on the cover ("Pillar III Disclosure – March 31, 2025")
  if (!counts.size) {
    const bare = new RegExp(DATE_PHRASE.source.replace(/^\(\?:as[\s\S]*?\)\[\\s:\|\]\*/, ""), "gi");
    pages.slice(0, 2).forEach((p) => {
      const text = p.lines.join(" \n ");
      let m;
      while ((m = bare.exec(text))) {
        const iso = parseDateText(m[1] || m[0]);
        if (!iso) continue;
        const c = counts.get(iso) || { iso, n: 0, first: `p.${p.page}: ${m[0].trim()}` };
        c.n += QUARTER_END.test(iso) ? 3 : 1;
        counts.set(iso, c);
      }
    });
  }
  // "Annual Report 2024-25" / "FY 2024-25" without an explicit date: year end 31 March
  if (!counts.size) {
    const head = pages.slice(0, 3).map((p) => p.lines.join(" ")).join(" ");
    const m = /(?:annual\s+report|financial\s+year|\bfy)\s*[:-]?\s*(20\d{2})\s*[-–/]\s*(?:20)?(\d{2})\b/i.exec(head);
    if (m) {
      const iso = `${+m[1] + 1}-03-31`;
      counts.set(iso, { iso, n: 1, first: m[0] });
    }
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n || (a.iso < b.iso ? 1 : -1))[0];
  return best ? { as_of_date: best.iso, evidence: best.first } : { as_of_date: null, evidence: null };
}

function detectBankName(pages) {
  const counts = new Map();
  pages.forEach((p, pi) => {
    for (const line of p.lines) {
      const found = [];
      for (const re of [BANK_NAME, BANK_OF]) {
        re.lastIndex = 0;
        let x;
        while ((x = re.exec(line))) found.push(x);
      }
      for (const m of found) {
        let name = m[0].replace(/\s+/g, " ").replace(/^(?:the|of|and|&)\s+/i, "").trim();
        name = name.replace(/\bLtd\.?$/i, "Limited");
        if (NOT_A_BANK_NAME.test(name) || /^reserve bank/i.test(name) || name.split(" ").length < 2) continue;
        if (/^(?:of|and|the|&|for|with|by|to|in|on|at|from|our|your|its|this)\b/i.test(name)) continue;
        const key = name.toLowerCase().replace(/\s+limited$/, "");
        const c = counts.get(key) || { name, n: 0, page: p.page };
        c.n += pi < 2 ? 3 : 1;
        if (/limited$/i.test(name)) c.name = name; // keep the full legal name
        counts.set(key, c);
      }
    }
  });
  const best = [...counts.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { bank_name: best.name, evidence: `"${best.name}" (${best.n} mentions, first on p.${best.page})` } : { bank_name: null, evidence: null };
}

function categoryFromName(name) {
  if (!name) return null;
  for (const [re, cat] of CATEGORY_FROM_NAME) if (re.test(name)) return cat;
  return null;
}

function detectDocType(pages, format) {
  if (format === "json" || format === "csv" || format === "xlsx") {
    return { doc_type: "figures", label: "Figures (spreadsheet / structured data)", scores: {} };
  }
  const text = pages.map((p) => p.lines.join(" ")).join(" ");
  const scores = {};
  for (const t of DOC_TYPES) scores[t.id] = (text.match(t.re) || []).length;
  const best = Object.entries(scores).sort((a, b) => b[1] - a[1])[0];
  if (!best || best[1] === 0) return { doc_type: "other", label: "Other bank document", scores };
  const t = DOC_TYPES.find((d) => d.id === best[0]);
  return { doc_type: t.id, label: t.label, scores };
}

const DOC_TYPE_LABELS = Object.fromEntries([
  ...DOC_TYPES.map((d) => [d.id, d.label]),
  ["figures", "Figures (spreadsheet / structured data)"],
  ["other", "Other bank document"],
]);

/** UCB tier (Licensing directions, para 2) from total deposits in ₹ crore. */
function ucbTierFromDeposits(depositsCrore) {
  if (depositsCrore === null || depositsCrore === undefined || !Number.isFinite(depositsCrore)) return null;
  if (depositsCrore <= 100) return 1;
  if (depositsCrore <= 1000) return 2;
  if (depositsCrore <= 10000) return 3;
  return 4;
}

/**
 * @param {{format:string, pages:{page:number,lines:string[]}[], structured?:object}} parsed
 */
function detectProfile(parsed) {
  const s = parsed.structured || {};
  const name = s.bank_name ? { bank_name: s.bank_name, evidence: "bank_name field" } : detectBankName(parsed.pages);
  const date = s.as_of_date
    ? { as_of_date: parseDateText(s.as_of_date) || s.as_of_date, evidence: "as_of_date field" }
    : detectDate(parsed.pages);
  const docType = detectDocType(parsed.pages, parsed.format);
  const period = s.period_label || periodForDate(date.as_of_date);
  const category = s.institution_category || categoryFromName(name.bank_name);
  return {
    bank_name: name.bank_name,
    institution_category: category,
    as_of_date: date.as_of_date,
    period_label: period,
    doc_type: docType.doc_type,
    doc_type_label: docType.label,
    is_dsib: name.bank_name ? DSIB.some((re) => re.test(name.bank_name)) : false,
    evidence: {
      bank_name: name.evidence,
      institution_category: category ? (s.institution_category ? "institution_category field" : `from the name "${name.bank_name}"`) : null,
      as_of_date: date.evidence,
      doc_type: docType.scores,
    },
    detected_by: "rules",
  };
}

module.exports = {
  detectProfile,
  detectBankName,
  detectDate,
  detectDocType,
  categoryFromName,
  periodForDate,
  periodEnd,
  parseDateText,
  ucbTierFromDeposits,
  DOC_TYPE_LABELS,
  DSIB,
};
