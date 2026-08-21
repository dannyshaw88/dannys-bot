/**
 * File-backed UI timing diagnostics.
 *
 * /api/ipc-log writes through the API server's already-open logger, so these
 * events are captured in aura-farming-debug.log immediately instead of waiting
 * for a browser-console export.
 */
export function writeUiSpeedLog(event: string, detail: Record<string, unknown> = {}): void {
  const line = `[UI-SPEED] ${event} ${JSON.stringify(detail)}`;
  void fetch("/api/ipc-log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: line }),
    keepalive: true,
  }).catch(() => {
    // Diagnostics must never affect page loading.
  });
}