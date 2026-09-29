const router = require("express").Router();
const ctrl = require("../controllers/documentController");

router.get("/stats", ctrl.corpusStats);
router.get("/institution-categories", ctrl.institutionCategories);
router.get("/clauses/simplify/by-uri/:clauseUri(*)", ctrl.simplifyClause); // plain-language restatement + meaning check
router.get("/clauses/by-uri/:clauseUri(*)", ctrl.getClauseByUri);
router.get("/", ctrl.listDocuments);
router.get("/:docId", ctrl.getDocument);
router.get("/:docId/clauses", ctrl.getDocumentClauses);
router.get("/:docId/pdf", ctrl.getDocumentPdf);

module.exports = router;
