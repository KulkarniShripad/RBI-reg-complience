import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { askQuery, type ChatMessage } from "@/lib/api";

/**
 * Chat state lives here, above the router's page components, so switching
 * between Chat / Upload / Topics / Rules / Compliance in the sidebar does not
 * unmount it. It is also mirrored to localStorage, so a page reload keeps the
 * conversation. A question that is still being answered when you navigate
 * away completes in the background and appears when you come back.
 */

const STORAGE_KEY = "urcc.chat.v1";
const MAX_STORED_MESSAGES = 60;

export const WELCOME: ChatMessage = {
  id: "welcome",
  role: "assistant",
  content:
    "Hello! I'm your RBI Circular Assistant. Ask me anything about RBI Master Directions - limits, time lines, definitions or procedures. " +
    "Each answer lists the exact paragraphs it is based on; click a source to read it.",
};

interface Stored {
  messages: ChatMessage[];
  category: string;
}

const readStored = (): Stored | null => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Stored;
    if (!Array.isArray(parsed.messages)) return null;
    return { messages: parsed.messages, category: typeof parsed.category === "string" ? parsed.category : "all" };
  } catch {
    return null;
  }
};

const writeStored = (value: Stored) => {
  const messages = value.messages.slice(-MAX_STORED_MESSAGES);
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, messages }));
  } catch {
    // Storage full: keep the conversation text, drop the (large) source payloads of older answers.
    try {
      const slim = messages.map((m, i) => (i < messages.length - 6 ? { ...m, metadata: undefined } : m));
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...value, messages: slim }));
    } catch {
      /* storage unavailable (private mode) - the in-memory state still works */
    }
  }
};

let idCounter = 0;
const newId = () => `${Date.now().toString(36)}-${(idCounter++).toString(36)}`;

interface ChatContextValue {
  messages: ChatMessage[];
  loading: boolean;
  category: string;
  setCategory: (c: string) => void;
  send: (text: string) => Promise<void>;
  retryLast: () => Promise<void>;
  clear: () => void;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export const ChatProvider = ({ children }: { children: ReactNode }) => {
  const stored = useMemo(readStored, []);
  const [messages, setMessages] = useState<ChatMessage[]>(stored?.messages?.length ? stored.messages : [WELCOME]);
  const [category, setCategory] = useState<string>(stored?.category ?? "all");
  const [loading, setLoading] = useState(false);
  const pending = useRef(0);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    writeStored({ messages, category });
  }, [messages, category]);

  const send = useCallback(
    async (text: string) => {
      const query = text.trim();
      if (!query) return;
      const history = messagesRef.current
        .filter((m) => m.id !== "welcome" && !m.error)
        .slice(-6)
        .map((m) => ({ role: m.role, content: m.content }));
      setMessages((prev) => [...prev, { id: newId(), role: "user", content: query, createdAt: new Date().toISOString() }]);
      pending.current += 1;
      setLoading(true);
      try {
        const data = await askQuery(query, { history, category: category === "all" ? null : category });
        setMessages((prev) => [
          ...prev,
          { id: newId(), role: "assistant", content: data.answer, metadata: data, createdAt: new Date().toISOString() },
        ]);
      } catch (err: unknown) {
        const detail =
          (err as { response?: { data?: { error?: string } } })?.response?.data?.error ||
          "I couldn't reach the backend. Please check that it is running and try again.";
        setMessages((prev) => [...prev, { id: newId(), role: "assistant", content: detail, error: true }]);
      } finally {
        pending.current -= 1;
        if (pending.current <= 0) setLoading(false);
      }
    },
    [category],
  );

  const retryLast = useCallback(async () => {
    const lastUser = [...messagesRef.current].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setMessages((prev) => (prev.length && prev[prev.length - 1].error ? prev.slice(0, -2) : prev));
    await send(lastUser.content);
  }, [send]);

  const clear = useCallback(() => {
    setMessages([WELCOME]);
  }, []);

  const value = useMemo(
    () => ({ messages, loading, category, setCategory, send, retryLast, clear }),
    [messages, loading, category, send, retryLast, clear],
  );
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
};

export const useChat = () => {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
};
