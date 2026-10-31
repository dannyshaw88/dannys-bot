import * as android from "../../../androidManager";
import type { SnapchatContext } from "../context";

export async function swipeByDeviceGesture(context: SnapchatContext): Promise<boolean> {
  const gesture = context.swipeGesture;
  if (!gesture) {
    context.onLog("View Snaps stopped: configure a swipe gesture in My Device before scrolling Spotlight.");
    return false;
  }
  const points = [gesture.x1, gesture.y1, gesture.x2, gesture.y2];
  if (points.some(value => !Number.isFinite(value) || value <= 0) ||
      (gesture.x1 === gesture.x2 && gesture.y1 === gesture.y2) ||
      !Number.isFinite(gesture.durationMinMs) || !Number.isFinite(gesture.durationMaxMs)) {
    context.onLog("View Snaps stopped: the saved My Device swipe gesture is incomplete or invalid.");
    return false;
  }
  const durationMin = Math.max(1, Math.min(gesture.durationMinMs, gesture.durationMaxMs));
  const durationMax = Math.max(durationMin, Math.max(gesture.durationMinMs, gesture.durationMaxMs));
  const duration = Math.round(durationMin + Math.random() * (durationMax - durationMin));
  const jitter = (first: number, second: number) => {
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    return Math.round(low + Math.random() * (high - low));
  };
  const jitterX = Number.isFinite(gesture.jitterX) ? Math.abs(gesture.jitterX) : 0;
  const jitterY = Number.isFinite(gesture.jitterY) ? Math.abs(gesture.jitterY) : 0;
  const startJitterMinY = Number.isFinite(gesture.startJitterMinY) ? gesture.startJitterMinY! : 0;
  const startJitterMaxY = Number.isFinite(gesture.startJitterMaxY) ? gesture.startJitterMaxY! : startJitterMinY;
  const dx = jitter(-jitterX, jitterX);
  const dy1 = jitter(startJitterMinY, startJitterMaxY);
  const dy2 = jitter(-jitterY, jitterY);
  const pauseMin = Number.isFinite(gesture.pauseMinMs) ? Math.max(0, gesture.pauseMinMs!) : 0;
  const pauseMax = Number.isFinite(gesture.pauseMaxMs) ? Math.max(pauseMin, gesture.pauseMaxMs!) : pauseMin;
  const settleMin = Number.isFinite(gesture.settleMinMs) ? Math.max(0, gesture.settleMinMs!) : 0;
  const settleMax = Number.isFinite(gesture.settleMaxMs) ? Math.max(settleMin, gesture.settleMaxMs!) : settleMin;
  if (pauseMax > 0) await context.sleep(jitter(pauseMin, pauseMax));
  await android.swipe(
    context.serial,
    gesture.x1 + dx,
    gesture.y1 + dy1,
    gesture.x2 + dx,
    gesture.y2 + dy1 + dy2,
    duration,
    false,
  );
  if (settleMax > 0) await context.sleep(jitter(settleMin, settleMax));
  return !context.isAborted();
}
