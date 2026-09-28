const db = require("../config/db");

function generateReport(bank, quantResults, qualResults) {
  const breaches = quantResults.filter((r) => r.status === "BREACH");
  const notReported = quantResults.filter((r) => r.status === "NOT_REPORTED");
  const passes = quantResults.filter((r) => r.status === "PASS");
  const gaps = qualResults.filter((r) => r.status === "LIKELY_GAP");
  const partial = qualResults.filter((r) => r.status === "PARTIAL");
  const covered = qualResults.filter((r) => r.status === "COVERED");
  const needsReview = qualResults.filter((r) => r.status === "NEEDS_REVIEW");

  const mappingWarnings = quantResults.filter(
    (r) => r.mapping_check && r.mapping_check.mapping_plausible === false
  );

  return {
    bank,
    summary: {
      quantitative_checked: quantResults.length,
      quantitative_pass: passes.length,
      quantitative_breach: breaches.length,
      quantitative_not_reported: notReported.length,
      quantitative_mapping_warnings: mappingWarnings.length,
      qualitative_checked: qualResults.length,
      qualitative_covered: covered.length,
      qualitative_partial: partial.length,
      qualitative_likely_gap: gaps.length,
      qualitative_needs_review: needsReview.length,
    },
    breaches: breaches.map((r) => ({
      clause_uri: r.clause_uri,
      rbi_ref: r.rbi_ref,
      page: r.page_number,
      rule: `${r.operator} ${r.threshold_value}${r.threshold_unit}`,
      reported: r.reported_value,
      clause_text: r.clause_text,
    })),
    mapping_warnings: mappingWarnings.map((r) => ({
      clause_uri: r.clause_uri,
      rule_id: r.rule_id,
      reasoning: r.mapping_check.reasoning,
    })),
    qualitative_gaps: gaps.map((r) => ({
      clause_uri: r.clause_uri,
      rbi_ref: r.rbi_ref,
      page: r.page_number,
      clause_text: r.clause_text,
    })),
  };
}

function persistRun({ bankId, periodLabel, report, quantResults, qualResults }) {
  const insertRun = db.prepare(
    `INSERT INTO compliance_runs (bank_id, period_label, summary_json, quant_checked, quant_breach, qual_checked, qual_gap)
     VALUES (@bankId, @periodLabel, @summaryJson, @quantChecked, @quantBreach, @qualChecked, @qualGap)`
  );
  const insertDetail = db.prepare(
    `INSERT INTO compliance_run_details (run_id, clause_uri, check_type, status, detail_json)
     VALUES (@runId, @clauseUri, @checkType, @status, @detailJson)`
  );

  const txn = db.transaction(() => {
    const info = insertRun.run({
      bankId,
      periodLabel,
      summaryJson: JSON.stringify(report),
      quantChecked: report.summary.quantitative_checked,
      quantBreach: report.summary.quantitative_breach,
      qualChecked: report.summary.qualitative_checked,
      qualGap: report.summary.qualitative_likely_gap,
    });
    const runId = info.lastInsertRowid;
    for (const r of quantResults) {
      insertDetail.run({
        runId,
        clauseUri: r.clause_uri,
        checkType: "quantitative",
        status: r.status,
        detailJson: JSON.stringify(r),
      });
    }
    for (const r of qualResults) {
      insertDetail.run({
        runId,
        clauseUri: r.clause_uri,
        checkType: "qualitative",
        status: r.status,
        detailJson: JSON.stringify(r),
      });
    }
    return runId;
  });

  return txn();
}

function listRuns(bankId) {
  return db
    .prepare(`SELECT run_id, period_label, run_at, quant_checked, quant_breach, qual_checked, qual_gap,
                     COALESCE(json_extract(summary_json, '$.mode'), 'manual') AS mode,
                     json_extract(summary_json, '$.overall') AS overall,
                     json_extract(summary_json, '$.document.file_name') AS document
              FROM compliance_runs WHERE bank_id = ? ORDER BY run_at DESC, run_id DESC`)
    .all(bankId);
}

function getRun(runId) {
  const run = db.prepare(`SELECT * FROM compliance_runs WHERE run_id = ?`).get(runId);
  if (!run) return null;
  const details = db
    .prepare(`SELECT * FROM compliance_run_details WHERE run_id = ?`)
    .all(runId)
    .map((d) => ({ ...d, detail_json: JSON.parse(d.detail_json) }));
  const report = JSON.parse(run.summary_json);
  if (report.mode === "auto") {
    // automatic document check: the report object carries every section
    return { ...run, summary_json: report, report, auto_report: report, mode: "auto", quant_results: [], qual_results: [], details };
  }
  // The dashboard's history view reads report / quant_results / qual_results
  // (the same shape POST .../run returns); details stay for API users.
  return {
    ...run,
    summary_json: report,
    report,
    quant_results: details.filter((d) => d.check_type === "quantitative").map((d) => d.detail_json),
    qual_results: details.filter((d) => d.check_type === "qualitative").map((d) => d.detail_json),
    details,
  };
}

module.exports = { generateReport, persistRun, listRuns, getRun };
