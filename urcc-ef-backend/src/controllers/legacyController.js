/**
 * Endpoints used by the dashboard (chat, topics, rules, upload, quick
 * compliance). They read the SQLite corpus built by scripts/db_builder.py
 * and the vector index (src/services/vectorStore.js).
 */
const db = require("../config/db");
const answerService = require("../services/answerService");
const ingestService = require("../services/ingestService");
const categoryService = require("../services/categoryService");

const TOPIC_COLORS = ["#1d4ed8", "#047857", "#b45309", "#be123c", "#7c3aed", "#0f766e", "#4d7c0f", "#9f1239", "#0369a1", "#a16207"];

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
async function ask(req, res) {
  const src = req.method === "POST" ? req.body || {} : req.query;
  const query = String(src.query || src.q || "").trim();
  if (!query) return res.status(400).json({ error: "query is required" });
  if (query.length > 2000) return res.status(400).json({ error: "query is too long (max 2000 characters)" });
  const history = Array.isArray(src.history)
    ? src.history.filter((m) => m && typeof m.content === "string" && ["user", "assistant"].includes(m.role)).slice(-8)
    : [];
  const category = src.category || src.topic || null;
  res.json(await answerService.answer({ query, history, category: category === "all" ? null : category }));
}

// ---------------------------------------------------------------------------
// Topics: computed from the database on every request, so uploads appear
// immediately. Two groupings: by institution type and by subject family.
// ---------------------------------------------------------------------------
function listTopics(req, res) {
  const docs = db
    .prepare(
      `SELECT d.doc_id, d.title, d.rbi_ref, d.topic, d.topic_families, d.doc_date, d.institution_category, d.source,
              (SELECT COUNT(*) FROM clause_registry cr WHERE cr.doc_id = d.doc_id AND cr.clause_role != 'deleted') AS clause_count,
              (SELECT COUNT(*) FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri
                 WHERE cr.doc_id = d.doc_id AND ra.atom_kind = 'requirement') AS rule_count
       FROM documents d ORDER BY d.title`
    )
    .all()
    .map((d) => ({ ...d, topic_families: JSON.parse(d.topic_families || '["other"]') }));
  const catRows = db.prepare("SELECT doc_id, category FROM document_categories").all();
  const catsByDoc = new Map();
  for (const r of catRows) {
    if (!catsByDoc.has(r.doc_id)) catsByDoc.set(r.doc_id, []);
    catsByDoc.get(r.doc_id).push(r.category);
  }
  const families = db.prepare("SELECT family_id, label FROM topic_families ORDER BY sort_order").all();
  const familyLabel = Object.fromEntries(families.map((f) => [f.family_id, f.label]));

  const docSummary = (d) => ({
    doc_id: d.doc_id,
    title: d.title,
    rbi_ref: d.rbi_ref,
    topic: d.topic,
    date: d.doc_date,
    categories: (catsByDoc.get(d.doc_id) || [d.institution_category]).map((c) => ({ id: c, label: categoryService.label(c) })),
    families: d.topic_families.map((f) => ({ id: f, label: familyLabel[f] || f })),
    clause_count: d.clause_count,
    rule_count: d.rule_count,
    uploaded: d.source === "upload",
  });

  const categories = categoryService
    .all()
    .map((c, i) => {
      const inCat = docs.filter((d) => (catsByDoc.get(d.doc_id) || [d.institution_category]).includes(c.id));
      const famCounts = {};
      inCat.forEach((d) => d.topic_families.forEach((f) => (famCounts[f] = (famCounts[f] || 0) + 1)));
      return {
        topic_id: c.id,
        label: c.label,
        kind: "institution",
        subtopics: Object.keys(famCounts).sort((a, b) => famCounts[b] - famCounts[a]).map((f) => familyLabel[f] || f),
        subtopic_ids: Object.keys(famCounts).sort((a, b) => famCounts[b] - famCounts[a]),
        related_topics: [],
        document_count: inCat.length,
        clause_count: inCat.reduce((a, d) => a + d.clause_count, 0),
        rule_count: inCat.reduce((a, d) => a + d.rule_count, 0),
        active_rule_count: inCat.reduce((a, d) => a + d.rule_count, 0),
        circular_ids: inCat.map((d) => d.rbi_ref || d.title),
        documents: inCat.map(docSummary),
        visualization_meta: { cluster_color: TOPIC_COLORS[i % TOPIC_COLORS.length] },
      };
    })
    .filter((c) => c.document_count > 0);

  const familyTopics = families
    .map((f, i) => {
      const inFam = docs.filter((d) => d.topic_families.includes(f.family_id));
      const subjects = {};
      inFam.forEach((d) => (subjects[d.topic] = (subjects[d.topic] || 0) + 1));
      return {
        topic_id: f.family_id,
        label: f.label,
        kind: "subject",
        subtopics: Object.keys(subjects).sort((a, b) => subjects[b] - subjects[a]),
        related_topics: [],
        document_count: inFam.length,
        clause_count: inFam.reduce((a, d) => a + d.clause_count, 0),
        rule_count: inFam.reduce((a, d) => a + d.rule_count, 0),
        active_rule_count: inFam.reduce((a, d) => a + d.rule_count, 0),
        circular_ids: inFam.map((d) => d.rbi_ref || d.title),
        documents: inFam.map(docSummary),
        visualization_meta: { cluster_color: TOPIC_COLORS[(i + 3) % TOPIC_COLORS.length] },
      };
    })
    .filter((f) => f.document_count > 0);

  res.json({ topics: categories, families: familyTopics, total: categories.length, documents: docs.length });
}

// ---------------------------------------------------------------------------
// Rules (rule atoms)
// ---------------------------------------------------------------------------
const OP_TEXT = { "<=": "at most", ">=": "at least", "<": "below", ">": "above", within_days: "within" };

function unitText(unit) {
  if (!unit) return "";
  if (unit === "%") return "%";
  return ` ${unit.replace(/_/g, " ")}`;
}

function mapRule(row) {
  const variable = (row.variable_text || "Value").replace(/\s+/g, " ").trim();
  const req = `${OP_TEXT[row.operator] || row.operator} ${row.threshold_value}${unitText(row.threshold_unit)}${
    row.threshold_base ? ` of ${row.threshold_base}` : ""
  }`;
  const title = `${variable.charAt(0).toUpperCase()}${variable.slice(1)}: ${req}`;
  return {
    rule_id: String(row.rule_id),
    title: title.length > 180 ? `${title.slice(0, 177)}...` : title,
    topic: row.institution_category,
    topic_label: categoryService.label(row.institution_category),
    subtopic: row.atom_kind,
    is_active: true,
    tags: [row.atom_kind, row.confidence === "high" ? "high confidence" : "needs review", row.threshold_unit].filter(Boolean),
    plain_language_summary: row.sentence || row.clause_text,
    source_circular_id: row.rbi_ref || row.document_title || "",
    document_title: row.document_title,
    doc_id: row.doc_id,
    effective_date: row.doc_date || undefined,
    requirements: [
      {
        type: row.operator,
        field: row.variable_name || variable,
        value: row.threshold_value,
        unit: row.threshold_unit,
        currency: String(row.threshold_unit || "").startsWith("₹") ? "INR" : null,
        description: `${variable} must be ${req}.`,
      },
    ],
    conditions: [],
    exceptions: [],
    penalties: [],
    related_rule_ids: [],
    section_number: row.paragraph_number,
    clause_uri: row.clause_uri,
    page: row.page_number,
    clause_text: row.clause_text,
    atom_kind: row.atom_kind,
    confidence: row.confidence,
    visualization_meta: { cluster_color: TOPIC_COLORS[row.rule_id % TOPIC_COLORS.length], node_label: title, cluster: row.institution_category },
  };
}

const RULE_SELECT = `SELECT ra.*, cr.clause_text, cr.clause_type, cr.page_number, cr.section_title, cr.paragraph_number,
                            d.doc_id, d.institution_category, d.rbi_ref, d.title AS document_title, d.doc_date
                     FROM rule_atoms ra
                     JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri
                     JOIN documents d ON d.doc_id = cr.doc_id`;

function ruleFilters(q) {
  const where = [];
  const params = [];
  const topic = q.topic && q.topic !== "all" ? q.topic : null;
  if (topic) {
    const cat = categoryService.normalise(topic);
    if (cat) {
      where.push("d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)");
      params.push(cat);
    } else {
      where.push("d.topic_families LIKE ?");
      params.push(`%"${topic}"%`);
    }
  }
  const sub = q.subtopic && q.subtopic !== "all" ? q.subtopic : null;
  if (sub) {
    if (["requirement", "condition"].includes(sub)) {
      where.push("ra.atom_kind = ?");
      params.push(sub);
    } else if (["quantitative", "qualitative", "relational", "hybrid"].includes(sub)) {
      where.push("cr.clause_type = ?");
      params.push(sub);
    } else {
      where.push("d.topic_families LIKE ?");
      params.push(`%"${sub}"%`);
    }
  }
  const kind = q.kind || (sub && ["requirement", "condition"].includes(sub) ? null : "requirement");
  if (kind && kind !== "all") {
    where.push("ra.atom_kind = ?");
    params.push(kind);
  }
  if (q.search) {
    where.push("(ra.sentence LIKE ? OR ra.variable_text LIKE ? OR d.title LIKE ? OR d.rbi_ref LIKE ?)");
    const s = `%${q.search}%`;
    params.push(s, s, s, s);
  }
  if (q.doc_id) {
    where.push("d.doc_id = ?");
    params.push(q.doc_id);
  }
  return { suffix: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
}

function listRules(req, res) {
  const { page = 1, per_page = 20 } = req.query;
  const { suffix, params } = ruleFilters(req.query);
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri JOIN documents d ON d.doc_id = cr.doc_id${suffix}`)
    .get(...params).n;
  const size = Math.min(Math.max(Number(per_page) || 20, 1), 100);
  const currentPage = Math.max(Number(page) || 1, 1);
  const rows = db
    .prepare(`${RULE_SELECT}${suffix} ORDER BY ra.confidence = 'high' DESC, d.title, cr.seq, ra.rule_id LIMIT ? OFFSET ?`)
    .all(...params, size, (currentPage - 1) * size);
  res.json({ rules: rows.map(mapRule), total, page: currentPage, per_page: size, pages: Math.max(1, Math.ceil(total / size)) });
}

function visualization(req, res) {
  const { limit = 200 } = req.query;
  const { suffix, params } = ruleFilters(req.query);
  const rows = db.prepare(`${RULE_SELECT}${suffix} ORDER BY ra.rule_id LIMIT ?`).all(...params, Math.min(Number(limit) || 200, 500));
  const nodes = rows.map((row) => ({ id: String(row.rule_id), type: "rule", label: mapRule(row).title, data: mapRule(row) }));
  res.json({
    nodes, edges: [],
    stats: { total_rules: nodes.length, total_nodes: nodes.length, total_edges: 0, topic_stats: {} },
    filters: { topics: categoryService.all().map((c) => c.id), subtopics: ["requirement", "condition"], tags: [] },
    edge_legend: {},
  });
}

// ---------------------------------------------------------------------------
// Quick compliance (free-text "field: value" input). The full workflow is
// under /api/compliance; this endpoint only evaluates figures whose names
// match a rule's canonical variable name.
// ---------------------------------------------------------------------------
function parseInput(data) {
  try {
    return JSON.parse(data);
  } catch (_) {
    return Object.fromEntries(
      data.split(/\r?\n/).map((line) => line.split(/\s*[:=]\s*/, 2)).filter(([k, v]) => k && v !== undefined)
    );
  }
}

function evaluateCompliance(req, res) {
  const { data, topic, entity_type } = req.body || {};
  if (!data || !String(data).trim()) return res.status(400).json({ error: "Input data cannot be empty." });
  const input = parseInput(String(data));
  const cat = categoryService.normalise(topic || entity_type);
  const rows = db
    .prepare(`${RULE_SELECT} WHERE ra.atom_kind = 'requirement' AND ra.variable_name IS NOT NULL${
      cat ? " AND d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)" : ""}`)
    .all(...(cat ? [cat] : []));
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "_");
  const passed = [];
  const violations = [];
  const skipped = [];
  for (const row of rows) {
    const rule = mapRule(row);
    const key = Object.keys(input).find((k) => norm(k) === norm(row.variable_name));
    const value = key !== undefined ? Number(String(input[key]).replace(/[,%₹\s]/g, "")) : NaN;
    const ok = Number.isFinite(value) && (
      (row.operator === "<=" && value <= row.threshold_value) || (row.operator === ">=" && value >= row.threshold_value) ||
      (row.operator === "<" && value < row.threshold_value) || (row.operator === ">" && value > row.threshold_value) ||
      (row.operator === "within_days" && value <= row.threshold_value));
    const check = {
      ...rule,
      status: Number.isFinite(value) ? (ok ? "PASS" : "VIOLATION") : "SKIPPED",
      violations: Number.isFinite(value) && !ok ? [`${row.variable_text} is ${value}; required ${rule.requirements[0].description}`] : [],
      passed: ok ? [rule.requirements[0].description] : [],
      summary: rule.plain_language_summary,
      source: row.rbi_ref || row.document_title,
    };
    if (!Number.isFinite(value)) skipped.push(check);
    else if (ok) passed.push(check);
    else violations.push(check);
  }
  const status = violations.length ? "NON_COMPLIANT" : passed.length ? "COMPLIANT" : "INSUFFICIENT_DATA";
  res.json({
    overall_status: status, input_parsed: input, topic_checked: cat || "all", rules_evaluated: rows.length,
    violations_count: violations.length, passed_count: passed.length, skipped_count: skipped.length,
    violations, passed,
    summary: `${passed.length} rules passed, ${violations.length} violations, and ${skipped.length} rules lacked matching numeric input.`,
    checked_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------
async function upload(req, res) {
  if (!req.file) return res.status(400).json({ error: "No file received. Choose a PDF to upload.", code: "no_file" });
  try {
    const result = await ingestService.enqueueUpload({
      tempPath: req.file.path,
      originalName: req.file.originalname,
      category: req.body.category || req.body.topic,
      title: req.body.title,
      replace: String(req.body.replace || "").toLowerCase() === "true",
    });
    res.status(201).json(result);
  } catch (err) {
    if (err instanceof ingestService.UploadError) {
      return res.status(err.status).json({ success: false, error: err.message, code: err.code, duplicate: err.code.startsWith("duplicate"), ...err.extra });
    }
    throw err;
  }
}

/** Pre-upload check from the browser: POST {sha256} -> is this file already ingested? */
function checkDuplicate(req, res) {
  const sha = String((req.body && req.body.sha256) || req.query.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) return res.status(400).json({ error: "sha256 (64 hex characters) is required" });
  const existing = ingestService.findDuplicate(sha);
  res.json({ duplicate: !!existing, existing: existing || null });
}

function listCategories(req, res) {
  const counts = Object.fromEntries(
    db.prepare("SELECT category, COUNT(*) AS n FROM document_categories GROUP BY category").all().map((r) => [r.category, r.n])
  );
  res.json({ categories: categoryService.all().map((c) => ({ id: c.id, label: c.label, document_count: counts[c.id] || 0 })) });
}

module.exports = { ask, listTopics, listRules, visualization, evaluateCompliance, upload, checkDuplicate, listCategories, mapRule };
