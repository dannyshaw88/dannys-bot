import * as android from "../../androidManager";
import type { SnapchatContext, UiNode, UiState } from "./context";

export const BANNER_RECHECK_MS = 120;
export const ADD_FRIENDS_BANNER_RECHECK_MS = 5_000;

export const shortResourceId = (node: UiNode) => node.resourceId.split("/").pop() ?? node.resourceId;
export const nodeLabel = (node: UiNode) => `${node.text} ${node.desc}`.trim();
export const center = (node: UiNode) => ({
  x: Math.round((node.bounds[0] + node.bounds[2]) / 2),
  y: Math.round((node.bounds[1] + node.bounds[3]) / 2),
});

const decodeXml = (value: string) => value
  .replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&amp;/g, "&");

export function parseNodes(xml: string): UiNode[] {
  const nodes: UiNode[] = [];
  const nodeRegex = /<node\b([^>]*)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = nodeRegex.exec(xml)) !== null) {
    const attrs = match[1];
    const get = (key: string) => decodeXml((attrs.match(new RegExp(`${key}="([^"]*)"`)) ?? [])[1] ?? "");
    const boundsMatch = get("bounds").match(/^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/);
    if (!boundsMatch) continue;
    nodes.push({
      text: get("text"),
      desc: get("content-desc"),
      resourceId: get("resource-id"),
      className: get("class"),
      packageName: get("package"),
      clickable: get("clickable") === "true",
      focusable: get("focusable") === "true",
      focused: get("focused") === "true",
      selected: get("selected") === "true",
      bounds: boundsMatch.slice(1).map(Number) as [number, number, number, number],
    });
  }
  return nodes;
}

export async function dump(serial: string): Promise<UiState> {
  const xml = await android.dumpUi(serial).catch(() => "");
  return { xml, nodes: parseNodes(xml) };
}

export async function tapNode(
  context: SnapchatContext,
  node: UiNode,
  reason: string,
  settleMs = 700,
  exact = false,
): Promise<boolean> {
  if (context.isAborted()) return false;
  const { x, y } = center(node);
  await android.tap(
    context.serial,
    x,
    y,
    "bot",
    `Snapchat: ${reason}`,
    "automation",
    exact ? { exact: true } : undefined,
  );
  if (settleMs > 0) await context.sleep(settleMs);
  return !context.isAborted();
}

export function exactClickable(nodes: UiNode[], labels: string[]): UiNode | undefined {
  const wanted = new Set(labels.map(value => value.toLowerCase()));
  return nodes.find(node =>
    node.clickable &&
    [node.text, node.desc].some(value => wanted.has(value.trim().toLowerCase())),
  );
}

export function findOccludingBanner(nodes: UiNode[], target: UiNode, screenWidth: number, screenHeight: number) {
  const point = center(target);
  const targetArea = (target.bounds[2] - target.bounds[0]) * (target.bounds[3] - target.bounds[1]);
  const screenArea = screenWidth * screenHeight;
  return nodes.find(node => {
    if (node === target) return false;
    const [left, top, right, bottom] = node.bounds;
    const area = (right - left) * (bottom - top);
    const hasOverlaySignal = node.clickable || Boolean(node.text.trim() || node.desc.trim()) ||
      /banner|toast|snackbar|notification/i.test(node.resourceId);
    if (!hasOverlaySignal) return false;
    const coversTapPoint = point.x >= left && point.x <= right && point.y >= top && point.y <= bottom;
    return coversTapPoint && area > targetArea * 2.5 && area < screenArea * 0.5;
  });
}

export async function tapExact(context: SnapchatContext, labels: string[], reason: string): Promise<boolean> {
  const { nodes } = await dump(context.serial);
  const node = exactClickable(nodes, labels);
  return node ? tapNode(context, node, reason) : false;
}

export function randomCount(min: number, max: number): number {
  const low = Math.max(0, Math.trunc(Math.min(min, max)));
  const high = Math.max(low, Math.trunc(Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function randomSeconds(min: number, max: number): number {
  const low = Math.max(1, Math.min(60, Math.min(min, max)));
  const high = Math.max(low, Math.min(60, Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}

export function randomPercent(min: number, max: number): number {
  const low = Math.max(0, Math.min(100, Math.min(min, max)));
  const high = Math.max(low, Math.min(100, Math.max(min, max)));
  return low + Math.floor(Math.random() * (high - low + 1));
}
