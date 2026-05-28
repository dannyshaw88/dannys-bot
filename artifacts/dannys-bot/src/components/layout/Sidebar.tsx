import { useLocation, useSearch } from "wouter";
import {
  LayoutDashboard, Users, ShieldAlert, Settings, Activity,
  ChevronLeft, ChevronRight, Ghost, User, UserMinus, UserPlus, MessageSquare, Cookie, Upload, Globe,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";
import { useProfile } from "@/hooks/use-profiles";

const PROFILE_TABS = (creatorMode: boolean) => [
  { value: "settings",      label: "Account Settings",    icon: Settings,      spacerAfter: true },
  ...(!creatorMode ? [
    { value: "follow",        label: "Follow Tool",         icon: UserPlus      },
    { value: "unfollow",      label: "Unfollow Tool",       icon: UserMinus     },
    { value: "contact",       label: "Contact Tool",        icon: MessageSquare },
    { value: "human-session", label: "Human Session Tools", icon: User          },
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
  const activeTab = new URLSearchParams(search).get("tab") ?? "settings";

  const BRAND = "#1AD2F2";
  const navItems = [
    { name: "Dashboard",         path: "/dashboard",          icon: LayoutDashboard, iconColor: undefined,  iconStyle: { color: BRAND } },
    { name: "Accounts",          path: "/profiles",            icon: Users,           iconColor: undefined,  iconStyle: { color: BRAND } },
    { name: "Bulk Import Accounts", path: "/bulk-import", icon: Upload,     iconColor: undefined, iconStyle: { color: BRAND } },
    { name: "Ghost Browser",    path: "/create-ghost",       icon: Ghost,           iconColor: undefined,  iconStyle: { color: BRAND } },
    { name: "Statistics",        path: "/stats",              icon: Activity,        iconColor: undefined,  iconStyle: { color: BRAND } },
    { name: "Proxy Manager",     path: "/proxies",            icon: ShieldAlert,     iconColor: undefined,  iconStyle: { color: BRAND } },
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
    <div className="w-[218px] bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">
      <div className="h-16 flex items-center px-4 border-b border-border/50 gap-2">
        <img src="/bot-logo.png" alt="Equinox" className="w-[38px] h-[38px] shrink-0 object-contain" />
        <span className="font-bold text-lg tracking-tight text-foreground mr-1">
          Equi<span style={{ color: "#1AD2F2" }}>nox</span>
        </span>
        <button
          onClick={goBack}
          className={cn(
            "p-1.5 rounded transition-colors shrink-0",
            canBack ? "hover:bg-accent cursor-pointer" : "cursor-default"
          )}
          style={{ color: canBack ? "#1AD2F2" : "#1AD2F260" }}
          title="Go back"
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2.5} />
        </button>
        <button
          onClick={goForward}
          className={cn(
            "p-1.5 rounded transition-colors shrink-0",
            canForward ? "hover:bg-accent cursor-pointer" : "cursor-default"
          )}
          style={{ color: canForward ? "#1AD2F2" : "#1AD2F260" }}
          title="Go forward"
        >
          <ChevronRight className="w-5 h-5" strokeWidth={2.5} />
        </button>
      </div>

      <nav className="flex-1 px-3 py-1 space-y-0 overflow-y-auto">
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
                  "flex items-center w-full px-4 py-2.5 gap-2.5 text-sm font-medium transition-all duration-200 group text-left rounded-none",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon
                  className={cn(
                    "w-5 h-5 mr-3 transition-colors",
                    item.iconColor ?? (isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground")
                  )}
                  style={item.iconStyle}
                />
                {item.name}
              </button>

              {/* Sub-tabs — only shown when on a profile details page under Accounts */}
              {item.path === "/profiles" && profileId > 0 && (
                <div className="ml-2 mt-1.5 mb-0.5 space-y-0 border-t border-border/40 pt-1">
                  {PROFILE_TABS(!!profile?.creatorMode).map(({ value, label, spacerAfter }) => {
                    const isSubActive = activeTab === value;
                    return (
                      <div key={value}>
                        <button
                          onClick={() => setLocation(`/profiles/${profileId}?tab=${value}`)}
                          className={cn(
                            "flex items-center w-full px-4 py-1.5 text-xs font-bold transition-all duration-150 text-left rounded-md",
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
            </div>
          );
        })}
      </nav>

      {slot && (
        <div className="px-4 pb-3">
          {slot}
        </div>
      )}

      <div className="px-3 pb-2">
        <button
          onClick={() => setLocation("/settings")}
          className={cn(
            "flex items-center w-full px-4 py-2.5 gap-2.5 text-sm font-medium transition-all duration-200 group text-left rounded-none",
            location === "/settings"
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground hover:bg-accent hover:text-foreground"
          )}
        >
          <Settings className={cn(
            "w-5 h-5 mr-3 transition-colors",
            location === "/settings" ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
          )} />
          Settings
        </button>
      </div>

      <div className="px-4 pb-4 border-t border-border/50 pt-3">
        <div className="bg-background rounded-lg px-2.5 py-1.5 border border-border flex items-center gap-1.5 min-w-0">
          <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0"></span>
          <span className="text-[11px] font-medium text-foreground whitespace-nowrap">System Status</span>
          <span className="text-[11px] text-muted-foreground whitespace-nowrap truncate">· in Development</span>
        </div>
      </div>
    </div>
  );
}
