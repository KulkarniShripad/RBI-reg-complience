/**
 * The judgement step of the RAG + LLM modality: given the regulatory clause
 * and the bank's evidence, return one of the five decisions.
 *
 *   geminiJudge     the production judge (Gemini, JSON output, citation-
 *                   constrained prompt). Used whenever GEMINI_API_KEY is set.
 *   surrogateJudge  an offline, deterministic stand-in with the same interface,
 *                   so the router and the benchmark can be run and reproduced
 *                   without an API key. It reads the text the way the prompt
 *                   asks the LLM to: the requirement's number and direction,
 *                   the reported figure, yes/no statements, negation, hedging
 *                   and contradictions, and relevance (BGE similarity).
 *
 * Results obtained with the surrogate are labelled as such everywhere they are
 * reported; its cue lists are generic English and were fixed before the test
 * split was evaluated. It is not a claim about Gemini's accuracy.
 */
const embedding = require("../embeddingService");
const gemini = require("../geminiService");

const REL_MIN = 0.6; // BGE cosine below which a sentence is not about the clause

const NEG = /\b(?:not|no|never|none|failed to|fails to|has not|have not|does not|did not|is not|are not|was not|without|yet to|absence of|lack(?:s|ing)? )\b/i;
const HEDGE = /\b(?:plans? to|intends? to|proposes? to|will be|in due course|under preparation|draft|partially|started work|expected to be completed|in the process|being considered|awaited|estimated|approximately|around)\b/i;
const NOT_APPLICABLE = /\b(?:does not apply|not applicable|is not triggered)\b/i;
const CONTRAST = /\b(?:however|but|whereas|on the other hand)\b/i;

// embedding cache: the same clause sentences recur across many (rule, evidence) pairs
const vecCache = new Map();
async function embedCached(texts) {
  const missing = [...new Set(texts.filter((t) => !vecCache.has(t)))];
  if (missing.length) {
    const vs = await embedding.embedPassages(missing);
    missing.forEach((t, i) => vecCache.set(t, vs[i]));
  }
  return texts.map((t) => vecCache.get(t));
}

const splitSentences = (t) => String(t || "").replace(/\s+/g, " ").split(/(?<=[.;])\s+(?=[A-Z(])/).map((s) => s.trim()).filter((s) => s.length > 3);

const UPPER = /(?:not exceed|shall not be more than|not more than|up to|maximum of|ceiling of|within|no later than|not be higher than|cap(?:ped)? at|less than)[^.;]{0,80}?(\d+(?:\.\d+)?)\s*(per ?cent|%|calendar days|working days|days|months)/i;
const LOWER = /(?:at least|not less than|minimum(?: of)?|not be less than|shall maintain[^.;]{0,50}?of)[^.;]{0,80}?(\d+(?:\.\d+)?)\s*(per ?cent|%)/i;

function thresholdIn(text) {
  const u = UPPER.exec(text);
  const l = LOWER.exec(text);
  const pickU = u && (!l || u.index < l.index);
  const m = pickU ? u : l;
  if (!m) return null;
  return { op: pickU ? "<=" : ">=", value: Number(m[1]), unit: /day|month/i.test(m[2]) ? "days" : "%" };
}

function numbersIn(text, unit) {
  const out = [];
  const rangeRe = /range of (\d+(?:\.\d+)?)\s*%?\s*(?:to|-|and)\s*(\d+(?:\.\d+)?)/gi;
  const ranges = [];
  let r;
  while ((r = rangeRe.exec(text))) ranges.push([Number(r[1]), Number(r[2])]);
  const re = unit === "days" ? /(\d+(?:\.\d+)?)\s*(?:working\s+|calendar\s+)?days?\b/gi : /(\d+(?:\.\d+)?)\s*(?:%|per ?cent)/gi;
  let m;
  while ((m = re.exec(text))) out.push(Number(m[1]));
  return { values: out, ranges };
}

const cmp = { ">=": (v, t) => v >= t, "<=": (v, t) => v <= t };

async function surrogateJudge({ clauseText, evidenceText }) {
  const t0 = Date.now();
  const clauseSents = splitSentences(clauseText).slice(0, 12);
  const evSents = splitSentences(evidenceText);
  if (!evSents.length) return { decision: "INSUFFICIENT_DATA", justification: "no evidence", latency_ms: Date.now() - t0 };
  const vecs = await embedCached([...clauseSents, ...evSents]);
  const cv = vecs.slice(0, clauseSents.length);
  const ev = vecs.slice(clauseSents.length);
  const relOf = (i) => Math.max(...cv.map((c) => embedding.dot(c, ev[i])));
  const rel = ev.map((_, i) => relOf(i));
  const bestClauseIdx = (() => {
    let best = 0;
    let bs = -1;
    cv.forEach((c, j) => {
      const s = Math.max(...ev.map((e) => embedding.dot(c, e)));
      if (s > bs) (bs = s), (best = j);
    });
    return best;
  })();
  const out = (decision, why) => ({ decision, justification: why, relevance: Number(Math.max(...rel).toFixed(3)), latency_ms: Date.now() - t0 });

  if (NOT_APPLICABLE.test(evidenceText)) return out("COMPLIANT", "the evidence says the requirement's condition does not apply");

  // numbers: the requirement in the clause sentence most related to the evidence
  const th = thresholdIn(clauseSents[bestClauseIdx] || "") || thresholdIn(clauseText);
  if (th) {
    const { values, ranges } = numbersIn(evidenceText, th.unit);
    if (ranges.length) {
      const [a, b] = ranges[0];
      if (cmp[th.op](a, th.value) !== cmp[th.op](b, th.value)) return out("AMBIGUOUS", `reported range ${a}-${b} straddles ${th.op} ${th.value}`);
      return out(cmp[th.op](a, th.value) ? "COMPLIANT" : "NON_COMPLIANT", `reported range against ${th.op} ${th.value}`);
    }
    if (values.length) {
      const verdicts = new Set(values.map((v) => cmp[th.op](v, th.value)));
      if (verdicts.size > 1) return out("AMBIGUOUS", `reported figures fall on both sides of ${th.op} ${th.value}`);
      return out([...verdicts][0] ? "COMPLIANT" : "NON_COMPLIANT", `reported ${values[0]} against ${th.op} ${th.value}`);
    }
  }

  // yes / no statements and narrative polarity
  const boolYes = /requirement met[^:]*:\s*yes/i.test(evidenceText);
  const boolNo = /requirement met[^:]*:\s*no/i.test(evidenceText);
  const relevant = evSents.map((s, i) => ({ s, r: rel[i] })).filter((x) => x.r >= REL_MIN && !/requirement met/i.test(x.s));
  if (!relevant.length && !boolYes && !boolNo) return out("INSUFFICIENT_DATA", "no evidence sentence is about this requirement");
  const neg = relevant.some((x) => NEG.test(x.s));
  const pos = relevant.some((x) => !NEG.test(x.s) && !HEDGE.test(x.s));
  const hedge = relevant.some((x) => HEDGE.test(x.s));
  if ((neg && pos) || (neg && CONTRAST.test(evidenceText) && boolYes) || (boolYes && neg) || (boolNo && pos && !neg)) {
    return out("AMBIGUOUS", "the evidence both affirms and denies the requirement");
  }
  if (neg || boolNo) return out("NON_COMPLIANT", "the evidence states the requirement is not met");
  if (hedge) return out("AMBIGUOUS", "the evidence describes partial or intended implementation");
  if (pos || boolYes) return out("COMPLIANT", "the evidence states the requirement is met");
  return out("INSUFFICIENT_DATA", "no usable statement");
}

const DECISIONS = ["COMPLIANT", "NON_COMPLIANT", "INSUFFICIENT_DATA", "AMBIGUOUS", "REQUIRES_HUMAN_REVIEW"];

async function geminiJudge({ clauseText, evidenceText, asOf }) {
  const t0 = Date.now();
  const prompt = `You are an RBI compliance examiner. Decide whether the bank's evidence satisfies the regulatory requirement.

REQUIREMENT (verbatim from the RBI Master Direction):
"${clauseText}"

BANK EVIDENCE${asOf ? ` (as on ${asOf})` : ""}:
"${evidenceText}"

Rules: use only the two texts above; compare numbers exactly as written; if the requirement depends on a date or condition, apply the version / condition that holds for the evidence; do not infer compliance from intentions or plans.
Respond in strict JSON only:
{ "decision": ${DECISIONS.map((d) => `"${d}"`).join(" | ")}, "justification": "<one sentence>" }
COMPLIANT = evidence satisfies the requirement; NON_COMPLIANT = evidence affirmatively fails it; INSUFFICIENT_DATA = the needed facts are missing; AMBIGUOUS = evidence neither clearly satisfies nor violates it (e.g. partial, a range across the threshold); REQUIRES_HUMAN_REVIEW = sources contradict each other.`;
  const { text, model } = await gemini.generate(prompt, { json: true, temperature: 0, maxOutputTokens: 200 });
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json|```/g, ""));
  } catch (_) {
    parsed = { decision: "REQUIRES_HUMAN_REVIEW", justification: `unparseable output: ${text.slice(0, 80)}` };
  }
  const decision = DECISIONS.includes(parsed.decision) ? parsed.decision : "REQUIRES_HUMAN_REVIEW";
  return { decision, justification: parsed.justification || null, model, latency_ms: Date.now() - t0, prompt_chars: prompt.length };
}

function judgeFor(kind) {
  if (kind === "gemini") {
    if (!gemini.isConfigured()) throw new Error("--judge gemini needs GEMINI_API_KEY");
    return { name: "gemini", fn: geminiJudge };
  }
  return { name: "surrogate", fn: surrogateJudge };
}

module.exports = { CUES: { NEG, HEDGE, CONTRAST }, surrogateJudge, geminiJudge, judgeFor, splitSentences, thresholdIn, embedCached, REL_MIN };
