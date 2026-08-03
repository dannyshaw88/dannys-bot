export function normalizeActivityDetail(detail?: string): string | undefined {
  return detail?.replace(/\b(\d+)\s+POSTS?\s+UPLOADED\b/gi, (_match, count: string) =>
    `${count} post${count === "1" ? "" : "s"} uploaded`,
  );
}