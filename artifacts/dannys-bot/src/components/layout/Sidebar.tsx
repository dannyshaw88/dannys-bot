import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";

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

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const slot = useSidebarSlot();
  const { pushLocation } = useNavigationHistory();

  useEffect(() => {
    pushLocation(location);
  }, [location]);

  const BRAND = "#1AD2F2";
  const navItems = [
    { name: "Dashboard",       shortLabel: "DASHBOARD",      path: "/dashboard",    icon: FilledDashboardIcon   },
    { name: "Accounts",        shortLabel: "ACCOUNTS",       path: "/profiles",     icon: FilledPersonIcon      },
    { name: "Statistics",      shortLabel: "STATISTICS",     path: "/stats",        icon: FilledBarChartIcon    },
    { name: "Ghost Browser",   shortLabel: "GHOST BROWSER",  path: "/create-ghost",  icon: FilledGhostIcon       },
    { name: "Proxy Manager",   shortLabel: "PROXY MANAGER",  path: "/proxies",      icon: FilledShieldAlertIcon },
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
            return location.startsWith(item.path);
          })();
          const Icon = item.icon;

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
                <Icon
                  className={cn("w-[32px] h-[32px] shrink-0 transition-colors", isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")}
                  style={isActive ? { color: BRAND } : { color: BRAND }}
                />
                <span className="text-[9px] font-bold tracking-wide leading-tight text-center text-foreground">
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
