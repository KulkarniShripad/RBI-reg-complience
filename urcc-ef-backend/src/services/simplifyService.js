/**
 * Plain-language restatement of a regulatory clause (journal Sec. V.H), with
 * a meaning-preservation guard.
 *
 *   rules    deterministic rewriting: one idea per sentence (list items and
 *            ";"-joined provisions are split), common legalese replaced
 *            ("shall" → "must", "in terms of" → "under", "prior to" → "before",
 *            ...), cross-reference asides and footnote markers dropped.
 *            Conditions and exceptions ("provided that", "unless", "except",
 *            "subject to") are kept verbatim.
 *   llm      Gemini rewrite when configured (simplify(text, {useLlm:true})).
 *
 * Whatever produced the rewrite, it is accepted only if it keeps every number
 * and unit, the obligation / prohibition polarity, and every exception or
 * condition marker of the source; otherwise the offending sentence falls back
 * to the original wording. The original clause is always shown next to the
 * simplification - it never replaces the source.
 */
const gemini = require("./geminiService");

const REPLACEMENTS = [
  [/\bshall not\b/gi, "must not"],
  [/\bshall\b/gi, "must"],
  [/\bis required to\b/gi, "must"],
  [/\bare required to\b/gi, "must"],
  [/\bit shall be ensured that\b/gi, "make sure that"],
  [/\bin terms of\b/gi, "under"],
  [/\bin respect of\b/gi, "for"],
  [/\bwith respect to\b/gi, "for"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequent to\b/gi, "after"],
  [/\bwith effect from\b/gi, "from"],
  [/\bin the event that\b/gi, "if"],
  [/\bin the event of\b/gi, "if there is"],
  [/\bnotwithstanding\b/gi, "despite"],
  [/\binter alia\b/gi, "among other things"],
  [/\bvis-[àa]-vis\b/gi, "compared with"],
  [/\bon an ongoing basis\b/gi, "at all times"],
  [/\bhereinafter\b/gi, ""],
  [/\bthereof\b/gi, "of it"],
  [/\btherein\b/gi, "in it"],
  [/\bcommence(s|d)?\b/gi, (m, s) => (s === "d" ? "started" : s === "s" ? "starts" : "start")],
  [/\butili[sz]e(s|d)?\b/gi, (m, s) => (s === "d" ? "used" : s === "s" ? "uses" : "use")],
  [/\bendeavour\b/gi, "try"],
  [/\bsuch\b(?= (?:bank|entity|account|loan|borrower))/gi, "that"],
  [/\bin accordance with\b/gi, "under"],
  [/\bpursuant to\b/gi, "under"],
  [/\bin order to\b/gi, "to"],
  [/\bfor the purpose of\b/gi, "for"],
  [/\bfor the purposes of\b/gi, "for"],
  [/\bon account of\b/gi, "because of"],
  [/\bby virtue of\b/gi, "because of"],
  [/\bin lieu of\b/gi, "instead of"],
  [/\bin the case of\b/gi, "for"],
  [/\bin case of\b/gi, "for"],
  [/\bwith a view to\b/gi, "to"],
  [/\bat the time of\b/gi, "when"],
  [/\ba period of\s+/gi, ""],
  [/\bfurnish(es|ed)?\b/gi, (m, s) => (s === "ed" ? "given" : s === "es" ? "gives" : "give")],
  [/\bascertain\b/gi, "check"],
  [/\bwherein\b/gi, "where"],
  [/\bwhereby\b/gi, "by which"],
  [/\bhenceforth\b/gi, "from now on"],
  [/\baforesaid\b/gi, "above"],
  [/\bforthwith\b/gi, "immediately"],
  [/\bmust (require|apply|mean|include|be deemed|stand|continue|cease)\b/gi, "will $1"],
  // numbers stated in words become digits, so the unit can follow them
  [/\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|twenty-five|thirty|forty|fifty|sixty|seventy|seventy-five|eighty|ninety|hundred|one hundred)\s+(?=per ?cent\b)/gi, (m, w) => `${WORD_NUM[w.toLowerCase()]} `],
  [/\s*\bper ?cent\b/gi, "%"],
  [/\bRWAs\b/g, "risk-weighted assets (RWAs)"],
];
const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, "twenty-five": 25, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, "seventy-five": 75, eighty: 80, ninety: 90, hundred: 100, "one hundred": 100 };
const DROP = [
  /\s*\((?:refer|see|as specified in|please refer)[^)]{0,120}\)/gi,
  /\s*\[(?:\d{1,3}|[ivx]+)\]/gi, // footnote markers
  /\bof these Directions\b/gi,
  /\s*\((?:hereinafter|herein)[^)]{0,120}\)/gi,
];

const NUM_RE = /\d+(?:\.\d+)?(?:\s*(?:%|per cent|days?|months?|years?|crore|lakh))?/gi;
const EXCEPTION = /\b(?:provided that|unless|except|subject to|other than|excluding|notwithstanding|despite)\b/gi;

const WORD_PCT = new RegExp(`\\b(${Object.keys(WORD_NUM).sort((a, b) => b.length - a.length).join("|")})\\s+(?=per ?cent\\b)`, "gi");
function numbersOf(t) {
  const digits = String(t).replace(WORD_PCT, (m, w) => `${WORD_NUM[w.toLowerCase()]} `).replace(/per ?cent/gi, "per cent");
  return (digits.match(NUM_RE) || []).map((x) => x.replace(/\s*per cent/i, "%").replace(/\s+/g, "")).sort();
}
function polarity(t) {
  const s = String(t).toLowerCase();
  return {
    prohibition: /\b(?:shall not|must not|may not|cannot|is not permitted|are not permitted|no bank shall)\b/.test(s),
    obligation: /\b(?:shall|must|is required to|are required to)\b/.test(s),
  };
}
function exceptions(t) {
  return (String(t).match(EXCEPTION) || []).map((x) => x.toLowerCase().replace("notwithstanding", "despite")).sort();
}

/** Does `out` keep the numbers, polarity and exception markers of `src`? */
function preserves(src, out) {
  const sn = numbersOf(src);
  const on = numbersOf(out);
  const missing = sn.filter((n) => !on.includes(n));
  const ps = polarity(src);
  const po = polarity(out);
  const se = exceptions(src);
  const oe = exceptions(out);
  const exMissing = se.filter((e) => !oe.includes(e));
  const problems = [];
  if (missing.length) problems.push(`numbers dropped: ${[...new Set(missing)].join(", ")}`);
  if (ps.prohibition !== po.prohibition) problems.push("prohibition changed");
  if (ps.obligation && !po.obligation && !po.prohibition) problems.push("obligation lost");
  if (exMissing.length) problems.push(`exception / condition dropped: ${[...new Set(exMissing)].join(", ")}`);
  return { ok: problems.length === 0, problems };
}

function splitProvisions(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .replace(/\s*\|\s*/g, " ")
    // list items "(i) ... (ii) ..." and "; (b)" become separate sentences
    .split(/(?:;\s*|\.\s+|:\s+)(?=\(?(?:[ivx]{1,4}|[a-z]|\d{1,2})\)\s)|;\s+(?=[A-Za-z(])|(?<=[.])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

// a long sentence becomes two at a proviso or a coordinated second obligation;
// the proviso keeps its marker ("Provided that ...")
const LONG_WORDS = 25;
function splitLong(s) {
  if ((s.match(/\S+/g) || []).length <= LONG_WORDS) return [s];
  const m = /,?\s+(?=provided that\b)|;\s+(?:and|or)\s+(?=[a-z])|,\s+and\s+(?=(?:it|the bank|banks|they|such|the entity)\s+(?:shall|must|should)\b)/i.exec(s);
  if (!m || m.index < 40 || s.length - m.index < 30) return [s];
  const head = s.slice(0, m.index).replace(/[,;]\s*$/, "");
  const tail = s.slice(m.index + m[0].length);
  return [head, ...splitLong(tail.charAt(0).toUpperCase() + tail.slice(1))];
}

function rewriteSentence(s) {
  let out = s;
  for (const re of DROP) out = out.replace(re, "");
  for (const [re, rep] of REPLACEMENTS) out = out.replace(re, rep);
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([,.;])/g, "$1").trim();
  if (out && !/[.:!?]$/.test(out)) out += ".";
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/** Rule-based simplification, sentence by sentence, each guarded. */
function simplifyRules(text) {
  const parts = splitProvisions(text).flatMap(splitLong);
  let fallbacks = 0;
  const out = parts.map((p) => {
    const r = rewriteSentence(p);
    if (preserves(p, r).ok) return r;
    fallbacks++;
    return p;
  });
  return { text: out.join(" "), sentences: out, fallbacks, method: "rules" };
}

async function simplify(text, { useLlm = false } = {}) {
  if (useLlm && gemini.isConfigured()) {
    try {
      const prompt = `Rewrite this RBI regulatory provision in plain English for a bank employee who is not a lawyer. Keep every number, unit, date, condition, exception ("provided that", "unless", "except", "subject to") and whether something is required or prohibited. Use short sentences. Do not add anything that is not in the text. Output only the rewritten text.\n\nPROVISION:\n${text}`;
      const { text: llm, model } = await gemini.generate(prompt, { temperature: 0, maxOutputTokens: 800 });
      const check = preserves(text, llm);
      if (check.ok) return { text: llm.trim(), method: "llm", model, check };
      const rb = simplifyRules(text);
      return { ...rb, method: "rules", llm_rejected: check.problems };
    } catch (err) {
      return { ...simplifyRules(text), llm_error: err.message };
    }
  }
  return simplifyRules(text);
}

// ── readability ──

function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
  return Math.max(1, m ? m.length : 1);
}
/** Flesch-Kincaid Grade Level. */
function fkgl(text) {
  const sents = String(text).split(/[.!?;:]+(?:\s|$)/).filter((s) => /[a-z]/i.test(s));
  const words = String(text).match(/[A-Za-z][A-Za-z'-]*/g) || [];
  if (!sents.length || !words.length) return null;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sents.length) + 11.8 * (syl / words.length) - 15.59;
}

module.exports = { simplify, simplifyRules, preserves, fkgl, splitProvisions };
