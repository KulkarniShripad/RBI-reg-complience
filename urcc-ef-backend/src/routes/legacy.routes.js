const router = require("express").Router();
const multer = require("multer");
const os = require("os");
const ctrl = require("../controllers/legacyController");

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024 } });
router.get("/ask", ctrl.ask);
router.get("/topics", ctrl.listTopics);
router.get("/rules", ctrl.listRules);
router.get("/visualization", ctrl.visualization);
router.post("/compliance", ctrl.evaluateCompliance);
router.post("/upload", upload.single("file"), ctrl.upload);

module.exports = router;