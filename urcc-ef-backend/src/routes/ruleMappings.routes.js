const router = require("express").Router();
const ctrl = require("../controllers/ruleMappingController");

router.get("/", ctrl.listMappings); // ?approved_only=true
router.post("/:ruleId/suggest", ctrl.suggestMapping); // Gemini proposes, inert until approved
router.put("/:ruleId/approve", ctrl.approveMapping); // human approves - body: {canonical_label, cims_return_code?, cims_field_tag?, approved_by}

module.exports = router;
