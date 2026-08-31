/**
 * Device-level Collision Preventer coordinator.
 *
 * This module deliberately owns the queue outside React. Mounted MobilePage
 * runtimes, Mobile Phone Apps, and hstRunner recovery all import this same
 * module instance, so they cannot accidentally acquire separate per-device
 * locks.
 */

export type CollisionSource = "hst-ui" | "hst-background" | "phone-apps";

export type CollisionConfig = {
  enabled: boolean;
  restMinMin: number;
  restMinMax: number;
};

export type CollisionLease = {
  id: string;
  collisionPrevented: boolean;
};

export type CollisionRequestOptions = {
  source: CollisionSource;
  owner: string;
  onQueued?: () => void;
};

type CollisionQueueEntry = {
  id: string;
  slotIdx: number;
  readyAt: number;
  source: CollisionSource;
  owner: string;
  resolve: (lease: CollisionLease) => void;
};

type CollisionState = {
  config: CollisionConfig;
  configLoadedAt: number;
  configVersion: number;
  configLoading: Promise<CollisionConfig> | null;
  queue: CollisionQueueEntry[];
  busy: boolean;
  activeLeaseId: string | null;
  activeSlot: number | null;
  activeSource: CollisionSource | null;
  activeOwner: string | null;
  restTimer: ReturnType<typeof setTimeout> | null;
};

export const DEFAULT_COLLISION_CONFIG: CollisionConfig = {
  enabled: true,
  restMinMin: 5,
  restMinMax: 10,
};

const collisionStates = new Map<string, CollisionState>();
let leaseSequence = 0;

function getCollisionState(serial: string): CollisionState {
  const existing = collisionStates.get(serial);
  if (existing) return existing;
  const created: CollisionState = {
    config: { ...DEFAULT_COLLISION_CONFIG },
    configLoadedAt: 0,
    configVersion: 0,
    configLoading: null,
    queue: [],
    busy: false,
    activeLeaseId: null,
    activeSlot: null,
    activeSource: null,
    activeOwner: null,
    restTimer: null,
  };
  collisionStates.set(serial, created);
  return created;
}

function nextLeaseId(serial: string): string {
  leaseSequence += 1;
  return `${serial}:${leaseSequence}`;
}

function normalizeConfig(raw: unknown): CollisionConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<CollisionConfig>;
  const min = Number(value.restMinMin);
  const max = Number(value.restMinMax);
  return {
    enabled: value.enabled !== false,
    restMinMin: Number.isFinite(min) ? Math.max(0, min) : DEFAULT_COLLISION_CONFIG.restMinMin,
    restMinMax: Number.isFinite(max) ? Math.max(0, max) : DEFAULT_COLLISION_CONFIG.restMinMax,
  };
}

function describe(source: CollisionSource, owner: string, slotIdx: number): string {
  return `${source}/${owner}/slot${slotIdx}`;
}

function resolveCancelled(entry: CollisionQueueEntry): void {
  entry.resolve({ id: "", collisionPrevented: false });
}

function processCollisionQueue(serial: string): void {
  const state = getCollisionState(serial);
  state.restTimer = null;
  if (state.queue.length === 0) {
    state.busy = false;
    state.activeLeaseId = null;
    state.activeSlot = null;
    state.activeSource = null;
    state.activeOwner = null;
    return;
  }

  state.queue.sort((a, b) => a.readyAt - b.readyAt || a.slotIdx - b.slotIdx || a.id.localeCompare(b.id));
  const next = state.queue.shift()!;
  state.busy = true;
  state.activeLeaseId = next.id;
  state.activeSlot = next.slotIdx;
  state.activeSource = next.source;
  state.activeOwner = next.owner;
  const waitMs = Math.max(0, Date.now() - next.readyAt);
  console.info(
    `[COLLISION] ${serial} acquired queued ${describe(next.source, next.owner, next.slotIdx)} ` +
    `lease=${next.id} due=${new Date(next.readyAt).toISOString()} waitedMs=${waitMs}`,
  );
  next.resolve({ id: next.id, collisionPrevented: true });
}

function applyCollisionConfig(serial: string, config: CollisionConfig): CollisionConfig {
  const state = getCollisionState(serial);
  state.config = config;
  state.configLoadedAt = Date.now();
  state.configVersion += 1;

  // Disabling the feature removes only the post-cycle rest. An active cycle
  // still owns the device, and queued turns are released when that cycle
  // finishes, so disabling can never create an overlap.
  if (!config.enabled && state.restTimer !== null) {
    clearTimeout(state.restTimer);
    state.restTimer = null;
    if (state.activeLeaseId === null) processCollisionQueue(serial);
  }
  return config;
}

async function loadCollisionConfig(serial: string): Promise<CollisionConfig> {
  const state = getCollisionState(serial);
  if (state.configLoading) return state.configLoading;
  if (Date.now() - state.configLoadedAt < 2_000) return state.config;

  const requestedVersion = state.configVersion;
  state.configLoading = fetch(
    `/api/mobile/devices/${encodeURIComponent(serial)}/collision-preventer`,
  ).then(async response => {
    const body = await response.json().catch(() => null);
    const config = normalizeConfig(body?.config);
    // A settings save may have completed while this GET was in flight. Do
    // not let the older response overwrite the user's newer configuration.
    if (state.configVersion !== requestedVersion) return state.config;
    // A missing config retains the fail-closed default. The settings panel
    // initializes new devices separately.
    return applyCollisionConfig(serial, config ?? state.config);
  }).catch(() => {
    state.configLoadedAt = Date.now();
    return state.config;
  }).finally(() => {
    state.configLoading = null;
  });
  return state.configLoading;
}

export function setCollisionConfig(serial: string, raw: unknown): CollisionConfig {
  return applyCollisionConfig(serial, normalizeConfig(raw) ?? { ...DEFAULT_COLLISION_CONFIG });
}

export async function requestCollisionSlot(
  serial: string,
  slotIdx: number,
  readyAt: number,
  options: CollisionRequestOptions,
): Promise<CollisionLease> {
  await loadCollisionConfig(serial);
  const state = getCollisionState(serial);
  const id = nextLeaseId(serial);

  return new Promise<CollisionLease>(resolve => {
    if (!state.busy) {
      state.busy = true;
      state.activeLeaseId = id;
      state.activeSlot = slotIdx;
      state.activeSource = options.source;
      state.activeOwner = options.owner;
      console.info(
        `[COLLISION] ${serial} acquired immediate ${describe(options.source, options.owner, slotIdx)} ` +
        `lease=${id} due=${new Date(readyAt).toISOString()}`,
      );
      resolve({ id, collisionPrevented: false });
      return;
    }

    state.queue.push({
      id,
      slotIdx,
      readyAt,
      source: options.source,
      owner: options.owner,
      resolve,
    });
    console.info(
      `[COLLISION] ${serial} queued ${describe(options.source, options.owner, slotIdx)} ` +
      `lease=${id} due=${new Date(readyAt).toISOString()} ` +
      `active=${state.activeSource}/${state.activeOwner}/slot${state.activeSlot ?? "none"} ` +
      `queueLength=${state.queue.length}`,
    );
    options.onQueued?.();
  });
}

export function releaseCollisionSlot(
  serial: string,
  lease: CollisionLease | null | undefined,
  skipRest = false,
): void {
  if (!lease?.id) return;
  const state = getCollisionState(serial);
  if (state.activeLeaseId !== lease.id) {
    console.info(
      `[COLLISION] ${serial} ignored stale release lease=${lease.id} ` +
      `active=${state.activeLeaseId ?? "none"}`,
    );
    return;
  }

  const released = describe(
    state.activeSource ?? "hst-background",
    state.activeOwner ?? "unknown",
    state.activeSlot ?? -1,
  );
  state.activeLeaseId = null;
  state.activeSlot = null;
  state.activeSource = null;
  state.activeOwner = null;

  if (skipRest || !state.config.enabled) {
    console.info(`[COLLISION] ${serial} released ${released}; continuing without rest`);
    processCollisionQueue(serial);
    return;
  }

  if (state.restTimer !== null) return;
  const min = Math.min(state.config.restMinMin, state.config.restMinMax);
  const max = Math.max(state.config.restMinMin, state.config.restMinMax);
  const restMs = (min + Math.random() * Math.max(0, max - min)) * 60_000;
  console.info(
    `[COLLISION] ${serial} released ${released}; restMs=${Math.round(restMs)} ` +
    `queued=${state.queue.length}`,
  );
  state.restTimer = setTimeout(() => processCollisionQueue(serial), Math.round(restMs));
}

export function cancelCollisionSlot(
  serial: string,
  slotIdx: number,
  source?: CollisionSource,
): void {
  const state = getCollisionState(serial);
  const cancelled = state.queue.filter(entry =>
    entry.slotIdx === slotIdx && (!source || entry.source === source),
  );
  if (cancelled.length === 0) return;
  state.queue = state.queue.filter(entry =>
    !(entry.slotIdx === slotIdx && (!source || entry.source === source)),
  );
  console.info(
    `[COLLISION] ${serial} cancelled ${cancelled.length} queued turn(s) ` +
    `slot=${slotIdx}${source ? ` source=${source}` : ""}`,
  );
  for (const entry of cancelled) resolveCancelled(entry);
}

export function resetCollision(serial: string): void {
  const state = getCollisionState(serial);
  if (state.restTimer !== null) clearTimeout(state.restTimer);
  for (const entry of state.queue) resolveCancelled(entry);
  state.queue = [];
  state.restTimer = null;
  state.busy = false;
  state.activeLeaseId = null;
  state.activeSlot = null;
  state.activeSource = null;
  state.activeOwner = null;
  console.info(`[COLLISION] ${serial} reset`);
}