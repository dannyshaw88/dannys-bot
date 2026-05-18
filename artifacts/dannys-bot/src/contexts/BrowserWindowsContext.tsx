import { createContext, useContext, useState, useCallback, ReactNode } from "react";

export interface BrowserWindowEntry {
  profileId: number;
  username: string;
  userAgent: string;
  minimized: boolean;
  maximized: boolean;
  zIndex: number;
  x: number;
  y: number;
  pendingUrl?: string;
}

interface BrowserWindowsCtx {
  windows: BrowserWindowEntry[];
  openWindow: (profileId: number, username: string, userAgent: string) => void;
  closeWindow: (profileId: number) => void;
  minimizeWindow: (profileId: number) => void;
  restoreWindow: (profileId: number) => void;
  focusWindow: (profileId: number) => void;
  moveWindow: (profileId: number, x: number, y: number) => void;
  navigateTo: (profileId: number, username: string, userAgent: string, url: string) => void;
  clearPendingUrl: (profileId: number) => void;
}

const Ctx = createContext<BrowserWindowsCtx | null>(null);

let baseZ = 100;
let cascade = 0;

export function BrowserWindowsProvider({ children }: { children: ReactNode }) {
  const [windows, setWindows] = useState<BrowserWindowEntry[]>([]);

  const topZ = useCallback(() => ++baseZ, []);

  const openWindow = useCallback((profileId: number, username: string, userAgent: string) => {
    // In Electron, delegate to the native IPC so the EB opens as a real OS window
    // that minimizes to the Windows taskbar. The server-side Puppeteer handles all
    // user-agent spoofing — nothing about the EB changes, only the window host.
    const electronAPI = (window as any).electronAPI;
    if (electronAPI?.openBrowserWindow) {
      electronAPI.openBrowserWindow(profileId, username, userAgent);
      return;
    }

    // Browser/dev fallback: render as in-app floating panel
    setWindows(prev => {
      if (prev.find(w => w.profileId === profileId)) {
        baseZ++;
        return prev.map(w =>
          w.profileId === profileId
            ? { ...w, minimized: false, zIndex: baseZ }
            : w
        );
      }
      const offset = (cascade++ % 6) * 30;
      return [...prev, {
        profileId,
        username,
        userAgent,
        minimized: false,
        maximized: false,
        zIndex: topZ(),
        x: 120 + offset,
        y: 60 + offset,
      }];
    });
  }, [topZ]);

  const navigateTo = useCallback((profileId: number, username: string, userAgent: string, url: string) => {
    setWindows(prev => {
      const exists = prev.find(w => w.profileId === profileId);
      if (exists) {
        baseZ++;
        return prev.map(w =>
          w.profileId === profileId
            ? { ...w, minimized: false, zIndex: baseZ, pendingUrl: url }
            : w
        );
      }
      const offset = (cascade++ % 6) * 30;
      return [...prev, {
        profileId,
        username,
        userAgent,
        minimized: false,
        maximized: true,
        zIndex: topZ(),
        x: 120 + offset,
        y: 60 + offset,
        pendingUrl: url,
      }];
    });
  }, [topZ]);

  const clearPendingUrl = useCallback((profileId: number) => {
    setWindows(prev => prev.map(w =>
      w.profileId === profileId ? { ...w, pendingUrl: undefined } : w
    ));
  }, []);

  const closeWindow = useCallback((profileId: number) => {
    setWindows(prev => prev.filter(w => w.profileId !== profileId));
  }, []);

  const minimizeWindow = useCallback((profileId: number) => {
    setWindows(prev => prev.map(w =>
      w.profileId === profileId ? { ...w, minimized: true } : w
    ));
  }, []);

  const restoreWindow = useCallback((profileId: number) => {
    baseZ++;
    setWindows(prev => prev.map(w =>
      w.profileId === profileId ? { ...w, minimized: false, zIndex: baseZ } : w
    ));
  }, []);

  const focusWindow = useCallback((profileId: number) => {
    baseZ++;
    setWindows(prev => prev.map(w =>
      w.profileId === profileId ? { ...w, minimized: false, zIndex: baseZ } : w
    ));
  }, []);

  const moveWindow = useCallback((profileId: number, x: number, y: number) => {
    setWindows(prev => prev.map(w =>
      w.profileId === profileId ? { ...w, x, y } : w
    ));
  }, []);

  return (
    <Ctx.Provider value={{ windows, openWindow, closeWindow, minimizeWindow, restoreWindow, focusWindow, moveWindow, navigateTo, clearPendingUrl }}>
      {children}
    </Ctx.Provider>
  );
}

export function useBrowserWindows() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useBrowserWindows must be used inside BrowserWindowsProvider");
  return ctx;
}
