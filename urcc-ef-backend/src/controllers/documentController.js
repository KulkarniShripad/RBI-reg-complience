const db = require("../config/db");

function listDocuments(req, res) {
  const { institution_category, limit = 50, offset = 0 } = req.query;
  let sql = `SELECT doc_id, rbi_ref, title, institution_category, template_variant, total_pages,
                    source_url, last_updated_label, superseded_by
             FROM documents`;
  const params = [];
  if (institution_category) {
    sql += ` WHERE institution_category = ?`;
    params.push(institution_category);
  }
  sql += ` ORDER BY rbi_ref DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));
  res.json(db.prepare(sql).all(...params));
}

function getDocument(req, res) {
  const doc = db.prepare(`SELECT * FROM documents WHERE doc_id = ?`).get(req.params.docId);
  if (!doc) return res.status(404).json({ error: "document not found" });
  const clauseCount = db
    .prepare(`SELECT COUNT(*) as n FROM clause_registry WHERE doc_id = ?`)
    .get(req.params.docId).n;
  res.json({ ...doc, clause_count: clauseCount });
}

function getDocumentClauses(req, res) {
  const { limit = 100, offset = 0, clause_type } = req.query;
  let sql = `SELECT * FROM clause_registry WHERE doc_id = ?`;
  const params = [req.params.docId];
  if (clause_type) {
    sql += ` AND clause_type = ?`;
    params.push(clause_type);
  }
  sql += ` ORDER BY CAST(paragraph_number AS INTEGER) LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));
  res.json(db.prepare(sql).all(...params));
}

function getClauseByUri(req, res) {
  const uri = decodeURIComponent(req.params.clauseUri);
  const clause = db.prepare(`SELECT * FROM clause_registry WHERE clause_uri = ?`).get(uri);
  if (!clause) return res.status(404).json({ error: "clause not found" });
  const ruleAtoms = db.prepare(`SELECT * FROM rule_atoms WHERE clause_uri = ?`).all(uri);
  const crossRefs = db.prepare(`SELECT * FROM cross_references WHERE from_clause_uri = ?`).all(uri);
  res.json({ ...clause, rule_atoms: ruleAtoms, cross_references: crossRefs });
}

function institutionCategories(req, res) {
  const rows = db
    .prepare(`SELECT institution_category, COUNT(*) as document_count FROM documents GROUP BY institution_category`)
    .all();
  res.json(rows);
}

function corpusStats(req, res) {
  const docs = db.prepare(`SELECT COUNT(*) as n FROM documents`).get().n;
  const clauses = db
    .prepare(`SELECT clause_type, COUNT(*) as n FROM clause_registry GROUP BY clause_type`)
    .all();
  const ruleAtoms = db.prepare(`SELECT COUNT(*) as n FROM rule_atoms`).get().n;
  const definitions = db.prepare(`SELECT COUNT(*) as n FROM definitions`).get().n;
  const crossRefs = db.prepare(`SELECT COUNT(*) as n FROM cross_references`).get().n;
  res.json({ documents: docs, clauses_by_type: clauses, rule_atoms: ruleAtoms, definitions, cross_references: crossRefs });
}

module.exports = {
  listDocuments,
  getDocument,
  getDocumentClauses,
  getClauseByUri,
  institutionCategories,
  corpusStats,
};
