import { useEffect, useRef, useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, MessageCircle, RotateCcw, Send, Sparkles } from "lucide-react";

type TestMessage = { role: "user" | "assistant"; content: string };

const PROMPT_STORAGE_KEY = "aura:snapchat-luna-test-prompt";

function readSavedPrompt(): string {
  try { return localStorage.getItem(PROMPT_STORAGE_KEY) ?? ""; } catch { return ""; }
}

export function LunaTestPage() {
  const [prompt, setPrompt] = useState(readSavedPrompt);
  const [peer, setPeer] = useState("Test user");
  const [messages, setMessages] = useState<TestMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading, notice]);

  const updatePrompt = (value: string) => {
    setPrompt(value);
    try { localStorage.setItem(PROMPT_STORAGE_KEY, value); } catch {}
  };

  const sendMessage = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const content = input.trim();
    if (!content || loading) return;
    if (!prompt.trim()) {
      setError("Enter Luna’s prompt before testing a message.");
      return;
    }

    const nextMessages: TestMessage[] = [...messages, { role: "user", content }];
    setMessages(nextMessages);
    setInput("");
    setError("");
    setNotice("");
    setLoading(true);
    try {
      const response = await fetch("/api/snapchat/luna-test", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, peer, messages: nextMessages }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
      if (data.reply) {
        setMessages(current => [...current, { role: "assistant", content: data.reply }]);
      } else {
        setNotice("Luna skipped this turn. No message was sent.");
      }
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Could not reach Luna.");
    } finally {
      setLoading(false);
    }
  };

  const resetConversation = () => {
    setMessages([]);
    setInput("");
    setError("");
    setNotice("");
  };

  return (
    <AppLayout>
      <div className="space-y-5 pb-8">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <MessageCircle className="h-6 w-6 text-cyan-500" />
              <h1 className="text-2xl font-bold tracking-tight">Luna test ground</h1>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              A text-only Snapchat simulation using Luna’s real reply generator. It never opens a phone or sends a message.
            </p>
          </div>
          <Button variant="outline" onClick={resetConversation} disabled={!messages.length && !input}>
            <RotateCcw className="mr-2 h-4 w-4" />
            Reset chat
          </Button>
        </header>

        <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.9fr)_minmax(420px,1.1fr)]">
          <Card className="h-fit">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Sparkles className="h-4 w-4 text-cyan-500" />
                Luna’s prompt
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                Paste or edit the prompt you want Luna to follow. It is remembered in this browser.
              </p>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="block text-xs font-semibold text-foreground" htmlFor="luna-test-prompt">
                Reply goal / prompt
              </label>
              <textarea
                id="luna-test-prompt"
                value={prompt}
                onChange={event => updatePrompt(event.target.value)}
                placeholder="Paste the Snapchat reply prompt you want to test…"
                className="min-h-[360px] w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                maxLength={12_000}
              />
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Uses the OpenAI key in Settings → Security.</span>
                <span>{prompt.length.toLocaleString()} / 12,000</span>
              </div>
              <div className="rounded-md border border-cyan-200 bg-cyan-50 px-3 py-2 text-xs leading-5 text-cyan-950">
                The prompt is remembered in this browser. Test messages stay on this page and are not written to Aura Farming’s live reply-history file.
              </div>
            </CardContent>
          </Card>

          <Card className="mx-auto flex min-h-[68vh] w-full max-w-[440px] flex-col overflow-hidden rounded-[2rem] border-[8px] border-slate-900 bg-white shadow-xl">
            <div className="flex h-6 shrink-0 items-center justify-between bg-slate-900 px-4 text-[10px] font-medium tracking-wide text-white">
              <span>SNAPCHAT · SIMULATED</span>
              <span>TEST ONLY</span>
            </div>
            <CardHeader className="border-b bg-[#fffc00] pb-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <CardTitle className="text-base">Chat with {peer || "Test user"}</CardTitle>
                  <p className="mt-1 text-xs text-slate-700">Mock conversation · no phone connected</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Contact
                  <input
                    value={peer}
                    onChange={event => setPeer(event.target.value)}
                    maxLength={80}
                    className="h-8 w-32 rounded-md border border-yellow-700/30 bg-white/80 px-2 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>
            </CardHeader>
            <CardContent className="flex min-h-0 flex-1 flex-col p-0">
              <div className="flex-1 space-y-3 overflow-y-auto bg-white p-4">
                {!messages.length && (
                  <div className="flex h-full min-h-64 flex-col items-center justify-center text-center">
                    <div className="mb-3 rounded-full bg-cyan-100 p-3 text-cyan-700">
                      <MessageCircle className="h-6 w-6" />
                    </div>
                    <p className="text-sm font-medium">Start a test conversation</p>
                    <p className="mt-1 max-w-xs text-xs leading-5 text-muted-foreground">
                      Enter a message below and Luna will reply using your prompt.
                    </p>
                  </div>
                )}
                {messages.map((message, index) => (
                  <div
                    key={`${index}-${message.role}`}
                    className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
                  >
                    <div className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 shadow-sm ${
                      message.role === "user"
                        ? "rounded-br-md bg-cyan-600 text-white"
                        : "rounded-bl-md border border-slate-200 bg-white text-slate-900"
                    }`}>
                      <div className={`mb-1 text-[10px] font-semibold uppercase tracking-wide ${
                        message.role === "user" ? "text-cyan-100" : "text-slate-400"
                      }`}>
                        {message.role === "user" ? peer || "You" : "Luna"}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{message.content}</div>
                    </div>
                  </div>
                ))}
                {loading && (
                  <div className="flex justify-start">
                    <div className="flex items-center gap-2 rounded-2xl rounded-bl-md border border-slate-200 bg-white px-3.5 py-3 text-xs text-muted-foreground">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      Luna is replying…
                    </div>
                  </div>
                )}
                {notice && (
                  <p className="mx-auto w-fit rounded-full bg-amber-50 px-3 py-1.5 text-xs text-amber-800">{notice}</p>
                )}
                {error && (
                  <p role="alert" className="mx-auto w-fit rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                    {error}
                  </p>
                )}
                <div ref={bottomRef} />
              </div>
              <form onSubmit={sendMessage} className="flex items-end gap-2 border-t bg-slate-50 p-3">
                <textarea
                  value={input}
                  onChange={event => setInput(event.target.value)}
                  onKeyDown={event => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  placeholder="Type a message as the contact…"
                  aria-label="Message to Luna"
                  rows={2}
                  maxLength={4_000}
                  className="max-h-36 min-h-11 flex-1 resize-y rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <Button type="submit" disabled={loading || !input.trim() || !prompt.trim()} className="h-11">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  <span className="ml-2">Send</span>
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppLayout>
  );
}
