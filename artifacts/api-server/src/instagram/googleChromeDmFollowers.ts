/** Wait for actual collected rows, not an early page shell or skeleton links. */
export async function waitForGoogleChromeDmFollowers<T>(
  collect: () => Promise<T[]>,
  stopped: () => boolean,
  timeoutMs = 30_000,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500)),
): Promise<T[]> {
  const deadline = Date.now() + timeoutMs;
  while (!stopped()) {
    const rows = await collect();
    if (rows.length) return rows;
    if (Date.now() >= deadline) {
      throw new Error("The Followers page opened, but no readable user rows became available. No messages were sent.");
    }
    await pause();
  }
  return [];
}
