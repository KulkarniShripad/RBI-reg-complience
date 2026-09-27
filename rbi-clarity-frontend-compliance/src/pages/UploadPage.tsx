import { useRef, useState } from "react";
import axios from "axios";
import { AlertTriangle, CheckCircle, FileText, Loader2, RefreshCw, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  checkDuplicate,
  sha256OfFile,
  uploadCircular,
  type UploadErrorBody,
  type UploadResult,
} from "@/lib/api";
import { resetCategoriesCache, useCategories } from "@/lib/categories";
import { useToast } from "@/hooks/use-toast";

const MAX_BYTES = 50 * 1024 * 1024;

type Status =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "duplicate"; message: string }
  | { kind: "ready" }
  | { kind: "uploading" }
  | { kind: "possible_update"; body: UploadErrorBody }
  | { kind: "error"; message: string }
  | { kind: "done"; result: UploadResult };

const UploadPage = () => {
  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState("auto");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const inputRef = useRef<HTMLInputElement>(null);
  const categories = useCategories(true);
  const { toast } = useToast();

  const reset = () => {
    setFile(null);
    setTitle("");
    setStatus({ kind: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  };

  const choose = async (f: File | undefined | null) => {
    if (!f) return;
    if (!/\.pdf$/i.test(f.name) && f.type !== "application/pdf") {
      toast({ title: "Invalid file", description: "Please choose a PDF file.", variant: "destructive" });
      return;
    }
    if (f.size > MAX_BYTES) {
      toast({ title: "File too large", description: "The maximum size is 50 MB.", variant: "destructive" });
      return;
    }
    setFile(f);
    setStatus({ kind: "checking" });
    // Check for an identical file before uploading anything.
    const sha = await sha256OfFile(f);
    if (!sha) return setStatus({ kind: "ready" });
    try {
      const res = await checkDuplicate(sha);
      if (res.duplicate) {
        const e = res.existing ?? { doc_id: "" };
        return setStatus({
          kind: "duplicate",
          message: `This exact file is already in the knowledge base${e.title ? `: "${e.title}"` : ""}${e.rbi_ref ? ` (${e.rbi_ref})` : ""}.`,
        });
      }
    } catch {
      /* the server re-checks on upload anyway */
    }
    setStatus({ kind: "ready" });
  };

  const handleUpload = async (replace = false) => {
    if (!file) return;
    setStatus({ kind: "uploading" });
    try {
      const res = await uploadCircular(file, category, title || undefined, replace);
      setStatus({ kind: "done", result: res });
      resetCategoriesCache();
      toast({ title: res.status === "replaced" ? "Circular replaced" : "Circular added", description: `${res.clauses ?? 0} provisions and ${res.rules_extracted} numeric requirements extracted.` });
    } catch (err) {
      const body = axios.isAxiosError(err) ? (err.response?.data as UploadErrorBody | undefined) : undefined;
      if (body?.code === "possible_update") return setStatus({ kind: "possible_update", body });
      if (body?.code === "duplicate" || body?.code === "duplicate_in_progress") {
        return setStatus({ kind: "duplicate", message: body.error });
      }
      const message = body?.error || (axios.isAxiosError(err) && !err.response ? "Cannot reach the backend." : "Could not upload the circular.");
      setStatus({ kind: "error", message });
      toast({ title: "Upload failed", description: message, variant: "destructive" });
    }
  };

  const busy = status.kind === "uploading" || status.kind === "checking";

  return (
    <div className="p-6 md:p-10 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Upload Circular</h1>
      <p className="text-muted-foreground mb-8">
        Add an RBI circular or Master Direction (PDF with a text layer). It is parsed into paragraphs, its numeric
        requirements are extracted, and it becomes searchable in the chat within seconds. Duplicate files are rejected.
      </p>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="space-y-2">
          <Label>Institution type</Label>
          <Select value={category} onValueChange={setCategory} disabled={busy}>
            <SelectTrigger aria-label="Institution type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Detect from the document</SelectItem>
              {categories.map((c) => (
                <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Title (optional)</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Read from the document" disabled={busy} />
        </div>
      </div>

      <Card
        className={`border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          file ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
        }`}
        onDrop={(e) => {
          e.preventDefault();
          if (!busy) void choose(e.dataTransfer.files[0]);
        }}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => !busy && status.kind !== "done" && inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          data-testid="file-input"
          onChange={(e) => void choose(e.target.files?.[0])}
        />

        {status.kind === "done" ? (
          <div className="space-y-3">
            <CheckCircle className="h-12 w-12 mx-auto text-green-600" />
            <p className="text-foreground font-medium">{status.result.status === "replaced" ? "Replaced the earlier version" : "Circular added"}</p>
            <div className="text-sm text-muted-foreground space-y-1">
              <p className="font-medium text-foreground">{status.result.title}</p>
              {status.result.rbi_ref && <p>{status.result.rbi_ref}</p>}
              <p>
                {status.result.clauses ?? 0} provisions · {status.result.rules_extracted} numeric requirements ·{" "}
                {status.result.definitions ?? 0} definitions · {status.result.chunks_embedded} passages indexed for search
              </p>
              {status.result.categories?.length ? <p>Applies to: {status.result.categories.map((c) => c.label).join(", ")}</p> : null}
              {status.result.topic && <p>Topic: {status.result.topic}</p>}
              {status.result.warnings?.map((w) => (
                <p key={w} className="text-xs text-yellow-800">{w}</p>
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); reset(); }}>Upload another</Button>
          </div>
        ) : file ? (
          <div className="space-y-3" onClick={(e) => e.stopPropagation()}>
            <FileText className="h-12 w-12 mx-auto text-primary" />
            <p className="text-foreground font-medium break-all">{file.name}</p>
            <p className="text-muted-foreground text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB</p>

            {status.kind === "checking" && (
              <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" /> Checking for duplicates…
              </p>
            )}
            {status.kind === "duplicate" && (
              <div role="alert" className="text-sm rounded-md border border-yellow-300 bg-yellow-100/60 text-yellow-900 px-3 py-2 flex gap-2 text-left">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> <span>{status.message} Nothing was uploaded.</span>
              </div>
            )}
            {status.kind === "possible_update" && (
              <div role="alert" className="text-sm rounded-md border border-yellow-300 bg-yellow-100/60 text-yellow-900 px-3 py-2 text-left space-y-2">
                <p className="flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {status.body.error}</p>
                {Array.isArray(status.body.existing) && status.body.existing.map((e) => (
                  <p key={e.doc_id} className="text-xs">Existing: {e.title}{e.last_updated_label ? ` (updated as on ${e.last_updated_label})` : ""}</p>
                ))}
                {status.body.incoming?.last_updated_label && <p className="text-xs">This file: updated as on {status.body.incoming.last_updated_label}</p>}
                <div className="flex gap-2">
                  <Button size="sm" onClick={() => void handleUpload(true)}><RefreshCw className="h-3.5 w-3.5 mr-1" /> Replace existing version</Button>
                  <Button size="sm" variant="outline" onClick={reset}>Cancel</Button>
                </div>
              </div>
            )}
            {status.kind === "error" && <p role="alert" className="text-sm text-destructive">{status.message}</p>}

            <div className="flex gap-2 justify-center">
              <Button onClick={() => void handleUpload(false)} disabled={busy || status.kind === "duplicate" || status.kind === "possible_update"}>
                {status.kind === "uploading" ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Processing…</> : "Upload & Process"}
              </Button>
              <Button variant="outline" onClick={reset} disabled={status.kind === "uploading"}>
                <X className="h-4 w-4 mr-1" /> Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Upload className="h-12 w-12 mx-auto text-muted-foreground" />
            <p className="text-foreground font-medium">Drop a PDF here or click to browse</p>
            <p className="text-muted-foreground text-sm">RBI circulars and Master Directions (max 50 MB)</p>
          </div>
        )}
      </Card>
    </div>
  );
};

export default UploadPage;
