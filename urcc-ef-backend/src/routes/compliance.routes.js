const router = require("express").Router();
const ctrl = require("../controllers/complianceController");

// POST body: { period_label, use_llm_mapping_check?, submitted_field_labels?, qual_sample_limit?, persist? }
router.post("/:bankId/run", ctrl.runComplianceCheck);            // fixed-hybrid baseline (blueprint §5.4 condition 4)
router.post("/:bankId/run-routed", ctrl.runRoutedComplianceCheck); // adaptive router (blueprint §5.4 condition 5)
router.post("/:bankId/compare", ctrl.compareRoutingStrategies);   // both, side by side, for RQ1
router.get("/:bankId/runs", ctrl.listRuns);
router.get("/runs/:runId", ctrl.getRun);

module.exports = router;
