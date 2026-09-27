const router = require("express").Router();
const ctrl = require("../controllers/graphController");

// Reference data
router.get("/vocabulary", ctrl.vocabulary);                     // allowed entity / edge / exposure values
router.get("/rules", ctrl.listRules);                           // ?category= rule catalog with resolved source clauses
router.get("/scenarios", ctrl.listScenarios);                   // synthetic sample networks
router.post("/scenarios/:scenarioId/load", ctrl.loadScenario);  // { period_label, bank_id?, force? }
router.get("/runs/:graphRunId", ctrl.getRun);

// One bank's network
router.get("/:bankId", ctrl.getNetwork);                        // ?period_label=
router.post("/:bankId/entities", ctrl.upsertEntities);          // { entities: [...] } or one entity
router.delete("/:bankId/entities/:entityId", ctrl.deleteEntity);
router.post("/:bankId/edges", ctrl.upsertEdges);                // { edges: [...] } or one edge
router.patch("/:bankId/edges/:edgeId", ctrl.reviewEdge);        // { status: confirmed|flagged|rebutted, review_note }
router.delete("/:bankId/edges/:edgeId", ctrl.deleteEdge);
router.post("/:bankId/exposures", ctrl.upsertExposures);        // { period_label, exposures: [...] }
router.delete("/:bankId/exposures/:exposureId", ctrl.deleteExposure);
router.put("/:bankId/capital", ctrl.setCapital);                // { period_label, tier1_capital, tier2_capital, owned_funds, paid_up_capital_reserves }
router.put("/:bankId/profile", ctrl.setProfile);                // { nbfc_layer, nbfc_is_ifc, rcb_rating }
router.post("/:bankId/import", ctrl.importNetwork);             // { period_label, replace?, entities, edges, exposures, capital?, profile? }
router.get("/:bankId/export", ctrl.exportNetwork);              // ?period_label=
router.post("/:bankId/check", ctrl.runCheck);                   // { period_label, include_flagged?, persist? }
router.get("/:bankId/runs", ctrl.listRuns);

module.exports = router;
