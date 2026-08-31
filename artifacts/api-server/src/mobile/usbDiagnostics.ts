import fs from "fs";
import path from "path";

export type UsbDiagnosticPhone = {
  serial: string;
  state: string;
};

export type UsbDiagnosticEvent = {
  at: string;
  kind: "poll" | "state-transition" | "device-vanished" | "adb-unavailable";
  pollId: number;
  serial?: string;
  previousState?: string;
  state?: string;
  durationMs?: number;
  adbFound?: boolean;
  adbPath?: string | null;
  commandOk?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  error?: string | null;
  stderr?: string;
  rawOutput?: string;
  phones?: UsbDiagnosticPhone[];
  probeFailures?: Array<{ serial: string; operation: string; error: string }>;
  consecutiveFailures?: number;
};

const MAX_EVENTS = 2_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_BYTES = 16 * 1024;

function diagnosticsPath(): string {
  const base = process.env.ADB_TOOLS_DIR
    || (process.env.DATABASE_PATH ? path.dirname(process.env.DATABASE_PATH) : process.cwd());
  return path.join(base, "aura-farming-usb-diagnostics.jsonl");
}

const filePath = diagnosticsPath();
const events: UsbDiagnosticEvent[] = [];
const previousStates = new Map<string, string>();
const consecutiveFailures = new Map<string, number>();
const knownSerials = new Set<string>();
let pollId = 0;

function trimText(value: unknown, max = MAX_TEXT_BYTES): string {
  return String(value ?? "")
    .replace(/\u0000/g, "")
    .slice(0, max);
}

function appendToDisk(event: UsbDiagnosticEvent): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(event) + "\n", "utf8");
    if (fs.statSync(filePath).size <= MAX_FILE_BYTES) return;

    const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
    const kept = lines.slice(-Math.floor(MAX_EVENTS / 2));
    fs.writeFileSync(filePath, kept.join("\n") + (kept.length ? "\n" : ""), "utf8");
  } catch { /* diagnostics must never break device polling */ }
}

function record(event: Omit<UsbDiagnosticEvent, "at">, important = false): void {
  const complete: UsbDiagnosticEvent = {
    at: new Date().toISOString(),
    ...event,
  };
  events.push(complete);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  appendToDisk(complete);

  // Successful polls belong in the export only. State changes and failures are
  // also written to the normal server log so they are visible immediately.
  if (important) console.warn(`[USB-DIAG] ${JSON.stringify(complete)}`);
}

export type UsbPollDiagnostic = {
  adbFound: boolean;
  adbPath: string | null;
  durationMs: number;
  commandOk: boolean;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  error: string | null;
  stderr: string;
  rawOutput: string;
  phones: UsbDiagnosticPhone[];
  probeFailures?: Array<{ serial: string; operation: string; error: string }>;
};

export function recordUsbPoll(observation: UsbPollDiagnostic): number {
  const currentPollId = ++pollId;
  const currentSerials = new Set(observation.phones.map(phone => phone.serial));

  record({
    kind: "poll",
    pollId: currentPollId,
    durationMs: observation.durationMs,
    adbFound: observation.adbFound,
    adbPath: observation.adbPath,
    commandOk: observation.commandOk,
    exitCode: observation.exitCode,
    signal: observation.signal,
    timedOut: observation.timedOut,
    error: observation.error ? trimText(observation.error, 2_000) : null,
    stderr: trimText(observation.stderr, 4_000),
    rawOutput: trimText(observation.rawOutput),
    phones: observation.phones,
    probeFailures: observation.probeFailures,
  });

  if (!observation.adbFound || !observation.commandOk) {
    for (const serial of knownSerials) {
      consecutiveFailures.set(serial, (consecutiveFailures.get(serial) ?? 0) + 1);
    }
    record({
      kind: "adb-unavailable",
      pollId: currentPollId,
      adbFound: observation.adbFound,
      adbPath: observation.adbPath,
      commandOk: observation.commandOk,
      exitCode: observation.exitCode,
      signal: observation.signal,
      timedOut: observation.timedOut,
      error: observation.error ? trimText(observation.error, 2_000) : null,
      stderr: trimText(observation.stderr, 4_000),
      consecutiveFailures: Math.max(0, ...Array.from(consecutiveFailures.values())),
    }, true);
    return currentPollId;
  }

  for (const phone of observation.phones) {
    const previousState = previousStates.get(phone.serial);
    const failures = consecutiveFailures.get(phone.serial) ?? 0;
    consecutiveFailures.set(phone.serial, 0);
    knownSerials.add(phone.serial);
    previousStates.set(phone.serial, phone.state);

    if (previousState && previousState !== phone.state) {
      record({
        kind: "state-transition",
        pollId: currentPollId,
        serial: phone.serial,
        previousState,
        state: phone.state,
        consecutiveFailures: failures,
      }, true);
    }
  }

  // Only a successful `adb devices -l` response can prove that a serial
  // vanished. A command timeout/error must not manufacture disconnects for all
  // phones that happened to be connected.
  for (const serial of knownSerials) {
    if (currentSerials.has(serial)) continue;
    if (!previousStates.has(serial)) continue;
    const previousState = previousStates.get(serial);
    previousStates.delete(serial);
    consecutiveFailures.delete(serial);
    record({
      kind: "device-vanished",
      pollId: currentPollId,
      serial,
      previousState,
      state: "missing",
    }, true);
  }

  return currentPollId;
}

export function getUsbDiagnostics(serial?: string | null): {
  filePath: string;
  maxEvents: number;
  generatedAt: string;
  filterSerial: string | null;
  events: UsbDiagnosticEvent[];
} {
  const filtered = serial
    ? events.filter(event =>
        event.serial === serial
        || event.phones?.some(phone => phone.serial === serial)
        || event.kind === "poll"
      )
    : events;

  return {
    filePath,
    maxEvents: MAX_EVENTS,
    generatedAt: new Date().toISOString(),
    filterSerial: serial ?? null,
    events: filtered,
  };
}