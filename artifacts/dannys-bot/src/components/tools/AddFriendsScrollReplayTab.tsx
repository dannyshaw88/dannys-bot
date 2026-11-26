import { useMemo, useRef, useState } from "react";
import { RotateCcw, Upload } from "lucide-react";
import mixedDump from "@assets/equinox-inspect-dump-1795563512708_1795563527991.txt?raw";
import contactsDump from "@assets/equinox-inspect-dump-1795563594602_1795563612145.txt?raw";
import dismissedDump from "@assets/DISMISSED_1795563650788.txt?raw";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddFriendsReplayPhone } from "./AddFriendsReplayPhone";
import { contactsFrom, listTopFor, prepareScene, serializeNodes, type Scene, type UiNode } from "./addFriendsReplayScene";

type Action = "add" | "skip" | "dismiss";
const initial = prepareScene(mixedDump);
function firstVisible(scene: Scene) {
  return contactsFrom(scene.nodes).find(contact => !contact.dismissed && contact.action === "Add" && contact.top >= listTopFor(scene) && contact.top < scene.height)?.name ?? "";
}

export function AddFriendsScrollReplayTab() {
  const [scene, setScene] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [dumpText, setDumpText] = useState(mixedDump);
  const [selected, setSelected] = useState(() => firstVisible(initial));
  const [running, setRunning] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const [sourceHash, setSourceHash] = useState("");
  const [lastInput, setLastInput] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const contacts = useMemo(() => contactsFrom(scene.nodes), [scene.nodes]);
  const selectedContact = contacts.find(contact => contact.name === selected);

  const loadDump = (text: string) => {
    try {
      const next = prepareScene(text);
      setScene(next); setBaseline(next); setDumpText(text); setSelected(firstVisible(next));
      setError(""); setLogs([]); setLastInput("");
      setStatus(`Loaded ${contactsFrom(next.nodes).length} cards; the imported visible position and individual heights are preserved.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not read the dump."); }
  };
  const runAction = async (action: Action, name = selected) => {
    if (running) return;
    if (name !== firstVisible(scene)) {
      setError("The actual tool processes the first eligible contact, not a manually chosen lower row.");
      return;
    }
    setRunning(true); setError(""); setStatus("Compiling and starting the current Add Friends tool…");
    setLogs([]); setLastInput("");
    controller.current = new AbortController();
    try {
      const response = await fetch("/api/debug/add-friends-tool-replay", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        signal: controller.current.signal,
        body: JSON.stringify({
          uiXml: serializeNodes(scene.nodes),
          screenWidth: scene.width,
          screenHeight: scene.height,
          friendName: name,
          action,
        }),
      });
      if (!response.ok) throw new Error((await response.json()).error || "Could not start the tool.");
      if (!response.body) throw new Error("No live execution stream was returned.");
      let finished = false;
      const consume = async (line: string) => {
        if (!line.trim()) return;
        const event = JSON.parse(line);
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "start") {
          setSourceHash(event.sourceHash);
          setStatus("Running the current runAddFriends entrypoint against the imported device.");
        } else if (event.type === "log") setLogs(previous => [...previous, event.message]);
        else if (event.type === "frame" || event.type === "done") {
          if (Array.isArray(event.nodes)) {
            const next = { ...scene, nodes: event.nodes as UiNode[] };
            setScene(next);
            setSelected(firstVisible(next));
          }
          if (event.type === "done") {
            finished = true;
            setStatus(event.message);
          } else {
            const description = event.kind === "tap"
              ? `Tool tap: ${event.action} ${event.name} at (${event.x}, ${event.y})`
              : `Tool swipe: (${event.gesture.x1}, ${event.gesture.y1}) → (${event.gesture.x2}, ${event.gesture.y2}); content moved ${event.gesture.contentMovement}px`;
            setLastInput(description);
            setLogs(previous => [...previous, description]);
            // Display each received input frame; this does not decide or repair
            // any movement. The real tool continues running on the server.
            await new Promise(resolve => setTimeout(resolve, 220));
          }
        }
      };
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) await consume(line);
        if (done) break;
      }
      if (buffer.trim()) await consume(buffer);
      if (!finished) throw new Error("Execution ended without a tool result; the replay has not reported success.");
    } catch (caught) {
      if (caught instanceof Error && caught.name === "AbortError") setStatus("Stopped the tool replay.");
      else { setStatus(""); setError(caught instanceof Error ? caught.message : "Tool replay failed."); }
    } finally { controller.current?.abort(); controller.current = null; setRunning(false); }
  };
  const reset = () => {
    setScene(baseline); setSelected(firstVisible(baseline)); setLastInput("");
    setError(""); setLogs([]); setStatus("Restored the imported screen.");
  };
  return <div className="space-y-5">
    <div>
      <h2 className="text-xl font-semibold">Snapchat Add Friends screen test</h2>
      <p className="mt-1 text-sm text-muted-foreground">Runs one actual Add Friends tool step per click. Its taps and swipes update the imported device automatically.</p>
    </div>
    <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.85fr)_minmax(340px,1.15fr)]">
      <section className="desktop-card space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Imported phone screen</h3>
          <Button variant="outline" size="sm" disabled={running} onClick={reset}><RotateCcw className="mr-2 h-4 w-4" />Reset</Button>
        </div>
        <div className="mx-auto w-full max-w-[330px]">
          <AddFriendsReplayPhone scene={scene} contacts={contacts} selected={selected} onSelect={setSelected}
            onAction={(action, name) => void runAction(action, name)} running={running} />
        </div>
        <p className="text-xs text-muted-foreground">Each card keeps its own measured height. Missing subtitles remain blank; contact and mutual-friend details are taken only from the dump.</p>
      </section>
      <section className="desktop-card space-y-4 p-4">
        <div className="space-y-2">
          <h3 className="font-semibold">Import an Inspect dump</h3>
          <label className="block text-sm">Your supplied examples
            <select className="mt-1 w-full rounded-md border border-input bg-background px-3 py-2" defaultValue="mixed" disabled={running}
              data-testid="select-replay-example" onChange={event => loadDump(event.target.value === "mixed" ? mixedDump : event.target.value === "contacts" ? contactsDump : dismissedDump)}>
              <option value="mixed">No subtitle and mutual friends</option>
              <option value="contacts">In my contacts</option>
              <option value="dismissed">Dismissed feedback card</option>
            </select>
          </label>
          <Input type="file" accept=".txt,.xml,text/plain,application/xml" disabled={running}
            data-testid="input-add-friends-inspect" onChange={event => { const file = event.target.files?.[0]; if (file) void file.text().then(loadDump); }} />
          <textarea value={dumpText} onChange={event => setDumpText(event.target.value)} data-testid="textarea-add-friends-inspect"
            aria-label="Inspect dump text" className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs" spellCheck={false} />
          <Button variant="outline" disabled={running} onClick={() => loadDump(dumpText)}><Upload className="mr-2 h-4 w-4" />Load this dump</Button>
        </div>
        <div className="space-y-3 border-t border-border pt-4">
          <h3 className="font-semibold">Run the current Add Friends code</h3>
          <p className="text-xs text-muted-foreground">Each swipe is calculated from the imported row positions, screen size, and observed list movement. There is no fixed scroll-distance setting.</p>
          <select value={selected} onChange={event => setSelected(event.target.value)} data-testid="select-add-friends-sim-contact"
            className="w-full rounded-md border border-input bg-background px-3 py-2" disabled>
            {contacts.filter(contact => contact.bottom > listTopFor(scene) && contact.top < scene.height * 0.94).map((contact, index) =>
              <option key={`${contact.name}-${index}`} value={contact.name} disabled={contact.dismissed}>{contact.name} — {contact.height}px{contact.dismissed ? " (dismissed)" : ""}</option>)}
          </select>
          <div className="grid grid-cols-3 gap-2">
            {(["add", "skip", "dismiss"] as const).map(action => <Button key={action} variant={action === "add" ? "default" : "outline"}
              data-testid={`button-sim-action-${action}`} disabled={running || !selectedContact || selectedContact.dismissed}
              onClick={() => void runAction(action)}>{action[0].toUpperCase() + action.slice(1)}</Button>)}
          </div>
          {running && <Button variant="outline" onClick={() => controller.current?.abort()}>Stop</Button>}
          <p className="text-xs text-muted-foreground">Add runs the normal tool. Dismiss enables its Avoid Users Containing filter for this contact. Skip tests that filter’s missing-Hide fallback. The real tool decides what happens next.</p>
          <p className="text-xs text-muted-foreground">Source is compiled fresh on every run. Only Android responses, time delays, and storage are simulated—no phone or farm history is changed.</p>
          {sourceHash && <p className="font-mono text-xs" data-testid="text-replay-source">Live tool source: {sourceHash}</p>}
          {lastInput && <p className="text-sm" data-testid="text-replay-last-input">{lastInput}</p>}
          {selectedContact && <p className="text-sm" data-testid="text-replay-card-height">Selected card: <strong>{selectedContact.height}px</strong>{selectedContact.reason ? ` · ${selectedContact.reason}` : " · No subtitle"}</p>}
        </div>
        {(status || error) && <div role={error ? "alert" : "status"} className={`rounded-md border p-3 text-sm ${error ? "border-destructive/30 bg-destructive/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>{error || status}</div>}
        {logs.length > 0 && <details open className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Live tool log</summary>
          <pre data-testid="text-replay-live-log" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{logs.join("\n")}</pre></details>}
      </section>
    </div>
  </div>;
}
