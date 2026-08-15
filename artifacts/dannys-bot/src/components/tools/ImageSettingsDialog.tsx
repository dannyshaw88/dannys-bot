import { useState, useRef, useEffect } from "react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { FolderOpen, Loader2, Image as ImageIcon, Settings, AlertCircle } from "lucide-react";

export interface FilterSetting {
  enabled: boolean;
  min: number;
  max: number;
}

export interface ImageFilterSettings {
  contrast:   FilterSetting;
  brightness: FilterSetting;
  noise:      FilterSetting;
  sharpen:    FilterSetting;
  pixelate:   FilterSetting;
}

interface Props {
  open: boolean;
  onClose: () => void;
  settings: ImageFilterSettings;
  onSave: (settings: ImageFilterSettings) => void;
  alterationLevel?: string;
  showPipelineControls?: boolean;
  alterationEnabled?: boolean;
  imageSettingsEnabled?: boolean;
  onPipelineSettingsSave?: (settings: {
    alterationEnabled: boolean;
    alterationLevel: "small" | "medium" | "high";
    imageSettingsEnabled: boolean;
    fixAiSlop: boolean;
    metadataCleanup: boolean;
    frequencyDisruption: boolean;
  }) => void;
  fixAiSlop?: boolean;
  metadataCleanup?: boolean;
  frequencyDisruption?: boolean;
}

const FILTER_DEFS = [
  { key: "contrast",   label: "Contrast",        step: 1   },
  { key: "brightness", label: "Brightness",       step: 1   },
  { key: "noise",      label: "Noise",            step: 1   },
  { key: "sharpen",    label: "Sharpen Effect",   step: 0.1 },
  { key: "pixelate",   label: "Pixelate Effect",  step: 0.1 },
] as const;

export function ImageSettingsDialog({
  open, onClose, settings, onSave, alterationLevel,
  showPipelineControls = false,
  alterationEnabled = true,
  imageSettingsEnabled = true,
  onPipelineSettingsSave,
  fixAiSlop = true,
  metadataCleanup = true,
  frequencyDisruption = false,
}: Props) {
  const [local, setLocal] = useState<ImageFilterSettings>(settings);
  const [localAlterationEnabled, setLocalAlterationEnabled] = useState(alterationEnabled);
  const [localAlterationLevel, setLocalAlterationLevel] = useState<"small" | "medium" | "high">(
    alterationLevel === "medium" || alterationLevel === "high" ? alterationLevel : "small",
  );
  const [localImageSettingsEnabled, setLocalImageSettingsEnabled] = useState(imageSettingsEnabled);
  const [localFixAiSlop, setLocalFixAiSlop] = useState(fixAiSlop);
  const [localMetadataCleanup, setLocalMetadataCleanup] = useState(metadataCleanup);
  const [localFrequencyDisruption, setLocalFrequencyDisruption] = useState(frequencyDisruption);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [previewImage, setPreviewImage]   = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing]   = useState(false);
  const [previewError, setPreviewError]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setLocal(settings);
    setLocalAlterationEnabled(alterationEnabled);
    setLocalAlterationLevel(alterationLevel === "medium" || alterationLevel === "high" ? alterationLevel : "small");
    setLocalImageSettingsEnabled(imageSettingsEnabled);
    setLocalFixAiSlop(fixAiSlop);
    setLocalMetadataCleanup(metadataCleanup);
    setLocalFrequencyDisruption(frequencyDisruption);
  }, [
    open, settings, alterationEnabled, alterationLevel, imageSettingsEnabled,
    fixAiSlop, metadataCleanup, frequencyDisruption,
  ]);

  // Keep local in sync when dialog re-opens with new settings
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) {
      setLocal(settings);
      setLocalAlterationEnabled(alterationEnabled);
      setLocalAlterationLevel(alterationLevel === "medium" || alterationLevel === "high" ? alterationLevel : "small");
      setLocalImageSettingsEnabled(imageSettingsEnabled);
      setLocalFixAiSlop(fixAiSlop);
      setLocalMetadataCleanup(metadataCleanup);
      setLocalFrequencyDisruption(frequencyDisruption);
    }
    else onClose();
  };

  const setFilter = (key: string, val: unknown) =>
    setLocal(prev => ({ ...prev, [key]: val }));

  const handleBrowse = () => fileRef.current?.click();

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setOriginalImage(reader.result as string);
      setPreviewImage(null);
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  };

  const handlePreview = async () => {
    if (!originalImage) return;
    setIsPreviewing(true);
    setPreviewError(null);
    try {
      const res = await fetch("/api/image-alteration-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: originalImage, settings: local, level: alterationLevel ?? "small" }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setPreviewError(data.error ?? `Server error ${res.status}`);
      } else {
        setPreviewImage(data.previewBase64 ?? null);
      }
    } catch (e: any) {
      setPreviewError(e?.message ?? "Network error");
    }
    setIsPreviewing(false);
  };

  const handleOk = () => {
    onSave(local);
    onPipelineSettingsSave?.({
      alterationEnabled: localAlterationEnabled,
      alterationLevel: localAlterationLevel,
      imageSettingsEnabled: localImageSettingsEnabled,
      fixAiSlop: localFixAiSlop,
      metadataCleanup: localMetadataCleanup,
      frequencyDisruption: localFrequencyDisruption,
    });
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-3xl p-0 gap-0 overflow-hidden">
        {/* Title bar */}
        <DialogHeader className="px-4 py-3 border-b border-border bg-muted/30 flex flex-row items-center gap-2 space-y-0">
          <Settings className="w-4 h-4 text-muted-foreground shrink-0" />
          <DialogTitle className="text-sm font-semibold tracking-tight">IMAGE SETTINGS</DialogTitle>
        </DialogHeader>

        <div className="flex gap-0 divide-x divide-border">
          {/* ── Left: filter controls ────────────────────────────── */}
          <div className="w-64 shrink-0 p-4 space-y-2">
            {showPipelineControls && (
              <div className="mb-3 space-y-2 rounded-md border border-border/60 bg-muted/20 p-2.5">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={localAlterationEnabled} onChange={e => setLocalAlterationEnabled(e.target.checked)} className="w-3.5 h-3.5 accent-primary" />
                  <span className="text-xs font-medium">Enable alteration</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">Level</span>
                  {(["small", "medium", "high"] as const).map(level => (
                    <button key={level} type="button" disabled={!localAlterationEnabled} onClick={() => setLocalAlterationLevel(level)}
                      className={`h-6 px-2 text-[10px] rounded border capitalize ${localAlterationLevel === level ? "bg-primary text-primary-foreground border-primary" : "bg-background border-border text-muted-foreground"}`}>
                      {level}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={localImageSettingsEnabled} onChange={e => setLocalImageSettingsEnabled(e.target.checked)} className="w-3.5 h-3.5 accent-primary" />
                  <span className="text-xs font-medium">Enable filter settings</span>
                </div>
                <div className="space-y-1 pt-1 border-t border-border/50">
                  {[
                    ["Fix AI Slop", localFixAiSlop, setLocalFixAiSlop],
                    ["Remove Metadata", localMetadataCleanup, setLocalMetadataCleanup],
                    ["Structural Pixel Disruption", localFrequencyDisruption, setLocalFrequencyDisruption],
                  ].map(([label, checked, setter]) => (
                    <label key={String(label)} className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <input type="checkbox" checked={Boolean(checked)} onChange={e => (setter as (value: boolean) => void)(e.target.checked)} className="w-3.5 h-3.5 accent-primary" />
                      {label}
                    </label>
                  ))}
                </div>
              </div>
            )}
            {/* Column headers */}
            <div className="grid grid-cols-[18px_1fr_52px_52px] gap-x-2 items-center pb-1.5 border-b border-border/50">
              <span />
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Filters</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Min</span>
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide text-center">Max</span>
            </div>

            {FILTER_DEFS.map(({ key, label, step }) => {
              const f = local[key] as FilterSetting;
              return (
                <div key={key} className="grid grid-cols-[18px_1fr_52px_52px] gap-x-2 items-center">
                  <input
                    type="checkbox"
                    checked={f.enabled}
                    onChange={e => setFilter(key, { ...f, enabled: e.target.checked })}
                    className="w-3.5 h-3.5 accent-primary cursor-pointer"
                  />
                  <span className={`text-xs select-none ${f.enabled ? "text-foreground" : "text-muted-foreground/40 line-through"}`}>
                    {label}
                  </span>
                  <input
                    type="number" step={step} disabled={!f.enabled || (showPipelineControls && !localImageSettingsEnabled)}
                    className="w-full h-7 text-xs border border-border rounded px-1.5 bg-background disabled:opacity-30 text-center"
                    value={f.min}
                    onChange={e => setFilter(key, { ...f, min: Number(e.target.value) })}
                  />
                  <input
                    type="number" step={step} disabled={!f.enabled || (showPipelineControls && !localImageSettingsEnabled)}
                    className="w-full h-7 text-xs border border-border rounded px-1.5 bg-background disabled:opacity-30 text-center"
                    value={f.max}
                    onChange={e => setFilter(key, { ...f, max: Number(e.target.value) })}
                  />
                </div>
              );
            })}

          </div>

          {/* ── Right: Original + Preview panels ─────────────────── */}
          <div className="flex flex-1 divide-x divide-border min-w-0">
            {/* Original */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="px-3 py-2 bg-muted/20 border-b border-border">
                <Label className="text-xs font-semibold text-muted-foreground">Original</Label>
              </div>
              <div className="flex-1 flex items-center justify-center p-3 bg-[repeating-conic-gradient(#80808018_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] min-h-[200px]">
                {originalImage
                  ? <img src={originalImage} alt="original" className="max-h-52 max-w-full object-contain shadow" />
                  : <div className="flex flex-col items-center gap-2 text-muted-foreground/40 select-none">
                      <ImageIcon className="w-10 h-10" />
                      <span className="text-xs">Browse for an image</span>
                    </div>
                }
              </div>
            </div>

            {/* Preview */}
            <div className="flex-1 flex flex-col min-w-0">
              <div className="px-3 py-2 bg-muted/20 border-b border-border">
                <Label className="text-xs font-semibold text-muted-foreground">Preview</Label>
              </div>
              <div className="flex-1 flex items-center justify-center p-3 bg-[repeating-conic-gradient(#80808018_0%_25%,transparent_0%_50%)] bg-[length:16px_16px] min-h-[200px]">
                {isPreviewing
                  ? <Loader2 className="w-8 h-8 animate-spin text-muted-foreground/50" />
                  : previewError
                    ? <div className="flex flex-col items-center gap-2 text-destructive/70 select-none px-4 text-center">
                        <AlertCircle className="w-8 h-8 shrink-0" />
                        <span className="text-xs break-all">{previewError}</span>
                      </div>
                    : previewImage
                      ? <img src={previewImage} alt="preview" className="max-h-52 max-w-full object-contain shadow" />
                      : <div className="flex flex-col items-center gap-2 text-muted-foreground/40 select-none">
                          <ImageIcon className="w-10 h-10" />
                          <span className="text-xs">Click "Preview Changes"</span>
                        </div>
                }
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <DialogFooter className="px-4 py-3 border-t border-border bg-muted/20 flex flex-row items-center justify-between gap-2 sm:justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline" size="sm"
              disabled={!originalImage || isPreviewing}
              onClick={handlePreview}
              className="text-xs h-8"
            >
              {isPreviewing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
              Preview Changes
            </Button>
            <Button variant="outline" size="sm" onClick={handleBrowse} className="text-xs h-8">
              <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
              Browse for Image
            </Button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/jpg,image/png,image/webp" className="hidden" onChange={handleFile} />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose} className="text-xs h-8">Cancel</Button>
            <Button size="sm" onClick={handleOk} className="text-xs h-8">OK</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
