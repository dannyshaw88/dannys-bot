import type { Express, Request, Response } from "express";
import { z } from "zod/v4";
import fs from "fs";
import path from "path";
import * as android from "../mobile/androidManager";
import { storage } from "../storage";
import { logger } from "../lib/logger";

const p = (req: Request, key: string): string => String((req.params as any)[key] ?? "");

// ── Per-instance config (proxy assignment) ────────────────────────────────────
// Stored in mobile-instances.json next to the DB so it survives restarts.
type InstanceConfig = { proxyId?: number | null };
type InstanceConfigMap = Record<string, InstanceConfig>;

function configFilePath(): string {
  return path.join(process.cwd(), "mobile-instances.json");
}
function loadInstanceConfigs(): InstanceConfigMap {
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    return JSON.parse(raw) as InstanceConfigMap;
  } catch { return {}; }
}
function saveInstanceConfigs(cfg: InstanceConfigMap): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2));
}

export function registerMobileRoutes(app: Express) {
  app.get("/api/mobile/status", async (_req: Request, res: Response) => {
    try {
      const toolset = android.detectToolset();
      res.json({
        platform: process.platform,
        toolset,
        // ready = can start emulators (adb + emulator); canCreate = can make AVDs (avdmanager)
        ready: toolset.adb.found && toolset.emulator.found,
        canCreate: toolset.avdmanager.found,
      });
    } catch (e: any) {
      logger.error({ err: e }, "mobile status failed");
      res.status(500).json({ error: e?.message ?? "Status check failed" });
    }
  });

  app.get("/api/mobile/avds", async (_req: Request, res: Response) => {
    try {
      const avds = await android.getAvdInfo();
      const devices = await android.listDevices();
      res.json({ avds, devices });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to list AVDs" });
    }
  });

  const createSchema = z.object({
    name: z.string().min(1).regex(/^[A-Za-z0-9_\-]+$/, "Only letters, numbers, underscore, dash"),
    systemImage: z.string().optional(),
  });
  app.post("/api/mobile/avds", async (req: Request, res: Response) => {
    try {
      const input = createSchema.parse(req.body);
      await android.createAvd(input.name, input.systemImage);
      res.json({ ok: true, name: input.name });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to create AVD" });
    }
  });

  // ── Connect / disconnect emulator ─────────────────────────────────────────────
  const connectSchema = z.object({ address: z.string().min(1) });
  app.post("/api/mobile/connect", async (req: Request, res: Response) => {
    try {
      const { address } = connectSchema.parse(req.body);
      const result = await android.connectDevice(address);
      res.json(result);
    } catch (e: any) { res.status(400).json({ ok: false, message: e?.message }); }
  });

  app.post("/api/mobile/disconnect", async (req: Request, res: Response) => {
    try {
      const { address } = connectSchema.parse(req.body);
      await android.disconnectDevice(address);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ ok: false, message: e?.message }); }
  });

  app.post("/api/mobile/discover", async (_req: Request, res: Response) => {
    try {
      const results = await android.autoDiscoverEmulators();
      res.json({ results });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Instance config (proxy assignment) ───────────────────────────────────────
  app.get("/api/mobile/config", async (_req: Request, res: Response) => {
    try {
      const [cfg, proxies] = await Promise.all([
        Promise.resolve(loadInstanceConfigs()),
        storage.getProxies(),
      ]);
      res.json({ instanceConfigs: cfg, proxies });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const instanceConfigSchema = z.object({ proxyId: z.number().nullable().optional() });
  app.post("/api/mobile/instances/:name/config", async (req: Request, res: Response) => {
    try {
      const name = p(req, "name");
      const input = instanceConfigSchema.parse(req.body);
      const cfg = loadInstanceConfigs();
      cfg[name] = { ...cfg[name], ...input };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, config: cfg[name] });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Apply proxy to a running device via ADB (call after boot)
  const deviceProxySchema = z.object({ proxyId: z.number().nullable() });
  app.post("/api/mobile/devices/:serial/proxy", async (req: Request, res: Response) => {
    try {
      const input = deviceProxySchema.parse(req.body);
      if (input.proxyId) {
        const proxies = await storage.getProxies();
        const proxy = proxies.find(pr => pr.id === input.proxyId);
        if (!proxy) return res.status(404).json({ error: "Proxy not found" });
        await android.setDeviceProxy(p(req, "serial"), {
          host: proxy.host, port: proxy.port,
          user: proxy.username ?? undefined, pass: proxy.password ?? undefined,
        });
      } else {
        await android.setDeviceProxy(p(req, "serial"), null);
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const startSchema = z.object({
    avdName: z.string().min(1),
    port: z.number().int().optional(),
  });
  app.post("/api/mobile/avds/start", async (req: Request, res: Response) => {
    try {
      const input = startSchema.parse(req.body);
      // Look up any saved proxy for this AVD
      const cfg = loadInstanceConfigs();
      const instanceCfg = cfg[input.avdName];
      let proxyOpts: { host: string; port: number; user?: string; pass?: string } | undefined;
      if (instanceCfg?.proxyId) {
        const proxies = await storage.getProxies();
        const proxy = proxies.find(pr => pr.id === instanceCfg.proxyId);
        if (proxy) proxyOpts = { host: proxy.host, port: proxy.port, user: proxy.username ?? undefined, pass: proxy.password ?? undefined };
      }
      const r = android.startEmulator(input.avdName, { port: input.port, proxy: proxyOpts });
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to start emulator" });
    }
  });

  app.post("/api/mobile/devices/:serial/stop", async (req: Request, res: Response) => {
    try {
      await android.stopEmulator(p(req, "serial"));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to stop emulator" });
    }
  });

  app.get("/api/mobile/devices/:serial/wait-boot", async (req: Request, res: Response) => {
    try {
      const booted = await android.waitForBoot(p(req, "serial"), 180000);
      res.json({ booted });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Wait failed" });
    }
  });

  const installSchema = z.object({ apkPath: z.string().min(1) });
  app.post("/api/mobile/devices/:serial/install", async (req: Request, res: Response) => {
    try {
      const input = installSchema.parse(req.body);
      await android.installApk(p(req, "serial"), input.apkPath);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Install failed" });
    }
  });

  app.get("/api/mobile/devices/:serial/instagram-installed", async (req: Request, res: Response) => {
    try {
      const installed = await android.isPackageInstalled(p(req, "serial"), "com.instagram.android");
      res.json({ installed });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Check failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/instagram/launch", async (req: Request, res: Response) => {
    try { await android.launchInstagram(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/instagram/stop", async (req: Request, res: Response) => {
    try { await android.stopInstagram(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/instagram/clear", async (req: Request, res: Response) => {
    try { await android.clearInstagramData(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/scrcpy/start", async (req: Request, res: Response) => {
    try {
      const r = android.startScrcpy(p(req, "serial"), { windowTitle: `Equinox Mobile — ${p(req, "serial")}`, maxSize: 1080 });
      res.json({ ok: true, ...r });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to start screen mirror" });
    }
  });

  app.post("/api/mobile/devices/:serial/scrcpy/stop", async (req: Request, res: Response) => {
    try { android.stopScrcpy(p(req, "serial")); res.json({ ok: true }); }
    catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const inputTextSchema = z.object({ text: z.string() });
  app.post("/api/mobile/devices/:serial/input/text", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      await android.inputText(p(req, "serial"), input.text);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const tapSchema = z.object({ x: z.number(), y: z.number() });
  app.post("/api/mobile/devices/:serial/input/tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      await android.tap(p(req, "serial"), input.x, input.y);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const keySchema = z.object({ code: z.union([z.string(), z.number()]) });
  app.post("/api/mobile/devices/:serial/input/key", async (req: Request, res: Response) => {
    try {
      const input = keySchema.parse(req.body);
      await android.keyevent(p(req, "serial"), input.code);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const recipeSchema = z.object({
    steps: z.array(z.any()),
  });
  app.post("/api/mobile/devices/:serial/recipe", async (req: Request, res: Response) => {
    try {
      const input = recipeSchema.parse(req.body);
      await android.runSignupRecipe(p(req, "serial"), input.steps);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.get("/api/mobile/devices/:serial/android-id", async (req: Request, res: Response) => {
    try {
      const id = await android.getAndroidId(p(req, "serial"));
      res.json({ androidId: id });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const androidIdSchema = z.object({ androidId: z.string().regex(/^[0-9a-f]{16}$/, "Must be 16 hex characters") });
  app.post("/api/mobile/devices/:serial/android-id", async (req: Request, res: Response) => {
    try {
      const input = androidIdSchema.parse(req.body);
      await android.setAndroidId(p(req, "serial"), input.androidId);
      res.json({ ok: true, androidId: input.androidId });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/android-id/random", (_req: Request, res: Response) => {
    res.json({ androidId: android.randomAndroidId() });
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
      } as any);
      res.json({ ok: true, profile });
    } catch (e: any) {
      logger.error({ err: e }, "save mobile account failed");
      res.status(400).json({ error: e?.message ?? "Failed to save account" });
    }
  });
}
