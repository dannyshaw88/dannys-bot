export type SnapchatRunWindow = {
  start: string;
  end: string;
  timeZone?: string;
};

export type SnapchatRunWindowStatus = {
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

type ClockParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function getClockParts(timestamp: number, timeZone?: string): ClockParts | null {
  if (!timeZone) {
    const date = new Date(timestamp);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
      second: date.getSeconds(),
    };
  }
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      hourCycle: "h23",
    }).formatToParts(new Date(timestamp));
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return {
      year: Number(values.year),
      month: Number(values.month),
      day: Number(values.day),
      hour: Number(values.hour),
      minute: Number(values.minute),
      second: Number(values.second),
    };
  } catch {
    return null;
  }
}

function localDateTimeToTimestamp(
  year: number,
  month: number,
  day: number,
  minutes: number,
  timeZone?: string,
): number {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  if (!timeZone) {
    const date = new Date(0);
    date.setFullYear(year, month - 1, day);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  }
  const desiredLocalAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let estimate = desiredLocalAsUtc;
  for (let i = 0; i < 4; i += 1) {
    const parts = getClockParts(estimate, timeZone);
    if (!parts) return Number.NaN;
    const representedLocalAsUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      0,
    );
    const adjustment = desiredLocalAsUtc - representedLocalAsUtc;
    estimate += adjustment;
    if (adjustment === 0) break;
  }
  return estimate;
}

export function getSnapchatRunWindowStatus(
  window: SnapchatRunWindow | null | undefined,
  now = Date.now(),
): SnapchatRunWindowStatus {
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

  const timeZone = typeof window?.timeZone === "string" ? window.timeZone.trim() : "";
  const current = getClockParts(now, timeZone || undefined);
  if (!current) {
    return { configured: true, valid: false, open: false, nextOpenAt: null, closesAt: null };
  }
  const currentMinutes = current.hour * 60 + current.minute;
  const crossesMidnight = start > end;
  const open = crossesMidnight
    ? currentMinutes >= start || currentMinutes < end
    : currentMinutes >= start && currentMinutes < end;

  const atClockTime = (minutes: number, addDays = 0) => {
    const date = new Date(Date.UTC(current.year, current.month - 1, current.day + addDays));
    return localDateTimeToTimestamp(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      minutes,
      timeZone || undefined,
    );
  };

  if (open) {
    const closesTomorrow = crossesMidnight && currentMinutes >= start;
    const closesAt = atClockTime(end, closesTomorrow ? 1 : 0);
    if (!Number.isFinite(closesAt)) {
      return { configured: true, valid: false, open: false, nextOpenAt: null, closesAt: null };
    }
    return {
      configured: true,
      valid: true,
      open: true,
      nextOpenAt: null,
      closesAt,
    };
  }

  let nextOpenAt = atClockTime(start);
  if (!Number.isFinite(nextOpenAt)) {
    return { configured: true, valid: false, open: false, nextOpenAt: null, closesAt: null };
  }
  if (nextOpenAt <= now) nextOpenAt = atClockTime(start, 1);
  if (!Number.isFinite(nextOpenAt)) {
    return { configured: true, valid: false, open: false, nextOpenAt: null, closesAt: null };
  }
  return { configured: true, valid: true, open: false, nextOpenAt, closesAt: null };
}

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
