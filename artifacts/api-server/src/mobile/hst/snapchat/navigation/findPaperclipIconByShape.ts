import type { ScreenPixels } from "../../../androidManager";

// Screenshot-derived mask of Snapchat's tilted paperclip glyph. This icon is
// diagonal, not the upright paperclip shape used by some other toolbars.
const TEMPLATE = [
  "...........##...",
  ".........#####..",
  "........##....#.",
  ".......##.....#.",
  "......##......#.",
  ".....##......##.",
  "....##......##..",
  "...##......##...",
  "..##......##....",
  ".##......##....#",
  ".#......##....##",
  "##.....##....##.",
  "#.....##....##..",
  "#....##....##...",
  "#.........##....",
  "##.......#......",
  ".##.....##......",
  "..######........",
  "...####.........",
] as const;

const FOREGROUND: Array<{ x: number; y: number }> = [];
for (let y = 0; y < TEMPLATE.length; y++) {
  for (let x = 0; x < TEMPLATE[y].length; x++) {
    if (TEMPLATE[y][x] === "#") FOREGROUND.push({ x, y });
  }
}

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
  const values: Array<{ foreground: boolean; value: number }> = [];
  let total = 0;
  for (let y = 0; y < TEMPLATE.length; y++) {
    for (let x = 0; x < TEMPLATE[y].length; x++) {
      const value = luma(screen, left + (x + 0.5) * scale, top + (y + 0.5) * scale);
      if (value === null) return null;
      const foreground = TEMPLATE[y][x] === "#";
      values.push({ foreground, value });
      total += value;
    }
  }

  // Normalized correlation compares the exact tilted silhouette while
  // accounting for the variable video frame behind the white toolbar icon.
  const mean = total / values.length;
  const foregroundRatio = FOREGROUND.length / values.length;
  const templateVariance = foregroundRatio * (1 - foregroundRatio);
  let covariance = 0;
  let imageVariance = 0;
  for (const { foreground, value } of values) {
    const centeredValue = value - mean;
    covariance += ((foreground ? 1 : 0) - foregroundRatio) * centeredValue;
    imageVariance += centeredValue * centeredValue;
  }
  const imageVarianceMean = imageVariance / values.length;
  if (imageVarianceMean <= 0) return null;
  return covariance / values.length / Math.sqrt(templateVariance * imageVarianceMean);
}

export function findPaperclipIconByShape(
  screen: ScreenPixels,
  candidateCenters: Array<{ x: number; y: number }>,
): { x: number; y: number; score: number } | null {
  const uniqueCenters: Array<{ x: number; y: number }> = [];
  for (const point of candidateCenters) {
    if (!uniqueCenters.some(existing =>
      Math.abs(existing.x - point.x) <= 6 && Math.abs(existing.y - point.y) <= 6,
    )) uniqueCenters.push(point);
  }

  const matches: Array<{ x: number; y: number; score: number }> = [];
  const scales = [1.4, 1.8, 2.2, 2.6, 3, 3.4, 3.8, 4.2, 4.6];
  const offsets = [-15, -10, -5, 0, 5, 10, 15];
  for (const point of uniqueCenters) {
    let centerBest = -Infinity;
    let bestPoint = point;
    for (const scale of scales) {
      for (const dx of offsets) {
        for (const dy of offsets) {
          const candidate = { x: point.x + dx, y: point.y + dy };
          const score = scoreAt(screen, candidate, scale);
          if (score !== null && score > centerBest) {
            centerBest = score;
            bestPoint = candidate;
          }
        }
      }
    }
    if (centerBest > -Infinity) matches.push({ ...bestPoint, score: centerBest });
  }

  matches.sort((a, b) => b.score - a.score);
  const best = matches[0];
  const secondBest = matches[1]?.score ?? -Infinity;
  if (!best || best.score < 0.56 || best.score - secondBest < 0.055) return null;
  return best;
}
