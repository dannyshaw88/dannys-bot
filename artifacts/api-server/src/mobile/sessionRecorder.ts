/**
 * Session Recorder — per-device ring-buffer capture of every tap, log line,
 * and uiautomator dump XML.
 *
 * Purpose: gives the developer an exact, time-stamped playback of what the
 * automation did AND what Instagram showed, bridging the gap between "the log
 * says it tapped recipient" and "the phone tapped Your Story instead".
 *
 * Usage:
 *   import * as recorder from "./sessionRecorder";
 *   recorder.start(serial);
 *   // ... automation runs ...
 *   recorder.stop(serial);
 *   const json = recorder.exportJson(serial);
 *
 * All functions are safe to call even when not recording (no-ops).
 */

export type EventType = "tap" | "key" | "swipe" | "log" | "dump";

export interface RecEvent {
  ts:      number;          // Date.now() at time of event
  type:    EventType;
  data:    TapData | KeyData | SwipeData | LogData | DumpData;
}

export interface TapData    { x: number; y: number; label?: string; source?: "manual" | "bot" }
export interface KeyData    { code: number; label?: string }
export interface SwipeData  { x1: number; y1: number; x2: number; y2: number; durationMs?: number }
export interface LogData    { text: string }
export interface DumpData   { xmlSnippet: string; fullXmlKb: number; summary?: string }

interface Session {
  serial:     string;
  startedAt:  number;
  stoppedAt?: number;
  events:     RecEvent[];
  active:     boolean;
}

const MAX_EVENTS   = 1000;
const MAX_XML_BYTES = 60_000; // truncate dumps stored in the session to ~60 KB

const sessions = new Map<string, Session>();

// ─── Control ─────────────────────────────────────────────────────────────────

export function start(serial: string): void {
  sessions.set(serial, {
    serial,
    startedAt: Date.now(),
    events: [],
    active: true,
  });
}

export function stop(serial: string): void {
  const s = sessions.get(serial);
  if (!s) return;
  s.active     = false;
  s.stoppedAt  = Date.now();
}

export function isRecording(serial: string): boolean {
  return sessions.get(serial)?.active === true;
}

export function status(serial: string): { recording: boolean; eventCount: number; startedAt?: number } {
  const s = sessions.get(serial);
  if (!s) return { recording: false, eventCount: 0 };
  return { recording: s.active, eventCount: s.events.length, startedAt: s.startedAt };
}

// ─── Record helpers ───────────────────────────────────────────────────────────

function push(serial: string, ev: RecEvent): void {
  const s = sessions.get(serial);
  if (!s || !s.active) return;
  if (s.events.length >= MAX_EVENTS) s.events.shift(); // ring-buffer oldest-out
  s.events.push(ev);
}

export function addTap(serial: string, x: number, y: number, label?: string, source?: "manual" | "bot"): void {
  push(serial, { ts: Date.now(), type: "tap", data: { x, y, label, source } });
}

export function addKey(serial: string, code: number, label?: string): void {
  push(serial, { ts: Date.now(), type: "key", data: { code, label } });
}

export function addSwipe(serial: string, x1: number, y1: number, x2: number, y2: number, durationMs?: number): void {
  push(serial, { ts: Date.now(), type: "swipe", data: { x1, y1, x2, y2, durationMs } });
}

export function addLog(serial: string, text: string): void {
  push(serial, { ts: Date.now(), type: "log", data: { text } });
}

export function addDump(serial: string, xml: string, summary?: string): void {
  const fullKb = Math.round(xml.length / 1024);
  const xmlSnippet = xml.length > MAX_XML_BYTES ? xml.slice(0, MAX_XML_BYTES) + "\n…[TRUNCATED]" : xml;
  push(serial, { ts: Date.now(), type: "dump", data: { xmlSnippet, fullXmlKb: fullKb, summary } });
}

/**
 * Returns a wrapped version of `onLog` that both calls the original callback
 * AND records the line if this serial is currently being recorded.
 */
export function wrapOnLog(serial: string, onLog?: (line: string) => void): (line: string) => void {
  return (line: string) => {
    onLog?.(line);
    addLog(serial, line);
  };
}

// ─── Export ───────────────────────────────────────────────────────────────────

export function exportJson(serial: string): string | null {
  const s = sessions.get(serial);
  if (!s) return null;

  const durationMs = s.stoppedAt
    ? s.stoppedAt - s.startedAt
    : Date.now() - s.startedAt;

  return JSON.stringify(
    {
      equinoxSessionRecording: true,
      version: 1,
      serial: s.serial,
      startedAt: new Date(s.startedAt).toISOString(),
      stoppedAt: s.stoppedAt ? new Date(s.stoppedAt).toISOString() : null,
      durationMs,
      eventCount: s.events.length,
      events: s.events,
    },
    null,
    2,
  );
}

export function exportHtml(serial: string): string | null {
  const s = sessions.get(serial);
  if (!s) return null;

  const esc = (str: string) =>
    str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const icon: Record<EventType, string> = {
    tap:   "👆",
    key:   "⌨️",
    swipe: "🔄",
    log:   "📝",
    dump:  "🔍",
  };

  const color: Record<EventType, string> = {
    tap:   "#4ade80",
    key:   "#60a5fa",
    swipe: "#f59e0b",
    log:   "#e5e7eb",
    dump:  "#c084fc",
  };

  let rows = "";
  const t0 = s.startedAt;

  for (let i = 0; i < s.events.length; i++) {
    const ev = s.events[i];
    const dt = `+${((ev.ts - t0) / 1000).toFixed(2)}s`;
    let desc = "";
    // Row background: highlight manual taps so they stand out immediately
    const rowBg = (ev.type === "tap" && (ev.data as TapData).source === "manual")
      ? "background:rgba(251,146,60,0.08);"
      : "";

    if (ev.type === "tap") {
      const d = ev.data as TapData;
      const isManual = d.source === "manual";
      const tapIcon  = isManual ? "🫵" : "🤖";
      const tapLabel = isManual ? "YOU tapped" : "BOT tapped";
      const tapColor = isManual ? "#fb923c" : "#4ade80";
      desc = `<span style="color:${tapColor};font-weight:bold">${tapIcon} ${tapLabel}</span> (${d.x}, ${d.y})${d.label ? ` — ${esc(d.label)}` : ""}`;
    } else if (ev.type === "key") {
      const d = ev.data as KeyData;
      desc = `key ${d.code}${d.label ? ` (${esc(d.label)})` : ""}`;
    } else if (ev.type === "swipe") {
      const d = ev.data as SwipeData;
      desc = `swipe (${d.x1},${d.y1}) → (${d.x2},${d.y2})${d.durationMs ? ` ${d.durationMs}ms` : ""}`;
    } else if (ev.type === "log") {
      const d = ev.data as LogData;
      desc = esc(d.text);
    } else if (ev.type === "dump") {
      const d = ev.data as DumpData;
      const id = `dump-${i}`;
      desc = `uiautomator dump (${d.fullXmlKb} KB)${d.summary ? ` — ${esc(d.summary)}` : ""}
        <details style="margin-top:4px">
          <summary style="cursor:pointer;color:#c084fc;font-size:11px">Show XML</summary>
          <pre style="font-size:10px;overflow:auto;max-height:300px;background:#1e1e2e;padding:8px;border-radius:4px;color:#cdd6f4;margin-top:4px">${esc(d.xmlSnippet)}</pre>
        </details>`;
    }

    rows += `<tr style="${rowBg}">
      <td style="color:#6b7280;font-size:10px;white-space:nowrap;padding:4px 8px;vertical-align:top">${i + 1}</td>
      <td style="color:#6b7280;font-size:10px;white-space:nowrap;padding:4px 8px;vertical-align:top">${dt}</td>
      <td style="font-size:12px;padding:4px 8px;vertical-align:top">${ev.type === "tap" ? "" : icon[ev.type]}</td>
      <td style="color:${color[ev.type]};padding:4px 8px;vertical-align:top;word-break:break-all">${desc}</td>
    </tr>\n`;
  }

  const durationMs = s.stoppedAt ? s.stoppedAt - s.startedAt : Date.now() - s.startedAt;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Equinox Session Recording — ${esc(serial)}</title>
<style>
  body { background:#0d0d0d; color:#e5e7eb; font-family:monospace; margin:0; padding:24px; }
  h1   { font-size:18px; margin-bottom:4px; }
  .meta{ font-size:12px; color:#6b7280; margin-bottom:20px; }
  table{ width:100%; border-collapse:collapse; }
  tr:hover td { background:rgba(255,255,255,0.03); }
  th   { text-align:left; font-size:11px; color:#4b5563; padding:4px 8px; border-bottom:1px solid #1f2937; }
  td   { border-bottom:1px solid #111827; }
</style>
</head>
<body>
<h1>🎬 Equinox Session Recording</h1>
<p class="meta">Device: <b>${esc(serial)}</b> &nbsp;|&nbsp; Started: ${new Date(s.startedAt).toISOString()} &nbsp;|&nbsp; Duration: ${(durationMs / 1000).toFixed(1)}s &nbsp;|&nbsp; Events: ${s.events.length}</p>
<table>
<thead><tr><th>#</th><th>time</th><th></th><th>event</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>`;
}
