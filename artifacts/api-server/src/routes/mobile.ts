import type { Express, Request, Response } from "express";
import { spawnSync, spawn, execFile } from "child_process";
import { promisify } from "util";
import { z } from "zod/v4";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import * as http from "http";
import * as os from "os";
import sharp from "sharp";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";
import * as android from "../mobile/androidManager";
import * as proxyRelay from "../mobile/proxyRelay";
import * as sessionRecorder from "../mobile/sessionRecorder";
import { getDeviceLabel } from "./usb-phones";
import { fixAiSlop } from "../instagram/fixAiSlop";
import { getRuntimeSnapshot } from "../diagnostics/runtimeSnapshot";
import {
  alterJpegBuffer,
  type AlterationLevel,
  type ImageFilterSettings,
} from "../instagram/imageAlteration";
// NOTE: src/mobile/scrcpyServer.ts implements a real scrcpy-server protocol
// client that was meant to replace the screenrecord-based mirror below (to
// fix screenrecord's MIUI keyguard-freeze issue), but it has never
// successfully completed its handshake against real hardware in testing —
// see the comment above the video WebSocket route. Left unused but in place
// for whoever picks this up next; do not wire it back in without confirming
// a real device actually streams frames.
import { storage } from "../storage";
import { logger } from "../lib/logger";
import { HikerApiClient } from "../instagram/hikerApiClient";

// Sharp/libvips is a native dependency. On Windows, concurrent decode work
// alongside sustained ADB screenshot polling has previously terminated the
// API process with STATUS_ACCESS_VIOLATION (0xC0000005). Keep the native
// decoder deliberately conservative; screenshot polling itself remains
// concurrent and is still coalesced per device below.
sharp.concurrency(1);
sharp.cache(false);

type BasicImageInfo = { format: string; width: number; height: number };

function readBasicImageInfo(bytes: Buffer): BasicImageInfo {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { format: "png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    if (bytes.toString("ascii", 12, 16) === "VP8X" && bytes.length >= 30) {
      return { format: "webp", width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
    }
    return { format: "webp", width: 0, height: 0 };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset++; continue; }
      const marker = bytes[offset + 1];
      offset += 2;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const segmentLength = bytes.readUInt16BE(offset);
      if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
      const sof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (sof && segmentLength >= 7) {
        return { format: "jpeg", height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
      }
      offset += segmentLength;
    }
  }
  return { format: "unknown", width: 0, height: 0 };
}

type MalesOnlyMatch = { name: string; field: "account name" | "username" | "bio" };
type CompiledMalesOnlyName = {
  name: string;
  bio: RegExp;
  accountName: RegExp;
  username: RegExp;
};

const malesOnlyMatcherCache = new Map<string, CompiledMalesOnlyName[]>();

// Farm thumbnails and inspector screenshots can poll at the same time. Never
// start two ADB screencap processes for one device: on Windows/USB this can
// serialize inside ADB and freeze every queued request for ~30 seconds.
const screencapInFlight = new Map<string, Promise<Buffer>>();
const SCREENCAP_TIMEOUT_MS = 8_000;
let visualDecodeQueue: Promise<void> = Promise.resolve();

function capturePng(adbPath: string, serial: string): Promise<Buffer> {
  const existing = screencapInFlight.get(serial);
  if (existing) return existing;

  const job = new Promise<Buffer>((resolve, reject) => {
    const child = spawn(adbPath, ["-s", serial, "exec-out", "screencap", "-p"]);
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(`screencap timed out after ${SCREENCAP_TIMEOUT_MS}ms`));
    }, SCREENCAP_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`screencap exited with code ${code ?? "null"}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  }).finally(() => {
    if (screencapInFlight.get(serial) === job) screencapInFlight.delete(serial);
  });

  screencapInFlight.set(serial, job);
  return job;
}

async function decodeVisualScreenshot(png: Buffer): Promise<{
  data: Buffer;
  info: { width: number; height: number; channels: number };
}> {
  let release!: () => void;
  const previous = visualDecodeQueue;
  visualDecodeQueue = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const decoded = android.decodePngPixels(png);
    return {
      data: decoded.pixels,
      info: {
        width: decoded.width,
        height: decoded.height,
        channels: decoded.channels,
      },
    };
  } finally {
    release();
  }
}

type VisualPostControl = { x: number; y: number; score: number } | null;

/**
 * Locate the two post-picker controls from the rendered phone image.
 * Accessibility metadata is not required here: Instagram can render the
 * control while omitting its UIAutomator node.
 */
async function findVisualPostControl(
  serial: string,
  kind: "home" | "compose" | "post" | "expand" | "next" | "caption" | "share",
  onLog?: (msg: string) => void,
): Promise<VisualPostControl> {
  const adb = android.detectToolset().adb.path;
  if (!adb) return null;
  try {
    const png = await capturePng(adb, serial);
    const decoded = await decodeVisualScreenshot(png);
    const { data, info } = decoded;
    const regions: Record<typeof kind, [number, number, number, number]> = {
      // Instagram Home is in the bottom navigation row. The old full-height
      // region selected bright profile/status pixels (and sometimes returned
      // the screenshot corner) instead of the Home icon.
      home: [0.02, 0.82, 0.22, 0.98],
      // Compose "+" is in the top app header, below the Android status bar.
      compose: [0.02, 0.07, 0.30, 0.25],
      post: [0.25, 0, 0.75, 0.28],
      expand: [0, 0.30, 0.28, 0.60],
      next: [0.76, 0, 1, 0.16],
      caption: [0, 0.35, 0.85, 0.85],
      share: [0.60, 0.80, 1, 1],
    };
    const [rx0, ry0, rx1, ry1] = regions[kind];
    const x0 = Math.floor(info.width * rx0);
    const x1 = Math.floor(info.width * rx1);
    const y0 = Math.floor(info.height * ry0);
    const y1 = Math.floor(info.height * ry1);
    const tile = 12;
    let best: VisualPostControl = null;
    for (let y = y0; y < y1; y += tile) {
      for (let x = x0; x < x1; x += tile) {
        let bright = 0;
        let coloured = 0;
        let count = 0;
        for (let py = y; py < Math.min(y + tile, y1); py += 2) {
          for (let px = x; px < Math.min(x + tile, x1); px += 2) {
            const i = (py * info.width + px) * info.channels;
            const r = data[i] ?? 0, g = data[i + 1] ?? 0, b = data[i + 2] ?? 0;
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            if (max > 205 && max - min < 45) bright++;
            if ((kind === "next" || kind === "post" || kind === "share") && b > 145 && b > r * 1.15) coloured++;
            count++;
          }
        }
        const score = (kind === "next" || kind === "post" || kind === "share") ? coloured * 3 + bright : bright;
        if (score < (kind === "next" ? 6 : 5)) continue;
         // Never accept a tile touching the screenshot edge. Those pixels are
         // frequently bright system/status-bar background, not a control.
         if (x < 8 || y < 8 || x + tile >= info.width - 8 || y + tile >= info.height - 8) continue;
         if (!best || score > best.score) {
          best = { x: Math.round(x + tile / 2), y: Math.round(y + tile / 2), score };
        }
      }
    }
    if (best) onLog?.(`Make a Post: visual ${kind} control found at (${best.x}, ${best.y}), score=${best.score}`);
    return best;
  } catch {
    return null;
  }
}

function getCompiledMalesOnlyNames(rawNames: string): CompiledMalesOnlyName[] {
  const cached = malesOnlyMatcherCache.get(rawNames);
  if (cached) return cached;

  const compiled = rawNames
    .split(",")
    .map(name => name.trim().toLocaleLowerCase())
    .filter(Boolean)
    .map(name => {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return {
        name,
        bio: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu"),
        accountName: new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, "iu"),
        username: new RegExp(`(?:^|[._])${escaped}(?:\\d{1,4}(?=$|[._])|(?=$|[._]))`, "iu"),
      };
    });

  // Keep the cache bounded if a workspace has many distinct allowlists.
  if (malesOnlyMatcherCache.size >= 8) {
    const oldest = malesOnlyMatcherCache.keys().next().value;
    if (oldest !== undefined) malesOnlyMatcherCache.delete(oldest);
  }
  malesOnlyMatcherCache.set(rawNames, compiled);
  return compiled;
}

/**
 * Males Only is an explicit configured-name allowlist, not gender inference.
 * Keep the three Instagram profile fields separate: `full_name` is the
 * account/display name, `username` is the handle, and `biography` is the bio.
 * Account/display names and usernames require a configured token at a
 * dot/underscore boundary (or field boundary), with an optional numeric
 * suffix of up to four digits. Bios use a bounded token match so a name
 * embedded in an unrelated word is rejected.
 */
function findMalesOnlyMatch(
  username: string,
  accountName: string,
  bio: string,
  allowedNames: CompiledMalesOnlyName[],
): MalesOnlyMatch | null {
  const normalizedFields: Array<[MalesOnlyMatch["field"], string]> = [
    ["account name", accountName],
    ["username", username],
    ["bio", bio],
  ];
  // Prefer the account-name field when the same configured token appears in
  // more than one field, so the Debugging Log reflects the actual display
  // name that caused the allow decision.
  for (const field of normalizedFields) {
    for (const entry of allowedNames) {
      const matches = field[0] === "bio"
        ? entry.bio.test(field[1])
        : field[0] === "account name"
          ? entry.accountName.test(field[1])
          : entry.username.test(field[1]);
      if (matches) return { name: entry.name, field: field[0] };
    }
  }
  return null;
}

function findLiveMalesOnlyMatch(
  username: string,
  profileXml: string,
  allowedNames: CompiledMalesOnlyName[],
): MalesOnlyMatch | null {
  // Do not flatten the whole accessibility dump. It contains navigation
  // labels, buttons, suggested-user cards, and hidden containers; searching
  // that string made an unrelated "ash" label look like profile biography.
  const nodes = [...profileXml.matchAll(/<node\s([^>]+?)\/?>/g)]
    .map(match => {
      const attrs = match[1];
      const read = (name: string) => attrs.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? "";
      const bounds = read("bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
      return {
        text: read("text").trim(),
        desc: read("content-desc").trim(),
        cls: read("class"),
        clickable: read("clickable") === "true",
        bounds: bounds ? { x1: +bounds[1], y1: +bounds[2], x2: +bounds[3], y2: +bounds[4] } : null,
      };
    })
    .filter(node =>
      node.text &&
      node.bounds &&
      /TextView|EditText/i.test(node.cls) &&
      !node.clickable &&
      node.bounds.y1 >= 80 &&
      node.bounds.y2 <= 1100 &&
      node.bounds.x2 > node.bounds.x1,
    );

  const clean = username.replace(/^@/, "").trim().toLocaleLowerCase();
  const usernameIndex = nodes.findIndex(node =>
    node.text.toLocaleLowerCase() === clean ||
    node.text.toLocaleLowerCase() === `@${clean}`,
  );
  const profileNodes = usernameIndex >= 0 ? nodes.slice(usernameIndex + 1) : nodes;
  // Instagram places display name immediately after the handle and biography
  // text immediately after the display name. Keep the fields separate so the
  // matcher can report the real field that caused the decision.
  const accountNameNode = profileNodes[0];
  const accountName = accountNameNode?.text ?? "";
  // Do not treat every later TextView as biography: after the header, the same
  // accessibility tree contains post captions, suggested accounts, and hidden
  // content. The biography is the compact text band immediately below the
  // account name, before the profile's content tabs/grid begin.
  const bioBottom = accountNameNode?.bounds
    ? accountNameNode.bounds.y2 + 500
    : 0;
  const bio = accountNameNode?.bounds
    ? profileNodes
        .slice(1)
        .filter(node =>
          Boolean(node.bounds) &&
          node.bounds!.y1 >= accountNameNode.bounds!.y1 &&
          node.bounds!.y2 <= bioBottom,
        )
        .map(node => node.text)
        .join("\n")
    : "";
  return findMalesOnlyMatch(username, accountName, bio, allowedNames);
}

const execFileP = promisify(execFile);

// ── Battery charging-control scheduler ────────────────────────────────────
// Supports two modes depending on what the device allows:
//   "real"  — physically stops charging via sysfs (probeChargingControl found a
//             writable path); best for battery health + electricity saving.
//   "spoof" — only hides charging state from apps via dumpsys; physical charging
//             continues (fallback when sysfs is unavailable).
// Config is persisted to global_settings so schedules survive server restarts.
interface BatterySpoofConfig {
  enabled: boolean;
  unplugMinutes: number;  // how long each stop window lasts
  cycleHours: number;     // repeat interval
  spoofLevel: number;     // battery % reported to apps while stopped
}
interface BatterySpoofEntry {
  interval:     ReturnType<typeof setInterval> | null;
  resetTimeout: ReturnType<typeof setTimeout>  | null;
  spoofActive:  boolean;
  nextAt:       number | null; // epoch ms of next stop window
}
const batterySpoofTimers  = new Map<string, BatterySpoofEntry>();
const batterySpoofConfigs = new Map<string, BatterySpoofConfig>();
// Cache probe results so we never re-probe mid-cycle.
const chargingControlCache = new Map<string, android.ChargingControlSupport>();

function _stopBatterySpoofCycle(serial: string) {
  const e = batterySpoofTimers.get(serial);
  if (!e) return;
  if (e.interval)     clearInterval(e.interval);
  if (e.resetTimeout) clearTimeout(e.resetTimeout);
  batterySpoofTimers.delete(serial);
}

function _startBatterySpoofCycle(serial: string, cfg: BatterySpoofConfig) {
  _stopBatterySpoofCycle(serial);
  const cycleMs  = cfg.cycleHours    * 3_600_000;
  const unplugMs = cfg.unplugMinutes *    60_000;

  const runStop = async () => {
    const probe = chargingControlCache.get(serial);
    const useReal = probe?.supported === true;
    try {
      if (useReal) {
        await android.stopPhysicalCharging(serial, probe as Extract<android.ChargingControlSupport, { supported: true }>);
        logger.info(`[battery] ${serial}: physical charging STOPPED via ${(probe as any).path}`);
      } else {
        await android.setBatterySpoof(serial, cfg.spoofLevel);
        logger.info(`[battery] ${serial}: app-level spoof active — reporting ${cfg.spoofLevel}% unplugged`);
      }
      const e = batterySpoofTimers.get(serial);
      if (e) e.spoofActive = true;

      const rt = setTimeout(async () => {
        try {
          if (useReal) {
            await android.resumePhysicalCharging(serial, probe as Extract<android.ChargingControlSupport, { supported: true }>);
            logger.info(`[battery] ${serial}: physical charging RESUMED`);
          } else {
            await android.clearBatterySpoof(serial);
            logger.info(`[battery] ${serial}: app-level spoof cleared`);
          }
          const e2 = batterySpoofTimers.get(serial);
          if (e2) { e2.spoofActive = false; e2.resetTimeout = null; }
        } catch (err: any) {
          logger.error(`[battery] ${serial}: resume error: ${err?.message}`);
        }
      }, unplugMs);

      const e2 = batterySpoofTimers.get(serial);
      if (e2) { e2.resetTimeout = rt; e2.nextAt = Date.now() + cycleMs; }
    } catch (err: any) {
      logger.error(`[battery] ${serial}: stop error: ${err?.message}`);
    }
  };

  runStop();
  const iv = setInterval(runStop, cycleMs);
  batterySpoofTimers.set(serial, { interval: iv, resetTimeout: null, spoofActive: false, nextAt: Date.now() + cycleMs });
}

// In-memory cache for android IDs — avoids repeated slow ADB reads after a
// successful write. Keyed by device serial. Cleared only on server restart or
// explicit reset; the value on-device is the source of truth for first-read.
const androidIdCache = new Map<string, string>();

/** Makes a plain HTTP proxy request to api.ipify.org through the given upstream. */
function fetchExternalIpViaProxy(host: string, port: number, user?: string, pass?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const authHeader = user
      ? `Basic ${Buffer.from(`${user}:${pass ?? ""}`).toString("base64")}`
      : null;
    const req = http.request(
      {
        host,
        port,
        method: "GET",
        path: "http://api.ipify.org/",
        headers: {
          Host: "api.ipify.org",
          "User-Agent": "curl/8.0",
          ...(authHeader ? { "Proxy-Authorization": authHeader } : {}),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve(data.trim()));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(12000, () => req.destroy(new Error("IP check timed out after 12 s")));
    req.end();
  });
}

const p = (req: Request, key: string): string => String((req.params as any)[key] ?? "");

// ── Per-instance config (proxy assignment) ────────────────────────────────────
// Stored in userData (via EQUINOX_DATA_DIR env var) so it survives app updates.
// Falls back to process.cwd() in dev / non-Electron environments.
type AutomationSettings = {
  cycleIntervalMin?: number;
  cycleIntervalMax?: number;
  enabled: boolean;
  trustScoreId?: string | null;
  trustScoreDisabledTools?: string[];
  trustScoreToolOverrides?: Record<string, boolean>;
  injectBrowsingFeedChanceMin?: number;
  injectBrowsingFeedChanceMax?: number;
  feedEnabled?: boolean;
  storiesEnabled?: boolean;
  actionDelayMin: number;
  actionDelayMax: number;
  likePercentMin: number;
  likePercentMax: number;
  shareFeedPercentMin: number;
  shareFeedPercentMax: number;
  shareDmPercentMin: number;
  shareDmPercentMax: number;
  savePercentMin: number;
  savePercentMax: number;
  expandCaptionPercentMin: number;
  expandCaptionPercentMax: number;
  tapAudioPercentMin: number;
  tapAudioPercentMax: number;
  clickHashtagPercentMin: number;
  clickHashtagPercentMax: number;
  clickAuthorPercentMin: number;
  clickAuthorPercentMax: number;
  feedRerunChanceMin: number;
  feedRerunChanceMax: number;
  feedScrollMin: number;
  feedScrollMax: number;
  viewStoriesSlidesMin: number;
  viewStoriesSlidesMax: number;
  viewStoriesSlideWatchPctMin: number;
  viewStoriesSlideWatchPctMax: number;
  viewStoriesLikePercentMin: number;
  viewStoriesLikePercentMax: number;
  viewStoriesShareDmPercentMin: number;
  viewStoriesShareDmPercentMax: number;
  viewStoriesCommentPercentMin: number;
  viewStoriesCommentPercentMax: number;
  viewStoriesClickAuthorPercentMin: number;
  viewStoriesClickAuthorPercentMax: number;
  // View Reels — taps the Reels tab, snap-swipes through N reels, and acts
  // on each via the right-side vertical icon column (see findReelActionIcons
  // in androidManager.ts, distinct from the feed's horizontal action bar).
  viewReelsEnabled?: boolean;
  viewReelsScrollMin?: number;
  viewReelsScrollMax?: number;
  viewReelsLikePercentMin?: number;
  viewReelsLikePercentMax?: number;
  viewReelsShareFeedPercentMin?: number;
  viewReelsShareFeedPercentMax?: number;
  viewReelsShareDmPercentMin?: number;
  viewReelsShareDmPercentMax?: number;
  viewReelsSavePercentMin?: number;
  viewReelsSavePercentMax?: number;
  viewReelsClickAuthorPercentMin?: number;
  viewReelsClickAuthorPercentMax?: number;
  viewReelsActivatePctMin?: number;
  viewReelsActivatePctMax?: number;
  viewReelsWatchPctMin?: number;
  viewReelsWatchPctMax?: number;
  // View Explore Page — taps the Search/Explore tab, scrolls the grid N times,
  // and optionally clicks individual posts to like / share / save them.
  viewExploreEnabled?: boolean;
  viewExploreActivatePctMin?: number;
  viewExploreActivatePctMax?: number;
  viewExploreScrollMin?: number;
  viewExploreScrollMax?: number;
  viewExploreActionDelayMin?: number;
  viewExploreActionDelayMax?: number;
  viewExploreClickPostPctMin?: number;
  viewExploreClickPostPctMax?: number;
  viewExploreLikePercentMin?: number;
  viewExploreLikePercentMax?: number;
  viewExploreShareFeedPercentMin?: number;
  viewExploreShareFeedPercentMax?: number;
  viewExploreShareDmPercentMin?: number;
  viewExploreShareDmPercentMax?: number;
  viewExploreSavePercentMin?: number;
  viewExploreSavePercentMax?: number;
  viewExploreClickAuthorPercentMin?: number;
  viewExploreClickAuthorPercentMax?: number;
  // Follow Filters — profile-quality gates. Persisted so Copy Settings
  // can apply them to other slots without the fields being stripped.
  followFiltersEnabled?: boolean;
  followFilterPrivateUsers?: boolean;
  followFilterEnglishSpeaking?: boolean;
  followFilterMinFollowers50?: boolean;
  followFilterVerifiedUsers?: boolean;
  followFilterMaxFollowers25k?: boolean;
  followFilterMalesOnly?: boolean;
  followFilterMaleNames?: string;
  // Follow Users — HikerAPI-driven follow flow (persisted here too; this
  // schema previously only covered the feed/stories fields, so these were
  // silently stripped by automationSchema.parse() on every autosave and
  // never actually reached disk — see fix note 12 Jul 2026).
  followEnabled?: boolean;
  followUsersMin?: number;
  followUsersMax?: number;
  followSpreadFollows?: boolean;
  followSources?: { type: string; value: string }[];
  // Inject Browsing — per-user profile-browsing behaviour (same fix).
  injectBrowsingEnabled?: boolean;
  injectBrowsingActivatePctMin?: number;
  injectBrowsingActivatePctMax?: number;
  injectBrowsingBeforeFollowPctMin?: number;
  injectBrowsingBeforeFollowPctMax?: number;
  injectBrowsingFeedMin?: number;
  injectBrowsingFeedMax?: number;
  injectBrowsingClickPostPctMin?: number;
  injectBrowsingClickPostPctMax?: number;
  injectBrowsingLikePctMin?: number;
  injectBrowsingLikePctMax?: number;
  injectBrowsingShareFeedPctMin?: number;
  injectBrowsingShareFeedPctMax?: number;
  injectBrowsingShareDmPctMin?: number;
  injectBrowsingShareDmPctMax?: number;
  injectBrowsingSavePostPctMin?: number;
  injectBrowsingSavePostPctMax?: number;
  injectBrowsingAbandonFollowPctMin?: number;
  injectBrowsingAbandonFollowPctMax?: number;
  injectBrowsingTapHighlightsPctMin?: number;
  injectBrowsingTapHighlightsPctMax?: number;
  // Random Jitter — human-like interstitial actions (same persistence fix as
  // Follow/Inject Browsing above; was missing from this type even though the
  // zod schema and defaults object already used these keys).
  randomJitterEnabled?: boolean;
  checkNotificationsPctMin?: number;
  checkNotificationsPctMax?: number;
  checkNotificationsScrollsMin?: number;
  checkNotificationsScrollsMax?: number;
  checkNotificationsClickPctMin?: number;
  checkNotificationsClickPctMax?: number;
  visitProfilePctMin?: number;
  visitProfilePctMax?: number;
  // Visit Saved — navigates to own Saved media page via profile → hamburger → Saved, scrolls.
  visitSavedPctMin?: number;
  visitSavedPctMax?: number;
  // Visit Random Settings — opens profile → hamburger → taps one validated
  // settings row, optionally scrolls once, then backs out once.
  visitSettingsPctMin?: number;
  visitSettingsPctMax?: number;
  // App Switch — presses square button, opens SMS app for a random dwell, returns to Instagram.
  appSwitchPctMin?: number;
  appSwitchPctMax?: number;
  // Check DMs — opens the inbox, scrolls, optionally taps a thread.
  checkDmEnabled?: boolean;
  checkDmActivatePctMin?: number;
  checkDmActivatePctMax?: number;
  checkDmScrollMin?: number;
  checkDmScrollMax?: number;
  checkDmClickPctMin?: number;
  checkDmClickPctMax?: number;
  // Activate Percentage — a top-level chance (rolled once per automation-cycle
  // execution, i.e. once per "toggle tick") that gates whether the tool runs
  // AT ALL on this execution, independent of its own internal settings. This
  // is distinct from injectBrowsingActivatePct* above, which rolls per-user
  // INSIDE an already-running Follow step. Default 100/100 (always runs)
  // preserves existing behaviour for accounts saved before this field existed.
  feedActivatePctMin?: number;
  feedActivatePctMax?: number;
  viewStoriesActivatePctMin?: number;
  viewStoriesActivatePctMax?: number;
  followActivatePctMin?: number;
  followActivatePctMax?: number;
  randomJitterActivatePctMin?: number;
  randomJitterActivatePctMax?: number;
  // Make a Post — settings ported over from the old browser-automation
  // "Make a Post" tool (HumanSessionPanel's repost* fields) at the user's
  // request (13 Jul 2026). These fields are forwarded into the live mobile
  // automation-cycle image-preparation path before the Android media-picker
  // upload.
  makePostEnabled?: boolean;
  makePostActivatePctMin?: number;
  makePostActivatePctMax?: number;
  makePostPerSessionMin?: number;
  makePostPerSessionMax?: number;
  makePostAlterationEnabled?: boolean;
  makePostAlterationLevel?: "small" | "medium" | "high";
  makePostImageSettingsEnabled?: boolean;
  makePostDisableWhenExhausted?: boolean;
  makePostLocalFolderEnabled?: boolean;
  makePostLocalFolderPath?: string;
  makePostLocalFolderNoRepeat?: boolean;
  makePostLocalFolderRandom?: boolean;
  makePostLocalFolderDeleteAfterUpload?: boolean;
  makePostAddLocation?: boolean;
  makePostUseChatGpt?: boolean;
  makePostFixAiSlop?: boolean;
  makePostMetadataCleanup?: boolean;
  makePostFrequencyDisruption?: boolean;
  makePostCaptionText?: string;
  makePostPostToProfilePctMin?: number;
  makePostPostToProfilePctMax?: number;
  makePostPostToStoryPctMin?: number;
  makePostPostToStoryPctMax?: number;
  updateProfilePicActivatePctMin?: number;
  updateProfilePicActivatePctMax?: number;
  updateProfilePicFolderPath?: string;
  updateProfilePicDisableAfterUsed?: boolean;
  updateProfilePicAlterationEnabled?: boolean;
  updateProfilePicAlterationLevel?: "small" | "medium" | "high";
  updateProfilePicImageSettingsEnabled?: boolean;
  updateProfilePicImageSettings?: ImageFilterSettings;
  updateProfilePicFixAiSlop?: boolean;
  updateProfilePicMetadataCleanup?: boolean;
  updateProfilePicFrequencyDisruption?: boolean;
  updateBioActivatePctMin?: number;
  updateBioActivatePctMax?: number;
  updateBioText?: string;
  updateBioDisableAfterUsed?: boolean;
  makePostImageSettings?: {
    contrast: { enabled: boolean; min: number; max: number };
    brightness: { enabled: boolean; min: number; max: number };
    noise: { enabled: boolean; min: number; max: number };
    sharpen: { enabled: boolean; min: number; max: number };
    pixelate: { enabled: boolean; min: number; max: number };
  };
  postStoryEnabled?: boolean;
  postStoryActivatePctMin?: number;
  postStoryActivatePctMax?: number;
  postStoryLocalFolderPath?: string;
  postStoryLocalFolderNoRepeat?: boolean;
  postStoryLocalFolderRandom?: boolean;
  postStoryAlterationEnabled?: boolean;
  postStoryAlterationLevel?: "small" | "medium" | "high";
  postStoryImageSettingsEnabled?: boolean;
  postStoryFixAiSlop?: boolean;
  postStoryAddLink?: boolean;
  postStoryLinkUrl?: string;
  postStoryImageSettings?: {
    contrast: { enabled: boolean; min: number; max: number };
    brightness: { enabled: boolean; min: number; max: number };
    noise: { enabled: boolean; min: number; max: number };
    sharpen: { enabled: boolean; min: number; max: number };
    pixelate: { enabled: boolean; min: number; max: number };
  };
  // Device profile — OEM-specific Android system-shell behaviour.
  // 'auto' = look up ro.product.model in the server-side DEVICE_PROFILES table.
  // 'left' / 'up' = manual override stored per device.
  dismissDirection?: "auto" | "left" | "up";
};
type DeviceSlot = { slotId?: string; username: string; password: string; totpSecret?: string; emailAddress?: string; emailPassword?: string; phoneNumber?: string };
type DeviceAccount = { slots: DeviceSlot[] };
type DeviceSettings = { googlePlayEmail?: string; googlePlayPassword?: string; selectedSimSlot?: number; simPhoneNumbers?: Record<string, string> };
type DevicePrefs = {
  dismissDirection?: "auto" | "left" | "up";
  motherCodeOverrides?: {
    globalDwell?: { minMs: number; maxMs: number };
    accountSwitching?: { minMs: number; maxMs: number };
    navigation?: { minMs: number; maxMs: number };
    actionPacing?: { minMs: number; maxMs: number };
    perTool?: Record<string, { minMs: number; maxMs: number }>;
  };
  swipePersonalityOverrides?: Record<string, { weightMin: number; weightMax: number; durationMinMs: number; durationMaxMs: number }>;
  typingSpeedProfile?: { minMs: number; maxMs: number; errorPercentMin: number; errorPercentMax: number; dwellMinMs: number; dwellMaxMs: number; hesitationMinMs: number; hesitationMaxMs: number };
  swipeGesture?: { x1: number; y1: number; x2: number; y2: number; durationMinMs: number; durationMaxMs: number; jitterX: number; jitterY: number; startJitterMinY?: number; startJitterMaxY?: number; pauseMinMs?: number; pauseMaxMs?: number; settleMinMs?: number; settleMaxMs?: number };
};
type InstanceConfig = { proxyId?: number | null; proxyProtocol?: "http" | "socks5"; proxyPort?: number | null; sourceInterface?: string | null; automation?: AutomationSettings; account?: DeviceAccount; slotAutomation?: Record<string, AutomationSettings>; deviceSettings?: DeviceSettings; devicePrefs?: DevicePrefs };
type InstanceConfigMap = Record<string, InstanceConfig>;

function configFilePath(): string {
  if (process.env.EQUINOX_DATA_DIR) {
    return path.join(process.env.EQUINOX_DATA_DIR, "mobile-instances.json");
  }
  // In dev/server mode (no Electron), resolve relative to the running script
  // rather than process.cwd() — cwd() can vary depending on how the server is
  // launched (pnpm filter from workspace root vs. running directly from the
  // package dir). process.argv[1] is always the entry script's absolute path
  // (e.g. .../artifacts/api-server/dist/index.mjs), so one level up from its
  // directory gives the stable artifacts/api-server/ package root.
  return path.join(path.dirname(path.resolve(process.argv[1])), "..", "mobile-instances.json");
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

// ── Make a Post — dedicated per-slot folder path store ──────────────────────
// Stored in a separate plain-text file per (serial, slotIdx) so the assigned
// directory survives settings copies (Copy Settings), schema migrations, and
// any autosave race that could overwrite mobile-instances.json with a stale
// empty-string value.  Mirrors the FOLLOWED_DIR / POSTED_DIR pattern exactly.
const FOLDER_PATHS_DIR: string = process.env.EQUINOX_DATA_DIR
  ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-folder-paths")
  : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-folder-paths");
try { fs.mkdirSync(FOLDER_PATHS_DIR, { recursive: true }); } catch { /* already exists */ }

// Debug screenshots — one folder per public device model, cleared when a new
// account's Human Session cycle starts. Each elapsed timestamp gets exactly one
// screenshot; detail lines stamped with the same elapsed time are log-only.
const SCREENSHOTS_DIR: string = process.env.EQUINOX_DATA_DIR
  ? path.join(process.env.EQUINOX_DATA_DIR, "debug-screenshots")
  : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "debug-screenshots");

// Rolling per-device log buffer — last 40 lines, updated by pushDebugLogLine
// which is called from tLog before captureDebugScreenshot so the current line
// is already in the buffer when the composite is built.
const debugLogBuffer = new Map<string, string[]>();
const DEBUG_LOG_BUFFER_SIZE = 40;
// ADB screencap calls must be serialized per device. Without this queue, rapid
// log lines start overlapping child processes and some frames never get saved.
const debugScreenshotQueues = new Map<string, Promise<void>>();
const debugScreenshotTimestamps = new Map<string, Set<string>>();

function pushDebugLogLine(serial: string, line: string): void {
  let buf = debugLogBuffer.get(serial);
  if (!buf) { buf = []; debugLogBuffer.set(serial, buf); }
  buf.push(line);
  if (buf.length > DEBUG_LOG_BUFFER_SIZE) buf.shift();
}

// Escape XML special characters for SVG text content.
function escapeXmlSvg(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Pick a colour for a single log line based on its content — mirrors the
// colour assignments used by the frontend Debugging Log panel.
function debugLogLineColor(line: string): string {
  if (line.includes("▶")) return "#f97316";          // tool header — orange
  if (line.includes("✓")) return "#4ade80";           // success — green
  if (line.includes("✗")) return "#f87171";           // failure — red
  if (line.includes("[RST-DBG]")) return "#facc15";   // reset debug — yellow
  if (/Cycle complete/i.test(line)) return "#c084fc"; // cycle end — purple
  if (/Follow:|Follows:/i.test(line)) return "#60a5fa"; // follow — blue
  if (/Inject/i.test(line)) return "#22d3ee";         // inject browsing — cyan
  if (/error|failed/i.test(line)) return "#f87171";   // error words — red
  return "#cbd5e1";                                   // default — light grey
}

async function captureDebugScreenshot(serial: string, label: string): Promise<void> {
  try {
    const adb = android.detectToolset().adb.path;
    if (!adb) return;
    const dir = path.join(SCREENSHOTS_DIR, getDeviceLabel(serial));
    const legacySerialDir = path.join(
      SCREENSHOTS_DIR,
      serial.replace(/[^a-zA-Z0-9_\-]/g, "_"),
    );
    // Older builds used the serial for this folder. Merge it into the public
    // model folder once the device metadata is available so one phone cannot
    // leave two separate screenshot histories behind.
    if (legacySerialDir !== dir && fs.existsSync(legacySerialDir)) {
      await fsPromises.mkdir(dir, { recursive: true });
      for (const file of await fsPromises.readdir(legacySerialDir)) {
        const from = path.join(legacySerialDir, file);
        const to = path.join(dir, file);
        if (!fs.existsSync(to)) await fsPromises.rename(from, to).catch(() => {});
        else await fsPromises.unlink(from).catch(() => {});
      }
      await fsPromises.rm(legacySerialDir, { recursive: true, force: true }).catch(() => {});
    }
    await fsPromises.mkdir(dir, { recursive: true });
    const ts = Date.now();
    const safeName = label.replace(/[^a-zA-Z0-9\s_\-]/g, "").replace(/\s+/g, "_").slice(0, 60);
    const filename = `${ts}_${safeName}.png`;

    // ── 1. Capture the phone screen via ADB ──────────────────────────────────
    const phonePngRaw = await new Promise<Buffer | null>((resolve) => {
      const child = spawn(adb, ["-s", serial, "exec-out", "screencap", "-p"]);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (d: Buffer) => chunks.push(d));
      child.on("close", () => {
        const buf = Buffer.concat(chunks);
        resolve(buf.length > 1000 ? buf : null);
      });
      child.on("error", () => resolve(null));
    });

    if (!phonePngRaw) return;

    // ── 2. Resize phone screen to a fixed height ──────────────────────────────
    const TARGET_H = 760;
    const LOG_W    = 580;
    const PADDING  = 10;
    const LINE_H   = 16;

    const phoneResized = await sharp(phonePngRaw)
      .resize({ height: TARGET_H, fit: "contain", background: "#000000" })
      .png()
      .toBuffer();
    const phoneMeta = await sharp(phoneResized).metadata();
    const phoneW = phoneMeta.width ?? 360;

    // ── 3. Render the debug log panel as SVG ──────────────────────────────────
    const bufLines = debugLogBuffer.get(serial) ?? [];
    const maxLines = Math.floor((TARGET_H - PADDING * 2) / LINE_H) - 1; // -1 for header
    const visibleLines = bufLines.slice(-maxLines);

    const headerY = PADDING + LINE_H;
    const textRows = visibleLines.map((line, i) => {
      const y = headerY + (i + 1) * LINE_H;
      const color = debugLogLineColor(line);
      // Truncate long lines so they don't overflow the panel width.
      const display = escapeXmlSvg(line.length > 68 ? line.slice(0, 68) + "…" : line);
      return `<text x="${PADDING}" y="${y}" fill="${color}">${display}</text>`;
    }).join("\n    ");

    const svgStr = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${LOG_W}" height="${TARGET_H}">
  <rect width="${LOG_W}" height="${TARGET_H}" fill="#0f172a"/>
  <text x="${PADDING}" y="${headerY}" fill="#94a3b8" font-weight="bold">── Debugging Log ──</text>
  ${textRows}
</svg>`;

    // sharp rasterises SVG natively (libvips + librsvg).
    const logPanelPng = await sharp(Buffer.from(svgStr, "utf8"))
      .resize(LOG_W, TARGET_H)
      .png()
      .toBuffer();

    // ── 4. Composite: phone (left) + log panel (right) ────────────────────────
    const totalW = phoneW + LOG_W;
    const composite = await sharp({
      create: { width: totalW, height: TARGET_H, channels: 4 as const,
                background: { r: 15, g: 23, b: 42, alpha: 1 } },
    })
      .composite([
        { input: phoneResized, left: 0,      top: 0 },
        { input: logPanelPng,  left: phoneW, top: 0 },
      ])
      .png()
      .toBuffer();

    await fsPromises.writeFile(path.join(dir, filename), composite).catch(() => {});
  } catch {
    // Never let a screenshot failure affect the automation cycle.
  }
}

function queueDebugScreenshot(serial: string, timestamp: string, label: string): void {
  let capturedTimestamps = debugScreenshotTimestamps.get(serial);
  if (!capturedTimestamps) {
    capturedTimestamps = new Set<string>();
    debugScreenshotTimestamps.set(serial, capturedTimestamps);
  }
  if (capturedTimestamps.has(timestamp)) return;
  capturedTimestamps.add(timestamp);

  const previous = debugScreenshotQueues.get(serial) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => captureDebugScreenshot(serial, label))
    .catch(() => {})
    .finally(() => {
      if (debugScreenshotQueues.get(serial) === next) {
        debugScreenshotQueues.delete(serial);
      }
    });
  debugScreenshotQueues.set(serial, next);
}

function _folderPathFile(serial: string, slotIdx: number): string {
  return path.join(FOLDER_PATHS_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_slot${slotIdx}.txt`);
}

/** Returns the persisted Make-a-Post local folder path for this slot, or "" if none. */
function getMakePostFolderPath(serial: string, slotIdx: number): string {
  try { return fs.readFileSync(_folderPathFile(serial, slotIdx), "utf8").trim(); }
  catch { return ""; }
}

/** Writes the Make-a-Post local folder path for this slot to its dedicated file.
 *  Never writes an empty string — an empty path would silently clear the file and
 *  make it look like the setting was never saved.  Re-ensures the directory exists
 *  on every write so a failed mkdirSync at startup (rare Windows permission races)
 *  does not permanently prevent the file from being created. */
function setMakePostFolderPath(serial: string, slotIdx: number, folderPath: string): void {
  if (!folderPath) return; // never overwrite with empty — callers use "" to mean "no change"
  try {
    fs.mkdirSync(FOLDER_PATHS_DIR, { recursive: true }); // re-ensure dir on every write
    fs.writeFileSync(_folderPathFile(serial, slotIdx), folderPath, "utf8");
  } catch { /* best effort */ }
}

function _postStoryFolderPathFile(serial: string, slotIdx: number): string {
  return path.join(FOLDER_PATHS_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_slot${slotIdx}_post_story.txt`);
}

function getPostStoryFolderPath(serial: string, slotIdx: number): string {
  try { return fs.readFileSync(_postStoryFolderPathFile(serial, slotIdx), "utf8").trim(); }
  catch { return ""; }
}

function setPostStoryFolderPath(serial: string, slotIdx: number, folderPath: string): void {
  if (!folderPath) return;
  try {
    fs.mkdirSync(FOLDER_PATHS_DIR, { recursive: true });
    fs.writeFileSync(_postStoryFolderPathFile(serial, slotIdx), folderPath, "utf8");
  } catch { /* best effort */ }
}

function _profilePicFolderPathFile(serial: string, slotIdx: number): string {
  return path.join(FOLDER_PATHS_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_slot${slotIdx}_profile_pic.txt`);
}

/** Returns the persisted Update Profile Picture local folder path for this slot, or "" if none. */
function getProfilePicFolderPath(serial: string, slotIdx: number): string {
  try { return fs.readFileSync(_profilePicFolderPathFile(serial, slotIdx), "utf8").trim(); }
  catch { return ""; }
}

function setProfilePicFolderPath(serial: string, slotIdx: number, folderPath: string): void {
  if (!folderPath) return;
  try {
    fs.mkdirSync(FOLDER_PATHS_DIR, { recursive: true });
    fs.writeFileSync(_profilePicFolderPathFile(serial, slotIdx), folderPath, "utf8");
  } catch { /* best effort */ }
}

function clearProfilePicFolderPath(serial: string, slotIdx: number): void {
  try { fs.unlinkSync(_profilePicFolderPathFile(serial, slotIdx)); } catch { /* best effort */ }
}

/**
 * Strip CRLF pairs injected by Windows ADB exec-out into binary streams.
 * On Windows, ADB exec-out can convert \n (0x0A) bytes to \r\n (0x0D 0x0A),
 * which corrupts PNG files whose zlib blocks happen to contain 0x0A bytes.
 * We detect this by checking the PNG magic header: a valid PNG always starts
 * with 0x89 0x50 (the first two bytes of \x89PNG).  If the buffer doesn't
 * start with those bytes we strip all 0x0D 0x0A → 0x0A pairs and recheck.
 */
function stripCrlf(buf: Buffer): Buffer {
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0D && i + 1 < buf.length && buf[i + 1] === 0x0A) {
      out[j++] = 0x0A;
      i++; // skip the extra \r
    } else {
      out[j++] = buf[i]!;
    }
  }
  return j === buf.length ? buf : out.subarray(0, j);
}

/** Returns true when buf starts with the PNG magic number (\x89PNG). */
function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

export function registerMobileRoutes(httpServer: http.Server, app: Express) {
  app.get("/api/diagnostics/snapshot", (_req: Request, res: Response) => {
    logger.info("[diagnostics] runtime snapshot requested");
    res.json({
      ok: true,
      ...getRuntimeSnapshot(),
    });
  });
  app.post("/api/diagnostics/snapshot", (_req: Request, res: Response) => {
    logger.info("[diagnostics] runtime snapshot download requested");
    const filename = `aura-diagnostic-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    const content = JSON.stringify({ ok: true, ...getRuntimeSnapshot() }, null, 2);
    res
      .status(200)
      .setHeader("Content-Type", "application/json; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename="${filename}"`)
      .send(content);
  });
  // ── Screen mirror WebSocket stream ─────────────────────────────────────────
  const screenWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    logger.info({ url }, "[mobile-ws] upgrade request received");
    const m = url.match(/^\/api\/mobile\/screen\/([^/?#]+)/);
    if (!m) {
      logger.info({ url }, "[mobile-ws] URL did not match screen route — ignoring");
      return;
    }
    const serial = decodeURIComponent(m[1]);
    logger.info({ serial }, "[mobile-ws] upgrading connection for device");
    // Mark the socket so the instagram upgrade handler (registered later) knows
    // not to call socket.destroy() on it — it destroys every socket it doesn't
    // recognise, which kills this connection after we've already claimed it.
    (socket as any).__wsHandled = true;
    screenWss.handleUpgrade(request, socket as any, head, (ws) => {
      logger.info({ serial }, "[mobile-ws] WebSocket handshake complete");
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      logger.info({ adbFound: !!adbPath, adbPath }, "[mobile-ws] ADB toolset check");
      if (!adbPath) {
        logger.warn({ serial }, "[mobile-ws] ADB not found — closing socket");
        ws.send(JSON.stringify({ error: "ADB not found on this machine" }));
        ws.close();
        return;
      }

      // Check that the device is actually connected before starting the loop
      const deviceCheck = spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000 });
      const devicesOutput = deviceCheck.stdout ?? "";
      logger.info({ serial, devicesOutput }, "[mobile-ws] adb devices output at connection time");
      const deviceLine = devicesOutput.split("\n").find(l => l.startsWith(serial));
      if (!deviceLine) {
        logger.warn({ serial, devicesOutput }, "[mobile-ws] serial not found in adb devices — closing");
        ws.send(JSON.stringify({ error: `Device ${serial} not found in adb devices list` }));
        ws.close();
        return;
      }
      const deviceState = deviceLine.split("\t")[1]?.trim() ?? "unknown";
      logger.info({ serial, deviceState }, "[mobile-ws] device state from adb devices");
      if (deviceState !== "device") {
        logger.warn({ serial, deviceState }, "[mobile-ws] device not in ready state");
        ws.send(JSON.stringify({ error: `Device state is "${deviceState}" — expected "device". Check USB Debugging.` }));
        ws.close();
        return;
      }

      let running = true;
      let frameCount = 0;
      let screenOffStreak = 0; // consecutive 0-byte frames

      // Helper: fire-and-forget ADB shell command (non-blocking)
      const adbShell = (...args: string[]) =>
        spawn(adbPath, ["-s", serial, "shell", ...args], { stdio: "ignore" });

      // Disable screen timeout for this session so the phone stays awake.
      // We save the original value and restore it on disconnect.
      let originalScreenTimeout = "30000"; // fallback default
      try {
        const st = spawnSync(adbPath, ["-s", serial, "shell", "settings", "get", "system", "screen_off_timeout"], { encoding: "utf8", timeout: 3000 });
        const val = st.stdout?.trim();
        if (val && /^\d+$/.test(val)) originalScreenTimeout = val;
      } catch { /* ignore */ }
      adbShell("settings", "put", "system", "screen_off_timeout", "2147483647");
      logger.info({ serial, originalScreenTimeout }, "[mobile-ws] screen timeout disabled for session");

      ws.on("close", (code, reason) => {
        logger.info({ serial, code, reason: reason?.toString() }, "[mobile-ws] client disconnected");
        running = false;
        // Restore original screen timeout
        try { adbShell("settings", "put", "system", "screen_off_timeout", originalScreenTimeout); } catch { /* ignore */ }
        logger.info({ serial, originalScreenTimeout }, "[mobile-ws] screen timeout restored");
      });
      ws.on("error", (err) => {
        logger.error({ serial, err }, "[mobile-ws] WebSocket error");
        running = false;
      });

      logger.info({ serial, adbPath }, "[mobile-ws] starting screencap loop");
      (async () => {
        while (running) {
          try {
            await new Promise<void>((resolve) => {
              const child = spawn(adbPath, ["-s", serial, "exec-out", "screencap", "-p"]);
              const chunks: Buffer[] = [];
              let stderrOut = "";
              child.stdout.on("data", (d: Buffer) => chunks.push(d));
              child.stderr?.on("data", (d: Buffer) => { stderrOut += d.toString(); });
              child.on("error", (err) => {
                logger.error({ serial, err }, "[mobile-ws] spawn error for screencap");
                resolve();
              });
              child.on("close", (code) => {
                let frame = Buffer.concat(chunks);
                const rawLen = frame.length;
                const first4 = frame.length >= 4
                  ? [...frame.subarray(0, 4)].map(b => b.toString(16).padStart(2, "0")).join(" ")
                  : "too short";

                if (frame.length > 8 && !isPng(frame)) {
                  frame = stripCrlf(frame);
                }
                const validPng = isPng(frame);

                if (frameCount === 0 || frameCount % 20 === 0) {
                  // Log every 20th frame to avoid flooding — always log the first
                  logger.info({
                    serial, frameCount, code, rawLen, frameLen: frame.length,
                    first4bytes: first4, validPng, stderr: stderrOut.trim() || null,
                  }, "[mobile-ws] screencap frame");
                }
                frameCount++;

                if (validPng && ws.readyState === 1) {
                  if (screenOffStreak > 0) {
                    // Screen came back — clear streak and tell client
                    screenOffStreak = 0;
                    if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Screen woke up" }));
                  }
                  ws.send(frame, (err) => { if (err) { logger.error({ serial, err }, "[mobile-ws] send error"); running = false; } });
                } else if (!validPng && ws.readyState === 1) {
                  if (rawLen === 0) {
                    screenOffStreak++;
                    // Only notify client once when it first goes dark, then every 10s
                    if (screenOffStreak === 1 || screenOffStreak % 20 === 0) {
                      const msg = "Screen is off or locked — waking…";
                      logger.warn({ serial, screenOffStreak }, `[mobile-ws] ${msg}`);
                      ws.send(JSON.stringify({ error: msg }));
                    }
                    // Do NOT send WAKEUP here — the screencap loop must never
                    // fight against the phone sleeping between automation cycles.
                  } else {
                    screenOffStreak = 0;
                    const msg = `screencap returned ${rawLen} bytes but not a valid PNG (first bytes: ${first4}) — ${stderrOut.trim() || "no stderr"}`;
                    logger.warn({ serial, rawLen, first4, stderrOut: stderrOut.trim() }, `[mobile-ws] ${msg}`);
                    ws.send(JSON.stringify({ error: msg }));
                  }
                }
                resolve();
              });
            });
          } catch (err) {
            logger.error({ serial, err }, "[mobile-ws] screencap loop error");
          }
          // Back off when the screen is off, but not so much that a click-to-wake
          // feels unresponsive — 400ms keeps the "did my tap wake it" feedback loop
          // fast while still not hammering adb every 150ms while asleep.
          // NOTE: this loop delay is only part of the latency budget — each
          // frame also costs the time for `adb exec-out screencap -p` to run
          // on the device itself (PNG capture + USB transfer), typically
          // 150-400ms depending on the phone. That per-frame cost is inherent
          // to the screencap approach and is NOT eliminated by lowering this
          // delay; a truly "instant" (~30fps) mirror requires switching to a
          // continuous H.264 stream (e.g. scrcpy) instead of discrete PNG
          // captures. See CHANGELOG for details.
          const delay = screenOffStreak > 0 ? 400 : 150;
          if (running) await new Promise<void>(r => setTimeout(r, delay));
        }
        logger.info({ serial, frameCount }, "[mobile-ws] screencap loop ended");
      })();
    });
  });

  // ── Live H.264 video mirror (real-time stream, not screenshot polling) ─────
  // Reverted to the `screenrecord`-based mirror (confirmed working at ~30fps
  // on real hardware). We tried replacing this with a real scrcpy-server
  // protocol client (see src/mobile/scrcpyServer.ts) to fix screenrecord's
  // MIUI keyguard-freeze issue, but across every test on this hardware the
  // scrcpy session never completed its handshake — the video socket header
  // never arrived ("socket closed before header was fully read") even with
  // a logcat-failure fallback added — so it silently produced *zero* frames,
  // which is strictly worse than screenrecord's occasional stall-and-restart.
  // Until scrcpy's handshake failure is root-caused against real device
  // logcat output, screenrecord is the working path — do not swap this out
  // again without confirming a real device actually streams frames first.
  //
  // Uses the on-device `screenrecord` binary (built into Android since API 19,
  // no scrcpy/root/extra install required) to continuously encode the screen
  // as raw H.264 and pipe it straight to the browser over this WebSocket. The
  // browser demuxes Annex-B access units and decodes them with WebCodecs —
  // this is what gives near-instant (~30fps) mirroring instead of the old
  // "adb exec-out screencap" polling loop, which paid a full PNG capture cost
  // (150-400ms) per frame.
  //
  // `screenrecord` has a hard --time-limit cap (180s on most Android builds)
  // per invocation, so we transparently respawn it when it exits and keep
  // streaming — the browser-side decoder just sees a short gap.
  const videoWss = new WebSocketServer({ noServer: true });
  // Tracks whether a video session for a given serial has already run its
  // one-time stale-process cleanup this connection. Guards the `pkill` below
  // so a second concurrent/overlapping connection for the SAME device never
  // kills a stream that this process itself just started — it only clears
  // processes left behind by something outside this server's tracking
  // (a crashed tab, a previous server run, etc).
  const videoSessionActive = new Set<string>();
  // Tracks serials where the user has explicitly powered on the phone mirror
  // (pressed the Power button in the Mirror tab). Persists across navigation —
  // intentionally NOT cleared when the mirror page unmounts so the farm grid
  // can keep showing the thumbnail after the user navigates away.
  // Resets to empty on server restart.
  const mirrorLive = new Set<string>();
  // Maps serial → the currently-connected video WebSocket for that device.
  // Populated when a video WS client connects, cleared on disconnect.
  // Used by the automation cycle to push real-time progress messages into
  // the client's Log panel without a separate channel.
  const videoSessionWS = new Map<string, import('ws').WebSocket>();

  // Maps serial → set of connected log-stream WebSocket clients.
  // Log-stream is a lightweight, always-on channel (no video frames) that
  // lets the frontend receive automation log messages regardless of whether
  // the phone mirror screen is open.
  const logStreamWSS = new WebSocketServer({ noServer: true });
  const logSessionWS = new Map<string, Set<import('ws').WebSocket>>();

  // Helper: push an info message to the log-stream WebSocket subscribers for
  // a device, falling back to the video WebSocket only when no log-stream
  // clients are connected.  No-ops silently when nothing is connected.
  //
  // Previously this sent to BOTH channels simultaneously.  DeviceLogContext
  // opens a log-stream WS for every connected phone (always-on), while
  // LiveCanvas opens a video WS whenever the mirror is live — both forward
  // j.info messages to the same React log state, so every message appeared
  // twice in the Debugging Log panel.  Fix: log-stream is the canonical
  // delivery channel; video WS is only a fallback for the rare case where
  // no log-stream client is connected yet.
  const sendVideoLog = (serial: string, msg: string): void => {
    const payload = JSON.stringify({ info: msg });
    const lws = logSessionWS.get(serial);
    const activeLogClients = lws ? [...lws].filter(ws => ws.readyState === 1) : [];

    if (activeLogClients.length > 0) {
      // Log-stream is connected — deliver only via that channel.
      for (const ws of activeLogClients) {
        try { ws.send(payload); } catch { /* ignore */ }
      }
    } else {
      // No log-stream clients yet — fall back to the video WebSocket.
      const vws = videoSessionWS.get(serial);
      if (vws && vws.readyState === 1) {
        try { vws.send(payload); } catch { /* ignore */ }
      }
    }
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    const m = url.match(/^\/api\/mobile\/video\/([^/?#]+)/);
    if (!m) return;
    const serial = decodeURIComponent(m[1]);
    (socket as any).__wsHandled = true;
    logger.info({ serial }, "[mobile-video] upgrading connection for device");
    videoWss.handleUpgrade(request, socket as any, head, async (ws) => {
      // Timing instrumentation for the "first connect lags ~5s, retry is
      // instant" report: log elapsed ms at every stage instead of guessing
      // where the time goes, so the next repro pinpoints the real cause
      // rather than another unverified theory.
      const t0 = Date.now();
      const elapsed = () => Date.now() - t0;

      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) {
        ws.send(JSON.stringify({ error: "ADB not found on this machine" }));
        ws.close();
        return;
      }

      const deviceCheck = spawnSync(adbPath, ["devices"], { encoding: "utf8", timeout: 5000 });
      logger.info({ serial, elapsedMs: elapsed() }, "[mobile-video] timing: adb devices check done");
      const deviceLine = (deviceCheck.stdout ?? "").split("\n").find(l => l.startsWith(serial));
      if (!deviceLine || deviceLine.split("\t")[1]?.trim() !== "device") {
        ws.send(JSON.stringify({ error: `Device ${serial} not found or not ready` }));
        ws.close();
        return;
      }

      let running = true;
      let restartCount = 0;
      let currentChild: ReturnType<typeof spawn> | null = null;

      const adbShell = (...args: string[]) =>
        spawn(adbPath, ["-s", serial, "shell", ...args], { stdio: "ignore" });

      // Keep the screen awake for the duration of the mirror session — same
      // trick as the PNG endpoint, but doubly important here: if the display
      // actually powers off, screenrecord stops producing frames entirely.
      let originalScreenTimeout = "30000";
      try {
        const st = spawnSync(adbPath, ["-s", serial, "shell", "settings", "get", "system", "screen_off_timeout"], { encoding: "utf8", timeout: 3000 });
        const val = st.stdout?.trim();
        if (val && /^\d+$/.test(val)) originalScreenTimeout = val;
      } catch { /* ignore */ }
      adbShell("settings", "put", "system", "screen_off_timeout", "2147483647");
      // WAKEUP and dismiss-keyguard intentionally removed: auto-waking on
      // connect was the root cause of the phone constantly waking between
      // automation cycles. Wake is now exclusively user-triggered (canvas tap).

      // NOTE: we intentionally do NOT force `--size` to the device's exact
      // `wm size` here. screenrecord's encoder on many devices requires
      // width/height to be 16-pixel-aligned; most phone resolutions (e.g.
      // 1080x2400) are NOT multiples of 16, so pinning the raw wm-size value
      // made screenrecord fail to start at all (symptom: stream never
      // produces data — "waiting for screen data" forever). Instead we let
      // screenrecord pick its own (possibly downscaled) size, and correct
      // tap coordinates for the mismatch server-side in the /input/tap route
      // by scaling from the video's reported size to the device's real size.

      let cleanedUp = false;
      const cleanup = (reason: string) => {
        if (cleanedUp) return; // idempotent — close fires after error too
        cleanedUp = true;
        running = false;
        videoSessionActive.delete(serial);
        videoSessionWS.delete(serial);
        if (lagWatchdog) clearInterval(lagWatchdog);
        try { currentChild?.kill(); } catch { /* ignore */ }
        try { adbShell("settings", "put", "system", "screen_off_timeout", originalScreenTimeout); } catch { /* ignore */ }
        logger.info({ serial, reason }, "[mobile-video] session cleaned up");
      };
      ws.on("close", () => cleanup("close"));
      ws.on("error", (err) => { logger.error({ serial, err }, "[mobile-video] WebSocket error"); cleanup("error"); });

      // ── Client-triggered resync ───────────────────────────────────────────
      // The client sends { clientLag: true } when its WebCodecs decode queue
      // has been backed up for >800ms. The server-side ws.bufferedAmount check
      // only catches TCP send-buffer backlog (i.e. client can't receive fast
      // enough) — it misses the case where TCP delivers data quickly but the
      // client's GPU decoder falls behind. This bidirectional signal is the
      // only reliable way to catch that second scenario.
      ws.on("message", (raw: Buffer | string) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.clientLag && running) {
            logger.warn({ serial }, "[mobile-video] client reported decode lag — restarting screenrecord");
            if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Mirror fell behind — resyncing…" }));
            lastLagRestart = Date.now();
            try { currentChild?.kill(); } catch { /* ignore — close handler restarts */ }
          }
        } catch { /* ignore non-JSON control frames */ }
      });

      // ── Lag watchdog ─────────────────────────────────────────────────────
      // "The delay/lag is awful" / "video is no longer 30fps" reports trace
      // back to the same mechanism: ws.send() here is fire-and-forget. If the
      // browser (or the Node event loop itself, e.g. an unrelated slow
      // synchronous block introduced by some other code change) can't drain
      // the socket as fast as screenrecord produces bytes, Node queues the
      // backlog in `ws.bufferedAmount` and keeps growing it forever — WS/TCP
      // backpressure never self-corrects here because we never checked for
      // it. The stream doesn't visibly break, it just falls further and
      // further behind real time, which looks exactly like "stopped being
      // 30fps" / "awful lag" to the user, and — critically — never recovers
      // on its own; only a full reconnect used to clear it. Poll the queued
      // byte count and force a fresh screenrecord (which restarts from a
      // clean IDR frame with an empty send queue) whenever it backs up past
      // ~2 seconds of video at the stream's own bit rate, so lag is bounded
      // and self-healing instead of compounding for the rest of the session.
      // Threshold lowered from 2 MB to 800 KB so the watchdog fires much
      // sooner — at 8 Mbps, 800 KB is only ~0.8 s of buffered video, which
      // keeps the observed lag tight. The watchdog also runs every 500 ms
      // instead of 1 s so it catches a growing backlog faster.
      const LAG_BYTES_THRESHOLD = 800_000; // ~0.8s of buffered video at 8Mbps
      let lastLagRestart = 0;
      const lagWatchdog = setInterval(() => {
        if (!running || ws.readyState !== 1) return;
        const buffered = ws.bufferedAmount;
        if (buffered > LAG_BYTES_THRESHOLD && Date.now() - lastLagRestart > 4000) {
          lastLagRestart = Date.now();
          logger.warn({ serial, buffered }, "[mobile-video] send buffer backed up — forcing screenrecord restart to clear lag");
          if (ws.readyState === 1) ws.send(JSON.stringify({ info: "Mirror fell behind — resyncing…" }));
          try { currentChild?.kill(); } catch { /* ignore — close handler restarts */ }
        }
      }, 500);

      // Scoped to the whole WS session (not per screenrecord restart) so a
      // stall that persists across several internal restarts still only
      // sends/logs its notice once, instead of every ~6s forever.
      let stallNotified = false;

      const spawnStream = () => {
        if (!running || ws.readyState !== 1) return;
        // --output-format=h264: raw Annex-B elementary stream (no MP4 container)
        // straight to stdout via `exec-out` — this is what lets us pipe it
        // directly into a WebSocket frame-by-frame with zero temp files.
        const args = [
          "-s", serial, "exec-out", "screenrecord",
          "--output-format=h264",
          // 4 Mbps instead of 8 Mbps: halves the data volume per second,
          // which halves how fast the client decode queue can fill up and
          // halves the lag that accumulates before the resync watchdog fires.
          // Mirror quality at 4 Mbps is still excellent for a local USB stream.
          "--bit-rate", "4000000",
          "--time-limit", "180",
          "-",
        ];
        const child = spawn(adbPath, args);
        currentChild = child;
        let sawAnyData = false;
        let bytesTotal = 0;
        let stderrOut = "";

        // screenrecord on some OEM builds (MIUI especially) will hand back
        // SPS/PPS and then go completely silent — no more stdout, no exit,
        // no error — if the virtual display it's mirroring stops producing
        // new frames (keyguard re-engaging, always-on-display swallowing the
        // real screen, DRM/secure-surface blocking, etc). That looks exactly
        // like "connected but frozen forever" from the client's side. Watch
        // for a stall and force a fresh screenrecord + re-poke the device
        // rather than hanging indefinitely.
        // Only surface the "stalled" notice once per stall episode — every
        // restart re-arms the timer, and if the screen genuinely stays off
        // the old code kept logging/sending the same message every 6s
        // forever (this is what filled the Log panel with endless "Tap the
        // mirror to wake" lines). Reset the flag only when real data flows
        // again, so the client still gets a single fresh notice per episode.
        // Stall threshold — three tiers:
        //
        //  1. No real frame yet (only SPS/PPS headers received, chunk ≤ ~500 B):
        //     Restart at 8 s.  This is the MIUI/Instagram DRM scenario: scrcpy
        //     sends the codec headers then freezes because the secure surface
        //     blocks capture.  We want to restart quickly so the mirror catches
        //     up rather than sitting blank until the user notices.
        //
        //  2. Real frames were flowing + automation cycle is active:
        //     Wait 30 s.  UIAutomator accessibility dumps take 1–2 s each and
        //     are chained during launch — 6 s would fire mid-dump and kill the
        //     stream while the phone is legitimately busy.
        //
        //  3. Real frames were flowing + no automation:
        //     6 s.  Normal idle mirror watchdog.
        //
        // A "real frame" is any chunk > 512 B (SPS/PPS on this device is
        // 117 B; a real IDR frame is typically 30–200 KB).
        let sawRealFrame = false;
        const stallThresholdMs = () => {
          // No real IDR frame yet — MIUI DRM is likely blocking capture.
          // Restart aggressively (4 s) so each restart has a short window to
          // catch a real frame before DRM re-engages.  This is faster than the
          // original 6 s constant timeout, giving more frequent catch attempts.
          if (!sawRealFrame) return 4_000;
          // Real frames were flowing + automation active — UIAutomator dumps
          // can cause legitimate 3–5 s gaps between frames.  Wait patiently.
          return automationCycleInProgress.has(serial) ? 30_000 : 6_000;
        };
        let stallTimer: NodeJS.Timeout | null = null;
        const armStall = (ms: number) => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(() => {
            logger.warn({ serial, bytesTotal, sawRealFrame }, `[mobile-video] stream stalled — no data for ${ms / 1000}s, forcing restart`);
            if (!stallNotified) {
              stallNotified = true;
              // Only notify the client for DRM blocks — the generic "screen may
              // be off" message is suppressed as it clutters the log uselessly.
              const cycleActive = automationCycleInProgress.has(serial);
              if (!sawRealFrame && ws.readyState === 1) {
                // DRM block message suppressed — too noisy in the log.
              } else if (sawRealFrame && cycleActive && ws.readyState === 1) {
                ws.send(JSON.stringify({ info: "Stream paused — automation busy (UIAutomator / adb). Restarting stream…" }));
              }
              // "screen may be off" case: no client log — server restarts silently.
            }
            // WAKEUP intentionally omitted: wake must only come from user input.
            try { child.kill(); } catch { /* ignore — close handler restarts */ }
          }, ms);
        };
        armStall(stallThresholdMs());

        child.stdout.on("data", (chunk: Buffer) => {
          if (!sawAnyData) {
            logger.info({ serial, elapsedMs: elapsed(), restartCount }, "[mobile-video] timing: first stdout chunk from screenrecord");
          }
          sawAnyData = true;
          bytesTotal += chunk.length;
          if (!sawRealFrame && chunk.length > 512) {
            sawRealFrame = true;
            logger.info({ serial, chunkBytes: chunk.length, elapsedMs: elapsed() }, "[mobile-video] first real IDR frame received");
          }
          stallNotified = false;
          armStall(stallThresholdMs());
          if (ws.readyState === 1) ws.send(chunk);
        });
        child.stderr?.on("data", (d: Buffer) => {
          const line = d.toString().trim();
          stderrOut += line;
          if (line && ws.readyState === 1) ws.send(JSON.stringify({ info: `[screenrecord] ${line}` }));
        });
        child.on("error", (err) => {
          if (stallTimer) clearTimeout(stallTimer);
          logger.error({ serial, err }, "[mobile-video] spawn error for screenrecord");
          if (ws.readyState === 1) {
            ws.send(JSON.stringify({ error: `Failed to start screenrecord: ${err.message}`, fatal: true }));
            ws.close();
          }
          cleanup("screenrecord spawn error");
        });
        child.on("close", (code) => {
          if (stallTimer) clearTimeout(stallTimer);
          currentChild = null;
          if (!running) return;
          if (!sawAnyData) {
            // screenrecord never produced a byte — likely unsupported on this
            // device/Android version. Tell the client so it can fall back to
            // the PNG polling stream instead of retrying forever.
            logger.warn({ serial, code, stderr: stderrOut.trim() }, "[mobile-video] screenrecord produced no data — unsupported?");
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ error: `screenrecord unavailable on this device (${stderrOut.trim() || `exit ${code}`})`, fatal: true }));
              ws.close();
            }
            running = false;
            return;
          }
          // Hit the --time-limit, was stalled, or was killed for some other
          // transient reason — restart immediately to keep the stream going.
          restartCount++;
          logger.info({ serial, restartCount, code, bytesTotal }, "[mobile-video] screenrecord cycle ended — restarting");
          spawnStream();
        });
      };

      // A prior mirror session (tab closed/refreshed without a clean
      // WebSocket close, or the previous `child.kill()` only killed the
      // local `adb exec-out` process but not the remote on-device
      // `screenrecord`) can leave a screenrecord instance holding the
      // hardware encoder. The new invocation then has to wait for Android
      // to notice the old process died before it can grab the encoder
      // itself — this is the "first connect is ~5s delayed, reconnect is
      // instant" symptom, since by the second attempt the stale process has
      // already been reaped. Explicitly clear any stale instance first so
      // every connection gets the encoder immediately. Guarded by
      // `videoSessionActive`: only run this when THIS process has no other
      // tracked session already streaming that serial, so an overlapping
      // second connection to the same device can never kill a sibling
      // session's own live screenrecord out from under it.
      if (!videoSessionActive.has(serial)) {
        spawnSync(adbPath, ["-s", serial, "shell", "pkill", "-f", "screenrecord"], { encoding: "utf8", timeout: 3000 });
      }
      videoSessionActive.add(serial);
      videoSessionWS.set(serial, ws);
      logger.info({ serial, elapsedMs: elapsed() }, "[mobile-video] timing: pkill stale screenrecord done");

      // NOTE: an earlier fix here assumed the display being off explained
      // the first-connect delay — the user confirmed the screen was ON, so
      // that theory was wrong. Keeping ensureScreenOn as a no-op-when-on
      // safety net (it returns immediately if the screen is already awake),
      // but logging its own elapsed cost separately so it's not blamed for
      // time it didn't spend.
      const screenOnBefore = await android.isScreenOn(serial).catch(() => null);
      await android.ensureScreenOn(serial).catch(() => { /* best effort */ });
      logger.info({ serial, elapsedMs: elapsed(), screenWasAlreadyOn: screenOnBefore === true }, "[mobile-video] timing: ensureScreenOn done");

      logger.info({ serial, elapsedMs: elapsed(), adbPath }, "[mobile-video] timing: about to spawn screenrecord");
      spawnStream();
    });
  });

  // ── Log-stream WebSocket ───────────────────────────────────────────────────
  // Lightweight always-on channel: no video frames, just { info } / { error }
  // log messages pushed by sendVideoLog.  The frontend connects one of these
  // per real device so logs accumulate even when the mirror screen is closed.
  httpServer.on("upgrade", (request, socket, head) => {
    const url = request.url ?? "";
    const m = url.match(/^\/api\/mobile\/log-stream\/([^/?#]+)/);
    if (!m) return;
    const serial = decodeURIComponent(m[1]);
    (socket as any).__wsHandled = true;
    logStreamWSS.handleUpgrade(request, socket as any, head, (ws) => {
      if (!logSessionWS.has(serial)) logSessionWS.set(serial, new Set());
      logSessionWS.get(serial)!.add(ws);
      ws.on("close", () => {
        const set = logSessionWS.get(serial);
        if (set) { set.delete(ws); if (set.size === 0) logSessionWS.delete(serial); }
      });
    });
  });

  // ── HST diagnostic log endpoint ────────────────────────────────────────────
  // Receives fire-and-forget POST from the client scheduling effect so that
  // [HST-DBG] messages appear in aura-farming-debug.log, not just the UI Action Log.
  app.post("/api/hst-dbg", (req: Request, res: Response) => {
    const msg = typeof req.body?.msg === "string" ? req.body.msg : String(req.body?.msg ?? "");
    if (msg) logger.info(`[HST-DBG] ${msg}`);
    res.json({ ok: true });
  });

  // ── Screen size ────────────────────────────────────────────────────────────
  app.get("/api/mobile/devices/:serial/screen-size", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const { stdout } = await execFileP(adbPath, ["-s", p(req, "serial"), "shell", "wm", "size"], { timeout: 5000 } as any);
      const m = String(stdout).match(/(\d+)x(\d+)/);
      if (m) { res.json({ width: parseInt(m[1]), height: parseInt(m[2]) }); }
      else { res.status(500).json({ error: "Could not parse screen size" }); }
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Screen info (raw, in-app diagnostic — no terminal needed) ──────────────
  // Returns the RAW `wm size` output, not just a parsed WxH. This device farm
  // has a known-suspected bug where "Physical size" and "Override size" report
  // different values (a display-size override active on the device), which
  // desyncs any coordinate math that assumes a single screen size. The parsed
  // /screen-size endpoint above collapses that distinction; this one preserves
  // it so it can be diagnosed from a single in-app button click.
  //
  // This was originally added in v1.1.547, then removed in v1.1.548 on the
  // (incorrect, as it turned out) theory that the offset bug was "fixed at
  // the source" — v1.1.550/551 show the wm-size/video-frame mismatch is
  // still very much alive, and it's now also the leading suspect for the
  // mirror rendering at the wrong aspect ratio entirely (not just tap
  // offset), so the diagnostic is reinstated rather than re-guessed.
  app.get("/api/mobile/devices/:serial/screen-info", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const serial = p(req, "serial");
      const [sizeR, densityR] = await Promise.all([
        execFileP(adbPath, ["-s", serial, "shell", "wm", "size"], { timeout: 5000 } as any),
        execFileP(adbPath, ["-s", serial, "shell", "wm", "density"], { timeout: 5000 } as any),
      ]);
      const sizeOut = String(sizeR.stdout || "").trim();
      const densityOut = String(densityR.stdout || "").trim();
      const physicalM = sizeOut.match(/Physical size:\s*(\d+)x(\d+)/);
      const overrideM = sizeOut.match(/Override size:\s*(\d+)x(\d+)/);
      const physical = physicalM ? { w: parseInt(physicalM[1]), h: parseInt(physicalM[2]) } : null;
      const override = overrideM ? { w: parseInt(overrideM[1]), h: parseInt(overrideM[2]) } : null;
      let mismatch: { physicalRatio: number; overrideRatio: number; percentDiff: number } | null = null;
      if (physical && override) {
        const physicalRatio = physical.w / physical.h;
        const overrideRatio = override.w / override.h;
        mismatch = { physicalRatio, overrideRatio, percentDiff: Math.abs(physicalRatio - overrideRatio) / physicalRatio * 100 };
      }
      res.json({ sizeRaw: sizeOut, densityRaw: densityOut, physical, override, mismatch });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Manual PC → phone media transfer ─────────────────────────────────────
  // This is intentionally separate from automated Make a Post. The user
  // chooses one image, loads it into DCIM/Camera, completes the Instagram post
  // manually in the mirror, and explicitly deletes the phone copy afterward.
  app.post("/api/mobile/devices/:serial/manual-media/load", async (req: Request, res: Response) => {
    let tempPath: string | null = null;
    try {
      const serial = p(req, "serial");
      const body = z.object({
        localPath: z.string().trim().min(1).optional(),
        fileName: z.string().trim().min(1).max(255),
        fileData: z.string().min(1).optional(),
      }).refine(v => !!v.localPath || !!v.fileData, { message: "localPath or fileData is required" }).parse(req.body);

      const ext = path.extname(body.fileName).toLowerCase();
      const allowedExts = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".avif", ".bmp"]);
      if (!allowedExts.has(ext)) {
        res.status(400).json({ ok: false, error: "Choose an image file (JPG, PNG, WEBP, GIF, HEIC, HEIF, AVIF, or BMP)." });
        return;
      }

      let sourcePath = body.localPath;
      if (body.fileData) {
        const safeName = body.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        tempPath = path.join(os.tmpdir(), `equinox-manual-media-${Date.now()}-${safeName}`);
        const buffer = Buffer.from(body.fileData.replace(/^data:[^;]+;base64,/, ""), "base64");
        if (!buffer.length) throw new Error("Selected image data was empty");
        await fsPromises.writeFile(tempPath, buffer);
        sourcePath = tempPath;
      }
      if (!sourcePath) throw new Error("No image source was provided");
      const stat = await fsPromises.stat(sourcePath);
      if (!stat.isFile()) throw new Error("Selected image path is not a file");
      if (stat.size > 100 * 1024 * 1024) throw new Error("Image is larger than 100 MB");

      const devicePath = await android.pushFileToDevice(serial, sourcePath, body.fileName);
      logger.info({ serial, fileName: body.fileName, devicePath }, "[manual-media] loaded image onto phone");
      res.json({ ok: true, fileName: body.fileName, devicePath });
    } catch (e: any) {
      logger.warn({ err: e }, "[manual-media] load failed");
      res.status(400).json({ ok: false, error: e?.message ?? "Could not load image onto phone" });
    } finally {
      if (tempPath) await fsPromises.unlink(tempPath).catch(() => {});
    }
  });

  app.delete("/api/mobile/devices/:serial/manual-media", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const devicePath = z.string()
        .regex(/^\/sdcard\/DCIM\/Camera\/IMG_[a-f0-9]{24}\.(jpg|jpeg|png|webp|gif|heic|heif|avif|bmp)$/, "Invalid manual media path")
        .parse(req.body?.devicePath);
      await android.removeDeviceFile(serial, devicePath);
      logger.info({ serial, devicePath }, "[manual-media] deleted image from phone");
      res.json({ ok: true, devicePath });
    } catch (e: any) {
      logger.warn({ err: e }, "[manual-media] delete failed");
      res.status(400).json({ ok: false, error: e?.message ?? "Could not delete image from phone" });
    }
  });

  // Diagnostic-only PC -> phone transfer. This never opens Instagram, selects
  // an account, or leaves the test image on the device.
  app.post("/api/mobile/devices/:serial/media-audit", async (req: Request, res: Response) => {
    let prepared: Awaited<ReturnType<typeof prepareMakePostImage>> | null = null;
    let devicePath: string | null = null;
    let tempPath: string | null = null;
    try {
      const serial = p(req, "serial");
      const body = z.object({
        localPath: z.string().trim().min(1).optional(),
        fileName: z.string().trim().min(1).max(255),
        fileData: z.string().min(1).optional(),
        fixAiSlop: z.boolean().default(false),
        alterationEnabled: z.boolean().default(true),
        alterationLevel: z.enum(["small", "medium", "large"]).default("small"),
        frequencyDisruption: z.boolean().default(false),
      }).refine(v => !!v.localPath || !!v.fileData, { message: "localPath or fileData is required" }).parse(req.body);
      let sourcePath = body.localPath;
      if (body.fileData) {
        const safeName = body.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        tempPath = path.join(os.tmpdir(), `equinox-media-audit-${Date.now()}-${safeName}`);
        const buffer = Buffer.from(body.fileData.replace(/^data:[^;]+;base64,/, ""), "base64");
        if (!buffer.length) throw new Error("Selected image data was empty");
        await fsPromises.writeFile(tempPath, buffer);
        sourcePath = tempPath;
      }
      if (!sourcePath) throw new Error("No image source was provided");
      const stat = await fsPromises.stat(sourcePath);
      if (!stat.isFile()) throw new Error("localPath is not a file");
      if (stat.size > 100 * 1024 * 1024) throw new Error("Image is larger than 100 MB");

      prepared = await prepareMakePostImage(sourcePath, body.fileName, {
        doFixAiSlop: body.fixAiSlop,
        alterationEnabled: body.alterationEnabled,
        alterationLevel: body.alterationLevel,
        frequencyDisruption: body.frequencyDisruption,
      });
      const originalReport = await forensicImageReport("original Windows source", await fsPromises.readFile(sourcePath));
      const processedReport = await forensicImageReport("processed Make a Post output", await fsPromises.readFile(prepared.pushFilePath));
      devicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
      await auditDeviceMediaCopy(serial, devicePath, prepared.audit);
      const pulledPath = await android.pullFileFromDevice(serial, devicePath);
      const pulledBytes = await fsPromises.readFile(pulledPath);
      const deviceSha256 = createHash("sha256").update(pulledBytes).digest("hex");
      const deviceMetadata = await sharp(pulledBytes).metadata();
      await fsPromises.rm(path.dirname(pulledPath), { recursive: true, force: true }).catch(() => {});

      res.json({
        ok: true,
        instagramOpened: false,
        devicePath,
        source: prepared.audit,
        forensic: {
          original: originalReport,
          processed: processedReport,
          device: await forensicImageReport("device pullback", pulledBytes),
          comparisons: {
            originalToProcessedByteIdentical: originalReport.sha256 === processedReport.sha256,
            processedToDeviceByteIdentical: processedReport.sha256 === deviceSha256,
            processedToDeviceMetadataIdentical:
              processedReport.format === (deviceMetadata.format ?? "unknown") &&
              processedReport.width === (deviceMetadata.width ?? 0) &&
              processedReport.height === (deviceMetadata.height ?? 0) &&
              processedReport.bytes === pulledBytes.length,
          },
        },
        device: {
          sha256: deviceSha256,
          bytes: pulledBytes.length,
          format: deviceMetadata.format ?? "unknown",
          width: deviceMetadata.width ?? 0,
          height: deviceMetadata.height ?? 0,
        },
        matchesProcessed: deviceSha256 === prepared.audit.processedSha256,
      });
    } catch (e: any) {
      res.status(400).json({ ok: false, instagramOpened: false, error: e?.message ?? "Media audit failed" });
    } finally {
      if (devicePath) await android.removeDeviceFile(p(req, "serial"), devicePath).catch(() => {});
      if (prepared) await prepared.cleanup().catch(() => {});
      if (tempPath) await fsPromises.unlink(tempPath).catch(() => {});
    }
  });

  // Batch audit: prepare exactly once, then transfer the identical bytes to
  // every selected device. This is the authoritative cross-device test.
  app.post("/api/mobile/media-audit-batch", async (req: Request, res: Response) => {
    let prepared: Awaited<ReturnType<typeof prepareMakePostImage>> | null = null;
    let tempPath: string | null = null;
    const devicePaths = new Map<string, string>();
    try {
      const body = z.object({
        serials: z.array(z.string().min(1)).min(1),
        localPath: z.string().trim().min(1).optional(),
        fileName: z.string().trim().min(1).max(255),
        fileData: z.string().min(1).optional(),
        fixAiSlop: z.boolean().default(false),
        alterationEnabled: z.boolean().default(true),
        alterationLevel: z.enum(["small", "medium", "large"]).default("small"),
        frequencyDisruption: z.boolean().default(false),
      }).refine(v => !!v.localPath || !!v.fileData, { message: "localPath or fileData is required" }).parse(req.body);
      let sourcePath = body.localPath;
      if (body.fileData) {
        const safeName = body.fileName.replace(/[^a-zA-Z0-9_.-]/g, "_");
        tempPath = path.join(os.tmpdir(), `equinox-media-audit-batch-${Date.now()}-${safeName}`);
        await fsPromises.writeFile(tempPath, Buffer.from(body.fileData.replace(/^data:[^;]+;base64,/, ""), "base64"));
        sourcePath = tempPath;
      }
      if (!sourcePath) throw new Error("No image source was provided");
      const stat = await fsPromises.stat(sourcePath);
      if (!stat.isFile() || stat.size > 100 * 1024 * 1024) throw new Error("Invalid image source");
      prepared = await prepareMakePostImage(sourcePath, body.fileName, {
        doFixAiSlop: body.fixAiSlop, alterationEnabled: body.alterationEnabled,
        alterationLevel: body.alterationLevel, frequencyDisruption: body.frequencyDisruption,
      });
      const processedBytes = await fsPromises.readFile(prepared.pushFilePath);
      const processedSha256 = createHash("sha256").update(processedBytes).digest("hex");
      const results = await Promise.all(body.serials.map(async serial => {
        try {
          const devicePath = await android.pushFileToDevice(serial, prepared!.pushFilePath, prepared!.pushFileName, false);
          devicePaths.set(serial, devicePath);
          const transfer = {
            sourcePath,
            sourceFileName: body.fileName,
            preparedFilePath: prepared!.pushFilePath,
            pushedFileName: prepared!.pushFileName,
            devicePath,
            stages: ["host source selected", "Make a Post preparation completed", "adb push completed", "device filesystem pullback before scan", "media scan broadcast sent", "device filesystem pullback after scan", "temporary device file removed"],
          };
          const preScanPath = await android.pullFileFromDevice(serial, devicePath);
          const preScanBytes = await fsPromises.readFile(preScanPath);
          const preScanSha256 = createHash("sha256").update(preScanBytes).digest("hex");
          await fsPromises.rm(path.dirname(preScanPath), { recursive: true, force: true }).catch(() => {});
          await android.scanMediaFile(serial, devicePath);
          const pulledPath = await android.pullFileFromDevice(serial, devicePath);
          const pulledBytes = await fsPromises.readFile(pulledPath);
          const postScanSha256 = createHash("sha256").update(pulledBytes).digest("hex");
          await fsPromises.rm(path.dirname(pulledPath), { recursive: true, force: true }).catch(() => {});
          return {
            serial, ok: true, transfer,
            preScan: { sha256: preScanSha256, bytes: preScanBytes.length },
            postScan: { sha256: postScanSha256, bytes: pulledBytes.length },
            matchesSharedProcessed: postScanSha256 === processedSha256,
            transferChangedFile: preScanSha256 !== postScanSha256,
            matchesOtherDevices: true,
          };
        } catch (error: any) {
          return { serial, ok: false, error: error?.message ?? "Device audit failed", matchesSharedProcessed: false, matchesOtherDevices: false };
        }
      }));
      const successful = results.filter(item => item.ok);
       const hashes = successful.map(item => item.postScan?.sha256);
      const sharedHash = hashes[0] ?? null;
       for (const item of results) if (item.ok) item.matchesOtherDevices = item.postScan?.sha256 === sharedHash;
      res.json({
         ok: true, instagramOpened: false, preparedOnce: true, inspection: "pc-to-phone-transfer-channel",
         transfer: {
           sourcePath,
           sourceFileName: body.fileName,
           preparedFilePath: prepared.pushFilePath,
           pushedFileName: prepared.pushFileName,
           preparedSha256: processedSha256,
           stages: ["host source selected", "Make a Post preparation completed", "same prepared file transferred to every selected device"],
         },
        results,
        crossDevice: {
          allSuccessful: successful.length === results.length,
          allDevicesReceivedSameBytes: successful.length > 0 && hashes.every(hash => hash === sharedHash),
          deviceCount: results.length,
          successfulCount: successful.length,
        },
      });
    } catch (error: any) {
      res.status(400).json({ ok: false, instagramOpened: false, error: error?.message ?? "Batch media audit failed" });
    } finally {
      await Promise.all([...devicePaths.entries()].map(([serial, devicePath]) => android.removeDeviceFile(serial, devicePath).catch(() => {})));
      if (prepared) await prepared.cleanup().catch(() => {});
      if (tempPath) await fsPromises.unlink(tempPath).catch(() => {});
    }
  });

  // BANNED: `adb shell wm size reset` (and any command that changes phone display settings)
  // is permanently removed. The code handles coordinate differences in software via
  // rescaleForDevice() — the phone's display settings must never be touched by this app.

  // ── Network interfaces (for source-adapter picker in UI) ───────────────────
  app.get("/api/network/interfaces", (_req: Request, res: Response) => {
    const raw = os.networkInterfaces();
    const result: { name: string; ip: string; family: string }[] = [];
    for (const [name, addrs] of Object.entries(raw)) {
      for (const addr of addrs ?? []) {
        if (!addr.internal) {
          result.push({ name, ip: addr.address, family: addr.family });
        }
      }
    }
    res.json(result);
  });

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

  // ── Per-device automation settings (isolated to the Mobile tab) ─────────────
  // NOTE (12 Jul 2026 fix): this schema previously only covered the
  // feed/stories fields. Any keys NOT listed in a z.object() schema are
  // silently stripped by .parse() (zod's default, non-strict behaviour) —
  // so every autosave of Follow Users / Inject Browsing settings was
  // dropping those fields before they ever reached disk. The frontend
  // sends them right back on the next load from AUTOMATION_DEFAULTS,
  // which is exactly what looked like "settings reset on restart". Any
  // NEW persisted field must be added here too, or it will silently never
  // survive a save.
  const followSourceSchema = z.object({ type: z.string(), value: z.string() });
  const automationSchema = z.object({
    enabled: z.boolean().default(false),
    cycleIntervalMin: z.number().min(1).max(9999).optional(),
    cycleIntervalMax: z.number().min(1).max(9999).optional(),
    feedEnabled: z.boolean().default(true),
    storiesEnabled: z.boolean().default(true),
    actionDelayMin: z.number().min(0).max(9999),
    actionDelayMax: z.number().min(0).max(9999),
    likePercentMin: z.number().min(0).max(100),
    likePercentMax: z.number().min(0).max(100),
    shareFeedPercentMin: z.number().min(0).max(100).default(0),
    shareFeedPercentMax: z.number().min(0).max(100).default(0),
    shareDmPercentMin: z.number().min(0).max(100).default(0),
    shareDmPercentMax: z.number().min(0).max(100).default(0),
    savePercentMin: z.number().min(0).max(100).default(0),
    savePercentMax: z.number().min(0).max(100).default(0),
    expandCaptionPercentMin: z.number().min(0).max(100).default(0),
    expandCaptionPercentMax: z.number().min(0).max(100).default(0),
    tapAudioPercentMin: z.number().min(0).max(100).default(0),
    tapAudioPercentMax: z.number().min(0).max(100).default(0),
    clickHashtagPercentMin: z.number().min(0).max(100).default(0),
    clickHashtagPercentMax: z.number().min(0).max(100).default(0),
    clickAuthorPercentMin: z.number().min(0).max(100).default(0),
    clickAuthorPercentMax: z.number().min(0).max(100).default(0),
    feedRerunChanceMin: z.number().min(0).max(100).default(0),
    feedRerunChanceMax: z.number().min(0).max(100).default(0),
    feedScrollMin: z.number().min(1),
    feedScrollMax: z.number().min(1),
    viewStoriesSlidesMin: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMax: z.number().min(0).max(100).default(0),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
    viewStoriesLikePercentMin: z.number().min(0).max(100).default(0),
    viewStoriesLikePercentMax: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesCommentPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesCommentPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    viewReelsEnabled: z.boolean().default(false),
    viewReelsScrollMin: z.number().min(0).max(100).default(0),
    viewReelsScrollMax: z.number().min(0).max(100).default(0),
    viewReelsLikePercentMin: z.number().min(0).max(100).default(0),
    viewReelsLikePercentMax: z.number().min(0).max(100).default(0),
    viewReelsShareFeedPercentMin: z.number().min(0).max(100).default(0),
    viewReelsShareFeedPercentMax: z.number().min(0).max(100).default(0),
    viewReelsShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewReelsShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewReelsSavePercentMin: z.number().min(0).max(100).default(0),
    viewReelsSavePercentMax: z.number().min(0).max(100).default(0),
    viewReelsActivatePctMin: z.number().min(0).max(100).default(100),
    viewReelsActivatePctMax: z.number().min(0).max(100).default(100),
    // viewReelsWatchPctMin/Max were missing from this persistence schema even
    // though they appeared in the GET defaults and the execution schema.  Zod
    // was silently stripping them on every POST so Watch % never actually saved
    // to disk and always reset to the 30-70 default on the next page load.
    viewReelsWatchPctMin: z.number().min(1).max(100).default(30),
    viewReelsWatchPctMax: z.number().min(1).max(100).default(70),
    viewReelsClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewReelsClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    // View Explore Page — see AutomationSettings type above for full comment.
    viewExploreEnabled: z.boolean().default(false),
    viewExploreActivatePctMin: z.number().min(0).max(100).default(100),
    viewExploreActivatePctMax: z.number().min(0).max(100).default(100),
    viewExploreScrollMin: z.number().min(0).max(100).default(0),
    viewExploreScrollMax: z.number().min(0).max(100).default(0),
    viewExploreActionDelayMin: z.number().min(0).max(9999).default(3),
    viewExploreActionDelayMax: z.number().min(0).max(9999).default(6),
    viewExploreClickPostPctMin: z.number().min(0).max(100).default(0),
    viewExploreClickPostPctMax: z.number().min(0).max(100).default(0),
    viewExploreLikePercentMin: z.number().min(0).max(100).default(0),
    viewExploreLikePercentMax: z.number().min(0).max(100).default(0),
    viewExploreShareFeedPercentMin: z.number().min(0).max(100).default(0),
    viewExploreShareFeedPercentMax: z.number().min(0).max(100).default(0),
    viewExploreShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewExploreShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewExploreSavePercentMin: z.number().min(0).max(100).default(0),
    viewExploreSavePercentMax: z.number().min(0).max(100).default(0),
    viewExploreClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewExploreClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    followEnabled: z.boolean().default(false),
    followUsersMin: z.number().min(0).max(9999).default(1),
    followUsersMax: z.number().min(0).max(9999).default(3),
    followSpreadFollows: z.boolean().default(false),
    followSources: z.array(followSourceSchema).default([]),
    injectBrowsingEnabled: z.boolean().default(false),
    injectBrowsingActivatePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingActivatePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingFeedMin: z.number().min(0).default(3),
    injectBrowsingFeedMax: z.number().min(0).default(6),
    injectBrowsingClickPostPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingClickPostPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingSavePostPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingSavePostPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingAbandonFollowPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingAbandonFollowPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingTapHighlightsPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingTapHighlightsPctMax: z.number().min(0).max(100).default(0),
    // ── Follow Filters — profile-quality gates. Were missing from the
    //    persistence schema, causing zod to strip them on every POST so
    //    Copy Settings never actually applied them to target slots.
    followFiltersEnabled: z.boolean().default(false),
    followFilterPrivateUsers: z.boolean().default(false),
    followFilterEnglishSpeaking: z.boolean().default(false),
    followFilterMinFollowers50: z.boolean().default(false),
    followFilterVerifiedUsers: z.boolean().default(false),
    followFilterMaxFollowers25k: z.boolean().default(false),
    followFilterMalesOnly: z.boolean().default(false),
    followFilterMaleNames: z.string().default(""),
    // ── Random Jitter fields — were missing from this persistence schema,
    //    causing zod to silently strip them on every POST so they never reached
    //    disk and reset to defaults on every restart.
    randomJitterEnabled: z.boolean().default(false),
    checkNotificationsPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsPctMax: z.number().min(0).max(100).default(0),
    checkNotificationsScrollsMin: z.number().min(0).default(2),
    checkNotificationsScrollsMax: z.number().min(0).default(5),
    checkNotificationsClickPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsClickPctMax: z.number().min(0).max(100).default(0),
    visitProfilePctMin: z.number().min(0).max(100).default(0),
    visitProfilePctMax: z.number().min(0).max(100).default(0),
    // Visit Saved — go to profile → hamburger → Saved, scroll 1–10 times, return.
    visitSavedPctMin: z.number().min(0).max(100).default(0),
    visitSavedPctMax: z.number().min(0).max(100).default(0),
    // Visit Random Settings — profile → hamburger → tap one row, optionally
    // scroll once, then press Back once.
    visitSettingsPctMin: z.number().min(0).max(100).default(0),
    visitSettingsPctMax: z.number().min(0).max(100).default(0),
    // App Switch: press square button, open SMS for random dwell, return to Instagram.
    appSwitchPctMin: z.number().min(0).max(100).default(0),
    appSwitchPctMax: z.number().min(0).max(100).default(0),
    // Update Profile Picture — navigates to own profile → Edit profile → Edit pictures → gallery.
    updateProfilePicActivatePctMin: z.number().min(0).max(100).default(0),
    updateProfilePicActivatePctMax: z.number().min(0).max(100).default(0),
    updateProfilePicFolderPath: z.string().default(""),
    updateProfilePicDisableAfterUsed: z.boolean().default(false),
    updateProfilePicAlterationEnabled: z.boolean().default(true),
    updateProfilePicAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    updateProfilePicImageSettingsEnabled: z.boolean().default(true),
    updateProfilePicImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
     updateProfilePicFixAiSlop: z.boolean().default(true),
     updateProfilePicMetadataCleanup: z.boolean().default(true),
     updateProfilePicFrequencyDisruption: z.boolean().default(false),
    // Update Bio — navigates to own profile → Edit profile → taps bio field → pastes bioText → saves.
    updateBioActivatePctMin: z.number().min(0).max(100).default(0),
    updateBioActivatePctMax: z.number().min(0).max(100).default(0),
    updateBioText: z.string().default(""),
    updateBioDisableAfterUsed: z.boolean().default(false),
    // ── Check DMs — opens the inbox, scrolls, optionally taps a thread.
    checkDmEnabled: z.boolean().default(false),
    checkDmActivatePctMin: z.number().min(0).max(100).default(100),
    checkDmActivatePctMax: z.number().min(0).max(100).default(100),
    checkDmScrollMin: z.number().min(0).default(1),
    checkDmScrollMax: z.number().min(0).default(3),
    checkDmClickPctMin: z.number().min(0).max(100).default(0),
    checkDmClickPctMax: z.number().min(0).max(100).default(0),
    // ── Activate Percentage — top-level per-execution chance gate for each
    // tool (rolled once per automation-cycle run, before the tool's own
    // internal settings are even considered). Defaults to 100/100 (always
    // runs) so upgrading doesn't silently start skipping an already-enabled
    // tool for existing users.
    feedActivatePctMin: z.number().min(0).max(100).default(100),
    feedActivatePctMax: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMin: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMax: z.number().min(0).max(100).default(100),
    followActivatePctMin: z.number().min(0).max(100).default(100),
    followActivatePctMax: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMin: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMax: z.number().min(0).max(100).default(100),
    // ── Make a Post — ported from the old browser-automation tool's
    // repost* settings. The automation cycle consumes the local-folder,
    // alteration, and image-settings fields below.
    makePostEnabled: z.boolean().default(false),
    makePostActivatePctMin: z.number().min(0).max(100).default(100),
    makePostActivatePctMax: z.number().min(0).max(100).default(100),
    makePostPerSessionMin: z.number().min(1).max(20).default(1),
    makePostPerSessionMax: z.number().min(1).max(20).default(1),
    makePostAlterationEnabled: z.boolean().default(true),
    makePostAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    makePostImageSettingsEnabled: z.boolean().default(true),
    makePostDisableWhenExhausted: z.boolean().default(true),
    // My Computer is the only Make a Post source. Keep this field for
    // compatibility with older saved payloads, but normalize it to true at
    // every mobile-settings boundary.
    makePostLocalFolderEnabled: z.boolean().default(true),
    makePostLocalFolderPath: z.string().default(""),
    makePostLocalFolderNoRepeat: z.boolean().default(false),
    makePostLocalFolderRandom: z.boolean().default(false),
    makePostLocalFolderDeleteAfterUpload: z.boolean().default(false),
    makePostAddLocation: z.boolean().default(false),
    makePostUseChatGpt: z.boolean().default(false),
    makePostFixAiSlop: z.boolean().default(true),
    makePostMetadataCleanup: z.boolean().default(true),
    makePostFrequencyDisruption: z.boolean().default(false),
    makePostPostToProfilePctMin: z.number().min(0).max(100).default(100),
    makePostPostToProfilePctMax: z.number().min(0).max(100).default(100),
    makePostPostToStoryPctMin: z.number().min(0).max(100).default(0),
    makePostPostToStoryPctMax: z.number().min(0).max(100).default(0),
    makePostCaptionText: z.string().default(""),
    makePostImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
    postStoryEnabled: z.boolean().default(false),
    postStoryActivatePctMin: z.number().min(0).max(100).default(100),
    postStoryActivatePctMax: z.number().min(0).max(100).default(100),
    postStoryLocalFolderPath: z.string().default(""),
    postStoryLocalFolderNoRepeat: z.boolean().default(false),
    postStoryLocalFolderRandom: z.boolean().default(false),
    postStoryAlterationEnabled: z.boolean().default(true),
    postStoryAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    postStoryImageSettingsEnabled: z.boolean().default(true),
    postStoryFixAiSlop: z.boolean().default(false),
    postStoryAddLink: z.boolean().default(false),
    postStoryLinkUrl: z.string().default(""),
    postStoryImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
    // ── Shuffle Tool Order — was missing from this persistence schema, causing
    //    zod to silently strip it on every POST so Copy Settings never saved it
    //    and the value reset to false on every restart.
    shuffleToolOrder: z.boolean().default(false),
    // TrustScore assignment metadata is persisted with the slot, while the
    // actual inherited values continue to live in the TrustScore template.
    // This keeps a slot's manual values recoverable when its TrustScore is
    // cleared.
    trustScoreId: z.string().max(100).nullable().default(null),
    trustScoreDisabledTools: z.array(z.string().max(40)).default([]),
    trustScoreToolOverrides: z.record(z.string().max(40), z.boolean()).default({}),
    // ── Device profile: OEM dismiss gesture direction for the recents/floating-
    //    windows app switcher. 'auto' = look up the model in DEVICE_PROFILES on
    //    the server; 'left'/'up' = manual override stored per device.
    dismissDirection: z.enum(["auto", "left", "up"]).default("auto"),
  });
  app.get("/api/mobile/devices/:serial/automation-settings", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const defaults: AutomationSettings = {
      enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
      feedEnabled: true, storiesEnabled: true,
      actionDelayMin: 5, actionDelayMax: 10,
      likePercentMin: 3, likePercentMax: 5,
      shareFeedPercentMin: 0, shareFeedPercentMax: 0,
      shareDmPercentMin: 0, shareDmPercentMax: 0,
      savePercentMin: 0, savePercentMax: 0,
      expandCaptionPercentMin: 0, expandCaptionPercentMax: 0,
      tapAudioPercentMin: 0, tapAudioPercentMax: 0,
      clickHashtagPercentMin: 0, clickHashtagPercentMax: 0,
      clickAuthorPercentMin: 0, clickAuthorPercentMax: 0,
      feedRerunChanceMin: 0, feedRerunChanceMax: 0,
      feedScrollMin: 5, feedScrollMax: 10,
      viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
      viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
      viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
      viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,
      viewStoriesCommentPercentMin: 0, viewStoriesCommentPercentMax: 0,
      viewStoriesClickAuthorPercentMin: 0, viewStoriesClickAuthorPercentMax: 0,
      viewReelsEnabled: false, viewReelsScrollMin: 0, viewReelsScrollMax: 0,
      viewReelsLikePercentMin: 0, viewReelsLikePercentMax: 0,
      viewReelsShareFeedPercentMin: 0, viewReelsShareFeedPercentMax: 0,
      viewReelsShareDmPercentMin: 0, viewReelsShareDmPercentMax: 0,
      viewReelsSavePercentMin: 0, viewReelsSavePercentMax: 0,
      viewReelsActivatePctMin: 100, viewReelsActivatePctMax: 100,
      viewReelsWatchPctMin: 30, viewReelsWatchPctMax: 70,
      viewReelsClickAuthorPercentMin: 0, viewReelsClickAuthorPercentMax: 0,
      viewExploreEnabled: false, viewExploreActivatePctMin: 100, viewExploreActivatePctMax: 100,
      viewExploreScrollMin: 0, viewExploreScrollMax: 0,
      viewExploreActionDelayMin: 3, viewExploreActionDelayMax: 6,
      viewExploreClickPostPctMin: 0, viewExploreClickPostPctMax: 0,
      viewExploreLikePercentMin: 0, viewExploreLikePercentMax: 0,
      viewExploreShareFeedPercentMin: 0, viewExploreShareFeedPercentMax: 0,
      viewExploreShareDmPercentMin: 0, viewExploreShareDmPercentMax: 0,
      viewExploreSavePercentMin: 0, viewExploreSavePercentMax: 0,
      viewExploreClickAuthorPercentMin: 0, viewExploreClickAuthorPercentMax: 0,
      followEnabled: false, followUsersMin: 1, followUsersMax: 3, followSpreadFollows: false, followSources: [],
      injectBrowsingEnabled: false,
      injectBrowsingActivatePctMin: 0, injectBrowsingActivatePctMax: 0,
      injectBrowsingBeforeFollowPctMin: 0, injectBrowsingBeforeFollowPctMax: 0,
      injectBrowsingFeedChanceMin: 100, injectBrowsingFeedChanceMax: 100,
      injectBrowsingFeedMin: 3, injectBrowsingFeedMax: 6,
      injectBrowsingClickPostPctMin: 0, injectBrowsingClickPostPctMax: 0,
      injectBrowsingLikePctMin: 0, injectBrowsingLikePctMax: 0,
      injectBrowsingShareFeedPctMin: 0, injectBrowsingShareFeedPctMax: 0,
      injectBrowsingShareDmPctMin: 0, injectBrowsingShareDmPctMax: 0,
      injectBrowsingSavePostPctMin: 0, injectBrowsingSavePostPctMax: 0,
      injectBrowsingTapHighlightsPctMin: 0, injectBrowsingTapHighlightsPctMax: 0,
      randomJitterEnabled: false,
      checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
      checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
      checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
      visitProfilePctMin: 0, visitProfilePctMax: 0,
      visitSavedPctMin: 0, visitSavedPctMax: 0,
      visitSettingsPctMin: 0, visitSettingsPctMax: 0,
      appSwitchPctMin: 0, appSwitchPctMax: 0,
      updateProfilePicActivatePctMin: 0, updateProfilePicActivatePctMax: 0,
      updateProfilePicFolderPath: "", updateProfilePicDisableAfterUsed: false,
      updateProfilePicAlterationEnabled: true, updateProfilePicAlterationLevel: "small",
      updateProfilePicImageSettingsEnabled: true,
      updateProfilePicImageSettings: {
        contrast: { enabled: true, min: 5, max: 250 },
        brightness: { enabled: true, min: 5, max: 250 },
        noise: { enabled: true, min: 5, max: 15 },
        sharpen: { enabled: true, min: 1.0, max: 2.0 },
        pixelate: { enabled: true, min: 0.9, max: 2.1 },
      },
      updateBioActivatePctMin: 0, updateBioActivatePctMax: 0,
      updateBioText: "", updateBioDisableAfterUsed: false,
      checkDmEnabled: false,
      checkDmActivatePctMin: 100, checkDmActivatePctMax: 100,
      checkDmScrollMin: 1, checkDmScrollMax: 3,
      checkDmClickPctMin: 0, checkDmClickPctMax: 0,
      feedActivatePctMin: 100, feedActivatePctMax: 100,
      viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
      followActivatePctMin: 100, followActivatePctMax: 100,
      randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
      makePostEnabled: false,
      makePostActivatePctMin: 100, makePostActivatePctMax: 100,
      makePostPerSessionMin: 1, makePostPerSessionMax: 1,
      makePostAlterationEnabled: true, makePostAlterationLevel: "small",
      makePostImageSettingsEnabled: true,
      makePostDisableWhenExhausted: true,
      makePostLocalFolderEnabled: true, makePostLocalFolderPath: "",
      makePostLocalFolderNoRepeat: false, makePostLocalFolderRandom: false,
      makePostLocalFolderDeleteAfterUpload: false,
    makePostUseChatGpt: false, makePostFixAiSlop: true,
      makePostCaptionText: "",
      makePostImageSettings: {
        contrast: { enabled: true, min: 5, max: 250 },
        brightness: { enabled: true, min: 5, max: 250 },
        noise: { enabled: true, min: 5, max: 15 },
        sharpen: { enabled: true, min: 1.0, max: 2.0 },
        pixelate: { enabled: true, min: 0.9, max: 2.1 },
      },
      postStoryEnabled: false,
      postStoryActivatePctMin: 100, postStoryActivatePctMax: 100,
      postStoryLocalFolderPath: "",
      postStoryLocalFolderNoRepeat: false, postStoryLocalFolderRandom: false,
      postStoryAlterationEnabled: true, postStoryAlterationLevel: "small",
      postStoryImageSettingsEnabled: true,
      postStoryFixAiSlop: false,
      postStoryImageSettings: {
        contrast: { enabled: true, min: 5, max: 250 },
        brightness: { enabled: true, min: 5, max: 250 },
        noise: { enabled: true, min: 5, max: 15 },
        sharpen: { enabled: true, min: 1.0, max: 2.0 },
        pixelate: { enabled: true, min: 0.9, max: 2.1 },
      },
      dismissDirection: "auto" as const,
    };
    res.json({ ...defaults, ...cfg[p(req, "serial")]?.automation });
  });
  app.post("/api/mobile/devices/:serial/automation-settings", (req: Request, res: Response) => {
    try {
      const input = automationSchema.parse(req.body);
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], automation: input };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, automation: input });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save automation settings" }); }
  });

  // ── TrustScore inheritance ────────────────────────────────────────────────
  // A slot keeps its own manual baseline in slotAutomation. When a TrustScore
  // is assigned, only template-controlled fields are resolved from the
  // current template at read/execution time. This deliberately avoids copying
  // a template snapshot into the slot, so later template edits propagate.
  const trustScoreAutomationKey = (trustScoreId: string) =>
    `trust_score_mobile_settings_${trustScoreId}`;
  const trustScoreDurationKey = (trustScoreId: string) =>
    `trust_score_duration_hours_${trustScoreId}`;
  const accountSlotId = (serial: string, slotIdx: number): string => {
    const slot = loadInstanceConfigs()[serial]?.account?.slots?.[slotIdx];
    return typeof slot?.slotId === "string" && slot.slotId.length >= 8
      ? slot.slotId
      : `legacy-index-${slotIdx}`;
  };
  const slotAutomationKey = (serial: string, slotIdx: number) =>
    accountSlotId(serial, slotIdx);
  const trustScoreAssignmentKey = (serial: string, slotIdx: number) =>
    `mobile_trust_score_${serial}_${accountSlotId(serial, slotIdx)}`;
  const trustScoreTimerKey = (serial: string, slotIdx: number) =>
    `mobile_trust_score_timer_${serial}_${accountSlotId(serial, slotIdx)}`;
  // Builds before stable slot IDs used the visible numeric index in these
  // settings keys. Keep the legacy key as a read/migration fallback so a
  // restart cannot make an existing assignment or countdown look new.
  const legacyTrustScoreAssignmentKey = (serial: string, slotIdx: number) =>
    `mobile_trust_score_${serial}_${slotIdx}`;
  const legacyTrustScoreTimerKey = (serial: string, slotIdx: number) =>
    `mobile_trust_score_timer_${serial}_${slotIdx}`;
  type TrustScoreTimerState = {
    scoreId: string;
    durationHours: number;
    startedAt: number | null;
    remainingMs: number | null;
    paused: boolean;
  };
  const readTrustScoreTimer = (
    all: Record<string, string>,
    serial: string,
    slotIdx: number,
  ): TrustScoreTimerState | null => {
    // Numeric index keys are not valid fallbacks: deleting a slot renumbers
    // later accounts, so an old numeric key belongs to the deleted account.
    const raw = all[trustScoreTimerKey(serial, slotIdx)];
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (
        typeof parsed?.scoreId !== "string" ||
        typeof parsed?.durationHours !== "number" ||
        typeof parsed?.paused !== "boolean"
      ) return null;
      return parsed as TrustScoreTimerState;
    } catch {
      return null;
    }
  };
  const trustScoreTimerRemainingMs = (timer: TrustScoreTimerState, now = Date.now()) =>
    timer.paused
      ? Math.max(0, timer.remainingMs ?? 0)
      : Math.max(0, (timer.startedAt ?? now) + timer.durationHours * 60 * 60 * 1000 - now);
  const writeTrustScoreTimer = async (
    serial: string,
    slotIdx: number,
    timer: TrustScoreTimerState,
  ) => {
    await storage.setGlobalSetting(trustScoreTimerKey(serial, slotIdx), JSON.stringify(timer));
  };
  const clearTrustScoreTimer = async (serial: string, slotIdx: number) => {
    // An empty JSON value is used instead of deleting global settings because
    // the storage abstraction intentionally exposes only set/get operations.
    await storage.setGlobalSetting(trustScoreTimerKey(serial, slotIdx), "");
  };
  const trustScoreIdSchema = z.string().min(1).max(100);
  const trustScoreAutomationDefaults = (): Record<string, any> => automationSchema.parse({
    actionDelayMin: 5,
    actionDelayMax: 10,
    likePercentMin: 3,
    likePercentMax: 5,
    feedScrollMin: 5,
    feedScrollMax: 10,
  });
  const TRUST_SCORE_SLOT_OWNED_FIELDS = new Set([
    "enabled",
    "trustScoreId",
    "trustScoreDisabledTools",
    "trustScoreToolOverrides",
    "followSources",
    "updateProfilePicActivatePctMin",
    "updateProfilePicActivatePctMax",
    "updateProfilePicFolderPath",
    "updateProfilePicAlterationEnabled",
    "updateProfilePicAlterationLevel",
    "updateProfilePicImageSettingsEnabled",
    "updateProfilePicImageSettings",
    "updateProfilePicFixAiSlop",
    "updateProfilePicMetadataCleanup",
    "updateProfilePicFrequencyDisruption",
    "updateBioActivatePctMin",
    "updateBioActivatePctMax",
    "updateBioText",
    // Disable-after-use behavior is owned by the Trust Score template, not
    // by an individual physical phone/account slot.
    "makePostLocalFolderEnabled",
    "makePostLocalFolderPath",
    "makePostAddLocation",
    "makePostAlterationEnabled",
    "makePostAlterationLevel",
    "makePostImageSettingsEnabled",
    "makePostImageSettings",
    "makePostFixAiSlop",
    "makePostMetadataCleanup",
    "makePostFrequencyDisruption",
    "postStoryAddLink",
    "postStoryLinkUrl",
    // Follow Filters are owned by the Human Session Tool slot, not inherited
    // from the assigned TrustScore template.
    "followFiltersEnabled",
    "followFilterPrivateUsers",
    "followFilterEnglishSpeaking",
    "followFilterMinFollowers50",
    "followFilterVerifiedUsers",
    "followFilterMaxFollowers25k",
    "followFilterMalesOnly",
    "followFilterMaleNames",
  ]);
  const TRUST_SCORE_TEMPLATE_LOCKED_FIELDS = new Set(
    [...TRUST_SCORE_SLOT_OWNED_FIELDS].filter(field => ![
      "injectBrowsingEnabled",
      "followFiltersEnabled",
      "followFilterPrivateUsers",
      "followFilterEnglishSpeaking",
      "followFilterMinFollowers50",
      "followFilterVerifiedUsers",
      "followFilterMaxFollowers25k",
      "updateProfilePicDisableAfterUsed",
      "updateBioDisableAfterUsed",
    ].includes(field)),
  );
  // These values are controlled by the TrustScore template and must survive
  // the physical-slot exclusion cleanup above.
  const TRUST_SCORE_TEMPLATE_VALUE_FIELDS = new Set([
    "preSwitchEnabledMin",
    "preSwitchEnabledMax",
    "preSwitchActionPercentMin",
    "preSwitchActionPercentMax",
  ]);
  const COPYABLE_ACCOUNT_SPECIFIC_FIELDS = new Set([
    "followSources",
    "followFiltersEnabled",
    "followFilterPrivateUsers",
    "followFilterEnglishSpeaking",
    "followFilterMinFollowers50",
    "followFilterVerifiedUsers",
    "followFilterMaxFollowers25k",
    "followFilterMalesOnly",
    "followFilterMaleNames",
    "updateProfilePicActivatePctMin",
    "updateProfilePicActivatePctMax",
    "updateProfilePicFolderPath",
    "updateProfilePicAlterationEnabled",
    "updateProfilePicAlterationLevel",
    "updateProfilePicImageSettingsEnabled",
    "updateProfilePicImageSettings",
    "updateProfilePicFixAiSlop",
    "updateProfilePicMetadataCleanup",
    "updateProfilePicFrequencyDisruption",
    "updateBioActivatePctMin",
    "updateBioActivatePctMax",
    "updateBioText",
    "makePostLocalFolderPath",
    "makePostAddLocation",
    "makePostAlterationEnabled",
    "makePostAlterationLevel",
    "makePostImageSettingsEnabled",
    "makePostImageSettings",
    "postStoryLinkUrl",
     "makePostFixAiSlop",
     "makePostMetadataCleanup",
     "makePostFrequencyDisruption",
  ]);
  const TRUST_SCORE_TOOL_FIELDS = new Set([
    "feedEnabled",
    "storiesEnabled",
    "viewExploreEnabled",
    "viewReelsEnabled",
    "checkDmEnabled",
    "followEnabled",
    "randomJitterEnabled",
    "makePostEnabled",
    "postStoryEnabled",
  ]);
  // Follow Filters are configured per Human Session Tool slot. They remain
  // visible/editable in TrustScore settings for compatibility, but TrustScore
  // template values must never replace the HST values used at execution time.
  const FOLLOW_FILTER_FIELDS = new Set([
    "followFiltersEnabled",
    "followFilterPrivateUsers",
    "followFilterEnglishSpeaking",
    "followFilterMinFollowers50",
    "followFilterVerifiedUsers",
    "followFilterMaxFollowers25k",
    "followFilterMalesOnly",
    "followFilterMaleNames",
  ]);
  const loadTrustScoreAssignment = async (serial: string, slotIdx: number) => {
    const all = await storage.getGlobalSettings();
    const key = trustScoreAssignmentKey(serial, slotIdx);
    const configured = Object.prototype.hasOwnProperty.call(all, key);
    const legacyKey = legacyTrustScoreAssignmentKey(serial, slotIdx);
    const legacyConfigured = Object.prototype.hasOwnProperty.call(all, legacyKey);
    let scoreId: string | null = null;
    if (configured || legacyConfigured) {
      try {
        const parsed = JSON.parse(all[configured ? key : legacyKey]);
        scoreId = typeof parsed === "string" && parsed.length > 0 ? parsed : null;
      } catch {
        scoreId = null;
      }
    }
    // Migrate the value asynchronously without making the settings read wait.
    if (!configured && legacyConfigured) {
      void storage.setGlobalSetting(key, all[legacyKey]);
    }
    return { all: configured ? all : { ...all, [key]: legacyConfigured ? all[legacyKey] : "" }, configured: configured || legacyConfigured, scoreId };
  };

  const resolveTrustScoreSettings = async (
    serial: string,
    slotIdx: number,
    base: Record<string, any>,
  ): Promise<{ settings: Record<string, any>; scoreId: string | null; configured: boolean }> => {
    const { all, configured, scoreId } = await loadTrustScoreAssignment(serial, slotIdx);
    if (!scoreId) return { settings: base, scoreId: null, configured };

    let template: Record<string, any> = {};
    const raw = all[trustScoreAutomationKey(scoreId)];
    if (raw) {
      try {
        const rawTemplate = JSON.parse(raw);
        template = automationSchema.parse({
          ...trustScoreAutomationDefaults(),
          ...rawTemplate,
        });
        // Preserve TrustScore-owned pre-switch values explicitly. These are
        // present in the stored template but can be omitted by the large
        // automation schema's effective-settings projection.
        for (const field of [
          "preSwitchEnabledMin",
          "preSwitchEnabledMax",
          "preSwitchActionPercentMin",
          "preSwitchActionPercentMax",
        ] as const) {
          const value = rawTemplate?.[field];
          if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
            template[field] = value;
          }
        }
      } catch {
        template = {};
      }
    }

    const disabledTools = Array.isArray(base.trustScoreDisabledTools)
      ? base.trustScoreDisabledTools.filter((key: unknown): key is string => typeof key === "string")
      : [];
    const toolOverrides = base.trustScoreToolOverrides &&
      typeof base.trustScoreToolOverrides === "object"
      ? base.trustScoreToolOverrides as Record<string, boolean>
      : {};
    const effective = { ...base };
    const templateDisabledTools = [...TRUST_SCORE_TOOL_FIELDS].filter(
      field => template[field] === false,
    );
    for (const [field, value] of Object.entries(template)) {
      if (FOLLOW_FILTER_FIELDS.has(field)) continue;
      if (TRUST_SCORE_SLOT_OWNED_FIELDS.has(field)) continue;
      if (TRUST_SCORE_TOOL_FIELDS.has(field) && templateDisabledTools.includes(field)) {
        effective[field] = false;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(toolOverrides, field)) continue;
      if (TRUST_SCORE_TOOL_FIELDS.has(field) && disabledTools.includes(field)) continue;
      effective[field] = value;
    }
    for (const field of TRUST_SCORE_TOOL_FIELDS) {
      if (templateDisabledTools.includes(field)) {
        effective[field] = false;
      } else if (Object.prototype.hasOwnProperty.call(toolOverrides, field)) {
        effective[field] = Boolean(toolOverrides[field]);
      } else if (disabledTools.includes(field)) {
        effective[field] = false;
      }
    }
    effective.trustScoreId = scoreId;
    effective.trustScoreDisabledTools = disabledTools;
    effective.trustScoreTemplateDisabledTools = templateDisabledTools;
    effective.trustScoreToolOverrides = toolOverrides;
    return { settings: effective, scoreId, configured };
  };

  // ── Startup auto-restart helper ──────────────────────────────────────────────
  // Returns every {serial, slotIdx} pair that has enabled:true in the persisted
  // config.  The frontend calls this once on mount and calls startHstLoop for
  // each entry — recovering all HST timers after an app restart without
  // requiring the user to manually toggle each slot off and on.
  app.get("/api/mobile/enabled-hst-slots", (_req: Request, res: Response) => {
    try {
      const cfg = loadInstanceConfigs();
      const slots: { serial: string; slotIdx: number }[] = [];
      for (const [serial, deviceCfg] of Object.entries(cfg)) {
        const slotAuto = (deviceCfg as InstanceConfig).slotAutomation ?? {};
        for (const [idxStr, settings] of Object.entries(slotAuto)) {
          if ((settings as AutomationSettings).enabled) {
            slots.push({ serial, slotIdx: parseInt(idxStr, 10) });
          }
        }
      }
      res.json({ slots });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load enabled slots" });
    }
  });

  app.delete("/api/mobile/surplus/scope", async (req: Request, res: Response) => {
    const serial = String(req.body?.serial ?? "").trim();
    const scope = req.body?.scope;
    const slotIdx = Number(req.body?.slotIdx);
    if (!scope || (scope !== "slot" && scope !== "device" && scope !== "all")) {
      return void res.status(400).json({ error: "scope must be slot, device, or all" });
    }
    if (scope === "all") {
      await storage.clearAllOverspill();
      return void res.json({ ok: true });
    }
    const cfg = loadInstanceConfigs();
    const slots = cfg[serial]?.account?.slots ?? [];
    const indexes = scope === "slot"
      ? [Number.isInteger(slotIdx) ? slotIdx : -1]
      : slots.map((_slot: any, index: number) => index);
    const usernames = indexes
      .map(index => slots[index]?.username)
      .filter((username): username is string => typeof username === "string" && username.trim().length > 0)
      .map(username => username.replace(/^@/, "").toLowerCase());
    const profiles = await storage.getProfiles();
    const profileIds = profiles
      .filter(profile => usernames.includes(String(profile.username ?? "").replace(/^@/, "").toLowerCase()) ||
        usernames.includes(String((profile as any).accountLabel ?? "").replace(/^@/, "").toLowerCase()))
      .map(profile => profile.id);
    await Promise.all(usernames.map(username => storage.clearOverspillByPhoneSlot(username)));
    await Promise.all(profileIds.map(profileId => storage.clearOverspillByProfile(profileId)));
    res.json({ ok: true });
  });

  // Manual Follow Users target management. These operations are deliberately
  // scoped to a single physical device; they never inspect or modify slots on
  // another phone.
  app.post("/api/mobile/follow-surplus/import", async (req: Request, res: Response) => {
    try {
      const serial = String(req.body?.serial ?? "").trim();
      const slotIdx = Number(req.body?.slotIdx);
      const usernames = Array.isArray(req.body?.usernames)
        ? req.body.usernames.map((v: unknown) => String(v).replace(/^@/, "").trim().toLowerCase())
          .filter((v: string) => /^[a-z0-9._]{2,40}$/i.test(v))
        : [];
      const slots = loadInstanceConfigs()[serial]?.account?.slots ?? [];
      const slotUsername = slots[slotIdx]?.username?.replace(/^@/, "").trim().toLowerCase();
      if (!serial || !slotUsername) return void res.status(400).json({ error: "A valid device and account slot are required" });
      const existing = await storage.getOverspillUsersByPhoneSlot(slotUsername);
      const existingSet = new Set(existing.map(row => row.instagramUsername.toLowerCase()));
      const unique = [...new Set(usernames)].filter(username => !existingSet.has(username));
      await storage.addOverspillUsers(unique.map(username => ({
        profileId: 0,
        phoneSlotKey: slotUsername,
        instagramUsername: username,
        instagramUserId: "",
        sourceValue: "manual import",
        sourceType: "manual",
        scrapedAt: new Date().toISOString(),
      })));
      res.json({ ok: true, imported: unique.length, skipped: usernames.length - unique.length });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Import failed" }); }
  });

  app.post("/api/mobile/follow-surplus/split", async (req: Request, res: Response) => {
    try {
      const serial = String(req.body?.serial ?? "").trim();
      const slots = (loadInstanceConfigs()[serial]?.account?.slots ?? [])
        .map((slot: any) => String(slot?.username ?? "").replace(/^@/, "").trim().toLowerCase())
        .filter((username: string) => username.length > 0);
      if (!serial || slots.length === 0) return void res.status(400).json({ error: "No account slots found for this device" });
      const rows = (await Promise.all(slots.map(username => storage.getOverspillUsersByPhoneSlot(username)))).flat();
      const users = [...new Map(rows.map(row => [row.instagramUsername.toLowerCase(), row])).values()];
      await Promise.all(slots.map(username => storage.clearOverspillByPhoneSlot(username)));
      const now = new Date().toISOString();
      await storage.addOverspillUsers(users.map((row, index) => ({
        profileId: 0,
        phoneSlotKey: slots[index % slots.length],
        instagramUsername: row.instagramUsername,
        instagramUserId: row.instagramUserId ?? "",
        sourceValue: row.sourceValue || "split",
        sourceType: row.sourceType || "manual",
        scrapedAt: now,
      })));
      res.json({ ok: true, users: users.length, slots: slots.length });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Split failed" }); }
  });

  // ── Per-slot Human Session Tool automation settings ─────────────────────────
  // Each Instagram account slot stores its own independent copy of all
  // automation settings. Settings are keyed by slot index in slotAutomation.
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/automation-state", (req: Request, res: Response) => {
    try {
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      const saved = cfg[serial]?.slotAutomation?.[slotAutomationKey(serial, slotIdx)]
        ?? cfg[serial]?.slotAutomation?.[String(slotIdx)]
        ?? {};
      res.json({ enabled: saved.enabled === true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to load slot state" });
    }
  });
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/automation-settings", async (req: Request, res: Response) => {
    try {
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
      const cfg = loadInstanceConfigs();
      const serial = p(req, "serial");
      const defaults: AutomationSettings = {
        enabled: false, cycleIntervalMin: 20, cycleIntervalMax: 30,
        feedEnabled: true, storiesEnabled: true,
        actionDelayMin: 5, actionDelayMax: 10,
        likePercentMin: 3, likePercentMax: 5,
        shareFeedPercentMin: 0, shareFeedPercentMax: 0,
        shareDmPercentMin: 0, shareDmPercentMax: 0,
        savePercentMin: 0, savePercentMax: 0,
        expandCaptionPercentMin: 0, expandCaptionPercentMax: 0,
        tapAudioPercentMin: 0, tapAudioPercentMax: 0,
        clickHashtagPercentMin: 0, clickHashtagPercentMax: 0,
        clickAuthorPercentMin: 0, clickAuthorPercentMax: 0,
        feedRerunChanceMin: 0, feedRerunChanceMax: 0,
        feedScrollMin: 5, feedScrollMax: 10,
        viewStoriesSlidesMin: 0, viewStoriesSlidesMax: 0,
        viewStoriesSlideWatchPctMin: 50, viewStoriesSlideWatchPctMax: 90,
        viewStoriesLikePercentMin: 0, viewStoriesLikePercentMax: 0,
        viewStoriesShareDmPercentMin: 0, viewStoriesShareDmPercentMax: 0,
        viewStoriesCommentPercentMin: 0, viewStoriesCommentPercentMax: 0,
        viewStoriesClickAuthorPercentMin: 0, viewStoriesClickAuthorPercentMax: 0,
        viewReelsEnabled: false, viewReelsScrollMin: 0, viewReelsScrollMax: 0,
        viewReelsLikePercentMin: 0, viewReelsLikePercentMax: 0,
        viewReelsShareFeedPercentMin: 0, viewReelsShareFeedPercentMax: 0,
        viewReelsShareDmPercentMin: 0, viewReelsShareDmPercentMax: 0,
        viewReelsSavePercentMin: 0, viewReelsSavePercentMax: 0,
        viewReelsActivatePctMin: 100, viewReelsActivatePctMax: 100,
        viewReelsWatchPctMin: 30, viewReelsWatchPctMax: 70,
        viewReelsClickAuthorPercentMin: 0, viewReelsClickAuthorPercentMax: 0,
        viewExploreEnabled: false, viewExploreActivatePctMin: 100, viewExploreActivatePctMax: 100,
        viewExploreScrollMin: 0, viewExploreScrollMax: 0,
        viewExploreActionDelayMin: 3, viewExploreActionDelayMax: 6,
        viewExploreClickPostPctMin: 0, viewExploreClickPostPctMax: 0,
        viewExploreLikePercentMin: 0, viewExploreLikePercentMax: 0,
        viewExploreShareFeedPercentMin: 0, viewExploreShareFeedPercentMax: 0,
        viewExploreShareDmPercentMin: 0, viewExploreShareDmPercentMax: 0,
        viewExploreSavePercentMin: 0, viewExploreSavePercentMax: 0,
        viewExploreClickAuthorPercentMin: 0, viewExploreClickAuthorPercentMax: 0,
        followEnabled: false, followUsersMin: 1, followUsersMax: 3, followSpreadFollows: false, followSources: [],
        injectBrowsingEnabled: false,
        injectBrowsingActivatePctMin: 0, injectBrowsingActivatePctMax: 0,
        injectBrowsingBeforeFollowPctMin: 0, injectBrowsingBeforeFollowPctMax: 0,
        injectBrowsingFeedMin: 3, injectBrowsingFeedMax: 6,
        injectBrowsingClickPostPctMin: 0, injectBrowsingClickPostPctMax: 0,
        injectBrowsingLikePctMin: 0, injectBrowsingLikePctMax: 0,
        injectBrowsingShareFeedPctMin: 0, injectBrowsingShareFeedPctMax: 0,
        injectBrowsingShareDmPctMin: 0, injectBrowsingShareDmPctMax: 0,
        injectBrowsingSavePostPctMin: 0, injectBrowsingSavePostPctMax: 0,
        injectBrowsingAbandonFollowPctMin: 0, injectBrowsingAbandonFollowPctMax: 0,
        injectBrowsingTapHighlightsPctMin: 0, injectBrowsingTapHighlightsPctMax: 0,
        followFiltersEnabled: false,
        followFilterPrivateUsers: false,
        followFilterEnglishSpeaking: false,
        followFilterMinFollowers50: false,
        followFilterVerifiedUsers: false,
        followFilterMaxFollowers25k: false,
    followFilterMalesOnly: false,
    followFilterMaleNames: "",
        randomJitterEnabled: false,
        checkNotificationsPctMin: 0, checkNotificationsPctMax: 0,
        checkNotificationsScrollsMin: 2, checkNotificationsScrollsMax: 5,
        checkNotificationsClickPctMin: 0, checkNotificationsClickPctMax: 0,
        visitProfilePctMin: 0, visitProfilePctMax: 0,
        visitSavedPctMin: 0, visitSavedPctMax: 0,
        visitSettingsPctMin: 0, visitSettingsPctMax: 0,
        appSwitchPctMin: 0, appSwitchPctMax: 0,
        updateProfilePicActivatePctMin: 0, updateProfilePicActivatePctMax: 0,
        updateProfilePicFolderPath: "", updateProfilePicDisableAfterUsed: false,
        updateProfilePicAlterationEnabled: true, updateProfilePicAlterationLevel: "small",
        updateProfilePicImageSettingsEnabled: true,
        updateProfilePicImageSettings: {
          contrast: { enabled: true, min: 5, max: 250 },
          brightness: { enabled: true, min: 5, max: 250 },
          noise: { enabled: true, min: 5, max: 15 },
          sharpen: { enabled: true, min: 1.0, max: 2.0 },
          pixelate: { enabled: true, min: 0.9, max: 2.1 },
        },
        updateBioActivatePctMin: 0, updateBioActivatePctMax: 0,
        updateBioText: "", updateBioDisableAfterUsed: false,
        checkDmEnabled: false,
        checkDmActivatePctMin: 100, checkDmActivatePctMax: 100,
        checkDmScrollMin: 1, checkDmScrollMax: 3,
        checkDmClickPctMin: 0, checkDmClickPctMax: 0,
        feedActivatePctMin: 100, feedActivatePctMax: 100,
        viewStoriesActivatePctMin: 100, viewStoriesActivatePctMax: 100,
        followActivatePctMin: 100, followActivatePctMax: 100,
        randomJitterActivatePctMin: 100, randomJitterActivatePctMax: 100,
        makePostEnabled: false,
        makePostActivatePctMin: 100, makePostActivatePctMax: 100,
        makePostPerSessionMin: 1, makePostPerSessionMax: 1,
        makePostAlterationEnabled: true, makePostAlterationLevel: "small",
        makePostImageSettingsEnabled: true,
        makePostDisableWhenExhausted: true,
        makePostLocalFolderEnabled: true, makePostLocalFolderPath: "",
        makePostLocalFolderNoRepeat: false, makePostLocalFolderRandom: false,
        makePostLocalFolderDeleteAfterUpload: false,
        makePostUseChatGpt: false, makePostFixAiSlop: true,
        makePostPostToProfilePctMin: 100, makePostPostToProfilePctMax: 100,
        makePostPostToStoryPctMin: 0, makePostPostToStoryPctMax: 0,
        makePostCaptionText: "",
        makePostImageSettings: {
          contrast: { enabled: true, min: 5, max: 250 },
          brightness: { enabled: true, min: 5, max: 250 },
          noise: { enabled: true, min: 5, max: 15 },
          sharpen: { enabled: true, min: 1.0, max: 2.0 },
          pixelate: { enabled: true, min: 0.9, max: 2.1 },
        },
        postStoryEnabled: false,
        postStoryActivatePctMin: 100, postStoryActivatePctMax: 100,
        postStoryLocalFolderPath: "",
        postStoryLocalFolderNoRepeat: false, postStoryLocalFolderRandom: false,
        postStoryAlterationEnabled: true, postStoryAlterationLevel: "small",
        postStoryImageSettingsEnabled: true,
        postStoryImageSettings: {
          contrast: { enabled: true, min: 5, max: 250 },
          brightness: { enabled: true, min: 5, max: 250 },
          noise: { enabled: true, min: 5, max: 15 },
          sharpen: { enabled: true, min: 1.0, max: 2.0 },
          pixelate: { enabled: true, min: 0.9, max: 2.1 },
        },
        postStoryFixAiSlop: false,
        postStoryAddLink: false, postStoryLinkUrl: "",
        dismissDirection: "auto" as const,
      };
      const saved = cfg[serial]?.slotAutomation?.[slotAutomationKey(serial, slotIdx)]
        ?? cfg[serial]?.slotAutomation?.[String(slotIdx)];
      const merged: Record<string, any> = {
        ...defaults,
        ...saved,
        // The background HST runner is mounted outside MobilePage and cannot
        // read the Account Settings panel's React state.  Include the
        // persisted account identity in the per-slot response so a restart
        // preserves both slotIdx and slotUsername in cycle/dashboard events.
        slotUsername: cfg[serial]?.account?.slots?.[slotIdx]?.username ?? "",
      };
      // The dedicated folder-path file is the authoritative source for
      // makePostLocalFolderPath.  It is written directly when the user assigns
      // a folder, so it survives Copy Settings, schema drift, and any autosave
      // race that could overwrite mobile-instances.json with a stale "".
      const dedicatedFolderPath = getMakePostFolderPath(serial, slotIdx);
      if (dedicatedFolderPath) merged.makePostLocalFolderPath = dedicatedFolderPath;
      const dedicatedStoryFolderPath = getPostStoryFolderPath(serial, slotIdx);
      if (dedicatedStoryFolderPath) merged.postStoryLocalFolderPath = dedicatedStoryFolderPath;
      const dedicatedProfilePicPath = getProfilePicFolderPath(serial, slotIdx);
      if (dedicatedProfilePicPath) merged.updateProfilePicFolderPath = dedicatedProfilePicPath;
      const resolved = await resolveTrustScoreSettings(serial, slotIdx, merged);
      // My Computer is the implicit and always-enabled Make a Post source.
      resolved.settings.makePostLocalFolderEnabled = true;
      logger.info(`[TOGGLE-DBG] GET slot settings  serial=${serial} slotIdx=${slotIdx} enabled=${resolved.settings.enabled} trustScore=${resolved.scoreId ?? "manual"}`);
      res.json({
        ...resolved.settings,
        trustScoreId: resolved.scoreId,
        trustScoreConfigured: resolved.configured,
        trustScoreControlledFields: resolved.scoreId
          ? Object.keys(resolved.settings).filter(field => !TRUST_SCORE_SLOT_OWNED_FIELDS.has(field))
          : [],
        trustScoreTemplateDisabledTools: resolved.settings.trustScoreTemplateDisabledTools ?? [],
      });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to load slot automation settings" }); }
  });
  app.post("/api/mobile/devices/:serial/slots/:slotIdx/automation-settings", async (req: Request, res: Response) => {
    try {
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      // Load whatever is already saved for this slot.  For Copy Settings the
      // client only sends the selected fields, so we must merge the partial
      // payload on top of the existing values — not replace everything.
      // Also provide hard-coded fallbacks for the few schema fields that have
      // no zod .default() so a brand-new slot never fails validation.
      const stableKey = slotAutomationKey(serial, slotIdx);
      const existing = cfg[serial]?.slotAutomation?.[stableKey]
        ?? cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
      const base: Record<string, any> = {
        actionDelayMin: 5, actionDelayMax: 10,
        likePercentMin: 3, likePercentMax: 5,
        feedScrollMin:  5, feedScrollMax:  10,
        ...existing,
      };
      // Never let an empty string from the client overwrite a saved folder
      // path.  The frontend's autosave fires every ~500 ms and may send "" if
      // React state was stale at the moment of capture (hydration glitch,
      // settings loaded before the dedicated file was ready, Copy Settings
      // wipe, etc.).  Stripping the empty value here means the existing saved
      // path in `base` (from mobile-instances.json) is preserved instead.
      const body = { ...req.body };
      if (body.makePostLocalFolderPath === "") delete body.makePostLocalFolderPath;
      if (body.postStoryLocalFolderPath === "") delete body.postStoryLocalFolderPath;
      const assignment = await loadTrustScoreAssignment(serial, slotIdx);
      // Never let a full effective-settings response write template values
      // back into the slot's manual baseline. Feature switches are represented
      // by trustScoreDisabledTools instead.
      if (assignment.scoreId) {
        const isTrustScoreCopy = body.trustScoreCopy === true;
        const toolOverrides = {
          ...(base.trustScoreToolOverrides ?? {}),
          ...(isTrustScoreCopy ? {} : Object.fromEntries(
            [...TRUST_SCORE_TOOL_FIELDS]
              .filter(field => typeof body[field] === "boolean")
              .map(field => [field, body[field]]),
          )),
        };
        body.trustScoreToolOverrides = toolOverrides;
        for (const field of Object.keys(body)) {
          const allowedForRequest = isTrustScoreCopy
            ? COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)
            : TRUST_SCORE_SLOT_OWNED_FIELDS.has(field) || field.startsWith("trustScore");
          if (
            field !== "trustScoreCopy" &&
            !allowedForRequest
          ) delete body[field];
        }
        delete body.trustScoreCopy;
      } else if (body.trustScoreCopy === true) {
        for (const field of Object.keys(body)) {
          if (
            field !== "trustScoreCopy" &&
            !COPYABLE_ACCOUNT_SPECIFIC_FIELDS.has(field)
          ) delete body[field];
        }
        delete body.trustScoreCopy;
      }
      const input = automationSchema.parse({ ...base, ...body });
      // Ignore legacy false values from old UI/settings payloads.
      input.makePostLocalFolderEnabled = true;
      logger.info(`[TOGGLE-DBG] POST slot settings serial=${serial} slotIdx=${slotIdx} enabled=${input.enabled} (all slots after save: ${JSON.stringify(Object.entries({ ...cfg[serial]?.slotAutomation, [String(slotIdx)]: input }).map(([k,v]: [string,any]) => ({ slot: k, enabled: v?.enabled })))})`);
      cfg[serial] = {
        ...cfg[serial],
        slotAutomation: { ...cfg[serial]?.slotAutomation, [stableKey]: input },
      };
      saveInstanceConfigs(cfg);
      // Mirror the folder path into the dedicated file whenever it arrives
      // non-empty.  The explicit /folder-path endpoint does this too, but the
      // autosave (which fires every 500 ms after any settings change) hits
      // THIS endpoint — not /folder-path.  If the /folder-path fetch ever
      // fails silently, the autosave is the only other write path, and without
      // this line the dedicated file would never be created.  Writing here
      // means every successful autosave is also a dedicated-file write, giving
      // the path two independent stores that must BOTH be empty before it can
      // be lost on restart.
      if (input.makePostLocalFolderPath) {
        setMakePostFolderPath(serial, slotIdx, input.makePostLocalFolderPath);
      }
      if (input.postStoryLocalFolderPath) {
        setPostStoryFolderPath(serial, slotIdx, input.postStoryLocalFolderPath);
      }
      if (input.updateProfilePicFolderPath) {
        setProfilePicFolderPath(serial, slotIdx, input.updateProfilePicFolderPath);
      }
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save slot automation settings" }); }
  });

  // ── Trust Score template Human Session Tool settings ───────────────────────
  // Trust Score tiers use the same mobile-engine settings UI as Phone Farm, but
  // they are templates rather than physical devices/slots. Keep their
  // configuration in global settings so editing a tier never requires a
  // connected phone and never starts a live automation cycle.
  app.get("/api/trust-score-templates/:trustScoreId/mobile-settings", async (req: Request, res: Response) => {
    try {
      const trustScoreId = trustScoreIdSchema.parse(p(req, "trustScoreId"));
      const all = await storage.getGlobalSettings();
      const savedRaw = all[trustScoreAutomationKey(trustScoreId)];
      const saved = savedRaw ? JSON.parse(savedRaw) : {};
      const settings = { ...trustScoreAutomationDefaults(), ...saved };
      for (const field of TRUST_SCORE_TEMPLATE_LOCKED_FIELDS) {
        if (!TRUST_SCORE_TEMPLATE_VALUE_FIELDS.has(field)) delete settings[field];
      }
      res.json(settings);
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to load Trust Score settings" });
    }
  });

  app.post("/api/trust-score-templates/:trustScoreId/mobile-settings", async (req: Request, res: Response) => {
    try {
      const trustScoreId = trustScoreIdSchema.parse(p(req, "trustScoreId"));
      // A template never owns physical-slot values. The editor sends a full
      // effective-settings-shaped object, so strip excluded fields at the
      // persistence boundary instead of allowing them to become part of the
      // template by accident.
      const body = { ...req.body };
      for (const field of TRUST_SCORE_TEMPLATE_LOCKED_FIELDS) {
        if (!TRUST_SCORE_TEMPLATE_VALUE_FIELDS.has(field)) delete body[field];
      }
      // Autosaves can arrive with a partial/effective settings object while
      // another control is still settling. Merge the existing template first
      // so a missing pre-switch field can never be replaced by schema default 0.
      const all = await storage.getGlobalSettings();
      const existingRaw = all[trustScoreAutomationKey(trustScoreId)];
      let existing: Record<string, unknown> = {};
      if (existingRaw) {
        try {
          const parsed = JSON.parse(existingRaw);
          if (parsed && typeof parsed === "object") existing = parsed;
        } catch {}
      }
      const input = automationSchema.parse({ ...existing, ...body });
      for (const field of [
        "preSwitchEnabledMin",
        "preSwitchEnabledMax",
        "preSwitchActionPercentMin",
        "preSwitchActionPercentMax",
      ] as const) {
        const value = body[field];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100) {
          input[field] = value;
        }
      }
      for (const field of TRUST_SCORE_TEMPLATE_LOCKED_FIELDS) {
        if (!TRUST_SCORE_TEMPLATE_VALUE_FIELDS.has(field)) delete input[field];
      }
      await storage.setGlobalSetting(
        trustScoreAutomationKey(trustScoreId),
        JSON.stringify(input),
      );
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to save Trust Score settings" });
    }
  });

  // TrustScore durations are deliberately separate from Human Session Tool
  // settings. They are configured once per badge and used by physical slots
  // assigned to that badge. Missing/blank durations remain timer-free.
  app.get("/api/trust-scores/durations", async (_req: Request, res: Response) => {
    try {
      const all = await storage.getGlobalSettings();
      const durations: Record<string, number> = {};
      const prefix = "trust_score_duration_hours_";
      for (const [key, raw] of Object.entries(all)) {
        if (!key.startsWith(prefix)) continue;
        const hours = Number(raw);
        if (Number.isInteger(hours) && hours >= 1 && hours <= 999) {
          durations[key.slice(prefix.length)] = hours;
        }
      }
      res.json({ durations });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load TrustScore durations" });
    }
  });

  app.post("/api/trust-scores/:trustScoreId/duration", async (req: Request, res: Response) => {
    try {
      const trustScoreId = trustScoreIdSchema.parse(p(req, "trustScoreId"));
      const body = z.object({
        hours: z.number().int().min(1).max(999).nullable(),
        hasNextScore: z.boolean().default(true),
      }).parse(req.body);
      const key = trustScoreDurationKey(trustScoreId);
      const all = await storage.getGlobalSettings();
      if (body.hours === null) {
        await storage.setGlobalSetting(key, "");
      } else {
        await storage.setGlobalSetting(key, String(body.hours));
      }

      // Adding a duration after a badge is already assigned must initialize
      // that slot immediately. Clearing a duration removes its running timer.
      const assignmentPrefix = "mobile_trust_score_";
      const instanceConfigs = loadInstanceConfigs();
      for (const [assignmentKey, rawScore] of Object.entries(all)) {
        if (
          !assignmentKey.startsWith(assignmentPrefix) ||
          assignmentKey.startsWith("mobile_trust_score_timer_") ||
          rawScore !== JSON.stringify(trustScoreId)
        ) continue;
        let serial: string | null = null;
        let slotIdx = -1;
        for (const [candidateSerial, candidateConfig] of Object.entries(instanceConfigs)) {
          const candidateIdx = candidateConfig.account?.slots?.findIndex((slot: any) =>
            assignmentKey === `mobile_trust_score_${candidateSerial}_${slot?.slotId}` ||
            assignmentKey === `mobile_trust_score_${candidateSerial}_${candidateConfig.account?.slots?.indexOf(slot)}`,
          ) ?? -1;
          if (candidateIdx >= 0) {
            serial = candidateSerial;
            slotIdx = candidateIdx;
            break;
          }
        }
        if (!serial) continue;
        if (!Number.isInteger(slotIdx) || slotIdx < 0) continue;
        if (body.hours === null || !body.hasNextScore) {
          await clearTrustScoreTimer(serial, slotIdx);
          continue;
        }
        const existing = readTrustScoreTimer(all, serial, slotIdx);
        if (!existing || existing.durationHours !== body.hours) {
          await writeTrustScoreTimer(serial, slotIdx, {
            scoreId: trustScoreId,
            durationHours: body.hours,
            startedAt: Date.now(),
            remainingMs: null,
            paused: false,
          });
        }
      }
      res.json({ ok: true, hours: body.hours });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to save TrustScore duration" });
    }
  });

  // ── Per-device prefs (hardware-level, not per-slot) ────────────────────────
  // Stored separately from automation settings so they can never be
  // accidentally overwritten by an autosave of the automation panel.
  app.get("/api/mobile/devices/:serial/device-prefs", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    res.json(cfg[p(req, "serial")]?.devicePrefs ?? {});
  });
  app.post("/api/mobile/devices/:serial/device-prefs", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const allowed = z.object({
        dismissDirection: z.enum(["auto", "left", "up"]).optional(),
        motherCodeOverrides: z.object({
          globalDwell: z.object({ minMs: z.number().finite().min(0), maxMs: z.number().finite().min(0) }).optional(),
          accountSwitching: z.object({ minMs: z.number().finite().min(0), maxMs: z.number().finite().min(0) }).optional(),
          navigation: z.object({ minMs: z.number().finite().min(0), maxMs: z.number().finite().min(0) }).optional(),
          actionPacing: z.object({ minMs: z.number().finite().min(0), maxMs: z.number().finite().min(0) }).optional(),
          perTool: z.record(z.string(), z.object({ minMs: z.number().finite().min(0), maxMs: z.number().finite().min(0) })).optional(),
        }).optional(),
        swipePersonalityOverrides: z.record(z.string(), z.object({
          weightMin: z.number().finite().min(0).max(1000),
          weightMax: z.number().finite().min(0).max(1000),
          durationMinMs: z.number().finite().min(1).max(30000),
          durationMaxMs: z.number().finite().min(1).max(30000),
        })).optional(),
        typingSpeedProfile: z.object({
          minMs: z.number().finite().min(0),
          maxMs: z.number().finite().min(0),
          errorPercentMin: z.number().finite().min(0).max(100),
          errorPercentMax: z.number().finite().min(0).max(100),
          dwellMinMs: z.number().finite().min(1),
          dwellMaxMs: z.number().finite().min(1),
          hesitationMinMs: z.number().finite().min(0),
          hesitationMaxMs: z.number().finite().min(0),
        }).optional(),
        swipeGesture: z.object({
          x1: z.number().finite(),
          y1: z.number().finite(),
          x2: z.number().finite(),
          y2: z.number().finite(),
          durationMinMs: z.number().finite(),
          durationMaxMs: z.number().finite().max(150),
          jitterX: z.number().finite(),
          jitterY: z.number().finite(),
          startJitterMinY: z.number().finite().optional(),
          startJitterMaxY: z.number().finite().optional(),
          pauseMinMs: z.number().finite().min(0).optional(),
          pauseMaxMs: z.number().finite().min(0).optional(),
          settleMinMs: z.number().finite().min(0).optional(),
          settleMaxMs: z.number().finite().min(0).optional(),
        }).optional(),
      }).parse(req.body);
      const cfg = loadInstanceConfigs();
      cfg[serial] = {
        ...cfg[serial],
        devicePrefs: {
          ...cfg[serial]?.devicePrefs,
          ...allowed,
          ...(allowed.swipeGesture
            ? { swipeGesture: { ...allowed.swipeGesture, durationMaxMs: Math.min(150, allowed.swipeGesture.durationMaxMs) } }
            : {}),
        },
      };
      saveInstanceConfigs(cfg);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/test-swipe-gesture", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const prefs = loadInstanceConfigs()[serial]?.devicePrefs;
      const gesture = prefs?.swipeGesture;
      if (!gesture) { res.status(400).json({ error: "No swipe gesture is configured for this device" }); return; }
      const jitterX = gesture.jitterX ?? 0;
      const jitterY = gesture.jitterY ?? 0;
    const startJitterMinY = Math.max(0, Math.min(gesture.startJitterMinY ?? 0, gesture.startJitterMaxY ?? 0));
    const startJitterMaxY = Math.max(startJitterMinY, gesture.startJitterMaxY ?? startJitterMinY);
      const size = android.getScreenSize(serial);
      const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(v)));
      // Keep the device's calibrated path, but avoid replaying the exact same
      // landing coordinates on every test. The caller supplies the previewed
      // jittered path so the phone and preview execute the same gesture.
      const incoming = z.object({
        path: z.object({ x1: z.number(), y1: z.number(), x2: z.number(), y2: z.number() }).optional(),
      }).parse(req.body ?? {});
      const path = incoming.path
        ? { x1: clamp(incoming.path.x1, size.w), y1: clamp(incoming.path.y1, size.h), x2: clamp(incoming.path.x2, size.w), y2: clamp(incoming.path.y2, size.h) }
        : { x1: clamp(gesture.x1 + Math.round((Math.random() * 2 - 1) * jitterX), size.w), y1: clamp(gesture.y1 + Math.round(startJitterMinY + Math.random() * (startJitterMaxY - startJitterMinY) + Math.random() * 2 - 1), size.h), x2: clamp(gesture.x2 + Math.round((Math.random() * 2 - 1) * jitterX), size.w), y2: clamp(gesture.y2 + Math.round((Math.random() * 2 - 1) * jitterY), size.h) };
      if (!Number.isFinite(gesture.durationMinMs) || !Number.isFinite(gesture.durationMaxMs)) {
        throw new Error("Swipe Gesture Profile duration is invalid");
      }
      const durationMinMs = Math.min(gesture.durationMinMs, gesture.durationMaxMs);
      const durationMaxMs = Math.min(150, Math.max(gesture.durationMinMs, gesture.durationMaxMs));
      const durationMs = durationMinMs + Math.round(Math.random() * (durationMaxMs - durationMinMs));
      // The UI supplies this exact randomized path. Disable the legacy
      // low-level jitter so the coordinates in the response are precisely
      // the coordinates sent to the device.
      await android.swipe(serial, path.x1, path.y1, path.x2, path.y2, durationMs, false);
      res.json({ ok: true, resolution: size, path, sentPath: path, durationMs });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Swipe test failed" }); }
  });

  // ── Per-slot trust score ────────────────────────────────────────────────────
  // Trust scores used to live only in browser localStorage, so navigating away
  // from Phone Farm (or using another browser) made the badge appear to reset.
  // Keep them in the existing SQLite global_settings store, keyed by device and
  // slot. `configured` distinguishes an explicit "clear score" from a first load.
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/trust-score", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const key = trustScoreAssignmentKey(serial, slotIdx);
      const all = await storage.getGlobalSettings();
      const configured = Object.prototype.hasOwnProperty.call(all, key);
      let scoreId: string | null = null;
      if (configured) {
        const parsed = JSON.parse(all[key]);
        scoreId = typeof parsed === "string" ? parsed : null;
      }
      res.json({ configured, scoreId });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load trust score" });
    }
  });

  app.post("/api/mobile/devices/:serial/slots/:slotIdx/trust-score", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const { scoreId, hasNextScore } = z.object({
        scoreId: z.string().min(1).max(100).nullable(),
        hasNextScore: z.boolean().default(true),
      }).parse(req.body);
      const assignmentKey = trustScoreAssignmentKey(serial, slotIdx);
      const all = await storage.getGlobalSettings();
      let previousScoreId: string | null = null;
      try {
        const parsed = JSON.parse(all[assignmentKey] ?? "null");
        previousScoreId = typeof parsed === "string" ? parsed : null;
      } catch {}
      const existingTimer = readTrustScoreTimer(all, serial, slotIdx);
      const now = Date.now();
      await storage.setGlobalSetting(
        assignmentKey,
        JSON.stringify(scoreId),
      );
      if (scoreId === null) {
        if (previousScoreId && existingTimer?.scoreId === previousScoreId) {
          await writeTrustScoreTimer(serial, slotIdx, {
            ...existingTimer,
            remainingMs: trustScoreTimerRemainingMs(existingTimer, now),
            startedAt: null,
            paused: true,
          });
        }
      } else {
        const durationRaw = all[trustScoreDurationKey(scoreId)];
        const durationHours = Number(durationRaw);
        const hasDuration = Number.isInteger(durationHours) && durationHours >= 1 && durationHours <= 999;
        const canRunTimer = hasDuration && hasNextScore;
        const canResume =
          previousScoreId === null &&
          existingTimer?.paused === true &&
          existingTimer.scoreId === scoreId &&
          trustScoreTimerRemainingMs(existingTimer, now) > 0;
        const sameScore = previousScoreId === scoreId && existingTimer?.scoreId === scoreId;
        if (!canRunTimer) {
          await clearTrustScoreTimer(serial, slotIdx);
        } else if (canResume) {
          const remainingMs = trustScoreTimerRemainingMs(existingTimer!, now);
          await writeTrustScoreTimer(serial, slotIdx, {
            scoreId,
            durationHours,
            startedAt: now - (durationHours * 60 * 60 * 1000 - remainingMs),
            remainingMs: null,
            paused: false,
          });
        } else if (sameScore && !existingTimer?.paused) {
          // Re-saving the same assignment must not reset its countdown.
        } else {
          await writeTrustScoreTimer(serial, slotIdx, {
            scoreId,
            durationHours,
            startedAt: now,
            remainingMs: null,
            paused: false,
          });
        }
      }
      res.json({ ok: true, scoreId });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to save trust score" });
    }
  });

  app.get("/api/mobile/devices/:serial/slots/:slotIdx/trust-score-timer", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const all = await storage.getGlobalSettings();
      // Never read numeric index keys here. They can transfer a deleted
      // account's badge to the account that moved into its visible position.
      const assignmentRaw = all[trustScoreAssignmentKey(serial, slotIdx)];
      let scoreId: string | null = null;
      try {
        const parsed = JSON.parse(assignmentRaw ?? "null");
        scoreId = typeof parsed === "string" ? parsed : null;
      } catch {}
      const timer = scoreId ? readTrustScoreTimer(all, serial, slotIdx) : null;
      const configuredDuration = scoreId == null
        ? null
        : Number(all[trustScoreDurationKey(scoreId)]);
      const validConfiguredDuration =
        Number.isInteger(configuredDuration) &&
        configuredDuration >= 1 &&
        configuredDuration <= 999
          ? configuredDuration
          : null;
      // A duration edit must take effect for an already-assigned score. Do not
      // keep serving an old timer (for example 75h) after the settings field
      // has been changed to 50h.
      const reconciledTimer = timer && validConfiguredDuration !== null &&
        timer.durationHours !== validConfiguredDuration
        ? {
            scoreId,
            durationHours: validConfiguredDuration,
            startedAt: Date.now(),
            remainingMs: null,
            paused: false,
          } satisfies TrustScoreTimerState
        : timer;
      if (reconciledTimer && reconciledTimer !== timer) {
        await writeTrustScoreTimer(serial, slotIdx, reconciledTimer);
      }
      if (scoreId && !reconciledTimer) {
        const durationHours = validConfiguredDuration;
        if (Number.isInteger(durationHours) && durationHours >= 1 && durationHours <= 999) {
          await writeTrustScoreTimer(serial, slotIdx, {
            scoreId,
            durationHours,
            startedAt: Date.now(),
            remainingMs: null,
            paused: false,
          });
          res.json({
            scoreId,
            running: true,
            paused: false,
            durationHours,
            expiresAt: Date.now() + durationHours * 60 * 60 * 1000,
            remainingMs: durationHours * 60 * 60 * 1000,
          });
          return;
        }
      }
      if (!scoreId && timer?.paused) {
        const remainingMs = trustScoreTimerRemainingMs(timer);
        res.json({
          scoreId: null,
          paused: true,
          running: false,
          durationHours: timer.durationHours,
          remainingMs,
          expiresAt: null,
        });
        return;
      }
      if (!scoreId || !reconciledTimer) {
        res.json({ scoreId, running: false, paused: false, remainingMs: null, expiresAt: null });
        return;
      }
      const remainingMs = trustScoreTimerRemainingMs(reconciledTimer);
      res.json({
        scoreId,
        running: !reconciledTimer.paused && remainingMs > 0,
        paused: reconciledTimer.paused,
        durationHours: reconciledTimer.durationHours,
        remainingMs,
        expiresAt: reconciledTimer.paused ? null : Date.now() + remainingMs,
      });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to load TrustScore timer" });
    }
  });

  app.post("/api/mobile/devices/:serial/slots/:slotIdx/trust-score-timer/advance", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = parseInt(String(req.params.slotIdx), 10);
      if (isNaN(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const { expectedScoreId, nextScoreId, hasNextScore } = z.object({
        expectedScoreId: z.string().min(1).max(100),
        nextScoreId: z.string().min(1).max(100).nullable(),
        hasNextScore: z.boolean().default(true),
      }).parse(req.body);
      const assignmentKey = trustScoreAssignmentKey(serial, slotIdx);
      const all = await storage.getGlobalSettings();
      let currentScoreId: string | null = null;
      try {
        const parsed = JSON.parse(all[assignmentKey] ?? "null");
        currentScoreId = typeof parsed === "string" ? parsed : null;
      } catch {}
      if (currentScoreId !== expectedScoreId) {
        res.json({ ok: false, scoreId: currentScoreId });
        return;
      }
      if (!nextScoreId) {
        await clearTrustScoreTimer(serial, slotIdx);
        res.json({ ok: true, scoreId: currentScoreId });
        return;
      }
      const durationHours = Number(all[trustScoreDurationKey(nextScoreId)]);
      await storage.setGlobalSetting(assignmentKey, JSON.stringify(nextScoreId));
      const canRunTimer =
        hasNextScore &&
        Number.isInteger(durationHours) &&
        durationHours >= 1 &&
        durationHours <= 999;
      if (canRunTimer) {
        const now = Date.now();
        await writeTrustScoreTimer(serial, slotIdx, {
          scoreId: nextScoreId,
          durationHours,
          startedAt: now,
          remainingMs: null,
          paused: false,
        });
      } else {
        await clearTrustScoreTimer(serial, slotIdx);
      }
      res.json({ ok: true, scoreId: nextScoreId });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to advance TrustScore" });
    }
  });

  // ── Per-device linked Instagram account (Account Settings tab) ──────────────
  const SLOT_COUNT = 1;
  const deviceSlotSchema = z.object({
    // Stable identity: never derive account-owned state from the visible
    // array index because deleting a slot renumbers every later account.
    slotId: z.string().min(8).max(100).optional(),
    username: z.string(),
    password: z.string(),
    totpSecret: z.string().optional(),
    emailAddress: z.string().optional(),
    emailPassword: z.string().optional(),
    phoneNumber: z.string().optional(),
  });
  const deviceAccountSchema = z.object({
    // No upper-bound cap — users can add as many slots as they need via the UI
    slots: z.array(deviceSlotSchema).min(0),
  });
  const emptySlots = (): DeviceSlot[] => Array.from({ length: SLOT_COUNT }, () => ({ username: "", password: "" }));
  const migrateAccount = (raw: any): DeviceAccount => {
    if (raw && Array.isArray(raw.slots)) {
      return {
        ...raw,
        slots: raw.slots.map((slot: any) => ({
          ...slot,
          slotId: typeof slot?.slotId === "string" && slot.slotId.length >= 8
            ? slot.slotId
            : crypto.randomUUID(),
        })),
      } as DeviceAccount;
    }
    // Legacy single-account format → migrate into slot 0
    if (raw && typeof raw.username === "string") {
      const slots = emptySlots();
      slots[0] = { slotId: crypto.randomUUID(), username: raw.username, password: raw.password ?? "", totpSecret: raw.totpSecret };
      return { slots };
    }
    return { slots: emptySlots() };
  };
  app.get("/api/mobile/devices/:serial/account", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const serial = p(req, "serial");
    const raw = cfg[serial]?.account ?? null;
    const migrated = migrateAccount(raw);
    // Persist generated IDs immediately. Otherwise a legacy slot would get
    // a fresh identity on every reload before the UI had a chance to save.
    if (JSON.stringify(raw) !== JSON.stringify(migrated)) {
      cfg[serial] = { ...cfg[serial], account: migrated };
      saveInstanceConfigs(cfg);
    }
    res.json(migrated);
  });
  app.post("/api/mobile/devices/:serial/account", async (req: Request, res: Response) => {
    try {
      const parsed = deviceAccountSchema.parse(req.body);
      const input = {
        ...parsed,
        slots: parsed.slots.map(slot => ({ ...slot, slotId: slot.slotId ?? crypto.randomUUID() })),
      };
      // Previously forced a minimum of SLOT_COUNT (5) slots, padding with
      // empty entries.  That caused deleted slots to silently reappear every
      // time the panel reloaded — the save wrote 2 slots, the pad restored
      // 5, and the UI loaded 5 again.  Now we store exactly what the UI
      // sent so the displayed count always matches what was saved.
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], account: input };
      saveInstanceConfigs(cfg);
      // Account saves are also a state-boundary checkpoint. The UI can save
      // the shortened slot array immediately after deleting a slot, before
      // the separate DELETE request finishes. Purge every slot-owned record
      // whose stable identity is no longer present, so a replacement slot
      // cannot inherit the deleted account's HST toggle/settings or TrustScore.
      const liveAutomationKeys = new Set(
        input.slots.map(slot => `${serial}:${slot.slotId}`),
      );
      const savedAutomation = cfg[serial]?.slotAutomation ?? {};
      const nextAutomation = Object.fromEntries(
        Object.entries(savedAutomation).filter(([key]) =>
          liveAutomationKeys.has(key) ||
          (!/^\d+$/.test(key) && !key.startsWith(`${serial}:`)),
        ),
      );
      cfg[serial] = { ...cfg[serial], slotAutomation: nextAutomation };
      saveInstanceConfigs(cfg);
      const allSettings = await storage.getGlobalSettings();
      const liveTrustPrefixes = new Set(
        input.slots.flatMap(slot => [
          `mobile_trust_score_${serial}_${slot.slotId}`,
          `mobile_trust_score_timer_${serial}_${slot.slotId}`,
        ]),
      );
      await Promise.all(
        Object.keys(allSettings)
          .filter(key =>
            key.startsWith(`mobile_trust_score_${serial}_`) &&
            !liveTrustPrefixes.has(key),
          )
          .map(key => storage.deleteGlobalSetting(key)),
      );
      res.json({ ok: true, account: input });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save the account" }); }
  });

  // Removing a physical farm device is a destructive account-boundary
  // operation.  The serial may be registered again later with completely
  // different accounts, so do not let the old account slots, HST toggles,
  // TrustScore badges, or countdowns follow the replacement accounts.
  app.delete("/api/mobile/devices/:serial/account-state", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const all = await storage.getGlobalSettings();
      const keyPrefixes = [
        `mobile_trust_score_${serial}_`,
        `mobile_trust_score_timer_${serial}_`,
        `mobile_followed_users_${serial}_`,
        `mobile_posted_media_${serial}_`,
        `mobile_posted_profile_media_${serial}_`,
      ];
      await Promise.all(
        Object.keys(all)
          .filter(key => keyPrefixes.some(prefix => key.startsWith(prefix)))
          .map(key => storage.deleteGlobalSetting(key)),
      );

      const cfg = loadInstanceConfigs();
      if (cfg[serial]) {
        const { account: _account, slotAutomation: _slotAutomation, ...deviceConfig } = cfg[serial];
        cfg[serial] = deviceConfig;
        saveInstanceConfigs(cfg);
      }
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to clear device account state" });
    }
  });

  // Deleting an account slot must also delete every slot-owned setting. Slot
  // indexes are reused by the UI, so leaving these keys behind makes a newly
  // added account inherit the previous account's TrustScore/settings.
  app.delete("/api/mobile/devices/:serial/slots/:slotIdx", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = Number.parseInt(String(req.params.slotIdx), 10);
      if (!Number.isInteger(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const all = await storage.getGlobalSettings();
      const cfgBeforeDelete = loadInstanceConfigs();
      const deletedSlot = cfgBeforeDelete[serial]?.account?.slots?.[slotIdx];
      const deletedSlotId =
        typeof deletedSlot?.slotId === "string" && deletedSlot.slotId.length >= 8
          ? deletedSlot.slotId
          : null;
      const prefixes = [
        `mobile_trust_score_${serial}_${slotIdx}`,
        `mobile_trust_score_timer_${serial}_${slotIdx}`,
      ];
      if (deletedSlotId) {
        prefixes.push(
          `mobile_trust_score_${serial}_${deletedSlotId}`,
          `mobile_trust_score_timer_${serial}_${deletedSlotId}`,
        );
      }
      for (const key of Object.keys(all)) {
        if (prefixes.includes(key)) {
          await storage.deleteGlobalSetting(key);
        }
      }
      const cfg = cfgBeforeDelete;
      const slotAutomation = { ...(cfg[serial]?.slotAutomation ?? {}) };
      delete slotAutomation[String(slotIdx)];
      delete slotAutomation[slotAutomationKey(serial, slotIdx)];
      cfg[serial] = { ...cfg[serial], slotAutomation };
      saveInstanceConfigs(cfg);
      res.json({ ok: true });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Failed to clear deleted slot" });
    }
  });

  // ── Device settings (Google Play credentials + SIM selection) ──────────────
  app.get("/api/mobile/devices/:serial/device-settings", (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    res.json(cfg[p(req, "serial")]?.deviceSettings ?? {});
  });
  app.post("/api/mobile/devices/:serial/device-settings", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
       const { googlePlayEmail, googlePlayPassword, selectedSimSlot, simPhoneNumbers } = req.body as DeviceSettings;
      const cfg = loadInstanceConfigs();
       cfg[serial] = { ...cfg[serial], deviceSettings: { googlePlayEmail, googlePlayPassword, selectedSimSlot, simPhoneNumbers } };
      saveInstanceConfigs(cfg);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Device spec — auto-detect hardware & software via adb getprop ──────────
  app.get("/api/mobile/devices/:serial/device-spec", async (req: Request, res: Response) => {
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) { res.status(503).json({ error: "ADB not found" }); return; }
      const serial = p(req, "serial");

      const prop = async (key: string): Promise<string> => {
        try {
          const r = await execFileP(adbPath, ["-s", serial, "shell", "getprop", key], { timeout: 4000 } as any);
          return String(r.stdout || "").trim();
        } catch { return ""; }
      };
      const shell = async (cmd: string): Promise<string> => {
        try {
          const r = await execFileP(adbPath, ["-s", serial, "shell", cmd], { timeout: 5000 } as any);
          return String(r.stdout || "").trim();
        } catch { return ""; }
      };

      const [
        manufacturer, model, brand, androidVersion, sdkInt, cpuAbi,
        densityPrimary, densityFallback, hardware, buildFingerprint, buildDate,
        carrier1, carrier2, wmSizeRaw, meminfoRaw, kernelRaw, dfRaw,
      ] = await Promise.all([
        prop("ro.product.manufacturer"), prop("ro.product.model"), prop("ro.product.brand"),
        prop("ro.build.version.release"), prop("ro.build.version.sdk"), prop("ro.product.cpu.abi"),
        prop("ro.sf.lcd_density"), prop("ro.screen.density"),
        prop("ro.hardware"), prop("ro.build.fingerprint"), prop("ro.build.date"),
        prop("gsm.operator.alpha"), prop("gsm.operator.alpha.2"),
        shell("wm size"), shell("cat /proc/meminfo | head -1"), shell("uname -r"), shell("df /data | tail -1"),
      ]);

      const density = densityPrimary || densityFallback;
      const sizeM = wmSizeRaw.match(/Physical size:\s*(\d+)x(\d+)/);
      const resolution = sizeM ? { w: parseInt(sizeM[1]), h: parseInt(sizeM[2]) } : null;
      const memM = meminfoRaw.match(/MemTotal:\s+(\d+)\s+kB/i);
      const ramMb = memM ? Math.round(parseInt(memM[1]) / 1024) : null;
      const dfParts = dfRaw.trim().split(/\s+/);
      let storageTotalMb: number | null = null;
      if (dfParts.length >= 2) {
        const total = parseInt(dfParts[1]);
        if (!isNaN(total) && total > 1000) storageTotalMb = Math.round(total / 1024);
      }

      // Phone number via iphonesubinfo service (best-effort, varies by Android version)
      const parseSubinfo = (raw: string): string | null => {
        const parts: string[] = [];
        const re = /'([^']*)'/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(raw)) !== null) {
          for (const ch of m[1]) { if (ch !== "." && /[\d+]/.test(ch)) parts.push(ch); }
        }
        const num = parts.join("").replace(/[^0-9+]/g, "");
        return num.length >= 7 ? num : null;
      };

      let phoneNumber: string | null = null;
      let phoneNumber2: string | null = null;
      const sdk = parseInt(sdkInt) || 0;
      if (sdk >= 33) {
        const [r1, r2] = await Promise.all([
          shell("service call iphonesubinfo 17 i32 1 i32 0"),
          shell("service call iphonesubinfo 18 i32 1 i32 0"),
        ]);
        phoneNumber = parseSubinfo(r1); phoneNumber2 = parseSubinfo(r2);
      } else if (sdk >= 29) {
        const [r1, r2] = await Promise.all([
          shell("service call iphonesubinfo 15 i32 1"),
          shell("service call iphonesubinfo 16 i32 1"),
        ]);
        phoneNumber = parseSubinfo(r1); phoneNumber2 = parseSubinfo(r2);
      } else {
        phoneNumber = parseSubinfo(await shell("service call iphonesubinfo 7"));
      }

      // gsm.operator.alpha can return comma-separated values (e.g. "EE,EE" or
      // "O2,Three") — take the first non-empty segment so the SIM title never
      // contains commas.
      const cleanCarrier = (s: string): string | null => {
        const first = s.split(",")[0].trim();
        return first || null;
      };
      const sims: Array<{ slot: number; carrier: string | null; phoneNumber: string | null }> = [];
      if (carrier1 || phoneNumber) sims.push({ slot: 0, carrier: cleanCarrier(carrier1), phoneNumber: phoneNumber || null });
      if (carrier2 || phoneNumber2) sims.push({ slot: 1, carrier: cleanCarrier(carrier2), phoneNumber: phoneNumber2 || null });

      res.json({
        manufacturer: manufacturer || null, model: model || null, brand: brand || null,
        androidVersion: androidVersion || null, sdkInt: sdkInt || null, cpuAbi: cpuAbi || null,
        density: density || null, hardware: hardware || null,
        buildFingerprint: buildFingerprint ? buildFingerprint.substring(0, 100) : null,
        buildDate: buildDate || null, resolution, ramMb, storageTotalMb,
        kernel: kernelRaw || null, sims,
      });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Check Feed — N downward scrolls over the Instagram feed currently on
  // screen. Opening Instagram/navigating to the feed is out of scope for now
  // (per user instruction) — this just drives the scroll gesture repeatedly
  // against whatever is currently visible on the device. A configurable
  // percentage of scrolls also get a double-tap (like) on the post left on
  // screen, and the pacing between actions honors the user's delay setting
  // (seconds) instead of a hardcoded pause.
  const checkFeedSchema = z.object({
    count: z.number().min(1).max(50),
    delayMinSec: z.number().min(0).max(120).default(5),
    delayMaxSec: z.number().min(0).max(120).default(10),
    likePercentMin: z.number().min(0).max(100).default(0),
    likePercentMax: z.number().min(0).max(100).default(0),
  });
  const checkFeedInProgress = new Set<string>();

  // Per-cycle abort tracking.  Each new cycle is assigned a random ID that is
  // passed by the frontend in both the cycle POST body and the abort POST body.
  // The abort endpoint only sets the flag when the supplied ID matches the ID
  // of the cycle that is currently running, so a stale abort POST that arrives
  // after the next cycle has already started cannot kill the new cycle.
  const automationCycleCurrentId  = new Map<string, string>(); // serial → running cycle ID
  const automationCycleAbortedId  = new Map<string, string>(); // serial → ID that was aborted
  // Tracks which Instagram account (username) was last successfully active on
  // each device. Used to skip the account-switcher tap sequence when the same
  // slot runs back-to-back — avoids a visually-identical long-press every cycle.
  const automationLastActiveUsername = new Map<string, string>(); // serial → last active username
  const automationPreSwitchInProgress = new Map<string, boolean>();
  const runRandomActionsStep = async (
    serial: string,
    onLog: (msg: string) => void,
    opts: {
      checkNotificationsPctMin: number;
      checkNotificationsPctMax: number;
      checkNotificationsScrollsMin: number;
      checkNotificationsScrollsMax: number;
      checkNotificationsClickPctMin: number;
      checkNotificationsClickPctMax: number;
      visitProfilePctMin: number;
      visitProfilePctMax: number;
      visitSavedPctMin: number;
      visitSavedPctMax: number;
      visitSettingsPctMin: number;
      visitSettingsPctMax: number;
      appSwitchPctMin: number;
      appSwitchPctMax: number;
      updateProfilePicEnabled?: boolean;
      updateProfilePicFolderPath?: string;
      updateProfilePicAlterationEnabled?: boolean;
      updateProfilePicAlterationLevel?: "small" | "medium" | "high";
      updateProfilePicImageSettingsEnabled?: boolean;
      updateProfilePicImageSettings?: any;
      updateProfilePicFixAiSlop?: boolean;
      updateProfilePicMetadataCleanup?: boolean;
      updateProfilePicFrequencyDisruption?: boolean;
      updateProfilePicDisableAfterUsed?: boolean;
      updateBioActivatePctMin?: number;
      updateBioActivatePctMax?: number;
      updateBioText?: string;
      updateBioDisableAfterUsed?: boolean;
      slotIdx?: number;
      slotAutomationKey?: string;
    },
    mutateAfter?: (kind: "profile" | "bio") => Promise<void>,
  ) => {
    let _jitterFired = false;
    const notifChance = rollRange(opts.checkNotificationsPctMin, opts.checkNotificationsPctMax) / 100;
    if (notifChance > 0 && Math.random() < notifChance) {
      onLog("Random Actions: checking notifications…");
      await runCheckNotifications(serial, {
        scrollsMin: opts.checkNotificationsScrollsMin,
        scrollsMax: opts.checkNotificationsScrollsMax,
        clickPctMin: opts.checkNotificationsClickPctMin,
        clickPctMax: opts.checkNotificationsClickPctMax,
        onLog: (msg) => onLog(`  ${msg}`),
      });
      _jitterFired = true;
    }
    const profileChance = rollRange(opts.visitProfilePctMin, opts.visitProfilePctMax) / 100;
    if (profileChance > 0 && Math.random() < profileChance) {
      onLog("Random Actions: visiting own profile…");
      await runVisitOwnProfile(serial, (msg) => onLog(`  ${msg}`));
      _jitterFired = true;
      await mutateAfter?.("profile");
    }
    const savedChance = rollRange(opts.visitSavedPctMin, opts.visitSavedPctMax) / 100;
    if (savedChance > 0 && Math.random() < savedChance) {
      onLog("Random Actions: visiting saved posts…");
      await runVisitSaved(serial, (msg) => onLog(`  ${msg}`));
      _jitterFired = true;
    }
    const settingsChance = rollRange(opts.visitSettingsPctMin, opts.visitSettingsPctMax) / 100;
    if (settingsChance > 0 && Math.random() < settingsChance) {
      onLog("Random Actions: visiting random settings…");
      await runVisitSettings(serial, (msg) => onLog(`  ${msg}`));
      _jitterFired = true;
    }
    const appSwitchChance = rollRange(opts.appSwitchPctMin, opts.appSwitchPctMax) / 100;
    if (appSwitchChance > 0 && Math.random() < appSwitchChance) {
      onLog("Random Actions: app switch (SMS)…");
      await runAppSwitch(serial, (msg) => onLog(`  ${msg}`));
      _jitterFired = true;
    }
    const profilePicChance = rollRange(opts.updateProfilePicEnabled ? 100 : 0, opts.updateProfilePicEnabled ? 100 : 0) / 100;
    if (profilePicChance > 0 && Math.random() < profilePicChance && opts.updateProfilePicEnabled) {
      onLog("Random Actions: updating profile picture…");
      await runUpdateProfilePicture(serial, opts.updateProfilePicFolderPath ?? "", (msg) => onLog(`  ${msg}`), {
        alterationEnabled: opts.updateProfilePicAlterationEnabled ?? true,
        alterationLevel: opts.updateProfilePicAlterationLevel ?? "small",
        imageSettingsEnabled: opts.updateProfilePicImageSettingsEnabled ?? true,
        imageSettings: opts.updateProfilePicImageSettings,
        doFixAiSlop: opts.updateProfilePicFixAiSlop ?? true,
        metadataCleanup: opts.updateProfilePicMetadataCleanup ?? true,
        frequencyDisruption: opts.updateProfilePicFrequencyDisruption ?? false,
      });
      if (opts.updateProfilePicDisableAfterUsed) {
        await mutateAfter?.("profile");
      }
      _jitterFired = true;
    }
    const bioChance = rollRange(opts.updateBioActivatePctMin ?? 0, opts.updateBioActivatePctMax ?? 0) / 100;
    if (bioChance > 0 && Math.random() < bioChance && opts.updateBioText?.trim()) {
      onLog("Random Actions: updating profile bio…");
      await runUpdateBio(serial, opts.updateBioText, (msg) => onLog(`  ${msg}`));
      if (opts.updateBioDisableAfterUsed) {
        await mutateAfter?.("bio");
      }
      _jitterFired = true;
    }
    return _jitterFired;
  };
  const pushRandomActionStep = (steps: string[], key: string) => {
    steps.push(key);
  };
  const preSwitchToolNames = new Set([
    "Feed",
    "View Stories",
    "View Reels",
    "Check Inbox",
    "Inject Browsing",
    "Random Actions",
    "Make a Post",
    "Update Profile Picture",
    "Update Bio",
    "Post a Story",
  ]);

  const isCycleAborted = (serial: string) =>
    automationCycleAbortedId.get(serial) !== undefined &&
    automationCycleAbortedId.get(serial) === automationCycleCurrentId.get(serial);

  // Shared mother-code timing with a stable, serial-specific accent. The
  // per-action random sample below still prevents repetitive sequences.
  const devicePersonality = (serial: string) => {
    let h = 2166136261;
    for (let i = 0; i < serial.length; i++) {
      h ^= serial.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const unit = (salt: number) => {
      let n = (h ^ Math.imul(salt, 2246822519)) >>> 0;
      n ^= n >>> 15; n = Math.imul(n, 2246822519) >>> 0;
      n ^= n >>> 13; n = Math.imul(n, 3266489917) >>> 0;
      return ((n ^ (n >>> 16)) >>> 0) / 0x100000000;
    };
    return {
      dwellScale: 0.86 + unit(1) * 0.30,
      pauseScale: 0.82 + unit(2) * 0.36,
      settleScale: 0.82 + unit(3) * 0.36,
      gestureScale: 0.92 + unit(4) * 0.16,
      xBias: Math.round((unit(5) - 0.5) * 18),
      yBias: Math.round((unit(6) - 0.5) * 24),
    };
  };
  const effectiveTypingProfile = (serial: string) => {
    const profile = loadInstanceConfigs()[serial]?.devicePrefs?.typingSpeedProfile;
    if (!profile) return undefined;
    const scale = devicePersonality(serial).dwellScale;
    const range = (minMs: number, maxMs: number) => ({
      minMs: Math.max(0, Math.round(minMs * scale)),
      maxMs: Math.max(0, Math.round(maxMs * scale)),
    });
    return {
      ...profile,
      ...range(profile.minMs, profile.maxMs),
      dwellMinMs: Math.max(1, Math.round(profile.dwellMinMs * scale)),
      dwellMaxMs: Math.max(1, Math.round(profile.dwellMaxMs * scale)),
      hesitationMinMs: Math.max(0, Math.round(profile.hesitationMinMs * scale)),
      hesitationMaxMs: Math.max(0, Math.round(profile.hesitationMaxMs * scale)),
    };
  };

  // Helper: every mobile dwell is sampled at the point of execution. Keeping
  // this at the shared boundary prevents a newly added action from silently
  // reintroducing a fixed timing signature.
  const dwellDiagnosticAt = new Map<string, number>();
  const randomizedDwellMs = (serial: string, ms: number, category: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" = "actionPacing"): number => {
    if (!Number.isFinite(ms) || ms <= 0) return Math.max(0, ms);
    const scaled = ms * devicePersonality(serial).dwellScale;
    const low = scaled >= 5000 ? Math.max(1, Math.round(scaled * 0.5)) : Math.max(1, Math.round(scaled));
    const high = scaled >= 5000 ? Math.round(scaled) : 5000;
    const overrides = loadInstanceConfigs()[serial]?.devicePrefs?.motherCodeOverrides;
    const override = overrides?.globalDwell;
    if (!override) return low + Math.floor(Math.random() * (high - low + 1));
    const min = Math.min(override.minMs, override.maxMs);
    const max = Math.max(override.minMs, override.maxMs);
    const actual = Math.round(min + Math.random() * (max - min));
    const diagnosticKey = `${serial}:${category}`;
    const now = Date.now();
    if ((dwellDiagnosticAt.get(diagnosticKey) ?? 0) + 5000 <= now) {
      dwellDiagnosticAt.set(diagnosticKey, now);
      logger.info({ serial, category, requestedMs: ms, overrideMinMs: min, overrideMaxMs: max, actualMs: actual },
        "[mobile-override] global dwell applied");
    }
    return actual;
  };
  const sleepOrAbort = (serial: string, ms: number, category: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" = "actionPacing") => {
    const dwellMs = randomizedDwellMs(serial, ms, category);
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        if (isCycleAborted(serial)) reject(new Error("cycle-aborted"));
        else resolve();
      }, dwellMs);
      // Also check immediately for zero-ms waits
      if (dwellMs <= 0) { clearTimeout(t); isCycleAborted(serial) ? reject(new Error("cycle-aborted")) : resolve(); }
    });
  };
  const returnToHomeSafely = async (serial: string): Promise<boolean> => {
    // Android Back is deliberately not a Home route: it only reverses the
    // current navigation stack and can leave the device inside a feed viewer.
    // The only safe route currently available here is the validated Home tab.
    const home = await android.findHomeTab(serial).catch(() => null);
    if (!home) return false;
    await android.tap(serial, home.x, home.y);
    return true;
  };

  const hstRandomDelay = (serial: string, minMs: number, maxMs: number) =>
    sleepOrAbort(serial, minMs + Math.floor(Math.random() * (maxMs - minMs + 1)));

  // Helper: get screen dimensions via adb wm size.
  function getScreenSize(serial: string): { w: number; h: number } {
    let w = 1080, h = 2400;
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (adbPath) {
        const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
        const out = wm.stdout ?? "";
        // UIAutomator and `adb shell input tap` both operate in the OVERRIDE
        // (logical) coordinate space, not the physical pixel space.
        // OEM devices (Xiaomi, Oppo, etc.) often print both:
        //   Physical size: 1080x2400
        //   Override size: 720x1280
        // A naïve /(\d+)x(\d+)/ grabs the first match (physical), causing
        // every percentage-based tap to land at the wrong position.
        // Always prefer Override size when present — identical fix already
        // applied to the same function in androidManager.ts.
        const mOverride = out.match(/Override\s+size:\s*(\d+)x(\d+)/i);
        const mAny      = out.match(/(\d+)x(\d+)/);
        const m = mOverride ?? mAny;
        if (m) { w = parseInt(m[1]); h = parseInt(m[2]); }
      }
    } catch { /* fall back to defaults above */ }
    return { w, h };
  }

  // Each tool tracks its own last DM recipient independently — no cross-tool
  // sharing so that changing one tool's Share-to-DM code can never affect
  // another tool's recipient state. All four Maps are keyed by serial.
  const _viewFeedLastDmRecipient        = new Map<string, { x: number; y: number }>();
  const _viewStoriesLastDmRecipient     = new Map<string, { x: number; y: number }>();
  const _viewReelsLastDmRecipient       = new Map<string, { x: number; y: number }>();
  const _viewExploreLastDmRecipient     = new Map<string, { x: number; y: number }>();
  const _injectBrowsingLastDmRecipient  = new Map<string, { x: number; y: number }>();

  /**
   * Rolls a single scroll-swipe velocity from a session-level weight set.
   *
   * Four modes, weighted by `weights` (treated as relative, not %-of-100):
   *   super skim — fast long swipe (flicking through boring content)
   *   fast       — medium-paced scroll
   *   normal     — slow short nudge (something caught the eye)
   *   back       — short reversed swipe (peeked back up)
   *
   * Pass `allowBack = false` for Reels (a back-swipe navigates to the
   * previous clip, which is never what we want mid-loop).
   *
   * `safeStartFrac` is the minimum Y fraction for the swipe start point.
   * Feed requires ≥0.88 to clear the post action bar; Explore can use 0.80.
   */
  function rollScrollVelocity(
    h: number,
    weights: { superSkim: number; skim: number; fast: number; quick: number; normal: number; slow: number; focused: number; tapDragRelease: number; back: number },
    allowBack = true,
    safeStartFrac = 0.80,
    history?: { lastMode?: string; streak: number },
    serial?: string,
  ): { duration: number; fromY: number; toY: number; mode: string } {
    const personalityOverrides = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides : undefined;
    const effectiveWeights = { ...weights };
    for (const mode of Object.keys(effectiveWeights) as Array<keyof typeof effectiveWeights>) {
      const configured = personalityOverrides?.[mode];
      // UI uses weight 0 as "follow Mother Code defaults", not "disable this
      // personality". A deliberate zero-weight override can be added later
      // with an explicit enabled flag without changing this compatibility rule.
      if (configured && (configured.weightMin > 0 || configured.weightMax > 0)) {
        const min = Math.min(configured.weightMin, configured.weightMax);
        const max = Math.max(configured.weightMin, configured.weightMax);
        effectiveWeights[mode] = min + Math.random() * (max - min);
      }
    }
    // Roll independently for every scroll, but avoid visibly artificial runs.
    // Repeats remain possible; after three of the same mode, force the next
    // roll to choose another mode. Back-scrolls are rarer and are capped at
    // two consecutive rolls because a long reverse run is not natural reading.
    const blocked = new Set<string>();
    if (history?.lastMode && history.streak >= 3) blocked.add(history.lastMode);
    if (history?.lastMode === "back" && history.streak >= 2) blocked.add("back");
    const superSkim = blocked.has("superSkim") ? 0 : effectiveWeights.superSkim;
    const skim = blocked.has("skim") ? 0 : effectiveWeights.skim;
    const fast = blocked.has("fast") ? 0 : effectiveWeights.fast;
    const quick = blocked.has("quick") ? 0 : effectiveWeights.quick;
    const normal = blocked.has("normal") ? 0 : effectiveWeights.normal;
    const slow = blocked.has("slow") ? 0 : effectiveWeights.slow;
    const focused = blocked.has("focused") ? 0 : effectiveWeights.focused;
    const tapDragRelease = blocked.has("tapDragRelease") ? 0 : effectiveWeights.tapDragRelease;
    const back = blocked.has("back") ? 0 : (allowBack ? effectiveWeights.back : 0);
    const duration = (mode: keyof typeof effectiveWeights, fallbackMin: number, fallbackMax: number) => {
      const configured = personalityOverrides?.[mode]?.weightMin > 0 || personalityOverrides?.[mode]?.weightMax > 0
        ? personalityOverrides[mode] : undefined;
      const min = Math.max(1, Math.round(configured?.durationMinMs ?? fallbackMin));
      const max = Math.max(min, Math.round(configured?.durationMaxMs ?? fallbackMax));
      return min + Math.round(Math.random() * (max - min));
    };
    const total = superSkim + skim + fast + quick + normal + slow + focused + tapDragRelease + back;
    const roll = Math.random() * total;
    let cum = 0;

    cum += superSkim;
    if (roll < cum) return { mode: "superSkim", duration: duration("superSkim", 150, 350), fromY: Math.round(h * safeStartFrac), toY: Math.round(h * 0.08) };
    cum += skim;
    if (roll < cum) {
      return { mode: "skim", duration: duration("skim", 450, 800), fromY: Math.round(h * safeStartFrac), toY: Math.round(h * 0.22) };
    }
    cum += fast;
    if (roll < cum) return { mode: "fast", duration: duration("fast", 900, 1500), fromY: Math.round(h * safeStartFrac), toY: Math.round(h * 0.30) };
    cum += quick;
    if (roll < cum) return { mode: "quick", duration: duration("quick", 1250, 2000), fromY: Math.round(h * Math.min(0.65, safeStartFrac)), toY: Math.round(h * 0.38) };
    cum += normal;
    if (roll < cum) return { mode: "normal", duration: duration("normal", 1500, 2500), fromY: Math.round(h * Math.min(0.65, safeStartFrac)), toY: Math.round(h * 0.42) };
    cum += slow;
    if (roll < cum) return { mode: "slow", duration: duration("slow", 2000, 3500), fromY: Math.round(h * Math.min(0.62, safeStartFrac)), toY: Math.round(h * 0.45) };
    cum += focused;
    if (roll < cum) return { mode: "focused", duration: duration("focused", 2500, 5000), fromY: Math.round(h * Math.min(0.58, safeStartFrac)), toY: Math.round(h * 0.48) };
    cum += tapDragRelease;
    if (roll < cum) return { mode: "tapDragRelease", duration: duration("tapDragRelease", 5000, 10000), fromY: Math.round(h * safeStartFrac), toY: Math.round(h * 0.35) };
    return {
      mode: "back",
      duration: duration("back", 350, 600),
      fromY: Math.round(h * 0.28),
      toY:   Math.round(h * 0.52),
    };
  }

  /**
   * Executes a content-scroll using the hardware-specific gesture profile.
   * The profile is keyed by serial, so one phone can never inherit another
   * phone's swipe geometry. A missing profile is an explicit configuration
   * error; content scrolling must never silently use generated coordinates.
   */
  async function deviceProfileSwipe(
    serial: string,
    fallback: { x1: number; y1: number; x2: number; y2: number; durationMs: number },
    source: string,
    personality?: "superSkim" | "skim" | "fast" | "quick" | "normal" | "slow" | "focused" | "tapDragRelease" | "back",
    opts?: { maxFromY?: number },
  ): Promise<{ x1: number; y1: number; x2: number; y2: number; durationMs: number; profile: boolean }> {
    let configured: DevicePrefs["swipeGesture"] | undefined;
    try { configured = loadInstanceConfigs()[serial]?.devicePrefs?.swipeGesture; } catch { configured = undefined; }
    const size = getScreenSize(serial);
    const clamp = (value: number, max: number) => Math.max(0, Math.min(max - 1, Math.round(value)));
    if (!configured) {
      throw new Error(`Swipe Gesture Profile is required for ${source}`);
    }
    const jitterX = Number.isFinite(configured.jitterX) ? configured.jitterX : 0;
    const jitterY = Number.isFinite(configured.jitterY) ? configured.jitterY : 0;
    const dx = Math.round((Math.random() * 2 - 1) * jitterX);
    const startJitterMinY = Math.max(0, Math.min(configured.startJitterMinY ?? 0, configured.startJitterMaxY ?? 0));
    const startJitterMaxY = Math.max(startJitterMinY, configured.startJitterMaxY ?? startJitterMinY);
    const startDy = Math.round(startJitterMinY + Math.random() * (startJitterMaxY - startJitterMinY));
    const endDy = Math.round((Math.random() * 2 - 1) * jitterY);
    if (!Number.isFinite(configured.durationMinMs) || !Number.isFinite(configured.durationMaxMs)) {
      throw new Error(`Swipe Gesture Profile duration is invalid for ${source}`);
    }
    // The device profile owns gesture duration as well as geometry. Do not
    // collapse calibrated ranges to the old 150 ms ceiling: on slower phones
    // that turns the configured swipe into a touch-down/tap, which can focus
    // Instagram's Send message composer instead of advancing the viewer.
    const minDuration = Math.max(1, Math.min(configured.durationMinMs, configured.durationMaxMs));
    const maxDuration = Math.max(minDuration, Math.max(configured.durationMinMs, configured.durationMaxMs));
    // The saved profile owns the physical gesture. Personality only changes
    // how quickly it is performed, so calibrated coordinates remain stable.
    const span = maxDuration - minDuration;
    const durationBand: Record<"superSkim" | "skim" | "fast" | "quick" | "normal" | "slow" | "focused" | "tapDragRelease" | "back", [number, number]> = {
      superSkim: [0, 0.20],
      skim: [0.20, 0.45],
      fast: [0.45, 0.70],
      quick: [0.70, 0.90],
      normal: [0.90, 1],
      slow: [0.90, 1],
      focused: [0.90, 1],
      tapDragRelease: [0.05, 0.10],
      back: [0.05, 0.10],
    };
    const [bandStart, bandEnd] = personality ? durationBand[personality] : [0, 1];
    const personalityProfile = devicePersonality(serial);
    const durationMs = Math.max(1, Math.round(
      (minDuration + span * (bandStart + Math.random() * (bandEnd - bandStart))) *
      personalityProfile.gestureScale,
    ));
    const pauseMin = Math.max(0, Math.min(configured.pauseMinMs ?? 0, configured.pauseMaxMs ?? 0));
    const pauseMax = Math.max(pauseMin, configured.pauseMaxMs ?? pauseMin);
    const settleMin = Math.max(0, Math.min(configured.settleMinMs ?? 0, configured.settleMaxMs ?? 0));
    const settleMax = Math.max(settleMin, configured.settleMaxMs ?? settleMin);
    const pauseMs = Math.round((pauseMin + Math.random() * (pauseMax - pauseMin)) * personalityProfile.pauseScale);
    const settleMs = Math.round((settleMin + Math.random() * (settleMax - settleMin)) * personalityProfile.settleScale);
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const reversed = personality === "back";
    let path = {
      x1: clamp((reversed ? configured.x2 : configured.x1) + dx + personalityProfile.xBias, size.w),
      y1: clamp((reversed ? configured.y2 : configured.y1) + (reversed ? endDy : startDy) + personalityProfile.yBias, size.h),
      x2: clamp((reversed ? configured.x1 : configured.x2) + dx + personalityProfile.xBias, size.w),
      y2: clamp((reversed ? configured.y1 : configured.y2) + (reversed ? startDy : endDy) + personalityProfile.yBias, size.h),
      durationMs,
    };
    // If the caller specifies a maximum starting Y (e.g. to keep the swipe
    // start out of a bottom-row of clickable grid cells on the Explore page),
    // clamp AFTER jitter so the profile's random offset can't push the finger
    // onto an element whose touch consumer would claim the DOWN event as a tap.
    if (opts?.maxFromY !== undefined && !reversed) {
      path.y1 = Math.min(path.y1, opts.maxFromY);
    }
    // The Reels caller already captures one live accessibility dump before and
    // after each advance. Do not repeat those expensive dumps here; the
    // calibrated path and final input coordinates are still logged below.
    logger.info({
      serial,
      source,
      personality,
      reversed,
      profileConfiguredFrom: [configured.x1, configured.y1],
      profileConfiguredTo: [configured.x2, configured.y2],
      profileDurationRangeMs: [configured.durationMinMs, configured.durationMaxMs],
      profileJitter: {
        xMax: configured.jitterX,
        yMax: configured.jitterY,
        startY: [configured.startJitterMinY, configured.startJitterMaxY],
        applied: { x: dx, startY: startDy, endY: endDy },
      },
      profilePauseRangeMs: [configured.pauseMinMs, configured.pauseMaxMs],
      profileSettleRangeMs: [configured.settleMinMs, configured.settleMaxMs],
      requestedFallback: {
        from: [fallback.x1, fallback.y1],
        to: [fallback.x2, fallback.y2],
        durationMs: fallback.durationMs,
      },
      from: [path.x1, path.y1],
      to: [path.x2, path.y2],
      durationMs,
      pauseMs,
      settleMs,
      profile: true,
    }, "[mobile-input] device-profile swipe resolved");
    // The profile already generated the complete randomized path. Do not
    // apply android.swipe's legacy hidden center-line jitter on top of it.
    await android.swipe(serial, path.x1, path.y1, path.x2, path.y2, path.durationMs, false);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    return { ...path, profile: true };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: VIEW FEED
  // Functions: runCheckFeedLoop()
  // Route:     POST /api/mobile/devices/:serial/check-feed
  //            (also called directly from automation-cycle)
  // Isolation: all like/share/save/DM logic is self-contained here.
  //            Do not import helpers added for other tools into this section.
  // ═══════════════════════════════════════════════════════════════════════════

  // Shared by the standalone `/check-feed` route and the full
  // `/automation-cycle` route below — the scroll/like/share loop.
  async function runCheckFeedLoop(serial: string, params: {
    count: number; delayMinSec: number; delayMaxSec: number;
    /** Automation-cycle has already navigated here; standalone Check Feed has not. */
    homeAlreadyEstablished?: boolean;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin?: number; shareFeedPercentMax?: number;
    shareDmPercentMin?: number; shareDmPercentMax?: number;
    savePercentMin?: number; savePercentMax?: number;
    expandCaptionPercentMin?: number; expandCaptionPercentMax?: number;
    tapAudioPercentMin?: number; tapAudioPercentMax?: number;
    clickHashtagPercentMin?: number; clickHashtagPercentMax?: number;
    clickAuthorPercentMin?: number; clickAuthorPercentMax?: number;
    onLog?: (msg: string) => void;
  }): Promise<{ count: number; likes: number; likeFailures: number; sharesFeed: number; sharesDm: number; saves: number; captionExpands: number; strayNavRecoveries: number; audioTaps: number; hashtagTaps: number; authorVisits: number }> {
    params.onLog?.("[TRACE] feed: start");
    const {
      count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
      shareFeedPercentMin = 0, shareFeedPercentMax = 0,
      shareDmPercentMin = 0, shareDmPercentMax = 0,
      savePercentMin = 0, savePercentMax = 0,
      expandCaptionPercentMin = 0, expandCaptionPercentMax = 0,
      tapAudioPercentMin = 0, tapAudioPercentMax = 0,
      clickHashtagPercentMin = 0, clickHashtagPercentMax = 0,
      clickAuthorPercentMin = 0, clickAuthorPercentMax = 0,
      homeAlreadyEstablished = false,
      onLog,
    } = params;

    // Always establish the Home/feed surface before taking the first live
    // post dump. View Feed can be launched while Instagram is on a profile,
    // search, Reels, or another nested screen; scanning that tree as if it
    // were the feed causes every downstream action to target the wrong UI.
    if (!homeAlreadyEstablished) {
      onLog?.("[TRACE] feed: find-home");
      const homeTab = await android.findHomeTab(serial).catch(() => null);
      if (!homeTab) {
        throw new Error("View Feed cannot start: Instagram Home tab was not found");
      }
      onLog?.(`View Feed: tapping Home tab before execution at (${homeTab.x}, ${homeTab.y})`);
      await android.tap(serial, homeTab.x, homeTab.y, "bot");
      onLog?.("[TRACE] feed: tap-home");
      await new Promise(resolve => setTimeout(resolve, 150 + Math.floor(Math.random() * 351)));
    } else {
      onLog?.("View Feed: Home feed already established — skipping duplicate Home tap");
    }

    const delayLoSec = Math.min(delayMinSec, delayMaxSec);
    const delayHiSec = Math.max(delayMinSec, delayMaxSec);
    const likeLoPct = Math.min(likePercentMin, likePercentMax);
    const likeHiPct = Math.max(likePercentMin, likePercentMax);
    const likeChance = (likeLoPct + Math.random() * (likeHiPct - likeLoPct)) / 100;
    const shareFeedLo = Math.min(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedHi = Math.max(shareFeedPercentMin, shareFeedPercentMax);
    const shareFeedChance = (shareFeedLo + Math.random() * (shareFeedHi - shareFeedLo)) / 100;
    const shareDmLo = Math.min(shareDmPercentMin, shareDmPercentMax);
    const shareDmHi = Math.max(shareDmPercentMin, shareDmPercentMax);
    const shareDmChance = (shareDmLo + Math.random() * (shareDmHi - shareDmLo)) / 100;
    const saveLo = Math.min(savePercentMin, savePercentMax);
    const saveHi = Math.max(savePercentMin, savePercentMax);
    const saveChance = (saveLo + Math.random() * (saveHi - saveLo)) / 100;
    const captionExpandLo = Math.min(expandCaptionPercentMin, expandCaptionPercentMax);
    const captionExpandHi = Math.max(expandCaptionPercentMin, expandCaptionPercentMax);
    const captionExpandChance = (captionExpandLo + Math.random() * (captionExpandHi - captionExpandLo)) / 100;
    const tapAudioLo = Math.min(tapAudioPercentMin, tapAudioPercentMax);
    const tapAudioHi = Math.max(tapAudioPercentMin, tapAudioPercentMax);
    const tapAudioChance = (tapAudioLo + Math.random() * (tapAudioHi - tapAudioLo)) / 100;
    const clickHashtagLo = Math.min(clickHashtagPercentMin, clickHashtagPercentMax);
    const clickHashtagHi = Math.max(clickHashtagPercentMin, clickHashtagPercentMax);
    const clickHashtagChance = (clickHashtagLo + Math.random() * (clickHashtagHi - clickHashtagLo)) / 100;
    const clickAuthorLo = Math.min(clickAuthorPercentMin, clickAuthorPercentMax);
    const clickAuthorHi = Math.max(clickAuthorPercentMin, clickAuthorPercentMax);
    const clickAuthorChance = (clickAuthorLo + Math.random() * (clickAuthorHi - clickAuthorLo)) / 100;
    onLog?.(`Feed settings — like:${Math.round(likeChance * 100)}% expandCaption:${Math.round(captionExpandChance * 100)}% tapAudio:${Math.round(tapAudioChance * 100)}% clickHashtag:${Math.round(clickHashtagChance * 100)}% clickAuthor:${Math.round(clickAuthorChance * 100)}% save:${Math.round(saveChance * 100)}% shareFeed:${Math.round(shareFeedChance * 100)}% shareDm:${Math.round(shareDmChance * 100)}%`);

    const { w, h } = getScreenSize(serial);
    const x  = Math.round(w / 2);
    // y1 must start LOW enough to be below the action bar (Like/Comment/Share
    // icons) of every Instagram post format, including the tallest allowed
    // (4:5 portrait). On a 720×1280 device a 4:5 image is 720×900px; adding
    // the ~60px header puts the action bar at y≈960–1008. The old y1=78%
    // (y=998) landed RIGHT on that bar — Android registered the touch-down
    // on the Comment icon and the upward drag was treated as opening comments
    // rather than scrolling the feed. Moving to 88% (y=1126) clears the
    // action bar of any format by ≥100px while still leaving a 600px+ drag
    // distance to y2.
    const y1 = Math.round(h * 0.88);
    const y2 = Math.round(h * 0.22);
    const cy = Math.round(h / 2);
    // Instagram feed post action-bar icon positions are NOT fixed —
    // page/profile owners can disable comments and/or shares per post,
    // which removes icons from the bar and shifts everything after the
    // gap left-ward. A fixed 48.1%/66.0% X guess (measured from one
    // screenshot where all icons happened to be present) landed on the
    // Comment button once a post had fewer icons than that, opening the
    // comment/reply compose box instead of sharing — confirmed from a
    // user-supplied screen-layout scan (Jul 2026). Every tap below is now
    // resolved per-post from `android.findFeedActionIcons()`, which reads
    // the real accessibility tree for whatever's on screen right now and
    // returns `null` for any icon whose identity is ambiguous (see its
    // doc comment) instead of guessing — see the action-bar gating below.

    // Share-to-DM used to just tap the paper-plane icon and press Back —
    // it never actually picked a recipient or sent anything, it only
    // *opened and closed* the DM picker. See tapRandomShareSheetRecipient /
    // sendShareSheet below for the real send flow.

    let likes = 0;
    let likeFailures = 0;
    let captionExpands = 0;
    let sharesFeed = 0;
    let sharesDm = 0;
    let saves = 0;
    let strayNavRecoveries = 0;
    let audioTaps = 0;
    let hashtagTaps = 0;
    let authorVisits = 0;
    // Sponsored posts ("Ads") render a full-width CTA button ("Shop Now",
    // "Install Now", "Learn More") overlaid near the bottom of the media —
    // right where our double-tap-to-like jitter can land after a scroll that
    // doesn't align to a post boundary. Tapping that button navigates out of
    // Instagram entirely (browser / Play Store), and every scripted tap for
    // the rest of the cycle then lands on the wrong app, which looks like
    // "the whole flow broke". We can't reliably detect an ad from pixels
    // alone via adb, so instead we verify we're still inside Instagram after
    // every gesture that could have hit a CTA, and recover with BACK if not.
    const INSTAGRAM_PKG = "com.instagram.android";
    const verifyStillInInstagram = async (): Promise<boolean> => {
      const fg = await android.getForegroundPackage(serial).catch(() => null);
      if (!fg || fg === INSTAGRAM_PKG) return true;
      if (fg !== INSTAGRAM_PKG) {
        strayNavRecoveries++;
        logger.warn({ serial, fg }, "[check-feed] tap navigated away from Instagram (likely hit an ad's CTA) — recovering with BACK");
        onLog?.(`⚠ Tapped outside Instagram — foreground app is "${fg}" (likely hit an ad CTA). Pressing Back to recover…`);
        try { await android.pressBack(serial); } catch { /* best effort */ }
        await sleepOrAbort(serial, 700);
        // If BACK didn't get us home (e.g. it opened a separate app like the
        // Play Store rather than an in-app browser), force Instagram back to
        // the foreground rather than continuing to tap blind.
        const fg2 = await android.getForegroundPackage(serial).catch(() => null);
        if (fg2 && fg2 !== INSTAGRAM_PKG) {
          await android.launchInstagram(serial).catch(() => { /* best effort */ });
          await sleepOrAbort(serial, 1500);
        }
      }
      return false;
    };

    // View Feed owns this scan deliberately.  Do not replace it with the
    // shared feed-icon helper: that helper is also used by other tools and its
    // row selection is allowed to use assumptions that are unsafe here.
    //
    // Every coordinate returned by this function is the centre of the exact
    // accessibility node that supplied it.  The current post is selected by
    // one coherent action-row identity (Like + any same-row controls), never
    // by screen percentages or by "first node in the dump".
    type ViewFeedA11yNode = {
      x: number; y: number; x1: number; y1: number; x2: number; y2: number;
      rid: string; desc: string; text: string; cls: string; clickable: boolean;
    };
    type ViewFeedScan = {
      like: { x: number; y: number };
      alreadyLiked: boolean;
      comment: { x: number; y: number } | null;
      shareFeed: { x: number; y: number } | null;
      shareDm: { x: number; y: number } | null;
      save: { x: number; y: number } | null;
      saveLabel: string;
      author: { x: number; y: number; name: string } | null;
      audio: { x: number; y: number } | null;
      mediaBounds?: { x1: number; y1: number; x2: number; y2: number };
      isVideoPost: boolean;
      xml: string;
    };
    const scanViewFeedA11y = async (): Promise<ViewFeedScan | null> => {
      const xml = await android.dumpUi(serial).catch(() => "");
      if (!xml) return null;
      if (
        xml.includes('text="Ad"') || xml.includes('content-desc="Ad"') ||
        xml.includes('text="Sponsored"') || xml.includes('content-desc="Sponsored"') ||
        xml.includes('text="Advert"') || xml.includes('content-desc="Advert"')
      ) {
        onLog?.("View Feed a11y scan: sponsored post marker found — skipping post actions");
        return null;
      }
      const nodes: ViewFeedA11yNode[] = [];
      for (const segment of xml.split("<node ")) {
        const bounds = segment.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bounds) continue;
        const x1 = Number(bounds[1]), y1 = Number(bounds[2]);
        const x2 = Number(bounds[3]), y2 = Number(bounds[4]);
        const attr = (name: string) => (segment.match(new RegExp(`${name}="([^"]*)"`)) ?? [])[1] ?? "";
        const rid = attr("resource-id");
        const desc = attr("content-desc");
        const text = attr("text");
        const cls = attr("class");
        nodes.push({
          x: Math.floor((x1 + x2) / 2), y: Math.floor((y1 + y2) / 2),
          x1, y1, x2, y2, rid, desc, text, cls,
          clickable: segment.includes('clickable="true"'),
        });
      }

      const isLike = (n: ViewFeedA11yNode) =>
        n.rid.includes("row_feed_button_like") || /^(?:un)?like$/i.test(n.desc);
      const likeByCoord = new Map<string, ViewFeedA11yNode>();
      for (const node of nodes) {
        // Instagram exposes the real Like control inconsistently: the
        // row_feed_button_like child can be a non-clickable Button while its
        // tappable parent ViewGroup owns the same bounds. The resource ID is
        // an unambiguous action identity, so accept it using its live bounds.
        // Label-only Like/Unlike matches remain strict and must be clickable.
        if (!isLike(node)) continue;
        const key = `${node.x},${node.y}`;
        const previous = likeByCoord.get(key);
        // Prefer the concrete resource-id node over a same-centre wrapper.
        if (!previous || (node.rid.includes("row_feed_button_like") && !previous.rid.includes("row_feed_button_like"))) {
          likeByCoord.set(key, node);
        }
      }
      const likes = [...likeByCoord.values()];
      if (likes.length === 0) {
        onLog?.("View Feed a11y scan: no clickable Like/Unlike node");
        // View Feed diagnostic only: preserve the raw node attributes that
        // explain a failed action-bar match. This is especially important for
        // carousels, whose media hierarchy differs from single-photo posts.
        // Do not dump the entire XML into the UI log; retain every node in the
        // action-bar band plus media-group nodes so the next exported log is
        // self-contained without changing automation behavior.
        const diagnosticNodes = nodes.filter(n =>
          (n.y1 >= 0.40 * getScreenSize(serial).h && n.y1 <= 0.82 * getScreenSize(serial).h) ||
          /(?:carousel_)?media_group/i.test(n.rid),
        );
        onLog?.(
          `View Feed a11y diagnostic: ${diagnosticNodes.length} raw node(s) in ` +
          `action/media region`,
        );
        for (const n of diagnosticNodes) {
          onLog?.(
            `[feed-raw-node] ${n.clickable ? "CLICKABLE" : "view"} ` +
            `rid="${n.rid}" desc="${n.desc}" text="${n.text}" ` +
            `class="${n.cls}" bounds="[${n.x1},${n.y1}][${n.x2},${n.y2}"]"`,
          );
        }
        return null;
      }

      const sameRow = (a: ViewFeedA11yNode, b: ViewFeedA11yNode, tolerance = 36) =>
        Math.abs(a.y - b.y) <= tolerance;
      const isSave = (n: ViewFeedA11yNode) =>
        n.rid.includes("row_feed_button_save") ||
        /^(?:add to saved|remove from saved)$/i.test(n.desc);
      const isComment = (n: ViewFeedA11yNode) =>
        /^comment$/i.test(n.desc) && !/commentary|comments/i.test(n.text);
      const isRepost = (n: ViewFeedA11yNode) =>
        /^(?:repost|repost to your story|share to feed)$/i.test(n.desc);
      const isDm = (n: ViewFeedA11yNode) =>
        /^(?:send|direct|message|share via dm)$/i.test(n.desc);
      const isFeedSaveRibbon = (n: ViewFeedA11yNode) =>
        n.clickable &&
        isSave(n) &&
        n.x1 >= getScreenSize(serial).w * 0.78 &&
        n.x2 > n.x1 &&
        n.y2 > n.y1 &&
        n.x2 - n.x1 <= 180 &&
        n.y2 - n.y1 <= 180;

      // Pick the row with the strongest complete identity.  A recycled
      // off-screen post may expose another Like node, but it will not have the
      // same row's save/role controls.  Ties are ambiguous and fail closed.
      const rowChoices = likes.map(like => {
        const row = nodes.filter(n => sameRow(n, like));
        const controls = row.filter(n => n.clickable);
        const mediaAbove = nodes
          .filter(n => /(?:carousel_)?media_group/.test(n.rid) && n.y2 < like.y)
          .sort((a, b) => (like.y - a.y2) - (like.y - b.y2))[0];
        const mediaGap = mediaAbove ? like.y - mediaAbove.y2 : Number.POSITIVE_INFINITY;
        const score =
          100 +
          (row.some(isSave) ? 40 : 0) +
          (row.some(isComment) ? 20 : 0) +
          (row.some(isRepost) ? 20 : 0) +
          (row.some(isDm) ? 20 : 0) +
          Math.min(controls.length, 8) +
          (mediaAbove ? 60 : 0);
        return { like, row, score, mediaGap };
      });
      rowChoices.sort((a, b) => b.score - a.score || a.mediaGap - b.mediaGap);
      if (
        rowChoices.length > 1 &&
        rowChoices[0].score === rowChoices[1].score &&
        rowChoices[0].mediaGap === rowChoices[1].mediaGap
      ) {
        onLog?.("View Feed a11y scan: multiple equally-identified action rows — skipping");
        return null;
      }
      const chosen = rowChoices[0];
      const row = chosen.row;
      const like = chosen.like;
      const pos = (n: ViewFeedA11yNode) => ({ x: n.x, y: n.y });
      const clickableRow = row.filter(n => n.clickable);
      // A save resource-id can also appear on a large wrapper around an
      // embedded Reel/media surface. Only accept a compact, right-edge live
      // node as the feed ribbon; never tap a large wrapper's centre.
      const saveNode = clickableRow.find(isFeedSaveRibbon) ?? null;
      const commentNode = clickableRow.find(isComment) ?? null;
      const repostNode = clickableRow.find(isRepost) ?? null;
      const dmNode = clickableRow.find(isDm) ?? null;

      let comment = commentNode ? pos(commentNode) : null;
      let shareFeed = repostNode ? pos(repostNode) : null;
      let shareDm = dmNode ? pos(dmNode) : null;

      // Do not infer unlabeled action identity from horizontal position.
      // Instagram can expose the comment bubble (or a wrapper/count node)
      // without exposing the paper-plane node. In that case Share via DM
      // must remain null and be skipped rather than guessed.

      const mediaCandidates = nodes.filter(n =>
        /(?:carousel_)?media_group/.test(n.rid) &&
        n.y2 < like.y &&
        n.y2 > 0 &&
        n.x2 > n.x1 && n.y2 > n.y1,
      );
      mediaCandidates.sort((a, b) =>
        (b.x2 - b.x1) * (b.y2 - b.y1) - (a.x2 - a.x1) * (a.y2 - a.y1),
      );
      const media = mediaCandidates[0];
      const { h: actionScreenH } = getScreenSize(serial);
      const mediaToActionGap = media ? like.y - media.y2 : Number.POSITIVE_INFINITY;
      // The action row must belong to a currently visible post. A recycled
      // Like node from the previous post can remain at the top of the dump
      // while the current post's media/action row is below the viewport. If
      // there is no media immediately above this Like node, or the gap is
      // implausibly large, fail closed instead of tapping stale coordinates.
      if (!media || mediaToActionGap > actionScreenH * 0.12) {
        onLog?.(
          `View Feed a11y scan: Like node has no adjacent visible media ` +
          `(likeY=${like.y}, mediaBottom=${media?.y2 ?? "none"}, gap=${Number.isFinite(mediaToActionGap) ? mediaToActionGap : "n/a"}) — skipping`,
        );
        return null;
      }

      // The author must belong to the current post, not merely be any
      // clickable row_feed_photo_profile_name node above the action row.
      // Recycled feed/profile nodes can otherwise win this scan (including
      // the account profile control in the lower-right navigation area).
      const { w: authorScreenW } = getScreenSize(serial);
      const authorCandidates = nodes.filter(n => {
        if (!n.clickable || !n.rid.includes("row_feed_photo_profile_name") || n.y >= like.y) {
          return false;
        }
        if (media) {
          // A feed post's author header is immediately above its media and
          // occupies the same horizontal post bounds. Both values come from
          // the current accessibility dump.
          return n.y < media.y1 && n.x2 > media.x1 && n.x1 < media.x2;
        }
        // If this build omits media_group, retain only author candidates in
        // the dynamically derived central region of the device display.
        return n.x > authorScreenW * 0.15 && n.x < authorScreenW * 0.85;
      });
      // The current post's header is the author node immediately before the
      // current post media. If media is unavailable, the central-region
      // filter above prevents navigation/profile controls from being chosen.
      authorCandidates.sort((a, b) => {
        if (media) {
          const aGap = media.y1 - a.y;
          const bGap = media.y1 - b.y;
          return Math.abs(aGap) - Math.abs(bGap);
        }
        return b.y - a.y;
      });
      const authorNode = authorCandidates[0] ?? null;

      const audioCandidates = nodes.filter(n => {
        if (n.y >= like.y - 20) return false;
        if (/action_bar|like_button|comment_|share_|send_|save_/i.test(n.rid)) return false;
        return /audio|music|sound|song/i.test(n.rid) ||
          /\b(?:audio|music|song|original)\b/i.test(`${n.desc} ${n.text}`);
      });
      audioCandidates.sort((a, b) => {
        const aStrong = /audio|music|sound|song/i.test(a.rid) ? 1 : 0;
        const bStrong = /audio|music|sound|song/i.test(b.rid) ? 1 : 0;
        return bStrong - aStrong || b.y - a.y;
      });
      const audioNode = audioCandidates[0] ?? null;

      return {
        like: pos(like),
        alreadyLiked: /^unlike$/i.test(like.desc),
        comment, shareFeed, shareDm,
        save: saveNode ? pos(saveNode) : null,
        saveLabel: saveNode?.desc || saveNode?.text || "",
        author: authorNode ? { ...pos(authorNode), name: authorNode.desc || authorNode.text || "unknown" } : null,
        audio: audioNode ? pos(audioNode) : null,
        mediaBounds: media ? { x1: media.x1, y1: media.y1, x2: media.x2, y2: media.y2 } : undefined,
        isVideoPost: /SurfaceView|TextureView|VideoView|video_player|row_feed_video/.test(xml),
        xml,
      };
    };
    // Roll session scroll personality once — each run of the feed tool gets
    // its own mix so the distribution never converges to a fixed signature
    // over many sessions. Weights are relative (don't need to sum to 100).
    const feedScrollWeights = {
      superSkim: 1 + Math.floor(Math.random() * 5), skim: 10 + Math.floor(Math.random() * 16),
      fast: 40 + Math.floor(Math.random() * 36), quick: 50 + Math.floor(Math.random() * 46),
      normal: 60 + Math.floor(Math.random() * 36), slow: 75 + Math.floor(Math.random() * 21),
      focused: 75 + Math.floor(Math.random() * 26),
      tapDragRelease: 1 + Math.floor(Math.random() * 5),
      back:       Math.floor(Math.random() * 6),       // 0–5
    };
    onLog?.(`Feed scroll personality — super skim:${feedScrollWeights.superSkim} skim:${feedScrollWeights.skim} fast:${feedScrollWeights.fast} quick:${feedScrollWeights.quick} normal:${feedScrollWeights.normal} slow:${feedScrollWeights.slow} focused:${feedScrollWeights.focused} tap-drag-release:${feedScrollWeights.tapDragRelease} back:${feedScrollWeights.back}`);
    const feedPersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

    for (let i = 0; i < count; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      const feedTimingStartedAt = Date.now();
      let feedTimingAfterScroll = feedTimingStartedAt;
      let feedTimingAfterMainActions = feedTimingStartedAt;
      let feedTimingAfterSecondaryActions = feedTimingStartedAt;
      // There is no previous content on the first scroll, so a backward
      // personality would have nothing meaningful to revisit. Keep the
      // session personality distribution for later scrolls.
      const sv = rollScrollVelocity(h, feedScrollWeights, /*allowBack=*/i > 0, /*safeStartFrac=*/0.88, feedPersonalityHistory, serial);
      const feedOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[sv.mode] : undefined;
      onLog?.(`[Override] Feed swipe: mode=${sv.mode}, duration=${sv.duration}ms${feedOverride ? `, weight=${feedOverride.weightMin}-${feedOverride.weightMax}, durationRange=${feedOverride.durationMinMs}-${feedOverride.durationMaxMs}ms` : ", Mother Code default"}`);
      feedPersonalityHistory.streak = feedPersonalityHistory.lastMode === sv.mode ? feedPersonalityHistory.streak + 1 : 1;
      feedPersonalityHistory.lastMode = sv.mode;
      const feedModeLabel = sv.mode === "superSkim" ? "super skim" : sv.mode;
      onLog?.(`View Feed ${i + 1}/${count} [${feedModeLabel}]`);
      logger.info({ serial, target: "feed-scroll", mode: sv.mode, from: [x, sv.fromY], to: [x, sv.toY], durationMs: sv.duration }, "[check-feed] swipe");
      await deviceProfileSwipe(serial, { x1: x, y1: sv.fromY, x2: x, y2: sv.toY, durationMs: sv.duration }, "feed-scroll", sv.mode as any);
      await sleepOrAbort(serial, 180);

      // Roll action chances before any post-scroll inspection. A scroll-only
      // iteration must not pay for a UIAutomator dump or foreground check.
      const wantLike = likeChance > 0 && Math.random() < likeChance;
      const wantShareFeed = shareFeedChance > 0 && Math.random() < shareFeedChance;
      const wantShareDm = shareDmChance > 0 && Math.random() < shareDmChance;
      const wantSave = saveChance > 0 && Math.random() < saveChance;
      const wantExpandCaption = captionExpandChance > 0 && Math.random() < captionExpandChance;
      const wantTapAudio = tapAudioChance > 0 && Math.random() < tapAudioChance;
      const wantClickHashtag = clickHashtagChance > 0 && Math.random() < clickHashtagChance;
      const wantClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;

      // Single UI dump used for all mid-scroll sheet checks — avoids two
      // sequential dumps (comments check + interstitial scan) that together
      // could eat 5-9 s and leave an unexpected sheet open long enough to
      // auto-dismiss before we react.
      if (wantLike || wantShareFeed || wantShareDm || wantSave || wantExpandCaption) {
        const xml = await android.dumpUi(serial).catch(() => "");
        if (/Add a comment|add a comment|Comments/i.test(xml) && /EditText|class="android\.widget\.EditText"/.test(xml)) {
          // Comments sheet accidentally opened by the swipe — press Back.
          logger.warn({ serial }, "[check-feed] comments sheet opened by scroll — pressing Back to recover");
          onLog?.(`View Feed ${i + 1}/${count}: comments accidentally opened — recovering with Back`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
        } else if (xml.includes("Hide")) {
          // Post options sheet (⋮ three-dot menu) accidentally opened — press Back.
          // Do NOT run dismissInstagramInterstitials here; it would see stale
          // dismiss-label nodes while the sheet is still open and tap something
          // unintended.
          logger.warn({ serial }, "[check-feed] post options sheet ('Hide') detected mid-scroll — pressing Back to recover");
          onLog?.(`View Feed ${i + 1}/${count}: post options sheet detected — recovering with Back`);
          await android.pressBack(serial);
          await sleepOrAbort(serial, 400);
        } else {
          // No unexpected sheet — run interstitial check with the already-taken
          // dump so we don't do a second round-trip to the device.
          const midPopup = await android.dismissInstagramInterstitials(serial, xml).catch(() => null);
          if (midPopup) {
            logger.info({ serial, dismissed: midPopup }, "[check-feed] dismissed mid-scroll popup");
            onLog?.(`View Feed ${i + 1}/${count}: dismissed mid-scroll popup (${midPopup})`);
            await sleepOrAbort(serial, 400);
          }
        }
      }
      feedTimingAfterScroll = Date.now();

      if (wantLike || wantShareFeed || wantShareDm || wantSave || wantExpandCaption) {
        // This can invoke a 5-second adb dumpsys timeout on a busy device.
        // No action can have navigated away during a scroll-only iteration,
        // so defer the safety check until an action is actually going to be
        // inspected/tapped. This removes the recurring post-scroll stall on
        // iterations where every action roll missed.
        await verifyStillInInstagram();
        const feedbackCard = await android.isFeedbackOrSurveyCard(serial).catch(() => null);
        if (feedbackCard) {
          // This card replaced the post entirely — there is nothing safe to
          // tap for like/share/share-DM. Skip all three and just scroll on.
          logger.info({ serial, marker: feedbackCard }, "[check-feed] skip card detected in place of a post — skipping like/share/share-DM, scrolling past");
          onLog?.(`View Feed ${i + 1}/${count}: skip card detected ("${feedbackCard}") — skipping like/share`);
          if (wantLike) likeFailures++;
        } else {
          // Settle briefly after the scroll animation before dumping the
          // action row. The dump itself is the authoritative readiness check;
          // a long fixed wait here made every rolled action expensive.
          await sleepOrAbort(serial, 350);
          // Look up the real action-bar icons for whatever's on screen right
          // now. The Like button's presence confirms this is a normal post
          // with a normal action bar; each icon's actual position (or
          // absence — a page/profile owner can disable comments and/or
          // shares per post) is resolved fresh per post instead of assuming
          // a fixed layout. See findFeedActionIcons()'s doc comment.
          onLog?.(`View Feed ${i + 1}/${count}: scanning action bar…`);
            // View Feed is intentionally strict and isolated from the other
            // tools: sponsored cards are skipped, and a double-tap may only
            // use a media rectangle confirmed by the live node tree.
            const icons = await scanViewFeedA11y().catch(() => null);
          if (!icons) {
            // No Like button found — this isn't a normal in-feed post right
            // now (Reel suggestion, ad, still animating in from the scroll,
            // or some other card we don't specifically recognize). Skip
            // like AND share AND share-DM rather than firing share taps at
            // coordinates that assume an action bar exists.
            logger.info({ serial, target: "action-bar", matched: false }, "[check-feed] skipped like/share/share-DM — no Like button visible on screen");
            onLog?.(`View Feed ${i + 1}/${count}: no Like button visible — skipping actions (Reel/ad/animating)`);
            if (wantLike) likeFailures++;
          } else {
            const likeBtn = icons.like;
            const iconSummary = `like=(${likeBtn.x},${likeBtn.y}) comment=${icons.comment ? `(${icons.comment.x},${icons.comment.y})` : "n/a"} shareFeed=${icons.shareFeed ? `(${icons.shareFeed.x},${icons.shareFeed.y})` : "n/a"} shareDM=${icons.shareDm ? `(${icons.shareDm.x},${icons.shareDm.y})` : "n/a"}`;
            logger.info({ serial, hasComment: !!icons.comment, hasShareFeed: !!icons.shareFeed, hasShareDm: !!icons.shareDm }, "[check-feed] action-bar icons detected for this post");
            onLog?.(`View Feed ${i + 1}/${count}: action bar found — ${iconSummary}`);

            if (wantLike) {
              // `icons` was just obtained from the live tree and its Like node
              // is already structurally validated. Reusing it avoids a second
              // full UIAutomator dump for the most common Feed action.
              const likeScan = icons;
              if (!likeScan) {
                likeFailures++;
                onLog?.(`View Feed ${i + 1}/${count}: like skipped — current Like node was not confirmed`);
              } else if (likeScan.alreadyLiked) {
                onLog?.(`View Feed ${i + 1}/${count}: already liked — skipping like`);
              } else {
                // ~93 % of likes use a double-tap on the post image — the
                // natural human gesture.  The remaining ~7 % tap the heart
                // icon so the mix of input methods looks organic to
                // Instagram's telemetry.  Stories are excluded from this
                // path (they use their own accessibility-tree like button).
                // A double-tap is allowed only for a normal photo post whose
                // media rectangle was confirmed by the live node tree. Video
                // posts must use the Like node because a media double-tap
                // opens the full-screen player.
                  const useDoubleTap = Math.random() < 0.93 &&
                   !likeScan.isVideoPost &&
                    !likeScan.hasInteractiveMediaOverlay &&
                   !!likeScan.mediaBounds;
                  if (likeScan.hasInteractiveMediaOverlay) {
                    onLog?.(`View Feed ${i + 1}/${count}: interactive media overlay detected — using Like node instead of double-tap`);
                  }
                 let _likeActionSucceeded = false;
                 try {
                  if (useDoubleTap) {
                    // Place the double-tap in the upper quarter of the post
                    // image to stay clear of sponsored-post CTA banners
                    // (e.g. "Shop Now", "Install Now") that Instagram overlays
                    // near the bottom of the media area.
                    //
                    // Primary path: use the media container's real bounding
                    // box (returned by findFeedActionIcons from the same a11y
                    // dump, so no extra dump cost) and tap at a random point
                    // between 25 % and 45 % down from the top of the media.
                    //
                    // No proportional screen-coordinate fallback is allowed in
                    // View Feed. When bounds are unavailable, the branch below
                    // uses the confirmed Like node instead.
                     const mb = likeScan.mediaBounds!;
                     const mediaW = mb.x2 - mb.x1;
                     // Use only the currently visible portion of the
                     // node-confirmed media, ending just above the live Like
                     // row. A recycled container may extend outside the
                     // viewport even though its node bounds look valid.
                     const visibleY1 = Math.max(mb.y1, 0);
                     const visibleY2 = Math.min(mb.y2, likeScan.like.y - 24);
                     const mediaH = visibleY2 - visibleY1;
                    // Keep the gesture inside the node-confirmed media
                    // rectangle. A small central band avoids captions/CTA
                    // overlays while retaining natural variation.
                     const xFraction = 0.45 + Math.random() * 0.10;
                     const yFraction = 0.35 + Math.random() * 0.10;
                    const dtX = Math.round(mb.x1 + mediaW * xFraction);
                    let dtY: number;
                     dtY = Math.round(visibleY1 + mediaH * yFraction);
                    onLog?.(`View Feed ${i + 1}/${count}: double-tap using media bounds (${Math.round(xFraction * 100)}% across, ${Math.round(yFraction * 100)}% down)`);
                     logger.info({ serial, target: "image-double-tap", x: dtX, y: dtY, mediaBoundsUsed: !!likeScan.mediaBounds }, "[check-feed] double-tap like");
                    onLog?.(`View Feed ${i + 1}/${count}: double-tapping image at (${dtX},${dtY})…`);
                     await android.doubleTap(serial, dtX, dtY, (msg) => onLog?.(`  ${msg}`));
                  } else {
                    // Safe node-targeted fallback when this is a video post,
                    // the random double-tap roll misses, or the media border
                    // is not exposed by this Instagram build.
                     if (!likeScan.mediaBounds && !likeScan.isVideoPost) {
                      onLog?.(`View Feed ${i + 1}/${count}: media border not confirmed — using Like node instead of guessing a double-tap`);
                    }
                     const jx = likeScan.like.x;
                     const jy = likeScan.like.y;
                    logger.info({ serial, target: "like-button", x: jx, y: jy }, "[check-feed] heart-icon like");
                    onLog?.(`View Feed ${i + 1}/${count}: tapping heart icon at (${jx},${jy})…`);
                    await android.tap(serial, jx, jy);
                   }
                   _likeActionSucceeded = true;
                } catch {
                  likeFailures++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✗ like threw an error`);
                }
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
                const _likeStayedInInstagram = await verifyStillInInstagram();
                 if (_likeActionSucceeded && _likeStayedInInstagram) {
                  likes++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ liked`);
                 } else if (_likeActionSucceeded) {
                  likeFailures++;
                  onLog?.(`View Feed ${i + 1}/${count}: like not counted — action left Instagram and was recovered`);
                }
              }
            } else {
              onLog?.(`View Feed ${i + 1}/${count}: like roll missed (chance ${Math.round(likeChance * 100)}%) — scrolling without like`);
            }

            // Share to Feed (repost): tap the circular-arrows icon, find
            // "Repost" in the sheet via accessibility tree, tap it, then
            // dismiss the "You reposted…" confirmation popup by tapping its
            // "Close" button. Using pressBack to cancel (not a swipe) avoids
            // any chance of the gesture crossing the bottom nav bar and
            // triggering the Reels tab. `icons.shareFeed` is this post's
            // real, freshly-measured icon position — null means this post's
            // icon layout couldn't be told apart with confidence (see
            // findFeedActionIcons), so the action is skipped rather than
            // risking a tap on the wrong control (e.g. Comment).
            if (wantShareFeed) {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
              const shareFeedScan = await scanViewFeedA11y().catch(() => null);
              const shareFeedNode = shareFeedScan?.shareFeed ?? null;
              if (!shareFeedNode) {
                logger.info({ serial }, "[check-feed] skipped share-to-feed — current repost node not confirmed");
                onLog?.(`View Feed ${i + 1}/${count}: skipped repost — current share-to-feed node not confirmed`);
              } else {
              const shareFeedIconX = shareFeedNode.x, rowY = shareFeedNode.y;
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              try {
                // Capture the icon's own label before tapping — see the
                // same-name guard in runProfileBrowsingSequence for why:
                // some accounts' Instagram build reposts instantly on a
                // single tap with NO confirmation sheet, relabelling the
                // SAME icon in place (e.g. "Repost" -> "Remove
                // repost"/"Reposted") instead of showing a separate sheet
                // button. Without this check, findButtonByLabel("Repost")
                // matches that same relabelled icon via substring and this
                // code taps it AGAIN — undoing the repost it just made.
                const beforeCd = await android.getContentDescNear(serial, shareFeedIconX, rowY).catch(() => null);
                onLog?.(`View Feed ${i + 1}/${count}: tapping share-to-feed icon at (${shareFeedIconX},${rowY})…`);
                await android.tap(serial, shareFeedIconX, rowY);
                logger.info({ serial, x: shareFeedIconX, y: rowY, beforeCd }, "[check-feed] tapped share-to-feed icon");
                await sleepOrAbort(serial, 400); // wait for repost sheet

                const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
                // Use a 60 px tolerance (not 15). The action-bar icon's a11y
                // bounds-centre can shift by ~30 px between measurements due
                // to layout timing, so 15 px was too tight and caused a
                // second tap on the original icon (unsharing what was just
                // shared). A genuine sheet "Repost" button always appears at
                // screen centre (x ≈ 540+), well beyond 60 px from the icon.
                const _rDx = repostBtn ? Math.abs(repostBtn.x - shareFeedIconX) : 0;
                const _rDy = repostBtn ? Math.abs(repostBtn.y - rowY) : 0;
                const sameCoords = !!repostBtn && _rDx < 60 && _rDy < 60;
                if (sameCoords) logger.info({ serial, repostBtn, shareFeedIconX, rowY, dx: _rDx, dy: _rDy }, "[check-feed] 'Repost' node within 60 px of icon — treated as same icon (single-tap path)");
                if (repostBtn && !sameCoords) {
                  onLog?.(`View Feed ${i + 1}/${count}: Repost sheet opened — tapping Repost at (${repostBtn.x},${repostBtn.y})…`);
                  await android.tap(serial, repostBtn.x, repostBtn.y);
                  logger.info({ serial }, "[check-feed] tapped Repost in sheet");
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
                  // "You reposted X's post" popup appears after the first
                  // repost — find its blue "Close" button via accessibility
                  // tree and tap it.
                  const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
                  if (closeBtn) {
                    await android.tap(serial, closeBtn.x, closeBtn.y);
                    logger.info({ serial }, "[check-feed] dismissed repost confirmation popup (Close)");
                    onLog?.(`View Feed ${i + 1}/${count}: dismissed "You reposted" popup`);
                    await sleepOrAbort(serial, 150);
                  }
                  sharesFeed++;
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ reposted to feed (total reposts: ${sharesFeed})`);
                } else if (sameCoords) {
                  // The a11y tree returned a "Repost"-labelled node at the same
                  // position as the icon we just tapped (single-tap repost path
                  // — no confirmation sheet). Don't re-check whether the label
                  // changed: the tree dump is unreliable (~90% false-negatives
                  // reported), so we accept the tap as-is regardless of what the
                  // dump says happened afterward. Do NOT press Back — that
                  // navigates away from the feed.
                  logger.info({ serial, beforeCd }, "[check-feed] sameCoords repost tap accepted without label re-check");
                  onLog?.(`View Feed ${i + 1}/${count}: repost tapped (single-tap path, no sheet check)`);
                  sharesFeed++;
                } else {
                  // No Repost button found in the dump after the tap. The dump is
                  // unreliable; the repost sheet may have opened and been dismissed
                  // before the dump ran, or the button may be outside the capture
                  // window. Accept the tap and continue — do NOT press Back.
                  logger.info({ serial }, "[check-feed] no Repost-labelled node found after tap — accepting tap, not pressing Back");
                  onLog?.(`View Feed ${i + 1}/${count}: repost tap sent (sheet not confirmed in dump — continuing)`);
                }
                await verifyStillInInstagram();
              } catch (e: any) { if (e?.message === "cycle-aborted") throw e; /* else non-fatal */ }
              }
            }

            // Share via DM: tap the paper-plane icon to open the DM picker,
            // then close it with Back (registers the share-intent tap in a
            // human-looking way without needing to know a recipient).
            // pressBack is intentional — a swipe-dismiss risks crossing the
            // bottom nav bar and accidentally triggering the Reels tab.
            // `icons.shareDm` is this post's real, freshly-measured icon
            // position — null means it couldn't be identified with
            // confidence (disabled by the poster, or ambiguous layout — see
            // findFeedActionIcons), so the action is skipped.
            if (wantShareDm) {
              // ── View Feed — Share via DM (isolated; not shared with any other tool) ──
              const _cfPfx = `View Feed ${i + 1}/${count}`;
              let _cfDmSent = false;
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                const dmScan = await scanViewFeedA11y().catch(() => null);
                const dmNode = dmScan?.shareDm ?? null;
                if (!dmNode) {
                  onLog?.(`${_cfPfx}: share aborted — current paper-plane node not confirmed`);
                  await verifyStillInInstagram();
                } else {
                onLog?.(`${_cfPfx}: tapping share-via-DM icon at (${dmNode.x},${dmNode.y})…`);
                await android.tap(serial, dmNode.x, dmNode.y);
             await sleepOrAbort(serial, 1500 + Math.floor(Math.random() * 3501));
                onLog?.(`${_cfPfx}: confirming share sheet opened and picking DM recipient…`);
                let _cfScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                if (!_cfScan?.sheetOpen) {
                  onLog?.(`${_cfPfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                  await sleepOrAbort(serial, 1500);
                  _cfScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                }
                if (!_cfScan?.sheetOpen) {
                  logger.warn({ serial }, "[check-feed] share sheet not confirmed open after retry — closing and skipping DM");
                  onLog?.(`${_cfPfx}: share aborted — share sheet did not open`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 200);
                } else {
                  const _cfSendBtn0 = _cfScan.sendBtn ?? null;
                  if (_cfScan.preSelectedRecipients && _cfScan.preSelectedRecipients.length > 0) {
                    onLog?.(`${_cfPfx}: deselecting ${_cfScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
                    for (const _r of _cfScan.preSelectedRecipients) {
                      onLog?.(`${_cfPfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                      await android.tap(serial, _r.x, _r.y);
                      await sleepOrAbort(serial, 400);
                    }
                  }
                  const _cfRecipients = _cfScan.recipients ?? [];
                  if (_cfRecipients.length === 0) {
                    await android.pressBack(serial);
                    logger.warn({ serial }, "[check-feed] no recipient found — closed share sheet without sending");
                    onLog?.(`${_cfPfx}: share skipped — no recipient avatars found (closed without sending)`);
                  } else {
                    const _cfLast = _viewFeedLastDmRecipient.get(serial);
                    const _cfPool = _cfLast ? _cfRecipients.filter(r => !(r.x === _cfLast.x && r.y === _cfLast.y)) : _cfRecipients;
                    const _cfCands = _cfPool.length > 0 ? _cfPool : _cfRecipients;
                    const _cfPick = _cfCands[Math.floor(Math.random() * _cfCands.length)];
                    _viewFeedLastDmRecipient.set(serial, { x: _cfPick.x, y: _cfPick.y });
                    onLog?.(`${_cfPfx}: tapping recipient at (${_cfPick.x},${_cfPick.y})${(_cfPick as any).name ? ` (${(_cfPick as any).name})` : ""}`);
                    await android.tap(serial, _cfPick.x, _cfPick.y);
                    await sleepOrAbort(serial, 800);
                    const _cfIsOpen = async () => {
                      const _x = await android.dumpUi(serial).catch(() => "");
                      // "Add to story" removed — the home feed's story tray has
                      // desc="Add to story" on the reel badge, so it's present in the
                      // tree even after the share sheet closes, causing a false-positive
                      // that made the code think the sheet was still open and press Back.
                      return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                             _x.includes("android.widget.EditText") || _x.includes("Copy link");
                    };
                    // Always fresh lookup after recipient tap — direct_send_button_multi_select
                    // only appears once a recipient is selected, so _cfSendBtn0 (from the
                    // pre-selection scan) is stale and points to the wrong element.
                    const _cfSb = await android.findButtonByLabel(serial, "Send").catch(() => null);
                    if (_cfSb) {
                      await android.tap(serial, _cfSb.x, _cfSb.y);
                      // 1500ms — sheet animates closed after Send; 300ms was too
                      // short, sheet still visible at check time, code pressed Back
                      // and cancelled the DM (confirmed from dump 16 Jul 2026).
                      await sleepOrAbort(serial, 1500);
                      if (!(await _cfIsOpen())) {
                        _cfDmSent = true;
                        logger.info({ serial }, "[check-feed] shared post via DM — Send tapped");
                        onLog?.(`${_cfPfx}: ✓ shared via DM — Send tapped`);
                        await sleepOrAbort(serial, 300);
                      } else {
                        logger.info({ serial }, "[check-feed] Send tapped but sheet still open — pressing Back to close");
                        onLog?.(`${_cfPfx}: Send tapped but share sheet still open after wait — pressing Back`);
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    } else if (!(await _cfIsOpen())) {
                      _cfDmSent = true;
                      logger.info({ serial }, "[check-feed] share sheet already closed — DM likely sent by recipient tap");
                      onLog?.(`${_cfPfx}: ✓ shared via DM — sheet auto-dismissed (sent by recipient tap)`);
                      await sleepOrAbort(serial, 200);
                    } else {
                      // Never guess the Send position in View Feed.  The
                      // sheet is still open, so close it and fail closed.
                      onLog?.(`${_cfPfx}: Send node not found via accessibility — closing without sending`);
                      await android.pressBack(serial);
                      await sleepOrAbort(serial, 200);
                    }
                  }
                }
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`${_cfPfx}: share-via-DM error — ${e?.message}`);
              }
                if (_cfDmSent) sharesDm++;
              await verifyStillInInstagram();
            }

            // ── Save Post (bookmark / ribbon icon) ────────────────────────
            // Taps the ribbon icon (row_feed_button_save / "Add to Saved")
            // identified by findFeedActionIcons. After the tap Instagram
            // shows a small "Save to collection?" bottom sheet. We dismiss
            // it with a tap in the top-25% of the screen — far above any
            // collection UI — which is safe on every layout because
            // Instagram never puts any interactive control in that region
            // while the sheet is open.
            if (wantSave) {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 200 + Math.round(Math.random() * 200));
              const saveScan = await scanViewFeedA11y().catch(() => null);
              const _saveBtn = saveScan?.save ?? null;
              if (!saveScan || !_saveBtn) {
                logger.info({ serial }, "[check-feed] save button not found on this post — skipping save");
                onLog?.(`View Feed ${i + 1}/${count}: save skipped — ribbon icon not found on this post`);
              } else if (/remove from saved/i.test(saveScan.saveLabel)) {
                onLog?.(`View Feed ${i + 1}/${count}: already saved — skipping save`);
              } else {
                try {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  onLog?.(`View Feed ${i + 1}/${count}: tapping save (ribbon) icon at (${_saveBtn.x},${_saveBtn.y})…`);
                  await android.tap(serial, _saveBtn.x, _saveBtn.y);
                 await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
                  // Instagram may show a "Collect the posts you love" bottom
                  // sheet on accounts with no existing collections.  Detect it
                  // with a fresh dump and dismiss it by tapping the transparent
                  // background_dimmer above the sheet (top 12% of screen).
                  // The dump is skipped when the sheet isn't present — the
                  // timeout is rare and acceptable on the save path.
                  let _fsSaveXml = await android.dumpUi(serial).catch(() => "");
                  if (_fsSaveXml.includes('pinned_save_row') || _fsSaveXml.includes('Collect the posts you love')) {
                    // The sheet must be dismissed through its own live
                    // accessibility node.  Never tap a screen-relative
                    // "safe" coordinate in View Feed.
                    let _fsDismissed = false;
                    for (const _fsSeg of _fsSaveXml.split("<node ")) {
                      const _fsRid = (_fsSeg.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
                      const _fsDesc = (_fsSeg.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
                      if (
                        !_fsSeg.includes('clickable="true"') ||
                        !/background_dimmer|scrim|dismiss/i.test(`${_fsRid} ${_fsDesc}`)
                      ) continue;
                      const _fsBb = _fsSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                      if (!_fsBb) continue;
                      const _fsX = Math.floor((Number(_fsBb[1]) + Number(_fsBb[3])) / 2);
                      const _fsY = Math.floor((Number(_fsBb[2]) + Number(_fsBb[4])) / 2);
                      await android.tap(serial, _fsX, _fsY);
                      _fsDismissed = true;
                      onLog?.(`View Feed ${i + 1}/${count}: dismissed "Save to collection?" via accessibility dimmer node`);
                      await sleepOrAbort(serial, 300);
                      break;
                    }
                    if (!_fsDismissed) {
                      onLog?.(`View Feed ${i + 1}/${count}: save sheet detected but no dismiss node was confirmed — leaving it closed with Back`);
                      await android.pressBack(serial);
                      await sleepOrAbort(serial, 300);
                    }
                    _fsSaveXml = await android.dumpUi(serial).catch(() => "");
                  }
                  const _saveStayedInInstagram = await verifyStillInInstagram();
                  const _saveAfter = await scanViewFeedA11y().catch(() => null);
                  const _saveConfirmed = /remove from saved/i.test(_saveAfter?.saveLabel ?? "");
                  if (_saveStayedInInstagram && _saveConfirmed) {
                    saves++;
                    logger.info({ serial }, "[check-feed] saved post via ribbon icon");
                    onLog?.(`View Feed ${i + 1}/${count}: ✓ post saved`);
                  } else if (_saveStayedInInstagram) {
                    onLog?.(`View Feed ${i + 1}/${count}: save tap completed but saved state was not confirmed — not counted`);
                  } else {
                    onLog?.(`View Feed ${i + 1}/${count}: save not counted — action left Instagram and was recovered`);
                  }
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  onLog?.(`View Feed ${i + 1}/${count}: save error — ${e?.message}`);
                }
              }
            }

            // ── Expand Caption ──────────────────────────────────────────
            // Taps the truncated-caption "more" link to expand it in place.
            // Instagram renders this as a TextView; its text attribute is
            // "more" (exact, lowercase).  Some builds also set content-desc
            // to the same value.  We check both so either attribute works.
            // "More actions for this post" (the ⋮ button) won't match because
            // it's a longer phrase — the contains() check is safe.
            // Uses its own fresh dump so it works independently of the
            // action-bar scan above.
            //
            // IMPORTANT: must also require class="android.widget.TextView".
            // Sponsored posts render a full-width CTA button ("Visit Instagram
            // profile", "Learn More", etc.) that can carry content-desc="more"
            // in Instagram's a11y tree.  That button is class="android.widget.Button"
            // — not a TextView — and tapping it opens the advertiser's profile
            // within Instagram (same package, so verifyStillInInstagram() won't
            // catch it), breaking every subsequent action in the cycle.
            if (wantExpandCaption) {
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _ecXml = await android.dumpUi(serial).catch(() => "");
                // Split on '<node ' and check each segment for text="more"
                // OR content-desc="more" (exact, lowercase in both cases).
                // Using includes() instead of regex avoids backslash issues
                // and is immune to attribute ordering variations.
                // Also require class="android.widget.TextView" — caption "more"
                // links are always TextViews; sponsored-post CTA buttons are
                // android.widget.Button and must be excluded.
                let _ecTapped = false;
                for (const _ecSeg of _ecXml.split("<node ")) {
                  if (_ecTapped) break;
                  // Instagram renders the truncated-caption link as text="more"
                  // on most builds, but some versions capitalise it as "More".
                  // Lower-case the segment for the attribute check so both pass.
                  // The original segment is still used for bounds extraction.
                  const _ecLower = _ecSeg.toLowerCase();
                  const _hasMoreText = _ecLower.includes('text="more"');
                  const _hasMoreDesc = _ecLower.includes('content-desc="more"');
                  if (!_hasMoreText && !_hasMoreDesc) continue;
                  // Reject CTA buttons on sponsored posts — they are Buttons, not TextViews.
                  if (!_ecLower.includes('class="android.widget.textview"')) continue;
                  const _ecBb = _ecSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                  if (!_ecBb) continue;
                  const _ecX = Math.round((parseInt(_ecBb[1]) + parseInt(_ecBb[3])) / 2);
                  const _ecY = Math.round((parseInt(_ecBb[2]) + parseInt(_ecBb[4])) / 2);
                  onLog?.(`View Feed ${i + 1}/${count}: tapping caption "more" at (${_ecX},${_ecY}) [matched via ${_hasMoreText ? "text" : "content-desc"}]`);
                  await android.tap(serial, _ecX, _ecY);
                  await verifyStillInInstagram();
                  // Dwell after expanding — simulate reading the caption.
                  // 2–10 s, rolled fresh each time so the duration looks human.
                  const _ecDwellMs = 2000 + Math.round(Math.random() * 8000);
                  onLog?.(`View Feed ${i + 1}/${count}: ✓ caption expanded — dwelling ${(_ecDwellMs / 1000).toFixed(1)}s`);
                  await sleepOrAbort(serial, _ecDwellMs);
                  captionExpands++;
                  _ecTapped = true;
                }
                if (!_ecTapped) {
                  onLog?.(`View Feed ${i + 1}/${count}: caption "more" not visible — skipping expand`);
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`View Feed ${i + 1}/${count}: expand caption error — ${e?.message}`);
              }
            }
          }
        }
      } else {
        onLog?.(`View Feed ${i + 1}/${count}: no actions rolled this scroll`);
      }
      feedTimingAfterMainActions = Date.now();

      // ── Tap Audio (music/song page) — independent of action bar ──────
      // On posts that carry an audio affordance (rotating disc icon at the
      // bottom-left of the media), tapping it opens the song's page — a
      // grid of other posts using the same track.  We scroll that grid
      // briefly and return to the feed with Back.  The roll is skipped
      // silently when no audio affordance is detectable on the current post.
      // The Meta Edits promotional popup ("Level up your edits") is dismissed
      // with one Back press; if a second tap still triggers it the roll is
      // aborted cleanly.  No retry loops — per-project rules.
      if (wantTapAudio) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          await sleepOrAbort(serial, 300);
          const _atScan = await scanViewFeedA11y().catch(() => null);
          const _atNode = _atScan?.audio ?? null;

          if (!_atNode) {
            onLog?.(`View Feed ${i + 1}/${count}: tap-audio rolled but no audio affordance on this post — skipping`);
          } else {
            onLog?.(`View Feed ${i + 1}/${count}: tapping audio affordance at (${_atNode.x},${_atNode.y})…`);
            await android.tap(serial, _atNode.x, _atNode.y);
             await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
            await verifyStillInInstagram();

            const _atXml2 = await android.dumpUi(serial).catch(() => "");
            let _atOnSongPage = false;

            if (_atXml2.toLowerCase().includes("level up")) {
              // Meta Edits promotional popup — dismiss and try once more.
              onLog?.(`View Feed ${i + 1}/${count}: Meta Edits popup detected — dismissing and retrying…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
              await android.tap(serial, _atNode.x, _atNode.y);
               await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
              await verifyStillInInstagram();
              const _atXml3 = await android.dumpUi(serial).catch(() => "");
              if (_atXml3.toLowerCase().includes("level up")) {
                onLog?.(`View Feed ${i + 1}/${count}: Meta Edits popup still showing after retry — aborting audio tap`);
                await android.pressBack(serial);
                 await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
              } else {
                _atOnSongPage = true;
              }
            } else if (_atXml2.toLowerCase().includes("view song details")) {
              // Bottom sheet — tap "View song details" to proceed to the page.
              onLog?.(`View Feed ${i + 1}/${count}: "View song details" sheet detected — tapping…`);
              let _atSheetTapped = false;
              for (const _atSeg2 of _atXml2.split("<node ")) {
                const _atT2 = (_atSeg2.match(/\btext="([^"]*)"/) ?? [])[1] ?? "";
                const _atD2 = (_atSeg2.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
                if (!(_atT2.toLowerCase().includes("view song details") || _atD2.toLowerCase().includes("view song details"))) continue;
                const _atBb2 = _atSeg2.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!_atBb2) break;
                const _atX2 = Math.round((parseInt(_atBb2[1]) + parseInt(_atBb2[3])) / 2);
                const _atY2 = Math.round((parseInt(_atBb2[2]) + parseInt(_atBb2[4])) / 2);
                onLog?.(`View Feed ${i + 1}/${count}: tapping "View song details" at (${_atX2},${_atY2})…`);
                await android.tap(serial, _atX2, _atY2);
                 await sleepOrAbort(serial, 1200 + Math.floor(Math.random() * 3801));
                await verifyStillInInstagram();
                _atOnSongPage = true;
                _atSheetTapped = true;
                break;
              }
              if (!_atSheetTapped) {
                // Sheet visible but couldn't resolve the node — press Back.
                onLog?.(`View Feed ${i + 1}/${count}: "View song details" node not found in sheet — pressing Back`);
                await android.pressBack(serial);
                   await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
              }
            } else {
              // Navigated directly to the song/audio page.
              _atOnSongPage =
                _atXml2.includes("audio_page") ||
                _atXml2.includes("music_page") ||
                _atXml2.includes("clips_audio") ||
                _atXml2.includes("audio_browser") ||
                /song|original audio|music/i.test(_atXml2);
              if (!_atOnSongPage) {
                onLog?.(`View Feed ${i + 1}/${count}: audio tap did not open a confirmed song page — pressing Back`);
                await android.pressBack(serial);
                await sleepOrAbort(serial, 400);
              }
            }

            if (_atOnSongPage) {
              // Scroll the song grid 1–20 times with a 1–10% per-scroll tap chance.
              const _atScrolls = 1 + Math.floor(Math.random() * 20);
              const _atTapChance = 0.01 + Math.random() * 0.09; // 1–10%
              onLog?.(`View Feed ${i + 1}/${count}: on song page — scrolling ${_atScrolls}x (tap chance ${Math.round(_atTapChance * 100)}%)…`);
              const { w: _atW, h: _atH } = getScreenSize(serial);
              let _atDidTap = false;
              for (let _atS = 0; _atS < _atScrolls; _atS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _atSY1 = Math.round(_atH * 0.75);
                const _atSY2 = Math.round(_atH * 0.30);
                const _atSX  = Math.round(_atW / 2);
                const _atDur = 300 + Math.round(Math.random() * 400);
                await deviceProfileSwipe(serial, { x1: _atSX, y1: _atSY1, x2: _atSX, y2: _atSY2, durationMs: _atDur }, "feed-audio-profile-scroll");
                 await sleepOrAbort(serial, 280 + Math.floor(Math.random() * 4721));
                if (!_atDidTap && Math.random() < _atTapChance) {
                  // Tap a random clickable item in the content area.
                  const _atGXml = await android.dumpUi(serial).catch(() => "");
                  const _atItems: { x: number; y: number }[] = [];
                  for (const _atGSeg of _atGXml.split("<node ")) {
                    const _atGBb = _atGSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!_atGBb) continue;
                    const _gX = Math.round((parseInt(_atGBb[1]) + parseInt(_atGBb[3])) / 2);
                    const _gY = Math.round((parseInt(_atGBb[2]) + parseInt(_atGBb[4])) / 2);
                    // Only items in the main content zone — skip top nav / bottom nav.
                    if (_gY > _atH * 0.12 && _gY < _atH * 0.92) _atItems.push({ x: _gX, y: _gY });
                  }
                  if (_atItems.length > 0) {
                    const _atPicked = _atItems[Math.floor(Math.random() * _atItems.length)];
                    onLog?.(`View Feed ${i + 1}/${count}: song-page tap at (${_atPicked.x},${_atPicked.y})…`);
                    await android.tap(serial, _atPicked.x, _atPicked.y);
                     await sleepOrAbort(serial, 1000 + Math.floor(Math.random() * 4001));
                    await verifyStillInInstagram();
                    // Press Back once to return from the post (or wherever the tap landed).
                    await android.pressBack(serial);
                     await sleepOrAbort(serial, 600 + Math.floor(Math.random() * 4401));
                    await verifyStillInInstagram();
                    _atDidTap = true;
                    break; // stop scrolling after a tap
                  }
                }
              }
              // Return to the feed — one Back press from the song/audio page.
              onLog?.(`View Feed ${i + 1}/${count}: returning from song page…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              audioTaps++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ audio page visited`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: tap-audio error — ${e?.message}`);
        }
      }

      // ── Click Hashtag (browse hashtag grid page) ─────────────────────
      // Finds hashtag buttons in the visible caption, taps one at random
      // to open the hashtag grid page, scrolls 1–10 times, and has a
      // 1–10% per-scroll chance to tap a random post on the grid.
      // If a post was tapped, presses Back twice (post → grid → feed);
      // otherwise presses Back once (grid → feed).
      // The roll is skipped when no hashtag buttons are visible (only
      // the audio tap runs on posts that have hashtags, not all posts do).
      if (wantClickHashtag) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          await sleepOrAbort(serial, 300);
          const _chXml = await android.dumpUi(serial).catch(() => "");
          // Collect hashtag button nodes from the caption area — they are
          // android.widget.Button elements whose content-desc starts with '#'.
          // Exclude the action bar (like/comment/share) and non-caption nodes
          // by checking the '#' prefix on the desc attribute.
          const _chHashtags: { x: number; y: number; tag: string }[] = [];
          for (const _chSeg of _chXml.split("<node ")) {
            const _chDesc = (_chSeg.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
            if (!_chDesc.startsWith("#")) continue;
            const _chClass = (_chSeg.match(/class="([^"]*)"/) ?? [])[1] ?? "";
            // Only Button nodes — a11y assigns class Button to caption hashtag links.
            if (!_chClass.includes("Button")) continue;
            const _chBb = _chSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!_chBb) continue;
            const _chX = Math.round((parseInt(_chBb[1]) + parseInt(_chBb[3])) / 2);
            const _chY = Math.round((parseInt(_chBb[2]) + parseInt(_chBb[4])) / 2);
            // Only nodes in the caption area — below the action bar (> 40% height).
            if (_chY < h * 0.40) continue;
            _chHashtags.push({ x: _chX, y: _chY, tag: _chDesc });
          }

          if (_chHashtags.length === 0) {
            onLog?.(`View Feed ${i + 1}/${count}: click-hashtag rolled but no hashtag buttons visible — skipping`);
          } else {
            const _chPick = _chHashtags[Math.floor(Math.random() * _chHashtags.length)];
            onLog?.(`View Feed ${i + 1}/${count}: tapping hashtag "${_chPick.tag}" at (${_chPick.x},${_chPick.y})…`);
            await android.tap(serial, _chPick.x, _chPick.y);
            await sleepOrAbort(serial, 1500, "accountSwitching");
            await verifyStillInInstagram();

            // Confirm we arrived at the hashtag grid — look for the grid card layout.
            const _chGridXml = await android.dumpUi(serial).catch(() => "");
            const _chOnGrid = _chGridXml.includes("grid_card_layout_container") ||
              _chGridXml.includes("tabbed_pager") ||
              _chGridXml.includes("swipeable_tab_view_pager");

            if (!_chOnGrid) {
              onLog?.(`View Feed ${i + 1}/${count}: hashtag grid not confirmed — pressing Back and continuing`);
              await android.pressBack(serial);
              await sleepOrAbort(serial, 600);
            } else {
              // Scroll the hashtag grid 1–10 times; 1–10% per-scroll tap chance.
              const _chScrolls = 1 + Math.floor(Math.random() * 10);
              const _chTapChance = 0.01 + Math.random() * 0.09; // 1–10%
              onLog?.(`View Feed ${i + 1}/${count}: on hashtag grid "${_chPick.tag}" — scrolling ${_chScrolls}x (tap chance ${Math.round(_chTapChance * 100)}%)…`);
              const { w: _chW, h: _chH } = getScreenSize(serial);
              let _chDidTapPost = false;
              for (let _chS = 0; _chS < _chScrolls; _chS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _chSY1 = Math.round(_chH * 0.75);
                const _chSY2 = Math.round(_chH * 0.30);
                const _chSX  = Math.round(_chW / 2);
                const _chDur = 300 + Math.round(Math.random() * 400);
                await deviceProfileSwipe(serial, { x1: _chSX, y1: _chSY1, x2: _chSX, y2: _chSY2, durationMs: _chDur }, "feed-hashtag-profile-scroll");
                 await sleepOrAbort(serial, 280 + Math.floor(Math.random() * 4721));
                if (!_chDidTapPost && Math.random() < _chTapChance) {
                  // Tap a random grid post using the grid_card_layout_container nodes.
                  const _chPXml = await android.dumpUi(serial).catch(() => "");
                  const _chPosts: { x: number; y: number }[] = [];
                  for (const _chPSeg of _chPXml.split("<node ")) {
                    const _chRid = (_chPSeg.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
                    // Match grid card or image_button nodes inside the grid.
                    if (!_chRid.includes("grid_card_layout_container") && !_chRid.includes("image_button")) continue;
                    const _chPBb = _chPSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                    if (!_chPBb) continue;
                    const _chPX = Math.round((parseInt(_chPBb[1]) + parseInt(_chPBb[3])) / 2);
                    const _chPY = Math.round((parseInt(_chPBb[2]) + parseInt(_chPBb[4])) / 2);
                    // Stay within the main content zone — skip nav bars.
                    if (_chPY > _chH * 0.10 && _chPY < _chH * 0.92) _chPosts.push({ x: _chPX, y: _chPY });
                  }
                  if (_chPosts.length > 0) {
                    const _chPostPick = _chPosts[Math.floor(Math.random() * _chPosts.length)];
                    onLog?.(`View Feed ${i + 1}/${count}: tapping grid post at (${_chPostPick.x},${_chPostPick.y})…`);
                    await android.tap(serial, _chPostPick.x, _chPostPick.y);
                     await sleepOrAbort(serial, 1200 + Math.floor(Math.random() * 3801));
                    await verifyStillInInstagram();
                    // Press Back once to return from the post to the hashtag grid.
                    await android.pressBack(serial);
                     await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
                    await verifyStillInInstagram();
                    _chDidTapPost = true;
                    break; // stop scrolling after a tap
                  }
                }
              }
              // Return to the feed — one Back press from the hashtag grid.
              onLog?.(`View Feed ${i + 1}/${count}: returning from hashtag grid…`);
              await android.pressBack(serial);
               await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              hashtagTaps++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ hashtag grid visited (${_chPick.tag}${_chDidTapPost ? ", tapped a post" : ""})`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: click-hashtag error — ${e?.message}`);
        }
      }

      // ── Click Author (visit post author's profile) ───────────────────
      // Taps row_feed_photo_profile_name — the author name label that sits
      // immediately to the right of the avatar bubble in every feed post
      // header.  Present on single-author posts and collab posts alike
      // (collabs show both names combined; the tap opens the first-listed
      // author's profile, which is the one visually beside the avatar ring).
      // Once on the profile, scrolls 1–10 times then presses Back to return.
      if (wantClickAuthor) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
           await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
          const _caScan = await scanViewFeedA11y().catch(() => null);
          const _caNode = _caScan?.author ?? null;
          if (!_caNode) {
            onLog?.(`View Feed ${i + 1}/${count}: click-author rolled but no profile name button visible — skipping`);
          } else {
            onLog?.(`View Feed ${i + 1}/${count}: tapping author "${_caNode.name}" at (${_caNode.x},${_caNode.y})…`);
            await android.tap(serial, _caNode.x, _caNode.y);
             await sleepOrAbort(serial, 1500 + Math.floor(Math.random() * 3501));
            await verifyStillInInstagram();
            // Post-tap verification — dump the UI and confirm we actually
            // landed on a profile page before doing anything else.
            // Without this the code stamps log entries as if everything is
            // working even when the tap missed (stale node coords, feed was
            // still animating, etc.).
            // A profile page always has at least one of: Follow / Following /
            // Unfollow / Message buttons, a profile_header node, or an
            // action_bar_title node.  If none are present the feed is still
            // on screen — the tap went astray.
            const _caChkXml = await android.dumpUi(serial).catch(() => "");
            const _caOnProfile =
              _caChkXml.includes('text="Follow"')    || _caChkXml.includes('content-desc="Follow"') ||
              _caChkXml.includes('text="Following"') || _caChkXml.includes('content-desc="Following"') ||
              _caChkXml.includes('text="Unfollow"')  || _caChkXml.includes('content-desc="Unfollow"') ||
              _caChkXml.includes('text="Message"')   || _caChkXml.includes('content-desc="Message"') ||
              _caChkXml.includes('profile_header')   ||
              _caChkXml.includes('action_bar_title');
            if (!_caOnProfile) {
              onLog?.(`View Feed ${i + 1}/${count}: click-author — tap did not open a profile (feed still visible) — skipping`);
            } else {
              // Confirmed on profile — scroll it.
              const _caScrolls = 1 + Math.floor(Math.random() * 3);
              onLog?.(`View Feed ${i + 1}/${count}: on author profile "${_caNode.name}" — scrolling ${_caScrolls}x…`);
              const { w: _caW, h: _caH } = getScreenSize(serial);
              for (let _caS = 0; _caS < _caScrolls; _caS++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                const _caSY1 = Math.round(_caH * 0.75);
                const _caSY2 = Math.round(_caH * 0.30);
                const _caDur = 350 + Math.round(Math.random() * 350);
                await deviceProfileSwipe(serial, { x1: Math.round(_caW / 2), y1: _caSY1, x2: Math.round(_caW / 2), y2: _caSY2, durationMs: _caDur }, "feed-author-profile-scroll");
                const _caRenderWaitMs = 2500 + Math.round(Math.random() * 7500);
                await sleepOrAbort(serial, _caRenderWaitMs);
              }
              // Return to the feed — one Back press from the author's profile.
              onLog?.(`View Feed ${i + 1}/${count}: returning from author profile…`);
              await android.pressBack(serial);
                 await sleepOrAbort(serial, 700 + Math.floor(Math.random() * 4301));
              await verifyStillInInstagram();
              authorVisits++;
              onLog?.(`View Feed ${i + 1}/${count}: ✓ author profile visited (${_caNode.name})`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Feed ${i + 1}/${count}: click-author error — ${e?.message}`);
        }
      }

      feedTimingAfterSecondaryActions = Date.now();

      if (i < count - 1) {
        const feedTimingBeforeConfiguredDelay = Date.now();
        const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
        await sleepOrAbort(serial, Math.round(delaySec * 1000));
        const feedTimingEndedAt = Date.now();
        onLog?.(
          `View Feed ${i + 1}/${count} timing — ` +
          `scroll+safety=${((feedTimingAfterScroll - feedTimingStartedAt) / 1000).toFixed(1)}s, ` +
          `main-actions=${((feedTimingAfterMainActions - feedTimingAfterScroll) / 1000).toFixed(1)}s, ` +
          `secondary-actions=${((feedTimingAfterSecondaryActions - feedTimingAfterMainActions) / 1000).toFixed(1)}s, ` +
          `configured-delay=${((feedTimingEndedAt - feedTimingBeforeConfiguredDelay) / 1000).toFixed(1)}s, ` +
          `total=${((feedTimingEndedAt - feedTimingStartedAt) / 1000).toFixed(1)}s`,
        );
      } else {
        const feedTimingEndedAt = Date.now();
        onLog?.(
          `View Feed ${i + 1}/${count} timing — ` +
          `scroll+safety=${((feedTimingAfterScroll - feedTimingStartedAt) / 1000).toFixed(1)}s, ` +
          `main-actions=${((feedTimingAfterMainActions - feedTimingAfterScroll) / 1000).toFixed(1)}s, ` +
          `secondary-actions=${((feedTimingAfterSecondaryActions - feedTimingAfterMainActions) / 1000).toFixed(1)}s, ` +
          `configured-delay=0.0s, ` +
          `total=${((feedTimingEndedAt - feedTimingStartedAt) / 1000).toFixed(1)}s`,
        );
      }
    }
    if (strayNavRecoveries > 0) {
      logger.warn({ serial, strayNavRecoveries }, "[check-feed] recovered from stray navigation (ad CTA) during this run");
      onLog?.(`⚠ Recovered from ${strayNavRecoveries} stray navigation(s) — likely tapped an ad CTA during scroll`);
    }
    return { count, likes, likeFailures, sharesFeed, sharesDm, saves, captionExpands, strayNavRecoveries, audioTaps, hashtagTaps, authorVisits };
  }

  // View stories from the stories bar at the top of the feed.
  // Opens the first story, watches N slides per user (each for a randomly
  // chosen % of the typical slide duration), then advances to the next user.
  /**
   * Picks and opens one story bubble from the tray using a single "hold and
   * slide right" drag rather than a plain tap. Always tapping the same
   * fixed spot (the first real story) creates a detectable pattern, so
   * instead this presses down on the tray and drags right to a *randomly
   * chosen* bubble, releasing there to open it.
   *
   * Per user confirmation, the story tray after tapping the Home tab sits
   * top-central and is a thin band — only ~15px tall on their device — so
   * accuracy on Y matters more than on X. An earlier version of this
   * function first did a *separate* swipe to scroll the tray when the
   * target bubble (1-10) wasn't yet on screen, then a second swipe to do
   * the actual pick — that two-gesture chain is almost certainly what
   * landed on the Reels tab instead: two independent `input swipe` calls
   * starting very close to the top of the screen can each be misread as
   * unrelated gestures (e.g. a stray edge/notification gesture) rather than
   * one continuous scrub. Fixed by doing exactly ONE gesture, clamped to
   * whatever bubbles are actually visible on screen (no separate
   * pre-scroll), which is simpler and much less likely to be misread.
   *
   * Returns the 1-based position that was opened (for logging only).
   */
  async function pickAndOpenRandomStory(serial: string, w: number, h: number, onLog?: (msg: string) => void): Promise<{ slot: number; opened: boolean }> {
    // ── Find story bubbles directly from UIAutomator dump ──
    //
    // Every story bubble in the home-feed tray carries a content-desc of the
    // form "<username>'s story" (Instagram sets this on the avatar ImageView or
    // its parent FrameLayout). We parse the dump, collect ALL such nodes, and
    // tap their exact centre coordinates — no hardcoded percentages, no spacing
    // math, no device-specific calibration. This works identically on every
    // phone in the farm regardless of screen size, resolution, or DPI.
    //
    // Tap strategy:
    //   • Try slot 1 (first friend) first — real friends are always sorted
    //     before "Suggested" tiles, so slot 1 is the least likely to be a
    //     suggested-account chip that would dismiss rather than open.
    //   • If slot 1 fails, try up to 2 more randomly-ordered slots.
    //   • X and Y use the exact centre from the live accessibility node.
    //     Do not offset the tap toward a guessed "safe" area: that can land
    //     on an adjacent control or the bottom navigation.

    // Parse a UIAutomator XML dump and extract story-tray bubble nodes.
    // Returns every node whose content-desc or resource-id indicates a story
    // tray item, using multiple patterns to cover all known Instagram builds.
    //
    // Instagram's first tray item is always the signed-in user's own upload
    // bubble ("Your story"). On some builds that bubble exposes only the same
    // generic story-tray resource-id as real stories, or its label is attached
    // to a wrapper node rather than the node carrying the bounds. Therefore
    // label filtering alone is not sufficient: after collecting the live
    // bounds, we sort left-to-right and explicitly remove the first physical
    // bubble before returning candidates.
    const extractStoryBubbles = (xml: string): Array<{ cx: number; cy: number; desc: string }> => {
      const bubbles: Array<{ cx: number; cy: number; desc: string }> = [];
      if (!xml) return bubbles;
      const nodeRe = /<node\b([^>]*\/?>) */g;
      let nm: RegExpExecArray | null;
      while ((nm = nodeRe.exec(xml)) !== null) {
        const attrs = nm[1];
        const desc  = (attrs.match(/content-desc="([^"]*)"/)  ?? [])[1] ?? "";
        const rid   = (attrs.match(/resource-id="([^"]*)"/)   ?? [])[1] ?? "";
        const bm    = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;

        // ── EXCLUSION: upload / own-story controls ────────────────────────────
        // "Add to story", "Add to your story", "Your story", etc. all end with
        // "story" and would match the broad patterns below. Reject them HERE,
        // before any inclusion check, so they can never enter the candidate list
        // regardless of their screen position.
        const UPLOAD_EXCLUDE_RE = /^(add(\s+to)?(\s+your)?\s+story|your\s+story|create(\s+a)?\s+story|new\s+story)$/i;
        if (UPLOAD_EXCLUDE_RE.test(desc.trim())) continue;

        // ── Pattern 1: content-desc ending in "'s story" (ASCII or Unicode) ──
        // e.g. "fruitthchaz's story"  "lyrics_mood_0_'s story"
        const isStoryDesc =
          /'s story\b/i.test(desc) ||
          /\u2019s story\b/i.test(desc) ||
          // Pattern 2: "View <username>'s story" (some builds prefix with "View ")
          /^view .+'s story$/i.test(desc) ||
          /^view .+\u2019s story$/i.test(desc) ||
          // Pattern 3: content-desc is exactly "<username>, story" or
          // "<username> story" or "<username> - story" (less common variants)
          /[,\-–]?\s*story$/i.test(desc) ||
          // Pattern 4: resource-id contains "reel_tray_item" or "story_tray"
          // (covers builds where the avatar ViewGroup has no useful content-desc)
          /reel_tray_item/i.test(rid) ||
          /story_tray/i.test(rid);

        if (!isStoryDesc) continue;

        const cx = Math.round((Number(bm[1]) + Number(bm[3])) / 2);
        const cy = Math.round((Number(bm[2]) + Number(bm[4])) / 2);
        bubbles.push({ cx, cy, desc: desc || rid });
      }

      // A tray bubble commonly has both a labelled parent and an avatar child
      // in the dump. Collapse those nested/overlapping nodes so "first bubble"
      // means the first physical tray item, not whichever XML node appeared
      // first.
      bubbles.sort((a, b) => a.cx - b.cx || a.cy - b.cy);
      const deduped: typeof bubbles = [];
      for (const bubble of bubbles) {
        const duplicate = deduped.some(existing =>
          Math.abs(existing.cx - bubble.cx) <= 24 &&
          Math.abs(existing.cy - bubble.cy) <= 24,
        );
        if (!duplicate) deduped.push(bubble);
      }

      if (deduped.length > 0) {
        const ownStory = deduped.shift()!;
        onLog?.(`Story tray: ignoring first bubble "${ownStory.desc}" at (${ownStory.cx},${ownStory.cy}) — upload-your-own-story control`);
      }
      return deduped;
    };

    // First attempt.
    let trayXml = await android.dumpUi(serial).catch(() => "");
    let storyBubbles = extractStoryBubbles(trayXml);

    // If the first dump finds nothing, wait briefly and retry once — the story
    // tray sometimes finishes populating slightly after the feed renders.
    if (storyBubbles.length === 0) {
      onLog?.(`Story tray: first dump found no story bubbles — waiting 500 ms and retrying…`);
      await new Promise(r => setTimeout(r, 500));
      trayXml = await android.dumpUi(serial).catch(() => "");
      storyBubbles = extractStoryBubbles(trayXml);
    }

    if (storyBubbles.length === 0) {
      onLog?.(`Story tray: no bubbles after initial Home check — tapping Home once more and re-checking…`);
      const retryHome = await android.findHomeTab(serial).catch(() => null);
      if (retryHome) {
        await android.tap(serial, retryHome.x, retryHome.y);
      } else {
        const { w: retryW, h: retryH } = getScreenSize(serial);
        await android.tap(serial, Math.round(retryW * 0.10), Math.round(retryH * 0.975));
      }
      await new Promise(r => setTimeout(r, 500));
      trayXml = await android.dumpUi(serial).catch(() => "");
      storyBubbles = extractStoryBubbles(trayXml);
    }

    if (storyBubbles.length === 0) {
      // Diagnostic: log every content-desc and resource-id in the dump so we
      // can see exactly what Instagram is outputting on this build.  Limited
      // to 40 entries so the log stays readable.
      const diagEntries: string[] = [];
      const diagRe = /<node\b([^>]*\/?>) */g;
      let dm: RegExpExecArray | null;
      while ((dm = diagRe.exec(trayXml)) !== null && diagEntries.length < 40) {
        const a = dm[1];
        const d = (a.match(/content-desc="([^"]*)"/) ?? [])[1] ?? "";
        const r = (a.match(/resource-id="([^"]*)"/)  ?? [])[1] ?? "";
        if (d || r) diagEntries.push(`desc="${d}" rid="${r}"`);
      }
      onLog?.(`Story tray: still no bubbles after retry — dump node sample: ${diagEntries.slice(0, 20).join(" | ") || "(dump was empty)"}`);
      onLog?.(`Story tray: no story bubbles found — no stories to open this cycle`);
      return { slot: 0, opened: false };
    }

    onLog?.(`Story tray: found ${storyBubbles.length} story bubble(s) in dump: ${storyBubbles.map(b => b.desc).join(", ")}`);

    // Try slot 1 first, then the rest in random order, up to 3 attempts total.
    const [first, ...rest] = storyBubbles;
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
    const ordered = [first, ...rest];
    const maxAttempts = Math.min(3, ordered.length);

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const bubble = ordered[attempt];
      // Tap the exact centre of the node identified in the live dump. Never
      // apply a guessed offset after resolving a node.
      const tapX = bubble.cx;
      const tapY = bubble.cy;

      onLog?.(`Story tray: tapping "${bubble.desc}" at (${tapX},${tapY}) — attempt ${attempt + 1}/${maxAttempts}`);

      await android.tap(serial, tapX, tapY);
      await new Promise(r => setTimeout(r, 600));

      const stillOnFeedFast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      const storyOpen = stillOnFeedFast === true
        ? true
        : await android.isInStoryViewerSlow(serial).catch(() => false);
      if (storyOpen) {
        onLog?.(`Story tray: "${bubble.desc}" opened successfully`);
        return { slot: attempt + 1, opened: true };
      }
      onLog?.(`Story tray: tap on "${bubble.desc}" did NOT open a story — story viewer not detected (likely hit a follow/suggestion badge)`);
    }

    onLog?.(`Story tray: exhausted ${maxAttempts} attempt(s) — no story opened this cycle`);
    return { slot: maxAttempts, opened: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: VIEW STORIES
  // Functions: pickAndOpenRandomStory(), runViewStoriesFromFeedLoop()
  // Route:     (called from automation-cycle only)
  // Isolation: story slide navigation, emoji comment, DM share are all here.
  //            Do not apply keyboard-mapping or typing helpers from other tools
  //            to this section without explicit intent.
  // ═══════════════════════════════════════════════════════════════════════════

  async function runViewStoriesFromFeedLoop(serial: string, params: {
    slidesMin: number; slidesMax: number;
    slideWatchPctMin: number; slideWatchPctMax: number;
    likePercentMin: number; likePercentMax: number;
    shareDmPercentMin: number; shareDmPercentMax: number;
    commentPercentMin: number; commentPercentMax: number;
    clickAuthorPercentMin: number; clickAuthorPercentMax: number;
    alreadyInStoryViewer?: boolean;
    onLog?: (msg: string) => void;
  }): Promise<{ storiesWatched: number; storyLikes: number }> {
    params.onLog?.("[TRACE] stories: start");
    const {
      slidesMin, slidesMax,
      slideWatchPctMin, slideWatchPctMax,
      likePercentMin, likePercentMax,
      shareDmPercentMin, shareDmPercentMax,
      commentPercentMin, commentPercentMax,
      clickAuthorPercentMin, clickAuthorPercentMax,
      onLog,
    } = params;

    const totalStories = Math.floor(
      Math.min(slidesMin, slidesMax) +
      Math.random() * (Math.max(slidesMin, slidesMax) - Math.min(slidesMin, slidesMax) + 1)
    );
    if (totalStories <= 0) return { storiesWatched: 0, storyLikes: 0 };

    const { w, h } = getScreenSize(serial);
    // Logged once per run so a bad like/share tap or a false "sharing
    // disabled" can be cross-checked against the actual device resolution —
    // this farm runs multiple phone models with different aspect ratios,
    // and every tap coordinate and icon-scan band in this loop is a
    // percentage of w/h calibrated against one reference device.
    onLog?.(`Story loop: device resolution ${w}×${h}`);

    // Per-story action chances — sampled once for the whole session so
    // the overall distribution stays consistent.
    const likeChance  = (Math.min(likePercentMin, likePercentMax) +
      Math.random() * Math.abs(likePercentMax - likePercentMin)) / 100;
    const shareChance = (Math.min(shareDmPercentMin, shareDmPercentMax) +
      Math.random() * Math.abs(shareDmPercentMax - shareDmPercentMin)) / 100;
    const commentChance = (Math.min(commentPercentMin, commentPercentMax) +
      Math.random() * Math.abs(commentPercentMax - commentPercentMin)) / 100;
    const clickAuthorChance = (Math.min(clickAuthorPercentMin, clickAuthorPercentMax) +
      Math.random() * Math.abs(clickAuthorPercentMax - clickAuthorPercentMin)) / 100;
    const commentsConfigured = Number(commentPercentMin) > 0 && Number(commentPercentMax) > 0;
    onLog?.(
      `Story actions configured: like=${likePercentMin}-${likePercentMax}% ` +
      `share=${shareDmPercentMin}-${shareDmPercentMax}% ` +
      `comment=${commentPercentMin}-${commentPercentMax}% ` +
      `commentGate=${commentsConfigured ? "enabled" : "disabled"}`,
    );

    // Returns true only while the story viewer is genuinely still on screen.
    // Root-cause fix (Jul 2026): every prior fix in this loop assumed that
    // once a story opened, it stayed open for the rest of the per-slide
    // loop and for the whole multi-step DM-share sequence (icon scan → tap
    // → wait → pick recipient → wait → tap Send). Stories auto-advance (and
    // the LAST story in a user's tray auto-EXITS back to the home feed) on
    // their own ~5-6s timer regardless of what our script is doing — a
    // short/fast story, or a DM-share sequence whose waits alone add up to
    // several seconds, can run out that timer mid-sequence. When that
    // happens every remaining scripted tap in this function was firing
    // blind at whatever is now actually on screen — the home feed — which
    // is exactly how a "share to DM" tap turned into an accidental like on
    // a home-feed Reel (feed and story share-sheet coordinates overlap).
    // This check must run before every single tap below, not just once at
    // story-open time.
    //
    // Root-cause fix (Jul 2026, follow-up): this used to call findHomeTab
    // directly on every check, which requires a full uiautomator dump +
    // adb pull (~3-4s per call). Called up to 5-6 times inside one ~5-6s
    // story slide, THAT was consuming the slide's entire timer on safety
    // checks alone — the real reason likes/shares still stalled and
    // weren't "instant" even after the earlier fix removed the deliberate
    // pre-action watch delay. isStoryViewerOpenFast() does the same check
    // via a screenshot pixel scan (~100-300ms) and only ever returns a
    // confident `true`; it returns `null` whenever it can't tell for sure
    // (e.g. a single-story tray with no multi-segment progress bar), and
    // only THEN do we pay for the slow-but-proven accessibility-tree check.
    // `fastOnly = true` skips the slow uiautomator-dump fallback and requires
    // the fast pixel scan to POSITIVELY confirm the story viewer is open.
    // If the fast scan is inconclusive (returns null), we now FAIL CLOSED and
    // return false — the caller skips the action entirely.
    //
    // Root cause of the audio/music mis-tap bug: when fastOnly was inconclusive
    // the old code assumed the story was still open and allowed the share icon
    // scan to proceed. After a story auto-closes to the home feed, the lower-
    // screen pixel scan mistook the feed post’s audio/music icon for the story
    // share control and tapped it. Failing closed skips a rare like/share but
    // eliminates the mis-tap on unrelated feed controls entirely.
    const stillInStoryViewer = async (fastOnly = false) => {
      const fastStart = Date.now();
      const fast = await android.isStoryViewerOpenFast(serial).catch(() => null);
      if (fast === true) return true;
      if (fastOnly) {
        // Can't positively confirm viewer from pixels alone — fail CLOSED.
        // Skip the action rather than risk tapping a feed control (e.g.
        // audio/music icon) after the story auto-closes to the home feed.
        onLog?.(`  (story-viewer check: fast scan ${Date.now() - fastStart}ms inconclusive — fastOnly, failing closed)`);
        return false;
      }
      // Instrumented (12 Jul 2026): the previous version of this fix
      // assumed the fast pixel-scan check would hit most of the time and
      // never verified it in the field. Log every fallback with real
      // timings so the next report shows hard numbers (how often the fast
      // check misses, how long the slow dump actually costs on this
      // device) instead of guessing from story-loop timestamps.
      const slowStart = Date.now();
      // isInStoryViewerSlow checks for POSITIVE story-viewer markers first
      // (reel_viewer/toolbar_like_button resource IDs), then for the home tab
      // via content-desc/resource-id only — no positional fallback.  The old
      // findHomeTab-based check used strategy-3 positional fallback which
      // matched the story viewer's own bottom-bar clickables ("Send message"
      // input + heart/share icons all sit at y > 88%), making it return
      // non-null and falsely concluding the viewer was closed.
      const result = await android.isInStoryViewerSlow(serial).catch(() => false);
      onLog?.(`  (story-viewer check: fast scan ${slowStart - fastStart}ms inconclusive → slow dump ${Date.now() - slowStart}ms)`);
      return result;
    };

    // If the caller already confirmed the Story viewer, do not scan or tap
    // Home-feed story bubbles inside the viewer.
    const { slot: picked, opened: storyOpened } = params.alreadyInStoryViewer
      ? (onLog?.("Story viewer already active — skipping story-bubble picker"), { slot: 0, opened: true })
      : await pickAndOpenRandomStory(serial, w, h, onLog);
    logger.info({ serial, picked, totalStories, storyOpened }, "[view-stories] story open attempt");

    // If the tray tap didn't actually open a story (bottom nav was still
    // visible after the tap — meaning we hit a follow badge or missed the
    // bubble entirely) there is nothing to like or share.  Acting on whatever
    // is currently visible would mean double-tapping a home-feed post (which
    // likes it) or tapping dead air. Return zero watched rather than
    // accidentally interacting with the wrong screen.
    if (!storyOpened) {
      onLog?.("Story tray: no story opened — skipping story actions for this cycle");
      return { storiesWatched: 0, storyLikes: 0 };
    }

    await sleepOrAbort(serial, 1800 + Math.floor(Math.random() * 3201)); // let viewer animate open

    let storiesWatched = 0;
    let storyLikes = 0;

    for (let s = 0; s < totalStories; s++) {
      if (isCycleAborted(serial)) break;
      const storyTimingStartedAt = Date.now();
      let storyTimingAfterChecks = storyTimingStartedAt;
      let storyTimingAfterWatch = storyTimingStartedAt;
      let storyTimingAfterActions = storyTimingStartedAt;

      // Mid-story interstitial guard — runs at the start of every slide.
      // The "Interacting with content shared from Facebook" dialog (and
      // similar full-screen popups) block all further interaction and cannot
      // be dismissed by tapping outside — only their primary OK button works.
      // dismissInstagramInterstitials handles this and other known dialogs,
      // so we check once per slide before doing anything else.  Most slides
      // produce no dump cost because dismissInstagramInterstitials reuses any
      // preloaded XML passed to it; here we let it do its own dump since we
      // have none yet at the top of the iteration.
      const _storySlidePopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
      if (_storySlidePopup) {
        onLog?.(`View Stories ${s + 1}: mid-story popup dismissed (${_storySlidePopup})`);
        logger.info({ serial, story: s + 1, dismissed: _storySlidePopup }, "[view-stories] mid-story interstitial dismissed");
        await sleepOrAbort(serial, 400 + Math.floor(Math.random() * 4601));
      }

      // Like, share, and/or comment on this story?
      const willLike        = likeChance        > 0 && Math.random() < likeChance;
      const willShare       = shareChance       > 0 && Math.random() < shareChance;
      const willComment     = commentsConfigured && commentChance > 0 && Math.random() < commentChance;
      onLog?.(
        `View Stories ${s + 1}: action roll like=${willLike ? "yes" : "no"} ` +
        `share=${willShare ? "yes" : "no"} comment=${willComment ? "yes" : "no"} ` +
        `commentGate=${commentsConfigured ? "enabled" : "disabled"}`,
      );
      const willClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;
      storyTimingAfterChecks = Date.now();

      // Watch this story for a random percentage of its ~6s duration — but
      // ONLY when no action is scheduled on this slide. When a like and/or
      // share is scheduled, fire immediately — no delay, no pre-action
      // viewer check. Root-cause fix (Jul 2026): the "fast" pixel-scan
      // viewer check was taking ~2.7s on this farm's devices (screenshot
      // round-trip), so 250ms delay + 2.7s check = ~3s before the like
      // fired — longer than a 3-second story slide. The story auto-advanced
      // before the doubleTap ever ran. Pre-action check removed entirely;
      // we are guaranteed to be in the viewer at this point (opened 1800ms
      // ago, nothing has navigated away). Post-action checks (pre-advance
      // at line ~2076, pre-exit at ~2106) still guard against blind taps
      // after the slide timer expires.
      if (!(willLike || willShare || willComment || willClickAuthor)) {
        const watchPct = Math.min(slideWatchPctMin, slideWatchPctMax) +
          Math.random() * Math.abs(slideWatchPctMax - slideWatchPctMin);
        const watchTarget = watchPct / 100;
        const watchStarted = Date.now();
        let reachedTarget = false;
        let previousProgress: number | null = null;
        while (Date.now() - watchStarted < 60000) {
          const progress = await android.readStoryProgress(serial).catch(() => null);
          if (progress == null) {
            await sleepOrAbort(serial, 180);
            continue;
          }
          if (previousProgress != null && progress + 0.15 < previousProgress) {
            onLog?.(`View Stories ${s + 1}: story segment advanced before target (${(progress * 100).toFixed(0)}%)`);
            break;
          }
          previousProgress = progress;
          if (progress >= watchTarget) {
            reachedTarget = true;
            break;
          }
          await sleepOrAbort(serial, 180);
        }
        onLog?.(
          `View Stories ${s + 1}: progress target=${(watchTarget * 100).toFixed(0)}% ` +
          `reached=${reachedTarget ? "yes" : "no"} elapsed=${((Date.now() - watchStarted) / 1000).toFixed(1)}s`,
        );
      }
      storyTimingAfterWatch = Date.now();

      if (willLike) {
        // Tap the story Like button via the accessibility tree.
        //
        // Previous approach: double-tap at fixed screen-centre percentages
        // (w*0.50, h*0.44). Violated the project rule against hardcoded
        // coordinates and was not reliably registering on this farm's devices
        // (confirmed from log: "liked (double-tap at (540,1082))" fired but
        // the Like Story button still showed cd="Like Story" afterwards).
        //
        // Fix: find toolbar_like_button by resource-id via findStoryLikeButtonViaA11y
        // and tap it once — same as every other button in this codebase.
        // Falls back to the legacy double-tap if the a11y lookup fails.
        const likeBtn = await android.findStoryLikeButtonViaA11y(serial).catch(() => null);
        if (likeBtn) {
          await android.tap(serial, likeBtn.x, likeBtn.y);
          storyLikes++;
          logger.info({ serial, story: s + 1, x: likeBtn.x, y: likeBtn.y }, "[view-stories] liked story via a11y toolbar_like_button");
          onLog?.(`View Stories ${s + 1}: liked via a11y at (${likeBtn.x},${likeBtn.y})`);
        } else {
          // Like button not found in accessibility tree — skip the like entirely.
          //
          // The previous fallback (double-tap at w*0.50, h*0.44) is PERMANENTLY
          // REMOVED. Tapping at the centre of the story screen is not safe:
          // story authors commonly place link stickers, mention stickers, and
          // hashtag stickers anywhere in the 30–60% height band. A tap on any
          // of these navigates away from the story viewer — to an external URL,
          // a profile page, or a hashtag feed — exactly the "random shit clicked
          // mid-story" bug that has recurred repeatedly.
          //
          // Skipping the like on this slide is always safer than a blind
          // centre-screen tap that can and does cause unintended navigation.
          logger.info({ serial, story: s + 1 }, "[view-stories] like button not found via a11y — skipping like (no fallback tap)");
          onLog?.(`View Stories ${s + 1}: like skipped — toolbar_like_button not found in a11y tree (no centre-screen tap; fallback removed)`);
        }
        // When a share is also scheduled on this slide, don't linger here —
        // every extra ms is runway the DM-share sequence won't have.
        await sleepOrAbort(serial, willShare
          ? 100 + Math.floor(Math.random() * 4901)
          : 200 + Math.floor(Math.random() * 4801));
      }

      if (willShare && !(await stillInStoryViewer(/* fastOnly= */ true))) {
        onLog?.(`View Stories ${s + 1}: story viewer closed before share could start — skipping share`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone before share attempt");
      } else if (willShare) {
        // Scan for icons BEFORE tapping — skip share entirely if the
        // paper-plane isn't present (story owner has sharing disabled).
        //
        // Previous approach: blind tap at fixed right-edge coordinates, then
        // check if the keyboard opened. Problem: that tap always lands inside
        // the message field when sharing is disabled (the field expands to
        // fill the full bar width), briefly opening the keyboard and
        // disrupting the story before we back out.
        //
        // Fix: run findStoryActionIcons() first.  When sharing is disabled
        // only the heart icon is visible — the scan returns 0 or 1 cluster.
        // When sharing is enabled the heart AND paper-plane both appear — the
        // scan returns ≥2 clusters, and the rightmost cluster IS the
        // paper-plane.  We only tap if ≥2 icons were found, and we tap the
        // actual detected coordinates rather than a guessed percentage.
        // The keyboard check is kept as a final safety net.
        // Strategy 1: UIAutomator accessibility probe.
        // Instagram draws the story reply-bar on a canvas with no accessible
        // child elements on most device/version combinations, but some builds
        // DO label the paper-plane. Try the a11y tree first (fast, zero tap
        // risk on wrong coordinates) and fall back to the pixel scan only if
        // Strategy 1 (v1.1.580): UIAutomator a11y probe — tries known labels and
        // the text-field-anchor approach.  Now also passes onLog so the full
        // diagnostic dump of every node in the lower 35 % of the screen appears
        // in the Log tab on every share attempt.  If it returns null, fall
        // through to the pixel scan unchanged.
        //
        // NOTE: the positional probe (find rightmost clickable in the bar zone)
        // was REMOVED in v1.1.581 — it reliably returned the text-input field
        // centre (~60 % of screen width) rather than the paper-plane (~88–93 %),
        // burning the slide timer with three keyboard-opening retries.
        let shareIconPos: { x: number; y: number } | null = null;
        const a11yPos = await android.findStoryShareButtonViaA11y(serial, (msg) => onLog?.(msg)).catch(() => null);
        if (a11yPos) {
          shareIconPos = a11yPos;
          onLog?.(`View Stories ${s + 1}: share button located via a11y at (${a11yPos.x},${a11yPos.y})`);
        } else {
          // Strategy 2: pixel scan.
          const iconScan = await android.findStoryActionIcons(serial).catch(() => null);
          const rawPos = (iconScan && iconScan.length >= 2) ? iconScan[iconScan.length - 1] : null;
          onLog?.(`View Stories ${s + 1}: pixel scan — ${iconScan == null ? "screenshot unavailable" : `${iconScan.length} cluster(s) found`}${rawPos ? ` — rightmost at (${rawPos.x},${rawPos.y})` : " — <2 clusters (sharing disabled or scan miss)"}`);
          // Sanity check: the paper-plane is always in the rightmost ~15–20 %
          // of the screen.  The v1.1.580 threshold of 40 % was too permissive
          // and would accept false content-cluster matches in the centre of the
          // frame.  Raised to 65 % — anything left of that is not the paper-
          // plane regardless of device resolution.
          if (rawPos && rawPos.x > w * 0.65) {
            shareIconPos = rawPos;
          } else if (rawPos) {
            onLog?.(`View Stories ${s + 1}: pixel scan result rejected — x=${rawPos.x} < 65% of w=${w}; false content match — skipping share`);
            logger.warn({ serial, story: s + 1, rawX: rawPos.x, w }, "[view-stories] share pixel-scan rejected — x too far left");
          }
        }

        let opened = false;
        if (!shareIconPos) {
          // no usable position — skip without touching the screen
          logger.info({ serial, story: s + 1 }, "[view-stories] share skipped — paper-plane not found");
          onLog?.(`View Stories ${s + 1}: share skipped — owner has sharing disabled (no paper-plane detected)`);
        } else {
          // Tap the paper-plane once and wait for the share sheet — identical
          // to the feed share-to-DM flow which does not use a keyboard check.
          //
          // DO NOT use isKeyboardShown() here.  When the paper-plane tap
          // correctly opens the DM share sheet, the sheet's search box
          // ("Search" EditText) auto-focuses and raises the soft keyboard —
          // so isKeyboardShown() returns true even on a SUCCESSFUL tap.
          // The old keyboard-check-and-retry loop therefore pressed Back every
          // time the sheet opened correctly, closing it immediately, then
          // repeated 3 times — which is exactly the "clicking and closing the
          // share sheet" behaviour reported (15 Jul 2026).
          //
          // Sheet confirmation is handled below via direct_private_share
          // resource-id (the same signal sendShareSheet uses), which
          // unambiguously distinguishes "sheet open" from "nothing happened".
          await android.tap(serial, shareIconPos.x, shareIconPos.y);
          onLog?.(`View Stories ${s + 1}: tapped paper-plane at (${shareIconPos.x},${shareIconPos.y}) — waiting for share sheet`);
          await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801)); // let the sheet render
          opened = true;
        }
        if (opened) {
          await sleepOrAbort(serial, 150 + Math.floor(Math.random() * 4851)); // wait for recipient picker
          // Confirm the sheet actually rendered BEFORE firing the recipient
          // tap. Root-cause fix (12 Jul 2026, user-reported): the only gate
          // that used to exist here was "no keyboard AND still in story
          // viewer" — but that's true both when the sheet genuinely opened
          // AND when the paper-plane tap landed on something that did
          // neither (e.g. a slightly mis-scanned icon position that missed
          // every real element). In that second case `opened` was still set
          // true, and the very next line blind-tapped recipient slot 1 at
          // x≈15% of screen width — which, on the plain story screen
          // underneath (no sheet actually covering it), is squarely inside
          // Instagram's "go to previous story" tap zone. That's the
          // "clicked backwards" bug: the bot wasn't confused about DM UI,
          // it just never verified the DM sheet was really there before
          // tapping into it blind.
          //
          // The Send button only ever exists inside this DM share sheet, so
          // finding it is a reliable positive signal the sheet is open —
          // unlike the absence checks used above, which can't tell "sheet
          // open" apart from "nothing happened at all".
          // Capture the Send button position — proves the sheet is open AND
          // passes it to sendShareSheet so it can skip its own 2–3s a11y dump.
          // Uses confirmAndScanShareSheet (one dump for both confirm + recipient
          // scan) instead of two sequential dumps — every second here eats into
          // the story's fixed auto-advance timer (see story-action-timing-
          // starvation), so the single-dump path matters even more here than on
          // the feed/reels flows.
          const storyShareScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
          const sheetSendBtn = storyShareScan?.sendBtn ?? null;
          if (!sheetSendBtn) {
            logger.warn({ serial, story: s + 1 }, "[view-stories] share sheet not confirmed open (no Send button found) — skipping recipient tap to avoid a blind tap on the story underneath");
            onLog?.(`View Stories ${s + 1}: share aborted — could not confirm the share sheet actually opened (no Send button found) — skipped recipient tap rather than risk tapping the story underneath`);
          } else {
          // ── View Stories — Share via DM: recipient pick + send (isolated; not shared with any other tool) ──
          const _stRecipients = storyShareScan?.recipients ?? [];
          if (_stRecipients.length === 0) {
            await android.pressBack(serial);
            logger.warn({ serial, story: s + 1 }, "[view-stories] no recipient found — closed share sheet without sending");
            onLog?.(`View Stories ${s + 1}: share skipped — no recipient avatars found in sheet (closed without sending)`);
          } else {
            const _stLast = _viewStoriesLastDmRecipient.get(serial);
            const _stPool = _stLast ? _stRecipients.filter(r => !(r.x === _stLast.x && r.y === _stLast.y)) : _stRecipients;
            const _stCands = _stPool.length > 0 ? _stPool : _stRecipients;
            const _stPick = _stCands[Math.floor(Math.random() * _stCands.length)];
            _viewStoriesLastDmRecipient.set(serial, { x: _stPick.x, y: _stPick.y });
            onLog?.(`View Stories ${s + 1}: tapping recipient at (${_stPick.x},${_stPick.y})${(_stPick as any).name ? ` (${(_stPick as any).name})` : ""}`);
            await android.tap(serial, _stPick.x, _stPick.y);
            await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801)); // brief pause for selection to register
            // No "still in story viewer?" check here — sheetSendBtn already confirms
            // the story was showing when the sheet opened. Adding an a11y dump
            // (fast 1–1.5s + slow 2.7s = 4.2s) burns the remaining slide budget
            // without providing meaningful protection.
            const _stIsOpen = async () => {
              const _x = await android.dumpUi(serial).catch(() => "");
              return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                     _x.includes("android.widget.EditText") || _x.includes("Copy link") || _x.includes("Add to story");
            };
            const _stSb = sheetSendBtn ?? await android.findButtonByLabel(serial, "Send").catch(() => null);
            if (_stSb) {
              await android.tap(serial, _stSb.x, _stSb.y);
              await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
              if (!(await _stIsOpen())) {
                logger.info({ serial, story: s + 1 }, "[view-stories] shared story via DM — Send tapped");
                onLog?.(`View Stories ${s + 1}: shared via DM — Send tapped`);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              } else {
                await android.pressBack(serial);
                logger.info({ serial, story: s + 1 }, "[view-stories] Send button not found — closed DM picker");
                onLog?.(`View Stories ${s + 1}: Send button not found — closed DM picker`);
                await sleepOrAbort(serial, 200);
              }
            } else if (!(await _stIsOpen())) {
              logger.info({ serial, story: s + 1 }, "[view-stories] share sheet already closed — DM likely sent by recipient tap");
              onLog?.(`View Stories ${s + 1}: shared via DM — sheet auto-dismissed (sent by recipient tap)`);
              await sleepOrAbort(serial, 150 + Math.floor(Math.random() * 4851));
            } else {
              const _stFbX = Math.round(w * 0.50), _stFbY = Math.round(h * 0.982);
              onLog?.(`View Stories ${s + 1}: Send button not found via a11y — tapping coordinate fallback (${_stFbX},${_stFbY})`);
              await android.tap(serial, _stFbX, _stFbY);
              await sleepOrAbort(serial, 300 + Math.floor(Math.random() * 4701));
              if (!(await _stIsOpen())) {
                onLog?.(`View Stories ${s + 1}: ✓ shared via DM — sent via coordinate fallback`);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              } else {
                await android.pressBack(serial);
                await sleepOrAbort(serial, 200 + Math.floor(Math.random() * 4801));
              }
            }
          }
          } // closes sheetSendBtn else
        }
      }

      // ── View Stories — Emoji comment reply ─────────────────────────────
      // Selects an emoji through the live keyboard accessibility tree as a
      // reply to the current story slide.
      // Only fires when the author allows message replies — confirmed by
      // the presence of id="message_composer_container" with
      // desc="Send Message or Reaction" in the accessibility tree.
      //
      // Flow:
      //   SEND-MESSAGE-BAR  → message_composer_container present → tap to open keyboard
      //   ENTER-MESSAGE     → keyboard open; resolve the Emoji control and picker
      //                       cell from the live IME accessibility tree
      //   TAP-SEND-PAPER-AIRPLANE → emoji in field, send button visible:
      //                       id="row_thread_composer_send_button_background" desc="Send"
      if (commentsConfigured && willComment && (await stillInStoryViewer(/* fastOnly= */ true))) {
        try {
          const _cXml = await android.dumpUi(serial).catch(() => "");
          const _hasComposerContainer =
            /(?:id|resource-id)="[^"]*message_composer_container"/.test(_cXml);
          const _hasLegacyComposerLabel =
            /(?:content-desc|desc)="Send Message or Reaction"/i.test(_cXml);
          const _hasVisibleComposerLabel =
            /(?:id|resource-id)="[^"]*composer_text"/.test(_cXml) &&
            /(?:text|content-desc)="Send message"/i.test(_cXml);
          onLog?.(
            `View Stories ${s + 1}: message composer probe — ` +
            `container=${_hasComposerContainer ? "yes" : "no"}, ` +
            `legacy-label=${_hasLegacyComposerLabel ? "yes" : "no"}, ` +
            `visible-label=${_hasVisibleComposerLabel ? "yes" : "no"}`,
          );

          // Do not require one Instagram resource-id. Xiaomi/Instagram builds
          // can render the visible reply bar while exposing only a generic
          // lower-screen node (or composer_text) in UIAutomator.
          const _composer = await android.findStoryReplyComposerViaA11y(
            serial,
            msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
          );
          if (!_composer) {
            onLog?.(`View Stories ${s + 1}: emoji comment skipped — author has message replies disabled`);
            logger.info({ serial, story: s + 1 }, "[view-stories] emoji comment skipped — reply composer not found");
          } else {
            onLog?.(`View Stories ${s + 1}: tapping message composer at (${_composer.x},${_composer.y})…`);
            await android.tap(serial, _composer.x, _composer.y);
            await sleepOrAbort(serial, 800); // keyboard animates up

            // ── Open the Emoji picker through a verified layered tap ──
            //
            // Gboard may render its controls without exposing usable
            // accessibility nodes. The shared helper tries the live IME node,
            // then the same-device calibrated physical tap, then visual
            // keyboard geometry, verifying the Emoji picker after each tap.
            let _emojiKeyPressed = false;
            try {
              _emojiKeyPressed = await android.tapCalibratedKeyboardKey(
                serial,
                "emoji",
                msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
              );
            } catch (e: any) {
              onLog?.(`View Stories ${s + 1}: calibrated Emoji bind failed — ${e?.message}`);
              logger.warn(
                { serial, story: s + 1, err: e?.message },
                "[view-stories] calibrated emoji bind failed",
              );
            }
            if (!_emojiKeyPressed) {
              onLog?.(
                `View Stories ${s + 1}: Emoji picker could not be opened by ` +
                `live-node, calibrated-tap, or visual fallback`,
              );
              await android.pressBack(serial).catch(() => {});
              continue;
            }

            await sleepOrAbort(serial, 350);
            try {
              const _emojiSelected = await android.tapKeyboardEmojiNode(
                serial,
                msg => onLog?.(`View Stories ${s + 1}: ${msg}`),
              );
              if (!_emojiSelected) {
                await android.pressBack(serial).catch(() => {});
                continue;
              }
            } catch (e: any) {
              onLog?.(`View Stories ${s + 1}: live Emoji picker node lookup failed — ${e?.message}`);
              logger.warn({ serial, story: s + 1, err: e?.message }, "[view-stories] live emoji node lookup failed");
              await android.pressBack(serial).catch(() => {});
              continue;
            }
            await sleepOrAbort(serial, 400); // selected emoji settles; send button appears

            // Find the send button that appears after the emoji is entered.
            // From TAP-SEND-PAPER-AIRPLANE dump:
            //   id="row_thread_composer_send_button_background" desc="Send"
            //   bounds=[898,1150][1041,1249] center=(970,1200)
            const _sendXml = await android.dumpUi(serial).catch(() => "");
            const _sendMatch = _sendXml.match(
              /id="row_thread_composer_send_button[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/
            );
            if (_sendMatch) {
              const _sbX = Math.round((+_sendMatch[1] + +_sendMatch[3]) / 2);
              const _sbY = Math.round((+_sendMatch[2] + +_sendMatch[4]) / 2);
              onLog?.(`View Stories ${s + 1}: tapping send at (${_sbX},${_sbY})…`);
              await android.tap(serial, _sbX, _sbY);
              await sleepOrAbort(serial, 300);
              onLog?.(`View Stories ${s + 1}: ✓ emoji reply sent`);
              logger.info({ serial, story: s + 1 }, "[view-stories] emoji comment sent");
            } else {
              // Send button not found — emoji may not have been entered or
              // keyboard is still showing. Press BACK to dismiss cleanly.
              await android.pressBack(serial).catch(() => {});
              await sleepOrAbort(serial, 300);
              onLog?.(`View Stories ${s + 1}: emoji comment — send button not found, dismissed keyboard`);
              logger.warn({ serial, story: s + 1 }, "[view-stories] emoji comment — send button not found after emoji tap");
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Stories ${s + 1}: emoji comment error — ${e?.message}`);
          await android.pressBack(serial).catch(() => {}); // safety dismiss
        }
      }

      // ── Click author — visit the story author's profile ──────────────────────
      if (willClickAuthor) {
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          const _saStillIn = await stillInStoryViewer(true);
          if (!_saStillIn) {
            onLog?.(`View Stories ${s + 1}: click-author — story viewer already closed, skipping`);
          } else {
            // Dump the story viewer to locate the author's avatar ring.
            // Do not tap reel_viewer_text_container: on current Instagram
            // builds it spans both the username header and the attribution/
            // song row, so its center can land on "Original audio" instead of
            // opening the author profile. The dedicated avatar node is the
            // unambiguous author target.
            const _saXml = await android.dumpUi(serial).catch(() => "");
            const _saNodeMatch =
              _saXml.match(/resource-id="[^"]*reel_viewer_profile_picture"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ??
              _saXml.match(/resource-id="[^"]*profile_picture_container"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
            if (!_saNodeMatch) {
              onLog?.(`View Stories ${s + 1}: click-author — author avatar ring not found in dump, skipping`);
            } else {
              const _saX = Math.round((+_saNodeMatch[1] + +_saNodeMatch[3]) / 2);
              const _saY = Math.round((+_saNodeMatch[2] + +_saNodeMatch[4]) / 2);
              onLog?.(`View Stories ${s + 1}: click-author — tapping author avatar ring at (${_saX},${_saY})…`);
              await android.tap(serial, _saX, _saY);
              await sleepOrAbort(serial, 1800); // profile page animates in
              // Scroll the profile 1–10 times; 2.5–8 s dwell after each scroll.
              const _saScrolls = 1 + Math.floor(Math.random() * 10);
              onLog?.(`View Stories ${s + 1}: click-author — scrolling author profile ${_saScrolls}x…`);
              const { w: _saW, h: _saH } = getScreenSize(serial);
              for (let _saI = 0; _saI < _saScrolls; _saI++) {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await deviceProfileSwipe(
                  serial,
                  {
                    x1: Math.round(_saW / 2), y1: Math.round(_saH * 0.75),
                    x2: Math.round(_saW / 2), y2: Math.round(_saH * 0.30),
                    durationMs: 350 + Math.round(Math.random() * 350),
                  },
                  "stories-author-profile-scroll",
                  "normal",
                );
                await sleepOrAbort(serial, 2500 + Math.round(Math.random() * 5500)); // 2.5–8 s
              }
              // Back once → returns to the story viewer.
              onLog?.(`View Stories ${s + 1}: click-author — returning from author profile…`);
              await android.pressBack(serial);
              await sleepOrAbort(serial, 700);
              onLog?.(`View Stories ${s + 1}: click-author — ✓ author profile visited`);
            }
          }
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`View Stories ${s + 1}: click-author error — ${e?.message}`);
          await android.pressBack(serial).catch(() => {}); // safety return to story
        }
      }
      storyTimingAfterActions = Date.now();

      // Don't tap "advance to next slide" if we've already left the story
      // viewer — that tap would land on the feed and register as a like/
      // navigation there instead of harmlessly advancing a story slide.
      // Normal slide completion only needs a positive fast confirmation. If
      // the fast scan is inconclusive, fail closed and stop rather than paying
      // a 3–5s UIAutomator dump on every ordinary slide. The slow fallback is
      // still used for risky action paths and final recovery below.
      if (!(await stillInStoryViewer(true))) {
        onLog?.(`View Stories ${s + 1}: story viewer already closed — stopping story loop`);
        logger.info({ serial, story: s + 1 }, "[view-stories] story viewer gone at end of slide — stopping loop");
        storiesWatched++;
        break;
      }

      storiesWatched++;
      onLog?.(
        `View Stories ${s + 1}/${totalStories} timing — ` +
        `pre-watch/checks=${((storyTimingAfterChecks - storyTimingStartedAt) / 1000).toFixed(1)}s, ` +
        `watch-wait=${((storyTimingAfterWatch - storyTimingAfterChecks) / 1000).toFixed(1)}s, ` +
        `actions/author=${((storyTimingAfterActions - storyTimingAfterWatch) / 1000).toFixed(1)}s, ` +
        `total=${((storyTimingAfterActions - storyTimingStartedAt) / 1000).toFixed(1)}s`,
      );

      // Advance to the next story by tapping the far-right edge (~97%) of the
      // screen at ~45% height — but ONLY when there are more slides left to
      // watch.
      //
      // History of x-position changes and why:
      //   w*0.75  (original) — dead centre; hit collaboration/hashtag/mention
      //                        stickers constantly (all of which navigate away).
      //   w*0.92  (v1.2.30)  — far right, 8% inset from edge; still hit
      //                        mention stickers that the author placed in the
      //                        right portion of the frame (confirmed Jul 2026).
      //   w*0.97  (current)  — extreme right edge (3% inset, ~22 px on a
      //                        720-px-wide screen).  Story creators virtually
      //                        never place interactive stickers this close to
      //                        the physical edge (IG's editor snaps/clips them
      //                        away from that strip), so collision risk is
      //                        near-zero while the tap still lands in the
      //                        "right half = advance" zone Instagram recognises.
      //
      // History of y-position changes and why:
      //   h*0.15  (previous) — intended to clear the author header (~10%),
      //                        but the actual author bar (progress strip +
      //                        avatar + name + mute button) runs to ~12–15%
      //                        on most story layouts, so the tap landed on the
      //                        author's name/avatar and opened their profile
      //                        every time the advance fired (confirmed Jul 2026).
      //   h*0.45  (current)  — mid-screen; well below the author header
      //                        (~12–15%) and above the reply bar (~88%).
      //                        Interactive stickers (mentions, hashtags, links)
      //                        most commonly appear in the 20–60% band, but at
      //                        x=97% (the extreme physical edge) Instagram's
      //                        editor clips them away so sticker collision risk
      //                        remains near-zero at this x even at mid-screen y.
      //
      // Skipping the advance on the last iteration: on 3-second stories the
      // unnecessary last-tap would push to slide totalStories+1, causing the
      // tray to auto-advance to the next user's stories instead of staying on
      // the final slide until we swipe down.
      if (s < totalStories - 1) {
        await android.tap(serial, Math.round(w * 0.97), Math.round(h * 0.45));
        await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
      }
    }

    // End the story tool with one downward swipe. Do not inspect foreground
    // package, validate the viewer, press Back, or perform Home-tab recovery.
    // If the story viewer is open, this exits it; otherwise Instagram simply
    // refreshes/scrolls the feed, which is acceptable.
    const { w: _storyExitW, h: _storyExitH } = getScreenSize(serial);
    onLog?.("Story exit: swiping down to leave the story viewer");
    await deviceProfileSwipe(
      serial,
      {
        x1: Math.round(_storyExitW / 2),
        y1: Math.round(_storyExitH * 0.30),
        x2: Math.round(_storyExitW / 2),
        y2: Math.round(_storyExitH * 0.85),
        durationMs: 500,
      },
      "story-exit",
      "back",
    );
    await sleepOrAbort(serial, 800);
    return { storiesWatched, storyLikes };

    // ── Ad / deviation recovery ───────────────────────────────────────────
    // A "next story" advance tap that lands on a sponsored post's CTA button
    // (or a swipe Instagram intercepts for a full-screen ad) can open Chrome
    // or Instagram's in-app WebView, taking us completely out of the story
    // viewer — and possibly out of the Instagram app entirely.  Every
    // subsequent scripted tap would land on the wrong app.  Check the
    // foreground package and press Back until we are back in Instagram before
    // doing anything else (including the exit-swipe below).
    const _stPkg = await android.getForegroundPackage(serial).catch(() => null);
    if (_stPkg && _stPkg !== "com.instagram.android") {
      onLog?.(`Story loop: deviated — foreground app is "${_stPkg}" (expected Instagram) — pressing Back to recover`);
      logger.info({ serial, pkg: _stPkg }, "[view-stories] deviated to external app — pressing Back to recover");
      for (let _stRi = 0; _stRi < 5; _stRi++) {
        await android.pressBack(serial);
        await sleepOrAbort(serial, 700);
        const _stNowPkg = await android.getForegroundPackage(serial).catch(() => null);
        if (!_stNowPkg || _stNowPkg === "com.instagram.android") {
          onLog?.(`Story loop: recovered — back in Instagram after ${_stRi + 1} Back press(es)`);
          logger.info({ serial, attempts: _stRi + 1 }, "[view-stories] recovered to Instagram after ad deviation");
          break;
        }
      }
    }

    // Exit the story viewer with Android Back — only if we're actually still
    // in it. Do not use a swipe here: the established Story exit contract is
    // Back, and a swipe can leave Instagram in the viewer or advance content.
    if (await stillInStoryViewer()) {
      onLog?.("Story exit: pressing Android Back");
      logger.info({ serial }, "[view-stories] exiting story viewer with Android Back");
      await android.pressBack(serial);
    }
    await sleepOrAbort(serial, 800);

    // ── Home-feed recovery ─────────────────────────────────────────────────
    // Even at x=97%, an advance tap can occasionally land on a mention/collab
    // sticker placed near the right edge, navigating to the story author's
    // profile page.  The ad-deviation block above only catches non-Instagram
    // apps; this block catches the intra-Instagram case where we're left on a
    // non-feed surface.
    //
    // Detection: findHomeTab looks for content-desc="Home" or the feed_tab
    // resource-id in the accessibility tree.
    //
    // Recovery: ALWAYS tap the Home tab when it is visible rather than just
    // checking for its presence.  The Reels full-screen player still shows the
    // bottom nav (Home tab visible), so the old null-only guard passed through
    // it without navigating back to the feed.  Tapping Home is safe on the
    // feed (stays/refreshes) AND correctly exits the Reels player back to the
    // home feed.  When the Home tab is absent entirely (Chrome, deep link,
    // etc.) fall back to pressing Back once.
    //
    // Root cause (observed Jul 2026): after all story slides ended naturally,
    // Instagram auto-navigated to the Reels full-screen player.  findHomeTab
    // returned non-null (bottom nav still visible in Reels), so the old
    // null-only guard did nothing and the automation cycle continued inside
    // the Reels player instead of the home feed.
    {
      const _stFeedTab = await android.findHomeTab(serial).catch(() => null);
      if (_stFeedTab) {
        onLog?.("Story exit: tapping Home tab to return to home feed (guards against Reels/profile auto-navigation after story end)");
        logger.info({ serial }, "[view-stories] tapping Home tab post-exit to ensure home feed");
        await android.tap(serial, _stFeedTab.x, _stFeedTab.y);
        await sleepOrAbort(serial, 700);
      } else {
        // When the reply composer/keyboard is focused, Back dismisses only the
        // keyboard. Returning immediately here leaves Instagram inside the
        // story viewer and the next dispatcher tool starts on that screen.
        // Recover in bounded steps, re-dumping after every Back, until Home is
        // positively visible or the viewer is positively gone.
        for (let _stRecovery = 0; _stRecovery < 3; _stRecovery++) {
          onLog?.(
            `Story exit: home tab absent after story loop — pressing Back ` +
            `(${_stRecovery + 1}/3) and rechecking`,
          );
          logger.info({ serial, attempt: _stRecovery + 1 }, "[view-stories] home tab absent post-exit — pressing Back and rechecking");
          await android.pressBack(serial);
          await sleepOrAbort(serial, 600);
          const _stRecoveredHome = await android.findHomeTab(serial).catch(() => null);
          if (_stRecoveredHome) {
            onLog?.("Story exit: Home tab confirmed after Back recovery — returning to home feed");
            await android.tap(serial, _stRecoveredHome.x, _stRecoveredHome.y);
            await sleepOrAbort(serial, 700);
            break;
          }
          if (!(await android.isInStoryViewerSlow(serial).catch(() => false))) {
            onLog?.("Story exit: Story viewer no longer detected after Back recovery");
            break;
          }
        }
      }
    }

    return { storiesWatched, storyLikes };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: VIEW EXPLORE PAGE
  // Functions: runViewExplorePage()
  // Route:     (called from automation-cycle only)
  // Isolation: Explore grid scroll + post open + action-bar interactions.
  //            Fully isolated — no code shared with any other tool.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── View Reels — taps the Reels tab, then snap-swipes through N reels,
  // acting on each via the right-side vertical icon column (Like/Comment/
  // Repost/Send) instead of the feed's horizontal bottom action bar. See
  // findReelActionIcons in androidManager.ts for the detection approach and
  // its "not yet validated on a real device" caveat.
  // ── View Explore Page ─────────────────────────────────────────────────────
  // Taps the Search/Explore tab, scrolls the grid N times, and optionally
  // clicks individual posts to like / share-to-feed / share-via-DM / save them.
  // Navigation: identical to the Follow tool's approach (findInstagramSearchTab).
  // Post actions: uses findFeedActionIcons — an opened Explore post looks and
  // behaves exactly like a regular feed post once tapped.
  // Exit: taps the Home tab at the end to return to the home feed.
  // This function is fully isolated — no code is shared with any other tool.
  async function runViewExplorePage(serial: string, params: {
    scrollCount: number;
    delayMinSec: number; delayMaxSec: number;
    clickPostPctMin: number; clickPostPctMax: number;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin: number; shareFeedPercentMax: number;
    shareDmPercentMin: number; shareDmPercentMax: number;
    savePercentMin: number; savePercentMax: number;
    clickAuthorPctMin: number; clickAuthorPctMax: number;
    onLog?: (msg: string) => void;
    onProgress?: (progress: { postsScrolled: number; postsClicked: number; likes: number; sharesFeed: number; sharesDm: number; saves: number; authorVisits: number }) => void;
  }): Promise<{ postsScrolled: number; postsClicked: number; likes: number; sharesFeed: number; sharesDm: number; saves: number; authorVisits: number }> {
    const {
      scrollCount, delayMinSec, delayMaxSec,
      clickPostPctMin, clickPostPctMax,
      likePercentMin, likePercentMax,
      shareFeedPercentMin, shareFeedPercentMax,
      shareDmPercentMin, shareDmPercentMax,
      savePercentMin, savePercentMax,
      clickAuthorPctMin, clickAuthorPctMax,
      onLog, onProgress,
    } = params;

    onLog?.("[TRACE] explore: start");
    const { w, h } = getScreenSize(serial);
    onLog?.(`Explore loop: device resolution ${w}×${h}`);

    // Navigate to the Search/Explore tab — identical to the Follow tool.
    const searchTab = await android.findInstagramSearchTab(serial, onLog).catch(() => null);
    if (!searchTab) {
      onLog?.("View Explore Page: Search tab not found — skipping");
      logger.warn({ serial }, "[view-explore] Search tab not found");
      return { postsScrolled: 0, postsClicked: 0, likes: 0, sharesFeed: 0, sharesDm: 0, saves: 0, authorVisits: 0 };
    }
    onLog?.("[TRACE] explore: tap-search-tab");
    await android.tap(serial, searchTab.x, searchTab.y);
    // Same 2500ms settle used by Follow — enough for the Explore grid to render.
    await sleepOrAbort(serial, 2500);

    // Pre-roll session-level chance values once so every scroll sees consistent rates.
    const clickChance     = (Math.min(clickPostPctMin, clickPostPctMax) + Math.random() * Math.abs(clickPostPctMax - clickPostPctMin)) / 100;
    const likeChance      = (Math.min(likePercentMin, likePercentMax) + Math.random() * Math.abs(likePercentMax - likePercentMin)) / 100;
    const shareFeedChance = (Math.min(shareFeedPercentMin, shareFeedPercentMax) + Math.random() * Math.abs(shareFeedPercentMax - shareFeedPercentMin)) / 100;
    const shareDmChance   = (Math.min(shareDmPercentMin, shareDmPercentMax) + Math.random() * Math.abs(shareDmPercentMax - shareDmPercentMin)) / 100;
    const saveChance        = (Math.min(savePercentMin, savePercentMax) + Math.random() * Math.abs(savePercentMax - savePercentMin)) / 100;
    const clickAuthorChance = (Math.min(clickAuthorPctMin, clickAuthorPctMax) + Math.random() * Math.abs(clickAuthorPctMax - clickAuthorPctMin)) / 100;

    const delayLoSec = Math.min(delayMinSec, delayMaxSec);
    const delayHiSec = Math.max(delayMinSec, delayMaxSec);

    let postsScrolled = 0, postsClicked = 0, likes = 0, sharesFeed = 0, sharesDm = 0, saves = 0, authorVisits = 0;

    // Explore grid media can open either a photo viewer or a Reel viewer.
    // Those viewers have different accessibility trees, so a UI "Back"
    // node is not a reliable exit control. Android BACK is intentionally the
    // single exit path for both viewer types.
    const exitExploreMediaViewer = async (iteration: number) => {
      onLog?.(`View Explore ${iteration}/${scrollCount}: exiting media viewer with Android Back`);
      await android.pressBack(serial);
      await sleepOrAbort(serial, 800);
    };

    // Scroll geometry: same safe band as runCheckFeedLoop.
    const x  = Math.round(w / 2);

    // Session scroll personality — same approach as runCheckFeedLoop.
    const exploreScrollWeights = {
      superSkim: 1 + Math.floor(Math.random() * 5), skim: 10 + Math.floor(Math.random() * 16),
      fast: 40 + Math.floor(Math.random() * 36), quick: 50 + Math.floor(Math.random() * 46),
      normal: 60 + Math.floor(Math.random() * 36), slow: 75 + Math.floor(Math.random() * 21),
      focused: 75 + Math.floor(Math.random() * 26),
      tapDragRelease: 1 + Math.floor(Math.random() * 5),
      back:       Math.floor(Math.random() * 6),       // 0–5
    };
    onLog?.(`Explore scroll personality — super skim:${exploreScrollWeights.superSkim} skim:${exploreScrollWeights.skim} fast:${exploreScrollWeights.fast} quick:${exploreScrollWeights.quick} normal:${exploreScrollWeights.normal} slow:${exploreScrollWeights.slow} focused:${exploreScrollWeights.focused} tap-drag-release:${exploreScrollWeights.tapDragRelease} back:${exploreScrollWeights.back}`);
    const explorePersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

    for (let i = 0; i < scrollCount; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      onLog?.(`View Explore ${i + 1}/${scrollCount}`);

      // Optionally click a post from the currently visible grid.
      if (clickChance > 0 && Math.random() < clickChance) {
        // Parse explore grid cells from the accessibility tree.
        // The explore grid has two cell types:
        //   • Photo/carousel cells  → container id="grid_card_layout_container"
        //                             child    id="image_button"
        //   • Reel cells            → container id="layout_container"
        //                             child    id="image_preview"
        // Matching the tappable image children directly (image_button +
        // image_preview) catches both types, and the ≥150px size filter
        // excludes tiny UI images (profile pics, icons, etc.).
        const xml = await android.dumpUi(serial).catch(() => "");
        const gridCells: Array<{ x: number; y: number; resourceId: string; clickable: boolean; enabled: boolean }> = [];
        const nodeRe2 = /<node\s([^>]*?)\s*\/?>/g;
        let cm: RegExpExecArray | null;
        while ((cm = nodeRe2.exec(xml)) !== null) {
          const attrs = cm[1];
          const resourceMatch = attrs.match(/resource-id="([^"]*)"/);
          const resourceId = resourceMatch?.[1] ?? "";
          // Tap the grid's owning container, not merely an image child. The
          // image child can have valid-looking bounds while the surrounding
          // container owns Instagram's click handler.
          const isGridContainer =
            resourceId.endsWith("grid_card_layout_container") ||
            resourceId.endsWith("layout_container");
          const isImageChild =
            resourceId.endsWith("image_button") ||
            resourceId.endsWith("image_preview");
          if (!isGridContainer && !isImageChild) continue;
          const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (!bm) continue;
          const x1 = parseInt(bm[1]), y1 = parseInt(bm[2]);
          const x2 = parseInt(bm[3]), y2 = parseInt(bm[4]);
          // Must be a real grid cell — at least 150×150px.
          if ((x2 - x1) < 150 || (y2 - y1) < 150) continue;
          const cx = Math.round((x1 + x2) / 2);
          const cy = Math.round((y1 + y2) / 2);
          // Exclude cells clipped into the search/action bar (top ~155px)
          // or the bottom nav (bottom ~30px from screen edge).
          const clickable = /clickable="true"/.test(attrs);
          const enabled = !/enabled="false"/.test(attrs);
          if (cy > 155 && cy < h - 30 && enabled && (isGridContainer ? clickable : clickable)) {
            gridCells.push({ x: cx, y: cy, resourceId, clickable, enabled });
          }
        }
        // Prefer the clickable grid containers. Image children are retained
        // only as a compatibility fallback for builds where Instagram exposes
        // no clickable container but marks the image node itself clickable.
        const clickableContainers = gridCells.filter((cell) =>
          cell.resourceId.endsWith("grid_card_layout_container") ||
          cell.resourceId.endsWith("layout_container"),
        );
        const clickableCells = clickableContainers.length > 0
          ? clickableContainers
          : gridCells.filter((cell) => cell.clickable);

        if (clickableCells.length > 0) {
          const cell = clickableCells[Math.floor(Math.random() * clickableCells.length)];
          onLog?.(`View Explore ${i + 1}/${scrollCount}: selected ${cell.resourceId} clickable=${cell.clickable} enabled=${cell.enabled} candidates=${clickableCells.length}`);
          onLog?.(`View Explore ${i + 1}/${scrollCount}: clicking grid post at (${cell.x},${cell.y})`);
          await android.tap(serial, cell.x, cell.y);
          // Explore click-post dwell: remain on the selected grid post long
          // enough for its media/viewer to render before continuing with any
          // actions. This is intentionally isolated to View Explore.
          const explorePostDwellMs = 1000 + Math.floor(Math.random() * 9001);
          onLog?.(`View Explore ${i + 1}/${scrollCount}: dwelling ${explorePostDwellMs}ms on clicked post`);
          await sleepOrAbort(serial, explorePostDwellMs);
          postsClicked++;

          const wantLike        = likeChance        > 0 && Math.random() < likeChance;
          const wantShareFeed   = shareFeedChance   > 0 && Math.random() < shareFeedChance;
          const wantShareDm     = shareDmChance     > 0 && Math.random() < shareDmChance;
          const wantSave        = saveChance        > 0 && Math.random() < saveChance;
          const wantClickAuthor = clickAuthorChance > 0 && Math.random() < clickAuthorChance;

          if (wantLike || wantShareFeed || wantShareDm || wantSave) {
            await sleepOrAbort(serial, 600); // settle before scanning action bar

            // ── Explore-only: wait for reel player nodes to appear ───────────
            // Problem: the reel/post viewer sometimes opens in a separate window
            // layer (observed on Xiaomi MIUI). The standard uiautomator dump
            // captures the focused window — during the opening animation or
            // before the view attaches to the accessibility system, the dump
            // still returns the explore GRID rather than the post viewer.
            // Running findFeedActionIcons / findReelActionIcons against that
            // grid dump wastes ~9 s per cycle and both return null.
            //
            // Fix: do cheap raw dumps (no parsing, no scan logic) polling for
            // ANY well-known post-viewer node to appear. Once confirmed, the
            // tree is ready and the expensive scans will find the real icons.
            // If the nodes never appear within the budget, fall straight through
            // — the existing scan logic handles the null path as before.
            {
              const POST_NODES = [
                "com.instagram.android:id/like_button",
                "com.instagram.android:id/comment_button",
                "com.instagram.android:id/direct_share_button",
                "com.instagram.android:id/row_feed_button_like",
              ];
              const POLL_MS    = 2000;
              const MAX_POLLS  = 6;  // up to 12 s additional wait
              let postReady = false;
              for (let p = 0; p < MAX_POLLS && !postReady; p++) {
                const pollXml = await android.dumpUi(serial).catch(() => "");
                if (POST_NODES.some(n => pollXml.includes(n))) {
                  postReady = true;
                  if (p > 0) onLog?.(`View Explore ${i + 1}/${scrollCount}: post viewer ready after ${p * POLL_MS / 1000}s extra wait`);
                } else {
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: viewer not ready yet — retrying in ${POLL_MS / 1000}s (poll ${p + 1}/${MAX_POLLS})`);
                  await sleepOrAbort(serial, POLL_MS);
                }
              }
              if (!postReady) onLog?.(`View Explore ${i + 1}/${scrollCount}: viewer never appeared in tree — proceeding anyway`);
            }

            onLog?.(`View Explore ${i + 1}/${scrollCount}: scanning action bar…`);
            let icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);

            // ── Explore-only: Reels column fallback (null path) ─────────────
            // findFeedActionIcons looks for Like/Unlike near screen centre-x
            // (≈540 px). In the Reels viewer that Explore posts open into,
            // every icon sits at x≈998 (right edge) — the feed scanner misses
            // them entirely and returns null. When that happens, fall straight
            // through to findReelActionIcons which scans the right-edge column
            // directly. Save is not in the Reels column; it stays null here
            // and the broader save scan below picks it up if present.
            // This block is intentionally isolated to runViewExplorePage and
            // has no effect on any other tool.
            if (!icons) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: feed scan found nothing — trying Reels column scan`);
              const _veReelIcons = await android.findReelActionIcons(serial, onLog).catch(() => null);
              if (_veReelIcons) {
                icons = {
                  like:       _veReelIcons.like,
                  comment:    _veReelIcons.comment,
                  shareFeed:  _veReelIcons.shareFeed,
                  shareDm:    _veReelIcons.shareDm,
                  save:       null,
                  alreadyLiked: _veReelIcons.alreadyLiked,
                };
                onLog?.(`View Explore ${i + 1}/${scrollCount}: Reels column found — like=(${_veReelIcons.like.x},${_veReelIcons.like.y}) shareFeed=${_veReelIcons.shareFeed ? `(${_veReelIcons.shareFeed.x},${_veReelIcons.shareFeed.y})` : "null"} shareDm=${_veReelIcons.shareDm ? `(${_veReelIcons.shareDm.x},${_veReelIcons.shareDm.y})` : "null"}`);
              }
            }

            // ── Explore-only: vertical column overlay (non-null path) ────────
            // If findFeedActionIcons DID return icons but Like is in the right
            // column (x > 80%), the horizontal row scan will have returned null
            // for shareFeed/shareDm. Overlay those from findReelActionIcons.
            if (icons && icons.like.x > Math.round(w * 0.80)) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: vertical column layout detected (like.x=${icons.like.x}) — re-scanning shareFeed/shareDm via column scan`);
              const _veColIcons = await android.findReelActionIcons(serial, onLog).catch(() => null);
              if (_veColIcons) {
                icons = { ...icons, shareFeed: _veColIcons.shareFeed, shareDm: _veColIcons.shareDm };
              }
              // Save remains null unless the shared screenshot matcher found
              // the attached ribbon icon. Never restore an accessibility or
              // positional Save fallback for the vertical Reel layout.
            }

            if (!icons) {
              onLog?.(`View Explore ${i + 1}/${scrollCount}: no action bar found — skipping actions`);
              logger.info({ serial }, "[view-explore] opened post has no action bar");
            } else {
              // ── Like ──────────────────────────────────────────────────────
              if (wantLike) {
                if (icons.alreadyLiked) {
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: already liked — skipping like`);
                } else {
                  // ~93 % double-tap on image; ~7 % heart-icon tap for variety.
                  const useDoubleTap = Math.random() < 0.93;
                  if (useDoubleTap) {
                    const { w: _eW } = getScreenSize(serial);
                    const dtX = Math.round(_eW / 2) + Math.round((Math.random() - 0.5) * 20);
                    let dtY: number;
                    if (icons.mediaBounds) {
                      const mb = icons.mediaBounds;
                      const fraction = 0.25 + Math.random() * 0.20;
                      dtY = Math.round(mb.y1 + (mb.y2 - mb.y1) * fraction) + Math.round((Math.random() - 0.5) * 20);
                      onLog?.(`View Explore ${i + 1}/${scrollCount}: double-tap using media bounds (${Math.round(fraction * 100)}% into media)`);
                    } else {
                      dtY = icons.like.y - Math.round(icons.like.y * 0.35) + Math.round((Math.random() - 0.5) * 40);
                    }
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: double-tapping image at (${dtX},${dtY})…`);
                    await android.doubleTap(serial, dtX, dtY);
                  } else {
                    const jx = icons.like.x + Math.round((Math.random() - 0.5) * 6);
                    const jy = icons.like.y + Math.round((Math.random() - 0.5) * 6);
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping heart icon at (${jx},${jy})…`);
                    await android.tap(serial, jx, jy);
                  }
                  likes++;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ liked`);
                  await sleepOrAbort(serial, 300);
                }
              }

              // ── Share to Feed (repost) ─────────────────────────────────────
              if (wantShareFeed && !icons.shareFeed) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: skipped repost — share-to-feed icon not found`);
              }
              if (wantShareFeed && icons.shareFeed) {
                try {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                  const _eSfX = icons.shareFeed.x, _eSfY = icons.shareFeed.y;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping share-to-feed at (${_eSfX},${_eSfY})…`);
                  await android.tap(serial, _eSfX, _eSfY);
                  await sleepOrAbort(serial, 400);
                  const _eRpBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
                  const _eRpDx = _eRpBtn ? Math.abs(_eRpBtn.x - _eSfX) : 0;
                  const _eRpDy = _eRpBtn ? Math.abs(_eRpBtn.y - _eSfY) : 0;
                  const _eRpSame = !!_eRpBtn && _eRpDx < 60 && _eRpDy < 60;
                  if (_eRpBtn && !_eRpSame) {
                    await android.tap(serial, _eRpBtn.x, _eRpBtn.y);
                    await sleepOrAbort(serial, 300);
                    const _eClose = await android.findButtonByLabel(serial, "Close").catch(() => null);
                    if (_eClose) { await android.tap(serial, _eClose.x, _eClose.y); await sleepOrAbort(serial, 150); }
                    sharesFeed++;
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ reposted to feed`);
                  } else if (_eRpSame) {
                    sharesFeed++;
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ reposted to feed (single-tap)`);
                  } else {
                    await android.pressBack(serial).catch(() => {});
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: repost — Repost button not found after tap`);
                  }
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: share-to-feed error — ${e?.message}`);
                }
              }

              // ── Share via DM (isolated; not shared with any other tool) ───
              const _veOverlap = !!icons.shareDm && !!icons.shareFeed &&
                Math.abs(icons.shareDm.x - icons.shareFeed.x) < 15 &&
                Math.abs(icons.shareDm.y - icons.shareFeed.y) < 15;
              if (wantShareDm && !icons.shareDm) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: skipped share-via-DM — paper-plane icon not found`);
              }
              if (wantShareDm && icons.shareDm && _veOverlap) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: share-via-DM skipped — icon overlaps share-to-feed (ambiguous layout)`);
              }
              if (wantShareDm && icons.shareDm && !_veOverlap) {
                const _vePfx = `View Explore ${i + 1}/${scrollCount}`;
                let _veDmSent = false;
                try {
                  if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                  await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                  onLog?.(`${_vePfx}: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
                  await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
                  await sleepOrAbort(serial, 1500);
                  onLog?.(`${_vePfx}: confirming share sheet opened and picking DM recipient…`);
                  let _veScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                  if (!_veScan?.sheetOpen) {
                    onLog?.(`${_vePfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                    await sleepOrAbort(serial, 1500);
                    _veScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
                  }
                  if (!_veScan?.sheetOpen) {
                    logger.warn({ serial }, "[view-explore] share sheet not confirmed open after retry — skipping DM");
                    onLog?.(`${_vePfx}: share aborted — share sheet did not open`);
                    await android.pressBack(serial);
                    await sleepOrAbort(serial, 200);
                  } else {
                    if (_veScan.preSelectedRecipients && _veScan.preSelectedRecipients.length > 0) {
                      onLog?.(`${_vePfx}: deselecting ${_veScan.preSelectedRecipients.length} pre-selected recipient(s)…`);
                      for (const _r of _veScan.preSelectedRecipients) {
                        onLog?.(`${_vePfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                        await android.tap(serial, _r.x, _r.y);
                        await sleepOrAbort(serial, 400);
                      }
                    }
                    const _veRecipients = _veScan.recipients ?? [];
                    if (_veRecipients.length === 0) {
                      await android.pressBack(serial);
                      logger.warn({ serial }, "[view-explore] no recipient found — closed without sending");
                      onLog?.(`${_vePfx}: share skipped — no recipient avatars found`);
                    } else {
                      const _veLast = _viewExploreLastDmRecipient.get(serial);
                      const _vePool = _veLast ? _veRecipients.filter(r => !(r.x === _veLast.x && r.y === _veLast.y)) : _veRecipients;
                      const _veCands = _vePool.length > 0 ? _vePool : _veRecipients;
                      const _vePick = _veCands[Math.floor(Math.random() * _veCands.length)];
                      _viewExploreLastDmRecipient.set(serial, { x: _vePick.x, y: _vePick.y });
                      onLog?.(`${_vePfx}: tapping recipient at (${_vePick.x},${_vePick.y})${(_vePick as any).name ? ` (${(_vePick as any).name})` : ""}`);
                      await android.tap(serial, _vePick.x, _vePick.y);
                      await sleepOrAbort(serial, 800);
                      const _veIsOpen = async () => {
                        const _x = await android.dumpUi(serial).catch(() => "");
                        return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                               _x.includes("android.widget.EditText") || _x.includes("Copy link");
                      };
                      const _veSb = await android.findButtonByLabel(serial, "Send").catch(() => null);
                      if (_veSb) {
                        await android.tap(serial, _veSb.x, _veSb.y);
                        await sleepOrAbort(serial, 1500);
                        if (!(await _veIsOpen())) {
                          _veDmSent = true;
                          logger.info({ serial }, "[view-explore] shared post via DM — Send tapped");
                          onLog?.(`${_vePfx}: ✓ shared via DM — Send tapped`);
                          await sleepOrAbort(serial, 300);
                        } else {
                          onLog?.(`${_vePfx}: Send tapped but sheet still open — pressing Back`);
                          await android.pressBack(serial);
                          await sleepOrAbort(serial, 200);
                        }
                      } else if (!(await _veIsOpen())) {
                        _veDmSent = true;
                        logger.info({ serial }, "[view-explore] share sheet auto-dismissed — DM likely sent");
                        onLog?.(`${_vePfx}: ✓ shared via DM — sheet auto-dismissed`);
                        await sleepOrAbort(serial, 200);
                      } else {
                        const _veFbX = Math.round(w * 0.50), _veFbY = Math.round(h * 0.982);
                        onLog?.(`${_vePfx}: Send not found via a11y — tapping coordinate fallback (${_veFbX},${_veFbY})`);
                        await android.tap(serial, _veFbX, _veFbY);
                        await sleepOrAbort(serial, 1500);
                        if (!(await _veIsOpen())) {
                          _veDmSent = true;
                          onLog?.(`${_vePfx}: ✓ shared via DM — sent via coordinate fallback`);
                          await sleepOrAbort(serial, 300);
                        } else {
                          await android.pressBack(serial);
                          await sleepOrAbort(serial, 200);
                        }
                      }
                    }
                  }
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  onLog?.(`${_vePfx}: share-via-DM error — ${e?.message}`);
                }
                if (_veDmSent) sharesDm++;
              }

              // ── Save Post ──────────────────────────────────────────────────
              if (wantSave) {
                const _eSaveBtn = icons.save;
                if (!_eSaveBtn) {
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: save skipped — ribbon icon not found`);
                } else {
                  try {
                    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                    await sleepOrAbort(serial, 200 + Math.round(Math.random() * 200));
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping save (ribbon) at (${_eSaveBtn.x},${_eSaveBtn.y})…`);
                    await android.tap(serial, _eSaveBtn.x, _eSaveBtn.y);
                    await sleepOrAbort(serial, 600);
                    // Dismiss "Save to collection?" bottom sheet by tapping the
                    // top-25% of the screen — always safe, no interactive controls
                    // in that zone while the collection sheet is visible.
                    const _eDismissX = Math.round(w * 0.50);
                    const _eDismissY = Math.round(h * 0.12);
                    // Only dismiss if the collection sheet is actually visible —
                    // an unconditional tap risks hitting the Explore header when
                    // the toast appears without the sheet.
                    const _eSaveXml = await android.dumpUi(serial).catch(() => "");
                    if (_eSaveXml.includes('pinned_save_row') || _eSaveXml.includes('Collect the posts you love')) {
                      await android.tap(serial, _eDismissX, _eDismissY);
                      await sleepOrAbort(serial, 300);
                    }
                    saves++;
                    logger.info({ serial }, "[view-explore] saved post via ribbon icon");
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ saved`);
                  } catch (e: any) {
                    if (e?.message === "cycle-aborted") throw e;
                    onLog?.(`View Explore ${i + 1}/${scrollCount}: save error — ${e?.message}`);
                  }
                }
              }
            }
          }

          // ── Click Author (visit post author's profile) ─────────────────
          // Taps clips_author_username (Reels viewer) or
          // row_feed_photo_profile_name (photo-post viewer) — whichever is
          // present — to open the author's profile. Scrolls 1–10 times with
          // a normal swipe followed by a 2.5–10 s render wait, then presses
          // Back once after the profile visit to return to the post viewer;
          // the existing Back press below then returns to Explore.
          // This block is intentionally isolated to runViewExplorePage.
          if (wantClickAuthor) {
            try {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              await sleepOrAbort(serial, 300);
              const _aeXml = await android.dumpUi(serial).catch(() => "");
              // Skip author click if Instagram labels this as a sponsored post.
              // Quoted attribute matching prevents false positives on words like
              // "Add", "Adidas", etc. whose text values differ from the bare "Ad".
              const _aeIsAd =
                _aeXml.includes('text="Ad"')         || _aeXml.includes('content-desc="Ad"') ||
                _aeXml.includes('text="Sponsored"')  || _aeXml.includes('content-desc="Sponsored"') ||
                _aeXml.includes('text="Advert"')     || _aeXml.includes('content-desc="Advert"');
              if (_aeIsAd) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: ad post detected — skipping click author`);
              } else {
              // Find author button — covers Reels viewer (clips_author_username)
              // and photo-post viewer (row_feed_photo_profile_name).
              //
              // clips_author_info_component is deliberately excluded: it is a
              // container node that appears before its children in the XML dump.
              // It has no text/content-desc, so the name would be "unknown", and
              // tapping it on a collab post opens a Collaborators sheet instead
              // of navigating to the author's profile.
              //
              // Require a non-empty name: collab posts expose multiple
              // clips_author_username nodes (one per collaborator). Taking the
              // first one with a non-empty text/content-desc gives us the
              // original (topmost) author — later nodes are collaborators.
              // An empty name means we hit a container; skip it.
              let _aeNode: { x: number; y: number; name: string } | null = null;
              const _aeNodeRe = /<node\s([^>]*?)(?:\/?>)/g;
              let _aeMatch: RegExpExecArray | null;
              while ((_aeMatch = _aeNodeRe.exec(_aeXml)) !== null) {
                const _aeSeg = _aeMatch[1];
                const _aeRid = (_aeSeg.match(/resource-id="([^"]*)"/) ?? [])[1] ?? "";
                const _isAuthor =
                  /(?:^|:)clips_author_username$/.test(_aeRid) ||
                  /(?:^|:)row_feed_photo_profile_name$/.test(_aeRid);
                if (!_isAuthor) continue;
                const _aeDesc =
                  (_aeSeg.match(/text="([^"]*)"/) ?? [])[1] ??
                  (_aeSeg.match(/content-desc="([^"]*)"/) ?? [])[1] ??
                  "";
                // Skip nodes with no name — containers and collab groupings.
                if (!_aeDesc) continue;
                const _aeBb = _aeSeg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
                if (!_aeBb) continue;
                const _aeX = Math.round((parseInt(_aeBb[1]) + parseInt(_aeBb[3])) / 2);
                const _aeY = Math.round((parseInt(_aeBb[2]) + parseInt(_aeBb[4])) / 2);
                _aeNode = { x: _aeX, y: _aeY, name: _aeDesc };
                break;
              }
              if (!_aeNode) {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author rolled but no named author button visible — skipping`);
              } else {
                onLog?.(`View Explore ${i + 1}/${scrollCount}: tapping author "${_aeNode.name}" at (${_aeNode.x},${_aeNode.y})…`);
                await android.tap(serial, _aeNode.x, _aeNode.y);
                await sleepOrAbort(serial, 1500);
                // Guard: collab posts can open a Collaborators sheet instead of
                // a profile. Check the post-tap dump and bail if the sheet appeared.
                const _aeChkXml = await android.dumpUi(serial).catch(() => "");
                const _aeIsCollab =
                  _aeChkXml.includes('text="Collaborators"') ||
                  _aeChkXml.includes('clips_collab');
                if (_aeIsCollab) {
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author — Collaborators sheet appeared (collab post) — pressing Back, skipping`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 500);
                } else {
                  // Normal single-author profile — scroll it. Keep the gesture
                  // short and natural, then wait for the profile posts to render
                  // before starting another scroll.
                  const _aeScrolls = 1 + Math.floor(Math.random() * 10);
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: on author profile "${_aeNode.name}" — scrolling ${_aeScrolls}x…`);
                  const { w: _aeW, h: _aeH } = getScreenSize(serial);
                  for (let _aeS = 0; _aeS < _aeScrolls; _aeS++) {
                    if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                    const _aeSY1 = Math.round(_aeH * 0.75);
                    const _aeSY2 = Math.round(_aeH * 0.30);
                    const _aeDur = 350 + Math.round(Math.random() * 350);
                    await deviceProfileSwipe(serial, { x1: Math.round(_aeW / 2), y1: _aeSY1, x2: Math.round(_aeW / 2), y2: _aeSY2, durationMs: _aeDur }, "explore-author-scroll");
                    const _aeRenderWaitMs = 2500 + Math.round(Math.random() * 7500);
                    await sleepOrAbort(serial, _aeRenderWaitMs);
                  }
                  // Back once — returns to the post/reel viewer. The outer
                  // Back below then returns from the post/reel to Explore.
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: returning from author profile…`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 700);
                  authorVisits++;
                  onLog?.(`View Explore ${i + 1}/${scrollCount}: ✓ author profile visited (${_aeNode.name})`);
                }
              }
              } // end ad-skip else
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
              onLog?.(`View Explore ${i + 1}/${scrollCount}: click-author error — ${e?.message}`);
            }
          }

          // Always leave clicked media through Android BACK. Do not search for
          // or tap an accessibility Back node: Reels and photo viewers expose
          // different trees, and media clicks can replace the entire UI.
          await exitExploreMediaViewer(i + 1);
        } else {
          onLog?.(`View Explore ${i + 1}/${scrollCount}: no grid posts visible — skipping click`);
        }
      }

      postsScrolled++;
      onProgress?.({ postsScrolled, postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits });

      if (i < scrollCount - 1) {
        // Delay between scrolls.
        const delaySec = delayLoSec + Math.random() * (delayHiSec - delayLoSec);
        if (delaySec > 0) await sleepOrAbort(serial, Math.round(delaySec * 1000));
        // Swipe up to reveal more Explore posts.
        // The first Explore advance is the first opportunity to reveal more
        // content; there is no prior grid position to revisit yet.
        const esv = rollScrollVelocity(h, exploreScrollWeights, /*allowBack=*/i > 0, /*safeStartFrac=*/0.80, explorePersonalityHistory, serial);
        const exploreOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[esv.mode] : undefined;
        onLog?.(`[Override] Explore swipe: mode=${esv.mode}, duration=${esv.duration}ms${exploreOverride ? `, weight=${exploreOverride.weightMin}-${exploreOverride.weightMax}, durationRange=${exploreOverride.durationMinMs}-${exploreOverride.durationMaxMs}ms` : ", Mother Code default"}`);
        explorePersonalityHistory.streak = explorePersonalityHistory.lastMode === esv.mode ? explorePersonalityHistory.streak + 1 : 1;
        explorePersonalityHistory.lastMode = esv.mode;
        const exploreModeLabel = esv.mode === "superSkim" ? "super skim" : esv.mode;
        onLog?.(`View Explore ${i + 1}/${scrollCount}: next swipe [${exploreModeLabel}]`);
        logger.info({ serial, source: "explore-scroll", mode: esv.mode, from: [x, esv.fromY], to: [x, esv.toY], durationMs: esv.duration }, "[mobile-input] swipe");
        // Cap the swipe start at 68% of screen height so startJitter can never
        // push the finger onto the bottom row of clickable Reel thumbnail cells,
        // which have touch consumers that claim the DOWN event as a tap even
        // when the gesture travels 600+ px upward (root cause: jitter-pushed
        // y1 onto a Reel cell → cell's touch consumer fired before the grid's
        // scroll interceptor could claim the drag).
        const exploreMaxFromY = Math.round(h * 0.68);
        await deviceProfileSwipe(serial, { x1: x, y1: esv.fromY, x2: x, y2: esv.toY, durationMs: esv.duration }, "explore-scroll", esv.mode as any, { maxFromY: exploreMaxFromY });
        // Explore-only render dwell: the grid often needs a few seconds after
        // the gesture before its media cells are actually populated. Keep this
        // hardcoded and isolated here; it must not alter Feed, Reels, Stories,
        // or any other tool's swipe timing.
        const exploreMediaDwellMs = 1000 + Math.floor(Math.random() * 4001);
        onLog?.(`View Explore ${i + 1}/${scrollCount}: waiting ${exploreMediaDwellMs}ms for media to render after swipe`);
        await sleepOrAbort(serial, exploreMediaDwellMs);
      }
    }

    // Navigate back to the home feed — Explore has its own distinct UI so
    // tapping Home is the cleanest exit (same pattern as after View Reels).
    onLog?.("View Explore Page: navigating back to home feed…");
    // Use the live accessibility tree for the exit tap. The screenshot-based
    // brightness scan is unsafe here: Home and Reels are adjacent, and the
    // brightest tile in the bottom-nav region is not necessarily Home.
    const homeTab = await android.findHomeTab(serial).catch(() => null);
    if (!homeTab) {
      onLog?.("View Explore Page: Home tab was not semantically detected — refusing an unsafe guessed tap");
      logger.warn({ serial }, "[view-explore] Home tab not found at exit; skipping guessed tap");
      return { postsScrolled, postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits };
    }
    onLog?.(`View Explore Page: tapping semantic Home tab at (${homeTab.x}, ${homeTab.y})`);
    await android.tap(serial, homeTab.x, homeTab.y);
      await sleepOrAbort(serial, 1000);

    return { postsScrolled, postsClicked, likes, sharesFeed, sharesDm, saves, authorVisits };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: VIEW REELS
  // Functions: runViewReelsLoop()
  // Route:     (called from automation-cycle only)
  // Isolation: Reels tab navigation, swipe, like/share/save are all here.
  //            Action-icon detection uses the Reels-specific vertical column
  //            layout — do not conflate with the feed's horizontal bar.
  // ═══════════════════════════════════════════════════════════════════════════

  async function runViewReelsLoop(serial: string, params: {
    scrollMin: number; scrollMax: number;
    watchPctMin: number; watchPctMax: number;
    likePercentMin: number; likePercentMax: number;
    shareFeedPercentMin: number; shareFeedPercentMax: number;
    shareDmPercentMin: number; shareDmPercentMax: number;
    savePercentMin: number; savePercentMax: number;
    clickAuthorPctMin: number; clickAuthorPctMax: number;
    onLog?: (msg: string) => void;
    onProgress?: (progress: { reelsViewed: number; likes: number; sharesFeed: number; sharesDm: number; saves: number }) => void;
  }): Promise<{ reelsViewed: number; likes: number; sharesFeed: number; sharesDm: number; saves: number }> {
    const {
      scrollMin, scrollMax,
      watchPctMin, watchPctMax,
      likePercentMin, likePercentMax,
      shareFeedPercentMin, shareFeedPercentMax,
      shareDmPercentMin, shareDmPercentMax,
      savePercentMin, savePercentMax,
      clickAuthorPctMin, clickAuthorPctMax,
      onLog, onProgress,
    } = params;

    const totalReels = Math.floor(rollRange(scrollMin, scrollMax));
    if (totalReels <= 0) return { reelsViewed: 0, likes: 0, sharesFeed: 0, sharesDm: 0, saves: 0 };

    const { w, h } = getScreenSize(serial);
    onLog?.(`Reels loop: device resolution ${w}×${h}`);

    const reelsTab = await android.findReelsTab(serial, onLog).catch(() => null);
    if (!reelsTab) {
      onLog?.("Reels tab not found — a11y miss and positional fallback found < 2 bottom-nav nodes; skipping View Reels");
      logger.warn({ serial }, "[view-reels] Reels tab not found");
      return { reelsViewed: 0, likes: 0, sharesFeed: 0, sharesDm: 0, saves: 0 };
    }
    await android.tap(serial, reelsTab.x, reelsTab.y);
    onLog?.(`Tapped Reels tab at (${reelsTab.x},${reelsTab.y}) — waiting for Reels to load`);
    await sleepOrAbort(serial, 1500);

    let likes = 0, sharesFeed = 0, sharesDm = 0, saves = 0, reelsViewed = 0;

    // Session scroll personality for Reels — same dynamic-weight approach as
    // feed/explore. Back-scroll snaps fully to the previous clip (Reels snaps
    // per clip, unlike the feed's partial nudge), which just means occasionally
    // rewatching a reel — a normal human behaviour kept at a low weight.
    const reelsScrollWeights = {
      superSkim: 1 + Math.floor(Math.random() * 5), skim: 10 + Math.floor(Math.random() * 16),
      fast: 40 + Math.floor(Math.random() * 36), quick: 50 + Math.floor(Math.random() * 46),
      normal: 60 + Math.floor(Math.random() * 36), slow: 75 + Math.floor(Math.random() * 21),
      focused: 75 + Math.floor(Math.random() * 26),
      tapDragRelease: 1 + Math.floor(Math.random() * 5),
      back:       Math.floor(Math.random() * 6),       // 0–5
    };
    onLog?.(`Reels scroll personality — super skim:${reelsScrollWeights.superSkim} skim:${reelsScrollWeights.skim} fast:${reelsScrollWeights.fast} quick:${reelsScrollWeights.quick} normal:${reelsScrollWeights.normal} slow:${reelsScrollWeights.slow} focused:${reelsScrollWeights.focused} tap-drag-release:${reelsScrollWeights.tapDragRelease} back:${reelsScrollWeights.back}`);
    const reelsPersonalityHistory: { lastMode?: string; streak: number } = { streak: 0 };

    // Reels snap fully to the next clip on a swipe — unlike the feed's
    // partial scroll (runCheckFeedLoop), a single full-height swipe here
    // always lands on exactly the next reel.
    const summarizeReelsSwipeScreen = (xml: string): string => {
      if (!xml) return "empty-ui-dump";
      const markers = [
        "reel_viewer", "reels_feed_media_view", "clips_tab", "clips_author_username",
        "Friends", "Popular profiles", "Suggested profiles", "People you may know",
        "Follow", "Edit profile", "Share profile", "Discover people",
        "task_view_thumbnail", "recents_container", "com.instagram.android",
      ];
      const found = markers.filter(marker => xml.includes(marker));
      const texts = [...xml.matchAll(/(?:text|content-desc)="([^"]+)"/g)]
        .map(match => match[1])
        .filter(value => value.length > 1)
        .slice(0, 16);
      return `bytes=${xml.length} markers=[${found.join(",") || "none"}] labels=[${texts.join(" | ")}]`;
    };

    const swipeToNextReel = async (reelLabel: string) => {
      const rx = Math.round(w / 2);
      // The lower 20% of the Instagram viewer contains the "Send message"
      // composer. Starting a swipe at 80% can press/focus that field before
      // Android recognizes the movement, opening the keyboard instead of
      // advancing the reel. Keep the touch-down clearly above the composer.
      const rsv = rollScrollVelocity(h, reelsScrollWeights, /*allowBack=*/false, /*safeStartFrac=*/0.68, reelsPersonalityHistory, serial);
      const reelsOverride = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides?.[rsv.mode] : undefined;
      onLog?.(`[Override] Reels swipe: mode=${rsv.mode}, duration=${rsv.duration}ms${reelsOverride ? `, weight=${reelsOverride.weightMin}-${reelsOverride.weightMax}, durationRange=${reelsOverride.durationMinMs}-${reelsOverride.durationMaxMs}ms` : ", Mother Code default"}, backAllowed=false`);
      reelsPersonalityHistory.streak = reelsPersonalityHistory.lastMode === rsv.mode ? reelsPersonalityHistory.streak + 1 : 1;
      reelsPersonalityHistory.lastMode = rsv.mode;
      const beforeXml = await android.dumpUi(serial).catch(() => "");
      onLog?.(`${reelLabel}: swipe screen BEFORE — ${summarizeReelsSwipeScreen(beforeXml)}`);
      const reelsModeLabel = rsv.mode === "superSkim" ? "super skim" : rsv.mode;
      onLog?.(`${reelLabel}: advance swipe [${reelsModeLabel}]`);
      logger.info({ serial, source: "reels-advance", mode: rsv.mode, from: [rx, rsv.fromY], to: [rx, rsv.toY], durationMs: rsv.duration }, "[mobile-input] swipe");
      const actualPath = await deviceProfileSwipe(serial, { x1: rx, y1: rsv.fromY, x2: rx, y2: rsv.toY, durationMs: rsv.duration }, "reels-advance", rsv.mode as any);
      const afterXml = await android.dumpUi(serial).catch(() => "");
      onLog?.(
        `${reelLabel}: swipe screen AFTER — ${summarizeReelsSwipeScreen(afterXml)}` +
        `; completed=${actualPath.x1},${actualPath.y1}->${actualPath.x2},${actualPath.y2}`,
      );
    };

    for (let i = 0; i < totalReels; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      const reelTimingStartedAt = Date.now();
      let reelTimingAfterWatch = reelTimingStartedAt;
      let reelTimingAfterActions = reelTimingStartedAt;
      onLog?.(`Reel ${i + 1}/${totalReels}`);

      // Watch a configurable % of the reel before acting. Keeps the reel
      // visible long enough for Instagram to render the action-icon column,
      // and gives the reel a natural watch time. Assumed max reel duration
      // is 30 s; watchPct is rolled fresh each reel.
      const watchPct = rollRange(watchPctMin, watchPctMax);
      const watchMs  = Math.max(1500, Math.round((watchPct / 100) * 30000));
      onLog?.(`Reel ${i + 1}/${totalReels}: watching ${watchPct.toFixed(0)}% (~${(watchMs / 1000).toFixed(1)}s)`);
      await sleepOrAbort(serial, watchMs);
      reelTimingAfterWatch = Date.now();

      // Roll like/share decisions fresh per reel so each reel is independent.
      const wantLike      = likePercentMax > 0 && Math.random() * 100 < rollRange(likePercentMin, likePercentMax);
      const wantShareFeed = shareFeedPercentMax > 0 && Math.random() * 100 < rollRange(shareFeedPercentMin, shareFeedPercentMax);
      const wantSave      = savePercentMax > 0 && Math.random() * 100 < rollRange(savePercentMin, savePercentMax);
      const wantShareDm     = shareDmPercentMax > 0 && Math.random() * 100 < rollRange(shareDmPercentMin, shareDmPercentMax);
      const wantClickAuthor = clickAuthorPctMax > 0 && Math.random() * 100 < rollRange(clickAuthorPctMin, clickAuthorPctMax);

      // Holds the last UIAutomator dump from the reel-player poll below.
      // Declared here (outside the poll block) so the ad-detection check at
      // the bottom of this reel iteration can reference it regardless of
      // whether the poll block ran (i.e. even when wantLike/Share/Save are all
      // false but wantClickAuthor or another action is active).
      let lastPollXml = "";

      if (wantLike || wantShareFeed || wantSave || wantShareDm) {
        // ── View Reels: wait for reel player nodes to appear ────────────────
        // Problem: the reel viewer sometimes opens in a separate accessibility
        // window layer (observed on Xiaomi MIUI). UIAutomator's dump captures
        // only the focused window — during the opening animation or before the
        // view attaches, the dump still returns the underlying Reels tab UI
        // rather than the player. findReelActionIcons running against that dump
        // finds nothing and returns null, so the like/share is silently skipped.
        //
        // Fix: cheap raw-dump poll for ANY known reel-player node before the
        // expensive column scan. The moment one appears the tree is ready.
        // If no node appears within the budget, fall through — the existing
        // null path handles it as before, but now logs every poll attempt.
        // This block is isolated to the View Reels loop and has no effect on
        // any other tool.
        {
          // Match what findReelActionIcons actually anchors on: content-desc
          // "Like" / "Unlike" in the right-side column. The old resource-id
          // list (like_count, comment_button, direct_share_button) does not
          // exist on all devices/IG builds, causing the poll to burn its full
          // 6 × 2 s budget even when the reel is visibly playing.
          // Signals that the reel player's view hierarchy has attached to the
          // a11y tree.  Ordered from most-specific to least-specific so the
          // poll exits as early as possible.
          //
          // Why not content-desc="Like"/"Unlike" only?
          //   On some device/IG-build combinations (observed: Redmi 12 5G) the
          //   Reels action icons do NOT carry those exact content-desc values —
          //   the poll burned its full 12 s budget every reel, then proceeded
          //   to findReelActionIcons which also failed to find the Like anchor
          //   and returned null, silently skipping every action.
          //
          // The resource-id markers below appear in the reel player view
          // hierarchy even when content-desc is absent:
          //   • reel_viewer_*       — reel_viewer_root / reel_viewer_video_player / …
          //   • reels_feed_media_view_root — Reels-tab feed container
          //   • :id/outer_container — action-icon column container on builds
          //                           where individual icons lack labels
          const REEL_NODES = [
            'content-desc="Like"',
            'content-desc="Unlike"',
            "reel_viewer",                  // reel_viewer_root, _video_player, _toolbar, …
            "reels_feed_media_view",        // Reels-tab feed root (some builds)
            ":id/outer_container",          // action-icon column container (no-cd builds)
            // Ad reels use a completely different view hierarchy — no reel_viewer
            // IDs and no Like/Unlike nodes — so the poll was burning its full 12 s
            // on every ad. Including the ad markers here lets the poll exit on the
            // first attempt. The isReelAd check below still fires and skips actions.
            'text="Ad"',
            'content-desc="Ad"',
            'text="Sponsored"',
            'content-desc="Sponsored"',
          ];
          const POLL_MS   = 2000;
          const MAX_POLLS = 6; // up to 12 s extra wait
          let reelReady = false;
          for (let p = 0; p < MAX_POLLS && !reelReady; p++) {
            const pollXml = await android.dumpUi(serial).catch(() => "");
            lastPollXml = pollXml;
            // This poll is entered only after findReelsTab() succeeded and the
            // Reels tab was tapped.  Some Xiaomi/Instagram builds render the
            // full-screen Reels player without exposing any reel_viewer_* or
            // reels_feed_media_view_* nodes to UIAutomator.  In that case the
            // focused Instagram window is the reliable screen-level signal;
            // requiring a player resource-id produces a false "never
            // appeared" diagnosis even though Reels is visibly on screen.
            const instagramWindowFocused =
              pollXml.includes("com.instagram.android") &&
              !pollXml.includes("task_view_thumbnail") &&
              !pollXml.includes("recents_container") &&
              !pollXml.includes("recents_view");
            if (REEL_NODES.some(n => pollXml.includes(n)) || instagramWindowFocused) {
              reelReady = true;
              if (p > 0) {
                onLog?.(
                  `Reel ${i + 1}/${totalReels}: Instagram window ready after ${p * POLL_MS / 1000}s extra wait` +
                  (REEL_NODES.some(n => pollXml.includes(n)) ? "" : " (screen-level fallback; player nodes unavailable on this build)"),
                );
              }
            } else {
              // Diagnose what the dump DID contain so future logs make it
              // immediately obvious why the player nodes are missing.
              // Two known causes:
              //   A) Floating window — Android's UIAutomator dumps the focused
              //      accessibility window. If Instagram is running inside a
              //      floating/pop-up window (common on Xiaomi MIUI "Free-form"
              //      or Samsung "Multi-window"), the recents/task-switcher layer
              //      is focused instead of Instagram. The dump returns the
              //      recents XML (task_view_thumbnail, txtSmallWindow, etc.)
              //      rather than any Instagram node — a dead giveaway.
              //   B) Regular window, player still loading — Instagram IS the
              //      focused window but the reel video frame hasn't attached to
              //      the a11y tree yet (brief animation / first-launch lag).
              let windowCtx: string;
              if (pollXml.includes("task_view_thumbnail") || pollXml.includes("recents_container") || pollXml.includes("recents_view")) {
                windowCtx = "⚠ floating/multi-window — dump returned Android recents layer (task_view_thumbnail detected); UIAutomator is not focused on the Instagram window";
              } else if (pollXml.includes("txtSmallWindow") || pollXml.includes("Floating windows")) {
                windowCtx = "⚠ floating-window bar detected (txtSmallWindow / 'Floating windows' present) — Instagram may be in a pop-up window";
              } else if (pollXml.includes("com.instagram.android")) {
                windowCtx = "regular window — Instagram a11y tree visible but reel player not yet attached (still loading)";
              } else {
                windowCtx = `unrecognised context — dump is ${pollXml.length} chars, no Instagram or recents nodes found`;
              }
              onLog?.(`Reel ${i + 1}/${totalReels}: player not in tree yet [${windowCtx}] — retrying in ${POLL_MS / 1000}s (poll ${p + 1}/${MAX_POLLS})`);
              await sleepOrAbort(serial, POLL_MS);
            }
          }
          if (!reelReady) onLog?.(`Reel ${i + 1}/${totalReels}: player never appeared in tree — proceeding anyway`);
        }

        // ── Ad detection — skip all actions for sponsored reels ──────────────
        // Instagram labels sponsored reels with text="Ad" or content-desc="Ad"
        // (sometimes "Sponsored"/"Advert"). Reuse the last dump from the
        // player-ready poll above — no extra dump cost. Quoted attribute
        // matching prevents false positives on "Add", "Adidas", etc.
        const isReelAd =
          lastPollXml.includes('text="Ad"')        || lastPollXml.includes('content-desc="Ad"') ||
          lastPollXml.includes('text="Sponsored"') || lastPollXml.includes('content-desc="Sponsored"') ||
          lastPollXml.includes('text="Advert"')    || lastPollXml.includes('content-desc="Advert"');
        if (isReelAd) {
          onLog?.(`Reel ${i + 1}/${totalReels}: ad post detected — skipping all actions`);
        } else {

        onLog?.(`Reel ${i + 1}/${totalReels}: scanning right-side action column…`);
        const icons = await android.findReelActionIcons(serial, (msg) => onLog?.(`  ${msg}`)).catch(() => null);
        // ── Like — require validated live action-node evidence ─────────────
        // Never guess a video coordinate when the action-column scan found no
        // Like/Unlike node. A double-tap fallback is unsafe here: the current
        // screen may be a profile, suggested-user card, ad, or another
        // non-player surface, and a guessed tap can navigate away from Reels.
        if (wantLike) {
          if (!icons) {
            onLog?.(`Reel ${i + 1}/${totalReels}: Like/Unlike node not found — skipping like safely`);
          } else if (icons.alreadyLiked) {
            onLog?.(`Reel ${i + 1}/${totalReels}: already liked — skipping like`);
          } else {
            if (!icons.like) {
              onLog?.(`Reel ${i + 1}/${totalReels}: Like node not found — skipping like safely`);
              continue;
            }
            onLog?.(`Reel ${i + 1}/${totalReels}: tapping validated Like node at (${icons.like.x},${icons.like.y})…`);
            await android.tap(serial, icons.like.x, icons.like.y);
            likes++;
            onLog?.(`Reel ${i + 1}/${totalReels}: ✓ liked`);
            await sleepOrAbort(serial, 250);
          }
        }

        // ── Share / Save — require icon coordinates ─────────────────────────
        if (!icons) {
          if (wantShareFeed || wantSave || wantShareDm) {
            onLog?.(`Reel ${i + 1}/${totalReels}: action icons not found — skipping share/save for this reel`);
          }
        } else {
          if (wantShareFeed) {
            if (!icons.shareFeed) {
              onLog?.(`Reel ${i + 1}/${totalReels}: Share to Feed icon not found — skipping`);
            } else {
              await android.tap(serial, icons.shareFeed.x, icons.shareFeed.y);
              sharesFeed++;
              onLog?.(`Reel ${i + 1}/${totalReels}: shared to feed at (${icons.shareFeed.x},${icons.shareFeed.y})`);
              await sleepOrAbort(serial, 400);
              // Instagram can show a "You reposted …'s reel" dialog after
              // Share to Feed. Check only after this repost action; do not
              // spend a dump/check on every viewed reel.
              const _vrRepostXml = await android.dumpUi(serial).catch(() => "");
              if (_vrRepostXml.includes('content-desc="Close"') || _vrRepostXml.includes('text="Close"')) {
                const _vrRepostClose = await android.findButtonByLabel(serial, "Close").catch(() => null);
                if (_vrRepostClose) {
                  await android.tap(serial, _vrRepostClose.x, _vrRepostClose.y);
                  onLog?.(`View Reels ${i + 1}/${totalReels}: dismissed repost confirmation dialog (Close)`);
                  await sleepOrAbort(serial, 250);
                } else {
                  onLog?.(`View Reels ${i + 1}/${totalReels}: repost dialog detected but Close button was not resolved`);
                }
              }
            }
          }
          if (wantSave) {
            // ── View Reels — Save (isolated; not shared with any other tool) ──
            if (icons.alreadySaved) {
              onLog?.(`Reel ${i + 1}/${totalReels}: already saved — skipping save`);
            } else if (!icons.save) {
              onLog?.(`Reel ${i + 1}/${totalReels}: Save icon not found — skipping`);
            } else {
              await android.tap(serial, icons.save.x, icons.save.y);
              saves++;
              onLog?.(`Reel ${i + 1}/${totalReels}: saved at (${icons.save.x},${icons.save.y})`);
              // Wait long enough for Instagram to show the "Save to collection?"
              // bottom sheet if it's going to (common on fresh/new accounts).
              await sleepOrAbort(serial, 600);
              // Conditionally dismiss: dump once, check for the collection popup.
              // Only tap if the popup is actually there — an unconditional tap at
              // the top of the screen would hit the Reels "For you" tab or the
              // creator header and could navigate away from the reel.
              const _vrSaveXml = await android.dumpUi(serial).catch(() => "");
              if (_vrSaveXml.includes("Start a collection") || _vrSaveXml.includes("Collect the posts")) {
                const _vrDismissX = Math.round(w * 0.50);
                const _vrDismissY = Math.round(h * 0.12);
                await android.tap(serial, _vrDismissX, _vrDismissY);
                onLog?.(`Reel ${i + 1}/${totalReels}: dismissed "Save to collection?" popup`);
                await sleepOrAbort(serial, 300);
              }
            }
          }
          if (wantShareDm) {
            if (!icons.shareDm) {
              onLog?.(`Reel ${i + 1}/${totalReels}: Share via DM icon not found — skipping`);
            } else {
              // ── View Reels — Share via DM (isolated; not shared with any other tool) ──
              const _vrPfx = `Reel ${i + 1}/${totalReels}`;
              let _vrDmSent = false;
              try {
                if (isCycleAborted(serial)) throw new Error("cycle-aborted");
                await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
                onLog?.(`${_vrPfx}: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
                await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
                await sleepOrAbort(serial, 1500);
                onLog?.(`${_vrPfx}: confirming share sheet opened and picking DM recipient…`);
                const _vrShareScanOptions = { strictContactParents: true };
                let _vrScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                if (!_vrScan?.sheetOpen) {
                  onLog?.(`${_vrPfx}: share sheet not yet visible — waiting 1500ms and retrying…`);
                  await sleepOrAbort(serial, 1500);
                  _vrScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                }
                if (!_vrScan?.sheetOpen) {
                  logger.warn({ serial }, "[view-reels] share sheet not confirmed open after retry — closing and skipping DM");
                  onLog?.(`${_vrPfx}: share aborted — share sheet did not open`);
                  await android.pressBack(serial);
                  await sleepOrAbort(serial, 200);
                } else {
                  let _vrShareAborted = false;
                  if (_vrScan.preSelectedRecipients && _vrScan.preSelectedRecipients.length > 0) {
                    onLog?.(`${_vrPfx}: deselecting ${_vrScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
                    for (const _r of _vrScan.preSelectedRecipients) {
                      onLog?.(`${_vrPfx}: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
                      await android.tap(serial, _r.x, _r.y);
                      await sleepOrAbort(serial, 400);
                    }
                    // Deselecting a prior contact can reflow the grid. Never
                    // reuse coordinates from the pre-deselection dump.
                    const _vrRefresh = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                    if (!_vrRefresh?.sheetOpen) {
                      await android.pressBack(serial);
                      onLog?.(`${_vrPfx}: share skipped — sheet disappeared while clearing prior recipient`);
                      _vrShareAborted = true;
                    }
                    if (_vrRefresh?.sheetOpen) _vrScan = _vrRefresh;
                  }
                  const _vrRecipients = _vrShareAborted ? [] : (_vrScan.recipients ?? []);
                  if (_vrRecipients.length === 0) {
                    await android.pressBack(serial);
                    logger.warn({ serial }, "[view-reels] no recipient found — closed share sheet without sending");
                    onLog?.(`${_vrPfx}: share skipped — no recipient avatars found (closed without sending)`);
                  } else {
                    const _vrLast = _viewReelsLastDmRecipient.get(serial);
                    const _vrPool = _vrLast ? _vrRecipients.filter(r => !(r.x === _vrLast.x && r.y === _vrLast.y)) : _vrRecipients;
                    const _vrCands = _vrPool.length > 0 ? _vrPool : _vrRecipients;
                    const _vrPick = _vrCands[Math.floor(Math.random() * _vrCands.length)];
                    _viewReelsLastDmRecipient.set(serial, { x: _vrPick.x, y: _vrPick.y });
                    onLog?.(
                      `${_vrPfx}: validated recipient candidate — ` +
                      `bounds="${String((_vrPick as any).bounds ?? `[${_vrPick.x},${_vrPick.y}]`) }" ` +
                      `rid="${String((_vrPick as any).resourceId ?? "")}" ` +
                      `class="${String((_vrPick as any).className ?? "")}" ` +
                      `text="${String((_vrPick as any).text ?? "")}" ` +
                      `content-desc="${String((_vrPick as any).contentDesc ?? "")}" ` +
                      `parent-desc="${String((_vrPick as any).name ?? "")}"`,
                    );
                    onLog?.(`${_vrPfx}: tapping recipient at (${_vrPick.x},${_vrPick.y})${(_vrPick as any).name ? ` (${(_vrPick as any).name})` : ""}`);
                    await android.tap(serial, _vrPick.x, _vrPick.y);
                    await sleepOrAbort(serial, 800);
                    // A disappeared sheet is NOT proof that a DM was sent:
                    // tapping the reused avatar resource can launch WhatsApp
                    // or another external shortcut. Confirm the selected
                    // contact itself before looking for Send.
                    const _vrPostTapScan = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                    const _vrPickName = String((_vrPick as any).name ?? "").replace(/\bnot selected\b|\bselected\b/gi, "").trim();
                    const _vrSelected = _vrPostTapScan?.sheetOpen === true &&
                      (_vrPostTapScan.preSelectedRecipients ?? []).some(r => {
                        const samePoint = Math.abs(r.x - _vrPick.x) <= 35 && Math.abs(r.y - _vrPick.y) <= 35;
                        const rName = String((r as any).name ?? "").replace(/\bnot selected\b|\bselected\b/gi, "").trim();
                        return samePoint || Boolean(_vrPickName && rName && rName === _vrPickName);
                      });
                    if (!_vrSelected) {
                      onLog?.(`${_vrPfx}: share skipped — recipient selection was not positively confirmed; refusing to treat a dismissed sheet as a sent DM`);
                      await android.pressBack(serial).catch(() => {});
                      await sleepOrAbort(serial, 200);
                    } else {
                      // Always do a fresh lookup after recipient tap — the Send
                      // button only appears once a recipient is selected.
                      // findDmSendButton tries resource-ids first before the
                      // label fallback.
                      const _vrSb = await android.findDmSendButton(serial).catch(() => null);
                      if (_vrSb) {
                        await android.tap(serial, _vrSb.x, _vrSb.y);
                        await sleepOrAbort(serial, 1000);
                        const _vrAfterSend = await android.confirmAndScanShareSheet(serial, onLog, _vrShareScanOptions).catch(() => null);
                        if (!_vrAfterSend?.sheetOpen) {
                          _vrDmSent = true;
                          logger.info({ serial }, "[view-reels] shared post via DM — Send tapped");
                          onLog?.(`${_vrPfx}: ✓ shared via DM — Send tapped`);
                          await sleepOrAbort(serial, 300);
                        } else {
                          logger.info({ serial }, "[view-reels] Send tapped but sheet still open — pressing Back");
                          onLog?.(`${_vrPfx}: Send tapped but sheet did not close — pressing Back`);
                          await android.pressBack(serial);
                          await sleepOrAbort(serial, 200);
                        }
                      } else {
                        // Send button not found after a confirmed contact
                        // selection — press Back and skip rather than guessing.
                        // No coordinate fallback: tapping a blind Y-fraction risks hitting
                        // the Android nav bar (Home button) and dismissing Instagram.
                        logger.info({ serial }, "[view-reels] Send button not found — pressing Back and skipping DM share");
                        onLog?.(`${_vrPfx}: Send button not found via a11y — pressing Back and skipping`);
                        await android.pressBack(serial);
                        await sleepOrAbort(serial, 200);
                      }
                    }
                  }
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                onLog?.(`${_vrPfx}: share-via-DM error — ${e?.message}`);
              }
              if (_vrDmSent) sharesDm++;
            }
          }
        }
        } // end !isReelAd
      }

      // ── Click Author — navigate to creator profile, scroll, then Back ──────
      // Independent of the icon scan: uses the XML dump to locate
      // clips_author_username (bottom-left of the Reels viewer) directly.
      if (wantClickAuthor) {
        const _vrCaPfx = `View Reels ${i + 1}/${totalReels}`;
        try {
          if (isCycleAborted(serial)) throw new Error("cycle-aborted");
          onLog?.(`${_vrCaPfx}: clicking author profile…`);
          // Author visiting is optional. Do not let a slow UIAutomator dump
          // stall the whole Reels run when the author node is unavailable.
          const _vrCaXml = await Promise.race([
            android.dumpUi(serial).catch(() => ""),
            new Promise<string>(resolve => setTimeout(() => resolve(""), 2500)),
          ]);
          // Skip author click if Instagram labels this as a sponsored post.
          // Quoted attribute matching prevents false positives on words like
          // "Add", "Adidas", etc. whose text values differ from the bare "Ad".
          const _vrCaIsAd =
            _vrCaXml.includes('text="Ad"')         || _vrCaXml.includes('content-desc="Ad"') ||
            _vrCaXml.includes('text="Sponsored"')  || _vrCaXml.includes('content-desc="Sponsored"') ||
            _vrCaXml.includes('text="Advert"')     || _vrCaXml.includes('content-desc="Advert"');
          if (_vrCaIsAd) {
            onLog?.(`${_vrCaPfx}: ad post detected — skipping click author`);
          } else {
          // Try clips_author_username first, then clips_author_info_component.
          // Raw UIAutomator XML uses resource-id="com.instagram.android:id/<name>"
          // so we match the plain name fragment (same approach as all polling code)
          // then grab the first bounds="[x1,y1][x2,y2]" that follows it.
          const _findNode = (rid: string): { x: number; y: number } | null => {
            const _idx = _vrCaXml.indexOf(rid);
            if (_idx === -1) return null;
            const _seg = _vrCaXml.slice(_idx);
            const _bm = _seg.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
            if (!_bm) return null;
            return {
              x: Math.round((parseInt(_bm[1]) + parseInt(_bm[3])) / 2),
              y: Math.round((parseInt(_bm[2]) + parseInt(_bm[4])) / 2),
            };
          };
          const _vrCaNode = _findNode("clips_author_username") ?? _findNode("clips_author_info_component");
          if (!_vrCaNode) {
            onLog?.(`${_vrCaPfx}: author node not found in dump — skipping click author`);
          } else {
            onLog?.(`${_vrCaPfx}: tapping author at (${_vrCaNode.x},${_vrCaNode.y})…`);
            await android.tap(serial, _vrCaNode.x, _vrCaNode.y);
            await sleepOrAbort(serial, 1800);
            const _vrCaScrolls = Math.floor(rollRange(1, 10));
            onLog?.(`${_vrCaPfx}: on author profile — scrolling ${_vrCaScrolls} time(s)…`);
            const _cx = Math.round(w / 2);
            for (let _s = 0; _s < _vrCaScrolls; _s++) {
              if (isCycleAborted(serial)) throw new Error("cycle-aborted");
              const _cfY = Math.round(h * 0.75);
              const _ctY = Math.round(h * 0.30);
              await deviceProfileSwipe(serial, { x1: _cx, y1: _cfY, x2: _cx, y2: _ctY, durationMs: 400 + Math.round(Math.random() * 200) }, "reels-author-profile-scroll");
              const _dwell = 2500 + Math.round(Math.random() * 7500);
              onLog?.(`${_vrCaPfx}: author scroll ${_s + 1}/${_vrCaScrolls} — dwell ${(_dwell / 1000).toFixed(1)}s`);
              await sleepOrAbort(serial, _dwell);
            }
            await android.pressBack(serial);
            onLog?.(`${_vrCaPfx}: ✓ visited author profile (${_vrCaScrolls} scroll(s)) — pressed Back`);
            await sleepOrAbort(serial, 800);
          }
          } // end ad-skip else
        } catch (e: any) {
          if (e?.message === "cycle-aborted") throw e;
          onLog?.(`Reel ${i + 1}/${totalReels}: click-author error — ${e?.message}`);
        }
      }
      reelTimingAfterActions = Date.now();

      reelsViewed++;
      onProgress?.({ reelsViewed, likes, sharesFeed, sharesDm, saves });
      onLog?.(
        `Reel ${i + 1}/${totalReels} timing — ` +
        `watch-wait=${((reelTimingAfterWatch - reelTimingStartedAt) / 1000).toFixed(1)}s, ` +
        `actions/author=${((reelTimingAfterActions - reelTimingAfterWatch) / 1000).toFixed(1)}s, ` +
        `total=${((reelTimingAfterActions - reelTimingStartedAt) / 1000).toFixed(1)}s`,
      );

      if (i < totalReels - 1) {
        await swipeToNextReel(`Reel ${i + 1}/${totalReels}`);
        await sleepOrAbort(serial, 400 + Math.round(Math.random() * 300));
      }
    }

    return { reelsViewed, likes, sharesFeed, sharesDm, saves };
  }

  app.post("/api/mobile/devices/:serial/check-feed", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    if (checkFeedInProgress.has(serial)) {
      res.status(409).json({ error: "A Check Feed run is already in progress on this device" });
      return;
    }
    checkFeedInProgress.add(serial);
    try {
      const params = checkFeedSchema.parse(req.body);
      const { count, likes, likeFailures, strayNavRecoveries } = await runCheckFeedLoop(serial, params);
      res.json({ ok: true, count, likes, likeFailures, strayNavRecoveries });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to check feed" }); }
    finally { checkFeedInProgress.delete(serial); }
  });

  // ── Automation Cycle — the full "toggle on" lifecycle, per user
  // instruction: power on the phone, open Instagram, run the configured
  // scroll/like/share/stories tools, close Instagram by swiping it away in
  // the recent-apps switcher, cycle airplane mode off/on to force a fresh
  // connection, then lock the phone again. Each toggle "tick" runs this
  // whole sequence once; the frontend calls it back-to-back on a randomized
  // gap while the master toggle stays on, so it recycles every time.
  const automationCycleSchema = checkFeedSchema.extend({
    airplaneWaitMinSec: z.number().min(1).max(120).default(15),
    airplaneWaitMaxSec: z.number().min(1).max(120).default(20),
    // Master on/off switches for each slide of the cycle (12 Jul 2026).
    // When a step is unticked in the UI, its whole block never runs — this
    // is purely a gate, not a percentage/chance like the fields below.
    feedEnabled: z.boolean().default(true),
    storiesEnabled: z.boolean().default(true),
    shareFeedPercentMin: z.number().min(0).max(100).default(0),
    shareFeedPercentMax: z.number().min(0).max(100).default(0),
    shareDmPercentMin: z.number().min(0).max(100).default(0),
    shareDmPercentMax: z.number().min(0).max(100).default(0),
    savePercentMin: z.number().min(0).max(100).default(0),
    savePercentMax: z.number().min(0).max(100).default(0),
    expandCaptionPercentMin: z.number().min(0).max(100).default(0),
    expandCaptionPercentMax: z.number().min(0).max(100).default(0),
    tapAudioPercentMin: z.number().min(0).max(100).default(0),
    tapAudioPercentMax: z.number().min(0).max(100).default(0),
    clickHashtagPercentMin: z.number().min(0).max(100).default(0),
    clickHashtagPercentMax: z.number().min(0).max(100).default(0),
    clickAuthorPercentMin: z.number().min(0).max(100).default(0),
    clickAuthorPercentMax: z.number().min(0).max(100).default(0),
    feedRerunChanceMin: z.number().min(0).max(100).default(0),
    feedRerunChanceMax: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMin: z.number().min(0).max(100).default(0),
    viewStoriesSlidesMax: z.number().min(0).max(100).default(0),
    viewStoriesSlideWatchPctMin: z.number().min(1).max(100).default(50),
    viewStoriesSlideWatchPctMax: z.number().min(1).max(100).default(90),
    viewStoriesLikePercentMin: z.number().min(0).max(100).default(0),
    viewStoriesLikePercentMax: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesCommentPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesCommentPercentMax: z.number().min(0).max(100).default(0),
    viewStoriesClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewStoriesClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    // View Reels — see AutomationSettings type above for full comment.
    viewReelsEnabled: z.boolean().default(false),
    viewReelsScrollMin: z.number().min(0).max(100).default(0),
    viewReelsScrollMax: z.number().min(0).max(100).default(0),
    viewReelsLikePercentMin: z.number().min(0).max(100).default(0),
    viewReelsLikePercentMax: z.number().min(0).max(100).default(0),
    viewReelsShareFeedPercentMin: z.number().min(0).max(100).default(0),
    viewReelsShareFeedPercentMax: z.number().min(0).max(100).default(0),
    viewReelsShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewReelsShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewReelsSavePercentMin: z.number().min(0).max(100).default(0),
    viewReelsSavePercentMax: z.number().min(0).max(100).default(0),
    viewReelsActivatePctMin: z.number().min(0).max(100).default(100),
    viewReelsActivatePctMax: z.number().min(0).max(100).default(100),
    viewReelsWatchPctMin: z.number().min(1).max(100).default(30),
    viewReelsWatchPctMax: z.number().min(1).max(100).default(70),
    viewReelsClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewReelsClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    // View Explore Page — see AutomationSettings type for full comment.
    viewExploreEnabled: z.boolean().default(false),
    viewExploreActivatePctMin: z.number().min(0).max(100).default(100),
    viewExploreActivatePctMax: z.number().min(0).max(100).default(100),
    viewExploreScrollMin: z.number().min(0).max(100).default(0),
    viewExploreScrollMax: z.number().min(0).max(100).default(0),
    viewExploreActionDelayMin: z.number().min(0).max(9999).default(3),
    viewExploreActionDelayMax: z.number().min(0).max(9999).default(6),
    viewExploreClickPostPctMin: z.number().min(0).max(100).default(0),
    viewExploreClickPostPctMax: z.number().min(0).max(100).default(0),
    viewExploreLikePercentMin: z.number().min(0).max(100).default(0),
    viewExploreLikePercentMax: z.number().min(0).max(100).default(0),
    viewExploreShareFeedPercentMin: z.number().min(0).max(100).default(0),
    viewExploreShareFeedPercentMax: z.number().min(0).max(100).default(0),
    viewExploreShareDmPercentMin: z.number().min(0).max(100).default(0),
    viewExploreShareDmPercentMax: z.number().min(0).max(100).default(0),
    viewExploreSavePercentMin: z.number().min(0).max(100).default(0),
    viewExploreSavePercentMax: z.number().min(0).max(100).default(0),
    viewExploreClickAuthorPercentMin: z.number().min(0).max(100).default(0),
    viewExploreClickAuthorPercentMax: z.number().min(0).max(100).default(0),
    // Check DMs — opens the inbox, scrolls through it, and optionally taps one
    // conversation thread. Positioned between View Reels and Follow Users in the
    // tool sequence to mimic the natural human habit of checking messages mid-session.
    checkDmEnabled: z.boolean().default(false),
    checkDmActivatePctMin: z.number().min(0).max(100).default(100),
    checkDmActivatePctMax: z.number().min(0).max(100).default(100),
    checkDmScrollMin: z.number().min(0).default(1),
    checkDmScrollMax: z.number().min(0).default(3),
    checkDmClickPctMin: z.number().min(0).max(100).default(0),
    checkDmClickPctMax: z.number().min(0).max(100).default(0),
    // Follow Users — HikerAPI-driven follow flow. HikerAPI fetches candidates
    // from the configured target sources (hashtags / followers-of-account);
    // the software then navigates to Instagram Search and follows each user by
    // typing their @username character-by-character on the on-screen keyboard.
    followEnabled: z.boolean().default(false),
    followUsersMin: z.number().min(0).max(9999).default(1),
    followUsersMax: z.number().min(0).max(9999).default(3),
    followSpreadFollows: z.boolean().default(false),
    followSources: z.array(z.object({ type: z.string(), value: z.string() })).default([]),
    preSwitchEnabledMin: z.number().min(0).max(100).default(0),
    preSwitchEnabledMax: z.number().min(0).max(100).default(0),
    preSwitchActionPercentMin: z.number().min(0).max(100).default(0),
    preSwitchActionPercentMax: z.number().min(0).max(100).default(0),
    followMaxScrapeSessions: z.number().min(0).max(999).default(0),
    // Inject Browsing — per-user profile-browsing behaviour woven into the
    // Follow Users flow itself (12 Jul 2026 rework). There is no per-item
    // enable toggle anymore: search-browsing (landing on the profile via
    // Search) is mandatory and always happens as part of following, "Get
    // Suggested Users" was removed, and the old separate "Inject Profile
    // Browsing" toggle was a duplicate of this whole section. The single
    // injectBrowsingEnabled switch below gates everything; the roll
    // percentages/counts are re-rolled independently for every user.
    injectBrowsingEnabled: z.boolean().default(false),
    // Rolled once per user: outer gate — whether inject browsing runs at all
    // for this user. min=30/max=60 → ~45% of users get the browsing sequence.
    injectBrowsingActivatePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingActivatePctMax: z.number().min(0).max(100).default(0),
    // Rolled once per user (if activate passed): chance THIS user gets the
    // profile-browsing sequence before they're followed. min=5/max=10 → each
    // user independently has an ~7.5% (avg of the range) chance of it happening.
    injectBrowsingBeforeFollowPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingBeforeFollowPctMax: z.number().min(0).max(100).default(0),
    // Chance, once browsing is triggered for this user, that their grid of
    // posts gets scrolled at all.
    injectBrowsingFeedChanceMin: z.number().min(0).max(100).default(100),
    injectBrowsingFeedChanceMax: z.number().min(0).max(100).default(100),
    // How many rows to scroll down (Instagram's profile grid is 3 posts per
    // row) when the feed-chance roll above succeeds.
    injectBrowsingFeedMin: z.number().min(0).default(3),
    injectBrowsingFeedMax: z.number().min(0).default(6),
    // Chance to open (click) one of the scrolled-past posts.
    injectBrowsingClickPostPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingClickPostPctMax: z.number().min(0).max(100).default(0),
    // Once a post is opened: chance to like it / repost it / share it via DM.
    injectBrowsingLikePctMin: z.number().min(0).max(100).default(0),
    injectBrowsingLikePctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareFeedPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingShareDmPctMax: z.number().min(0).max(100).default(0),
    injectBrowsingTapHighlightsPctMin: z.number().min(0).max(100).default(0),
    injectBrowsingTapHighlightsPctMax: z.number().min(0).max(100).default(0),
    // ── Filters — profile-quality gates applied before each follow action.
    // followFiltersEnabled is the master gate; individual sub-flags control
    // which specific checks are run.
    followFiltersEnabled: z.boolean().default(false),
    followFilterVerifiedUsers: z.boolean().default(false),
    followFilterMaxFollowers25k: z.boolean().default(false),
    followFilterMalesOnly: z.boolean().default(false),
    followFilterMaleNames: z.string().default(""),
    followFilterPrivateUsers: z.boolean().default(false),
    followFilterEnglishSpeaking: z.boolean().default(false),
    followFilterMinFollowers50: z.boolean().default(false),
    // ── Random Jitter — human-like interstitial actions fired on each cycle
    // at a random percentage chance.  Master gate: randomJitterEnabled.
    randomJitterEnabled: z.boolean().default(false),
    // Check Notifications: taps the heart icon, scrolls, optionally taps an item.
    checkNotificationsPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsPctMax: z.number().min(0).max(100).default(0),
    checkNotificationsScrollsMin: z.number().min(0).default(2),
    checkNotificationsScrollsMax: z.number().min(0).default(5),
    checkNotificationsClickPctMin: z.number().min(0).max(100).default(0),
    checkNotificationsClickPctMax: z.number().min(0).max(100).default(0),
    // Visit My Profile: taps the profile icon in the bottom nav, then returns.
    visitProfilePctMin: z.number().min(0).max(100).default(0),
    visitProfilePctMax: z.number().min(0).max(100).default(0),
    // Visit Saved: profile → hamburger → Saved page, scrolls 1–10×, returns.
    visitSavedPctMin: z.number().min(0).max(100).default(0),
    visitSavedPctMax: z.number().min(0).max(100).default(0),
    // Visit Random Settings: profile → hamburger → tap one row, optionally
    // scroll once, then press Back once.
    visitSettingsPctMin: z.number().min(0).max(100).default(0),
    visitSettingsPctMax: z.number().min(0).max(100).default(0),
    // App Switch: press square button, open SMS for random 10–30 s, return to Instagram.
    appSwitchPctMin: z.number().min(0).max(100).default(0),
    appSwitchPctMax: z.number().min(0).max(100).default(0),
    // Update Profile Picture
    updateProfilePicActivatePctMin: z.number().min(0).max(100).default(0),
    updateProfilePicActivatePctMax: z.number().min(0).max(100).default(0),
    updateProfilePicFolderPath: z.string().default(""),
    updateProfilePicDisableAfterUsed: z.boolean().default(false),
    updateProfilePicAlterationEnabled: z.boolean().default(true),
    updateProfilePicAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    updateProfilePicImageSettingsEnabled: z.boolean().default(true),
    updateProfilePicImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
    // Update Bio
    updateBioActivatePctMin: z.number().min(0).max(100).default(0),
    updateBioActivatePctMax: z.number().min(0).max(100).default(0),
    updateBioText: z.string().default(""),
    updateBioDisableAfterUsed: z.boolean().default(false),
    // ── Activate Percentage — see AutomationSettings type for full comment.
    // Rolled once per tool per automation-cycle execution, gating whether
    // that tool runs at all THIS cycle, on top of its own enabled toggle.
    feedActivatePctMin: z.number().min(0).max(100).default(100),
    feedActivatePctMax: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMin: z.number().min(0).max(100).default(100),
    viewStoriesActivatePctMax: z.number().min(0).max(100).default(100),
    followActivatePctMin: z.number().min(0).max(100).default(100),
    followActivatePctMax: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMin: z.number().min(0).max(100).default(100),
    randomJitterActivatePctMax: z.number().min(0).max(100).default(100),
    // ── Make a Post — wired into the automation cycle (13 Jul 2026).
    // Only the local-folder image source is used for the on-device flow.
    // ALL makePost* fields that the cycle handler reads MUST be listed here —
    // Zod strips unknown keys, so any field missing from this schema arrives
    // as undefined in the handler regardless of what the frontend sends.
    makePostEnabled: z.boolean().default(false),
    makePostActivatePctMin: z.number().min(0).max(100).default(100),
    makePostActivatePctMax: z.number().min(0).max(100).default(100),
    makePostPerSessionMin: z.number().min(1).max(20).default(1),
    makePostPerSessionMax: z.number().min(1).max(20).default(1),
    makePostLocalFolderEnabled: z.boolean().default(true),
    makePostLocalFolderPath: z.string().default(""),
    makePostLocalFolderNoRepeat: z.boolean().default(false),
    makePostLocalFolderRandom: z.boolean().default(false),
    makePostLocalFolderDeleteAfterUpload: z.boolean().default(false),
    makePostCaptionText: z.string().default(""),
    makePostAlterationEnabled: z.boolean().default(true),
    makePostAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    makePostImageSettingsEnabled: z.boolean().default(true),
    makePostImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
     // Fix AI Slop — strip C2PA / EXIF / XMP / IPTC metadata and apply pixel
    // perturbation before pushing the image to the device.  MUST be in this
    // schema or Zod strips it from the request body and doFixAiSlop is always
    // undefined (falsy) regardless of what the frontend sends.
     makePostFixAiSlop: z.boolean().default(true),
     makePostMetadataCleanup: z.boolean().default(true),
     makePostFrequencyDisruption: z.boolean().default(false),
    // Post destination: probability that a given Make a Post attempt goes to
    // the profile feed vs. to a Story.  Defaults keep existing behaviour
    // (profile=100%, story=0%).  If story is rolled first (random < storyPct),
    // the story flow runs; otherwise the profile flow runs if profilePct allows.
    makePostPostToProfilePctMin: z.number().min(0).max(100).default(100),
    makePostPostToProfilePctMax: z.number().min(0).max(100).default(100),
    makePostPostToStoryPctMin: z.number().min(0).max(100).default(0),
    makePostPostToStoryPctMax: z.number().min(0).max(100).default(0),
    // ── Post a Story — standalone Story publisher, separate from Make a Post.
    postStoryEnabled: z.boolean().default(false),
    postStoryActivatePctMin: z.number().min(0).max(100).default(100),
    postStoryActivatePctMax: z.number().min(0).max(100).default(100),
    postStoryLocalFolderPath: z.string().default(""),
    postStoryLocalFolderNoRepeat: z.boolean().default(false),
    postStoryLocalFolderRandom: z.boolean().default(false),
    postStoryAlterationEnabled: z.boolean().default(true),
    postStoryAlterationLevel: z.enum(["small", "medium", "high"]).default("small"),
    postStoryImageSettingsEnabled: z.boolean().default(true),
    postStoryImageSettings: z.object({
      contrast: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      brightness: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      noise: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      sharpen: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
      pixelate: z.object({ enabled: z.boolean(), min: z.number(), max: z.number() }),
    }).default({
      contrast: { enabled: true, min: 5, max: 250 },
      brightness: { enabled: true, min: 5, max: 250 },
      noise: { enabled: true, min: 5, max: 15 },
      sharpen: { enabled: true, min: 1.0, max: 2.0 },
      pixelate: { enabled: true, min: 0.9, max: 2.1 },
    }),
    postStoryFixAiSlop: z.boolean().default(false),
    postStoryAddLink: z.boolean().default(false),
    postStoryLinkUrl: z.string().default(""),
    // Which Instagram account slot is driving this cycle. When set the cycle
    // switches to that account via the built-in Instagram switcher before
    // running any tools, so each slot's settings are always applied to the
    // correct account even when multiple accounts share the same device.
    slotUsername: z.string().optional().default(""),
    slotIdx: z.number().int().min(0).default(0),
    // Shuffle tool order — when true, the six Step-2 tools (Feed, Stories,
    // Reels, Follow, Post, Jitter) are Fisher-Yates shuffled into a random
    // order before each cycle runs.  When false the default fixed sequence
    // is preserved.  Enables Instagram to see varied interaction patterns
    // across cycles rather than an identical ordered fingerprint every time.
    shuffleToolOrder: z.boolean().default(false),
    // ── Device profile: OEM dismiss gesture direction (same field as
    //    automationSchema — must be kept in sync per schema-drift rule).
    dismissDirection: z.enum(["auto", "left", "up"]).default("auto"),
  });
  const automationCycleInProgress = new Set<string>();
  // Tracks WHICH slot index is actively running on each device.
  // A device can only run one slot at a time (serial-level 409 guard above),
  // so a Map<serial, slotIdx> is sufficient.  Used by /api/mobile/cycle-active
  // so the frontend can show "Running" only for the slot that is actually
  // executing, not for every slot on the same physical phone.
  const automationCycleActiveSlot = new Map<string, number>();
  // Exact tool currently executing on each physical device. This is updated
  // by the dispatcher itself rather than inferred from asynchronous log text.
  const automationCurrentTool = new Map<string, string>();

  // Per-serial persistent log of users followed. Survives server restarts by
  // writing each entry to a JSON file on disk alongside the database.
  type MobileFollowedEntry = { username: string; source: string; followedAt: number };
  const mobileFollowedUsers = new Map<string, MobileFollowedEntry[]>();

  // Must NOT be derived from process.cwd() — in the packaged Windows app,
  // cwd is not a stable, guaranteed-writable location across launches (it
  // can land in a read-only Program Files path or vary by how the exe was
  // spawned). EQUINOX_DATA_DIR (set by electron/main.ts to Electron's
  // userData path) is the established stable location this codebase
  // already uses for exactly this reason — see configFilePath() above,
  // which anchors mobile-instances.json the same way. This file used cwd
  // instead, so every restart of the packaged app could resolve to a
  // different (often empty) folder, making previously followed users look
  // "wiped" even though the old JSON file was still sitting untouched in
  // the previous cwd.
  const FOLLOWED_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-followed")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-followed");
  try { fs.mkdirSync(FOLLOWED_DIR, { recursive: true }); } catch { /* already exists */ }

  // One-time migration: earlier builds wrote here (process.cwd()-based),
  // so carry any existing per-device files forward into the new stable
  // location instead of silently orphaning them.
  try {
    const legacyDir = path.join(process.cwd(), "data", "mobile-followed");
    if (legacyDir !== FOLLOWED_DIR && fs.existsSync(legacyDir)) {
      for (const f of fs.readdirSync(legacyDir)) {
        const dest = path.join(FOLLOWED_DIR, f);
        if (!fs.existsSync(dest)) fs.copyFileSync(path.join(legacyDir, f), dest);
      }
    }
  } catch { /* best effort */ }

  // Per-(serial, stable slotId) file path. The route still accepts slotIdx,
  // but the persisted filename follows the account identity so deletion and
  // renumbering cannot move history to another account.
  const _followedFilePath = (serial: string, slotIdx: number) =>
    path.join(FOLLOWED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_slot${accountSlotId(serial, slotIdx)}.json`);

  // Legacy path used before per-slot isolation was introduced.
  const _followedFilePathLegacy = (serial: string) =>
    path.join(FOLLOWED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}.json`);

  const getMobileFollowedList = (serial: string, slotIdx: number): MobileFollowedEntry[] => {
    const mapKey = `${serial}:${slotIdx}`;
    if (!mobileFollowedUsers.has(mapKey)) {
      // Hydrate from disk on first access so data survives restarts.
      try {
        const raw = fs.readFileSync(_followedFilePath(serial, slotIdx), "utf8");
        mobileFollowedUsers.set(mapKey, JSON.parse(raw) as MobileFollowedEntry[]);
      } catch {
        // For slot 0, fall back to the pre-isolation legacy file so existing
        // data is not lost after upgrading.
        if (slotIdx === 0) {
          try {
            const raw = fs.readFileSync(_followedFilePathLegacy(serial), "utf8");
            mobileFollowedUsers.set(mapKey, JSON.parse(raw) as MobileFollowedEntry[]);
          } catch {
            mobileFollowedUsers.set(mapKey, []);
          }
        } else {
          mobileFollowedUsers.set(mapKey, []);
        }
      }
    }
    return mobileFollowedUsers.get(mapKey)!;
  };

  const recordMobileFollow = (serial: string, slotIdx: number, username: string, source: string) => {
    const list = getMobileFollowedList(serial, slotIdx);
    list.unshift({ username, source, followedAt: Date.now() });
    // Persist to disk so data survives server restarts.
    try { fs.writeFileSync(_followedFilePath(serial, slotIdx), JSON.stringify(list), "utf8"); } catch { /* best effort */ }
    // Also write to the shared global followed_users table so ALL phones see
    // this follow when checking the global skip list. profileId = 0 is the
    // phone-automation sentinel (no real browser-bot profile). SQLite does not
    // enforce the FK constraint so the insert succeeds cleanly.
    storage.createFollowedUser({
      profileId: 0,
      instagramUsername: username,
      instagramUserId: "",
      sourceValue: source,
      sourceType: "phone",
      followedAt: new Date().toISOString(),
    }).catch(() => { /* best-effort — don't abort automation on a DB write failure */ });
  };

  // ── Make a Post — local-folder file picker ──────────────────────────────
  // Per-serial persistent record of which local-folder files have already
  // been posted, so "Do not repeat images" survives server restarts —
  // mirrors the mobileFollowedUsers/FOLLOWED_DIR pattern above exactly.
  const mobilePostedLocalFiles = new Map<string, string[]>();
  const POSTED_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-posted-local")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-posted-local");
  try { fs.mkdirSync(POSTED_DIR, { recursive: true }); } catch { /* already exists */ }
  const _postedFilePath = (serial: string, slotIdx = 0) =>
    path.join(POSTED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_${accountSlotId(serial, slotIdx)}.json`);
  const getPostedLocalFiles = (serial: string, slotIdx = 0): string[] => {
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    if (!mobilePostedLocalFiles.has(key)) {
      try {
        const raw = fs.readFileSync(_postedFilePath(serial, slotIdx), "utf8");
        mobilePostedLocalFiles.set(key, JSON.parse(raw) as string[]);
      } catch {
        mobilePostedLocalFiles.set(key, []);
      }
    }
    return mobilePostedLocalFiles.get(key)!;
  };
  const recordPostedLocalFile = (serial: string, slotIdx: number, fileName: string) => {
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    const list = getPostedLocalFiles(serial, slotIdx);
    list.unshift(fileName);
    try { fs.writeFileSync(_postedFilePath(serial, slotIdx), JSON.stringify(list.slice(0, 5000)), "utf8"); } catch { /* best effort */ }
  };

  // Account-scoped history of confirmed profile-feed posts. This is separate
  // from mobilePostedLocalFiles: that list is a device-wide no-repeat cache
  // and also includes Stories, while this history is the source of truth for
  // the Human Session Tool Posted Media tab and Statistics → Posts.
  type PostedProfileMediaEntry = {
    id: string;
    filename: string;
    username: string;
    slotIdx: number;
    postedAt: string;
  };
  const mobilePostedProfileMedia = new Map<string, PostedProfileMediaEntry[]>();
  const POSTED_PROFILE_MEDIA_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-posted-profile-media")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-posted-profile-media");
  try { fs.mkdirSync(POSTED_PROFILE_MEDIA_DIR, { recursive: true }); } catch { /* already exists */ }
  const _postedProfileMediaPath = (serial: string, slotIdx = 0) =>
    path.join(POSTED_PROFILE_MEDIA_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_${accountSlotId(serial, slotIdx)}.json`);
  const getPostedProfileMedia = (serial: string, slotIdx = 0): PostedProfileMediaEntry[] => {
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    if (!mobilePostedProfileMedia.has(key)) {
      try {
        const raw = fs.readFileSync(_postedProfileMediaPath(serial, slotIdx), "utf8");
        const parsed = JSON.parse(raw);
        mobilePostedProfileMedia.set(key, Array.isArray(parsed) ? parsed : []);
      } catch {
        mobilePostedProfileMedia.set(key, []);
      }
    }
    return mobilePostedProfileMedia.get(key)!;
  };
  const recordPostedProfileMedia = (serial: string, slotIdx: number, username: string, filename: string) => {
    const normalizedUsername = username.replace(/^@/, "").trim();
    if (!normalizedUsername) return;
    const entry: PostedProfileMediaEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      filename,
      username: normalizedUsername,
      slotIdx,
      postedAt: new Date().toISOString(),
    };
    const list = getPostedProfileMedia(serial, slotIdx);
    list.unshift(entry);
    try {
      fs.writeFileSync(_postedProfileMediaPath(serial, slotIdx), JSON.stringify(list.slice(0, 5000)), "utf8");
    } catch { /* best effort — posting has already succeeded */ }
  };

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

  type MakePostImageOptions = {
    doFixAiSlop?: boolean;
    alterationEnabled?: boolean;
    alterationLevel?: AlterationLevel;
    imageSettingsEnabled?: boolean;
    imageSettings?: ImageFilterSettings;
    frequencyDisruption?: boolean;
    homeTapCount?: number;
    onLog?: (msg: string) => void;
  };

  /**
   * Prepares the copy that will be sent to the phone. The source image is
   * never modified. Both Fix AI Slop and the image-alteration engine operate
   * on temporary files, and cleanup removes every temporary stage after ADB
   * push succeeds or fails.
   */
  async function prepareMakePostImage(
    localFilePath: string,
    fileName: string,
    opts: MakePostImageOptions,
  ): Promise<{
    pushFilePath: string;
    pushFileName: string;
    audit: { sourceSha256: string; processedSha256: string; processedBytes: number; format: string; width: number; height: number };
    cleanup: () => Promise<void>;
  }> {
    const { doFixAiSlop, alterationEnabled, alterationLevel, imageSettingsEnabled, imageSettings, frequencyDisruption, onLog } = opts;
    const tempFiles: string[] = [];
    const tempDirs: string[] = [];
    const prefix = fileName.includes("/") ? "Make a Post" : "Make a Post";
    const verifyProcessedImage = async (
      candidatePath: string,
      inputBytes: Buffer,
      stage: string,
    ): Promise<Buffer> => {
      const outputBytes = await fsPromises.readFile(candidatePath);
      if (!outputBytes.length || outputBytes.equals(inputBytes)) {
        throw new Error(`${stage} output was empty or byte-identical to its input`);
      }
      const metadata = readBasicImageInfo(outputBytes);
      if (!metadata.format || !metadata.width || !metadata.height) {
        throw new Error(`${stage} output is missing a recognized image header or dimensions`);
      }
      return outputBytes;
    };
    const describeImage = async (imagePath: string, bytes: Buffer) => {
      const metadata = readBasicImageInfo(bytes);
      return {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        bytes: bytes.length,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
      };
    };

    let pushFilePath = localFilePath;
    const sourceBytes = await fsPromises.readFile(localFilePath);
    const sourceAudit = await describeImage(localFilePath, sourceBytes);
    onLog?.(`${prefix}: Fix AI Slop setting = ${doFixAiSlop ? "ON" : "OFF"}`);
    if (doFixAiSlop) {
      onLog?.(`${prefix}: Fix AI Slop — stripping metadata & AI fingerprints…`);
      try {
        const inputBytes = await fsPromises.readFile(pushFilePath);
        pushFilePath = await fixAiSlop(pushFilePath, onLog);
        if (pushFilePath === localFilePath) {
          throw new Error("processor returned the original source path");
        }
        tempFiles.push(pushFilePath);
        const outputBytes = await verifyProcessedImage(pushFilePath, inputBytes, "Fix AI Slop");
        const outputAudit = await describeImage(pushFilePath, outputBytes);
        onLog?.(`${prefix}: Fix AI Slop verified — processed image is decodable and differs from input`);
        onLog?.(`${prefix}: Fix AI Slop audit — sourceSha256=${sourceAudit.sha256} processedSha256=${outputAudit.sha256} bytes=${outputAudit.bytes} format=${outputAudit.format} dimensions=${outputAudit.width}x${outputAudit.height}`);
      } catch (e: any) {
        await Promise.all(tempFiles.map(file => fsPromises.unlink(file).catch(() => {})));
        tempFiles.length = 0;
        await Promise.all(tempDirs.map(dir => fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})));
        tempDirs.length = 0;
        throw new Error(`Fix AI Slop verification failed: ${e?.message ?? "unknown error"}`);
      }
    }

    let pushFileName = fileName;
    if (alterationEnabled) {
      const level = alterationLevel ?? "small";
      onLog?.(`${prefix}: applying ${level} image alteration…`);
      try {
        const input = await fsPromises.readFile(pushFilePath);
        const altered = await alterJpegBuffer(
          input,
          level,
          imageSettingsEnabled ? imageSettings : undefined,
          frequencyDisruption === true,
        );
        const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "equinox-mobile-alter-"));
        const sourceExt = path.extname(fileName).toLowerCase();
        const isJpeg = altered.length >= 2 && altered[0] === 0xff && altered[1] === 0xd8;
        const outputExt = isJpeg ? ".jpg" : (IMAGE_EXTS.has(sourceExt) ? sourceExt : ".jpg");
        const alteredPath = path.join(tempDir, `altered${outputExt}`);
        await fsPromises.writeFile(alteredPath, altered);
        tempDirs.push(tempDir);
        tempFiles.push(alteredPath);
        pushFilePath = alteredPath;
        const outputBytes = await verifyProcessedImage(pushFilePath, input, `${level} image alteration`);
        const outputAudit = await describeImage(pushFilePath, outputBytes);

        // alterJpegBuffer emits JPEG when Sharp is available. Keep the
        // extension aligned with the bytes so Android MediaStore/Instagram
        // does not infer PNG/WebP from the original source name.
        if (isJpeg && sourceExt !== ".jpg" && sourceExt !== ".jpeg") {
          pushFileName = `${path.basename(fileName, path.extname(fileName))}.jpg`;
        }
        onLog?.(`${prefix}: ${level} image alteration verified — pushing processed copy`);
        onLog?.(`${prefix}: ${level} alteration audit — sourceSha256=${sourceAudit.sha256} processedSha256=${outputAudit.sha256} bytes=${outputAudit.bytes} format=${outputAudit.format} dimensions=${outputAudit.width}x${outputAudit.height}`);
      } catch (e: any) {
        await Promise.all(tempFiles.map(file => fsPromises.unlink(file).catch(() => {})));
        tempFiles.length = 0;
        await Promise.all(tempDirs.map(dir => fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})));
        tempDirs.length = 0;
        throw new Error(`${level} image alteration verification failed: ${e?.message ?? "unknown error"}`);
      }
    }

    // Structural Pixel Disruption was removed from mobile image preparation.
    // Keep the legacy option in the settings schema for compatibility, but
    // never consume it here: mobile Make a Post must not add a visible pattern.

    const processedBytes = await fsPromises.readFile(pushFilePath);
    const processedAudit = await describeImage(pushFilePath, processedBytes);
    return {
      pushFilePath,
      pushFileName,
      audit: {
        sourceSha256: sourceAudit.sha256,
        processedSha256: processedAudit.sha256,
        processedBytes: processedAudit.bytes,
        format: processedAudit.format,
        width: processedAudit.width,
        height: processedAudit.height,
      },
      cleanup: async () => {
        for (const tempFile of tempFiles) {
          await fsPromises.unlink(tempFile).catch(() => {});
        }
        for (const tempDir of tempDirs) {
          await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      },
    };
  }

  async function auditDeviceMediaCopy(
    serial: string,
    devicePath: string,
    expected: { sha256: string; bytes: number; format: string; width: number; height: number },
    onLog?: (msg: string) => void,
  ): Promise<void> {
    let pulledPath = "";
    try {
      pulledPath = await android.pullFileFromDevice(serial, devicePath);
      const bytes = await fsPromises.readFile(pulledPath);
      const metadata = await sharp(bytes).metadata();
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const matchesShape =
        bytes.length === expected.bytes &&
        (metadata.format ?? "unknown") === expected.format &&
        (metadata.width ?? 0) === expected.width &&
        (metadata.height ?? 0) === expected.height;
      onLog?.(
        `Media audit before Instagram: deviceSha256=${sha256} ` +
        `matchesProcessed=${sha256 === expected.sha256} bytes=${bytes.length} ` +
        `format=${metadata.format ?? "unknown"} dimensions=${metadata.width ?? 0}x${metadata.height ?? 0} ` +
        `matchesShape=${matchesShape}`,
      );
    } catch (error: any) {
      onLog?.(`Media audit before Instagram: unavailable — ${error?.message ?? error}`);
    } finally {
      if (pulledPath) {
        await fsPromises.rm(path.dirname(pulledPath), { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  async function forensicImageReport(label: string, bytes: Buffer) {
    const metadata = await sharp(bytes).metadata();
    const hashBuffer = (value?: Buffer) => value ? createHash("sha256").update(value).digest("hex") : null;
    return {
      label,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      format: metadata.format ?? "unknown",
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      space: metadata.space ?? null,
      channels: metadata.channels ?? null,
      depth: metadata.depth ?? null,
      density: metadata.density ?? null,
      chromaSubsampling: metadata.chromaSubsampling ?? null,
      isProgressive: metadata.isProgressive ?? null,
      orientation: metadata.orientation ?? null,
      hasAlpha: metadata.hasAlpha ?? null,
      embedded: {
        exif: hashBuffer(metadata.exif),
        exifBytes: metadata.exif?.length ?? 0,
        icc: hashBuffer(metadata.icc),
        iccBytes: metadata.icc?.length ?? 0,
        iptc: hashBuffer(metadata.iptc),
        iptcBytes: metadata.iptc?.length ?? 0,
        xmp: hashBuffer(metadata.xmp),
        xmpBytes: metadata.xmp?.length ?? 0,
      },
    };
  }

  /**
   * Picks the next image to post from `folderPath` per the user's Local
   * Folder settings (random vs. alphabetical order, no-repeat). Returns
   * null (with a log line) if the folder is empty/unreadable or every file
   * has already been posted — callers must treat that as "nothing to post",
   * not an error.
   */
  async function pickLocalFolderImage(serial: string, opts: {
    folderPath: string; random: boolean; noRepeat: boolean; slotIdx?: number; onLog?: (msg: string) => void;
  }): Promise<string | null> {
    const { folderPath, random, noRepeat, slotIdx = 0, onLog } = opts;
    let entries: string[];
    try {
      entries = await fsPromises.readdir(folderPath);
    } catch (e: any) {
      onLog?.(`Make a Post: could not read local folder "${folderPath}" — ${e?.message ?? "unknown error"}`);
      return null;
    }
    let images = entries.filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()));
    if (images.length === 0) {
      onLog?.(`Make a Post: no image files found in "${folderPath}"`);
      return null;
    }
    if (noRepeat) {
      const posted = new Set(getPostedLocalFiles(serial, slotIdx));
      const filtered = images.filter(f => !posted.has(f));
      if (filtered.length === 0) {
        onLog?.("Make a Post: all local-folder images already posted (Do not repeat is ON)");
        return null;
      }
      images = filtered;
    }
    const ordered = random ? [...images].sort(() => Math.random() - 0.5) : [...images].sort((a, b) => a.localeCompare(b));
    return ordered[0];
  }

  /**
   * Runs one "Make a Post" attempt: pushes a local-folder image to the
   * device, taps the "+" compose icon, walks the create-post flow (select
   * photo → Next → Next → caption → Share). Every UI-dependent step
   * verifies the expected control is actually present before tapping it
   * (findButtonByLabel/findComposeButton return null rather than a guessed
   * coordinate) and aborts the attempt with a log line instead of firing a
   * blind tap — this flow has never been exercised against a real device,
   * so failing loudly here is much safer than silently mis-tapping.
   */

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: MAKE A POST
  // Functions: pickLocalFolderImage(), runMakePostStep()
  // Route:     (called from automation-cycle only)
  // Isolation: local-folder image pick, IG composer open, caption, upload.
  //            Caption input remains on its existing direct adb-input path.
  // ═══════════════════════════════════════════════════════════════════════════

  async function runMakePostStep(serial: string, opts: {
    localFolderPath: string; localFolderRandom: boolean; localFolderNoRepeat: boolean;
    deleteAfterUpload: boolean; captionText: string;
    addLocation?: boolean;
    accountUsername?: string; slotIdx?: number;
    doFixAiSlop?: boolean;
    alterationEnabled?: boolean;
    alterationLevel?: AlterationLevel;
    imageSettingsEnabled?: boolean;
    imageSettings?: ImageFilterSettings;
    frequencyDisruption?: boolean;
    onLog?: (msg: string) => void;
  }): Promise<{ posted: boolean; fileName?: string }> {
    const {
      localFolderPath, localFolderRandom, localFolderNoRepeat, deleteAfterUpload,
      captionText, doFixAiSlop, alterationEnabled, alterationLevel,
      imageSettingsEnabled, imageSettings, frequencyDisruption, addLocation, accountUsername, slotIdx, onLog,
      homeTapCount = 1,
    } = opts;

    // Make a Post always starts from Instagram's normal Home feed.  Do not use
    // the screenshot heuristic for this tap: a bright pixel in the navigation
    // strip can be a different icon or an animation frame, and tapping it can
    // leave Instagram/kill the desktop cycle before image preparation starts.
    // The accessibility detector has the account of the live screen and its
    // known fallbacks, so keep this navigation step on that path.
    onLog?.("Make a Post: locating Instagram Home button…");
    const homeTab = await android.findHomeTab(serial).catch(() => null);
    if (!homeTab) {
      onLog?.("Make a Post: validated Instagram Home node not exposed — aborting before any tap");
      return { posted: false };
    } else {
      if (
        !Number.isFinite(homeTab.x) ||
        !Number.isFinite(homeTab.y) ||
        homeTab.x < 0 ||
        homeTab.y < 0
      ) {
        onLog?.(`Make a Post: invalid Home coordinates (${homeTab.x}, ${homeTab.y}) — aborting before any tap`);
        return { posted: false };
      }
      const taps = Math.max(1, Math.round(homeTapCount));
      for (let tapIndex = 0; tapIndex < taps; tapIndex++) {
        onLog?.(`Make a Post: tapping Instagram Home button (${tapIndex + 1}/${taps})…`);
        await android.tap(serial, homeTab.x, homeTab.y);
        if (tapIndex + 1 < taps) await sleepOrAbort(serial, 500);
      }
    }
    // Do not immediately continue after the tab tap. On slower phones the
    // Home surface remains in its transition state for several seconds; use
    // a natural randomized 3–5 second dwell before any later picker or
    // compose lookup is attempted.
    const homeDwellMs = 3000 + Math.round(Math.random() * 2000);
    onLog?.(`Make a Post: waiting ${ (homeDwellMs / 1000).toFixed(1) }s for Instagram Home to finish loading…`);
    await sleepOrAbort(serial, homeDwellMs);

    const fileName = await pickLocalFolderImage(serial, {
      folderPath: localFolderPath, random: localFolderRandom, noRepeat: localFolderNoRepeat, slotIdx, onLog,
    });
    if (!fileName) return { posted: false };
    const localFilePath = path.join(localFolderPath, fileName);

    onLog?.(`Make a Post: preparing processed image "${fileName}"…`);
    const prepared = await prepareMakePostImage(localFilePath, fileName, {
      doFixAiSlop,
      alterationEnabled,
      alterationLevel,
      imageSettingsEnabled,
      imageSettings,
      frequencyDisruption,
      onLog,
    });
    onLog?.(
      `Make a Post: image preparation complete — path=${path.basename(prepared.pushFilePath)} ` +
      `bytes=${prepared.audit.processedBytes} format=${prepared.audit.format} ` +
      `dimensions=${prepared.audit.width}x${prepared.audit.height}`,
    );

    onLog?.(`Make a Post: pushing "${fileName}" to device…`);
    let devicePath: string;
    try {
      devicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
    } catch (e: any) {
      await prepared.cleanup();
      onLog?.(`Make a Post: adb push failed — ${e?.message ?? "unknown error"}`);
      return { posted: false };
    }
    onLog?.(`Make a Post: adb push complete — devicePath=${devicePath}`);
    await prepared.cleanup();
    onLog?.("Make a Post: local prepared image cleaned up after push");
    onLog?.("Make a Post: auditing device media copy before opening Instagram picker…");
    await auditDeviceMediaCopy(serial, devicePath, prepared.audit, onLog);
    onLog?.("Make a Post: device media audit complete");
    onLog?.(`Make a Post: ✓ pushed to ${devicePath}, media-scanner notified — processedSha256=${prepared.audit.processedSha256} filename=${prepared.pushFileName} bytes=${prepared.audit.processedBytes}`);
    await sleepOrAbort(serial, 1200); // let the scanner index the file before we open the picker
    onLog?.("Make a Post: media-scan settle complete; looking for compose icon");

    onLog?.("Make a Post: looking for the \"+\" compose icon…");
    const composeBtn = await android.findComposeButton(serial).catch(() => null);
    if (!composeBtn) {
      onLog?.("Make a Post: compose \"+\" icon not found — skipping (selector likely needs real-device tuning)");
      return { posted: false };
    }
    onLog?.("Make a Post: tapping the \"+\" compose icon…");
    await android.tap(serial, composeBtn.x, composeBtn.y);
    // 3.5 s — Instagram's compose picker takes >1.8 s to finish its opening
    // animation on this device; a shorter sleep means the layout dump (and
    // every subsequent UIAutomator call) runs against a blank transitioning
    // screen instead of the real picker UI.
    await sleepOrAbort(serial, 3500);

    // One-shot layout dump — fires immediately after the "+" tap sleep,
    // before any other UIAutomator call, to capture exactly what opened.
    // This is the only dump in this flow; additional dumps compound delays
    // and can cause time-sensitive screens (the picker) to change state.
    await android.logScreenLayout(serial, "Make a Post: after '+' tap", onLog);

    // ── Wrong-header-icon guard ───────────────────────────────────────────────
    // Confirmed real-device regressions (13 Jul 2026): two different blind
    // positional fallbacks in findComposeButton have each mismatched a
    // different wrong screen — a top-right header scan hit Notifications,
    // and a bottom-nav-centre guess hit Direct/Messages (this device's
    // bottom nav has no create tab at all). findComposeButton now uses the
    // user-confirmed top-left header icon position, but this check stays as
    // a safety net: if a label/resource-id match ever points at
    // Notifications or Direct again, recover by backing out and retrying
    // once via that same confirmed top-left position instead of silently
    // continuing on the wrong screen.
    if (await android.isOnNotificationsOrDirectScreenLive(serial).catch(() => false)) {
      onLog?.("Make a Post: \"+\" tap opened Notifications/Direct instead of the composer — wrong icon tapped. Aborting without a second tap.");
      await android.pressBack(serial);
      await sleepOrAbort(serial, 800);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // Auto-clear any interstitial ("Turn on notifications?", a stray "Not now"
    // confirmation, etc.) that can appear right after opening the composer —
    // left alone it silently sits on top of the picker and every later
    // findButtonByLabel() call comes back empty.
    // NOTE: "Cancel" is excluded from DISMISS_LABELS — it is too generic and
    // would dismiss the compose/picker screen itself back to the home feed.
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    // The "+" compose icon opens a sheet with multiple post-type tabs
    // (POST / REEL / STORY). Tap the POST tab to switch into the feed-post
    // gallery/picker. When the sheet already opened on POST mode this tab
    // isn't present, so this is a no-op in that case.
    onLog?.("Make a Post: checking for POST mode tab…");
    const postTab = await android.findButtonByLabel(serial, "POST").catch(() => null)
      ?? await android.findButtonByLabel(serial, "Post").catch(() => null);
    if (postTab) {
      onLog?.("Make a Post: tapping POST tab…");
      await android.tap(serial, postTab.x, postTab.y);
      onLog?.("Make a Post: POST tab tapped — waiting 2 s for grid to load…");
      await sleepOrAbort(serial, 2000);
      onLog?.("Make a Post: 2 s wait done");
    } else {
      // POST tab not found — already on the photo picker, but give the grid
      // a moment to finish loading before we scan for thumbnails.
      onLog?.("Make a Post: no POST tab found — waiting 800 ms…");
      await sleepOrAbort(serial, 800);
      onLog?.("Make a Post: 800 ms wait done");
    }

    // ── Story-picker guard ────────────────────────────────────────────────────
    // The story "+" button in the stories tray carries content-desc="Add" and
    // appears before the compose "+" in the accessibility tree, so
    // findComposeButton can find it first and open the "Add to story" picker
    // instead of the post compose sheet.  Detect this early — before any
    // thumbnail tap or Next tap — and abort cleanly.
    //
    // Signals unique to the story picker / story editor:
    //   • "Your story" / "Close Friends" share buttons (story editor bottom bar)
    //   • overflow_button resource-id (story editor right toolbar)
    //   • "Add to story" window title text
    // If ANY of these are present we are on the wrong screen.
    const onStoryScreen = await android.isOnStoryCreator(serial).catch(() => false);
    if (onStoryScreen) {
      onLog?.("Make a Post: story picker/editor opened instead of post composer — the wrong \"+\" button was tapped. Pressing Back and aborting.");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // Instagram always auto-selects the newest gallery photo the moment the
    // New Post picker opens — the image appears in the preview area at the top.
    // Never tap a thumbnail manually: tapping the already-selected tile
    // DESELECTS it (turns it grey/white), and tapping any other tile risks
    // hitting the camera icon at grid cell 0, which opens the camera app.
    //
    // Simply check for the expand/fit toggle as a confirmation signal.  If it
    // is visible, image is confirmed selected — tap the toggle to switch from
    // IG's default centre-crop to the full original photo.  If the toggle is
    // not found in the accessibility tree (some IG builds don't expose it),
    // the image is still selected — IG's auto-selection is unconditional.
    onLog?.("Make a Post: IG auto-selects newest photo — checking for expand/fit toggle…");
    let expandToggle: { x: number; y: number } | null = null;
    for (let expandScan = 0; expandScan < 4 && !expandToggle; expandScan++) {
      expandToggle = await android.findExpandPhotoButton(serial).catch(() => null);
      if (!expandToggle && expandScan < 3) await sleepOrAbort(serial, 400);
    }

    // Confirm the picker is actually open before tapping Next. Check for any
    // recognizable picker signal: the expand toggle (only visible when a photo
    // is selected in the preview), or a labelled Next button.
    // Tap the expand/fit toggle (two-arrow icon, bottom-left of preview) to
    // switch from IG's default centre-crop to the full original photo before
    // advancing to the filter/edit screen.
    if (!expandToggle) {
      onLog?.("Make a Post: accessibility resize control not found after retries — aborting safely");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post: tapping accessibility expand/fit toggle at (${expandToggle.x}, ${expandToggle.y})…`);
    await android.tap(serial, expandToggle.x, expandToggle.y);
    await sleepOrAbort(serial, 500);

    // The expand/fit tap can animate the preview and temporarily place the
    // gallery grid over the image. Never reuse a Next coordinate found before
    // that transition: on affected Instagram builds it lands back on the
    // image/grid instead of the top-bar button. Re-dump and locate the live
    // control only after the picker has settled.
    await sleepOrAbort(serial, 700);
    onLog?.("Make a Post: re-scanning settled picker for live \"Next\" button…");
    let nextBtn1: { x: number; y: number } | null = await android.findPostNextButton(serial).catch(() => null);
    for (let nextScan = 0; nextScan < 4 && !nextBtn1; nextScan++) {
      nextBtn1 = await android.findPostNextButton(serial).catch(() => null);
      if (!nextBtn1 && nextScan < 3) await sleepOrAbort(serial, 500);
    }
    if (!nextBtn1) {
      onLog?.("Make a Post: accessibility Next control not found after retries — aborting safely");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    onLog?.(`Make a Post: found "Next" at (${nextBtn1.x}, ${nextBtn1.y}) — tapping…`);
    await android.tap(serial, nextBtn1.x, nextBtn1.y);

    // Instagram keeps the picker tree alive while the image-editor transition
    // runs. A single 1.5 s expand-toggle check races that transition: it can
    // report the old picker even though the tap succeeded, causing us to abort
    // before ever looking for the editor's second Next button.
    //
    // Prefer the editor's live labelled Next node as the success signal. Only
    // fail after a bounded settle window in which the picker signal remains and
    // no editor Next appears. All candidates still come from fresh UI dumps.
    let editorNext: { x: number; y: number } | null = null;
    let stillOnPicker: { x: number; y: number } | null = null;
    for (let advanceScan = 0; advanceScan < 10; advanceScan++) {
      await sleepOrAbort(serial, advanceScan === 0 ? 700 : 500);
      editorNext = await android.findPostNextButton(serial).catch(() => null);
      if (editorNext) break;
      stillOnPicker = await android.findExpandPhotoButton(serial).catch(() => null);
      if (!stillOnPicker) break;
    }
    if (!editorNext && stillOnPicker) {
      onLog?.("Make a Post: tapped \"Next\" but the picker screen did not advance after waiting for the editor — aborting this attempt");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    // Filter/edit screen → Next. Instagram's image editor (audio overlay,
    // filter strip, ratio controls) shows a labelled "Next" in the app bar —
    // give it extra time to settle before looking, since the audio-suggestion
    // overlay animation can delay accessibility-tree population.
    const nextBtn2 = editorNext ?? await android.findPostNextButton(serial).catch(() => null);
    if (nextBtn2) {
      onLog?.(`Make a Post: tapping filter/edit "Next" at (${nextBtn2.x}, ${nextBtn2.y})…`);
      await android.tap(serial, nextBtn2.x, nextBtn2.y);
      await sleepOrAbort(serial, 2000);
    }

    // Edit/adjustments screen → Next (only present on some builds).
    const nextBtn3 = await android.findPostNextButton(serial).catch(() => null);
    if (nextBtn3) {
      onLog?.(`Make a Post: tapping edit "Next" at (${nextBtn3.x}, ${nextBtn3.y})…`);
      await android.tap(serial, nextBtn3.x, nextBtn3.y);
      await sleepOrAbort(serial, 2000);
    }

    // Caption screen — verify we're actually there before typing/sharing.
    const shareBtn = await android.findShareFooterButton(serial).catch(() => null);
    if (!shareBtn) {
      onLog?.("Make a Post: caption/share screen not confirmed (no \"Share\" control found) — aborting this attempt");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    const caption = captionText.trim();
    if (caption) {
      const captionField = await android.findButtonByLabel(serial, "Write a caption").catch(() => null);
      if (captionField) {
        await android.tap(serial, captionField.x, captionField.y);
        await sleepOrAbort(serial, 500);
        await android.inputText(serial, caption);
        await sleepOrAbort(serial, 400);
        await android.pressBack(serial); // dismiss keyboard, don't navigate away from this screen
        await sleepOrAbort(serial, 400);
      } else {
        onLog?.("Make a Post: caption field not found — posting without a caption");
      }
    }

    // Dismiss any interstitial that appeared while the caption screen was
    // loading — most importantly the "Sharing posts" bottom sheet that
    // Instagram shows on first-time posting for an account. If this popup is
    // present and not cleared before the Share tap, the tap lands on the sheet
    // instead of the Share button and the post never submits.
    const preTapPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (preTapPopup) {
      onLog?.(`Make a Post: dismissed caption-screen popup ("${preTapPopup}") before Share tap`);
      await sleepOrAbort(serial, 600);
    }

    // Location must only be handled on the final caption/share page. The
    // earlier Share lookup may be stale after caption entry or an editor
    // transition, so require a fresh live Share node immediately before
    // opening the location picker. Never fall back to the older coordinate.
    let finalShareBtn = await android.findShareFooterButton(serial).catch(() => null);
    if (!finalShareBtn) {
      onLog?.("Make a Post: final caption/share page not confirmed immediately before location — aborting safely");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    if (addLocation) {
      const addLocationBtn = await android.findButtonByLabel(serial, "Add location").catch(() => null);
      if (addLocationBtn) {
        onLog?.("Make a Post: tapping Add location…");
        await android.tap(serial, addLocationBtn.x, addLocationBtn.y);
        // Instagram's location picker can render its shell before the
        // row_search_edit_text field is actually attached. On slower devices
        // the old 1s wait caused us to miss the field and continue toward
        // Share while the picker was still loading.
        onLog?.("Make a Post: waiting 12s for location picker/search box to load…");
        await sleepOrAbort(serial, 12000);

        const locationSearch = await android.findLocationSearchField(serial).catch(() => null);
        if (!locationSearch) {
          onLog?.("Make a Post: location search field not found — continuing without location");
        } else {
          onLog?.("Make a Post: entering location search \"Manchester United Kingdom\"…");
          await android.tap(serial, locationSearch.x, locationSearch.y);
          // The picker can retain a previous query. Clear by moving to the end
          // and sending enough deletes to cover any existing query, then type
          // the exact requested search text.
          await android.keyevent(serial, "123"); // KEYCODE_MOVE_END
          for (let i = 0; i < 80; i++) {
            await android.keyevent(serial, "67"); // KEYCODE_DEL
          }
          const locationText = "Manchester United Kingdom";
          const typedLocation = await android.typeViaSavedCalibrationMap(
            serial,
            locationText,
            effectiveTypingProfile(serial),
            message => onLog?.(`Make a Post: ${message}`),
          );
          if (!typedLocation.ok) {
            onLog?.(
              `Make a Post: calibrated keyboard could not enter location` +
              `${typedLocation.missing.length ? ` — missing ${typedLocation.missing.join(", ")}` : ""}`,
            );
            await android.pressBack(serial).catch(() => {});
            await sleepOrAbort(serial, 800);
          }
          await sleepOrAbort(serial, 1200);

          const matchingLocation = typedLocation.ok
            ? await android.findButtonByLabel(serial, "Manchester, United Kingdom").catch(() => null)
            : null;
          if (matchingLocation) {
            onLog?.("Make a Post: selecting location \"Manchester, United Kingdom\"…");
            await android.tap(serial, matchingLocation.x, matchingLocation.y);
            await sleepOrAbort(serial, 800);

            // Some Instagram accounts/builds show a secondary "Map preview"
            // confirmation after the location result is selected. It is
            // conditional, so never guess a coordinate or tap an underlying
            // control: only tap a live accessibility node labelled "Add".
            const mapPreviewAdd = await android.findLocationMapPreviewAdd(serial).catch(() => null);
            if (mapPreviewAdd) {
              onLog?.("Make a Post: map preview confirmation shown — tapping Add…");
              await android.tap(serial, mapPreviewAdd.x, mapPreviewAdd.y);
              await sleepOrAbort(serial, 800);
            } else {
              onLog?.("Make a Post: no map preview confirmation shown — continuing");
            }
          } else {
            onLog?.("Make a Post: requested Manchester location result not found — continuing without location");
          }
        }
      } else {
        onLog?.("Make a Post: Add location control not found — continuing without location");
      }
    }

    // Re-find Share (screen may have re-rendered after the caption/advanced steps).
    finalShareBtn = await android.findShareFooterButton(serial).catch(() => null);
    if (!finalShareBtn) {
      onLog?.("Make a Post: Share control not found after returning from location — aborting safely");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.("Make a Post: tapping Share…");
    await android.tap(serial, finalShareBtn.x, finalShareBtn.y);

    // Poll for the caption screen to disappear — the definitive sign the post
    // was submitted and Instagram is uploading. A failed action is logged and
    // aborted; automation actions never retry a tap.
    // Poll for the post to be accepted. Each iteration does ONE UIAutomator
    // dump (checkMakeAPostUploadState) instead of two back-to-back calls
    // (findMakeAPostSuccessSignal + findShareFooterButton = ~8-10 s/round).
    // Three success states are detected from the single dump:
    //   1. successSignal — explicit "Posted!" overlay visible.
    //   2. shareGone     — share button disappeared entirely.
    //   3. shareDisabled — button present but clickable="false" (upload in
    //      progress, Instagram disables it the moment it accepts the upload —
    //      this fires ~8 s before the success overlay).
    // Retry tap ONLY fires when the button is still present AND still
    // clickable after 6 s — i.e. genuinely stuck, not just uploading.
    let shareConfirmed = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleepOrAbort(serial, 1500);
      const uploadState = await android.checkMakeAPostUploadState(serial).catch(() => null);
      if (!uploadState) continue; // dump failed — wait and retry
      const { successSignal, shareGone, shareDisabled } = uploadState;
      if (successSignal) {
        onLog?.("Make a Post: detected Instagram success signal — post submitted ✓");
        shareConfirmed = true;
        break;
      }
      if (shareGone) {
        onLog?.("Make a Post: Share button gone — post submitted ✓");
        shareConfirmed = true;
        break;
      }
      if (shareDisabled) {
        onLog?.("Make a Post: Share button disabled — upload in progress, post submitted ✓");
        shareConfirmed = true;
        break;
      }
      // Share button remains visible and clickable. Do not tap again; continue
      // polling once per cycle and fail closed if Instagram never accepts it.
    }

    // Dismiss any post-share interstitial ("OK", notifications prompt, etc.)
    // that can appear right after sharing and sit on top of the feed if left
    // unhandled.
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    if (!shareConfirmed) {
      onLog?.("Make a Post: Share button still present after ~15 s — post did not submit. Aborting.");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }

    recordPostedLocalFile(serial, slotIdx, fileName);
    recordPostedProfileMedia(serial, opts.slotIdx ?? 0, opts.accountUsername ?? "", fileName);
    if (deleteAfterUpload) {
      try { await fsPromises.unlink(localFilePath); } catch { /* best effort */ }
    }
    // Always remove the temp copy pushed to the device — it is only needed
    // for the picker/upload. Leaving it behind fills up the camera roll.
    await android.removeDeviceFile(serial, devicePath).catch(() => {});
    onLog?.(`Make a Post: ✓ posted "${fileName}"`);
    return { posted: true, fileName };
  }

  // ── Make a Post — Story flow ──────────────────────────────────────────────
  // Posts the chosen image as an Instagram Story instead of a profile feed post.
  // Flow: + tap → STORY tab → story camera → Gallery icon → pick newest photo
  //       → forward arrow → Share → Finished → dismiss Stories archive popup.
  async function runMakePostStoryStep(serial: string, opts: {
    localFolderPath: string; localFolderRandom: boolean; localFolderNoRepeat: boolean;
    deleteAfterUpload: boolean;
    doFixAiSlop?: boolean;
    alterationEnabled?: boolean;
    alterationLevel?: AlterationLevel;
    imageSettingsEnabled?: boolean;
    imageSettings?: ImageFilterSettings;
    onLog?: (msg: string) => void;
  }): Promise<{ posted: boolean; fileName?: string }> {
    const {
      localFolderPath, localFolderRandom, localFolderNoRepeat, deleteAfterUpload,
      doFixAiSlop, alterationEnabled, alterationLevel,
      imageSettingsEnabled, imageSettings, onLog,
    } = opts;

    const fileName = await pickLocalFolderImage(serial, {
      folderPath: localFolderPath, random: localFolderRandom, noRepeat: localFolderNoRepeat, slotIdx, onLog,
    });
    if (!fileName) return { posted: false };
    const localFilePath = path.join(localFolderPath, fileName);

    const prepared = await prepareMakePostImage(localFilePath, fileName, {
      doFixAiSlop,
      alterationEnabled,
      alterationLevel,
      imageSettingsEnabled,
      imageSettings,
      onLog: (msg) => onLog?.(msg.replace("Make a Post:", "Make a Post (Story):")),
    });

    onLog?.(`Make a Post (Story): pushing "${fileName}" to device…`);
    let devicePath: string;
    try {
      devicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
    } catch (e: any) {
      await prepared.cleanup();
      onLog?.(`Make a Post (Story): adb push failed — ${e?.message ?? "unknown error"}`);
      return { posted: false };
    }
    await prepared.cleanup();
    await auditDeviceMediaCopy(serial, devicePath, prepared.audit, onLog);
    onLog?.(`Make a Post (Story): ✓ pushed to ${devicePath} — processedSha256=${prepared.audit.processedSha256} filename=${prepared.pushFileName} bytes=${prepared.audit.processedBytes}`);
    await sleepOrAbort(serial, 1200);

    // Step 1 — Tap the "+" compose button (same entry point as profile post)
    onLog?.("Make a Post (Story): looking for the \"+\" compose icon…");
    const composeBtn = await android.findComposeButton(serial).catch(() => null);
    if (!composeBtn) {
      onLog?.("Make a Post (Story): compose \"+\" icon not found — aborting");
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.("Make a Post (Story): tapping the \"+\" compose icon…");
    await android.tap(serial, composeBtn.x, composeBtn.y);
    await sleepOrAbort(serial, 3500);
    await android.logScreenLayout(serial, "Make a Post (Story): after '+' tap", onLog);
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    // Step 2 — Tap the STORY tab in the compose sheet bottom bar
    onLog?.("Make a Post (Story): looking for the STORY tab…");
    const storyTab = await android.findButtonByLabel(serial, "STORY").catch(() => null)
      ?? await android.findButtonByLabel(serial, "Story").catch(() => null);
    if (!storyTab) {
      onLog?.("Make a Post (Story): STORY tab not found in compose sheet — aborting");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post (Story): tapping STORY tab at (${storyTab.x}, ${storyTab.y})…`);
    await android.tap(serial, storyTab.x, storyTab.y);
    await sleepOrAbort(serial, 2500);
    await android.logScreenLayout(serial, "Make a Post (Story): after STORY tab tap", onLog);

    // Step 3 — Tap the gallery icon (bottom-left of the story camera screen)
    onLog?.("Make a Post (Story): looking for gallery icon…");
    const galleryBtn = await android.findStoryGalleryButton(serial).catch(() => null);
    if (!galleryBtn) {
      onLog?.("Make a Post (Story): gallery icon not found — aborting");
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post (Story): tapping gallery icon at (${galleryBtn.x}, ${galleryBtn.y})…`);
    await android.tap(serial, galleryBtn.x, galleryBtn.y);
    await sleepOrAbort(serial, 1500);
    await android.logScreenLayout(serial, "Make a Post (Story): after gallery tap", onLog);

    // Step 4 — Tap the most recent photo thumbnail in the "Add to story" gallery
    onLog?.("Make a Post (Story): looking for most recent photo thumbnail…");
    const thumbnail = await android.findFirstStoryGalleryThumbnail(serial).catch(() => null);
    if (!thumbnail) {
      onLog?.("Make a Post (Story): no photo thumbnail found in story gallery — aborting");
      await android.pressBack(serial);
      await android.pressBack(serial);
      await android.removeDeviceFile(serial, devicePath).catch(() => {});
      return { posted: false };
    }
    onLog?.(`Make a Post (Story): tapping thumbnail at (${thumbnail.x}, ${thumbnail.y})…`);
    await android.tap(serial, thumbnail.x, thumbnail.y);
    await sleepOrAbort(serial, 1500);
    await android.logScreenLayout(serial, "Make a Post (Story): after thumbnail tap", onLog);

    // Step 5 — Tap the forward-arrow/share node in the story editor bottom bar.
    // The node finder uses the live accessibility attributes. Some Instagram
    // builds expose the blue chevron as share_story_button and submit directly,
    // skipping the separate Share screen.
    onLog?.("Make a Post (Story): looking for the forward arrow button…");
    const arrowBtn = await android.findStoryNextArrowButton(serial).catch(() => null);
    let shareTappedDirectly = false;
    if (!arrowBtn) {
      // On the combined editor/share layout there is no separate "Next"
      // node. Fall through to the actual Share node instead of treating that
      // valid layout as a failure.
      onLog?.("Make a Post (Story): forward arrow node not found — checking for direct Share node…");
      const directShareBtn = await android.findStoryShareButton(serial).catch(() => null);
      if (!directShareBtn) {
        onLog?.("Make a Post (Story): forward arrow/Share node not found — aborting");
        await android.pressBack(serial);
        await android.pressBack(serial);
        await android.removeDeviceFile(serial, devicePath).catch(() => {});
        return { posted: false };
      }
      onLog?.(`Make a Post (Story): tapping direct Share at (${directShareBtn.x}, ${directShareBtn.y})…`);
      await android.tap(serial, directShareBtn.x, directShareBtn.y);
      shareTappedDirectly = true;
    } else {
      onLog?.(`Make a Post (Story): tapping forward/share node at (${arrowBtn.x}, ${arrowBtn.y})…`);
      await android.tap(serial, arrowBtn.x, arrowBtn.y);
      shareTappedDirectly = !!arrowBtn.directShare;
    }
    if (!shareTappedDirectly) {
      await sleepOrAbort(serial, 1500);
    }
    await android.logScreenLayout(serial, "Make a Post (Story): after arrow tap", onLog);

    // Step 6 — Tap the blue "Share" button on the story share destination screen
    if (!shareTappedDirectly) {
      onLog?.("Make a Post (Story): looking for Share button…");
      const shareBtn = await android.findStoryShareButton(serial).catch(() => null);
      if (!shareBtn) {
        onLog?.("Make a Post (Story): Share button not found — aborting");
        await android.pressBack(serial);
        await android.removeDeviceFile(serial, devicePath).catch(() => {});
        return { posted: false };
      }
      onLog?.(`Make a Post (Story): tapping Share at (${shareBtn.x}, ${shareBtn.y})…`);
      await android.tap(serial, shareBtn.x, shareBtn.y);
    } else {
      onLog?.("Make a Post (Story): direct Share node submitted the story");
    }
    await sleepOrAbort(serial, 2000);
    await android.logScreenLayout(serial, "Make a Post (Story): after Share tap", onLog);

    // Step 7 — Tap "Finished" on the "Also share to" screen
    onLog?.("Make a Post (Story): looking for Finished button…");
    const finishedBtn = await android.findStoryFinishedButton(serial).catch(() => null);
    if (finishedBtn) {
      onLog?.(`Make a Post (Story): tapping Finished at (${finishedBtn.x}, ${finishedBtn.y})…`);
      await android.tap(serial, finishedBtn.x, finishedBtn.y);
      await sleepOrAbort(serial, 1500);
    } else {
      onLog?.("Make a Post (Story): Finished button not found — story may already be live");
    }

    // Step 8 — Dismiss "Stories archive" popup if it appears, then general interstitials
    const archiveDismissed = await android.dismissStoriesArchivePopup(serial).catch(() => false);
    if (archiveDismissed) onLog?.("Make a Post (Story): dismissed Stories archive popup");
    await android.dismissInstagramInterstitials(serial).catch(() => null);

    recordPostedLocalFile(serial, slotIdx, fileName);
    if (deleteAfterUpload) {
      try { await fsPromises.unlink(localFilePath); } catch { /* best effort */ }
    }
    await android.removeDeviceFile(serial, devicePath).catch(() => {});
    onLog?.(`Make a Post (Story): ✓ story posted "${fileName}"`);
    return { posted: true, fileName };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: RANDOM JITTER
  // Functions: runCheckNotifications(), runVisitOwnProfile(), runVisitSaved(),
  //            runVisitSettings(), runAppSwitch()
  // Route:     (called from automation-cycle only, interleaved between tools)
  // Isolation: human-behaviour padding actions. None of these functions should
  //            contain tool-specific logic (follow, post, story, etc.).
  //            NOTE: runCheckDmLoop() is the CHECK DM TOOL — see its own
  //            marker below. It is NOT part of Jitter.
  // ═══════════════════════════════════════════════════════════════════════════

  /** Check Instagram notifications: tap heart icon → scroll → optionally tap item. */
  async function runCheckNotifications(serial: string, opts: {
    scrollsMin: number; scrollsMax: number;
    clickPctMin: number; clickPctMax: number;
    onLog?: (msg: string) => void;
  }): Promise<void> {
    const { scrollsMin, scrollsMax, clickPctMin, clickPctMax, onLog } = opts;
    // Notifications can be launched after another tool leaves Instagram on a
    // nested screen. Establish the Home surface before looking for the heart.
    const homeTab = await android.findHomeTab(serial).catch(() => null);
    if (!homeTab) {
      onLog?.("Random Actions: Home tab not positively detected — skipping check notifications");
      logger.warn({ serial }, "[jitter-check-notif] Home tab not found; refusing notification navigation");
      return;
    }
    onLog?.(`Random Actions: tapping Home before notifications at (${homeTab.x},${homeTab.y})`);
    await android.tap(serial, homeTab.x, homeTab.y);
    await sleepOrAbort(serial, 1000);
    // Find the notifications heart icon via accessibility tree scan.
    const icon = await android.findInstagramNotificationsIcon(serial).catch(() => null);
    if (!icon) {
      onLog?.("Random Actions: notifications icon not found — skipping check notifications");
      logger.warn({ serial }, "[jitter-check-notif] notifications icon not found by scan");
      return;
    }
    await android.tap(serial, icon.x, icon.y);
    await hstRandomDelay(serial, 1500, 10000);
    onLog?.("Random Actions: ✓ opened notifications");
    // Scroll down x–y times to browse through them.
    const scrollCount = rollRange(scrollsMin, scrollsMax);
    const { w, h } = getScreenSize(serial);
    for (let i = 0; i < scrollCount; i++) {
      await deviceProfileSwipe(
        serial,
        {
          x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
          x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
          durationMs: 380 + Math.round(Math.random() * 120),
        },
        "check-notifications-scroll",
        "normal",
      );
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 500));
    }
    // Optionally tap a random notification item (passive: opens a profile or post).
    const clickChance = rollRange(clickPctMin, clickPctMax) / 100;
    if (clickChance > 0 && Math.random() < clickChance) {
      const item = await android.findRandomNotificationItem(serial).catch(() => null);
      if (item) {
        await android.tap(serial, item.x, item.y);
        onLog?.("Random Actions: ✓ tapped notification item");
        await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 1500));
        await android.pressBack(serial);
        await hstRandomDelay(serial, 2500, 10000);
      } else {
        onLog?.("Random Actions: no clickable notification row found — skipping click");
      }
    } else {
      onLog?.("Random Actions: click-notification roll missed — skipping click");
    }
    // Return to home feed.
    await android.pressBack(serial);
    await hstRandomDelay(serial, 2500, 10000);
    onLog?.("Random Actions: ✓ notifications check done");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: CHECK DM
  // Functions: runCheckDmLoop()
  // Route:     (called from automation-cycle only)
  // Isolation: opens DM inbox, scrolls, optionally taps a thread.
  //            Separate from Random Jitter — it has its own toggle in the UI.
  //            Do not merge its logic with Jitter helpers.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Check DM inbox: tap the paper-plane icon, dismiss any "Not now" popup,
   * scroll through the inbox, and optionally tap one conversation thread.
   */
  async function runCheckDmLoop(serial: string, opts: {
    scrollsMin: number; scrollsMax: number;
    clickPctMin: number; clickPctMax: number;
    onLog?: (msg: string) => void;
  }): Promise<void> {
    const { scrollsMin, scrollsMax, clickPctMin, clickPctMax, onLog } = opts;
    // Tap the DM paper-plane icon (top-right header area of the home feed).
    const dmTab = await android.findInstagramDmTab(serial).catch(() => null);
    if (!dmTab) {
      onLog?.("Check Inbox: DM icon not found — skipping");
      logger.warn({ serial }, "[check-dm] DM icon not found by scan");
      return;
    }
    await android.tap(serial, dmTab.x, dmTab.y);
    await sleepOrAbort(serial, 2000);
    // Dismiss any "Not now" popup (e.g. "Turn on notifications for Direct").
    const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (dismissed) {
      onLog?.(`Check Inbox: dismissed popup ("${dismissed}")`);
      await sleepOrAbort(serial, 600);
    }
    onLog?.("Check Inbox: ✓ opened DM inbox");
    // Scroll through inbox N times.
    const scrollCount = rollRange(scrollsMin, scrollsMax);
    const { w, h } = getScreenSize(serial);
    for (let i = 0; i < scrollCount; i++) {
      await deviceProfileSwipe(
        serial,
        {
          x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
          x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
          durationMs: 380 + Math.round(Math.random() * 120),
        },
        "check-dm-scroll",
        "normal",
      );
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 500));
    }
    // Optionally tap a conversation thread.
    const clickChance = rollRange(clickPctMin, clickPctMax) / 100;
    if (clickChance > 0 && Math.random() < clickChance) {
      const item = await android.findDmConversationItem(serial).catch(() => null);
      if (item) {
        await android.tap(serial, item.x, item.y);
        onLog?.("Check Inbox: ✓ opened conversation thread");
        await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 1500));
        await android.pressBack(serial);
        await sleepOrAbort(serial, 600);
      } else {
        onLog?.("Check Inbox: no conversation thread found — skipping tap");
      }
    } else {
      onLog?.("Check Inbox: click-thread roll missed — skipping");
    }
    // Return to home feed.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
    onLog?.("Check Inbox: ✓ DM inbox check done");
  }

  /** Visit own profile: tap profile icon in bottom nav, dwell briefly, return to home. */
  async function runVisitOwnProfile(serial: string, onLog?: (msg: string) => void): Promise<void> {
    // Locate profile tab via accessibility tree — more reliable than fixed %
    // coordinates which drift across screen resolutions and OEM skins.
    const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
    if (!profileTab) {
      onLog?.("Random Actions: profile tab not found — skipping visit profile");
      logger.warn({ serial }, "[jitter-visit-profile] profile tab not found by scan");
      return;
    }
    await android.tap(serial, profileTab.x, profileTab.y);
    await hstRandomDelay(serial, 1500, 10000);

    // The profile / "Discover people" page sometimes triggers an
    // "Allow Instagram to access your contacts?" system dialog.
    // Dismiss it automatically so the cycle does not stall.
    const dismissed = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (dismissed) {
      onLog?.(`Random Jitter: dismissed contacts popup ("${dismissed}")`);
      await hstRandomDelay(serial, 2500, 10000);
    }

    onLog?.("Random Actions: ✓ visited own profile");
    // Return to home feed.
    const homeTab = await android.findHomeTab(serial).catch(() => null);
    if (homeTab) {
      await android.tap(serial, homeTab.x, homeTab.y);
    } else {
      await android.pressBack(serial);
    }
    await hstRandomDelay(serial, 250, 10000);
  }

  /**
   * Visit Saved — navigates to the account's Saved media page via:
   *   Profile tab → hamburger "Options" button → "Saved" row
   * then scrolls 1–10 times through the saved posts grid, and returns
   * to the home feed.
   *
   * Navigation path confirmed from UIAutomator XML dumps:
   *   - Profile page hamburger: ImageView content-desc="Options" (~top-right)
   *   - Settings and activity page Saved row: View content-desc="Saved"
   */
  async function runVisitSaved(serial: string, onLog?: (msg: string) => void): Promise<void> {
    // Tap the profile tab directly; it is available in the Instagram bottom
    // navigation regardless of which tool opened this action.
    const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
    if (!profileTab) {
      onLog?.("Visit Saved: profile tab not found — skipping");
      logger.warn({ serial }, "[jitter-visit-saved] profile tab not found");
      return;
    }
    await android.tap(serial, profileTab.x, profileTab.y);
    await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));

    // Dismiss any interstitial that may appear on profile page load.
    const d1 = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (d1) await sleepOrAbort(serial, 500);

    // 3. Tap the hamburger "Options" button (top-right of profile page).
    const optionsBtn = await android.findInstagramProfileOptionsButton(serial).catch(() => null);
    if (!optionsBtn) {
      onLog?.("Visit Saved: Options button not found — skipping");
      logger.warn({ serial }, "[jitter-visit-saved] Options/hamburger button not found");
      // Return to home and bail.
      await returnToHomeSafely(serial);
      await sleepOrAbort(serial, 600);
      return;
    }
    await android.tap(serial, optionsBtn.x, optionsBtn.y);
    await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 600));
    onLog?.("Visit Saved: ✓ opened Settings and activity");

    // 4. Tap the "Saved" row on the Settings and activity page.
    const savedRow = await android.findInstagramSavedRow(serial).catch(() => null);
    if (!savedRow) {
      onLog?.("Visit Saved: Saved row not found — skipping");
      logger.warn({ serial }, "[jitter-visit-saved] Saved row not found");
      // Back out: Settings and activity → profile → home.
      await android.pressBack(serial);
      await sleepOrAbort(serial, 600);
      await returnToHomeSafely(serial);
      await sleepOrAbort(serial, 600);
      return;
    }
    await android.tap(serial, savedRow.x, savedRow.y);
    await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));
    onLog?.("Visit Saved: ✓ opened Saved media page");

    // 5. Scroll through saved posts 1–10 times.
    const scrollCount = rollRange(1, 10);
    const { w, h } = getScreenSize(serial);
    for (let i = 0; i < scrollCount; i++) {
      await deviceProfileSwipe(
        serial,
        {
          x1: Math.round(w * 0.5), y1: Math.round(h * 0.65),
          x2: Math.round(w * 0.5), y2: Math.round(h * 0.30),
          durationMs: 380 + Math.round(Math.random() * 120),
        },
        "visit-saved-scroll",
        "normal",
      );
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 600));
    }
    onLog?.(`Visit Saved: ✓ scrolled ${scrollCount}×`);

    // 6. Return to home feed: pressBack × 2 (Saved → Settings, Settings → Profile),
    //    then tap the home tab.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 600);
    await android.pressBack(serial);
    await sleepOrAbort(serial, 600);
    await returnToHomeSafely(serial);
    await sleepOrAbort(serial, 600);
    onLog?.("Visit Saved: ✓ done, returned to home feed");
  }

  /**
   * Visit Random Settings — navigates to Settings and activity via Profile →
   * Options, taps exactly one validated top-level settings row, optionally
   * scrolls that destination once, then presses Back exactly once.
   *
   * Never use a blind coordinate tap and never tap a second-level setting.
   */
  async function runVisitSettings(serial: string, onLog?: (msg: string) => void): Promise<void> {
    // Tap the profile tab directly; it is available in the Instagram bottom
    // navigation regardless of which tool opened this action.
    const profileTab = await android.findInstagramProfileTab(serial).catch(() => null);
    if (!profileTab) {
      onLog?.("Visit Settings: profile tab not found — skipping");
      logger.warn({ serial }, "[jitter-visit-settings] profile tab not found");
      return;
    }
    await android.tap(serial, profileTab.x, profileTab.y);
    await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 800));

    // Dismiss any interstitial that may appear on profile page load.
    const d1 = await android.dismissInstagramInterstitials(serial).catch(() => null);
    if (d1) await sleepOrAbort(serial, 500);

    // 3. Tap the hamburger "Options" button (top-right of profile page).
    const optionsBtn = await android.findInstagramProfileOptionsButton(serial).catch(() => null);
    if (!optionsBtn) {
      onLog?.("Visit Settings: Options button not found — skipping");
      logger.warn({ serial }, "[jitter-visit-settings] Options/hamburger button not found");
      await returnToHomeSafely(serial);
      await sleepOrAbort(serial, 600);
      return;
    }
    await android.tap(serial, optionsBtn.x, optionsBtn.y);
    await sleepOrAbort(serial, 2000 + Math.round(Math.random() * 600));
    onLog?.("Visit Settings: ✓ opened Settings and activity");

    // 4. Tap exactly one real settings row. Never guess at a screen coordinate.
    const settingsRow = await android.findInstagramSettingsRow(serial).catch(() => null);
    if (!settingsRow) {
      onLog?.("Visit Settings: no validated settings row found — skipping");
      logger.warn({ serial }, "[jitter-visit-settings] no validated settings row");
      await android.pressBack(serial);
      await sleepOrAbort(serial, 800);
      return;
    }
    await android.tap(serial, settingsRow.x, settingsRow.y);
    await sleepOrAbort(serial, 1200 + Math.round(Math.random() * 600));
    onLog?.(`Visit Settings: ✓ tapped one setting row (${settingsRow.label})`);

    // 5. Either scroll once then Back, or Back immediately. There is never a
    // second setting/subsetting tap in this flow.
    const { w, h } = getScreenSize(serial);
    if (Math.random() < 0.5) {
      await deviceProfileSwipe(
        serial,
        {
          x1: Math.round(w * 0.5), y1: Math.round(h * 0.68),
          x2: Math.round(w * 0.5), y2: Math.round(h * 0.34),
          durationMs: 420 + Math.round(Math.random() * 120),
        },
        "visit-settings-scroll",
        "normal",
      );
      await sleepOrAbort(serial, 500 + Math.round(Math.random() * 400));
      onLog?.("Visit Settings: ✓ scrolled once");
    }

    // 6. Back once only.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
    onLog?.("Visit Settings: ✓ done after one Back");
  }

  /**
   * App Switch — presses the square (Overview) button to open the
   * floating-windows recents overlay, launches the device's default SMS app
   * via a generic SENDTO intent (works across OEMs without hardcoding a
   * package name), waits a random 10–30 s to simulate reading messages, then
   * re-opens the recents overlay, swipes the SMS card up to dismiss it, and
   * launches Instagram back to the foreground.
   */
  async function runAppSwitch(serial: string, onLog?: (msg: string) => void): Promise<void> {
    // 1. Open the recent-apps (square/Overview) overlay.
    await android.openRecentApps(serial);
    await sleepOrAbort(serial, 800 + Math.round(Math.random() * 400));

    // 2. Launch the default SMS app via a generic intent so it works across
    //    OEMs (Samsung, Xiaomi, stock Android, etc.) without a hardcoded pkg.
    const tools = android.detectToolset();
    const adb = tools.adb.path ?? "";
    if (adb) {
      spawnSync(adb, [
        "-s", serial, "shell", "am", "start",
        "-a", "android.intent.action.SENDTO",
        "-d", "smsto:",
      ], { encoding: "utf8", timeout: 8000 });
    }
    onLog?.("Random Actions: ✓ opened SMS app");

    // 3. Dwell in the SMS app for a random 10–30 s.
    const dwellMs = 10_000 + Math.round(Math.random() * 20_000);
    onLog?.(`Random Jitter: staying in SMS for ${Math.round(dwellMs / 1000)}s…`);
    await sleepOrAbort(serial, dwellMs);

    // 4. Re-open the recents overlay — SMS is now the top card.
    await android.openRecentApps(serial);
    await sleepOrAbort(serial, 700 + Math.round(Math.random() * 300));

    // 5. Swipe up to dismiss the SMS card, leaving Instagram as the remaining app.
    await android.swipeUpFromBottom(serial);
    await sleepOrAbort(serial, 600 + Math.round(Math.random() * 400));

    // 6. Bring Instagram back to the foreground.  Using launchInstagram is
    //    more reliable than tapping a recents card whose position may vary.
    await android.launchInstagram(serial);
    await sleepOrAbort(serial, 1500 + Math.round(Math.random() * 500));

    onLog?.("Random Actions: ✓ returned to Instagram after app switch");
  }

  // ── Update Profile Picture ───────────────────────────────────────────────
  // Picks the most recent image from the PC folder, pushes it to the device,
  // navigates: profile tab → Edit profile → Edit pictures → + button →
  // gallery thumbnail → Finished → Back, then deletes from PC and device.
  async function runUpdateProfilePicture(
    serial: string,
    folderPath: string,
    onLog?: (msg: string) => void,
    imageOptions?: {
      alterationEnabled?: boolean;
      alterationLevel?: AlterationLevel;
      imageSettingsEnabled?: boolean;
      imageSettings?: ImageFilterSettings;
      fixAiSlop?: boolean;
      metadataCleanup?: boolean;
      frequencyDisruption?: boolean;
    },
  ): Promise<void> {
    // 1. Pick the most recent image file from the PC folder.
    let files: { name: string; mtime: number }[] = [];
    try {
      files = fs.readdirSync(folderPath)
        .filter(f => /\.(jpe?g|png|webp)$/i.test(f))
        .map(f => ({ name: f, mtime: fs.statSync(path.join(folderPath, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
    } catch (e: any) {
      onLog?.(`Update Profile Pic: ✗ could not read folder: ${e?.message}`); return;
    }
    if (!files.length) { onLog?.("Update Profile Pic: ✗ no images found in folder"); return; }
    const localFile = files[0].name;
    const localPath = path.join(folderPath, localFile);

    // 2. Prepare and push the image to the device. Profile-picture uploads
    // always use the same privacy/alteration pipeline as Make a Post:
    // Fix AI Slop plus the Small alteration preset. The source file remains
    // untouched; only the temporary processed copy is sent to the phone.
    let prepared: Awaited<ReturnType<typeof prepareMakePostImage>>;
    try {
      prepared = await prepareMakePostImage(localPath, localFile, {
        doFixAiSlop: imageOptions?.fixAiSlop ?? false,
        alterationEnabled: imageOptions?.alterationEnabled ?? true,
        alterationLevel: imageOptions?.alterationLevel ?? "small",
        imageSettingsEnabled: imageOptions?.imageSettingsEnabled ?? true,
        imageSettings: imageOptions?.imageSettings,
        frequencyDisruption: imageOptions?.frequencyDisruption ?? false,
      // The preparation pipeline is shared with Make a Post, but this caller
      // is Update Profile Pic. Relabel delegated progress lines so Random
      // Actions cannot misreport an avatar update as a post.
      onLog: (msg) => onLog?.(msg.replace(/^Make a Post:/, "Update Profile Pic:")),
      });
    } catch (e: any) {
      onLog?.(`Update Profile Pic: ✗ image preparation failed: ${e?.message}`);
      return;
    }

    // pushFileToDevice builds its own unique on-device path (ig_<random-id>_<name>) and
    // returns it — capture the actual path so removeDeviceFile targets the
    // correct file.  Previously the caller constructed a separate devicePath
    // variable and passed it as the fileName argument, which caused the file
    // to land at a completely different mangled path, making the removeDeviceFile
    // call a no-op (it tried to delete a file that never existed at that path).
    let actualDevicePath: string;
    try {
      actualDevicePath = await android.pushFileToDevice(serial, prepared.pushFilePath, prepared.pushFileName);
      onLog?.(`Update Profile Pic: pushed ${localFile} to device — processedSha256=${prepared.audit.processedSha256} filename=${prepared.pushFileName} bytes=${prepared.audit.processedBytes}`);
    } catch (e: any) {
      onLog?.(`Update Profile Pic: ✗ push failed: ${e?.message}`);
      await prepared.cleanup();
      return;
    }
    await auditDeviceMediaCopy(serial, actualDevicePath, prepared.audit, onLog);
    await sleepOrAbort(serial, 1000);

    // Steps 3–10: navigation.  Wrapped in try-finally so the device file is
    // always removed regardless of whether navigation succeeds or bails early
    // at any step — previously every early `return` left the image on the
    // phone's storage indefinitely.
    let uploadSucceeded = false;
    try {

    // 3. Tap the profile tab (bottom-right, tab_avatar).
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*tab_avatar[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ profile tab not found"); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped profile tab");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 4. Tap the "Edit profile" button.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/desc="Edit profile"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Edit profile"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Edit profile button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Edit profile");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 5. Verify Edit Profile page is loaded, then tap "Edit pictures".
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("edit_profile_fields") && !xml.includes("change_avatar_button")) {
        onLog?.("Update Profile Pic: ✗ Edit Profile page did not load"); await android.pressBack(serial); return;
      }
      const m = xml.match(/resource-id="[^"]*change_avatar_button[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Edit pictures button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Edit pictures");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 6. Handle whichever UI Instagram shows after "Edit picture or avatar".
    //
    //    Layout A (older builds): the mpp overlay opens directly, showing a
    //    dotted-ring "+" add slot (resource-id mpp_left). Tap it to open the
    //    gallery picker.
    //
    //    Layout B (newer builds — observed Jul 2026): a bottom sheet appears
    //    first with three options: "Choose from library", "Import from
    //    Facebook", "Take Photo" (resource-id update_profile_options_list).
    //    We must tap "Choose from library" to reach the gallery picker;
    //    the mpp_left button is never shown in this path.
    //
    //    Both layouts are detected from one dump so no extra round-trip is
    //    needed. After handling either path, execution falls through to step 7
    //    (gallery picker check), which is the same regardless of which layout
    //    was shown.
    {
      const xml = await android.dumpUi(serial);
      const hasPhotoSheet =
        xml.includes("update_profile_options_list") ||
        xml.includes("update_profile_picture_tab_layout") ||
        xml.includes('desc="Choose from library"');

      if (hasPhotoSheet) {
        // Layout B — tap "Choose from library".
        const m = xml.match(/desc="Choose from library"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                  xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Choose from library"/);
        if (!m) {
          onLog?.("Update Profile Pic: ✗ 'Choose from library' button not found in photo sheet");
          await android.pressBack(serial); return;
        }
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Profile Pic: tapped 'Choose from library' (photo sheet layout)");
      } else {
        // Layout A — tap the "+" add slot (mpp_left).
        const m = xml.match(/resource-id="[^"]*mpp_left[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!m) { onLog?.("Update Profile Pic: ✗ mpp_left (+) button not found"); await android.pressBack(serial); return; }
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Profile Pic: tapped + (mpp_left) button");
      }
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 7. Confirm the "Add profile pictures" gallery screen loaded.
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("gallery_picker_view") && !xml.includes("Add profile pictures")) {
        onLog?.("Update Profile Pic: ✗ gallery picker did not open"); await android.pressBack(serial); return;
      }
      onLog?.("Update Profile Pic: gallery picker opened");
    }

    // 8. Tap the most recent photo — first gallery_grid_item_thumbnail in the dump.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*gallery_grid_item_thumbnail[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ gallery thumbnail not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: selected most recent photo");
    }
    await sleepOrAbort(serial, 1000 + Math.round(Math.random() * 500));

    // 9. Tap "Finished".
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*next_button_textview[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/text="Finished"[^/]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Profile Pic: ✗ Finished button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Profile Pic: tapped Finished");
    }
    await sleepOrAbort(serial, 2500 + Math.round(Math.random() * 1000));

    // 10. Press Back once to leave the edit-profile view.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800 + Math.round(Math.random() * 400));
    onLog?.("Update Profile Pic: pressed Back");

    uploadSucceeded = true;

    } finally {
      // Always delete from device — regardless of whether any navigation step
      // failed and returned early.  The image was already pushed in step 2 so
      // it must be cleaned up unconditionally to avoid accumulating files on
      // the phone's storage.
      try {
        await android.removeDeviceFile(serial, actualDevicePath!);
        onLog?.(`Update Profile Pic: deleted ${localFile} from device`);
      } catch (e: any) { onLog?.(`Update Profile Pic: ⚠ could not delete device file: ${e?.message}`); }
      await prepared.cleanup();
    }

    if (!uploadSucceeded) return;

    // 11. Delete the file from the PC folder (only on successful upload).
    try { fs.unlinkSync(localPath); onLog?.(`Update Profile Pic: deleted ${localFile} from PC`); }
    catch (e: any) { onLog?.(`Update Profile Pic: ⚠ could not delete PC file: ${e?.message}`); }

    onLog?.("Update Profile Pic: ✓ done");
  }

  // ── Update Bio ─────────────────────────────────────────────────────────────
  /** Resolve Jarvee-style spin syntax: every {a|b|c} group is independently
   *  replaced with a randomly chosen variant. Multiple groups are each rolled
   *  separately, so "{Hi|Hey} {there|you}" produces one of four sentences. */
  function resolveSpinSyntax(text: string): string {
    return text.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
      const parts = inner.split("|");
      return parts[Math.floor(Math.random() * parts.length)];
    });
  }

  // Navigates to the user's own profile → Edit profile → taps the Bio field →
  // clears it → types the supplied text → taps the Save/Submit button.
  async function runUpdateBio(serial: string, bioText: string, onLog?: (msg: string) => void): Promise<void> {
    const originalBioText = bioText;
    onLog?.(`Update Bio: input received — length=${originalBioText.length}, value=${JSON.stringify(originalBioText)}`);
    if (!bioText.trim()) { onLog?.("Update Bio: ✗ bio text is empty — skipping"); return; }
    // Normalize textarea/API line endings before resolving spin groups. Saved
    // settings can contain Windows CRLF (or legacy bare CR) line breaks; the
    // calibrated keyboard path intentionally maps newline only to Enter.
    bioText = bioText.replace(/\r\n?/g, "\n");
    // Resolve spin syntax before typing — each {a|b|c} group is rolled independently.
    bioText = resolveSpinSyntax(bioText);
    onLog?.(`Update Bio: spin resolved — inputLength=${originalBioText.length}, outputLength=${bioText.length}, value=${JSON.stringify(bioText)}, spinGroupsRemaining=${(bioText.match(/\{[^{}]*\}/g) ?? []).length}`);

    // 1. Tap the profile tab (bottom-right, tab_avatar).
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/resource-id="[^"]*tab_avatar[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Bio: ✗ profile tab not found"); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Bio: tapped profile tab");
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 2. Tap the "Edit profile" button.
    {
      const xml = await android.dumpUi(serial);
      const m = xml.match(/(?:desc|text|content-desc)="Edit profile"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*(?:desc|text|content-desc)="Edit profile"/i) ||
                xml.match(/resource-id="[^"]*(?:edit_profile|edit_profile_button)[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/i);
      if (!m) { onLog?.("Update Bio: ✗ Edit profile button not found"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
    }
    await sleepOrAbort(serial, 1800 + Math.round(Math.random() * 400));

    // 3. Verify Edit Profile page loaded, then tap the bio field.
    {
      const xml = await android.dumpUi(serial);
      if (!xml.includes("edit_profile_fields") && !xml.includes("prism_form_field_container")) {
        onLog?.("Update Bio: ✗ Edit Profile page did not load after verified Edit profile-node tap");
        await android.pressBack(serial); return;
      }
      onLog?.("Update Bio: ✓ Edit Profile page loaded after verified Edit profile-node tap");
      // The bio section is a Button with resource-id ending in "bio"; its
      // EditText child is what we tap to place the cursor.
      const m = xml.match(/resource-id="[^"]*\bbio\b[^"]*"[^/]*\/?>[\s\S]*?<[^>]*EditText[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/resource-id="[^"]*\bbio\b[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
      if (!m) { onLog?.("Update Bio: ✗ bio field not found in Edit Profile"); await android.pressBack(serial); return; }
      await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
      onLog?.("Update Bio: tapped bio field");
    }
    // Wait for the dedicated Bio edit screen to open (it's a separate screen from Edit Profile).
    await sleepOrAbort(serial, 1400 + Math.round(Math.random() * 300));

    // 3b. Re-dump the Bio edit screen and tap the EditText directly to establish
    //     a proper input connection. On MIUI/Android 13 the previous tap (on the
    //     Edit Profile page) opens the Bio screen but the input method service
    //     hasn't bound to the new field yet — calling inputText immediately causes
    //     a NullPointerException in InputShellCommand.sendText. Tapping the field
    //     from the Bio screen's own dump forces Android to initialise the input
    //     connection before we try to type.
    {
      const bioXml = await android.dumpUi(serial);
      // Bio edit screen is identified by edit_bio_layout or prism_form_field_container.
      if (bioXml.includes("edit_bio_layout") || bioXml.includes("prism_form_field_container")) {
        // Tap the EditText (the actual text field, not the outer container).
        const et = bioXml.match(/\bEditText\b[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (et) {
          await android.tap(serial, Math.round((+et[1] + +et[3]) / 2), Math.round((+et[2] + +et[4]) / 2));
          onLog?.("Update Bio: confirmed focus on Bio edit screen");
          await sleepOrAbort(serial, 500);
        }
      } else {
        onLog?.("Update Bio: ⚠ Bio edit screen did not open — pressing Back");
        await android.pressBack(serial); return;
      }
    }

    // 4. Replace the focused Bio field through the saved per-device keyboard
    //    calibration map. First select all existing content and clear it;
    //    typing must never begin in a field containing stale Bio text.
    {
      try {
        onLog?.("Update Bio: clearing focused field — select-all then delete");
        await android.clearFocusedTextField(
          serial,
          message => onLog?.(`Update Bio: ${message}`),
        );
        const clearedXml = await android.dumpUi(serial);
        const focusedField = [...clearedXml.matchAll(/<node\b[^>]*class="android\.widget\.EditText"[^>]*>/gi)]
          .map(match => match[0])
          .find(node => /focused="true"/i.test(node));
        const remaining = focusedField?.match(/\btext="([^"]*)"/i)?.[1] ?? "";
        onLog?.(`Update Bio: clear verification — focusedEditTextFound=${Boolean(focusedField)}, remainingLength=${remaining.length}, remainingValue=${JSON.stringify(remaining)}`);
        if (remaining.length > 0) {
          onLog?.(`Update Bio: ✗ clear verification found ${remaining.length} remaining characters — aborting`);
          await android.pressBack(serial);
          return;
        }
        onLog?.("Update Bio: ✓ existing Bio text cleared and verified");
      } catch (e: any) {
        onLog?.(`Update Bio: ✗ could not select/clear existing Bio text — ${e?.message ?? String(e)}`);
        await android.pressBack(serial);
        return;
      }
      onLog?.(`Update Bio: typing start — length=${bioText.length}, value=${JSON.stringify(bioText)}`);
      const typed = await android.typeViaSavedCalibrationMap(
        serial,
        bioText,
        effectiveTypingProfile(serial),
        message => onLog?.(`Update Bio: ${message}`),
        // Bio text must be entered exactly as generated. Human-error
        // simulation types a random character and then presses Backspace;
        // on Gboard that destructive correction can race the prior tap and
        // delete a real character/word while still reporting ok=true.
        { debugLabel: "Update Bio", disableHumanErrors: true },
      );
      if (!typed.ok) {
        onLog?.(`Update Bio: ✗ calibrated typing incomplete — missing ${typed.missing.join(", ") || "required calibration"}`);
        await android.pressBack(serial);
        return;
      }
      onLog?.(`Update Bio: typing result — ok=${typed.ok}, calibrationAvailable=${typed.available}, missing=${typed.missing.join(",") || "none"}`);
      onLog?.(`Update Bio: entered bio text via keyboard calibration (${bioText.length} chars)`);
    }
    await sleepOrAbort(serial, 800 + Math.round(Math.random() * 200));

    // 5. Tap the "Finished" tick in the top-right of the Bio edit screen action bar,
    //    then fall back to broader Save/Submit/Done matches for other IG builds.
    {
      const xml = await android.dumpUi(serial);
      // Primary: action_bar_button_action with desc="Finished" (Bio edit screen — confirmed via dump).
      // Secondary: desc="Submit" or text="Done" for other IG builds.
      const m = xml.match(/id="[^"]*action_bar_button_action[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*id="[^"]*action_bar_button_action[^"]*"/) ||
                xml.match(/desc="Finished"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Finished"/) ||
                xml.match(/desc="Submit"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*desc="Submit"/) ||
                xml.match(/text="Done"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/) ||
                xml.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"[^>]*text="Done"/);
      if (m) {
        await android.tap(serial, Math.round((+m[1] + +m[3]) / 2), Math.round((+m[2] + +m[4]) / 2));
        onLog?.("Update Bio: tapped Finished/Save button");
      } else {
        // Fallback: tap the right side of the action bar (Finished tick is always there).
        const ab = xml.match(/resource-id="[^"]*action_bar\b[^"]*"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (ab) {
          // Right ~10% of the action bar, vertically centered.
          const x = Math.round(+ab[3] - (+ab[3] - +ab[1]) * 0.07);
          const y = Math.round((+ab[2] + +ab[4]) / 2);
          await android.tap(serial, x, y);
          onLog?.("Update Bio: tapped action bar right edge (Finished fallback)");
        } else {
          onLog?.("Update Bio: ⚠ could not find Finished button — pressing Back without saving");
          await android.pressBack(serial); return;
        }
      }
    }
    await sleepOrAbort(serial, 1500 + Math.round(Math.random() * 300));

    // 6. Leave the surrounding settings surface after the Save/tick action.
    // The Save/tick flow already handles leaving the dedicated bio editor, so
    // only one Back is needed before the next shuffled tool starts.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 800);
    onLog?.("Update Bio: pressed Back (left surrounding settings)");
    onLog?.("Update Bio: ✓ done");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TOOL: FOLLOW
  // Functions: runProfileBrowsingSequence() [inject browsing],
  //            tapOneProfileHighlight(), runFollowUsersStep()
  // Route:     POST /api/mobile/devices/:serial/slots/:slotIdx/follow-users
  //            (also called from automation-cycle)
  // Isolation: HikerAPI candidate fetch, Instagram search, profile nav, follow
  //            tap are all here. Search bar input uses the strict saved Android
  //            keyboard calibration map and never falls back to adb text input.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── HikerAPI-driven follow step ──────────────────────────────────────────
  interface InjectBrowsingParams {
    activatePctMin: number; activatePctMax: number;
    beforeFollowPctMin: number; beforeFollowPctMax: number;
    feedMin: number; feedMax: number;
    clickPostPctMin: number; clickPostPctMax: number;
    likePctMin: number; likePctMax: number;
    shareFeedPctMin: number; shareFeedPctMax: number;
    shareDmPctMin: number; shareDmPctMax: number;
    /** Chance (%) to save the viewed post — taps the ribbon/bookmark icon. */
    savePostPctMin: number; savePostPctMax: number;
    /** Chance (%) to skip the follow entirely after browsing — adds variation
     *  so not every browsing session ends in a follow. The user can still be
     *  scraped and followed again later by any account. */
    abandonFollowPctMin: number; abandonFollowPctMax: number;
    /** Chance (%) to tap one of the profile's story highlight circles and
     *  dwell in it briefly before swiping down to dismiss. Fires before OR
     *  after the profile-grid scroll (50/50 coin flip per user). */
    tapHighlightsPctMin: number; tapHighlightsPctMax: number;
  }

  /** Picks a value uniformly from [lo, hi], tolerating either order. */
  function rollRange(min: number, max: number): number {
    const lo = Math.min(min, max), hi = Math.max(min, max);
    return lo + Math.random() * (hi - lo);
  }

  /**
   * Activate Percentage gate — rolls once per tool per automation-cycle
   * execution ("execution" = one full run of the whole toggle-tick loop,
   * i.e. once every wait-interval). A min/max of 100/100 always passes
   * (back-compat default); e.g. 5/10 gives this execution roughly a 5-10%
   * (~7.5% avg) chance of the tool being active at all this time around.
   */
  function rollActivate(min: number, max: number): boolean {
    const chance = rollRange(min, max) / 100;
    return chance > 0 && Math.random() < chance;
  }

  /**
   * Decides, for ONE user, whether Inject Browsing runs at all this user
   * and — independently — whether it should run before or after the Follow
   * tap. These are two separate rolls, not one combined gate:
   *
   *   - `activatePct` — whether browsing happens for this user at all.
   *   - `beforeFollowPct` — GIVEN that it happens, the odds it happens
   *     before the follow (vs. after). This does NOT gate whether browsing
   *     happens — it only orders it.
   *
   * Fix (15 Jul 2026): previously `beforeFollowPct` was (incorrectly) used
   * as a second on/off gate stacked on top of `activatePct` — if that roll
   * missed, browsing was skipped entirely for the user, with no "after
   * follow" branch ever implemented. That made "before follow" look like it
   * meant "follow first, never browse" whenever the roll missed. Now a miss
   * only changes the order to after-follow; browsing still runs whenever
   * `activatePct` says it should.
   */
  function rollInjectBrowsingDecision(browsing: InjectBrowsingParams): { willBrowse: boolean; browseBeforeFollow: boolean } {
    const activateChance = rollRange(browsing.activatePctMin, browsing.activatePctMax) / 100;
    const willBrowse = activateChance > 0 && Math.random() < activateChance;
    if (!willBrowse) return { willBrowse: false, browseBeforeFollow: false };
    const beforeFollowChance = rollRange(browsing.beforeFollowPctMin, browsing.beforeFollowPctMax) / 100;
    const browseBeforeFollow = beforeFollowChance > 0 && Math.random() < beforeFollowChance;
    return { willBrowse, browseBeforeFollow };
  }

  /**
   * Taps one randomly chosen story highlight on the profile page, dwells
   * inside the story viewer for 2–20 s, then swipes down to close if still
   * in the viewer (auto-close means only one story existed).
   *
   * Detection: Instagram renders highlight circles as tappable nodes in the
   * profile header area. They appear with content-desc patterns like
   * "meh Highlight" or "gym Highlight", or with resource-ids that contain
   * "highlight". We scan the live a11y dump and pick one at random.
   * If none are found (profile has no highlights) the call is a silent no-op.
   */
  async function tapOneProfileHighlight(
    serial: string,
    onLog?: (msg: string) => void,
  ): Promise<void> {
    try {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      const { h: _hlH } = getScreenSize(serial);
      const xml = await android.dumpUi(serial).catch(() => "");

      // ── Structural highlight-circle detection ────────────────────────────
      //
      // Highlight circles are identified purely by their position in the
      // accessibility tree — NOT by content-desc or any user-visible text.
      // The user can name a highlight anything (or leave it blank, which
      // makes Instagram default the title to "Highlight"), so text matching
      // is fundamentally unreliable.
      //
      // Strategy order (first non-empty result wins):
      //
      //   1. resource-id contains "reel_header" AND clickable=true
      //      Instagram uses com.instagram.android:id/reel_header_content (and
      //      similar) for the clickable wrapper around each highlight circle.
      //      This is a code identifier, completely independent of locale or
      //      user-defined title.
      //
      //   2. Tray-bounds structural: find the scrollable/non-clickable
      //      container whose resource-id contains "highlight" (a code id, e.g.
      //      "profile_header_highlights_tray"), extract its Y bounds, then
      //      collect every small square-ish clickable node whose centre falls
      //      inside that band.  The circles are always roughly 100-220px wide
      //      with a near-1:1 aspect ratio.
      //
      //   3. Diagnostic fallback: log every clickable node's resource-id,
      //      content-desc, size, and position so the exact pattern can be
      //      identified from the Debugging Log without a separate inspect run.

      const segments = xml.split("<node ");

      interface HLCandidate { x: number; y: number; name: string }
      let candidates: HLCandidate[] = [];

      function parseHLNode(seg: string): {
        cx: number; cy: number; cd: string; rid: string; w: number; h: number;
      } | null {
        const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bb) return null;
        const x1 = parseInt(bb[1]); const y1 = parseInt(bb[2]);
        const x2 = parseInt(bb[3]); const y2 = parseInt(bb[4]);
        return {
          cx: Math.round((x1 + x2) / 2),
          cy: Math.round((y1 + y2) / 2),
          w:  x2 - x1,
          h:  y2 - y1,
          cd:  seg.match(/content-desc="([^"]*)"/)?.[1] ?? "",
          rid: seg.match(/resource-id="([^"]*)"/)?.[1] ?? "",
        };
      }

      // Strategy 1: resource-id contains "reel_header" (structural code id,
      // not text — works regardless of locale or user-defined title).
      for (const seg of segments) {
        const n = parseHLNode(seg); if (!n) continue;
        if (!n.rid.toLowerCase().includes("reel_header")) continue;
        candidates.push({ x: n.cx, y: n.cy, name: n.cd || n.rid });
      }

      // Strategy 2: find the highlights tray container by resource-id
      // (contains "highlight" as a code identifier — e.g.
      // "profile_header_highlights_tray"), extract its Y bounds, then
      // collect every small square-ish clickable node inside that band.
      if (candidates.length === 0) {
        let trayY1 = -1, trayY2 = -1;
        for (const seg of segments) {
          const rid = seg.match(/resource-id="([^"]*)"/)?.[1]?.toLowerCase() ?? "";
          // Must contain "highlight" as a code id but not itself be a
          // clickable circle (those are handled above / below).
          if (!rid.includes("highlight")) continue;
          const bb = seg.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
          if (!bb) continue;
          trayY1 = parseInt(bb[2]); trayY2 = parseInt(bb[4]);
          break;
        }
        if (trayY1 >= 0) {
          const bandY1 = trayY1 - 20;
          const bandY2 = trayY2 + 20;
          for (const seg of segments) {
            const n = parseHLNode(seg); if (!n) continue;
            if (n.cy < bandY1 || n.cy > bandY2) continue;
            // Circle icons are roughly square: AR 0.4-2.5, min 60 px wide.
            const ar = n.w > 0 ? n.h / n.w : 0;
            if (ar < 0.4 || ar > 2.5 || n.w < 60) continue;
            candidates.push({ x: n.cx, y: n.cy, name: n.cd || n.rid });
          }
        }
      }

      // Strategy 3: diagnostic — log every clickable node so the Debugging
      // Log reveals the exact resource-ids used on this device/build.
      if (candidates.length === 0) {
        onLog?.("Inject Browsing: no highlights found on this profile — skipping tap");
        const diagLines: string[] = [];
        for (const seg of segments) {
          const n = parseHLNode(seg); if (!n) continue;
          diagLines.push(
            `  rid="${n.rid.slice(0, 70)}" cd="${n.cd.slice(0, 40)}" pos=(${n.cx},${n.cy}) size=${n.w}x${n.h}`,
          );
          if (diagLines.length >= 35) { diagLines.push("  … (truncated)"); break; }
        }
        if (diagLines.length > 0) {
          onLog?.(`Inject Browsing: [diag] clickable nodes:\n${diagLines.join("\n")}`);
        }
        return;
      }

      // Pick one at random and tap it.
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      onLog?.(`Inject Browsing: tapping highlight "${pick.name}" at (${pick.x},${pick.y})…`);
      await android.tap(serial, pick.x, pick.y);
      await sleepOrAbort(serial, 1500); // wait for story viewer to open

      // Dwell 2–20 s inside the highlight story.
      const dwellMs = 2000 + Math.round(Math.random() * 18000);
      onLog?.(`Inject Browsing: dwelling in highlight for ${(dwellMs / 1000).toFixed(1)}s…`);
      await sleepOrAbort(serial, dwellMs);

      // Instagram's story viewer dismisses with the inverse of the normal
      // feed scroll gesture. Do not spend another UIAutomator dump deciding
      // whether it is open, and never use Android Back here: a Back event can
      // leave the viewer on an intermediate Instagram screen.
      onLog?.("Inject Browsing: swiping down to close highlight viewer…");
      // Close the Story using this device's calibrated Swipe Gesture Profile,
      // reversed from its normal direction.  This keeps the exact physical
      // start/end geometry and timing learned from the device instead of
      // falling back to the old shared center-line 300 ms gesture.
      await deviceProfileSwipe(
        serial,
        {
          x1: Math.round(getScreenSize(serial).w / 2),
          y1: Math.round(getScreenSize(serial).h * 0.35),
          x2: Math.round(getScreenSize(serial).w / 2),
          y2: Math.round(getScreenSize(serial).h * 0.92),
          durationMs: 300,
        },
        "story-close",
        "back",
      );
      await sleepOrAbort(serial, 700);
      onLog?.("Inject Browsing: ✓ highlight viewed and dismissed");
    } catch (e: any) {
      if (e?.message === "cycle-aborted") throw e;
      onLog?.(`Inject Browsing: tap highlights error — ${e?.message}`);
    }
  }

  /**
   * Runs the "Inject Browsing" sequence for ONE user's profile page. Caller
   * decides (via rollInjectBrowsingDecision) whether and when this runs —
   * this function no longer rolls the activate/before-follow gates itself.
   * Every roll below (whether the feed gets scrolled, whether a post gets
   * opened, liked, reposted, or shared via DM) is drawn fresh per user — a
   * min/max pair is a range the actual chance for THIS user is drawn from,
   * not a fixed percentage, so e.g. min=5/max=10 gives each user its own
   * roll somewhere in that band (~7.5% on average) rather than exactly 7.5%
   * every time.
   *
   * Must be called while already sitting on the target user's profile page.
   * When called before the follow tap: after findAndTapUserInSearch, before
   * tapFollowButtonOnProfilePage. When called after: right after the follow
   * tap succeeds/fails, still on the same profile page. Every step degrades
   * to a no-op (never throws, never leaves the profile page) if the
   * expected icon/button can't be located — per spec, a missing icon just
   * means that step is skipped for this user.
   */
  // Returns the number of profile-grid rows that were actually scrolled down,
  // so the caller can scroll EXACTLY that many rows back to the top before
  // tapping Follow.  Returns 0 when the feed-scroll roll was missed or rolled
  // 0 rows (profile is still at the top — doing a scroll-back there would
  // pull-to-refresh instead of returning to the top).
  async function runProfileBrowsingSequence(
    serial: string,
    browsing: InjectBrowsingParams,
    onLog?: (msg: string) => void,
    onLike?: () => void,
  ): Promise<number> {
    const { w, h } = getScreenSize(serial);

    // ── Tap Highlights — roll once at the start; coin-flip decides timing ──
    // 50 % chance it fires BEFORE the profile-grid scroll (highlighting feels
    // more natural when the page is still at the top), 50 % chance AFTER.
    const tapHighlightsChance = rollRange(browsing.tapHighlightsPctMin, browsing.tapHighlightsPctMax) / 100;
    const willTapHighlights   = tapHighlightsChance > 0 && Math.random() < tapHighlightsChance;
    const tapHighlightsBefore = willTapHighlights && Math.random() < 0.5;
    if (willTapHighlights) {
      onLog?.(`Inject Browsing: tap highlights — chance:${Math.round(tapHighlightsChance * 100)}% timing:${tapHighlightsBefore ? 'before' : 'after'} feed scroll`);
    }

    // ── Highlights — BEFORE feed scroll ──────────────────────────────────
    if (tapHighlightsBefore) {
      await tapOneProfileHighlight(serial, onLog);
    }

    // Activation already decided by rollInjectBrowsingDecision — no second
    // gate here. If we were called, the grid scroll is guaranteed to run;
    // only the number of rows is random.

    // Read the profile's post count so we never scroll past content that
    // doesn't exist.  12 posts fit on screen without scrolling (4 rows × 3
    // per row); every additional 12 posts allows one more scroll row.
    // If the count can't be parsed, fall back to the configured max.
    const profilePostCount = await android.getProfilePostCount(serial).catch(() => null);
    let maxScrollsByPostCount = Infinity;
    if (profilePostCount !== null) {
      maxScrollsByPostCount = Math.max(0, Math.floor((profilePostCount - 12) / 12));
      onLog?.(`Inject Browsing: profile has ${profilePostCount} post(s) — max useful scroll: ${maxScrollsByPostCount} row(s)`);
    }

    const rolledRows = Math.max(0, Math.round(rollRange(browsing.feedMin, browsing.feedMax)));
    const rows = Math.min(rolledRows, maxScrollsByPostCount);
    if (rows === 0) {
      onLog?.("Inject Browsing: feed posts rolled to 0 (or post count too low to need scrolling) — skipping grid scroll");
      return 0;
    }
    onLog?.(`Inject Browsing: scrolling profile grid — ${rows} row(s)`);
    const x = Math.round(w / 2);
    const y1 = Math.round(h * 0.78);
    const y2 = Math.round(h * 0.30);
    for (let i = 0; i < rows; i++) {
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      logger.info({ serial, source: "inject-profile-grid-scroll-down", from: [x, y1], to: [x, y2] }, "[mobile-input] swipe");
      await deviceProfileSwipe(serial, { x1: x, y1: y1, x2: x, y2: y2, durationMs: 500 + Math.round(Math.random() * 200) }, "inject-profile-grid-scroll-down");
      // Wait 4–7 seconds so images fully render before the next scroll.
      const renderWait = 4000 + Math.round(Math.random() * 3000);
      onLog?.(`Inject Browsing: waiting ${(renderWait / 1000).toFixed(1)}s for media to render…`);
      await sleepOrAbort(serial, renderWait);
    }

    // ── Highlights — AFTER feed scroll ───────────────────────────────────
    // Must run here — before click-post — so it fires even when the
    // click-post roll misses.  The original placement (after the post-open
    // block) was unreachable whenever click-post didn't fire, which meant
    // "after" timing silently never executed.
    if (willTapHighlights && !tapHighlightsBefore) {
      if (rows > 0) {
        onLog?.(`Inject Browsing: scrolling back to top for highlights — ${rows} row(s)`);
        for (let _hsi = 0; _hsi < rows; _hsi++) {
          logger.info({ serial, source: "inject-profile-grid-scroll-back-for-highlights", from: [Math.round(w / 2), Math.round(h * 0.35)], to: [Math.round(w / 2), Math.round(h * 0.80)], durationMs: 400 }, "[mobile-input] swipe");
          // This is the exact inverse of the configured account/device gesture.
          // Passing the back personality is required: deviceProfileSwipe uses
          // the saved x1/y1 → x2/y2 path whenever a profile exists, so merely
          // reversing this fallback would otherwise still send the normal
          // configured direction.
          await deviceProfileSwipe(
            serial,
            { x1: Math.round(w / 2), y1: Math.round(h * 0.35), x2: Math.round(w / 2), y2: Math.round(h * 0.80), durationMs: 400 },
            "inject-profile-grid-scroll-back",
            "back",
          );
          await sleepOrAbort(serial, 350);
          // The profile header stats (post count / followers / following)
          // disappear while the grid is scrolled and reappear at the top.
          // Check after every recovery swipe so an unpredictable gesture
          // cannot cause redundant swipes and repeated profile re-rendering.
          const topStats = await android.getProfilePostCount(serial).catch(() => null);
          if (topStats !== null) {
            onLog?.(`Inject Browsing: profile header detected after ${_hsi + 1}/${rows} upward swipe(s) — stopping top recovery early`);
            break;
          }
        }
        await sleepOrAbort(serial, 500);
      }
      await tapOneProfileHighlight(serial, onLog);
      return 0; // already at top — caller must not scroll back further
    }

    const clickChance = rollRange(browsing.clickPostPctMin, browsing.clickPostPctMax) / 100;
    if (!(clickChance > 0 && Math.random() < clickChance)) {
      onLog?.("Inject Browsing: click-post roll missed — not opening a post");
      return rows;
    }

    // Find real post thumbnail positions from the live accessibility tree.
    // Instagram's profile grid renders each thumbnail as a Button with
    // resource-id com.instagram.android:id/image_button — those are the
    // only safe tap targets.  Hardcoded percentage slots (w*0.17 etc.) are
    // forbidden: they can land on tab strips, gaps, or off-screen areas and
    // produce "no post opened" failures even on profiles with hundreds of posts.
    const gridPosts = await android.findProfileGridPosts(serial, onLog).catch(() => [] as { x: number; y: number; cd: string }[]);
    if (gridPosts.length === 0) {
      onLog?.("Inject Browsing: no image_button nodes found in grid — skipping post open");
      return rows;
    }
    const slot = gridPosts[Math.floor(Math.random() * gridPosts.length)];
    const slotCd = slot.cd ? ` (${slot.cd})` : "";
    onLog?.(`Inject Browsing: opening a scrolled post at (${slot.x},${slot.y})${slotCd}`);
    await android.tap(serial, slot.x, slot.y);
    await sleepOrAbort(serial, 1200);

    // Confirm a post actually opened (has a Like button).
    let icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);
    if (!icons) {
      // Distinguish two cases that both produce icons=null:
      //
      //   A) Tap didn't open a post (e.g. thumbnail was partially off-screen,
      //      or this is a pinned Reel/video that opens a different viewer) —
      //      still on the profile grid. Safe to retry with a fresh a11y dump.
      //
      //   B) A Reel/post opened but findFeedActionIcons returned null because
      //      the viewer uses a different label. We are INSIDE the viewer.
      //      Pressing Back + retrying is wrong — it closes a valid post.
      //
      // Detection: isInPostViewer checks for resource-ids that only appear
      // inside a post/Reel viewer, never on the profile grid.
      const insideViewer = await android.isInPostViewer(serial).catch(() => false);
      if (insideViewer) {
        onLog?.("Inject Browsing: post/Reel opened but icons not found — pressing Back to profile");
        logger.info({ serial }, "[inject-browsing] findFeedActionIcons=null, isInPostViewer=true — no identifiable Like button; pressing Back without retry");
        await android.pressBack(serial);
        await sleepOrAbort(serial, 500);
        return rows;
      }
      // Case A: still on profile grid — scroll up once and retry using a
      // fresh a11y dump (same rule: no hardcoded coordinates).
      //
      // Do NOT press Back here. Follow reaches this profile via a search, so
      // the profile's own Back target is the Search page. Pressing Back while
      // on the base profile grid (no viewer open) exits the profile entirely.
      onLog?.("Inject Browsing: no post opened here — scrolling up and retrying via a11y");
      logger.info({ serial }, "[inject-browsing] findFeedActionIcons=null, isInPostViewer=false — still on profile grid; scrolling up and re-scanning a11y tree for image_button nodes");
      await deviceProfileSwipe(
        serial,
        { x1: x, y1: y2, x2: x, y2: y1, durationMs: 500 },
        "inject-profile-grid-retry-scroll",
        "back",
      );
      await sleepOrAbort(serial, 800);
      const retryPosts = await android.findProfileGridPosts(serial, onLog).catch(() => [] as { x: number; y: number; cd: string }[]);
      if (retryPosts.length === 0) {
        onLog?.("Inject Browsing: retry — no image_button nodes found after scroll-up, giving up");
        return rows;
      }
      const retrySlot = retryPosts[Math.floor(Math.random() * retryPosts.length)];
      const retryCd = retrySlot.cd ? ` (${retrySlot.cd})` : "";
      onLog?.(`Inject Browsing: retry — tapping post at (${retrySlot.x},${retrySlot.y})${retryCd}`);
      await android.tap(serial, retrySlot.x, retrySlot.y);
      await sleepOrAbort(serial, 1200);
      icons = await android.findFeedActionIcons(serial, onLog).catch(() => null);
      if (!icons) {
        const stillInViewer = await android.isInPostViewer(serial).catch(() => false);
        onLog?.("Inject Browsing: retry also found no post — giving up on this profile's posts");
        logger.info({ serial, stillInViewer }, "[inject-browsing] retry tap also found no Like button — profile may be Reels-only or viewer label not recognised");
        if (stillInViewer) {
          await android.pressBack(serial);
          await sleepOrAbort(serial, 500);
        }
        return rows;
      }
      onLog?.("Inject Browsing: retry succeeded — post opened after scrolling up");
    }

    // Diagnostic: show exactly which icons were resolved so we can see
    // what the accessibility tree contained for this specific post.
    logger.info(
      { serial, like: !!icons.like, comment: !!icons.comment, shareFeed: !!icons.shareFeed, shareDm: !!icons.shareDm,
        shareFeedCoords: icons.shareFeed ?? null, shareDmCoords: icons.shareDm ?? null },
      "[inject-browsing] action-bar icons found for this profile post"
    );
    // Only report Like/Comment from the icon scan — ShareFeed and ShareDM are
    // resolved by findButtonByLabel("Repost"/"Send") which runs later and is
    // more reliable than the positional icon scan. Showing them here as ✗
    // was misleading users into thinking the repost/share hadn't worked even
    // when it had (the label-scan found the button even when the icon scan
    // failed to detect it by position).
    onLog?.(`Inject Browsing: icons — Like:${icons.alreadyLiked ? '(already liked)' : '✓'} Comment:${icons.comment?'✓':'✗'}`);

    const likeChance = rollRange(browsing.likePctMin, browsing.likePctMax) / 100;
    logger.info({ serial, likeChance: Math.round(likeChance * 100), alreadyLiked: !!icons.alreadyLiked }, "[inject-browsing] like chance rolled");
    if (likeChance > 0 && Math.random() < likeChance) {
      if (icons.alreadyLiked) {
        onLog?.("Inject Browsing: post already liked — skipping like tap, continuing with share actions");
        logger.info({ serial }, "[inject-browsing] post already liked (Unlike button found) — skipped like tap, share/DM actions will still run");
      } else {
        try {
          // ~93 % double-tap on the post image; ~7 % heart-icon tap for variety.
          const useDoubleTap = Math.random() < 0.93;
          if (useDoubleTap) {
            const { w: _ibW } = getScreenSize(serial);
            const dtX = Math.round(_ibW / 2) + Math.round((Math.random() - 0.5) * 20);
            let dtY: number;
            if (icons.mediaBounds) {
              const mb = icons.mediaBounds;
              const fraction = 0.25 + Math.random() * 0.20;
              dtY = Math.round(mb.y1 + (mb.y2 - mb.y1) * fraction) + Math.round((Math.random() - 0.5) * 20);
              onLog?.(`Inject Browsing: double-tap using media bounds (${Math.round(fraction * 100)}% into media)`);
            } else {
              dtY = icons.like.y - Math.round(icons.like.y * 0.35) + Math.round((Math.random() - 0.5) * 40);
            }
            onLog?.(`Inject Browsing: double-tapping image at (${dtX},${dtY})…`);
            await android.doubleTap(serial, dtX, dtY);
          } else {
            onLog?.(`Inject Browsing: tapping heart icon at (${icons.like.x},${icons.like.y})…`);
            await android.tap(serial, icons.like.x, icons.like.y);
          }
          onLike?.();
          onLog?.("Inject Browsing: ✓ liked the post");
          await sleepOrAbort(serial, 300);
        } catch { /* best effort */ }
      }
    }

    const shareFeedChance = rollRange(browsing.shareFeedPctMin, browsing.shareFeedPctMax) / 100;
    logger.info(
      { serial, shareFeedChance: Math.round(shareFeedChance * 100),
        settingsMin: browsing.shareFeedPctMin, settingsMax: browsing.shareFeedPctMax },
      "[inject-browsing] share-feed chance rolled"
    );
    if (!(shareFeedChance > 0 && Math.random() < shareFeedChance)) {
      onLog?.("Inject Browsing: share-to-feed roll missed — skipping");
    } else {
      try {
        // findButtonByLabel("Repost") is the trusted source — it only
        // returns a node whose content-desc literally matches "Repost", so
        // it can never point at the wrong icon. `icons.shareFeed` (from
        // findFeedActionIcons) is NOT equally trustworthy: when this
        // post's Repost icon has no content-desc, findFeedActionIcons
        // falls back to positional guessing (leftmost unclaimed node),
        // which silently mis-assigns the Comment icon's coordinates to
        // `shareFeed` whenever an icon is missing/unlabeled on this
        // device/build. That regression (Comment tapped instead of
        // Share, previously fixed in v1.1.499/v1.1.500) came back when
        // this code briefly preferred `icons.shareFeed` over the label
        // scan — do NOT invert this priority again. `icons.shareFeed` is
        // only used as a last resort when the label scan finds nothing.
        const repostIcon = await android.findButtonByLabel(serial, "Repost").catch(() => null) ?? icons.shareFeed;
        if (!repostIcon) {
          onLog?.("Inject Browsing: Repost icon not found on this post — skipping share-to-feed");
          logger.warn({ serial }, "[inject-browsing] neither findFeedActionIcons row-scan nor findButtonByLabel('Repost') found the icon — likely absent on this post (sharing disabled by poster)");
        } else {
          // Capture the icon's own label BEFORE tapping. Some accounts'
          // Instagram build reposts instantly on a single tap with NO
          // confirmation sheet at all — the icon just relabels itself in
          // place (e.g. "Repost" -> "Remove repost"/"Reposted"). Comparing
          // before/after lets us tell that apart from "sheet genuinely
          // never opened", which both look identical (a "Repost"-matching
          // node at the same coordinates) to a same-coords-only check —
          // confirmed via a live run where a real, successful single-tap
          // repost was misread as failure and triggered a wrong pressBack.
          await android.tap(serial, repostIcon.x, repostIcon.y);
          logger.info({ serial, x: repostIcon.x, y: repostIcon.y }, "[inject-browsing] tapped Repost icon");
          // Wait briefly for a confirmation sheet to appear (some devices/builds
          // show a "Repost" confirm button inside a bottom sheet; others do the
          // repost instantly on a single tap with no sheet at all).
          await sleepOrAbort(serial, 1000);
          const repostBtn = await android.findButtonByLabel(serial, "Repost").catch(() => null);
          const sameCoords = !!repostBtn &&
            Math.abs(repostBtn.x - repostIcon.x) < 15 && Math.abs(repostBtn.y - repostIcon.y) < 15;
          if (repostBtn && !sameCoords) {
            // A separate "Repost" confirm button appeared at a different
            // position — a real sheet is open. Tap it to confirm.
            await android.tap(serial, repostBtn.x, repostBtn.y);
            onLog?.("Inject Browsing: reposted the post");
            await sleepOrAbort(serial, 800);
            const closeBtn = await android.findButtonByLabel(serial, "Close").catch(() => null);
            if (closeBtn) { await android.tap(serial, closeBtn.x, closeBtn.y); await sleepOrAbort(serial, 400); }
          } else {
            // No sheet appeared — either the repost completed on a single tap
            // (no confirmation sheet on this device/build), or the post does
            // not support resharing. In both cases: do NOT press Back.
            // Pressing Back navigates away from the post and breaks the
            // remaining actions (ShareDM etc.) that still need to run.
            // The tap already fired; assume it worked.
            onLog?.("Inject Browsing: reposted the post (single tap — no sheet)");
            logger.info({ serial, repostBtn, sameCoords }, "[inject-browsing] no sheet appeared after Repost tap — assuming single-tap repost completed");
          }
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Inject Browsing: share-to-feed error — ${e?.message}`);
      }
    }

    const shareDmChance = rollRange(browsing.shareDmPctMin, browsing.shareDmPctMax) / 100;
    logger.info(
      { serial, shareDmChance: Math.round(shareDmChance * 100),
        settingsMin: browsing.shareDmPctMin, settingsMax: browsing.shareDmPctMax },
      "[inject-browsing] share-DM chance rolled"
    );
    if (!(shareDmChance > 0 && Math.random() < shareDmChance)) {
      onLog?.("Inject Browsing: share-via-DM roll missed — skipping");
    } else if (!icons.shareDm) {
      logger.info({ serial }, "[inject-browsing] skipped share-via-DM — icon not identifiable on this post (disabled or ambiguous layout)");
      onLog?.("Inject Browsing: skipped share-via-DM — paper-plane icon not found on this post");
    } else {
      // ── Inject Browsing — Share via DM (isolated; not shared with any other tool) ──
      try {
        if (isCycleAborted(serial)) throw new Error("cycle-aborted");
        await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
        onLog?.(`Inject Browsing: tapping share-via-DM icon at (${icons.shareDm.x},${icons.shareDm.y})…`);
        await android.tap(serial, icons.shareDm.x, icons.shareDm.y);
        await sleepOrAbort(serial, 1500);
        onLog?.("Inject Browsing: confirming share sheet opened and picking DM recipient…");
        let _ibScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
        if (!_ibScan?.sheetOpen) {
          onLog?.("Inject Browsing: share sheet not yet visible — waiting 1500ms and retrying…");
          await sleepOrAbort(serial, 1500);
          _ibScan = await android.confirmAndScanShareSheet(serial, onLog).catch(() => null);
        }
        if (!_ibScan?.sheetOpen) {
          logger.warn({ serial }, "[inject-browsing] share sheet not confirmed open after retry — closing and skipping DM");
          onLog?.("Inject Browsing: share aborted — share sheet did not open");
          await android.pressBack(serial);
          await sleepOrAbort(serial, 200);
        } else {
          const _ibSendBtn0 = _ibScan.sendBtn ?? null;
          if (_ibScan.preSelectedRecipients && _ibScan.preSelectedRecipients.length > 0) {
            onLog?.(`Inject Browsing: deselecting ${_ibScan.preSelectedRecipients.length} pre-selected recipient(s) from prior run…`);
            for (const _r of _ibScan.preSelectedRecipients) {
              onLog?.(`Inject Browsing: deselecting${(_r as any).name ? ` (${(_r as any).name})` : ""} at (${_r.x},${_r.y})`);
              await android.tap(serial, _r.x, _r.y);
              await sleepOrAbort(serial, 400);
            }
          }
          const _ibRecipients = _ibScan.recipients ?? [];
          if (_ibRecipients.length === 0) {
            await android.pressBack(serial);
            logger.warn({ serial }, "[inject-browsing] no recipient found — closed share sheet without sending");
            onLog?.("Inject Browsing: share skipped — no recipient avatars found (closed without sending)");
          } else {
            const _ibLast = _injectBrowsingLastDmRecipient.get(serial);
            const _ibPool = _ibLast ? _ibRecipients.filter(r => !(r.x === _ibLast.x && r.y === _ibLast.y)) : _ibRecipients;
            const _ibCands = _ibPool.length > 0 ? _ibPool : _ibRecipients;
            const _ibPick = _ibCands[Math.floor(Math.random() * _ibCands.length)];
            _injectBrowsingLastDmRecipient.set(serial, { x: _ibPick.x, y: _ibPick.y });
            onLog?.(`Inject Browsing: tapping recipient at (${_ibPick.x},${_ibPick.y})${(_ibPick as any).name ? ` (${(_ibPick as any).name})` : ""}`);
            await android.tap(serial, _ibPick.x, _ibPick.y);
            await sleepOrAbort(serial, 800);
            const _ibIsOpen = async () => {
              const _x = await android.dumpUi(serial).catch(() => "");
              // "Add to story" removed — home-feed story tray has this label
              // and causes a false-positive after the sheet closes.
              return _x.includes("direct_private_share") || _x.includes("grid_view_pog_avatar_view") ||
                     _x.includes("android.widget.EditText") || _x.includes("Copy link");
            };
            const _ibSb = _ibSendBtn0 ?? await android.findButtonByLabel(serial, "Send").catch(() => null);
            if (_ibSb) {
              await android.tap(serial, _ibSb.x, _ibSb.y);
              await sleepOrAbort(serial, 300);
              if (!(await _ibIsOpen())) {
                logger.info({ serial }, "[inject-browsing] shared post via DM — Send tapped");
                onLog?.("Inject Browsing: ✓ shared via DM — Send tapped");
                await sleepOrAbort(serial, 300);
              } else {
                logger.info({ serial }, "[inject-browsing] Send button not found after picking recipient — pressing Back");
                onLog?.("Inject Browsing: Send button not found after picking DM recipient — pressing Back");
                await android.pressBack(serial);
                await sleepOrAbort(serial, 200);
              }
            } else if (!(await _ibIsOpen())) {
              logger.info({ serial }, "[inject-browsing] share sheet already closed — DM likely sent by recipient tap");
              onLog?.("Inject Browsing: ✓ shared via DM — sheet auto-dismissed (sent by recipient tap)");
              await sleepOrAbort(serial, 200);
            } else {
              const _ibFbX = Math.round(w * 0.50), _ibFbY = Math.round(h * 0.982);
              onLog?.(`Inject Browsing: Send button not found via a11y — tapping coordinate fallback (${_ibFbX},${_ibFbY})`);
              await android.tap(serial, _ibFbX, _ibFbY);
              await sleepOrAbort(serial, 300);
              if (!(await _ibIsOpen())) {
                onLog?.("Inject Browsing: ✓ shared via DM — sent via coordinate fallback");
                await sleepOrAbort(serial, 300);
              } else {
                await android.pressBack(serial);
                await sleepOrAbort(serial, 200);
              }
            }
          }
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Inject Browsing: share-via-DM error — ${e?.message}`);
      }
    }

    // ── Save Post ────────────────────────────────────────────────────────────
    const savePostChance = rollRange(browsing.savePostPctMin, browsing.savePostPctMax) / 100;
    if (!(savePostChance > 0 && Math.random() < savePostChance)) {
      onLog?.("Inject Browsing: save-post roll missed — skipping");
    } else if (!icons.save) {
      logger.info({ serial }, "[inject-browsing] skipped save-post — row_feed_button_save not found on this post");
      onLog?.("Inject Browsing: skipped save-post — bookmark icon not found on this post");
    } else {
      try {
        if (isCycleAborted(serial)) throw new Error("cycle-aborted");
        await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300));
        onLog?.(`Inject Browsing: tapping save icon at (${icons.save.x},${icons.save.y})…`);
        await android.tap(serial, icons.save.x, icons.save.y);
        await sleepOrAbort(serial, 600);
        // Dismiss the "Collect the posts you love" bottom sheet if it appears.
        {
          const _ibSaveXml = await android.dumpUi(serial).catch(() => "");
          if (_ibSaveXml.includes('pinned_save_row') || _ibSaveXml.includes('Collect the posts you love')) {
            const { w: _ibW, h: _ibH } = getScreenSize(serial);
            await android.tap(serial, Math.round(_ibW * 0.50), Math.round(_ibH * 0.12));
            onLog?.("Inject Browsing: dismissed \"Save to collection?\" popup");
            await sleepOrAbort(serial, 300);
          }
        }
        onLog?.("Inject Browsing: ✓ post saved");
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Inject Browsing: save-post error — ${e?.message}`);
      }
    }

    // Back out of the opened post to the profile grid before continuing.
    await android.pressBack(serial);
    await sleepOrAbort(serial, 500);

    return rows;
  }

  async function runFollowUsersStep(
    serial: string,
    params: {
      usersMin: number;
      usersMax: number;
      sources: { type: string; value: string }[];
      onLog?: (msg: string) => void;
      recordFollow?: (username: string, source: string) => void;
      onLike?: () => void;
      browsing?: InjectBrowsingParams;
      /** Pre-built set of lowercase usernames already followed — candidates
       *  matching any entry are dropped before the follow loop begins, so no
       *  browsing time is wasted on a target that has already been followed. */
      skipFollowedUsernames?: Set<string>;
      /** Usernames in the global skipped list — candidates matching any entry
       *  are dropped before the follow loop so they are never re-scraped. */
      skipSkippedUsernames?: Set<string>;
      /** Profile-quality gates to apply after navigating to the target's
       *  profile but before the Follow tap. */
      filters?: { skipVerified?: boolean; maxFollowers?: number; skipPrivate?: boolean; minFollowers?: number; requireEnglish?: boolean; malesOnly?: boolean; maleNames?: string };
      /** Jarvee-style "abort after X scrapes" limit. 0 = unlimited.
       *  Counts the initial HikerAPI fetch as scrape #1; re-scrapes count
       *  from #2 onward.  When the total reaches this number the session
       *  ends even if targetCount hasn't been reached. */
      maxScrapeSessions?: number;
      /** DB profile ID for this Instagram account. When provided, Surplus
       *  candidates saved from previous cycles are consumed first before
       *  HikerAPI is called. Leftover candidates at the end of the session
       *  are written back to Surplus for the next cycle. */
      profileId?: number;
      /** Phone-farm slot key (Instagram username, no @) used when the slot
       *  has no matching EB profile. Surplus is keyed by this when profileId
       *  is absent. */
      phoneSlotKey?: string;
      /** When true, any candidate rejected by a filter (HikerAPI metadata pre-
       *  filter or profile-visit quality gate) is written to the global
       *  skipped_users table so every account skips that user on future cycles.
       *  Tied to the "Skip Already Skipped Users" toggle in Settings → Automation.
       *  When false/absent no writes are made to skipped_users. */
      writeSkippedUsers?: boolean;
      /** Spread-Follows mode: pre-fetched candidates from the automation cycle.
       *  When provided the entire HikerAPI/surplus fetch phase is skipped and
       *  these candidates are used directly. Surplus save is also skipped (the
       *  caller manages it). */
      preloadedCandidates?: {
        targets: string[];
        candidateSource: Map<string, string>;
        candidateMeta: Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }>;
      };
       /** The caller has already left Instagram on a confirmed, focused,
        * cleared Search field (used for spread backup candidates). */
       searchAlreadyReady?: boolean;
       /** Keep the Search surface only when another spread slot follows
        *  immediately. The final slot must restore the normal Instagram UI. */
       keepSearchOpenAfterStep?: boolean;
    },
  ): Promise<number> {
    const { usersMin, usersMax, sources, onLog, onLike, recordFollow, browsing, skipFollowedUsernames, skipSkippedUsernames, filters } = params;
    let searchReadyForReuse = !!params.searchAlreadyReady;

    // Follow leaves Instagram on the search/results surface after each
    // profile.  Always restore the normal Instagram UI before another tool
    // starts: clear the current query through Instagram's live clear control,
    // then leave the search surface with exactly one Back.  This is also
    // required when the run stops early (including spread mode), otherwise
    // the next tool cannot reliably find the Home tab.
    const finishFollowNavigation = async () => {
      try {
        await android.clearInstagramSearchBar(serial, (msg) => onLog?.(`Follow: cleanup — ${msg}`));
      } catch (e: any) {
        onLog?.(`Follow: cleanup clear failed — ${e?.message ?? "unknown error"}`);
      }
      try {
        await android.pressBack(serial);
        await sleepOrAbort(serial, 500);
        onLog?.("Follow: cleanup — cleared search and pressed Back once to normal UI");
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Follow: cleanup Back failed — ${e?.message ?? "unknown error"}`);
      }
    };

    // A rejected profile must stay inside the Explore/search flow. Returning
    // to the normal UI here makes the next candidate trigger the expensive
    // Home → Search navigation again and can cause the cleanup Back sequence
    // to land on Home. Return one level to results, clear the query, and leave
    // the live search field focused for the next candidate.
    const returnToClearedFollowSearch = async () => {
      // This state is only valid after every confirmation below succeeds.
      // Invalidate it before touching navigation so a failed Back/search
      // recovery can never leak a stale "reuse" claim into the next user.
      searchReadyForReuse = false;
      await android.pressBack(serial);
      await sleepOrAbort(serial, 500);
      await android.clearInstagramSearchBar(serial, (msg) => onLog?.(`Follow: skipped-user cleanup — ${msg}`));
      const searchBar = await android.findInstagramSearchBar(serial, onLog).catch(() => null);
      if (!searchBar) {
        onLog?.("Follow: skipped-user cleanup — cleared search bar not found");
        return false;
      }
      await android.tap(serial, searchBar.x, searchBar.y);
      await sleepOrAbort(serial, 500);
      const focused = await android.isInstagramSearchBarFocused(serial).catch(() => false);
      if (!focused) {
        onLog?.("Follow: skipped-user cleanup — search bar focus not confirmed");
        return false;
      }
      onLog?.("Follow: skipped-user cleanup — search bar cleared and focused for next user");
      searchReadyForReuse = true;
      return true;
    };

    // ── Shared state — populated by either the normal fetch path or the
    //    spread-mode preloaded path, then consumed by the shared follow loop. ──
    const _usePreloaded = !!params.preloadedCandidates;
    let candidateSource = new Map<string, string>();
    let candidateMeta   = new Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }>();
    let targets: string[] = [];
    let targetCount = 0;
    let hiker: HikerApiClient | undefined;
    let attemptedSet = new Set<string>();
    let MAX_SCRAPE_ROUNDS = 0;
    const profileId = params.profileId;
    const phoneSlotKey = params.phoneSlotKey?.replace(/^@/, "").toLowerCase() || "";

    if (!_usePreloaded) {
      if (!sources.length) {
        onLog?.("Follow: no target sources configured — skipping");
        return 0;
      }

      const globalSettings = await storage.getGlobalSettings();
      const hikerApiToken: string = globalSettings?.hikerApiToken ?? "";
      if (!hikerApiToken) {
        onLog?.("Follow: HikerAPI token not configured (Settings → Global → HikerAPI) — skipping");
        return 0;
      }

      const lo = Math.min(usersMin, usersMax);
      const hi = Math.max(usersMin, usersMax);
      targetCount = lo === hi ? lo : Math.round(lo + Math.random() * (hi - lo));
      if (targetCount === 0) { onLog?.("Follow: target count is 0 — skipping"); return 0; }

      onLog?.(`Follow: targeting ${targetCount} users from ${sources.length} source(s)`);

      hiker = new HikerApiClient(hikerApiToken);
      // Track source per username so the Followed Users tab shows the hashtag
      // or target account the user was discovered from, not "hikerapi".
      const candidates: string[] = [];

    // ── Surplus / Overspill candidates ──────────────────────────────────────
    // Before calling HikerAPI, check the Surplus table for candidates saved
    // from previous cycles for this account. Consuming these first avoids
    // burning HikerAPI quota on sources that were already scraped.
    const overspillIdsToDelete: number[] = [];
    if (profileId && profileId > 0) {
      try {
        const overspillRows = await storage.getOverspillUsersByProfile(profileId);
        if (overspillRows.length > 0) {
          onLog?.(`Follow: ${overspillRows.length} candidate${overspillRows.length !== 1 ? "s" : ""} in Surplus — using before HikerAPI`);
          for (const row of overspillRows) {
            const u = row.instagramUsername;
            if (skipFollowedUsernames?.has(u.toLowerCase())) continue;
            if (skipSkippedUsernames?.has(u.toLowerCase())) continue;
            if (!candidateSource.has(u)) candidateSource.set(u, row.sourceValue || "surplus");
            candidates.push(u);
            overspillIdsToDelete.push(row.id);
          }
        }
      } catch (e: any) {
        onLog?.(`Follow: could not load Surplus — ${e?.message}`);
      }
    } else if (phoneSlotKey) {
      try {
        const overspillRows = await storage.getOverspillUsersByPhoneSlot(phoneSlotKey);
        if (overspillRows.length > 0) {
          onLog?.(`Follow: ${overspillRows.length} candidate${overspillRows.length !== 1 ? "s" : ""} in Surplus — using before HikerAPI`);
          for (const row of overspillRows) {
            const u = row.instagramUsername;
            if (skipFollowedUsernames?.has(u.toLowerCase())) continue;
            if (skipSkippedUsernames?.has(u.toLowerCase())) continue;
            if (!candidateSource.has(u)) candidateSource.set(u, row.sourceValue || "surplus");
            candidates.push(u);
            overspillIdsToDelete.push(row.id);
          }
        }
      } catch (e: any) {
        onLog?.(`Follow: could not load Surplus — ${e?.message}`);
      }
    }
    // Delete the Surplus records we loaded so they aren't re-used if the cycle
    // is interrupted before the new surplus is saved at the end.
    if (overspillIdsToDelete.length > 0) {
      storage.deleteOverspillUsers(overspillIdsToDelete).catch(() => {});
    }

    // Only call HikerAPI if Surplus didn't already fill the candidate pool.
    if (candidates.length < targetCount * 3) {
      // Shuffle sources before iterating so the loop (which breaks as soon as
      // enough candidates are collected) starts from a different random source
      // each cycle rather than always position 0 (#bodybuilding in this case).
      // Without the shuffle, targetCount×3 candidates are found immediately from
      // the first source, the break fires, and the rest of the list is never
      // reached.
      const shuffledSources = [...sources].sort(() => Math.random() - 0.5);

      for (const src of shuffledSources) {
        if (candidates.length >= targetCount * 3) break;
        const sourceLabel = src.type === "hashtag"
          ? `#${src.value.replace(/^#/, "")}`
          : `@${src.value.replace(/^@/, "")}`;
        try {
          if (src.type === "hashtag") {
            const res = await hiker.getHashtagUsers(src.value.replace(/^#/, ""), 50);
            for (const u of res.users) {
              if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
              if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
              candidates.push(u.username);
            }
            onLog?.(`Follow: ${sourceLabel} → ${res.users.length} users`);
          } else if (src.type === "target_followers") {
            const userInfo = await hiker.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
            if (!userInfo?.pk) { onLog?.(`Follow: could not resolve @${src.value} — skipping source`); continue; }
            const followers = await hiker.getFollowers(userInfo.pk, 50);
            for (const u of followers) {
              if (!candidateSource.has(u.username)) candidateSource.set(u.username, sourceLabel);
              if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
              candidates.push(u.username);
            }
            onLog?.(`Follow: ${sourceLabel} followers → ${followers.length} users`);
          }
        } catch (e: any) {
          onLog?.(`Follow: HikerAPI error for source "${src.value}": ${e?.message}`);
        }
      }
    } else {
      onLog?.("Follow: Surplus pool is sufficient — skipping HikerAPI scrape this cycle");
    }

    if (!candidates.length) { onLog?.("Follow: no candidates collected — skipping"); return 0; }

    // Deduplicate and shuffle first, then filter out already-followed users
    // (checked before any browsing/follow attempt so no time is wasted).
    const unique = [...new Set(candidates)].sort(() => Math.random() - 0.5);
    let filtered = unique;
    if (skipFollowedUsernames?.size) {
      filtered = unique.filter(u => !skipFollowedUsernames.has(u.toLowerCase()));
      const skipped = unique.length - filtered.length;
      if (skipped > 0) onLog?.(`Follow: skipped ${skipped} already-followed user${skipped !== 1 ? 's' : ''}`);
    }
    if (skipSkippedUsernames?.size) {
      const before = filtered.length;
      filtered = filtered.filter(u => !skipSkippedUsernames.has(u.toLowerCase()));
      const skipped = before - filtered.length;
      if (skipped > 0) onLog?.(`Follow: skipped ${skipped} user${skipped !== 1 ? 's' : ''} already in the global skip list`);
    }
    // HikerAPI metadata is retained for source context only. Account-quality
    // filters are evaluated against Instagram's live profile UI below.

    // Mutable candidate pool. Extended automatically by re-scraping HikerAPI
    // whenever the current batch is exhausted before `targetCount` is reached —
    // the Follow tool never abandons mid-run just because a batch ran dry.
    targets = [...filtered];
    // Track every username ever placed in the pool across all scrape rounds so
    // re-scrapes never inject duplicates.
    attemptedSet = new Set<string>(targets.map(u => u.toLowerCase()));
      onLog?.(`Follow: ${targets.length} candidate${targets.length !== 1 ? "s" : ""} in pool, targeting ${targetCount} follow${targetCount !== 1 ? "s" : ""}`);
      MAX_SCRAPE_ROUNDS = (params.maxScrapeSessions ?? 0) > 0
        ? (params.maxScrapeSessions as number) - 1   // -1: initial scrape already done before loop
        : 50;  // effectively unlimited
    } else {
      // ── Spread mode: use pre-fetched candidates provided by the automation cycle ─
      const _pre = params.preloadedCandidates!;
      for (const [k, v] of _pre.candidateSource) candidateSource.set(k, v);
      for (const [k, v] of _pre.candidateMeta)   candidateMeta.set(k, v);
      targets = [..._pre.targets];
      targetCount = targets.length;
      if (targetCount === 0) { onLog?.("Follow: spread slot — no pre-fetched candidates"); return 0; }
      onLog?.(`Follow: spread mode — ${targetCount} Surplus candidate(s)`);
      attemptedSet = new Set<string>(targets.map(u => u.toLowerCase()));
      // MAX_SCRAPE_ROUNDS stays 0 — no re-scraping in spread mode
    }

    let followed = 0;
    let _fi = 0;              // manual index into `targets` (grows as re-scrapes inject new entries)
    let scrapeRound = 0;

    // Navigate to Search only for the first candidate in a spread. Backup
    // candidates reuse the confirmed cleared/focused Search field left by the
    // previous rejected candidate.
    if (!params.searchAlreadyReady) {
      onLog?.("[TRACE] follow: prepare-search");
      // Returning from Explore can leave the Search surface visually present
      // before its accessibility nodes are republished.
      await sleepOrAbort(serial, 2500);

    // Floating-window guard (MIUI "Floating windows" feature, confirmed 15 Jul
    // 2026 from live log + screenshot evidence). When Instagram is running in a
    // MIUI floating / resized window instead of fullscreen, the UIAutomator
    // accessibility dump reports the window's own bounds as the root — e.g.
    // 720×1709 instead of the real 1080×2460 screen. This shifts the
    // bottom-nav detection cutoff to a position where the nav bar no longer
    // sits, causing findInstagramSearchTab to return null every time even
    // though Instagram's layout is unchanged. Detection: compare the
    // ui-dump-derived root-bounds height against the real device height from
    // `adb shell wm size`. If mismatched by more than 12%, Instagram is in a
    // floating window. Recovery: relaunch Instagram fullscreen via `am start`
    // with CLEAR_TOP / NEW_TASK, which pulls the existing task out of floating
    // mode and into the foreground at full screen size on all tested MIUI
    // versions.
    const floatCheck = await android.detectFloatingWindow(serial).catch(() => null);
    if (floatCheck?.floating) {
      onLog?.(
        `Follow: ⚠️ Instagram is in a floating window (window ${floatCheck.windowW}×${floatCheck.windowH}, ` +
        `real screen ${floatCheck.deviceW}×${floatCheck.deviceH}) — relaunching fullscreen before proceeding`,
      );
      // Force-launch the main activity via the existing launchInstagram helper
      // (am start --activity-clear-top). Android/MIUI promotes the task from
      // the floating-window stack to a normal fullscreen foreground task.
      await android.launchInstagram(serial);
      // Give MIUI time to animate the window transition back to fullscreen.
      await sleepOrAbort(serial, 3000);
    }

      const searchTab = await android.findInstagramSearchTab(serial, onLog).catch(() => null);
      if (!searchTab) {
        onLog?.("Follow: Search tab not found — skipping");
        await finishFollowNavigation();
        return 0;
      }
      await android.tap(serial, searchTab.x, searchTab.y);
      onLog?.("[TRACE] follow: tap-search-tab");
      await sleepOrAbort(serial, 2500);
    } else {
      onLog?.("Follow: reusing confirmed cleared Search field for next spread candidate");
    }

    while (followed < targetCount) {
      // Pool exhausted — fetch a fresh batch from HikerAPI rather than giving up
      if (_fi >= targets.length) {
        if (scrapeRound >= MAX_SCRAPE_ROUNDS) {
          onLog?.(`Follow: pool exhausted after ${MAX_SCRAPE_ROUNDS} re-scrape rounds — stopping at ${followed}/${targetCount} follows`);
          break;
        }
        scrapeRound++;
        onLog?.(`Follow: pool exhausted (${followed}/${targetCount} followed) — re-scraping from HikerAPI (round ${scrapeRound}/${MAX_SCRAPE_ROUNDS})…`);
        // Abort check before any network calls — if the toggle was switched off
        // while the previous candidates were running, stop immediately instead
        // of firing a whole new batch of HikerAPI requests.
        await sleepOrAbort(serial, 0);
        const newRaw: string[] = [];
        const shuffledSrcs = [...sources].sort(() => Math.random() - 0.5);
        for (const src of shuffledSrcs) {
          // Check abort between every source so a long scrape round doesn't
          // ignore a stop-signal for minutes.
          await sleepOrAbort(serial, 0);
          if (newRaw.length >= targetCount * 3) break;
          const srcLabel = src.type === "hashtag"
            ? `#${src.value.replace(/^#/, "")}`
            : `@${src.value.replace(/^@/, "")}`;
          try {
            if (src.type === "hashtag") {
              const res = await hiker!.getHashtagUsers(src.value.replace(/^#/, ""), 50);
              for (const u of res.users) {
                if (attemptedSet.has(u.username.toLowerCase())) continue;
                if (!candidateSource.has(u.username)) candidateSource.set(u.username, srcLabel);
                if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                  candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                newRaw.push(u.username);
                attemptedSet.add(u.username.toLowerCase());
              }
              onLog?.(`Follow: re-scrape ${srcLabel} → ${res.users.length} users`);
            } else if (src.type === "target_followers") {
              const userInfo = await hiker!.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
              if (userInfo?.pk) {
                const followers = await hiker!.getFollowers(userInfo.pk, 50);
                for (const u of followers) {
                  if (attemptedSet.has(u.username.toLowerCase())) continue;
                  if (!candidateSource.has(u.username)) candidateSource.set(u.username, srcLabel);
                  if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                    candidateMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                  newRaw.push(u.username);
                  attemptedSet.add(u.username.toLowerCase());
                }
                onLog?.(`Follow: re-scrape ${srcLabel} followers → ${followers.length} users`);
              }
            }
          } catch (e: any) {
            // Must re-throw cycle-aborted — the generic catch here would
            // otherwise swallow it and keep looping through more sources.
            if (e?.message === "cycle-aborted") throw e;
            onLog?.(`Follow: HikerAPI re-scrape error for "${src.value}": ${e?.message}`);
          }
        }
        // Apply only global skip rules; account-quality filters are checked
        // against Instagram's live profile UI below.
        const newFiltered = newRaw.filter(u => {
          if (skipFollowedUsernames?.has(u.toLowerCase())) return false;
          if (skipSkippedUsernames?.has(u.toLowerCase())) return false;
          return true;
        });
        if (!newFiltered.length) {
          onLog?.(`Follow: re-scrape round ${scrapeRound} returned no new viable candidates — stopping`);
          break;
        }
        onLog?.(`Follow: re-scrape injected ${newFiltered.length} new candidate${newFiltered.length !== 1 ? "s" : ""} — continuing`);
        targets.push(...newFiltered);
        continue;
      }

      const username = targets[_fi++];
      try {
        onLog?.(`Follow: → @${username} (candidate ${_fi}/${targets.length})`);
        // A result tap opens a profile. The previous candidate's confirmed
        // Search state must never survive that navigation.
        searchReadyForReuse = false;

        // Tap the search bar and allow only a short keyboard/focus settle.
        // The live focus check below is authoritative; a multi-second random
        // delay here made every already-cleared search unnecessarily slow.
        // After a profile navigation, never assume the previous Search
        // surface survived. Re-enter Search from the live semantic tab node
        // before looking for the input bar.
        if (_fi > 1 && !searchReadyForReuse) {
          onLog?.("[TRACE] follow: re-enter-search-after-profile");
          const recoverySearchTab = await android.findInstagramSearchTab(serial, onLog).catch(() => null);
          if (!recoverySearchTab) {
            onLog?.("Follow: Search tab not confirmed after profile navigation — stopping");
            break;
          }
          await android.tap(serial, recoverySearchTab.x, recoverySearchTab.y);
          await sleepOrAbort(serial, 2500);
        }
        const searchBar = await android.findInstagramSearchBar(serial, onLog).catch(() => null);
        if (!searchBar) { onLog?.("Follow: search bar accessibility node not found — stopping"); break; }
        onLog?.("[TRACE] follow: tap-search-field");
        await android.tap(serial, searchBar.x, searchBar.y);
        await sleepOrAbort(serial, 500 + Math.floor(Math.random() * 500));
        const searchFocused = await android.isInstagramSearchBarFocused(serial).catch(() => false);
        if (!searchFocused) {
          onLog?.("Follow: search bar tap was not confirmed focused — stopping without pressing Back");
          break;
        }

        // Clear any leftover text from the previous search, then type the
        // new username.  KEYCODE_CTRL_A cannot send modifier+key chords via
        // adb shell input keyevent on Android — it is silently ignored so old
        // search text accumulates.  clearInstagramSearchBar() finds and taps
        // the × clear button by resource-id, or falls back to backspace-over-
        // text using the EditText node's text attribute (no coordinates used).
        if (searchReadyForReuse) {
          onLog?.("Follow: reusing confirmed clear/focus state — skipping redundant search cleanup");
        } else {
          // The Search node was just found and tapped above. Do not perform a
          // second UIAutomator dump here: on slower devices it can consume
          // the full dump timeout even when the field is already empty.
          await android.clearInstagramSearchBar(
            serial,
            (msg) => onLog?.(`  ${msg}`),
            { skipNodeLookup: true },
          );
        }
        searchReadyForReuse = false;
        onLog?.("[TRACE] follow: type-username");
        // Use only real taps on the saved Android keyboard calibration map.
        const typed = await android.typeViaSavedCalibrationMap(serial, username.replace(/^@+/, ""), effectiveTypingProfile(serial), message => {
          onLog?.(`  ${message}`);
        }, { debugLabel: "Follow" });
        if (!typed.ok) {
          onLog?.(
            `Follow: calibrated keyboard could not enter ${username}` +
            `${typed.missing.length ? ` — missing ${typed.missing.join(", ")}` : ""} — skipping`,
          );
          onLog?.("Follow: leaving failed search state without Back because field entry was not confirmed");
          continue;
        }
        // Tap the matched user in results
        onLog?.("[TRACE] follow: open-search-result");
        const searchResult = await android.findAndTapUserInSearch(serial, username, onLog).catch(() => ({ found: false }));
        if (!searchResult.found) {
          onLog?.(`Follow: @${username} not found in results — skipping`);
          // Stay on the Search/Explore surface for the next candidate. A failed
          // result lookup has not opened a profile, so pressing Back here can
          // leave Explore and return to the feed; the next loop iteration will
          // find, focus, and clear the live search bar directly.
          await android.clearInstagramSearchBar(serial, (msg) => onLog?.(`  ${msg}`)).catch(() => {});
          searchReadyForReuse = true;
          onLog?.("Follow: failed result cleaned without Back — staying in Search for next candidate");
          continue;
        }

        let profileXml = searchResult.profileXml ?? "";
        // The post-tap verifier already dumped a confirmed profile tree. Reuse
        // it when it contains the profile header; only wait/dump again when
        // the verifier's tree is too sparse for the configured live filters.
        const profileEvidencePresent =
          profileXml.includes(":id/follow_button") ||
          profileXml.includes(":id/follow_btn") ||
          profileXml.includes(":id/inline_follow_button") ||
          /(?:text|content-desc)="(?:Follow|Following|Requested)"/.test(profileXml);
        if (!profileEvidencePresent) {
          await sleepOrAbort(serial, 1500);
          profileXml = await android.dumpUi(serial).catch(() => "");
        }

        // ── Profile-quality filter gate ────────────────────────────────────
        // ONE shared XML dump covers ALL active profile-quality filters:
        // Verified badge, Private account, Follower count (min & max), English
        // Speaking. Extra 1 s settle lets the profile header fully render
        // (badge + follower count) before the dump fires.
        if (filters && (filters.skipVerified || filters.skipPrivate || filters.maxFollowers !== undefined || filters.minFollowers !== undefined || filters.requireEnglish || filters.malesOnly)) {
          try {
            const filterGateStartedAt = Date.now();
            if (!profileXml || !profileXml.includes("</hierarchy>")) {
              await sleepOrAbort(serial, 1000);
              profileXml = await android.dumpUi(serial).catch(() => "");
            }

            // ── Verified badge ──────────────────────────────────────────────
            if (filters.skipVerified) {
              const isVerified =
                /content-desc="[^"]*[Vv]erified[^"]*"/.test(profileXml) ||
                profileXml.includes(":id/is_verified") ||
                profileXml.includes(":id/verified_badge") ||
                profileXml.includes(":id/verified_checkmark");
              if (isVerified) {
                onLog?.(`Follow: @${username} is verified — skipping (Skip Verified filter)`);
                if (params.writeSkippedUsers) storage.addSkippedUser(username, "verified-badge").catch(() => {});
                await returnToClearedFollowSearch();
                continue;
              }
            }

            // ── Private account ─────────────────────────────────────────────
            if (filters.skipPrivate) {
              // Instagram's private-profile UI is exposed as a notice block,
              // not consistently as a `private_profile` resource.  Current
              // builds expose:
              //   row_profile_header_empty_profile_notice_title
              //   text="This account is private"
              // and a subtitle telling the user to follow to see photos.
              // Match the live accessibility dump case-insensitively because
              // Android/Instagram builds vary the capitalization.
              const normalizedPrivateXml = profileXml
                .replace(/&amp;/g, "&")
                .replace(/\s+/g, " ");
              const isPrivate =
                /(?:text|content-desc)="[^"]*this\s+account\s+is\s+private[^"]*"/i.test(normalizedPrivateXml) ||
                /(?:text|content-desc)="[^"]*follow\s+this\s+profile\s+to\s+see\s+their\s+photos\s+and\s+videos[^"]*"/i.test(normalizedPrivateXml) ||
                normalizedPrivateXml.includes("row_profile_header_empty_profile_notice_title") ||
                normalizedPrivateXml.includes("row_profile_header_empty_profile_notice_subtitle") ||
                /private_profile/i.test(normalizedPrivateXml);
              if (isPrivate) {
                onLog?.(`Follow: @${username} is private — skipping (Private Users filter)`);
                if (params.writeSkippedUsers) storage.addSkippedUser(username, "private-account").catch(() => {});
                await returnToClearedFollowSearch();
                continue;
              }
            }

            // ── Follower count (shared parse for max & min checks) ──────────
            if (filters.maxFollowers !== undefined || filters.minFollowers !== undefined) {
              const followerMatch = profileXml.match(
                /content-desc="([0-9][0-9,.]*)([KkMm]?)\s*[Ff]ollowers/
              );
              if (followerMatch) {
                const digits = parseFloat(followerMatch[1].replace(/,/g, ""));
                const suffix = followerMatch[2].toLowerCase();
                const count = suffix === "k" ? digits * 1_000
                            : suffix === "m" ? digits * 1_000_000
                            : digits;
                if (!isNaN(count)) {
                  if (filters.maxFollowers !== undefined && count >= filters.maxFollowers) {
                    onLog?.(`Follow: @${username} has ${count.toLocaleString()} followers (≥25K) — skipping (-25K filter)`);
                    if (params.writeSkippedUsers) storage.addSkippedUser(username, "too-many-followers").catch(() => {});
                    await returnToClearedFollowSearch();
                    continue;
                  }
                  if (filters.minFollowers !== undefined && count < filters.minFollowers) {
                    onLog?.(`Follow: @${username} has ${count.toLocaleString()} followers (<${filters.minFollowers}) — skipping (50 Followers+ filter)`);
                    if (params.writeSkippedUsers) storage.addSkippedUser(username, "too-few-followers").catch(() => {});
                    await returnToClearedFollowSearch();
                    continue;
                  }
                }
              }
            }

            // ── English Speaking ────────────────────────────────────────────
            // Detect non-allowed scripts by Unicode range rather than a
            // non-ASCII ratio. Ratio checks fail on mixed bios (some Hindi,
            // some Latin + emojis) because the Latin portion dilutes the
            // ratio below any threshold.
            //
            // SAFE scripts (pass through):
            //   Latin / Latin Extended (English, all EU languages)
            //   CJK Unified Ideographs (Chinese, Japanese)
            //   Hiragana / Katakana (Japanese)
            //   Hangul (Korean)
            //   Cyrillic (Bulgarian, Serbian — EU members)
            //   Greek (EU member)
            //   Common: ASCII, digits, punctuation, emoji
            //
            // BLOCKED scripts (trigger skip):
            //   Arabic / Urdu / Persian  U+0600–06FF, U+0750–077F,
            //                            U+08A0–08FF, U+FB50–FDFF, U+FE70–FEFF
            //   Devanagari (Hindi etc.)  U+0900–097F
            //   Bengali                  U+0980–09FF
            //   Gurmukhi (Punjabi)       U+0A00–0A7F
            //   Gujarati                 U+0A80–0AFF
            //   Oriya                    U+0B00–0B7F
            //   Tamil                    U+0B80–0BFF
            //   Telugu                   U+0C00–0C7F
            //   Kannada                  U+0C80–0CFF
            //   Malayalam                U+0D00–0D7F
            //   Sinhala                  U+0D80–0DFF
            //   Thai                     U+0E00–0E7F
            //   Lao                      U+0E80–0EFF
            //   Tibetan                  U+0F00–0FFF
            //   Myanmar                  U+1000–109F
            //
            // Even 3 characters from a blocked script in any node is enough
            // to skip — a single Hindi word easily exceeds that.
            if (filters.requireEnglish) {
              // eslint-disable-next-line no-misleading-character-class
              const BLOCKED_SCRIPT_RE = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F\u0D80-\u0DFF\u0E00-\u0E7F\u0E80-\u0EFF\u0F00-\u0FFF\u1000-\u109F]/g;
              // UIAutomator XML dumps encode non-Latin characters as XML
              // character references (e.g. Hindi "स" → "&#x938;" or "&#2360;")
              // rather than raw Unicode.  The regex above tests raw codepoints,
              // so it would silently miss every encoded char.  Decode both hex
              // (&#xNNNN;) and decimal (&#NNNN;) entity references before testing.
              const decodeXmlEntities = (s: string) =>
                s.replace(/&#x([0-9A-Fa-f]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
                 .replace(/&#([0-9]+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
              let skipForEnglish = false;
              const contentDescNodes = profileXml.match(/content-desc="([^"]{3,300})"/g) ?? [];
              const textNodes        = profileXml.match(/\btext="([^"]{3,300})"/g) ?? [];
              const allNodes = [...contentDescNodes, ...textNodes];
              for (const m of allNodes) {
                const rawVal = m.replace(/^(?:content-desc|text)="/, "").replace(/"$/, "");
                const val = decodeXmlEntities(rawVal);
                if (val.length < 3) continue;
                const blockedChars = (val.match(BLOCKED_SCRIPT_RE) ?? []).length;
                if (blockedChars >= 3) { skipForEnglish = true; break; }
              }
              if (skipForEnglish) {
                onLog?.(`Follow: @${username} bio contains non-allowed script — skipping (English Speaking filter)`);
                if (params.writeSkippedUsers) storage.addSkippedUser(username, "non-english").catch(() => {});
                await returnToClearedFollowSearch();
                continue;
              }
            }

            // ── Males Only (last profile filter) ────────────────────────────
            // This remains an explicit allowlist, never gender inference. The
            // live Instagram accessibility tree is authoritative; HikerAPI
            // candidate metadata is never used for this decision.
            if (filters.malesOnly) {
              const allowedNames = getCompiledMalesOnlyNames(filters.maleNames ?? "");
              let matchesAllowedName = false;
              if (allowedNames.length) {
                const malesMatchStartedAt = Date.now();
                const matchedEntry = findLiveMalesOnlyMatch(username, profileXml, allowedNames);
                onLog?.(`Follow: Males Only checked ${allowedNames.length.toLocaleString()} configured name(s) in ${Date.now() - malesMatchStartedAt} ms`);
                matchesAllowedName = Boolean(matchedEntry);
                if (matchedEntry) {
                  onLog?.(`Follow: Males Only allowed @${username} — matched "${matchedEntry.name}" in live profile ${matchedEntry.field}`);
                }
              }
              if (!matchesAllowedName) {
                onLog?.(`Follow: @${username} has no allowed Males Only name in username, name, or bio — skipping`);
                if (params.writeSkippedUsers) storage.addSkippedUser(username, "males-only-name").catch(() => {});
                await returnToClearedFollowSearch();
                continue;
              }
            }
            onLog?.(`Follow: profile filters completed in ${Date.now() - filterGateStartedAt} ms`);

          } catch (filterErr: any) {
            if (filters.skipPrivate) {
              onLog?.(`Follow: private-account check failed for @${username} — skipping`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "private-check-failed").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
            if (filters.malesOnly) {
              onLog?.(`Follow: Males Only profile check failed for @${username} (${filterErr?.message}) — skipping`);
              if (params.writeSkippedUsers) storage.addSkippedUser(username, "males-only-check-failed").catch(() => {});
              await returnToClearedFollowSearch();
              continue;
            }
            onLog?.(`Follow: profile-filter check failed for @${username} (${filterErr?.message}) — proceeding`);
          }
        }

        // Inject Browsing — rolled fresh for this user. `willBrowse` decides
        // whether browsing happens at all; `browseBeforeFollow` (an
        // independent roll, only consulted when willBrowse is true) decides
        // whether it happens before or after the Follow tap. A before-follow
        // miss no longer skips browsing — it just moves it to run after the
        // follow instead.
        const { willBrowse, browseBeforeFollow } = browsing
          ? rollInjectBrowsingDecision(browsing)
          : { willBrowse: false, browseBeforeFollow: false };

        if (browsing && willBrowse && browseBeforeFollow) {
          onLog?.("Inject Browsing: rolled to browse this profile before following");
          const didScroll = await runProfileBrowsingSequence(serial, browsing, onLog, onLike).catch((e: any) => {
            if (e?.message === "cycle-aborted") throw e;
            onLog?.(`Inject Browsing: error — ${e?.message}`);
            return 0;
          });
          // Scroll EXACTLY as many rows back up as we scrolled down, so we
          // stop at the top of the grid where the Follow button is visible.
          // Doing MORE swipes than we scrolled overshoots the top and triggers
          // a pull-to-refresh (a downward finger-drag from the very top of the
          // content), which is both wrong and bot-like.  Using a start-y that
          // is safely below the top of the content area (0.55 rather than
          // 0.30) also avoids accidentally hitting the profile header zone.
          if (didScroll > 0) {
            const { w: bw, h: bh } = getScreenSize(serial);
            onLog?.(`Inject Browsing: scrolling back to top — ${didScroll} row(s)`);
            // Swipe geometry must mirror the scroll-down exactly so N scrolls
            // back up covers the same content distance as N scrolls down.
            // Scroll-down: finger 0.78→0.30 = 48% of screen height per swipe.
            // Scroll-up:   finger 0.35→0.80 = 45% of screen height per swipe.
            // (0.35 start avoids the profile header tap zone; 0.80 end matches
            //  the same lower-screen anchor as the down-swipe start.)
            // Pull-to-refresh is triggered by content position, not finger
            // start-y, so a longer swipe here does NOT risk pull-to-refresh
            // as long as we don't scroll MORE rows than we scrolled down.
            for (let _si = 0; _si < didScroll; _si++) {
              logger.info({ serial, source: "inject-follow-profile-grid-scroll-back", from: [Math.round(bw / 2), Math.round(bh * 0.35)], to: [Math.round(bw / 2), Math.round(bh * 0.80)], durationMs: 400 }, "[mobile-input] swipe");
              // Reverse the calibrated gesture, rather than sending the
              // configured forward path again. This keeps the profile grid at
              // the same top position after exactly `didScroll` rows.
              await deviceProfileSwipe(
                serial,
                { x1: Math.round(bw / 2), y1: Math.round(bh * 0.35), x2: Math.round(bw / 2), y2: Math.round(bh * 0.80), durationMs: 400 },
                "inject-follow-profile-grid-scroll-back",
                "back",
              );
              await sleepOrAbort(serial, 350);
              // A visible post-count stat means the profile header is back in
              // view, so the grid has reached the top. Do not perform the
              // remaining planned swipes; each extra swipe can refresh the
              // profile and look like repeated browsing to Instagram.
              const topStats = await android.getProfilePostCount(serial).catch(() => null);
              if (topStats !== null) {
                onLog?.(`Inject Browsing: profile header detected after ${_si + 1}/${didScroll} upward swipe(s) — stopping top recovery early`);
                break;
              }
            }
            await sleepOrAbort(serial, 500);
          }
        } else if (browsing && willBrowse && !browseBeforeFollow) {
          onLog?.("Inject Browsing: rolled to browse this profile after following");
        }

        // Abandon Follow — fires only when pre-follow browsing ran. Rolls a
        // per-user chance to skip the follow entirely so not every browsing
        // session ends identically. The user is NOT added to any skip list and
        // CAN be scraped and followed again in a future cycle or by another
        // account — the goal is purely to add variation to the follow pattern.
        if (browsing && willBrowse && browseBeforeFollow && browsing.abandonFollowPctMin > 0) {
          const abandonChance = rollRange(browsing.abandonFollowPctMin, browsing.abandonFollowPctMax) / 100;
          if (Math.random() < abandonChance) {
            onLog?.(`Follow: ↩ abandoned follow @${username} after inject-browsing (variation — user can be re-scraped)`);
            await android.pressBack(serial);
            await sleepOrAbort(serial, 500);
            const interPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
            if (interPopup) await sleepOrAbort(serial, 400);
            continue;
          }
        }

        // Dismiss any interstitial/upsell popup that appeared during navigation
        // to this profile or during pre-follow browsing (e.g. "Instagram Plus
        // — Choose custom fonts for your profile bio" with "Not now" dismiss).
        // Must run before the Follow tap so the popup isn't blocking the button.
        const preFollowPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
        if (preFollowPopup) {
          onLog?.(`Follow: dismissed popup before follow tap ("${preFollowPopup}")`);
          await sleepOrAbort(serial, 400);
        }

        // Tap Follow on the profile page. Only logs success when the button
        // is confirmed to have changed to "Following" or "Requested".
        const didFollow = await android.tapFollowButtonOnProfilePage(serial).catch(() => false);
        onLog?.(`[TRACE] follow: follow-result=${didFollow ? "confirmed" : "not-confirmed"}`);
        if (didFollow) {
          followed++;
          recordFollow?.(username, candidateSource.get(username) ?? "unknown");
          onLog?.(`Follow: ✓ followed @${username} (${followed}/${targets.length})`);
          await sleepOrAbort(serial, 1000 + Math.round(Math.random() * 1500));
        } else {
          onLog?.(`Follow: Follow button not found or state did not change on @${username} — already following?`);
        }

        // Browsing rolled to run AFTER the follow — do it now, still on the
        // same profile page, regardless of whether the follow tap itself
        // succeeded (a missed/duplicate Follow tap shouldn't also skip the
        // browsing that was already decided for this user).
        if (browsing && willBrowse && !browseBeforeFollow) {
          await runProfileBrowsingSequence(serial, browsing, onLog, onLike).catch((e: any) => {
            if (e?.message === "cycle-aborted") throw e;
            onLog?.(`Inject Browsing: error — ${e?.message}`);
          });
        }

        // Return to the search/explore results after each user. The profile
        // was opened from the search results, so exactly one Back is correct:
        // profile → search results. Do not press Back again when Home is absent;
        // that second press exits the search context and lands on the home feed.
        await android.pressBack(serial);
        await sleepOrAbort(serial, 500);
        onLog?.("Follow: returned to search results after one Back; keeping Explore/search context");
        await sleepOrAbort(serial, 800);
        // Dismiss any popup that appeared after pressing back (e.g. IG Plus
        // upsell, notification prompts) before the next operation.
        const interUserPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
        if (interUserPopup) {
          onLog?.(`Follow: dismissed popup between users ("${interUserPopup}")`);
          await sleepOrAbort(serial, 400);
        }
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Follow: error on @${username}: ${e?.message}`);
      }
    }

    // ── Save unused candidates to Surplus ────────────────────────────────────
    // Any candidate that was in the pool but never attempted (because
    // targetCount was reached first) is written to the Surplus table so the
    // NEXT cycle can consume them before calling HikerAPI again — saving
    // API quota.  Only candidates from index _fi onward were never attempted.
    if (!_usePreloaded && _fi < targets.length && (profileId && profileId > 0 || phoneSlotKey)) {
      const surplus = targets.slice(_fi);
      const now = new Date().toISOString();
      const surplusEntries = surplus.map(u => ({
        profileId: (profileId && profileId > 0) ? profileId : 0,
        phoneSlotKey: (profileId && profileId > 0) ? "" : phoneSlotKey,
        instagramUsername: u,
        instagramUserId: "",
        sourceValue: candidateSource.get(u) ?? "surplus",
        sourceType: "phone",
        scrapedAt: now,
      }));
      storage.addOverspillUsers(surplusEntries).catch(() => {});
      onLog?.(`Follow: saved ${surplusEntries.length} unused candidate${surplusEntries.length !== 1 ? "s" : ""} to Surplus for next cycle`);
    }

    if (_usePreloaded && params.keepSearchOpenAfterStep) {
      // Spread Follows invokes this step once per assigned candidate/backup.
      // Do not leave Search with the normal two-Back final cleanup between
      // segments: the next Spread Follow segment is about to reuse the same
      // Search surface. Filter-rejected candidates already use
      // returnToClearedFollowSearch(), which returns here with one Back and a
      // cleared/focused search field.
      try {
        if (searchReadyForReuse) {
          onLog?.("Spread Follow: cleanup — search already confirmed clear/focused; skipping redundant cleanup");
        } else {
          await android.clearInstagramSearchBar(serial, (msg) => onLog?.(`Spread Follow: cleanup — ${msg}`));
        }
        onLog?.("Spread Follow: cleanup — cleared search; keeping Search open for next assignment");
      } catch (e: any) {
        if (e?.message === "cycle-aborted") throw e;
        onLog?.(`Spread Follow: cleanup clear failed — ${e?.message ?? "unknown error"}`);
      }
    } else {
      await finishFollowNavigation();
    }
    return followed;
  }

  // ── Followed Users endpoint — returns in-memory follow log per device ─────
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/followed-users", (req: Request, res: Response) => {
    const serial  = req.params.serial as string;
    const slotIdx = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    const list = getMobileFollowedList(serial, slotIdx);
    res.json({ ok: true, users: list });
  });

  // ── Make a Post — dedicated folder path endpoints ─────────────────────────
  // These endpoints read/write the per-slot dedicated folder-path text file,
  // which is the authoritative source of truth for makePostLocalFolderPath.
  // Using a dedicated file means the assigned directory survives normal
  // autosave/schema races; the explicit HST Copy Settings flow may update it
  // for a selected target slot.
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/folder-path", (req: Request, res: Response) => {
    const serial  = req.params.serial as string;
    const slotIdx = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    res.json({ ok: true, path: getMakePostFolderPath(serial, slotIdx) });
  });

  app.post("/api/mobile/devices/:serial/slots/:slotIdx/folder-path", (req: Request, res: Response) => {
    const serial     = req.params.serial as string;
    const slotIdx    = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    const folderPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    // Guard: never write an empty path.  An empty string has no legitimate meaning
    // here — the only caller is the Browse button which always produces a real path.
    // Writing "" would clear BOTH the dedicated file and mobile-instances.json,
    // which is exactly the reset bug this endpoint was meant to prevent.
    if (!folderPath) { res.json({ ok: true }); return; }
    // Write to the dedicated file first — this is the authoritative store.
    setMakePostFolderPath(serial, slotIdx, folderPath);
    // Also patch mobile-instances.json so the value is available on a cold
    // start before the dedicated file takes over.
    try {
      const cfg = loadInstanceConfigs();
      const stableKey = slotAutomationKey(serial, slotIdx);
      const existing = cfg[serial]?.slotAutomation?.[stableKey] ?? cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
      cfg[serial] = {
        ...cfg[serial],
        slotAutomation: {
          ...cfg[serial]?.slotAutomation,
          [stableKey]: { ...existing, makePostLocalFolderPath: folderPath },
        },
      };
      saveInstanceConfigs(cfg);
    } catch { /* best effort — dedicated file is the real source of truth */ }
    res.json({ ok: true });
  });

  app.get("/api/mobile/devices/:serial/slots/:slotIdx/post-story-folder-path", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const slotIdx = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    res.json({ ok: true, path: getPostStoryFolderPath(serial, slotIdx) });
  });

  app.post("/api/mobile/devices/:serial/slots/:slotIdx/post-story-folder-path", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const slotIdx = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    const folderPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!folderPath) { res.json({ ok: true }); return; }
    setPostStoryFolderPath(serial, slotIdx, folderPath);
    try {
      const cfg = loadInstanceConfigs();
      const stableKey = slotAutomationKey(serial, slotIdx);
      const existing = cfg[serial]?.slotAutomation?.[stableKey] ?? cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
      cfg[serial] = {
        ...cfg[serial],
        slotAutomation: {
          ...cfg[serial]?.slotAutomation,
          [stableKey]: { ...existing, postStoryLocalFolderPath: folderPath },
        },
      };
      saveInstanceConfigs(cfg);
    } catch { /* dedicated file remains authoritative */ }
    res.json({ ok: true });
  });

  // ── Update Profile Picture folder-path endpoint ──────────────────────────────
  // POST with a non-empty path sets the dedicated file; POST with "" clears both.
  app.post("/api/mobile/devices/:serial/slots/:slotIdx/profile-pic-folder-path", (req: Request, res: Response) => {
    const serial  = req.params.serial as string;
    const slotIdx = parseInt(req.params.slotIdx, 10);
    if (isNaN(slotIdx) || slotIdx < 0) { res.status(400).json({ error: "Invalid slot index" }); return; }
    const folderPath = typeof req.body?.path === "string" ? req.body.path.trim() : "";
    if (!folderPath) {
      // Explicit clear: remove dedicated file and wipe field from mobile-instances.json.
      clearProfilePicFolderPath(serial, slotIdx);
      try {
        const cfg = loadInstanceConfigs();
        const stableKey = slotAutomationKey(serial, slotIdx);
        const existing = cfg[serial]?.slotAutomation?.[stableKey] ?? cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
        cfg[serial] = {
          ...cfg[serial],
          slotAutomation: {
            ...cfg[serial]?.slotAutomation,
            [stableKey]: { ...existing, updateProfilePicFolderPath: "" },
          },
        };
        saveInstanceConfigs(cfg);
      } catch { /* best effort */ }
      res.json({ ok: true }); return;
    }
    setProfilePicFolderPath(serial, slotIdx, folderPath);
    try {
      const cfg = loadInstanceConfigs();
      const stableKey = slotAutomationKey(serial, slotIdx);
      const existing = cfg[serial]?.slotAutomation?.[stableKey] ?? cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
      cfg[serial] = {
        ...cfg[serial],
        slotAutomation: {
          ...cfg[serial]?.slotAutomation,
          [stableKey]: { ...existing, updateProfilePicFolderPath: folderPath },
        },
      };
      saveInstanceConfigs(cfg);
    } catch { /* best effort */ }
    res.json({ ok: true });
  });

  // Posted Media — list of local-folder filenames that have already been posted
  // for this serial (the "Do not repost the same image" no-repeat tracking list).
  app.get("/api/mobile/devices/:serial/posted-media", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const slotIdxRaw = Number(req.query.slotIdx);
    const slotIdx = Number.isInteger(slotIdxRaw) && slotIdxRaw >= 0 ? slotIdxRaw : 0;
    const files = getPostedLocalFiles(serial, slotIdx);
    res.json({ ok: true, files });
  });

  // Remove one filename from the posted list so it can be reposted.
  // The filename is passed as a URL-encoded path parameter.
  app.delete("/api/mobile/devices/:serial/posted-media/:filename", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const filename = decodeURIComponent(req.params.filename as string);
    const slotIdxRaw = Number(req.query.slotIdx);
    const slotIdx = Number.isInteger(slotIdxRaw) && slotIdxRaw >= 0 ? slotIdxRaw : 0;
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    const list = getPostedLocalFiles(serial, slotIdx);
    const next = list.filter(f => f !== filename);
    mobilePostedLocalFiles.set(key, next);
    try { fs.writeFileSync(_postedFilePath(serial, slotIdx), JSON.stringify(next), "utf8"); } catch { /* best effort */ }
    res.json({ ok: true, removed: list.length - next.length });
  });

  // Confirmed profile-feed posts for one account slot. This is intentionally
  // separate from posted-media, which is the device-wide no-repeat cache and
  // includes Story uploads.
  app.get("/api/mobile/devices/:serial/posted-profile-media", (req: Request, res: Response) => {
    const serial = req.params.serial as string;
    const username = String(req.query.username ?? "").replace(/^@/, "").trim().toLowerCase();
    const slotIdxRaw = Number(req.query.slotIdx);
    const slotIdx = Number.isInteger(slotIdxRaw) && slotIdxRaw >= 0 ? slotIdxRaw : null;
    if (!username) return res.status(400).json({ ok: false, error: "username required" });

    const entries = getPostedProfileMedia(serial, slotIdx ?? 0).filter(entry =>
      entry.username.replace(/^@/, "").trim().toLowerCase() === username &&
      (slotIdx === null || entry.slotIdx === slotIdx)
    );
    const today = new Date().toISOString().slice(0, 10);
    res.json({
      ok: true,
      entries,
      count: entries.length,
      dailyCount: entries.filter(entry => entry.postedAt.slice(0, 10) === today).length,
    });
  });

  // Abort endpoint — called by the frontend when the master toggle is switched
  // off mid-cycle.  The frontend passes the same cycleId it used to start the
  // cycle so we can ignore stale abort POSTs that arrive after the next cycle
  // has already started (the race that was killing fresh cycles on toggle-off).
  app.post("/api/mobile/devices/:serial/automation-cycle/abort", (req: Request, res: Response) => {
    const serial = p(req, "serial");
    const cycleId: string | undefined = req.body?.cycleId;
    // Only set the abort flag if a real cycleId was supplied AND it matches
    // the cycle currently registered on this device.  A null/empty cycleId
    // (sent when the client toggle was turned off while no cycle was in-flight)
    // must NOT set the abort — otherwise the abort POST can arrive after a new
    // cycle has already started and kill it via the automationCycleAbortedId
    // race condition (toggle-dead-after-first-run bug).
    if (cycleId && automationCycleCurrentId.get(serial) === cycleId) {
      automationCycleAbortedId.set(serial, cycleId);
    }
    res.json({ ok: true });
  });

  app.post("/api/mobile/devices/:serial/automation-cycle", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    // The USB poll can still report a serial while ADB has transitioned it to
    // offline. Never start a Human Session Tool cycle against that stale entry.
    // The frontend keeps the saved toggle enabled and retries automatically
    // when the same serial returns as a ready device.
    try {
      const currentDevice = (await android.listDevices()).find(device => device.serial === serial);
      if (!currentDevice || currentDevice.state !== "device") {
        res.status(409).json({
          error: `Device ${serial} is not ready for automation (${currentDevice?.state ?? "not connected"})`,
        });
        return;
      }
    } catch (error) {
      logger.warn({ err: error, serial }, "Could not verify device state before automation cycle");
      res.status(503).json({ error: "Could not verify device connection before starting automation" });
      return;
    }
    if (automationCycleInProgress.has(serial) || checkFeedInProgress.has(serial)) {
      res.status(409).json({ error: "An automation cycle is already in progress on this device" });
      return;
    }
    // Register this cycle's ID so the abort endpoint can target it precisely.
    // Using the ID from the request body (sent by the frontend) means a stale
    // abort POST that arrives after this cycle started will NOT match and is
    // safely ignored.
    const incomingCycleId: string = req.body?.cycleId ?? `fallback-${Date.now()}`;
    const incomingSlotIdx: number = typeof req.body?.slotIdx === "number" ? req.body.slotIdx : 0;
    automationCycleCurrentId.set(serial, incomingCycleId);
    automationCycleAbortedId.delete(serial); // clear any abort from a previous cycle
    automationCycleInProgress.add(serial);
    automationCycleActiveSlot.set(serial, incomingSlotIdx);
    checkFeedInProgress.add(serial); // also blocks a concurrent manual Check Feed call
    const steps: string[] = [];
    // Diagnostic-only execution trace. This records the shared dispatcher
    // path without changing any Android action, timing, or tool settings.
    // It lets us compare the underlying route across devices/cycles.
    const executionTrace: string[] = [];
    let storiesWatched = 0;
    let storyLikes = 0;
    let followedCount = 0;
    let reelsViewed = 0;
    let reelsLikes = 0;
    let exploreLikes = 0;
    let injectBrowsingLikes = 0;
    let postsUploaded = 0;
    // Hoisted so the catch block can include partial stats in the COMPLETE log
    // even when the cycle is aborted or errors mid-run.
    let likes = 0, likeFailures = 0, sharesFeed = 0, sharesDm = 0, saves = 0, captionExpands = 0, strayNavRecoveries = 0, audioTaps = 0, hashtagTaps = 0, authorVisits = 0;
    let feedScrolled = 0; // number of feed posts requested to scroll this cycle
    let exploreScrolled = 0; // number of explore scrolls this cycle
    let _slotUsername = "";       // captured from schema parse for catch-block use
    let _mobileProfileId: number | null = null; // same
    const cycleMetricSummary = () => [
      `1 cycle`,
      `${likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes} likes`,
      `${followedCount} follows`,
      `${storiesWatched} stories watched`,
      `${reelsViewed} reels watched`,
      `${sharesDm} DMs`,
      `${postsUploaded} posts uploaded`,
      `${sharesFeed + sharesDm} shares`,
      `${saves} saved`,
      `${feedScrolled} posts scrolled`,
      `${exploreScrolled} Explore scrolls`,
    ].join(", ");
    // Dashboard COMPLETE rows are intentionally metrics-only. The detailed
    // tool lifecycle remains in the live device log; persisting `steps` here
    // made the Activity Log show implementation internals such as
    // power-on/unlock/launch/airplane-mode instead of what the cycle actually
    // accomplished.
    const dashboardMetricSummary = () => {
      const totalLikes = likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes;
      const parts: string[] = [];
      if (totalLikes) parts.push(`${totalLikes} likes`);
      if (followedCount) parts.push(`${followedCount} follows`);
      if (storiesWatched) parts.push(`${storiesWatched} stories watched`);
      if (reelsViewed) parts.push(`${reelsViewed} reels watched`);
      if (sharesDm) parts.push(`${sharesDm} DMs`);
      if (postsUploaded) parts.push(`${postsUploaded} posts uploaded`);
      if (sharesFeed + sharesDm) parts.push(`${sharesFeed + sharesDm} shares`);
      if (saves) parts.push(`${saves} saved`);
      if (feedScrolled) parts.push(`${feedScrolled} posts scrolled`);
      if (exploreScrolled) parts.push(`${exploreScrolled} Explore scrolls`);
      return parts.join(", ") || "No metrics recorded";
    };
    const cycleStart = Date.now();
    // tLog prefixes every log line with elapsed seconds so the user can see
    // exactly where each chunk of time is going in the Log tab.
    const tLog = (msg: string) => {
      const totalSec = (Date.now() - cycleStart) / 1000;
      const mins = Math.floor(totalSec / 60);
      const secs = (totalSec % 60).toFixed(1);
      const elapsed = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
      const fullLine = `[${elapsed}] ${msg}`;
      sendVideoLog(serial, fullLine);
      // Push into the rolling buffer BEFORE capturing so the composite always
      // includes the current line in the log panel on the right.
      pushDebugLogLine(serial, fullLine);
      // One frame per elapsed timestamp. Detail/status lines emitted during
      // the same timestamp remain in the rolling log panel but do not start
      // additional ADB/Sharp screenshot work.
      queueDebugScreenshot(serial, elapsed, fullLine);
    };
    try {
      const parsedCycle = automationCycleSchema.parse(req.body);
      // Re-resolve the assigned TrustScore at execution time. The browser
      // normally sends the same effective values it displayed, but the server
      // must remain authoritative when a template was edited in another tab
      // or the request came from the background runner.
      const savedSlotSettings =
        loadInstanceConfigs()[serial]?.slotAutomation?.[String(incomingSlotIdx)] ?? {};
      const effectiveCycle = await resolveTrustScoreSettings(serial, incomingSlotIdx, {
        ...savedSlotSettings,
        ...parsedCycle,
      });
      const effectiveSettings: any = effectiveCycle.settings;
      const {
        count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
        airplaneWaitMinSec, airplaneWaitMaxSec,
        feedEnabled, storiesEnabled,
        shareFeedPercentMin, shareFeedPercentMax,
        shareDmPercentMin, shareDmPercentMax,
        savePercentMin, savePercentMax,
        expandCaptionPercentMin, expandCaptionPercentMax,
        tapAudioPercentMin, tapAudioPercentMax,
        clickHashtagPercentMin, clickHashtagPercentMax,
        clickAuthorPercentMin, clickAuthorPercentMax,
        feedRerunChanceMin, feedRerunChanceMax,
        viewStoriesSlidesMin, viewStoriesSlidesMax,
        viewStoriesSlideWatchPctMin, viewStoriesSlideWatchPctMax,
        viewStoriesLikePercentMin, viewStoriesLikePercentMax,
        viewStoriesShareDmPercentMin, viewStoriesShareDmPercentMax,
        viewStoriesCommentPercentMin, viewStoriesCommentPercentMax,
        viewStoriesClickAuthorPercentMin, viewStoriesClickAuthorPercentMax,
        viewReelsEnabled, viewReelsScrollMin, viewReelsScrollMax,
        viewReelsWatchPctMin, viewReelsWatchPctMax,
        viewReelsLikePercentMin, viewReelsLikePercentMax,
        viewReelsShareFeedPercentMin, viewReelsShareFeedPercentMax,
        viewReelsShareDmPercentMin, viewReelsShareDmPercentMax,
        viewReelsSavePercentMin, viewReelsSavePercentMax,
        viewReelsClickAuthorPercentMin, viewReelsClickAuthorPercentMax,
        viewReelsActivatePctMin, viewReelsActivatePctMax,
        viewExploreEnabled, viewExploreActivatePctMin, viewExploreActivatePctMax,
        viewExploreScrollMin, viewExploreScrollMax,
        viewExploreActionDelayMin, viewExploreActionDelayMax,
        viewExploreClickPostPctMin, viewExploreClickPostPctMax,
        viewExploreLikePercentMin, viewExploreLikePercentMax,
        viewExploreShareFeedPercentMin, viewExploreShareFeedPercentMax,
        viewExploreShareDmPercentMin, viewExploreShareDmPercentMax,
        viewExploreSavePercentMin, viewExploreSavePercentMax,
        viewExploreClickAuthorPercentMin, viewExploreClickAuthorPercentMax,
        checkDmEnabled, checkDmActivatePctMin, checkDmActivatePctMax,
        checkDmScrollMin, checkDmScrollMax, checkDmClickPctMin, checkDmClickPctMax,
        followEnabled, followUsersMin, followUsersMax, followSpreadFollows, followSources,
        followFiltersEnabled, followFilterVerifiedUsers, followFilterMaxFollowers25k,
        followFilterPrivateUsers, followFilterEnglishSpeaking, followFilterMinFollowers50,
        followFilterMalesOnly, followFilterMaleNames,
         preSwitchEnabledMin, preSwitchEnabledMax,
         preSwitchActionPercentMin, preSwitchActionPercentMax,
        injectBrowsingEnabled,
        injectBrowsingActivatePctMin, injectBrowsingActivatePctMax,
        injectBrowsingBeforeFollowPctMin, injectBrowsingBeforeFollowPctMax,
        injectBrowsingFeedMin, injectBrowsingFeedMax,
        injectBrowsingClickPostPctMin, injectBrowsingClickPostPctMax,
        injectBrowsingLikePctMin, injectBrowsingLikePctMax,
        injectBrowsingShareFeedPctMin, injectBrowsingShareFeedPctMax,
        injectBrowsingShareDmPctMin, injectBrowsingShareDmPctMax,
        injectBrowsingSavePostPctMin, injectBrowsingSavePostPctMax,
        injectBrowsingAbandonFollowPctMin, injectBrowsingAbandonFollowPctMax,
        injectBrowsingTapHighlightsPctMin, injectBrowsingTapHighlightsPctMax,
        randomJitterEnabled,
        checkNotificationsPctMin, checkNotificationsPctMax,
        checkNotificationsScrollsMin, checkNotificationsScrollsMax,
        checkNotificationsClickPctMin, checkNotificationsClickPctMax,
        visitProfilePctMin, visitProfilePctMax,
        visitSavedPctMin, visitSavedPctMax,
        visitSettingsPctMin, visitSettingsPctMax,
        appSwitchPctMin, appSwitchPctMax,
        updateProfilePicActivatePctMin, updateProfilePicActivatePctMax,
        updateProfilePicAlterationEnabled, updateProfilePicAlterationLevel,
        updateProfilePicImageSettingsEnabled, updateProfilePicImageSettings,
        updateProfilePicFixAiSlop, updateProfilePicMetadataCleanup, updateProfilePicFrequencyDisruption,
        updateProfilePicFolderPath: _updateProfilePicFolderPath,
        updateProfilePicDisableAfterUsed,
        updateBioActivatePctMin, updateBioActivatePctMax,
        updateBioText,
        updateBioDisableAfterUsed,
        feedActivatePctMin, feedActivatePctMax,
        viewStoriesActivatePctMin, viewStoriesActivatePctMax,
        followActivatePctMin, followActivatePctMax,
        randomJitterActivatePctMin, randomJitterActivatePctMax,
        makePostEnabled, makePostActivatePctMin, makePostActivatePctMax,
        makePostPerSessionMin, makePostPerSessionMax,
        makePostLocalFolderEnabled, makePostLocalFolderPath,
        makePostLocalFolderNoRepeat, makePostLocalFolderRandom, makePostAddLocation,
        makePostAlterationEnabled, makePostAlterationLevel, makePostImageSettingsEnabled,
        makePostImageSettings, makePostFixAiSlop, makePostMetadataCleanup, makePostFrequencyDisruption, makePostCaptionText,
        postStoryEnabled, postStoryActivatePctMin, postStoryActivatePctMax,
        postStoryLocalFolderPath, postStoryLocalFolderNoRepeat, postStoryLocalFolderRandom,
        postStoryAlterationEnabled, postStoryAlterationLevel, postStoryImageSettingsEnabled,
        postStoryImageSettings, postStoryFixAiSlop,
        slotUsername, slotIdx,
        shuffleToolOrder,
        dismissDirection,
      } = effectiveSettings;

      // The account assignment is owned by the device's slot configuration.
      // Do not let a stale background-runner payload erase the identity used
      // for Dashboard activity and username-keyed mobile statistics.
      const assignedSlotUsername =
        loadInstanceConfigs()[serial]?.account?.slots?.[slotIdx]?.username?.trim() ?? "";
      const resolvedSlotUsername = assignedSlotUsername || slotUsername?.trim() || "";

      // ── Global followed / skipped settings ─────────────────────────────────
      // Read the shared global settings store (Settings → Scraping).  These
      // are the same flags the browser-bot engine reads — wiring them here
      // gives phone automation a single, shared "already followed" / "skip
      // list" that spans all devices and all browser-bot accounts.
      const globalCycleSettings = await storage.getGlobalSettings();
      const globalSkipFollowed          = globalCycleSettings.skipFollowedUsers       === "true";
      const globalSkipSkipped           = globalCycleSettings.skipAlreadySkippedUsers === "true";
      const globalFollowMaxScrapeSessions = parseInt(globalCycleSettings.followMaxScrapeSessions ?? "0", 10);

      // ── Resolve profileId for Dashboard logging ─────────────────────────────
      // Map slotUsername → profile row so cycle start/complete events appear
      // in the main Dashboard activity feed alongside EB account actions.
      let mobileProfileId: number | null = null;
      if (resolvedSlotUsername) {
        const allProfiles = await storage.getProfiles();
        const normalized = resolvedSlotUsername.toLowerCase();
        const match = allProfiles.find(p =>
          p.username.trim().toLowerCase() === normalized ||
          p.accountLabel?.trim().toLowerCase() === normalized
        );
        if (match) mobileProfileId = match.id;
      }
      // Capture for catch-block COMPLETE log (in scope there).
      _slotUsername = resolvedSlotUsername;
      _mobileProfileId = mobileProfileId;
      // Log cycle start to Dashboard.
      // profileId 0 is the system sentinel (same as "Aura Farming started")
      // so events always appear even when slotUsername has no matching EB
      // profile.  slotUsername goes into targetUsername so the ACCOUNT column
      // shows which Instagram account ran the cycle even without a profile link.
      storage.createSessionAction({
        profileId: mobileProfileId ?? 0,
        toolId: 0,
        action: "tool_start",
        targetUsername: resolvedSlotUsername,
        detail: "Cycle Started, Farming Aura",
        result: "ok",
        sourceValue: `${serial}:${slotIdx}`,
        sourceType: "phone",
        timestamp: new Date().toISOString(),
      }).catch(() => {});

      // Clear debug screenshots from the previous account's cycle so the new
      // account starts fresh with its own 50-frame sequence.
      await fsPromises.rm(
        path.join(SCREENSHOTS_DIR, getDeviceLabel(serial)),
        { recursive: true, force: true },
      ).catch(() => {});
      debugScreenshotTimestamps.delete(serial);

      // 1. Power on the phone.
      tLog("▶ Waking screen…");
      await android.wakeScreen(serial);
      steps.push("power-on");
      await sleepOrAbort(serial, 1200); // let the screen finish waking

      // 1b. Swipe up from the bottom to dismiss the lock screen.  On MIUI
      // (Xiaomi) and similar OEM skins, `am start` alone does NOT clear the
      // keyguard — the app launches behind the lock screen and all subsequent
      // taps land on the keyguard instead of Instagram.  A real swipe gesture
      // also resets the screen-off timeout so the display stays on while the
      // cycle runs (KEYCODE_WAKEUP alone does not count as touch input).
      tLog("▶ Unlocking screen…");
      await android.swipeUpFromBottom(serial);
      steps.push("unlock-swipe");
      await sleepOrAbort(serial, 800); // let the keyguard animation complete
      tLog("  ✓ Screen unlocked");

      // 2. Open Instagram.
      tLog("▶ Opening Instagram…");
      await android.launchInstagram(serial);
      steps.push("launch-instagram");
      // Reduced from 1200 → 400 ms: the UIAutomator dump below (~5-15 s) waits
      // for UI idle itself, so a long fixed sleep before it is redundant.
      // 400 ms is enough for the IG process to appear before the dump starts.
      await sleepOrAbort(serial, 400);

      // 2b–2c. SINGLE shared UIAutomator dump covers: ads-choice dialog check,
      // interstitials check, AND the account-switcher pre-check + profile-tab
      // lookup.  Previously these were 4 sequential dumps × 5-15 s each = up
      // to 60 s overhead.  One shared dump collapses them to ~1 dump.
      // If any dialog IS dismissed the screen changes — we pass `undefined` so
      // the next check does its own fresh dump instead of using stale XML.
      tLog("▶ UIAutomator: scanning for ads-choice dialog…");
      const launchXml = await android.getUiDump(serial).catch(() => "");
      const adsChoice = await android.dismissAdsChoiceDialog(serial, launchXml).catch(() => ({ dismissed: false, steps: [] as string[] }));
      if (adsChoice.dismissed) {
        steps.push(`ads-choice-dialog(${adsChoice.steps.length} steps)`);
        tLog(`▶ Dismissed ads-choice dialog (${adsChoice.steps.length} taps)`);
        await sleepOrAbort(serial, 1000);
      } else {
        tLog("▶ No ads-choice dialog — continuing");
      }

      // 2c. Dismiss any other interstitial (notifications, save-login, etc.)
      // Reuse launchXml when no ads-choice was dismissed (screen unchanged).
      tLog("▶ UIAutomator: scanning for other launch popups…");
      const interstitialsXml = adsChoice.dismissed ? undefined : launchXml;
      const launchPopup = await android.dismissInstagramInterstitials(serial, interstitialsXml).catch(() => null);
      if (launchPopup) {
        steps.push(`launch-popup-dismissed(${launchPopup})`);
        tLog(`▶ Dismissed launch popup (${launchPopup})`);
        await sleepOrAbort(serial, 600);
      } else {
        tLog("▶ No launch popup — feed ready");
      }
      const launchRestrictionDismissed = await android.dismissInstagramAccountRestriction(serial, tLog).catch(() => false);
      if (launchRestrictionDismissed) {
        steps.push("account-restriction-dismissed");
        await sleepOrAbort(serial, 700);
      } else {
        const restrictionCheck = await android.getUiDump(serial).catch(() => "");
        const restrictionLower = restrictionCheck.toLowerCase();
        if (restrictionLower.includes("what happened") &&
            (restrictionLower.includes("restriction") || restrictionLower.includes("can't share links"))) {
          tLog("✗ Account restriction screen remains open and could not be safely dismissed — pausing cycle");
          steps.push("account-restriction-unresolved");
          throw new Error("Instagram account restriction screen could not be dismissed safely");
        }
      }
      // Instagram can expose the feed in the accessibility tree before the
      // first feed render has finished. Give the launch screen a few seconds
      // to settle before account switching or any tool taps begin.
      tLog("▶ Dwell: allowing Instagram feed to finish rendering…");
      await sleepOrAbort(serial, 3000);
      tLog("  ✓ Instagram open");

      const preSwitchLastUsername = automationLastActiveUsername.get(serial) || "";
      const preSwitchRoll = (() => {
        const lo = Math.min(preSwitchEnabledMin, preSwitchEnabledMax);
        const hi = Math.max(preSwitchEnabledMin, preSwitchEnabledMax);
        return (lo === hi ? lo : Math.round(lo + Math.random() * (hi - lo))) / 100;
      })();
      const preSwitchToolPercent = (() => {
        const lo = Math.min(preSwitchActionPercentMin, preSwitchActionPercentMax);
        const hi = Math.max(preSwitchActionPercentMin, preSwitchActionPercentMax);
        return (lo === hi ? lo : Math.round(lo + Math.random() * (hi - lo))) / 100;
      })();
      let preSwitchActionsRan = false;
      if (preSwitchEnabledMin <= 0 && preSwitchEnabledMax <= 0) {
        tLog("▶ Pre-switch activation disabled at 0% — skipping all pre-switch actions");
      } else if (preSwitchActionPercentMin <= 0 && preSwitchActionPercentMax <= 0) {
        tLog("▶ Pre-switch action percentage is 0% — skipping all pre-switch actions");
      }
      // These values must exist before pre-switch dispatch. Previously they
      // were declared below this branch, causing a TDZ failure whenever
      // pre-switch ran: "Cannot access '_toolActivated' before initialization".
      const _toolActivated: Record<string, boolean> = {
        feed: feedEnabled && rollActivate(feedActivatePctMin, feedActivatePctMax),
        stories: storiesEnabled && viewStoriesSlidesMax > 0 && rollActivate(viewStoriesActivatePctMin ?? 100, viewStoriesActivatePctMax ?? 100),
        explore: (viewExploreEnabled ?? false) && (viewExploreScrollMax ?? 0) > 0 && rollActivate(viewExploreActivatePctMin ?? 100, viewExploreActivatePctMax ?? 100),
        reels: (viewReelsEnabled ?? false) && (viewReelsScrollMax ?? 0) > 0 && rollActivate(viewReelsActivatePctMin ?? 100, viewReelsActivatePctMax ?? 100),
        checkDm: (checkDmEnabled ?? false) && rollActivate(checkDmActivatePctMin ?? 100, checkDmActivatePctMax ?? 100),
        follow: followEnabled && rollActivate(followActivatePctMin, followActivatePctMax),
        post: makePostEnabled && rollActivate(makePostActivatePctMin, makePostActivatePctMax),
        postStory: postStoryEnabled && rollActivate(postStoryActivatePctMin, postStoryActivatePctMax),
        "Random Actions": randomJitterEnabled && rollActivate(randomJitterActivatePctMin, randomJitterActivatePctMax),
      };
      const _toolOrderLabels: Record<string, string> = {
        feed: "VIEW FEED", stories: "VIEW STORIES", explore: "VIEW EXPLORE",
        reels: "VIEW REELS", checkDm: "CHECK INBOX", follow: "FOLLOW USERS",
        post: "MAKE A POST", postStory: "POST A STORY", "Random Actions": "RANDOM ACTIONS",
      };
      const _toolSeq = ["feed", "stories", "explore", "reels", "checkDm", "follow", "post", "postStory", "Random Actions"]
        .filter(t => _toolActivated[t]);
      if (shuffleToolOrder) {
        for (let _si = _toolSeq.length - 1; _si > 0; _si--) {
          const _sj = Math.floor(Math.random() * (_si + 1));
          [_toolSeq[_si], _toolSeq[_sj]] = [_toolSeq[_sj], _toolSeq[_si]];
        }
        tLog(`▶ Tool order shuffled: ${_toolSeq.length ? _toolSeq.map(name => _toolOrderLabels[name] ?? name).join(" → ") : "(no tools active this execution)"}`);
      }
      if (
        preSwitchLastUsername &&
        preSwitchLastUsername !== resolvedSlotUsername &&
        preSwitchRoll > 0 &&
        preSwitchToolPercent > 0 &&
        Math.random() < preSwitchRoll
      ) {
        automationPreSwitchInProgress.set(serial, true);
        try {
          tLog(`▶ Pre-switch actions on @${preSwitchLastUsername} before switching to @${resolvedSlotUsername || preSwitchLastUsername}…`);
          const preSwitchStatsStart = {
            likes,
            storyLikes,
            exploreLikes,
            reelsLikes,
            injectBrowsingLikes,
            followedCount,
            storiesWatched,
            reelsViewed,
            sharesDm,
            sharesFeed,
            saves,
            postsUploaded,
            feedScrolled,
            exploreScrolled,
          };
          const preSwitchToolSeq = _toolSeq.filter(tool => tool !== "follow" && !String(tool).startsWith("follow_spread:"));
          // Pre-switch percentage is a quota for the combined pre-switch
          // workload, not merely a multiplier for counts inside every tool.
          // The old behavior ran every activated tool and only reduced its
          // inner count; Math.max(1, ...) then made low percentages run at
          // least one action per tool, so the configured percentage was
          // routinely exceeded.
          const preSwitchToolCount = Math.min(
            preSwitchToolSeq.length,
            Math.max(0, Math.round(preSwitchToolSeq.length * preSwitchToolPercent)),
          );
          const preSwitchSelectedTools = (() => {
            if (preSwitchToolCount >= preSwitchToolSeq.length) return preSwitchToolSeq;
            if (preSwitchToolCount <= 0) return [] as string[];
            const ranked = preSwitchToolSeq
              .map((tool, index) => ({ tool, index, random: Math.random() }))
              .sort((a, b) => a.random - b.random)
              .slice(0, preSwitchToolCount)
              .sort((a, b) => a.index - b.index);
            return ranked.map(({ tool }) => tool);
          })();
          tLog(
            `▶ Pre-switch quota: ${Math.round(preSwitchToolPercent * 100)}% — ` +
            `${preSwitchSelectedTools.length}/${preSwitchToolSeq.length} tools selected` +
            (preSwitchSelectedTools.length ? ` (${preSwitchSelectedTools.map(tool => _toolOrderLabels[tool] ?? tool).join(" → ")})` : ""),
          );
          preSwitchActionsRan = preSwitchSelectedTools.length > 0;
          for (const preTool of preSwitchSelectedTools) {
            if (isCycleAborted(serial)) break;
            if (preTool === "follow" || String(preTool).startsWith("follow_spread:")) continue;
            if (!_toolActivated[preTool]) continue;
            automationCurrentTool.set(serial, preTool === "Random Actions" ? "Random Actions" : ({
              feed: "View Feed",
              stories: "Stories",
              explore: "Explore",
              reels: "Reel Viewer",
              checkDm: "Check Inbox",
              post: "Make a Post",
              postStory: "Post a Story",
              "Random Actions": "Random Actions",
            } as Record<string, string>)[preTool] ?? preTool);
            tLog(`▶ Pre-switch dispatch: ${_toolOrderLabels[preTool] ?? preTool}`);
            const scaled = (n: number) => Math.max(0, Math.floor(n * preSwitchToolPercent));
            if (preTool === "feed") {
              await runCheckFeedLoop(serial, {
                count: scaled(Math.max(feedScrollMin, 1)),
                // Instagram was launched, popup-checked, and given its
                // post-launch settle window immediately above. Pre-switch
                // actions run on that already-established feed surface; do
                // not perform a second strict Home-icon accessibility lookup
                // here. Xiaomi/Instagram builds can visibly render the nav
                // bar while exposing icon geometry that the fallback rejects.
                homeAlreadyEstablished: true,
                likesMin: likePercentMin,
                likesMax: likePercentMax,
                shareFeedPercentMin,
                shareFeedPercentMax,
                shareDmPercentMin,
                shareDmPercentMax,
                savePercentMin,
                savePercentMax,
                expandCaptionPercentMin,
                expandCaptionPercentMax,
                tapAudioPercentMin,
                tapAudioPercentMax,
                clickHashtagPercentMin,
                clickHashtagPercentMax,
                clickAuthorPercentMin,
                clickAuthorPercentMax,
                rerunChanceMin: 0,
                rerunChanceMax: 0,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch View Feed skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "stories") {
              await runViewStoriesFromFeedLoop(serial, {
                slidesMin: scaled(viewStoriesSlidesMin),
                slidesMax: scaled(viewStoriesSlidesMax),
                slideWatchPctMin: viewStoriesSlideWatchPctMin,
                slideWatchPctMax: viewStoriesSlideWatchPctMax,
                likePercentMin: viewStoriesLikePercentMin,
                likePercentMax: viewStoriesLikePercentMax,
                shareDmPercentMin: viewStoriesShareDmPercentMin,
                shareDmPercentMax: viewStoriesShareDmPercentMax,
                commentPercentMin: viewStoriesCommentPercentMin,
                commentPercentMax: viewStoriesCommentPercentMax,
                clickAuthorPercentMin: viewStoriesClickAuthorPercentMin,
                clickAuthorPercentMax: viewStoriesClickAuthorPercentMax,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch Stories skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "reels") {
              await runViewReelsLoop(serial, {
                scrollMin: scaled(viewReelsScrollMin),
                scrollMax: scaled(viewReelsScrollMax),
                watchPctMin: viewReelsWatchPctMin,
                watchPctMax: viewReelsWatchPctMax,
                likePercentMin: viewReelsLikePercentMin,
                likePercentMax: viewReelsLikePercentMax,
                shareFeedPercentMin: viewReelsShareFeedPercentMin,
                shareFeedPercentMax: viewReelsShareFeedPercentMax,
                shareDmPercentMin: viewReelsShareDmPercentMin,
                shareDmPercentMax: viewReelsShareDmPercentMax,
                savePercentMin: viewReelsSavePercentMin,
                savePercentMax: viewReelsSavePercentMax,
                clickAuthorPercentMin: viewReelsClickAuthorPercentMin,
                clickAuthorPercentMax: viewReelsClickAuthorPercentMax,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch View Reels skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "checkDm") {
              await runCheckDmLoop(serial, {
                scrollsMin: scaled(checkDmScrollMin),
                scrollsMax: scaled(checkDmScrollMax),
                clickPctMin: checkDmClickPctMin,
                clickPctMax: checkDmClickPctMax,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch Check Inbox skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "post") {
              await runMakePostStep(serial, {
                addLocation: makePostAddLocation,
                alterationEnabled: makePostAlterationEnabled,
                alterationLevel: makePostAlterationLevel,
                imageSettingsEnabled: makePostImageSettingsEnabled,
                imageSettings: makePostImageSettings,
                fixAiSlop: makePostFixAiSlop,
                metadataCleanup: makePostMetadataCleanup,
                frequencyDisruption: makePostFrequencyDisruption,
                captionText: makePostCaptionText,
                localFolderEnabled: makePostLocalFolderEnabled,
                localFolderPath: makePostLocalFolderPath,
                localFolderNoRepeat: makePostLocalFolderNoRepeat,
                localFolderRandom: makePostLocalFolderRandom,
                localFolderDeleteAfterUpload: false,
                useChatGpt: false,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch Make a Post skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "postStory") {
              await runMakePostStoryStep(serial, {
                localFolderPath: postStoryLocalFolderPath,
                localFolderNoRepeat: postStoryLocalFolderNoRepeat,
                localFolderRandom: postStoryLocalFolderRandom,
                alterationEnabled: postStoryAlterationEnabled,
                alterationLevel: postStoryAlterationLevel,
                imageSettingsEnabled: postStoryImageSettingsEnabled,
                imageSettings: postStoryImageSettings,
                fixAiSlop: postStoryFixAiSlop,
                addLink: postStoryAddLink,
                linkUrl: postStoryLinkUrl,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch Post a Story skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "Random Actions") {
              await runRandomActionsStep(serial, (msg) => tLog(`  ${msg}`), {
                checkNotificationsPctMin,
                checkNotificationsPctMax,
                checkNotificationsScrollsMin,
                checkNotificationsScrollsMax,
                checkNotificationsClickPctMin,
                checkNotificationsClickPctMax,
                visitProfilePctMin,
                visitProfilePctMax,
                visitSavedPctMin,
                visitSavedPctMax,
                visitSettingsPctMin,
                visitSettingsPctMax,
                appSwitchPctMin,
                appSwitchPctMax,
                updateProfilePicEnabled: updateProfilePicActivatePctMax > 0,
                updateProfilePicFolderPath: _updateProfilePicFolderPath,
                updateProfilePicAlterationEnabled,
                updateProfilePicAlterationLevel,
                updateProfilePicImageSettingsEnabled,
                updateProfilePicImageSettings,
                updateProfilePicFixAiSlop,
                updateProfilePicMetadataCleanup,
                updateProfilePicFrequencyDisruption,
                updateProfilePicDisableAfterUsed,
                updateBioActivatePctMin,
                updateBioActivatePctMax,
                updateBioText,
                updateBioDisableAfterUsed,
                slotIdx,
              });
            }
          }
          const preSwitchStatsDelta = {
            likes: (likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes) - (preSwitchStatsStart.likes + preSwitchStatsStart.storyLikes + preSwitchStatsStart.exploreLikes + preSwitchStatsStart.reelsLikes + preSwitchStatsStart.injectBrowsingLikes),
            follows: followedCount - preSwitchStatsStart.followedCount,
            stories: storiesWatched - preSwitchStatsStart.storiesWatched,
            reels: reelsViewed - preSwitchStatsStart.reelsViewed,
            dms: sharesDm - preSwitchStatsStart.sharesDm,
            feedShares: (sharesFeed + sharesDm) - (preSwitchStatsStart.sharesFeed + preSwitchStatsStart.sharesDm),
            saves: saves - preSwitchStatsStart.saves,
            postsUploaded: postsUploaded - preSwitchStatsStart.postsUploaded,
            feedScrolled: feedScrolled - preSwitchStatsStart.feedScrolled,
            exploreScrolled: exploreScrolled - preSwitchStatsStart.exploreScrolled,
          };
          if (preSwitchLastUsername) {
            storage.incrementMobileStats(preSwitchLastUsername, {
              likes: Math.max(0, preSwitchStatsDelta.likes),
              follows: Math.max(0, preSwitchStatsDelta.follows),
              stories: Math.max(0, preSwitchStatsDelta.stories),
              reels: Math.max(0, preSwitchStatsDelta.reels),
              dms: Math.max(0, preSwitchStatsDelta.dms),
              feedShares: Math.max(0, preSwitchStatsDelta.feedShares),
              saves: Math.max(0, preSwitchStatsDelta.saves),
              cycles: 0,
              feedScrolls: Math.max(0, preSwitchStatsDelta.feedScrolled),
              exploreScrolls: Math.max(0, preSwitchStatsDelta.exploreScrolled),
            }).catch(() => {});
          }
        } finally {
          automationPreSwitchInProgress.delete(serial);
        }
      }

      // ═════════════════════════════════════════════════════════════════════
      // ACCOUNT SWITCH
      // Functions: android.switchToInstagramAccount() [in androidManager.ts]
      // When:      runs before every tool dispatch, once per automation-cycle
      //            slot execution — switches to the account assigned to this
      //            slot so the correct account is always active before tools run.
      // Isolation: this block owns account verification and switching only.
      //            No tool logic (feed, follow, stories, etc.) belongs here.
      //            The underlying implementation lives entirely in
      //            androidManager.ts → switchToInstagramAccount().
      // ═════════════════════════════════════════════════════════════════════

      // Pre-switch tools can leave Instagram on Stories, Reels, Inbox, or
      // another nested surface. The launch-time profile navigation happened
      // before those tools ran, so it cannot be reused as the account-switch
      // entry point. Explicitly tap the live Profile tab again before starting
      // the account-switch routine.
      if (preSwitchActionsRan) {
        const postPreSwitchProfileTab = await android.findInstagramProfileTab(serial).catch(() => null);
        if (postPreSwitchProfileTab) {
          tLog(
            `▶ Pre-switch complete: tapping Profile tab again at ` +
            `(${postPreSwitchProfileTab.x}, ${postPreSwitchProfileTab.y}) before account switch…`,
          );
          await android.tap(serial, postPreSwitchProfileTab.x, postPreSwitchProfileTab.y);
          await sleepOrAbort(serial, 800);
        } else {
          tLog("⚠ Pre-switch complete: Profile tab was not found for the required return tap; account switch will perform its own lookup");
        }
      }

      // 2d. Switch to the correct Instagram account for this slot.
      // Each slot stores the username of the Instagram account it represents.
      // Before any tools run we open Instagram's built-in account switcher
      // (long-press the profile tab → pick the matching username) so the
      // correct account is active regardless of which one was last open.
      // This is a no-op when slotUsername is empty (device-level cycle or
      // slot with no username entered yet).
      //
      // Pass launchXml only when neither ads-choice nor a popup was dismissed
      // (screen unchanged) so the switcher can reuse the dump for its pre-check
      // and profile-tab lookup without doing two more sequential dumps.
      const switchPreloadXml = (!adsChoice.dismissed && !launchPopup) ? launchXml : undefined;
      tLog("[TRACE] step-1 account-switch: begin");
      if (resolvedSlotUsername) {
         automationCurrentTool.set(serial, "ACCOUNT SWITCHING");
          tLog(`[TRACE] step-1 account-switch: target=@${resolvedSlotUsername}`);
         tLog(`▶ Switching to Instagram account: @${resolvedSlotUsername}…`);
         const switched = await android.switchToInstagramAccount(
           serial,
           resolvedSlotUsername,
           tLog,
           switchPreloadXml,
           loadInstanceConfigs()[serial]?.devicePrefs?.swipeGesture,
         );
         if (switched) {
            tLog("[TRACE] step-1 account-switch: confirmed");
           steps.push(`account-switch(@${resolvedSlotUsername})`);
           automationLastActiveUsername.set(serial, resolvedSlotUsername);
           // Brief extra settle after switching — Instagram reloads the new
           // account's home feed, and ads-choice / interstitial dialogs can
           // reappear for accounts that haven't accepted them yet.
           await sleepOrAbort(serial, 1500);
           const postSwitchPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
           if (postSwitchPopup) {
             tLog(`▶ Dismissed post-switch popup (${postSwitchPopup})`);
             await sleepOrAbort(serial, 500);
          }
         } else {
            tLog("[TRACE] step-1 account-switch: failed");
           tLog(`✗ Account switch to @${resolvedSlotUsername} failed — continuing with tools`);
           steps.push("account-switch(attempted — continuing)");
        }
      } else {
        tLog("[TRACE] step-1 account-switch: skipped-no-slot-username");
      }

      automationLastActiveUsername.set(serial, resolvedSlotUsername || automationLastActiveUsername.get(serial) || "");

      // ── Step 2: Shuffleable tool dispatcher ──────────────────────────────
      // When shuffleToolOrder is on the six tools are Fisher-Yates shuffled
      // into a random order before each cycle. When off they run in the
      // default sequence: Feed → Stories → Reels → Follow → Post → Jitter.
      //
      // Exit safety guarantee:
      //   • Stories: runViewStoriesFromFeedLoop already swipe-exits the
      //     viewer internally (ad-deviation recovery + swipe-down). The
      //     caller receives control only after the phone is back on the feed.
      //   • Reels: after runViewReelsLoop returns we press Back up to 3
      //     times polling findHomeTab, so the full-screen viewer is confirmed
      //     closed before the next tool starts.
      //   • All other tools self-navigate to their own starting position
      //     (Search tab, Home tab, compose "+") so they work from any screen.
      // (likes, sharesFeed, etc. already hoisted before try — no re-declaration needed)

      const trace = (msg: string) => {
        const totalSec = ((Date.now() - cycleStart) / 1000).toFixed(1);
        const entry = `${totalSec}s ${msg}`;
        executionTrace.push(entry);
        tLog(`[TRACE] ${entry}`);
      };

      // ── Spread Follows mode ───────────────────────────────────────────────
      // When enabled and follow is activated with targetCount ≥ 2, pre-fetches
      // all candidates upfront via HikerAPI/surplus then rebuilds the tool
      // sequence so one follow fires between each non-follow tool instead of
      // doing all follows back-to-back at the end.
      let _spreadCandidateSource: Map<string, string> | undefined;
      let _spreadCandidateMeta: Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }> | undefined;
      // Backup queue: extra pre-fetched candidates kept for filter-retry and
      // HikerAPI re-scrape fallback.  Flushed to Surplus after the tool loop.
      let _sfBackupQueue: string[] = [];
      // Surplus rows stay in the table until their candidate is actually
      // handed to the Follow tool. This prevents a pre-fetched but never
      // reached candidate from being lost.
      const _sfSurplusIds = new Map<string, number>();
      let _sfHikerToken: string = "";
      let _sfSpreadProfileId: number | undefined;
      let _sfSpreadSlotKey: string = "";

      if (followSpreadFollows && _toolActivated['follow']) {
        const _slo = Math.min(followUsersMin, followUsersMax);
        const _shi = Math.max(followUsersMin, followUsersMax);
        const _spreadTarget = _slo === _shi ? _slo : Math.round(_slo + Math.random() * (_shi - _slo));
        if (_spreadTarget >= 2) {
          tLog(`▶ Spread Follows: pre-fetching ${_spreadTarget} candidates…`);
          try {
            const _sfGlobal = await storage.getGlobalSettings();
            const _sfToken: string = _sfGlobal?.hikerApiToken ?? "";
            if (!_sfToken) {
              tLog("▶ Spread Follows: HikerAPI token not configured — falling back to normal follow");
            } else if (!followSources.length) {
              tLog("▶ Spread Follows: no follow sources configured — falling back to normal follow");
            } else {
              // Build skip sets (same as normal follow dispatcher)
              const _sfSkipFollowed = await (async () => {
                if (!globalSkipFollowed) return undefined;
                const local = new Set(getMobileFollowedList(serial).map(e => e.username.toLowerCase()));
                const globalSet = await storage.getAllFollowedUsernames();
                for (const u of globalSet) local.add(u);
                return local;
              })();
              const _sfSkipSkipped = await (async () => {
                if (!globalSkipSkipped) return undefined;
                const rows = await storage.getSkippedUsers(100_000);
                return new Set(rows.map(s => s.instagramUsername.toLowerCase()));
              })();
              const _sfFilters = followFiltersEnabled
                ? { skipVerified: followFilterVerifiedUsers, maxFollowers: followFilterMaxFollowers25k ? 25_000 : undefined,
                    skipPrivate: followFilterPrivateUsers, minFollowers: followFilterMinFollowers50 ? 50 : undefined,
                    requireEnglish: followFilterEnglishSpeaking,
                    malesOnly: followFilterMalesOnly, maleNames: followFilterMaleNames }
                : undefined;

              const _sfHiker = new HikerApiClient(_sfToken);
              const _sfSource = new Map<string, string>();
              const _sfMeta   = new Map<string, { isVerified?: boolean; isPrivate?: boolean; followerCount?: number }>();
              const _sfRaw: string[] = [];

              // Consume surplus first before calling HikerAPI
              const _sfProfileId = mobileProfileId;
              const _sfSlotKey = (mobileProfileId ? undefined : (slotUsername || undefined))?.replace(/^@/, "").toLowerCase() ?? "";
              if (_sfProfileId && _sfProfileId > 0) {
                try {
                  const rows = await storage.getOverspillUsersByProfile(_sfProfileId);
                  for (const row of rows) {
                    const u = row.instagramUsername;
                    if (_sfSkipFollowed?.has(u.toLowerCase())) continue;
                    if (_sfSkipSkipped?.has(u.toLowerCase())) continue;
                    _sfSurplusIds.set(u.toLowerCase(), row.id);
                    if (!_sfSource.has(u)) _sfSource.set(u, row.sourceValue || "surplus");
                    _sfRaw.push(u);
                  }
                  if (rows.length) tLog(`  Spread Follows: loaded ${rows.length} surplus candidate(s)`);
                } catch {}
              } else if (_sfSlotKey) {
                try {
                  const rows = await storage.getOverspillUsersByPhoneSlot(_sfSlotKey);
                  for (const row of rows) {
                    const u = row.instagramUsername;
                    if (_sfSkipFollowed?.has(u.toLowerCase())) continue;
                    if (_sfSkipSkipped?.has(u.toLowerCase())) continue;
                    _sfSurplusIds.set(u.toLowerCase(), row.id);
                    if (!_sfSource.has(u)) _sfSource.set(u, row.sourceValue || "surplus");
                    _sfRaw.push(u);
                  }
                  if (rows.length) tLog(`  Spread Follows: loaded ${rows.length} surplus candidate(s)`);
                } catch {}
              }

              if (_sfRaw.length < _spreadTarget * 3) {
                const _sfShuffledSrcs = [...followSources].sort(() => Math.random() - 0.5);
                for (const src of _sfShuffledSrcs) {
                  if (_sfRaw.length >= _spreadTarget * 3) break;
                  const srcLabel = src.type === "hashtag" ? `#${src.value.replace(/^#/, "")}` : `@${src.value.replace(/^@/, "")}`;
                  try {
                    if (src.type === "hashtag") {
                      const res = await _sfHiker.getHashtagUsers(src.value.replace(/^#/, ""), 50);
                      for (const u of res.users) {
                        if (!_sfSource.has(u.username)) _sfSource.set(u.username, srcLabel);
                        if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                          _sfMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                        _sfRaw.push(u.username);
                      }
                      tLog(`  Spread Follows: ${srcLabel} → ${res.users.length} users`);
                    } else if (src.type === "target_followers") {
                      const userInfo = await _sfHiker.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
                      if (!userInfo?.pk) continue;
                      const followers = await _sfHiker.getFollowers(userInfo.pk, 50);
                      for (const u of followers) {
                        if (!_sfSource.has(u.username)) _sfSource.set(u.username, srcLabel);
                        if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                          _sfMeta.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                        _sfRaw.push(u.username);
                      }
                      tLog(`  Spread Follows: ${srcLabel} followers → ${followers.length} users`);
                    }
                  } catch (e: any) {
                    if (e?.message === "cycle-aborted") throw e;
                    tLog(`  Spread Follows: HikerAPI error for "${src.value}": ${e?.message}`);
                  }
                }
              } else {
                tLog("  Spread Follows: Surplus pool sufficient — skipping HikerAPI scrape");
              }

              // Dedup + filter candidates
              let _sfCandidates = [...new Set(_sfRaw)].sort(() => Math.random() - 0.5);
              if (_sfSkipFollowed?.size) _sfCandidates = _sfCandidates.filter(u => !_sfSkipFollowed!.has(u.toLowerCase()));
              if (_sfSkipSkipped?.size)  _sfCandidates = _sfCandidates.filter(u => !_sfSkipSkipped!.has(u.toLowerCase()));
              // Account-quality filters, including Males Only, are
              // deliberately deferred to runFollowUsersStep. Candidates must
              // be opened in Instagram and checked against the live
              // accessibility tree before any Follow tap.
              // Candidates must be opened in Instagram and checked against the
              // live accessibility tree before any Follow tap.

              const _sfPool = _sfCandidates.slice(0, _spreadTarget);
              const _nonFollowTools = _toolSeq.filter(t => t !== 'follow');

              if (_sfPool.length >= 2 && _nonFollowTools.length >= 1) {
                _spreadCandidateSource = _sfSource;
                _spreadCandidateMeta   = _sfMeta;
                _sfHikerToken          = _sfToken;
                _sfSpreadProfileId     = _sfProfileId;
                _sfSpreadSlotKey       = _sfSlotKey;

                // Keep extras as a backup queue for filter-retry — do NOT flush
                // to Surplus yet.  Any survivors are flushed after the tool loop.
                if (_sfCandidates.length > _sfPool.length) {
                  _sfBackupQueue = _sfCandidates.slice(_sfPool.length);
                  tLog(`  Spread Follows: keeping ${_sfBackupQueue.length} candidate(s) as backup pool`);
                }

                // Interleave spread follows across the complete non-Follow
                // sequence. The old implementation started inserting only
                // after the original shuffled Follow position, so when Follow
                // happened to be last every candidate stayed in one bulk
                // block at the end of the cycle.
                //
                // Place candidates after evenly spaced non-Follow tools. This
                // keeps the feature independent of where the placeholder
                // Follow tool landed in the shuffle, while preserving the
                // shuffled order of every other tool.
                const _nonFollowSeq = _toolSeq.filter(_nt => _nt !== 'follow');
                const _spreadSeq: string[] = [];
                const _spreadCount = _sfPool.length;
                let _sfi = 0;
                for (let _ni = 0; _ni < _nonFollowSeq.length; _ni++) {
                  _spreadSeq.push(_nonFollowSeq[_ni]);
                  const _afterCount = Math.min(
                    _spreadCount,
                    Math.floor(((_ni + 1) * _spreadCount) / _nonFollowSeq.length),
                  );
                  while (_sfi < _afterCount) {
                    _spreadSeq.push(`follow_spread:${_sfPool[_sfi++]}`);
                  }
                }
                // If there are more follow slots than non-Follow tools, keep
                // the extras after the final tool rather than dropping them.
                while (_sfi < _spreadCount) {
                  _spreadSeq.push(`follow_spread:${_sfPool[_sfi++]}`);
                }

                _toolSeq.splice(0, _toolSeq.length, ..._spreadSeq);
                tLog(`▶ Spread Follows active (${_sfPool.length} user(s)) → ${_spreadSeq.join(' → ')}`);
              } else if (_sfPool.length < 2) {
                tLog(`▶ Spread Follows: only ${_sfPool.length} candidate(s) fetched — falling back to normal follow`);
              }
              // _nonFollowTools.length === 0: sequence unchanged, follow runs normally
            }
          } catch (e: any) {
            if (e?.message === "cycle-aborted") throw e;
            tLog(`▶ Spread Follows pre-fetch error — ${e?.message} — falling back to normal follow`);
          }
        }
        // targetCount === 1: spread never applies, follow runs normally via standard dispatcher
      }

      // View Feed re-run is appended after the completed shuffled sequence.
      // Reusing the same `feed` dispatcher entry reapplies every View Feed
      // setting and action, including likes, hashtags, and author clicks.
      const _feedRerunLo = Math.min(feedRerunChanceMin, feedRerunChanceMax);
      const _feedRerunHi = Math.max(feedRerunChanceMin, feedRerunChanceMax);
      const _feedRerunChance = _feedRerunLo + Math.random() * (_feedRerunHi - _feedRerunLo);
      if (_toolActivated.feed && _feedRerunChance > 0 && Math.random() * 100 < _feedRerunChance) {
        _toolSeq.push("feed");
        tLog(`▶ View Feed re-run rolled (${Math.round(_feedRerunChance)}%) — appended at end of cycle`);
      }

      // Report the order the dispatcher will actually execute. Spread Follows
      // rewrites the base shuffled sequence after pre-fetching candidates, so
      // this makes every injected follow position explicit in the log.
      const _effectiveToolOrder = _toolSeq.map(_name =>
        _name.startsWith("follow_spread:")
          // Show each injected spread slot as the same tool label used by the
          // shuffle. The specific candidate is logged when that Follow Users
          // slot executes; the order display should make duplicate Follow
          // positions visible rather than replacing them with usernames.
          ? "FOLLOW USERS"
          : (_toolOrderLabels[_name] ?? _name),
      );
      tLog(`▶ Effective tool order${followSpreadFollows ? " (Spread Follows applied where active)" : ""}: ${
        _effectiveToolOrder.length > 0 ? _effectiveToolOrder.join(' → ') : '(no tools active this execution)'
      }`);

      let _toolsRan = 0; // how many tools have executed before the current one
      let _viewFeedExecuted = false;

      for (const [_toolIndex, _tool] of _toolSeq.entries()) {
        if (isCycleAborted(serial)) break;
        const _isFirst = _toolsRan === 0;
        trace(`tool-start index=${_toolIndex + 1}/${_toolSeq.length} tool=${_tool.startsWith("follow_spread:") ? "follow" : _tool} first=${_isFirst}`);
        const _currentToolLabels: Record<string, string> = {
          feed: "View Feed",
          stories: "Stories",
          explore: "Explore",
          reels: "Reel Viewer",
          checkDm: "Check Inbox",
          follow: "Follow Users",
          post: "Make a Post",
          postStory: "Post a Story",
          "Random Actions": "Random Actions",
        };
        automationCurrentTool.set(
          serial,
          _tool.startsWith("follow_spread:") ? "Follow Users" : (_currentToolLabels[_tool] ?? _tool),
        );

        // ── Feed ────────────────────────────────────────────────────────
        if (_tool === 'feed') {
          if (_toolActivated[_tool]) { // pre-rolled above
            // When this is not the first tool the previous one may have left
            // the phone anywhere — navigate back to the home feed before
            // starting the scroll sequence.
            if (!_isFirst) {
              tLog("▶ View Feed: navigating to home feed…");
              const _fHome = await android.findHomeTab(serial).catch(() => null);
              if (_fHome) {
                await android.tap(serial, _fHome.x, _fHome.y);
              } else {
                // Coordinate fallback — same as Stories uses — taps the leftmost
                // bottom-nav icon (Home) when uiautomator can't find it by node.
                const { w: sw, h: sh } = getScreenSize(serial);
                await android.tap(serial, Math.round(sw * 0.10), Math.round(sh * 0.975));
              }
              await sleepOrAbort(serial, 2000);
            }
            tLog(`▶ Starting feed scroll — ${count} posts`);
            ({ likes, likeFailures, sharesFeed, sharesDm, saves, captionExpands, strayNavRecoveries, audioTaps, hashtagTaps, authorVisits } = await runCheckFeedLoop(serial, {
              count, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
              homeAlreadyEstablished: !_isFirst,
              shareFeedPercentMin, shareFeedPercentMax,
              shareDmPercentMin, shareDmPercentMax,
              savePercentMin, savePercentMax,
              expandCaptionPercentMin, expandCaptionPercentMax,
              tapAudioPercentMin, tapAudioPercentMax,
              clickHashtagPercentMin, clickHashtagPercentMax,
              clickAuthorPercentMin, clickAuthorPercentMax,
              onLog: (msg) => tLog(`  ${msg}`),
            }));
            feedScrolled = count;
            steps.push(`feed(${count} scrolls, ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} dm-shares, ${saves} saves, ${captionExpands} caption-expands, ${audioTaps} audio-taps, ${hashtagTaps} hashtag-taps, ${authorVisits} author-visits, ${likeFailures} like-failures${strayNavRecoveries ? `, ${strayNavRecoveries} ad-nav-recoveries` : ""})`);
            tLog(`▶ Feed done — ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} DM-shares, ${saves} saves, ${captionExpands} caption-expands`);
            _viewFeedExecuted = true;
          } else if (!feedEnabled) {
            steps.push("feed(skipped — View Feed disabled)");
            tLog("▶ View Feed disabled — skipping feed scroll");
          } else {
            steps.push("feed(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ View Feed Activate Percentage roll missed — skipping feed scroll this execution");
          }

        // ── Stories ─────────────────────────────────────────────────────
        } else if (_tool === 'stories') {
          if (_toolActivated[_tool]) { // pre-rolled above
            // Always establish the Home feed first, even when Stories is the
            // first tool in the cycle. The phone can still be on a nested
            // screen from a previous cycle or app resume.
            const _alreadyInStory = await android.isInStoryViewerSlow(serial).catch(() => false);
            let storyEntry: { slot: number; opened: boolean };
            if (_alreadyInStory) {
              // The story tool may be entered while the phone is already
              // showing a story (for example, the preceding Feed action
              // opened one). That is a valid starting state. Do not tap Home
              // or press a story bubble: those actions would operate on the
              // viewer and can focus the reply composer.
              tLog("▶ Stories: already in Story viewer — skipping Home and story-bubble taps");
              storyEntry = { slot: 0, opened: true };
            } else {
              tLog("▶ Tapping Home tab for stories…");
              // Only navigate to Home when we positively know we are not
              // already in the Story viewer.
              const homeTab = await android.findHomeTab(serial).catch(() => null);
              if (homeTab) {
                await android.tap(serial, homeTab.x, homeTab.y);
              } else {
                steps.push("stories(aborted — Home tab not positively detected)");
                tLog("▶ Stories aborted — Home tab not positively detected; refusing coordinate fallback");
                continue;
              }
              await sleepOrAbort(serial, 1200);
              const _homeConfirmed = await android.findHomeTab(serial).catch(() => null);
              if (!_homeConfirmed) {
                steps.push("stories(aborted — Home tab confirmation failed)");
                tLog("▶ Stories aborted — Home tab confirmation failed; refusing to open story tray");
                continue;
              }
              const preStoriesPopup = await android.dismissInstagramInterstitials(serial).catch(() => null);
              if (preStoriesPopup) {
                steps.push(`pre-stories-popup-dismissed(${preStoriesPopup})`);
                await sleepOrAbort(serial, 600);
              }
              // The story scanner performs the live accessibility check itself.
              // A long fixed sleep here only delays the first dump when the tray
              // is already rendered; keep a short settle window for animation.
              tLog("▶ Checking story tray readiness…");
              await sleepOrAbort(serial, 800);
              tLog(`▶ Starting stories (up to ${viewStoriesSlidesMax})`);
              storyEntry = await pickAndOpenRandomStory(
                serial,
                getScreenSize(serial).w,
                getScreenSize(serial).h,
                (msg) => tLog(`  ${msg}`),
              );
            }
            if (!storyEntry.opened) {
              steps.push("stories(aborted — no story bubbles after Home retry)");
              tLog("▶ Stories aborted — no story bubbles available");
              continue;
            }
            const result = await runViewStoriesFromFeedLoop(serial, {
              slidesMin: viewStoriesSlidesMin, slidesMax: viewStoriesSlidesMax,
              slideWatchPctMin: viewStoriesSlideWatchPctMin, slideWatchPctMax: viewStoriesSlideWatchPctMax,
              likePercentMin: viewStoriesLikePercentMin, likePercentMax: viewStoriesLikePercentMax,
              shareDmPercentMin: viewStoriesShareDmPercentMin, shareDmPercentMax: viewStoriesShareDmPercentMax,
              commentPercentMin: viewStoriesCommentPercentMin, commentPercentMax: viewStoriesCommentPercentMax,
              clickAuthorPercentMin: viewStoriesClickAuthorPercentMin, clickAuthorPercentMax: viewStoriesClickAuthorPercentMax,
              alreadyInStoryViewer: _alreadyInStory,
              onLog: (msg) => tLog(`  ${msg}`),
            });
            // runViewStoriesFromFeedLoop exits the viewer internally (ad-
            // deviation recovery + swipe-down). Control returns here only
            // once the phone is back on the home feed — no extra exit step.
            storiesWatched = result.storiesWatched;
            storyLikes = result.storyLikes;
            steps.push(`stories(${result.storiesWatched} watched)`);
            tLog(`▶ Stories done — ${result.storiesWatched} watched, ${result.storyLikes} likes`);
          } else if (!storiesEnabled) {
            steps.push("stories(skipped — View Stories from Feed disabled)");
            tLog("▶ View Stories from Feed disabled — skipping stories");
          } else if (storiesEnabled && viewStoriesSlidesMax > 0) {
            steps.push("stories(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ View Stories from Feed Activate Percentage roll missed — skipping stories this execution");
          }

        // ── Explore ─────────────────────────────────────────────────────
        } else if (_tool === 'explore') {
          if (_toolActivated[_tool]) {
            // Navigate to the Search/Explore tab, scroll the grid, and
            // optionally click posts to like/share/save.  The function
            // handles its own Home-tab exit at the end, so no nav needed here.
            tLog(`▶ Starting View Explore Page (${viewExploreScrollMax} scrolls max)`);
            const exploreResult = await runViewExplorePage(serial, {
              scrollCount: Math.floor(rollRange(viewExploreScrollMin ?? 0, viewExploreScrollMax ?? 0)),
              delayMinSec: viewExploreActionDelayMin ?? 3,
              delayMaxSec: viewExploreActionDelayMax ?? 6,
              clickPostPctMin: viewExploreClickPostPctMin ?? 0,
              clickPostPctMax: viewExploreClickPostPctMax ?? 0,
              likePercentMin: viewExploreLikePercentMin ?? 0,
              likePercentMax: viewExploreLikePercentMax ?? 0,
              shareFeedPercentMin: viewExploreShareFeedPercentMin ?? 0,
              shareFeedPercentMax: viewExploreShareFeedPercentMax ?? 0,
              shareDmPercentMin: viewExploreShareDmPercentMin ?? 0,
              shareDmPercentMax: viewExploreShareDmPercentMax ?? 0,
              savePercentMin: viewExploreSavePercentMin ?? 0,
              savePercentMax: viewExploreSavePercentMax ?? 0,
              clickAuthorPctMin: viewExploreClickAuthorPercentMin ?? 0,
              clickAuthorPctMax: viewExploreClickAuthorPercentMax ?? 0,
              onLog: (msg) => tLog(`  ${msg}`),
              onProgress: (progress) => {
                exploreScrolled = progress.postsScrolled;
                exploreLikes = progress.likes;
                sharesFeed = progress.sharesFeed;
                sharesDm = progress.sharesDm;
                saves = progress.saves;
                authorVisits = progress.authorVisits;
              },
            });
            exploreScrolled = exploreResult.postsScrolled;
            exploreLikes = exploreResult.likes;
            steps.push(`explore(${exploreResult.postsScrolled} scrolls, ${exploreResult.postsClicked} clicked, ${exploreResult.likes} likes, ${exploreResult.sharesFeed} feed-shares, ${exploreResult.sharesDm} dm-shares, ${exploreResult.saves} saves, ${exploreResult.authorVisits} author-visits)`);
            tLog(`▶ View Explore Page done — ${exploreResult.postsScrolled} scrolls, ${exploreResult.postsClicked} clicked, ${exploreResult.likes} likes`);
          } else if (!viewExploreEnabled) {
            steps.push("explore(skipped — View Explore Page disabled)");
            tLog("▶ View Explore Page disabled — skipping");
          } else if (viewExploreEnabled && (viewExploreScrollMax ?? 0) > 0) {
            steps.push("explore(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ View Explore Page Activate Percentage roll missed — skipping this execution");
          }
          _toolsRan++;

        // ── Reels ───────────────────────────────────────────────────────
        } else if (_tool === 'reels') {
          if (_toolActivated[_tool]) { // pre-rolled above
            tLog(`▶ Starting View Reels (up to ${viewReelsScrollMax})`);
            const reelsResult = await runViewReelsLoop(serial, {
              scrollMin: viewReelsScrollMin, scrollMax: viewReelsScrollMax,
              watchPctMin: viewReelsWatchPctMin, watchPctMax: viewReelsWatchPctMax,
              likePercentMin: viewReelsLikePercentMin, likePercentMax: viewReelsLikePercentMax,
              shareFeedPercentMin: viewReelsShareFeedPercentMin, shareFeedPercentMax: viewReelsShareFeedPercentMax,
              shareDmPercentMin: viewReelsShareDmPercentMin, shareDmPercentMax: viewReelsShareDmPercentMax,
              savePercentMin: viewReelsSavePercentMin ?? 0, savePercentMax: viewReelsSavePercentMax ?? 0,
              clickAuthorPctMin: viewReelsClickAuthorPercentMin ?? 0, clickAuthorPctMax: viewReelsClickAuthorPercentMax ?? 0,
              onLog: (msg) => tLog(`  ${msg}`),
              onProgress: (progress) => {
                reelsViewed = progress.reelsViewed;
                reelsLikes = progress.likes;
                sharesFeed = progress.sharesFeed;
                sharesDm = progress.sharesDm;
                saves = progress.saves;
              },
            });
            reelsViewed = reelsResult.reelsViewed;
            reelsLikes = reelsResult.likes;
            steps.push(`reels(${reelsResult.reelsViewed} viewed, ${reelsResult.likes} likes, ${reelsResult.sharesFeed} feed-shares, ${reelsResult.sharesDm} dm-shares, ${reelsResult.saves} saves)`);
            tLog(`▶ View Reels done — ${reelsResult.reelsViewed} viewed, ${reelsResult.likes} likes`);
            // Reels owns one deterministic exit action: tap the leftmost
            // Instagram bottom-navigation slot. Do not resolve labels or
            // resource IDs; those can identify the wrong node on variant
            // accessibility trees.
            tLog("▶ View Reels — exiting full-screen viewer via Home tab…");
            const homeTab = await android.getBottomLeftHomeFallback(serial);
            await android.tap(serial, homeTab.x, homeTab.y);
            tLog(`▶ View Reels — tapped Home tab at (${homeTab.x},${homeTab.y})`);
          } else if (!viewReelsEnabled) {
            steps.push("reels(skipped — View Reels disabled)");
            tLog("▶ View Reels disabled — skipping reels");
          } else if (viewReelsEnabled && viewReelsScrollMax > 0) {
            steps.push("reels(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ View Reels Activate Percentage roll missed — skipping reels this execution");
          }

        // ── Check DMs ───────────────────────────────────────────────────
        } else if (_tool === 'checkDm') {
          if (_toolActivated[_tool]) {
            tLog("▶ Check Inbox — opening DM inbox…");
            try {
              await runCheckDmLoop(serial, {
                scrollsMin: checkDmScrollMin,
                scrollsMax: checkDmScrollMax,
                clickPctMin: checkDmClickPctMin,
                clickPctMax: checkDmClickPctMax,
                onLog: (msg) => tLog(`  ${msg}`),
              });
              steps.push("checkDm(done)");
            tLog("▶ Check Inbox done");
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
            tLog(`▶ Check Inbox error — ${e?.message}`);
              steps.push("checkDm(error)");
            }
          } else if (!checkDmEnabled) {
            // no-op — Check Inbox disabled is the common/default state
          } else {
            steps.push("checkDm(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ Check Inbox Activate Percentage roll missed — skipping this execution");
          }

        // ── Follow Users ────────────────────────────────────────────────
        } else if (_tool.startsWith('follow_spread:')) {
          // ── Spread Follow slot — one pre-fetched user ─────────────────────
          const _spreadUsername = _tool.slice('follow_spread:'.length);
          tLog(`▶ Spread Follow → @${_spreadUsername}`);
          try {
            // Pre-compute skip sets once; reused for all retries in this slot.
            const _ssSkipFollowed = await (async () => {
              if (!globalSkipFollowed) return undefined;
              const local = new Set(getMobileFollowedList(serial).map(e => e.username.toLowerCase()));
              const globalSet = await storage.getAllFollowedUsernames();
              for (const u of globalSet) local.add(u);
              return local;
            })();
            const _ssSkipSkipped = await (async () => {
              if (!globalSkipSkipped) return undefined;
              const rows = await storage.getSkippedUsers(100_000);
              return new Set(rows.map(s => s.instagramUsername.toLowerCase()));
            })();
            const _ssBrowsing = injectBrowsingEnabled ? {
              activatePctMin: injectBrowsingActivatePctMin, activatePctMax: injectBrowsingActivatePctMax,
              beforeFollowPctMin: injectBrowsingBeforeFollowPctMin, beforeFollowPctMax: injectBrowsingBeforeFollowPctMax,
              feedMin: injectBrowsingFeedMin, feedMax: injectBrowsingFeedMax,
              clickPostPctMin: injectBrowsingClickPostPctMin, clickPostPctMax: injectBrowsingClickPostPctMax,
              likePctMin: injectBrowsingLikePctMin, likePctMax: injectBrowsingLikePctMax,
              shareFeedPctMin: injectBrowsingShareFeedPctMin, shareFeedPctMax: injectBrowsingShareFeedPctMax,
              shareDmPctMin: injectBrowsingShareDmPctMin, shareDmPctMax: injectBrowsingShareDmPctMax,
              savePostPctMin: injectBrowsingSavePostPctMin, savePostPctMax: injectBrowsingSavePostPctMax,
              abandonFollowPctMin: injectBrowsingAbandonFollowPctMin, abandonFollowPctMax: injectBrowsingAbandonFollowPctMax,
              tapHighlightsPctMin: injectBrowsingTapHighlightsPctMin, tapHighlightsPctMax: injectBrowsingTapHighlightsPctMax,
            } : undefined;
            const _ssFilters = followFiltersEnabled
              ? { skipVerified: followFilterVerifiedUsers, maxFollowers: followFilterMaxFollowers25k ? 25_000 : undefined,
                  skipPrivate: followFilterPrivateUsers, minFollowers: followFilterMinFollowers50 ? 50 : undefined,
                  requireEnglish: followFilterEnglishSpeaking,
                  malesOnly: followFilterMalesOnly, maleNames: followFilterMaleNames }
              : undefined;

            // Helper — calls runFollowUsersStep for exactly one candidate.
            const _runOneSpreadSlot = async (candidate: string, searchAlreadyReady = false) => {
              const surplusId = _sfSurplusIds.get(candidate.toLowerCase());
              if (surplusId !== undefined) {
                await storage.deleteOverspillUsers([surplusId]).catch(() => {});
                _sfSurplusIds.delete(candidate.toLowerCase());
                tLog(`  Spread Follows: consumed Surplus @${candidate} after dispatch`);
              }
              return runFollowUsersStep(serial, {
              usersMin: 1, usersMax: 1,
              sources: followSources,
              preloadedCandidates: {
                targets: [candidate],
                candidateSource: _spreadCandidateSource ?? new Map(),
                candidateMeta:   _spreadCandidateMeta   ?? new Map(),
              },
              onLog: (msg) => tLog(`  ${msg}`),
              recordFollow: (u, src) => recordMobileFollow(serial, slotIdx, u, src),
              onLike: () => { injectBrowsingLikes++; },
              skipFollowedUsernames: _ssSkipFollowed,
              skipSkippedUsernames:  _ssSkipSkipped,
              writeSkippedUsers:     globalSkipSkipped,
              browsing: _ssBrowsing,
              filters:  _ssFilters,
              profileId: mobileProfileId ?? undefined,
              phoneSlotKey: mobileProfileId ? undefined : (slotUsername || undefined),
               searchAlreadyReady,
               // The spread owns cleanup across its entire candidate and
               // backup sequence. Never press Back between candidates.
               keepSearchOpenAfterStep: true,
              });
            };

            let _sfCount = await _runOneSpreadSlot(_spreadUsername);

            // If filtered/skipped at follow-time, try backup candidates first.
            while (_sfCount === 0 && _sfBackupQueue.length > 0) {
              const _nextUser = _sfBackupQueue.shift()!;
              tLog(`  Spread Follow: @${_spreadUsername} filtered — trying backup @${_nextUser}`);
              _sfCount = await _runOneSpreadSlot(_nextUser, true);
            }

            // Backup queue exhausted — do one HikerAPI re-scrape round.
            if (_sfCount === 0 && _sfHikerToken && followSources.length) {
              tLog(`  Spread Follow: backup queue empty — re-scraping HikerAPI for replacement…`);
              try {
                const _rsHiker = new HikerApiClient(_sfHikerToken);
                for (const src of [...followSources].sort(() => Math.random() - 0.5)) {
                  if (_sfBackupQueue.length >= 10) break;
                  try {
                    const srcLabel = src.type === "hashtag"
                      ? `#${src.value.replace(/^#/, "")}`
                      : `@${src.value.replace(/^@/, "")}`;
                    const users: { username: string; isVerified?: boolean; isPrivate?: boolean; followerCount?: number }[] = [];
                    if (src.type === "hashtag") {
                      const res = await _rsHiker.getHashtagUsers(src.value.replace(/^#/, ""), 50);
                      users.push(...res.users);
                    } else if (src.type === "target_followers") {
                      const ui = await _rsHiker.getUserByUsername(src.value.replace(/^@/, "")).catch(() => null);
                      if (ui?.pk) users.push(...await _rsHiker.getFollowers(ui.pk, 50));
                    }
                    for (const u of users) {
                      if (_ssSkipFollowed?.has(u.username.toLowerCase())) continue;
                      if (_ssSkipSkipped?.has(u.username.toLowerCase())) continue;
                      if (_spreadCandidateSource?.has(u.username)) continue; // already in pool/attempted
                      _spreadCandidateSource?.set(u.username, srcLabel);
                      if (u.isVerified !== undefined || u.isPrivate !== undefined || u.followerCount !== undefined)
                        _spreadCandidateMeta?.set(u.username, { isVerified: u.isVerified, isPrivate: u.isPrivate, followerCount: u.followerCount });
                      _sfBackupQueue.push(u.username);
                    }
                  } catch (e: any) { if (e?.message === "cycle-aborted") throw e; }
                }
                if (_sfBackupQueue.length) {
                  tLog(`  Spread Follow: re-scrape found ${_sfBackupQueue.length} new candidate(s)`);
                  while (_sfCount === 0 && _sfBackupQueue.length > 0) {
                    const _nextUser = _sfBackupQueue.shift()!;
                    tLog(`  Spread Follow: trying re-scraped @${_nextUser}`);
                    _sfCount = await _runOneSpreadSlot(_nextUser, true);
                  }
                } else {
                  tLog(`  Spread Follow: re-scrape found no viable candidates — slot unfulfilled`);
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  Spread Follow: re-scrape error — ${e?.message}`);
              }
            }

            // The complete spread is now finished: the primary candidate,
            // backups, and any replacement scrape candidates have all been
            // exhausted or one has succeeded. Restore the normal Instagram UI
            // exactly once for the next tool/dispatcher entry.
            try {
              await android.clearInstagramSearchBar(serial, (msg) => tLog(`  Spread Follow: final cleanup — ${msg}`));
              await android.pressBack(serial);
              await sleepOrAbort(serial, 500, "accountSwitching");
              await android.pressBack(serial);
              await sleepOrAbort(serial, 500);
              tLog("  Spread Follow: final cleanup — pressed Back twice to restore normal UI");
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
              tLog(`  Spread Follow: final cleanup failed — ${e?.message ?? "unknown error"}`);
            }

            followedCount += _sfCount;
            steps.push(`follow_spread(@${_spreadUsername}${_sfCount > 0 ? '' : ',skipped'})`);
          } catch (e: any) {
            if (e?.message === "cycle-aborted") throw e;
            tLog(`▶ Spread Follow @${_spreadUsername} error — ${e?.message}`);
            steps.push(`follow_spread(@${_spreadUsername},error)`);
          }

        } else if (_tool === 'follow') {
          if (_toolActivated[_tool]) { // pre-rolled above
            tLog("▶ Follow Users — fetching targets via HikerAPI…");
            try {
              const followCount = await runFollowUsersStep(serial, {
                usersMin: followUsersMin,
                usersMax: followUsersMax,
                sources: followSources,
                maxScrapeSessions: globalFollowMaxScrapeSessions,
                onLog: (msg) => tLog(`  ${msg}`),
                recordFollow: (username, source) => recordMobileFollow(serial, slotIdx, username, source),
                onLike: () => { injectBrowsingLikes++; },
                skipFollowedUsernames: await (async () => {
                  if (!globalSkipFollowed) return undefined;
                  const local = new Set(getMobileFollowedList(serial, slotIdx).map(e => e.username.toLowerCase()));
                  if (globalSkipFollowed) {
                    const globalSet = await storage.getAllFollowedUsernames();
                    for (const u of globalSet) local.add(u);
                  }
                  return local;
                })(),
                skipSkippedUsernames: await (async () => {
                  if (!globalSkipSkipped) return undefined;
                  const rows = await storage.getSkippedUsers(100_000);
                  return new Set(rows.map(s => s.instagramUsername.toLowerCase()));
                })(),
                browsing: injectBrowsingEnabled ? {
                  activatePctMin: injectBrowsingActivatePctMin, activatePctMax: injectBrowsingActivatePctMax,
                  beforeFollowPctMin: injectBrowsingBeforeFollowPctMin, beforeFollowPctMax: injectBrowsingBeforeFollowPctMax,
                  feedMin: injectBrowsingFeedMin, feedMax: injectBrowsingFeedMax,
                  clickPostPctMin: injectBrowsingClickPostPctMin, clickPostPctMax: injectBrowsingClickPostPctMax,
                  likePctMin: injectBrowsingLikePctMin, likePctMax: injectBrowsingLikePctMax,
                  shareFeedPctMin: injectBrowsingShareFeedPctMin, shareFeedPctMax: injectBrowsingShareFeedPctMax,
                  shareDmPctMin: injectBrowsingShareDmPctMin, shareDmPctMax: injectBrowsingShareDmPctMax,
                  savePostPctMin: injectBrowsingSavePostPctMin, savePostPctMax: injectBrowsingSavePostPctMax,
                  abandonFollowPctMin: injectBrowsingAbandonFollowPctMin, abandonFollowPctMax: injectBrowsingAbandonFollowPctMax,
                  tapHighlightsPctMin: injectBrowsingTapHighlightsPctMin, tapHighlightsPctMax: injectBrowsingTapHighlightsPctMax,
                } : undefined,
        filters: followFiltersEnabled
                  ? {
                      skipVerified:  followFilterVerifiedUsers,
                      maxFollowers:  followFilterMaxFollowers25k ? 25_000 : undefined,
                      skipPrivate:   followFilterPrivateUsers,
                      minFollowers:  followFilterMinFollowers50 ? 50 : undefined,
                      requireEnglish: followFilterEnglishSpeaking,
                      malesOnly: followFilterMalesOnly,
                      maleNames: followFilterMaleNames,
                    }
                  : undefined,
                writeSkippedUsers: globalSkipSkipped,
                profileId: mobileProfileId ?? undefined,
                phoneSlotKey: mobileProfileId ? undefined : (slotUsername || undefined),
              });
              followedCount = followCount;
              steps.push(`follow(${followCount} followed)`);
              tLog(`▶ Follow done — ${followCount} users followed`);
            } catch (e: any) {
              if (e?.message === "cycle-aborted") throw e;
              tLog(`▶ Follow step error — ${e?.message}`);
              steps.push("follow(error)");
            }
          } else if (!followEnabled) {
            // no-op — Follow Users disabled is the common/default state
          } else {
            steps.push("follow(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ Follow Users Activate Percentage roll missed — skipping follow step this execution");
          }

        // ── Make a Post ─────────────────────────────────────────────────
        } else if (_tool === 'post') {
          if (_toolActivated[_tool]) { // pre-rolled above
            tLog("[TRACE] make-a-post: start");
            // The frontend sends makePostLocalFolderPath from its React state.
            // If that state was stale/empty for any reason (hydration glitch,
            // settings loaded before the dedicated file was ready, etc.) fall
            // back to reading directly from the dedicated file — it is always
            // the authoritative source and survives everything that can clear
            // the JSON store.
            const resolvedFolderPath = makePostLocalFolderPath || getMakePostFolderPath(serial, slotIdx);
            if (!resolvedFolderPath) {
              steps.push("make-a-post(skipped — Local Folder source not configured)");
              tLog("▶ Make a Post enabled but no Local Folder path configured — skipping");
            } else {
              const postCount = rollRange(makePostPerSessionMin, makePostPerSessionMax);
              tLog(`▶ Make a Post — attempting ${postCount} post(s) from local folder…`);
              let posted = 0;
              for (let i = 0; i < postCount; i++) {
                try {
                  tLog(`[TRACE] make-a-post: attempt ${i + 1}/${postCount}`);
                  // Make a Post is feed-only. The preserved Story routine is
                  // dispatched by the standalone Post a Story tool below.
                  tLog("  Make a Post: destination → normal feed");
                  const result = await runMakePostStep(serial, {
                    localFolderPath: resolvedFolderPath,
                    localFolderRandom: makePostLocalFolderRandom,
                    localFolderNoRepeat: makePostLocalFolderNoRepeat,
                    accountUsername: slotUsername,
                    slotIdx,
                    alterationEnabled: makePostAlterationEnabled,
                    alterationLevel: makePostAlterationLevel,
                    imageSettingsEnabled: makePostImageSettingsEnabled,
                    imageSettings: makePostImageSettings,
                    doFixAiSlop: makePostFixAiSlop,
                    frequencyDisruption: makePostFrequencyDisruption,
                    addLocation: makePostAddLocation,
                    captionText: makePostCaptionText,
                    homeTapCount: _viewFeedExecuted ? 2 : 1,
                    onLog: (msg) => tLog(`  ${msg}`),
                  });
                  if (result.posted) {
                    posted++;
                    postsUploaded++;
                    tLog("  Make a Post: upload confirmed — dwelling 5 s before continuing…");
                    await sleepOrAbort(serial, 5000);
                  } else break;
                } catch (e: any) {
                  if (e?.message === "cycle-aborted") throw e;
                  tLog(`▶ Make a Post attempt error — ${e?.message}`);
                  break;
                }
              }
              steps.push(`make-a-post(${posted}/${postCount} posted)`);
              tLog(`▶ Make a Post done — ${posted}/${postCount} posted`);
            }
          } else if (makePostEnabled) {
            steps.push("make-a-post(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ Make a Post Activate Percentage roll missed — skipping this execution");
          }

        // ── Post a Story ──────────────────────────────────────────────────
        } else if (_tool === 'postStory') {
          if (_toolActivated[_tool]) {
            tLog("[TRACE] post-a-story: start");
            const resolvedStoryFolderPath =
              postStoryLocalFolderPath || getPostStoryFolderPath(serial, slotIdx);
            if (!resolvedStoryFolderPath) {
              steps.push("post-a-story(skipped — Local Folder source not configured)");
              tLog("▶ Post a Story enabled but no Local Folder path configured — skipping");
            } else {
              tLog("▶ Post a Story — attempting one story from local folder…");
              let posted = 0;
              try {
                const result = await runMakePostStoryStep(serial, {
                  localFolderPath: resolvedStoryFolderPath,
                  localFolderRandom: postStoryLocalFolderRandom,
                  localFolderNoRepeat: postStoryLocalFolderNoRepeat,
                  alterationEnabled: postStoryAlterationEnabled,
                  alterationLevel: postStoryAlterationLevel,
                  imageSettingsEnabled: postStoryImageSettingsEnabled,
                  imageSettings: postStoryImageSettings,
                  doFixAiSlop: postStoryFixAiSlop,
                  onLog: (msg) => tLog(`  ${msg}`),
                });
                if (result.posted) {
                  posted++;
                  postsUploaded++;
                  tLog("  Post a Story: upload confirmed — dwelling 5 s before continuing…");
                  await sleepOrAbort(serial, 5000);
                }
              } catch (e: any) {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`▶ Post a Story attempt error — ${e?.message}`);
              }
              steps.push(`post-a-story(${posted}/1 posted)`);
              tLog(`▶ Post a Story done — ${posted}/1 posted`);
            }
          } else if (postStoryEnabled) {
            steps.push("post-a-story(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ Post a Story Activate Percentage roll missed — skipping this execution");
          }

        // ── Random Jitter ───────────────────────────────────────────────
        } else if (_tool === 'Random Actions') {
          if (_toolActivated[_tool]) { // pre-rolled above
            tLog("[TRACE] random-actions: start");
            const _jitterFired = await runRandomActionsStep(serial, (msg) => tLog(`  ${msg}`), {
              checkNotificationsPctMin,
              checkNotificationsPctMax,
              checkNotificationsScrollsMin,
              checkNotificationsScrollsMax,
              checkNotificationsClickPctMin,
              checkNotificationsClickPctMax,
              visitProfilePctMin,
              visitProfilePctMax,
              visitSavedPctMin,
              visitSavedPctMax,
              visitSettingsPctMin,
              visitSettingsPctMax,
              appSwitchPctMin,
              appSwitchPctMax,
              updateProfilePicEnabled: updateProfilePicActivatePctMax > 0 || updateProfilePicActivatePctMin > 0,
              updateProfilePicFolderPath: _updateProfilePicFolderPath,
              updateProfilePicAlterationEnabled,
              updateProfilePicAlterationLevel,
              updateProfilePicImageSettingsEnabled,
              updateProfilePicImageSettings,
              updateProfilePicFixAiSlop,
              updateProfilePicMetadataCleanup,
              updateProfilePicFrequencyDisruption,
              updateProfilePicDisableAfterUsed,
              updateBioActivatePctMin,
              updateBioActivatePctMax,
              updateBioText,
              updateBioDisableAfterUsed,
              slotIdx,
            }, async (kind) => {
              if (kind === "profile" && updateProfilePicDisableAfterUsed) {
                try {
                  const _cfg = loadInstanceConfigs();
                  const _slotKey = slotAutomationKey(serial, slotIdx);
                  const _existing = _cfg[serial]?.slotAutomation?.[_slotKey]
                    ?? _cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
                  _cfg[serial] = {
                    ..._cfg[serial],
                    slotAutomation: {
                      ..._cfg[serial]?.slotAutomation,
                      [_slotKey]: { ..._existing, updateProfilePicActivatePctMin: 0, updateProfilePicActivatePctMax: 0 },
                    },
                  };
                  saveInstanceConfigs(_cfg);
                } catch { /* best effort */ }
              }
              if (kind === "bio" && updateBioDisableAfterUsed) {
                try {
                  const _cfg = loadInstanceConfigs();
                  const _slotKey = slotAutomationKey(serial, slotIdx);
                  const _existing = _cfg[serial]?.slotAutomation?.[_slotKey]
                    ?? _cfg[serial]?.slotAutomation?.[String(slotIdx)] ?? {};
                  _cfg[serial] = {
                    ..._cfg[serial],
                    slotAutomation: {
                      ..._cfg[serial]?.slotAutomation,
                      [_slotKey]: { ..._existing, updateBioActivatePctMin: 0, updateBioActivatePctMax: 0 },
                    },
                  };
                  saveInstanceConfigs(_cfg);
                } catch { /* best effort */ }
              }
            });
            if (!_jitterFired) {
              tLog("▶ Random Actions: activated — both action rolls missed this cycle");
              steps.push("jitter(activated,no-actions-rolled)");
            }
          } else if (randomJitterEnabled) {
            steps.push("jitter(skipped — Activate Percentage roll missed this execution)");
            tLog("▶ Random Actions Activate Percentage roll missed — skipping this execution");
          }
        }

        _toolsRan++;
      } // end tool dispatch loop

      // Flush any remaining spread backup candidates to Surplus so they're
      // available for the next cycle (not lost when none were needed this run).
      if (_sfBackupQueue.length && (_sfSpreadProfileId && _sfSpreadProfileId > 0 || _sfSpreadSlotKey)) {
        const _flushNow = new Date().toISOString();
        storage.addOverspillUsers(_sfBackupQueue.map(u => ({
          profileId: (_sfSpreadProfileId && _sfSpreadProfileId > 0) ? _sfSpreadProfileId : 0,
          phoneSlotKey: (_sfSpreadProfileId && _sfSpreadProfileId > 0) ? "" : _sfSpreadSlotKey,
          instagramUsername: u,
          instagramUserId: "",
          sourceValue: _spreadCandidateSource?.get(u) ?? "surplus",
          sourceType: "phone",
          scrapedAt: _flushNow,
        }))).catch(() => {});
        tLog(`  Spread Follows: flushed ${_sfBackupQueue.length} unused backup candidate(s) to Surplus`);
        _sfBackupQueue = [];
      }
      trace(`cycle-tools-complete count=${_toolSeq.length}`);

      // 5. Close Instagram completely — recents switcher + swipe away, not a
      // force-stop, so the device behaves like a person put it down.
      // If a restart/abort was requested while the tool loop was running, do
      // not let this old worker perform the device-specific left-dismiss
      // gesture after a new cycle has been allowed to take ownership.
      if (isCycleAborted(serial)) throw new Error("cycle-aborted");
      tLog("▶ Closing Instagram…");
      // Resolve dismiss direction: if 'auto', look up the device model in the
      // DEVICE_PROFILES table (one getprop call); otherwise use the stored override.
      // Resolve dismiss direction in priority order:
      //   1. Explicit slot-level override ("left" or "up")
      //   2. Device-prefs override set from My Device tab (still "auto" at slot → check device prefs)
      //   3. Model lookup via DEVICE_PROFILES table
      const devicePrefsForDismiss = (() => {
        try { return loadInstanceConfigs()[serial]?.devicePrefs ?? {}; } catch { return {}; }
      })();
      const effectiveDismiss = dismissDirection !== "auto"
        ? dismissDirection
        : (devicePrefsForDismiss.dismissDirection && devicePrefsForDismiss.dismissDirection !== "auto")
          ? devicePrefsForDismiss.dismissDirection
          : "auto";
      const _rawModel = android.getDeviceModel(serial);
      const resolvedDismissDir: "left" | "up" = effectiveDismiss !== "auto"
        ? effectiveDismiss
        : android.getModelDismissDirection(_rawModel);
      tLog(`  dismiss direction: ${resolvedDismissDir} (slot: ${dismissDirection}, device-pref: ${devicePrefsForDismiss.dismissDirection ?? "none"}, model: "${_rawModel}"`);
      await android.closeInstagramViaRecents(
        serial,
        resolvedDismissDir,
        (msg) => tLog(`  ${msg}`),
        devicePrefsForDismiss.swipeGesture,
      );
      steps.push("closed-instagram");
      tLog("  ✓ Instagram closed");

      // After close, the recents overview is still on screen (we opened it
      // to do the swipe attempt). Press HOME to dismiss it and return to the
      // launcher before sleeping — otherwise the phone locks with recents
      // still showing and the next cycle wakes to an unexpected screen.
      await android.keyevent(serial, 3 /* KEYCODE_HOME */);
      await new Promise(r => setTimeout(r, 600)); // let launcher animate in

      // 6. Cycle airplane mode on, wait, then off — forces a fresh network
      // session on the next run.
      tLog("▶ Airplane mode ON — recycling network…");
      await android.setAirplaneMode(serial, true);
      tLog("  ✓ Airplane mode on — waiting…");
      steps.push("airplane-mode-on");
      const waitLoSec = Math.min(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitHiSec = Math.max(airplaneWaitMinSec, airplaneWaitMaxSec);
      const waitSec = waitLoSec + Math.random() * (waitHiSec - waitLoSec);
      await sleepOrAbort(serial, Math.round(waitSec * 1000));
      tLog("▶ Airplane mode OFF — restoring network…");
      await android.setAirplaneMode(serial, false);
      tLog("  ✓ Airplane mode off — network reconnecting");
      steps.push("airplane-mode-off");

      // 7. Finalise the cycle: close Instagram, recycle the network, then
      // lock the phone ready for the next cycle.
      automationCurrentTool.set(serial, "FINALISING");
      tLog("▶ Finalising — closing Instagram and recycling network…");
      // 7. Swipe up, then press power again to lock the phone — ready for
      // the next cycle to start from a clean, screen-off state.
      await sleepOrAbort(serial, 1500); // let the radios reconnect before touching the screen
      await android.swipeUpFromBottom(serial);
      steps.push("swipe-up");
      {
        const totalLikes = likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes;
        const summary = ` — ${cycleMetricSummary()}`;
        const hasCycleStatistics =
          totalLikes > 0 ||
          followedCount > 0 ||
          storiesWatched > 0 ||
          reelsViewed > 0 ||
          sharesDm > 0 ||
          sharesFeed > 0 ||
          saves > 0 ||
          postsUploaded > 0 ||
          feedScrolled > 0 ||
          exploreScrolled > 0;
        tLog(`Cycle complete ✓${summary}`);
      }
      await android.sleepScreen(serial);
      steps.push("power-off");

      // Persist cycle stats to DB so the Metrics tab survives software restarts.
      // A cycle is only real when at least one tool produced a statistic.
      // Device-flow failures can otherwise reach this cleanup path with every
      // counter at zero and incorrectly increment the cycle total.
      const hasCycleStatistics =
        likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes > 0 ||
        followedCount > 0 ||
        storiesWatched > 0 ||
        reelsViewed > 0 ||
        sharesDm > 0 ||
        sharesFeed > 0 ||
        saves > 0 ||
        postsUploaded > 0 ||
        feedScrolled > 0 ||
        exploreScrolled > 0;
      if (slotUsername && hasCycleStatistics) {
        storage.incrementMobileStats(slotUsername, {
          likes: likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes,
          follows: followedCount,
          stories: storiesWatched,
          reels: reelsViewed,
          dms: sharesDm,
          // "Shares" in Statistics is the combined share-action metric:
          // Share to Feed/Repost plus Share to DMs.
          feedShares: sharesFeed + sharesDm,
          saves,
          cycles: 1,
          feedScrolls: feedScrolled,
          exploreScrolls: exploreScrolled,
        }).catch((e: any) => logger.warn({ err: e }, "[mobile-cycle] stat persist error"));
      }
      // Log cycle completion to Dashboard activity feed.
      // Always log regardless of whether slotUsername matched an EB profile —
      // use profileId 0 as a system sentinel so entries are always visible.
      {
        // Activity details should stamp only tools that actually ran. Do not
        // list disabled tools or percentage-roll misses as if they were used.
        const usedToolSteps = steps.filter((step) => !/\(skipped\b/i.test(step));
        storage.createSessionAction({
          profileId: mobileProfileId ?? 0,
          toolId: 0,
          action: "tool_complete",
          targetUsername: slotUsername || "",
          // Dashboard detail is the compact, non-zero metrics summary. The
          // full tool lifecycle is retained in the live device log.
          detail: dashboardMetricSummary(),
          result: "ok",
          sourceValue: `${serial}:${slotIdx}`,
          sourceType: "phone",
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      res.json({
        ok: true,
        count,
        likes: likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes,
        likeFailures,
        sharesFeed,
        sharesDm,
        storiesWatched,
        followedCount,
        postsUploaded,
        strayNavRecoveries,
        steps,
        executionTrace,
      });
    } catch (e: any) {
      // A device restart can make an in-flight ADB request throw a generic
      // "device offline"/transport error before the next abort checkpoint is
      // reached. The matching abort marker is authoritative for an explicit
      // cycle stop (including the green Restart action), so preserve the
      // partial metrics and Dashboard COMPLETE stamp in that case too.
      const abortRequested =
        automationCycleCurrentId.get(serial) !== undefined &&
        automationCycleAbortedId.get(serial) === automationCycleCurrentId.get(serial);
      const aborted = e?.message === "cycle-aborted" || abortRequested;
      // Emit a log-stream message so the Action Log tab always gets an entry,
      // even when the cycle errors or is aborted before reaching the end.
      {
        const totalLikes = likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes;
        const parts: string[] = [];
        if (followedCount)            parts.push(`${followedCount} follow${followedCount === 1 ? ' done' : 's done'}`);
        if (totalLikes)               parts.push(`${totalLikes} like${totalLikes === 1 ? ' done' : 's done'}`);
        if (storiesWatched)           parts.push(`${storiesWatched} stor${storiesWatched === 1 ? 'ie watched' : 'ies watched'}`);
        if (reelsViewed)              parts.push(`${reelsViewed} reel${reelsViewed === 1 ? ' watched' : 's watched'}`);
        if (sharesDm)                 parts.push(`${sharesDm} DMs`);
        if (sharesFeed)               parts.push(`${sharesFeed} feed shares`);
        if (saves)                    parts.push(`${saves} saved`);
        const summary = ` — ${cycleMetricSummary()}`;
        if (aborted) {
          tLog(`${cycleMetricSummary()} — Cycle aborted`);
        } else {
          tLog(`Cycle failed — ${e?.message ?? "unknown error"}${summary}`);
        }
      }
      // Always stamp COMPLETE so the Dashboard never leaves a dangling STARTED.
      // Accumulate whatever partial stats were collected before the abort/error.
      if (_slotUsername || _mobileProfileId !== null) {
        const totalLikes = likes + storyLikes + exploreLikes + reelsLikes + injectBrowsingLikes;
        const parts: string[] = [];
        if (followedCount) parts.push(`${followedCount} follow${followedCount === 1 ? ' done' : 's done'}`);
        if (totalLikes) parts.push(`${totalLikes} like${totalLikes === 1 ? ' done' : 's done'}`);
        if (storiesWatched) parts.push(`${storiesWatched} stor${storiesWatched === 1 ? 'ie watched' : 'ies watched'}`);
        if (reelsViewed) parts.push(`${reelsViewed} reel${reelsViewed === 1 ? ' watched' : 's watched'}`);
        if (sharesDm) parts.push(`${sharesDm} DMs`);
        if (sharesFeed) parts.push(`${sharesFeed} feed shares`);
        if (saves) parts.push(`${saves} saved`);
        if (postsUploaded) parts.push(`${postsUploaded} post${postsUploaded === 1 ? "" : "s"} uploaded`);
        if (feedScrolled) parts.push(`${feedScrolled} posts scrolled`);
         if (exploreScrolled) parts.push(`${exploreScrolled} Explore scroll${exploreScrolled === 1 ? "" : "s"}`);
        // Aborted cycles are still real cycles for Statistics. Persist the
        // partial counters collected before the abort, including the cycle
        // itself, just as the normal completion path does.
        if (aborted && _slotUsername) {
          await storage.incrementMobileStats(_slotUsername, {
            likes: totalLikes,
            follows: followedCount,
            stories: storiesWatched,
            reels: reelsViewed,
            dms: sharesDm,
            feedShares: sharesFeed + sharesDm,
            saves,
            cycles: 1,
            feedScrolls: feedScrolled,
            exploreScrolls: exploreScrolled,
          }).catch((statError: any) => {
            logger.warn({ err: statError }, "[mobile-cycle] aborted stat persist error");
          });
        }
        storage.createSessionAction({
          profileId: _mobileProfileId ?? 0,
          toolId: 0,
          action: "tool_complete",
          targetUsername: _slotUsername,
           detail: aborted
             ? `${dashboardMetricSummary()} — Cycle aborted`
             : `${dashboardMetricSummary()} — Cycle error: ${e?.message ?? "unknown"}`,
          result: aborted ? "ok" : "error",
          sourceValue: `${serial}:${incomingSlotIdx}`,
          sourceType: "phone",
          timestamp: new Date().toISOString(),
        }).catch(() => {});
      }
      res.status(aborted ? 200 : 400).json({
        ok: aborted,
        aborted,
        error: aborted ? undefined : (e?.message ?? "Automation cycle failed"),
        steps,
        executionTrace,
      });
    } finally {
      automationCycleInProgress.delete(serial);
      automationCycleActiveSlot.delete(serial);
      automationCurrentTool.delete(serial);
      checkFeedInProgress.delete(serial);
      automationCycleCurrentId.delete(serial);
      automationCycleAbortedId.delete(serial);
      // Clear mirror-live when the cycle ends so the farm grid restores the
      // slot wallpaper instead of continuing to poll a stale screencap stream.
      mirrorLive.delete(serial);
    }
  });

  // ── Per-slot metrics (daily + lifetime, persisted across restarts) ───────────
  app.get("/api/mobile/slot-stats", async (req: Request, res: Response) => {
    try {
      const username = String(req.query.username ?? "").trim();
      if (!username) return res.status(400).json({ ok: false, error: "username required" });
      const result = await storage.getMobileSlotStats(username);
      res.json({ ok: true, ...result });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "Failed to load slot stats" });
    }
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

  const instanceConfigSchema = z.object({
    proxyId: z.number().nullable().optional(),
    proxyProtocol: z.enum(["http", "socks5"]).optional(),
  });
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

  // Apply proxy to a running device via a transparent local relay.
  //
  // How it works:
  //   1. Equinox starts a local TCP relay on a random port (0.0.0.0).
  //   2. The relay forwards all CONNECT (HTTPS) and plain HTTP to the real
  //      upstream proxy, injecting Proxy-Authorization automatically.
  //   3. Android's global proxy is pointed at GATEWAY_IP:RELAY_PORT — no
  //      credentials needed from Android's side, so auth stripping is never
  //      an issue.
  //
  // The gateway IP (e.g. 10.0.2.2) is how the Android VM reaches the Windows
  // host. We detect it from the device's default route so it works for both
  // AVD and BlueStacks without hardcoding anything.
  // Check the external IP seen through the device's assigned proxy (server-side test).
  app.get("/api/mobile/devices/:serial/check-ip", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId;
      if (!proxyId) return res.status(400).json({ ok: false, error: "No proxy assigned to this device" });

      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ ok: false, error: "Proxy not found" });

      const ip = await fetchExternalIpViaProxy(
        proxy.host, proxy.port,
        proxy.username ?? undefined,
        proxy.password ?? undefined,
      );
      res.json({ ok: true, ip, proxy: `${proxy.host}:${proxy.port}` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "IP check failed" });
    }
  });

  // Apply the saved proxy to a running Android device via a host-side relay.
  //
  // Why a relay instead of setting http_proxy directly?
  //   Android's `settings put global http_proxy` only accepts "host:port" — it
  //   cannot carry credentials.  Authenticated proxies silently fail (407) and
  //   apps fall back to a direct connection.  We start a local TCP relay that
  //   forwards traffic to the real upstream and injects Proxy-Authorization
  //   automatically.  Android is pointed at gateway_ip:relay_port (no creds).
  app.post("/api/mobile/devices/:serial/apply-proxy", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId ?? null;
      if (!proxyId) {
        proxyRelay.stopRelayForDevice(serial);
        await android.setDeviceProxy(serial, null);
        return res.json({ ok: true, message: "Proxy cleared on device" });
      }
      const proxies = await storage.getProxies();
      const proxy = proxies.find(pr => pr.id === proxyId);
      if (!proxy) return res.status(404).json({ ok: false, error: "Proxy not found" });

      // Start (or restart) the local relay on 127.0.0.1 (localhost only)
      const relayPort = await proxyRelay.startRelay(serial, {
        host: proxy.host,
        port: proxy.port,
        user: proxy.username ?? undefined,
        pass: proxy.password ?? undefined,
      });

      // Register adb reverse so Android's localhost:relayPort tunnels through
      // the ADB connection to the host relay — no Windows Firewall rules needed.
      android.adbReverse(serial, relayPort);

      // Point Android at its own loopback — the ADB tunnel does the rest
      await android.setDeviceProxy(serial, { host: "127.0.0.1", port: relayPort });

      res.json({ ok: true, message: `Relay (adb reverse :${relayPort}) → ${proxy.host}:${proxy.port} applied` });
    } catch (e: any) {
      res.status(500).json({ ok: false, error: e?.message ?? "Apply proxy failed" });
    }
  });

  // Save proxy assignment for a device (no relay — user configures proxy directly in LD Player)
  const deviceProxySchema = z.object({ proxyId: z.number().nullable() });
  app.post("/api/mobile/devices/:serial/proxy", async (req: Request, res: Response) => {
    try {
      const input = deviceProxySchema.parse(req.body);
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      cfg[serial] = { ...cfg[serial], proxyId: input.proxyId ?? null };
      saveInstanceConfigs(cfg);
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

  app.post("/api/mobile/devices/:serial/instagram/install-from-play", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const result = await android.installInstagramFromPlayStore(serial);
      res.json(result);
      if (result.ok) {
        android.pullAndCacheInstalledApk(serial).catch((e: any) =>
          logger.warn({ err: e }, "[mobile] background APK cache pull failed"),
        );
      }
    } catch (e: any) {
      res.status(500).json({ ok: false, steps: [], error: e?.message ?? "Failed" });
    }
  });

  app.get("/api/mobile/instagram-apk-cache", (_req: Request, res: Response) => {
    const cachePath = android.getCachedApkPath();
    if (fs.existsSync(cachePath)) {
      const size = fs.statSync(cachePath).size;
      res.json({ cached: true, size, path: cachePath });
    } else {
      res.json({ cached: false });
    }
  });

  app.post("/api/mobile/devices/:serial/instagram/install-cached", async (req: Request, res: Response) => {
    try {
      await android.installFromCachedApk(p(req, "serial"));
      res.json({ ok: true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Cached install failed" });
    }
  });

  const signupSchema = z.object({ email: z.string().email() });
  app.post("/api/mobile/devices/:serial/instagram/signup", async (req: Request, res: Response) => {
    try {
      const { email } = signupSchema.parse(req.body);
      const result = await android.instagramSignup(p(req, "serial"), email);
      res.json(result);
    } catch (e: any) {
      res.status(400).json({ ok: false, steps: [], error: e?.message ?? "Failed" });
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

  // Native mirror Paste: the desktop clipboard value is loaded into the
  // device clipboard, then Android's real paste key is dispatched. This is
  // deliberately separate from input/text and must never fall back to
  // character-by-character typing.
  app.post("/api/mobile/devices/:serial/input/clipboard-paste", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      const serial = p(req, "serial");
      await android.setClipboard(serial, input.text);
      await android.pasteClipboard(serial);
      res.json({ ok: true, method: "native-clipboard-paste" });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? "Clipboard paste failed" });
    }
  });

  // Manual mirror "tap to type" sends characters through the saved
  // per-device keyboard calibration map. The field to receive the text is
  // intentionally not selected here: the user taps/focuses it in the mirror,
  // then presses one of the desktop-side field buttons.
  app.post("/api/mobile/devices/:serial/input/type-calibrated", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      const serial = p(req, "serial");
      req.log.info({ serial, characterCount: input.text.length }, "[mirror-calibrated-type] starting");
      const result = await android.typeViaSavedCalibrationMap(serial, input.text, effectiveTypingProfile(serial), message => {
        req.log.info({ serial, message }, "[mirror-calibrated-type]");
      });
      if (!result.ok) {
        return void res.status(422).json({
          ok: false,
          calibrated: result.available,
          missing: result.missing,
          error: result.available
            ? "Saved keyboard calibration is missing one or more requested keys"
            : "No saved keyboard calibration map for this device",
        });
      }
      res.json({ ok: true, calibrated: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Account phone-number entry is a normal calibrated keyboard operation.
  // Keep it on an explicit route so it can never be confused with the
  // Instagram 2FA keypad route below, which uses the separate `2fa:*` map.
  app.post("/api/mobile/devices/:serial/input/type-phone-number-calibrated", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      if (!/^[0-9+().\-\s]+$/.test(input.text)) {
        return void res.status(400).json({ ok: false, error: "Phone number contains unsupported characters" });
      }
      const serial = p(req, "serial");
      req.log.info({ serial, characterCount: input.text.length }, "[mirror-phone-number-calibrated] starting");
      const result = await android.typeViaSavedCalibrationMap(
        serial,
        input.text,
        effectiveTypingProfile(serial),
        message => req.log.info({ serial, message }, "[mirror-phone-number-calibrated]"),
        { disableHumanErrors: true, debugLabel: "phone-number-regular-keyboard" },
      );
      if (!result.ok) {
        return void res.status(422).json({
          ok: false,
          calibrated: result.available,
          missing: result.missing,
          error: result.available
            ? "Regular keyboard calibration is missing one or more phone-number keys"
            : "No saved regular keyboard calibration map for this device",
        });
      }
      res.json({ ok: true, calibrated: true, keyboard: "regular" });
    } catch (e: any) {
      res.status(400).json({ ok: false, error: e?.message ?? "Phone-number typing failed" });
    }
  });

  app.post("/api/mobile/devices/:serial/input/type-2fa-calibrated", async (req: Request, res: Response) => {
    try {
      const input = inputTextSchema.parse(req.body);
      const serial = p(req, "serial");
      const result = await android.typeViaSaved2faKeypad(serial, input.text, effectiveTypingProfile(serial), message => {
        req.log.info({ serial, message }, "[mirror-2fa-keypad]");
      });
      if (!result.ok) return void res.status(422).json({
        ok: false, calibrated: result.available, missing: result.missing,
        error: result.available ? "2FA keypad calibration is missing one or more digits" : "No saved calibration map for this device",
      });
      res.json({ ok: true, calibrated: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // videoW/videoH are optional: the client's decoded video frame size at the
  // moment it computed x/y. screenrecord may stream at a downscaled size
  // relative to the device's real screen (see comment in the video WS route
  // above), so if the client's video size doesn't match the device's actual
  // `wm size`, we rescale x/y into real device pixels before tapping —
  // otherwise every tap silently lands on the wrong spot.
  const tapSchema = z.object({
    x: z.number(),
    y: z.number(),
    videoW: z.number().optional(),
    videoH: z.number().optional(),
  });
  // Android's virtual-display capture (what `screenrecord` records against)
  // NEVER stretches the source display to fill a differently-shaped output
  // buffer — SurfaceFlinger's display projection preserves the source
  // aspect ratio and pads the rest of the buffer with black (letterboxed if
  // the buffer is relatively taller, pillarboxed if it's relatively wider).
  // That means when the video buffer's own aspect ratio doesn't match the
  // device's real `wm size` ratio, the real screen content only occupies a
  // centered sub-rectangle of the buffer — the remaining border is dead
  // encoder padding, not scaled-down real content.
  //
  // A naive `x/videoW*realW` scale (the previous implementation) treats the
  // WHOLE buffer, padding included, as if it linearly covered the whole real
  // screen. That is correct at the padded axis's center (padding is
  // symmetric, so the middle lines up) but increasingly wrong the further a
  // tap is from that center — exactly the "accurate in the middle, off near
  // the edges" pattern reported after [1.1.558] (videoW×videoH 720×1280 vs.
  // device 1080×2460 on the affected hardware: those ratios differ by ~22%,
  // so the padded axis alone accounts for a very real, very visible offset
  // that grows toward the padded edges). Compute the actual content
  // sub-rect within the buffer first, then scale relative to THAT.
  function videoContentRect(videoW: number, videoH: number, realW: number, realH: number): { x: number; y: number; w: number; h: number } {
    const videoRatio = videoW / videoH;
    const deviceRatio = realW / realH;
    if (Math.abs(videoRatio - deviceRatio) / deviceRatio < 0.005) {
      return { x: 0, y: 0, w: videoW, h: videoH };
    }
    if (videoRatio > deviceRatio) {
      // Buffer is relatively wider than the device screen — pillarboxed
      // (dead columns) left/right; real content spans the full buffer height.
      const w = videoH * deviceRatio;
      return { x: (videoW - w) / 2, y: 0, w, h: videoH };
    }
    // Buffer is relatively taller than the device screen — letterboxed
    // (dead rows) top/bottom; real content spans the full buffer width.
    const h = videoW / deviceRatio;
    return { x: 0, y: (videoH - h) / 2, w: videoW, h };
  }

  // Shared by /input/tap and /input/double-tap — the mirrored video frame is
  // often downscaled (and, per videoContentRect above, letterboxed/
  // pillarboxed) relative to the device's real resolution, so tap
  // coordinates captured against the video's pixel size need rescaling
  // through the real content sub-rect before they're sent to adb.
  function rescaleForDevice(serial: string, x: number, y: number, videoW?: number, videoH?: number): { x: number; y: number; rescaled: boolean; video: [number,number]; device: [number,number]; from: [number,number]; to: [number,number] } {
    const noOp = { x, y, rescaled: false, video: [videoW ?? 0, videoH ?? 0] as [number,number], device: [0,0] as [number,number], from: [x,y] as [number,number], to: [x,y] as [number,number] };
    if (!videoW || !videoH) return noOp;
    try {
      const tools = android.detectToolset();
      const adbPath = tools.adb.path;
      if (!adbPath) return noOp;
      const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
      const out = wm.stdout ?? "";
      // `wm size` can print BOTH a "Physical size" and an "Override size"
      // line when a display-size override is active (e.g. a prior
      // testing/scaling change). Touch input is interpreted against the
      // CURRENT logical size, which is the override when one is set — not
      // the physical panel resolution. Picking the first match (always
      // "Physical size") when an override was active meant every rescaled
      // tap was proportionally off from the true target, growing with
      // distance from the top-left corner — exactly the "tap the left edge
      // of a key = correct, tap its centre = lands one key over" pattern
      // reported on this device. Prefer Override size when present.
      const overrideM = out.match(/Override size:\s*(\d+)x(\d+)/);
      const physicalM = out.match(/Physical size:\s*(\d+)x(\d+)/);
      const m = overrideM ?? physicalM ?? out.match(/(\d+)x(\d+)/);
      if (!m) return noOp;
      const realW = parseInt(m[1]);
      const realH = parseInt(m[2]);
      const device: [number,number] = [realW, realH];
      if (realW === videoW && realH === videoH) return { ...noOp, device };
      // NOTE: a previous version of this function skipped rescaling whenever
      // the video and device aspect ratios differed by more than 2%, on the
      // theory that a mismatched AR meant `wm size` was reporting an
      // incompatible coordinate space (e.g. the physical panel resolution
      // instead of the logical input space) and that raw video coordinates
      // must already be correct. That was wrong and made every manual mirror
      // tap land far from the click (confirmed via Click Test: bullseye vs.
      // yellow dot at completely different spots, "double the size" symptom,
      // taps landing near the middle of the screen for edge taps).
      //
      // The real explanation (see the comment above the screenrecord spawn
      // in this file's video-WS route): `screenrecord` is *never* pinned to
      // the device's exact `wm size` because most panel resolutions aren't
      // 16-pixel-aligned, so screenrecord silently picks its own encoder-
      // supported size — which can legitimately have a different aspect
      // ratio than the panel (e.g. video 720×1280 vs. device 1080×2460 on
      // this hardware). That's expected, not a sign of an incompatible
      // coordinate space. `wm size` (Override if present, else Physical) is
      // still the space `adb shell input tap`/uiautomator use — the same
      // space every other tap in this codebase (built from uiautomator
      // bounds) already targets successfully. Independent per-axis scaling
      // from the video's pixel space into that space is correct regardless
      // of whether the two aspect ratios match, as long as the video frame
      // itself isn't letterboxed (screenrecord doesn't add letterbox bars).
      const rect = videoContentRect(videoW, videoH, realW, realH);
      const rx = Math.round(Math.min(realW - 1, Math.max(0, ((x - rect.x) / rect.w) * realW)));
      const ry = Math.round(Math.min(realH - 1, Math.max(0, ((y - rect.y) / rect.h) * realH)));
      logger.info({ serial, from: [x, y], to: [rx, ry], video: [videoW, videoH], real: [realW, realH], contentRect: rect }, "[mobile-tap] rescaled tap for downscaled/letterboxed video");
      return { x: rx, y: ry, rescaled: true, video: [videoW, videoH], device, from: [x, y], to: [rx, ry] };
    } catch { return noOp; }
  }

  app.post("/api/mobile/devices/:serial/input/tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const result = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      // Tag as manual and, when recording, capture the screen state immediately
      // after the tap so the macro export shows what was on screen at each step.
      await android.tap(serial, result.x, result.y, "manual");
      if (sessionRecorder.isRecording(serial)) {
        // Fire async — don't block the tap response (dump takes ~1-2s)
        android.dumpUi(serial)
          .then(xml => { if (xml) sessionRecorder.addDump(serial, xml, "screen after manual tap"); })
          .catch(() => { /* ignore dump errors during macro recording */ });
      }
      res.json({ ok: true, rescaled: result.rescaled, video: result.video, device: result.device, from: result.from, to: result.to });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Manual long-press from the operator holding on the mirrored screen.
  // The standard ADB idiom for a long-press is a zero-distance swipe with a
  // long duration — same as the automation uses in switchToInstagramAccount
  // to open the account switcher.  2000ms is the same duration used there.
  app.post("/api/mobile/devices/:serial/input/longpress", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const result = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.swipe(serial, result.x, result.y, result.x, result.y, 2000);
      res.json({ ok: true, rescaled: result.rescaled, video: result.video, device: result.device, from: result.from, to: result.to });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Account-switcher hold: resolve Instagram's live Profile tab on the
  // currently selected device instead of trusting a mirror-screen coordinate.
  app.post("/api/mobile/devices/:serial/input/profile-tab-longpress", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      logger.info({ serial }, "[manual-account-switch] resolving profile tab before long-press");
      const profileTab = await android.findInstagramProfileTab(serial);
      if (!profileTab) {
        logger.warn({ serial }, "[manual-account-switch] profile tab unavailable; long-press not dispatched");
        res.status(404).json({ error: "Instagram Profile tab was not found in the live accessibility tree" });
        return;
      }
      logger.info({ serial, profileTab }, "[manual-account-switch] profile target resolved; dispatching long-press");
      await android.swipe(serial, profileTab.x, profileTab.y, profileTab.x, profileTab.y, 2000);
      logger.info({ serial, profileTab }, "[manual-account-switch] long-press dispatched");
      res.json({ ok: true, dispatched: true, target: "profile-tab", node: profileTab });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Profile-tab long-press failed" });
    }
  });

  // Manual double-tap (like) from the operator clicking the mirrored screen
  // twice — must go through the same single-adb-call `doubleTap` used by
  // the automated Check Feed loop. Sending this as two separate
  // `/input/tap` requests (the old behavior) reintroduces the exact
  // latency bug that broke double-tap-to-like: each request is its own
  // adb round-trip, and by the time the second tap lands Instagram's
  // double-tap gesture window has already closed.
  app.post("/api/mobile/devices/:serial/input/double-tap", async (req: Request, res: Response) => {
    try {
      const input = tapSchema.parse(req.body);
      const serial = p(req, "serial");
      const result = rescaleForDevice(serial, input.x, input.y, input.videoW, input.videoH);
      await android.doubleTap(serial, result.x, result.y);
      res.json({ ok: true, rescaled: result.rescaled, video: result.video, device: result.device, from: result.from, to: result.to });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // Debug-only: dump the current accessibility tree (resource-ids,
  // content-desc, bounds) for whatever screen is showing. Used to find the
  // *real* selectors for elements (e.g. story tray bubbles) instead of
  // guessing tap coordinates from screen percentages, which has repeatedly
  // landed on the wrong element.
  app.get("/api/mobile/devices/:serial/ui-dump", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      res.type("text/plain").send(xml || "(empty dump)");
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Session Recorder ─────────────────────────────────────────────────────
  // Records every tap, log line, and uiautomator dump XML so the full
  // automation → Instagram → outcome chain is captured in one export file.

  app.post("/api/mobile/devices/:serial/session-recorder/start", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      android.resetDebugCaptures(serial);
      const queues = new Map<string, Promise<void>>();
      sessionRecorder.setScreenshotCapture((captureSerial, ts, label) => {
        const previous = queues.get(captureSerial) ?? Promise.resolve();
        const next = previous
          .catch(() => {})
          .then(async () => {
            const file = await android.captureDebugScreenshot(captureSerial, ts, label);
            if (file) sessionRecorder.addScreenshot(captureSerial, ts, file, label);
          })
          .finally(() => {
            if (queues.get(captureSerial) === next) queues.delete(captureSerial);
          });
        queues.set(captureSerial, next);
      });
      sessionRecorder.start(serial);
      logger.info({ serial }, "[session-recorder] recording started");
      res.json({ ok: true, recording: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/session-recorder/stop", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      sessionRecorder.stop(serial);
      const st = sessionRecorder.status(serial);
      logger.info({ serial, eventCount: st.eventCount }, "[session-recorder] recording stopped");
      res.json({ ok: true, recording: false, eventCount: st.eventCount });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.get("/api/mobile/devices/:serial/session-recorder/status", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      res.json(sessionRecorder.status(serial));
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  /** Download as JSON — includes full uiautomator XML for every dump. */
  app.get("/api/mobile/devices/:serial/session-recorder/export.json", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const json = sessionRecorder.exportJson(serial);
      if (!json) { res.status(404).json({ error: "No recording for this device" }); return; }
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="equinox-session-${serial}-${Date.now()}.json"`);
      res.send(json);
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  /** Download as a self-contained HTML report — human readable, no dependencies. */
  app.get("/api/mobile/devices/:serial/session-recorder/export.html", (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const html = sessionRecorder.exportHtml(serial);
      if (!html) { res.status(404).json({ error: "No recording for this device" }); return; }
      res.setHeader("Content-Type", "text/html");
      res.setHeader("Content-Disposition", `attachment; filename="equinox-session-${serial}-${Date.now()}.html"`);
      res.send(html);
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // General-purpose screen layout scanner.  Reads the full accessibility
  // tree for whatever is on screen right now, groups every element with a
  // real (non-zero) bounding box into three vertical zones, and returns
  // human-readable lines including pixel coordinates AND screen-percentage
  // equivalents.  Paste the log output to the developer when implementing
  // any new gesture/tap feature — avoids coordinate-guessing entirely.
  //
  // Crucially: includes elements with NO text/desc/id (Instagram's story
  // bubbles, for example, are completely anonymous in the accessibility
  // tree) — we still report their bounds so the developer can see where
  // they sit on screen.
  app.get("/api/mobile/devices/:serial/screen-layout-scan", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      if (!xml || xml.length < 200) {
        res.json({ ok: false, lines: ["(empty dump — is the phone awake and unlocked?)"] });
        return;
      }

      const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W = rootM ? parseInt(rootM[1]) : 0;
      const H = rootM ? parseInt(rootM[2]) : 0;
      if (!W || !H) {
        res.json({ ok: false, lines: ["Could not read screen size from dump — try again."] });
        return;
      }

      const pct = (v: number, dim: number) => `${((v / dim) * 100).toFixed(1)}%`;

      interface Elem {
        x1: number; y1: number; x2: number; y2: number;
        cx: number; cy: number;
        cls: string; rid: string; cd: string; txt: string; clickable: boolean;
      }
      const elems: Elem[] = [];

      const nodeRe = /<node\s([^/\n>]+)\s*\/>/g;
      let m: RegExpExecArray | null;
      while ((m = nodeRe.exec(xml)) !== null) {
        const attrs = m[1];
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const [x1, y1, x2, y2] = [bm[1], bm[2], bm[3], bm[4]].map(Number);
        // Skip zero-size nodes (invisible / layout containers only)
        if (x2 - x1 < 4 || y2 - y1 < 4) continue;
        const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; };
        elems.push({
          x1, y1, x2, y2,
          cx: Math.floor((x1 + x2) / 2),
          cy: Math.floor((y1 + y2) / 2),
          cls:       get("class").replace(/^.*\./, ""),
          rid:       get("resource-id").replace(/^[^/]+\//, ""),
          cd:        get("content-desc"),
          txt:       get("text"),
          clickable: get("clickable") === "true",
        });
      }

      // Sort by vertical position then horizontal
      elems.sort((a, b) => a.cy - b.cy || a.cx - b.cx);

      const lines: string[] = [];
      lines.push(`══ SCREEN LAYOUT SCAN ══  ${W}×${H} px  |  ${elems.length} elements`);
      lines.push(`   Send this to your developer before implementing any tap/swipe.`);

      const zones = [
        { label: "TOP    (0 – 33%)",    min: 0,          max: Math.round(H * 0.33) },
        { label: "MIDDLE (33 – 67%)",   min: Math.round(H * 0.33), max: Math.round(H * 0.67) },
        { label: "BOTTOM (67 – 100%)",  min: Math.round(H * 0.67), max: H },
      ];

      for (const zone of zones) {
        const group = elems.filter(e => e.cy >= zone.min && e.cy < zone.max);
        lines.push("");
        lines.push(`── ${zone.label}  (${group.length} elements) ─────────────────────`);
        if (group.length === 0) { lines.push("   (none)"); continue; }
        for (const e of group) {
          const tag  = e.clickable ? "●" : "○"; // ● = tappable
          const label = [e.rid, e.cd, e.txt].filter(Boolean).join(" | ") || "(no label)";
          lines.push(`  ${tag} center=(${e.cx}, ${e.cy})  [${pct(e.cx,W)}, ${pct(e.cy,H)}]  ${e.cls}`);
          lines.push(`     bounds=[${e.x1},${e.y1}][${e.x2},${e.y2}]  ${label}`);
        }
      }

      lines.push("");
      lines.push(`● = clickable element  ○ = container/label`);
      res.json({ ok: true, lines, screenW: W, screenH: H });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Inspect All Nodes ─────────────────────────────────────────────────────
  // Returns every node in the current UI dump so the frontend can do all
  // hover hit-testing client-side — one fetch on inspect-mode entry, zero
  // server calls on hover (Chrome-DevTools F12 style).
  app.get("/api/mobile/devices/:serial/inspect-all-nodes", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const { xml, imeIncluded } = await android.dumpUiWithIme(serial);
      if (!xml || xml.length < 200) {
        res.json({ ok: false, nodes: [], error: "Empty dump — is the phone awake and unlocked?" });
        return;
      }
      const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W = rootM ? parseInt(rootM[1]) : 0;
      const H = rootM ? parseInt(rootM[2]) : 0;
      interface AllNode {
        index: number; cls: string; resourceId: string; contentDesc: string; text: string;
        bounds: string; boundsRaw: [number,number,number,number];
        center: { x: number; y: number }; clickable: boolean; area: number;
      }
      const nodes: AllNode[] = [];
      const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
      let m2: RegExpExecArray | null;
      let idx = 0;
      while ((m2 = nodeRe.exec(xml)) !== null) {
        const attrs = m2[1];
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const [x1, y1, x2, y2] = [bm[1], bm[2], bm[3], bm[4]].map(Number);
        if (x2 - x1 < 2 || y2 - y1 < 2) continue;
        const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; };
        nodes.push({
          index: idx++,
          cls:         get("class").replace(/^.*\./, ""),
          resourceId:  get("resource-id").replace(/^[^/]+\//, ""),
          contentDesc: get("content-desc"),
          text:        get("text"),
          bounds:      `[${x1},${y1}][${x2},${y2}]`,
          boundsRaw:   [x1, y1, x2, y2],
          center:      { x: Math.round((x1+x2)/2), y: Math.round((y1+y2)/2) },
          clickable:   get("clickable") === "true",
          area:        (x2-x1) * (y2-y1),
        });
      }
      res.json({ ok: true, nodes, screenW: W, screenH: H, imeIncluded });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  // ── Screenshot capture (base64 PNG) ──────────────────────────────────────
  // Returns a single full-resolution screenshot as a base64 data URI.
  // Used by the Scan tab in the element inspector: the image is displayed in
  // the browser with UIAutomator node bounds overlaid as SVG rectangles, so
  // the user can visually identify custom-drawn elements that have no
  // accessibility node and pin them with a name for the developer's index.
  app.get("/api/mobile/devices/:serial/screencap-base64", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const tools = android.detectToolset();
      if (!tools.adb.found || !tools.adb.path) { res.status(503).json({ ok: false, error: "adb not found" }); return; }
      const adbPath = tools.adb.path;
       let frame = await capturePng(adbPath, serial);
      // Strip CRLF line endings that some Windows ADB versions inject
      if (frame.length > 8 && !isPng(frame)) {
        frame = stripCrlf(frame);
      }
      if (!isPng(frame)) {
         res.json({ ok: false, error: `Not a valid PNG (${frame.length} bytes)` });
        return;
      }
      res.json({ ok: true, image: "data:image/png;base64," + frame.toString("base64") });
    } catch (e: any) { res.status(400).json({ ok: false, error: e?.message }); }
  });

  // ── Screencap — raw PNG (for farm-grid thumbnails) ────────────────────────
  // Returns the device screenshot as a raw image/png response so the frontend
  // can use a plain <img> or SVG <image> with a URL instead of embedding a
  // multi-MB base64 data URI in React state.  The ?t= query param is ignored
  // server-side; the client appends a timestamp to bust the browser cache on
  // each poll tick.
  app.get("/api/mobile/devices/:serial/screencap.png", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const tools = android.detectToolset();
      if (!tools.adb.found || !tools.adb.path) { res.status(503).end(); return; }
      const adbPath = tools.adb.path;
       let frame = await capturePng(adbPath, serial);
      if (frame.length > 8 && !isPng(frame)) frame = stripCrlf(frame);
      if (!isPng(frame)) { res.status(502).end(); return; }
      res.set({
        "Content-Type": "image/png",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Content-Length": String(frame.length),
      });
      res.end(frame);
    } catch { res.status(500).end(); }
  });

  // ── Debug screenshots ZIP download ───────────────────────────────────────
  // Returns a ZIP archive containing all saved debug screenshots for this
  // device plus the full server debug log.  Lets devs grab a complete
  // snapshot for offline analysis with a single button click.
  app.get("/api/mobile/devices/:serial/debug-screenshots.zip", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const label  = getDeviceLabel(serial);
      const dir    = path.join(SCREENSHOTS_DIR, label);

      const AdmZip = (await import("adm-zip")).default;
      const zip = new AdmZip();

      // Add all PNGs from the device's screenshot folder (sorted chronologically).
      let screenshotCount = 0;
      if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir).filter(f => f.endsWith(".png")).sort();
        for (const f of files) {
          const buf = fs.readFileSync(path.join(dir, f));
          zip.addFile(`screenshots/${f}`, buf);
          screenshotCount++;
        }
      }

      // Add the server debug log.
      const logPath = (global as any).__SERVER_LOG_PATH as string | undefined;
      if (logPath && fs.existsSync(logPath)) {
        zip.addFile("aura-farming-debug.log", fs.readFileSync(logPath));
      }

      if (screenshotCount === 0 && (!logPath || !fs.existsSync(logPath))) {
        res.status(404).json({ error: "No debug screenshots or log found for this device" });
        return;
      }

      const zipBuf  = zip.toBuffer();
      const filename = `debug-${label}-${Date.now()}.zip`;
      res.set({
        "Content-Type":        "application/zip",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length":      String(zipBuf.length),
      });
      res.end(zipBuf);
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // ── Mirror live state ─────────────────────────────────────────────────────
  // Called by the client when the user presses Power (live → true) or the
  // mirror stops (live → false). Persists across navigation so the farm grid
  // can show the thumbnail even after the user leaves the mirror page.
  app.post("/api/mobile/devices/:serial/mirror-live", (req: Request, res: Response) => {
    const serial = p(req, "serial");
    const { on } = req.body as { on: boolean };
    if (on) mirrorLive.add(serial);
    else    mirrorLive.delete(serial);
    res.json({ ok: true });
  });

  // Returns the set of device serials where the phone mirror is powered on.
  // The farm grid polls this every 2 s to show/hide the live thumbnail overlay.
  app.get("/api/mobile/stream-active", (_req: Request, res: Response) => {
    res.json({ serials: [...mirrorLive] });
  });

  // Returns the set of device serials that currently have an automation cycle
  // running, plus the specific slot index that is active on each device.
  // The farm page polls this every 2 s to:
  //   1. gate the live mirror thumbnail (serial-level check, backward-compat)
  //   2. show "Running" only for the SPECIFIC slot that is executing, not for
  //      every slot on the same physical phone (slot-level check via `slots`)
  app.get("/api/mobile/cycle-active", (_req: Request, res: Response) => {
    const serials = [...automationCycleInProgress];
    const slots = serials.map(serial => ({
      serial,
      slotIdx: automationCycleActiveSlot.get(serial) ?? 0,
    }));
    res.json({ serials, slots });
  });

  // The farm grid uses the same rolling debug buffer as the device detail
  // page, so its current-tool label cannot drift into a separate lifecycle
  // state. Return the latest tool header seen for this device.
  app.get("/api/mobile/devices/:serial/current-tool", (req: Request, res: Response) => {
    const serial = p(req, "serial");
    res.json({ tool: automationCurrentTool.get(serial) ?? null });
  });

  // ── Element Inspector ─────────────────────────────────────────────────────
  // Like Chrome DevTools F12 — click a point on the phone mirror and get back
  // every accessibility node whose bounds contain that point, sorted from most
  // specific (smallest area, innermost element) to least (full-screen root).
  // The frontend uses this in "Inspect mode" so the user can hover/click any
  // element on-screen and immediately see its label, resource-id, and exact
  // pixel bounds without any guesswork.
  const inspectNodeSchema = z.object({ x: z.number(), y: z.number() });
  app.post("/api/mobile/devices/:serial/inspect-node", async (req: Request, res: Response) => {
    try {
      const { x, y } = inspectNodeSchema.parse(req.body);
      const serial = p(req, "serial");
      const xml = await android.dumpUi(serial);
      if (!xml || xml.length < 200) {
        res.json({ ok: false, nodes: [], error: "Empty dump — is the phone awake and unlocked?" });
        return;
      }
      const rootM = xml.match(/bounds="\[0,0\]\[(\d+),(\d+)\]"/);
      const W = rootM ? parseInt(rootM[1]) : 0;
      const H = rootM ? parseInt(rootM[2]) : 0;

      interface InspectNode {
        cls: string; resourceId: string; contentDesc: string; text: string;
        bounds: string; boundsRaw: [number,number,number,number];
        center: { x: number; y: number }; clickable: boolean; area: number;
      }
      const hits: InspectNode[] = [];
      // Match BOTH self-closing <node … /> AND opening <node …> tags (nodes with children).
      // UIAutomator XML uses opening tags for any container that has child nodes — e.g.
      // RecyclerView items, FrameLayouts, gallery tiles — so a self-closing-only regex
      // silently misses every container and returns "no elements" for clickable areas.
      const nodeRe = /<node\s([^>]+?)\s*\/?>/g;
      let m: RegExpExecArray | null;
      while ((m = nodeRe.exec(xml)) !== null) {
        const attrs = m[1];
        const bm = attrs.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!bm) continue;
        const [x1, y1, x2, y2] = [bm[1], bm[2], bm[3], bm[4]].map(Number);
        // Must contain the tapped point
        if (x < x1 || x > x2 || y < y1 || y > y2) continue;
        // Skip zero-size containers
        if (x2 - x1 < 2 || y2 - y1 < 2) continue;
        const get = (attr: string) => { const a = attrs.match(new RegExp(`${attr}="([^"]*)"`)); return a ? a[1] : ""; };
        hits.push({
          cls:         get("class").replace(/^.*\./, ""),
          resourceId:  get("resource-id").replace(/^[^/]+\//, ""),
          contentDesc: get("content-desc"),
          text:        get("text"),
          bounds:      `[${x1},${y1}][${x2},${y2}]`,
          boundsRaw:   [x1, y1, x2, y2],
          center:      { x: Math.round((x1+x2)/2), y: Math.round((y1+y2)/2) },
          clickable:   get("clickable") === "true",
          area:        (x2-x1) * (y2-y1),
        });
      }
      // Smallest area first = most specific (innermost) element at the top
      hits.sort((a, b) => a.area - b.area);
      res.json({ ok: true, nodes: hits, screenW: W, screenH: H, tappedAt: { x, y } });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  const swipeSchema = z.object({
    x1: z.number(),
    y1: z.number(),
    x2: z.number(),
    y2: z.number(),
    durationMs: z.number().optional(),
    videoW: z.number().optional(),
    videoH: z.number().optional(),
  });
  app.post("/api/mobile/devices/:serial/input/swipe", async (req: Request, res: Response) => {
    try {
      const input = swipeSchema.parse(req.body);
      const serial = p(req, "serial");
      let { x1, y1, x2, y2 } = input;
      if (input.videoW && input.videoH) {
        try {
          const tools = android.detectToolset();
          const adbPath = tools.adb.path;
          if (adbPath) {
            const wm = spawnSync(adbPath, ["-s", serial, "shell", "wm", "size"], { encoding: "utf8", timeout: 3000 });
            const m = (wm.stdout ?? "").match(/(\d+)x(\d+)/);
            if (m) {
              const realW = parseInt(m[1]);
              const realH = parseInt(m[2]);
              if (realW !== input.videoW || realH !== input.videoH) {
                // Same content-sub-rect correction as /input/tap (see
                // videoContentRect above) — a naive full-buffer scale is
                // only accurate at the padded axis's center and drifts
                // toward the edges when the video buffer is letterboxed/
                // pillarboxed relative to the device's real aspect ratio.
                const rect = videoContentRect(input.videoW, input.videoH, realW, realH);
                const scale = (v: number, off: number, span: number, real: number) =>
                  Math.round(Math.min(real - 1, Math.max(0, ((v - off) / span) * real)));
                x1 = scale(x1, rect.x, rect.w, realW);
                y1 = scale(y1, rect.y, rect.h, realH);
                x2 = scale(x2, rect.x, rect.w, realW);
                y2 = scale(y2, rect.y, rect.h, realH);
                logger.info({ serial, video: [input.videoW, input.videoH], real: [realW, realH], contentRect: rect }, "[mobile-swipe] rescaled swipe for downscaled/letterboxed video");
              }
            }
          }
        } catch { /* fall back to unscaled coordinates */ }
      }
      await android.swipe(serial, x1, y1, x2, y2, input.durationMs);
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

  // ── Device control shortcuts (My Device tab) ────────────────────────────
  const standbySchema = z.object({ on: z.boolean() });
  app.post("/api/mobile/devices/:serial/standby", async (req: Request, res: Response) => {
    try {
      const { on } = standbySchema.parse(req.body);
      const serial = p(req, "serial");
      if (on) await android.ensureScreenOn(serial);
      else {
        await android.sleepScreen(serial);
        // KEYCODE_SLEEP returns before some OEMs update dumpsys power. Read
        // back briefly so the client never treats a stale optimistic value as
        // the physical device state.
        for (let i = 0; i < 8; i++) {
          const actual = await android.isScreenOn(serial);
          if (actual === false) {
            res.json({ ok: true, on: false });
            return;
          }
          await new Promise(resolve => setTimeout(resolve, 125));
        }
      }
      const actual = await android.isScreenOn(serial);
      res.json({ ok: true, on: actual ?? on });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/reboot", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    try {
      const activeCycleId = automationCycleCurrentId.get(serial);
      if (activeCycleId) automationCycleAbortedId.set(serial, activeCycleId);
      // Keep the cycle lock and abort identity until the worker's finally block
      // runs. Releasing it here lets a new Follow cycle start while this old
      // worker is still unwinding and can still reach the left-dismiss gesture.
      android.rebootDevice(serial);
      res.json({ ok: true, interruptedCycle: Boolean(activeCycleId) });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  // Graceful device restart: stop the active HST cycle first so its partial
  // counters are persisted by the cycle's existing abort path before ADB
  // disappears. Scheduled timers are cleared by the web client for this
  // serial; the server only owns the in-flight cycle/reboot boundary.
  app.post("/api/mobile/devices/:serial/graceful-reboot", async (req: Request, res: Response) => {
    const serial = p(req, "serial");
    try {
      const activeCycleId = automationCycleCurrentId.get(serial);
      if (activeCycleId) automationCycleAbortedId.set(serial, activeCycleId);

      const deadline = Date.now() + 30_000;
      while (automationCycleInProgress.has(serial) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

       const stillRunning = automationCycleInProgress.has(serial);
       if (stillRunning) {
         logger.warn({ serial }, "[graceful-reboot] cycle did not stop within 30 seconds; refusing to reboot");
         res.status(409).json({
           error: "The automation cycle is still stopping. The device was not rebooted.",
           interruptedCycle: Boolean(activeCycleId),
           forcedCleanup: true,
         });
         return;
       }
       // Do not release the server-side cycle lock here. The in-flight worker
       // must finish its abort path first, otherwise a new cycle can overlap
       // its final recents gesture.

       android.rebootDevice(serial);
       // Keep the cycle identity/abort marker until the worker's finally block
       // clears it. If the worker was blocked on ADB and only reaches its catch
       // after the reboot, deleting these markers here makes it look like a
       // generic failure instead of "cycle-aborted", skipping partial metrics.
       // A subsequent cycle start overwrites/clears stale markers safely.
       res.json({ ok: true, interruptedCycle: Boolean(activeCycleId), forcedCleanup: false });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Graceful restart failed" });
    }
  });

  app.get("/api/mobile/devices/:serial/brightness", async (req: Request, res: Response) => {
    try {
      const percent = android.getBrightness(p(req, "serial"));
      res.json({ percent });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const brightnessSchema2 = z.object({ percent: z.number().min(0).max(100) });
  app.post("/api/mobile/devices/:serial/brightness", async (req: Request, res: Response) => {
    try {
      const { percent } = brightnessSchema2.parse(req.body);
      android.setBrightness(p(req, "serial"), percent);
      res.json({ ok: true });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/devices/:serial/airplane-cycle", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const durationSec = 10 + Math.floor(Math.random() * 6);
      await android.setAirplaneMode(serial, true);
      res.json({ ok: true, durationSec });
      setTimeout(() => {
        void android.setAirplaneMode(serial, false);
      }, durationSec * 1000);
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
      const serial = p(req, "serial");
      // Return cached value immediately if we've already read/written it this session
      if (androidIdCache.has(serial)) {
        res.json({ androidId: androidIdCache.get(serial) });
        return;
      }
      const id = await android.getAndroidId(serial);
      if (id) androidIdCache.set(serial, id);
      res.json({ androidId: id });
    } catch (e: any) { res.status(500).json({ error: e?.message }); }
  });

  const androidIdSchema = z.object({ androidId: z.string().regex(/^[0-9a-f]{16}$/, "Must be 16 hex characters") });
  app.post("/api/mobile/devices/:serial/android-id", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const input = androidIdSchema.parse(req.body);
      await android.setAndroidId(serial, input.androidId);
      androidIdCache.set(serial, input.androidId);
      res.json({ ok: true, androidId: input.androidId });
    } catch (e: any) { res.status(400).json({ error: e?.message }); }
  });

  app.post("/api/mobile/android-id/random", (_req: Request, res: Response) => {
    res.json({ androidId: android.randomAndroidId() });
  });

  // ── Device property inspection ─────────────────────────────────────────────
  app.get("/api/mobile/devices/:serial/device-props", async (req: Request, res: Response) => {
    try {
      const props = await android.getDeviceProps(p(req, "serial"));
      res.json(props);
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not read device properties" });
    }
  });

  // ── Device proxy status (what proxy Android itself is configured with) ─────
  app.get("/api/mobile/devices/:serial/proxy-status", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const deviceProxy = await android.getDeviceProxySetting(serial);
      const cfg = loadInstanceConfigs();
      const proxyId = cfg[serial]?.proxyId ?? null;
      let upstreamProxy: string | null = null;
      if (proxyId) {
        const proxies = await storage.getProxies();
        const px = proxies.find(pr => pr.id === proxyId);
        if (px) upstreamProxy = `${px.host}:${px.port}`;
      }
      res.json({ deviceProxy, upstreamProxy, relayActive: !!deviceProxy });
    } catch (e: any) {
      res.status(500).json({ error: e?.message ?? "Could not read device proxy status" });
    }
  });

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
        const tools = android.detectToolset();
        if (tools.adb.path) {
          spawnSync(tools.adb.path, ["disconnect", serial], { encoding: "utf8", timeout: 5000 });
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
        const tools = android.detectToolset();
        if (tools.adb.path) {
          spawnSync(tools.adb.path, ["disconnect", serial], { encoding: "utf8", timeout: 5000 });
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
      // Support legacy key name so existing saved configs are not lost.
      const raw    = all[`collision_scheduler_${serial}`] ?? all[`collision_preventer_${serial}`] ?? null;
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
      }).passthrough().parse(req.body);
      const merged = {
        ...existing,
        ...input,
        ...(input.chrome ? { chrome: { ...(existing.chrome ?? {}), ...input.chrome } } : {}),
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
              shortsLikePctMin, shortsLikePctMax } = z.object({
        app:                  z.enum(["chrome", "googlePlay", "snapchat", "youtube", "whatsapp"]),
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
      await android.swipeUpFromBottom(serial);

      let result: { ok: boolean; steps: string[]; error?: string };

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
      } else {
        // Remaining apps are placeholders — will be implemented individually.
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
