import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, History, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getComplianceRun, getComplianceRuns, type ComplianceRun, type ComplianceRunDetail } from "@/lib/api";
import { formatDateTime, getErrorMessage, resolveSummary } from "@/lib/compliance";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading, StatusBadge } from "./shared";
import { ResultsView } from "./ResultsView";
import { AutoReportView } from "@/components/autocheck/AutoReportView";
import type { AutoReport } from "@/lib/disclosures";

interface Props {
  bankId: string;
  period: string;
  /** Changes whenever a new run completes, to trigger a refresh */
  refreshKey: number;
}

const runDate = (r: ComplianceRun) => r.created_at || r.run_at || null;

export const RunHistory = ({ bankId, period, refreshKey }: Props) => {
  const [runs, setRuns] = useState<ComplianceRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [onlyPeriod, setOnlyPeriod] = useState(false);

  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<ComplianceRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const list = await getComplianceRuns(bankId);
      list.sort((a, b) => (Date.parse(runDate(b) ?? "") || b.run_id) - (Date.parse(runDate(a) ?? "") || a.run_id));
      setRuns(list);
    } catch (err) {
      setError(getErrorMessage(err, "Could not load run history."));
    } finally {
      setLoading(false);
    }
  }, [bankId]);

  useEffect(() => {
    load();
  }, [load, refreshKey]);

  const openRun = useCallback(async (runId: number) => {
    setOpenId(runId);
    setDetail(null);
    setDetailLoading(true);
    setDetailError(null);
    try {
      setDetail(await getComplianceRun(runId));
    } catch (err) {
      setDetailError(getErrorMessage(err, `Could not load run #${runId}.`));
    } finally {
      setDetailLoading(false);
    }
  }, []);

  // automatic document checks carry their whole report
  const autoReport = detail ? (detail as unknown as { auto_report?: AutoReport }).auto_report : undefined;

  if (openId !== null) {
    return (
      <div className="space-y-4">
        <Button variant="outline" size="sm" onClick={() => setOpenId(null)}>
          <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to history
        </Button>
        {detailLoading ? (
          <Card className="p-5"><LoadingState label={`Loading run #${openId}…`} /></Card>
        ) : detailError ? (
          <Card className="p-5"><ErrorState message={detailError} onRetry={() => openRun(openId)} /></Card>
        ) : autoReport ? (
          <AutoReportView report={autoReport} runId={detail?.run_id} />
        ) : detail ? (
          <ResultsView
            runId={detail.run_id}
            period={detail.period_label}
            runDate={runDate(detail)}
            report={detail.report ?? {}}
            quant={detail.quant_results}
            qual={detail.qual_results}
            network={detail.graph_results ?? null}
          />
        ) : null}
      </div>
    );
  }

  const shown = onlyPeriod ? runs.filter((r) => r.period_label === period) : runs;
  const cell = (n: number | null) => (n === null ? "—" : n);

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeading
        title="Compliance run history"
        description={loading ? undefined : `${runs.length} saved run${runs.length === 1 ? "" : "s"} for this bank`}
        actions={
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RotateCw className="h-3.5 w-3.5 mr-1.5" />}
            Refresh
          </Button>
        }
      />
      <div className="flex items-center gap-2 mb-3">
        <Switch id="only-period" checked={onlyPeriod} onCheckedChange={setOnlyPeriod} />
        <Label htmlFor="only-period" className="text-sm font-normal text-muted-foreground">Only {period}</Label>
      </div>

      {loading && !runs.length ? (
        <LoadingState label="Loading runs…" />
      ) : error ? (
        <ErrorState message={error} onRetry={load} retrying={loading} />
      ) : shown.length === 0 ? (
        <EmptyState
          icon={<History className="h-5 w-5" />}
          title={runs.length ? `No runs for ${period}` : "No runs yet"}
          description="Runs saved with “Save to history” appear here."
        />
      ) : (
        <div className="overflow-x-auto -mx-4 sm:mx-0 border-y sm:border border-border sm:rounded-lg">
          <Table className="min-w-[640px]">
            <TableHeader>
              <TableRow>
                <TableHead>Run</TableHead>
                <TableHead>Period</TableHead>
                <TableHead>Run date</TableHead>
                <TableHead className="text-right">Quant checked</TableHead>
                <TableHead className="text-right">Breaches</TableHead>
                <TableHead className="text-right">Qual checked</TableHead>
                <TableHead className="text-right">Gaps</TableHead>
                <TableHead><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((r) => {
                const s = resolveSummary([r, r.report]);
                return (
                  <TableRow key={r.run_id} className="cursor-pointer" onClick={() => openRun(r.run_id)}>
                    <TableCell className="font-medium">
                      #{r.run_id}
                      {r.mode === "auto" && (
                        <div className="flex flex-wrap items-center gap-1 mt-1">
                          <StatusBadge status={String(r.overall ?? "")} />
                          <span className="text-[11px] text-muted-foreground font-normal truncate max-w-[180px]" title={String(r.document ?? "")}>
                            auto · {String(r.document ?? "")}
                          </span>
                        </div>
                      )}
                    </TableCell>
                    <TableCell>{r.period_label}</TableCell>
                    <TableCell className="text-muted-foreground whitespace-nowrap">{formatDateTime(runDate(r))}</TableCell>
                    <TableCell className="text-right tabular-nums">{cell(s.quant_checked)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.quant_breach ? "text-red-800 font-medium" : "")}>
                      {cell(s.quant_breach)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{cell(s.qual_checked)}</TableCell>
                    <TableCell className={cn("text-right tabular-nums", s.qual_gap ? "text-red-800 font-medium" : "")}>
                      {cell(s.qual_gap)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRun(r.run_id);
                        }}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </Card>
  );
};
