/**
 * All LLM calls in the system go through this file. Two distinct jobs,
 * kept deliberately separate because they have different reliability
 * requirements:
 *
 *   1. judgeQualitativeCoverage()  - the Subsystem 2 judgment call that
 *      was previously an honest stub in compliance_checker.py. This is a
 *      legitimate LLM-at-check-time use case: judging whether free-text
 *      evidence satisfies a free-text requirement is not something regex
 *      or deterministic code can do.
 *
 *   2. verifyVariableMapping()  - a NEW, secondary check for Subsystem 1.
 *      This does NOT replace the deterministic operator/threshold
 *      evaluation in quantService.js. It answers a narrower, safer
 *      question: "does the bank's submitted field plausibly correspond to
 *      what this clause's variable_text is describing?" If the LLM says
 *      no, that's surfaced as a WARNING on top of the deterministic
 *      PASS/BREACH/NOT_REPORTED verdict - it never overrides it. See the
 *      design note in complianceController.js for why quantitative
 *      arithmetic itself is intentionally NOT delegated to an LLM.
 *
 * Uses the strict-JSON-output pattern throughout (matches the prompt shown
 * in the original compliance_checker.py stub almost verbatim) so parsing
 * is predictable and failures are loud, not silently swallowed.
 */
const { GoogleGenerativeAI } = require("@google/generative-ai");
const env = require("../config/env");

let client = null;
function getClient() {
  if (!env.gemini.apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env and add your key before calling any LLM-backed endpoint."
    );
  }
  if (!client) client = new GoogleGenerativeAI(env.gemini.apiKey);
  return client;
}

function stripJsonFences(text) {
  return text.replace(/```json/gi, "").replace(/```/g, "").trim();
}

// Models tried in order. The configured model first, then fallbacks - so a
// retired or misspelt GEMINI_MODEL, a quota error on one model, or a
// temporary overload does not take the whole chat down.
function modelChain(primary) {
  return [...new Set([primary, ...env.gemini.fallbackModels].filter(Boolean))];
}

function isRetryable(err) {
  const msg = String(err && err.message);
  return /\b(429|500|502|503|504)\b|overloaded|unavailable|timeout|timed out|ECONNRESET|fetch failed|quota/i.test(msg);
}

function isModelMissing(err) {
  return /\b404\b|not found|is not supported|unknown model|invalid model/i.test(String(err && err.message));
}

function withTimeout(promise, ms) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`Gemini request timed out after ${ms} ms`)), ms);
    }),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One generateContent call with retries and model fallback.
 * @returns {Promise<{text: string, model: string}>}
 */
async function generate(prompt, { model = env.gemini.model, temperature = 0, json = false, maxOutputTokens } = {}) {
  const errors = [];
  for (const m of modelChain(model)) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const genModel = getClient().getGenerativeModel({ model: m });
        const result = await withTimeout(
          genModel.generateContent({
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            generationConfig: {
              temperature,
              ...(json ? { responseMimeType: "application/json" } : {}),
              ...(maxOutputTokens ? { maxOutputTokens } : {}),
            },
          }),
          env.gemini.timeoutMs
        );
        const text = result.response.text();
        if (!text || !text.trim()) throw new Error("Gemini returned an empty response");
        return { text: text.trim(), model: m };
      } catch (err) {
        errors.push(`${m}: ${err.message}`);
        if (/GEMINI_API_KEY is not set|API key not valid|API_KEY_INVALID|PERMISSION_DENIED/i.test(err.message)) {
          throw err; // no point trying other models
        }
        if (isModelMissing(err)) break; // next model
        if (isRetryable(err) && attempt < 2) {
          await sleep(600 * 2 ** attempt);
          continue;
        }
        break;
      }
    }
  }
  throw new Error(`All Gemini models failed - ${errors.slice(-3).join(" | ")}`);
}

async function callGemini(prompt, { model = env.gemini.model, temperature = 0 } = {}) {
  const { text } = await generate(prompt, { model, temperature, json: true });
  try {
    return JSON.parse(stripJsonFences(text));
  } catch (err) {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 300)}`);
  }
}

async function callGeminiText(prompt, { model = env.gemini.model, temperature = 0.2 } = {}) {
  return (await generate(prompt, { model, temperature })).text;
}

function isConfigured() {
  return !!env.gemini.apiKey;
}

/**
 * Grounded answer over numbered sources. Returns {text, model}.
 * @param {{query:string, sources:string, history?:string, strict?:boolean}} args
 */
async function answerRegulatoryQuestion({ query, sources, history = "", entityNote = "", retry = false }) {
  const prompt = `You are an assistant that explains Reserve Bank of India (RBI) regulations to bank compliance staff.
Answer the QUESTION using the numbered SOURCES, which are exact extracts from RBI Master Directions.

How to answer:
- Start with a direct answer in the first sentence. Then give the supporting detail.
- Quote numbers, percentages, amounts, time limits, conditions and exceptions exactly as the sources state them.
- Cite every factual statement with its source number in square brackets, e.g. [1] or [2][4].
- Different sources may apply to different types of institutions (commercial banks, small finance banks, NBFCs, etc.). Say which institution type each requirement applies to. If the question names an institution type, lead with that one.
- If the sources answer only part of the question, answer that part and then state briefly which part is not covered by the sources. Do not refuse when the sources are relevant.
- Do not use knowledge outside the sources. Do not invent paragraph numbers, figures or circulars.
- Keep it concise: short paragraphs or bullet points, no more than about 250 words unless the question needs a list.${
    retry
      ? "\n- The sources below were selected as the closest matches. Read them carefully: the answer is usually stated in them even when worded differently from the question."
      : ""
  }
${entityNote ? `\nNOTE: ${entityNote}\n` : ""}${history ? `\nEARLIER CONVERSATION (for context only):\n${history}\n` : ""}
QUESTION: ${query}

SOURCES:
${sources}

Answer:`;
  return generate(prompt, { temperature: 0.1, maxOutputTokens: 1200 });
}

/** Turn a follow-up ("what about NBFCs?") into a stand-alone question. */
async function rewriteFollowUp({ question, history }) {
  const prompt = `Rewrite the user's latest message as a single self-contained question about RBI regulations, using the earlier conversation only to fill in what the message refers to. Keep the user's wording where possible. Output only the rewritten question.

EARLIER CONVERSATION:
${history}

LATEST MESSAGE: ${question}

Stand-alone question:`;
  const { text } = await generate(prompt, { temperature: 0, maxOutputTokens: 120 });
  return text.replace(/^["'\s]+|["'\s]+$/g, "").split("\n")[0];
}

// ---------------------------------------------------------------------
// Subsystem 2: qualitative judgment (real implementation of the prompt
// that was previously only shown, never called, in compliance_checker.py)
// ---------------------------------------------------------------------
const QUALITATIVE_JUDGMENT_PROMPT = ({ rbiRef, page, clauseText, evidenceText }) => `You are auditing a bank's internal governance documentation against a specific RBI regulatory requirement.

REGULATORY REQUIREMENT (from ${rbiRef}, page ${page}):
"${clauseText}"

BANK'S SUBMITTED EVIDENCE (retrieved as the closest semantic match):
"${evidenceText}"

Does the submitted evidence demonstrate that the bank has actually complied with this
specific requirement? Respond in strict JSON only, with exactly these keys:
{
  "coverage": "full" | "partial" | "none",
  "justification": "<one sentence, grounded only in the evidence text above>",
  "confidence": "high" | "low"
}
Do not use any knowledge beyond the two texts above. If the evidence does not clearly
address the requirement, say so - do not infer compliance from an unrelated but
plausible-sounding excerpt.`;

async function judgeQualitativeCoverage({ rbiRef, page, clauseText, evidenceText }) {
  if (!evidenceText) {
    return { coverage: "none", justification: "No evidence above similarity threshold.", confidence: "high" };
  }
  const prompt = QUALITATIVE_JUDGMENT_PROMPT({ rbiRef, page, clauseText, evidenceText });
  return callGemini(prompt);
}

// ---------------------------------------------------------------------
// Subsystem 1 secondary check: variable mapping plausibility, NOT
// arithmetic. See file docstring above for why this boundary matters.
// ---------------------------------------------------------------------
const VARIABLE_MAPPING_PROMPT = ({ clauseText, variableText, operator, thresholdValue, thresholdUnit, submittedFieldLabel }) => `You are sanity-checking a compliance data mapping, NOT performing a calculation.

REGULATORY CLAUSE:
"${clauseText}"

The clause's constrained variable was extracted (heuristically) as:
"${variableText}"

The extracted rule is: value must be ${operator} ${thresholdValue}${thresholdUnit}.

A bank has submitted a figure under this field label:
"${submittedFieldLabel}"

Question: does the submitted field label plausibly refer to the SAME quantity as the
clause's constrained variable? This is a semantic mapping check only - do not evaluate
whether any number passes or fails the threshold, and do not perform arithmetic.

Respond in strict JSON only:
{
  "mapping_plausible": true | false,
  "reasoning": "<one sentence>",
  "confidence": "high" | "low"
}`;

async function verifyVariableMapping({
  clauseText,
  variableText,
  operator,
  thresholdValue,
  thresholdUnit,
  submittedFieldLabel,
}) {
  const prompt = VARIABLE_MAPPING_PROMPT({
    clauseText,
    variableText,
    operator,
    thresholdValue,
    thresholdUnit,
    submittedFieldLabel,
  });
  return callGemini(prompt);
}

// ---------------------------------------------------------------------
// Rule-atom refinement for the ~90% of quantitative-signal clauses that
// the regex templates in classifier.py could NOT cleanly parse (this is
// the "actually wire the LLM refinement stage" item from §8 of the
// handoff doc). Kept separate from the two functions above since it's an
// ingestion-time job, not a check-time job.
// ---------------------------------------------------------------------
const RULE_REFINEMENT_PROMPT = (clauseText) => `Extract a structured rule from this RBI regulatory clause, if one genuinely exists.
The clause may contain a compound condition, a cross-referenced threshold, or no
numeric rule at all - in that case say so rather than inventing one.

CLAUSE:
"${clauseText}"

Respond in strict JSON only:
{
  "has_rule": true | false,
  "operator": "<=" | ">=" | "within_days" | null,
  "threshold_value": <number> | null,
  "threshold_unit": "<string like '%' or 'days'>" | null,
  "variable_text": "<what quantity the threshold constrains, in the clause's own words>" | null,
  "notes": "<brief note if this clause could not be cleanly reduced to one rule, e.g. compound condition>"
}`;

async function refineRuleAtom(clauseText) {
  return callGemini(RULE_REFINEMENT_PROMPT(clauseText), { model: env.gemini.modelHeavy, temperature: 0 });
}

// ---------------------------------------------------------------------
// Curation-time only: suggest a mapping from a rule_atom to RBI's actual
// reporting schema (CIMS return code / field tag). This is called ONCE
// per rule by a compliance officer's review workflow, NEVER at submission
// check time - see the design note in ruleMappingController.js for why
// that boundary is the actual fix for "how do we know the right figure
// was checked", not a per-submission LLM guess.
// ---------------------------------------------------------------------
const FIELD_MAPPING_PROMPT = ({ clauseText, variableText, thresholdUnit }) => `You are helping a compliance officer identify which RBI regulatory return field a clause's numeric requirement corresponds to.

CLAUSE:
"${clauseText}"

The clause's constrained variable was extracted as: "${variableText}"
Unit: ${thresholdUnit}

RBI banks report structured data via CIMS (return codes like R089, R129) or,
for returns not yet migrated, legacy XBRL taxonomies (e.g. DNBS forms for
NBFCs). You do not have access to RBI's internal taxonomy documents, so DO
NOT invent a specific return code or tag with false confidence - only
suggest one if the clause text itself names a specific known return/report
(e.g. "DSB return", "CRAR return"). Otherwise, propose a clear, unambiguous
CANONICAL LABEL a human could use to build a data-entry form, and say so
plainly if no source return is identifiable from the clause alone - a
compliance officer must look this up in the actual Master Direction's
reporting-format annex or the current RBI return schema documentation.

Respond in strict JSON only:
{
  "canonical_label": "<clear unambiguous label for a data-entry form>",
  "suggested_return_code": "<code>" | null,
  "suggested_field_tag": "<tag>" | null,
  "confidence": "high" | "low",
  "needs_human_lookup": true | false,
  "reasoning": "<one sentence>"
}`;

async function suggestFieldMapping({ clauseText, variableText, thresholdUnit }) {
  return callGemini(FIELD_MAPPING_PROMPT({ clauseText, variableText, thresholdUnit }));
}

// ---------------------------------------------------------------------
// Automatic compliance check from a bank's own documents
// (src/services/disclosure/). The LLM is only asked what the deterministic
// code could not settle, and every answer is checked afterwards: an extracted
// figure must occur in the quoted line, a detected category must be a known
// one, a rule the LLM says applies is still evaluated by plain arithmetic.
// ---------------------------------------------------------------------

async function extractDisclosureMetrics({ metrics, lines }) {
  const prompt = `You are reading lines extracted from a bank's published disclosure (annual report, Basel III Pillar 3 disclosure or financial results).
For each METRIC below, find the value the BANK ITSELF reports for the latest period in the document (the first / current-period column of a table).
Ignore regulatory minimums and requirements (e.g. "minimum CRAR of 9%"), peer or industry figures, targets and earlier periods.
Prefer standalone figures over consolidated ones. Report percentages as numbers without the % sign; report amounts in the unit the line states.

METRICS:
${metrics.map((m) => `- ${m.key}: ${m.label} (${m.description}; unit ${m.unit})`).join("\n")}

LINES (format "p<page>: <text>"):
${lines.join("\n")}

Respond in strict JSON only, one key per metric:
{ "<metric_key>": { "value": <number>, "page": <number>, "quote": "<the exact line the value is taken from>" } | null }
Use null when the metric is not reported in these lines. Never estimate or compute a value.`;
  return callGemini(prompt);
}

async function detectDisclosureProfile({ headText, categories }) {
  const prompt = `Identify the institution that published this document and the reporting date of its figures.

DOCUMENT START:
${headText}

Allowed institution categories (use the id): ${categories.map((c) => `${c.id} (${c.label})`).join(", ")}

Respond in strict JSON only:
{
  "bank_name": "<legal name as written in the document>" | null,
  "institution_category": "<one of the ids above>" | null,
  "as_of_date": "YYYY-MM-DD" | null,
  "doc_type": "pillar3" | "annual_report" | "financial_results" | "board_minutes" | "policy" | "other",
  "reasoning": "<one sentence>"
}
Use null when the document does not say. Do not guess a date that is not written in the text.`;
  return callGemini(prompt);
}

async function judgeMetricRuleApplicability({ metric, value, category, clauseText, operator, threshold, unit, rbiRef }) {
  const prompt = `A bank of category "${category}" reports ${metric.label} (${metric.description}) = ${value}${metric.unit === "%" ? "%" : ` ${metric.unit}`}.

Candidate requirement (from ${rbiRef || "an RBI Master Direction"}), extracted as: value ${operator} ${threshold}${unit || ""}
"${clauseText}"

Question: does this paragraph impose that numeric requirement DIRECTLY on the quantity the bank reported (the same measure, same basis), and does it apply to this bank's category?
Answer "no" when the paragraph constrains a different quantity (e.g. a sub-component, an eligibility condition for some permission, a limit on an instrument), or only defines or illustrates something.
Do not do any arithmetic and do not say whether the value passes.

Respond in strict JSON only:
{ "applies": true | false, "reasoning": "<one sentence>", "confidence": "high" | "low" }`;
  return callGemini(prompt);
}

async function writeComplianceSummary({ facts }) {
  const prompt = `Write a short executive summary (at most 180 words, plain prose, no headings) of an automated RBI compliance check for a bank's compliance officer.
Use ONLY the facts in the JSON below. Mention every BREACH and BUFFER_SHORTFALL with the figure, the requirement and the RBI reference.
Say which figures could not be found or need review. Do not add figures, rules or advice that are not in the facts. Do not call the bank compliant with anything that was not checked.

FACTS:
${JSON.stringify(facts)}`;
  return (await generate(prompt, { temperature: 0.1, maxOutputTokens: 600 })).text;
}

module.exports = {
  extractDisclosureMetrics,
  detectDisclosureProfile,
  judgeMetricRuleApplicability,
  writeComplianceSummary,
  generate,
  isConfigured,
  rewriteFollowUp,
  answerRegulatoryQuestion,
  judgeQualitativeCoverage,
  verifyVariableMapping,
  refineRuleAtom,
  suggestFieldMapping,
};
