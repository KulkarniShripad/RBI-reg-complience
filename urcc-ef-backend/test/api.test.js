/**
 * End-to-end API tests on a throw-away database built from two real
 * circulars. Run with: npm test   (needs python3 + pymupdf, like the pipeline)
 *
 * The embedding model is deliberately unavailable here, so these tests also
 * prove the fallbacks: search degrades to keyword-only and the chat still
 * answers (extractively) instead of failing.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const REPO = path.resolve(__dirname, "..", "..");
const PDF_A = path.join(REPO, "circulars", "Urban_Cooperative_Bank", "269MDB68791ED3DA4407596FC88446FC24DF3.PDF");
const PDF_B = path.join(REPO, "circulars", "Rural_Cooperative_Bank", "315MDD4D6D28D4BD84F84A93DBB459D696D04.PDF");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "urcc-test-"));
const circulars = path.join(tmp, "circulars");
fs.mkdirSync(path.join(circulars, "Urban_Cooperative_Bank"), { recursive: true });
fs.copyFileSync(PDF_A, path.join(circulars, "Urban_Cooperative_Bank", path.basename(PDF_A)));

Object.assign(process.env, {
  NODE_ENV: "test",
  RELATIONAL_DB_PATH: path.join(tmp, "urcc_ef.db"),
  VECTOR_DB_PATH: path.join(tmp, "urcc_ef_vectors.db"),
  CIRCULARS_ROOT: circulars,
  EMBEDDING_MODEL_DIR: path.join(tmp, "no-model"),
  EMBEDDING_ALLOW_REMOTE: "false",
  EMBED_MISSING_ON_START: "false",
  GEMINI_API_KEY: "",
});

const havePdfs = fs.existsSync(PDF_A) && fs.existsSync(PDF_B);
let base;
let server;

test.before(async () => {
  if (!havePdfs) return;
  // Build a one-document corpus with the real pipeline.
  execFileSync("python3", [
    path.join(__dirname, "..", "scripts", "db_builder.py"), "build",
    "--circulars", circulars, "--db", process.env.RELATIONAL_DB_PATH, "--workers", "1",
  ], { stdio: "pipe" });
  const { app, warmUp } = require("../src/server");
  await new Promise((resolve) => {
    server = app.listen(0, () => resolve());
  });
  warmUp();
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function upload(file, fields = {}) {
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)], { type: "application/pdf" }), path.basename(file));
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  const res = await fetch(`${base}/upload`, { method: "POST", body: form });
  return { status: res.status, body: await res.json() };
}

test("health reports corpus and fallback state", { skip: !havePdfs }, async () => {
  const res = await fetch(`${base}/api/health`);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.corpus.count_documents, "1");
  assert.equal(body.llm.configured, false);
});

test("re-uploading an ingested PDF is rejected as a duplicate", { skip: !havePdfs }, async () => {
  const { status, body } = await upload(PDF_A, { category: "urban_cooperative_banks" });
  assert.equal(status, 409);
  assert.equal(body.code, "duplicate");
  assert.equal(body.duplicate, true);
  // nothing new was written into the circulars folder
  assert.equal(fs.readdirSync(path.join(circulars, "Urban_Cooperative_Bank")).length, 1);
});

test("browser pre-check finds the duplicate by SHA-256", { skip: !havePdfs }, async () => {
  const sha = require("crypto").createHash("sha256").update(fs.readFileSync(PDF_A)).digest("hex");
  const res = await fetch(`${base}/upload/check`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sha256: sha }),
  });
  const body = await res.json();
  assert.equal(body.duplicate, true);
  assert.ok(body.existing.title.includes("Urban Co-operative Banks"));
});

test("a non-PDF upload is rejected", { skip: !havePdfs }, async () => {
  const fake = path.join(tmp, "notes.pdf");
  fs.writeFileSync(fake, "this is not a pdf");
  const { status, body } = await upload(fake);
  assert.equal(status, 400);
  assert.equal(body.code, "not_pdf");
});

test("an unknown category is rejected with the valid list", { skip: !havePdfs }, async () => {
  const { status, body } = await upload(PDF_B, { category: "KYC" });
  assert.equal(status, 400);
  assert.equal(body.code, "unknown_category");
  assert.ok(body.valid_categories.some((c) => c.id === "rural_cooperative_banks"));
});

test("a new PDF is added, categorised and immediately listed under topics", { skip: !havePdfs }, async () => {
  const { status, body } = await upload(PDF_B, { category: "Rural_Cooperative_Bank" }); // legacy spelling is normalised
  assert.equal(status, 201, JSON.stringify(body));
  assert.equal(body.status, "added");
  assert.equal(body.institution_category, "rural_cooperative_banks");
  assert.ok(body.clauses > 0);
  // uploading it a second time is now a duplicate too
  const again = await upload(PDF_B);
  assert.equal(again.status, 409);

  const topics = await (await fetch(`${base}/topics`)).json();
  const rcb = topics.topics.find((t) => t.topic_id === "rural_cooperative_banks");
  assert.ok(rcb, "category appears in topics");
  assert.ok(rcb.documents.some((d) => d.doc_id === body.doc_id));
  assert.ok(topics.families.length > 0, "subject families are listed");

  const pdf = await fetch(`${base}/api/documents/${body.doc_id}/pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
});

test("chat answers from sources without an LLM and without vectors", { skip: !havePdfs }, async () => {
  const res = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: "What must a rural co-operative bank do before declaring dividend?" }),
  });
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.ok(["extractive", "not_found"].includes(body.answer_mode), body.answer_mode);
  if (body.answer_mode === "extractive") {
    assert.ok(body.sources.length > 0);
    assert.ok(body.sources[0].clause_text.length > 0, "sources carry the full clause text");
    assert.match(body.answer, /\[1\]/);
  }
  // punctuation-heavy questions must not break full-text search
  const odd = await fetch(`${base}/ask?query=${encodeURIComponent('What is "CRAR"? (sec. 5-A) *')}`);
  assert.equal(odd.status, 200);
});

test("clause detail includes document, location and neighbours", { skip: !havePdfs }, async () => {
  const docs = await (await fetch(`${base}/api/documents`)).json();
  const doc = docs.documents[0];
  const clauses = await (await fetch(`${base}/api/documents/${doc.doc_id}/clauses`)).json();
  const para = clauses.find((c) => c.paragraph_number === "2") || clauses[1];
  const detail = await (await fetch(`${base}/api/documents/clauses/by-uri/${encodeURIComponent(para.clause_uri)}`)).json();
  assert.equal(detail.clause_uri, para.clause_uri);
  assert.ok(detail.document.title);
  assert.ok(detail.page_number >= 1);
  assert.ok(detail.previous || detail.next);
});

test("LLM path: cites sources, retries once when the model claims the sources are insufficient, falls back on errors", { skip: !havePdfs }, async () => {
  const gemini = require("../src/services/geminiService");
  const orig = { isConfigured: gemini.isConfigured, answer: gemini.answerRegulatoryQuestion };
  const calls = [];
  gemini.isConfigured = () => true;
  gemini.answerRegulatoryQuestion = async (args) => {
    calls.push(args);
    if (calls.length === 1) return { text: "The provided sources do not contain enough information.", model: "stub" };
    return { text: "A bank must meet the conditions in paragraph 2 [1].", model: "stub" };
  };
  try {
    const q = "conditions for declaration of dividend by rural co-operative banks";
    const body = await (await fetch(`${base}/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
    })).json();
    assert.equal(body.answer_mode, "llm", JSON.stringify({ mode: body.answer_mode, conf: body.confidence }));
    assert.ok(calls[0].sources.includes("[1]"), "sources are numbered for citation");
    assert.equal(calls.length, 2, "re-asked once with wider context");
    assert.equal(calls[1].retry, true);
    assert.ok(body.fallbacks.some((f) => /wider/.test(f)));
    assert.match(body.answer, /\[1\]/);

    calls.length = 0;
    gemini.answerRegulatoryQuestion = async () => {
      throw new Error("All Gemini models failed - 503 overloaded");
    };
    const failed = await (await fetch(`${base}/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: q }),
    })).json();
    assert.equal(failed.answer_mode, "extractive");
    assert.match(failed.error, /503/);
    assert.ok(failed.sources.length > 0);
  } finally {
    gemini.isConfigured = orig.isConfigured;
    gemini.answerRegulatoryQuestion = orig.answer;
  }
});

test("follow-up questions carry the previous subject", { skip: !havePdfs }, async () => {
  const body = await (await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: "what about its board approval?",
      history: [
        { role: "user", content: "dividend declaration by rural co-operative banks" },
        { role: "assistant", content: "..." },
      ],
    }),
  })).json();
  assert.ok(body.rewritten_query && body.rewritten_query.includes("dividend"), body.rewritten_query);
});
