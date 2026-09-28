/**
 * The automatic compliance report as one self-contained HTML page (inline CSS,
 * prints cleanly to PDF from the browser). Everything shown comes from the
 * persisted report object; nothing is recomputed here.
 */
const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const STATUS = {
  PASS: ["Pass", "#166534", "#dcfce7"],
  PASS_WITH_CONDITIONS: ["Pass (conditions)", "#166534", "#ecfccb"],
  BREACH: ["Breach", "#991b1b", "#fee2e2"],
  BUFFER_SHORTFALL: ["Buffer shortfall", "#9a3412", "#ffedd5"],
  TARGET_SHORTFALL: ["Target shortfall", "#9a3412", "#ffedd5"],
  NOT_DISCLOSED: ["Not in document", "#475569", "#f1f5f9"],
  NEEDS_REVIEW: ["Needs review", "#854d0e", "#fef9c3"],
  CANDIDATE: ["Possible rule", "#854d0e", "#fef9c3"],
  PRESENT: ["Present", "#166534", "#dcfce7"],
  LIKELY_MISSING: ["Likely missing", "#9a3412", "#ffedd5"],
  COVERED: ["Covered", "#166534", "#dcfce7"],
  PARTIAL: ["Partial", "#854d0e", "#fef9c3"],
  NOT_DEMONSTRATED: ["Not demonstrated", "#9a3412", "#ffedd5"],
  EVIDENCE_FOUND: ["Evidence found", "#1e40af", "#dbeafe"],
  ATTENTION: ["Needs attention", "#9a3412", "#ffedd5"],
  INSUFFICIENT_DATA: ["Insufficient data", "#475569", "#f1f5f9"],
};

const badge = (s) => {
  const [label, fg, bg] = STATUS[s] || [s, "#334155", "#f1f5f9"];
  return `<span class="b" style="color:${fg};background:${bg}">${esc(label)}</span>`;
};

const fmt = (v, unit) => (v === null || v === undefined ? "—" : `${Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 })}${unit === "%" ? "%" : unit ? ` ${unit}` : ""}`);
const ref = (s) => (s ? `${esc(s.rbi_ref || s.doc_title || "")}${s.paragraph ? `, para ${esc(s.paragraph)}` : ""}${s.page_number ? `, p.${esc(s.page_number)}` : ""}` : "");

function renderReport(report) {
  const s = report.summary;
  const rows = report.rule_results
    .map(
      (r) => `<tr>
  <td>${badge(r.status)}</td>
  <td><b>${esc(r.label)}</b>${r.origin === "discovered" ? ' <span class="muted">(found by search)</span>' : ""}<div class="muted">${esc(r.metric_label)}</div></td>
  <td class="num">${fmt(r.reported_value, r.unit)}${r.figure?.page ? `<div class="muted">doc p.${esc(r.figure.page)} · ${esc(r.figure.confidence)}</div>` : ""}</td>
  <td class="num">${r.threshold === null || r.threshold === undefined ? "—" : `${r.operator === ">=" ? "≥" : r.operator === "<=" ? "≤" : esc(r.operator)} ${fmt(r.threshold, r.unit)}`}</td>
  <td>${ref(r.source)}${r.source?.excerpt ? `<blockquote>${esc(r.source.excerpt)}</blockquote>` : ""}${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}${r.rule_note ? `<div class="muted">${esc(r.rule_note)}</div>` : ""}</td>
</tr>`
    )
    .join("");
  const figures = report.figures
    .map(
      (f) => `<tr><td>${esc(f.label || f.metric_key)}</td><td class="num">${fmt(f.value, f.unit)}</td><td>${esc(f.basis || "")}</td><td>${f.page ? `p.${esc(f.page)}` : ""}</td><td>${esc(f.method)} · ${esc(f.confidence)}</td><td class="muted">${esc(f.snippet || "")}</td></tr>`
    )
    .join("");
  const disc = report.disclosures.items
    .map((d) => `<tr><td>${badge(d.status)}</td><td>${esc(d.label)}</td><td>${d.found ? `p.${esc(d.found.page)}` : "—"}</td><td>${ref(d.source)}</td></tr>`)
    .join("");
  const qual = report.qualitative.results
    .map(
      (q) => `<tr><td>${badge(q.status)}</td><td>${ref(q)}<blockquote>${esc(q.clause_text.slice(0, 500))}${q.clause_text.length > 500 ? "…" : ""}</blockquote></td><td>p.${esc(q.evidence_page)}<blockquote>${esc(q.evidence_text.slice(0, 400))}${q.evidence_text.length > 400 ? "…" : ""}</blockquote>${q.justification ? `<div class="note">${esc(q.justification)}</div>` : ""}</td></tr>`
    )
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Compliance report – ${esc(report.bank.bank_name)} – ${esc(report.period_label)}</title>
<style>
body{font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#0f172a;background:#fff;margin:0;padding:24px;max-width:1100px;margin:auto}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px;border-bottom:1px solid #e2e8f0;padding-bottom:4px}
.muted{color:#64748b;font-size:12px}.note{color:#854d0e;font-size:12px;margin-top:4px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #e2e8f0;padding:6px 8px;vertical-align:top;text-align:left}
th{background:#f8fafc;font-weight:600}.num{text-align:right;white-space:nowrap}
.b{display:inline-block;border-radius:999px;padding:1px 8px;font-size:12px;font-weight:600;white-space:nowrap}
blockquote{margin:4px 0 0;padding:4px 8px;border-left:3px solid #cbd5e1;color:#334155;font-size:12px;background:#f8fafc}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin:12px 0}
.card{border:1px solid #e2e8f0;border-radius:8px;padding:8px 10px}.card b{font-size:18px;display:block}
.summary{background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:10px 12px}
@media print{body{padding:0}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body>
<h1>RBI compliance report — ${esc(report.bank.bank_name)}</h1>
<div class="muted">${esc(report.bank.institution_label)} · bank ID ${esc(report.bank.bank_id)} · period ${esc(report.period_label)}${report.as_of_date ? ` (figures as on ${esc(report.as_of_date)})` : ""} · generated ${esc(report.generated_at.slice(0, 16).replace("T", " "))} UTC${report.run_id ? ` · run #${esc(report.run_id)}` : ""}</div>
<div class="muted">Source document: ${esc(report.document.file_name)} (${esc(report.document.doc_type_label)}, ${esc(report.document.page_count)} page(s))${report.profile.is_dsib ? " · D-SIB" : ""}${report.profile.ucb_tier ? ` · UCB Tier ${esc(report.profile.ucb_tier)}` : ""}</div>
<p>Overall: ${badge(report.overall)}</p>
<div class="summary">${esc(report.executive_summary)}<div class="muted">Summary written by ${report.executive_summary_by === "llm" ? "the LLM from the findings below" : "a template from the findings below"}.</div></div>
<div class="grid">
<div class="card"><b>${s.rules_evaluated}/${s.rules_applicable}</b>requirements checked</div>
<div class="card"><b>${s.breach}</b>breaches</div>
<div class="card"><b>${s.buffer_shortfall + s.target_shortfall}</b>buffer / target shortfalls</div>
<div class="card"><b>${s.not_disclosed}</b>figures not in document</div>
<div class="card"><b>${s.disclosures_present}/${s.disclosures_checked}</b>required disclosures present</div>
<div class="card"><b>${s.needs_review}</b>need review</div>
</div>
<h2>Requirements on published figures</h2>
${rows ? `<table><thead><tr><th>Status</th><th>Requirement</th><th class="num">Reported</th><th class="num">Required</th><th>RBI source</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">No figure-based requirements apply to this category.</p>'}
<h2>Figures read from the document</h2>
${figures ? `<table><thead><tr><th>Figure</th><th class="num">Value</th><th>Basis</th><th>Page</th><th>How read</th><th>Line</th></tr></thead><tbody>${figures}</tbody></table>` : '<p class="muted">No figures were recognised.</p>'}
<h2>Required disclosures${report.disclosures.set ? ` (${esc(report.disclosures.set)})` : ""}</h2>
${disc ? `<table><thead><tr><th>Status</th><th>Item</th><th>Found</th><th>Required by</th></tr></thead><tbody>${disc}</tbody></table>` : `<p class="muted">${esc(report.disclosures.reason || "Not applicable.")}</p>`}
<h2>Obligations the document addresses</h2>
${qual ? `<table><thead><tr><th>Status</th><th>RBI obligation</th><th>Passage in the document</th></tr></thead><tbody>${qual}</tbody></table>` : `<p class="muted">${esc(report.qualitative.reason || "None matched.")}</p>`}
<h2>Notes and method</h2>
<ul>${report.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
<p class="muted">Deterministic: ${esc(report.method.deterministic.join("; "))}.<br>LLM (${report.method.llm_configured && report.method.llm_requested ? "used where needed" : "not used"}): ${esc(report.method.llm.join("; "))}.</p>
<p class="muted">This is an automated screening of published information against RBI Master Directions in the corpus. It is not a supervisory assessment.</p>
</body></html>`;
}

module.exports = { renderReport };
