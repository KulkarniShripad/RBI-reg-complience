const router = require("express").Router();
const multer = require("multer");
const os = require("os");
const ctrl = require("../controllers/legacyController");

const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 50 * 1024 * 1024, files: 1 } });

router.get("/ask", ctrl.ask);
router.post("/ask", ctrl.ask); // body: { query, history?: [{role, content}], category? }
router.get("/topics", ctrl.listTopics);
router.get("/categories", ctrl.listCategories);
router.get("/rules", ctrl.listRules);
router.get("/visualization", ctrl.visualization);
router.post("/compliance", ctrl.evaluateCompliance);
router.post("/upload/check", ctrl.checkDuplicate); // body: { sha256 }
router.post("/upload", (req, res, next) =>
  upload.single("file")(req, res, (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "File is larger than 50 MB.", code: "too_large" });
    if (err) return next(err);
    return ctrl.upload(req, res, next);
  })
);

module.exports = router;
