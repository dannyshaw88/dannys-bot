/**
 * AI Image Generation page.
 *
 * Talks to the local Python sidecar via the Express proxy (/api/image-gen/*).
 * In web mode (no sidecar) the status endpoint returns { status: "unavailable" }
 * and the page shows a "desktop app only" notice.
 * In desktop mode the user can load a model and generate images locally on their GPU.
 */
import { useState, useEffect, useRef, useCallback, DragEvent } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Loader2, Sparkles, Download, RefreshCw, AlertTriangle, ChevronDown, X, Upload, ImageIcon, Trash2, HardDrive, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ModelInfo {
  label: string;
  size_gb: number;
  installed?: boolean;
  default_steps: number;
  default_guidance: number;
  supports_reference_image?: boolean;
  requires_reference_image?: boolean;
  uses_cpu_offload?: boolean;
  disabled?: boolean;
  disabled_reason?: string;
}

interface GpuInfo {
  available: boolean;
  backend: string;
  name?: string | null;
  reason: string;
  torch_version?: string | null;
  torch_cuda_version?: string | null;
  system_gpu_detected?: boolean;
  system_gpu_name?: string | null;
  driver_version?: string | null;
  device_count?: number;
  compute_capability?: string | null;
  vram_gb?: number | null;
  recommended_dtype?: string | null;
}

interface StatusResponse {
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  message: string;
  available?: boolean;
  loaded_model: string | null;
  available_models: Record<string, ModelInfo>;
  loading_phase?: "checking_cache" | "hardware_check" | "downloading" | "loading_pipeline" | "moving_to_device" | "error" | "idle";
  loading_detail?: string;
  loading_elapsed_seconds?: number | null;
  cpu_threads?: number;
  cpu_count?: number;
  gpu?: GpuInfo;
  generation_progress?: GenerationProgress | null;
}

interface GenerationProgress {
  current_step: number;
  total_steps: number;
  percent: number;
  elapsed_seconds: number;
  phase: string;
}

interface GenerateResult {
  image_b64: string;
  seed: number;
  elapsed_ms: number;
  filename: string;
}

// Electron IPC (only exists in the desktop app)
declare global {
  interface Window {
    electronAPI?: {
      setupImageGen?: () => Promise<{ ok: boolean; message?: string }>;
      getImageGenSetupStatus?: () => Promise<{
        running: boolean;
        done: boolean;
        ok: boolean;
        lines: string[];
      }>;
      onImageGenSetupProgress?: (cb: (line: string, done: boolean) => void) => (() => void) | void;
      openImageGenOutputDir?: () => void;
    };
  }
}

const BRAND = "#1AD2F2";
const RESOLUTIONS = [
  { label: "1024 × 1024 (Square)", w: 1024, h: 1024 },
  { label: "1080 × 1080 (Instagram Square)", w: 1080, h: 1080 },
  { label: "1080 × 1350 (Instagram Portrait 4:5)", w: 1080, h: 1350 },
  { label: "1080 × 1920 (Instagram Story / Reel)", w: 1080, h: 1920 },
  { label: "1344 × 768 (Landscape)", w: 1344, h: 768 },
  { label: "768 × 1344 (Portrait)", w: 768, h: 1344 },
  { label: "1152 × 896 (Wide)", w: 1152, h: 896 },
  { label: "896 × 1152 (Tall)", w: 896, h: 1152 },
];

// ── Persistent state cache ─────────────────────────────────────────────────────
// Route changes unmount this page. Keep the editor state in localStorage so
// navigation and normal renderer reloads do not erase a half-finished setup.
interface PageCache {
  prompt: string;
  negPrompt: string;
  model: string;
  resolution: typeof RESOLUTIONS[number];
  steps: number | "";
  guidance: number | "";
  seed: number | "";
  initImage: string | null;
  initImageName: string;
  strength: number;
  charImage: string | null;
  charImageName: string;
  cpuThreads: number | "";
  result: GenerateResult | null;
}
const PAGE_CACHE_KEY = "aura-farming-ai-image-page-v2";
const defaultPageCache: PageCache = {
  prompt: "",
  negPrompt: "",
  model: "qwen-image-edit-2511",
  resolution: RESOLUTIONS[0],
  steps: "",
  guidance: "",
  seed: "",
  initImage: null,
  initImageName: "",
  strength: 0.75,
  charImage: null,
  charImageName: "",
  cpuThreads: "",
  result: null,
};
function readPageCache(): PageCache {
  try {
    const saved = JSON.parse(localStorage.getItem(PAGE_CACHE_KEY) ?? "null");
    if (!saved || typeof saved !== "object") return { ...defaultPageCache };
    const resolution = RESOLUTIONS.find(r => r.w === saved.resolution?.w && r.h === saved.resolution?.h)
      ?? defaultPageCache.resolution;
    return { ...defaultPageCache, ...saved, resolution };
  } catch {
    return { ...defaultPageCache };
  }
}
function writePageCache(value: PageCache): void {
  try {
    localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify(value));
  } catch {
    // Large base64 uploads/results can exceed browser storage quotas. Preserve
    // all controls even if the optional image payload cannot be persisted.
    try {
      localStorage.setItem(PAGE_CACHE_KEY, JSON.stringify({
        ...value,
        initImage: null,
        charImage: null,
        result: null,
      }));
    } catch { /* storage is unavailable; in-memory state still works */ }
  }
}
const _cache: PageCache = readPageCache();

// ── Component ─────────────────────────────────────────────────────────────────
export function ImageGenPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState(false);

  const [prompt, setPrompt] = useState(_cache.prompt);
  const [negPrompt, setNegPrompt] = useState(_cache.negPrompt);
  const [model, setModel] = useState(_cache.model);
  const [resolution, setResolution] = useState(_cache.resolution);
  const [steps, setSteps] = useState<number | "">(_cache.steps);
  const [guidance, setGuidance] = useState<number | "">(_cache.guidance);
  const [seed, setSeed] = useState<number | "">(_cache.seed);

  const [initImage, setInitImage] = useState<string | null>(_cache.initImage);   // data URL
  const [initImageName, setInitImageName] = useState(_cache.initImageName);
  const [strength, setStrength] = useState(_cache.strength);

  const [charImage, setCharImage] = useState<string | null>(_cache.charImage);
  const [charImageName, setCharImageName] = useState(_cache.charImageName);
  const [cpuThreads, setCpuThreads] = useState<number | "">(_cache.cpuThreads);

  const [generating, setGenerating] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  const [result, setResult] = useState<GenerateResult | null>(_cache.result);

  // Sync all user-editable state back to the cache whenever anything changes
  useEffect(() => {
    _cache.prompt = prompt;
    _cache.negPrompt = negPrompt;
    _cache.model = model;
    _cache.resolution = resolution;
    _cache.steps = steps;
    _cache.guidance = guidance;
    _cache.seed = seed;
    _cache.initImage = initImage;
    _cache.initImageName = initImageName;
    _cache.strength = strength;
    _cache.charImage = charImage;
    _cache.charImageName = charImageName;
    _cache.cpuThreads = cpuThreads;
    _cache.result = result;
    writePageCache(_cache);
  }, [prompt, negPrompt, model, resolution, steps, guidance, seed, initImage, initImageName, strength, charImage, charImageName, cpuThreads, result]);
  const [error, setError] = useState("");
  const [modelNotice, setModelNotice] = useState("");

  const [settingUp, setSettingUp] = useState(false);
  const [setupLog, setSetupLog] = useState<string[]>([]);
  const setupLogRef = useRef<HTMLDivElement>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Poll status ─────────────────────────────────────────────────────────────
  const fetchStatus = useCallback(async () => {
    try {
      const r = await fetch("/api/image-gen/status");
      if (r.ok) {
        const data: StatusResponse = await r.json();
        setStatus(data);
        setStatusErr(false);
        // Auto-select the loaded model, or recover from an old saved selection.
        if (data.loaded_model && data.status === "ready") {
          setModel(data.loaded_model);
        } else if (!data.available_models?.[model]) {
          const firstSelectable = Object.entries(data.available_models ?? {})
            .find(([, info]) => !info.disabled)?.[0];
          if (firstSelectable) setModel(firstSelectable);
        }
      } else {
        setStatusErr(true);
      }
    } catch {
      setStatusErr(true);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [fetchStatus]);

  // Scroll setup log to bottom
  useEffect(() => {
    if (setupLogRef.current) {
      setupLogRef.current.scrollTop = setupLogRef.current.scrollHeight;
    }
  }, [setupLog]);

  // Register Electron progress listener once
  useEffect(() => {
    if (!window.electronAPI?.onImageGenSetupProgress) return;
    let active = true;
    const restoreSetup = async () => {
      try {
        const saved = await window.electronAPI?.getImageGenSetupStatus?.();
        if (!active || !saved) return;
        if (saved.lines.length > 0) setSetupLog(saved.lines);
        setSettingUp(saved.running);
      } catch { /* browser mode or older desktop build */ }
    };
    restoreSetup();
    const unsubscribe = window.electronAPI.onImageGenSetupProgress((line, done) => {
      setSetupLog(prev => [...prev.slice(-200), line]);
      if (done) {
        setSettingUp(false);
        fetchStatus();
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [fetchStatus]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Actions ─────────────────────────────────────────────────────────────────
  const handleLoadModel = async () => {
    setLoadingModel(true);
    setError("");
    try {
      const r = await fetch("/api/image-gen/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        setError(d.detail ?? d.error ?? "Failed to start model load");
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setLoadingModel(false);
    }
  };

  const handleCpuThreads = async (val: number | "") => {
    setCpuThreads(val);
    if (val === "") return;
    try {
      await fetch("/api/image-gen/cpu-threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ threads: Number(val) }),
      });
    } catch { /* non-critical */ }
  };

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    if (
      (currentModelInfo?.requires_reference_image ?? currentModelInfo?.supports_reference_image) &&
      !initImage &&
      !charImage
    ) {
      setError(`${currentModelInfo.label} requires a reference or input image.`);
      return;
    }
    setGenerating(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        prompt: prompt.trim(),
        negative_prompt: negPrompt.trim(),
        model,
        width: resolution.w,
        height: resolution.h,
      };
      if (steps !== "") body.steps = Number(steps);
      if (guidance !== "") body.guidance_scale = Number(guidance);
      if (seed !== "") body.seed = Number(seed);
       if (initImage) {
        // Strip the "data:image/...;base64," prefix — sidecar expects raw base64
        body.init_image = initImage.split(",")[1];
        body.strength = strength;
       } else if (currentModelInfo?.supports_reference_image && charImage) {
         body.init_image = charImage.split(",")[1];
      }

      const r = await fetch("/api/image-gen/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok) {
        setError(d.detail ?? d.error ?? "Generation failed");
      } else {
        setResult(d as GenerateResult);
        setSeed(d.seed);
      }
    } catch (e: any) {
      setError(e.message ?? "Network error");
    } finally {
      setGenerating(false);
    }
  };

  const handleUnload = async () => {
    try {
      await fetch("/api/image-gen/unload", { method: "POST" });
      // Status poll will pick up the idle state within 2 s
    } catch { /* non-critical */ }
  };

  const handleDeleteModel = async (modelKey: string) => {
    const info = status?.available_models?.[modelKey];
    if (!info?.installed) return;
    const confirmed = window.confirm(
      `Delete the downloaded ${info.label} files from this PC? This will free approximately ${info.size_gb} GB of disk space. You can download the model again later.`,
    );
    if (!confirmed) return;

    setDeletingModel(modelKey);
    setError("");
    setModelNotice("");
    try {
      const r = await fetch("/api/image-gen/delete-model", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: modelKey }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        setError(data.detail ?? data.error ?? "Failed to delete the downloaded model");
        return;
      }
      setResult(null);
      const freed = typeof data.freed_bytes === "number" ? formatBytes(data.freed_bytes) : `about ${info.size_gb} GB`;
      setModelNotice(`${info.label} removed from disk. ${freed} of disk space was reclaimed.`);
      await fetchStatus();
    } catch (e: any) {
      setError(e.message ?? "Network error while deleting the model");
    } finally {
      setDeletingModel(null);
    }
  };

  const handleSetup = async () => {
    if (!window.electronAPI?.setupImageGen) return;
    setSettingUp(true);
    setSetupLog(["Starting or resuming AI library installation…"]);
    const response = await window.electronAPI.setupImageGen();
    if (!response.ok) {
      setSettingUp(false);
      if (response.message) setSetupLog(prev => [...prev, `❌ ${response.message}`]);
    }
    // Progress events continue via onImageGenSetupProgress
  };

  const handleDownload = () => {
    if (!result) return;
    const a = document.createElement("a");
    a.href = `data:image/png;base64,${result.image_b64}`;
    a.download = result.filename;
    a.click();
  };

  // ── Derived ─────────────────────────────────────────────────────────────────
  const isUnavailable = status?.status === "unavailable";
  const isReady = status?.status === "ready";
  const isLoading = status?.status === "loading";
  const loadingPipeline =
    status?.loading_phase === "loading_pipeline" ||
    status?.loading_phase === "moving_to_device";
  const loadingHardware = status?.loading_phase === "hardware_check";
  const needsLoad = status?.status === "idle" || status?.status === "error";
  const noSidecar = statusErr && !status;
  const hasElectronSetup = Boolean(window.electronAPI?.setupImageGen);
  const currentModelInfo = status?.available_models?.[model];
  const defaultSteps = currentModelInfo?.default_steps ?? 4;
  const defaultGuidance = currentModelInfo?.default_guidance ?? 0;
  const supportsReferenceImage = Boolean(currentModelInfo?.supports_reference_image);
  const requiresReferenceImage = Boolean(
    currentModelInfo?.requires_reference_image ?? currentModelInfo?.supports_reference_image,
  );
  const gpu = status?.gpu;
  const generationProgress = status?.generation_progress;
  const pixelCount = resolution.w * resolution.h;
  const slowCpuJob = !gpu?.available && (pixelCount > 786432 || (steps !== "" && Number(steps) > 8));

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-screen bg-background">
      <Sidebar />
      <div className="ml-[133px] flex-1 flex flex-col min-h-0 overflow-hidden">

        {/* ── Header ── */}
        <div className="border-b border-border px-6 py-4 flex items-center gap-3 shrink-0">
          <Sparkles className="w-5 h-5" style={{ color: BRAND }} />
          <h1 className="text-lg font-bold text-foreground">AI Image Generation</h1>
          <div className="ml-auto flex items-center gap-2">
            <StatusPill status={status} statusErr={statusErr} />
            <button
              onClick={fetchStatus}
              className="p-1.5 rounded hover:bg-accent text-muted-foreground"
              title="Refresh status"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="flex-1 overflow-y-auto p-6 flex flex-col items-center justify-center">

          {modelNotice && (
            <div className="max-w-xl mb-4 flex items-start gap-2 p-3 rounded-md bg-green-500/10 border border-green-500/20">
              <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-green-400 mt-0.5 shrink-0" />
              <p className="text-xs text-green-700 dark:text-green-300">{modelNotice}</p>
              <button onClick={() => setModelNotice("")} className="ml-auto">
                <X className="w-3.5 h-3.5 text-muted-foreground" />
              </button>
            </div>
          )}

          {/* Unavailable (web mode) */}
          {isUnavailable && (
            <InfoCard icon="🖥️" title="Desktop App Required">
              <p className="text-sm text-muted-foreground">
                AI image generation runs locally on your GPU and is only available in the
                Aura Farming Windows desktop app — not in the browser.
              </p>
              <p className="text-sm text-muted-foreground mt-2">
                Download the installer from{" "}
                <code className="text-xs bg-muted px-1 py-0.5 rounded">
                  github.com/dannyshaw88/dannys-bot → Actions → Latest build
                </code>
              </p>
            </InfoCard>
          )}

          {/* Connection error (server not running or sidecar unreachable) */}
          {noSidecar && (
            <InfoCard icon="⚠️" title="Cannot reach the API server">
              <p className="text-sm text-muted-foreground">
                The image generation status endpoint is not responding. Make sure the API server is running.
              </p>
            </InfoCard>
          )}

          {/* Needs first-time setup */}
          {!isUnavailable && !noSidecar && needsLoad && !isLoading && (
            <SetupSection
              model={model}
              models={status?.available_models ?? {}}
              onModelChange={setModel}
              onLoad={handleLoadModel}
              onDelete={handleDeleteModel}
              deletingModel={deletingModel}
              loadingModel={loadingModel}
              onSetup={hasElectronSetup ? handleSetup : undefined}
              settingUp={settingUp}
              setupLog={setupLog}
              setupLogRef={setupLogRef}
              statusMessage={status?.message}
            />
          )}

          {/* Loading model */}
          {isLoading && (
            <InfoCard
              icon={<Loader2 className="w-5 h-5 animate-spin" style={{ color: BRAND }} />}
              title={
                loadingHardware
                  ? "Checking hardware compatibility…"
                  : loadingPipeline
                    ? "Download complete — loading model into memory…"
                    : "Loading model…"
              }
            >
              <p className="text-sm text-muted-foreground">{status?.message}</p>
              {status?.loading_detail && (
                <p className="text-xs text-muted-foreground mt-1">{status.loading_detail}</p>
              )}
              <div className="mt-3 h-2 w-full rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full w-full rounded-full animate-pulse"
                  style={{ background: BRAND, opacity: 0.4 }}
                />
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {loadingPipeline
                  ? "The files are downloaded. The model is now being assembled and moved into memory; this can take several minutes on supported hardware."
                  : loadingHardware
                    ? "Preparing the hardware check before downloading starts…"
                  : "First load downloads the model weights. This can take several minutes on a fast connection."}
              </p>
              {typeof status?.loading_elapsed_seconds === "number" && status.loading_elapsed_seconds >= 60 && (
                <p className="text-xs text-muted-foreground mt-2">
                  Loading time: {Math.floor(status.loading_elapsed_seconds / 60)}m {Math.floor(status.loading_elapsed_seconds % 60)}s
                </p>
              )}
              {typeof status?.loading_elapsed_seconds === "number" && status.loading_elapsed_seconds >= 300 && (
                <p className="text-xs text-amber-700 dark:text-amber-300 mt-2">
                  Model assembly is taking longer than 5 minutes. If this does not finish, the selected model likely exceeds the available GPU or system memory; refresh the app and choose a smaller model.
                </p>
              )}
            </InfoCard>
          )}

          {/* Ready — main generation UI */}
          {isReady && (
            <div className="grid grid-cols-[380px_1fr] gap-6 max-w-[1200px]">

              {/* ── Left: Controls ── */}
              <div className="space-y-4">

                {/* Model */}
                <Section label="Model">
                  <SelectField
                    value={model}
                    onChange={setModel}
                     options={Object.entries(status?.available_models ?? {})
                       .filter(([, info]) => !info.disabled)
                       .map(([k, v]) => ({ value: k, label: v.label }))}
                  />
                   {currentModelInfo?.installed && (
                     <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                       <HardDrive className="w-3 h-3" />
                       Downloaded on this PC · approximately {currentModelInfo.size_gb} GB
                     </p>
                   )}
                  {model !== status?.loaded_model && (
                   <button
                      onClick={handleLoadModel}
                      disabled={loadingModel}
                      className="mt-2 w-full py-1.5 text-xs font-semibold rounded border border-border hover:bg-accent text-foreground disabled:opacity-50"
                    >
                      {loadingModel ? <Loader2 className="w-3 h-3 animate-spin inline mr-1" /> : null}
                      Switch to {model}
                    </button>
                  )}
                  {/* Unload button — frees the model's RAM so Phone Farm / rest of app stays responsive */}
                  <button
                    onClick={handleUnload}
                    className="mt-2 w-full py-1.5 text-xs rounded border border-border hover:bg-accent text-muted-foreground"
                    title="Releases the model from memory. Phone Farm and other features will respond normally again. Reload the model when you want to generate again."
                  >
                    Unload model &amp; free RAM
                  </button>
                   <button
                     onClick={() => handleDeleteModel(model)}
                     disabled={!currentModelInfo?.installed || deletingModel === model}
                     className="mt-2 w-full py-1.5 text-xs rounded border border-red-500/30 hover:bg-red-500/10 text-red-600 dark:text-red-400 disabled:opacity-40 disabled:hover:bg-transparent flex items-center justify-center gap-1.5"
                     title="Deletes the downloaded model files from this PC. You can download the model again later."
                   >
                     {deletingModel === model ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                     Delete downloaded model files
                   </button>
                   <GpuStatusNote gpu={gpu} />
                   {slowCpuJob && (
                     <p className="mt-2 rounded-md border border-red-500/30 bg-red-500/5 p-2 text-[10px] text-red-700 dark:text-red-300 leading-relaxed">
                      This CPU job is unusually heavy ({resolution.w}×{resolution.h}). A CPU laptop may take a long time to process large edits.
                     </p>
                   )}
                </Section>

                {/* Reference image */}
                 {supportsReferenceImage && (
                   <Section label="Reference image (editing)">
                    <p className="text-[10px] text-muted-foreground mb-2 leading-relaxed">
                         {supportsReferenceImage
                          ? requiresReferenceImage
                            ? `Upload the image to edit. ${currentModelInfo?.label ?? "This model"} uses it directly as visual context and follows your prompt. This model requires a reference image.`
                            : `Optional: upload an image for ${currentModelInfo?.label ?? "this model"} to use as visual context while editing. Leave it empty for text-to-image generation.`
                         : "Upload an image for the selected model to use as visual context while editing."}
                    </p>
                    <ImageUploadZone
                      image={charImage}
                      imageName={charImageName}
                      onImage={(dataUrl, name) => { setCharImage(dataUrl); setCharImageName(name); }}
                      onClear={() => { setCharImage(null); setCharImageName(""); }}
                    />
                  </Section>
                )}

                {/* Input image (img2img) */}
                <Section label="Input Image (optional)">
                  <ImageUploadZone
                    image={initImage}
                    imageName={initImageName}
                    onImage={(dataUrl, name) => { setInitImage(dataUrl); setInitImageName(name); }}
                    onClear={() => { setInitImage(null); setInitImageName(""); }}
                  />
                  {initImage && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-[10px] text-muted-foreground uppercase tracking-wide">
                          Edit Strength — {Math.round(strength * 100)}%
                        </label>
                        <span className="text-[10px] text-muted-foreground">
                          {strength <= 0.3 ? "subtle" : strength >= 0.8 ? "full redraw" : "balanced"}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={1.0}
                        step={0.05}
                        value={strength}
                        onChange={e => setStrength(Number(e.target.value))}
                        className="w-full accent-[#1AD2F2]"
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>subtle change</span>
                        <span>full redraw</span>
                      </div>
                    </div>
                  )}
                </Section>

                {/* Prompt */}
                <Section label="Prompt">
                  <textarea
                    value={prompt}
                    onChange={e => setPrompt(e.target.value)}
                    placeholder="Describe the image you want to generate…"
                    rows={4}
                    className="w-full bg-muted border border-border rounded-md px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground resize-none focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </Section>

                {/* Resolution */}
                <Section label="Resolution">
                  <SelectField
                    value={`${resolution.w}x${resolution.h}`}
                    onChange={val => {
                      const found = RESOLUTIONS.find(r => `${r.w}x${r.h}` === val);
                      if (found) setResolution(found);
                    }}
                    options={RESOLUTIONS.map(r => ({ value: `${r.w}x${r.h}`, label: r.label }))}
                  />
                </Section>

                {/* Advanced */}
                <Section label="Advanced (optional)">
                  <div className="grid grid-cols-2 gap-2">
                    <LabelledInput
                      label="Steps"
                      placeholder={String(defaultSteps)}
                      value={String(steps)}
                      onChange={v => setSteps(v === "" ? "" : Number(v))}
                      type="number"
                      min={1}
                      max={150}
                      help={`Recommended for this model: ${defaultSteps}. Steps are denoising passes — more can add detail but takes longer. Turbo models usually need 1–8; SDXL/RealVis about 30; FLUX dev about 50.`}
                    />
                    <LabelledInput
                      label="Guidance"
                      placeholder={String(defaultGuidance)}
                      value={String(guidance)}
                      onChange={v => setGuidance(v === "" ? "" : Number(v))}
                      type="number"
                      min={0}
                      max={20}
                      step={0.5}
                    />
                    <LabelledInput
                      label="Seed"
                      placeholder="random"
                      value={String(seed)}
                      onChange={v => setSeed(v === "" ? "" : Number(v))}
                      type="number"
                      min={0}
                    />
                    <LabelledInput
                      label={`CPU Threads (of ${status?.cpu_count ?? "?"})`}
                      placeholder={String(status?.cpu_threads ?? "auto")}
                      value={String(cpuThreads)}
                      onChange={v => handleCpuThreads(v === "" ? "" : Number(v))}
                      type="number"
                      min={1}
                      max={status?.cpu_count ?? 64}
                      title="Limit how many CPU cores PyTorch uses. Lower = cooler/quieter PC, slower generation. Default is half your cores."
                    />
                  </div>
                </Section>

                {/* Generate button */}
                {error && (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
                    <AlertTriangle className="w-4 h-4 text-destructive mt-0.5 shrink-0" />
                    <p className="text-xs text-destructive">{error}</p>
                    <button onClick={() => setError("")} className="ml-auto">
                      <X className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                  </div>
                )}

                <button
                  onClick={handleGenerate}
                  disabled={generating || !prompt.trim()}
                  className="w-full py-2.5 rounded-md font-semibold text-sm flex items-center justify-center gap-2 transition-all"
                  style={{
                    background: generating || !prompt.trim() ? undefined : BRAND,
                    color: generating || !prompt.trim() ? undefined : "#000",
                    opacity: generating || !prompt.trim() ? 0.5 : 1,
                  }}
                >
                  {generating
                    ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
                    : <><Sparkles className="w-4 h-4" /> Generate</>
                  }
                </button>

              </div>

              {/* ── Right: Output ── */}
              <div className="flex flex-col gap-4">
                {result ? (
                  <div className="space-y-3">
                    <div className="relative group rounded-lg overflow-hidden border border-border bg-muted/30">
                      <img
                        src={`data:image/png;base64,${result.image_b64}`}
                        alt="Generated image"
                        className="w-full h-auto block"
                      />
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-3 opacity-0 group-hover:opacity-100 transition-opacity">
                        <div className="flex items-center justify-between">
                          <div className="text-xs text-white/80 space-y-0.5">
                            <div>Seed: {result.seed}</div>
                            <div>Generated in {(result.elapsed_ms / 1000).toFixed(1)}s</div>
                          </div>
                          <button
                            onClick={handleDownload}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-white/20 hover:bg-white/30 rounded text-white text-xs font-medium backdrop-blur-sm"
                          >
                            <Download className="w-3.5 h-3.5" />
                            Save
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center justify-between text-xs text-muted-foreground">
                      <span>Saved to output folder · {result.filename}</span>
                      <button
                        onClick={handleDownload}
                        className="flex items-center gap-1 hover:text-foreground"
                      >
                        <Download className="w-3 h-3" /> Download
                      </button>
                    </div>
                  </div>
                ) : (
                  <div
                    className="flex flex-col items-center justify-center rounded-lg border-2 border-dashed border-border text-muted-foreground"
                    style={{ minHeight: "400px" }}
                  >
                    {generating ? (
                      <GenerationProgressView progress={generationProgress} />
                    ) : (
                      <>
                        <Sparkles className="w-10 h-10 mb-3 opacity-20" />
                        <p className="text-sm opacity-60">Your generated image will appear here</p>
                      </>
                    )}
                  </div>
                )}
              </div>

            </div>
          )}

        </div>
      </div>
    </div>
  );
}

function GenerationProgressView({ progress }: { progress?: GenerationProgress | null }) {
  const percent = progress?.percent ?? 0;
  return (
    <div className="w-full max-w-md px-8 text-center">
      <Loader2 className="w-10 h-10 animate-spin mx-auto mb-3" style={{ color: BRAND }} />
      <p className="text-sm">Generating your image…</p>
      <div className="mt-4 h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${percent}%`, background: BRAND }}
        />
      </div>
      <div className="mt-2 flex justify-between text-xs text-muted-foreground">
        <span>{progress ? `${progress.phase} · step ${progress.current_step}/${progress.total_steps}` : "Preparing…"}</span>
        <span>{progress ? `${progress.elapsed_seconds.toFixed(0)}s` : "Starting"}</span>
      </div>
    </div>
  );
}

// ── Small reusable sub-components ─────────────────────────────────────────────

function StatusPill({ status, statusErr }: { status: StatusResponse | null; statusErr: boolean }) {
  if (statusErr && !status) {
    return (
      <span className="text-xs text-muted-foreground px-2 py-0.5 rounded-full border border-border">
        Connecting…
      </span>
    );
  }
  if (!status) return null;

  const map: Record<string, { dot: string; label: string }> = {
    unavailable: { dot: "bg-gray-400", label: "Not available" },
    idle:        { dot: "bg-yellow-400", label: "Not loaded" },
    loading:     { dot: "bg-blue-400 animate-pulse", label: "Loading model…" },
    ready:       { dot: "bg-green-500", label: "Ready" },
    error:       { dot: "bg-red-500", label: "Error" },
  };
  const info = map[status.status] ?? map.idle;

  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground px-2 py-0.5 rounded-full border border-border">
      <span className={cn("w-2 h-2 rounded-full shrink-0", info.dot)} />
      {info.label}
    </span>
  );
}

function InfoCard({
  icon, title, children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="max-w-xl rounded-xl border border-border bg-card p-6 space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <h2 className="font-semibold text-foreground">{title}</h2>
      </div>
      {children}
    </div>
  );
}

function SetupSection({
  model, models, onModelChange, onLoad, loadingModel,
  onDelete, deletingModel,
  onSetup, settingUp, setupLog, setupLogRef, statusMessage,
}: {
  model: string;
  models: Record<string, ModelInfo>;
  onModelChange: (m: string) => void;
  onLoad: () => void;
  loadingModel: boolean;
  onDelete: (model: string) => void;
  deletingModel: string | null;
  onSetup?: () => void;
  settingUp: boolean;
  setupLog: string[];
  setupLogRef: React.RefObject<HTMLDivElement | null>;
  statusMessage?: string;
}) {
  return (
    <div className="max-w-xl space-y-4">
      <div className="rounded-xl border border-border bg-card p-6 space-y-4">
        <div className="flex items-center gap-3">
          <Sparkles className="w-5 h-5" style={{ color: BRAND }} />
          <h2 className="font-semibold text-foreground">Local AI Image Generation</h2>
        </div>

        {statusMessage && statusMessage !== "Ready to load a model." && (
          <p className="text-sm text-muted-foreground">{statusMessage}</p>
        )}

        <p className="text-sm text-muted-foreground">
          Images are generated on <strong className="text-foreground">your own computer</strong> — GPU acceleration is used when available, with CPU fallback for slower generation.
        </p>

        {/* Model picker */}
        {Object.keys(models).length > 0 && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Choose model
            </label>
            <SelectField
              value={model}
              onChange={onModelChange}
               options={Object.entries(models).map(([k, v]) => ({ value: k, label: v.label, disabled: v.disabled }))}
            />
            {models[model] && (
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">
                  Download size: ~{models[model].size_gb} GB (stored in your AppData folder)
                </p>
                {models[model].installed && (
                  <p className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                    <CheckCircle2 className="w-3.5 h-3.5" /> Downloaded on this PC
                  </p>
                )}
              </div>
            )}
          </div>
        )}

        {/* Load button (if sidecar is running but no model loaded) */}
        <button
          onClick={onLoad}
          disabled={loadingModel}
          className="w-full py-2.5 rounded-md font-semibold text-sm flex items-center justify-center gap-2"
          style={{ background: BRAND, color: "#000" }}
        >
          {loadingModel
            ? <><Loader2 className="w-4 h-4 animate-spin" /> Loading…</>
            : <><Sparkles className="w-4 h-4" /> Load Model &amp; Start Generating</>
          }
        </button>
        {models[model]?.installed && (
          <button
            onClick={() => onDelete(model)}
            disabled={deletingModel === model}
            className="w-full py-2 rounded-md font-semibold text-sm border border-red-500/30 hover:bg-red-500/10 text-red-600 dark:text-red-400 flex items-center justify-center gap-2 disabled:opacity-50"
          >
            {deletingModel === model ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
            Delete downloaded model files
          </button>
        )}

        {/* First-time setup (if torch not installed) */}
        {onSetup && (
          <div className="border-t border-border pt-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">First time or repairing an error?</strong> Install or repair the AI libraries (torch + diffusers) in your bundled Python environment. Downloads ~1.5–2.5 GB depending on your CUDA version.
            </p>
            <button
              onClick={onSetup}
              disabled={settingUp}
              className="w-full py-2 rounded-md font-semibold text-sm border border-border hover:bg-accent text-foreground flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {settingUp
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</>
                : setupLog.length > 0 ? "Retry / Resume AI Library Repair" : "Install / Repair AI Libraries"
              }
            </button>
          </div>
        )}
      </div>

      {/* Setup log */}
      {setupLog.length > 0 && (
        <div
          ref={setupLogRef}
          className="rounded-md bg-black/80 border border-border p-3 font-mono text-xs text-green-400 max-h-56 overflow-y-auto space-y-0.5"
        >
          {setupLog.map((line, i) => (
            <div key={i}>{line || " "}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function GpuStatusNote({ gpu }: { gpu?: GpuInfo }) {
  if (!gpu) {
    return (
      <p className="mt-2 text-[10px] text-muted-foreground leading-relaxed">
        GPU capability details are not available from this image-generation server yet.
      </p>
    );
  }
  if (gpu.available) {
    return (
      <p className="mt-2 flex items-start gap-1.5 text-[10px] text-green-600 dark:text-green-400 leading-relaxed">
        <CheckCircle2 className="w-3 h-3 mt-0.5 shrink-0" />
        <span>GPU acceleration active: {gpu.name ?? "NVIDIA CUDA"}{gpu.torch_cuda_version ? ` · CUDA ${gpu.torch_cuda_version}` : ""}.</span>
      </p>
    );
  }

  const systemName = gpu.system_gpu_name ?? gpu.name;
  return (
    <div className="mt-2 rounded-md border border-yellow-500/30 bg-yellow-500/5 p-2 text-[10px] text-yellow-700 dark:text-yellow-300 leading-relaxed">
      <div className="font-semibold">
        {systemName
          ? `${systemName} is installed, but this Python environment is using the CPU.`
          : "GPU acceleration is not available to this Python environment."}
      </div>
      <div className="mt-1">{gpu.reason}</div>
      {gpu.driver_version && <div className="mt-1">Windows driver detected: {gpu.driver_version}.</div>}
      <div className="mt-1">
        Device Manager showing a current driver does not guarantee that PyTorch can use CUDA; the bundled Torch build and its CUDA runtime must also be compatible.
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "No additional disk space";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index >= 3 ? 2 : 0)} ${units[index]}`;
}

function ImageUploadZone({
  image, imageName, onImage, onClear,
}: {
  image: string | null;
  imageName: string;
  onImage: (dataUrl: string, name: string) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const readFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = e => {
      const result = e.target?.result;
      if (typeof result === "string") onImage(result, file.name);
    };
    reader.readAsDataURL(file);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) readFile(file);
  };

  if (image) {
    return (
      <div className="relative rounded-md overflow-hidden border border-border bg-muted/30 group">
        <img src={image} alt="Input" className="w-full h-36 object-cover block" />
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <button
            onClick={onClear}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-black/60 hover:bg-black/80 rounded text-white text-xs font-medium"
          >
            <X className="w-3 h-3" /> Remove
          </button>
        </div>
        <div className="px-2 py-1 bg-muted border-t border-border flex items-center gap-1.5">
          <ImageIcon className="w-3 h-3 text-muted-foreground shrink-0" />
          <span className="text-xs text-muted-foreground truncate">{imageName}</span>
          <button onClick={onClear} className="ml-auto shrink-0 text-muted-foreground hover:text-foreground">
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) readFile(f); e.target.value = ""; }}
      />
      <div
        onClick={() => inputRef.current?.click()}
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-2 h-24 rounded-md border-2 border-dashed cursor-pointer transition-colors",
          dragging
            ? "border-[#1AD2F2] bg-[#1AD2F2]/5"
            : "border-border hover:border-[#1AD2F2]/50 hover:bg-accent/50"
        )}
      >
        <Upload className="w-5 h-5 text-muted-foreground" />
        <span className="text-xs text-muted-foreground text-center">
          Drop an image or <span className="text-foreground underline underline-offset-2">click to upload</span>
        </span>
        <span className="text-[10px] text-muted-foreground/60">PNG · JPEG · WEBP</span>
      </div>
    </>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</label>
      {children}
    </div>
  );
}

function SelectField({
  value, onChange, options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; disabled?: boolean }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full appearance-none bg-muted border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary pr-8"
      >
        {options.map(o => (
          <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
    </div>
  );
}

function LabelledInput({
  label, placeholder, value, onChange, type = "text", min, max, step, title, help,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  min?: number;
  max?: number;
  step?: number;
  title?: string;
  help?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</label>
      <input
        type={type}
        value={value === "undefined" ? "" : value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        min={min}
        max={max}
        step={step}
        title={title}
        className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
      {help && <p className="text-[9px] leading-tight text-muted-foreground">{help}</p>}
    </div>
  );
}
