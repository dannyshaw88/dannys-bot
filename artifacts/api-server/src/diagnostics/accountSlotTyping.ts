// Account fields include passwords and OTP secrets. Keep timing information,
// but never write key identities or the entered field value to diagnostics.
export function accountSlotTypingTiming(message: string): string | null {
  const batch = message.match(/sent (\d+) calibrated key tap\(s\) in (\d+)ms \(ADB (\d+)ms, queued (\d+)ms, configured pauses (\d+)ms\)/);
  if (batch) {
    const [, taps, total, adb, queued, pauses] = batch;
    return `batch taps=${taps} totalMs=${total} adbMs=${adb} queueMs=${queued} configuredPausesMs=${pauses}`;
  }
  const capture = message.match(/per-tap ADB timings \((\d+)\/(\d+) captured, 10ms resolution\):/);
  if (!capture) return null;
  const durations = [...message.matchAll(/"(?:\\.|[^"\\])*":(\d+)ms/g)]
    .map((match, index) => `tap${index + 1}=${match[1]}ms`);
  return `per-tap captured=${capture[1]}/${capture[2]} resolutionMs=10 [${durations.join(", ")}]`;
}
