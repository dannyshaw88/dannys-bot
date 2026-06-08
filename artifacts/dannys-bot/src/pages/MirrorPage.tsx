import { useState, useRef, useEffect, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  Smartphone, Wifi, WifiOff, RefreshCw, Play, Pause, Home,
  Volume2, VolumeX, Power, ChevronUp, ChevronDown, ChevronLeft, ChevronRight,
  Keyboard, UserPlus, Loader2, Copy, ClipboardPaste, CheckCircle2,
  Mail, Lock, Calendar, Server, Key, Info,
} from "lucide-react";

// ── Helpers (ported from Ghost Browser) ──────────────────────────────────────

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

// iPhone screen logical dimensions (390×844 = standard iPhone 13/14/15)
const IPHONE_W = 390;
const IPHONE_H = 844;

// ── Sub-components ────────────────────────────────────────────────────────────

function ConnectionBadge({ connected }: { connected: boolean }) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border",
      connected
        ? "text-green-700 bg-green-50 border-green-200 dark:bg-green-950/40 dark:border-green-800"
        : "text-muted-foreground bg-muted/60 border-border",
    )}>
      {connected ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
      {connected ? "WDA Connected" : "WDA Offline"}
    </span>
  );
}

function WdaHelpBox() {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300 space-y-1.5">
      <p className="font-semibold flex items-center gap-1.5"><Info className="w-3.5 h-3.5" /> WebDriverAgent not detected</p>
      <p>To enable iPhone control, install WDA on your iPhone:</p>
      <ol className="list-decimal ml-4 space-y-0.5">
        <li>Clone <span className="font-mono">https://github.com/appium/WebDriverAgent</span></li>
        <li>Open <span className="font-mono">WebDriverAgent.xcodeproj</span> in Xcode</li>
        <li>Set your Apple ID as signing team</li>
        <li>Build &amp; run <strong>WebDriverAgentRunner</strong> on your iPhone</li>
        <li>Forward port: <span className="font-mono">iproxy 8100 8100</span></li>
      </ol>
      <p>For screenshots only: <span className="font-mono">pip install tidevice</span></p>
    </div>
  );
}

// ── iPhone frame renderer ─────────────────────────────────────────────────────

interface PhoneFrameProps {
  jpeg: string | null;
  streaming: boolean;
  onTap: (x: number, y: number) => void;
  onSwipeStart: (x: number, y: number) => void;
  onSwipeEnd: (x: number, y: number) => void;
}

function PhoneFrame({ jpeg, streaming, onTap, onSwipeStart, onSwipeEnd }: PhoneFrameProps) {
  const imgRef = useRef<HTMLImageElement>(null);
  const swipeStart = useRef<{ x: number; y: number } | null>(null);

  const toPhoneCoords = (e: React.MouseEvent<HTMLElement>): { x: number; y: number } => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const relX = (e.clientX - rect.left) / rect.width;
    const relY = (e.clientY - rect.top) / rect.height;
    return {
      x: Math.round(relX * IPHONE_W),
      y: Math.round(relY * IPHONE_H),
    };
  };

  const handleMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    swipeStart.current = toPhoneCoords(e);
  };

  const handleMouseUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!swipeStart.current) return;
    const end = toPhoneCoords(e);
    const dx = Math.abs(end.x - swipeStart.current.x);
    const dy = Math.abs(end.y - swipeStart.current.y);
    if (dx < 8 && dy < 8) {
      onTap(end.x, end.y);
    } else {
      onSwipeStart(swipeStart.current.x, swipeStart.current.y);
      onSwipeEnd(end.x, end.y);
    }
    swipeStart.current = null;
  };

  return (
    <div className="flex flex-col items-center">
      {/* Phone bezel */}
      <div className="relative rounded-[38px] border-[6px] border-gray-800 dark:border-gray-600 bg-black shadow-2xl overflow-hidden select-none"
        style={{ width: 270, height: 585 }}>
        {/* Notch */}
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-28 h-7 bg-black rounded-b-2xl z-10" />
        {/* Home indicator */}
        <div className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-24 h-1 bg-white/30 rounded-full z-10" />
        {/* Screen area */}
        <div
          className="w-full h-full cursor-crosshair"
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
        >
          {jpeg ? (
            <img
              ref={imgRef}
              src={`data:image/jpeg;base64,${jpeg}`}
              className="w-full h-full object-cover"
              draggable={false}
              alt="iPhone screen"
            />
          ) : (
            <div className="w-full h-full flex flex-col items-center justify-center gap-3 bg-gray-900">
              <Smartphone className="w-10 h-10 text-gray-600" />
              <p className="text-xs text-gray-500 text-center px-4">
                {streaming ? "Capturing screenshot…" : "Press Start to begin mirroring"}
              </p>
            </div>
          )}
        </div>
      </div>
      {/* Side buttons */}
      <p className="text-[10px] text-muted-foreground mt-2">
        Click to tap · Drag to swipe
      </p>
    </div>
  );
}

// ── Control pad ───────────────────────────────────────────────────────────────

function ControlPad({ onCommand }: { onCommand: (cmd: string, payload?: any) => void }) {
  const [typeText, setTypeText] = useState("");

  return (
    <div className="space-y-4">
      {/* Hardware buttons */}
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">Hardware Buttons</p>
        <div className="flex gap-2 flex-wrap">
          {[
            { label: "Home", icon: Home, cmd: "pressButton", payload: "home" },
            { label: "Power", icon: Power, cmd: "pressButton", payload: "power" },
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

      {/* Swipe shortcuts */}
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

      {/* Text input */}
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

      {/* Quick actions */}
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

// ── Signup panel ─────────────────────────────────────────────────────────────

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

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [signupRunning, setSignupRunning] = useState(false);
  const [signupStatus, setSignupStatus]   = useState("");
  const [manualCode, setManualCode]       = useState("");
  const [codePending, setCodePending]     = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Persist form fields
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        usernameSpin, password, dob, emailAddr, emailPass,
        imapHost, imapPort, imapSecure: String(imapSecure),
      }));
    } catch {}
  }, [usernameSpin, password, dob, emailAddr, emailPass, imapHost, imapPort, imapSecure]);

  // Poll signup status while running
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
          <strong>WDA required for automation.</strong> Screenshot mirroring still works without it.
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

        <Field label="Password" icon={Lock} value={password} onChange={setPassword}
          type="password" placeholder="Password" />

        <div className="space-y-1">
          <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
            <Calendar className="w-3 h-3" /> Date of Birth
          </label>
          <div className="flex gap-1.5">
            <Input value={dob} onChange={e => setDob(e.target.value)}
              placeholder="DD/MM/YYYY" className="h-8 text-xs flex-1" />
            <button onClick={() => setDob(generateDob())}
              className="flex items-center gap-1 px-2 h-8 rounded border border-input bg-muted/50 text-[10px] hover:bg-accent transition-colors">
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>

      <div className="space-y-3">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Email / IMAP</p>
        <Field label="Email Address" icon={Mail} value={emailAddr} onChange={setEmailAddr}
          placeholder="example@gmail.com" />
        <Field label="Email Password" icon={Key} value={emailPass} onChange={setEmailPass}
          type="password" placeholder="For IMAP code fetch" />
        <div className="grid grid-cols-3 gap-2">
          <div className="col-span-2 space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground flex items-center gap-1">
              <Server className="w-3 h-3" /> IMAP Host
            </label>
            <Input value={imapHost} onChange={e => setImapHost(e.target.value)}
              placeholder="imap.gmail.com" className="h-8 text-xs" />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Port</label>
            <Input value={imapPort} onChange={e => setImapPort(e.target.value)}
              placeholder="993" className="h-8 text-xs" />
          </div>
        </div>
        <label className="flex items-center gap-2 cursor-pointer text-xs text-muted-foreground">
          <input type="checkbox" checked={imapSecure} onChange={e => setImapSecure(e.target.checked)}
            className="w-3.5 h-3.5" />
          SSL/TLS
        </label>
      </div>

      {/* Run button */}
      <Button
        onClick={handleSignup}
        disabled={signupRunning || !username || !password || !emailAddr || !dob}
        className="w-full h-9 text-sm font-semibold"
        style={{ background: "#1AD2F2", color: "#000" }}
      >
        {signupRunning ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Signing up…</> : <><UserPlus className="w-4 h-4 mr-2" />Auto Signup on iPhone</>}
      </Button>

      {/* Status */}
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

      {/* Verification code input */}
      {codePending && signupRunning && (
        <div className="rounded-lg border border-border bg-card p-3 space-y-2">
          <p className="text-xs font-semibold">Enter verification code</p>
          <div className="flex gap-2">
            <Input value={manualCode} onChange={e => setManualCode(e.target.value)}
              placeholder="6-digit code" className="h-8 text-xs flex-1 font-mono tracking-widest" />
            <Button variant="outline" size="sm" onClick={handleFetchCode}
              disabled={!emailAddr || !emailPass || !imapHost}
              className="h-8 px-2 text-[10px]">
              <Mail className="w-3 h-3 mr-1" /> IMAP
            </Button>
            <Button size="sm" onClick={handleSubmitCode}
              disabled={!manualCode.trim()}
              className="h-8 px-3 text-[10px]">
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
  const [devices, setDevices]       = useState<IosDevice[]>([]);
  const [selectedUdid, setSelectedUdid] = useState<string | null>(null);
  const [wdaConnected, setWdaConnected] = useState(false);
  const [streaming, setStreaming]   = useState(false);
  const [jpeg, setJpeg]             = useState<string | null>(null);
  const [fps, setFps]               = useState(0);
  const [tab, setTab]               = useState<"controls" | "signup">("controls");
  const [toastMsg, setToastMsg]     = useState("");

  const streamRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const fpsCountRef = useRef(0);
  const fpsTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const toast = (msg: string) => {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(""), 2500);
  };

  // Fetch devices + WDA status on mount and every 10s
  const refreshDevices = useCallback(async () => {
    try {
      const [dr, wr] = await Promise.all([
        fetch("/api/mirror/devices").then(r => r.json()),
        fetch("/api/mirror/wda-status").then(r => r.json()),
      ]);
      setDevices((dr as any).devices ?? []);
      setWdaConnected(!!(wr as any).connected);
      if ((dr as any).devices?.length && !selectedUdid) {
        setSelectedUdid((dr as any).devices[0].udid);
      }
    } catch {}
  }, [selectedUdid]);

  useEffect(() => {
    refreshDevices();
    const t = setInterval(refreshDevices, 10_000);
    return () => clearInterval(t);
  }, [refreshDevices]);

  // FPS counter
  useEffect(() => {
    fpsTimerRef.current = setInterval(() => {
      setFps(fpsCountRef.current);
      fpsCountRef.current = 0;
    }, 1000);
    return () => { if (fpsTimerRef.current) clearInterval(fpsTimerRef.current); };
  }, []);

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

  // Handle WDA commands from control pad
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
        const cx = IPHONE_W / 2;
        const cy = IPHONE_H / 2;
        const d = 200;
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
    try {
      await fetch("/api/mirror/tap", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y }),
      });
    } catch {}
  };

  const handleSwipe = async (startX: number, startY: number, endX: number, endY: number) => {
    try {
      await fetch("/api/mirror/swipe", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromX: startX, fromY: startY, toX: endX, toY: endY }),
      });
    } catch {}
  };

  const selectedDevice = devices.find(d => d.udid === selectedUdid);

  return (
    <AppLayout>
      <div className="flex flex-col h-full overflow-hidden">
        {/* ── Header ── */}
        <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0 flex-wrap">
          <div className="flex items-center gap-2">
            <Smartphone className="w-5 h-5 text-primary" style={{ color: "#1AD2F2" }} />
            <h1 className="text-base font-bold tracking-tight">iPhone Mirror</h1>
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
            <span className="text-xs text-muted-foreground">No iPhone detected — connect via USB</span>
          )}

          <ConnectionBadge connected={wdaConnected} />

          <div className="ml-auto flex items-center gap-2">
            {streaming && (
              <span className="text-[10px] font-mono text-muted-foreground">{fps} fps</span>
            )}
            <button
              onClick={() => streaming ? stopStream() : startStream()}
              disabled={devices.length === 0}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors",
                streaming
                  ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100 dark:bg-red-950/30"
                  : devices.length > 0
                  ? "border-border bg-muted/40 text-foreground hover:bg-accent"
                  : "border-border/40 bg-muted/20 text-muted-foreground/50 cursor-not-allowed",
              )}
            >
              {streaming ? <><Pause className="w-3.5 h-3.5" />Stop</> : <><Play className="w-3.5 h-3.5" />Start Mirror</>}
            </button>
            <button
              onClick={() => { setJpeg(null); startStream(); stopStream(); setTimeout(startStream, 100); }}
              disabled={!streaming}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-muted/40 text-xs text-muted-foreground hover:bg-accent transition-colors disabled:opacity-40"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex flex-1 overflow-hidden">
          {/* Left: phone frame */}
          <div className="flex flex-col items-center justify-center w-[310px] shrink-0 py-6 px-4 border-r border-border bg-muted/10">
            <PhoneFrame
              jpeg={jpeg}
              streaming={streaming}
              onTap={handleTap}
              onSwipeStart={(x, y) => { /* captured inline */ }}
              onSwipeEnd={(x, y) => { /* no-op, handled in handleSwipe */ }}
            />
          </div>

          {/* Right: tabs */}
          <div className="flex flex-col flex-1 overflow-hidden">
            {/* Tab bar */}
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
                    tab === t.id
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                  style={tab === t.id ? { borderColor: "#1AD2F2", color: "#1AD2F2" } : {}}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-y-auto p-5 space-y-5">
              {tab === "controls" && (
                <>
                  {!wdaConnected && <WdaHelpBox />}
                  <ControlPad onCommand={handleCommand} />
                </>
              )}
              {tab === "signup" && (
                <SignupPanel wdaConnected={wdaConnected} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Toast */}
      {toastMsg && (
        <div className="fixed bottom-4 right-4 z-50 bg-card border border-border rounded-lg px-4 py-2.5 text-xs font-medium shadow-xl">
          {toastMsg}
        </div>
      )}
    </AppLayout>
  );
}
