const router = require("express").Router();
const queryCtrl = require("../controllers/queryController");

router.get("/", queryCtrl.hybridQuery); // GET /api/query?q=...&top_k=5&institution_category=...

module.exports = router;
