import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, UserPlus, ShieldAlert, Settings, Activity, BookOpen, ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";
import { useEffect, useRef, useState } from "react";


export function Sidebar() {
  const [location, setLocation] = useLocation();
  const slot = useSidebarSlot();

  const historyStack = useRef<string[]>([location]);
  const historyIndex = useRef<number>(0);
  const isNavigating = useRef<boolean>(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);

  useEffect(() => {
    if (isNavigating.current) {
      isNavigating.current = false;
      setCanBack(historyIndex.current > 0);
      setCanForward(historyIndex.current < historyStack.current.length - 1);
      return;
    }
    const stack = historyStack.current;
    const idx = historyIndex.current;
    if (stack[idx] === location) return;
    const newStack = stack.slice(0, idx + 1);
    newStack.push(location);
    historyStack.current = newStack;
    historyIndex.current = newStack.length - 1;
    setCanBack(historyIndex.current > 0);
    setCanForward(false);
  }, [location]);

  const navItems = [
    { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
    { name: "Accounts", path: "/profiles", icon: Users },
    { name: "Create an Account", path: "/create-account", icon: UserPlus },
    { name: "Stats", path: "/stats", icon: Activity },
    { name: "Proxy Manager", path: "/proxies", icon: ShieldAlert },
    { name: "Settings", path: "/settings", icon: Settings },
  ];

  function goBack() {
    if (historyIndex.current <= 0) return;
    historyIndex.current -= 1;
    isNavigating.current = true;
    setLocation(historyStack.current[historyIndex.current]);
  }

  function goForward() {
    if (historyIndex.current >= historyStack.current.length - 1) return;
    historyIndex.current += 1;
    isNavigating.current = true;
    setLocation(historyStack.current[historyIndex.current]);
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

      <nav className="flex-1 px-3 py-1 space-y-0">
        {navItems.map((item) => {
          const isActive = location === item.path || (item.path !== "/dashboard" && location.startsWith(item.path));
          const Icon = item.icon;
          
          return (
            <Link key={item.path} href={item.path} className={cn(
              "flex items-center px-4 py-2.5 gap-2.5 rounded-md text-sm font-medium transition-all duration-200 group",
              isActive 
                ? "bg-primary/10 text-primary" 
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}>
              <Icon className={cn(
                "w-5 h-5 mr-3 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
              )} />
              {item.name}
            </Link>
          );
        })}
      </nav>

      {slot && (
        <div className="px-4 pb-3">
          {slot}
        </div>
      )}

      <div className="px-3 pb-2">
        <Link href="/readme" className={cn(
          "flex items-center px-4 py-2.5 gap-2.5 rounded-md text-sm font-medium transition-all duration-200 group w-full",
          location === "/readme"
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        )}>
          <BookOpen className={cn(
            "w-5 h-5 mr-3 transition-colors",
            location === "/readme" ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
          )} />
          README &amp; FAQ
        </Link>
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
