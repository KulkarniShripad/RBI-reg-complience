const router = require("express").Router();
const ctrl = require("../controllers/ingestController");

router.get("/watch-list", ctrl.listWatchList);
router.get("/pending-updates", ctrl.listPendingUpdates);
router.post("/scan", ctrl.triggerRbiScan); // POST /api/ingest/scan?apply=true

module.exports = router;
