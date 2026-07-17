import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

function FilledDashboardIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect fill="currentColor" x="2"  y="2"  width="9"  height="11" rx="1.8"/>
      <rect fill="currentColor" x="13" y="2"  width="9"  height="5"  rx="1.8"/>
      <rect fill="currentColor" x="13" y="9"  width="9"  height="13" rx="1.8"/>
      <rect fill="currentColor" x="2"  y="15" width="9"  height="7"  rx="1.8"/>
    </svg>
  );
}

function FilledBulkImportIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      {/* Person silhouette (left) */}
      <circle fill="currentColor" cx="9" cy="7" r="4"/>
      <path fill="currentColor" d="M17 21c0-4.418-3.582-8-8-8S1 16.582 1 21h16z"/>
      {/* Bold import arrow from right */}
      <path fill="currentColor" d="M23 12.5l-5-4v2.5h-3v3h3v2.5z"/>
    </svg>
  );
}


function FilledPersonIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <circle fill="currentColor" cx="12" cy="7" r="4.5"/>
      <path fill="currentColor" d="M20.5 21c0-4.694-3.806-8.5-8.5-8.5S3.5 16.306 3.5 21h17z"/>
    </svg>
  );
}

function FilledBarChartIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <rect fill="currentColor" x="2" y="14" width="6" height="8" rx="1.2"/>
      <rect fill="currentColor" x="9" y="8"  width="6" height="14" rx="1.2"/>
      <rect fill="currentColor" x="16" y="2" width="6" height="20" rx="1.2"/>
    </svg>
  );
}

function FilledGhostIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" stroke="none" d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z"/>
      <circle fill="white" cx="9" cy="10" r="1.5"/>
      <circle fill="white" cx="15" cy="10" r="1.5"/>
    </svg>
  );
}


function FilledSettingsIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" stroke="none" d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
      <circle fill="white" cx="12" cy="12" r="3"/>
    </svg>
  );
}

function FilledShieldAlertIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill="currentColor" stroke="none" d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
      <rect x="11" y="8" width="2" height="5" rx="0.5" fill="white"/>
      <circle cx="12" cy="16" r="1" fill="white"/>
    </svg>
  );
}


function FilledHammerIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      <path d="M9.06 1.93C7.17 1.92 5.33 2.65 3.91 4.03a.75.75 0 0 0 .06 1.09l2.29 1.87-.96.97-2.29-1.87a.75.75 0 0 0-1.02.05C.61 7.52 0 9.25 0 11c0 3.87 3.13 7 7 7 1.27 0 2.46-.36 3.47-.97l8.56 5.55c1.03.66 2.38.55 3.29-.28l.96-.87c.95-.86 1.05-2.33.22-3.31L16.59 11l2.35-2.35a2 2 0 0 0 0-2.83l-2.76-2.76a2 2 0 0 0-2.83 0L12 4.41l-.88-.88A6.91 6.91 0 0 0 9.06 1.93zM7 14a3 3 0 1 1 0-6 3 3 0 0 1 0 6z"/>
    </svg>
  );
}

export function FilledFarmIcon({ className, style }: { className?: string; style?: React.CSSProperties }) {
  // Phone + gear badge + speed lines — matches the Phone Farm icon
  return (
    <svg className={className} style={style} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="currentColor">
      {/* Speed / motion lines */}
      <rect x="0.5" y="8.5" width="4" height="1.6" rx="0.8"/>
      <rect x="0.5" y="11.5" width="3" height="1.6" rx="0.8"/>
      {/* Phone body */}
      <rect x="5" y="1" width="11" height="19" rx="2"/>
      {/* Screen cutout */}
      <rect x="6.5" y="3" width="8" height="13" rx="1" fill="var(--background,#0f172a)"/>
      {/* Home button cutout */}
      <circle cx="10.5" cy="18" r="1" fill="var(--background,#0f172a)"/>
      {/* Gear badge — 6-tooth, overlapping right edge of phone */}
      {/* Outer teeth (12-point polygon: alternating outer r=2.5 and inner r=1.6) */}
      <path d="M17,10.5 L17.8,11.61 L19.17,11.75 L18.6,13 L19.17,14.25 L17.8,14.39 L17,15.5 L16.2,14.39 L14.84,14.25 L15.4,13 L14.84,11.75 L16.2,11.61Z"/>
      {/* Gear centre hole */}
      <circle cx="17" cy="13" r="1.1" fill="var(--background,#0f172a)"/>
    </svg>
  );
}

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const slot = useSidebarSlot();
  const { pushLocation } = useNavigationHistory();
  const queryClient = useQueryClient();

  useEffect(() => {
    pushLocation(location);
  }, [location]);

  // Read the cached proxy list (populated by AdapterRotationWatcher's global poll)
  // without triggering an extra fetch — just peek at the cache.
  const proxies = (queryClient.getQueryData<Array<{ proxyType?: string; rotating?: boolean }>>(["/api/proxies"]) ?? []);
  const anyAdapterRotating = proxies.some(p => p.proxyType === "adapter" && p.rotating);

  const BRAND = "#1AD2F2";
  const navItems = [
    { name: "Dashboard",       shortLabel: "DASHBOARD",      path: "/dashboard",    icon: FilledDashboardIcon   },
    { name: "Phone Farm",        shortLabel: "PHONE FARM",     path: "/mobile",       icon: FilledFarmIcon        },
    { name: "Statistics",      shortLabel: "STATISTICS",     path: "/stats",        icon: FilledBarChartIcon    },
    { name: "Tools",           shortLabel: "TOOLS",          path: "/tools",        icon: FilledHammerIcon      },
  ];

  return (
    <div className="w-[133px] bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">

      {/* ── Header: logo centred, then Equinox text below ── */}
      <div className="flex flex-col items-center border-b border-border/50 pt-[14px] pb-[10px] px-2">
        <img src="/bot-logo.png" alt="Equinox" className="w-[55px] h-[55px] shrink-0 object-contain mb-[6px]" />
        <span className="font-bold text-base tracking-tight text-foreground">
          Equi<span style={{ color: BRAND }}>nox</span>
        </span>
      </div>

      {/* ── Jarvee-style nav: icon centred above ALL-CAPS label ── */}
      <nav className="flex-1 py-1 space-y-0 overflow-y-auto [&::-webkit-scrollbar]:w-0 [scrollbar-width:none] [-ms-overflow-style:none]">
        {navItems.map((item) => {
          const isActive = (() => {
            if (item.path === "/dashboard") return location === "/dashboard";
            if (item.path === "/profiles") return location === "/profiles" || location.startsWith("/profiles/");
            if (item.path === "/mobile") return location === "/mobile" || location.startsWith("/mobile/");
            return location.startsWith(item.path);
          })();
          const Icon = item.icon;
          const showRotating = item.path === "/proxies" && anyAdapterRotating;

          return (
            <div key={item.path}>
              <button
                onClick={() => setLocation(item.path)}
                className={cn(
                  "flex flex-col items-center justify-center w-full py-[23.5px] gap-1 transition-all duration-200 rounded-none",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <div className="relative">
                  <Icon
                    className={cn("w-[32px] h-[32px] shrink-0 transition-colors", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}
                    style={isActive ? { color: BRAND } : { color: BRAND }}
                  />
                  {showRotating && (
                    <Loader2
                      className="absolute -top-1 -right-1 w-3.5 h-3.5 animate-spin text-orange-400"
                    />
                  )}
                </div>
                <span className="text-[9px] font-bold tracking-wide leading-tight text-center text-foreground [hyphens:none]">
                  {item.shortLabel}
                </span>
              </button>
            </div>
          );
        })}
      </nav>

      {slot && (
        <div className="px-4 pb-3">
          {slot}
        </div>
      )}

      {/* ── Settings — same Jarvee style ── */}
      <div className="pb-2">
        <button
          onClick={() => setLocation("/settings")}
          className={cn(
            "flex flex-col items-center justify-center w-full py-[23.5px] gap-1 transition-all duration-200 rounded-none",
            location === "/settings"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <FilledSettingsIcon
            className={cn("w-[32px] h-[32px] shrink-0 transition-colors", location === "/settings" ? "text-primary" : "text-muted-foreground")}
            style={{ color: BRAND }}
          />
          <span className="text-[9px] font-bold tracking-wide text-foreground">
            SETTINGS
          </span>
        </button>
      </div>

      {/* ── Status pill ── */}
      <div className="pb-4 border-t border-border/50 pt-3 flex justify-center">
        <div className="bg-background rounded-lg px-2 py-1.5 border border-border flex items-center justify-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green-500 shrink-0"></span>
          <span className="text-[10px] text-foreground tracking-wide">Operational</span>
        </div>
      </div>
    </div>
  );
}
