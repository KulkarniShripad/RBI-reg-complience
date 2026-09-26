import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Upload, FileText, CheckCircle, Loader2, X } from "lucide-react";
import { uploadCircular, getTopics, FOLDER_SUBTOPICS, type UploadResult } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";

const UploadPage = () => {
  const [file, setFile] = useState<File | null>(null);
  const [topic, setTopic] = useState("general");
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [topics, setTopics] = useState<string[]>(Object.keys(FOLDER_SUBTOPICS));
  const inputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    getTopics()
      .then((data) => {
        if (data.topics?.length) {
          const ids = data.topics.map((t) => t.topic_id);
          // merge with static fallback
          const merged = Array.from(new Set([...ids, ...Object.keys(FOLDER_SUBTOPICS)]));
          setTopics(merged);
        }
      })
      .catch(() => {});
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const dropped = e.dataTransfer.files[0];
    if (dropped?.type === "application/pdf") {
      setFile(dropped);
      setResult(null);
    } else {
      toast({ title: "Invalid file", description: "Please upload a PDF file.", variant: "destructive" });
    }
  };

  const handleUpload = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const res = await uploadCircular(file, topic, title || undefined);
      setResult(res);
      toast({ title: "Success", description: `Circular uploaded — ${res.rules_extracted} rules extracted.` });
    } catch (err: any) {
      const msg = err?.response?.data?.detail || "Could not upload the circular.";
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  const formatTopic = (t: string) => t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <div className="p-6 md:p-10 max-w-2xl mx-auto">
      <h1 className="font-display text-2xl font-bold text-foreground mb-2">Upload Circular</h1>
      <p className="text-muted-foreground mb-8">Upload RBI circular PDFs to add them to the knowledge base.</p>

      {/* Topic & Title */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <div className="space-y-2">
          <Label>Topic</Label>
          <Select value={topic} onValueChange={setTopic}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {topics.map((t) => (
                <SelectItem key={t} value={t}>{formatTopic(t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label>Title (optional)</Label>
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Auto-detected from filename" />
        </div>
      </div>

      <Card
        className={`border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          file ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
        }`}
        onDrop={handleDrop}
        onDragOver={(e) => e.preventDefault()}
        onClick={() => inputRef.current?.click()}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf"
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.[0]) {
              setFile(e.target.files[0]);
              setResult(null);
            }
          }}
        />

        {result?.success ? (
          <div className="space-y-3">
            <CheckCircle className="h-12 w-12 mx-auto text-green-600" />
            <p className="text-foreground font-medium">Upload accepted</p>
            <div className="text-sm text-muted-foreground space-y-1">
              <p>Circular: <span className="font-medium text-foreground">{result.title}</span></p>
              <p>{result.rules_extracted} rules extracted · {result.chunks_embedded} chunks embedded · {result.word_count} words</p>
              {result.note && <p className="text-xs">{result.note}</p>}
            </div>
            <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setFile(null); setResult(null); setTitle(""); }}>
              Upload Another
            </Button>
          </div>
        ) : file ? (
          <div className="space-y-3">
            <FileText className="h-12 w-12 mx-auto text-primary" />
            <p className="text-foreground font-medium">{file.name}</p>
            <p className="text-muted-foreground text-sm">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            <div className="flex gap-2 justify-center">
              <Button onClick={(e) => { e.stopPropagation(); handleUpload(); }} disabled={uploading}>
                {uploading ? <><Loader2 className="h-4 w-4 animate-spin mr-2" /> Processing...</> : "Upload & Process"}
              </Button>
              <Button variant="outline" onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                <X className="h-4 w-4 mr-1" /> Remove
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <Upload className="h-12 w-12 mx-auto text-muted-foreground" />
            <p className="text-foreground font-medium">Drop a PDF here or click to browse</p>
            <p className="text-muted-foreground text-sm">Supports RBI circular documents (max 50 MB)</p>
          </div>
        )}
      </Card>
    </div>
  );
};

export default UploadPage;
