import { useState, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Loader2, Download, Sparkles, ChevronDown, ChevronUp, Zap } from "lucide-react";

const SIZES = [
  { label: "Portrait (512×768)", w: 512, h: 768 },
  { label: "Square (512×512)", w: 512, h: 512 },
  { label: "Landscape (768×512)", w: 768, h: 512 },
  { label: "Tall (512×896)", w: 512, h: 896 },
  { label: "Wide (896×512)", w: 896, h: 512 },
];

const SAMPLERS = [
  "DPM++ 2M Karras",
  "DPM++ SDE Karras",
  "Euler a",
  "Euler",
  "DDIM",
];

async function checkStatus(): Promise<{ running: boolean; model?: string }> {
  const res = await fetch("/api/ai/status");
  if (!res.ok) return { running: false };
  return res.json();
}

async function generateImage(payload: {
  prompt: string;
  negativePrompt: string;
  width: number;
  height: number;
  steps: number;
  cfgScale: number;
  sampler: string;
}): Promise<{ image: string }> {
  const res = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error ?? `Server error ${res.status}`);
  }
  return res.json();
}

export function AIPage() {
  const [prompt, setPrompt] = useState("");
  const [negPrompt, setNegPrompt] = useState("ugly, deformed, blurry, low quality, watermark, text, bad anatomy");
  const [sizeIdx, setSizeIdx] = useState(0);
  const [steps, setSteps] = useState(25);
  const [cfg, setCfg] = useState(7);
  const [sampler, setSampler] = useState(SAMPLERS[0]);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [showSetup, setShowSetup] = useState(false);
  const [showNeg, setShowNeg] = useState(false);
  const imgRef = useRef<HTMLAnchorElement>(null);

  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ["ai-status"],
    queryFn: checkStatus,
    refetchInterval: 8000,
  });

  const mutation = useMutation({
    mutationFn: generateImage,
    onSuccess: (data) => {
      setGeneratedImage(data.image);
    },
  });

  const isConnected = status?.running === true;
  const size = SIZES[sizeIdx];

  function handleGenerate() {
    if (!prompt.trim()) return;
    mutation.mutate({
      prompt: prompt.trim(),
      negativePrompt: negPrompt.trim(),
      width: size.w,
      height: size.h,
      steps,
      cfgScale: cfg,
      sampler,
    });
  }

  function handleSave() {
    if (!generatedImage) return;
    const a = document.createElement("a");
    a.href = `data:image/png;base64,${generatedImage}`;
    a.download = `equinox-ai-${Date.now()}.png`;
    a.click();
  }

  return (
    <AppLayout>
      <div className="p-6 max-w-4xl mx-auto space-y-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold text-foreground">AI Studio</h1>
          </div>
          <div className="flex items-center gap-3">
            <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs font-medium ${
              isConnected
                ? "border-green-500/40 bg-green-500/10 text-green-400"
                : "border-red-500/40 bg-red-500/10 text-red-400"
            }`}>
              <span className={`w-1.5 h-1.5 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`} />
              {isConnected ? `Connected${status?.model ? ` — ${status.model.slice(0, 30)}` : ""}` : "Not connected"}
            </div>
            <Button variant="outline" size="sm" onClick={() => refetchStatus()}>
              Refresh
            </Button>
          </div>
        </div>

        {/* Setup Guide */}
        <div className="border border-border rounded-lg overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-foreground hover:bg-accent/50 transition-colors"
            onClick={() => setShowSetup(v => !v)}
          >
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              <span>Setup Guide — 3 steps to get running locally</span>
              {!isConnected && <Badge variant="outline" className="text-yellow-400 border-yellow-500/40 text-[10px]">Required</Badge>}
            </div>
            {showSetup ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>

          {showSetup && (
            <div className="px-4 pb-4 pt-1 space-y-4 bg-card/50 border-t border-border">
              <div className="space-y-3">

                <div className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">1</span>
                  <div>
                    <p className="text-sm font-medium text-foreground">Install Python 3.10 or 3.11</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Go to <span className="text-primary font-mono">python.org/downloads</span> → download <strong className="text-foreground">Python 3.10.x or 3.11.x</strong> (not 3.12+)
                    </p>
                    <div className="mt-1.5 bg-yellow-500/10 border border-yellow-500/30 rounded px-2 py-1.5">
                      <p className="text-xs text-yellow-400 font-medium">⚠ On the installer's first screen — tick "Add Python to PATH" before clicking Install</p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-1">Do NOT install Python from the Microsoft Store — use python.org only.</p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">2</span>
                  <div>
                    <p className="text-sm font-medium text-foreground">Install Git for Windows</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Go to <span className="text-primary font-mono">git-scm.com</span> → download and install with default options. Forge uses git to manage itself.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">3</span>
                  <div>
                    <p className="text-sm font-medium text-foreground">Run webui-user.bat in your Forge folder</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Double-click <span className="font-mono bg-muted px-1 rounded">webui-user.bat</span> — first run downloads ~5 GB of dependencies automatically. Leave the CMD window open.
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      When it's ready it will say <span className="font-mono bg-muted px-1 rounded">Running on local URL: http://127.0.0.1:7860</span> — then come back here, the status badge will turn green.
                    </p>
                  </div>
                </div>

                <div className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-primary/20 text-primary text-xs font-bold flex items-center justify-center">4</span>
                  <div>
                    <p className="text-sm font-medium text-foreground">Download a model from CivitAI</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Search <span className="font-mono bg-muted px-1 rounded">"Realistic Vision v6"</span> or <span className="font-mono bg-muted px-1 rounded">"epiCRealism"</span> on civitai.com → download the <strong className="text-foreground">.safetensors</strong> file → place it in your <span className="font-mono bg-muted px-1 rounded">stable-diffusion-webui-forge-main/models/Stable-diffusion/</span> folder
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Your GTX 1050 (4GB) runs SD 1.5 models well — avoid SDXL models (too large for 4GB VRAM).
                    </p>
                  </div>
                </div>

              </div>
              <div className="bg-muted/50 rounded-md p-3 text-xs text-muted-foreground">
                <strong className="text-foreground">No content filters.</strong> Everything runs on your PC — nothing is sent to any server. SFW and NSFW generation both work.
              </div>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_280px] gap-5">

          {/* Left: Prompt + Controls */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-sm font-medium">Prompt</Label>
              <Textarea
                placeholder="A photorealistic portrait of a woman, studio lighting, sharp focus, 8k..."
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                className="h-28 resize-none text-sm"
              />
            </div>

            <div>
              <button
                className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 mb-1.5"
                onClick={() => setShowNeg(v => !v)}
              >
                {showNeg ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                Negative prompt
              </button>
              {showNeg && (
                <Textarea
                  placeholder="ugly, deformed, blurry..."
                  value={negPrompt}
                  onChange={e => setNegPrompt(e.target.value)}
                  className="h-16 resize-none text-sm"
                />
              )}
            </div>

            <Button
              className="w-full h-11 text-sm font-semibold"
              onClick={handleGenerate}
              disabled={mutation.isPending || !isConnected || !prompt.trim()}
            >
              {mutation.isPending ? (
                <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Generating...</>
              ) : (
                <><Sparkles className="w-4 h-4 mr-2" /> Generate Image</>
              )}
            </Button>

            {!isConnected && (
              <p className="text-xs text-center text-muted-foreground">
                Follow the setup guide above to connect Stable Diffusion
              </p>
            )}

            {mutation.isError && (
              <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/20 rounded-md p-2">
                {(mutation.error as Error)?.message ?? "Generation failed"}
              </div>
            )}
          </div>

          {/* Right: Settings */}
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Size</Label>
              <div className="space-y-1">
                {SIZES.map((s, i) => (
                  <button
                    key={i}
                    onClick={() => setSizeIdx(i)}
                    className={`w-full text-left text-xs px-3 py-2 rounded-md border transition-colors ${
                      sizeIdx === i
                        ? "border-primary/60 bg-primary/10 text-primary"
                        : "border-border bg-card text-muted-foreground hover:text-foreground hover:border-border/80"
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                Steps: <span className="text-foreground">{steps}</span>
              </Label>
              <Slider
                min={10} max={50} step={1}
                value={[steps]}
                onValueChange={([v]) => setSteps(v)}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>10 (fast)</span><span>50 (quality)</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                CFG Scale: <span className="text-foreground">{cfg}</span>
              </Label>
              <Slider
                min={1} max={15} step={0.5}
                value={[cfg]}
                onValueChange={([v]) => setCfg(v)}
                className="w-full"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>1 (creative)</span><span>15 (strict)</span>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Sampler</Label>
              <select
                value={sampler}
                onChange={e => setSampler(e.target.value)}
                className="w-full text-xs px-3 py-2 rounded-md border border-border bg-card text-foreground"
              >
                {SAMPLERS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
          </div>
        </div>

        {/* Result */}
        {(generatedImage || mutation.isPending) && (
          <div className="border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <Label className="text-sm font-medium">Result</Label>
              {generatedImage && (
                <Button variant="outline" size="sm" onClick={handleSave}>
                  <Download className="w-3.5 h-3.5 mr-1.5" />
                  Save to PC
                </Button>
              )}
            </div>

            {mutation.isPending ? (
              <div className="flex items-center justify-center h-48 bg-muted/30 rounded-md">
                <div className="text-center space-y-2">
                  <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto" />
                  <p className="text-sm text-muted-foreground">Generating on your GPU...</p>
                </div>
              </div>
            ) : generatedImage ? (
              <img
                src={`data:image/png;base64,${generatedImage}`}
                alt="Generated"
                className="w-full rounded-md object-contain max-h-[600px]"
              />
            ) : null}
          </div>
        )}

        <a ref={imgRef} className="hidden" />
      </div>
    </AppLayout>
  );
}
