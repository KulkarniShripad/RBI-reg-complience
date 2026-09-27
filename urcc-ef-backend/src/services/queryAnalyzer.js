/**
 * Query understanding for the regulatory chat: what entity type the user
 * is asking about, which abbreviations need expanding, and what kind of
 * answer they want. Deterministic - no LLM needed - so it works even when
 * Gemini is unavailable.
 *
 * Abbreviations come from two places:
 *   1. a short hand-written list of the most common RBI terms, and
 *   2. the corpus itself: every "Long Name (ABBR)" pattern whose initials
 *      match (e.g. "Net Demand and Time Liabilities (NDTL)") is harvested
 *      at startup, so new circulars teach the glossary new terms.
 */
const db = require("../config/db");

const MANUAL_GLOSSARY = {
  crar: "capital to risk-weighted assets ratio capital adequacy",
  car: "capital adequacy ratio",
  lcr: "liquidity coverage ratio",
  nsfr: "net stable funding ratio",
  slr: "statutory liquidity ratio",
  crr: "cash reserve ratio",
  npa: "non-performing asset",
  npas: "non-performing assets",
  kyc: "know your customer",
  aml: "anti-money laundering",
  cft: "combating financing of terrorism",
  psl: "priority sector lending",
  anbc: "adjusted net bank credit",
  nof: "net owned fund",
  ndtl: "net demand and time liabilities",
  htm: "held to maturity",
  afs: "available for sale",
  hft: "held for trading",
  alm: "asset liability management",
  irac: "income recognition asset classification provisioning",
  sma: "special mention account",
  rwa: "risk weighted assets",
  rwas: "risk weighted assets",
  cet1: "common equity tier 1",
  at1: "additional tier 1",
  ltv: "loan to value",
  msme: "micro small and medium enterprises",
  mse: "micro and small enterprises",
  kcc: "kisan credit card",
  bsbda: "basic savings bank deposit account",
  ppi: "prepaid payment instrument",
  ckycr: "central kyc records registry",
  vcip: "video based customer identification process",
  "v-cip": "video based customer identification process",
  pep: "politically exposed person",
  peps: "politically exposed persons",
  str: "suspicious transaction report",
  ctr: "cash transaction report",
  io: "internal ombudsman",
  re: "regulated entity",
  res: "regulated entities",
  wos: "wholly owned subsidiary",
  nofhc: "non-operative financial holding company",
  hfc: "housing finance company",
  spd: "standalone primary dealer",
  mfi: "microfinance institution",
  "nbfc-mfi": "nbfc microfinance institution",
  p2p: "peer to peer lending",
  dlg: "default loss guarantee",
  bc: "business correspondent",
  mclr: "marginal cost of funds based lending rate",
  ebr: "external benchmark rate",
  ecl: "expected credit loss",
  lei: "legal entity identifier",
  ufce: "unhedged foreign currency exposure",
  cersai: "central registry of securitisation asset reconstruction and security interest",
  dicgc: "deposit insurance and credit guarantee corporation",
  fema: "foreign exchange management act",
  ecb: "external commercial borrowing",
  it: "information technology",
  cic: "credit information company core investment company",
  ots: "one time settlement",
  qccp: "qualifying central counterparty",
};

const STOPWORDS = new Set(
  (
    "a an the of for to in on at by with from as is are was were be been being do does did what which who whom whose " +
    "when where why how can could should would will shall may might must i me my we our you your it its this that these " +
    "those there their them they he she his her about into over under than then so such any all each every some no not " +
    "or and if but also please tell explain describe give list show me know want need regarding related rbi reserve bank india " +
    "rule rules regulation regulations requirement requirements direction directions circular circulars per as"
  ).split(" ")
);

let cache = null;

function loadCategories() {
  const rows = db.prepare("SELECT category_id, label, aliases, patterns FROM categories ORDER BY sort_order").all();
  return rows.map((r) => ({
    id: r.category_id,
    label: r.label,
    aliases: JSON.parse(r.aliases || "[]"),
    patterns: JSON.parse(r.patterns || "[]").map((p) => {
      try {
        return new RegExp(p.replace(/\(\?<!standalone \)/g, ""), "i");
      } catch (_) {
        return null;
      }
    }).filter(Boolean),
  }));
}

function harvestGlossary() {
  const glossary = {};
  const rx = /((?:[A-Z][a-z]+|and|of|for|to|in|on|the|&)(?:[\s-]+(?:[A-Z][a-z]+|and|of|for|to|in|on|the|&)){1,8})\s*\(\s*['‘]?([A-Z][A-Za-z0-9-]{1,7})['’]?\s*\)/g;
  const rows = db
    .prepare("SELECT clause_text FROM clause_registry WHERE clause_role IN ('definition','obligation','information','applicability') ")
    .iterate();
  for (const { clause_text: text } of rows) {
    for (const m of text.matchAll(rx)) {
      const words = m[1].split(/[\s-]+/).filter((w) => /^[A-Z]/.test(w));
      const abbr = m[2].replace(/s$/, "");
      const initials = words.map((w) => w[0]).join("");
      if (abbr.length >= 2 && initials.toUpperCase().endsWith(abbr.toUpperCase().replace(/[^A-Z]/g, ""))) {
        const key = abbr.toLowerCase();
        const phrase = words.slice(-abbr.replace(/[^A-Za-z]/g, "").length).join(" ").toLowerCase();
        if (!glossary[key] && phrase.split(" ").length >= 2) glossary[key] = phrase;
      }
    }
  }
  return glossary;
}

function init() {
  if (cache) return cache;
  let harvested = {};
  try {
    harvested = harvestGlossary();
  } catch (e) {
    console.warn("[queryAnalyzer] glossary harvest failed:", e.message);
  }
  cache = { categories: loadCategories(), glossary: { ...harvested, ...MANUAL_GLOSSARY } };
  console.log(`[queryAnalyzer] ${Object.keys(cache.glossary).length} abbreviations, ${cache.categories.length} categories`);
  return cache;
}

function reset() {
  cache = null;
}

const SMALLTALK = /^(hi+|hello|hey|hii|good (morning|afternoon|evening)|thanks?|thank you|ok(ay)?|who are you|what can you do|help|how are you)[\s!.?]*$/i;
const DEFINITION_INTENT = /\b(what\s+(is|are|does|do)\s+(a|an|the)?|define|definition|meaning\s+of|what\s+is\s+meant\s+by|stands?\s+for|full\s+form)\b/i;
const NUMERIC_INTENT =
  /\b(how\s+(much|many|long|soon)|minimum|maximum|min|max|limit|ceiling|cap|threshold|percent(age)?|per\s*cent|%|ratio|within\s+how|time\s*limit|deadline|days?|months?|amount|₹|rs\.?|crore|lakh)\b/i;
const FOLLOW_UP = /^(and|also|what about|how about|same (for|about)|for |then|what if|in that case|is it|does it|can it|are they|do they|what are its|its |it |this |that |those |these )/i;

const UNAMBIGUOUS_SHORT = new Set(["nbfc", "nbfcs", "aifi", "aifis", "sfb", "sfbs", "rrb", "rrbs", "ucb", "ucbs", "scb", "scbs"]);

function detectCategories(text) {
  const { categories } = init();
  const found = [];
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
  const tokens = text.match(/[A-Za-z][A-Za-z0-9-]*/g) || [];
  for (const c of categories) {
    if (c.id === "multiple") continue;
    const long = c.aliases.filter((a) => a.includes(" ") || a.length >= 6);
    const short = c.aliases.filter((a) => !a.includes(" ") && a.length < 6);
    const longHit = long.some((a) => lower.includes(` ${a.replace(/[^a-z0-9]+/g, " ")} `));
    // Short forms ("SFB", "PB", "LAB", "ARC") only count as whole tokens written
    // in capitals - "lab" or "arc" in ordinary text must not select a category.
    const shortHit = tokens.some((t) => {
      const base = t.replace(/s$/, "").toLowerCase();
      if (!short.includes(base) && !short.includes(t.toLowerCase())) return false;
      return t === t.toUpperCase() || t.replace(/s$/, "") === t.replace(/s$/, "").toUpperCase() || UNAMBIGUOUS_SHORT.has(t.toLowerCase());
    });
    const patHit = c.patterns.some((p) => p.test(text));
    if (longHit || shortHit || patHit) found.push(c.id);
  }
  return found;
}

function expandAbbreviations(text) {
  const { glossary } = init();
  const expansions = [];
  for (const token of text.match(/[A-Za-z][A-Za-z0-9-]{1,9}/g) || []) {
    const key = token.toLowerCase();
    // Expand ALL-CAPS tokens always; lower-case tokens only if unambiguous and long enough.
    if (glossary[key] && (token === token.toUpperCase() || key.length >= 4) && !STOPWORDS.has(key)) {
      if (!expansions.some((e) => e.abbr === key)) expansions.push({ abbr: key, expansion: glossary[key] });
    }
  }
  return expansions;
}

function contentTerms(text) {
  return (text.toLowerCase().match(/[a-z0-9₹%][a-z0-9.%-]*/g) || [])
    .map((t) => t.replace(/[.-]+$/, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * @param {string} query
 * @param {{history?: {role:string, content:string}[]}} [opts]
 */
function analyze(query, opts = {}) {
  const q = String(query || "").trim();
  const expansions = expandAbbreviations(q);
  const categories = detectCategories(q);
  const terms = contentTerms(q);
  const history = opts.history || [];
  const lastUser = [...history].reverse().find((m) => m.role === "user" && m.content && m.content.trim() !== q);
  // A follow-up leans on the previous question ("what about for NBFCs?",
  // "and its time limit?"). A complete question is never rewritten.
  const followUp =
    !!lastUser &&
    (FOLLOW_UP.test(q) ||
      (/\b(it|its|this|that|these|those|they|them|same|above)\b/i.test(q) && terms.length <= 6) ||
      terms.length <= 1);
  return {
    query: q,
    smalltalk: SMALLTALK.test(q),
    intent: {
      definition: DEFINITION_INTENT.test(q) && !NUMERIC_INTENT.test(q.replace(/what is the/i, "")),
      numeric: NUMERIC_INTENT.test(q),
    },
    categories,
    expansions,
    terms,
    follow_up: followUp,
    previous_query: lastUser ? lastUser.content : null,
    expanded_query: expansions.length
      ? `${q} (${expansions.map((e) => `${e.abbr.toUpperCase()}: ${e.expansion}`).join("; ")})`
      : q,
  };
}

module.exports = { analyze, init, reset, contentTerms, STOPWORDS, detectCategories };
