import { useLocation, useSearch } from "wouter";
import {
  LayoutDashboard, Users, UserPlus, ShieldAlert, Settings, Activity,
  ChevronLeft, ChevronRight, Wand2, User, UserMinus, MessageSquare, Cookie,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useNavigationHistory } from "@/contexts/NavigationHistoryContext";
import { useEffect } from "react";
import { useProfile } from "@/hooks/use-profiles";

const PROFILE_TABS = (creatorMode: boolean) => [
  { value: "settings",      label: "Account Settings",    icon: Settings },
  ...(!creatorMode ? [
    { value: "human-session", label: "Human Session Tools", icon: User },
    { value: "follow",        label: "Follow Tool",         icon: UserPlus },
    { value: "unfollow",      label: "Unfollow Tool",       icon: UserMinus },
    { value: "contact",       label: "Contact Tool",        icon: MessageSquare },
    { value: "session-log",   label: "Session Log",         icon: Activity },
  ] : []),
  { value: "create-cookie", label: "Create a Cookie",     icon: Cookie },
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

  const navItems = [
    { name: "Dashboard",         path: "/dashboard",          icon: LayoutDashboard },
    { name: "Accounts",          path: "/profiles",            icon: Users },
    { name: "Create an Account", path: "/create-account-api", icon: Wand2 },
    { name: "Statistics",         path: "/stats",              icon: Activity },
    { name: "Proxy Manager",     path: "/proxies",            icon: ShieldAlert },
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
    <div className="w-64 bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">
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
          const fromCreateAccount = location.startsWith("/profiles/") && search.includes("from=create-account");
          const isActive = (() => {
            if (item.path === "/dashboard") return location === "/dashboard";
            if (item.path === "/create-account") return location === "/create-account" || fromCreateAccount;
            if (item.path === "/profiles") return location === "/profiles" || location.startsWith("/profiles/");
            return location.startsWith(item.path);
          })();
          const Icon = item.icon;

          return (
            <div key={item.path}>
              <button
                onClick={() => setLocation(item.path)}
                className={cn(
                  "flex items-center w-full px-4 py-2.5 gap-2.5 rounded-md text-sm font-medium transition-all duration-200 group text-left",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground"
                )}
              >
                <Icon className={cn(
                  "w-5 h-5 mr-3 transition-colors",
                  isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                )} />
                {item.name}
              </button>

              {/* Sub-tabs — only shown when on a profile details page under Accounts */}
              {item.path === "/profiles" && profileId > 0 && (
                <div className="ml-2 mt-0.5 mb-0.5 space-y-0">
                  {PROFILE_TABS(!!profile?.creatorMode).map(({ value, label }) => {
                    const isSubActive = activeTab === value;
                    return (
                      <button
                        key={value}
                        onClick={() => setLocation(`/profiles/${profileId}?tab=${value}`)}
                        className={cn(
                          "flex items-center w-full px-4 py-1.5 text-xs font-medium transition-all duration-150 text-left rounded-md",
                          isSubActive
                            ? "text-primary"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <ChevronRight className="w-3 h-3 text-muted-foreground mr-1 shrink-0" />
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

      <div className="px-3 pb-2">
        <button
          onClick={() => setLocation("/settings")}
          className={cn(
            "flex items-center w-full px-4 py-2.5 gap-2.5 rounded-md text-sm font-medium transition-all duration-200 group text-left",
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

      <div className="p-4 border-t border-border/50">
        <div className="bg-background rounded-lg p-3 border border-border">
          <p className="text-xs font-medium text-foreground">System Status</p>
          <div className="flex items-center mt-2">
            <span className="w-2 h-2 rounded-full bg-green-500 mr-2"></span>
            <span className="text-xs text-muted-foreground">All services operational</span>
          </div>
        </div>
      </div>
    </div>
  );
}
