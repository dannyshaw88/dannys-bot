export function normalizeSnapchatContactLabel(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\p{P}\p{S}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase();
}

export function stripSnapchatPeerNamePrefix(value: string, peerName: string): string | undefined {
  const separator = value.indexOf(":");
  if (separator < 0) return undefined;
  const label = value.slice(0, separator).trim();
  if (
    !label ||
    normalizeSnapchatContactLabel(label) !==
      normalizeSnapchatContactLabel(peerName)
  ) {
    return undefined;
  }
  const message = value.slice(separator + 1).trim();
  return message || undefined;
}
