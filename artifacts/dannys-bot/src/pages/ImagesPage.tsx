import React, { useState, useRef, useCallback } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
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
  const [localItems, setLocalItems] = useState<MediaItem[]>([]);
  const [localIsProcessing, setLocalIsProcessing] = useState(false);
  const [localFixAiSlop, setLocalFixAiSlop] = useState(true);
  const [localAltEnabled, setLocalAltEnabled] = useState(true);
  const [localAltLevel, setLocalAltLevel] = useState<"small" | "medium" | "high">("small");
  const [localImgSettingsEnabled, setLocalImgSettingsEnabled] = useState(true);
  const [localImgSettings, setLocalImgSettings] = useState<ImageFilterSettings>(DEFAULT_IMAGE_SETTINGS);
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

  const handleAddFiles = useCallback((files: File[]) => {
    if (props.onAddFiles) {
      props.onAddFiles(files);
      return;
    }
    const newItems = files.filter(file => file.type.startsWith("image/") || /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i.test(file.name)).map(f => ({
      id: Math.random().toString(36).substring(2, 9),
      file: f,
      name: f.name,
      size: f.size,
      previewUrl: URL.createObjectURL(f),
      status: "idle" as const,
      progress: 0,
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

  const handleStartProcessing = useCallback(() => {
    if (props.onStartProcessing) return props.onStartProcessing();

    setLocalIsProcessing(true);
    processingRef.current = true;

    void (async () => {
      const queue = localItems.filter(item => item.status !== "success");
      for (const item of queue) {
        if (!processingRef.current) break;
        setLocalItems(prev => prev.map(current => current.id === item.id
          ? { ...current, status: "processing", progress: 8, error: undefined }
          : current));
        try {
          const imageBase64 = await readFileDataUrl(item);
          if (!processingRef.current) break;
          setLocalItems(prev => prev.map(current => current.id === item.id
            ? { ...current, progress: 28 }
            : current));
          const response = await fetch("/api/images/process", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              ...(item.sourcePath ? { localPath: item.sourcePath } : { imageBase64 }),
              filename: item.name,
              fixAiSlop,
              alterationEnabled,
              alterationLevel,
              imageSettingsEnabled,
              imageSettings,
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
            }
            : current));
        } catch (error: any) {
          setLocalItems(prev => prev.map(current => current.id === item.id
            ? { ...current, status: "error", progress: 0, error: error?.message ?? "Processing failed" }
            : current));
        }
      }
      processingRef.current = false;
      setLocalIsProcessing(false);
    })();
  }, [alterationEnabled, alterationLevel, fixAiSlop, imageSettings, imageSettingsEnabled, localItems, props, readFileDataUrl]);

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
                        <Label className="text-[11px] text-muted-foreground mb-1.5 block text-left">Alteration Level</Label>
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
                
               {notice && (
                 <span className="hidden md:inline text-[11px] text-muted-foreground truncate max-w-[260px]" title={notice}>
                   {notice}
                 </span>
               )}
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
                    variant="secondary" 
                    size="sm" 
                    disabled={items.length === 0 || items.every(i => i.status === 'success')}
                    onClick={handleStartProcessing}
                    className="shadow-xs h-8 bg-foreground text-background hover:bg-foreground/90 border-0"
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
                 <div className="rounded-xl border border-border/60 bg-background shadow-xs overflow-hidden animate-in fade-in duration-300">
                   <div className="overflow-x-auto">
                     <table className="w-full text-sm text-left border-collapse min-w-[600px]">
                       <thead className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider bg-muted/40 border-b border-border/60">
                         <tr>
                           <th className="px-4 py-3 w-16 text-center">Orig</th>
                           <th className="px-4 py-3 w-16 text-center">Proc</th>
                           <th className="px-4 py-3">File Details</th>
                           <th className="px-4 py-3 w-56">Status</th>
                           <th className="px-4 py-3 w-12 text-right"></th>
                         </tr>
                       </thead>
                       <tbody className="divide-y divide-border/40">
                         {items.map(item => (
                           <tr key={item.id} className="hover:bg-muted/30 transition-colors group">
                             <td className="px-4 py-3">
                               <div className="w-10 h-10 rounded border border-border/60 bg-muted/30 overflow-hidden mx-auto shadow-xs">
                                 <img src={item.previewUrl} className="w-full h-full object-cover" alt="" />
                               </div>
                             </td>
                             <td className="px-4 py-3">
                               <div className="w-10 h-10 rounded border border-border/60 bg-muted/10 overflow-hidden mx-auto flex items-center justify-center shadow-xs">
                                 {item.processedPreviewUrl ? (
                                   <img src={item.processedPreviewUrl} className="w-full h-full object-cover" alt="" />
                                 ) : (
                                   <ImageIcon className="w-4 h-4 text-muted-foreground/30" />
                                 )}
                               </div>
                             </td>
                             <td className="px-4 py-3 min-w-0">
                               <div className="font-medium text-foreground truncate max-w-[280px]" title={item.name}>
                                 {item.name}
                               </div>
                               <div className="text-[11px] text-muted-foreground mt-0.5 font-mono">
                                 {(item.size / 1024 / 1024).toFixed(2)} MB
                               </div>
                             </td>
                             <td className="px-4 py-3">
                               <div className="flex flex-col justify-center h-10">
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
                               <Button 
                                 variant="ghost" 
                                 size="icon" 
                                 disabled={isProcessing}
                                 className="h-8 w-8 text-muted-foreground hover:text-destructive hover:bg-destructive/10 opacity-0 group-hover:opacity-100 transition-all focus:opacity-100"
                                 onClick={() => handleRemoveItem(item.id)}
                               >
                                 <X className="w-4 h-4" />
                               </Button>
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
