import { useMemo, useState } from "react";
import { RotateCcw, Upload } from "lucide-react";
import sampleInspectDump from "@assets/equinox-inspect-dump-1795559682316_1795561582044.txt?raw";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type Action = "add" | "skip" | "dismiss";
type Bounds = [number, number, number, number];
type UiNode = {
  text: string;
  desc: string;
  resourceId: string;
  className: string;
  packageName: string;
  clickable: boolean;
  focusable: boolean;
  focused: boolean;
  selected: boolean;
  bounds: Bounds;
};
type Contact = {
  name: string;
  reason: string;
  top: number;
  bottom: number;
  height: number;
  action: string;
  hasDismiss: boolean;
  children: UiNode[];
};
type ReplayResult = {
  expectedNext: string;
  expectedTop: number;
  actualTop: number;
  action: Action;
  swipes: Array<{ x1: number; y1: number; x2: number; y2: number; durationMs: number }>;
  logs: string[];
  nodes: UiNode[];
};
type Scene = { width: number; height: number; nodes: UiNode[] };

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, number: string) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)));
}

function readAttributes(source: string): Record<string, string> {
  return Object.fromEntries(
    [...source.matchAll(/([\w:-]+)="([^"]*)"/g)].map(([, key, value]) => [key, decodeXml(value)]),
  );
}

function parseInspectNodes(source: string): UiNode[] {
  const nodes: UiNode[] = [];
  const xmlNodes = [...source.matchAll(/<node\b([^>]*)\/?>/g)];
  if (xmlNodes.length) {
    for (const [, rawAttributes] of xmlNodes) {
      const attributes = readAttributes(rawAttributes);
      const bounds = attributes.bounds?.match(/^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/);
      if (!bounds) continue;
      nodes.push({
        text: attributes.text ?? "",
        desc: attributes["content-desc"] ?? "",
        resourceId: attributes["resource-id"] ?? attributes.id ?? "",
        className: attributes.class ?? "",
        packageName: attributes.package ?? "",
        clickable: attributes.clickable === "true",
        focusable: attributes.focusable === "true",
        focused: attributes.focused === "true",
        selected: attributes.selected === "true",
        bounds: bounds.slice(1).map(Number) as Bounds,
      });
    }
    return nodes;
  }

  for (const line of source.split(/\r?\n/)) {
    if (!/\bclickable=(?:true|false)\b/.test(line)) continue;
    const boundsMatches = [...line.matchAll(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/g)];
    const bounds = boundsMatches.at(-1);
    if (!bounds) continue;
    const attributes = readAttributes(line);
    const className = line.match(
      /\bfocused=(?:true|false)\s+([A-Za-z][\w.$]*)(?=\s+(?:id|desc|text)="|\s+\[)/,
    )?.[1] ?? "";
    nodes.push({
      text: attributes.text ?? "",
      desc: attributes.desc ?? "",
      resourceId: attributes.id ?? "",
      className,
      packageName: attributes.package ?? "",
      clickable: /\bclickable=true\b/.test(line),
      focusable: /\bfocusable=true\b/.test(line),
      focused: /\bfocused=true\b/.test(line),
      selected: /\bselected=true\b/.test(line),
      bounds: bounds.slice(1).map(Number) as Bounds,
    });
  }
  return nodes;
}

function shortId(node: UiNode): string {
  return node.resourceId.split("/").at(-1) ?? node.resourceId;
}

function prepareScene(source: string): Scene {
  const nodes = parseInspectNodes(source);
  const headingIndex = nodes.findIndex(node =>
    shortId(node) === "section-title" &&
    /^find friends$/i.test(node.text || node.desc),
  );
  if (headingIndex < 0) throw new Error("This dump has no Find friends screen.");
  const nextSection = nodes.findIndex((node, index) =>
    index > headingIndex && shortId(node) === "section-title",
  );
  const sectionEnd = nextSection < 0 ? nodes.length : nextSection;
  const rowIndices = nodes.flatMap((node, index) =>
    index > headingIndex &&
    index < sectionEnd &&
    shortId(node) === "scu_search_friend_cell" &&
    node.bounds[3] > node.bounds[1]
      ? [index]
      : [],
  );
  if (rowIndices.length < 2) throw new Error("This dump has fewer than two Find friends contact cards.");

  const width = Math.max(...nodes.map(node => node.bounds[2]));
  const height = Math.max(...nodes.map(node => node.bounds[3]));
  const headingBottom = nodes[headingIndex].bounds[3];
  let nextTop = Math.max(headingBottom + 24, Math.round(height * 0.187));

  for (let rowNumber = 0; rowNumber < rowIndices.length; rowNumber++) {
    const rowIndex = rowIndices[rowNumber];
    const row = nodes[rowIndex];
    const originalTop = row.bounds[1];
    const rowHeight = Math.max(110, Math.min(260, row.bounds[3] - originalTop || 186));
    const offset = nextTop - originalTop;
    const groupEnd = rowIndices[rowNumber + 1] ?? sectionEnd;
    for (let index = rowIndex; index < groupEnd; index++) {
      const node = nodes[index];
      node.bounds = [node.bounds[0], node.bounds[1] + offset, node.bounds[2], node.bounds[3] + offset];
    }
    nodes[rowIndex].bounds[3] = nextTop + rowHeight;
    nextTop += rowHeight;
  }
  return { width, height, nodes };
}

function contactsFrom(nodes: UiNode[]): Contact[] {
  const headingIndex = nodes.findIndex(node =>
    shortId(node) === "section-title" &&
    /^find friends$/i.test(node.text || node.desc),
  );
  if (headingIndex < 0) return [];
  const nextSection = nodes.findIndex((node, index) =>
    index > headingIndex && shortId(node) === "section-title",
  );
  const end = nextSection < 0 ? nodes.length : nextSection;
  const indices = nodes.flatMap((node, index) =>
    index > headingIndex && index < end && shortId(node) === "scu_search_friend_cell" ? [index] : [],
  );
  return indices.flatMap((index, rowNumber) => {
    const row = nodes[index];
    const rowEnd = indices[rowNumber + 1] ?? end;
    const children = nodes.slice(index + 1, rowEnd);
    const title = children.find(node => shortId(node) === "result-title");
    const name = title?.text.trim() || title?.desc.trim();
    if (!name) return [];
    const reason = children.find(node => shortId(node) === "result-reason");
    const action = children.find(node => shortId(node) === "scu_search_action_button");
    return [{
      name,
      reason: reason?.text.trim() || reason?.desc.trim() || "IN MY CONTACTS",
      top: row.bounds[1],
      bottom: row.bounds[3],
      height: row.bounds[3] - row.bounds[1],
      action: action?.text.trim() || action?.desc.trim() || "Add",
      hasDismiss: children.some(node => shortId(node) === "friend-cell-dismiss"),
      children,
    }];
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeNodes(nodes: UiNode[]): string {
  return `<hierarchy>${nodes.map(node =>
    `<node text="${xmlEscape(node.text)}" content-desc="${xmlEscape(node.desc)}" resource-id="${xmlEscape(node.resourceId)}" class="${xmlEscape(node.className)}" package="${xmlEscape(node.packageName)}" clickable="${node.clickable}" focusable="${node.focusable}" focused="${node.focused}" selected="${node.selected}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]"/>`,
  ).join("")}</hierarchy>`;
}

function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]).join("").toUpperCase();
}

const importedExample = prepareScene(sampleInspectDump);

export function AddFriendsScrollReplayTab() {
  const [scene, setScene] = useState<Scene>(importedExample);
  const [baseline, setBaseline] = useState<Scene>(importedExample);
  const [dumpText, setDumpText] = useState(sampleInspectDump);
  const [selected, setSelected] = useState(() => contactsFrom(importedExample.nodes)[0]?.name ?? "");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [replayLog, setReplayLog] = useState<string[]>([]);
  const contacts = useMemo(() => contactsFrom(scene.nodes), [scene.nodes]);
  const heading = scene.nodes.find(node => shortId(node) === "section-title" && /^find friends$/i.test(node.text || node.desc));
  const listTop = heading?.bounds[3] ?? 426;
  const navTop = scene.height - Math.round(scene.height * 0.056);
  const selectedContact = contacts.find(contact => contact.name === selected);

  const loadDump = (text: string) => {
    try {
      const nextScene = prepareScene(text);
      setDumpText(text);
      setScene(nextScene);
      setBaseline(nextScene);
      setSelected(contactsFrom(nextScene.nodes)[0]?.name ?? "");
      setError("");
      setStatus(`Loaded ${contactsFrom(nextScene.nodes).length} contacts from the Inspect dump.`);
      setReplayLog([]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not read this Inspect dump.");
    }
  };

  const runAction = async (action: Action, contactName = selected) => {
    const contact = contacts.find(item => item.name === contactName);
    if (!contact || running) return;
    setRunning(true);
    setError("");
    setStatus("");
    try {
      const response = await fetch("/api/debug/add-friends-scroll-replay", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          uiXml: serializeNodes(scene.nodes),
          screenWidth: scene.width,
          screenHeight: scene.height,
          friendName: contact.name,
          action,
        }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "The simulated action failed.");
      const result = payload as ReplayResult;
      if (!Array.isArray(result.nodes)) throw new Error("The replay returned no updated screen.");
      setScene({ ...scene, nodes: result.nodes });
      setSelected(result.expectedNext || contact.name);
      setStatus(`${action[0].toUpperCase()}${action.slice(1)} ${contact.name}; ${result.expectedNext} moved to the first row.`);
      setReplayLog(result.logs);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The simulated action failed.");
    } finally {
      setRunning(false);
    }
  };

  const resetScreen = () => {
    setScene({ ...baseline, nodes: baseline.nodes.map(node => ({ ...node, bounds: [...node.bounds] as Bounds })) });
    setSelected(contactsFrom(baseline.nodes)[0]?.name ?? "");
    setStatus("Restored the imported screen.");
    setError("");
    setReplayLog([]);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold">Snapchat Add Friends screen test</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The attached Inspect example is loaded. Click a contact, then try Add, Skip, or the grey X.
        </p>
      </div>

      <div className="grid gap-5 xl:grid-cols-[minmax(320px,0.85fr)_minmax(340px,1.15fr)]">
        <section className="desktop-card space-y-4 p-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-semibold">Imported phone screen</h3>
            <Button type="button" variant="outline" size="sm" data-testid="button-reset-add-friends-screen" onClick={resetScreen}>
              <RotateCcw className="mr-2 h-4 w-4" /> Reset
            </Button>
          </div>
          <div className="mx-auto w-full max-w-[330px]">
            <svg
              viewBox={`0 0 ${scene.width} ${scene.height}`}
              role="img"
              aria-label="Reconstructed Snapchat Add Friends screen"
              data-testid="screen-add-friends-simulator"
              className="block h-auto w-full overflow-hidden rounded-[2rem] border-[7px] border-neutral-900 bg-white shadow-xl"
            >
              <defs>
                <clipPath id="friend-list-clip">
                  <rect x="0" y={listTop} width={scene.width} height={Math.max(0, navTop - listTop)} />
                </clipPath>
              </defs>
              <rect width={scene.width} height={scene.height} fill="#ffffff" />
              <rect width={scene.width} height={70} fill="#f7f7f7" />
              <text x="50" y="48" fontSize="28" fill="#222">9:41</text>
              <text x={scene.width - 180} y="48" fontSize="24" fill="#222">●  ▮  ▰</text>
              <path d="M70 162 L45 185 L70 208" fill="none" stroke="#252525" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
              <text x={scene.width / 2} y="187" textAnchor="middle" fontSize="42" fontWeight="700" fill="#171717">Add friends</text>
              <circle cx={scene.width - 76} cy="162" r="7" fill="#272727" />
              <circle cx={scene.width - 54} cy="162" r="7" fill="#272727" />
              <circle cx={scene.width - 32} cy="162" r="7" fill="#272727" />
              <rect x="40" y="219" width={scene.width - 80} height="107" rx="54" fill="#f1f1f3" />
              <circle cx="87" cy="271" r="19" fill="none" stroke="#6e6e73" strokeWidth="7" />
              <path d="M101 285 L116 300" stroke="#6e6e73" strokeWidth="7" strokeLinecap="round" />
              <text x="145" y="286" fontSize="31" fill="#717176">Search...</text>
              <text x="45" y={listTop - 24} fontSize="31" fontWeight="700" fill="#1e1e1e">Find friends</text>
              <text x={scene.width - 280} y={listTop - 24} fontSize="26" fill="#555">All contacts ›</text>
              <line x1="0" x2={scene.width} y1={listTop} y2={listTop} stroke="#e7e7e7" strokeWidth="2" />
              <g clipPath="url(#friend-list-clip)">
                {contacts.map((contact, index) => {
                  const isSelected = selected === contact.name;
                  const isDismissed = contact.reason === "Dismissed in simulator";
                  const isSkipped = contact.reason === "Skipped in simulator";
                  const added = contact.action === "Snap" || contact.action === "Message";
                  const centerY = contact.top + contact.height / 2;
                  const buttonY = centerY - 44;
                  return (
                    <g
                      key={`${contact.name}-${index}`}
                      data-testid={`card-sim-contact-${index}`}
                      role="button"
                      tabIndex={0}
                      aria-label={`Select ${contact.name}`}
                      onClick={() => setSelected(contact.name)}
                      onKeyDown={event => {
                        if (event.key === "Enter" || event.key === " ") setSelected(contact.name);
                      }}
                      style={{ cursor: "pointer" }}
                    >
                      <rect
                        x="0"
                        y={contact.top}
                        width={scene.width}
                        height={contact.height}
                        fill={isSelected ? "#f5fbff" : isDismissed ? "#f2f2f2" : "#ffffff"}
                        stroke={isSelected ? "#18a8dc" : "#eeeeee"}
                        strokeWidth={isSelected ? "4" : "2"}
                      />
                      <circle cx="112" cy={centerY} r="67" fill={["#f4dcd3", "#d7e5e2", "#e5ddf0", "#eee7ce"][index % 4]} />
                      <text x="112" y={centerY + 12} textAnchor="middle" fontSize="39" fontWeight="600" fill="#4f5558">
                        {initials(contact.name)}
                      </text>
                      <text x="214" y={contact.top + 67} fontSize="35" fontWeight="600" fill="#202124">
                        {contact.name.length > 23 ? `${contact.name.slice(0, 21)}…` : contact.name}
                      </text>
                      <text x="214" y={contact.top + contact.height - 28} fontSize="23" fill="#747474">
                        {isDismissed ? "Dismissed in simulator" : isSkipped ? "Skipped in simulator" : contact.reason}
                      </text>
                      {isDismissed ? (
                        <rect x="709" y={buttonY} width="247" height="88" rx="44" fill="#d8d8d8" />
                      ) : added ? (
                        <>
                          <rect x="660" y={buttonY} width="164" height="88" rx="44" fill="#f4f4f4" />
                          <text x="742" y={buttonY + 56} textAnchor="middle" fontSize="25" fontWeight="600" fill="#222">Message</text>
                          <rect x="834" y={buttonY} width="155" height="88" rx="44" fill="#ffeb00" />
                          <text x="911" y={buttonY + 56} textAnchor="middle" fontSize="25" fontWeight="700" fill="#222">Snap</text>
                        </>
                      ) : (
                        <>
                          <g
                            role="button"
                            tabIndex={0}
                            aria-label={`Add ${contact.name}`}
                            data-testid={`button-sim-add-${index}`}
                            onClick={event => { event.stopPropagation(); setSelected(contact.name); void runAction("add", contact.name); }}
                            onKeyDown={event => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.stopPropagation();
                                setSelected(contact.name);
                                void runAction("add", contact.name);
                              }
                            }}
                          >
                            <rect x="709" y={buttonY} width="247" height="88" rx="44" fill="#ffeb00" />
                            <text x="832" y={buttonY + 56} textAnchor="middle" fontSize="29" fontWeight="700" fill="#222">＋ Add</text>
                          </g>
                          {contact.hasDismiss && (
                            <g
                              role="button"
                              tabIndex={0}
                              aria-label={`Dismiss ${contact.name}`}
                              data-testid={`button-sim-dismiss-${index}`}
                              onClick={event => { event.stopPropagation(); setSelected(contact.name); void runAction("dismiss", contact.name); }}
                              onKeyDown={event => {
                                if (event.key === "Enter" || event.key === " ") {
                                  event.stopPropagation();
                                  setSelected(contact.name);
                                  void runAction("dismiss", contact.name);
                                }
                              }}
                            >
                              <circle cx="1012" cy={centerY} r="22" fill="#efefef" />
                              <path d={`M1004 ${centerY - 8} L1020 ${centerY + 8} M1020 ${centerY - 8} L1004 ${centerY + 8}`} stroke="#8b8b8b" strokeWidth="5" strokeLinecap="round" />
                            </g>
                          )}
                        </>
                      )}
                    </g>
                  );
                })}
              </g>
              <rect x="0" y={navTop} width={scene.width} height={scene.height - navTop} fill="#171717" />
              <circle cx={scene.width / 2} cy={navTop + (scene.height - navTop) / 2} r="27" fill="#777" />
            </svg>
          </div>
          <p className="text-xs text-muted-foreground">
            Contact order and card heights come from Inspect. Off-screen rows reported at y=0 are rebuilt into a visible list.
          </p>
        </section>

        <section className="desktop-card space-y-4 p-4">
          <div className="space-y-2">
            <h3 className="font-semibold">Import an Inspect dump</h3>
            <Input
              type="file"
              accept=".txt,.xml,text/plain,application/xml"
              data-testid="input-add-friends-inspect"
              onChange={event => {
                const file = event.target.files?.[0];
                if (file) void file.text().then(loadDump);
              }}
            />
            <textarea
              value={dumpText}
              onChange={event => setDumpText(event.target.value)}
              data-testid="textarea-add-friends-inspect"
              aria-label="Inspect dump text"
              className="min-h-28 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs"
              spellCheck={false}
            />
            <Button type="button" variant="outline" data-testid="button-load-add-friends-inspect" onClick={() => loadDump(dumpText)}>
              <Upload className="mr-2 h-4 w-4" /> Load this dump
            </Button>
          </div>

          <div className="space-y-2 border-t border-border pt-4">
            <h3 className="font-semibold">Choose a contact and test the action</h3>
            <label className="block space-y-1 text-sm">
              <span>Contact visible in the screen</span>
              <select
                value={selected}
                onChange={event => setSelected(event.target.value)}
                data-testid="select-add-friends-sim-contact"
                className="w-full rounded-md border border-input bg-background px-3 py-2"
              >
              {contacts.map((contact, index) => (
                  <option key={`${contact.name}-${index}`} value={contact.name} disabled={contact.bottom <= listTop || contact.top >= navTop}>
                    {contact.name} {contact.top < navTop && contact.bottom > listTop ? "" : "(off-screen)"}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid grid-cols-3 gap-2">
              <Button type="button" data-testid="button-sim-action-add" disabled={running || !selectedContact} onClick={() => void runAction("add")}>Add</Button>
              <Button type="button" variant="outline" data-testid="button-sim-action-skip" disabled={running || !selectedContact} onClick={() => void runAction("skip")}>Skip</Button>
              <Button type="button" variant="outline" data-testid="button-sim-action-dismiss" disabled={running || !selectedContact} onClick={() => void runAction("dismiss")}>Dismiss</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              These run the same contact-positioning and one-card scroll helpers as the phone tool. No phone is touched.
            </p>
          </div>

          {(status || error) && (
            <div
              role={error ? "alert" : "status"}
              data-testid={error ? "status-add-friends-sim-error" : "status-add-friends-sim-result"}
              className={`rounded-md border p-3 text-sm ${error ? "border-destructive/30 bg-destructive/5 text-destructive" : "border-emerald-500/30 bg-emerald-500/5"}`}
            >
              {error || status}
            </div>
          )}
          {replayLog.length > 0 && (
            <details open className="rounded-md border border-border p-3">
              <summary className="cursor-pointer text-sm font-medium">What the code did</summary>
              <pre data-testid="text-add-friends-sim-log" className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap text-xs">{replayLog.join("\n")}</pre>
            </details>
          )}
        </section>
      </div>
    </div>
  );
}
