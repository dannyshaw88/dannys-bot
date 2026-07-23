import { useParams, useLocation } from "wouter";
import { useEffect, useRef, useState } from "react";
import { getTrustLevels, type TrustLevelEntry } from "@/components/TrustScoreBadge";
import { ChevronLeft } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import {
  AUTOMATION_DEFAULTS,
  AutomationSettingsPanel,
  type AutomationSettingsData,
  type UsbPhone,
} from "@/pages/MobilePage";

export function TrustScoreDetailPage() {
  const { trustScoreId } = useParams<{ trustScoreId: string }>();
  const [, navigate] = useLocation();

  const level = getTrustLevels().find(l => l.id === trustScoreId);
  if (!level) {
    return (
      <AppLayout>
        <div className="p-6 text-muted-foreground">Trust score tier not found.</div>
      </AppLayout>
    );
  }

  const Icon = level.icon;

  return (
    <AppLayout>
      <TrustScoreAutomationEditor trustScoreId={trustScoreId!} level={level} onBack={() => navigate("/trust-scores")} />
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
      </div>
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
