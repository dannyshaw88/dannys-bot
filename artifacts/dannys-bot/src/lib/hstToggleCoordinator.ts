/**
 * One shared transaction for Human Session Tool master-toggle changes.
 *
 * The Statistics page and the mounted Phone Farm runtime must not each invent
 * their own persistence/broadcast sequence.  This module owns the request
 * envelope and broadcasts only after the server has accepted the change.
 */

export type HstToggleSource = "statistics" | "phone-farm";

export type HstToggleEvent = {
  serial: string;
  slotIdx: number;
  slotId?: string;
  enabled: boolean;
  revision: number;
  requestId: string;
  source: HstToggleSource;
};

type ToggleCounter = { revision: number };
const counters = new Map<string, ToggleCounter>();
const requestQueues = new Map<string, Promise<unknown>>();
let requestSequence = 0;

function keyFor(serial: string, slotIdx: number, slotId?: string): string {
  return `${serial}:${slotId || slotIdx}`;
}

function nextEvent(
  serial: string,
  slotIdx: number,
  slotId: string | undefined,
  enabled: boolean,
  source: HstToggleSource,
): HstToggleEvent {
  const key = keyFor(serial, slotIdx, slotId);
  const counter = counters.get(key) ?? { revision: 0 };
  counter.revision += 1;
  counters.set(key, counter);
  requestSequence += 1;
  return {
    serial,
    slotIdx,
    ...(slotId ? { slotId } : {}),
    enabled,
    revision: counter.revision,
    requestId: `hst-toggle-${requestSequence}`,
    source,
  };
}

function broadcast(event: HstToggleEvent): void {
  // This same-tab path also covers embedded runtimes without
  // BroadcastChannel. The App listener and any mounted slot runtime dedupe
  // only by the event's requestId at their own boundary.
  window.dispatchEvent(new CustomEvent("aura-slot-toggle", { detail: event }));
  try {
    const channel = new BroadcastChannel("aura-slot-toggle");
    channel.postMessage(event);
    channel.close();
  } catch {
    // BroadcastChannel is unavailable in a few older embedded runtimes. The
    // originating Phone Farm runtime still applies its own local state.
  }
}

export async function persistHstToggle(input: {
  serial: string;
  slotIdx: number;
  slotId?: string;
  enabled: boolean;
  source: HstToggleSource;
}): Promise<HstToggleEvent> {
  const event = nextEvent(
    input.serial,
    input.slotIdx,
    input.slotId,
    input.enabled,
    input.source,
  );
  const queueKey = keyFor(input.serial, input.slotIdx, input.slotId);
  const previous = requestQueues.get(queueKey) ?? Promise.resolve();
  const request = previous.catch(() => undefined).then(async () => {
    const slotIdQuery = input.slotId ? `?slotId=${encodeURIComponent(input.slotId)}` : "";
    const response = await fetch(
      `/api/mobile/devices/${encodeURIComponent(input.serial)}/slots/${input.slotIdx}/automation-toggle${slotIdQuery}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: event.enabled,
          slotId: event.slotId,
          revision: event.revision,
          requestId: event.requestId,
          source: event.source,
        }),
      },
    );
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) {
      throw new Error(body?.error ?? `Toggle save failed (${response.status})`);
    }
    broadcast(event);
    return event;
  });
  requestQueues.set(queueKey, request);
  void request.then(
    () => { if (requestQueues.get(queueKey) === request) requestQueues.delete(queueKey); },
    () => { if (requestQueues.get(queueKey) === request) requestQueues.delete(queueKey); },
  );
  return request as Promise<HstToggleEvent>;
}
