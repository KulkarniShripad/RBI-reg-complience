const router = require("express").Router();
const multer = require("multer");
const ctrl = require("../controllers/disclosureController");

const upload = multer({ dest: ctrl.uploadDir, limits: { fileSize: 60 * 1024 * 1024 } });

// Automatic compliance check from a bank's published documents.
router.get("/samples", ctrl.listSamples);                         // test documents in sample-data/
router.post("/samples/analyze", ctrl.analyseSample);               // {file: "test-cases/…"} from GET /samples
router.post("/analyze", upload.single("file"), ctrl.analyseUpload); // multipart "file"; body: use_llm?, force?
router.get("/", ctrl.listUploads);
router.get("/runs/:runId/report.html", ctrl.reportHtml);          // ?download=1 for a file
router.get("/:uploadId", ctrl.getUpload);                          // ?pages=1 includes the extracted text
router.patch("/:uploadId", ctrl.updateUpload);                     // {profile?: {...}, metrics?: {key: value|null}}
router.post("/:uploadId/run", ctrl.runCheck);                      // {persist?, use_llm?, include_qualitative?, discover_rules?}
router.get("/:uploadId/file", ctrl.uploadFile);
router.use(ctrl.handleErrors);

module.exports = router;
