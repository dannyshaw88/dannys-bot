import { useParams, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { getTrustLevels, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import { ChevronLeft, Copy, CheckCircle2, Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AUTOMATION_DEFAULTS,
  AutomationSettingsPanel,
  type AutomationSettingsData,
  type UsbPhone,
} from "@/pages/MobilePage";

// ── CopyTrustScoreDialog ──────────────────────────────────────────────────────
// Copies the current tier's mobile settings to one or more other tiers.

const COPY_TS_TARGETS_KEY = "copyTrustScore_targets";

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
  const allLevels = getTrustLevels();
  const targets = allLevels.filter(l => l.id !== sourceTrustScoreId);
  const sourceLevel = allLevels.find(l => l.id === sourceTrustScoreId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<"idle" | "copying" | "done">("idle");

  // Restore last selection from sessionStorage when dialog opens
  useEffect(() => {
    if (!open) return;
    try {
      const raw = sessionStorage.getItem(COPY_TS_TARGETS_KEY);
      if (raw) {
        const ids: string[] = JSON.parse(raw);
        // Only keep IDs that still exist and aren't the source
        setSelected(new Set(ids.filter(id => targets.some(t => t.id === id))));
      } else {
        setSelected(new Set());
      }
    } catch {
      setSelected(new Set());
    }
    setStatus("idle");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const handleCopy = async () => {
    if (!selected.size || status !== "idle") return;
    // Persist selection
    try { sessionStorage.setItem(COPY_TS_TARGETS_KEY, JSON.stringify([...selected])); } catch {}
    setStatus("copying");
    try {
      await Promise.all([...selected].map(id =>
        fetch(`/api/trust-score-templates/${encodeURIComponent(id)}/mobile-settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(sourceSettings),
        }).then(async r => {
          if (!r.ok) throw new Error(`Server error (${r.status}) for tier ${id}`);
        })
      ));
      setStatus("done");
      setTimeout(() => { setStatus("idle"); onOpenChange(false); }, 1200);
    } catch {
      setStatus("idle");
    }
  };

  const allSelected = selected.size === targets.length;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) setStatus("idle"); onOpenChange(v); }}>
      <DialogContent className="max-w-sm p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border">
          <DialogTitle className="flex items-center gap-2 text-sm">
            <Copy className="w-4 h-4 text-primary shrink-0" />
            Copy Settings
            {sourceLevel && (
              <span
                className="flex items-center gap-1 rounded-full px-2 py-0.5 ml-1"
                style={{ background: sourceLevel.bg, border: `1px solid ${sourceLevel.border}` }}
              >
                <sourceLevel.icon size={10} color={sourceLevel.text} fill={sourceLevel.text} strokeWidth={2} />
                <span style={{ fontSize: 10, fontWeight: 700, color: sourceLevel.text, letterSpacing: "0.05em" }}>
                  {sourceLevel.label}
                </span>
              </span>
            )}
            <span className="text-xs font-normal text-muted-foreground ml-0.5">→ other tiers</span>
          </DialogTitle>
        </DialogHeader>

        {/* Target list */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-3">
          <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Copy To</span>
          <button
            className="text-[11px] text-primary hover:underline font-bold uppercase tracking-wide"
            onClick={() => setSelected(new Set(targets.map(t => t.id)))}
          >All</button>
          <button
            className="text-[11px] text-primary hover:underline font-bold uppercase tracking-wide"
            onClick={() => setSelected(new Set())}
          >None</button>
          {selected.size > 0 && (
            <span className="text-[11px] text-primary font-bold">({selected.size} selected)</span>
          )}
        </div>

        <div className="overflow-y-auto divide-y divide-border/40" style={{ maxHeight: 340 }}>
          {targets.map(t => {
            const Icon = t.icon;
            const checked = selected.has(t.id);
            return (
              <label
                key={t.id}
                className="flex items-center gap-3 px-4 py-2.5 cursor-pointer hover:bg-muted/30 transition-colors select-none"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(t.id)}
                  className="shrink-0 w-4 h-4"
                />
                <span
                  className="flex items-center gap-1 rounded-full px-2 py-0.5"
                  style={{ background: t.bg, border: `1px solid ${t.border}` }}
                >
                  <Icon size={10} color={t.text} fill={t.text} strokeWidth={2} />
                  <span style={{ fontSize: 10, fontWeight: 700, color: t.text, letterSpacing: "0.05em" }}>
                    {t.label}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        <DialogFooter className="px-5 py-3 border-t border-border flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={status === "copying"}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleCopy}
            disabled={!selected.size || status !== "idle"}
            className="gap-1.5"
          >
            {status === "copying" ? (
              <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Copying…</>
            ) : status === "done" ? (
              <><CheckCircle2 className="w-3.5 h-3.5" /> Done</>
            ) : (
              <><Copy className="w-3.5 h-3.5" /> Copy to {selected.size || ""} tier{selected.size !== 1 ? "s" : ""}</>
            )}
          </Button>
        </DialogFooter>
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
      <div className="flex-1 min-h-0 overflow-y-auto">
        <AutomationSettingsPanel
          phone={phone}
          settings={settings}
          setSettings={setSettings}
          setEnabledByUser={(enabled) => setSettings(current => ({ ...current, enabled }))}
          loading={loading}
          saveError={saveError}
          running={false}
          nextRunAt={null}
        />
      </div>
    </div>
  );
}
