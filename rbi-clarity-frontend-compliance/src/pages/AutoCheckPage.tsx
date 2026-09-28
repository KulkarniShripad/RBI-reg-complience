import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, CheckCircle2, FileSearch, FileUp, Loader2, Play, RotateCw, Sparkles } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useCategories } from "@/lib/categories";
import { getErrorMessage } from "@/lib/compliance";
import {
  ACCEPTED_FILES,
  DOC_TYPES,
  analyseFile,
  analyseSample,
  formatFigure,
  getSamples,
  getUpload,
  getUploads,
  periodOfDate,
  runAutoCheck,
  updateUpload,
  uploadFileUrl,
  type AutoReport,
  type SampleDoc,
  type UploadAnalysis,
  type UploadListItem,
} from "@/lib/disclosures";
import { AutoReportView } from "@/components/autocheck/AutoReportView";
import { ErrorState, LoadingState, SectionHeading } from "@/components/compliance/shared";
import { cn } from "@/lib/utils";

const PERIOD_RE = /^Q[1-4]-FY\d{4}-\d{2}$/;

const Steps = ({ step }: { step: 1 | 2 | 3 }) => (
  <ol className="flex flex-wrap gap-2 text-xs mb-5" aria-label="Progress">
    {["Upload a document", "Check what was read", "Compliance report"].map((t, i) => (
      <li
        key={t}
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-3 py-1",
          step === i + 1 ? "border-primary text-primary bg-primary/5" : step > i + 1 ? "border-border text-muted-foreground" : "border-border text-muted-foreground/70",
        )}
        aria-current={step === i + 1 ? "step" : undefined}
      >
        {step > i + 1 ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="font-semibold">{i + 1}</span>}
        {t}
      </li>
    ))}
  </ol>
);

// ── Step 1: upload ──

const UploadStep = ({ onAnalysed, useLlm, setUseLlm }: { onAnalysed: (a: UploadAnalysis) => void; useLlm: boolean; setUseLlm: (v: boolean) => void }) => {
  const { toast } = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);
  const [samples, setSamples] = useState<SampleDoc[] | null>(null);
  const [recent, setRecent] = useState<UploadListItem[]>([]);

  useEffect(() => {
    getSamples().then(setSamples).catch(() => setSamples([]));
    getUploads().then(setRecent).catch(() => setRecent([]));
  }, []);

  const handle = async (fn: () => Promise<UploadAnalysis>, label: string) => {
    setBusy(label);
    setError(null);
    try {
      const a = await fn();
      if (a.duplicate) toast({ title: "Already analysed", description: `${a.file_name} was uploaded before; showing that analysis.` });
      onAnalysed(a);
    } catch (err) {
      setError(getErrorMessage(err, "The document could not be analysed."));
    } finally {
      setBusy(null);
    }
  };

  const onFile = (f: File | undefined | null) => f && handle(() => analyseFile(f, useLlm), f.name);

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeading
          title="Upload a bank document"
          description="An annual report, Basel III Pillar 3 disclosure, quarterly results, investor presentation, or a spreadsheet / CSV / JSON of figures. The system finds the bank, its category and the period, reads the figures and checks them against the RBI rules that apply."
        />
        <div
          role="button"
          tabIndex={0}
          aria-label="Choose a file to upload"
          onClick={() => !busy && inputRef.current?.click()}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !busy && inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (!busy) onFile(e.dataTransfer.files?.[0]);
          }}
          className={cn(
            "rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors",
            drag ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
            busy && "opacity-60 cursor-wait",
          )}
        >
          {busy ? (
            <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              Reading {busy}…
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <FileUp className="h-7 w-7 text-primary" />
              <p className="text-sm font-medium text-foreground">Drop a file here or click to choose</p>
              <p className="text-xs text-muted-foreground">PDF, Excel (.xlsx), CSV, JSON, text or HTML · up to 60 MB</p>
            </div>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_FILES}
            className="hidden"
            data-testid="auto-file-input"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        <div className="flex items-center gap-2 mt-3">
          <Switch id="use-llm" checked={useLlm} onCheckedChange={setUseLlm} />
          <Label htmlFor="use-llm" className="text-sm font-normal">
            Use the LLM where the rules-based reader cannot decide <span className="text-muted-foreground">(needs GEMINI_API_KEY on the backend)</span>
          </Label>
        </div>
        {error && <div className="mt-3"><ErrorState message={error} /></div>}
      </Card>

      <Card className="p-4 sm:p-5">
        <SectionHeading
          title="Try a sample document"
          description="Real figures published by Indian banks (source linked) and fictional test cases with known breaches. See sample-data/README.md."
        />
        {samples === null ? (
          <LoadingState label="Loading samples…" />
        ) : samples.length === 0 ? (
          <p className="text-sm text-muted-foreground">No sample documents found (sample-data/manifest.json).</p>
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {samples.map((s) => (
              <div key={s.file} data-sample={s.file} className="rounded-lg border border-border p-3 flex flex-col gap-2 min-w-0">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground break-words">{s.title}</p>
                    <p className="text-xs text-muted-foreground">{s.period} · {s.file.split(".").pop()?.toUpperCase()}</p>
                  </div>
                  <Badge variant={s.kind === "public" ? "secondary" : "outline"} className="text-[11px] shrink-0">
                    {s.kind === "public" ? "real figures" : "test case"}
                  </Badge>
                </div>
                {s.source_url && (
                  <a className="text-xs text-primary hover:underline truncate" href={s.source_url} target="_blank" rel="noreferrer">
                    source: {new URL(s.source_url).hostname}
                  </a>
                )}
                <Button size="sm" variant="outline" className="self-start" disabled={!!busy} onClick={() => handle(() => analyseSample(s.file, useLlm, true), s.title)}>
                  <FileSearch className="h-3.5 w-3.5 mr-1.5" /> Analyse
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {recent.length > 0 && (
        <Card className="p-4 sm:p-5">
          <SectionHeading title="Recent uploads" />
          <div className="divide-y divide-border">
            {recent.slice(0, 8).map((u) => (
              <button
                key={u.upload_id}
                type="button"
                disabled={!!busy}
                onClick={() => handle(() => getUpload(u.upload_id), u.file_name)}
                className="w-full text-left py-2 flex flex-wrap items-center gap-x-3 gap-y-1 hover:bg-muted/40 px-1 rounded"
              >
                <span className="text-sm text-foreground font-medium truncate max-w-full">{u.file_name}</span>
                <span className="text-xs text-muted-foreground">{u.bank_name ?? "bank not detected"} · {u.period_label ?? "period ?"}</span>
                <Badge variant="outline" className="text-[11px]">{u.status}</Badge>
              </button>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
};

// ── Step 2: review what was read ──

const confidenceClass = (c: string) =>
  c === "high" ? "bg-green-100 text-green-800 border-green-300" : c === "medium" ? "bg-yellow-100 text-yellow-800 border-yellow-300" : "bg-orange-100 text-orange-800 border-orange-300";

const ReviewStep = ({
  analysis,
  onChange,
  onRun,
  running,
  useLlm,
}: {
  analysis: UploadAnalysis;
  onChange: (a: UploadAnalysis) => void;
  onRun: (opts: { include_qualitative: boolean }) => void;
  running: boolean;
  useLlm: boolean;
}) => {
  const categories = useCategories(false);
  const p = analysis.profile;
  const [profile, setProfile] = useState({
    bank_name: p.bank_name ?? "",
    bank_id: p.bank_id ?? "",
    institution_category: p.institution_category ?? "",
    as_of_date: p.as_of_date ?? "",
    period_label: p.period_label ?? "",
    doc_type: p.doc_type,
    is_dsib: !!p.is_dsib,
    ucb_tier: p.ucb_tier ? String(p.ucb_tier) : "",
  });
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(Object.values(analysis.metrics).map((m) => [m.metric_key, String(m.value)])),
  );
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [qual, setQual] = useState(["annual_report", "policy", "board_minutes", "other"].includes(p.doc_type));

  const rows = useMemo(() => {
    const keys = new Set([...analysis.expected_metrics.map((e) => e.key), ...Object.keys(values)]);
    return [...keys].map((k) => ({
      key: k,
      meta: analysis.catalog.find((c) => c.key === k),
      expected: analysis.expected_metrics.find((e) => e.key === k),
      figure: analysis.metrics[k] ?? null,
    }));
  }, [analysis, values]);

  const profilePatch = () => {
    const out: Record<string, unknown> = {};
    if (profile.bank_name !== (p.bank_name ?? "")) out.bank_name = profile.bank_name;
    if (profile.bank_id !== (p.bank_id ?? "")) out.bank_id = profile.bank_id;
    if (profile.institution_category && profile.institution_category !== (p.institution_category ?? "")) out.institution_category = profile.institution_category;
    if (profile.as_of_date !== (p.as_of_date ?? "")) out.as_of_date = profile.as_of_date || null;
    if (profile.period_label !== (p.period_label ?? "")) out.period_label = profile.period_label;
    if (profile.doc_type !== p.doc_type) out.doc_type = profile.doc_type;
    if (profile.is_dsib !== !!p.is_dsib) out.is_dsib = profile.is_dsib;
    if (profile.ucb_tier !== (p.ucb_tier ? String(p.ucb_tier) : "")) out.ucb_tier = profile.ucb_tier ? Number(profile.ucb_tier) : null;
    return out;
  };
  const metricsPatch = () => {
    const out: Record<string, number | null> = {};
    for (const [k, v] of Object.entries(values)) {
      const orig = analysis.metrics[k];
      if (v.trim() === "") {
        if (orig) out[k] = null;
      } else if (!orig || Number(v) !== orig.value) out[k] = Number(v.replace(/,/g, ""));
    }
    for (const k of Object.keys(analysis.metrics)) if (!(k in values)) out[k] = null;
    return out;
  };

  const invalid = Object.entries(values).find(([, v]) => v.trim() !== "" && !Number.isFinite(Number(v.replace(/,/g, ""))));
  const missing = [
    !profile.bank_name.trim() && "bank name",
    !profile.bank_id.trim() && "bank ID",
    !profile.institution_category && "institution category",
    !PERIOD_RE.test(profile.period_label) && "reporting period",
  ].filter(Boolean) as string[];

  const saveAndRun = async () => {
    setSaving(true);
    setError(null);
    try {
      const pp = profilePatch();
      const mp = metricsPatch();
      let current = analysis;
      if (Object.keys(pp).length || Object.keys(mp).length) {
        current = await updateUpload(analysis.upload_id, { profile: pp, metrics: mp });
        onChange(current);
      }
      onRun({ include_qualitative: qual });
    } catch (err) {
      setError(getErrorMessage(err, "Could not save the corrections."));
    } finally {
      setSaving(false);
    }
  };

  const ev = (k: string) => {
    const v = p.evidence?.[k];
    return typeof v === "string" ? v : null;
  };
  const isUcb = profile.institution_category === "urban_cooperative_banks";

  return (
    <div className="space-y-4">
      <Card className="p-4 sm:p-5">
        <SectionHeading
          title="Who and when"
          description={`Detected from ${analysis.file_name} (${analysis.page_count} page${analysis.page_count === 1 ? "" : "s"}${p.detected_by === "rules+llm" ? ", with LLM help" : ""}). Correct anything that is wrong. The bank is registered automatically if it is new.`}
          actions={
            analysis.has_file ? (
              <Button asChild variant="outline" size="sm">
                <a href={uploadFileUrl(analysis.upload_id)} target="_blank" rel="noreferrer">Open document</a>
              </Button>
            ) : undefined
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1">
            <Label htmlFor="bank-name">Bank name</Label>
            <Input id="bank-name" value={profile.bank_name} onChange={(e) => setProfile({ ...profile, bank_name: e.target.value })} />
            {ev("bank_name") && <p className="text-[11px] text-muted-foreground">{ev("bank_name")}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="bank-id">Bank ID</Label>
            <Input id="bank-id" value={profile.bank_id} onChange={(e) => setProfile({ ...profile, bank_id: e.target.value.toUpperCase() })} />
            <p className="text-[11px] text-muted-foreground">{p.registered ? "Already registered" : "Will be registered on run"}</p>
          </div>
          <div className="space-y-1">
            <Label>Institution category</Label>
            <Select value={profile.institution_category} onValueChange={(v) => setProfile({ ...profile, institution_category: v })}>
              <SelectTrigger aria-label="Institution category"><SelectValue placeholder="Select category" /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {ev("institution_category") && <p className="text-[11px] text-muted-foreground">{ev("institution_category")}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="as-of">Figures as on</Label>
            <Input
              id="as-of"
              type="date"
              value={profile.as_of_date}
              onChange={(e) => setProfile({ ...profile, as_of_date: e.target.value, period_label: periodOfDate(e.target.value) ?? profile.period_label })}
            />
            {ev("as_of_date") && <p className="text-[11px] text-muted-foreground">{ev("as_of_date")}</p>}
          </div>
          <div className="space-y-1">
            <Label htmlFor="period">Reporting period</Label>
            <Input id="period" value={profile.period_label} placeholder="Q1-FY2025-26" onChange={(e) => setProfile({ ...profile, period_label: e.target.value })} />
          </div>
          <div className="space-y-1">
            <Label>Document type</Label>
            <Select value={profile.doc_type} onValueChange={(v) => setProfile({ ...profile, doc_type: v })}>
              <SelectTrigger aria-label="Document type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {DOC_TYPES.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          {profile.institution_category === "commercial_banks" && (
            <div className="flex items-center gap-2 pt-5">
              <Switch id="dsib" checked={profile.is_dsib} onCheckedChange={(v) => setProfile({ ...profile, is_dsib: v })} />
              <Label htmlFor="dsib" className="font-normal text-sm">D-SIB (leverage ratio 4% instead of 3.5%)</Label>
            </div>
          )}
          {isUcb && (
            <div className="space-y-1">
              <Label>UCB tier</Label>
              <Select value={profile.ucb_tier || "auto"} onValueChange={(v) => setProfile({ ...profile, ucb_tier: v === "auto" ? "" : v })}>
                <SelectTrigger aria-label="UCB tier"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">From deposits (unknown)</SelectItem>
                  {[1, 2, 3, 4].map((t) => <SelectItem key={t} value={String(t)}>Tier {t}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] text-muted-foreground">Tier 1 ≤ ₹100 cr deposits, Tier 2 ≤ ₹1,000 cr, Tier 3 ≤ ₹10,000 cr, Tier 4 above.</p>
            </div>
          )}
        </div>
        {(p.notes ?? []).length > 0 && (
          <ul className="mt-3 text-xs text-muted-foreground list-disc pl-5">{p.notes!.map((n) => <li key={n}>{n}</li>)}</ul>
        )}
      </Card>

      <Card className="p-4 sm:p-5">
        <SectionHeading
          title="Figures read from the document"
          description="Each figure shows the page and line it was read from. Correct a wrong value, clear it, or add one the reader missed. Rows marked “checked by a rule” are the ones the applicable RBI requirements need."
        />
        <div className="divide-y divide-border">
          {rows.map(({ key, meta, expected, figure }) => (
            <div key={key} className="py-3 grid gap-2 md:grid-cols-[minmax(0,230px)_150px_minmax(0,1fr)] md:gap-4">
              <div className="min-w-0">
                <Label htmlFor={`m-${key}`} className="text-sm">{meta?.label ?? key}</Label>
                <div className="flex flex-wrap gap-1 mt-1">
                  {expected?.checked_by_rule && <Badge variant="outline" className="text-[10px]">checked by a rule</Badge>}
                  {figure && <Badge variant="outline" className={cn("text-[10px]", confidenceClass(figure.confidence))}>{figure.confidence} · {figure.method}</Badge>}
                  {!figure && !(key in values && values[key] !== "") && <Badge variant="outline" className="text-[10px]">not found</Badge>}
                </div>
              </div>
              <div className="flex items-center gap-1.5">
                <Input
                  id={`m-${key}`}
                  inputMode="decimal"
                  className={cn("h-8", invalid?.[0] === key && "border-destructive")}
                  value={values[key] ?? ""}
                  placeholder="—"
                  onChange={(e) => setValues({ ...values, [key]: e.target.value })}
                />
                <span className="text-xs text-muted-foreground whitespace-nowrap">{meta?.unit}</span>
              </div>
              <div className="text-xs text-muted-foreground min-w-0 break-words">
                {figure ? (
                  <>
                    {figure.page ? (
                      <a className="text-primary hover:underline mr-1" href={uploadFileUrl(analysis.upload_id, figure.page, analysis.format)} target="_blank" rel="noreferrer">
                        p. {figure.page}
                      </a>
                    ) : null}
                    {figure.basis && <span className="mr-1">({figure.basis})</span>}
                    <span className="font-mono text-[11px] text-foreground/80">{figure.snippet}</span>
                    {figure.alternatives.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1">
                        <span>Other readings:</span>
                        {figure.alternatives.map((a) => (
                          <button
                            key={`${a.value}-${a.page}`}
                            type="button"
                            className="underline hover:text-foreground"
                            title={a.snippet ?? ""}
                            onClick={() => setValues({ ...values, [key]: String(a.value) })}
                          >
                            {formatFigure(a.value, meta?.unit)}{a.page ? ` (p. ${a.page})` : ""}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  "Not in this document. Leave empty (reported as “not in document”) or enter the figure from another source."
                )}
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <Select value={adding} onValueChange={(v) => {
            setValues({ ...values, [v]: values[v] ?? "" });
            setAdding("");
          }}>
            <SelectTrigger className="w-64 h-8" aria-label="Add a figure"><SelectValue placeholder="Add a figure…" /></SelectTrigger>
            <SelectContent>
              {analysis.catalog.filter((c) => !rows.some((r) => r.key === c.key)).map((c) => (
                <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </Card>

      <Card className="p-4 sm:p-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-2">
            <Switch id="qual" checked={qual} onCheckedChange={setQual} />
            <Label htmlFor="qual" className="font-normal text-sm">Also match governance passages to RBI obligations (slower)</Label>
          </div>
          <Button onClick={saveAndRun} disabled={running || saving || missing.length > 0 || !!invalid}>
            {running || saving ? <Loader2 className="h-4 w-4 animate-spin mr-1.5" /> : <Play className="h-4 w-4 mr-1.5" />}
            {running ? "Checking…" : "Run compliance check"}
          </Button>
        </div>
        {missing.length > 0 && <p className="text-xs text-yellow-800 mt-2">Fill in: {missing.join(", ")}.</p>}
        {invalid && <p className="text-xs text-destructive mt-2">“{invalid[1]}” is not a number.</p>}
        {!useLlm && <p className="text-xs text-muted-foreground mt-2"><Sparkles className="inline h-3 w-3 mr-1" />LLM help is off: rules found only by text search are listed as “possible rule” for review.</p>}
        {error && <div className="mt-3"><ErrorState message={error} /></div>}
      </Card>
    </div>
  );
};

// ── Page ──

const AutoCheckPage = () => {
  const [params, setParams] = useSearchParams();
  const [analysis, setAnalysis] = useState<UploadAnalysis | null>(null);
  const [report, setReport] = useState<{ run_id: number | null; report: AutoReport } | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [useLlm, setUseLlm] = useState(true);
  const uploadParam = params.get("upload");

  const loadUpload = useCallback(async (id: number) => {
    setLoadError(null);
    try {
      setAnalysis(await getUpload(id));
    } catch (err) {
      setLoadError(getErrorMessage(err, "Could not load the upload."));
    }
  }, []);

  useEffect(() => {
    if (uploadParam && !analysis) loadUpload(Number(uploadParam));
  }, [uploadParam, analysis, loadUpload]);

  const onAnalysed = (a: UploadAnalysis) => {
    setAnalysis(a);
    setReport(null);
    setParams({ upload: String(a.upload_id) }, { replace: true });
  };

  const run = async (opts: { include_qualitative: boolean }) => {
    if (!analysis) return;
    setRunning(true);
    setRunError(null);
    try {
      setReport(await runAutoCheck(analysis.upload_id, { use_llm: useLlm, include_qualitative: opts.include_qualitative }));
    } catch (err) {
      setRunError(getErrorMessage(err, "The compliance check failed."));
    } finally {
      setRunning(false);
    }
  };

  const restart = () => {
    setAnalysis(null);
    setReport(null);
    setRunError(null);
    setParams({}, { replace: true });
  };

  const step: 1 | 2 | 3 = report ? 3 : analysis ? 2 : 1;

  return (
    <div className="p-4 sm:p-6 md:p-10 max-w-6xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Automatic Compliance Check</h1>
      <p className="text-muted-foreground mb-5">
        Upload what a bank publishes or reports. The system reads the figures, works out which RBI rules apply to this bank, checks them and writes a
        report. Every result links to the paragraph of the Master Direction it comes from and the page of the document the figure was read from.
      </p>
      <Steps step={step} />

      {loadError && <Card className="p-4 mb-4"><ErrorState message={loadError} onRetry={() => uploadParam && loadUpload(Number(uploadParam))} /></Card>}

      {step === 1 && <UploadStep onAnalysed={onAnalysed} useLlm={useLlm} setUseLlm={setUseLlm} />}

      {step === 2 && analysis && (
        <>
          <Button variant="outline" size="sm" className="mb-3" onClick={restart}>
            <ArrowLeft className="h-4 w-4 mr-1.5" /> Another document
          </Button>
          <ReviewStep key={analysis.upload_id} analysis={analysis} onChange={setAnalysis} onRun={run} running={running} useLlm={useLlm} />
          {runError && <Card className="p-4 mt-4"><ErrorState message={runError} /></Card>}
        </>
      )}

      {step === 3 && report && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setReport(null)}>
              <ArrowLeft className="h-4 w-4 mr-1.5" /> Back to figures
            </Button>
            <Button variant="outline" size="sm" onClick={restart}>
              <RotateCw className="h-4 w-4 mr-1.5" /> Check another document
            </Button>
            <Button asChild variant="outline" size="sm">
              <Link to={`/dashboard/compliance?bank=${encodeURIComponent(report.report.bank.bank_id)}&period=${encodeURIComponent(report.report.period_label)}&tab=history`}>
                Open bank in Compliance Checker
              </Link>
            </Button>
          </div>
          <AutoReportView report={report.report} runId={report.run_id} />
        </div>
      )}
    </div>
  );
};

export default AutoCheckPage;
