import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Send, Bot, User, Loader2, AlertCircle, CheckCircle, Info } from "lucide-react";
import { askQuery, type ChatMessage, type ChatResponseData } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import ReactMarkdown from "react-markdown";

const confidenceColors: Record<string, string> = {
  high: "bg-green-100 text-green-800 border-green-300",
  medium: "bg-yellow-100 text-yellow-800 border-yellow-300",
  low: "bg-red-100 text-red-800 border-red-300",
};

const ConfidenceIcon = ({ level }: { level: string }) => {
  if (level === "high") return <CheckCircle className="h-3 w-3" />;
  if (level === "medium") return <Info className="h-3 w-3" />;
  return <AlertCircle className="h-3 w-3" />;
};

const ChatPage = () => {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Hello! I'm your RBI Circular Assistant. Ask me anything about RBI regulations, circulars, or compliance requirements." },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const query = input.trim();
    if (!query || loading) return;

    setMessages((prev) => [...prev, { role: "user", content: query }]);
    setInput("");
    setLoading(true);

    try {
      const data: ChatResponseData = await askQuery(query);
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.answer, metadata: data },
      ]);
    } catch {
      toast({ title: "Error", description: "Failed to get response. Check your backend connection.", variant: "destructive" });
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "Sorry, I couldn't process your request. Please ensure the backend is running." },
      ]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 md:p-6 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "assistant" && (
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Bot className="h-4 w-4" />
              </div>
            )}
            <div className={`max-w-[75%] space-y-2`}>
              <div
                className={`rounded-xl px-4 py-3 text-sm leading-relaxed ${
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-foreground"
                }`}
              >
                {msg.role === "assistant" ? (
                  <div className="prose prose-sm max-w-none dark:prose-invert">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  msg.content
                )}
              </div>
              {/* Metadata for assistant messages */}
              {msg.role === "assistant" && msg.metadata && (
                <div className="space-y-2 px-1">
                  <div className="flex flex-wrap gap-1.5">
                    <Badge variant="outline" className={`text-xs ${confidenceColors[msg.metadata.confidence] || ""}`}>
                      <ConfidenceIcon level={msg.metadata.confidence} />
                      <span className="ml-1">Confidence: {msg.metadata.confidence}</span>
                    </Badge>
                    {msg.metadata.fallback_used && (
                      <Badge variant="outline" className="text-xs bg-muted">General knowledge</Badge>
                    )}
                    {msg.metadata.sources_used > 0 && (
                      <Badge variant="outline" className="text-xs">{msg.metadata.sources_used} sources</Badge>
                    )}
                    {msg.metadata.rules_matched > 0 && (
                      <Badge variant="outline" className="text-xs">{msg.metadata.rules_matched} rules matched</Badge>
                    )}
                  </div>
                  {msg.metadata.relevant_rule_ids?.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Referenced Rules: </span>
                      {msg.metadata.relevant_rule_ids.join(", ")}
                    </div>
                  )}
                  {msg.metadata.source_circulars?.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      <span className="font-medium">Source Circulars: </span>
                      {msg.metadata.source_circulars.join(", ")}
                    </div>
                  )}
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
          <div className="flex gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Bot className="h-4 w-4" />
            </div>
            <div className="bg-muted rounded-xl px-4 py-3">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          </div>
        )}
      </div>

      {/* Input */}
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
          <Button onClick={handleSend} disabled={loading || !input.trim()} size="icon" className="shrink-0 h-11 w-11">
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default ChatPage;
