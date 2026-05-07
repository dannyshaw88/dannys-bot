import { Switch, Route, Redirect } from "wouter";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import { Dashboard } from "@/pages/Dashboard";
import { StatsPage } from "@/pages/StatsPage";
import { ProfilesPage } from "@/pages/ProfilesPage";
import { CreateAccountPage } from "@/pages/CreateAccountPage";
import { ProfileDetailsPage } from "@/pages/ProfileDetailsPage";
import { ProxiesPage } from "@/pages/ProxiesPage";
import { SettingsPage } from "@/pages/SettingsPage";
import { StandaloneBrowserPage } from "@/pages/StandaloneBrowserPage";
import { ReadmePage } from "@/pages/ReadmePage";

import { BrowserWindowsProvider, useBrowserWindows } from "@/contexts/BrowserWindowsContext";
import { SidebarSlotProvider } from "@/contexts/SidebarSlotContext";
import { BrowserWindow } from "@/components/BrowserWindow";
import { BrowserTaskbar } from "@/components/BrowserTaskbar";
import { queryClient } from "@/lib/queryClient";

function Router() {
  return (
    <Switch>
      <Route path="/">
        <Redirect to="/dashboard" />
      </Route>
      <Route path="/dashboard" component={Dashboard} />
      <Route path="/profiles" component={ProfilesPage} />
      <Route path="/create-account" component={CreateAccountPage} />
      <Route path="/stats" component={StatsPage} />
      <Route path="/profiles/:id" component={ProfileDetailsPage} />
      <Route path="/proxies" component={ProxiesPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/browser/:id" component={StandaloneBrowserPage} />
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

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarSlotProvider>
          <BrowserWindowsProvider>
            <Toaster />
            <Router />
            <BrowserLayer />
          </BrowserWindowsProvider>
        </SidebarSlotProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
