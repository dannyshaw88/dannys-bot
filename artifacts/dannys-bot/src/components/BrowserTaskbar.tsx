import { useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { Monitor, X } from "lucide-react";

export function BrowserTaskbar() {
  const { windows, restoreWindow, minimizeWindow, focusWindow, closeWindow } = useBrowserWindows();

  if (windows.length === 0) return null;

  // The taskbar itself — fixed bottom bar, full width
  return (
    <div className="fixed bottom-0 left-0 right-0 z-[200] h-10 bg-slate-800 border-t border-slate-700 flex items-center gap-1 px-2">
      {windows.map(win => {
        const isActive = !win.minimized;
        return (
          <div
            key={win.profileId}
            className={`
              flex items-center gap-1.5 h-7 px-2.5 rounded cursor-pointer select-none
              border transition-colors max-w-[180px] group
              ${isActive
                ? "bg-slate-600 border-slate-500 text-white"
                : "bg-slate-700 border-slate-600 text-slate-300 hover:bg-slate-650 hover:text-white"}
            `}
            onClick={() => {
              if (win.minimized) restoreWindow(win.profileId);
              else focusWindow(win.profileId);
            }}
          >
            {/* Status dot */}
            <Monitor className="w-3 h-3 shrink-0 opacity-70" />

            {/* Username */}
            <span className="text-xs font-medium truncate flex-1 min-w-0">
              @{win.username}
            </span>

            {/* Close */}
            <button
              onClick={e => { e.stopPropagation(); fetch(`/api/browser/${win.profileId}/close`, { method: "POST" }).catch(() => {}); closeWindow(win.profileId); }}
              className="w-4 h-4 rounded flex items-center justify-center opacity-0 group-hover:opacity-100 hover:bg-red-500 hover:text-white transition-all shrink-0"
              title="Close"
            >
              <X className="w-2.5 h-2.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
