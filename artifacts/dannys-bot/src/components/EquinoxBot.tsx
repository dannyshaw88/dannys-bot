import { useState, useRef, useEffect, useCallback } from "react";
import { Send, X, Minus } from "lucide-react";
import { cn } from "@/lib/utils";

const LS_KEY = "aura-farming-bot-state";
type BotState = "bubble" | "open" | "hidden";
type Message = { role: "user" | "assistant"; content: string };

const WELCOME: Message = {
  role: "assistant",
  content: "Hi! I'm the Aura Farming Bot 👋\n\nAsk me anything about using the software",
};

export function AuraFarmingBot() {
  const [botState, setBotState] = useState<BotState>(() => {
    try {
      const s = localStorage.getItem(LS_KEY);
      if (s === "hidden") return "hidden";
    } catch {}
    return "bubble";
  });
  const [messages, setMessages] = useState<Message[]>([WELCOME]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const applyState = useCallback((s: BotState) => {
    setBotState(s);
    try {
      if (s === "hidden") localStorage.setItem(LS_KEY, "hidden");
      else localStorage.removeItem(LS_KEY);
    } catch {}
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<string>).detail;
      if (detail === "open") applyState("open");
    };
    window.addEventListener("aura-farming-bot-open", handler);
    return () => window.removeEventListener("aura-farming-bot-open", handler);
  }, [applyState]);

  useEffect(() => {
    if (botState === "open") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [botState]);

  useEffect(() => {
    if (botState === "open") {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, botState]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");

    const updated: Message[] = [...messages, { role: "user", content: text }];
    setMessages(updated);
    setLoading(true);

    try {
      const res = await fetch("/api/aura-farming-bot/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated }),
      });
      const j = await res.json();
      setMessages(prev => [...prev, {
        role: "assistant",
        content: j.reply ?? "Sorry, I couldn't get a response.",
      }]);
    } catch {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Connection error — please check the server is running and try again.",
      }]);
    }
    setLoading(false);
  }, [input, loading, messages]);

  if (botState === "hidden") return null;

  return (
    <>
      {botState === "bubble" && (
        <button
          onClick={() => applyState("open")}
          title="Talk to Aura Farming Bot"
          className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full shadow-2xl bg-background border border-border/60 flex items-center justify-center transition-transform hover:scale-110 active:scale-95"
          style={{ animation: "eqbot-pulse 3s ease-in-out infinite" }}
        >
          <img src="/bot-logo.png" alt="Aura Farming Bot" className="w-9 h-9 object-contain" />
        </button>
      )}

      {botState === "open" && (
        <div
          className="fixed bottom-5 right-5 z-50 flex flex-col bg-background border border-border rounded-2xl shadow-2xl overflow-hidden"
          style={{ width: 380, height: 520, animation: "eqbot-slideup 0.18s ease-out" }}
        >
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/20 shrink-0">
            <div className="flex items-center gap-2">
              <img src="/bot-logo.png" alt="" className="w-7 h-7 object-contain" style={{ animation: "eqbot-spin-idle 8s linear infinite" }} />
              <div>
                <p className="text-sm font-semibold text-foreground leading-tight">Aura Farming Bot</p>
                <p className="text-[10px] text-muted-foreground leading-tight">Software questions only</p>
              </div>
            </div>
            <div className="flex items-center gap-0.5">
              <button
                onClick={() => applyState("bubble")}
                title="Minimise"
                className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                onClick={() => applyState("hidden")}
                title="Close (accessible from Settings)"
                className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3 [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border">
            {messages.map((m, i) => (
              <div key={i} className={cn("flex items-end gap-2", m.role === "user" ? "justify-end" : "justify-start")}>
                {m.role === "assistant" && (
                  <img src="/bot-logo.png" alt="" className="w-6 h-6 object-contain shrink-0 mb-0.5" />
                )}
                <div className={cn(
                  "max-w-[80%] px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words rounded-2xl",
                  m.role === "user"
                    ? "bg-primary text-primary-foreground rounded-br-sm"
                    : "bg-muted text-foreground rounded-bl-sm"
                )}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div className="flex items-end gap-2">
                <img src="/bot-logo.png" alt="" className="w-6 h-6 object-contain shrink-0 mb-0.5" />
                <div className="bg-muted rounded-2xl rounded-bl-sm px-3.5 py-3 flex gap-1 items-center">
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50 animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="px-3 pb-3 pt-2 border-t border-border shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    sendMessage();
                  }
                }}
                placeholder="Ask a question…"
                rows={1}
                style={{ scrollbarWidth: "none", resize: "none" }}
                className="flex-1 bg-muted/40 border border-input rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring placeholder:text-muted-foreground min-h-[36px] max-h-[80px] overflow-y-auto"
              />
              <button
                onClick={sendMessage}
                disabled={!input.trim() || loading}
                className="w-9 h-9 shrink-0 flex items-center justify-center rounded-xl bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/40 text-center mt-1.5">Enter to send · Shift+Enter for new line</p>
          </div>
        </div>
      )}

      <style>{`
        @keyframes eqbot-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(26,210,242,0.5), 0 4px 24px rgba(0,0,0,0.15); }
          50%       { box-shadow: 0 0 0 10px rgba(26,210,242,0), 0 4px 24px rgba(0,0,0,0.15); }
        }
        @keyframes eqbot-slideup {
          from { opacity: 0; transform: translateY(14px) scale(0.97); }
          to   { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes eqbot-spin-idle {
          0%, 85%, 100% { transform: rotate(0deg); }
          90% { transform: rotate(12deg); }
          95% { transform: rotate(-8deg); }
        }
      `}</style>
    </>
  );
}
