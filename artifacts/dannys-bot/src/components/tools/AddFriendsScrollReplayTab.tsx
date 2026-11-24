import { useEffect, useRef, useState, type PointerEvent } from "react";
import { AlertCircle, CheckCircle2, FileCode2, ImageUp, Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type CropRect = { left: number; top: number; width: number; height: number };
type ReplayResult = {
  result: string;
  mode: string;
  dimensions: string;
  expectedNext: string;
  expectedTop: number;
  actualTop: number;
  preActionAlignment?: boolean;
  simulatedMovementScale?: number;
  swipes: Array<{ x1: number; y1: number; x2: number; y2: number; durationMs: number }>;
  logs: string[];
};

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function normalizeUiDump(value: string): string {
  if (/<node\b/.test(value)) return value;
  const nodes = value.split(/\r?\n/).flatMap(line => {
    const bounds = line.match(/\[\d+,\d+\]\[\d+,\d+\]/)?.[0];
    if (!bounds || !/\bclickable=(?:true|false)\b/.test(line)) return [];
    const attr = (name: string) => line.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? "";
    const className = line.match(
      /\bfocused=(?:true|false)\s+(.+?)(?=\s+(?:id|desc|text)="|\s+\[\d+,\d+\]\[\d+,\d+\])/,
    )?.[1]?.trim() ?? "";
    return [`<node text="${escapeXml(attr("text"))}" content-desc="${escapeXml(attr("desc"))}" resource-id="${escapeXml(attr("id"))}" class="${escapeXml(className)}" clickable="${/\bclickable=true\b/.test(line)}" bounds="${bounds}"/>`];
  });
  return nodes.length ? `<hierarchy>${nodes.join("")}</hierarchy>` : value;
}

function inferScreenSize(xml: string): { width: number; height: number } | null {
  const bounds = [...xml.matchAll(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g)]
    .map(match => ({
      left: Number(match[1]),
      top: Number(match[2]),
      right: Number(match[3]),
      bottom: Number(match[4]),
    }));
  const root = bounds.filter(rect => rect.left === 0 && rect.top === 0)
    .sort((a, b) => b.right * b.bottom - a.right * a.bottom)[0];
  if (root) return { width: root.right, height: root.bottom };
  if (bounds.length === 0) return null;
  return {
    width: Math.max(...bounds.map(rect => rect.right)),
    height: Math.max(...bounds.map(rect => rect.bottom)),
  };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read screenshot."));
    reader.onerror = () => reject(new Error("Could not read screenshot."));
    reader.readAsDataURL(file);
  });
}

function diagnoseCycleLog(value: string): string[] {
  if (!value.trim()) return [];
  const findings: string[] = [];
  const cards = [...value.matchAll(
    /after adding ([^\r\n,]+), divider measurement was unavailable[^\r\n]*card bounds=(-?\d+),(-?\d+),(-?\d+),(-?\d+)[^\r\n]*/gi,
  )];
  const card = cards.at(-1);
  const final = value.match(
    /after three movement-scaled corrections,[^\r\n]+ at y=(-?\d+) \(target y=(-?\d+); residual (-?\d+)px\)/i,
  );
  if (card && final) {
    const cardTop = Number(card[2]);
    const intendedTop = Number(final[2]);
    const gap = cardTop - intendedTop;
    if (Math.abs(gap) > 80) {
      findings.push(
        `The post-action card was at y=${cardTop}, but the routine aimed the next contact at y=${intendedTop} ` +
        `(${Math.abs(gap)}px apart). The chosen contact had not first been brought to the top before its action.`,
      );
    }
  }
  const movementPattern =
    /the previous (\d+)px swipe moved content (-?\d+)px; sending correction \d+ of 3 for (\d+)px to move ([^\r\n]+?) to the top\./gi;
  const targetName = final?.[0].match(/corrections, (.+?) is still at y=/i)?.[1]?.trim();
  const movements = [...value.matchAll(movementPattern)].filter(movement =>
    !targetName || movement[4].trim() === targetName,
  );
  if (movements.length) {
    findings.push("Observed correction sequence (swipe distance → measured list movement):");
    for (const movement of movements) {
      findings.push(`• ${movement[1]}px → ${movement[2]}px; next correction was ${movement[3]}px.`);
    }
    if (movements.some(movement => Number(movement[2]) < 0)) {
      findings.push(
        "A negative measured movement means the contact moved back down the screen during a correction; " +
        "that reversal is why the list appeared to scroll backwards.",
      );
    }
  }
  if (findings.length === 0) {
    findings.push("No Add Friends row-position or correction-movement sequence was found in this log.");
  }
  return findings;
}

export function AddFriendsScrollReplayTab() {
  const imageRef = useRef<HTMLImageElement>(null);
  const [screenshot, setScreenshot] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [uiXml, setUiXml] = useState("");
  const [cycleLog, setCycleLog] = useState("");
  const [crop, setCrop] = useState<CropRect | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(null);
  const [screenWidth, setScreenWidth] = useState("720");
  const [screenHeight, setScreenHeight] = useState("1600");
  const [friendName, setFriendName] = useState("");
  const [alignBeforeAction, setAlignBeforeAction] = useState(true);
  const [previousCenterY, setPreviousCenterY] = useState("");
  const [rowHeight, setRowHeight] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<ReplayResult | null>(null);
  const cycleLogDiagnosis = diagnoseCycleLog(cycleLog);

  useEffect(() => {
    if (!screenshot) {
      setImageUrl("");
      return;
    }
    const url = URL.createObjectURL(screenshot);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot]);

  useEffect(() => {
    const inferred = inferScreenSize(normalizeUiDump(uiXml));
    if (!inferred) return;
    setScreenWidth(String(inferred.width));
    setScreenHeight(String(inferred.height));
  }, [uiXml]);

  const loadUiDump = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("The UI dump must be under 2 MB.");
      return;
    }
    setUiXml(await file.text());
    setError("");
  };

  const loadCycleLog = async (file?: File) => {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setError("The cycle log must be under 2 MB.");
      return;
    }
    setCycleLog(await file.text());
    setError("");
  };

  const pointerPoint = (event: PointerEvent<HTMLImageElement>) => {
    const image = imageRef.current;
    if (!image) return null;
    const rect = image.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(image.naturalWidth, (event.clientX - rect.left) * image.naturalWidth / rect.width)),
      y: Math.max(0, Math.min(image.naturalHeight, (event.clientY - rect.top) * image.naturalHeight / rect.height)),
    };
  };

  const beginCrop = (event: PointerEvent<HTMLImageElement>) => {
    const point = pointerPoint(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart(point);
    setCrop({ left: point.x, top: point.y, width: 1, height: 1 });
  };

  const updateCrop = (event: PointerEvent<HTMLImageElement>) => {
    if (!dragStart) return;
    const point = pointerPoint(event);
    if (!point) return;
    setCrop({
      left: Math.min(dragStart.x, point.x),
      top: Math.min(dragStart.y, point.y),
      width: Math.abs(point.x - dragStart.x),
      height: Math.abs(point.y - dragStart.y),
    });
  };

  const finishCrop = (event: PointerEvent<HTMLImageElement>) => {
    updateCrop(event);
    setDragStart(null);
  };

  const cropStyle = () => {
    const image = imageRef.current;
    if (!image || !crop || image.naturalWidth === 0 || image.naturalHeight === 0) return undefined;
    return {
      left: `${crop.left / image.naturalWidth * 100}%`,
      top: `${crop.top / image.naturalHeight * 100}%`,
      width: `${crop.width / image.naturalWidth * 100}%`,
      height: `${crop.height / image.naturalHeight * 100}%`,
    };
  };

  const runReplay = async (regressionFixture = false) => {
    if (!regressionFixture && (!screenshot || !uiXml.trim())) {
      setError("Choose a screenshot and its matching UIAutomator XML dump.");
      return;
    }
    const normalizedUiXml = regressionFixture ? "" : normalizeUiDump(uiXml);
    if (!regressionFixture && screenshot && screenshot.size > 20 * 1024 * 1024) {
      setError("The screenshot must be under 20 MB.");
      return;
    }
    if (!regressionFixture && crop && (crop.width < 30 || crop.height < 60)) {
      setError("Drag a larger crop around the phone display, or choose the full image.");
      return;
    }
    setRunning(true);
    setError("");
    setResult(null);
    try {
      const imageBase64 = regressionFixture ? undefined : await readAsDataUrl(screenshot!);
      const response = await fetch("/api/debug/add-friends-scroll-replay", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(regressionFixture
          ? { regressionFixture: true }
          : {
            imageBase64,
            uiXml: normalizedUiXml,
            screenWidth: Number(screenWidth),
            screenHeight: Number(screenHeight),
            alignBeforeAction,
            crop: crop ? {
              left: Math.floor(crop.left),
              top: Math.floor(crop.top),
              width: Math.max(1, Math.floor(crop.width)),
              height: Math.max(1, Math.floor(crop.height)),
            } : null,
            friendName: friendName.trim() || undefined,
            previousCenterY: previousCenterY ? Number(previousCenterY) : undefined,
            rowHeight: rowHeight ? Number(rowHeight) : undefined,
          }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Replay failed.");
      setResult(payload as ReplayResult);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Replay failed.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Add Friends Scroll Replay</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Run the real scroll decision against a saved screen and UI dump. Swipes are recorded by a fake device;
          nothing is sent to a phone. Files are temporary and deleted after the replay.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1.2fr)_minmax(320px,0.8fr)]">
        <section className="desktop-card space-y-4 p-5">
          <h3 className="font-semibold">1. Load the capture</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="scroll-replay-image">Screen screenshot</Label>
              <Input
                id="scroll-replay-image"
                data-testid="input-scroll-replay-image"
                type="file"
                accept="image/png,image/jpeg,image/webp"
                onChange={event => {
                  setScreenshot(event.target.files?.[0] ?? null);
                  setCrop(null);
                  setResult(null);
                  setError("");
                }}
              />
              <p className="text-xs text-muted-foreground">PNG, JPEG, or WebP; maximum 20 MB.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="scroll-replay-xml">Matching UI dump (XML or Inspect text)</Label>
              <Input
                id="scroll-replay-xml"
                data-testid="input-scroll-replay-xml"
                type="file"
                accept=".xml,.txt,text/plain,application/xml"
                onChange={event => void loadUiDump(event.target.files?.[0])}
              />
              <p className="text-xs text-muted-foreground">Phone Farm → Inspect → Dump All downloads the tree text.</p>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="scroll-replay-log">Phone Farm run log (optional)</Label>
              <Input
                id="scroll-replay-log"
                data-testid="input-scroll-replay-log"
                type="file"
                accept=".txt,.log,text/plain"
                onChange={event => void loadCycleLog(event.target.files?.[0])}
              />
              <p className="text-xs text-muted-foreground">The log analysis shows measured row positions and direction reversals.</p>
            </div>
          </div>

          {imageUrl && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label>Drag over the phone display to crop it</Label>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  data-testid="button-scroll-replay-full-image"
                  onClick={() => {
                    const image = imageRef.current;
                    if (image) setCrop({ left: 0, top: 0, width: image.naturalWidth, height: image.naturalHeight });
                  }}
                >
                  Use full image
                </Button>
              </div>
              <div className="max-w-full overflow-auto rounded-lg border border-border bg-muted/30 p-2">
                <div className="relative inline-block max-w-full">
                  <img
                    ref={imageRef}
                    src={imageUrl}
                    alt="Screenshot to replay"
                    data-testid="image-scroll-replay-source"
                    draggable={false}
                    className="block max-h-[520px] max-w-full w-auto select-none touch-none"
                    onPointerDown={beginCrop}
                    onPointerMove={updateCrop}
                    onPointerUp={finishCrop}
                    onPointerCancel={() => setDragStart(null)}
                    onLoad={() => setCrop(null)}
                  />
                  {crop && (
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute border-2 border-cyan-400 bg-cyan-300/10"
                      style={cropStyle()}
                    />
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                The crop rectangle is shown in cyan. For an already-cropped phone screenshot, choose “Use full image.”
              </p>
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="scroll-replay-xml-text">UI dump contents</Label>
            <textarea
              id="scroll-replay-xml-text"
              data-testid="textarea-scroll-replay-xml"
              value={uiXml}
              onChange={event => setUiXml(event.target.value)}
              placeholder="Upload/paste XML or the text from Phone Farm → Inspect → Dump All"
              className="min-h-36 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              spellCheck={false}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="scroll-replay-log-text">Run log contents</Label>
            <textarea
              id="scroll-replay-log-text"
              data-testid="textarea-scroll-replay-log"
              value={cycleLog}
              onChange={event => setCycleLog(event.target.value)}
              placeholder="Upload or paste the run log around the Add Friends actions"
              className="min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              spellCheck={false}
            />
          </div>
          {cycleLog.trim() && (
            <div data-testid="status-scroll-replay-log-diagnosis" className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
              <p className="font-semibold">Run-log finding</p>
              {cycleLogDiagnosis.map((finding, index) => (
                <p key={index} className="text-muted-foreground">{finding}</p>
              ))}
            </div>
          )}
        </section>

        <section className="desktop-card space-y-4 p-5">
          <h3 className="font-semibold">2. Replay the scroll</h3>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="scroll-replay-width">Screen width</Label>
              <Input id="scroll-replay-width" data-testid="input-scroll-replay-width" type="number" min="100" value={screenWidth} onChange={event => setScreenWidth(event.target.value)} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="scroll-replay-height">Screen height</Label>
              <Input id="scroll-replay-height" data-testid="input-scroll-replay-height" type="number" min="100" value={screenHeight} onChange={event => setScreenHeight(event.target.value)} />
            </div>
            <div className="col-span-2 space-y-2">
              <Label htmlFor="scroll-replay-friend">Contact selected for this replay (optional)</Label>
              <Input id="scroll-replay-friend" data-testid="input-scroll-replay-friend" value={friendName} onChange={event => setFriendName(event.target.value)} placeholder="e.g. the contact whose Add row is shown" />
            </div>
            <label className="col-span-2 flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                data-testid="checkbox-scroll-replay-align-first"
                checked={alignBeforeAction}
                onChange={event => setAlignBeforeAction(event.target.checked)}
              />
              Bring the selected contact to the top before the action
            </label>
            <details className="col-span-2 rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">Position overrides</summary>
              <div className="mt-3 grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="scroll-replay-center-y">Previous row center Y</Label>
                  <Input id="scroll-replay-center-y" data-testid="input-scroll-replay-center-y" type="number" value={previousCenterY} onChange={event => setPreviousCenterY(event.target.value)} placeholder="Auto" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="scroll-replay-row-height">Previous row height</Label>
                  <Input id="scroll-replay-row-height" data-testid="input-scroll-replay-row-height" type="number" min="1" value={rowHeight} onChange={event => setRowHeight(event.target.value)} placeholder="Auto" />
                </div>
              </div>
            </details>
          </div>

          <Button
            type="button"
            data-testid="button-run-scroll-replay"
            className="w-full"
            onClick={() => void runReplay()}
            disabled={running || !screenshot || !uiXml.trim()}
          >
            {running ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Play className="mr-2 h-4 w-4" />}
            {running ? "Running replay…" : "Run scroll replay"}
          </Button>
          <Button
            type="button"
            variant="outline"
            data-testid="button-run-add-friends-regression"
            className="w-full"
            onClick={() => void runReplay(true)}
            disabled={running}
          >
            Run logged 4th-add regression
          </Button>

          {error && (
            <div role="alert" data-testid="status-scroll-replay-error" className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {result && (
            <div data-testid="status-scroll-replay-result" className="space-y-3 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-4">
              <div className="flex items-center gap-2 font-semibold text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" />
                Replay passed
              </div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <span className="text-muted-foreground">Next contact</span><span>{result.expectedNext}</span>
                <span className="text-muted-foreground">Expected top</span><span>{result.expectedTop}px</span>
                <span className="text-muted-foreground">Simulated top</span><span>{result.actualTop}px</span>
                <span className="text-muted-foreground">Swipes sent</span><span>{result.swipes.length}</span>
                <span className="text-muted-foreground">Input mode</span><span>{result.mode}</span>
                <span className="text-muted-foreground">Aligned before action</span><span>{result.preActionAlignment ? "Yes" : "No"}</span>
                <span className="text-muted-foreground">Simulated list response</span><span>{result.simulatedMovementScale ?? 1}× finger travel</span>
              </div>
              {result.swipes.map((swipe, index) => (
                <div key={`${swipe.x1}-${swipe.y1}-${index}`} data-testid={`row-scroll-replay-swipe-${index}`} className="rounded bg-background/80 p-2 font-mono text-xs">
                  Swipe {index + 1}: ({swipe.x1},{swipe.y1}) → ({swipe.x2},{swipe.y2}), {swipe.durationMs} ms
                </div>
              ))}
              <details>
                <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                  <FileCode2 className="h-4 w-4" /> Replay log
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-background p-3 text-xs">{result.logs.join("\n")}</pre>
              </details>
            </div>
          )}

          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-2 font-medium text-foreground">
              <ImageUp className="h-4 w-4" /> What this replay verifies
            </div>
            It runs the real positioning and scroll calculations and records coordinates. The fake list moves by the
            requested gesture; this does not emulate Android inertia or Snapchat rendering.
          </div>
        </section>
      </div>
    </div>
  );
}
