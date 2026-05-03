import { useState, useRef } from "react";
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
}

const FILTER_DEFS = [
  { key: "contrast",   label: "Contrast",        step: 1   },
  { key: "brightness", label: "Brightness",       step: 1   },
  { key: "noise",      label: "Noise",            step: 1   },
  { key: "sharpen",    label: "Sharpen Effect",   step: 0.1 },
  { key: "pixelate",   label: "Pixelate Effect",  step: 0.1 },
] as const;

export function ImageSettingsDialog({ open, onClose, settings, onSave, alterationLevel }: Props) {
  const [local, setLocal] = useState<ImageFilterSettings>(settings);
  const [originalImage, setOriginalImage] = useState<string | null>(null);
  const [previewImage, setPreviewImage]   = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing]   = useState(false);
  const [previewError, setPreviewError]   = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Keep local in sync when dialog re-opens with new settings
  const handleOpenChange = (isOpen: boolean) => {
    if (isOpen) setLocal(settings);
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

  const handleOk = () => { onSave(local); onClose(); };

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
                    type="number" step={step} disabled={!f.enabled}
                    className="w-full h-7 text-xs border border-border rounded px-1.5 bg-background disabled:opacity-30 text-center"
                    value={f.min}
                    onChange={e => setFilter(key, { ...f, min: Number(e.target.value) })}
                  />
                  <input
                    type="number" step={step} disabled={!f.enabled}
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
