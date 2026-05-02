import { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { LiveActivityTicker } from "./LiveActivityTicker";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex">
      <Sidebar />
      <main className="flex-1 ml-64 min-h-screen relative flex flex-col overflow-x-hidden w-0">
        <LiveActivityTicker />
        <div className="max-w-[1400px] mx-auto p-8 w-full">
          {children}
        </div>
      </main>
    </div>
  );
}
