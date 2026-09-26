import { useEffect, useState } from "react";
import { Building2, Check, Loader2, Pencil, Plus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { createBank, type Bank } from "@/lib/api";
import {
  BANK_ID_PATTERN,
  INSTITUTION_CATEGORIES,
  formatDateTime,
  formatLabel,
  getErrorMessage,
} from "@/lib/compliance";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState, SectionHeading } from "./shared";

interface Props {
  banks: Bank[];
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  selectedBank: Bank | null;
  onSelect: (bankId: string) => void;
  onSaved: (bank: Bank) => void;
}

type FormErrors = Partial<Record<"bank_id" | "bank_name" | "institution_category", string>>;

const emptyForm = { bank_id: "", bank_name: "", institution_category: "" };

export const BankSetup = ({ banks, loading, error, onRetry, selectedBank, onSelect, onSaved }: Props) => {
  const { toast } = useToast();
  const [mode, setMode] = useState<"create" | "edit">("create");
  const [form, setForm] = useState(emptyForm);
  const [errors, setErrors] = useState<FormErrors>({});
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Leave edit mode if the edited bank is deselected
  useEffect(() => {
    if (mode === "edit" && selectedBank && selectedBank.bank_id !== form.bank_id) {
      setMode("create");
      setForm(emptyForm);
      setErrors({});
    }
  }, [selectedBank, mode, form.bank_id]);

  const startEdit = (bank: Bank) => {
    setMode("edit");
    setForm({
      bank_id: bank.bank_id,
      bank_name: bank.bank_name,
      institution_category: bank.institution_category,
    });
    setErrors({});
    setSubmitError(null);
  };

  const cancelEdit = () => {
    setMode("create");
    setForm(emptyForm);
    setErrors({});
    setSubmitError(null);
  };

  const validate = (): FormErrors => {
    const e: FormErrors = {};
    const id = form.bank_id.trim();
    if (!id) e.bank_id = "Bank ID is required";
    else if (!BANK_ID_PATTERN.test(id)) e.bank_id = "Use letters, numbers, - or _ (max 64 characters)";
    else if (mode === "create" && banks.some((b) => b.bank_id.toLowerCase() === id.toLowerCase()))
      e.bank_id = "This bank ID already exists. Use Edit to update it.";
    if (!form.bank_name.trim()) e.bank_name = "Bank name is required";
    if (!form.institution_category) e.institution_category = "Select an institution category";
    return e;
  };

  const handleSubmit = async () => {
    if (saving) return;
    const e = validate();
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    setSubmitError(null);
    try {
      const payload = {
        bank_id: form.bank_id.trim(),
        bank_name: form.bank_name.trim(),
        institution_category: form.institution_category,
      };
      const saved = await createBank(payload);
      const bank: Bank = { ...payload, ...saved };
      toast({
        title: mode === "create" ? "Bank created" : "Bank updated",
        description: `${bank.bank_name} (${bank.bank_id}) is selected.`,
      });
      onSaved(bank);
      setMode("create");
      setForm(emptyForm);
      setErrors({});
    } catch (err) {
      const msg = getErrorMessage(err, "Could not save the bank.");
      setSubmitError(msg);
      toast({ title: "Could not save bank", description: msg, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const set = (k: keyof typeof form, v: string) => {
    setForm((f) => ({ ...f, [k]: v }));
    if (errors[k]) setErrors((e) => ({ ...e, [k]: undefined }));
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <Card className="p-5 lg:col-span-2 h-fit">
        <SectionHeading
          title={mode === "create" ? "Add a bank" : "Update bank"}
          description={
            mode === "create"
              ? "The institution category decides which RBI rules apply."
              : "Changing the category changes the applicable rules."
          }
        />
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="bank_id">Bank ID</Label>
            <Input
              id="bank_id"
              value={form.bank_id}
              onChange={(e) => set("bank_id", e.target.value)}
              placeholder="BANK-001"
              disabled={mode === "edit" || saving}
              aria-invalid={!!errors.bank_id}
              className={cn(errors.bank_id && "border-destructive")}
            />
            {errors.bank_id && <p className="text-xs text-destructive">{errors.bank_id}</p>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bank_name">Bank name</Label>
            <Input
              id="bank_name"
              value={form.bank_name}
              onChange={(e) => set("bank_name", e.target.value)}
              placeholder="Example Bank Ltd."
              disabled={saving}
              aria-invalid={!!errors.bank_name}
              className={cn(errors.bank_name && "border-destructive")}
            />
            {errors.bank_name && <p className="text-xs text-destructive">{errors.bank_name}</p>}
          </div>
          <div className="space-y-1.5">
            <Label>Institution category</Label>
            <Select
              value={form.institution_category}
              onValueChange={(v) => set("institution_category", v)}
              disabled={saving}
            >
              <SelectTrigger
                aria-invalid={!!errors.institution_category}
                className={cn(errors.institution_category && "border-destructive")}
              >
                <SelectValue placeholder="Select category" />
              </SelectTrigger>
              <SelectContent>
                {INSTITUTION_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {formatLabel(c)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.institution_category && (
              <p className="text-xs text-destructive">{errors.institution_category}</p>
            )}
          </div>

          {submitError && <ErrorState message={submitError} compact />}

          <div className="flex gap-2">
            <Button onClick={handleSubmit} disabled={saving} className="flex-1">
              {saving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" /> Saving…
                </>
              ) : mode === "create" ? (
                <>
                  <Plus className="h-4 w-4 mr-1.5" /> Create bank
                </>
              ) : (
                "Save changes"
              )}
            </Button>
            {mode === "edit" && (
              <Button variant="outline" onClick={cancelEdit} disabled={saving}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      </Card>

      <Card className="p-5 lg:col-span-3">
        <SectionHeading title="Registered banks" description={loading ? undefined : `${banks.length} total`} />
        {loading ? (
          <LoadingState label="Loading banks…" />
        ) : error ? (
          <ErrorState message={error} onRetry={onRetry} />
        ) : banks.length === 0 ? (
          <EmptyState
            icon={<Building2 className="h-5 w-5" />}
            title="No banks yet"
            description="Create a bank to start entering compliance data."
          />
        ) : (
          <ul className="divide-y divide-border -mx-1">
            {banks.map((b) => {
              const active = selectedBank?.bank_id === b.bank_id;
              return (
                <li key={b.bank_id} className="flex items-center gap-3 px-1 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-foreground truncate">{b.bank_name}</span>
                      {active && (
                        <Badge variant="default" className="text-[10px] px-2 py-0">
                          Selected
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2 mt-1">
                      <span className="text-xs text-muted-foreground">{b.bank_id}</span>
                      <Badge variant="secondary" className="text-xs">
                        {formatLabel(b.institution_category)}
                      </Badge>
                      {b.created_at && (
                        <span className="text-xs text-muted-foreground hidden sm:inline">
                          Added {formatDateTime(b.created_at)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex gap-1.5 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => {
                        onSelect(b.bank_id);
                        startEdit(b);
                      }}
                      aria-label={`Edit ${b.bank_name}`}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant={active ? "secondary" : "outline"}
                      size="sm"
                      onClick={() => onSelect(b.bank_id)}
                      disabled={active}
                    >
                      {active ? <Check className="h-3.5 w-3.5" /> : "Select"}
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
};
