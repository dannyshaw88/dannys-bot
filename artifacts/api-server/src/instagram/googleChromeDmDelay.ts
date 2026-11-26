/** Short waits keep Stop and the run time limit responsive during a message gap. */
export async function waitForGoogleChromeDmDelay(seconds: number, isStopped: () => boolean): Promise<void> {
  const deadline = Date.now() + seconds * 1000;
  while (!isStopped()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(250, remaining)));
  }
}
