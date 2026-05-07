import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { LiveActivityTicker } from "./LiveActivityTicker";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen bg-background flex overflow-hidden">
      <Sidebar />
      <main className="flex-1 ml-64 h-screen relative flex flex-col overflow-x-hidden w-0">
        <LiveActivityTicker />
        <div className="px-4 pt-4 w-full flex-1 min-h-0 overflow-y-auto">
          {children}
        </div>
      </main>
    </div>
  );
}
