import { useState, useRef, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Smartphone, RefreshCw, Home, Volume2, VolumeX, Power,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  Keyboard, UserPlus, Loader2, Copy, CheckCircle2,
  Mail, Lock, Calendar, Server, Key, Download, Zap,
  Play, Pause, CircleDot,
} from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveSpintax(template: string): string {
  let result = template;
  let prev = "";
  while (result !== prev) {
    prev = result;
    result = result.replace(/\{([^{}]*)\}/g, (_m, inner) => {
      const opts = inner.split("|");
      return opts[Math.floor(Math.random() * opts.length)];
    });
  }
  return result.trim();
}

function generatePassword(length = 14): string {
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  const lower = "abcdefghjkmnpqrstuvwxyz";
  const digits = "23456789";
  const special = "!@#$%&*";
  const all = upper + lower + digits + special;
  const rand = (s: string) => s[Math.floor(Math.random() * s.length)];
  const chars = [rand(upper), rand(lower), rand(digits), rand(special)];
  for (let i = chars.length; i < length; i++) chars.push(rand(all));
  return chars.sort(() => Math.random() - 0.5).join("");
}

function generateDob(): string {
  const age = Math.floor(Math.random() * 22) + 18;
  const now = new Date();
  const year = now.getFullYear() - age;
  const month = Math.floor(Math.random() * 12) + 1;
  const daysInMonth = new Date(year, month, 0).getDate();
  const day = Math.floor(Math.random() * daysInMonth) + 1;
  return `${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}/${year}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface IosDevice {
  udid: string;
  name: string;
  ios: string;
  connected: "usb" | "wifi";
}

type SetupStage =
  | "no_device"       // nothing plugged in
  | "device_found"    // phone detected, need to check WDA
  | "installing_wda"  // downloading + installing WDA
  | "starting_iproxy" // iproxy launching
  | "ready";          // WDA connected, full control active

const IPHONE_W = 390;
const IPHONE_H = 844;

// ── Phone frame ───────────────────────────────────────────────────────────────

interface PhoneFrameProps {
  jpeg: string | null;
  streaming: boolean;
  fps: number;
  onTap: (x: number, y: number) => void;
  onSwipe: (fx: number, fy: number, tx: number, ty: number) => void;
}

function PhoneFrame({ jpeg, streaming, fps, onTap, onSwipe }: PhoneFrameProps) {
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const toCoords = (e: React.MouseEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - rect.left) / rect.width) * IPHONE_W),
      y: Math.round(((e.clientY - rect.top) / rect.height) * IPHONE_H),
    };
  };

  return (
    <div className="flex flex-col items-center gap-2">
      <div
        className="relative rounded-[38px] border-[6px] border-gray-800 dark:border-gray-600 bg-black shadow-2xl overflow-hidden select-none"
        style={{ width: 270, height: 585 }}
      >
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-b-2xl z-10" />
        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-24 h-1 bg-white/30 rounded-full z-10" />
        <div
          className="w-full h-full cursor-crosshair"
          onMouseDown={e => { swipeStart.current = toCoords(e); }}
          onMouseUp={e => {
            if (!swipeStart.current) return;
            const end = toCoords(e);
            const dx = Math.abs(end.x - swipeStart.current.x);
            const dy = Math.abs(end.y - swipeStart.current.y);
            if (dx < 8 && dy < 8) {
              onTap(end.x, end.y);
            } else {
              onSwipe(swipeStart.current.x, swipeStart.current.y, end.x, end.y);
            }
            swipeStart.current = null;
          }}
        >
          {jpeg ? (
            <img
              src={`data:image/jpeg;base64,${jpeg}`}
              className="w-full h-full object-cover"
              draggable={false}
              alt="iPhone screen"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gray-900">
              <Smartphone className="w-10 h-10 text-gray-600" />
              <p className="text-xs text-gray-500 text-center px-4">
                {streaming ? "Capturing…" : "Plug in your iPhone to start"}
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
        <span>Click to tap · Drag to swipe</span>
        {streaming && (
          <span className="font-mono text-primary" style={{ color: "#1AD2F2" }}>{fps} fps</span>
        )}
      </div>
    </div>
  );
}

// ── Setup progress panel ──────────────────────────────────────────────────────

interface DiagResult {
  binaryFound: boolean;
  appleDriverRunning: boolean;
  suggestion: string;
  rawError: string;
  amdPath?: string;
  debugOutput?: string;
  binaryPath?: string;
}

interface SetupPanelProps {
  stage: SetupStage;
  devices: IosDevice[];
  selectedUdid: string | null;
  installProgress: number;
  installMessage: string;
  diagnosis: DiagResult | null;
  diagnosing: boolean;
  onInstallWda: () => void;
  onRetry: () => void;
}

function SetupPanel({ stage, devices, selectedUdid, installProgress, installMessage, diagnosis, diagnosing, onInstallWda, onRetry }: SetupPanelProps) {
  const steps = [
    { id: "plug",    label: "Plug in iPhone",             done: stage !== "no_device" },
    { id: "trust",   label: "Tap \"Trust\" on iPhone",    done: stage === "installing_wda" || stage === "starting_iproxy" || stage === "ready" },
    { id: "agent",   label: "Install control agent",      done: stage === "starting_iproxy" || stage === "ready" },
    { id: "connect", label: "Connect",                    done: stage === "ready" },
  ];

  const itunesRequired  = diagnosis?.suggestion === "itunes_required";
  const binaryMissing   = diagnosis !== null && !diagnosis.binaryFound;
  const noConnection    = diagnosis?.suggestion === "no_connection"
    || diagnosis?.suggestion === "unlock"
    || diagnosis?.suggestion === "needs_trust";
  const hasError        = diagnosis?.suggestion?.startsWith("error:") ?? false;
  const errorText       = hasError ? diagnosis!.suggestion.slice(6) : "";

  return (
    <div className="rounded-xl border border-border bg-card p-5 space-y-5">
      <div className="flex items-center gap-2">
        <Zap className="w-4 h-4" style={{ color: "#1AD2F2" }} />
        <p className="text-sm font-bold">Getting started — plug in your iPhone</p>
      </div>

      {/* Step progress */}
      <div className="space-y-3">
        {steps.map((s, i) => (
          <div key={s.id} className="flex items-center gap-3">
            <div className={cn(
              "w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0 border",
              s.done
                ? "bg-green-500 border-green-500 text-white"
                : "border-border bg-muted/40 text-muted-foreground",
            )}>
              {s.done ? "✓" : i + 1}
            </div>
            <span className={cn("text-sm", s.done ? "text-foreground line-through opacity-50" : "text-foreground font-medium")}>
              {s.label}
            </span>
          </div>
        ))}
      </div>

      {/* Stage-specific action */}
      {stage === "no_device" && (
        <div className="space-y-3">
          {/* iTunes required — most common root cause */}
          {itunesRequired && (
            <div className="rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/30 p-4 space-y-3">
              <div className="flex items-start gap-2">
                <span className="text-amber-600 dark:text-amber-400 text-base leading-none mt-0.5">⚠</span>
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Apple USB driver required</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Equinox needs <strong>iTunes</strong> (or the <strong>Apple Devices</strong> app) installed on this PC so Windows can communicate with your iPhone over USB. Without it, the iPhone is invisible to Equinox even when plugged in.
                  </p>
                </div>
              </div>
              <div className="flex gap-2">
                <a
                  href="https://www.apple.com/itunes/download/win64"
                  target="_blank"
                  rel="noreferrer"
                  className="flex-1"
                >
                  <Button className="w-full h-9 text-xs font-semibold" style={{ background: "#1AD2F2", color: "#000" }}>
                    <Download className="w-3.5 h-3.5 mr-1.5" />
                    Download iTunes (Apple)
                  </Button>
                </a>
                <Button variant="outline" size="sm" className="h-9 text-xs" onClick={onRetry}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1" />
                  Retry
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Install iTunes, restart Equinox, then plug in your iPhone again.
              </p>
            </div>
          )}

          {/* Binary missing */}
          {binaryMissing && (
            <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 text-sm text-red-800 dark:text-red-300">
              <p className="font-semibold">Equinox binaries not found</p>
              <p className="text-xs mt-1">The iPhone communication tools are missing. Try reinstalling Equinox.</p>
            </div>
          )}

          {/* Diagnosing spinner */}
          {diagnosing && !itunesRequired && !binaryMissing && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              Checking iPhone connection…
            </div>
          )}

          {/* iPhone connected but Equinox can't communicate with it */}
          {noConnection && !diagnosing && (
            <div className="rounded-lg border border-border bg-muted/30 p-4 space-y-3">
              <p className="text-sm font-semibold">iPhone connected — can't communicate yet</p>
              <p className="text-[11px] text-muted-foreground">
                You don't need to do anything special on your iPhone — no app to open, no setting to change. Just a USB cable connected to your PC is all that's needed. Work through these steps:
              </p>
              <ol className="space-y-2">
                {[
                  { n: 1, text: <>Make sure your iPhone screen is <strong>on and unlocked</strong> — swipe up and enter your passcode.</> },
                  { n: 2, text: <>Look for a <strong>"Trust This Computer?"</strong> popup on your iPhone — tap <strong>Trust</strong> and enter your passcode. (Only appears on first connection.)</> },
                  { n: 3, text: <>Make sure you're using a <strong>data cable</strong> (not a charge-only cable). Try a different USB port — prefer <strong>USB 2.0</strong> (black port) over USB 3.0 (blue port).</> },
                  { n: 4, text: <>Unplug and replug the cable, then wait 5 seconds.</> },
                  { n: 5, text: <>Press <strong>Win + R</strong>, type <code className="bg-muted px-1 rounded text-[10px]">services.msc</code>, find <strong>Apple Mobile Device Service</strong>, right-click → <strong>Restart</strong>.</> },
                ].map(s => (
                  <li key={s.n} className="flex gap-2.5 items-start">
                    <span className="shrink-0 w-5 h-5 rounded-full bg-muted border border-border flex items-center justify-center text-[10px] font-bold text-muted-foreground mt-0.5">{s.n}</span>
                    <span className="text-xs text-foreground leading-relaxed">{s.text}</span>
                  </li>
                ))}
              </ol>
              {diagnosis?.debugOutput && (
                <details className="mt-1">
                  <summary className="text-[10px] text-muted-foreground cursor-pointer hover:text-foreground">Technical details (share with support)</summary>
                  <pre className="mt-1.5 text-[9px] font-mono bg-muted/60 border border-border rounded p-2 overflow-x-auto whitespace-pre-wrap break-all leading-relaxed text-muted-foreground">
                    {[
                      `binary: ${diagnosis.binaryPath ?? "unknown"}`,
                      `amdPath: ${diagnosis.amdPath ?? "none"}`,
                      `debug: ${diagnosis.debugOutput}`,
                    ].join("\n")}
                  </pre>
                </details>
              )}
            </div>
          )}

          {/* Detection returned an actual error */}
          {hasError && !diagnosing && (
            <div className="rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3 space-y-1">
              <p className="text-sm font-semibold text-red-800 dark:text-red-300">Detection error</p>
              <p className="text-xs font-mono text-red-600 dark:text-red-400 break-all">{errorText}</p>
              {diagnosis?.amdPath && (
                <p className="text-[10px] text-muted-foreground">Apple DLL path: {diagnosis.amdPath}</p>
              )}
            </div>
          )}

          {/* Generic waiting — no diagnosis yet or suggestion is empty */}
          {!itunesRequired && !binaryMissing && !noConnection && !hasError && !diagnosing && (
            <div className="rounded-lg bg-muted/40 border border-border p-3 text-sm text-muted-foreground">
              Waiting for your iPhone… plug it in with a USB cable and it will appear here automatically.
            </div>
          )}

          {/* Retry button when diagnosis is done */}
          {!itunesRequired && !binaryMissing && diagnosis !== null && (
            <Button variant="outline" size="sm" className="w-full h-8 text-xs" onClick={onRetry}>
              <RefreshCw className="w-3.5 h-3.5 mr-1" />
              Check again
            </Button>
          )}
        </div>
      )}

      {stage === "device_found" && (
        <div className="space-y-3">
          <div className="rounded-lg bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-800 p-3 text-sm text-blue-800 dark:text-blue-300">
            <strong>iPhone detected!</strong> If your iPhone shows <em>"Trust This Computer?"</em> — tap <strong>Trust</strong> and enter your passcode.
          </div>
          <Button
            onClick={onInstallWda}
            className="w-full h-10 font-semibold"
            style={{ background: "#1AD2F2", color: "#000" }}
          >
            <Download className="w-4 h-4 mr-2" />
            Install Control Agent (one-time)
          </Button>
          <p className="text-[11px] text-muted-foreground text-center">
            This installs the control bridge on your iPhone — takes about 30 seconds. No Apple ID needed.
          </p>
        </div>
      )}

      {stage === "installing_wda" && (
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/40 p-3 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Loader2 className="w-4 h-4 animate-spin" style={{ color: "#1AD2F2" }} />
              {installMessage || "Installing control agent…"}
            </div>
            {installProgress > 0 && installProgress < 100 && (
              <div className="w-full bg-muted rounded-full h-1.5 overflow-hidden">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${installProgress}%`, background: "#1AD2F2" }}
                />
              </div>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground text-center">
            Keep your iPhone unlocked and screen on while this runs.
          </p>
        </div>
      )}

      {stage === "starting_iproxy" && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
          <Loader2 className="w-4 h-4 animate-spin shrink-0" style={{ color: "#1AD2F2" }} />
          Connecting to your iPhone…
        </div>
      )}

      {stage === "ready" && (
        <div className="rounded-lg bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 p-3 text-sm text-green-800 dark:text-green-300 font-medium">
          ✅ Connected — full control active. Click the screen to tap, drag to swipe.
        </div>
      )}
    </div>
  );
}

// ── Control pad ───────────────────────────────────────────────────────────────

function ControlPad({ onCommand, disabled }: { onCommand: (cmd: string, payload?: any) => void; disabled: boolean }) {
  const [typeText, setTypeText] = useState("");

  return (
    <div className={cn("space-y-5", disabled && "opacity-40 pointer-events-none")}>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Hardware Buttons</p>
        <div className="flex gap-2 flex-wrap">
          {[
            { label: "Home",  icon: Home,    cmd: "pressButton", payload: "home" },
            { label: "Power", icon: Power,   cmd: "pressButton", payload: "power" },
            { label: "Vol +", icon: Volume2, cmd: "pressButton", payload: "volumeUp" },
            { label: "Vol −", icon: VolumeX, cmd: "pressButton", payload: "volumeDown" },
          ].map(b => (
            <button
              key={b.label}
              onClick={() => onCommand(b.cmd, b.payload)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-muted/40 text-xs font-medium hover:bg-accent transition-colors"
            >
              <b.icon className="w-3.5 h-3.5" />
              {b.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Swipe</p>
        <div className="grid grid-cols-3 gap-1 w-28">
          <div />
          <button onClick={() => onCommand("swipe", { dir: "up" })}
            className="flex items-center justify-center h-8 rounded border border-border bg-muted/40 hover:bg-accent transition-colors">
            <ChevronUp className="w-4 h-4" />
          </button>
          <div />
          <button onClick={() => onCommand("swipe", { dir: "left" })}
            className="flex items-center justify-center h-8 rounded border border-border bg-muted/40 hover:bg-accent transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center justify-center h-8 rounded border border-border/50 bg-muted/20">
            <Smartphone className="w-3 h-3 text-muted-foreground" />
          </div>
          <button onClick={() => onCommand("swipe", { dir: "right" })}
            className="flex items-center justify-center h-8 rounded border border-border bg-muted/40 hover:bg-accent transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          <div />
          <button onClick={() => onCommand("swipe", { dir: "down" })}
            className="flex items-center justify-center h-8 rounded border border-border bg-muted/40 hover:bg-accent transition-colors">
            <ChevronDown className="w-4 h-4" />
          </button>
          <div />
        </div>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Type Text</p>
        <div className="flex gap-2">
          <Input
            value={typeText}
            onChange={e => setTypeText(e.target.value)}
            placeholder="Text to type on iPhone…"
            className="h-8 text-xs flex-1"
            onKeyDown={e => { if (e.key === "Enter" && typeText) { onCommand("type", typeText); setTypeText(""); } }}
          />
          <Button
            variant="outline" size="sm"
            disabled={!typeText}
            onClick={() => { onCommand("type", typeText); setTypeText(""); }}
            className="h-8 px-3 text-xs"
          >
            <Keyboard className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Quick Actions</p>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => onCommand("openApp", "com.burbn.instagram")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-muted/40 text-xs font-medium hover:bg-accent transition-colors"
          >
            <Smartphone className="w-3.5 h-3.5" /> Open Instagram
          </button>
          <button
            onClick={() => onCommand("openApp", "com.apple.mobilesafari")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border bg-muted/40 text-xs font-medium hover:bg-accent transition-colors"
          >
            <Smartphone className="w-3.5 h-3.5" /> Open Safari
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Signup panel ──────────────────────────────────────────────────────────────

const LS_KEY = "mirror-signup-fields-v1";
const loadLS = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(LS_KEY) ?? "{}"); } catch { return {}; } };

function SignupPanel({ wdaConnected }: { wdaConnected: boolean }) {
  const ls = loadLS();
  const [usernameSpin, setUsernameSpin] = useState(() => ls.usernameSpin ?? "");
  const [password, setPassword]         = useState(() => ls.password ?? generatePassword());
  const [emailAddr, setEmailAddr]       = useState(() => ls.emailAddr ?? "");
  const [emailPass, setEmailPass]       = useState(() => ls.emailPass ?? "");
  const [imapHost, setImapHost]         = useState(() => ls.imapHost ?? "");
  const [imapPort, setImapPort]         = useState(() => ls.imapPort ?? "993");
  const [imapSecure, setImapSecure]     = useState(() => (ls.imapSecure ?? "true") === "true");
  const [dob, setDob]                   = useState(() => ls.dob ?? generateDob());

  const [sessionId, setSessionId]     = useState<string | null>(null);
  const [signupRunning, setSignupRunning] = useState(false);
  const [signupStatus, setSignupStatus]   = useState("");
  const [manualCode, setManualCode]       = useState("");
  const [codePending, setCodePending]     = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        usernameSpin, password, dob, emailAddr, emailPass,
        imapHost, imapPort, imapSecure: String(imapSecure),
      }));
    } catch {}
  }, [usernameSpin, password, dob, emailAddr, emailPass, imapHost, imapPort, imapSecure]);

  useEffect(() => {
    if (!signupRunning || !sessionId) {
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return;
    }
    pollRef.current = setInterval(async () => {
      try {
        const r = await fetch(`/api/mirror/signup-status?sessionId=${encodeURIComponent(sessionId)}`);
        const j = await r.json() as any;
        if (j.msg) setSignupStatus(j.msg);
        if (j.msg?.includes("verification") || j.msg?.includes("code")) setCodePending(true);
        if (j.done) { setSignupRunning(false); setCodePending(false); }
      } catch {}
    }, 2000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [signupRunning, sessionId]);

  const username = usernameSpin.trim() ? resolveSpintax(usernameSpin) : "";

  const handleSignup = async () => {
    if (!username || !password || !emailAddr || !dob) {
      setSignupStatus("⚠ Fill in username, password, email and DOB first.");
      return;
    }
    setSignupRunning(true);
    setSignupStatus("Starting…");
    setCodePending(false);
    try {
      const r = await fetch("/api/mirror/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailAddr, password, username, dob }),
      });
      const j = await r.json() as any;
      if (j.ok) setSessionId(j.sessionId);
      else { setSignupStatus(`⚠ ${j.error}`); setSignupRunning(false); }
    } catch (e: any) {
      setSignupStatus(`⚠ ${e.message}`);
      setSignupRunning(false);
    }
  };

  const handleSubmitCode = async () => {
    if (!manualCode.trim() || !sessionId) return;
    try {
      await fetch("/api/mirror/signup-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, code: manualCode.trim() }),
      });
      setManualCode("");
      setCodePending(false);
    } catch {}
  };

  const handleFetchCode = async () => {
    if (!emailAddr || !emailPass || !imapHost) return;
    try {
      const r = await fetch("/api/signup/browser/fetch-imap-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: emailAddr, password: emailPass, imapHost, imapPort: Number(imapPort), secure: imapSecure }),
      });
      const j = await r.json() as any;
      if (j.code) { setManualCode(j.code); setSignupStatus(`Code fetched: ${j.code}`); }
      else setSignupStatus(`⚠ No code found: ${j.error ?? ""}`);
    } catch (e: any) {
      setSignupStatus(`⚠ IMAP error: ${e.message}`);
    }
  };

  const CopyBtn = ({ val }: { val: string }) => {
    const [c, setC] = useState(false);
    return (
      <button onClick={() => { navigator.clipboard.writeText(val).catch(() => {}); setC(true); setTimeout(() => setC(false), 1500); }}
        disabled={!val} className="flex items-center gap-1 px-2 h-8 rounded border border-input bg-muted/50 text-[10px] font-medium text-muted-foreground hover:bg-accent transition-colors">
        {c ? <CheckCircle2 className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
        {c ? "Copied" : "Copy"}
      </button>
    );
  };

  const Field = ({ label, icon: Icon, value, onChange, type = "text", placeholder }: any) => (
    <div className="space-y-1">
      <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
        <Icon className="w-3 h-3" /> {label}
      </label>
      <div className="flex gap-1.5">
        <Input type={type} value={value} onChange={(e: any) => onChange(e.target.value)}
          placeholder={placeholder} className="h-8 text-xs flex-1" />
        <CopyBtn val={value} />
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      {!wdaConnected && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-2.5 text-xs text-amber-800 dark:text-amber-300">
          <strong>Connect your iPhone first</strong> — use the Controls tab to set up the connection.
        </div>
      )}

      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Account Details</p>
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <UserPlus className="w-3 h-3" /> Username (Spintax OK)
          </label>
          <div className="flex gap-1.5">
            <Input value={usernameSpin} onChange={e => setUsernameSpin(e.target.value)}
              placeholder="{user|person|girl}_{name|photo}_{01|02}" className="h-8 text-xs flex-1" />
            <CopyBtn val={username} />
          </div>
          {username && <p className="text-[10px] text-muted-foreground">→ <span className="font-mono text-primary">{username}</span></p>}
        </div>
        <Field label="Password" icon={Lock} value={password} onChange={setPassword} type="password" placeholder="Password" />
        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Date of Birth
          </label>
          <div className="flex gap-1.5">
            <Input value={dob} onChange={e => setDob(e.target.value)} placeholder="DD/MM/YYYY" className="h-8 text-xs flex-1" />
            <button onClick={() => setDob(generateDob())}
              className="flex items-center gap-1 px-2 h-8 rounded border border-input bg-muted/50 text-[10px] hover:bg-accent transition-colors">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Email / IMAP</p>
        <Field label="Email Address" icon={Mail} value={emailAddr} onChange={setEmailAddr} placeholder="example@gmail.com" />
        <Field label="Email Password" icon={Key} value={emailPass} onChange={setEmailPass} type="password" placeholder="For IMAP code fetch" />
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Server className="w-3 h-3" /> IMAP Host
            </label>
            <Input value={imapHost} onChange={e => setImapHost(e.target.value)} placeholder="imap.gmail.com" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Port</label>
            <Input value={imapPort} onChange={e => setImapPort(e.target.value)} placeholder="993" className="h-8 text-xs" />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <input type="checkbox" checked={imapSecure} onChange={e => setImapSecure(e.target.checked)} className="w-3.5 h-3.5" />
          SSL/TLS
        </label>
      </div>

      <Button
        onClick={handleSignup}
        disabled={signupRunning || !username || !password || !emailAddr || !dob}
        className="w-full h-9 text-sm font-semibold"
        style={{ background: "#1AD2F2", color: "#000" }}
      >
        {signupRunning
          ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing up…</>
          : <><UserPlus className="w-4 h-4 mr-2" />Auto Signup on iPhone</>}
      </Button>

      {signupStatus && (
        <div className={cn(
          "rounded-lg p-2.5 text-xs font-medium border",
          signupStatus.startsWith("✅")
            ? "bg-green-50 border-green-200 text-green-800 dark:bg-green-950/30 dark:border-green-800"
            : signupStatus.startsWith("⚠")
            ? "bg-red-50 border-red-200 text-red-800 dark:bg-red-950/30 dark:border-red-800"
            : "bg-muted/60 border-border text-muted-foreground",
        )}>
          {signupStatus}
        </div>
      )}

      {codePending && signupRunning && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <p className="text-xs font-semibold">Enter verification code</p>
          <div className="flex gap-2">
            <Input value={manualCode} onChange={e => setManualCode(e.target.value)}
              placeholder="6-digit code" className="h-8 text-xs flex-1 font-mono tracking-widest" />
            <Button variant="outline" size="sm" onClick={handleFetchCode}
              disabled={!emailAddr || !emailPass || !imapHost} className="h-8 px-2 text-[10px]">
              <Mail className="w-3 h-3 mr-1" /> IMAP
            </Button>
            <Button size="sm" onClick={handleSubmitCode} disabled={!manualCode.trim()} className="h-8 px-3 text-[10px]">
              Submit
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function MirrorPage() {
  const [devices, setDevices]           = useState<IosDevice[]>([]);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [wdaConnected, setWdaConnected] = useState(false);
  const [iproxyRunning, setIproxyRunning] = useState(false);
  const [stage, setStage]               = useState<SetupStage>("no_device");
  const [streaming, setStreaming]       = useState(false);
  const [jpeg, setJpeg]                 = useState<string | null>(null);
  const [fps, setFps]                   = useState(0);
  const [tab, setTab]                   = useState<"controls" | "signup">("controls");
  const [toastMsg, setToastMsg]         = useState("");
  const [installSessionId, setInstallSessionId] = useState<string | null>(null);
  const [installProgress, setInstallProgress]   = useState(0);
  const [installMessage, setInstallMessage]     = useState("");

  const [diagnosis, setDiagnosis]   = useState<DiagResult | null>(null);
  const [diagnosing, setDiagnosing] = useState(false);

  const streamRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const fpsCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const installPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 2500);
  };

  // ── Diagnose why no device found ────────────────────────────────────────────

  const runDiagnose = useCallback(async () => {
    setDiagnosing(true);
    try {
      const r = await fetch("/api/mirror/diagnose");
      const j = await r.json() as any;
      setDiagnosis({
        binaryFound: !!j.binaryFound,
        appleDriverRunning: !!j.appleDriverRunning,
        suggestion: j.suggestion ?? "",
        rawError: j.rawError ?? "",
        amdPath: j.amdPath ?? "",
      });
    } catch {
      setDiagnosis({ binaryFound: false, appleDriverRunning: false, suggestion: "", rawError: "", amdPath: "" });
    } finally {
      setDiagnosing(false);
    }
  }, []);

  // ── Compute setup stage from state ──────────────────────────────────────────

  useEffect(() => {
    if (wdaConnected) {
      setStage("ready");
    } else if (iproxyRunning) {
      setStage("starting_iproxy");
    } else if (installSessionId) {
      setStage("installing_wda");
    } else if (devices.length > 0) {
      setStage("device_found");
      setDiagnosis(null); // clear any old diagnosis once device is found
    } else {
      setStage("no_device");
    }
  }, [devices, wdaConnected, iproxyRunning, installSessionId]);

  // ── Run diagnosis once when we hit no_device, with a short delay ────────────

  useEffect(() => {
    if (stage !== "no_device") return;
    const t = setTimeout(() => { runDiagnose(); }, 2500);
    return () => clearTimeout(t);
  }, [stage, runDiagnose]);

  // ── Auto-start iproxy when device detected ─────────────────────────────────

  useEffect(() => {
    if (selectedUdid && stage === "device_found" && !iproxyRunning && !installSessionId) {
      // Don't auto-install — wait for user to click. But DO auto-start iproxy
      // if WDA was already installed (from a previous session).
      fetch("/api/mirror/iproxy/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udid: selectedUdid }),
      }).then(r => r.json()).then((j: any) => {
        if (j.ok) setIproxyRunning(true);
      }).catch(() => {});
    }
  }, [selectedUdid, stage, iproxyRunning, installSessionId]);

  // ── Poll devices + WDA status ──────────────────────────────────────────────

  const refreshStatus = useCallback(async () => {
    try {
      const [dr, wr] = await Promise.all([
        fetch("/api/mirror/devices").then(r => r.json()),
        fetch("/api/mirror/wda-status").then(r => r.json()),
      ]);
      const devs: IosDevice[] = (dr as any).devices ?? [];
      setDevices(devs);
      setWdaConnected(!!(wr as any).connected);
      setIproxyRunning(!!(wr as any).iproxy?.running);
      if (devs.length && !selectedUdid) {
        setSelectedUdid(devs[0].udid);
      }
      // If phone disconnected, stop stream
      if (!devs.length) {
        stopStream();
        setJpeg(null);
      }
    } catch {}
  }, [selectedUdid]);

  useEffect(() => {
    refreshStatus();
    const t = setInterval(refreshStatus, 5_000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  // ── Auto-start stream when WDA connects ───────────────────────────────────

  useEffect(() => {
    if (wdaConnected && !streaming && selectedUdid) {
      startStream();
    }
  }, [wdaConnected, selectedUdid]);

  // ── FPS counter ────────────────────────────────────────────────────────────

  useEffect(() => {
    fpsTimerRef.current = setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
    return () => { if (fpsTimerRef.current) clearInterval(fpsTimerRef.current); };
  }, []);

  // ── Screen stream ──────────────────────────────────────────────────────────

  const stopStream = useCallback(() => {
    if (streamRef.current) { clearInterval(streamRef.current); streamRef.current = null; }
    setStreaming(false);
    fpsCountRef.current = 0;
  }, []);

  const startStream = useCallback(() => {
    if (streamRef.current) return;
    setStreaming(true);
    const capture = async () => {
      try {
        const r = await fetch("/api/mirror/screenshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ udid: selectedUdid }),
        });
        const j = await r.json() as any;
        if (j.ok && j.jpeg) {
          setJpeg(j.jpeg);
          fpsCountRef.current++;
        }
      } catch {}
    };
    capture();
    streamRef.current = setInterval(capture, 350);
  }, [selectedUdid]);

  useEffect(() => () => stopStream(), [stopStream]);

  // ── WDA install flow ───────────────────────────────────────────────────────

  const handleInstallWda = async () => {
    if (!selectedUdid) return;
    try {
      const r = await fetch("/api/mirror/wda/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ udid: selectedUdid }),
      });
      const j = await r.json() as any;
      if (!j.ok) { toast(`⚠ ${j.error}`); return; }
      setInstallSessionId(j.sessionId);
      setInstallProgress(0);
      setInstallMessage("Starting…");

      installPollRef.current = setInterval(async () => {
        try {
          const sr = await fetch(`/api/mirror/wda/install-status?sessionId=${encodeURIComponent(j.sessionId)}`);
          const s = await sr.json() as any;
          if (s.message) setInstallMessage(s.message);
          if (s.progress != null) setInstallProgress(s.progress);
          if (s.done) {
            clearInterval(installPollRef.current!);
            installPollRef.current = null;
            setInstallSessionId(null);
            if (s.step === "done") {
              // Start iproxy now that WDA is installed
              await fetch("/api/mirror/iproxy/start", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ udid: selectedUdid }),
              });
              setIproxyRunning(true);
              refreshStatus();
            } else {
              toast(`⚠ Install failed: ${s.message}`);
            }
          }
        } catch {}
      }, 1500);
    } catch (e: any) {
      toast(`⚠ ${e.message}`);
    }
  };

  useEffect(() => () => { if (installPollRef.current) clearInterval(installPollRef.current); }, []);

  // ── WDA control commands ───────────────────────────────────────────────────

  const handleCommand = async (cmd: string, payload?: any) => {
    try {
      if (cmd === "pressButton") {
        await fetch("/api/mirror/press-button", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: payload }),
        });
      } else if (cmd === "type") {
        await fetch("/api/mirror/type", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: payload }),
        });
        toast(`Typed: "${payload}"`);
      } else if (cmd === "swipe") {
        const dir = payload?.dir;
        const cx = IPHONE_W / 2, cy = IPHONE_H / 2, d = 200;
        const map: Record<string, [number, number, number, number]> = {
          up:    [cx, cy + d, cx, cy - d],
          down:  [cx, cy - d, cx, cy + d],
          left:  [cx + d, cy, cx - d, cy],
          right: [cx - d, cy, cx + d, cy],
        };
        if (map[dir]) {
          const [fx, fy, tx, ty] = map[dir];
          await fetch("/api/mirror/swipe", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ fromX: fx, fromY: fy, toX: tx, toY: ty }),
          });
        }
      } else if (cmd === "openApp") {
        await fetch("/api/mirror/open-app", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bundleId: payload }),
        });
        toast(`Opening ${payload}`);
      }
    } catch (e: any) {
      toast(`⚠ ${e.message}`);
    }
  };

  const handleTap = async (x: number, y: number) => {
    if (!wdaConnected) return;
    try {
      await fetch("/api/mirror/tap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
    } catch {}
  };

  const handleSwipe = async (fx: number, fy: number, tx: number, ty: number) => {
    if (!wdaConnected) return;
    try {
      await fetch("/api/mirror/swipe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromX: fx, fromY: fy, toX: tx, toY: ty }),
      });
    } catch {}
  };

  return (
    <AppLayout>
      <div className="flex flex-col h-full overflow-hidden">

        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5" style={{ color: "#1AD2F2" }} />
            <h1 className="text-base font-bold tracking-tight">iPhone Control</h1>
          </div>

          {devices.length > 0 ? (
            <select
              value={selectedUdid ?? ""}
              onChange={e => setSelectedUdid(e.target.value)}
              className="h-7 text-xs rounded-md border border-input bg-transparent px-2 focus:outline-none"
            >
              {devices.map(d => (
                <option key={d.udid} value={d.udid}>
                  {d.name} · iOS {d.ios}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-muted-foreground italic">No iPhone detected</span>
          )}

          <span className={cn(
            "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
            wdaConnected
              ? "text-green-700 bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800"
              : "text-muted-foreground bg-muted/60 border-border",
          )}>
            <CircleDot className="w-3 h-3" />
            {wdaConnected ? "Connected" : stage === "no_device" ? "No device" : stage === "installing_wda" ? "Installing…" : stage === "starting_iproxy" ? "Connecting…" : "Not connected"}
          </span>

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={refreshStatus}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-muted/40 text-xs text-muted-foreground hover:bg-accent transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
            {wdaConnected && (
              <button
                onClick={() => streaming ? stopStream() : startStream()}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
                  streaming
                    ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/30"
                    : "border-border bg-muted/40 text-foreground hover:bg-accent",
                )}
              >
                {streaming
                  ? <><Pause className="w-3.5 h-3.5" />Pause</>
                  : <><Play className="w-3.5 h-3.5" />Resume</>}
              </button>
            )}
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-1 overflow-hidden">
          {/* Phone frame */}
          <div className="flex flex-col items-center justify-center w-[310px] shrink-0 py-6 px-4 border-r border-border bg-muted/10">
            <PhoneFrame
              jpeg={jpeg}
              streaming={streaming}
              fps={fps}
              onTap={handleTap}
              onSwipe={handleSwipe}
            />
          </div>

          {/* Right panel */}
          <div className="flex flex-col flex-1 overflow-hidden">
            <div className="flex border-b border-border shrink-0">
              {[
                { id: "controls" as const, label: "Controls" },
                { id: "signup" as const, label: "iPhone Signup" },
              ].map(t => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "px-5 py-2.5 text-xs font-semibold border-b-2 transition-colors",
                    tab === t.id ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                  style={tab === t.id ? { borderColor: "#1AD2F2", color: "#1AD2F2" } : {}}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {tab === "controls" && (
                <>
                  {stage !== "ready" && (
                    <SetupPanel
                      stage={stage}
                      devices={devices}
                      selectedUdid={selectedUdid}
                      installProgress={installProgress}
                      installMessage={installMessage}
                      diagnosis={diagnosis}
                      diagnosing={diagnosing}
                      onInstallWda={handleInstallWda}
                      onRetry={() => { setDiagnosis(null); refreshStatus(); setTimeout(runDiagnose, 1500); }}
                    />
                  )}
                  <ControlPad onCommand={handleCommand} disabled={!wdaConnected} />
                </>
              )}
              {tab === "signup" && (
                <SignupPanel wdaConnected={wdaConnected} />
              )}
            </div>
          </div>
        </div>
      </div>

      {toastMsg && (
        <div className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-lg px-4 py-2.5 text-xs font-medium shadow-xl">
          {toastMsg}
        </div>
      )}
    </AppLayout>
  );
}
