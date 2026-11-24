export type Bounds = [number, number, number, number];
export type UiNode = {
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
  replayId?: number;
};
export type Scene = { width: number; height: number; nodes: UiNode[] };
export type Contact = {
  name: string;
  reason: string;
  top: number;
  bottom: number;
  height: number;
  action: string;
  dismissed: boolean;
  children: UiNode[];
};
export const shortId = (node: UiNode) => node.resourceId.split("/").at(-1) ?? "";
const label = (node?: UiNode) => node?.text.trim() || node?.desc.trim() || "";

function decodeXml(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));
}

export function parseInspectNodes(source: string): UiNode[] {
  const xml = [...source.matchAll(/<node\b([^>]*)\/?>/g)];
  const lines = xml.length ? xml.map(match => match[1]) : source.split(/\r?\n/);
  return lines.flatMap(line => {
    if (!xml.length && !/\bclickable=(?:true|false)\b/.test(line)) return [];
    const attrs = Object.fromEntries([...line.matchAll(/([\w:-]+)="([^"]*)"/g)]
      .map(([, key, value]) => [key, decodeXml(value)]));
    const bounds = (attrs.bounds ?? line).match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/);
    if (!bounds) return [];
    return [{
      text: attrs.text ?? "", desc: attrs["content-desc"] ?? attrs.desc ?? "",
      resourceId: attrs["resource-id"] ?? attrs.id ?? "",
      className: attrs.class ?? line.match(/\bfocused=(?:true|false)\s+([A-Za-z][\w.$]*)/)?.[1] ?? "",
      packageName: attrs.package ?? "",
      clickable: attrs.clickable === "true" || /\bclickable=true\b/.test(line),
      focusable: attrs.focusable === "true" || /\bfocusable=true\b/.test(line),
      focused: attrs.focused === "true" || /\bfocused=true\b/.test(line),
      selected: attrs.selected === "true",
      bounds: bounds.slice(1).map(Number) as Bounds,
    }];
  });
}

export function rowGroups(nodes: UiNode[]) {
  const heading = nodes.findIndex(node => shortId(node) === "section-title" && /^find friends$/i.test(label(node)));
  if (heading < 0) return [];
  const next = nodes.findIndex((node, index) => index > heading && shortId(node) === "section-title");
  const end = next < 0 ? nodes.length : next;
  const indices = nodes.flatMap((node, index) =>
    index > heading && index < end && shortId(node) === "scu_search_friend_cell" ? [index] : []);
  return indices.map((index, rowNumber) => ({
    index,
    end: indices[rowNumber + 1] ?? end,
    row: nodes[index],
    children: nodes.slice(index + 1, indices[rowNumber + 1] ?? end),
  }));
}

export function contactsFrom(nodes: UiNode[]): Contact[] {
  return rowGroups(nodes).flatMap(({ row, children }) => {
    const feedback = children.find(node => shortId(node) === "feedback-title");
    const name = label(children.find(node => shortId(node) === "result-title")) ||
      label(feedback).replace(/^Hid\s+/i, "").replace(/!\s*Tell us why\??$/i, "");
    if (!name) return [];
    return [{
      name,
      reason: label(children.find(node => shortId(node) === "result-reason")),
      top: row.bounds[1], bottom: row.bounds[3], height: row.bounds[3] - row.bounds[1],
      action: label(children.find(node => shortId(node) === "scu_search_action_button")) ||
        (children.some(node => shortId(node) === "scu_quick_add_chat") ? "Snap" : "Add"),
      dismissed: Boolean(feedback),
      children,
    }];
  });
}

export function listTopFor(scene: Scene): number {
  const heading = scene.nodes.findIndex(node => shortId(node) === "section-title" && /^find friends$/i.test(label(node)));
  const firstRow = scene.nodes.findIndex((node, index) => index > heading && shortId(node) === "scu_search_friend_cell");
  return Math.max(...scene.nodes.slice(heading, firstRow).filter(node =>
    ["section-title", "section-description"].includes(shortId(node))).map(node => node.bounds[3])) + Math.round(scene.width * 0.022);
}

export function prepareScene(source: string): Scene {
  const nodes = parseInspectNodes(source);
  if (!nodes.length) throw new Error("This dump has no Android nodes.");
  const scene = { width: Math.max(...nodes.map(node => node.bounds[2])), height: Math.max(...nodes.map(node => node.bounds[3])), nodes };
  const groups = rowGroups(nodes);
  if (groups.length < 2) throw new Error("This dump has fewer than two Find friends contact cards.");
  const listTop = listTopFor(scene);
  // Keep the actual visible part of a scrolled dump. RecyclerView reports cached
  // off-screen cards at y=0; they belong above the anchor, not at the list's top.
  const anchorIndex = Math.max(0, groups.findIndex(group => group.row.bounds[1] >= listTop));
  const anchor = groups[anchorIndex].row;
  const tops: number[] = [];
  tops[anchorIndex] = anchor.bounds[1] >= listTop ? anchor.bounds[1] : listTop;
  const heightOf = (index: number) => groups[index].row.bounds[3] - groups[index].row.bounds[1];
  const gapBefore = (index: number) => {
    const gap = groups[index].row.bounds[1] - groups[index - 1].row.bounds[3];
    return gap >= 0 && gap <= scene.width * 0.02 ? gap : 0;
  };
  for (let index = anchorIndex - 1; index >= 0; index--) {
    tops[index] = tops[index + 1] - heightOf(index) - gapBefore(index + 1);
  }
  for (let index = anchorIndex + 1; index < groups.length; index++) {
    tops[index] = tops[index - 1] + heightOf(index - 1) + gapBefore(index);
  }
  for (const [index, group] of groups.entries()) {
    const oldTop = group.row.bounds[1];
    const offset = tops[index] - oldTop;
    for (let nodeIndex = group.index; nodeIndex < group.end; nodeIndex++) {
      const node = nodes[nodeIndex];
      node.bounds = [node.bounds[0], node.bounds[1] + offset, node.bounds[2], node.bounds[3] + offset];
    }
    // Repair child positions clipped to y=0 only. Visible cards keep their own
    // measured title/subtitle positions and exact full-card height.
    if (oldTop === 0) {
      const title = group.children.find(node => shortId(node) === "result-title");
      const reason = group.children.find(node => shortId(node) === "result-reason");
      const titleHeight = title ? title.bounds[3] - title.bounds[1] : 0;
      const reasonHeight = reason ? reason.bounds[3] - reason.bounds[1] : 0;
      let textTop = tops[index] + (heightOf(index) - titleHeight - reasonHeight) / 2;
      for (const node of [title, reason]) {
        if (!node) continue;
        const nodeHeight = node.bounds[3] - node.bounds[1];
        node.bounds = [node.bounds[0], Math.round(textTop), node.bounds[2], Math.round(textTop + nodeHeight)];
        textTop += nodeHeight;
      }
    }
  }
  return scene;
}

export function serializeNodes(nodes: UiNode[]): string {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<hierarchy>${nodes.map(node => `<node text="${escape(node.text)}" content-desc="${escape(node.desc)}" resource-id="${escape(node.resourceId)}" class="${escape(node.className)}" package="${escape(node.packageName)}" clickable="${node.clickable}" focusable="${node.focusable}" focused="${node.focused}" selected="${node.selected}" bounds="[${node.bounds[0]},${node.bounds[1]}][${node.bounds[2]},${node.bounds[3]}]"/>`).join("")}</hierarchy>`;
}

// The supplied real 720px-wide before/after dumps expose a 151px feedback
// card, replacing a 137px contact card. Scale that structure, not the old row.
export function dismissReplayContact(source: UiNode[], name: string, width: number): UiNode[] {
  const nodes = source.map(node => ({ ...node, bounds: [...node.bounds] as Bounds }));
  const group = rowGroups(nodes).find(group =>
    group.children.some(node => shortId(node) === "result-title" && label(node) === name));
  if (!group) throw new Error(`No recommendation card found for ${name}.`);
  const scale = width / 720;
  const top = group.row.bounds[1];
  const newHeight = Math.round(151 * scale);
  const delta = newHeight - (group.row.bounds[3] - top);
  const make = (resourceId: string, text: string, bounds: Bounds): UiNode => ({
    ...group.row, resourceId, text, desc: text, className: "TextView", replayId: undefined,
    bounds: bounds.map((value, index) => Math.round(value * scale) + (index % 2 ? top : 0)) as Bounds,
  });
  const feedback: UiNode[] = [
    { ...group.row, bounds: [group.row.bounds[0], top, group.row.bounds[2], top + newHeight] },
    make("avatar", "", [30, 25, 130, 125]),
    make("feedback-title", `Hid ${name}! Tell us why?`, [152, 18, 633, 45]),
    make("fisrt-feedback", "I don't know this person", [152, 53, 633, 89]),
    make("second-feedback", "Other reason", [152, 97, 633, 133]),
    make("feedback-undo", "Undo", [633, 19, 686, 46]),
  ];
  for (const following of rowGroups(nodes).filter(item => item.index > group.index)) {
    for (let index = following.index; index < following.end; index++) {
      const node = nodes[index];
      node.bounds = [node.bounds[0], node.bounds[1] + delta, node.bounds[2], node.bounds[3] + delta];
    }
  }
  return [...nodes.slice(0, group.index), ...feedback, ...nodes.slice(group.end)];
}
