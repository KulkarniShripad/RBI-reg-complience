/**
 * Automatic compliance check from a bank's own document.
 *
 *   analyse(file)   parse -> detect bank / category / period / document type
 *                   -> extract figures (deterministic, LLM only for what is
 *                   missing, every LLM figure verified against the text)
 *                   -> stored as an upload the user can review and correct
 *   run(upload)     register the bank if needed -> store the figures for the
 *                   period -> anchored rules (arithmetic) -> other rules found
 *                   in the corpus for the remaining figures -> disclosure
 *                   completeness -> qualitative obligations the document
 *                   speaks to -> summary -> persisted as a compliance run
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("../../config/db");
const gemini = require("../geminiService");
const categoryService = require("../categoryService");
const quantService = require("../quantComplianceService");
const qualService = require("../qualComplianceService");
const catalog = require("./metricCatalog");
const parser = require("./documentParser");
const detector = require("./profileDetector");
const extractor = require("./metricExtractor");
const rules = require("./regulatoryRules");
const discovery = require("./ruleDiscovery");
const checklist = require("./disclosureChecklist");
const docQual = require("./documentQualitative");

const STORAGE_DIR = path.resolve(__dirname, "..", "..", "..", "data", "disclosures");

class DisclosureError extends Error {
  constructor(message, status = 400, details) {
    super(message);
    this.status = status;
    this.code = "disclosure_error";
    if (details) this.details = details;
  }
}

const SEVERITY = {
  BREACH: 6,
  BUFFER_SHORTFALL: 5,
  TARGET_SHORTFALL: 4,
  NEEDS_REVIEW: 3,
  LIKELY_MISSING: 2,
  CANDIDATE: 2,
  NOT_DISCLOSED: 1,
  PASS_WITH_CONDITIONS: 1,
  PASS: 0,
};

const CORE_METRICS = ["crar", "cet1_ratio", "tier1_ratio", "leverage_ratio", "lcr", "nsfr", "gross_npa_pct", "net_npa_pct", "pcr"];

function slug(name) {
  return (
    String(name || "BANK")
      .replace(/\b(limited|ltd\.?)\b/gi, "")
      .replace(/[^A-Za-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toUpperCase()
      .slice(0, 40) || "BANK"
  );
}

const normName = (s) => String(s || "").toLowerCase().replace(/\b(the|limited|ltd)\b/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function matchRegisteredBank(name) {
  if (!name) return null;
  const n = normName(name);
  return db.prepare("SELECT * FROM banks").all().find((b) => normName(b.bank_name) === n || normName(b.bank_id) === n) || null;
}

// ── LLM fallbacks (verified) ──

const KEYWORDS = {
  crar: /crar|capital\s+adequacy|capital\s+to\s+risk|total\s+capital\s+ratio/i,
  cet1_ratio: /cet\s*1|common\s+equity/i,
  tier1_ratio: /tier[\s-]*(?:1|i)\b/i,
  leverage_ratio: /leverage/i,
  lcr: /liquidity\s+coverage|\blcr\b/i,
  nsfr: /stable\s+funding|\bnsfr\b/i,
  gross_npa_pct: /gross\s+(?:npa|non)|\bgnpa/i,
  net_npa_pct: /net\s+(?:npa|non)|\bnnpa/i,
  pcr: /provision(?:ing)?\s+coverage|\bpcr\b/i,
  total_deposits: /deposits/i,
  net_worth: /net\s+worth/i,
};

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9.%]+/g, "");

async function llmFillMetrics(pages, metrics, wanted) {
  const missing = wanted.filter((k) => !metrics[k] || metrics[k].confidence === "low");
  if (!missing.length) return { asked: [], added: [] };
  const lines = [];
  for (const p of pages) {
    for (const l of p.lines) {
      if (missing.some((k) => KEYWORDS[k] && KEYWORDS[k].test(l)) && /\d/.test(l)) lines.push(`p${p.page}: ${l.slice(0, 260)}`);
      if (lines.length >= 220) break;
    }
    if (lines.length >= 220) break;
  }
  // few keyword lines (unusual wording): give the LLM the other lines with numbers as well
  if (lines.length < 40) {
    const have = new Set(lines);
    for (const p of pages) {
      for (const l of p.lines) {
        const entry = `p${p.page}: ${l.slice(0, 260)}`;
        if (/\d/.test(l) && !have.has(entry)) lines.push(entry);
        if (lines.length >= 220) break;
      }
      if (lines.length >= 220) break;
    }
  }
  if (!lines.length) return { asked: missing, added: [] };
  const answer = await gemini.extractDisclosureMetrics({ metrics: missing.map((k) => catalog.get(k)), lines });
  const allLines = new Map();
  pages.forEach((p) => p.lines.forEach((l) => allLines.set(squash(l), { page: p.page, line: l })));
  const added = [];
  for (const k of missing) {
    const a = answer && answer[k];
    if (!a || typeof a.value !== "number" || !a.quote) continue;
    // the quoted line must exist in the document and contain the number
    const hit = allLines.get(squash(a.quote)) || [...allLines.values()].find((x) => squash(x.line).includes(squash(a.quote)));
    const numText = String(a.value);
    if (!hit || !squash(hit.line).replace(/,/g, "").includes(squash(numText))) continue;
    const metric = catalog.get(k);
    if (a.value < metric.range[0] || a.value > metric.range[1]) continue;
    const prev = metrics[k];
    metrics[k] = {
      metric_key: k,
      value: a.value,
      unit: metric.unit,
      basis: /consolidated/i.test(hit.line) ? "consolidated" : null,
      page: hit.page,
      snippet: hit.line.slice(0, 300),
      method: "llm",
      confidence: "medium",
      why: ["read by the LLM; the quoted line and number were found in the document"],
      alternatives: prev ? [{ value: prev.value, page: prev.page, snippet: prev.snippet, basis: prev.basis }] : [],
    };
    added.push(k);
  }
  return { asked: missing, added };
}

async function llmFillProfile(parsed, profile) {
  if (profile.bank_name && profile.institution_category && profile.as_of_date) return false;
  const headText = parsed.pages.slice(0, 3).flatMap((p) => p.lines).slice(0, 120).join("\n").slice(0, 6000);
  const categories = categoryService.all().filter((c) => c.id !== "multiple");
  const r = await gemini.detectDisclosureProfile({ headText, categories });
  let used = false;
  if (!profile.bank_name && r.bank_name && headText.toLowerCase().includes(String(r.bank_name).toLowerCase().slice(0, 12))) {
    profile.bank_name = r.bank_name;
    profile.evidence.bank_name = "read by the LLM from the first pages";
    used = true;
  }
  if (!profile.institution_category && categoryService.normalise(r.institution_category)) {
    profile.institution_category = categoryService.normalise(r.institution_category);
    profile.evidence.institution_category = `LLM: ${r.reasoning || ""}`.trim();
    used = true;
  }
  if (!profile.as_of_date && /^\d{4}-\d{2}-\d{2}$/.test(r.as_of_date || "")) {
    profile.as_of_date = r.as_of_date;
    profile.period_label = detector.periodForDate(r.as_of_date);
    profile.evidence.as_of_date = "read by the LLM from the first pages";
    used = true;
  }
  if (used) profile.detected_by = "rules+llm";
  return used;
}

// ── Analyse ──

function storeFile(srcPath, sha, fileName) {
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const dest = path.join(STORAGE_DIR, `${sha.slice(0, 16)}${path.extname(fileName).toLowerCase()}`);
  if (!fs.existsSync(dest)) fs.copyFileSync(srcPath, dest);
  return dest;
}

/**
 * @param {{filePath:string, fileName:string, useLlm?:boolean, force?:boolean}} args
 */
async function analyse({ filePath, fileName, useLlm = true, force = false }) {
  const bytes = fs.readFileSync(filePath);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  if (!force) {
    const existing = db.prepare("SELECT upload_id FROM disclosure_uploads WHERE sha256 = ? ORDER BY upload_id DESC").get(sha);
    if (existing) return { ...getUpload(existing.upload_id), duplicate: true };
  }

  const parsed = await parser.parseDocument(filePath, fileName);
  const profile = detector.detectProfile(parsed);
  const notes = [];

  let metrics;
  if (parsed.structured) {
    const r = extractor.metricsFromStructured(parsed.structured.metrics);
    metrics = r.metrics;
    if (r.unknown.length) notes.push(`Fields not recognised as a known figure: ${r.unknown.join(", ")}.`);
  } else {
    metrics = extractor.extractMetrics(parsed.pages).metrics;
  }

  const llm = useLlm && gemini.isConfigured();
  const llmUse = { profile: false, metrics: [] };
  if (llm && parsed.format !== "json") {
    try {
      llmUse.profile = await llmFillProfile(parsed, profile);
    } catch (err) {
      notes.push(`LLM profile detection failed: ${err.message}`);
    }
    try {
      const wanted = [...CORE_METRICS, ...(profile.institution_category === "urban_cooperative_banks" ? ["total_deposits", "net_worth"] : [])];
      const r = await llmFillMetrics(parsed.pages, metrics, wanted);
      llmUse.metrics = r.added;
    } catch (err) {
      notes.push(`LLM figure extraction failed: ${err.message}`);
    }
  } else if (!llm && useLlm) {
    notes.push("No LLM configured (GEMINI_API_KEY): figures and profile were read by the deterministic extractor only.");
  }

  profile.institution_category = categoryService.normalise(profile.institution_category) || profile.institution_category || null;
  if (profile.institution_category === "urban_cooperative_banks") {
    profile.ucb_tier = detector.ucbTierFromDeposits(metrics.total_deposits?.value);
  }
  const registered = matchRegisteredBank(profile.bank_name);
  profile.bank_id = registered?.bank_id || (profile.bank_name ? slug(profile.bank_name) : null);
  profile.registered = !!registered;
  if (registered && !profile.institution_category) profile.institution_category = registered.institution_category;

  const stored = storeFile(filePath, sha, fileName);
  const detection = { ...profile, notes, llm_used: llmUse };
  const info = db
    .prepare(
      `INSERT INTO disclosure_uploads (bank_id, file_name, stored_path, sha256, format, page_count, doc_type, period_label, as_of_date, detection_json, pages_json)
       VALUES (@bank_id, @file_name, @stored_path, @sha256, @format, @page_count, @doc_type, @period_label, @as_of_date, @detection_json, @pages_json)`
    )
    .run({
      bank_id: registered?.bank_id || null,
      file_name: fileName,
      stored_path: stored,
      sha256: sha,
      format: parsed.format,
      page_count: parsed.page_count,
      doc_type: profile.doc_type,
      period_label: profile.period_label,
      as_of_date: profile.as_of_date,
      detection_json: JSON.stringify(detection),
      pages_json: JSON.stringify(parsed.pages),
    });
  const uploadId = Number(info.lastInsertRowid);
  saveMetrics(uploadId, metrics);
  return getUpload(uploadId);
}

function saveMetrics(uploadId, metrics) {
  const del = db.prepare("DELETE FROM disclosure_metric_values WHERE upload_id = ?");
  const ins = db.prepare(
    `INSERT INTO disclosure_metric_values (upload_id, metric_key, value, unit, basis, page, snippet, method, confidence, alternatives_json)
     VALUES (@upload_id, @metric_key, @value, @unit, @basis, @page, @snippet, @method, @confidence, @alternatives_json)`
  );
  db.transaction(() => {
    del.run(uploadId);
    for (const m of Object.values(metrics)) {
      ins.run({
        upload_id: uploadId,
        metric_key: m.metric_key,
        value: m.value,
        unit: m.unit,
        basis: m.basis || null,
        page: m.page || null,
        snippet: m.snippet || null,
        method: m.method,
        confidence: m.confidence,
        alternatives_json: JSON.stringify({ alternatives: m.alternatives || [], why: m.why || [], unit_note: m.unit_note || null }),
      });
    }
  })();
}

function metricsOf(uploadId) {
  const out = {};
  for (const r of db.prepare("SELECT * FROM disclosure_metric_values WHERE upload_id = ?").all(uploadId)) {
    const extra = JSON.parse(r.alternatives_json || "{}");
    out[r.metric_key] = {
      metric_key: r.metric_key,
      label: catalog.get(r.metric_key)?.label || r.metric_key,
      value: r.value,
      unit: r.unit,
      basis: r.basis,
      page: r.page,
      snippet: r.snippet,
      method: r.method,
      confidence: r.confidence,
      alternatives: extra.alternatives || [],
      why: extra.why || [],
      unit_note: extra.unit_note || null,
    };
  }
  return out;
}

function getUpload(uploadId, { withPages = false } = {}) {
  const u = db.prepare("SELECT * FROM disclosure_uploads WHERE upload_id = ?").get(uploadId);
  if (!u) return null;
  const profile = JSON.parse(u.detection_json);
  const pages = JSON.parse(u.pages_json);
  const metrics = metricsOf(uploadId);
  const category = profile.institution_category;
  const applicable = category ? rules.rulesFor(category, profile).map((r) => r.metric) : [];
  return {
    upload_id: u.upload_id,
    file_name: u.file_name,
    format: u.format,
    page_count: u.page_count,
    sha256: u.sha256,
    status: u.status,
    created_at: u.created_at,
    has_file: !!(u.stored_path && fs.existsSync(u.stored_path)),
    profile: {
      ...profile,
      institution_label: category ? categoryService.label(category) : null,
      doc_type_label: detector.DOC_TYPE_LABELS[profile.doc_type] || profile.doc_type,
    },
    metrics,
    // what the check will look for in this document, so the review screen can
    // show "not found" rows next to the found ones
    expected_metrics: [...new Set([...applicable, ...Object.keys(metrics)])].map((k) => ({
      key: k,
      label: catalog.get(k)?.label || k,
      unit: catalog.get(k)?.unit || null,
      found: !!metrics[k],
      checked_by_rule: applicable.includes(k),
    })),
    catalog: catalog.METRICS.map((m) => ({ key: m.key, label: m.label, unit: m.unit })),
    ...(withPages ? { pages } : {}),
  };
}

function listUploads(limit = 50) {
  return db
    .prepare(
      `SELECT upload_id, bank_id, file_name, format, page_count, doc_type, period_label, status, created_at,
              json_extract(detection_json, '$.bank_name') AS bank_name
       FROM disclosure_uploads ORDER BY upload_id DESC LIMIT ?`
    )
    .all(limit);
}

/**
 * Corrections from the review screen.
 * @param {number} uploadId
 * @param {{profile?:object, metrics?:Object<string, number|null>}} patch
 */
function updateUpload(uploadId, patch = {}) {
  const u = db.prepare("SELECT * FROM disclosure_uploads WHERE upload_id = ?").get(uploadId);
  if (!u) throw new DisclosureError("upload not found", 404);
  const profile = JSON.parse(u.detection_json);
  const p = patch.profile || {};
  if (p.institution_category !== undefined) {
    const c = categoryService.normalise(p.institution_category);
    if (!c || c === "multiple") throw new DisclosureError(`Unknown institution category "${p.institution_category}".`, 400);
    profile.institution_category = c;
  }
  if (p.bank_name !== undefined) profile.bank_name = String(p.bank_name).trim() || null;
  if (p.bank_id !== undefined) profile.bank_id = String(p.bank_id).trim().toUpperCase() || null;
  if (p.period_label !== undefined) {
    if (!/^Q[1-4]-FY\d{4}-\d{2}$/.test(p.period_label)) throw new DisclosureError("period_label must look like Q1-FY2025-26", 400);
    profile.period_label = p.period_label;
  }
  if (p.as_of_date !== undefined) {
    profile.as_of_date = p.as_of_date || null;
    if (p.as_of_date && p.period_label === undefined) profile.period_label = detector.periodForDate(p.as_of_date);
  }
  if (p.doc_type !== undefined) profile.doc_type = p.doc_type;
  if (p.is_dsib !== undefined) profile.is_dsib = !!p.is_dsib;
  if (p.ucb_tier !== undefined) profile.ucb_tier = p.ucb_tier ? Number(p.ucb_tier) : null;
  for (const k of Object.keys(p)) profile.evidence && (profile.evidence[k] = profile.evidence[k] ? `${profile.evidence[k]} (corrected by user)` : "set by user");

  const metrics = metricsOf(uploadId);
  for (const [k, v] of Object.entries(patch.metrics || {})) {
    const metric = catalog.get(k);
    if (!metric) throw new DisclosureError(`Unknown figure "${k}".`, 400);
    if (v === null || v === "") {
      delete metrics[k];
      continue;
    }
    const num = Number(v);
    if (!Number.isFinite(num)) throw new DisclosureError(`${metric.label}: "${v}" is not a number.`, 400);
    if (num < metric.range[0] || num > metric.range[1]) {
      throw new DisclosureError(`${metric.label}: ${num} is outside the plausible range ${metric.range[0]}–${metric.range[1]} ${metric.unit}.`, 400);
    }
    const prev = metrics[k];
    metrics[k] = {
      metric_key: k,
      value: num,
      unit: metric.unit,
      basis: prev?.basis || null,
      page: prev?.page || null,
      snippet: prev ? `${prev.snippet || ""}` : null,
      method: "manual",
      confidence: "high",
      why: ["entered / corrected by the user"],
      alternatives: prev && prev.value !== num ? [{ value: prev.value, page: prev.page, snippet: prev.snippet, basis: prev.basis }] : [],
    };
  }
  if (profile.institution_category === "urban_cooperative_banks" && patch.profile?.ucb_tier === undefined) {
    profile.ucb_tier = detector.ucbTierFromDeposits(metrics.total_deposits?.value) ?? profile.ucb_tier ?? null;
  }
  db.prepare("UPDATE disclosure_uploads SET detection_json = ?, period_label = ?, as_of_date = ?, doc_type = ? WHERE upload_id = ?").run(
    JSON.stringify(profile),
    profile.period_label,
    profile.as_of_date,
    profile.doc_type,
    uploadId
  );
  saveMetrics(uploadId, metrics);
  return getUpload(uploadId);
}

// ── Run ──

function ensureBank(profile) {
  const existing = profile.bank_id ? db.prepare("SELECT * FROM banks WHERE bank_id = ?").get(profile.bank_id) : null;
  if (existing) {
    if (existing.institution_category !== profile.institution_category) {
      throw new DisclosureError(
        `Bank ${existing.bank_id} is registered as ${categoryService.label(existing.institution_category)}, but this document was classified as ${categoryService.label(profile.institution_category)}. Correct the category or choose another bank ID.`,
        409
      );
    }
    return { bank: existing, created: false };
  }
  db.prepare("INSERT INTO banks (bank_id, bank_name, institution_category) VALUES (?, ?, ?)").run(
    profile.bank_id,
    profile.bank_name,
    profile.institution_category
  );
  return { bank: db.prepare("SELECT * FROM banks WHERE bank_id = ?").get(profile.bank_id), created: true };
}

function evaluateAnchored(category, profile, metrics) {
  const out = [];
  for (const r of rules.rulesFor(category, profile)) {
    const source = rules.resolveSource(r);
    const metric = catalog.get(r.metric);
    const m = metrics[r.metric];
    const base = {
      id: `rule:${r.key}`,
      rule_key: r.key,
      metric_key: r.metric,
      metric_label: metric.label,
      label: r.label,
      level: r.level,
      operator: r.op,
      unit: metric.unit,
      origin: "anchored",
      rule_note: r.note || null,
      source,
    };
    if (!source.verified) {
      out.push({ ...base, status: "NEEDS_REVIEW", reported_value: m?.value ?? null, threshold: typeof r.threshold === "number" ? r.threshold : null, note: `Not applied: ${source.reason}` });
      continue;
    }
    if (!m) {
      out.push({
        ...base,
        status: "NOT_DISCLOSED",
        reported_value: null,
        threshold: typeof r.threshold === "number" ? r.threshold : null,
        note: "This figure was not found in the document. It may be published elsewhere (e.g. the Pillar 3 disclosure or the annual report); upload that document or enter the figure.",
      });
      continue;
    }
    const v = rules.evaluateRule(r, m.value, profile);
    let status = v.status;
    let note = v.note || null;
    // a low-confidence reading must not produce a BREACH on its own
    if (m.confidence === "low" && (status === "BREACH" || status === "BUFFER_SHORTFALL")) {
      status = "NEEDS_REVIEW";
      note = `${note ? `${note} ` : ""}The figure was read with low confidence; confirm it before treating this as a ${v.status === "BREACH" ? "breach" : "buffer shortfall"}.`;
    }
    out.push({
      ...base,
      status,
      reported_value: m.value,
      threshold: v.threshold,
      note,
      figure: { page: m.page, snippet: m.snippet, method: m.method, confidence: m.confidence, basis: m.basis },
    });
  }
  return out;
}

/** Fill the manual per-rule table too, where an extracted rule atom states the same threshold in the same paragraph. */
function backfillSubmissions(bankId, periodLabel, results, fileName) {
  let n = 0;
  const atoms = db.prepare("SELECT rule_id, operator, threshold_value FROM rule_atoms WHERE clause_uri = ? AND atom_kind = 'requirement'");
  for (const r of results) {
    if (r.origin !== "anchored" || r.reported_value === null || !r.source?.clause_uri || r.threshold === null) continue;
    for (const a of atoms.all(r.source.clause_uri)) {
      if (a.operator === r.operator && Math.abs(a.threshold_value - r.threshold) < 1e-9) {
        quantService.upsertSubmission({
          bankId,
          ruleId: a.rule_id,
          reportedValue: r.reported_value,
          periodLabel,
          sourceNote: `auto: ${r.metric_label} from ${fileName}${r.figure?.page ? ` p.${r.figure.page}` : ""}`,
        });
        n++;
      }
    }
  }
  return n;
}

function templateSummary(report) {
  const s = report.summary;
  const bits = [];
  const name = report.bank.bank_name;
  bits.push(
    `${name} (${report.bank.institution_label}), ${report.period_label}: ${s.rules_evaluated} of ${s.rules_applicable} applicable figure-based requirements could be checked from "${report.document.file_name}".`
  );
  const issues = report.rule_results.filter((r) => ["BREACH", "BUFFER_SHORTFALL", "TARGET_SHORTFALL"].includes(r.status));
  if (issues.length) {
    bits.push(
      `Findings: ${issues
        .map((r) => `${r.metric_label} ${r.reported_value}${r.unit === "%" ? "%" : ` ${r.unit}`} against ${r.threshold}${r.unit === "%" ? "%" : ` ${r.unit}`} (${r.status.replace(/_/g, " ").toLowerCase()}, ${r.source?.rbi_ref || "RBI"} para ${r.source?.paragraph})`)
        .join("; ")}.`
    );
  } else if (s.rules_evaluated) {
    bits.push("Every requirement that could be checked is met.");
  }
  if (s.not_disclosed) bits.push(`${s.not_disclosed} requirement(s) could not be checked because the figure is not in this document.`);
  if (s.needs_review) bits.push(`${s.needs_review} item(s) need review.`);
  if (report.disclosures.applicable) bits.push(`${s.disclosures_present} of ${s.disclosures_checked} required ${report.disclosures.set} items were found in the document.`);
  return bits.join(" ");
}

/**
 * @param {number} uploadId
 * @param {{persist?:boolean, useLlm?:boolean, includeQualitative?:boolean, discover?:boolean}} opts
 */
async function run(uploadId, { persist = true, useLlm = true, includeQualitative = true, discover = true } = {}) {
  const upload = getUpload(uploadId, { withPages: true });
  if (!upload) throw new DisclosureError("upload not found", 404);
  const profile = upload.profile;
  const missing = [];
  if (!profile.bank_name) missing.push("bank_name");
  if (!profile.institution_category || !categoryService.normalise(profile.institution_category)) missing.push("institution_category");
  if (!profile.period_label) missing.push("period_label");
  if (!profile.bank_id) missing.push("bank_id");
  if (missing.length) {
    throw new DisclosureError(`Confirm ${missing.join(", ")} before running the check (they could not be detected from the document).`, 400, { missing });
  }
  const category = profile.institution_category;
  const { bank, created } = ensureBank(profile);
  db.prepare("UPDATE disclosure_uploads SET bank_id = ? WHERE upload_id = ?").run(bank.bank_id, uploadId);

  const metrics = upload.metrics;
  const upsertMetric = db.prepare(
    `INSERT INTO bank_metric_values (bank_id, period_label, metric_key, value, unit, upload_id, page, method, confidence)
     VALUES (@bank_id, @period_label, @metric_key, @value, @unit, @upload_id, @page, @method, @confidence)
     ON CONFLICT(bank_id, period_label, metric_key) DO UPDATE SET value = excluded.value, unit = excluded.unit, upload_id = excluded.upload_id,
       page = excluded.page, method = excluded.method, confidence = excluded.confidence, updated_at = datetime('now')`
  );
  db.transaction(() => {
    for (const m of Object.values(metrics)) {
      upsertMetric.run({ bank_id: bank.bank_id, period_label: profile.period_label, metric_key: m.metric_key, value: m.value, unit: m.unit, upload_id: uploadId, page: m.page, method: m.method, confidence: m.confidence });
    }
  })();

  const anchored = evaluateAnchored(category, profile, metrics);
  const covered = new Set(anchored.filter((r) => r.status !== "NEEDS_REVIEW" || r.reported_value !== null).map((r) => r.metric_key));
  const anchoredUris = new Set(anchored.map((r) => r.source?.clause_uri).filter(Boolean));
  const discovered = discover ? await discovery.discoverRules(category, metrics, covered, anchoredUris, { useLlm }) : [];
  const ruleResults = [...anchored, ...discovered].sort((a, b) => (SEVERITY[b.status] ?? 0) - (SEVERITY[a.status] ?? 0));

  const disclosures = checklist.checkDisclosures(category, profile.doc_type, upload.pages);
  let qualitative = { applicable: false, reason: "Not requested.", results: [] };
  if (includeQualitative && ["annual_report", "policy", "board_minutes", "other"].includes(profile.doc_type)) {
    qualitative = await docQual.obligationsInDocument({ category, pages: upload.pages, useLlm });
  } else if (includeQualitative) {
    qualitative = { applicable: false, reason: "Figures-only document (Pillar 3 / results / spreadsheet): no governance narrative to assess.", results: [] };
  }
  // keep the passages that matched an obligation as evidence for the manual qualitative check
  for (const q of qualitative.results) {
    qualService.insertEvidence({ bankId: bank.bank_id, evidenceText: q.evidence_text, sourceType: profile.doc_type, periodLabel: profile.period_label });
  }
  const backfilled = backfillSubmissions(bank.bank_id, profile.period_label, anchored, upload.file_name);

  const count = (arr, st) => arr.filter((r) => r.status === st).length;
  const summary = {
    rules_applicable: anchored.length,
    rules_evaluated: anchored.filter((r) => r.source?.verified && r.reported_value !== null).length,
    pass: count(ruleResults, "PASS") + count(ruleResults, "PASS_WITH_CONDITIONS"),
    breach: count(ruleResults, "BREACH"),
    buffer_shortfall: count(ruleResults, "BUFFER_SHORTFALL"),
    target_shortfall: count(ruleResults, "TARGET_SHORTFALL"),
    not_disclosed: count(ruleResults, "NOT_DISCLOSED"),
    needs_review: count(ruleResults, "NEEDS_REVIEW") + count(qualitative.results, "NEEDS_REVIEW"),
    // unconfirmed rules found by text search (no LLM): listed for review, not findings
    candidate_rules: count(ruleResults, "CANDIDATE"),
    discovered_rules: discovered.length,
    disclosures_checked: disclosures.items.length,
    disclosures_present: count(disclosures.items, "PRESENT"),
    disclosures_missing: count(disclosures.items, "LIKELY_MISSING"),
    obligations_matched: qualitative.results.length,
    obligations_covered: count(qualitative.results, "COVERED"),
    obligations_partial: count(qualitative.results, "PARTIAL"),
    figures_found: Object.keys(metrics).length,
    submissions_backfilled: backfilled,
  };
  const overall = summary.breach
    ? "BREACH"
    : summary.buffer_shortfall || summary.target_shortfall || summary.needs_review || summary.disclosures_missing
      ? "ATTENTION"
      : summary.rules_evaluated
        ? "PASS"
        : "INSUFFICIENT_DATA";

  const report = {
    mode: "auto",
    generated_at: new Date().toISOString(),
    overall,
    bank: { ...bank, institution_label: categoryService.label(bank.institution_category), created },
    period_label: profile.period_label,
    as_of_date: profile.as_of_date,
    document: {
      upload_id: upload.upload_id,
      file_name: upload.file_name,
      format: upload.format,
      page_count: upload.page_count,
      doc_type: profile.doc_type,
      doc_type_label: profile.doc_type_label,
      sha256: upload.sha256,
    },
    profile: {
      is_dsib: !!profile.is_dsib,
      ucb_tier: profile.ucb_tier ?? null,
      detected_by: profile.detected_by,
      evidence: profile.evidence,
    },
    summary,
    figures: Object.values(metrics),
    rule_results: ruleResults,
    disclosures,
    qualitative,
    method: {
      llm_configured: gemini.isConfigured(),
      llm_requested: !!useLlm,
      deterministic: [
        "text extraction and table reconstruction",
        "figure recognition (label patterns, units, current-period column)",
        "applicable rules: the bank's category + profile (D-SIB, UCB tier), each anchored to its paragraph",
        "pass / fail arithmetic",
        "disclosure completeness",
      ],
      llm: [
        "figures the patterns could not find (each verified against the quoted line)",
        "bank / category / date when not detectable",
        "whether a rule found by text search really constrains the figure",
        "whether a governance passage demonstrates an obligation",
        "the executive summary (from the findings only)",
      ],
    },
    notes: [
      ...(profile.notes || []),
      ...(created ? [`Bank ${bank.bank_id} was registered automatically from the document.`] : []),
      ...(summary.not_disclosed ? ["NOT_DISCLOSED means the figure is not in this document; it is not a finding against the bank."] : []),
      "Public documents contain summary figures only. Borrower-level limits (single / group exposure, related-party lending) need the bank's internal data.",
    ],
  };

  let summaryText = null;
  if (useLlm && gemini.isConfigured()) {
    try {
      summaryText = await gemini.writeComplianceSummary({
        facts: {
          bank: report.bank.bank_name,
          category: report.bank.institution_label,
          period: report.period_label,
          document: report.document.doc_type_label,
          overall,
          results: ruleResults.map((r) => ({ figure: r.metric_label, reported: r.reported_value, requirement: `${r.operator} ${r.threshold}`, status: r.status, ref: r.source?.rbi_ref, para: r.source?.paragraph })),
          disclosures_missing: disclosures.items.filter((d) => d.status === "LIKELY_MISSING").map((d) => d.label),
          obligations: qualitative.results.map((q) => ({ ref: q.rbi_ref, para: q.paragraph, status: q.status })),
        },
      });
    } catch (err) {
      report.notes.push(`LLM summary failed (${err.message}); the summary below is generated from the findings.`);
    }
  }
  report.executive_summary = summaryText || templateSummary(report);
  report.executive_summary_by = summaryText ? "llm" : "template";

  let runId = null;
  if (persist) runId = persistRun(bank.bank_id, profile.period_label, report);
  db.prepare("UPDATE disclosure_uploads SET status = 'checked' WHERE upload_id = ?").run(uploadId);
  return { run_id: runId, report };
}

function persistRun(bankId, periodLabel, report) {
  const insRun = db.prepare(
    `INSERT INTO compliance_runs (bank_id, period_label, summary_json, quant_checked, quant_breach, qual_checked, qual_gap)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insDetail = db.prepare(
    `INSERT INTO compliance_run_details (run_id, clause_uri, check_type, status, detail_json) VALUES (?, ?, ?, ?, ?)`
  );
  return db.transaction(() => {
    const s = report.summary;
    const info = insRun.run(bankId, periodLabel, "{}", s.rules_evaluated, s.breach, s.disclosures_checked + s.obligations_matched, s.disclosures_missing);
    const runId = Number(info.lastInsertRowid);
    report.run_id = runId;
    db.prepare("UPDATE compliance_runs SET summary_json = ? WHERE run_id = ?").run(JSON.stringify(report), runId);
    for (const r of report.rule_results) {
      insDetail.run(runId, r.source?.clause_uri || `metric:${r.metric_key}`, "quantitative", r.status, JSON.stringify({ kind: "metric_rule", ...r }));
    }
    for (const d of report.disclosures.items) {
      insDetail.run(runId, d.source?.clause_uri || d.key, "qualitative", d.status, JSON.stringify({ kind: "disclosure_item", ...d }));
    }
    for (const q of report.qualitative.results) {
      insDetail.run(runId, q.clause_uri, "qualitative", q.status, JSON.stringify({ kind: "document_obligation", ...q }));
    }
    return runId;
  })();
}

function storedFile(uploadId) {
  const u = db.prepare("SELECT stored_path, file_name, format FROM disclosure_uploads WHERE upload_id = ?").get(uploadId);
  if (!u || !u.stored_path || !fs.existsSync(u.stored_path)) return null;
  return u;
}

module.exports = { analyse, run, getUpload, listUploads, updateUpload, storedFile, DisclosureError, slug, STORAGE_DIR, SEVERITY };
