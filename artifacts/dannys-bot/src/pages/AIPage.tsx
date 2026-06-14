import { useState, useCallback, useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Sparkles, RefreshCw, Loader2, RotateCcw, Upload, X, Link } from "lucide-react";

const SIZES = [
  { label: "Portrait  512×768",  w: 512,  h: 768  },
  { label: "Square    512×512",  w: 512,  h: 512  },
  { label: "Landscape 768×512",  w: 768,  h: 512  },
  { label: "Tall      512×896",  w: 512,  h: 896  },
  { label: "Wide      896×512",  w: 896,  h: 512  },
  { label: "HD        768×1024", w: 768,  h: 1024 },
  { label: "HD Wide   1024×768", w: 1024, h: 768  },
];

// Hardcoded comprehensive model list — the /models endpoint only returns a subset.
// These are confirmed working model IDs on Pollinations free tier.
const BUILTIN_MODELS: { id: string; label: string }[] = [
  { id: "flux",             label: "Flux Schnell (fastest)" },
  { id: "turbo",            label: "Turbo" },
  { id: "flux-realism",     label: "Flux Realism" },
  { id: "flux-dev",         label: "Flux Dev" },
  { id: "flux-pro",         label: "Flux Pro" },
  { id: "flux-anime",       label: "Flux Anime" },
  { id: "flux-3d",          label: "Flux 3D" },
  { id: "any-dark",         label: "Any Dark" },
  { id: "gptimage",         label: "GPT Image" },
  { id: "dall-e-3",         label: "DALL-E 3" },
  { id: "stable-diffusion", label: "Stable Diffusion" },
  { id: "playground-v25",   label: "Playground v2.5" },
  { id: "sana",             label: "Sana" },
];

function buildUrl(
  prompt: string,
  w: number, h: number,
  model: string,
  seed: number,
  nsfw: boolean,
  enhance: boolean,
  refImageUrl?: string,
) {
  const p = encodeURIComponent(prompt.trim());
  const safe = nsfw ? "false" : "true";
  let url = `https://image.pollinations.ai/prompt/${p}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&safe=${safe}&enhance=${enhance}`;
  if (refImageUrl && refImageUrl.trim()) {
    url += `&image=${encodeURIComponent(refImageUrl.trim())}`;
  }
  return url;
}

export function AIPage() {
  const [prompt, setPrompt]         = useState("");
  const [sizeIdx, setSizeIdx]       = useState(0);
  const [selectedModel, setSelectedModel] = useState("flux");
  const [customModel, setCustomModel]     = useState("");
  const [nsfw, setNsfw]             = useState(false);
  const [enhance, setEnhance]       = useState(false);
  const [seed, setSeed]             = useState(() => Math.floor(Math.random() * 999999));
  const [imgUrl, setImgUrl]         = useState<string | null>(null);
  const [loading, setLoading]       = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [apiModels, setApiModels]   = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  // Reference image state
  const [refMode, setRefMode]       = useState<"url" | "upload">("url");
  const [refUrl, setRefUrl]         = useState("");
  const [refPreview, setRefPreview] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Fetch live model list from Pollinations on mount — use as supplement to built-ins
  useEffect(() => {
    async function fetchModels() {
      try {
        const res = await fetch("https://image.pollinations.ai/models");
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            const ids: string[] = data.map((m: any) =>
              typeof m === "string" ? m : (m.name ?? m.id ?? String(m))
            );
            // Only use API list if it has meaningful coverage (> 3 models)
            // Otherwise fall back to the built-in list
            if (ids.length > 3) {
              setApiModels(ids);
              setSelectedModel(ids[0]);
            }
          }
        }
      } catch {}
      setModelsLoading(false);
    }
    fetchModels();
  }, []);

  // Merged model list: built-ins first, then any extra from API not in built-ins
  const builtinIds = new Set(BUILTIN_MODELS.map(m => m.id));
  const extraApiModels = apiModels.filter(id => !builtinIds.has(id));
  const allModels: { id: string; label: string }[] = [
    ...BUILTIN_MODELS,
    ...extraApiModels.map(id => ({ id, label: id })),
  ];

  const activeModel = customModel.trim() || selectedModel;
  const size = SIZES[sizeIdx];
  const activeRefUrl = refMode === "url" ? refUrl : "";

  const generate = useCallback(() => {
    if (!prompt.trim()) return;
    const newSeed = Math.floor(Math.random() * 999999);
    setSeed(newSeed);
    setError(null);
    setLoading(true);
    setImgUrl(buildUrl(prompt, size.w, size.h, activeModel, newSeed, nsfw, enhance, activeRefUrl));
  }, [prompt, size, activeModel, nsfw, enhance, activeRefUrl]);

  const regenerate = useCallback(() => {
    if (!prompt.trim()) return;
    const newSeed = Math.floor(Math.random() * 999999);
    setSeed(newSeed);
    setError(null);
    setLoading(true);
    setImgUrl(buildUrl(prompt, size.w, size.h, activeModel, newSeed, nsfw, enhance, activeRefUrl));
  }, [prompt, size, activeModel, nsfw, enhance, activeRefUrl]);

  async function handleSave() {
    if (!imgUrl) return;
    try {
      const res = await fetch(imgUrl);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `equinox-ai-${seed}.jpg`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Failed to save image.");
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
      setRefPreview(ev.target?.result as string);
    };
    reader.readAsDataURL(file);
  }

  function clearRef() {
    setRefUrl("");
    setRefPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  const hasRef = refMode === "url" ? refUrl.trim().length > 0 : refPreview !== null;

  return (
    <AppLayout>
      <div className="p-6 max-w-4xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center gap-3">
          <Sparkles className="w-5 h-5 text-primary" />
          <h1 className="text-xl font-bold text-foreground">AI Studio</h1>
          <span className="text-xs text-muted-foreground ml-auto">Pollinations · No setup required</span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_260px] gap-5">

          {/* Left: prompt + generate */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Prompt</Label>
              <Textarea
                placeholder="A photorealistic portrait of a woman, studio lighting, sharp focus..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) generate(); }}
                className="h-32 resize-none text-sm"
              />
              <p className="text-[10px] text-muted-foreground">Ctrl+Enter to generate</p>
            </div>

            {/* Reference Image */}
            <div className="space-y-2 border border-border rounded-lg p-3 bg-card/40">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Reference Image
                  {hasRef && <span className="ml-2 text-primary text-[10px] font-normal normal-case">● active</span>}
                </Label>
                <div className="flex gap-1">
                  <button
                    onClick={() => setRefMode("url")}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      refMode === "url"
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Link className="inline w-2.5 h-2.5 mr-1" />URL
                  </button>
                  <button
                    onClick={() => setRefMode("upload")}
                    className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
                      refMode === "upload"
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    <Upload className="inline w-2.5 h-2.5 mr-1" />Upload
                  </button>
                  {hasRef && (
                    <button onClick={clearRef} className="text-[10px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:text-red-400 transition-colors">
                      <X className="inline w-2.5 h-2.5" />
                    </button>
                  )}
                </div>
              </div>

              {refMode === "url" ? (
                <Input
                  placeholder="https://example.com/my-image.jpg"
                  value={refUrl}
                  onChange={e => setRefUrl(e.target.value)}
                  className="text-xs h-8"
                />
              ) : (
                <div className="space-y-2">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                    id="ref-image-input"
                  />
                  {refPreview ? (
                    <div className="relative">
                      <img
                        src={refPreview}
                        alt="Reference"
                        className="w-full max-h-32 object-contain rounded border border-border bg-muted/30"
                      />
                      <p className="text-[10px] text-muted-foreground mt-1">
                        Local preview only. Paste a public URL above to use as generation reference.
                      </p>
                    </div>
                  ) : (
                    <label
                      htmlFor="ref-image-input"
                      className="flex flex-col items-center justify-center gap-1.5 border border-dashed border-border rounded-md py-4 cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors"
                    >
                      <Upload className="w-4 h-4 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">Click to pick a reference image</span>
                    </label>
                  )}
                </div>
              )}
            </div>

            {/* Toggles */}
            <div className="flex gap-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div onClick={() => setNsfw(v => !v)}
                  className={`w-9 h-5 rounded-full transition-colors relative ${nsfw ? "bg-red-500" : "bg-muted"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${nsfw ? "translate-x-4" : "translate-x-0.5"}`} />
                </div>
                <span className="text-xs text-muted-foreground">NSFW</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <div onClick={() => setEnhance(v => !v)}
                  className={`w-9 h-5 rounded-full transition-colors relative ${enhance ? "bg-primary" : "bg-muted"}`}>
                  <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${enhance ? "translate-x-4" : "translate-x-0.5"}`} />
                </div>
                <span className="text-xs text-muted-foreground">Enhance prompt</span>
              </label>
            </div>

            <Button className="w-full h-11 font-semibold" onClick={generate} disabled={!prompt.trim() || loading}>
              {loading
                ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
                : <><Sparkles className="w-4 h-4 mr-2" /> Generate</>}
            </Button>

            {error && (
              <p className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded p-2">{error}</p>
            )}
          </div>

          {/* Right: settings */}
          <div className="space-y-4">

            {/* Model */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Model {modelsLoading && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}
                </Label>
                <span className="text-[10px] text-muted-foreground">{allModels.length} available</span>
              </div>
              <select
                value={customModel ? "__custom__" : selectedModel}
                onChange={e => {
                  if (e.target.value === "__custom__") return;
                  setCustomModel("");
                  setSelectedModel(e.target.value);
                }}
                className="w-full text-xs px-3 py-2 rounded-md border border-border bg-card text-foreground"
              >
                {allModels.map(m => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
                {customModel && <option value="__custom__">✎ {customModel}</option>}
              </select>

              {/* Custom model input */}
              <div className="relative">
                <Input
                  placeholder="Or type any model name from pollinations.ai…"
                  value={customModel}
                  onChange={e => setCustomModel(e.target.value)}
                  className="text-xs pr-7 h-8"
                />
                {customModel && (
                  <button onClick={() => setCustomModel("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <RotateCcw className="w-3 h-3" />
                  </button>
                )}
              </div>
              {customModel && (
                <p className="text-[10px] text-primary">Using custom model: <span className="font-mono">{customModel}</span></p>
              )}
            </div>

            {/* Size */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Size</Label>
              <div className="space-y-1">
                {SIZES.map((s, i) => (
                  <button key={i} onClick={() => setSizeIdx(i)}
                    className={`w-full text-left text-xs px-3 py-1.5 rounded-md border transition-colors font-mono ${
                      sizeIdx === i
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground"
                    }`}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Seed */}
            <div className="space-y-1">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Seed: <span className="text-foreground font-mono">{seed}</span>
              </Label>
              <Button variant="outline" size="sm" className="w-full text-xs"
                onClick={() => setSeed(Math.floor(Math.random() * 999999))}>
                Random seed
              </Button>
            </div>

          </div>
        </div>

        {/* Result */}
        {imgUrl && (
          <div className="border border-border rounded-lg overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-card/50">
              <span className="text-xs font-medium text-muted-foreground">Result · <span className="font-mono">{activeModel}</span></span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={regenerate} disabled={loading}>
                  <RefreshCw className="w-3.5 h-3.5 mr-1.5" />Re-roll
                </Button>
                <Button variant="outline" size="sm" onClick={handleSave} disabled={loading}>
                  <Download className="w-3.5 h-3.5 mr-1.5" />Save
                </Button>
              </div>
            </div>
            <div className="relative bg-muted/20">
              {loading && (
                <div className="absolute inset-0 flex items-center justify-center bg-background/60 z-10">
                  <div className="text-center space-y-2">
                    <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
                    <p className="text-sm text-muted-foreground">Generating...</p>
                  </div>
                </div>
              )}
              <img
                key={imgUrl}
                src={imgUrl}
                alt="Generated"
                className="w-full object-contain max-h-[600px]"
                onLoad={() => setLoading(false)}
                onError={() => {
                  setLoading(false);
                  setError("Generation failed — model may be unavailable or busy. Try a different model (Flux or Turbo are most reliable).");
                  setImgUrl(null);
                }}
              />
            </div>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
