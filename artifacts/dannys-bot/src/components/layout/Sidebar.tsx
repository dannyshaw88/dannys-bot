import { Link, useLocation } from "wouter";
import { LayoutDashboard, Users, UserPlus, ShieldAlert, Settings, Activity, BookOpen } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSidebarSlot } from "@/contexts/SidebarSlotContext";


export function Sidebar() {
  const [location] = useLocation();
  const slot = useSidebarSlot();

  const navItems = [
    { name: "Dashboard", path: "/dashboard", icon: LayoutDashboard },
    { name: "Accounts", path: "/profiles", icon: Users },
    { name: "Create an Account", path: "/create-account", icon: UserPlus },
    { name: "Stats", path: "/stats", icon: Activity },
    { name: "Proxy Manager", path: "/proxies", icon: ShieldAlert },
    { name: "Settings", path: "/settings", icon: Settings },
  ];

  return (
    <div className="w-64 bg-card border-r border-border h-screen flex flex-col fixed left-0 top-0">
      <div className="h-16 flex items-center px-6 border-b border-border/50">
        <img src="/equinox-logo.png" alt="Equinox" className="w-7 h-7 mr-3 shrink-0 object-contain" />
        <span className="font-bold text-lg tracking-tight text-foreground">
          Equi<span style={{ color: "#00C8FF" }}>NOX</span>
        </span>
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
