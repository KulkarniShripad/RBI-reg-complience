/**
 * Uploaded file -> pages of text lines, whatever the format.
 *
 *   pdf        scripts/extract_document.py (PyMuPDF), table cells joined " | "
 *   xlsx       every sheet is a "page", every row a line of cells joined " | "
 *   csv / tsv  one page, rows joined " | "
 *   txt / md   pages split on form feeds (or every 80 lines)
 *   html       tags stripped, block elements become lines
 *   json       {bank_name?, period?, as_of_date?, metrics: {key: value}} or
 *              [{metric, value}] - structured figures, e.g. exported from a
 *              bank's reporting system
 *
 * Returns {format, pages:[{page, lines[]}], page_count, structured?}.
 */
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const env = require("../../config/env");

class DocumentError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.status = status;
    this.code = "document_unreadable";
  }
}

const EXT_FORMAT = {
  ".pdf": "pdf",
  ".xlsx": "xlsx",
  ".xlsm": "xlsx",
  ".csv": "csv",
  ".tsv": "csv",
  ".txt": "txt",
  ".md": "txt",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
};

function formatOf(fileName) {
  return EXT_FORMAT[path.extname(fileName || "").toLowerCase()] || null;
}

function runPython(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(env.python.bin, [path.join(env.python.scriptsDir, "extract_document.py"), filePath]);
    const out = [];
    let err = "";
    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("error", (e) => reject(new DocumentError(`Python is needed to read PDFs (${env.python.bin}): ${e.message}`, 500)));
    proc.on("close", (code) => {
      if (code !== 0) {
        const missing = /No module named ['"]?pymupdf|No module named ['"]?fitz/i.test(err);
        return reject(
          new DocumentError(
            missing
              ? "PyMuPDF is not installed for the Python the backend uses. Run: python3 -m pip install -r scripts/requirements.txt"
              : err.trim() || `PDF extraction failed (exit ${code})`,
            missing ? 500 : 422
          )
        );
      }
      try {
        resolve(JSON.parse(Buffer.concat(out).toString("utf8")));
      } catch (e) {
        reject(new DocumentError(`PDF extraction returned invalid output: ${e.message}`, 500));
      }
    });
  });
}

function cellText(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).replace(/\s+/g, " ").trim();
}

async function parseXlsx(filePath) {
  const readXlsxFile = require("read-excel-file/node").default;
  let sheets;
  try {
    sheets = await readXlsxFile(fs.createReadStream(filePath));
  } catch (e) {
    throw new DocumentError(`Could not read the spreadsheet: ${e.message}`);
  }
  return {
    format: "xlsx",
    pages: sheets.map((s, i) => ({
      page: i + 1,
      sheet: s.sheet,
      lines: s.data.map((row) => row.map(cellText).filter(Boolean).join(" | ")).filter(Boolean),
    })),
  };
}

function splitCsvLine(line, sep) {
  const cells = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === sep) {
      cells.push(cur);
      cur = "";
    } else cur += c;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

function parseCsv(text) {
  const clean = text.replace(/^﻿/, "");
  const first = clean.split(/\r?\n/, 1)[0] || "";
  const sep = (first.match(/\t/g) || []).length > (first.match(/,/g) || []).length ? "\t" : ",";
  const lines = clean
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => splitCsvLine(l, sep).filter(Boolean).join(" | "));
  return { format: "csv", pages: [{ page: 1, lines }] };
}

function parseText(text) {
  const chunks = text.includes("\f") ? text.split("\f") : null;
  const all = (chunks || [text]).map((t) => t.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean));
  const pages = [];
  if (chunks) all.forEach((lines, i) => pages.push({ page: i + 1, lines }));
  else for (let i = 0; i < all[0].length; i += 80) pages.push({ page: pages.length + 1, lines: all[0].slice(i, i + 80) });
  return { format: "txt", pages: pages.length ? pages : [{ page: 1, lines: [] }] };
}

function parseHtml(html) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(td|th)>/gi, " | ")
    .replace(/<(br|\/p|\/div|\/tr|\/h\d|\/li)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8377;|&#x20b9;/gi, "₹")
    .replace(/[ \t]*\|[ \t]*(\n|$)/g, "$1");
  return { ...parseText(text), format: "html" };
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new DocumentError(`Invalid JSON: ${e.message}`);
  }
  const structured = { bank_name: null, institution_category: null, as_of_date: null, period_label: null, metrics: [] };
  const push = (k, v, extra = {}) => {
    const value = typeof v === "object" && v !== null ? v.value : v;
    const num = typeof value === "number" ? value : parseFloat(String(value).replace(/,/g, "").replace(/%$/, ""));
    if (Number.isFinite(num)) structured.metrics.push({ name: k, value: num, ...(typeof v === "object" && v ? v : {}), ...extra });
  };
  if (Array.isArray(data)) {
    for (const r of data) push(r.metric ?? r.name ?? r.key, r.value, { unit: r.unit });
  } else if (data && typeof data === "object") {
    structured.bank_name = data.bank_name ?? data.bank ?? null;
    structured.institution_category = data.institution_category ?? data.category ?? null;
    structured.as_of_date = data.as_of_date ?? data.as_on ?? null;
    structured.period_label = data.period_label ?? data.period ?? null;
    const m = data.metrics ?? data.figures ?? {};
    if (Array.isArray(m)) for (const r of m) push(r.metric ?? r.name ?? r.key, r.value, { unit: r.unit });
    else for (const [k, v] of Object.entries(m)) push(k, v);
  }
  const lines = [
    structured.bank_name && `Bank: ${structured.bank_name}`,
    structured.as_of_date && `As on: ${structured.as_of_date}`,
    ...structured.metrics.map((m) => `${m.name} | ${m.value}${m.unit ? ` ${m.unit}` : ""}`),
  ].filter(Boolean);
  return { format: "json", pages: [{ page: 1, lines }], structured };
}

/**
 * @param {string} filePath  file on disk
 * @param {string} fileName  original name (decides the format)
 */
async function parseDocument(filePath, fileName) {
  const format = formatOf(fileName);
  if (!format) {
    throw new DocumentError(
      `Unsupported file type "${path.extname(fileName || "") || fileName}". Upload a PDF, Excel (.xlsx), CSV, text, HTML or JSON file.`,
      415
    );
  }
  let parsed;
  if (format === "pdf") {
    parsed = await runPython(filePath);
    if (parsed.scanned) {
      throw new DocumentError(
        "This PDF has no text layer (it is a scanned image). Run OCR on it first (e.g. ocrmypdf) or upload the text-based version from the bank's website."
      );
    }
  } else if (format === "xlsx") parsed = await parseXlsx(filePath);
  else {
    const text = fs.readFileSync(filePath, "utf8");
    parsed = format === "csv" ? parseCsv(text) : format === "html" ? parseHtml(text) : format === "json" ? parseJson(text) : parseText(text);
  }
  parsed.page_count = parsed.pages.length;
  const chars = parsed.pages.reduce((n, p) => n + p.lines.join(" ").length, 0);
  if (chars < 20) throw new DocumentError("The file contains no readable text.");
  return parsed;
}

module.exports = { parseDocument, formatOf, DocumentError, parseCsv, parseText, parseHtml, parseJson };
