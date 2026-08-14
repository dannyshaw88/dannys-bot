import React, { useState, useRef, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ImageSettingsDialog, type ImageFilterSettings } from "@/components/tools/ImageSettingsDialog";
import { 
  Image as ImageIcon, ImagePlus, Plus, Download, X, Play, 
  Settings2, Wand2, Shuffle, SlidersHorizontal, Loader2, CheckCircle2, AlertCircle, FileImage
} from "lucide-react";

const DEFAULT_IMAGE_SETTINGS: ImageFilterSettings = {
  contrast:  { enabled: true, min: 5,   max: 250 },
  brightness:{ enabled: true, min: 5,   max: 250 },
  noise:     { enabled: true, min: 5,   max: 15  },
  sharpen:   { enabled: true, min: 1.0, max: 2.0 },
  pixelate:  { enabled: true, min: 0.9, max: 2.1 },
};

const IMAGES_PAGE_STORAGE_KEY = "dannys-bot.fix-images.workspace.v1";
type PersistedImagesWorkspace = {
  items?: Array<Partial<MediaItem>>;
  fixAiSlop?: boolean;
  alterationEnabled?: boolean;
  alterationLevel?: "small" | "medium" | "high";
  imageSettingsEnabled?: boolean;
  imageSettings?: ImageFilterSettings;
  metadataCleanup?: boolean;
  frequencyDisruption?: boolean;
  waveSpeed?: boolean;
  wavePrompt?: string;
  waveStrength?: number;
  waveSeed?: number;
  waveOutputFormat?: "jpeg" | "png" | "webp";
  waveWidth?: string;
  waveHeight?: string;
};

function readPersistedWorkspace(): PersistedImagesWorkspace {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(window.sessionStorage.getItem(IMAGES_PAGE_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the selected image"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(file);
  });
}

export interface MediaItem {
  id: string;
  file?: File;
  sourcePath?: string;
  sourceDataUrl?: string;
  name: string;
  size: number;
  previewUrl: string;
  status: "idle" | "processing" | "success" | "error";
  progress: number;
  error?: string;
  processedPreviewUrl?: string;
  processedData?: Blob | string;
  processingLog?: string[];
}

export interface ImagesPageProps {
  embedded?: boolean;
  mediaItems?: MediaItem[];
  isProcessing?: boolean;
  onAddFiles?: (files: File[]) => void;
  onRemoveItem?: (id: string) => void;
  onClearAll?: () => void;
  onStartProcessing?: () => void;
  onCancelProcessing?: () => void;
  onExportAll?: () => void;

  fixAiSlop?: boolean;
  onFixAiSlopChange?: (val: boolean) => void;

  alterationEnabled?: boolean;
  onAlterationEnabledChange?: (val: boolean) => void;

  alterationLevel?: "small" | "medium" | "high";
  onAlterationLevelChange?: (val: "small" | "medium" | "high") => void;

  imageSettingsEnabled?: boolean;
  onImageSettingsEnabledChange?: (val: boolean) => void;

  imageSettings?: ImageFilterSettings;
  onImageSettingsChange?: (val: ImageFilterSettings) => void;
}

export default function ImagesPage(props: ImagesPageProps) {
  const persisted = readPersistedWorkspace();
  const [localItems, setLocalItems] = useState<MediaItem[]>(() => (persisted.items ?? []).map(item => ({
    ...(item as MediaItem),
    status: item.status === "success" ? "success" : "idle",
    progress: item.status === "success" ? 100 : 0,
  })));
  const [localIsProcessing, setLocalIsProcessing] = useState(false);
  const [localFixAiSlop, setLocalFixAiSlop] = useState(persisted.fixAiSlop ?? true);
  const [localAltEnabled, setLocalAltEnabled] = useState(persisted.alterationEnabled ?? true);
  const [localAltLevel, setLocalAltLevel] = useState<"small" | "medium" | "high">(persisted.alterationLevel ?? "small");
  const [localImgSettingsEnabled, setLocalImgSettingsEnabled] = useState(persisted.imageSettingsEnabled ?? true);
  const [localImgSettings, setLocalImgSettings] = useState<ImageFilterSettings>(persisted.imageSettings ?? DEFAULT_IMAGE_SETTINGS);
  const [localMetadataCleanup, setLocalMetadataCleanup] = useState(persisted.metadataCleanup ?? true);
  const [localFrequencyDisruption, setLocalFrequencyDisruption] = useState(persisted.frequencyDisruption ?? true);
  const [localWaveSpeed, setLocalWaveSpeed] = useState(persisted.waveSpeed ?? false);
  const [wavePrompt, setWavePrompt] = useState(persisted.wavePrompt ?? "");
  const [waveStrength, setWaveStrength] = useState(persisted.waveStrength === 0.1 ? 0.2 : (persisted.waveStrength ?? 0.2));
  const [waveSeed, setWaveSeed] = useState(persisted.waveSeed ?? -1);
  const [waveOutputFormat, setWaveOutputFormat] = useState<"jpeg" | "png" | "webp">(persisted.waveOutputFormat ?? "jpeg");
  const [waveWidth, setWaveWidth] = useState(persisted.waveWidth ?? "");
  const [waveHeight, setWaveHeight] = useState(persisted.waveHeight ?? "");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Determine actual values (props vs local state)
  const items = props.mediaItems ?? localItems;
  const isProcessing = props.isProcessing ?? localIsProcessing;
  const fixAiSlop = props.fixAiSlop ?? localFixAiSlop;
  const setFixAiSlop = props.onFixAiSlopChange ?? setLocalFixAiSlop;
  const alterationEnabled = props.alterationEnabled ?? localAltEnabled;
  const setAlterationEnabled = props.onAlterationEnabledChange ?? setLocalAltEnabled;
  const alterationLevel = props.alterationLevel ?? localAltLevel;
  const setAlterationLevel = props.onAlterationLevelChange ?? setLocalAltLevel;
  const imageSettingsEnabled = props.imageSettingsEnabled ?? localImgSettingsEnabled;
  const setImageSettingsEnabled = props.onImageSettingsEnabledChange ?? setLocalImgSettingsEnabled;
  const imageSettings = props.imageSettings ?? localImgSettings;
  const setImageSettings = props.onImageSettingsChange ?? setLocalImgSettings;
  const PageShell = props.embedded ? React.Fragment : AppLayout;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const processingRef = useRef<boolean>(false);

  useEffect(() => {
    if (props.mediaItems || props.fixAiSlop !== undefined) return;
    const workspace: PersistedImagesWorkspace = {
      items: localItems.map(({ file: _file, ...item }) => item),
      fixAiSlop: localFixAiSlop,
      alterationEnabled: localAltEnabled,
      alterationLevel: localAltLevel,
      imageSettingsEnabled: localImgSettingsEnabled,
      imageSettings: localImgSettings,
      metadataCleanup: localMetadataCleanup,
      frequencyDisruption: localFrequencyDisruption,
      waveSpeed: localWaveSpeed,
      wavePrompt,
      waveStrength,
      waveSeed,
      waveOutputFormat,
      waveWidth,
      waveHeight,
    };
    try {
      window.sessionStorage.setItem(IMAGES_PAGE_STORAGE_KEY, JSON.stringify(workspace));
    } catch {
      // A large batch may exceed session storage; the current mounted workspace remains usable.
    }
  }, [
    props.mediaItems,
    props.fixAiSlop,
    localItems,
    localFixAiSlop,
    localAltEnabled,
    localAltLevel,
    localImgSettingsEnabled,
    localImgSettings,
    localMetadataCleanup,
    localFrequencyDisruption,
    localWaveSpeed,
    wavePrompt,
    waveStrength,
    waveSeed,
    waveOutputFormat,
    waveWidth,
    waveHeight,
  ]);

  const handleAddFiles = useCallback(async (files: File[]) => {
    if (props.onAddFiles) {
      props.onAddFiles(files);
      return;
    }
    const validFiles = files.filter(file => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name));
    const newItems = await Promise.all(validFiles.map(async f => {
      const dataUrl = await fileToDataUrl(f);
      return {
        id: Math.random().toString(36).substring(2, 9),
        file: f,
        sourceDataUrl: dataUrl,
        name: f.name,
        size: f.size,
        previewUrl: dataUrl,
        status: "idle" as const,
        progress: 0,
      };
    }));
    setLocalItems(prev => [...prev, ...newItems]);
    setNotice(newItems.length ? `${newItems.length} image${newItems.length === 1 ? "" : "s"} imported` : "No supported image files were selected");
  }, [props]);

  const handleNativeFiles = useCallback((files: Array<{ fileName: string; dataUrl: string; filePath?: string }>) => {
    const newItems: MediaItem[] = files.map(file => ({
      id: `${file.fileName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: file.fileName,
      size: Math.max(0, Math.floor((file.dataUrl.length * 3) / 4)),
      previewUrl: file.dataUrl,
      sourcePath: file.filePath,
      sourceDataUrl: file.dataUrl,
      status: "idle",
      progress: 0,
    }));
    setLocalItems(prev => [...prev, ...newItems]);
    setNotice(newItems.length ? `${newItems.length} image${newItems.length === 1 ? "" : "s"} imported` : "No files selected");
  }, []);

  const browseForFiles = useCallback(async () => {
    setNotice(null);
    const electronApi = (window as any).electronAPI;
    if (electronApi?.openMediaFileDialog) {
      const result = await electronApi.openMediaFileDialog().catch((error: any) => ({ error: error?.message ?? "File picker failed" }));
      if (result?.error) {
        setNotice(result.error);
      } else if (!result?.canceled && Array.isArray(result?.files)) {
        handleNativeFiles(result.files);
      }
      return;
    }
    fileInputRef.current?.click();
  }, [handleNativeFiles]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length > 0) handleAddFiles(files);
    e.target.value = ""; 
  };

  const handleRemoveItem = useCallback((id: string) => {
    if (props.onRemoveItem) return props.onRemoveItem(id);
    setLocalItems(prev => {
      const item = prev.find(i => i.id === id);
      if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
      if (item?.processedPreviewUrl) URL.revokeObjectURL(item.processedPreviewUrl);
      return prev.filter(i => i.id !== id);
    });
  }, [props]);

  const handleClearAll = useCallback(() => {
    if (props.onClearAll) return props.onClearAll();
    localItems.forEach(i => {
      if (i.previewUrl) URL.revokeObjectURL(i.previewUrl);
      if (i.processedPreviewUrl) URL.revokeObjectURL(i.processedPreviewUrl);
    });
    setLocalItems([]);
    try {
      window.sessionStorage.removeItem(IMAGES_PAGE_STORAGE_KEY);
    } catch {}
  }, [props, localItems]);

  const readFileDataUrl = async (item: MediaItem): Promise<string> => {
    if (item.sourceDataUrl) return item.sourceDataUrl;
    if (!item.file) throw new Error("The source file is no longer available");
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Could not read the selected image"));
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(item.file!);
    });
  };

  const handleStartProcessing = useCallback((onlyItemId?: string) => {
    if (props.onStartProcessing) return props.onStartProcessing();

    setLocalIsProcessing(true);
    processingRef.current = true;

    void (async () => {
      // A completed item can be processed again so restoration settings can be tuned.
      const pendingItems = localItems.filter(item => item.status !== "success");
      const queue = onlyItemId
        ? localItems.filter(item => item.id === onlyItemId)
        : (pendingItems.length ? pendingItems : localItems);
      for (const item of queue) {
        if (!processingRef.current) break;
        setLocalItems(prev => prev.map(current => current.id === item.id
          ? { ...current, status: "processing", progress: 8, error: undefined }
          : current));
        try {
           let imageBase64 = await readFileDataUrl(item);
           let processFilename = item.name;
           if (localWaveSpeed) {
             let waveProgress = 8;
             const waveProgressTimer = window.setInterval(() => {
               waveProgress = Math.min(88, waveProgress + 2 + Math.random() * 3);
               setLocalItems(prev => prev.map(current => current.id === item.id
                 ? { ...current, progress: waveProgress }
                 : current));
             }, 850);
             let waveResponse: Response;
             try {
               waveResponse = await fetch("/api/wavespeed/process", {
                 method: "POST",
                 headers: { "Content-Type": "application/json" },
                 body: JSON.stringify({
                   imageBase64,
                   filename: item.name,
                   prompt: wavePrompt,
                   strength: waveStrength,
                   seed: waveSeed,
                   outputFormat: waveOutputFormat,
                   ...(waveWidth ? { width: Number(waveWidth) } : {}),
                   ...(waveHeight ? { height: Number(waveHeight) } : {}),
                 }),
               });
             } finally {
               window.clearInterval(waveProgressTimer);
             }
              const waveResult = await waveResponse.json().catch(() => null);
             if (!waveResponse.ok || !waveResult?.ok || typeof waveResult.dataUrl !== "string") {
                throw new Error(waveResult?.error ?? waveResult?.message ?? `WaveSpeed failed (${waveResponse.status})`);
             }
             imageBase64 = waveResult.dataUrl;
             processFilename = waveResult.filename ?? `${item.name.replace(/\.[^.]+$/, "")}_wavespeed.jpg`;
             setLocalItems(prev => prev.map(current => current.id === item.id
               ? { ...current, name: processFilename, progress: 20, processingLog: [`WaveSpeed Z-Image Turbo completed — cost $${Number(waveResult.cost ?? 0.005).toFixed(3)}`] }
               : current));
           }
          if (!processingRef.current) break;
          setLocalItems(prev => prev.map(current => current.id === item.id
            ? { ...current, progress: 28 }
            : current));
           const response = await fetch("/api/images/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
               ...(localWaveSpeed
                 ? { imageBase64 }
                 : item.sourcePath
                   ? { localPath: item.sourcePath }
                   : { imageBase64 }),
               filename: processFilename,
              fixAiSlop,
              alterationEnabled,
              alterationLevel,
              imageSettingsEnabled,
              imageSettings,
               metadataCleanup: localMetadataCleanup,
               frequencyDisruption: localFrequencyDisruption,
            }),
          });
          const result = await response.json().catch(() => null);
          if (!response.ok || !result?.ok || typeof result.dataUrl !== "string") {
            throw new Error(result?.error ?? `Processing failed (${response.status})`);
          }
          setLocalItems(prev => prev.map(current => current.id === item.id
            ? {
              ...current,
              name: result.filename ?? current.name,
              size: result.size ?? current.size,
              status: "success",
              progress: 100,
              processedPreviewUrl: result.dataUrl,
              processedData: result.dataUrl,
                processingLog: Array.isArray(result.processingLog) ? result.processingLog : [],
            }
            : current));
        } catch (error: any) {
          setLocalItems(prev => prev.map(current => current.id === item.id
            ? {
                ...current,
                status: "error",
                progress: 0,
                error: error?.message ?? "Processing failed",
                processingLog: [error?.message ?? "Processing failed"],
              }
            : current));
        }
      }
      processingRef.current = false;
      setLocalIsProcessing(false);
    })();
  }, [
    alterationEnabled,
    alterationLevel,
    fixAiSlop,
    imageSettings,
    imageSettingsEnabled,
    localFrequencyDisruption,
    localItems,
    localMetadataCleanup,
    localWaveSpeed,
    waveOutputFormat,
    wavePrompt,
    waveSeed,
    waveStrength,
    waveWidth,
    waveHeight,
    props,
    readFileDataUrl,
  ]);

  const handleCancelProcessing = useCallback(() => {
    if (props.onCancelProcessing) return props.onCancelProcessing();
    processingRef.current = false;
    setLocalIsProcessing(false);
    setLocalItems(prev => prev.map(i => i.status === 'processing' ? { ...i, status: 'idle', progress: 0 } : i));
  }, [props]);

  const handleExportAll = useCallback(() => {
    if (props.onExportAll) return props.onExportAll();
    const ready = localItems
      .filter(item => item.status === "success" && typeof item.processedData === "string")
      .map(item => ({ filename: item.name, dataUrl: String(item.processedData) }));
    if (!ready.length) return;
    const electronApi = (window as any).electronAPI;
    if (electronApi?.saveProcessedImages) {
      void electronApi.saveProcessedImages(ready).then((result: any) => {
        if (!result?.canceled) setNotice(`${result?.count ?? ready.length} processed image${ready.length === 1 ? "" : "s"} saved`);
      }).catch((error: any) => setNotice(error?.message ?? "Could not save processed images"));
      return;
    }
    ready.forEach(file => {
      const link = document.createElement("a");
      link.href = file.dataUrl;
      link.download = file.filename;
      link.click();
    });
    setNotice(`${ready.length} processed image${ready.length === 1 ? "" : "s"} downloaded`);
  }, [localItems, props]);

  return (
    <PageShell>
      <style>{`
        @keyframes image-processing-scan-down {
          0% { top: -2px; opacity: 0; }
          12% { opacity: 1; }
          48% { opacity: 0.95; }
          82% { opacity: 0.65; }
          100% { top: calc(100% - 1px); opacity: 0; }
        }
        @keyframes image-processing-pixels {
          0%, 100% { opacity: 0.25; background-position: 0 0, 14px 8px, 32px 2px, 51px 13px; }
          35% { opacity: 0.9; background-position: 5px 3px, 10px 12px, 36px 8px, 47px 9px; }
          70% { opacity: 0.45; background-position: 1px 10px, 18px 4px, 28px 12px, 55px 5px; }
        }
        tr.image-processing-scan {
          width: 100%;
          max-width: 100%;
          height: 112px;
          min-height: 112px;
        }
        tbody > tr {
          height: 112px;
        }
        tbody > tr > td {
          height: 112px;
          max-height: 112px;
          overflow: hidden;
          vertical-align: middle;
        }
        tr.image-processing-scan > td {
          position: relative;
          overflow: hidden;
        }
        tr.image-processing-scan > td::before,
        tr.image-processing-scan > td::after {
          content: "";
          position: absolute;
          pointer-events: none;
          inset: 0;
          z-index: 2;
        }
        tr.image-processing-scan > td::before {
          background-image:
            radial-gradient(circle, rgba(255,255,255,0.95) 0 1px, transparent 1.8px),
            radial-gradient(circle, rgba(103,232,249,0.9) 0 1.2px, transparent 2px),
            radial-gradient(circle, rgba(165,243,252,0.95) 0 1px, transparent 1.8px),
            radial-gradient(circle, rgba(255,255,255,0.8) 0 0.8px, transparent 1.6px);
          background-size: 47px 41px, 61px 53px, 73px 59px, 89px 67px;
          animation-name: image-processing-pixels;
          animation-duration: var(--pixel-duration, 0.65s);
          animation-timing-function: steps(5, end);
          animation-delay: var(--pixel-delay, 0s);
          animation-iteration-count: infinite;
        }
        tr.image-processing-scan > td::after {
          inset: 0 0 auto;
          height: 2px;
          background: linear-gradient(90deg, transparent, rgba(103,232,249,0.95) 20%, #fff 50%, rgba(103,232,249,0.95) 80%, transparent);
          box-shadow: 0 0 3px rgba(34,211,238,0.8);
          animation: image-processing-scan-down var(--scan-duration, 2.4s) linear infinite;
        }
        .fix-images-table {
          width: 100%;
          table-layout: fixed;
        }
        .fix-images-scroll {
          max-height: 200px;
          height: auto;
          overflow-y: auto;
          overflow-x: hidden;
        }
      `}</style>
      <div className="p-4 lg:p-6 h-[calc(100vh-3.5rem)] min-h-[600px]">
        <Card className="flex flex-col lg:flex-row h-full overflow-hidden border-border/60 shadow-sm bg-background">
          
          {/* Sidebar Settings */}
          <div className="w-full lg:w-80 shrink-0 border-b lg:border-b-0 bg-muted/10 flex flex-col z-10">
            <div className="p-5 border-b border-border/60 bg-background/50">
              <h1 className="text-base font-semibold tracking-tight flex items-center gap-2 text-foreground">
                <FileImage className="w-4 h-4 text-cyan-500" />
                Media Preparation
              </h1>
            </div>
            
            <div className="flex-1 overflow-y-auto p-5 space-y-8">
              <div className="space-y-4">
                <h2 className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
                  <Settings2 className="w-3.5 h-3.5" />
                  Pipeline Actions
                </h2>
                
                <div className="space-y-6">
                  <div className="space-y-3 border-b border-border/50 pb-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 mt-0.5">
                        <Label className="text-sm font-medium text-foreground cursor-pointer select-none" onClick={() => setLocalWaveSpeed(!localWaveSpeed)}>
                          Use WaveSpeed Z-Image Turbo
                        </Label>
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          Generate each image first, then continue the local preparation pipeline.
                        </p>
                      </div>
                      <Switch checked={localWaveSpeed} onCheckedChange={setLocalWaveSpeed} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                    </div>
                    {localWaveSpeed && (
                      <div className="space-y-3 rounded-md border border-border/60 bg-background/60 p-3">
                        <label className="block text-[11px] text-muted-foreground">
                          Prompt (required)
                          <Input value={wavePrompt} onChange={(e) => setWavePrompt(e.target.value)} className="mt-1 h-8 text-xs" aria-required="true" />
                        </label>
                        <label className="block text-[11px] text-muted-foreground">
                          Strength: {waveStrength.toFixed(2)}
                          <input type="range" min="0" max="1" step="0.01" value={waveStrength} onChange={(e) => setWaveStrength(Number(e.target.value))} className="w-full accent-cyan-500" />
                        </label>
                        <label className="block text-[11px] text-muted-foreground">
                          Seed
                          <Input type="number" value={waveSeed} onChange={(e) => setWaveSeed(Number(e.target.value))} className="mt-1 h-8 text-xs" />
                        </label>
                        <label className="block text-[11px] text-muted-foreground">
                          Output format
                          <select value={waveOutputFormat} onChange={(e) => setWaveOutputFormat(e.target.value as typeof waveOutputFormat)} className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs">
                            <option value="jpeg">JPEG</option>
                            <option value="png">PNG</option>
                            <option value="webp">WebP</option>
                          </select>
                        </label>
                        <div className="grid grid-cols-2 gap-2">
                          <label className="block text-[11px] text-muted-foreground">
                            Width
                            <Input type="number" min="256" max="2048" placeholder="Source" value={waveWidth} onChange={(e) => setWaveWidth(e.target.value)} className="mt-1 h-8 text-xs" />
                          </label>
                          <label className="block text-[11px] text-muted-foreground">
                            Height
                            <Input type="number" min="256" max="2048" placeholder="Source" value={waveHeight} onChange={(e) => setWaveHeight(e.target.value)} className="mt-1 h-8 text-xs" />
                          </label>
                        </div>
                        <p className="text-[10px] leading-4 text-muted-foreground">
                          Model: Z-Image Turbo · estimated cost $0.005/image
                        </p>
                      </div>
                    )}
                  </div>

                  {/* Fix AI Slop */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 mt-0.5">
                      <Label className="text-sm font-medium text-foreground flex items-center gap-1.5 cursor-pointer select-none" onClick={() => setFixAiSlop(!fixAiSlop)}>
                        <Wand2 className="w-3.5 h-3.5 text-cyan-500" />
                        Fix AI Slop
                      </Label>
                    </div>
                    <Switch checked={fixAiSlop} onCheckedChange={setFixAiSlop} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                  </div>
                  
                  {/* Image Alteration */}
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 mt-0.5">
                        <Label className="text-sm font-medium text-foreground flex items-center gap-1.5 cursor-pointer select-none" onClick={() => setAlterationEnabled(!alterationEnabled)}>
                          <Shuffle className="w-3.5 h-3.5 text-cyan-500" />
                          Image Alteration
                        </Label>
                      </div>
                      <Switch checked={alterationEnabled} onCheckedChange={setAlterationEnabled} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                    </div>
                    
                    {alterationEnabled && (
                      <div className="pt-1 text-left animate-in fade-in slide-in-from-top-1 duration-200">
                        <Select value={alterationLevel} onValueChange={(val) => setAlterationLevel(val as "small" | "medium" | "high")}>
                          <SelectTrigger className="relative h-8 text-xs bg-background shadow-xs [&>span]:absolute [&>span]:inset-x-0 [&>span]:text-center [&>span]:pointer-events-none [&>svg]:relative [&>svg]:z-10 [&>svg]:ml-auto">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="small">Small (Invisible changes)</SelectItem>
                            <SelectItem value="medium">Medium (Slight blur/crop)</SelectItem>
                            <SelectItem value="high">High (Noticeable changes)</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                    )}
                  </div>
                  
                  {/* Image Filters */}
                  <div className="space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="space-y-1 mt-0.5">
                        <Label className="text-sm font-medium text-foreground flex items-center gap-1.5 cursor-pointer select-none" onClick={() => setImageSettingsEnabled(!imageSettingsEnabled)}>
                          <SlidersHorizontal className="w-3.5 h-3.5 text-cyan-500" />
                          Image Filters
                        </Label>
                      </div>
                      <Switch checked={imageSettingsEnabled} onCheckedChange={setImageSettingsEnabled} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                    </div>
                    
                    {imageSettingsEnabled && (
                      <div className="pt-1 text-left animate-in fade-in slide-in-from-top-1 duration-200">
                         <Button variant="outline" size="sm" className="w-full h-8 text-xs bg-background shadow-xs" onClick={() => setDialogOpen(true)}>
                           Configure Filters
                         </Button>
                      </div>
                    )}
                  </div>

                  {/* Metadata cleanup */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 mt-0.5">
                      <Label className="text-sm font-medium text-foreground cursor-pointer select-none" onClick={() => setLocalMetadataCleanup(!localMetadataCleanup)}>
                        Remove metadata
                      </Label>
                    </div>
                    <Switch checked={localMetadataCleanup} onCheckedChange={setLocalMetadataCleanup} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                  </div>

                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-1 mt-0.5">
                      <Label className="text-sm font-medium text-foreground cursor-pointer select-none" onClick={() => setLocalFrequencyDisruption(!localFrequencyDisruption)}>
                        Structured pixel disruption
                      </Label>
                    </div>
                    <Switch checked={localFrequencyDisruption} onCheckedChange={setLocalFrequencyDisruption} className="data-[state=checked]:bg-cyan-500 shrink-0" />
                  </div>

                </div>
              </div>
            </div>
          </div>
          
          {/* Main Content Area */}
          <div className="flex-1 flex flex-col min-w-0 bg-muted/5 relative">
            {/* Action Toolbar */}
            <div className="h-14 border-b border-border/60 bg-background/50 flex items-center justify-between px-4 sm:px-5 shrink-0 z-10 backdrop-blur-sm">
              <div className="flex items-center gap-2 sm:gap-3">
                <Button 
                  variant="default" 
                  size="sm" 
                  className="bg-[#1AD2F2] hover:bg-[#14bddb] text-slate-950 shadow-sm border-0"
                   onClick={browseForFiles}
                  disabled={isProcessing}
                >
                  <Plus className="w-4 h-4 mr-1.5" />
                  Add Files
                </Button>
                <input type="file" multiple accept="image/*" className="hidden" ref={fileInputRef} onChange={handleFileChange} />
                
               {items.length > 0 && !isProcessing && (
                  <>
                    <Button variant="ghost" size="sm" onClick={handleClearAll} className="text-muted-foreground hover:text-foreground h-8 px-3">
                      Clear All
                    </Button>
                  </>
                )}
              </div>
              
              <div className="flex items-center gap-2 sm:gap-3">
                {items.some(i => i.status === 'success') && !isProcessing && (
                  <Button variant="outline" size="sm" onClick={handleExportAll} className="shadow-xs h-8">
                    <Download className="w-3.5 h-3.5 mr-1.5 text-cyan-600" />
                    Export Ready
                  </Button>
                )}
                
                {isProcessing ? (
                  <Button variant="destructive" size="sm" onClick={handleCancelProcessing} className="shadow-xs h-8">
                    <X className="w-3.5 h-3.5 mr-1.5" />
                    Stop Processing
                  </Button>
                ) : (
                  <Button 
                    type="button"
                    variant="secondary" 
                    size="sm" 
                    disabled={items.length === 0}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setNotice("Pipeline started");
                      handleStartProcessing();
                    }}
                    className="shadow-xs h-8 bg-cyan-500 text-slate-950 hover:bg-cyan-400 border-0"
                  >
                    <Play className="w-3.5 h-3.5 mr-1.5 fill-current" />
                    Run Pipeline
                  </Button>
                )}
              </div>
            </div>

            {/* List Area */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-5">
              {items.length === 0 ? (
                 <div className="h-full flex items-center justify-center min-h-[300px]">
                   <div className="flex flex-col items-center max-w-[320px] text-center animate-in fade-in zoom-in-95 duration-300">
                     <div className="w-16 h-16 rounded-2xl bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center mb-5 shadow-sm">
                       <ImagePlus className="w-7 h-7 text-cyan-600" />
                     </div>
                     <h3 className="text-base font-semibold tracking-tight text-foreground mb-2">Workspace Empty</h3>
                     <Button 
                       variant="outline" 
                        onClick={browseForFiles}
                       className="shadow-xs bg-background"
                     >
                       Browse for Files
                     </Button>
                   </div>
                 </div>
              ) : (
                  <div className="relative rounded-xl border border-border/60 bg-background shadow-xs overflow-hidden animate-in fade-in duration-300">
                    <div className="fix-images-scroll overflow-x-auto">
                     <table className="fix-images-table text-sm text-left border-collapse">
                       <thead className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/40 border-b border-border/60">
                         <tr>
                           <th className="px-4 py-3 w-24 text-center">Original</th>
                           <th className="px-4 py-3 w-24 text-center">Processed</th>
                           <th className="px-4 py-3">Full Name</th>
                           <th className="px-4 py-3 w-28">Size</th>
                           <th className="px-4 py-3 w-56">Status</th>
                           <th className="px-4 py-3 w-12 text-right"></th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-border/40">
                         {items.map(item => (
                             <tr
                               key={item.id}
                               className={`hover:bg-muted/30 transition-colors group ${item.status === "processing" ? "image-processing-scan" : ""}`}
                               style={item.status === "processing" ? {
                                 "--scan-duration": `${1.05 + ((item.id.charCodeAt(0) + item.id.charCodeAt(item.id.length - 1)) % 11) * 0.19}s`,
                                 "--pixel-delay": `-${((item.id.charCodeAt(1) || 0) % 17) * 0.11}s`,
                                 "--pixel-duration": `${0.42 + ((item.id.charCodeAt(2) || 0) % 9) * 0.09}s`
                               } as React.CSSProperties : undefined}
                             >
                              <td className="px-4 py-3">
                                <div className="w-20 h-20 rounded border border-border/60 bg-muted/30 overflow-hidden mx-auto shadow-xs">
                                 <img src={item.previewUrl} className="w-full h-full object-cover" alt="" />
                               </div>
                             </td>
                             <td className="px-4 py-3">
                                <div className="w-20 h-20 rounded border border-border/60 bg-muted/10 overflow-hidden mx-auto flex items-center justify-center shadow-xs">
                                 {item.processedPreviewUrl ? (
                                   <img src={item.processedPreviewUrl} className="w-full h-full object-cover" alt="" />
                                 ) : (
                                   <ImageIcon className="w-4 h-4 text-muted-foreground/30" />
                                 )}
                               </div>
                             </td>
                             <td className="px-4 py-3 min-w-0">
                                <div className="font-medium text-foreground truncate max-w-full" title={item.name}>
                                 {item.name}
                               </div>
                                {item.processingLog?.length ? (
                                  <div className="mt-1.5 max-w-[520px] h-[52px] max-h-[52px] rounded border border-border/60 bg-muted/30 p-1.5 font-mono text-[9px] leading-4 text-muted-foreground overflow-y-auto">
                                    <div className="mb-0.5 font-sans text-[10px] font-semibold text-cyan-600 dark:text-cyan-400">
                                      Processing log
                                    </div>
                                    {item.processingLog.map((line, index) => (
                                      <div key={`${item.id}-log-${index}`}>{line}</div>
                                    ))}
                                  </div>
                                ) : null}
                             </td>
                              <td className="px-4 py-3 text-[11px] text-muted-foreground font-mono whitespace-nowrap">
                                {(item.size / 1024 / 1024).toFixed(2)} MB
                              </td>
                             <td className="px-4 py-3">
                                <div className="flex flex-col justify-center min-h-20">
                                 {item.status === 'idle' && (
                                   <span className="text-[11px] text-muted-foreground font-medium">Ready</span>
                                 )}
                                 {item.status === 'processing' && (
                                   <div className="flex flex-col gap-1.5 w-full max-w-[140px]">
                                     <div className="flex items-center justify-between text-[10px] font-semibold text-cyan-600">
                                       <span className="flex items-center gap-1.5">
                                         <Loader2 className="w-3 h-3 animate-spin" />
                                         Processing
                                       </span>
                                       <span>{Math.round(item.progress)}%</span>
                                     </div>
                                     <Progress value={item.progress} className="h-1.5 bg-cyan-500/20 [&>div]:bg-cyan-500" />
                                   </div>
                                 )}
                                 {item.status === 'success' && (
                                   <span className="text-[11px] text-emerald-600 dark:text-emerald-500 font-medium flex items-center gap-1.5 bg-emerald-500/10 w-fit px-2 py-1 rounded border border-emerald-500/20">
                                     <CheckCircle2 className="w-3.5 h-3.5" />
                                     Processed
                                   </span>
                                 )}
                                 {item.status === 'error' && (
                                   <span className="text-[11px] text-destructive font-medium flex items-center gap-1.5 bg-destructive/10 w-fit px-2 py-1 rounded border border-destructive/20" title={item.error}>
                                     <AlertCircle className="w-3.5 h-3.5" />
                                     Failed
                                   </span>
                                 )}
                               </div>
                             </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-all focus-within:opacity-100">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  disabled={isProcessing || item.status === "processing"}
                                  className="h-8 px-2 text-cyan-600 hover:text-cyan-700 hover:bg-cyan-500/10"
                                  onClick={() => handleStartProcessing(item.id)}
                                  title="Process this image only"
                                >
                                  <Play className="w-3.5 h-3.5 mr-1 fill-current" />
                                  Process
                                </Button>
                               <Button 
                                 variant="ghost" 
                                 size="icon" 
                                 disabled={isProcessing}
                                 className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all focus:opacity-100"
                                 onClick={() => handleRemoveItem(item.id)}
                               >
                                 <X className="w-4 h-4" />
                               </Button>
                                </div>
                             </td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </div>
                 </div>
              )}
            </div>
          </div>
          
        </Card>
      </div>

      <ImageSettingsDialog 
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        settings={imageSettings}
        onSave={setImageSettings}
        alterationLevel={alterationLevel}
      />
    </PageShell>
  );
}
