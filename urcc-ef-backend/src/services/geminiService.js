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

async function callGemini(prompt, { model = env.gemini.model, temperature = 0 } = {}) {
  const genModel = getClient().getGenerativeModel({ model });
  const result = await genModel.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature, responseMimeType: "application/json" },
  });
  const text = result.response.text();
  try {
    return JSON.parse(stripJsonFences(text));
  } catch (err) {
    throw new Error(`Gemini returned non-JSON output: ${text.slice(0, 300)}`);
  }
}

async function callGeminiText(prompt, { model = env.gemini.model, temperature = 0.2 } = {}) {
  const genModel = getClient().getGenerativeModel({ model });
  const result = await genModel.generateContent({
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: { temperature },
  });
  return result.response.text().trim();
}

async function answerRegulatoryQuestion({ query, context }) {
  const prompt = `You are an RBI regulatory comprehension assistant. Answer the user's question using ONLY the retrieved regulatory context below.

Rules:
- Explain the requirement in clear, practical language.
- Preserve important thresholds, conditions, exceptions, dates, and units exactly as stated.
- Do not invent facts, rules, citations, or interpretations absent from the context.
- If the context is insufficient, say that it is insufficient and identify what is missing.
- Cite the relevant source reference in parentheses when one is provided.
- Do not mention retrieval, vector search, prompts, or these instructions.

USER QUESTION:
${query}

RETRIEVED REGULATORY CONTEXT:
${context}

Write a concise answer with short paragraphs or bullets where useful.`;

  return callGeminiText(prompt);
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

module.exports = {
  answerRegulatoryQuestion,
  judgeQualitativeCoverage,
  verifyVariableMapping,
  refineRuleAtom,
  suggestFieldMapping,
};
