import fs from "fs";
import fsPromises from "fs/promises";
import os from "os";
import path from "path";
import { randomBytes } from "node:crypto";

const LOCK_PATH = path.join(os.tmpdir(), "dannys-bot-mobile-automation.lock");
const LOCK_STALE_MS = 30_000;
const LOCK_RENEW_MS = 10_000;

let started = false;
let owned = false;
let token: string | null = null;
let renewTimer: ReturnType<typeof setInterval> | null = null;

async function tryAcquire(): Promise<boolean> {
  const nextToken = `${process.pid}:${Date.now()}:${randomBytes(6).toString("hex")}`;
  const tempPath = `${LOCK_PATH}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;

  try {
    await fsPromises.writeFile(tempPath, nextToken, "utf8");
    try {
      // link() is an atomic create-if-absent operation. This prevents two API
      // processes from both deciding they own mobile input at startup.
      await fsPromises.link(tempPath, LOCK_PATH);
      token = nextToken;
      return true;
    } catch (error: any) {
      if (error?.code !== "EEXIST") return false;

      // A crashed process must not permanently block the surviving API server.
      try {
        const stat = await fsPromises.stat(LOCK_PATH);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          await fsPromises.unlink(LOCK_PATH).catch(() => {});
          await fsPromises.link(tempPath, LOCK_PATH);
          token = nextToken;
          return true;
        }
      } catch {
        // Another process may have won the takeover race.
      }
      return false;
    } finally {
      await fsPromises.unlink(tempPath).catch(() => {});
    }
  } catch {
    return false;
  }
}

async function renew(): Promise<void> {
  if (!owned || !token) return;
  try {
    const current = await fsPromises.readFile(LOCK_PATH, "utf8").catch(() => null);
    if (current !== token) {
      console.error(
        "[mobile-lock] ownership lost; this API process will stop launching mobile automation",
      );
      owned = false;
      token = null;
      if (renewTimer) {
        clearInterval(renewTimer);
        renewTimer = null;
      }
      started = false;
      beginAcquireLoop();
      return;
    }
    await fsPromises.writeFile(LOCK_PATH, token, "utf8");
  } catch (error) {
    console.warn("[mobile-lock] renewal failed:", error);
  }
}

function beginAcquireLoop(): void {
  if (started) return;
  started = true;

  (async () => {
    while (!owned) {
      if (await tryAcquire()) {
        owned = true;
        console.log(`[mobile-lock] mobile automation owner acquired (pid=${process.pid})`);
        renewTimer = setInterval(() => {
          void renew();
        }, LOCK_RENEW_MS);
        return;
      }
      console.log(
        `[mobile-lock] another API process owns mobile automation; retrying in ${LOCK_RENEW_MS / 1000}s`,
      );
      await new Promise(resolve => setTimeout(resolve, LOCK_RENEW_MS));
    }
  })().catch(error => {
    console.error("[mobile-lock] acquisition loop failed:", error);
    started = false;
  });
}

export function startMobileAutomationProcessLock(): void {
  beginAcquireLoop();
  const release = () => {
    if (renewTimer) {
      clearInterval(renewTimer);
      renewTimer = null;
    }
    if (!owned || !token) return;
    try {
      if (fs.readFileSync(LOCK_PATH, "utf8") === token) {
        fs.unlinkSync(LOCK_PATH);
      }
    } catch {
      // The lock may already have been removed or taken over.
    }
    owned = false;
    token = null;
  };
  process.once("exit", release);
  process.once("SIGTERM", release);
  process.once("SIGINT", release);
}

export function mobileAutomationProcessLockOwned(): boolean {
  return owned;
}