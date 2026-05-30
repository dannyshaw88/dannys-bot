import { useState, useRef, useEffect } from "react";
import { Search, X } from "lucide-react";
import { ICON_REGISTRY, ICON_CATEGORIES, type IconEntry } from "./iconRegistry";

interface IconPickerProps {
  value: string | null;
  onChange: (key: string) => void;
  onClose: () => void;
}

export function IconPicker({ value, onChange, onClose }: IconPickerProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const searchRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const filtered: IconEntry[] = ICON_REGISTRY.filter(entry => {
    const matchCat = category === "All" || entry.category === category;
    const matchSearch = !search || entry.label.toLowerCase().includes(search.toLowerCase()) || entry.key.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/60"
      onMouseDown={e => { if (e.target === overlayRef.current) onClose(); }}
    >
      <div className="bg-background rounded-xl border border-border shadow-2xl flex flex-col"
        style={{ width: 560, height: 520 }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 pt-4 pb-3 border-b border-border shrink-0">
          <span className="text-sm font-semibold">Choose Icon</span>
          <button onClick={onClose} className="p-1 rounded hover:bg-accent transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-border shrink-0">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              ref={searchRef}
              type="text"
              placeholder="Search icons…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-background focus:outline-none focus:ring-2 focus:ring-primary"
            />
            {search && (
              <button
                onClick={() => setSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>

        {/* Category tabs */}
        <div className="flex gap-1 px-4 py-2 border-b border-border overflow-x-auto shrink-0 scrollbar-none">
          {ICON_CATEGORIES.map(cat => (
            <button
              key={cat}
              onClick={() => setCategory(cat)}
              className="shrink-0 px-2.5 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap"
              style={{
                background: category === cat ? "var(--primary)" : "transparent",
                color: category === cat ? "var(--primary-foreground)" : "var(--muted-foreground)",
                border: `1px solid ${category === cat ? "var(--primary)" : "var(--border)"}`,
              }}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Icon grid */}
        <div className="flex-1 overflow-y-auto p-3">
          {filtered.length === 0 ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              No icons match "{search}"
            </div>
          ) : (
            <div className="grid gap-1" style={{ gridTemplateColumns: "repeat(9, 1fr)" }}>
              {filtered.map(entry => {
                const isSelected = value === entry.key;
                return (
                  <button
                    key={entry.key}
                    title={entry.label}
                    onClick={() => { onChange(entry.key); onClose(); }}
                    className="flex flex-col items-center justify-center gap-0.5 rounded-lg p-1.5 transition-colors hover:bg-accent group"
                    style={{
                      background: isSelected ? "var(--primary)" : undefined,
                      outline: isSelected ? "2px solid var(--primary)" : undefined,
                    }}
                  >
                    <entry.Icon
                      size={16}
                      color={isSelected ? "var(--primary-foreground)" : "var(--foreground)"}
                    />
                    <span
                      className="text-[8px] leading-tight text-center truncate w-full"
                      style={{ color: isSelected ? "var(--primary-foreground)" : "var(--muted-foreground)" }}
                    >
                      {entry.label}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer count */}
        <div className="px-4 py-2 border-t border-border shrink-0 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {filtered.length} icon{filtered.length !== 1 ? "s" : ""}
            {category !== "All" && ` in ${category}`}
            {search && ` matching "${search}"`}
          </span>
          <button
            onClick={onClose}
            className="px-3 py-1 text-xs rounded-md border border-border hover:bg-accent transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
