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
import { runAppSwitch as runAppSwitchOperation } from "../mobile/hst/operations/appSwitch";
import { runVisitOwnProfile as runVisitOwnProfileOperation } from "../mobile/hst/operations/visitOwnProfile";
import { runVisitSaved as runVisitSavedOperation } from "../mobile/hst/operations/visitSaved";
import { runVisitSettings as runVisitSettingsOperation } from "../mobile/hst/operations/visitSettings";
import { runCheckNotifications as runCheckNotificationsOperation } from "../mobile/hst/operations/checkNotifications";
import { runCheckDmLoop as runCheckDmLoopOperation } from "../mobile/hst/operations/checkDm";
import { runCheckFeedLoop as runCheckFeedLoopOperation } from "../mobile/hst/operations/viewFeed";
import {
  pickAndOpenRandomStory,
  runViewStoriesFromFeedLoop as runViewStoriesFromFeedLoopOperation,
} from "../mobile/hst/operations/viewStories";
import { runViewExplorePage as runViewExplorePageOperation } from "../mobile/hst/operations/viewExplore";
import { runViewReelsLoop as runViewReelsLoopOperation } from "../mobile/hst/operations/viewReels";
import { runMakePostStep as runMakePostStepOperation } from "../mobile/hst/operations/makePost";
import { runMakePostStoryStep as runMakePostStoryStepOperation } from "../mobile/hst/operations/postStory";
import { runUpdateProfilePicture as runUpdateProfilePictureOperation } from "../mobile/hst/operations/updateProfilePicture";
import { runUpdateBio as runUpdateBioOperation } from "../mobile/hst/operations/updateBio";
import { runRandomActionsStep, type RandomActionsOperationContext } from "../mobile/hst/operations/randomActions";
import { runFollowUsersStep } from "../mobile/hst/operations/follow";
import {
  startSlotCycleNotebook,
  appendSlotCycleNotebook,
  finishSlotCycleNotebook,
  getSlotCycleNotebook,
} from "../mobile/slotCycleNotebook";
import {
  runAccountSwitch,
  runManualProfileTabLongPress,
} from "../mobile/hst/operations/accountSwitch";

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
  storiesRerunChanceMin: number;
  storiesRerunChanceMax: number;
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
type DeviceSlot = { slotId?: string; username: string; password: string; totpSecret?: string; emailAddress?: string; emailPassword?: string; phoneNumber?: string; personality?: DevicePersonality; personalityOverrides?: Partial<DevicePersonality> };
type DeviceAccount = { slots: DeviceSlot[] };
type DeviceSettings = { googlePlayEmail?: string; googlePlayPassword?: string; selectedSimSlot?: number; simPhoneNumbers?: Record<string, string> };
type DevicePrefs = {
  dismissDirection?: "auto" | "left" | "up";
  devicePersonality?: DevicePersonality;
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
type DevicePersonality = {
  engagement: number;
  consumption: number;
  attention: number;
  discovery: number;
  actionVariety: number;
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
const INSTANCE_CONFIG_CACHE_TTL_MS = 250;
let instanceConfigCache: InstanceConfigMap | null = null;
let instanceConfigCacheAt = 0;
function loadInstanceConfigs(): InstanceConfigMap {
  const now = Date.now();
  if (instanceConfigCache && now - instanceConfigCacheAt < INSTANCE_CONFIG_CACHE_TTL_MS) {
    return instanceConfigCache;
  }
  try {
    const raw = fs.readFileSync(configFilePath(), "utf8");
    instanceConfigCache = JSON.parse(raw) as InstanceConfigMap;
  } catch {
    instanceConfigCache = {};
  }
  instanceConfigCacheAt = now;
  return instanceConfigCache;
}
function saveInstanceConfigs(cfg: InstanceConfigMap): void {
  fs.writeFileSync(configFilePath(), JSON.stringify(cfg, null, 2));
  // Keep all same-process callers on the just-persisted object while allowing
  // a short window for the duplicate API workflow to observe external saves.
  instanceConfigCache = cfg;
  instanceConfigCacheAt = Date.now();
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
    storiesRerunChanceMin: z.number().min(0).max(100).default(0),
    storiesRerunChanceMax: z.number().min(0).max(100).default(0),
    viewExploreRerunChanceMin: z.number().min(0).max(100).default(0),
    viewExploreRerunChanceMax: z.number().min(0).max(100).default(0),
    viewReelsRerunChanceMin: z.number().min(0).max(100).default(0),
    viewReelsRerunChanceMax: z.number().min(0).max(100).default(0),
    checkDmRerunChanceMin: z.number().min(0).max(100).default(0),
    checkDmRerunChanceMax: z.number().min(0).max(100).default(0),
    makePostRerunChanceMin: z.number().min(0).max(100).default(0),
    makePostRerunChanceMax: z.number().min(0).max(100).default(0),
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
      storiesRerunChanceMin: 0, storiesRerunChanceMax: 0,
      viewExploreRerunChanceMin: 0, viewExploreRerunChanceMax: 0,
      viewReelsRerunChanceMin: 0, viewReelsRerunChanceMax: 0,
      checkDmRerunChanceMin: 0, checkDmRerunChanceMax: 0,
      makePostRerunChanceMin: 0, makePostRerunChanceMax: 0,
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
  const accountSlotId = (serial: string, slotIdx: number, requestedSlotId?: string): string => {
    if (requestedSlotId && requestedSlotId.length >= 8) {
      const matchingSlot = loadInstanceConfigs()[serial]?.account?.slots?.find(
        slot => slot.slotId === requestedSlotId,
      );
      if (matchingSlot) return requestedSlotId;
    }
    const slot = loadInstanceConfigs()[serial]?.account?.slots?.[slotIdx];
    return typeof slot?.slotId === "string" && slot.slotId.length >= 8
      ? slot.slotId
      : `legacy-index-${slotIdx}`;
  };
  const slotAutomationKey = (serial: string, slotIdx: number, requestedSlotId?: string) =>
    accountSlotId(serial, slotIdx, requestedSlotId);
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
          // slotAutomation also contains stable slotId keys and may retain
          // legacy/out-of-range entries from before the slot split. Startup
          // recovery must never turn those keys into invalid `/slots/N`
          // requests.
          if (!(settings as AutomationSettings).enabled) continue;
          if (!/^(?:0|[1-9]\d*)$/.test(idxStr)) continue;
          const slotIdx = Number(idxStr);
          if (Number.isSafeInteger(slotIdx) && slotIdx < MAX_MOBILE_ACCOUNT_SLOTS) {
            slots.push({ serial, slotIdx });
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
  const MAX_MOBILE_ACCOUNT_SLOTS = 10;
  const parseMobileSlotIndex = (value: unknown): number | null => {
    const raw = String(value ?? "");
    if (!/^(?:0|[1-9]\d*)$/.test(raw)) return null;
    const slotIdx = Number(raw);
    return Number.isSafeInteger(slotIdx) && slotIdx < MAX_MOBILE_ACCOUNT_SLOTS
      ? slotIdx
      : null;
  };
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/automation-state", (req: Request, res: Response) => {
    try {
      const slotIdx = parseMobileSlotIndex(req.params.slotIdx);
      if (slotIdx === null) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const serial = p(req, "serial");
      const requestedSlotId = typeof req.query.slotId === "string" ? req.query.slotId : undefined;
      const cfg = loadInstanceConfigs();
      const saved = cfg[serial]?.slotAutomation?.[slotAutomationKey(serial, slotIdx, requestedSlotId)]
        ?? cfg[serial]?.slotAutomation?.[String(slotIdx)]
        ?? {};
      res.json({ enabled: saved.enabled === true });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to load slot state" });
    }
  });
  app.get("/api/mobile/devices/:serial/slots/:slotIdx/automation-settings", async (req: Request, res: Response) => {
    try {
      const slotIdx = parseMobileSlotIndex(req.params.slotIdx);
      if (slotIdx === null) { res.status(400).json({ error: "Invalid slot index" }); return; }
      const cfg = loadInstanceConfigs();
      const serial = p(req, "serial");
      const requestedSlotId = typeof req.query.slotId === "string" ? req.query.slotId : undefined;
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
        storiesRerunChanceMin: 0, storiesRerunChanceMax: 0,
        viewExploreRerunChanceMin: 0, viewExploreRerunChanceMax: 0,
        viewReelsRerunChanceMin: 0, viewReelsRerunChanceMax: 0,
        checkDmRerunChanceMin: 0, checkDmRerunChanceMax: 0,
        makePostRerunChanceMin: 0, makePostRerunChanceMax: 0,
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
      const saved = cfg[serial]?.slotAutomation?.[slotAutomationKey(serial, slotIdx, requestedSlotId)]
        ?? cfg[serial]?.slotAutomation?.[String(slotIdx)];
      const merged: Record<string, any> = {
        ...defaults,
        ...saved,
        // The background HST runner is mounted outside MobilePage and cannot
        // read the Account Settings panel's React state.  Include the
        // persisted account identity in the per-slot response so a restart
        // preserves both slotIdx and slotUsername in cycle/dashboard events.
        slotId: cfg[serial]?.account?.slots?.[slotIdx]?.slotId ?? "",
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
      const slotIdx = parseMobileSlotIndex(req.params.slotIdx);
      if (slotIdx === null) { res.status(400).json({ error: "Invalid slot index" }); return; }
      const serial = p(req, "serial");
      const cfg = loadInstanceConfigs();
      // Load whatever is already saved for this slot.  For Copy Settings the
      // client only sends the selected fields, so we must merge the partial
      // payload on top of the existing values — not replace everything.
      // Also provide hard-coded fallbacks for the few schema fields that have
      // no zod .default() so a brand-new slot never fails validation.
      const requestedSlotId = typeof req.query.slotId === "string" ? req.query.slotId : undefined;
      const stableKey = slotAutomationKey(serial, slotIdx, requestedSlotId);
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

  const isDevicePersonality = (value: unknown): value is DevicePersonality => {
    if (!value || typeof value !== "object") return false;
    return ["engagement", "consumption", "attention", "discovery", "actionVariety"]
      .every(key => Number.isInteger((value as any)[key]) && (value as any)[key] >= 0 && (value as any)[key] <= 4);
  };
  const randomDevicePersonality = (): DevicePersonality => ({
    engagement: Math.floor(Math.random() * 5),
    consumption: Math.floor(Math.random() * 5),
    attention: Math.floor(Math.random() * 5),
    discovery: Math.floor(Math.random() * 5),
    actionVariety: Math.floor(Math.random() * 5),
  });
  const ensureDevicePersonality = (serial: string, regenerate = false): DevicePersonality => {
    const cfg = loadInstanceConfigs();
    const current = cfg[serial]?.devicePrefs?.devicePersonality;
    if (!regenerate && isDevicePersonality(current)) return current;
    const next = randomDevicePersonality();
    cfg[serial] = {
      ...cfg[serial],
      devicePrefs: { ...cfg[serial]?.devicePrefs, devicePersonality: next },
    };
    saveInstanceConfigs(cfg);
    logger.info({ serial, personality: next, regenerate }, "[device-personality] resolved persistent device profile");
    return next;
  };
  const ensureSlotPersonality = (serial: string, slotIdx: number, regenerate = false): DevicePersonality => {
    const cfg = loadInstanceConfigs();
    const slot = cfg[serial]?.account?.slots?.[slotIdx];
    const current = slot?.personality;
    if (!regenerate && isDevicePersonality(current)) return current;
    const next = randomDevicePersonality();
    if (!slot) return next;
    const slots = [...(cfg[serial]?.account?.slots ?? [])];
    slots[slotIdx] = { ...slots[slotIdx], personality: next };
    cfg[serial] = { ...cfg[serial], account: { slots } };
    saveInstanceConfigs(cfg);
    logger.info({ serial, slotIdx, personality: next, regenerate }, "[slot-personality] resolved persistent account profile");
    return next;
  };
  // Shared mother-code timing with a stable, serial-specific accent.  Keep
  // this deterministic per device so a phone never inherits another phone's
  // gesture geometry or pacing.
  const motherCodeDiagnostics = new Set<string>();
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
    const personality = {
      dwellScale: 0.86 + unit(1) * 0.30,
      pauseScale: 0.82 + unit(2) * 0.36,
      settleScale: 0.82 + unit(3) * 0.36,
      gestureScale: 0.92 + unit(4) * 0.16,
      xBias: Math.round((unit(5) - 0.5) * 36),
      yBias: Math.round((unit(6) - 0.5) * 48),
    };
    if (!motherCodeDiagnostics.has(serial)) {
      motherCodeDiagnostics.add(serial);
      const prefs = loadInstanceConfigs()[serial]?.devicePrefs;
      logger.info({
        serial, personality, hasDevicePrefs: Boolean(prefs),
        hasSwipeGesture: Boolean(prefs?.swipeGesture),
        hasTypingProfile: Boolean(prefs?.typingSpeedProfile),
        hasMotherOverrides: Boolean(prefs?.motherCodeOverrides),
      }, "[mother-code] resolved per-device personality");
    }
    return personality;
  };

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
        regeneratePersonality: z.boolean().optional(),
        devicePersonality: z.object({
          engagement: z.number().int().min(0).max(4),
          consumption: z.number().int().min(0).max(4),
          attention: z.number().int().min(0).max(4),
          discovery: z.number().int().min(0).max(4),
          actionVariety: z.number().int().min(0).max(4),
        }).optional(),
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
          // Keep the full calibrated duration range.  The old 150 ms cap
          // made a saved range such as 400–800 ms become 400–150 ms, which
          // normalized to an intermittently unreliable micro-swipe during
          // Step 3 recents dismissal.
          durationMaxMs: z.number().finite().min(1).max(30000),
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
      const nextPersonality = allowed.regeneratePersonality
        ? ensureDevicePersonality(serial, true)
        : allowed.devicePersonality;
      const { regeneratePersonality: _regeneratePersonality, devicePersonality: _devicePersonality, ...persistedAllowed } = allowed;
      cfg[serial] = {
        ...cfg[serial],
        devicePrefs: {
          ...cfg[serial]?.devicePrefs,
          ...persistedAllowed,
          ...(nextPersonality ? { devicePersonality: nextPersonality } : {}),
          ...(allowed.swipeGesture ? { swipeGesture: allowed.swipeGesture } : {}),
        },
      };
      saveInstanceConfigs(cfg);
      res.json({ ok: true, devicePersonality: cfg[serial].devicePrefs?.devicePersonality ?? null });
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
    personality: z.object({
      engagement: z.number().int().min(0).max(4),
      consumption: z.number().int().min(0).max(4),
      attention: z.number().int().min(0).max(4),
      discovery: z.number().int().min(0).max(4),
      actionVariety: z.number().int().min(0).max(4),
    }).optional(),
    personalityOverrides: z.object({
      engagement: z.number().int().min(0).max(4).optional(),
      consumption: z.number().int().min(0).max(4).optional(),
      attention: z.number().int().min(0).max(4).optional(),
      discovery: z.number().int().min(0).max(4).optional(),
      actionVariety: z.number().int().min(0).max(4).optional(),
    }).optional(),
  });
  const deviceAccountSchema = z.object({
    // No upper-bound cap — users can add as many slots as they need via the UI
    slots: z.array(deviceSlotSchema).min(0),
  });
  const slotPersonalityKey = (serial: string, slotId: string) =>
    `mobile_slot_personality_${serial}_${slotId}`;
  const slotPersonalityOverridesKey = (serial: string, slotId: string) =>
    `mobile_slot_personality_overrides_${serial}_${slotId}`;
  const parseStoredPersonality = (value: string | undefined): DevicePersonality | undefined => {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      return isDevicePersonality(parsed) ? parsed : undefined;
    } catch { return undefined; }
  };
  const parseStoredPersonalityOverrides = (value: string | undefined): Partial<DevicePersonality> | undefined => {
    if (!value) return undefined;
    try {
      const parsed = JSON.parse(value);
      if (!parsed || typeof parsed !== "object") return undefined;
      const allowed = ["engagement", "consumption", "attention", "discovery", "actionVariety"];
      const result: Partial<DevicePersonality> = {};
      for (const key of allowed) {
        if (Number.isInteger(parsed[key]) && parsed[key] >= 0 && parsed[key] <= 4) {
          (result as any)[key] = parsed[key];
        }
      }
      return result;
    } catch { return undefined; }
  };
  const loadSlotPersonalityFromDatabase = async (serial: string, slots: DeviceSlot[]): Promise<DeviceSlot[]> => {
    const settings = await storage.getGlobalSettings();
    return slots.map(slot => {
      if (!slot.slotId) return slot;
      const personality = parseStoredPersonality(settings[slotPersonalityKey(serial, slot.slotId)]);
      const personalityOverrides = parseStoredPersonalityOverrides(
        settings[slotPersonalityOverridesKey(serial, slot.slotId)],
      );
      return {
        ...slot,
        ...(personality ? { personality } : {}),
        ...(personalityOverrides ? { personalityOverrides } : {}),
      };
    });
  };
  const persistSlotPersonalityToDatabase = async (serial: string, slot: DeviceSlot): Promise<void> => {
    if (!slot.slotId) return;
    if (slot.personality && isDevicePersonality(slot.personality)) {
      await storage.setGlobalSetting(slotPersonalityKey(serial, slot.slotId), JSON.stringify(slot.personality));
    }
    if (slot.personalityOverrides && typeof slot.personalityOverrides === "object") {
      await storage.setGlobalSetting(
        slotPersonalityOverridesKey(serial, slot.slotId),
        JSON.stringify(slot.personalityOverrides),
      );
    } else {
      await storage.deleteGlobalSetting(slotPersonalityOverridesKey(serial, slot.slotId));
    }
  };
  const deleteSlotPersonalityFromDatabase = async (serial: string, slotId: string): Promise<void> => {
    await Promise.all([
      storage.deleteGlobalSetting(slotPersonalityKey(serial, slotId)),
      storage.deleteGlobalSetting(slotPersonalityOverridesKey(serial, slotId)),
    ]);
  };
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
  app.get("/api/mobile/devices/:serial/account", async (req: Request, res: Response) => {
    const cfg = loadInstanceConfigs();
    const serial = p(req, "serial");
    const raw = cfg[serial]?.account ?? null;
    const migrated = migrateAccount(raw);
    const hydratedSlots = await loadSlotPersonalityFromDatabase(serial, migrated.slots);
    const hydrated = { ...migrated, slots: hydratedSlots };
    // Persist generated IDs immediately. Otherwise a legacy slot would get
    // a fresh identity on every reload before the UI had a chance to save.
    if (JSON.stringify(raw) !== JSON.stringify(hydrated)) {
      cfg[serial] = { ...cfg[serial], account: hydrated };
      saveInstanceConfigs(cfg);
    }
    res.json(hydrated);
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
      await Promise.all(input.slots.map(slot => persistSlotPersonalityToDatabase(serial, slot)));
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
      const livePersonalityKeys = new Set(
        input.slots.flatMap(slot => slot.slotId ? [
          slotPersonalityKey(serial, slot.slotId),
          slotPersonalityOverridesKey(serial, slot.slotId),
        ] : []),
      );
      await Promise.all(
        Object.keys(allSettings)
          .filter(key =>
            (key.startsWith(`mobile_slot_personality_${serial}_`) ||
             key.startsWith(`mobile_slot_personality_overrides_${serial}_`)) &&
            !livePersonalityKeys.has(key),
          )
          .map(key => storage.deleteGlobalSetting(key)),
      );
      res.json({ ok: true, account: input });
    } catch (e: any) { res.status(400).json({ error: e?.message ?? "Failed to save the account" }); }
  });

  app.post("/api/mobile/devices/:serial/slots/:slotIdx/personality", async (req: Request, res: Response) => {
    try {
      const serial = p(req, "serial");
      const slotIdx = Number(req.params.slotIdx);
      if (!Number.isInteger(slotIdx) || slotIdx < 0) {
        res.status(400).json({ error: "Invalid slot index" });
        return;
      }
      const parsed = z.object({
        regenerate: z.boolean().optional(),
        slotId: z.string().min(8).max(100).optional(),
        personality: z.object({
          engagement: z.number().int().min(0).max(4),
          consumption: z.number().int().min(0).max(4),
          attention: z.number().int().min(0).max(4),
          discovery: z.number().int().min(0).max(4),
          actionVariety: z.number().int().min(0).max(4),
        }).optional(),
      }).refine(value => value.regenerate || value.personality, "Personality is required").parse(req.body);
      const cfg = loadInstanceConfigs();
      const slots = [...(cfg[serial]?.account?.slots ?? [])];
      // Prefer the stable identity, but tolerate a stale account save from
      // the UI by falling back to the visible position. The Personality
      // action must not fail just because the account credentials and slot
      // metadata were saved in separate debounced requests.
      let requestedSlotIdx = parsed.slotId
        ? slots.findIndex(slot => slot.slotId === parsed.slotId)
        : -1;
      if (requestedSlotIdx < 0 && slots[slotIdx]) requestedSlotIdx = slotIdx;
      // A newly rendered slot can briefly exist in the UI before its account
      // save reaches disk. Create only that empty slot record, preserving the
      // requested stable ID; the normal account save will fill its fields.
      if (requestedSlotIdx < 0 && slots.length === 0 && parsed.slotId) {
        requestedSlotIdx = slotIdx;
        slots[requestedSlotIdx] = { slotId: parsed.slotId, username: "", password: "" };
      }
      if (requestedSlotIdx < 0 || !slots[requestedSlotIdx]) {
        logger.warn({ serial, slotIdx, requestedSlotId: parsed.slotId, savedSlotCount: slots.length }, "[slot-personality] account slot unavailable");
        res.status(404).json({ error: "Account slot not found; save the account slot first and try again" });
        return;
      }
      const personality = parsed.regenerate
        ? randomDevicePersonality()
        : parsed.personality!;
      slots[requestedSlotIdx] = {
        ...slots[requestedSlotIdx],
        personality,
        ...(parsed.regenerate ? { personalityOverrides: {} } : {}),
      };
      cfg[serial] = { ...cfg[serial], account: { slots } };
      saveInstanceConfigs(cfg);
      await persistSlotPersonalityToDatabase(serial, slots[requestedSlotIdx]);
      logger.info({ serial, slotIdx: requestedSlotIdx, slotId: parsed.slotId, personality, regenerate: Boolean(parsed.regenerate) }, "[slot-personality] saved");
      res.json({ ok: true, personality });
    } catch (e: any) {
      res.status(400).json({ error: e?.message ?? "Failed to save slot personality" });
    }
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
        `mobile_slot_personality_${serial}_`,
        `mobile_slot_personality_overrides_${serial}_`,
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
  // The cycle payload is the complete execution settings object plus a small
  // amount of cycle/slot metadata. Keep this boundary permissive so newly
  // added HST settings are preserved and validated by the settings schema
  // when they are loaded, rather than failing because this route's metadata
  // schema was not updated in lockstep.
  const automationCycleSchema = z.object({
    cycleId: z.string().min(1),
    slotId: z.string().min(1),
    slotIdx: z.number().int().min(0).optional(),
    slotUsername: z.string().optional(),
    count: z.number().int().min(1).max(50),
  }).passthrough();
  const checkFeedInProgress = new Set<string>();
  // Shared cycle state used by the automation-cycle route, status polling,
  // mirror gating, and graceful shutdown handling.
  const automationCycleInProgress = new Set<string>();
  // Tracks the account slot currently executing on each device. This is
  // shared by the cycle runner and the lightweight status endpoint so the
  // account list can show Running on the correct slot.
  const automationCycleActiveSlot = new Map<string, number>();

  // Per-cycle abort tracking.  Each new cycle is assigned a random ID that is
  // passed by the frontend in both the cycle POST body and the abort POST body.
  // The abort endpoint only sets the flag when the supplied ID matches the ID
  // of the cycle that is currently running, so a stale abort POST that arrives
  // after the next cycle has already started cannot kill the new cycle.
  const automationCycleCurrentId  = new Map<string, string>(); // serial → running cycle ID
  const automationCycleAbortedId  = new Map<string, string>(); // serial → ID that was aborted
  // Current tool label for each active device cycle. This is read by the
  // lightweight status endpoint and cleared with the cycle state in finally.
  // Keep it in the same route-local registry as the other cycle maps so every
  // cycle/status path shares one authoritative value.
  const automationCurrentTool = new Map<string, string>(); // serial → current tool label
  // Tracks which Instagram account (username) was last successfully active on
  // each device. Used to skip the account-switcher tap sequence when the same
  // slot runs back-to-back — avoids a visually-identical long-press every cycle.
  const automationLastActiveUsername = new Map<string, string>(); // serial → last active username
  const automationPreSwitchInProgress = new Map<string, boolean>();
  // TOOL: VIEW FEED
  // Functions: runCheckFeedLoop()
  // Route:     POST /api/mobile/devices/:serial/check-feed
  //            (also called directly from automation-cycle)
  // Isolation: all like/share/save/DM logic is self-contained here.
  //            Do not import helpers added for other tools into this section.
  // ═══════════════════════════════════════════════════════════════════════════

  // Shared by the standalone `/check-feed` route and the full
  // `/automation-cycle` route below — the scroll/like/share loop.
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
      allowByteIdentical = false,
    ): Promise<Buffer> => {
      const outputBytes = await fsPromises.readFile(candidatePath);
      if (!outputBytes.length || (!allowByteIdentical && outputBytes.equals(inputBytes))) {
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
    let pushFileName = fileName;
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
        // A valid image may legitimately be byte-identical when it contains
        // no removable EXIF/XMP/IPTC/C2PA blocks. Fix AI Slop is a metadata
        // cleanup pass; unlike visual alteration, it must not fail the post
        // merely because there was nothing to remove.
        const outputBytes = await verifyProcessedImage(pushFilePath, inputBytes, "Fix AI Slop");
        const outputAudit = await describeImage(pushFilePath, outputBytes);
        onLog?.(`${prefix}: Fix AI Slop verified — processed image is decodable and differs from input`);
        onLog?.(`${prefix}: Fix AI Slop audit — sourceSha256=${sourceAudit.sha256} processedSha256=${outputAudit.sha256} bytes=${outputAudit.bytes} format=${outputAudit.format} dimensions=${outputAudit.width}x${outputAudit.height}`);
        if (outputAudit.format === "jpeg" && ![".jpg", ".jpeg"].includes(path.extname(fileName).toLowerCase())) {
          pushFileName = `${path.basename(fileName, path.extname(fileName))}.jpg`;
        }
      } catch (e: any) {
        await Promise.all(tempFiles.map(file => fsPromises.unlink(file).catch(() => {})));
        tempFiles.length = 0;
        await Promise.all(tempDirs.map(dir => fsPromises.rm(dir, { recursive: true, force: true }).catch(() => {})));
        tempDirs.length = 0;
        throw new Error(`Fix AI Slop verification failed: ${e?.message ?? "unknown error"}`);
      }
    }

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

  // Persistent local-folder no-repeat history, keyed by stable account slot.
  const mobilePostedLocalFiles = new Map<string, string[]>();
  const POSTED_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-posted-local")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-posted-local");
  try { fs.mkdirSync(POSTED_DIR, { recursive: true }); } catch {}
  const _postedFilePath = (serial: string, slotIdx = 0) =>
    path.join(POSTED_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_${accountSlotId(serial, slotIdx)}.json`);
  const getPostedLocalFiles = (serial: string, slotIdx = 0): string[] => {
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    if (!mobilePostedLocalFiles.has(key)) {
      try { mobilePostedLocalFiles.set(key, JSON.parse(fs.readFileSync(_postedFilePath(serial, slotIdx), "utf8"))); }
      catch { mobilePostedLocalFiles.set(key, []); }
    }
    return mobilePostedLocalFiles.get(key)!;
  };
  const recordPostedLocalFile = (serial: string, slotIdx: number, fileName: string) => {
    const list = getPostedLocalFiles(serial, slotIdx);
    list.unshift(fileName);
    try { fs.writeFileSync(_postedFilePath(serial, slotIdx), JSON.stringify(list.slice(0, 5000)), "utf8"); } catch {}
  };

  type PostedProfileMediaEntry = { id: string; filename: string; username: string; slotIdx: number; postedAt: string };
  const mobilePostedProfileMedia = new Map<string, PostedProfileMediaEntry[]>();
  const POSTED_PROFILE_MEDIA_DIR = process.env.EQUINOX_DATA_DIR
    ? path.join(process.env.EQUINOX_DATA_DIR, "mobile-posted-profile-media")
    : path.join(path.dirname(path.resolve(process.argv[1] ?? ".")), "..", "mobile-posted-profile-media");
  try { fs.mkdirSync(POSTED_PROFILE_MEDIA_DIR, { recursive: true }); } catch {}
  const _postedProfileMediaPath = (serial: string, slotIdx = 0) =>
    path.join(POSTED_PROFILE_MEDIA_DIR, `${serial.replace(/[^a-zA-Z0-9_\-]/g, "_")}_${accountSlotId(serial, slotIdx)}.json`);
  const getPostedProfileMedia = (serial: string, slotIdx = 0): PostedProfileMediaEntry[] => {
    const key = `${serial}:${accountSlotId(serial, slotIdx)}`;
    if (!mobilePostedProfileMedia.has(key)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(_postedProfileMediaPath(serial, slotIdx), "utf8"));
        mobilePostedProfileMedia.set(key, Array.isArray(parsed) ? parsed : []);
      } catch { mobilePostedProfileMedia.set(key, []); }
    }
    return mobilePostedProfileMedia.get(key)!;
  };
  const recordPostedProfileMedia = (serial: string, slotIdx: number, username: string, filename: string) => {
    const normalizedUsername = username.replace(/^@/, "").trim();
    if (!normalizedUsername) return;
    const list = getPostedProfileMedia(serial, slotIdx);
    list.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`, filename, username: normalizedUsername, slotIdx, postedAt: new Date().toISOString() });
    try { fs.writeFileSync(_postedProfileMediaPath(serial, slotIdx), JSON.stringify(list.slice(0, 5000)), "utf8"); } catch {}
  };

  const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

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

  const isCycleAborted = (serial: string) =>
    automationCycleAbortedId.get(serial) !== undefined &&
    automationCycleAbortedId.get(serial) === automationCycleCurrentId.get(serial);

  const applyDevicePersonality = <T extends Record<string, any>>(serial: string, input: T): T => {
    const profile = ensureSlotPersonality(serial, automationCycleActiveSlot.get(serial) ?? 0);
    const result = { ...input };
    const clampPct = (value: number) => Math.max(0, Math.min(100, value));
    const adjustRange = (minKey: string, maxKey: string, scale: number) => {
      const min = Number(result[minKey]), max = Number(result[maxKey]);
      if (!Number.isFinite(min) || !Number.isFinite(max) || Math.max(min, max) <= 0) return;
      result[minKey] = clampPct(Math.min(min, max) * scale);
      result[maxKey] = clampPct(Math.max(min, max) * scale);
    };
    const engagement = [0.75, 0.90, 1, 1.10, 1.25][profile.engagement];
    const action = [0.75, 0.90, 1, 1.10, 1.25][profile.actionVariety];
    const discovery = [0.75, 0.90, 1, 1.10, 1.25][profile.discovery];
    const volume = [0.75, 0.90, 1, 1.10, 1.25][profile.consumption];
    const attention = [0.85, 0.93, 1, 1.07, 1.15][profile.attention];
    for (const [a, b] of [["likePercentMin", "likePercentMax"], ["viewStoriesLikePercentMin", "viewStoriesLikePercentMax"], ["viewReelsLikePercentMin", "viewReelsLikePercentMax"], ["viewExploreLikePercentMin", "viewExploreLikePercentMax"]]) adjustRange(a, b, engagement * action);
    for (const [a, b] of [["shareFeedPercentMin", "shareFeedPercentMax"], ["shareDmPercentMin", "shareDmPercentMax"], ["savePercentMin", "savePercentMax"], ["viewStoriesShareDmPercentMin", "viewStoriesShareDmPercentMax"], ["viewStoriesCommentPercentMin", "viewStoriesCommentPercentMax"], ["viewReelsShareFeedPercentMin", "viewReelsShareFeedPercentMax"], ["viewReelsShareDmPercentMin", "viewReelsShareDmPercentMax"], ["viewReelsSavePercentMin", "viewReelsSavePercentMax"], ["viewExploreShareFeedPercentMin", "viewExploreShareFeedPercentMax"], ["viewExploreShareDmPercentMin", "viewExploreShareDmPercentMax"], ["viewExploreSavePercentMin", "viewExploreSavePercentMax"]]) adjustRange(a, b, action);
    for (const [a, b] of [["clickAuthorPercentMin", "clickAuthorPercentMax"], ["clickHashtagPercentMin", "clickHashtagPercentMax"], ["viewStoriesClickAuthorPercentMin", "viewStoriesClickAuthorPercentMax"], ["viewReelsClickAuthorPercentMin", "viewReelsClickAuthorPercentMax"], ["viewExploreClickPostPctMin", "viewExploreClickPostPctMax"], ["viewExploreClickAuthorPercentMin", "viewExploreClickAuthorPercentMax"]]) adjustRange(a, b, discovery * action);
    for (const [a, b] of [["feedScrollMin", "feedScrollMax"], ["viewStoriesSlidesMin", "viewStoriesSlidesMax"], ["viewReelsScrollMin", "viewReelsScrollMax"], ["viewExploreScrollMin", "viewExploreScrollMax"], ["checkDmScrollMin", "checkDmScrollMax"]]) {
      const min = Number(result[a]), max = Number(result[b]);
      if (Number.isFinite(min) && Number.isFinite(max) && Math.max(min, max) > 0) {
        result[a] = Math.max(0, Math.round(Math.min(min, max) * volume));
        result[b] = Math.max(result[a], Math.round(Math.max(min, max) * volume));
      }
    }
    if (Number.isFinite(result.actionDelayMin)) result.actionDelayMin = Math.max(0, result.actionDelayMin * attention);
    if (Number.isFinite(result.actionDelayMax)) result.actionDelayMax = Math.max(result.actionDelayMin ?? 0, result.actionDelayMax * attention);
    if (Number.isFinite(result.viewExploreActionDelayMin)) result.viewExploreActionDelayMin = Math.max(0, result.viewExploreActionDelayMin * attention);
    if (Number.isFinite(result.viewExploreActionDelayMax)) result.viewExploreActionDelayMax = Math.max(result.viewExploreActionDelayMin ?? 0, result.viewExploreActionDelayMax * attention);
    logger.info({ serial, slotIdx: automationCycleActiveSlot.get(serial) ?? 0, personality: profile }, "[slot-personality] applied bounded runtime adjustments");
    return result;
  };

  const effectiveTypingProfile = (serial: string) => {
    const profile = loadInstanceConfigs()[serial]?.devicePrefs?.typingSpeedProfile;
    if (!profile) return undefined;
    const slot = ensureSlotPersonality(serial, automationCycleActiveSlot.get(serial) ?? 0);
    const scale = devicePersonality(serial).dwellScale * [1.08, 1.04, 1, 0.96, 0.92][slot.attention];
    const range = (minMs: number, maxMs: number) => ({ minMs: Math.max(0, Math.round(minMs * scale)), maxMs: Math.max(0, Math.round(maxMs * scale)) });
    return { ...profile, ...range(profile.minMs, profile.maxMs), dwellMinMs: Math.max(1, Math.round(profile.dwellMinMs * scale)), dwellMaxMs: Math.max(1, Math.round(profile.dwellMaxMs * scale)), hesitationMinMs: Math.max(0, Math.round(profile.hesitationMinMs * scale)), hesitationMaxMs: Math.max(0, Math.round(profile.hesitationMaxMs * scale)) };
  };

  const dwellDiagnosticAt = new Map<string, number>();
  const randomizedDwellMs = (serial: string, ms: number, category: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" | "airplaneMode" = "actionPacing"): number => {
    if (!Number.isFinite(ms) || ms <= 0) return Math.max(0, ms);
    if (category === "airplaneMode") return Math.round(ms);
    const slot = ensureSlotPersonality(serial, automationCycleActiveSlot.get(serial) ?? 0);
    const scaled = ms * devicePersonality(serial).dwellScale * [1.08, 1.04, 1, 0.96, 0.92][slot.attention];
    const low = scaled >= 5000 ? Math.max(1, Math.round(scaled * 0.5)) : Math.max(1, Math.round(scaled));
    const high = scaled >= 5000 ? Math.round(scaled) : 5000;
    const overrides = loadInstanceConfigs()[serial]?.devicePrefs?.motherCodeOverrides;
    const source = overrides?.[category] ? category : overrides?.globalDwell ? "globalDwell" : "generated";
    const override = source === "generated" ? undefined : overrides?.[source];
    if (!override) return low + Math.floor(Math.random() * (high - low + 1));
    const min = Math.min(override.minMs, override.maxMs), max = Math.max(override.minMs, override.maxMs);
    const actual = Math.round(min + Math.random() * (max - min));
    const key = `${serial}:${category}`, now = Date.now();
    if ((dwellDiagnosticAt.get(key) ?? 0) + 5000 <= now) {
      dwellDiagnosticAt.set(key, now);
      logger.info({ serial, category, overrideSource: source, requestedMs: ms, overrideMinMs: min, overrideMaxMs: max, actualMs: actual }, "[mobile-override] dwell override applied");
    }
    return actual;
  };
  const jitterStaticDwell = (ms: number): number => {
    if (!Number.isFinite(ms) || ms <= 0) return Math.max(0, Math.round(ms));
    const min = Math.max(1, Math.ceil(ms * 0.8));
    const max = Math.max(min, Math.floor(ms * 1.2));
    return min + Math.floor(Math.random() * (max - min + 1));
  };
  const sleepOrAbort = (
    serial: string,
    ms: number,
    category: "globalDwell" | "accountSwitching" | "navigation" | "actionPacing" | "airplaneMode" = "actionPacing",
    timingMode: "static" | "computed" = "static",
  ) => {
    const dwellMs = timingMode === "computed"
      ? randomizedDwellMs(serial, ms, category)
      : jitterStaticDwell(ms);
    const startedAt = performance.now();
    return new Promise<void>((resolve, reject) => {
      const finish = () => {
        const aborted = isCycleAborted(serial);
        logger.info({ serial, category, requestedMs: ms, scheduledMs: dwellMs, elapsedMs: Math.round(performance.now() - startedAt), completed: !aborted },
          "[mobile-execution] dwell completed");
        if (aborted) reject(new Error("cycle-aborted")); else resolve();
      };
      const t = setTimeout(finish, dwellMs);
      if (dwellMs <= 0) { clearTimeout(t); finish(); }
    });
  };
  const returnToHomeSafely = async (serial: string): Promise<boolean> => {
    const home = await android.findHomeTab(serial).catch(() => null);
    if (!home) return false;
    await android.tap(serial, home.x, home.y);
    return true;
  };
  const hstRandomDelay = (serial: string, minMs: number, maxMs: number) =>
    sleepOrAbort(serial, minMs + Math.floor(Math.random() * (maxMs - minMs + 1)), "actionPacing", "computed");

  function rollScrollVelocity(
    h: number,
    weights: { superSkim: number; skim: number; fast: number; quick: number; normal: number; slow: number; focused: number; tapDragRelease: number; back: number },
    allowBack = true,
    safeStartFrac = 0.80,
    history?: { lastMode?: string; streak: number },
    serial?: string,
  ): { duration: number; fromY: number; toY: number; mode: string } {
    const overrides = serial ? loadInstanceConfigs()[serial]?.devicePrefs?.swipePersonalityOverrides : undefined;
    const effective = { ...weights };
    if (serial) {
      const slot = ensureSlotPersonality(serial, automationCycleActiveSlot.get(serial) ?? 0);
      const attention = [0.80, 0.92, 1, 1.08, 1.18][slot.attention];
      const variety = [0.82, 0.92, 1, 1.08, 1.16][slot.actionVariety];
      effective.fast *= attention; effective.quick *= attention;
      effective.normal *= attention; effective.slow *= attention;
      effective.focused *= attention * variety; effective.tapDragRelease *= variety;
    }
    for (const mode of Object.keys(effective) as Array<keyof typeof effective>) {
      const configured = overrides?.[mode];
      if (configured && (configured.weightMin > 0 || configured.weightMax > 0)) {
        const min = Math.min(configured.weightMin, configured.weightMax);
        const max = Math.max(configured.weightMin, configured.weightMax);
        effective[mode] = min + Math.random() * (max - min);
      }
    }
    const blocked = new Set<string>();
    if (history?.lastMode && history.streak >= 3) blocked.add(history.lastMode);
    if (history?.lastMode === "back" && history.streak >= 2) blocked.add("back");
    const modeWeights = (mode: keyof typeof effective) =>
      blocked.has(mode) || (mode === "back" && !allowBack) ? 0 : effective[mode];
    const entries = (Object.keys(effective) as Array<keyof typeof effective>)
      .map(mode => [mode, modeWeights(mode)] as const);
    const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
    let roll = Math.random() * total;
    let mode: keyof typeof effective = "normal";
    for (const [candidate, weight] of entries) {
      roll -= weight;
      if (roll < 0) { mode = candidate; break; }
    }
    const configured = overrides?.[mode];
    const defaults: Record<typeof mode, [number, number]> = {
      superSkim: [150, 350], skim: [450, 800], fast: [900, 1500], quick: [1250, 2000],
      normal: [1500, 2500], slow: [2000, 3500], focused: [2500, 5000],
      tapDragRelease: [450, 850], back: [350, 600],
    };
    const [fallbackMin, fallbackMax] = defaults[mode];
    const min = Math.max(1, Math.round(configured?.durationMinMs ?? fallbackMin));
    const max = Math.max(min, Math.round(configured?.durationMaxMs ?? fallbackMax));
    const duration = min + Math.round(Math.random() * (max - min));
    const from = mode === "quick" || mode === "normal" ? Math.min(0.65, safeStartFrac)
      : mode === "slow" ? Math.min(0.62, safeStartFrac)
      : mode === "focused" ? Math.min(0.58, safeStartFrac) : safeStartFrac;
    const to: Record<typeof mode, number> = {
      superSkim: 0.08, skim: 0.22, fast: 0.30, quick: 0.38, normal: 0.42,
      slow: 0.45, focused: 0.48, tapDragRelease: 0.35, back: 0.52,
    };
    return { mode, duration, fromY: Math.round(h * (mode === "back" ? 0.28 : from)), toY: Math.round(h * to[mode]) };
  }
  const consumptionScrollWeights = {
    superSkim: 1, skim: 3, fast: 8, quick: 12, normal: 30, slow: 30,
    focused: 20, tapDragRelease: 5, back: 0,
  };
  function rollFeedConsumptionGesture(h: number, history: { lastMode?: string; streak: number }, serial: string) {
    return rollScrollVelocity(h, consumptionScrollWeights, false, 0.80, history, serial);
  }

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
    if (!configured) throw new Error(`Swipe Gesture Profile is required for ${source}`);
    const jitterX = Number.isFinite(configured.jitterX) ? configured.jitterX : 0;
    const jitterY = Number.isFinite(configured.jitterY) ? configured.jitterY : 0;
    const dx = Math.round((Math.random() * 2 - 1) * jitterX);
    const startMin = Math.max(0, Math.min(configured.startJitterMinY ?? 0, configured.startJitterMaxY ?? 0));
    const startMax = Math.max(startMin, configured.startJitterMaxY ?? startMin);
    const startDy = Math.round(startMin + Math.random() * (startMax - startMin));
    const endDy = Math.round((Math.random() * 2 - 1) * jitterY);
    if (!Number.isFinite(configured.durationMinMs) || !Number.isFinite(configured.durationMaxMs)) {
      throw new Error(`Swipe Gesture Profile duration is invalid for ${source}`);
    }
    const minDuration = Math.max(1, Math.min(configured.durationMinMs, configured.durationMaxMs));
    const maxDuration = Math.max(minDuration, Math.max(configured.durationMinMs, configured.durationMaxMs));
    const bands: Record<NonNullable<typeof personality>, [number, number]> = {
      superSkim: [0, .20], skim: [.20, .45], fast: [.45, .70], quick: [.70, .90],
      normal: [.90, 1], slow: [.90, 1], focused: [.90, 1], tapDragRelease: [.05, .10], back: [.05, .10],
    };
    const [bandStart, bandEnd] = personality ? bands[personality] : [0, 1];
    const slot = ensureSlotPersonality(serial, automationCycleActiveSlot.get(serial) ?? 0);
    const slotScale = [1.08, 1.04, 1, .96, .92][slot.attention];
    const mother = devicePersonality(serial);
    const durationMs = Math.max(1, Math.round((minDuration + (maxDuration - minDuration) *
      (bandStart + Math.random() * (bandEnd - bandStart))) * mother.gestureScale * slotScale));
    const pauseMin = Math.max(0, Math.min(configured.pauseMinMs ?? 0, configured.pauseMaxMs ?? 0));
    const pauseMax = Math.max(pauseMin, configured.pauseMaxMs ?? pauseMin);
    const settleMin = Math.max(0, Math.min(configured.settleMinMs ?? 0, configured.settleMaxMs ?? 0));
    const settleMax = Math.max(settleMin, configured.settleMaxMs ?? settleMin);
    const pauseMs = Math.round((pauseMin + Math.random() * (pauseMax - pauseMin)) * mother.pauseScale * slotScale);
    const settleMs = Math.round((settleMin + Math.random() * (settleMax - settleMin)) * mother.settleScale * slotScale);
    if (pauseMs > 0) await new Promise(resolve => setTimeout(resolve, pauseMs));
    const reversed = personality === "back";
    const path = {
      x1: clamp((reversed ? configured.x2 : configured.x1) + dx + mother.xBias, size.w),
      y1: clamp((reversed ? configured.y2 : configured.y1) + (reversed ? endDy : startDy) + mother.yBias, size.h),
      x2: clamp((reversed ? configured.x1 : configured.x2) + dx + mother.xBias, size.w),
      y2: clamp((reversed ? configured.y1 : configured.y2) + (reversed ? startDy : endDy) + mother.yBias, size.h),
      durationMs,
    };
    if (opts?.maxFromY !== undefined && !reversed) path.y1 = Math.min(path.y1, opts.maxFromY);
    if (source === "explore-scroll" && !reversed && path.y1 - path.y2 < Math.round(size.h * .22)) {
      path.y2 = Math.max(0, path.y1 - Math.round(size.h * .22));
      logger.warn({ serial, source, minExploreTravel: Math.round(size.h * .22) }, "[mobile-input] recovered short Explore swipe before dispatch");
    }
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
    await android.swipe(serial, path.x1, path.y1, path.x2, path.y2, path.durationMs, false);
    if (settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
    return { ...path, profile: true };
  }

  // Shared screen-size resolver for every HST operation. Keep this bound to the
  // Android manager namespace so extracted operations and the gesture layer use
  // the same device dimensions.
  const getScreenSize = android.getScreenSize;

  /**
   * Dismiss Instagram's first-save collection sheet only after positively
   * detecting its accessibility markers. The tap stays inside the confirmed
   * clear scrim above the sheet and is randomized within that safe region.
   */
  const dismissSaveCollectionPrompt = async (
    serial: string,
    xml: string,
    onLog?: (msg: string) => void,
    context = "Save",
  ): Promise<boolean> => {
    if (!/(?:pinned_save_row|collect the posts you love|start a collection|save to collection)/i.test(xml)) {
      return false;
    }
    const { w, h } = getScreenSize(serial);
    const x = Math.round(w * (0.10 + Math.random() * 0.80));
    const y = Math.round(h * (0.04 + Math.random() * 0.15));
    await android.tap(serial, x, y);
    onLog?.(`${context}: dismissed collection prompt at randomized top-scrim point (${x},${y})`);
    await sleepOrAbort(serial, 300);
    return true;
  };

  // Keep the last validated DM recipient independently per operation. A
  // recipient coordinate is only a short-lived optimization for that tool's
  // next share action and must never leak between Feed, Stories, Explore,
  // Reels, or Inject Browsing.
  const _viewFeedLastDmRecipient = new Map<string, { x: number; y: number }>();
  const _viewStoriesLastDmRecipient = new Map<string, { x: number; y: number }>();
  const _viewExploreLastDmRecipient = new Map<string, { x: number; y: number }>();
  const _viewReelsLastDmRecipient = new Map<string, { x: number; y: number }>();
  const _injectBrowsingLastDmRecipient = new Map<string, { x: number; y: number }>();

  const hstOperationContext: any = {
    android, fs, fsPromises, path, storage, logger, deviceProfileSwipe,
    getScreenSize, isCycleAborted, sleepOrAbort, hstRandomDelay, returnToHomeSafely,
    rollRange, getDeviceDensity: (s: string) => android.getDeviceDensity(s),
    loadInstanceConfigs, consumptionScrollWeights, rollFeedConsumptionGesture, rollScrollVelocity,
    findButtonByLabel: android.findButtonByLabel, findFeedActionIcons: android.findFeedActionIcons,
    findReelActionIcons: android.findReelActionIcons, findHomeTab: android.findHomeTab,
    findInstagramSearchTab: android.findInstagramSearchTab,
    _viewFeedLastDmRecipient, _viewStoriesLastDmRecipient, _viewExploreLastDmRecipient,
    _viewReelsLastDmRecipient, _injectBrowsingLastDmRecipient, dismissSaveCollectionPrompt,
    pickLocalFolderImage, prepareMakePostImage, recordPostedLocalFile, recordPostedProfileMedia,
    auditDeviceMediaCopy, effectiveTypingProfile,
    HikerApiClient, getCompiledMalesOnlyNames, findLiveMalesOnlyMatch,
    runUpdateProfilePicture: (s: string, f: string, l: any, o: any) => runUpdateProfilePictureOperation(s, f, l, o, hstOperationContext),
    runUpdateBio: (s: string, b: string, l: any) => runUpdateBioOperation(s, b, l, hstOperationContext),
  };
  const runCheckFeedLoop = (s: string, p: any) => runCheckFeedLoopOperation(s, p, hstOperationContext);
  const runViewStoriesFromFeedLoop = (s: string, p: any) => runViewStoriesFromFeedLoopOperation(s, p, hstOperationContext);
  const runViewExplorePage = (s: string, p: any) => runViewExplorePageOperation(s, p, hstOperationContext);
  const runViewReelsLoop = (s: string, p: any) => runViewReelsLoopOperation(s, p, hstOperationContext);
  const runMakePostStep = (s: string, p: any) => runMakePostStepOperation(s, p, hstOperationContext);
  const runMakePostStoryStep = (s: string, p: any) => runMakePostStoryStepOperation(s, p, { ...hstOperationContext, slotIdx: p.slotIdx ?? 0 });
  const runUpdateProfilePicture = (s: string, f: string, l: any, o: any) => runUpdateProfilePictureOperation(s, f, l, o, hstOperationContext);
  const runUpdateBio = (s: string, b: string, l: any) => runUpdateBioOperation(s, b, l, hstOperationContext);

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
  function rollActivateWithTrace(min: number, max: number): { active: boolean; sampledPct: number; draw: number } {
    const sampledPct = rollRange(min, max);
    const draw = Math.random();
    return { sampledPct, draw, active: sampledPct > 0 && draw < sampledPct / 100 };
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
      await sleepOrAbort(serial, dwellMs, "actionPacing", "computed");

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
      await sleepOrAbort(serial, renderWait, "actionPacing", "computed");
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
           const useDoubleTap = Math.random() < 0.93 && Boolean(icons.mediaBounds);
           if (useDoubleTap && icons.mediaBounds) {
             const mb = icons.mediaBounds;
             const xFraction = 0.35 + Math.random() * 0.30;
             const yFraction = 0.35 + Math.random() * 0.30;
             const dtX = Math.round(mb.x1 + (mb.x2 - mb.x1) * xFraction);
             const dtY = Math.round(mb.y1 + (mb.y2 - mb.y1) * yFraction);
             onLog?.(`Inject Browsing: double-tap using central media bounds (${Math.round(xFraction * 100)}%,${Math.round(yFraction * 100)}%)`);
             onLog?.(`Inject Browsing: double-tapping image at (${dtX},${dtY})…`);
             await android.doubleTap(serial, dtX, dtY, undefined, mb);
           } else {
             if (!icons.mediaBounds) {
               onLog?.("Inject Browsing: media bounds unavailable — using confirmed Like icon instead of double-tap");
             }
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
        await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300), "actionPacing", "computed");
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
        await sleepOrAbort(serial, 300 + Math.round(Math.random() * 300), "actionPacing", "computed");
        onLog?.(`Inject Browsing: tapping save icon at (${icons.save.x},${icons.save.y})…`);
        await android.tap(serial, icons.save.x, icons.save.y);
        await sleepOrAbort(serial, 600);
        const _ibSaveXml = await android.dumpUi(serial).catch(() => "");
        await dismissSaveCollectionPrompt(serial, _ibSaveXml, onLog, "Inject Browsing");
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
    const configuredSlot = loadInstanceConfigs()[serial]?.account?.slots?.[incomingSlotIdx];
    const incomingSlotId = typeof req.body?.slotId === "string" ? req.body.slotId.trim() : "";
    const configuredSlotId = configuredSlot?.slotId?.trim() ?? "";
    const slotId = incomingSlotId || configuredSlotId;
    if (!configuredSlotId || !incomingSlotId || incomingSlotId !== configuredSlotId) {
      res.status(409).json({ error: "The account slot changed; refresh the mobile page and retry" });
      return;
    }
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
      if (notebookStarted) {
        try { appendSlotCycleNotebook(serial, slotId, incomingCycleId, fullLine); }
        catch (error) { logger.warn({ err: error, serial, slotId }, "[mobile-cycle] notebook append failed"); }
      }
    };
    let notebookStarted = false;
    try {
      const parsedCycle = automationCycleSchema.parse(req.body);
      // Re-resolve the assigned TrustScore at execution time. The browser
      // normally sends the same effective values it displayed, but the server
      // must remain authoritative when a template was edited in another tab
      // or the request came from the background runner.
      const savedSlotSettings =
        loadInstanceConfigs()[serial]?.slotAutomation?.[slotAutomationKey(serial, incomingSlotIdx, slotId)]
        ?? loadInstanceConfigs()[serial]?.slotAutomation?.[String(incomingSlotIdx)]
        ?? {};
      const effectiveCycle = await resolveTrustScoreSettings(serial, incomingSlotIdx, {
        ...savedSlotSettings,
        ...parsedCycle,
      });
      const effectiveSettings: any = applyDevicePersonality(serial, effectiveCycle.settings);
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
        storiesRerunChanceMin, storiesRerunChanceMax,
        viewExploreRerunChanceMin, viewExploreRerunChanceMax,
        viewReelsRerunChanceMin, viewReelsRerunChanceMax,
        checkDmRerunChanceMin, checkDmRerunChanceMax,
        makePostRerunChanceMin, makePostRerunChanceMax,
         feedScrollMin, feedScrollMax,
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
      try {
        startSlotCycleNotebook({
          serial,
          slotId,
          username: resolvedSlotUsername,
          cycleId: incomingCycleId,
        });
        notebookStarted = true;
      } catch (error) {
        logger.warn({ err: error, serial, slotId }, "[mobile-cycle] notebook start failed; continuing without notebook");
      }
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
      const launchRestrictionDismissed = await android.dismissInstagramAccountRestriction(
        serial,
        tLog,
        adsChoice.dismissed ? undefined : launchXml,
      ).catch(() => false);
      if (launchRestrictionDismissed) {
        steps.push("account-restriction-dismissed");
        await sleepOrAbort(serial, 500);
      }
      // Instagram can expose the feed in the accessibility tree before the
      // first feed render has finished. Keep a short bounded settle before
      // account switching; the profile-tab selector has its own live guard.
      tLog("▶ Dwell: allowing Instagram feed to finish rendering…");
      await sleepOrAbort(serial, 1000);
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
      const _activationTrace: Record<string, { enabled: boolean; minPct: number; maxPct: number; sampledPct: number; draw: number; active: boolean }> = {};
      const _activateTool = (name: string, enabled: boolean, minPct: number, maxPct: number) => {
        const roll = rollActivateWithTrace(minPct, maxPct);
        const active = enabled && roll.active;
        _activationTrace[name] = { enabled, minPct, maxPct, sampledPct: roll.sampledPct, draw: roll.draw, active };
        return active;
      };
      const _toolActivated: Record<string, boolean> = {
        feed: _activateTool("feed", feedEnabled, feedActivatePctMin, feedActivatePctMax),
        stories: _activateTool("stories", storiesEnabled && viewStoriesSlidesMax > 0, viewStoriesActivatePctMin ?? 100, viewStoriesActivatePctMax ?? 100),
        explore: _activateTool("explore", (viewExploreEnabled ?? false) && (viewExploreScrollMax ?? 0) > 0, viewExploreActivatePctMin ?? 100, viewExploreActivatePctMax ?? 100),
        reels: _activateTool("reels", (viewReelsEnabled ?? false) && (viewReelsScrollMax ?? 0) > 0, viewReelsActivatePctMin ?? 100, viewReelsActivatePctMax ?? 100),
        checkDm: _activateTool("checkDm", checkDmEnabled ?? false, checkDmActivatePctMin ?? 100, checkDmActivatePctMax ?? 100),
        follow: _activateTool("follow", followEnabled, followActivatePctMin, followActivatePctMax),
        post: _activateTool("post", makePostEnabled, makePostActivatePctMin, makePostActivatePctMax),
        postStory: _activateTool("postStory", postStoryEnabled, postStoryActivatePctMin, postStoryActivatePctMax),
        "Random Actions": _activateTool("Random Actions", randomJitterEnabled, randomJitterActivatePctMin, randomJitterActivatePctMax),
      };
      tLog(`[activation] ${JSON.stringify({ tools: _activationTrace, activeTools: Object.keys(_toolActivated).filter(tool => _toolActivated[tool]) })}`);
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
              await runCheckDmLoopOperation(serial, {
                scrollsMin: scaled(checkDmScrollMin),
                scrollsMax: scaled(checkDmScrollMax),
                clickPctMin: checkDmClickPctMin,
                clickPctMax: checkDmClickPctMax,
              }, {
                android,
                getScreenSize,
                deviceProfileSwipe,
                sleepOrAbort,
                rollRange,
                logger,
                onLog: (msg) => tLog(`  ${msg}`),
              }).catch((e: any) => {
                if (e?.message === "cycle-aborted") throw e;
                tLog(`  ⚠ Pre-switch Check Inbox skipped: ${e?.message ?? "unknown error"}`);
              });
            } else if (preTool === "post") {
              await runMakePostStep(serial, {
                localFolderPath: makePostLocalFolderPath || getMakePostFolderPath(serial, slotIdx),
                localFolderRandom: makePostLocalFolderRandom,
                localFolderNoRepeat: makePostLocalFolderNoRepeat,
                deleteAfterUpload: false,
                captionText: makePostCaptionText,
                addLocation: makePostAddLocation,
                alterationEnabled: makePostAlterationEnabled,
                alterationLevel: makePostAlterationLevel,
                imageSettingsEnabled: makePostImageSettingsEnabled,
                imageSettings: makePostImageSettings,
                doFixAiSlop: makePostFixAiSlop,
                frequencyDisruption: makePostFrequencyDisruption,
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
              }, hstOperationContext);
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

      // Account-switch orchestration is isolated from the cycle dispatcher.
      await runAccountSwitch({
        android,
        serial,
        username: resolvedSlotUsername,
        launchXml,
        adsChoiceDismissed: adsChoice.dismissed,
        launchPopup,
        preSwitchActionsRan,
        steps,
        log: tLog,
        sleepOrAbort,
        lastActiveUsername: automationLastActiveUsername,
        currentTool: automationCurrentTool,
        swipeGesture: loadInstanceConfigs()[serial]?.devicePrefs?.swipeGesture,
      });

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

      // Each requested tool gets an independent one-pass re-run roll. The
      // appended dispatcher entry invokes the real tool function again, so
      // that function's own counts, percentages, delays, and personality
      // rolls are all fresh for the re-run.
      const appendToolRerun = (
        tool: string,
        min: number,
        max: number,
        label: string,
      ) => {
        if (!_toolActivated[tool]) return;
        const lo = Math.min(min, max);
        const hi = Math.max(min, max);
        const chance = lo + Math.random() * (hi - lo);
        if (chance > 0 && Math.random() * 100 < chance) {
          _toolSeq.push(tool);
          tLog(`▶ ${label} re-run rolled (${Math.round(chance)}%) — appended at end of cycle`);
        }
      };
      appendToolRerun("feed", feedRerunChanceMin, feedRerunChanceMax, "View Feed");
      appendToolRerun("stories", storiesRerunChanceMin, storiesRerunChanceMax, "View Stories");
      appendToolRerun("explore", viewExploreRerunChanceMin, viewExploreRerunChanceMax, "View Explore");
      appendToolRerun("reels", viewReelsRerunChanceMin, viewReelsRerunChanceMax, "View Reels");
      appendToolRerun("checkDm", checkDmRerunChanceMin, checkDmRerunChanceMax, "Check Inbox");
      appendToolRerun("post", makePostRerunChanceMin, makePostRerunChanceMax, "Make a Post");

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
            // Every View Feed pass gets its own scroll-count roll. This is
            // deliberately inside the dispatcher rather than computed once
            // for the cycle, so a re-run is a genuinely fresh Feed session.
            const feedRunCount = Math.max(
              1,
              Math.min(
                50,
                Math.floor(
                  Math.min(feedScrollMin, feedScrollMax) +
                  Math.random() * (Math.abs(feedScrollMax - feedScrollMin) + 1),
                ),
              ),
            );
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
            tLog(`▶ Starting feed scroll — ${feedRunCount} posts (fresh pass roll)`);
            ({ likes, likeFailures, sharesFeed, sharesDm, saves, captionExpands, strayNavRecoveries, audioTaps, hashtagTaps, authorVisits } = await runCheckFeedLoop(serial, {
              count: feedRunCount, delayMinSec, delayMaxSec, likePercentMin, likePercentMax,
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
            feedScrolled = feedRunCount;
            steps.push(`feed(${feedRunCount} scrolls, ${likes} likes, ${sharesFeed} feed-shares, ${sharesDm} dm-shares, ${saves} saves, ${captionExpands} caption-expands, ${audioTaps} audio-taps, ${hashtagTaps} hashtag-taps, ${authorVisits} author-visits, ${likeFailures} like-failures${strayNavRecoveries ? `, ${strayNavRecoveries} ad-nav-recoveries` : ""})`);
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
                hstOperationContext,
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
             // Instagram bottom-navigation slot. Try the shared visual Home
             // detector first; it checks both normal and inverted polarity.
             // If the icon is not visually matchable in the viewer, the slot
             // itself remains the authoritative target.
            tLog("▶ View Reels — exiting full-screen viewer via Home tab…");
             const detectedHome = await android.findHomeTab(serial).catch(() => null);
             const homeTab = detectedHome ?? await android.getBottomLeftHomeFallback(serial);
             const homeTapSource = detectedHome ? "dual-polarity visual match" : "bottom-left navigation slot";
             await android.tap(serial, homeTab.x, homeTab.y, "manual");
             tLog(`▶ View Reels — tapped Home tab at (${homeTab.x},${homeTab.y}) via ${homeTapSource}`);
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
              await runCheckDmLoopOperation(serial, {
                scrollsMin: checkDmScrollMin,
                scrollsMax: checkDmScrollMax,
                clickPctMin: checkDmClickPctMin,
                clickPctMax: checkDmClickPctMax,
              }, {
                android,
                getScreenSize,
                deviceProfileSwipe,
                sleepOrAbort,
                rollRange,
                logger,
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
              }, hstOperationContext);

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
              }, hstOperationContext);
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
            }, hstOperationContext, async (kind) => {
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
      await sleepOrAbort(serial, Math.round(waitSec * 1000), "airplaneMode", "computed");
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
      try {
        finishSlotCycleNotebook({
          serial, slotId, cycleId: incomingCycleId, status: "complete",
          summary: `Cycle complete — ${cycleMetricSummary()}`,
        });
      } catch (error) {
        logger.warn({ err: error, serial, slotId }, "[mobile-cycle] notebook completion failed");
      }
    } catch (e: any) {
      logger.error({
        err: e,
        serial,
        slotIdx: incomingSlotIdx,
        slotId,
        cycleId: incomingCycleId,
        steps: steps.slice(-8),
      }, "[mobile-cycle] cycle failed");
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
      if (notebookStarted) {
        try {
          finishSlotCycleNotebook({
            serial, slotId, cycleId: incomingCycleId,
            status: aborted ? "aborted" : "failed",
            summary: aborted ? "Cycle aborted" : `Cycle failed: ${e?.message ?? "unknown error"}`,
          });
        } catch (error) {
          logger.warn({ err: error, serial, slotId }, "[mobile-cycle] notebook failure stamp failed");
        }
      }
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

  app.get("/api/mobile/devices/:serial/slots/:slotIdx/cycle-notebook", (req: Request, res: Response) => {
    const serial = p(req, "serial");
    const slotIdx = Number(req.params.slotIdx);
    const configuredSlot = loadInstanceConfigs()[serial]?.account?.slots?.[slotIdx];
    const requestedSlotId = typeof req.query.slotId === "string" ? req.query.slotId.trim() : "";
    const slotId = requestedSlotId || configuredSlot?.slotId?.trim();
    if (!requestedSlotId) {
      res.status(409).json({ ok: false, error: "The account slot identity is unavailable or changed" });
      return;
    }
    res.json(getSlotCycleNotebook(serial, slotId));
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
  // to open the account switcher. Profile-tab account switching uses a
  // randomized 2000–5000ms duration.
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
      const result = await runManualProfileTabLongPress({ android, serial });
      if (!result.ok) {
        res.status(result.status).json({ error: result.error });
        return;
      }
      res.json(result);
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
      logger.info({ serial, activeCycleId: activeCycleId ?? null }, "[graceful-reboot] request received");
      if (activeCycleId) automationCycleAbortedId.set(serial, activeCycleId);

      // Most cycles unwind through their abort checkpoint within a few
      // seconds. A device I/O call can still remain in flight indefinitely,
      // though, so graceful reboot must have a bounded drain period rather
      // than refusing to reboot forever.
      const drainTimeoutMs = 15_000;
      const deadline = Date.now() + drainTimeoutMs;
      while (automationCycleInProgress.has(serial) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 250));
      }

       const stillRunning = automationCycleInProgress.has(serial);
       if (stillRunning) {
          // The worker may be blocked inside a synchronous ADB operation and
          // therefore cannot observe the abort marker until the device
          // disappears. Rebooting here is the only reliable way to interrupt
          // that operation. The worker's existing catch/finally path will
          // classify the resulting offline error as an abort, persist partial
          // metrics, and release the cycle lock afterward.
          logger.warn({ serial, activeCycleId, waitedMs: drainTimeoutMs }, "[graceful-reboot] cycle did not stop; forcing adb reboot");
          android.rebootDevice(serial);
          logger.info({ serial, interruptedCycle: Boolean(activeCycleId), forcedCleanup: true }, "[graceful-reboot] forced adb reboot dispatched");
          res.json({
            ok: true,
           interruptedCycle: Boolean(activeCycleId),
           forcedCleanup: true,
         });
         return;
       }
       // Do not release the server-side cycle lock here. The in-flight worker
       // must finish its abort path first, otherwise a new cycle can overlap
       // its final recents gesture.

        logger.info({ serial, interruptedCycle: Boolean(activeCycleId) }, "[graceful-reboot] dispatching adb reboot");
        android.rebootDevice(serial);
        logger.info({ serial }, "[graceful-reboot] adb reboot command completed");
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
