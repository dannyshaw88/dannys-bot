import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronRight, Check, Smartphone } from "lucide-react";
import { userAgents } from "@shared/userAgents";

export interface UaEntry { api: string; embedded: string; }

interface Props {
  value: string;
  onSelect: (ua: UaEntry) => void;
}

function parseParts(api: string) {
  const p = api.split("; ");
  const androidVer = (p[0] ?? "").split("/")[1] ?? "";
  return {
    brand:   p[3] ?? "Unknown",
    model:   p[4] ?? api,
    dpi:     p[1] ?? "",
    android: androidVer ? `Android ${androidVer}` : "",
  };
}

export function UaPickerDropdown({ value, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [expandedBrands, setExpandedBrands] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (open && value) {
      const { brand } = parseParts(value);
      setExpandedBrands(new Set([brand]));
    }
    if (open) setSearch("");
  }, [open]);

  const grouped = userAgents.reduce((acc, ua) => {
    const { brand } = parseParts(ua.api);
    if (!acc[brand]) acc[brand] = [];
    acc[brand].push(ua);
    return acc;
  }, {} as Record<string, UaEntry[]>);

  const q = search.trim().toLowerCase();
  const filtered: Record<string, UaEntry[]> = {};
  for (const [brand, uas] of Object.entries(grouped)) {
    const matching = q
      ? uas.filter(ua =>
          brand.toLowerCase().includes(q) ||
          parseParts(ua.api).model.toLowerCase().includes(q)
        )
      : uas;
    if (matching.length > 0) filtered[brand] = matching;
  }

  const effectiveExpanded = q ? new Set(Object.keys(filtered)) : expandedBrands;

  const toggleBrand = (brand: string) => {
    setExpandedBrands(prev => {
      const next = new Set(prev);
      if (next.has(brand)) next.delete(brand); else next.add(brand);
      return next;
    });
  };

  const { brand: curBrand, model: curModel } = parseParts(value);
  const isKnown = !!value && userAgents.some(ua => ua.api === value);
  const currentLabel = isKnown
    ? `${curBrand} — ${curModel}`
    : value
    ? value.length > 42 ? value.slice(0, 42) + "…" : value
    : "Pick a device…";

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-2 min-w-0">
          <Smartphone className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-left">{currentLabel}</span>
        </span>
        <ChevronDown className={`ml-2 w-4 h-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div className="absolute left-0 right-0 z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="p-2 border-b border-border">
            <input
              autoFocus
              placeholder="Search brand or model…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              onClick={e => e.stopPropagation()}
              className="w-full rounded-sm border border-input bg-background px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {Object.entries(filtered).length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No devices found</p>
            )}
            {Object.entries(filtered).map(([brand, uas]) => (
              <div key={brand}>
                <button
                  type="button"
                  onClick={() => toggleBrand(brand)}
                  className="flex w-full items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/60 select-none"
                >
                  {effectiveExpanded.has(brand)
                    ? <ChevronDown className="w-3 h-3" />
                    : <ChevronRight className="w-3 h-3" />}
                  {brand}
                  <span className="ml-auto text-[10px] font-normal opacity-50 normal-case">
                    {uas.length} device{uas.length !== 1 ? "s" : ""}
                  </span>
                </button>
                {effectiveExpanded.has(brand) && uas.map(ua => {
                  const { model, android, dpi } = parseParts(ua.api);
                  const isSelected = ua.api === value;
                  return (
                    <button
                      key={ua.api}
                      type="button"
                      onClick={() => { onSelect(ua); setOpen(false); }}
                      className={`flex w-full items-center gap-2 pl-7 pr-3 py-1.5 text-xs transition-colors hover:bg-accent ${
                        isSelected ? "text-primary font-medium bg-accent/40" : "text-foreground"
                      }`}
                    >
                      <span className="w-3 shrink-0">
                        {isSelected && <Check className="w-3 h-3" />}
                      </span>
                      <span className="truncate">{model}</span>
                      <span className="ml-auto shrink-0 text-[10px] text-muted-foreground whitespace-nowrap">
                        {android} · {dpi}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
