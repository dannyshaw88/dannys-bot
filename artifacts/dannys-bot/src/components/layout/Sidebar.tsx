import { useLocation, useSearch } from "wouter";
import {
  LayoutDashboard, Users, ShieldAlert, Settings, Activity,
  ChevronLeft, ChevronRight, Ghost, User, UserMinus, UserPlus, MessageSquare, Cookie, Upload,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";
import { useProfile } from "@/hooks/use-profiles";

const PROFILE_TABS = (creatorMode: boolean) => [
  { value: "settings",      label: "Account Settings",    shortLabel: "SETTINGS",  icon: Settings,      spacerAfter: true },
  ...(!creatorMode ? [
    { value: "follow",        label: "Follow Tool",         shortLabel: "FOLLOW",    icon: UserPlus      },
    { value: "unfollow",      label: "Unfollow Tool",       shortLabel: "UNFOLLOW",  icon: UserMinus     },
    { value: "contact",       label: "Contact Tool",        shortLabel: "CONTACT",   icon: MessageSquare },
    { value: "human-session", label: "Human Session Tools", shortLabel: "HUMAN",     icon: User          },
    { value: "session-log",   label: "Session Log",         shortLabel: "LOG",       icon: Activity      },
  ] : []),
  { value: "create-cookie", label: "Create a Cookie",     shortLabel: "COOKIE",    icon: Cookie        },
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
  const activeTab = new URLSearchParams(search).get("tab") ?? "settings";

  const BRAND = "#1AD2F2";

  const navItems = [
    { name: "Dashboard",    shortName: "DASHBOARD", path: "/dashboard",   icon: LayoutDashboard },
    { name: "Accounts",     shortName: "ACCOUNTS",  path: "/profiles",    icon: Users           },
    { name: "Bulk Import",  shortName: "BULK\nIMPORT", path: "/bulk-import", icon: Upload       },
    { name: "Ghost Browser",shortName: "GHOST",     path: "/create-ghost",icon: Ghost           },
    { name: "Statistics",   shortName: "STATS",     path: "/stats",       icon: Activity        },
    { name: "Proxy Manager",shortName: "PROXIES",   path: "/proxies",     icon: ShieldAlert     },
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
    <div className="w-[74px] bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">

      {/* Logo + nav arrows */}
      <div className="h-16 flex flex-col items-center justify-center border-b border-border/50 gap-0.5 shrink-0">
        <img src="/bot-logo.png" alt="Equinox" className="w-8 h-8 object-contain" />
        <div className="flex items-center gap-0">
          <button
            onClick={goBack}
            className={cn(
              "p-0.5 rounded transition-colors",
              canBack ? "hover:bg-accent cursor-pointer" : "cursor-default"
            )}
            style={{ color: canBack ? BRAND : BRAND + "40" }}
            title="Go back"
          >
            <ChevronLeft className="w-4 h-4" strokeWidth={2.5} />
          </button>
          <button
            onClick={goForward}
            className={cn(
              "p-0.5 rounded transition-colors",
              canForward ? "hover:bg-accent cursor-pointer" : "cursor-default"
            )}
            style={{ color: canForward ? BRAND : BRAND + "40" }}
            title="Go forward"
          >
            <ChevronRight className="w-4 h-4" strokeWidth={2.5} />
          </button>
        </div>
      </div>

      {/* Main nav */}
      <nav className="flex-1 overflow-y-auto overflow-x-hidden">
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
                title={item.name}
                className={cn(
                  "flex flex-col items-center justify-center w-full py-2.5 gap-1 transition-all duration-150 rounded-none",
                  isActive
                    ? "bg-primary/15 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
                style={isActive ? { borderLeft: `3px solid ${BRAND}` } : { borderLeft: "3px solid transparent" }}
              >
                <Icon
                  className="w-[22px] h-[22px] shrink-0"
                  style={{ color: isActive ? BRAND : undefined }}
                />
                <span
                  className="text-[9px] font-bold tracking-wider leading-tight text-center whitespace-pre-line"
                  style={{ color: isActive ? BRAND : undefined }}
                >
                  {item.shortName}
                </span>
              </button>

              {/* Profile sub-tabs — icon-only squares when on a profile detail page */}
              {item.path === "/profiles" && profileId > 0 && (
                <div className="border-t border-border/30">
                  {PROFILE_TABS(!!profile?.creatorMode).map(({ value, label, icon: TabIcon, spacerAfter }) => {
                    const isSubActive = activeTab === value;
                    return (
                      <div key={value}>
                        <button
                          onClick={() => setLocation(`/profiles/${profileId}?tab=${value}`)}
                          title={label}
                          className={cn(
                            "flex items-center justify-center w-full py-2 transition-all duration-150 rounded-none",
                            isSubActive
                              ? "bg-primary/20 text-primary"
                              : "text-muted-foreground hover:bg-accent hover:text-foreground"
                          )}
                          style={isSubActive ? { borderLeft: `3px solid ${BRAND}` } : { borderLeft: "3px solid transparent" }}
                        >
                          <TabIcon
                            className="w-[16px] h-[16px] shrink-0"
                            style={{ color: isSubActive ? BRAND : undefined }}
                          />
                        </button>
                        {spacerAfter && <div className="h-px bg-border/30 mx-2" />}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {slot && (
        <div className="px-1 pb-2 flex justify-center">
          {slot}
        </div>
      )}

      {/* Settings button */}
      <div className="shrink-0">
        <button
          onClick={() => setLocation("/settings")}
          title="Settings"
          className={cn(
            "flex flex-col items-center justify-center w-full py-2.5 gap-1 transition-all duration-150 rounded-none",
            location === "/settings"
              ? "bg-primary/15 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
          style={location === "/settings" ? { borderLeft: `3px solid ${BRAND}` } : { borderLeft: "3px solid transparent" }}
        >
          <Settings
            className="w-[22px] h-[22px] shrink-0"
            style={{ color: location === "/settings" ? BRAND : undefined }}
          />
          <span
            className="text-[9px] font-bold tracking-wider"
            style={{ color: location === "/settings" ? BRAND : undefined }}
          >
            SETTINGS
          </span>
        </button>
      </div>

      {/* Status pill */}
      <div className="px-1 pb-3 pt-1 border-t border-border/50 shrink-0">
        <div className="bg-background rounded px-1 py-1 border border-border flex items-center justify-center gap-1 min-w-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400 shrink-0"></span>
          <span className="text-[9px] font-medium text-muted-foreground whitespace-nowrap truncate">Dev</span>
        </div>
      </div>
    </div>
  );
}
