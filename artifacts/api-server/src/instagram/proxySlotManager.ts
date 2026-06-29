// Proxy Slot Manager
// Enforces a maximum number of concurrent accounts per proxy, plus a
// randomised cooldown period after each account finishes — preventing
// proxies from being hammered by too many simultaneous sessions.
//
// Rules:
//   • At most `maxConcurrent` accounts may be ACTIVE on the same proxy at once.
//   • When an account finishes, that slot enters COOLDOWN for a random
//     duration between cooldownMinMs and cooldownMaxMs milliseconds.
//   • During cooldown the slot is unavailable — no new account can fill it.
//   • Only when the cooldown expires does the slot open back up.
//
// Slot enforcement applies to:
//   1. Automation engine — before launching any tool runner for a profile.
//   2. Verify route — before opening the embedded browser for verification.
//   3. Manual EB open — before opening a browser session for a profile.
//
// Counting rule: a profile that is simultaneously in `active` AND `cooldowns`
// (which happens while an EB session is open for a profile that previously had
// an automation cooldown) is counted only once — as ACTIVE.  The cooldown
// entry is kept so it can be restored if the EB closes before the expiry.

export interface ProxySlotSettings {
  maxConcurrent: number;
  cooldownMinMs: number;
  cooldownMaxMs: number;
}

export interface ProxySlotStatus {
  proxyId: number;
  active: number;
  onCooldown: number;
  max: number;
  available: number;
  activeProfileIds: number[];
}

interface SlotEntry {
  active: Set<number>;              // profileIds currently active on this proxy
  cooldowns: Map<number, number>;   // profileId → cooldown-expiry timestamp (ms)
}

class ProxySlotManager {
  private slots = new Map<number, SlotEntry>();
  private settings: ProxySlotSettings = {
    maxConcurrent: 2,
    cooldownMinMs: 30 * 60 * 1000,
    cooldownMaxMs: 35 * 60 * 1000,
  };
  private saveFn: (() => void) | null = null;

  /** Register a callback that is invoked after every state mutation. */
  setSaveFn(fn: () => void) {
    this.saveFn = fn;
  }

  private notifyChange() {
    try { this.saveFn?.(); } catch { /* non-fatal */ }
  }

  updateSettings(s: ProxySlotSettings) {
    this.settings = { ...s };
  }

  getSettings(): ProxySlotSettings {
    return { ...this.settings };
  }

  private getEntry(proxyId: number): SlotEntry {
    if (!this.slots.has(proxyId)) {
      this.slots.set(proxyId, { active: new Set(), cooldowns: new Map() });
    }
    return this.slots.get(proxyId)!;
  }

  private purgeExpiredCooldowns(entry: SlotEntry) {
    const now = Date.now();
    for (const [pid, expiry] of entry.cooldowns) {
      if (now >= expiry) entry.cooldowns.delete(pid);
    }
  }

  /**
   * Count cooldown slots excluding profiles that are already in `active`
   * (those are counted under the active bucket, not the cooldown bucket).
   */
  private cooldownCount(entry: SlotEntry): number {
    const now = Date.now();
    let count = 0;
    for (const [pid, expiry] of entry.cooldowns) {
      if (!entry.active.has(pid) && now < expiry) count++;
    }
    return count;
  }

  /** Returns whether this profileId can acquire a slot on the proxy right now. */
  canAcquire(proxyId: number, profileId: number): { ok: boolean; reason?: string } {
    const entry = this.getEntry(proxyId);
    this.purgeExpiredCooldowns(entry);

    // Already active — idempotent re-acquire is always ok.
    if (entry.active.has(profileId)) return { ok: true };

    const activeCount   = entry.active.size;
    const onCooldown    = this.cooldownCount(entry);
    const used          = activeCount + onCooldown;

    if (used >= this.settings.maxConcurrent) {
      const cooldownMins = Math.ceil(this.settings.cooldownMinMs / 60000);
      return {
        ok: false,
        reason: `Proxy at capacity: ${activeCount} active, ${onCooldown} on cooldown (max ${this.settings.maxConcurrent}). Next slot in ~${cooldownMins} min.`,
      };
    }
    return { ok: true };
  }

  /**
   * Acquire a slot for this profile on this proxy.
   * Returns false if the proxy is at capacity or in cooldown.
   *
   * @param clearCooldown  When true (default — automation), any existing cooldown
   *                       for this profile is cleared before going active.
   *                       When false (EB sessions), the cooldown entry is
   *                       preserved so it resumes if the EB closes before expiry.
   */
  acquire(proxyId: number, profileId: number, clearCooldown = true): boolean {
    const check = this.canAcquire(proxyId, profileId);
    if (!check.ok) return false;
    const entry = this.getEntry(proxyId);
    entry.active.add(profileId);
    if (clearCooldown) entry.cooldowns.delete(profileId);
    this.notifyChange();
    return true;
  }

  /**
   * Release the slot for this profile and start the cooldown timer.
   * The cooldown duration is randomised between cooldownMinMs and cooldownMaxMs.
   */
  release(proxyId: number, profileId: number) {
    const entry = this.getEntry(proxyId);
    if (!entry.active.has(profileId)) return; // not active, nothing to release
    entry.active.delete(profileId);
    const { cooldownMinMs, cooldownMaxMs } = this.settings;
    const cooldownMs = cooldownMinMs + Math.random() * (cooldownMaxMs - cooldownMinMs);
    entry.cooldowns.set(profileId, Date.now() + cooldownMs);
    this.notifyChange();
  }

  /**
   * Force-release without starting a cooldown (used for verify/EB sessions
   * that should not block subsequent automation).
   *
   * IMPORTANT: does NOT delete any existing cooldown entry.  If this profile
   * had an automation-originated cooldown that was preserved during an EB
   * session (acquire called with clearCooldown=false), that cooldown continues
   * running after the EB closes.
   */
  forceRelease(proxyId: number, profileId: number) {
    const entry = this.getEntry(proxyId);
    entry.active.delete(profileId);
    // Intentionally do NOT touch entry.cooldowns — any pre-existing automation
    // cooldown for this profile must survive the EB window closing.
    this.notifyChange();
  }

  /** Returns the current slot status for every proxy that has been tracked. */
  getStatus(): ProxySlotStatus[] {
    const result: ProxySlotStatus[] = [];
    for (const [proxyId, entry] of this.slots) {
      this.purgeExpiredCooldowns(entry);
      const onCooldown = this.cooldownCount(entry);
      const active     = entry.active.size;
      const max        = this.settings.maxConcurrent;
      result.push({
        proxyId,
        active,
        onCooldown,
        max,
        available: Math.max(0, max - active - onCooldown),
        activeProfileIds: [...entry.active],
      });
    }
    return result;
  }

  /** Returns the current slot status for a single proxy. */
  getProxyStatus(proxyId: number): ProxySlotStatus {
    const entry = this.getEntry(proxyId);
    this.purgeExpiredCooldowns(entry);
    const onCooldown = this.cooldownCount(entry);
    const active     = entry.active.size;
    const max        = this.settings.maxConcurrent;
    return {
      proxyId,
      active,
      onCooldown,
      max,
      available: Math.max(0, max - active - onCooldown),
      activeProfileIds: [...entry.active],
    };
  }

  /**
   * Serialize all non-expired cooldown state to a JSON string for DB persistence.
   * Active slots are NOT persisted — if the server restarts, running sessions
   * are gone and we only need to preserve the cooldown windows.
   */
  serialize(): string {
    const state: Record<number, Record<number, number>> = {};
    const now = Date.now();
    for (const [proxyId, entry] of this.slots) {
      const proxyState: Record<number, number> = {};
      for (const [profileId, expiry] of entry.cooldowns) {
        if (now < expiry) proxyState[profileId] = expiry;
      }
      if (Object.keys(proxyState).length > 0) state[proxyId] = proxyState;
    }
    return JSON.stringify(state);
  }

  /**
   * Restore cooldown state from a previously serialized JSON string.
   * Only non-expired entries are restored.  Active slots are not restored
   * (they were in-flight when the server was killed and must be re-acquired
   * by the automation engine on its next tick).
   */
  restore(json: string) {
    try {
      const state = JSON.parse(json) as Record<string, Record<string, number>>;
      const now = Date.now();
      for (const [proxyIdStr, cooldowns] of Object.entries(state)) {
        const proxyId = Number(proxyIdStr);
        if (!Number.isFinite(proxyId)) continue;
        const entry = this.getEntry(proxyId);
        for (const [profileIdStr, expiry] of Object.entries(cooldowns)) {
          const profileId = Number(profileIdStr);
          if (!Number.isFinite(profileId)) continue;
          if (now < expiry) entry.cooldowns.set(profileId, expiry);
        }
      }
    } catch { /* non-fatal — start with empty state */ }
  }
}

export const proxySlotManager = new ProxySlotManager();
