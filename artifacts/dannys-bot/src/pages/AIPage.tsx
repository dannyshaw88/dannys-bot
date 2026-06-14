import { useState, useCallback, useEffect } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Download, Sparkles, RefreshCw, Loader2, RotateCcw } from "lucide-react";

const SIZES = [
  { label: "Portrait  512×768",  w: 512,  h: 768  },
  { label: "Square    512×512",  w: 512,  h: 512  },
  { label: "Landscape 768×512",  w: 768,  h: 512  },
  { label: "Tall      512×896",  w: 512,  h: 896  },
  { label: "Wide      896×512",  w: 896,  h: 512  },
  { label: "HD        768×1024", w: 768,  h: 1024 },
  { label: "HD Wide   1024×768", w: 1024, h: 768  },
];

function buildUrl(prompt: string, w: number, h: number, model: string, seed: number, nsfw: boolean, enhance: boolean) {
  const p = encodeURIComponent(prompt.trim());
  const safe = nsfw ? "false" : "true";
  return `https://image.pollinations.ai/prompt/${p}?width=${w}&height=${h}&seed=${seed}&model=${model}&nologo=true&safe=${safe}&enhance=${enhance}`;
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

  // Fetch live model list from Pollinations on mount
  useEffect(() => {
    async function fetchModels() {
      try {
        const res = await fetch("https://image.pollinations.ai/models");
        if (res.ok) {
          const data: string[] = await res.json();
          if (Array.isArray(data) && data.length > 0) {
            setApiModels(data);
            setSelectedModel(data[0]);
          }
        }
      } catch {}
      setModelsLoading(false);
    }
    fetchModels();
  }, []);

  const activeModel = customModel.trim() || selectedModel;
  const size = SIZES[sizeIdx];

  const generate = useCallback(() => {
    if (!prompt.trim()) return;
    const newSeed = Math.floor(Math.random() * 999999);
    setSeed(newSeed);
    setError(null);
    setLoading(true);
    setImgUrl(buildUrl(prompt, size.w, size.h, activeModel, newSeed, nsfw, enhance));
  }, [prompt, size, activeModel, nsfw, enhance]);

  const regenerate = useCallback(() => {
    if (!prompt.trim()) return;
    const newSeed = Math.floor(Math.random() * 999999);
    setSeed(newSeed);
    setError(null);
    setLoading(true);
    setImgUrl(buildUrl(prompt, size.w, size.h, activeModel, newSeed, nsfw, enhance));
  }, [prompt, size, activeModel, nsfw, enhance]);

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

            {/* Model — live list from API */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                  Model {modelsLoading && <Loader2 className="inline w-3 h-3 animate-spin ml-1" />}
                </Label>
                {apiModels.length > 0 && (
                  <span className="text-[10px] text-muted-foreground">{apiModels.length} available</span>
                )}
              </div>
              <select
                value={customModel ? "__custom__" : selectedModel}
                onChange={e => {
                  if (e.target.value === "__custom__") return;
                  setCustomModel("");
                  setSelectedModel(e.target.value);
                }}
                disabled={modelsLoading}
                className="w-full text-xs px-3 py-2 rounded-md border border-border bg-card text-foreground disabled:opacity-50"
              >
                {apiModels.length === 0 && !modelsLoading && (
                  <option value="">-- no models returned --</option>
                )}
                {apiModels.map(m => (
                  <option key={m} value={m}>{m}</option>
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
                onError={() => { setLoading(false); setError("Generation failed — model may be unavailable, try a different one."); setImgUrl(null); }}
              />
            </div>
          </div>
        )}

      </div>
    </AppLayout>
  );
}
