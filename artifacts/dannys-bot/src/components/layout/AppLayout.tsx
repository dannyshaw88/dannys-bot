import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { LiveActivityTicker } from "./LiveActivityTicker";
import { AdapterRotationWatcher } from "./AdapterRotationWatcher";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen bg-background flex overflow-hidden">
      <AdapterRotationWatcher />
      <Sidebar />
      <main className="flex-1 ml-[133px] h-screen relative flex flex-col overflow-x-hidden w-0">
        <LiveActivityTicker />
        <div id="app-scroll" className="px-4 pt-4 w-full flex-1 min-h-0 overflow-y-scroll">
          {children}
        </div>
      </main>
    </div>
  );
}
