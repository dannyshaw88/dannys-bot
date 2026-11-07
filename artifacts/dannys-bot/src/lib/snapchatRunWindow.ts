export type SnapchatRunWindow = {
  start: string;
  end: string;
  timeZone?: string;
};

type WindowStatus = {
  configured: boolean;
  valid: boolean;
  open: boolean;
  nextOpenAt: number | null;
  closesAt: number | null;
};

function parseClockTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

export function getSnapchatRunWindowStatus(
  window: SnapchatRunWindow | null | undefined,
  now = Date.now(),
): WindowStatus {
  const startText = typeof window?.start === "string" ? window.start : "";
  const endText = typeof window?.end === "string" ? window.end : "";
  if (!startText && !endText) {
    return { configured: false, valid: true, open: true, nextOpenAt: null, closesAt: null };
  }

  const start = parseClockTime(startText);
  const end = parseClockTime(endText);
  if (start === null || end === null || start === end) {
    return { configured: true, valid: false, open: false, nextOpenAt: null, closesAt: null };
  }

  const current = new Date(now);
  const currentMinutes = current.getHours() * 60 + current.getMinutes();
  const crossesMidnight = start > end;
  const open = crossesMidnight
    ? currentMinutes >= start || currentMinutes < end
    : currentMinutes >= start && currentMinutes < end;

  const atClockTime = (minutes: number, addDay = false) => {
    const date = new Date(now);
    date.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    if (addDay) date.setDate(date.getDate() + 1);
    return date.getTime();
  };

  if (open) {
    const closesTomorrow = crossesMidnight && currentMinutes >= start;
    return {
      configured: true,
      valid: true,
      open: true,
      nextOpenAt: null,
      closesAt: atClockTime(end, closesTomorrow),
    };
  }

  let nextOpenAt = atClockTime(start);
  if (nextOpenAt <= now) nextOpenAt = atClockTime(start, true);
  return { configured: true, valid: true, open: false, nextOpenAt, closesAt: null };
}

/**
 * Preserve the requested interval when its target falls inside the window;
 * otherwise defer to the next opening. Null means a configured window is
 * incomplete, malformed, or has identical start/end times.
 */
export function getSnapchatWindowedDelay(
  delayMs: number,
  window: SnapchatRunWindow | null | undefined,
  now = Date.now(),
): number | null {
  const targetAt = now + Math.max(0, delayMs);
  const status = getSnapchatRunWindowStatus(window, targetAt);
  if (!status.valid) return null;
  if (status.open) return Math.max(0, delayMs);
  return status.nextOpenAt === null ? null : Math.max(0, status.nextOpenAt - now);
}
