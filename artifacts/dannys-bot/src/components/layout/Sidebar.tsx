import { useLocation, useSearch } from "wouter";
import {
  Gauge, Users, ShieldAlert, Settings, Activity,
  ChevronLeft, ChevronRight, Ghost, User, UserMinus, UserPlus, MessageSquare, Cookie, Upload, Award,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";
import { useProfile } from "@/hooks/use-profiles";

const TRUST_SCORE_TABS = [
  { value: "settings",      label: "Settings"      },
  { value: "follow",        label: "Follow Tool"   },
  { value: "unfollow",      label: "Unfollow Tool" },
  { value: "contact",       label: "Contact Tool"  },
  { value: "human-session", label: "Human Session" },
];

const PROFILE_TABS = (creatorMode: boolean) => [
  { value: "settings",      label: "Account Settings",    icon: Settings,      spacerAfter: true },
  ...(!creatorMode ? [
    { value: "follow",        label: "Follow Tool",         icon: UserPlus      },
    { value: "unfollow",      label: "Unfollow Tool",       icon: UserMinus     },
    { value: "contact",       label: "Contact Tool",        icon: MessageSquare },
    { value: "human-session", label: "Human Session",       icon: User          },
    { value: "session-log",   label: "Session Log",         icon: Activity      },
  ] : []),
  { value: "create-cookie", label: "Create a Cookie",     icon: Cookie        },
];

export function Sidebar() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const slot = useSidebarSlot();
  const { canBack, canForward, pushLocation, back, forward } = useNavigationHistory();

  useEffect(() => {
    pushLocation(location);
  }, [location]);

  const profileMatch = location.match(/^\/profiles\/(\d+)$/);
  const profileId = profileMatch ? Number(profileMatch[1]) : 0;
  const { data: profile } = useProfile(profileId);
  const trustScoreMatch = location.match(/^\/trust-scores\/([^?/]+)/);
  const activeTrustScoreId = trustScoreMatch ? trustScoreMatch[1] : null;
  const activeTab = new URLSearchParams(search).get("tab") ?? "settings";

  const BRAND = "#1AD2F2";
  const navItems = [
    { name: "Dashboard",            shortLabel: "DASHBOARD",      path: "/dashboard",      icon: Gauge       },
    { name: "Accounts",             shortLabel: "ACCOUNTS",       path: "/profiles",       icon: Users       },
    { name: "TrustScores",          shortLabel: "TRUSTSCORES",    path: "/trust-scores",   icon: Award       },
    { name: "Statistics",           shortLabel: "STATISTICS",     path: "/stats",          icon: Activity    },
    { name: "Ghost Browser",        shortLabel: "GHOST BROWSER",  path: "/create-ghost",   icon: Ghost       },
    { name: "Bulk Import Accounts", shortLabel: "BULK IMPORT",    path: "/bulk-import",    icon: Upload      },
    { name: "Proxy Manager",        shortLabel: "PROXY MANAGER",  path: "/proxies",        icon: ShieldAlert },
  ];

  function goBack() {
    const path = back();
    if (path) setLocation(path);
  }

  function goForward() {
    const path = forward();
    if (path) setLocation(path);
  }

  return (
    <div className="w-[133px] bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">

      {/* ── Header: logo + wordmark row, then arrows row below centered ── */}
      <div className="flex flex-col items-center border-b border-border/50 pt-[10px] pb-[7px] px-2">
        <div className="flex items-center gap-2 mb-1">
          <img src="/bot-logo.png" alt="Equinox" className="w-[28px] h-[28px] shrink-0 object-contain" />
          <span className="font-bold text-base tracking-tight text-foreground">
            Equi<span style={{ color: BRAND }}>nox</span>
          </span>
        </div>
        <div className="flex items-center justify-center gap-1">
          <button
            onClick={goBack}
            className={cn(
              "p-1.5 rounded transition-colors",
              canBack ? "hover:bg-accent cursor-pointer" : "cursor-default"
            )}
            style={{ color: canBack ? BRAND : BRAND + "60" }}
            title="Go back"
          >
            <ChevronLeft className="w-4 h-4" strokeWidth={2.5} />
          </button>
          <button
            onClick={goForward}
            className={cn(
              "p-1.5 rounded transition-colors",
              canForward ? "hover:bg-accent cursor-pointer" : "cursor-default"
            )}
            style={{ color: canForward ? BRAND : BRAND + "60" }}
            title="Go forward"
          >
            <ChevronRight className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* ── Jarvee-style nav: icon centred above ALL-CAPS label ── */}
      <nav className="flex-1 py-1 space-y-0 overflow-y-auto">
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
                <span className={cn(
                  "text-[9px] font-bold tracking-wide leading-tight text-center",
                  isActive ? "text-primary" : "text-muted-foreground"
                )}>
                  {item.shortLabel}
                </span>
              </button>

              {/* Profile sub-tabs */}
              {item.path === "/profiles" && profileId > 0 && (
                <div className="ml-2 mt-1.5 mb-0.5 space-y-0 border-t border-border/40 pt-1">
                  {PROFILE_TABS(!!profile?.creatorMode).map(({ value, label, spacerAfter }) => {
                    const isSubActive = activeTab === value;
                    return (
                      <div key={value}>
                        <button
                          onClick={() => setLocation(`/profiles/${profileId}?tab=${value}`)}
                          className={cn(
                            "flex items-center w-full px-2 py-1.5 text-[9px] font-bold transition-all duration-150 text-left rounded-md whitespace-nowrap",
                            isSubActive
                              ? "text-primary"
                              : "text-muted-foreground hover:text-foreground"
                          )}
                        >
                          <ChevronRight className="w-3 h-3 text-black dark:text-white mr-1 shrink-0" />
                          {label}
                        </button>
                        {spacerAfter && <div className="h-2" />}
                      </div>
                    );
                  })}
                </div>
              )}

              {/* TrustScore sub-tabs */}
              {item.path === "/trust-scores" && activeTrustScoreId && (
                <div className="ml-2 mt-1.5 mb-0.5 space-y-0 border-t border-border/40 pt-1">
                  {TRUST_SCORE_TABS.map(({ value, label }) => {
                    const isSubActive = activeTab === value;
                    return (
                      <button
                        key={value}
                        onClick={() => setLocation(`/trust-scores/${activeTrustScoreId}?tab=${value}`)}
                        className={cn(
                          "flex items-center w-full px-2 py-1.5 text-[9px] font-bold transition-all duration-150 text-left rounded-md whitespace-nowrap",
                          isSubActive ? "text-primary" : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <ChevronRight className="w-3 h-3 text-black dark:text-white mr-1 shrink-0" />
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}
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
          <Settings
            className={cn("w-[32px] h-[32px] shrink-0 transition-colors", location === "/settings" ? "text-primary" : "text-muted-foreground")}
            style={{ color: BRAND }}
          />
          <span className={cn(
            "text-[9px] font-bold tracking-wide",
            location === "/settings" ? "text-primary" : "text-muted-foreground"
          )}>
            SETTINGS
          </span>
        </button>
      </div>

      {/* ── Status pill ── */}
      <div className="px-3 pb-4 border-t border-border/50 pt-3">
        <div className="bg-background rounded-lg px-2 py-1.5 border border-border flex items-center justify-center gap-1.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
          <span className="text-[10px] font-bold text-foreground tracking-wide">Developing</span>
        </div>
      </div>
    </div>
  );
}
