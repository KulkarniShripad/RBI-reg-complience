import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { AlertCircle, Bot, CheckCircle, FileText, Info, Loader2, RotateCcw, Send, SquarePen, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SourceViewer, type SourceTarget } from "@/components/SourceViewer";
import { useChat } from "@/context/ChatContext";
import { useCategories } from "@/lib/categories";
import type { ChatMessage, ChatSource } from "@/lib/api";

const confidenceColors: Record<string, string> = {
  high: "bg-green-100 text-green-800 border-green-300",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
  low: "bg-red-100 text-red-800 border-red-300",
};

const MODE_LABEL: Record<string, string> = {
  llm: "AI answer from the sources",
  extractive: "Direct quotes (AI summary unavailable)",
  not_found: "Not found in knowledge base",
};

const ConfidenceIcon = ({ level }: { level: string }) => {
  if (level === "high") return <CheckCircle className="h-3 w-3" />;
  if (level === "medium") return <Info className="h-3 w-3" />;
  return <AlertCircle className="h-3 w-3" />;
};

const shortTitle = (t?: string | null) => (t ?? "").replace(/^Reserve Bank of India\s*/i, "").trim();

/** Turn "[2]" / "[1][3]" citations into links the markdown renderer can intercept. */
const linkCitations = (text: string, count: number) =>
  text.replace(/\[(\d{1,2})\]/g, (m, n) => (Number(n) >= 1 && Number(n) <= count ? `[\\[${n}\\]](#source-${n})` : m));

const SourceList = ({ sources, onOpen }: { sources: ChatSource[]; onOpen: (s: ChatSource) => void }) => (
  <div className="space-y-1.5">
    <p className="text-xs font-medium text-muted-foreground">Sources</p>
    <ol className="space-y-1.5">
      {sources.map((s) => (
        <li key={`${s.id}-${s.clause_uri}`}>
          <button
            type="button"
            onClick={() => onOpen(s)}
            className="w-full text-left rounded-lg border border-border bg-card hover:bg-accent/40 transition-colors px-3 py-2"
            aria-label={`Open source ${s.id}: ${shortTitle(s.doc_title)} paragraph ${s.paragraph}`}
          >
            <div className="flex items-start gap-2">
              <span className="text-xs font-semibold text-primary shrink-0 mt-0.5">[{s.id}]</span>
              <div className="min-w-0">
                <p className="text-xs font-medium text-foreground line-clamp-1">{shortTitle(s.doc_title)}</p>
                <p className="text-[11px] text-muted-foreground">
                  {String(s.paragraph).startsWith("Annex") || s.paragraph === "preamble" ? s.paragraph : `Para ${s.paragraph}`}
                  {s.page ? ` · p.${s.page}` : ""}
                  {s.rbi_ref ? ` · ${s.rbi_ref}` : ""}
                  {s.categories?.length ? ` · ${s.categories.map((c) => c.label).join(", ")}` : ""}
                </p>
                <p className="text-xs text-muted-foreground line-clamp-2 mt-0.5">{s.snippet || s.clause_text}</p>
              </div>
            </div>
          </button>
        </li>
      ))}
    </ol>
  </div>
);

const AssistantMessage = ({ msg, onOpenSource }: { msg: ChatMessage; onOpenSource: (s: ChatSource) => void }) => {
  const sources = msg.metadata?.sources ?? [];
  const content = sources.length ? linkCitations(msg.content, sources.length) : msg.content;
  const meta = msg.metadata;
  return (
    <div className="space-y-2 min-w-0">
      <div className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${msg.error ? "bg-destructive/10 text-destructive" : "bg-muted text-foreground"}`}>
        <div className="prose prose-sm max-w-none dark:prose-invert break-words">
          <ReactMarkdown
            components={{
              a: ({ href, children }) => {
                const m = /^#source-(\d+)$/.exec(href ?? "");
                if (m) {
                  const s = sources[Number(m[1]) - 1];
                  return (
                    <button
                      type="button"
                      className="text-primary font-medium no-underline hover:underline text-xs align-super"
                      onClick={() => s && onOpenSource(s)}
                      title={s ? `${shortTitle(s.doc_title)}, para ${s.paragraph}` : undefined}
                    >
                      {children}
                    </button>
                  );
                }
                return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
              },
            }}
          >
            {content}
          </ReactMarkdown>
        </div>
      </div>
      {meta && (
        <div className="space-y-2 px-1">
          <div className="flex flex-wrap gap-1.5">
            {meta.answer_mode && meta.answer_mode !== "smalltalk" && (
              <Badge variant="outline" className={`text-xs ${confidenceColors[meta.confidence] || ""}`}>
                <ConfidenceIcon level={meta.confidence} />
                <span className="ml-1">Retrieval confidence: {meta.confidence}</span>
              </Badge>
            )}
            {meta.answer_mode && MODE_LABEL[meta.answer_mode] && (
              <Badge variant="outline" className="text-xs bg-muted">{MODE_LABEL[meta.answer_mode]}</Badge>
            )}
            {meta.detected_categories?.map((c) => (
              <Badge key={c.id} variant="secondary" className="text-xs font-normal">{c.label}</Badge>
            ))}
            {meta.rules_matched > 0 && (
              <Badge variant="outline" className="text-xs">{meta.rules_matched} numeric rule{meta.rules_matched === 1 ? "" : "s"}</Badge>
            )}
          </div>
          {meta.rewritten_query && (
            <p className="text-xs text-muted-foreground">Understood as: “{meta.rewritten_query}”</p>
          )}
          {meta.fallbacks && meta.fallbacks.length > 0 && (
            <p className="text-xs text-muted-foreground">Search note: {meta.fallbacks.join("; ")}.</p>
          )}
          {sources.length > 0 && <SourceList sources={sources} onOpen={onOpenSource} />}
        </div>
      )}
    </div>
  );
};

const ChatPage = () => {
  const { messages, loading, send, clear, retryLast, category, setCategory } = useChat();
  const categories = useCategories(false);
  const [input, setInput] = useState("");
  const [viewing, setViewing] = useState<SourceTarget | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  const handleSend = () => {
    const q = input.trim();
    if (!q || loading) return;
    setInput("");
    void send(q);
  };

  const openSource = (s: ChatSource) =>
    setViewing({ clauseUri: s.clause_uri, preview: s, highlight: s.snippet, label: `Source [${s.id}]` });

  const last = messages[messages.length - 1];

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="border-b border-border px-4 py-2 flex flex-wrap items-center gap-2 bg-card">
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="h-8 w-[230px] text-xs" aria-label="Institution type">
            <SelectValue placeholder="All institution types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All institution types</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground hidden sm:inline">
          {category === "all" ? "Answers draw on every institution type." : "Answers are restricted to this institution type."}
        </span>
        <Button variant="ghost" size="sm" className="ml-auto h-8" onClick={clear} disabled={loading}>
          <SquarePen className="h-4 w-4 mr-1.5" /> New chat
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {messages.map((msg, i) => (
          <div key={msg.id ?? i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Bot className="h-4 w-4" />
              </div>
            )}
            <div className="max-w-[80%] min-w-0">
              {msg.role === "assistant" ? (
                <AssistantMessage msg={msg} onOpenSource={openSource} />
              ) : (
                <div className="rounded-xl px-4 py-3 text-sm leading-relaxed bg-primary text-primary-foreground whitespace-pre-wrap">
                  {msg.content}
                </div>
              )}
            </div>
            {msg.role === "user" && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
                <User className="h-4 w-4" />
              </div>
            )}
          </div>
        ))}
        {loading && (
          <div className="flex gap-3" aria-live="polite">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-4 w-4" />
            </div>
            <div className="bg-muted rounded-xl px-4 py-3 flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Searching the directions…
            </div>
          </div>
        )}
        {!loading && last?.error && (
          <div className="flex justify-start pl-11">
            <Button variant="outline" size="sm" onClick={() => void retryLast()}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Retry
            </Button>
          </div>
        )}
      </div>

      <div className="border-t border-border p-4 bg-card">
        <div className="max-w-3xl mx-auto flex gap-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Ask about RBI circulars..."
            className="resize-none min-h-[44px] max-h-32"
            rows={1}
          />
          <Button onClick={handleSend} disabled={loading || !input.trim()} size="icon" className="shrink-0 h-11 w-11" aria-label="Send">
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="max-w-3xl mx-auto mt-1.5 text-[11px] text-muted-foreground flex items-center gap-1">
          <FileText className="h-3 w-3" /> Answers are generated only from the uploaded RBI directions. Always verify against the source paragraph.
        </p>
      </div>

      <SourceViewer target={viewing} onClose={() => setViewing(null)} />
    </div>
  );
};

export default ChatPage;
