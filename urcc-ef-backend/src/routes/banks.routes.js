const router = require("express").Router();
const ctrl = require("../controllers/bankController");

router.get("/", ctrl.listBanks);
router.post("/", ctrl.createBank);
router.get("/:bankId", ctrl.getBank);

router.get("/:bankId/applicable-rules", ctrl.applicableQuantRules);

router.post("/:bankId/quant-submissions", ctrl.submitQuantData);
router.get("/:bankId/quant-submissions", ctrl.listQuantSubmissions);

router.post("/:bankId/qual-evidence", ctrl.submitQualEvidence);
router.get("/:bankId/qual-evidence", ctrl.listQualEvidence);

module.exports = router;
