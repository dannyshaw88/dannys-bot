/**
 * AI Image Generation page.
 *
 * Talks to the local Python sidecar via the Express proxy (/api/image-gen/*).
 * In web mode (no sidecar) the status endpoint returns { status: "unavailable" }
 * and the page shows a "desktop app only" notice.
 * In desktop mode the user can load a model and generate images locally on their GPU.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { Sidebar } from "@/components/layout/Sidebar";
import { Loader2, Sparkles, Download, RefreshCw, AlertTriangle, ChevronDown, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ─────────────────────────────────────────────────────────────────────
interface ModelInfo {
  label: string;
  size_gb: number;
  default_steps: number;
  default_guidance: number;
}

interface DownloadProgress {
  downloaded_bytes: number;
  total_bytes: number;
}

interface StatusResponse {
  status: "unavailable" | "idle" | "loading" | "ready" | "error";
  message: string;
  available?: boolean;
  loaded_model: string | null;
  available_models: Record<string, ModelInfo>;
  download_progress?: DownloadProgress | null;
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
      onImageGenSetupProgress?: (cb: (line: string, done: boolean) => void) => void;
      openImageGenOutputDir?: () => void;
    };
  }
}

const BRAND = "#1AD2F2";

const PRESETS = [
  "photorealistic portrait of a woman in streetwear, golden hour, Paris boulevard, shallow depth of field",
  "cinematic close-up of a man in a tailored suit, city lights bokeh background, ultra-realistic",
  "full body shot of a fitness model in athleisure, outdoor urban setting, natural lighting",
  "editorial fashion photography, rooftop setting, sunset, high detail skin texture",
];

const RESOLUTIONS = [
  { label: "1024 × 1024 (Square)", w: 1024, h: 1024 },
  { label: "1344 × 768 (Landscape)", w: 1344, h: 768 },
  { label: "768 × 1344 (Portrait)", w: 768, h: 1344 },
  { label: "1152 × 896 (Wide)", w: 1152, h: 896 },
  { label: "896 × 1152 (Tall)", w: 896, h: 1152 },
];

// ── Component ─────────────────────────────────────────────────────────────────
export function ImageGenPage() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusErr, setStatusErr] = useState(false);

  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("");
  const [model, setModel] = useState("flux-schnell");
  const [resolution, setResolution] = useState(RESOLUTIONS[0]);
  const [steps, setSteps] = useState<number | "">("");
  const [guidance, setGuidance] = useState<number | "">("");
  const [seed, setSeed] = useState<number | "">("");

  const [generating, setGenerating] = useState(false);
  const [loadingModel, setLoadingModel] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [error, setError] = useState("");

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
        // Auto-select model from status
        if (data.loaded_model && data.status === "ready") {
          setModel(data.loaded_model);
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
    window.electronAPI.onImageGenSetupProgress((line, done) => {
      setSetupLog(prev => [...prev.slice(-200), line]);
      if (done) {
        setSettingUp(false);
        fetchStatus();
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  const handleGenerate = async () => {
    if (!prompt.trim()) return;
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

  const handleSetup = async () => {
    if (!window.electronAPI?.setupImageGen) return;
    setSettingUp(true);
    setSetupLog(["Starting AI library installation…"]);
    await window.electronAPI.setupImageGen();
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
  const needsLoad = status?.status === "idle" || status?.status === "error";
  const noSidecar = statusErr && !status;
  const hasElectronSetup = Boolean(window.electronAPI?.setupImageGen);
  const currentModelInfo = status?.available_models?.[model];
  const defaultSteps = currentModelInfo?.default_steps ?? 4;
  const defaultGuidance = currentModelInfo?.default_guidance ?? 0;

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
        <div className="flex-1 overflow-y-auto p-6">

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
            <InfoCard icon={<Loader2 className="w-5 h-5 animate-spin" style={{ color: BRAND }} />} title="Loading model…">
              <p className="text-sm text-muted-foreground">{status?.message}</p>
              <DownloadProgressBar progress={status?.download_progress} />
              <p className="text-xs text-muted-foreground mt-1">
                First load downloads the model weights. This can take several minutes on a fast connection.
              </p>
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
                    options={Object.entries(status?.available_models ?? {}).map(([k, v]) => ({
                      value: k, label: v.label,
                    }))}
                  />
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
                  {/* Presets */}
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">Presets</p>
                    {PRESETS.map((p, i) => (
                      <button
                        key={i}
                        onClick={() => setPrompt(p)}
                        className="w-full text-left text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded px-2 py-1 transition-colors truncate"
                        title={p}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </Section>

                {/* Negative prompt */}
                <Section label="Negative Prompt (optional)">
                  <textarea
                    value={negPrompt}
                    onChange={e => setNegPrompt(e.target.value)}
                    placeholder="blurry, low quality, watermark, text…"
                    rows={2}
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
                  <div className="grid grid-cols-3 gap-2">
                    <LabelledInput
                      label="Steps"
                      placeholder={String(defaultSteps)}
                      value={String(steps)}
                      onChange={v => setSteps(v === "" ? "" : Number(v))}
                      type="number"
                      min={1}
                      max={150}
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
                      <>
                        <Loader2 className="w-10 h-10 animate-spin mb-3" style={{ color: BRAND }} />
                        <p className="text-sm">Generating your image…</p>
                        <p className="text-xs mt-1">This may take 10–60 seconds depending on your GPU</p>
                      </>
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
  onSetup, settingUp, setupLog, setupLogRef, statusMessage,
}: {
  model: string;
  models: Record<string, ModelInfo>;
  onModelChange: (m: string) => void;
  onLoad: () => void;
  loadingModel: boolean;
  onSetup?: () => void;
  settingUp: boolean;
  setupLog: string[];
  setupLogRef: React.RefObject<HTMLDivElement>;
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
          Images are generated on <strong className="text-foreground">your own GPU</strong> — no credits, no queue, no internet needed after the model downloads.
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
              options={Object.entries(models).map(([k, v]) => ({ value: k, label: v.label }))}
            />
            {models[model] && (
              <p className="text-xs text-muted-foreground">
                Download size: ~{models[model].size_gb} GB (one-time, stored in your AppData folder)
              </p>
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

        {/* First-time setup (if torch not installed) */}
        {onSetup && (
          <div className="border-t border-border pt-4 space-y-3">
            <p className="text-xs text-muted-foreground">
              <strong className="text-foreground">First time?</strong> Install the AI libraries (torch + diffusers) onto your bundled Python environment. Downloads ~1.5–2.5 GB depending on your CUDA version.
            </p>
            <button
              onClick={onSetup}
              disabled={settingUp}
              className="w-full py-2 rounded-md font-semibold text-sm border border-border hover:bg-accent text-foreground flex items-center justify-center gap-2 disabled:opacity-50"
            >
              {settingUp
                ? <><Loader2 className="w-4 h-4 animate-spin" /> Installing…</>
                : "Install AI Libraries"
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

function DownloadProgressBar({ progress }: { progress?: DownloadProgress | null }) {
  if (!progress || progress.total_bytes === 0) {
    // Indeterminate — we know a download is happening but can't measure it yet
    return (
      <div className="mt-3 space-y-1.5">
        <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full animate-pulse"
            style={{ width: "100%", background: BRAND, opacity: 0.4 }}
          />
        </div>
        <p className="text-xs text-muted-foreground">Preparing download…</p>
      </div>
    );
  }

  const pct = Math.min(100, Math.round((progress.downloaded_bytes / progress.total_bytes) * 100));
  const dlGB = (progress.downloaded_bytes / 1_073_741_824).toFixed(2);
  const totalGB = (progress.total_bytes / 1_073_741_824).toFixed(1);

  return (
    <div className="mt-3 space-y-1.5">
      <div className="h-2 w-full rounded-full bg-muted overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, background: BRAND }}
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{dlGB} / {totalGB} GB</span>
        <span>{pct}%</span>
      </div>
    </div>
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
  options: { value: string; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full appearance-none bg-muted border border-border rounded-md px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary pr-8"
      >
        {options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
    </div>
  );
}

function LabelledInput({
  label, placeholder, value, onChange, type = "text", min, max, step,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  min?: number;
  max?: number;
  step?: number;
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
        className="w-full bg-muted border border-border rounded px-2 py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  );
}
