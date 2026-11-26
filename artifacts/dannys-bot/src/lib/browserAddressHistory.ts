export const BROWSER_ADDRESS_HISTORY_KEY = "aura.googleChrome.visitedAddresses";
const HISTORY_LIMIT = 100;

export function normaliseVisitedAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function readVisitedAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const urls = value.map(normaliseVisitedAddress).filter((url): url is string => url !== null);
  return [...new Set(urls)].slice(0, HISTORY_LIMIT);
}

export function addVisitedAddress(previous: string[], value: unknown): string[] {
  const url = normaliseVisitedAddress(value);
  if (!url || previous[0] === url) return previous;
  return [url, ...previous.filter(item => item !== url)].slice(0, HISTORY_LIMIT);
}
