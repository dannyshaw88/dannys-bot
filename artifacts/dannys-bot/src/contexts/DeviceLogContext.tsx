/**
 * DeviceLogContext — global, always-on log collector for all connected phones.
 *
 * Opens a lightweight /api/mobile/log-stream/:serial WebSocket per connected
 * device and accumulates log + action-log lines in React state.  Components
 * anywhere in the tree (not only when the mirror screen is open) can read
 * these logs via useDeviceLog(serial).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const ACTION_LOG_RE = /Cycle\s+(complete|failed|aborted)/i; // "Cycle failed" added to catch-block tLog

interface SerialLogs {
  logLines:       string[];
  actionLogLines: string[];
}

interface DeviceLogContextValue {
  getSerialLogs:      (serial: string) => SerialLogs;
  addClientLog:       (serial: string, msg: string) => void;
  clearLogLines:      (serial: string) => void;
  clearActionLogLines:(serial: string) => void;
}

const DeviceLogContext = createContext<DeviceLogContextValue>({
  getSerialLogs:       () => ({ logLines: [], actionLogLines: [] }),
  addClientLog:        () => {},
  clearLogLines:       () => {},
  clearActionLogLines: () => {},
});

export function DeviceLogProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<Record<string, SerialLogs>>({});

  const appendLog = useCallback((serial: string, msg: string) => {
    const now       = new Date();
    const stamp     = now.toLocaleTimeString();
    const line      = `[${stamp}] ${msg}`;
    const isAction  = ACTION_LOG_RE.test(msg);
    const actionLine = isAction
      ? `[${now.toLocaleString(undefined, { dateStyle: "short", timeStyle: "medium" })}]  ${msg}`
      : null;

    setStore(prev => {
      const cur = prev[serial] ?? { logLines: [], actionLogLines: [] };
      const nextLog = [...cur.logLines, line];
      const nextAction = actionLine
        ? [...cur.actionLogLines, actionLine]
        : cur.actionLogLines;
      return { ...prev, [serial]: { logLines: nextLog, actionLogLines: nextAction } };
    });
  }, []);

  const clearLogLines = useCallback((serial: string) => {
    setStore(prev => ({
      ...prev,
      [serial]: { ...(prev[serial] ?? { logLines: [], actionLogLines: [] }), logLines: [] },
    }));
  }, []);

  const clearActionLogLines = useCallback((serial: string) => {
    setStore(prev => ({
      ...prev,
      [serial]: { ...(prev[serial] ?? { logLines: [], actionLogLines: [] }), actionLogLines: [] },
    }));
  }, []);

  // ── Log-stream WebSocket management ────────────────────────────────────────
  // Poll for connected phones every 5 s and maintain a log-stream WS per
  // serial.  FAKE_* serials are excluded — they have no server-side stream.
  const wsMapRef = useRef<Map<string, WebSocket>>(new Map());

  useEffect(() => {
    let alive = true;
    const wsMap = wsMapRef.current;

    const sync = async () => {
      if (!alive) return;
      try {
        const r = await fetch("/api/mobile/usb-phones");
        if (!r.ok || !alive) return;
        const d = await r.json();
        const phones: { serial: string; state: string }[] = d.phones ?? [];
        const activeSerials = new Set(
          phones
            .filter(p => p.state === "device" && !p.serial.startsWith("FAKE"))
            .map(p => p.serial),
        );

        // Open WS for newly connected real phones
        for (const serial of activeSerials) {
          if (wsMap.has(serial)) continue;
          const proto = window.location.protocol === "https:" ? "wss" : "ws";
          const ws = new WebSocket(
            `${proto}://${window.location.host}/api/mobile/log-stream/${encodeURIComponent(serial)}`,
          );
          wsMap.set(serial, ws);
          ws.onmessage = (ev) => {
            if (typeof ev.data !== "string") return;
            try {
              const j = JSON.parse(ev.data);
              if (j.info)  appendLog(serial, j.info);
              if (j.error) appendLog(serial, `ERROR: ${j.error}`);
            } catch { /* ignore */ }
          };
          ws.onclose = () => {
            if (wsMap.get(serial) === ws) wsMap.delete(serial);
          };
        }

        // Close WS for phones no longer seen
        for (const [serial, ws] of wsMap) {
          if (!activeSerials.has(serial)) {
            ws.close();
            wsMap.delete(serial);
          }
        }
      } catch { /* ignore network errors */ }
    };

    sync();
    const id = setInterval(sync, 5_000);
    return () => {
      alive = false;
      clearInterval(id);
      for (const ws of wsMap.values()) ws.close();
      wsMap.clear();
    };
  }, [appendLog]);

  const getSerialLogs = useCallback(
    (serial: string) => store[serial] ?? { logLines: [], actionLogLines: [] },
    [store],
  );

  return (
    <DeviceLogContext.Provider
      value={{ getSerialLogs, addClientLog: appendLog, clearLogLines, clearActionLogLines }}
    >
      {children}
    </DeviceLogContext.Provider>
  );
}

/**
 * Hook: returns log state and helpers for one phone serial.
 * Pass null/undefined when no serial is active — returns empty arrays.
 */
export function useDeviceLog(serial: string | null | undefined) {
  const ctx = useContext(DeviceLogContext);
  const logs = serial ? ctx.getSerialLogs(serial) : { logLines: [], actionLogLines: [] };

  const addLog = useCallback(
    (msg: string) => { if (serial) ctx.addClientLog(serial, msg); },
    [ctx, serial],
  );
  const clearLogLines = useCallback(
    () => { if (serial) ctx.clearLogLines(serial); },
    [ctx, serial],
  );
  const clearActionLogLines = useCallback(
    () => { if (serial) ctx.clearActionLogLines(serial); },
    [ctx, serial],
  );

  return {
    logLines:           logs.logLines,
    actionLogLines:     logs.actionLogLines,
    addLog,
    clearLogLines,
    clearActionLogLines,
  };
}
