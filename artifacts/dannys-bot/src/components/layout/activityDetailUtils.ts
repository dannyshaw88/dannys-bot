export function normalizeActivityDetail(detail?: string): string | undefined {
  return detail?.replace(/\b(\d+)\s+POSTS?\s+UPLOADED\b/gi, (_match, count: string) =>
    `${count} post${count === "1" ? "" : "s"} uploaded`,
  );
}

/**
 * Older cycle rows persisted the complete tool-step trace. Keep those rows
 * readable after the server switched to metrics-only summaries by extracting
 * and aggregating only the outcome metrics for the Dashboard display.
 */
export function compactCycleMetrics(detail?: string): string | undefined {
  const normalized = normalizeActivityDetail(detail);
  if (!normalized) return normalized;
  if (!/(?:power-on|unlock-swipe|launch-instagram|airplane-mode|feed\(|explore\(|reels\()/i.test(normalized)) {
    return normalized;
  }

  const totals = new Map<string, number>();
  const add = (label: string, value: string) => {
    const n = Number(value);
    if (n > 0) totals.set(label, (totals.get(label) ?? 0) + n);
  };
  for (const match of normalized.matchAll(/\b(\d+)\s+(likes?|liked)\b/gi)) add("likes", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+(?:follows?|followed)\b/gi)) add("follows", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+stories?\s+watched\b/gi)) add("stories watched", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+reels?\s+(?:watched|viewed|scrolled)\b/gi)) add("reels watched", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+DMs?\b/gi)) add("DMs", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+posts?\s+uploaded\b/gi)) add("posts uploaded", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+(?:feed[- ]shares|shares)\b/gi)) add("shares", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+saved\b/gi)) add("saved", match[1]);
  for (const match of normalized.matchAll(/\b(?:explore\()?(\d+)\s+(?:Explore\s+)?scrolls?\b/gi)) add("Explore scrolls", match[1]);
  for (const match of normalized.matchAll(/\b(\d+)\s+posts?\s+scrolled\b/gi)) add("posts scrolled", match[1]);

  const compact = [...totals].map(([label, value]) => `${value} ${label}`).join(", ");
  return compact || "No metrics recorded";
}