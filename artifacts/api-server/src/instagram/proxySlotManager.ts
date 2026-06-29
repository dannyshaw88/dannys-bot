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

  /** Returns whether this profileId can acquire a slot on the proxy right now. */
  canAcquire(proxyId: number, profileId: number): { ok: boolean; reason?: string } {
    const entry = this.getEntry(proxyId);
    this.purgeExpiredCooldowns(entry);

    // Already active — idempotent re-acquire is always ok.
    if (entry.active.has(profileId)) return { ok: true };

    const activeCount    = entry.active.size;
    const cooldownCount  = [...entry.cooldowns.values()].filter(e => Date.now() < e).length;
    const used           = activeCount + cooldownCount;

    if (used >= this.settings.maxConcurrent) {
      const cooldownMins = Math.ceil(this.settings.cooldownMinMs / 60000);
      return {
        ok: false,
        reason: `Proxy at capacity: ${activeCount} active, ${cooldownCount} on cooldown (max ${this.settings.maxConcurrent}). Next slot in ~${cooldownMins} min.`,
      };
    }
    return { ok: true };
  }

  /**
   * Acquire a slot for this profile on this proxy.
   * Returns false if the proxy is at capacity or in cooldown.
   */
  acquire(proxyId: number, profileId: number): boolean {
    const check = this.canAcquire(proxyId, profileId);
    if (!check.ok) return false;
    const entry = this.getEntry(proxyId);
    entry.active.add(profileId);
    entry.cooldowns.delete(profileId); // clear any lingering cooldown on re-acquire
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
  }

  /**
   * Force-release without starting a cooldown (used for verify/EB sessions
   * that should not block subsequent automation).
   */
  forceRelease(proxyId: number, profileId: number) {
    const entry = this.getEntry(proxyId);
    entry.active.delete(profileId);
    entry.cooldowns.delete(profileId);
  }

  /** Returns the current slot status for every proxy that has been tracked. */
  getStatus(): ProxySlotStatus[] {
    const result: ProxySlotStatus[] = [];
    const now = Date.now();
    for (const [proxyId, entry] of this.slots) {
      this.purgeExpiredCooldowns(entry);
      const onCooldown = [...entry.cooldowns.values()].filter(e => now < e).length;
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
    const now        = Date.now();
    const onCooldown = [...entry.cooldowns.values()].filter(e => now < e).length;
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
}

export const proxySlotManager = new ProxySlotManager();
