import { useMemo, useState } from "react";
import { Download, ExternalLink, FileText, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";
import { StatusBadge } from "@/components/compliance/shared";
import { NetworkResults } from "@/components/network/NetworkResults";
import { formatDateTime } from "@/lib/compliance";
import {
  formatFigure,
  operatorText,
  reportHtmlUrl,
  uploadFileUrl,
  type AutoReport,
  type RuleResult,
  type SourceRef,
} from "@/lib/disclosures";
import { cn } from "@/lib/utils";

const OVERALL_TEXT: Record<string, string> = {
  BREACH: "At least one regulatory minimum is breached.",
  ATTENTION: "No minimum is breached, but some items need attention.",
  PASS: "Every requirement that could be checked from this document is met.",
  INSUFFICIENT_DATA: "None of the applicable requirements could be checked from this document.",
};

const Stat = ({ value, label, tone }: { value: string | number; label: string; tone?: "bad" | "warn" }) => (
  <div className="rounded-lg border border-border p-3 min-w-0">
    <div className={cn("text-xl font-semibold tabular-nums", tone === "bad" && value ? "text-red-700" : tone === "warn" && value ? "text-orange-700" : "text-foreground")}>
      {value}
    </div>
    <div className="text-xs text-muted-foreground">{label}</div>
  </div>
);

const SourceButton = ({ source, onOpen }: { source: SourceRef; onOpen: (s: SourceRef) => void }) =>
  source?.verified && source.clause_uri ? (
    <button
      type="button"
      onClick={() => onOpen(source)}
      className="text-left text-xs text-primary hover:underline"
      aria-label={`Open ${source.rbi_ref ?? "source"} para ${source.paragraph}`}
    >
      {source.rbi_ref || source.doc_title}, para {source.paragraph}
      {source.page_number ? `, p. ${source.page_number}` : ""}
    </button>
  ) : (
    <span className="text-xs text-muted-foreground">{source?.reason ?? "no source"}</span>
  );

const RuleRow = ({ r, uploadId, format, onSource }: { r: RuleResult; uploadId: number; format: string; onSource: (s: SourceRef) => void }) => (
  <div className="py-3 border-b border-border last:border-0 grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_170px]">
    <div className="flex sm:block items-center gap-2">
      <StatusBadge status={r.status} />
      {r.origin === "discovered" && <div className="text-[11px] text-muted-foreground mt-1">found by search</div>}
    </div>
    <div className="min-w-0">
      <p className="text-sm font-medium text-foreground">{r.label}</p>
      <p className="text-xs text-muted-foreground">{r.metric_label}</p>
      <div className="mt-1"><SourceButton source={r.source} onOpen={onSource} /></div>
      {r.note && <p className="text-xs text-yellow-800 mt-1">{r.note}</p>}
      {r.rule_note && <p className="text-xs text-muted-foreground mt-1">{r.rule_note}</p>}
    </div>
    <div className="text-sm sm:text-right">
      <div>
        <span className="text-muted-foreground text-xs">Reported </span>
        <span className="font-medium tabular-nums">{formatFigure(r.reported_value, r.unit)}</span>
      </div>
      <div>
        <span className="text-muted-foreground text-xs">Required </span>
        <span className="tabular-nums">{r.threshold === null ? "—" : `${operatorText(r.operator)} ${formatFigure(r.threshold, r.unit)}`}</span>
      </div>
      {r.figure?.page ? (
        <a className="text-xs text-primary hover:underline" href={uploadFileUrl(uploadId, r.figure.page, format)} target="_blank" rel="noreferrer">
          doc p. {r.figure.page} · {r.figure.confidence}
        </a>
      ) : null}
    </div>
  </div>
);

interface Props {
  report: AutoReport;
  runId?: number | null;
}

export const AutoReportView = ({ report, runId }: Props) => {
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const s = report.summary;
  const id = runId ?? report.run_id ?? null;
  const openSource = (src: SourceRef) =>
    src.clause_uri && setTarget({ clauseUri: src.clause_uri, highlight: src.excerpt ?? null, label: `${src.rbi_ref ?? ""} para ${src.paragraph}` });

  const findings = useMemo(
    () => report.rule_results.filter((r) => !["PASS", "PASS_WITH_CONDITIONS", "CANDIDATE", "NOT_DISCLOSED"].includes(r.status)),
    [report.rule_results],
  );
  const others = report.rule_results.filter((r) => !findings.includes(r));

  return (
    <Card className="p-4 sm:p-5 space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-start gap-3 justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-foreground text-lg">{report.bank.bank_name}</h3>
            <StatusBadge status={report.overall} />
          </div>
          <p className="text-sm text-muted-foreground">
            {report.bank.institution_label} · {report.bank.bank_id} · {report.period_label}
            {report.as_of_date ? ` (as on ${report.as_of_date})` : ""}
            {report.profile.is_dsib ? " · D-SIB" : ""}
            {report.profile.ucb_tier ? ` · UCB Tier ${report.profile.ucb_tier}` : ""}
          </p>
          <p className="text-xs text-muted-foreground mt-0.5 break-words">
            <FileText className="inline h-3 w-3 mr-1" />
            {report.document.file_name} · {report.document.doc_type_label} · {report.document.page_count} page(s) · generated {formatDateTime(report.generated_at)}
            {id ? ` · run #${id}` : ""}
          </p>
        </div>
        {id ? (
          <div className="flex flex-wrap gap-2 shrink-0">
            <Button asChild variant="outline" size="sm">
              <a href={reportHtmlUrl(id)} target="_blank" rel="noreferrer"><ExternalLink className="h-3.5 w-3.5 mr-1.5" />Open report</a>
            </Button>
            <Button asChild size="sm">
              <a href={reportHtmlUrl(id, true)}><Download className="h-3.5 w-3.5 mr-1.5" />Download</a>
            </Button>
          </div>
        ) : null}
      </div>

      <div className="rounded-lg bg-muted/50 border border-border p-3">
        <p className="text-sm text-foreground">{OVERALL_TEXT[report.overall] ?? ""}</p>
        <p className="text-sm text-foreground mt-2 whitespace-pre-line">{report.executive_summary}</p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Stat value={`${s.rules_evaluated}/${s.rules_applicable}`} label="requirements checked" />
        <Stat value={s.breach} label="breaches" tone="bad" />
        <Stat value={s.buffer_shortfall + s.target_shortfall} label="buffer / target shortfalls" tone="warn" />
        <Stat value={s.not_disclosed} label="figures not in document" />
        <Stat value={s.disclosures_checked ? `${s.disclosures_present}/${s.disclosures_checked}` : "—"} label="required disclosures present" />
        <Stat value={s.obligations_matched} label="obligations addressed" />
      </div>

      <Tabs defaultValue="requirements">
        <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
          <TabsList className="w-max">
            <TabsTrigger value="requirements">Requirements ({report.rule_results.length})</TabsTrigger>
            <TabsTrigger value="figures">Figures ({report.figures.length})</TabsTrigger>
            <TabsTrigger value="disclosures">Disclosures ({report.disclosures.items.length})</TabsTrigger>
            <TabsTrigger value="obligations">Obligations ({report.qualitative.results.length})</TabsTrigger>
            {report.network && <TabsTrigger value="network">Network ({report.network.results.length})</TabsTrigger>}
            <TabsTrigger value="method">Method</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="requirements" className="mt-3">
          {report.rule_results.length === 0 ? (
            <p className="text-sm text-muted-foreground">No figure-based requirements apply to this category.</p>
          ) : (
            <>
              {findings.length > 0 && <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Findings</p>}
              {findings.map((r) => (
                <RuleRow key={r.id} r={r} uploadId={report.document.upload_id} format={report.document.format} onSource={openSource} />
              ))}
              {others.length > 0 && <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mt-4">Met, not in document, or unconfirmed</p>}
              {others.map((r) => (
                <RuleRow key={r.id} r={r} uploadId={report.document.upload_id} format={report.document.format} onSource={openSource} />
              ))}
            </>
          )}
        </TabsContent>

        <TabsContent value="figures" className="mt-3">
          {report.figures.length === 0 ? (
            <p className="text-sm text-muted-foreground">No figures were recognised in the document.</p>
          ) : (
            <div className="divide-y divide-border">
              {report.figures.map((f) => (
                <div key={f.metric_key} className="py-2 grid gap-1 sm:grid-cols-[minmax(0,220px)_120px_minmax(0,1fr)] sm:gap-3">
                  <div className="text-sm text-foreground">{f.label ?? f.metric_key}</div>
                  <div className="text-sm font-medium tabular-nums">{formatFigure(f.value, f.unit)}</div>
                  <div className="text-xs text-muted-foreground min-w-0 break-words">
                    {f.page ? `p. ${f.page} · ` : ""}
                    {f.method} · {f.confidence}
                    {f.basis ? ` · ${f.basis}` : ""}
                    {f.snippet ? <span className="block font-mono text-[11px] text-foreground/80 mt-0.5">{f.snippet}</span> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="disclosures" className="mt-3">
          {!report.disclosures.applicable ? (
            <p className="text-sm text-muted-foreground">{report.disclosures.reason}</p>
          ) : (
            <>
              <div className="divide-y divide-border">
                {report.disclosures.items.map((d) => (
                  <div key={d.key} className="py-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
                    <div className="w-32 shrink-0"><StatusBadge status={d.status} /></div>
                    <div className="flex-1 min-w-0 text-sm">{d.label}{d.found ? <span className="text-xs text-muted-foreground"> · p. {d.found.page}</span> : null}</div>
                    <SourceButton source={d.source} onOpen={openSource} />
                  </div>
                ))}
              </div>
            </>
          )}
        </TabsContent>

        <TabsContent value="obligations" className="mt-3">
          {!report.qualitative.results.length ? (
            <p className="text-sm text-muted-foreground">{report.qualitative.reason ?? "No governance passage matched an obligation closely."}</p>
          ) : (
            <div className="space-y-3">
              {report.qualitative.results.map((q) => (
                <div key={q.clause_uri} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={q.status} />
                    <SourceButton source={{ verified: true, clause_uri: q.clause_uri, rbi_ref: q.rbi_ref, paragraph: q.paragraph, page_number: q.page_number, doc_title: q.doc_title }} onOpen={openSource} />
                    <Badge variant="outline" className="text-[11px]">similarity {q.similarity_score.toFixed(2)}</Badge>
                  </div>
                  <p className="text-xs text-foreground mt-2 line-clamp-3">{q.clause_text}</p>
                  <p className="text-xs text-muted-foreground mt-2">Document p. {q.evidence_page}:</p>
                  <p className="text-xs text-foreground/90 italic line-clamp-3">{q.evidence_text}</p>
                  {q.justification && <p className="text-xs text-yellow-800 mt-1">{q.justification}</p>}
                </div>
              ))}
            </div>
          )}
        </TabsContent>

        {report.network && (
          <TabsContent value="network" className="mt-3">
            <NetworkResults check={{ ...report.network, message: report.network.message ?? undefined }} />
          </TabsContent>
        )}

        <TabsContent value="method" className="mt-3 space-y-3 text-sm">
          <ul className="list-disc pl-5 space-y-1 text-foreground">
            {report.notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
          <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground space-y-1">
            <p><Info className="inline h-3 w-3 mr-1" /><b className="text-foreground">Deterministic:</b> {report.method.deterministic.join("; ")}.</p>
            <p>
              <b className="text-foreground">LLM ({report.method.llm_configured && report.method.llm_requested ? "used where needed" : report.method.llm_configured ? "switched off" : "not configured"}):</b>{" "}
              {report.method.llm.join("; ")}.
            </p>
          </div>
        </TabsContent>
      </Tabs>

      <SourceViewer target={target} onClose={() => setTarget(null)} />
    </Card>
  );
};
