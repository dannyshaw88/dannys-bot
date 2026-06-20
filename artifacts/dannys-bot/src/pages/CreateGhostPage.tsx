import { useState } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useProxies } from "@/hooks/use-proxies";
import { GhostBrowserPanel, type SavedProxy } from "./GhostBrowserPanel";
import { cn } from "@/lib/utils";
import { Plus, X } from "lucide-react";

interface Tab {
  id: number;
  label: string;
}

const INITIAL_TABS: Tab[] = [
  { id: 1, label: "Signup 1" },
];

export function GhostBrowserTabContent() {
  const { data: proxies = [] } = useProxies();
  const [tabs, setTabs]           = useState<Tab[]>(INITIAL_TABS);
  const [nextSlot, setNextSlot]   = useState(2);
  const [activeTabIdx, setActiveTabIdx] = useState(0);

  const addTab = () => {
    const newTab: Tab = { id: nextSlot, label: `Signup ${nextSlot}` };
    setTabs(prev => [...prev, newTab]);
    setNextSlot(n => n + 1);
    setActiveTabIdx(tabs.length);
  };

  const removeTab = (idx: number) => {
    if (tabs.length <= 1) return;
    setTabs(prev => prev.filter((_, i) => i !== idx));
    setActiveTabIdx(prev => {
      if (idx < prev) return prev - 1;
      if (idx === prev) return Math.max(0, prev - 1);
      return prev;
    });
  };

  return (
    <>
      {/* ── Tab bar ── */}
      <div className="flex items-center gap-0.5 mb-1.5 border-b border-border pb-0 -mt-1 overflow-x-auto">
        {tabs.map((tab, i) => (
          <div key={tab.id} className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setActiveTabIdx(i)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-t-md border-t border-x border-border transition-colors select-none",
                i === activeTabIdx
                  ? "bg-background text-foreground border-b-background -mb-px z-10 relative"
                  : "bg-muted/40 text-muted-foreground hover:text-foreground hover:bg-muted/60 border-transparent"
              )}
            >
              {tab.label}
              {tabs.length > 1 && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={e => { e.stopPropagation(); removeTab(i); }}
                  onKeyDown={e => { if (e.key === "Enter") { e.stopPropagation(); removeTab(i); } }}
                  className="w-3.5 h-3.5 flex items-center justify-center rounded-sm hover:bg-destructive/20 hover:text-destructive text-muted-foreground/60 transition-colors"
                >
                  <X className="w-2.5 h-2.5" />
                </span>
              )}
            </button>
          </div>
        ))}

        {/* Add tab button */}
        <button
          type="button"
          onClick={addTab}
          title="Add new Ghost Browser tab"
          className="flex items-center justify-center w-6 h-6 ml-1 rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground hover:border-foreground/40 transition-colors shrink-0"
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {/* ── Render all panels; only the active one is visible ── */}
      {tabs.map((tab, i) => (
        <div key={tab.id} style={{ display: i === activeTabIdx ? "contents" : "none" }}>
          <GhostBrowserPanel slot={tab.id} proxies={proxies as SavedProxy[]} />
        </div>
      ))}
    </>
  );
}

export function CreateGhostPage() {
  return (
    <AppLayout>
      <GhostBrowserTabContent />
    </AppLayout>
  );
}
