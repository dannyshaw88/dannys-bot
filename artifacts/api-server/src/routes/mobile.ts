
  // ── Reset device for next account creation ────────────────────────────────
  // Uninstalls Instagram, sets a new android_id, clears the device proxy setting,
  // and removes the proxy assignment from the instance config.
  app.post("/api/mobile/devices/:serial/reset", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");

      // 1. Clear Instagram data (keeps the app installed — no re-download needed)
      await android.clearInstagramData(serial);

      // 1b. Reset Google Advertising ID (GAID) — survives pm clear, used by Instagram at signup
      const gaidResult = android.resetAdvertisingId(serial);

      // 2. Fresh device ID
      const newId = android.randomAndroidId();
      await android.setAndroidId(serial, newId);

      // 3. Clear proxy from the device's global settings
      await android.setDeviceProxy(serial, null);

      // 4. Stop the relay, remove adb reverse tunnel, and clear instance config
      android.adbReverseRemove(serial);
      proxyRelay.stopRelayForDevice(serial);
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: null };
      saveInstanceConfigs(cfg);

      // 5. Disconnect the device from ADB so it disappears from the device list
      try {
        const tools = await android.detectToolsetAsync();
        if (tools.adb.path) {
          await execFileP(tools.adb.path, ["disconnect", serial], {
            encoding: "utf8",
            timeout: 5000,
          } as any).catch(() => {});
        }
      } catch { /* non-fatal */ }

      logger.info({ serial, newAndroidId: newId, gaidReset: gaidResult.ok }, "device reset for next account creation");
      res.json({ ok: true, newAndroidId: newId, gaidReset: gaidResult.ok });
    } catch (e: any) {
      logger.error({ err: e }, "device reset failed");
      res.status(500).json({ error: e?.message ?? "Reset failed" });
    }
  });

  // Deep reset: clears Instagram + ALL Google identity (GSF ID + GAID) + Android ID
  // The user must re-sign into their Google account in BlueStacks after this.
  app.post("/api/mobile/devices/:serial/deep-reset", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");

      // 1. Clear Instagram + GMS + GSF (resets GSF ID, GAID, all Google device registration)
      const { steps } = await android.deepResetDevice(serial);

      // 2. Fresh Android ID
      const newId = android.randomAndroidId();
      await android.setAndroidId(serial, newId);
      androidIdCache.set(serial, newId);
      steps.push(`✓ Android ID reset → ${newId}`);

      // 3. Clear proxy
      await android.setDeviceProxy(serial, null);
      steps.push("✓ Proxy cleared");

      // 4. Stop relay, remove adb reverse tunnel, and clear instance config
      android.adbReverseRemove(serial);
      proxyRelay.stopRelayForDevice(serial);
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: null, proxyPort: null, proxyProtocol: null as any };
      saveInstanceConfigs(cfg);

      // 5. Disconnect ADB
      try {
        const tools = await android.detectToolsetAsync();
        if (tools.adb.path) {
          await execFileP(tools.adb.path, ["disconnect", serial], {
            encoding: "utf8",
            timeout: 5000,
          } as any).catch(() => {});
        }
      } catch { /* non-fatal */ }

      logger.info({ serial, newAndroidId: newId, steps }, "device deep reset complete");
      res.json({ ok: true, newAndroidId: newId, steps });
    } catch (e: any) {
      logger.error({ err: e }, "device deep reset failed");
      res.status(500).json({ error: e?.message ?? "Deep reset failed" });
    }
  });

  const saveAccountSchema = z.object({
    username: z.string().min(1),
    password: z.string().min(1),
    email: z.string().optional().nullable(),
    phoneNumber: z.string().optional().nullable(),
    dateOfBirth: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    serial: z.string().optional().nullable(),
    avdName: z.string().optional().nullable(),
    igDeviceState: z.string().optional().nullable(),
    userAgentApi: z.string().optional().nullable(),
  });
  app.post("/api/mobile/accounts", async (req: Request, res: Response) => {
    try {
      const input = saveAccountSchema.parse(req.body);
      const notesPrefix = input.avdName ? `Created via Mobile tab (AVD: ${input.avdName}${input.serial ? `, serial: ${input.serial}` : ""}).` : "Created via Mobile tab.";
      const profile = await storage.createProfile({
        username: input.username,
        password: input.password,
        email: input.email ?? null,
        phoneNumber: input.phoneNumber ?? null,
        dateOfBirth: input.dateOfBirth ?? null,
        notes: [notesPrefix, input.notes].filter(Boolean).join(" "),
        status: "idle",
        accountStatus: "pending",
        credentialsDirty: true,
        ...(input.igDeviceState ? { igDeviceState: input.igDeviceState } : {}),
        ...(input.userAgentApi ? { userAgentApi: input.userAgentApi } : {}),
      } as any);
      res.json({ ok: true, profile });
    } catch (e: any) {
      logger.error({ err: e }, "save mobile account failed");
      res.status(400).json({ error: e?.message ?? "Failed to save account" });
    }
  });

  // ── Drony VPN proxy automation ────────────────────────────────────────────
  // GET  /api/mobile/devices/:serial/drony        → { installed, active }
  // POST /api/mobile/devices/:serial/drony/install → install from apkPath
  // POST /api/mobile/devices/:serial/drony/configure → configure + activate
  // POST /api/mobile/devices/:serial/drony/deactivate → turn VPN off

  app.get("/api/mobile/devices/:serial/drony", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const [installed, active] = await Promise.all([
        android.isDronyInstalled(serial),
        android.isDronyVpnActive(serial),
      ]);
      res.json({ installed, active });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not check Drony status" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/install", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { apkPath } = z.object({ apkPath: z.string().min(1) }).parse(req.body);
      await android.installApk(serial, apkPath);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Install failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/configure", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { proxyId, proxyType } = z.object({
        proxyId: z.number(),
        proxyType: z.string().optional(),
      }).parse(req.body);
      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ error: "Proxy not found" });
      const result = await android.configureDrony(serial, {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
        proxyType: proxyType ?? "SOCKS5",
      });
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Configuration failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/drony/deactivate", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const result = await android.deactivateDrony(serial);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Deactivate failed" });
    }
  });

  // ── Battery charging control ───────────────────────────────────────────────

  /** GET current battery info + active stop-state. */
  app.get("/api/mobile/devices/:serial/battery", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const info   = await android.getBatteryInfo(serial);
      const timer  = batterySpoofTimers.get(serial) ?? null;
      const cfg    = batterySpoofConfigs.get(serial) ?? null;
      const probe  = chargingControlCache.get(serial) ?? null;
      res.json({
        ...info,
        chargingControl: {
          probed:      probe !== null,
          supported:   probe?.supported ?? null,
          path:        probe?.supported ? (probe as any).path : null,
          needsRoot:   probe?.supported ? (probe as any).needsRoot : null,
          failReason:  probe && !probe.supported ? (probe as any).reason : null,
        },
        schedule: {
          active:  !!timer,
          running: timer?.spoofActive ?? false,
          nextAt:  timer?.nextAt ?? null,
          config:  cfg,
        },
      });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  /** POST probe — detect whether this device supports physical charging control.
   *  Takes 2–5 s; result cached in-memory for the lifetime of the server. */
  app.post("/api/mobile/devices/:serial/battery/probe", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const result = await android.probeChargingControl(serial);
      chargingControlCache.set(serial, result);
      res.json(result);
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  /** POST manually stop charging right now (one-shot). */
  app.post("/api/mobile/devices/:serial/battery/stop", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const probe  = chargingControlCache.get(serial);
      if (probe?.supported) {
        await android.stopPhysicalCharging(serial, probe as Extract<android.ChargingControlSupport, { supported: true }>);
        res.json({ ok: true, mode: "real" });
      } else {
        const { level } = z.object({ level: z.number().int().min(1).max(100).default(75) }).parse(req.body);
        await android.setBatterySpoof(serial, level);
        res.json({ ok: true, mode: "spoof" });
      }
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  /** POST resume charging right now. */
  app.post("/api/mobile/devices/:serial/battery/resume", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const probe  = chargingControlCache.get(serial);
      if (probe?.supported) {
        await android.resumePhysicalCharging(serial, probe as Extract<android.ChargingControlSupport, { supported: true }>);
      } else {
        await android.clearBatterySpoof(serial);
      }
      const e = batterySpoofTimers.get(serial);
      if (e) e.spoofActive = false;
      res.json({ ok: true });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  /** GET current schedule config for a serial (loads from DB on first call). */
  app.get("/api/mobile/devices/:serial/battery/schedule", async (req: Request, res: Response) => {
    try {
      const serial  = p(req, "serial");
      // Lazy-load from DB if not already in memory (e.g. after server restart).
      if (!batterySpoofConfigs.has(serial)) {
        const all = await storage.getGlobalSettings();
        const raw = all[`battery_schedule_${serial}`];
        if (raw) {
          const cfg: BatterySpoofConfig = JSON.parse(raw);
          batterySpoofConfigs.set(serial, cfg);
          // Re-arm the scheduler if it was enabled when the server restarted.
          if (cfg.enabled && !batterySpoofTimers.has(serial)) {
            _startBatterySpoofCycle(serial, cfg);
          }
        }
      }
      const cfg   = batterySpoofConfigs.get(serial) ?? null;
      const timer = batterySpoofTimers.get(serial) ?? null;
      res.json({ config: cfg, active: !!timer, spoofActive: timer?.spoofActive ?? false, nextAt: timer?.nextAt ?? null });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  /** POST save schedule config and start/stop the cycle. */
  app.post("/api/mobile/devices/:serial/battery/schedule", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg    = z.object({
        enabled:       z.boolean(),
        unplugMinutes: z.number().int().min(1).max(1440),
        cycleHours:    z.number().min(0.5).max(24),
        spoofLevel:    z.number().int().min(1).max(100),
      }).parse(req.body) as BatterySpoofConfig;
      batterySpoofConfigs.set(serial, cfg);
      await storage.setGlobalSetting(`battery_schedule_${serial}`, JSON.stringify(cfg));
      if (cfg.enabled) {
        _startBatterySpoofCycle(serial, cfg);
      } else {
        _stopBatterySpoofCycle(serial);
        const probe = chargingControlCache.get(serial);
        if (probe?.supported) {
          await android.resumePhysicalCharging(serial, probe as Extract<android.ChargingControlSupport, { supported: true }>).catch(() => {});
        } else {
          await android.clearBatterySpoof(serial).catch(() => {});
        }
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Collision Preventer settings ──────────────────────────────────────────
  // Stored as a global setting keyed by serial. Purely advisory (client-side
  // queue logic uses the values); server just persists and returns them.

  app.get("/api/mobile/devices/:serial/collision-preventer", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const all    = await storage.getGlobalSettings();
      // Prefer the current key. The legacy key may still contain an older
      // default config and must not mask values saved through this endpoint.
      const raw    = all[`collision_preventer_${serial}`] ?? all[`collision_scheduler_${serial}`] ?? null;
      const config = raw ? JSON.parse(raw) : null;
      res.json({ config });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/collision-preventer", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg    = z.object({
        enabled:     z.boolean(),
        restMinMin:  z.number().min(0).max(60),
        restMinMax:  z.number().min(0).max(60),
      }).parse(req.body);
      await storage.setGlobalSetting(`collision_preventer_${serial}`, JSON.stringify(cfg));
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Device Browser proxy config ───────────────────────────────────────────
  // The "Browser" tab on each device detail page uses a synthetic Puppeteer
  // profileId derived from the device serial (same hash as the client's
  // serialToBrowserId in MobilePage.tsx). Proxy credentials are stored here
  // per device so the browser WebSocket handler in instagram.ts can pick them
  // up without a real DB profile lookup.
  function serialToBrowserProfileId(serial: string): number {
    let h = 5381;
    for (let i = 0; i < serial.length; i++) {
      h = (((h << 5) + h) ^ serial.charCodeAt(i)) >>> 0;
    }
    return 1_000_000 + (h % 8_999_999);
  }

  app.get("/api/mobile/devices/:serial/browser-proxy", async (req: Request, res: Response) => {
    try {
      const serial    = p(req, "serial");
      const profileId = serialToBrowserProfileId(serial);
      const all       = await storage.getGlobalSettings();
      const raw       = all[`device_browser_proxy_${profileId}`] ?? null;
      const proxy     = raw && raw !== "null" ? JSON.parse(raw) : null;
      res.json({ proxy });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/browser-proxy", async (req: Request, res: Response) => {
    try {
      const serial    = p(req, "serial");
      const profileId = serialToBrowserProfileId(serial);
      // Accept { host, port, username, password } or null to clear.
      const body = req.body;
      if (body === null || body?.clear === true) {
        await storage.setGlobalSetting(`device_browser_proxy_${profileId}`, "null");
        return res.json({ ok: true });
      }
      // useLocalIp — no proxy, browser uses the PC's own IP address
      if (body?.useLocalIp === true) {
        await storage.setGlobalSetting(`device_browser_proxy_${profileId}`, JSON.stringify({ useLocalIp: true }));
        return res.json({ ok: true });
      }
      const cfg = z.object({
        host:     z.string().min(1),
        port:     z.number().int().min(1).max(65535),
        username: z.string().default(""),
        password: z.string().default(""),
      }).parse(body);
      await storage.setGlobalSetting(`device_browser_proxy_${profileId}`, JSON.stringify(cfg));
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Mobile Phone Apps scheduler settings ─────────────────────────────────
  // Simple enabled + interval (min/max minutes) persisted per device serial.
  // Stored inside mobile-instances.json under cfg[serial].phoneApps so it
  // travels with the rest of the device config.

  app.get("/api/mobile/devices/:serial/phone-apps-settings", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg    = loadInstanceConfigs();
      const saved  = (cfg[serial] as any)?.phoneApps ?? null;
      const defaults = {
        enabled: false,
        intervalMin: 25,
        intervalMax: 99,
        chrome: {
          enabled: false,
          activatePctMin: 0,
          activatePctMax: 0,
          scrollMin: 1,
          scrollMax: 5,
          storyTapMin: 0,
          storyTapMax: 0,
          tappedStoryScrollMin: 0,
          tappedStoryScrollMax: 0,
          internalLinkPctMin: 0,
          internalLinkPctMax: 0,
          manualSearches: false,
          manualSearchPctMin: 0,
          manualSearchPctMax: 0,
          manualSearchCountMin: 1,
          manualSearchCountMax: 1,
          manualSearchScrollMin: 0,
          manualSearchScrollMax: 0,
          manualSearchLinkPctMin: 0,
          manualSearchLinkPctMax: 0,
          manualSearchDwellMin: 3,
          manualSearchDwellMax: 8,
           tapTrendingStoryMin: 0,
           tapTrendingStoryMax: 0,
        },
        snapchat: { enabled: false, activatePctMin: 0, activatePctMax: 0 },
        youtube: { enabled: false, activatePctMin: 0, activatePctMax: 0 },
        whatsapp: {
          enabled: false,
          activatePctMin: 0,
          activatePctMax: 0,
          userCountMin: 1,
          userCountMax: 1,
          message: "",
        },
      };
      res.json({
        ...defaults,
        ...saved,
        chrome: { ...defaults.chrome, ...((saved as any)?.chrome ?? {}) },
      });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/phone-apps-settings", (req: Request, res: Response) => {
    try {
      const serial   = p(req, "serial");
      const cfg      = loadInstanceConfigs();
      const existing = (cfg[serial] as any)?.phoneApps ?? {
        enabled: false,
        intervalMin: 25,
        intervalMax: 99,
        chrome: {
          enabled: false,
          manualSearches: false,
          manualSearchPctMin: 0,
          manualSearchPctMax: 0,
          manualSearchCountMin: 1,
          manualSearchCountMax: 1,
          manualSearchScrollMin: 0,
          manualSearchScrollMax: 0,
          manualSearchLinkPctMin: 0,
          manualSearchLinkPctMax: 0,
          manualSearchDwellMin: 3,
          manualSearchDwellMax: 8,
           tapTrendingStoryMin: 0,
           tapTrendingStoryMax: 0,
        },
      };
      // All fields optional — caller may send just { enabled } from the card-level
      // toggle without needing to know the current interval values.
      const input = z.object({
        enabled:     z.boolean().optional(),
        intervalMin: z.number().min(1).max(9999).optional(),
        intervalMax: z.number().min(1).max(9999).optional(),
        chrome: z.object({
          enabled: z.boolean().optional(),
          activatePctMin: z.number().int().min(0).max(100).optional(),
          activatePctMax: z.number().int().min(0).max(100).optional(),
          scrollMin: z.number().min(0).optional(),
          scrollMax: z.number().min(0).optional(),
          storyTapMin: z.number().int().min(0).optional(),
          storyTapMax: z.number().int().min(0).optional(),
          tappedStoryScrollMin: z.number().int().min(0).optional(),
          tappedStoryScrollMax: z.number().int().min(0).optional(),
          internalLinkPctMin: z.number().int().min(0).max(100).optional(),
          internalLinkPctMax: z.number().int().min(0).max(100).optional(),
          manualSearches: z.boolean().optional(),
          manualSearchPctMin: z.number().int().min(0).max(100).optional(),
          manualSearchPctMax: z.number().int().min(0).max(100).optional(),
          manualSearchCountMin: z.number().int().min(1).optional(),
          manualSearchCountMax: z.number().int().min(1).optional(),
          manualSearchScrollMin: z.number().int().min(0).optional(),
          manualSearchScrollMax: z.number().int().min(0).optional(),
          manualSearchLinkPctMin: z.number().int().min(0).max(100).optional(),
          manualSearchLinkPctMax: z.number().int().min(0).max(100).optional(),
          manualSearchDwellMin: z.number().min(1).max(10).optional(),
          manualSearchDwellMax: z.number().min(1).max(10).optional(),
           tapTrendingStoryMin: z.number().int().min(0).optional(),
           tapTrendingStoryMax: z.number().int().min(0).optional(),
        }).passthrough().optional(),
        whatsapp: z.object({
          enabled: z.boolean().optional(),
          activatePctMin: z.number().int().min(0).max(100).optional(),
          activatePctMax: z.number().int().min(0).max(100).optional(),
          userCountMin: z.number().int().min(1).max(100).optional(),
          userCountMax: z.number().int().min(1).max(100).optional(),
          message: z.string().max(10_000).optional(),
          media: z.object({
            fileName: z.string().min(1).max(255),
            mimeType: z.string().min(1).max(200),
            dataUrl: z.string().max(100_000_000),
          }).optional(),
        }).passthrough().optional(),
      }).passthrough().parse(req.body);
      const merged = {
        ...existing,
        ...input,
        ...(input.chrome ? { chrome: { ...(existing.chrome ?? {}), ...input.chrome } } : {}),
        ...(input.whatsapp ? { whatsapp: { ...(existing.whatsapp ?? {}), ...input.whatsapp } } : {}),
      };
      (cfg[serial] as any) = { ...cfg[serial], phoneApps: merged };
      saveInstanceConfigs(cfg);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Run a single phone app (called by the frontend scheduler per-cycle) ────
  // The frontend rolls the activation % and only calls this when activated.
  // Returns { ok, steps } — steps are appended to the device debug log.
  app.post("/api/mobile/devices/:serial/run-phone-app", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      // Phone Apps and Human Session Tool share the same physical device.
      // Never wake/tap another app while an Instagram cycle owns the device;
      // doing so can race the post/share flow and make account-switch UI appear
      // to happen at the wrong point in the cycle.
      if (automationCycleInProgress.has(serial) || checkFeedInProgress.has(serial)) {
        res.status(409).json({
          ok: false,
          skipped: true,
          error: "Device is busy with an Instagram automation cycle",
        });
        return;
      }
      const { app: appId, scrollMin, scrollMax, storyTapMin, storyTapMax,
              tappedStoryScrollMin, tappedStoryScrollMax,
              internalLinkPctMin, internalLinkPctMax,
              manualSearches, manualSearchPctMin, manualSearchPctMax,
              manualSearchCountMin, manualSearchCountMax,
              manualSearchScrollMin, manualSearchScrollMax,
              manualSearchLinkPctMin, manualSearchLinkPctMax,
              manualSearchDwellMin, manualSearchDwellMax,
               tapTrendingStoryMin, tapTrendingStoryMax,
              clickPctMin, clickPctMax,
              watchTimeMin, watchTimeMax,
              clickShortsPctMin, clickShortsPctMax,
              shortsScrollMin, shortsScrollMax,
              shortsWatchTimeMin, shortsWatchTimeMax,
               shortsLikePctMin, shortsLikePctMax,
               userCountMin, userCountMax, message, media } = z.object({
        app:                  z.enum(["chrome", "snapchat", "youtube", "whatsapp"]),
        scrollMin:            z.number().min(0).optional(),
        scrollMax:            z.number().min(0).optional(),
        storyTapMin:          z.number().int().min(0).optional(),
        storyTapMax:          z.number().int().min(0).optional(),
        tappedStoryScrollMin: z.number().int().min(0).optional(),
        tappedStoryScrollMax: z.number().int().min(0).optional(),
        internalLinkPctMin:   z.number().int().min(0).max(100).optional(),
        internalLinkPctMax:   z.number().int().min(0).max(100).optional(),
        manualSearches:       z.boolean().optional(),
        manualSearchPctMin:   z.number().int().min(0).max(100).optional(),
        manualSearchPctMax:   z.number().int().min(0).max(100).optional(),
        manualSearchCountMin: z.number().int().min(1).optional(),
        manualSearchCountMax: z.number().int().min(1).optional(),
        manualSearchScrollMin: z.number().int().min(0).optional(),
        manualSearchScrollMax: z.number().int().min(0).optional(),
        manualSearchLinkPctMin: z.number().int().min(0).max(100).optional(),
        manualSearchLinkPctMax: z.number().int().min(0).max(100).optional(),
        manualSearchDwellMin: z.number().min(1).max(10).optional(),
        manualSearchDwellMax: z.number().min(1).max(10).optional(),
         tapTrendingStoryMin: z.number().int().min(0).optional(),
         tapTrendingStoryMax: z.number().int().min(0).optional(),
        // YouTube-specific
        clickPctMin:          z.number().int().min(0).max(100).optional(),
        clickPctMax:          z.number().int().min(0).max(100).optional(),
        watchTimeMin:         z.number().min(0).max(600).optional(),
        watchTimeMax:         z.number().min(0).max(600).optional(),
        clickShortsPctMin:    z.number().int().min(0).max(100).optional(),
        clickShortsPctMax:    z.number().int().min(0).max(100).optional(),
        shortsScrollMin:      z.number().int().min(0).optional(),
        shortsScrollMax:      z.number().int().min(0).optional(),
        shortsWatchTimeMin:   z.number().min(0).max(600).optional(),
        shortsWatchTimeMax:   z.number().min(0).max(600).optional(),
        shortsLikePctMin:     z.number().int().min(0).max(100).optional(),
         shortsLikePctMax:     z.number().int().min(0).max(100).optional(),
         userCountMin:         z.number().int().min(1).max(100).optional(),
         userCountMax:         z.number().int().min(1).max(100).optional(),
         message:              z.string().max(10_000).optional(),
         media: z.object({
           fileName: z.string().min(1).max(255),
           mimeType: z.string().min(1).max(200),
           dataUrl: z.string().max(100_000_000),
         }).nullable().optional(),
       }).parse(req.body);

      // Resolve dismiss direction (used by Chrome recents close).
      // Priority: device-prefs override → model lookup.
      const devicePrefsPA = (() => {
        try { return loadInstanceConfigs()[serial]?.devicePrefs ?? {}; } catch { return {}; }
      })();
      const rawModelPA  = android.getDeviceModel(serial);
      const dismissDir: "left" | "up" =
        (devicePrefsPA.dismissDirection && devicePrefsPA.dismissDirection !== "auto")
          ? devicePrefsPA.dismissDirection
          : android.getModelDismissDirection(rawModelPA);

      // Wake and unlock the screen before launching any app.
      // Without this the device stays dark and am start is a no-op because
      // the keyguard is in the way.
      await android.wakeScreen(serial);
      await android.unlockScreen(serial);

      let result: { ok: boolean; steps: string[]; error?: string; contactKeysUsed?: string[] };

      if (appId === "chrome") {
        result = await android.runChromeApp(serial, {
          scrollMin, scrollMax, storyTapMin, storyTapMax,
          tappedStoryScrollMin, tappedStoryScrollMax,
          internalLinkPctMin, internalLinkPctMax,
          manualSearches, manualSearchPctMin, manualSearchPctMax,
          manualSearchCountMin, manualSearchCountMax,
          manualSearchScrollMin, manualSearchScrollMax,
          manualSearchLinkPctMin, manualSearchLinkPctMax,
          manualSearchDwellMin, manualSearchDwellMax,
          typingProfile: devicePrefsPA.typingSpeedProfile,
          swipeGesture: devicePrefsPA.swipeGesture,
           tapTrendingStoryMin, tapTrendingStoryMax,
          dismissDirection: dismissDir,
        });
      } else if (appId === "youtube") {
        result = await android.runYoutubeApp(serial, {
          scrollMin, scrollMax,
          clickPctMin, clickPctMax,
          watchTimeMin, watchTimeMax,
          clickShortsPctMin, clickShortsPctMax,
          shortsScrollMin, shortsScrollMax,
          shortsWatchTimeMin, shortsWatchTimeMax,
          shortsLikePctMin, shortsLikePctMax,
          swipeGesture: devicePrefsPA.swipeGesture,
          dismissDirection: dismissDir,
        });
      } else if (appId === "whatsapp") {
        if (!message?.trim()) throw new Error("WhatsApp message is empty");
        const savedWhatsAppHistory = (() => {
          try {
            const saved = (loadInstanceConfigs()[serial] as any)?.phoneApps?.whatsapp?.recentContactKeys;
            return Array.isArray(saved)
              ? saved.filter((key: unknown): key is string => typeof key === "string")
              : [];
          } catch {
            return [];
          }
        })();
        result = await android.runWhatsAppApp(serial, {
          userCountMin,
          userCountMax,
          message,
          recentContactKeys: savedWhatsAppHistory,
          dismissDirection: dismissDir,
          swipeGesture: devicePrefsPA.swipeGesture,
          media,
        });
        if (result.contactKeysUsed?.length) {
          const cfgAfterRun = loadInstanceConfigs();
          const existingPhoneApps = (cfgAfterRun[serial] as any)?.phoneApps ?? {};
          const existingWhatsApp = existingPhoneApps.whatsapp ?? {};
          const priorHistory = Array.isArray(existingWhatsApp.recentContactKeys)
            ? existingWhatsApp.recentContactKeys.filter((key: unknown): key is string => typeof key === "string")
            : [];
          const history = [...priorHistory, ...result.contactKeysUsed]
            .filter((key, index, all) => all.indexOf(key) === index)
            .slice(-20);
          (cfgAfterRun[serial] as any) = {
            ...cfgAfterRun[serial],
            phoneApps: {
              ...existingPhoneApps,
              whatsapp: { ...existingWhatsApp, recentContactKeys: history },
            },
          };
          saveInstanceConfigs(cfgAfterRun);
        }
      } else {
        // Snapchat is not implemented yet.
        result = { ok: true, steps: [`${appId}: not yet implemented`] };
      }

      res.json(result);
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  // ── Finish a Phone Apps cycle ─────────────────────────────────────────────
  // App-specific handlers close their own app through the verified recents
  // gesture.  The scheduler calls this only after the last selected app has
  // returned (or when no app activation roll fired), so the device is left in
  // the same screen-off state as the Human Session Tool.
  app.post("/api/mobile/devices/:serial/phone-apps-complete", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      // Do not let a late scheduler completion request lock or otherwise
      // manipulate a device that has already been claimed by HST.
      if (automationCycleInProgress.has(serial) || checkFeedInProgress.has(serial)) {
        res.status(409).json({
          ok: false,
          skipped: true,
          error: "Device is busy with an Instagram automation cycle",
        });
        return;
      }
      await android.sleepScreen(serial);
      logger.info({ serial }, "phone apps cycle complete; phone locked");
      res.json({ ok: true, locked: true });
    } catch (e: any) {
      logger.error({ serial: p(req, "serial"), err: e }, "phone apps cycle could not lock phone");
      res.status(400).json({ ok: false, locked: false, error: e?.message ?? "Could not lock phone" });
    }
  });

  // ── Client-side dashboard event logger ────────────────────────────────────
  // Used by the Collision Preventer (and any future client-side events) to
  // create a session_action row without going through the full cycle endpoint.
  app.post("/api/mobile/devices/:serial/log-event", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const body = z.object({
        slotUsername: z.string(),
        slotIdx:      z.number().int().min(0).default(0),
        action:       z.string(),
        detail:       z.string(),
        result:       z.string().default("ok"),
      }).parse(req.body);

      // Resolve EB profileId the same way the cycle does.
      let profileId = 0;
      if (body.slotUsername) {
        const allProfiles = await storage.getProfiles();
        const match = allProfiles.find(
          p => p.username === body.slotUsername || p.accountLabel === body.slotUsername
        );
        if (match) profileId = match.id;
      }

      await storage.createSessionAction({
        profileId,
        toolId: 0,
        action: body.action,
        targetUsername: body.slotUsername,
        detail: body.detail,
        result: body.result,
        sourceValue: `${serial}:${body.slotIdx}`,
        sourceType: "phone",
        timestamp: new Date().toISOString(),
      });
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ─── Keyboard Calibration ─────────────────────────────────────────────────
  // Captures one physical tap via getevent so the UI can build a per-device
  // key map for real-tap keyboard typing (each keystroke = real OS touch event).

  // Fixed Instagram controls use a separate strict map. Runtime HST navigation
  // never falls back to accessibility, reference images, or guessed positions.
  app.post("/api/mobile/devices/:serial/navigation-calibration/prefetch", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      res.json({ ok: await android.prefetchCalibrationData(serial) });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  app.get("/api/mobile/devices/:serial/navigation-calibration", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      res.json({ ok: true, map: android.loadNavigationCalibrationMap(serial), controlIds: android.NAVIGATION_CONTROL_IDS });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/navigation-calibration/capture", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { timeoutMs } = z.object({
        timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
      }).parse(req.body);
      const result = await android.captureOneTap(serial, timeoutMs, message => {
        req.log.info({ serial, message }, "[navigation-calibration]");
      });
      if (!result) return void res.status(408).json({ ok: false, error: "No tap detected within timeout — tap the named control on the physical phone" });
      const screen = android.getScreenSize(serial);
      res.json({ ok: true, x: result.x, y: result.y, screen });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/navigation-calibration/save", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { points } = z.object({
        points: z.record(z.string(), z.object({ x: z.number().finite(), y: z.number().finite() })),
      }).parse(req.body);
      const map = android.saveNavigationCalibrationMap(serial, points as any);
      res.json({ ok: true, map, count: Object.keys(map.points).length });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/navigation-calibration/test", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { control } = z.object({ control: z.enum(android.NAVIGATION_CONTROL_IDS) }).parse(req.body);
      const point = await android.tapCalibratedNavigationControl(serial, control, message => {
        req.log.info({ serial, message }, "[navigation-calibration]");
      });
      res.json({ ok: true, control, x: point.x, y: point.y });
    } catch (e: any) {
      req.log.warn({ err: e }, "[navigation-calibration] test failed");
      res.status(422).json({ ok: false, error: e?.message });
    }
  });

  app.delete("/api/mobile/devices/:serial/navigation-calibration", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      android.deleteNavigationCalibrationMap(serial);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  app.delete("/api/mobile/devices/:serial/navigation-calibration/:control", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { control } = z.object({ control: z.enum(android.NAVIGATION_CONTROL_IDS) }).parse(req.params);
      const map = android.deleteNavigationCalibrationControl(serial, control);
      res.json({ ok: true, map, count: map ? Object.keys(map.points).length : 0 });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  /** Pre-warm device-info + screen-size caches so subsequent captures are instant. */
  app.post("/api/mobile/devices/:serial/keyboard-calibration/prefetch", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const ok = await android.prefetchCalibrationData(serial);
      res.json({ ok });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  /** Type text strictly through the saved per-device calibration map. */
  app.post("/api/mobile/devices/:serial/keyboard-calibration/test", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { text } = z.object({
        text: z.string().min(1).max(200),
      }).parse(req.body);
      const map = android.loadKeyCalibrationMap(serial);
      if (!map) {
        return void res.status(422).json({
          ok: false,
          missing: [...text],
          error: "No saved keyboard calibration map for this device",
        });
      }
      const typingProfile = effectiveTypingProfile(serial);
      const result = await android.typeViaCalibrationMap(serial, text, map, message => {
        req.log.info({ serial, message }, "[keyboard-calibration]");
      }, typingProfile);
      req.log.info(
        { serial, characterCount: text.length, missing: result.missing },
        "[keyboard-calibration] test complete",
      );
      res.status(result.ok ? 200 : 422).json(result);
    } catch (e: any) {
      req.log.error({ err: e }, "[keyboard-calibration] test failed");
      res.status(400).json({ ok: false, error: e?.message });
    }
  });

  /** Wait for a single physical tap and return its screen-pixel coordinate. */
  app.post("/api/mobile/devices/:serial/keyboard-calibration/capture", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { timeoutMs } = z.object({
        timeoutMs: z.number().int().min(1000).max(30_000).default(15_000),
      }).parse(req.body);
      const result = await android.captureOneTap(serial, timeoutMs, message => {
        req.log.info({ serial, message }, "[keyboard-calibration]");
      });
      if (!result) {
        return void res.status(408).json({ ok: false, error: "No tap detected within timeout — make sure a keyboard key was pressed" });
      }
      res.json({ ok: true, x: result.x, y: result.y });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  /** Get the saved calibration map for a device (null if none saved yet). */
  app.get("/api/mobile/devices/:serial/keyboard-calibration", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const map = android.loadKeyCalibrationMap(serial);
      res.json({ ok: true, map });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  /** Save a calibration map for a device. */
  app.post("/api/mobile/devices/:serial/keyboard-calibration/save", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { map } = z.object({
        map: z.record(z.string(), z.object({ x: z.number(), y: z.number() })),
      }).parse(req.body);
      android.saveKeyCalibrationMap(serial, map);
      res.json({ ok: true, count: Object.keys(map).length });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  /** Delete the calibration map for a device. */
  app.delete("/api/mobile/devices/:serial/keyboard-calibration", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      android.deleteKeyCalibrationMap(serial);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });
}
