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
 * purple pill with a bright person-add glyph over the lower edge of the
 * thumbnail. The accessibility bounds include the whole story card, so the
 * badge is below the bounds' vertical midpoint.
 */
export function hasSuggestedFriendBadge(screen: ScreenPixels, story: UiNode): boolean {
  const [left, top, right, bottom] = story.bounds;
  const width = right - left;
  const height = bottom - top;
  if (width < 20 || height < 20 || left < 0 || top < 0 ||
      right > screen.width || bottom > screen.height) return false;

  const centerX = (left + right) / 2;
  const centerY = top + height * 0.82;
  const xRadius = Math.max(6, width * 0.32);
  const yRadius = Math.max(4, height * 0.12);
  const x1 = Math.max(0, Math.floor(centerX - xRadius));
  const x2 = Math.min(screen.width - 1, Math.ceil(centerX + xRadius));
  const y1 = Math.max(0, Math.floor(Math.max(top + height * 0.70, centerY - yRadius)));
  const y2 = Math.min(screen.height - 1, Math.ceil(Math.min(bottom, centerY + yRadius)));
  let purplePixels = 0;
  let pixelCount = 0;
  let plusPixels = 0;
  let plusPixelCount = 0;
  let personPixels = 0;
  let personPixelCount = 0;
  const glyphTop = Math.max(0, Math.floor(top + height * 0.74));
  const glyphBottom = Math.min(screen.height - 1, Math.ceil(top + height * 0.91));
  const plusLeft = Math.max(0, Math.floor(centerX - width * 0.20));
  const plusRight = Math.min(screen.width - 1, Math.ceil(centerX - width * 0.02));
  const personLeft = Math.max(0, Math.floor(centerX + width * 0.02));
  const personRight = Math.min(screen.width - 1, Math.ceil(centerX + width * 0.20));

  for (let y = y1; y <= y2; y++) {
    for (let x = x1; x <= x2; x++) {
      pixelCount++;
      if (isPurpleBadgePixel(screen, x, y)) purplePixels++;
    }
  }
  for (let y = glyphTop; y <= glyphBottom; y++) {
    for (let x = plusLeft; x <= plusRight; x++) {
      plusPixelCount++;
      if (isBrightGlyphPixel(screen, x, y)) plusPixels++;
    }
    for (let x = personLeft; x <= personRight; x++) {
      personPixelCount++;
      if (isBrightGlyphPixel(screen, x, y)) personPixels++;
    }
  }

  let pillRowPurple = 0;
  let pillRowPixels = 0;
  const row = Math.round(centerY);
  for (let x = Math.max(0, Math.floor(centerX - width * 0.28));
    x <= Math.min(screen.width - 1, Math.ceil(centerX + width * 0.28)); x++) {
    pillRowPixels++;
    if (isPurpleBadgePixel(screen, x, row)) pillRowPurple++;
  }

  return pixelCount > 0 &&
    plusPixelCount > 0 &&
    personPixelCount > 0 &&
    purplePixels / pixelCount >= 0.35 &&
    plusPixels / plusPixelCount >= 0.025 &&
    personPixels / personPixelCount >= 0.025 &&
    pillRowPixels > 0 &&
    pillRowPurple / pillRowPixels >= 0.55;
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
