import { useCallback, useEffect, useRef, useState } from "react";
import { FileText, Loader2, Plus, Send, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import {
  QUAL_SOURCE_TYPES,
  getQualitativeEvidence,
  submitQualitativeEvidence,
  type QualitativeEvidence as Evidence,
} from "@/lib/api";
import { formatDateTime, formatLabel, getErrorMessage } from "@/lib/compliance";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "./shared";

const MIN_CHARS = 20;
const MAX_CHARS = 20000;

interface Draft {
  key: number;
  text: string;
  sourceType: string;
  error: string | null;
}

export interface QualState {
  saved: number;
  unsaved: number;
}

interface Props {
  bankId: string;
  period: string;
  onStateChange: (s: QualState) => void;
}

let draftSeq = 0;
const newDraft = (sourceType = "policy_manual"): Draft => ({ key: ++draftSeq, text: "", sourceType, error: null });

export const QualitativeEvidence = ({ bankId, period, onStateChange }: Props) => {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Draft[]>([newDraft()]);
  const [saved, setSaved] = useState<Evidence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const submittingRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const all = await getQualitativeEvidence(bankId);
      setSaved(all.filter((e) => !e.period_label || e.period_label === period));
    } catch (err) {
      setError(getErrorMessage(err, "Could not load saved evidence."));
    } finally {
      setLoading(false);
    }
  }, [bankId, period]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    onStateChange({ saved: saved.length, unsaved: drafts.filter((d) => d.text.trim()).length });
  }, [saved.length, drafts, onStateChange]);

  const update = (key: number, patch: Partial<Draft>) =>
    setDrafts((ds) => ds.map((d) => (d.key === key ? { ...d, ...patch } : d)));

  const remove = (key: number) =>
    setDrafts((ds) => {
      const next = ds.filter((d) => d.key !== key);
      return next.length ? next : [newDraft()];
    });

  const validate = (d: Draft): string | null => {
    const t = d.text.trim();
    if (!t) return "Evidence text is required";
    if (t.length < MIN_CHARS) return `Add a little more detail (at least ${MIN_CHARS} characters)`;
    if (t.length > MAX_CHARS) return `Keep evidence under ${MAX_CHARS.toLocaleString()} characters`;
    if (!d.sourceType) return "Select a source type";
    return null;
  };

  const handleSubmit = async () => {
    if (submittingRef.current) return;
    const toSend = drafts.filter((d) => d.text.trim());
    if (!toSend.length) {
      update(drafts[0].key, { error: "Evidence text is required" });
      return;
    }
    const invalid = toSend.map((d) => [d.key, validate(d)] as const).filter(([, e]) => e);
    if (invalid.length) {
      setDrafts((ds) => ds.map((d) => {
        const hit = invalid.find(([k]) => k === d.key);
        return hit ? { ...d, error: hit[1] } : d;
      }));
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    const succeeded: number[] = [];
    const created: Evidence[] = [];
    const failures: Record<number, string> = {};
    try {
      // Sequential so each entry gets its own success/error state.
      for (const d of toSend) {
        try {
          const ev = await submitQualitativeEvidence(bankId, {
            evidence_text: d.text.trim(),
            source_type: d.sourceType,
            period_label: period,
          });
          succeeded.push(d.key);
          created.push(ev);
        } catch (err) {
          failures[d.key] = getErrorMessage(err, "Could not save this entry.");
        }
      }
    } finally {
      setDrafts((ds) => {
        const next = ds
          .filter((d) => !succeeded.includes(d.key))
          .map((d) => (failures[d.key] ? { ...d, error: failures[d.key] } : d));
        return next.length ? next : [newDraft()];
      });
      if (created.length) setSaved((s) => [...created, ...s]);
      submittingRef.current = false;
      setSubmitting(false);
    }

    const failed = Object.keys(failures).length;
    if (failed) {
      toast({
        title: succeeded.length ? "Some evidence was not saved" : "Could not save evidence",
        description: `${succeeded.length} saved, ${failed} failed. Unsaved text has been kept.`,
        variant: "destructive",
      });
    } else {
      toast({ title: "Evidence saved", description: `${succeeded.length} entr${succeeded.length === 1 ? "y" : "ies"} saved for ${period}.` });
      load();
    }
  };

  const filledCount = drafts.filter((d) => d.text.trim()).length;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="p-4 sm:p-5 lg:col-span-3 h-fit">
        <SectionHeading
          title="Add qualitative evidence"
          description="Paste policy excerpts, board minutes or audit notes that show how RBI requirements are met."
        />
        <div className="space-y-4">
          {drafts.map((d, i) => (
            <div key={d.key} className="rounded-lg border border-border p-3 space-y-2.5 bg-background/50">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-muted-foreground">Entry {i + 1}</span>
                <div className="flex items-center gap-2">
                  <Select
                    value={d.sourceType}
                    onValueChange={(v) => update(d.key, { sourceType: v, error: null })}
                    disabled={submitting}
                  >
                    <SelectTrigger className="h-8 w-[210px] text-xs" aria-label="Source type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUAL_SOURCE_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>{formatLabel(t)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => remove(d.key)}
                    disabled={submitting}
                    aria-label={`Remove entry ${i + 1}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <Label htmlFor={`ev-${d.key}`} className="sr-only">Evidence text</Label>
              <Textarea
                id={`ev-${d.key}`}
                value={d.text}
                disabled={submitting}
                onChange={(e) => update(d.key, { text: e.target.value, error: null })}
                placeholder="e.g. The bank's board-approved AML policy requires all cash transactions above ₹10 lakh to be reported…"
                className={cn("min-h-[120px] text-sm", d.error && "border-destructive")}
                aria-invalid={!!d.error}
              />
              <div className="flex justify-between gap-2">
                {d.error ? <p className="text-xs text-destructive" role="alert">{d.error}</p> : <span />}
                <span className="text-xs text-muted-foreground shrink-0">{d.text.trim().length.toLocaleString()} chars</span>
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-2 mt-4">
          <Button
            variant="outline"
            onClick={() => setDrafts((ds) => [...ds, newDraft(ds[ds.length - 1]?.sourceType)])}
            disabled={submitting}
          >
            <Plus className="h-4 w-4 mr-1.5" /> Add another entry
          </Button>
          <Button onClick={handleSubmit} disabled={submitting || filledCount === 0} className="sm:ml-auto">
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…</>
            ) : (
              <><Send className="h-4 w-4 mr-1.5" /> Save {filledCount > 1 ? `${filledCount} entries` : "evidence"}</>
            )}
          </Button>
        </div>
      </Card>

      <Card className="p-4 sm:p-5 lg:col-span-2">
        <SectionHeading title="Saved for this period" description={loading ? undefined : `${saved.length} entr${saved.length === 1 ? "y" : "ies"} · ${period}`} />
        {loading ? (
          <LoadingState label="Loading evidence…" />
        ) : error ? (
          <ErrorState message={error} onRetry={load} />
        ) : saved.length === 0 ? (
          <EmptyState icon={<FileText className="h-5 w-5" />} title="No evidence yet" description="Saved entries for this period will appear here." />
        ) : (
          <ul className="space-y-2.5 max-h-[560px] overflow-y-auto pr-1">
            {saved.map((e, i) => {
              const k = String(e.id ?? e.evidence_id ?? `i${i}`);
              const open = !!expanded[k];
              return (
                <li key={k} className="rounded-lg border border-border p-3">
                  <div className="flex flex-wrap items-center gap-2 mb-1.5">
                    <Badge variant="outline" className="text-xs">{formatLabel(e.source_type)}</Badge>
                    {(e.created_at || e.submitted_at) && (
                      <span className="text-xs text-muted-foreground">{formatDateTime(e.created_at || e.submitted_at)}</span>
                    )}
                  </div>
                  <p className={cn("text-sm text-foreground whitespace-pre-wrap break-words", !open && "line-clamp-3")}>
                    {e.evidence_text ?? ""}
                  </p>
                  {(e.evidence_text ?? "").length > 200 && (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline mt-1"
                      onClick={() => setExpanded((x) => ({ ...x, [k]: !open }))}
                    >
                      {open ? "Show less" : "Show more"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};
