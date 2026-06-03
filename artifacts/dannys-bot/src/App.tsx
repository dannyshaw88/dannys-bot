import { Switch, Route, Redirect } from "wouter";
import { QueryClientProvider, useQuery, useQueryClient } from "@tanstack/react-query";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { useState, useEffect } from "react";

import { Dashboard } from "@/pages/Dashboard";
import { StatsPage } from "@/pages/StatsPage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { CreateGhostPage } from "@/pages/CreateGhostPage";
import { ProfileDetailsPage } from "@/pages/ProfileDetailsPage";
import { ProxiesPage } from "@/pages/ProxiesPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StandaloneBrowserPage } from "@/pages/StandaloneBrowserPage";
import { ReadmePage } from "@/pages/ReadmePage";
import { BulkImportPage } from "@/pages/BulkImportPage";
import { MobilePage } from "@/pages/MobilePage";
import { TrustScoresPage } from "@/pages/TrustScoresPage";
import { TrustScoreDetailPage } from "@/pages/TrustScoreDetailPage";
import { BrowserWindowsProvider, useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { SidebarSlotProvider } from "@/contexts/SidebarSlotContext";
import { NavigationHistoryProvider } from "@/contexts/NavigationHistoryContext";
import { BrowserWindow } from "@/components/BrowserWindow";
import { BrowserTaskbar } from "@/components/BrowserTaskbar";
import { queryClient } from "@/lib/queryClient";
import { useStatusEvents } from "@/hooks/use-profiles";
import { Loader2 } from "lucide-react";

const SAVED_LOGIN_KEY = "equinox:savedLogin";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/profiles" component={ProfilesPage} />
      <Route path="/create-ghost" component={CreateGhostPage} />
      <Route path="/stats" component={StatsPage} />
      <Route path="/profiles/:id" component={ProfileDetailsPage} />
      <Route path="/proxies" component={ProxiesPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/browser/:id" component={StandaloneBrowserPage} />
      <Route path="/bulk-import" component={BulkImportPage} />
      <Route path="/mobile" component={MobilePage} />
      <Route path="/trust-scores" component={TrustScoresPage} />
      <Route path="/trust-scores/:trustScoreId" component={TrustScoreDetailPage} />
      <Route path="/readme" component={ReadmePage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function BrowserLayer() {
  const { windows } = useBrowserWindows();
  return (
    <>
      {windows.map(w => <BrowserWindow key={w.profileId} window={w} />)}
      <BrowserTaskbar />
    </>
  );
}

function AppInner() {
  useStatusEvents();
  return (
    <>
      <Router />
      <BrowserLayer />
    </>
  );
}

function LoginSplash() {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [saveLogin, setSaveLogin] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(SAVED_LOGIN_KEY);
      if (saved) {
        const { u, p } = JSON.parse(saved);
        if (u && p) {
          setUsername(u);
          setPassword(p);
          setSaveLogin(true);
          doLogin(u, p, true);
        }
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doLogin = async (u: string, p: string, silent = false) => {
    setLoading(true);
    if (!silent) setError("");
    try {
      const r = await fetch("/api/license/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u.trim(), password: p }),
        credentials: "include",
      });
      const data = await r.json();
      if (data.ok) {
        qc.invalidateQueries({ queryKey: ["/api/license/me"] });
      } else {
        if (!silent) setError("Invalid username or password.");
        localStorage.removeItem(SAVED_LOGIN_KEY);
      }
    } catch {
      if (!silent) setError("Connection failed. Please try again.");
    } finally {
      setLoading(false);
    }
  };

  const handleLogin = () => {
    if (!username.trim() || !password) return;
    if (saveLogin) {
      try { localStorage.setItem(SAVED_LOGIN_KEY, JSON.stringify({ u: username.trim(), p: password })); } catch {}
    } else {
      localStorage.removeItem(SAVED_LOGIN_KEY);
    }
    doLogin(username, password);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50" style={{ background: "#ffffff" }}>
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="flex flex-col items-center mb-7">
          <img
            src="/bot-logo.png"
            alt="Equinox"
            className="w-16 h-16 mb-2 object-contain"
          />
          <h1 className="text-2xl font-bold tracking-tight">
            <span style={{ color: "#111827" }}>Equi</span><span style={{ color: "#1AD2F2" }}>nox</span>
          </h1>
          <p className="text-sm mt-1" style={{ color: "#6b7280" }}>Sign in to your account</p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#111827" }}>Username</label>
            <input
              value={username}
              onChange={e => { setUsername(e.target.value); setError(""); }}
              placeholder="Username"
              autoComplete="off"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              style={{
                display: "block", width: "100%", height: "40px",
                padding: "0 12px", fontSize: "14px",
                border: "1px solid #d1d5db", borderRadius: "6px",
                background: "#ffffff", color: "#111827", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>
          <div>
            <label className="text-xs font-medium mb-1.5 block" style={{ color: "#111827" }}>Password</label>
            <input
              type="password"
              value={password}
              onChange={e => { setPassword(e.target.value); setError(""); }}
              placeholder="Password"
              onKeyDown={e => e.key === "Enter" && handleLogin()}
              style={{
                display: "block", width: "100%", height: "40px",
                padding: "0 12px", fontSize: "14px",
                border: "1px solid #d1d5db", borderRadius: "6px",
                background: "#ffffff", color: "#111827", outline: "none",
                boxSizing: "border-box",
              }}
            />
          </div>

          <label className="flex items-center gap-2 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={saveLogin}
              onChange={e => setSaveLogin(e.target.checked)}
              className="w-3.5 h-3.5"
            />
            <span className="text-xs" style={{ color: "#6b7280" }}>Save login</span>
          </label>

          {error && <p className="text-xs font-medium" style={{ color: "#dc2626" }}>{error}</p>}

          <button
            onClick={handleLogin}
            disabled={loading || !username.trim() || !password}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: "100%", height: "40px", marginTop: "4px",
              background: loading || !username.trim() || !password ? "#93c5fd" : "#2563eb",
              color: "#ffffff", fontWeight: 600, fontSize: "14px",
              border: "none", borderRadius: "6px", cursor: loading || !username.trim() || !password ? "not-allowed" : "pointer",
            }}
          >
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Sign In"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LicenseGate({ children }: { children: React.ReactNode }) {
  const { data: me, isLoading } = useQuery<{ ok: boolean }>({
    queryKey: ["/api/license/me"],
    queryFn: async () => {
      const r = await fetch("/api/license/me", { credentials: "include" });
      return r.json();
    },
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ background: "#ffffff" }}>
        <div className="flex flex-col items-center gap-3">
          <img
            src="/bot-logo.png"
            alt="Equinox"
            className="w-12 h-12 object-contain"
          />
          <Loader2 className="w-5 h-5 animate-spin" style={{ color: "#6b7280" }} />
        </div>
      </div>
    );
  }

  if (!me?.ok) {
    return <LoginSplash />;
  }

  return <>{children}</>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <NavigationHistoryProvider>
          <SidebarSlotProvider>
            <BrowserWindowsProvider>
              <LicenseGate>
                <AppInner />
              </LicenseGate>
            </BrowserWindowsProvider>
          </SidebarSlotProvider>
        </NavigationHistoryProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
