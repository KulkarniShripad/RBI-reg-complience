import { useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle, Circle, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { runComplianceCheck, type ComplianceRunResponse } from "@/lib/api";
import { getErrorMessage, resolveSummary } from "@/lib/compliance";
import { ErrorState, SectionHeading } from "./shared";
import type { QuantFormState } from "./QuantitativeForm";
import type { QualState } from "./QualitativeEvidence";

export interface RunOutcome extends ComplianceRunResponse {
  period: string;
  ranAt: string;
  persisted: boolean;
}

interface Props {
  bankId: string;
  period: string;
  quant: QuantFormState | null;
  qual: QualState | null;
  onComplete: (r: RunOutcome) => void;
}

const Check = ({ ok, children }: { ok: boolean; children: ReactNode }) => (
  <li className="flex items-start gap-2 text-sm">
    {ok ? <CheckCircle className="h-4 w-4 text-green-600 shrink-0 mt-0.5" /> : <Circle className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />}
    <span className={ok ? "text-foreground" : "text-muted-foreground"}>{children}</span>
  </li>
);

export const RunCheck = ({ bankId, period, quant, qual, onComplete }: Props) => {
  const { toast } = useToast();
  const [useLlm, setUseLlm] = useState(false);
  const [persist, setPersist] = useState(true);
  const [sampleLimit, setSampleLimit] = useState("40");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);

  const unsaved = (quant?.dirty ?? 0) + (qual?.unsaved ?? 0);

  const run = async () => {
    if (runningRef.current) return;
    const limit = Number(sampleLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      setLimitError("Enter a whole number between 1 and 500");
      return;
    }
    runningRef.current = true;
    setRunning(true);
    setError(null);
    try {
      const res = await runComplianceCheck(bankId, {
        period_label: period,
        use_llm_mapping_check: useLlm,
        submitted_field_labels: useLlm ? quant?.labels ?? {} : {},
        qual_sample_limit: limit,
        persist,
      });
      const s = resolveSummary([res.report], res.quant_results, res.qual_results);
      onComplete({ ...res, period, ranAt: new Date().toISOString(), persisted: persist });
      toast({
        title: "Compliance check complete",
        description: `${s.quant_breach ?? 0} breach(es), ${s.qual_gap ?? 0} likely gap(s)${
          res.graph_results?.summary
            ? `, ${(res.graph_results.summary.status_counts.BREACH ?? 0) + (res.graph_results.summary.status_counts.PROHIBITED ?? 0)} network finding(s)`
            : ""
        }${res.run_id !== null ? ` · Run #${res.run_id}` : ""}.`,
      });
    } catch (err) {
      const msg = getErrorMessage(err, "The compliance check failed.");
      setError(msg);
      toast({ title: "Compliance check failed", description: msg, variant: "destructive" });
    } finally {
      runningRef.current = false;
      setRunning(false);
    }
  };

  return (
    <Card className="p-4 sm:p-5">
      <SectionHeading title="Run compliance check" description={`Evaluates saved data for ${period} against the applicable RBI rules.`} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-2">Readiness</p>
          <ul className="space-y-1.5">
            <Check ok={!!quant && quant.submitted > 0}>
              {quant ? `${quant.submitted} of ${quant.total} quantitative values saved` : "Open Quantitative Data to load rules"}
            </Check>
            <Check ok={!!qual && qual.saved > 0}>
              {qual ? `${qual.saved} qualitative evidence entr${qual.saved === 1 ? "y" : "ies"} saved` : "Open Qualitative Evidence to review entries"}
            </Check>
            <li className="flex items-start gap-2 text-sm text-muted-foreground">
              <Circle className="h-4 w-4 shrink-0 mt-0.5 opacity-0" />
              <span>The counterparty network is checked too when exposures exist for {period} (Network tab).</span>
            </li>
          </ul>
          {unsaved > 0 && (
            <p className="mt-3 text-xs text-yellow-800 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
              {unsaved} unsaved entr{unsaved === 1 ? "y is" : "ies are"} not included until saved.
            </p>
          )}
          {quant && quant.total > quant.submitted && (
            <p className="mt-2 text-xs text-muted-foreground">
              Rules without a value are reported by the backend as Not reported.
            </p>
          )}
        </div>

        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="llm-check">LLM mapping check</Label>
              <p className="text-xs text-muted-foreground mt-0.5">
                Flags possible field-to-rule mismatches. Warnings only; statuses are unchanged.
              </p>
            </div>
            <Switch id="llm-check" checked={useLlm} onCheckedChange={setUseLlm} disabled={running} />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="persist">Save to history</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Store this run so it appears under History.</p>
            </div>
            <Switch id="persist" checked={persist} onCheckedChange={setPersist} disabled={running} />
          </div>
          <div className="flex items-start justify-between gap-4">
            <div>
              <Label htmlFor="sample-limit">Qualitative sample limit</Label>
              <p className="text-xs text-muted-foreground mt-0.5">Maximum qualitative requirements to assess.</p>
              {limitError && <p className="text-xs text-destructive mt-1">{limitError}</p>}
            </div>
            <Input
              id="sample-limit"
              inputMode="numeric"
              value={sampleLimit}
              disabled={running}
              onChange={(e) => {
                setSampleLimit(e.target.value);
                setLimitError(null);
              }}
              className="w-20 shrink-0"
              aria-invalid={!!limitError}
            />
          </div>
        </div>
      </div>

      {error && (
        <div className="mt-4">
          <ErrorState message={error} onRetry={run} retrying={running} />
        </div>
      )}

      <Button onClick={run} disabled={running} className="w-full mt-5">
        {running ? (
          <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Running check{useLlm ? " (LLM mapping can take a minute)" : ""}…</>
        ) : (
          <><Play className="h-4 w-4 mr-1.5" /> Run compliance check</>
        )}
      </Button>
    </Card>
  );
};
