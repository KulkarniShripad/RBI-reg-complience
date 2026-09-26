const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const db = require("../config/db");
const env = require("../config/env");
const { searchHybrid } = require("./queryController");
const { answerRegulatoryQuestion } = require("../services/geminiService");

const TOPIC_COLORS = ["#1d4ed8", "#047857", "#b45309", "#be123c", "#7c3aed", "#0f766e"];

function ruleQuery() {
  return `SELECT ra.*, cr.clause_text, cr.clause_type, cr.page_number, cr.section_title,
                 d.institution_category, d.rbi_ref, d.title AS document_title
          FROM rule_atoms ra
          JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri
          JOIN documents d ON d.doc_id = cr.doc_id`;
}

function mapRule(row) {
  const topic = row.institution_category || "uncategorized";
  const subtopic = row.clause_type || "general";
  const title = row.section_title || `${row.variable_text || "Regulatory requirement"} (${row.rbi_ref || "RBI"})`;
  const requirement = {
    type: row.operator,
    field: row.variable_name || row.variable_text || "reported value",
    value: row.threshold_value,
    currency: null,
    description: `${row.variable_text || "Value"} must be ${row.operator} ${row.threshold_value}${row.threshold_unit || ""}.`,
  };
  return {
    rule_id: String(row.rule_id),
    title,
    topic,
    subtopic,
    is_active: true,
    tags: [row.operator, row.threshold_unit].filter(Boolean),
    plain_language_summary: `${row.variable_text || "This requirement"} must be ${row.operator} ${row.threshold_value}${row.threshold_unit || ""}. Source: ${row.clause_text}`,
    source_circular_id: row.rbi_ref || row.document_title || "",
    effective_date: undefined,
    requirements: [requirement],
    conditions: [],
    exceptions: [],
    penalties: [],
    related_rule_ids: [],
    section_number: row.clause_uri,
    visualization_meta: { cluster_color: TOPIC_COLORS[row.rule_id % TOPIC_COLORS.length], node_label: title, cluster: topic },
  };
}

function listTopics(req, res) {
  const rows = db.prepare(`SELECT d.institution_category AS topic_id, MAX(d.institution_category) AS label,
                                  COUNT(DISTINCT ra.rule_id) AS rule_count,
                                  COUNT(DISTINCT d.rbi_ref) AS circular_count
                           FROM documents d LEFT JOIN clause_registry cr ON cr.doc_id = d.doc_id
                           LEFT JOIN rule_atoms ra ON ra.clause_uri = cr.clause_uri
                           GROUP BY d.institution_category ORDER BY topic_id`).all();
  const topics = rows.map((row, index) => ({
    topic_id: row.topic_id || "uncategorized",
    label: row.label || "Uncategorized",
    subtopics: ["quantitative", "qualitative"],
    related_topics: [],
    rule_count: row.rule_count || 0,
    active_rule_count: row.rule_count || 0,
    circular_ids: [],
    visualization_meta: { cluster_color: TOPIC_COLORS[index % TOPIC_COLORS.length] },
  }));
  res.json({ topics, total: topics.length });
}

function listRules(req, res) {
  const { topic, subtopic, search, page = 1, per_page = 20 } = req.query;
  const where = [];
  const params = [];
  if (topic) { where.push("d.institution_category = ?"); params.push(topic); }
  if (subtopic) { where.push("cr.clause_type = ?"); params.push(subtopic); }
  if (search) { where.push("(cr.clause_text LIKE ? OR d.title LIKE ? OR d.rbi_ref LIKE ?)"); params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  const suffix = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS n FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri JOIN documents d ON d.doc_id = cr.doc_id${suffix}`).get(...params).n;
  const size = Math.min(Math.max(Number(per_page), 1), 100);
  const currentPage = Math.max(Number(page), 1);
  const rows = db.prepare(`${ruleQuery()}${suffix} ORDER BY ra.rule_id LIMIT ? OFFSET ?`).all(...params, size, (currentPage - 1) * size);
  res.json({ rules: rows.map(mapRule), total, page: currentPage, per_page: size, pages: Math.ceil(total / size) });
}

function visualization(req, res) {
  const { topic, subtopic, search, limit = 200 } = req.query;
  const rows = db.prepare(`${ruleQuery()} WHERE 1=1${topic ? " AND d.institution_category = ?" : ""}${subtopic ? " AND cr.clause_type = ?" : ""}${search ? " AND cr.clause_text LIKE ?" : ""} ORDER BY ra.rule_id LIMIT ?`)
    .all(...[topic, subtopic, search && `%${search}%`, Math.min(Number(limit), 500)].filter((value) => value !== undefined));
  const nodes = rows.map((row) => ({ id: String(row.rule_id), type: "rule", label: mapRule(row).title, data: mapRule(row) }));
  res.json({ nodes, edges: [], stats: { total_rules: nodes.length, total_nodes: nodes.length, total_edges: 0, topic_stats: {} }, filters: { topics: [], subtopics: ["quantitative", "qualitative"], tags: [] }, edge_legend: {} });
}

function parseInput(data) {
  try { return JSON.parse(data); } catch (_) {
    return Object.fromEntries(data.split(/\r?\n/).map((line) => line.split(/\s*:\s*/, 2)).filter(([key, value]) => key && value));
  }
}

function evaluateCompliance(req, res) {
  const { data, topic, entity_type } = req.body || {};
  if (!data || !String(data).trim()) return res.status(400).json({ error: "Input data cannot be empty." });
  const input = parseInput(String(data));
  const rows = db.prepare(`${ruleQuery()} WHERE (? IS NULL OR d.institution_category = ?)`).all(topic || entity_type || null, topic || entity_type || null);
  const passed = [], violations = [], skipped = [];
  for (const row of rows) {
    const rule = mapRule(row);
    const keys = [row.variable_name, row.variable_text].filter(Boolean).map((key) => key.toLowerCase().replace(/[^a-z0-9]+/g, "_"));
    const key = Object.keys(input).find((candidate) => keys.includes(candidate.toLowerCase().replace(/[^a-z0-9]+/g, "_")));
    const value = key ? Number(input[key]) : NaN;
    const valid = Number.isFinite(value) && ((row.operator === "<=" && value <= row.threshold_value) || (row.operator === ">=" && value >= row.threshold_value) || (row.operator === "within_days" && value <= row.threshold_value));
    const check = { ...rule, status: Number.isFinite(value) ? (valid ? "PASS" : "VIOLATION") : "SKIPPED", violations: valid || !Number.isFinite(value) ? [] : [`${row.variable_text || "Value"} is ${value}; required ${row.operator} ${row.threshold_value}${row.threshold_unit || ""}.`], passed: valid ? [rule.requirements[0].description] : [], summary: rule.plain_language_summary, source: row.rbi_ref || row.document_title };
    if (!Number.isFinite(value)) skipped.push(check); else if (valid) passed.push(check); else violations.push(check);
  }
  const status = violations.length ? "NON_COMPLIANT" : (passed.length ? "COMPLIANT" : "INSUFFICIENT_DATA");
  res.json({ overall_status: status, input_parsed: input, topic_checked: topic || entity_type || "all", rules_evaluated: rows.length, violations_count: violations.length, passed_count: passed.length, skipped_count: skipped.length, violations, passed, summary: `${passed.length} rules passed, ${violations.length} violations, and ${skipped.length} rules lacked matching numeric input.`, checked_at: new Date().toISOString() });
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const process = spawn(env.python.bin, args, { cwd: env.python.scriptsDir });
    let output = "", error = "";
    process.stdout.on("data", (chunk) => { output += chunk; });
    process.stderr.on("data", (chunk) => { error += chunk; });
    process.on("close", (code) => code ? reject(new Error(error || `python exited ${code}`)) : resolve(output));
  });
}

function runNode(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: path.resolve(__dirname, "../..") });
    let output = "", error = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { error += chunk; });
    child.on("close", (code) => code ? reject(new Error(error || `node exited ${code}`)) : resolve(output));
  });
}

async function upload(req, res) {
  if (!req.file || path.extname(req.file.originalname).toLowerCase() !== ".pdf") return res.status(400).json({ error: "Only PDF files are accepted." });
  const topic = req.body.topic || "general";
  const destination = path.join(env.rbi.pdfStorageDir, topic);
  fs.mkdirSync(destination, { recursive: true });
  const target = path.join(destination, path.basename(req.file.originalname));
  // Multer stores uploads in /tmp, which may be a different filesystem.
  // Copying works across filesystem boundaries where rename() raises EXDEV.
  fs.copyFileSync(req.file.path, target);
  fs.unlinkSync(req.file.path);
  try {
    await runPython([path.join(env.python.scriptsDir, "incremental_ingest.py"), env.rbi.pdfStorageDir, "--db", env.db.relationalPath]);
    const result = { success: true, circular_id: path.basename(target, ".pdf"), title: req.body.title || path.basename(target, ".pdf"), topic, rules_extracted: 0, chunks_embedded: 0, word_count: 0, note: "Document ingested. Vector and full-text indexes are refreshing in the background." };
    res.status(202).json(result);

    // Vector rebuilding re-embeds the complete corpus and can take several
    // minutes. It must not keep the browser request in a loading state.
    Promise.resolve()
      .then(() => runPython([path.join(env.python.scriptsDir, "build_vectors.py")]))
      .then(() => runNode([path.join(__dirname, "../../migrations/002_build_fts_index.js")]))
      .then(() => console.log(`[upload] indexes refreshed for ${result.circular_id}`))
      .catch((error) => console.error(`[upload] index refresh failed for ${result.circular_id}:`, error));
  } catch (error) {
    return res.status(422).json({ error: error.message });
  }
}

async function ask(req, res) {
  const query = String(req.query.query || "").trim();
  if (!query) return res.status(400).json({ error: "query is required" });
  const result = await searchHybrid(query, 5, req.query.topic || null);
  const context = result.results.map((item, index) => [
    `[Source ${index + 1}]`,
    `Reference: ${item.rbi_ref || "Not provided"}`,
    `Document: ${item.doc_title || "Not provided"}`,
    `Page: ${item.page || "Not provided"}`,
    `Clause: ${item.clause_text}`,
  ].join("\n")).join("\n\n");
  let answer;
  let fallbackUsed = false;
  let answerError;
  if (!result.results.length) {
    answer = "I could not find relevant regulatory context for this question.";
    fallbackUsed = true;
  } else {
    try {
      answer = await answerRegulatoryQuestion({ query, context });
    } catch (error) {
      answer = "I found relevant regulatory text, but the language model was unavailable to explain it. Review the sources below or try again later.";
      fallbackUsed = true;
      answerError = error.message;
    }
  }
  res.json({ query, answer, relevant_rule_ids: result.results.map((item) => item.exact_rule?.rule_id).filter(Boolean).map(String), source_circulars: result.results.map((item) => item.rbi_ref).filter(Boolean), confidence: result.results.length >= 3 ? "high" : result.results.length ? "medium" : "low", sources_used: result.results.length, rules_matched: result.results.filter((item) => item.exact_rule).length, fallback_used: fallbackUsed, error: answerError, rules_detail: result.results.filter((item) => item.exact_rule).map((item) => mapRule({ ...item.exact_rule, clause_text: item.clause_text, clause_type: item.clause_type, page_number: item.page, rbi_ref: item.rbi_ref, document_title: item.doc_title, institution_category: "" })) });
}

module.exports = { ask, listTopics, listRules, visualization, evaluateCompliance, upload };