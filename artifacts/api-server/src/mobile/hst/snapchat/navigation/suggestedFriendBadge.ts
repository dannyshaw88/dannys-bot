import type { ScreenPixels } from "../../../androidManager";
import type { UiNode } from "../context";

type BadgeScan = { circles: UiNode[]; addFriendCount: number };

function isPurpleBadgePixel(screen: ScreenPixels, x: number, y: number): boolean {
  const offset = (y * screen.width + x) * screen.channels;
  const r = screen.pixels[offset] ?? 0;
  const g = screen.pixels[offset + 1] ?? r;
  const b = screen.pixels[offset + 2] ?? r;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  if (max < 90 || delta < 35) return false;

  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta + 6) % 6 * 60;
    else if (max === g) hue = ((b - r) / delta + 2) * 60;
    else hue = ((r - g) / delta + 4) * 60;
  }
  const saturation = delta / max;
  return hue >= 265 && hue <= 325 && saturation >= 0.38;
}

function isBrightGlyphPixel(screen: ScreenPixels, x: number, y: number): boolean {
  const offset = (y * screen.width + x) * screen.channels;
  const r = screen.pixels[offset] ?? 0;
  const g = screen.pixels[offset + 1] ?? r;
  const b = screen.pixels[offset + 2] ?? r;
  return Math.min(r, g, b) >= 175 && Math.max(r, g, b) - Math.min(r, g, b) <= 75;
}

/**
 * Snapchat can render the suggested-friend plus/person badge as pixels only:
 * the accessibility tree may expose the circular card but omit the badge.
 * A real Story ring is only an outline; the suggestion badge is a filled
 * purple pill with a bright person-add glyph across the center of that card.
 */
export function hasSuggestedFriendBadge(screen: ScreenPixels, story: UiNode): boolean {
  const [left, top, right, bottom] = story.bounds;
  const width = right - left;
  const height = bottom - top;
  if (width < 20 || height < 20 || left < 0 || top < 0 ||
      right > screen.width || bottom > screen.height) return false;

  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  const xRadius = Math.max(6, width * 0.25);
  const yRadius = Math.max(4, height * 0.12);
  const x1 = Math.max(0, Math.floor(centerX - xRadius));
  const x2 = Math.min(screen.width - 1, Math.ceil(centerX + xRadius));
  const y1 = Math.max(0, Math.floor(centerY - yRadius));
  const y2 = Math.min(screen.height - 1, Math.ceil(centerY + yRadius));
  let purplePixels = 0;
  let glyphPixels = 0;
  let pixelCount = 0;
  let glyphCount = 0;

  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      pixelCount++;
      if (isPurpleBadgePixel(screen, x, y)) purplePixels++;
      if (
        Math.abs(x - centerX) <= width * 0.15 &&
        Math.abs(y - centerY) <= height * 0.08
      ) {
        glyphCount++;
        if (isBrightGlyphPixel(screen, x, y)) glyphPixels++;
      }
    }
  }

  let centerRowPurple = 0;
  let centerRowPixels = 0;
  const row = Math.round(centerY);
  for (let x = Math.max(0, Math.floor(centerX - width * 0.2));
    x <= Math.min(screen.width - 1, Math.ceil(centerX + width * 0.2)); x++) {
    centerRowPixels++;
    if (isPurpleBadgePixel(screen, x, row)) centerRowPurple++;
  }

  return pixelCount > 0 &&
    glyphCount > 0 &&
    purplePixels / pixelCount >= 0.5 &&
    glyphPixels / glyphCount >= 0.035 &&
    centerRowPixels > 0 &&
    centerRowPurple / centerRowPixels >= 0.6;
}

export function filterSuggestedFriendStories(
  screen: ScreenPixels,
  circles: UiNode[],
): BadgeScan {
  const filtered = circles.filter(circle => !hasSuggestedFriendBadge(screen, circle));
  return {
    circles: filtered,
    addFriendCount: circles.length - filtered.length,
  };
}
