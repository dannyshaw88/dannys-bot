import type { ScreenPixels } from "../../../androidManager";

// Screenshot-derived silhouette of Snapchat's tilted paperclip glyph.
// Candidates come from the live right-side tool column; their order and
// vertical positions are deliberately not used to choose the target.
const TEMPLATE = [
  "........................",
  "........................",
  "........................",
  "..............####......",
  ".............######.....",
  "............###..##.....",
  "...........###...###....",
  "..........###....##.....",
  ".........###....###.....",
  "........###....###......",
  ".......###....####......",
  "......###....####..#....",
  ".....###....####..###...",
  "....###....###...###....",
  "...###....###...###.....",
  "...###...###...###......",
  "...###...##...###.......",
  "...###.......###........",
  "....##......###.........",
  "....###....###..........",
  ".....########...........",
  ".......#####............",
  "........................",
  "........................",
  "........................",
] as const;

const FOREGROUND: Array<{ x: number; y: number }> = [];
for (let y = 0; y < TEMPLATE.length; y++) {
  for (let x = 0; x < TEMPLATE[y].length; x++) {
    if (TEMPLATE[y][x] === "#") FOREGROUND.push({ x, y });
  }
}

const EDGE_OFFSETS = [
  [-2, 0], [2, 0], [0, -2], [0, 2],
] as const;

function luma(screen: ScreenPixels, x: number, y: number): number | null {
  const px = Math.round(x);
  const py = Math.round(y);
  if (px < 0 || py < 0 || px >= screen.width || py >= screen.height) return null;
  const offset = (py * screen.width + px) * screen.channels;
  const red = screen.pixels[offset] ?? 0;
  const green = screen.pixels[offset + 1] ?? red;
  const blue = screen.pixels[offset + 2] ?? red;
  return (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
}

function scoreAt(
  screen: ScreenPixels,
  center: { x: number; y: number },
  scale: number,
): number | null {
  const left = center.x - (TEMPLATE[0].length * scale) / 2;
  const top = center.y - (TEMPLATE.length * scale) / 2;
  let foregroundTotal = 0;
  let edgeContrastTotal = 0;
  let edgeContrastCount = 0;

  for (const point of FOREGROUND) {
    const x = left + (point.x + 0.5) * scale;
    const y = top + (point.y + 0.5) * scale;
    const value = luma(screen, x, y);
    if (value === null) return null;
    foregroundTotal += value;
    for (const [dx, dy] of EDGE_OFFSETS) {
      const surrounding = luma(screen, x + dx * scale, y + dy * scale);
      if (surrounding === null) continue;
      edgeContrastTotal += value - surrounding;
      edgeContrastCount++;
    }
  }

  const foregroundMean = foregroundTotal / Math.max(1, FOREGROUND.length);
  const edgeContrastMean = edgeContrastTotal / Math.max(1, edgeContrastCount);
  // The editor toolbar overlays the selected video, so background pixels vary
  // from clip to clip. Score the white glyph's local contrast instead of
  // rejecting it because unrelated bright pixels happen to lie nearby.
  return foregroundMean * 0.35 + edgeContrastMean * 0.65;
}

export function findPaperclipIconByShape(
  screen: ScreenPixels,
  candidateCenters: Array<{ x: number; y: number }>,
): { x: number; y: number; score: number } | null {
  const uniqueCenters = new Map<string, { x: number; y: number }>();
  for (const point of candidateCenters) {
    uniqueCenters.set(`${point.x}:${point.y}`, point);
  }

  const matches: Array<{ x: number; y: number; score: number }> = [];
  for (const point of uniqueCenters.values()) {
    let centerBest = -Infinity;
    for (const scale of [1, 1.4, 1.8, 2.2, 2.6, 3, 3.4, 3.8, 4.2]) {
      const score = scoreAt(screen, point, scale);
      if (score !== null) centerBest = Math.max(centerBest, score);
    }
    if (centerBest > -Infinity) matches.push({ ...point, score: centerBest });
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const secondBest = matches[1]?.score ?? -Infinity;
  if (!best || best.score < 0.18 || best.score - secondBest < 0.015) return null;
  return best;
}
