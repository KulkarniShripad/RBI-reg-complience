const fs = require("fs");
const path = require("path");
const db = require("../config/db");
const env = require("../config/env");
const categoryService = require("../services/categoryService");

function docCategories(docId) {
  return db
    .prepare("SELECT category, source FROM document_categories WHERE doc_id = ? ORDER BY rowid")
    .all(docId)
    .map((r) => ({ id: r.category, label: categoryService.label(r.category), source: r.source }));
}

function listDocuments(req, res) {
  const { institution_category, category, family, search, limit = 50, offset = 0 } = req.query;
  const where = [];
  const params = [];
  const cat = categoryService.normalise(category || institution_category);
  if (category || institution_category) {
    if (!cat) return res.status(400).json({ error: `unknown category '${category || institution_category}'` });
    where.push("d.doc_id IN (SELECT doc_id FROM document_categories WHERE category = ?)");
    params.push(cat);
  }
  if (family) {
    where.push("d.topic_families LIKE ?");
    params.push(`%"${family}"%`);
  }
  if (search) {
    where.push("(d.title LIKE ? OR d.rbi_ref LIKE ? OR d.topic LIKE ?)");
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  const suffix = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT d.doc_id, d.rbi_ref, d.title, d.topic, d.topic_families, d.institution_category, d.doc_date,
              d.last_updated_label, d.template_variant, d.total_pages, d.source, d.ingested_at
       FROM documents d${suffix} ORDER BY d.title LIMIT ? OFFSET ?`
    )
    .all(...params, Math.min(Number(limit) || 50, 500), Number(offset) || 0);
  const total = db.prepare(`SELECT COUNT(*) AS n FROM documents d${suffix}`).get(...params).n;
  res.json({
    total,
    documents: rows.map((r) => ({ ...r, topic_families: JSON.parse(r.topic_families || "[]"), categories: docCategories(r.doc_id) })),
  });
}

function getDocument(req, res) {
  const doc = db.prepare(`SELECT * FROM documents WHERE doc_id = ?`).get(req.params.docId);
  if (!doc) return res.status(404).json({ error: "document not found" });
  const counts = db
    .prepare(
      `SELECT COUNT(*) AS clauses,
              SUM(clause_role = 'obligation') AS obligations,
              SUM(clause_role = 'definition') AS definitions
       FROM clause_registry WHERE doc_id = ?`
    )
    .get(req.params.docId);
  const rules = db
    .prepare(
      `SELECT COUNT(*) AS n FROM rule_atoms ra JOIN clause_registry cr ON cr.clause_uri = ra.clause_uri
       WHERE cr.doc_id = ? AND ra.atom_kind = 'requirement'`
    )
    .get(req.params.docId).n;
  const annexes = db.prepare("SELECT annex_key, title, page_number, clause_uri FROM annexes WHERE doc_id = ?").all(req.params.docId);
  res.json({
    ...doc,
    topic_families: JSON.parse(doc.topic_families || "[]"),
    categories: docCategories(doc.doc_id),
    clause_count: counts.clauses,
    obligation_count: counts.obligations || 0,
    definition_count: counts.definitions || 0,
    rule_count: rules,
    annexes,
    pdf_available: !!resolvePdf(doc),
  });
}

function getDocumentClauses(req, res) {
  const { limit = 500, offset = 0, clause_type, role } = req.query;
  let sql = `SELECT clause_uri, paragraph_number, heading_path, clause_text, clause_role, clause_type, page_number, page_end
             FROM clause_registry WHERE doc_id = ?`;
  const params = [req.params.docId];
  if (clause_type) {
    sql += ` AND clause_type = ?`;
    params.push(clause_type);
  }
  if (role) {
    sql += ` AND clause_role = ?`;
    params.push(role);
  }
  sql += ` ORDER BY seq LIMIT ? OFFSET ?`;
  params.push(Math.min(Number(limit) || 500, 2000), Number(offset) || 0);
  res.json(db.prepare(sql).all(...params));
}

/**
 * One clause with everything needed to verify it: full text, document,
 * location, extracted rules, definitions, the paragraphs it references and
 * the paragraphs before/after it.
 */
function getClauseByUri(req, res) {
  const uri = decodeURIComponent(req.params.clauseUri || req.params[0] || "");
  const clause = db.prepare(`SELECT * FROM clause_registry WHERE clause_uri = ?`).get(uri);
  if (!clause) return res.status(404).json({ error: "clause not found", clause_uri: uri });
  const doc = db
    .prepare(`SELECT doc_id, title, rbi_ref, doc_date, last_updated_label, institution_category, total_pages, file_path FROM documents WHERE doc_id = ?`)
    .get(clause.doc_id);
  const ruleAtoms = db.prepare(`SELECT * FROM rule_atoms WHERE clause_uri = ? ORDER BY atom_kind = 'requirement' DESC, rule_id`).all(uri);
  const crossRefs = db
    .prepare(
      `SELECT x.ref_type, x.target_paragraph, x.target_annex, x.target_text, x.resolved_target_clause_uri,
              x.resolved_target_doc_id, t.clause_text AS target_clause_text, td.title AS target_doc_title
       FROM cross_references x
       LEFT JOIN clause_registry t ON t.clause_uri = x.resolved_target_clause_uri
       LEFT JOIN documents td ON td.doc_id = x.resolved_target_doc_id
       WHERE x.from_clause_uri = ?`
    )
    .all(uri)
    .map((x) => ({ ...x, target_clause_text: x.target_clause_text ? x.target_clause_text.slice(0, 800) : null }));
  const definitions = db.prepare("SELECT term, definition_text FROM definitions WHERE clause_uri = ?").all(uri);
  const neighbour = (dir) =>
    db
      .prepare(
        `SELECT clause_uri, paragraph_number, clause_role, substr(clause_text, 1, 400) AS preview FROM clause_registry
         WHERE doc_id = ? AND seq ${dir === "prev" ? "<" : ">"} ? AND clause_role NOT IN ('deleted')
         ORDER BY seq ${dir === "prev" ? "DESC" : "ASC"} LIMIT 1`
      )
      .get(clause.doc_id, clause.seq);
  const footnotes = db
    .prepare("SELECT page_number, footnote_text FROM footnotes WHERE doc_id = ? AND page_number BETWEEN ? AND ?")
    .all(clause.doc_id, clause.page_number || 0, clause.page_end || clause.page_number || 0);
  res.json({
    ...clause,
    document: doc
      ? { ...doc, file_path: undefined, categories: docCategories(doc.doc_id), pdf_available: !!resolvePdf(doc) }
      : null,
    rule_atoms: ruleAtoms,
    cross_references: crossRefs,
    definitions,
    footnotes,
    previous: neighbour("prev") || null,
    next: neighbour("next") || null,
  });
}

function resolvePdf(doc) {
  if (!doc || !doc.file_path) return null;
  const candidates = [path.resolve(env.circularsRoot, doc.file_path), doc.file_path];
  if (doc.pdf_sha256 || doc.doc_id) {
    const alt = db.prepare("SELECT file_path FROM document_files WHERE pdf_sha256 = (SELECT pdf_sha256 FROM documents WHERE doc_id = ?)").all(doc.doc_id);
    for (const a of alt) candidates.push(path.resolve(env.circularsRoot, a.file_path));
  }
  const root = path.resolve(env.circularsRoot);
  for (const c of candidates) {
    const full = path.resolve(c);
    // only serve files that live inside the circulars folder
    if (full.startsWith(root + path.sep) && fs.existsSync(full)) return full;
  }
  return null;
}

/** Stream the original PDF (open it at a page with #page=N in the browser). */
function getDocumentPdf(req, res) {
  const doc = db.prepare("SELECT doc_id, file_path, file_name, title FROM documents WHERE doc_id = ?").get(req.params.docId);
  const file = resolvePdf(doc);
  if (!file) return res.status(404).json({ error: "PDF file not found on the server" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(doc.file_name || "circular.pdf")}"`);
  fs.createReadStream(file).pipe(res);
}

function institutionCategories(req, res) {
  const rows = db.prepare(`SELECT category AS institution_category, COUNT(*) AS document_count FROM document_categories GROUP BY category`).all();
  res.json(rows.map((r) => ({ ...r, label: categoryService.label(r.institution_category) })));
}

function corpusStats(req, res) {
  const one = (sql) => db.prepare(sql).get().n;
  res.json({
    documents: one(`SELECT COUNT(*) AS n FROM documents`),
    clauses_by_type: db.prepare(`SELECT clause_type, COUNT(*) AS n FROM clause_registry GROUP BY clause_type`).all(),
    clauses_by_role: db.prepare(`SELECT clause_role, COUNT(*) AS n FROM clause_registry GROUP BY clause_role`).all(),
    rule_atoms: one(`SELECT COUNT(*) AS n FROM rule_atoms`),
    requirements: one(`SELECT COUNT(*) AS n FROM rule_atoms WHERE atom_kind = 'requirement'`),
    definitions: one(`SELECT COUNT(*) AS n FROM definitions`),
    cross_references: one(`SELECT COUNT(*) AS n FROM cross_references`),
    chunks: one(`SELECT COUNT(*) AS n FROM semantic_chunks`),
    meta: Object.fromEntries(db.prepare("SELECT key, value FROM corpus_meta").all().map((r) => [r.key, r.value])),
  });
}

module.exports = {
  listDocuments,
  getDocument,
  getDocumentClauses,
  getDocumentPdf,
  getClauseByUri,
  institutionCategories,
  corpusStats,
};
