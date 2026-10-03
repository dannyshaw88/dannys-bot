import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Smartphone, type LucideIcon } from "lucide-react";

export interface GroupedAgentPickerOption {
  value: string;
  group: string;
  label: string;
  detail?: string;
  searchText?: string;
}

export interface GroupedAgentPickerFeaturedOption {
  label: string;
  description?: string;
}

interface Props {
  value: string | null;
  options: readonly GroupedAgentPickerOption[];
  onSelect: (value: string | null) => void;
  fullWidth?: boolean;
  placeholder?: string;
  searchPlaceholder?: string;
  displayValue?: string;
  buttonTitle?: string;
  itemNoun?: string;
  icon?: LucideIcon;
  featuredOption?: GroupedAgentPickerFeaturedOption;
}

export function GroupedAgentPicker({
  value,
  options,
  onSelect,
  fullWidth,
  placeholder = "Choose an agent…",
  searchPlaceholder = "Search brand or model…",
  displayValue,
  buttonTitle,
  itemNoun = "agent",
  icon: Icon = Smartphone,
  featuredOption,
}: Props) {
  const [open, setOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const selectedGroup = options.find(option => option.value === value)?.group;
    setExpandedGroups(selectedGroup ? new Set([selectedGroup]) : new Set());
    setSearch("");
  }, [open, value, options]);

  const grouped = options.reduce((groups, option) => {
    (groups[option.group] ??= []).push(option);
    return groups;
  }, {} as Record<string, GroupedAgentPickerOption[]>);

  const query = search.trim().toLowerCase();
  const filtered = Object.entries(grouped).flatMap(([group, groupOptions]) => {
    const matches = query
      ? groupOptions.filter(option =>
          group.toLowerCase().includes(query) ||
          `${option.label} ${option.detail ?? ""} ${option.searchText ?? ""}`.toLowerCase().includes(query)
        )
      : groupOptions;
    return matches.length ? [[group, matches] as const] : [];
  });
  const effectiveExpanded = query ? new Set(filtered.map(([group]) => group)) : expandedGroups;
  const selectedOption = options.find(option => option.value === value);
  const buttonLabel = displayValue ?? selectedOption?.label ?? placeholder;
  const buttonWidth = fullWidth ? undefined : `${Math.max(18, buttonLabel.length + 6)}ch`;

  return (
    <div ref={containerRef} className={fullWidth ? "relative block w-full" : "relative inline-block"}>
      <button
        type="button"
        onClick={() => setOpen(current => !current)}
        style={buttonWidth ? { width: buttonWidth } : undefined}
        title={buttonTitle ?? selectedOption?.searchText ?? selectedOption?.label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex h-9 items-center justify-between rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring${fullWidth ? " w-full" : ""}`}
      >
        <span className="flex min-w-0 items-center gap-2 overflow-hidden">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{buttonLabel}</span>
        </span>
        <ChevronDown className={`ml-2 h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-150 ${open ? "rotate-180" : ""}`} />
      </button>

      {open && (
        <div
          className="absolute left-0 z-50 mt-1 rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
          style={{ minWidth: buttonWidth, width: "max-content", maxWidth: "90vw" }}
        >
          <div className="border-b border-border p-2">
            <input
              autoFocus
              placeholder={searchPlaceholder}
              value={search}
              onChange={event => setSearch(event.target.value)}
              onClick={event => event.stopPropagation()}
              className="w-full rounded-sm border border-input bg-background px-2.5 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-ring"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {featuredOption && (
              <button
                type="button"
                onClick={() => { onSelect(null); setOpen(false); }}
                aria-pressed={value === null}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-accent ${
                  value === null ? "bg-accent/40 text-primary" : "text-foreground"
                }`}
              >
                <span className="w-3 shrink-0">{value === null && <Check className="h-3 w-3" />}</span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium">{featuredOption.label}</span>
                  {featuredOption.description && (
                    <span className="mt-0.5 block max-w-[34rem] truncate text-[10px] text-muted-foreground">
                      {featuredOption.description}
                    </span>
                  )}
                </span>
              </button>
            )}
            {filtered.length === 0 && (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">No agents found</p>
            )}
            {filtered.map(([group, groupOptions]) => (
              <div key={group}>
                <button
                  type="button"
                  onClick={() => setExpandedGroups(current => {
                    const next = new Set(current);
                    if (next.has(group)) next.delete(group); else next.add(group);
                    return next;
                  })}
                  aria-expanded={effectiveExpanded.has(group)}
                  className="flex w-full select-none items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:bg-accent/60"
                >
                  {effectiveExpanded.has(group)
                    ? <ChevronDown className="h-3 w-3" />
                    : <ChevronRight className="h-3 w-3" />}
                  {group}
                  <span className="ml-auto text-[10px] font-normal normal-case opacity-50">
                    {groupOptions.length} {itemNoun}{groupOptions.length !== 1 ? "s" : ""}
                  </span>
                </button>
                {effectiveExpanded.has(group) && groupOptions.map(option => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => { onSelect(option.value); setOpen(false); }}
                    aria-pressed={option.value === value}
                    title={option.searchText}
                    className={`flex w-full items-center gap-2 py-1.5 pl-7 pr-3 text-left text-xs transition-colors hover:bg-accent ${
                      option.value === value ? "bg-accent/40 font-medium text-primary" : "text-foreground"
                    }`}
                  >
                    <span className="w-3 shrink-0">
                      {option.value === value && <Check className="h-3 w-3" />}
                    </span>
                    <span className="truncate">{option.label}</span>
                    {option.detail && (
                      <span className="ml-auto shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">
                        {option.detail}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}