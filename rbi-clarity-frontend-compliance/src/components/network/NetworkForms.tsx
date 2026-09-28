import { useEffect, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { getErrorMessage } from "@/lib/compliance";
import {
  ECON_CRITERIA,
  EDGE_LABELS,
  SELF,
  human,
  validationDetails,
  type NetworkEdge,
  type NetworkEntity,
  type NetworkExposure,
  type ValidationDetail,
  type Vocabulary,
} from "@/lib/network";

const NONE = "__none__";

const Field = ({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) => (
  <div className="space-y-1.5 min-w-0">
    <Label htmlFor={htmlFor}>{label}</Label>
    {children}
    {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
  </div>
);

const Choice = ({
  value,
  onChange,
  options,
  placeholder,
  allowNone,
  label,
}: {
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
  allowNone?: string;
  label: string;
}) => (
  <Select value={value || (allowNone ? NONE : "")} onValueChange={(v) => onChange(v === NONE ? null : v)}>
    <SelectTrigger aria-label={label}>
      <SelectValue placeholder={placeholder ?? "Select"} />
    </SelectTrigger>
    <SelectContent>
      {allowNone && <SelectItem value={NONE}>{allowNone}</SelectItem>}
      {options.map((o) => (
        <SelectItem key={o.value} value={o.value}>
          {o.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);

const Flag = ({ id, checked, onChange, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) => (
  <label htmlFor={id} className="flex items-start gap-2 text-sm cursor-pointer">
    <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" />
    <span>{children}</span>
  </label>
);

const Problems = ({ error, details }: { error: string | null; details: ValidationDetail[] }) =>
  error ? (
    <div role="alert" className="rounded-md border border-destructive/30 bg-red-50 p-3 text-sm">
      <p className="text-foreground">{error}</p>
      {details.length > 0 && (
        <ul className="list-disc pl-4 mt-1 text-xs text-muted-foreground">
          {details.map((d, i) => (
            <li key={i}>
              {d.field ? `${human(d.field)}: ` : ""}
              {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  ) : null;

function useSubmit(onDone: () => void) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<ValidationDetail[]>([]);
  const submit = async (fn: () => Promise<unknown>) => {
    setSaving(true);
    setError(null);
    setDetails([]);
    try {
      await fn();
      onDone();
    } catch (err) {
      setError(getErrorMessage(err, "Could not save."));
      setDetails(validationDetails(err));
    } finally {
      setSaving(false);
    }
  };
  return { saving, error, details, submit, reset: () => (setError(null), setDetails([])) };
}

// ── counterparty ─────────────────────────────────────────────────────────────

export const EntityDialog = ({
  open,
  onOpenChange,
  vocab,
  initial,
  existingIds,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vocab: Vocabulary;
  initial: NetworkEntity | null;
  existingIds: Set<string>;
  onSave: (e: NetworkEntity) => Promise<unknown>;
}) => {
  const blank: NetworkEntity = { entity_id: "", name: "", entity_type: "company", ite_class: null, group_relation: null, attributes: {} };
  const [e, setE] = useState<NetworkEntity>(initial ?? blank);
  const { saving, error, details, submit, reset } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (open) {
      setE(initial ?? blank);
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial]);
  const attr = (k: string) => !!e.attributes?.[k];
  const setAttr = (k: string, v: boolean) => setE((x) => ({ ...x, attributes: { ...(x.attributes ?? {}), [k]: v } }));
  const editing = !!initial;
  const idTaken = !editing && existingIds.has(e.entity_id.trim());

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit counterparty" : "Add counterparty"}</DialogTitle>
          <DialogDescription>A borrower, investee, guarantor, director, promoter or any party linked to one.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="ID" hint="Your key: PAN, CIN, LEI or customer ID" htmlFor="ent-id">
            <Input id="ent-id" value={e.entity_id} disabled={editing} onChange={(ev) => setE({ ...e, entity_id: ev.target.value })} aria-invalid={idTaken} />
            {idTaken && <p className="text-xs text-destructive">This ID already exists - edit that counterparty instead.</p>}
          </Field>
          <Field label="Name" htmlFor="ent-name">
            <Input id="ent-name" value={e.name} onChange={(ev) => setE({ ...e, name: ev.target.value })} />
          </Field>
          <Field label="Type">
            <Choice label="Type" value={e.entity_type} onChange={(v) => setE({ ...e, entity_type: v ?? "company" })} options={vocab.entity_types.map((t) => ({ value: t, label: human(t) }))} />
          </Field>
          <Field label="Bank's own group" hint="Only for the bank's subsidiaries, associates, JVs, promoters…">
            <Choice label="Bank's own group" value={e.group_relation} allowNone="Not a group entity" onChange={(v) => setE({ ...e, group_relation: v })} options={vocab.group_relations.map((t) => ({ value: t, label: human(t) }))} />
          </Field>
          <Field label="Intra-group class" hint="Used for intra-group limits; guessed from the type if empty">
            <Choice label="Intra-group class" value={e.ite_class} allowNone="Automatic" onChange={(v) => setE({ ...e, ite_class: v })} options={vocab.ite_classes.map((t) => ({ value: t, label: human(t) }))} />
          </Field>
        </div>
        <div className="space-y-2 pt-1">
          {e.entity_type === "nbfc" && (
            <Flag id="f-gold" checked={attr("gold_loan_nbfc")} onChange={(v) => setAttr("gold_loan_nbfc", v)}>
              Gold-loan NBFC (gold loans are 50% or more of its financial assets)
            </Flag>
          )}
          {e.entity_type === "company" && (
            <>
              <Flag id="f-s8" checked={attr("section8_company")} onChange={(v) => setAttr("section8_company", v)}>Section 8 company</Flag>
              <Flag id="f-gov" checked={attr("government_company")} onChange={(v) => setAttr("government_company", v)}>Government company</Flag>
            </>
          )}
          {["bank", "nbfc", "fund", "insurer"].includes(e.entity_type) && (
            <Flag id="f-ns" checked={attr("non_strategic_investor")} onChange={(v) => setAttr("non_strategic_investor", v)}>
              Holds shares in the bank only as a non-strategic investment, without control
            </Flag>
          )}
          <Flag id="f-econ" checked={attr("econ_assessed")} onChange={(v) => setAttr("econ_assessed", v)}>
            Economic interdependence assessed (none found)
          </Flag>
        </div>
        <Problems error={error} details={details} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || !e.entity_id.trim() || !e.name.trim() || idTaken} onClick={() => submit(() => onSave({ ...e, entity_id: e.entity_id.trim(), name: e.name.trim() }))}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ── relationship ─────────────────────────────────────────────────────────────

export const EdgeDialog = ({
  open,
  onOpenChange,
  vocab,
  entities,
  bankName,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vocab: Vocabulary;
  entities: NetworkEntity[];
  bankName: string;
  onSave: (e: NetworkEdge) => Promise<unknown>;
}) => {
  const blank: NetworkEdge = { from_entity: "", to_entity: "", edge_type: "OWNS", ownership_pct: null, status: "confirmed", bidirectional: 0 };
  const [e, setE] = useState<NetworkEdge>(blank);
  const { saving, error, details, submit, reset } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (open) {
      setE(blank);
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const opts = [
    { value: SELF, label: `${bankName} (this bank)` },
    ...entities.filter((x) => x.entity_id !== SELF).map((x) => ({ value: x.entity_id, label: `${x.name} (${x.entity_id})` })),
  ];
  const t = e.edge_type;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add relationship</DialogTitle>
          <DialogDescription>
            Ownership and control connect counterparties into groups; economic dependence adds contagion; director, relative and promoter
            links find related parties.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-3">
          <Field label="From">
            <Choice label="From" value={e.from_entity} placeholder="Select a party" onChange={(v) => setE({ ...e, from_entity: v ?? "" })} options={opts} />
          </Field>
          <Field label="Relationship">
            <Choice label="Relationship" value={e.edge_type} onChange={(v) => setE({ ...e, edge_type: v ?? "OWNS" })} options={vocab.edge_types.map((x) => ({ value: x, label: EDGE_LABELS[x] ?? human(x) }))} />
          </Field>
          <Field label="To">
            <Choice label="To" value={e.to_entity} placeholder="Select a party" onChange={(v) => setE({ ...e, to_entity: v ?? "" })} options={opts} />
          </Field>
          {t === "OWNS" && (
            <Field label="Shareholding / voting rights (%)" hint="More than 50% is treated as control automatically" htmlFor="edge-pct">
              <Input id="edge-pct" inputMode="decimal" value={e.ownership_pct ?? ""} onChange={(ev) => setE({ ...e, ownership_pct: ev.target.value === "" ? null : Number(ev.target.value) })} />
            </Field>
          )}
          {t === "CONTROLS" && (
            <Field label="Basis of control">
              <Choice label="Basis of control" value={e.basis} allowNone="Not specified" onChange={(v) => setE({ ...e, basis: v })} options={vocab.control_bases.map((x) => ({ value: x, label: human(x) }))} />
            </Field>
          )}
          {t === "ECONOMIC_DEPENDENCE" && (
            <>
              <Field label="Criterion" hint="'From' depends on 'To': problems at 'To' would spread to 'From'">
                <Choice
                  label="Criterion"
                  value={e.criterion ? String(e.criterion) : null}
                  allowNone="Not specified"
                  onChange={(v) => setE({ ...e, criterion: v ? Number(v) : null })}
                  options={Object.entries(ECON_CRITERIA).map(([k, v]) => ({ value: k, label: `${k}. ${v}` }))}
                />
              </Field>
              <Flag id="edge-bi" checked={!!e.bidirectional} onChange={(v) => setE({ ...e, bidirectional: v ? 1 : 0 })}>
                Two-way dependence
              </Flag>
            </>
          )}
          {t === "INTERESTED_IN" && (
            <Field label="Role">
              <Choice label="Role" value={e.role} onChange={(v) => setE({ ...e, role: v })} options={vocab.roles.map((x) => ({ value: x, label: human(x) }))} />
            </Field>
          )}
          {t === "RELATIVE_OF" && (
            <Field label="Relation">
              <Choice label="Relation" value={e.relation} allowNone="Not specified" onChange={(v) => setE({ ...e, relation: v })} options={vocab.relations.map((x) => ({ value: x, label: human(x) }))} />
            </Field>
          )}
          <Field label="Status" hint="Flagged = suspected, not yet confirmed: reported for review, never treated as fact">
            <Choice label="Status" value={e.status} onChange={(v) => setE({ ...e, status: (v ?? "confirmed") as NetworkEdge["status"] })} options={vocab.edge_statuses.map((x) => ({ value: x, label: human(x) }))} />
          </Field>
          <Field label="Evidence" htmlFor="edge-ev">
            <Textarea id="edge-ev" rows={2} value={e.evidence ?? ""} placeholder="e.g. shareholding pattern Mar-2026; 80% of output sold to X" onChange={(ev) => setE({ ...e, evidence: ev.target.value })} />
          </Field>
        </div>
        <Problems error={error} details={details} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={saving || !e.from_entity || !e.to_entity} onClick={() => submit(() => onSave(e))}>
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

// ── exposure ─────────────────────────────────────────────────────────────────

export const ExposureDialog = ({
  open,
  onOpenChange,
  vocab,
  entities,
  period,
  category,
  onSave,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  vocab: Vocabulary;
  entities: NetworkEntity[];
  period: string;
  category: string;
  onSave: (x: NetworkExposure) => Promise<unknown>;
}) => {
  const blank: NetworkExposure = { entity_id: "", exposure_kind: "fund_based", amount: 0, crm_amount: 0, infrastructure: 0, board_approved_excess: 0 };
  const [x, setX] = useState<NetworkExposure>(blank);
  const [amount, setAmount] = useState("");
  const { saving, error, details, submit, reset } = useSubmit(() => onOpenChange(false));
  useEffect(() => {
    if (open) {
      setX(blank);
      setAmount("");
      reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const parties = entities.filter((e) => e.entity_id !== SELF).map((e) => ({ value: e.entity_id, label: `${e.name} (${e.entity_id})` }));
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add exposure ({period})</DialogTitle>
          <DialogDescription>Amounts in ₹ crore. Saving the same counterparty and kind again replaces the figure.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="sm:col-span-2">
            <Field label="Counterparty">
              <Choice label="Counterparty" value={x.entity_id} placeholder="Select a counterparty" onChange={(v) => setX({ ...x, entity_id: v ?? "" })} options={parties} />
            </Field>
          </div>
          <Field label="Kind">
            <Choice label="Kind" value={x.exposure_kind} onChange={(v) => setX({ ...x, exposure_kind: v ?? "fund_based" })} options={vocab.exposure_kinds.map((k) => ({ value: k, label: human(k) }))} />
          </Field>
          <Field label="Exposure (₹ cr)" htmlFor="x-amt" hint="Outstanding / credit-equivalent value">
            <Input id="x-amt" inputMode="decimal" value={amount} onChange={(ev) => setAmount(ev.target.value)} />
          </Field>
          {category === "urban_cooperative_banks" && (
            <Field label="Sanctioned limit (₹ cr)" htmlFor="x-lim" hint="UCBs count the limit or the outstanding, whichever is higher">
              <Input id="x-lim" inputMode="decimal" value={x.sanctioned_limit ?? ""} onChange={(ev) => setX({ ...x, sanctioned_limit: num(ev.target.value) })} />
            </Field>
          )}
          <Field label="Eligible credit risk mitigation (₹ cr)" htmlFor="x-crm">
            <Input id="x-crm" inputMode="decimal" value={x.crm_amount ?? ""} onChange={(ev) => setX({ ...x, crm_amount: num(ev.target.value) })} />
          </Field>
          <Field label="Protection provider" hint="Exposure equal to the mitigation moves to this party">
            <Choice label="Protection provider" value={x.crm_provider} allowNone="None" onChange={(v) => setX({ ...x, crm_provider: v })} options={parties} />
          </Field>
          <Field label="Exempt from limits because">
            <Choice label="Exemption" value={x.exempt_reason} allowNone="Not exempt" onChange={(v) => setX({ ...x, exempt_reason: v })} options={vocab.exempt_reasons.map((k) => ({ value: k, label: human(k) }))} />
          </Field>
          <div className="sm:col-span-2 space-y-2">
            <Flag id="x-infra" checked={!!x.infrastructure} onChange={(v) => setX({ ...x, infrastructure: v ? 1 : 0 })}>
              On account of infrastructure loan / investment
            </Flag>
            <Flag id="x-board" checked={!!x.board_approved_excess} onChange={(v) => setX({ ...x, board_approved_excess: v ? 1 : 0 })}>
              Board has approved exposure above the single-counterparty limit (exceptional case)
            </Flag>
          </div>
          <div className="sm:col-span-2">
            <Field label="Director-lending exception (if any)" htmlFor="x-s20" hint="e.g. loan against own fixed deposit within LTV - reported for review">
              <Input id="x-s20" value={x.section20_exception ?? ""} onChange={(ev) => setX({ ...x, section20_exception: ev.target.value || null })} />
            </Field>
          </div>
        </div>
        <Problems error={error} details={details} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            disabled={saving || !x.entity_id || amount === "" || Number.isNaN(Number(amount))}
            onClick={() => submit(() => onSave({ ...x, amount: Number(amount) }))}
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
