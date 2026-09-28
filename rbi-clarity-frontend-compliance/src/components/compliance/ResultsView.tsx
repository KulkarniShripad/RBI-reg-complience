import { useMemo, useState, type ReactNode } from "react";
import { AlertTriangle, FileSearch, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ComplianceReport, QualitativeResult, QuantitativeResult } from "@/lib/api";
import type { NetworkCheck } from "@/lib/network";
import { NetworkResults } from "@/components/network/NetworkResults";
import { Network } from "lucide-react";
import {
  formatConfidence,
  formatDateTime,
  formatThreshold,
  formatValue,
  mappingWarningText,
  resolveSummary,
  ruleLabel,
  statusLabel,
} from "@/lib/compliance";
import { cn } from "@/lib/utils";
import { EmptyState, StatusBadge } from "./shared";

interface Props {
  runId: number | null;
  period: string;
  runDate?: string | null;
  report: ComplianceReport;
  quant: QuantitativeResult[];
  qual: QualitativeResult[];
  persisted?: boolean;
  network?: NetworkCheck | null;
}

const QUANT_ORDER = ["BREACH", "NOT_REPORTED", "PASS"];
const QUAL_ORDER = ["LIKELY_GAP", "PARTIAL", "NEEDS_REVIEW", "COVERED"];

const rank = (order: string[], s: string) => {
  const i = order.indexOf((s ?? "").toUpperCase());
  return i === -1 ? order.length : i;
};

const Stat = ({ label, value, tone }: { label: string; value: number | null; tone?: "bad" | "good" | "warn" }) => (
  <div className="rounded-lg border border-border bg-background/50 px-3 py-2.5 min-w-0">
    <p className="text-xs text-muted-foreground truncate">{label}</p>
    <p
      className={cn(
        "text-xl font-semibold mt-0.5 text-foreground tabular-nums",
        value ? tone === "bad" && "text-red-800" : "",
        value ? tone === "good" && "text-green-800" : "",
        value ? tone === "warn" && "text-yellow-800" : "",
      )}
    >
      {value ?? "—"}
    </p>
  </div>
);

const Detail = ({ label, children }: { label: string; children: ReactNode }) => (
  <div className="min-w-0">
    <dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="text-sm text-foreground break-words">{children}</dd>
  </div>
);

const FilterBar = ({
  statuses,
  counts,
  value,
  onChange,
}: {
  statuses: string[];
  counts: Record<string, number>;
  value: string;
  onChange: (s: string) => void;
}) => (
  <div className="flex flex-wrap gap-1.5 mb-3">
    {["ALL", ...statuses].map((s) => (
      <Button key={s} size="sm" variant={value === s ? "default" : "outline"} className="h-8" onClick={() => onChange(s)}>
        {s === "ALL" ? "All" : statusLabel(s)} ({s === "ALL" ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[s] ?? 0})
      </Button>
    ))}
  </div>
);

export const ResultsView = ({ runId, period, runDate, report, quant, qual, persisted = true, network = null }: Props) => {
  const [section, setSection] = useState<"quant" | "qual">(quant.length || !qual.length ? "quant" : "qual");
  const [quantFilter, setQuantFilter] = useState("ALL");
  const [qualFilter, setQualFilter] = useState("ALL");

  const summary = useMemo(() => resolveSummary([report], quant, qual), [report, quant, qual]);

  const quantCounts = useMemo(() => {
    const c: Record<string, number> = {};
    quant.forEach((q) => (c[(q.status ?? "").toUpperCase()] = (c[(q.status ?? "").toUpperCase()] ?? 0) + 1));
    return c;
  }, [quant]);
  const qualCounts = useMemo(() => {
    const c: Record<string, number> = {};
    qual.forEach((q) => (c[(q.status ?? "").toUpperCase()] = (c[(q.status ?? "").toUpperCase()] ?? 0) + 1));
    return c;
  }, [qual]);

  const quantShown = useMemo(
    () =>
      quant
        .filter((q) => quantFilter === "ALL" || (q.status ?? "").toUpperCase() === quantFilter)
        .sort((a, b) => rank(QUANT_ORDER, a.status) - rank(QUANT_ORDER, b.status)),
    [quant, quantFilter],
  );
  const qualShown = useMemo(
    () =>
      qual
        .filter((q) => qualFilter === "ALL" || (q.status ?? "").toUpperCase() === qualFilter)
        .sort((a, b) => rank(QUAL_ORDER, a.status) - rank(QUAL_ORDER, b.status)),
    [qual, qualFilter],
  );

  return (
    <section className="space-y-4" aria-label="Compliance results">
      <Card className="p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="rounded-lg bg-muted p-2 text-primary shrink-0">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h3 className="font-semibold text-foreground">
                {runId !== null ? `Run #${runId}` : "Compliance check"} · {period}
              </h3>
              <p className="text-xs text-muted-foreground">
                {runDate ? formatDateTime(runDate) : "Just now"}
                {!persisted && " · not saved to history"}
              </p>
            </div>
          </div>
          {summary.mapping_warnings ? (
            <Badge variant="outline" className="text-xs self-start sm:self-auto bg-yellow-100 text-yellow-800 border-yellow-300">
              <AlertTriangle className="h-3 w-3 mr-1" /> {summary.mapping_warnings} mapping warning{summary.mapping_warnings === 1 ? "" : "s"}
            </Badge>
          ) : null}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <p className="text-sm font-medium text-foreground mb-2">Quantitative</p>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Rules checked" value={summary.quant_checked} />
              <Stat label="Passes" value={summary.quant_pass} tone="good" />
              <Stat label="Breaches" value={summary.quant_breach} tone="bad" />
              <Stat label="Not reported" value={summary.quant_not_reported} />
            </div>
          </div>
          <div>
            <p className="text-sm font-medium text-foreground mb-2">Qualitative</p>
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Requirements checked" value={summary.qual_checked} />
              <Stat label="Covered" value={summary.qual_covered} tone="good" />
              <Stat label="Partial" value={summary.qual_partial} tone="warn" />
              <Stat label="Likely gaps" value={summary.qual_gap} tone="bad" />
            </div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-3">
          Statuses are determined by the backend rule engine. Mapping warnings are advisory and never change a result.
        </p>
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="inline-flex h-10 items-center rounded-md bg-muted p-1 text-muted-foreground mb-4 max-w-full overflow-x-auto">
          {(
            [
              ["quant", `Quantitative (${quant.length})`],
              ["qual", `Qualitative (${qual.length})`],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setSection(id)}
              className={cn(
                "whitespace-nowrap rounded-sm px-3 py-1.5 text-sm font-medium transition-all",
                section === id && "bg-background text-foreground shadow-sm",
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {section === "quant" ? (
          quant.length === 0 ? (
            <EmptyState icon={<FileSearch className="h-5 w-5" />} title="No quantitative results" description="The backend returned no numeric rule results for this run." />
          ) : (
            <>
              <FilterBar statuses={QUANT_ORDER} counts={quantCounts} value={quantFilter} onChange={setQuantFilter} />
              <ul className="space-y-2.5">
                {quantShown.map((q, i) => {
                  const warning = mappingWarningText(q);
                  const hasPage = q.page_number !== null && q.page_number !== undefined && q.page_number !== "";
                  return (
                    <li
                      key={`${q.rule_id}-${i}`}
                      className={cn(
                        "rounded-lg border border-border p-3 sm:p-4 border-l-2",
                        (q.status ?? "").toUpperCase() === "BREACH" && "border-l-destructive",
                        (q.status ?? "").toUpperCase() === "PASS" && "border-l-green-500",
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-foreground break-words">{ruleLabel(q)}</p>
                          <p className="text-xs text-muted-foreground">Rule {q.rule_id}</p>
                        </div>
                        <StatusBadge status={q.status} />
                      </div>
                      <dl className="grid grid-cols-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] gap-3 mt-3">
                        <Detail label="Reported">{formatValue(q.reported_value, q.reported_value !== null && q.reported_value !== undefined ? q.threshold_unit : null)}</Detail>
                        <Detail label="Requirement">{formatThreshold(q.operator, q.threshold_value, q.threshold_unit)}</Detail>
                        <Detail label="RBI reference">{q.rbi_ref || "—"}</Detail>
                        <Detail label="Page">{hasPage ? q.page_number : "—"}</Detail>
                      </dl>
                      {q.clause_text && (
                        <p className="text-xs text-muted-foreground mt-3 break-words line-clamp-4">{q.clause_text}</p>
                      )}
                      {warning && (
                        <div className="mt-3 flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-100/60 px-3 py-2">
                          <AlertTriangle className="h-3.5 w-3.5 text-yellow-800 shrink-0 mt-0.5" />
                          <p className="text-xs text-yellow-800 break-words">
                            <span className="font-medium">Mapping warning (advisory):</span> {warning}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </>
          )
        ) : qual.length === 0 ? (
          <EmptyState icon={<FileSearch className="h-5 w-5" />} title="No qualitative results" description="Add qualitative evidence for this period, then run the check again." />
        ) : (
          <>
            <FilterBar statuses={QUAL_ORDER} counts={qualCounts} value={qualFilter} onChange={setQualFilter} />
            <ul className="space-y-2.5">
              {qualShown.map((q, i) => {
                const requirement = q.rbi_requirement || q.requirement_text || q.clause_text;
                const evidence = q.evidence_excerpt || q.evidence_text;
                const confidence = formatConfidence(q.confidence);
                const source = q.source_reference || q.rbi_ref;
                const status = (q.status ?? "").toUpperCase();
                return (
                  <li
                    key={`${q.requirement_id ?? q.rule_id ?? "q"}-${i}`}
                    className={cn(
                      "rounded-lg border border-border p-3 sm:p-4 border-l-2",
                      status === "LIKELY_GAP" && "border-l-destructive",
                      status === "COVERED" && "border-l-green-500",
                      status === "PARTIAL" && "border-l-yellow-500",
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                        {source && <Badge variant="outline" className="text-xs font-normal">{source}</Badge>}
                        {q.page_number !== null && q.page_number !== undefined && q.page_number !== "" && (
                          <span className="text-xs text-muted-foreground">Page {q.page_number}</span>
                        )}
                        {confidence && (
                          <Badge variant="outline" className="text-xs font-normal">Confidence: {confidence}</Badge>
                        )}
                      </div>
                      <StatusBadge status={q.status} />
                    </div>
                    <div className="mt-2.5 space-y-2.5">
                      <div>
                        <p className="text-xs text-muted-foreground">RBI requirement</p>
                        <p className="text-sm text-foreground break-words">{requirement || "—"}</p>
                      </div>
                      <div>
                        <p className="text-xs text-muted-foreground">Evidence</p>
                        {evidence ? (
                          <p className="text-sm text-foreground border-l-2 border-border pl-3 mt-0.5 whitespace-pre-wrap break-words line-clamp-6">
                            {evidence}
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">No matching evidence found.</p>
                        )}
                      </div>
                      {q.justification && (
                        <div>
                          <p className="text-xs text-muted-foreground">Justification</p>
                          <p className="text-sm text-foreground break-words">{q.justification}</p>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="flex items-center gap-3 mb-4">
          <div className="rounded-lg bg-muted p-2 text-primary shrink-0">
            <Network className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-foreground">Counterparty network</h3>
            <p className="text-xs text-muted-foreground">
              Groups of connected counterparties, related parties and intra-group exposure, computed over the bank's exposure network.
            </p>
          </div>
        </div>
        {network ? (
          <NetworkResults check={network} compact />
        ) : (
          <p className="text-sm text-muted-foreground">
            Not checked: no exposures were entered for {period}. Add them in the Network tab and run the check again.
          </p>
        )}
      </Card>

      <details className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Raw report data</summary>
        <pre className="mt-3 max-h-80 overflow-auto text-xs text-foreground whitespace-pre-wrap break-all">
          {JSON.stringify(report, null, 2)}
        </pre>
      </details>
    </section>
  );
};
