import { useMemo, useState } from "react";
import { RotateCcw, Upload } from "lucide-react";
import mixedDump from "@assets/equinox-inspect-dump-1795563512708_1795563527991.txt?raw";
import contactsDump from "@assets/equinox-inspect-dump-1795563594602_1795563612145.txt?raw";
import dismissedDump from "@assets/DISMISSED_1795563650788.txt?raw";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AddFriendsReplayPhone } from "./AddFriendsReplayPhone";
import { contactsFrom, listTopFor, prepareScene, serializeNodes, type Scene, type UiNode } from "./addFriendsReplayScene";

type Action = "add" | "skip" | "dismiss";
type ReplayResult = {
  expectedNext: string;
  nodes: UiNode[];
  afterActionNodes?: UiNode[];
  logs: string[];
};
const initial = prepareScene(mixedDump);
function firstVisible(scene: Scene) {
  return contactsFrom(scene.nodes).find(contact => !contact.dismissed && contact.top >= listTopFor(scene) && contact.top < scene.height)?.name ?? "";
}

export function AddFriendsScrollReplayTab() {
  const [scene, setScene] = useState(initial);
  const [baseline, setBaseline] = useState(initial);
  const [dumpText, setDumpText] = useState(mixedDump);
  const [selected, setSelected] = useState(() => firstVisible(initial));
  const [running, setRunning] = useState(false);
  const [pause, setPause] = useState(true);
  const [pending, setPending] = useState<ReplayResult | null>(null);
  const [beforeAction, setBeforeAction] = useState<Scene | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const contacts = useMemo(() => contactsFrom(scene.nodes), [scene.nodes]);
  const selectedContact = contacts.find(contact => contact.name === selected);

  const loadDump = (text: string) => {
    try {
      const next = prepareScene(text);
      setScene(next); setBaseline(next); setDumpText(text); setSelected(firstVisible(next));
      setPending(null); setBeforeAction(null); setError(""); setLogs([]);
      setStatus(`Loaded ${contactsFrom(next.nodes).length} cards; the imported visible position and individual heights are preserved.`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Could not read the dump."); }
  };
  const finishScroll = (result: ReplayResult) => {
    setScene(current => ({ ...current, nodes: result.nodes }));
    setSelected(result.expectedNext); setPending(null); setLogs(result.logs);
    setStatus(`Scroll completed: ${result.expectedNext} is now at the top.`);
  };
  const runAction = async (action: Action, name = selected) => {
    if (running || pending) return;
    setRunning(true); setError(""); setStatus(""); setBeforeAction(scene);
    try {
      const response = await fetch("/api/debug/add-friends-scroll-replay", {
        method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uiXml: serializeNodes(scene.nodes), screenWidth: scene.width, screenHeight: scene.height, friendName: name, action }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Simulation failed.");
      if (!Array.isArray(result.nodes)) throw new Error("The replay returned no screen.");
      if (result.afterActionNodes && pause) {
        setScene({ ...scene, nodes: result.afterActionNodes });
        setSelected(name); setPending(result);
        setStatus(`${action === "dismiss" ? "Dismiss feedback card displayed" : `${action === "add" ? "Added" : "Skipped"} ${name}`}. Inspect its new height, then press Run scroll code.`);
        setLogs([]);
      } else finishScroll(result);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Simulation failed."); }
    finally { setRunning(false); }
  };
  const reset = () => {
    setScene(baseline); setSelected(firstVisible(baseline)); setPending(null); setBeforeAction(null);
    setError(""); setLogs([]); setStatus("Restored the imported screen.");
  };
  return <div className="space-y-5">
    <div>
      <h2 className="text-xl font-semibold">Snapchat Add Friends screen test</h2>
      <p className="mt-1 text-sm text-muted-foreground">Import a screen, take an action, inspect the changed card, then test the scroll.</p>
    </div>
    <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.85fr)_minmax(340px,1.15fr)]">
      <section className="desktop-card space-y-4 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="font-semibold">Imported phone screen</h3>
          <Button variant="outline" size="sm" disabled={running} onClick={reset}><RotateCcw className="mr-2 h-4 w-4" />Reset</Button>
        </div>
        <div className="mx-auto w-full max-w-[330px]">
          <AddFriendsReplayPhone scene={scene} contacts={contacts} selected={selected} onSelect={setSelected}
            onAction={(action, name) => void runAction(action, name)} running={running || Boolean(pending)}
            onUndo={beforeAction ? () => { setScene(beforeAction); setPending(null); setStatus("Undid the simulated action."); } : undefined} />
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
          <h3 className="font-semibold">Test the action and scroll</h3>
          <select value={selected} onChange={event => setSelected(event.target.value)} data-testid="select-add-friends-sim-contact"
            className="w-full rounded-md border border-input bg-background px-3 py-2" disabled={running || Boolean(pending)}>
            {contacts.filter(contact => contact.bottom > listTopFor(scene) && contact.top < scene.height * 0.94).map((contact, index) =>
              <option key={`${contact.name}-${index}`} value={contact.name} disabled={contact.dismissed}>{contact.name} — {contact.height}px{contact.dismissed ? " (dismissed)" : ""}</option>)}
          </select>
          <div className="grid grid-cols-3 gap-2">
            {(["add", "skip", "dismiss"] as const).map(action => <Button key={action} variant={action === "add" ? "default" : "outline"}
              data-testid={`button-sim-action-${action}`} disabled={running || Boolean(pending) || !selectedContact || selectedContact.dismissed}
              onClick={() => void runAction(action)}>{action[0].toUpperCase() + action.slice(1)}</Button>)}
          </div>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={pause} disabled={running || Boolean(pending)} onChange={event => setPause(event.target.checked)} />Pause after action to inspect the card</label>
          {pending && <Button className="w-full" data-testid="button-run-replay-scroll" onClick={() => finishScroll(pending)}>Run scroll code</Button>}
          <p className="text-xs text-muted-foreground">The scroll runs the phone tool’s helpers against simulated input. No real phone is touched.</p>
          {selectedContact && <p className="text-sm" data-testid="text-replay-card-height">Selected card: <strong>{selectedContact.height}px</strong>{selectedContact.reason ? ` · ${selectedContact.reason}` : " · No subtitle"}</p>}
        </div>
        {(status || error) && <div role={error ? "alert" : "status"} className={`rounded-md border p-3 text-sm ${error ? "border-destructive/30 bg-destructive/5" : "border-emerald-500/30 bg-emerald-500/5"}`}>{error || status}</div>}
        {logs.length > 0 && <details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">Scroll log</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{logs.join("\n")}</pre></details>}
      </section>
    </div>
  </div>;
}
