import { performance } from "node:perf_hooks";

let sequence = 0;
const active = new Map<number, { serial: string; phase: string; started: number }>();
const recent: Array<{ serial: string; phase: string; durationMs: number; endedAt: string; failed: boolean }> = [];

export function recentStartupPhases() {
  return recent.slice();
}

function emit(event: string, details: Record<string, unknown>) {
  console.info(`[STARTUP-DIAG] ${JSON.stringify({ event, at: new Date().toISOString(), pid: process.pid, ...details })}`);
}

export function startupPhases() {
  return [...active.values()].map(({ serial, phase, started }) => ({
    serial, phase, elapsedMs: Math.round(performance.now() - started),
  }));
}

export function beginStartupPhase(serial: string, phase: string): (failed?: boolean) => void {
  const id = ++sequence;
  const started = performance.now();
  active.set(id, { serial, phase, started });
  emit("phase-start", { id, serial, phase, activePhases: active.size });
  let ended = false;
  return (failed = false) => {
    if (ended) return;
    ended = true;
    active.delete(id);
    const result = { serial, phase, durationMs: Math.round(performance.now() - started), endedAt: new Date().toISOString(), failed };
    recent.push(result);
    if (recent.length > 30) recent.shift();
    emit("phase-end", { id, ...result, activePhases: active.size });
  };
}

export async function timeStartupPhase<T>(serial: string, phase: string, operation: () => Promise<T>): Promise<T> {
  const end = beginStartupPhase(serial, phase);
  try {
    const result = await operation();
    end();
    return result;
  } catch (error) {
    end(true);
    throw error;
  }
}
