import { useParams, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { getTrustLevels, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import { ChevronLeft, Copy, CheckCircle2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AUTOMATION_DEFAULTS,
  COPY_SECTIONS,
  type AutomationSettingsData,
  type UsbPhone,
  type CopySection,
  TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS,
} from "@/pages/mobileShared";
import { AutomationSettingsPanel } from "@/pages/MobilePage";
import { FakeTrustScoreMirror } from "@/components/FakeTrustScoreMirror";

// ── CopyTrustScoreDialog ──────────────────────────────────────────────────────
// Exact same two-panel layout as the mobile slot CopySettingsDialog.
// Left: trust score tiers to copy TO (except the source tier).
// Right: setting sections / sub-items to pick WHAT to copy.

const COPY_TS_TARGETS_KEY  = "copyTrustScore_targets";
const COPY_TS_SUBKEYS_KEY  = "copyTrustScore_subKeys";

function CopyTrustScoreDialog({
  open,
  onOpenChange,
  sourceTrustScoreId,
  sourceSettings,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sourceTrustScoreId: string;
  sourceSettings: AutomationSettingsData;
}) {
  const allLevels   = getTrustLevels();
  const tierTargets = allLevels.filter(l => l.id !== sourceTrustScoreId);
  const sourceLevel = allLevels.find(l => l.id === sourceTrustScoreId);

  const [selectedTiers,   setSelectedTiers]   = useState<Set<string>>(new Set());
  const [selectedSubKeys, setSelectedSubKeys] = useState<Set<string>>(new Set());
  const [copying,  setCopying]  = useState(false);
  const [result,   setResult]   = useState<"ok" | string | null>(null);

  // Restore saved selections when dialog opens
  useEffect(() => {
    if (!open) return;
    setResult(null);
    setCopying(false);
    try {
      const rawT = sessionStorage.getItem(COPY_TS_TARGETS_KEY);
      if (rawT) {
        const ids: string[] = JSON.parse(rawT);
        setSelectedTiers(new Set(ids.filter(id => tierTargets.some(t => t.id === id))));
      } else {
        setSelectedTiers(new Set());
      }
    } catch { setSelectedTiers(new Set()); }
    try {
      const rawS = sessionStorage.getItem(COPY_TS_SUBKEYS_KEY);
      if (rawS) {
        const allowed = new Set(
          COPY_SECTIONS.flatMap(section => section.sub)
            .filter(sub => sub.fields.every(field => !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)))
            .map(sub => sub.key),
        );
        setSelectedSubKeys(new Set(
          (JSON.parse(rawS) as string[]).filter(key => allowed.has(key)),
        ));
      } else {
        setSelectedSubKeys(new Set());
      }
    } catch { setSelectedSubKeys(new Set()); }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Left panel helpers ──
  const toggleTier = (id: string) => setSelectedTiers(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    sessionStorage.setItem(COPY_TS_TARGETS_KEY, JSON.stringify([...next]));
    return next;
  });
  const selectAllTiers  = () => { const s = new Set(tierTargets.map(t => t.id)); sessionStorage.setItem(COPY_TS_TARGETS_KEY, JSON.stringify([...s])); setSelectedTiers(s); };
  const selectNoneTiers = () => { sessionStorage.removeItem(COPY_TS_TARGETS_KEY); setSelectedTiers(new Set()); };

  // ── Right panel helpers ──
  const toggleSub = (key: string, checked: boolean) => setSelectedSubKeys(prev => {
    const sub = COPY_SECTIONS.flatMap(section => section.sub).find(candidate => candidate.key === key);
    if (!sub || sub.fields.some(field => TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field))) return prev;
    const n = new Set(prev);
    checked ? n.add(key) : n.delete(key);
    sessionStorage.setItem(COPY_TS_SUBKEYS_KEY, JSON.stringify([...n]));
    return n;
  });
  const toggleSection = (section: CopySection, checked: boolean) => setSelectedSubKeys(prev => {
    const n = new Set(prev);
    section.sub
      .filter(sub => sub.fields.every(field => !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)))
      .forEach(sub => checked ? n.add(sub.key) : n.delete(sub.key));
    sessionStorage.setItem(COPY_TS_SUBKEYS_KEY, JSON.stringify([...n]));
    return n;
  });
  const sectionState = (section: CopySection): "all" | "some" | "none" => {
    const copyableSubs = section.sub.filter(sub =>
      sub.fields.every(field => !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)),
    );
    const sel = copyableSubs.filter(sub => selectedSubKeys.has(sub.key)).length;
    if (sel === 0) return "none";
    if (sel === copyableSubs.length) return "all";
    return "some";
  };
  const selectAllSubs  = () => {
    const s = new Set(
      COPY_SECTIONS.flatMap(section => section.sub)
        .filter(sub => sub.fields.every(field => !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)))
        .map(sub => sub.key),
    );
    sessionStorage.setItem(COPY_TS_SUBKEYS_KEY, JSON.stringify([...s]));
    setSelectedSubKeys(s);
  };
  const selectNoneSubs = () => { sessionStorage.removeItem(COPY_TS_SUBKEYS_KEY); setSelectedSubKeys(new Set()); };

  // ── Copy action ──
  const handleCopy = async () => {
    if (!selectedTiers.size || !selectedSubKeys.size) return;
    setCopying(true);
    setResult(null);

    // Build the partial settings object from selected sub-keys
    const partial: Record<string, unknown> = {};
    for (const section of COPY_SECTIONS) {
      for (const sub of section.sub) {
        if (selectedSubKeys.has(sub.key)) {
          for (const field of sub.fields) {
            if (!TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)) {
              partial[field] = (sourceSettings as unknown as Record<string, unknown>)[field];
            }
          }
        }
      }
    }

    let ok = 0, fail = 0;
    await Promise.all([...selectedTiers].map(async id => {
      try {
        // Fetch current settings for the target tier, merge in the partial, save back
        const getRes = await fetch(
          `/api/trust-score-templates/${encodeURIComponent(id)}/mobile-settings`,
          { credentials: "include" }
        );
        const current: AutomationSettingsData = getRes.ok
          ? { ...AUTOMATION_DEFAULTS, ...(await getRes.json()) }
          : { ...AUTOMATION_DEFAULTS };
        const merged = { ...current, ...partial };
        const postRes = await fetch(
          `/api/trust-score-templates/${encodeURIComponent(id)}/mobile-settings`,
          { method: "POST", headers: { "Content-Type": "application/json" }, credentials: "include", body: JSON.stringify(merged) }
        );
        if (postRes.ok) ok++; else fail++;
      } catch { fail++; }
    }));

    if (fail === 0) {
      setResult("ok");
      setTimeout(() => { onOpenChange(false); }, 500);
    } else {
      setResult(`${fail} tier${fail !== 1 ? "s" : ""} failed`);
      setCopying(false);
      setTimeout(() => { onOpenChange(false); }, 1200);
    }
  };

  return (
    <Dialog open={open} onOpenChange={v => { if (!v && !copying) onOpenChange(v); }}>
      <DialogContent style={{ maxWidth: "52.8rem", maxHeight: "65vh", display: "flex", flexDirection: "column", padding: 0, overflow: "hidden" }}>
        <DialogHeader>
          <DialogTitle>Copy Settings to Other Tiers</DialogTitle>
        </DialogHeader>

        <div className="flex gap-8 mt-2 flex-1 min-h-0">

          {/* LEFT: trust score tier targets */}
          <div className="w-[22rem] shrink-0 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Copy to</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5" onClick={selectAllTiers}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5" onClick={selectNoneTiers}>None</Button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1 space-y-1 pr-1">
              <div className="rounded-md border border-border/50 overflow-hidden">
                {/* Source row (dimmed, non-interactive) */}
                {sourceLevel && (() => {
                  const SrcIcon = sourceLevel.icon;
                  return (
                    <div className="flex items-center gap-2 px-2.5 py-1.5 opacity-40 cursor-default select-none border-b border-border/30">
                      <input type="checkbox" className="w-3.5 h-3.5 accent-primary shrink-0" checked={false} disabled readOnly />
                      <span
                        className="flex items-center gap-1 rounded-full px-2 py-0.5"
                        style={{ background: sourceLevel.bg, border: `1px solid ${sourceLevel.border}` }}
                      >
                        <SrcIcon size={10} color={sourceLevel.text} fill={sourceLevel.text} strokeWidth={2} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: sourceLevel.text, letterSpacing: "0.05em" }}>
                          {sourceLevel.label}
                        </span>
                      </span>
                      <span className="text-[10px] text-muted-foreground">(source)</span>
                    </div>
                  );
                })()}
                {/* Target tier rows */}
                <div className="divide-y divide-border/30">
                  {tierTargets.map(t => {
                    const TIcon = t.icon;
                    const checked = selectedTiers.has(t.id);
                    return (
                      <label
                        key={t.id}
                        className="flex items-center gap-2 px-2.5 py-1.5 cursor-pointer select-none hover:bg-muted/20 transition-colors"
                      >
                        <input
                          type="checkbox"
                          className="w-3.5 h-3.5 accent-primary shrink-0"
                          checked={checked}
                          onChange={e => toggleTier(t.id)}
                        />
                        <span
                          className="flex items-center gap-1 rounded-full px-2 py-0.5"
                          style={{ background: t.bg, border: `1px solid ${t.border}` }}
                        >
                          <TIcon size={10} color={t.text} fill={t.text} strokeWidth={2} />
                          <span style={{ fontSize: 10, fontWeight: 700, color: t.text, letterSpacing: "0.05em" }}>
                            {t.label}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT: settings sections with sub-items */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settings</span>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5" onClick={selectAllSubs}>All</Button>
                <Button size="sm" variant="ghost" className="h-6 text-xs px-1.5" onClick={selectNoneSubs}>None</Button>
              </div>
            </div>
            <div className="overflow-y-auto flex-1 space-y-1 pr-1">
              {COPY_SECTIONS.map(section => {
                const state = sectionState(section);
                const sectionCopyable = section.sub.some(sub =>
                  sub.fields.every(field => !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field)),
                );
                return (
                  <div key={section.key} className="rounded-md border border-border/50 overflow-hidden">
                    <label className={`flex items-center gap-2 px-2.5 py-1.5 bg-muted/40 select-none transition-colors ${
                      sectionCopyable ? "cursor-pointer hover:bg-muted/60" : "cursor-default opacity-50"
                    }`}>
                      <input
                        type="checkbox"
                        className="w-3.5 h-3.5 accent-primary shrink-0"
                        checked={state === "all"}
                        ref={el => { if (el) el.indeterminate = state === "some"; }}
                        onChange={e => toggleSection(section, e.target.checked)}
                        disabled={!sectionCopyable}
                      />
                      <span className={`text-xs font-bold ${
                        sectionCopyable ? "text-foreground" : "text-muted-foreground"
                      }`}>{section.label}</span>
                    </label>
                    {section.sub.length > 1 && (
                      <div className="divide-y divide-border/30">
                        {section.sub.map(sub => {
                          const subCopyable = sub.fields.every(field =>
                            !TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS.has(field),
                          );
                          return (
                          <label key={sub.key} className={`flex items-center gap-2 px-3 pl-6 py-1 select-none transition-colors ${
                            subCopyable ? "cursor-pointer hover:bg-muted/20" : "cursor-default opacity-45"
                          }`}>
                            <input
                              type="checkbox"
                              className="w-3 h-3 accent-primary shrink-0"
                              checked={selectedSubKeys.has(sub.key)}
                              onChange={e => toggleSub(sub.key, e.target.checked)}
                              disabled={!subCopyable}
                            />
                            <span className="text-xs text-muted-foreground">{sub.label}</span>
                          </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

        </div>

        <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-border shrink-0">
          {result && result !== "ok" && (
            <span className="text-xs mr-auto text-destructive">{result}</span>
          )}
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={copying}>Cancel</Button>
          <Button
            onClick={handleCopy}
            disabled={copying || !selectedTiers.size || !selectedSubKeys.size}
            style={result === "ok" ? { background: "#16a34a", borderColor: "#16a34a" } : undefined}
          >
            {result === "ok"
              ? <CheckCircle2 className="w-4 h-4 text-white" />
              : copying ? "Copying…" : "Copy Settings"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function TrustScoreDetailPage() {
  const { trustScoreId } = useParams<{ trustScoreId: string }>();

  const level = getTrustLevels().find(l => l.id === trustScoreId);
  if (!level) {
    return (
      <AppLayout>
        <div className="p-6 text-muted-foreground">Trust score tier not found.</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <TrustScoreAutomationEditor trustScoreId={trustScoreId!} level={level} onBack={() => window.history.back()} />
    </AppLayout>
  );
}

function TrustScoreAutomationEditor({
  trustScoreId,
  level,
  onBack,
}: {
  trustScoreId: string;
  level: TrustLevelEntry;
  onBack: () => void;
}) {
  const [showCopyDialog, setShowCopyDialog] = useState(false);
  const [settings, setSettings] = useState<AutomationSettingsData>(AUTOMATION_DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saveError, setSaveError] = useState<string | null>(null);
  const hydratedRef = useRef(false);
  const lastSavedRef = useRef(JSON.stringify(AUTOMATION_DEFAULTS));

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`/api/trust-score-templates/${encodeURIComponent(trustScoreId)}/mobile-settings`, { credentials: "include" })
      .then(async response => {
        if (!response.ok) throw new Error(`Server error (${response.status})`);
        return response.json();
      })
      .then(data => {
        if (!active) return;
        const merged = { ...AUTOMATION_DEFAULTS, ...data };
        setSettings(merged);
        lastSavedRef.current = JSON.stringify(merged);
        hydratedRef.current = true;
      })
      .catch(error => {
        if (active) setSaveError(error?.message ?? "Couldn't load settings");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [trustScoreId]);

  useEffect(() => {
    if (!hydratedRef.current) return;
    const serialized = JSON.stringify(settings);
    if (serialized === lastSavedRef.current) return;
    const timer = setTimeout(() => {
      fetch(`/api/trust-score-templates/${encodeURIComponent(trustScoreId)}/mobile-settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: serialized,
      })
        .then(async response => {
          const data = await response.json().catch(() => null);
          if (!response.ok || !data?.ok) throw new Error(data?.error ?? `Server error (${response.status})`);
          lastSavedRef.current = serialized;
          setSaveError(null);
        })
        .catch(error => setSaveError(error?.message ?? "Couldn't save settings"));
    }, 500);
    return () => clearTimeout(timer);
  }, [settings, trustScoreId]);

  const phone: UsbPhone = {
    serial: `__trustscore__${trustScoreId}`,
    state: "device",
    model: "Trust Score Template",
    manufacturer: "Aura Farming",
  };

  const LevelIcon = level.icon;
  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-border bg-background">
        <button
          onClick={onBack}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> TrustScores
        </button>
        <div
          className="flex items-center gap-1.5 rounded-full px-3 py-1"
          style={{ background: level.bg, border: `1px solid ${level.border}` }}
        >
          <LevelIcon size={12} color={level.text} fill={level.text} strokeWidth={2} />
          <span style={{ fontSize: 11, fontWeight: 700, color: level.text, letterSpacing: "0.05em" }}>
            {level.label}
          </span>
        </div>
        <div className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 text-xs h-7 px-2.5"
          onClick={() => setShowCopyDialog(true)}
        >
          <Copy className="w-3 h-3" /> Copy Settings
        </Button>
      </div>
      <CopyTrustScoreDialog
        open={showCopyDialog}
        onOpenChange={setShowCopyDialog}
        sourceTrustScoreId={trustScoreId}
        sourceSettings={settings}
      />
      <div className="flex-1 min-h-0 flex">
        <div className="w-1/2 h-full min-h-0 flex items-center justify-center">
          <FakeTrustScoreMirror trustScoreLabel={level.label} />
        </div>
        <div className="w-1/2 h-full min-h-0 border-l border-border">
          <AutomationSettingsPanel
            phone={phone}
            settings={settings}
            setSettings={setSettings}
            setEnabledByUser={(enabled) => setSettings(current => ({ ...current, enabled }))}
            loading={loading}
            saveError={saveError}
            running={false}
            nextRunAt={null}
            templateLockedFields={[...TRUST_SCORE_HST_SLOT_EDITABLE_FIELDS]}
          />
        </div>
      </div>
    </div>
  );
}
