import { useRef, useCallback, useEffect, useState } from "react";
import { BrowserPanel } from "./BrowserPanel";
import { useBrowserWindows, type BrowserWindowEntry } from "@/contexts/BrowserWindowsContext";
import { Minus, X, Monitor, Maximize2, Minimize2 } from "lucide-react";

const WIN_W = 1100;
const WIN_H = 680;
const TASKBAR_H = 40;

interface Props {
  window: BrowserWindowEntry;
}

export function BrowserWindow({ window: win }: Props) {
  const { closeWindow, minimizeWindow, focusWindow, moveWindow } = useBrowserWindows();

  const handleClose = useCallback(() => {
    fetch(`/api/browser/${win.profileId}/close`, { method: "POST" }).catch(() => {});
    closeWindow(win.profileId);
  }, [win.profileId, closeWindow]);
  const [maximized, setMaximized] = useState(win.maximized);
  const dragging = useRef(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const winRef = useRef<HTMLDivElement>(null);

  // ── Drag logic (disabled when maximized) ─────────────────────────────────
  const onTitleMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    if (maximized) return;
    e.preventDefault();
    dragging.current = true;
    dragOffset.current = { x: e.clientX - win.x, y: e.clientY - win.y };
    focusWindow(win.profileId);

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const nx = Math.max(0, Math.min(ev.clientX - dragOffset.current.x, globalThis.innerWidth  - WIN_W));
      const ny = Math.max(0, Math.min(ev.clientY - dragOffset.current.y, globalThis.innerHeight - WIN_H));
      moveWindow(win.profileId, nx, ny);
    };

    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [maximized, win.x, win.y, win.profileId, focusWindow, moveWindow]);

  // Double-click title bar to toggle maximize
  const onTitleDoubleClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    setMaximized(m => !m);
  }, []);

  // Keep window on screen when viewport resizes (only when not maximized)
  useEffect(() => {
    if (maximized) return;
    const clamp = () => {
      const nx = Math.min(win.x, globalThis.innerWidth  - WIN_W);
      const ny = Math.min(win.y, globalThis.innerHeight - WIN_H);
      if (nx !== win.x || ny !== win.y) moveWindow(win.profileId, Math.max(0, nx), Math.max(0, ny));
    };
    globalThis.addEventListener("resize", clamp);
    return () => globalThis.removeEventListener("resize", clamp);
  }, [maximized, win.x, win.y, win.profileId, moveWindow]);

  if (win.minimized) return null;

  const style: React.CSSProperties = maximized
    ? {
        position: "fixed",
        left: 0,
        top: 0,
        width: "100vw",
        height: `calc(100vh - ${TASKBAR_H}px)`,
        zIndex: win.zIndex,
      }
    : {
        position: "fixed",
        left: win.x,
        top: win.y,
        width: WIN_W,
        height: WIN_H,
        zIndex: win.zIndex,
      };

  return (
    <div
      ref={winRef}
      onMouseDown={() => focusWindow(win.profileId)}
      style={style}
      className="flex flex-col overflow-hidden shadow-2xl border border-border bg-background select-none"
    >
      {/* Title bar */}
      <div
        onMouseDown={onTitleMouseDown}
        onDoubleClick={onTitleDoubleClick}
        className={`flex items-center gap-2 px-3 h-9 bg-slate-100 border-b border-border shrink-0 ${maximized ? "cursor-default" : "cursor-grab active:cursor-grabbing"}`}
      >
        <Monitor className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
        <span className="text-sm font-semibold text-foreground truncate flex-1">
          @{win.username} — Embedded Browser
        </span>

        {/* Window controls */}
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => minimizeWindow(win.profileId)}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-slate-200 text-muted-foreground hover:text-foreground transition-colors"
          title="Minimize"
        >
          <Minus className="w-3 h-3" />
        </button>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={() => setMaximized(m => !m)}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-slate-200 text-muted-foreground hover:text-foreground transition-colors"
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Minimize2 className="w-3 h-3" /> : <Maximize2 className="w-3 h-3" />}
        </button>
        <button
          onMouseDown={e => e.stopPropagation()}
          onClick={handleClose}
          className="w-6 h-6 rounded flex items-center justify-center hover:bg-red-100 hover:text-red-600 text-muted-foreground transition-colors"
          title="Close"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* Browser content */}
      <div className="flex-1 min-h-0">
        <BrowserPanel
          profileId={win.profileId}
          userAgent={win.userAgent}
          username={win.username}
        />
      </div>
    </div>
  );
}
