import type { Browser, Page } from "puppeteer";
import { WebSocket } from "ws";
import { generate as totpGenerate } from "otplib";
import fs from "fs";
import path from "path";

import { db } from "@workspace/db";
import { instagramApiCalls } from "../shared/schema";

function log(msg: string, _category?: string) {
  console.log(`[browser] ${msg}`);
}

// ── Cookie persistence ───────────────────────────────────────────────────────
const COOKIES_DIR = path.join(process.cwd(), "server", "browser-data");

function cookiePath(profileId: number) {
  return path.join(COOKIES_DIR, `cookies-${profileId}.json`);
}

async function saveCookies(profileId: number, page: Page): Promise<void> {
  try {
    const cookies = await page.cookies();
    if (!cookies.length) return;
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
    fs.writeFileSync(cookiePath(profileId), JSON.stringify(cookies, null, 2), "utf8");
    log(`[cookies:${profileId}] Saved ${cookies.length} cookies`, "browser");
  } catch (e: any) {
    log(`[cookies:${profileId}] Save error: ${e?.message}`, "browser");
  }
}

async function loadCookies(profileId: number, page: Page): Promise<boolean> {
  try {
    const p = cookiePath(profileId);
    if (!fs.existsSync(p)) return false;
    const raw = fs.readFileSync(p, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || !cookies.length) return false;
    await page.setCookie(...cookies);
    log(`[cookies:${profileId}] Restored ${cookies.length} cookies`, "browser");
    return true;
  } catch (e: any) {
    log(`[cookies:${profileId}] Load error: ${e?.message}`, "browser");
    return false;
  }
}

export function hasSavedCookies(profileId: number): boolean {
  try {
    return fs.existsSync(cookiePath(profileId));
  } catch { return false; }
}

export function deleteSavedCookies(profileId: number): void {
  try {
    const p = cookiePath(profileId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
}

interface Session {
  browser: Browser;
  page: Page;
  ws: WebSocket | null;
  frameLoop: ReturnType<typeof setInterval> | null;
  lastUrl: string;
  proxyKey: string; // "direct" or "host:port" — used to detect proxy changes
}

const sessions = new Map<number, Session>();

const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--no-first-run",
  "--no-zygote",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-sync",
  "--metrics-recording-only",
  "--disable-default-apps",
  "--mute-audio",
  "--hide-scrollbars",
  "--window-size=1280,760",
];

// Use system Chromium installed via Nix
const CHROMIUM_PATH = "/nix/store/zi4f80l169xlmivz8vja8wlphq74qqk0-chromium-125.0.6422.141/bin/chromium";

export async function getOrCreateSession(
  profileId: number,
  userAgent: string,
  proxy?: ProxyConfig,
): Promise<Session> {
  const newProxyKey = proxy ? `${proxy.host}:${proxy.port}` : "direct";
  const existing = sessions.get(profileId);

  // If session exists with a DIFFERENT proxy config, close and recreate it
  if (existing) {
    if (existing.proxyKey === newProxyKey) return existing;
    log(`Proxy changed for profile ${profileId} (${existing.proxyKey} → ${newProxyKey}), restarting browser`, "browser");
    await closeSession(profileId);
  }

  const proxyArg = proxy ? [`--proxy-server=${proxy.host}:${proxy.port}`] : [];
  log(`Launching Chrome for profile ${profileId}${proxy ? ` via proxy ${proxy.host}:${proxy.port}` : " (direct)"}`, "browser");

  const { default: puppeteer } = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: [...LAUNCH_ARGS, ...proxyArg],
    ignoreHTTPSErrors: true,
  });

  const [page] = await browser.pages();
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1280, height: 760 });

  // Authenticate proxy if credentials supplied
  if (proxy?.username) {
    await page.authenticate({ username: proxy.username, password: proxy.password ?? "" });
  }

  // Prevent bot detection
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Auto-dismiss cookie banners + post-login popups + save cookies on every main-frame navigation
  page.on("framenavigated", async (frame) => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    // Small delay so banners/dialogs have time to render
    await new Promise(r => setTimeout(r, 1500));
    await dismissCookieBanner(page);
    await dismissInstagramPopups(page);
    // Extra pass after another short delay (some popups appear with animation)
    await new Promise(r => setTimeout(r, 1500));
    await dismissInstagramPopups(page);
    // If we've navigated to Instagram and are NOT on the login page,
    // save cookies so the session persists across restarts
    if (
      url &&
      url.includes("instagram.com") &&
      !url.includes("/accounts/login") &&
      !url.includes("/accounts/emailsignup") &&
      !url.includes("about:blank")
    ) {
      await saveCookies(profileId, page);
    }
  });

  // ── Instagram API call interception ─────────────────────────────────────────
  const STATIC_EXT = /\.(jpg|jpeg|png|gif|webp|svg|ico|css|js|woff2?|ttf|eot|mp4|mp3)(\?.*)?$/i;
  const IG_HOSTS = ["instagram.com", "i.instagram.com", "graph.instagram.com", "www.instagram.com"];

  // Telemetry / infrastructure endpoints — not useful to log
  const NOISE_PATHS = new Set([
    "ajax/bz", "ajax/bootloader-endpoint", "ajax/bulk-route-definitions",
    "ajax/logging", "logging_client_events", "sync/instagram",
    "ajax/mercury/rollout", "ajax/navigation",
  ]);

  const isIgApiCall = (url: string) => {
    try {
      const u = new URL(url);
      return IG_HOSTS.some(h => u.hostname === h || u.hostname.endsWith("." + h))
        && !STATIC_EXT.test(u.pathname);
    } catch { return false; }
  };

  const getOpName = (url: string) => {
    try {
      const parts = new URL(url).pathname.replace(/\/$/, "").split("/").filter(Boolean);
      return parts.slice(-2).join("/") || new URL(url).pathname;
    } catch { return url; }
  };

  // Track pending requests: url → { startMs, method }
  const pending = new Map<string, { startMs: number; method: string }>();

  page.on("request", (req) => {
    if (isIgApiCall(req.url())) {
      pending.set(req.url(), { startMs: Date.now(), method: req.method() });
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    const info = pending.get(url);
    if (!info) return;
    pending.delete(url);

    const opName = getOpName(url);
    if (NOISE_PATHS.has(opName)) return; // skip telemetry noise

    const durationMs = Date.now() - info.startMs;
    try {
      await db.insert(instagramApiCalls).values({
        profileId,
        operationName: opName,
        date: new Date().toISOString(),
        message: url,
        source: "Browser",
        navChain: "",
        ipAddress: "",
        durationMs,
      });
    } catch { /* never crash the browser session on a log failure */ }
  });
  // ────────────────────────────────────────────────────────────────────────────

  const session: Session = { browser, page, ws: null, frameLoop: null, lastUrl: "", proxyKey: newProxyKey };
  sessions.set(profileId, session);
  log(`Chrome launched for profile ${profileId}`, "browser");

  // Restore saved cookies if available, then navigate to IG home (already logged in)
  // Otherwise go to the login page so the user can log in
  const cookiesLoaded = await loadCookies(profileId, page);
  if (cookiesLoaded) {
    log(`[cookies:${profileId}] Cookies restored — navigating to Instagram home`, "browser");
    page.goto("https://www.instagram.com/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  } else {
    page.goto("https://www.instagram.com/accounts/login/", { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  }

  return session;
}

export function attachWebSocket(profileId: number, ws: WebSocket) {
  const session = sessions.get(profileId);
  if (!session) return;

  // Replace any existing WebSocket
  if (session.ws && session.ws.readyState === WebSocket.OPEN) {
    session.ws.close();
  }
  session.ws = ws;

  startFrameLoop(profileId);
}

function startFrameLoop(profileId: number) {
  const session = sessions.get(profileId);
  if (!session) return;

  if (session.frameLoop) clearInterval(session.frameLoop);

  let cookieSaveTick = 0;
  let popupCheckTick = 0;

  session.frameLoop = setInterval(async () => {
    const s = sessions.get(profileId);
    if (!s || !s.ws || s.ws.readyState !== WebSocket.OPEN) {
      if (s?.frameLoop) clearInterval(s.frameLoop);
      return;
    }

    try {
      const [screenshot, currentUrl] = await Promise.all([
        s.page.screenshot({ type: "jpeg", quality: 90, encoding: "base64" }),
        s.page.url(),
      ]);

      const frame = JSON.stringify({ type: "frame", data: screenshot, url: currentUrl });
      s.ws.send(frame);

      if (currentUrl !== s.lastUrl) {
        s.lastUrl = currentUrl;
        s.ws.send(JSON.stringify({ type: "urlChange", url: currentUrl }));
      }

      // Check for post-login popups every ~5 seconds
      popupCheckTick++;
      if (popupCheckTick >= 50) { // 50 * 100ms = 5s
        popupCheckTick = 0;
        dismissInstagramPopups(s.page);
      }

      // Save cookies every ~60 seconds to persist any session refreshes
      cookieSaveTick++;
      if (cookieSaveTick >= 600) { // 600 * 100ms = 60s
        cookieSaveTick = 0;
        saveCookies(profileId, s.page);
      }
    } catch {
      // Page navigating — skip frame
    }
  }, 100); // 10 fps
}

export async function browserNavigate(profileId: number, url: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  try {
    s.ws?.send(JSON.stringify({ type: "loading", loading: true }));
    await s.page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    s.ws?.send(JSON.stringify({ type: "loading", loading: false }));
  } catch {
    s.ws?.send(JSON.stringify({ type: "loading", loading: false }));
  }
}

export async function browserClick(profileId: number, x: number, y: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  // Move then click for reliability
  await s.page.mouse.move(x, y);
  await s.page.mouse.click(x, y);
}

export async function browserMouseMove(profileId: number, x: number, y: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.mouse.move(x, y);
}

export async function browserScroll(profileId: number, x: number, y: number, deltaX: number, deltaY: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  // Use Puppeteer's wheel event for accurate scroll
  await s.page.mouse.move(x, y);
  await s.page.mouse.wheel({ deltaX, deltaY });
}

export async function browserKeyDown(profileId: number, key: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  // Map "Space" back to the actual key name Puppeteer expects
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.press(k as any); } catch {}
}

export async function browserKeyUp(profileId: number, key: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  const k = key === "Space" ? " " : key;
  try { await s.page.keyboard.up(k as any); } catch {}
}

export async function browserType(profileId: number, text: string) {
  const s = sessions.get(profileId);
  if (!s) return;
  await s.page.keyboard.type(text, { delay: 30 });
}

export async function browserBack(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  try { await s.page.goBack({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
}

export async function browserForward(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  try { await s.page.goForward({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
}

export async function browserReload(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  try { await s.page.reload({ waitUntil: "domcontentloaded", timeout: 10000 }); } catch {}
}

export async function closeSession(profileId: number) {
  const s = sessions.get(profileId);
  if (!s) return;
  if (s.frameLoop) clearInterval(s.frameLoop);
  if (s.ws) try { s.ws.close(); } catch {}
  await s.browser.close();
  sessions.delete(profileId);
  log(`Chrome closed for profile ${profileId}`, "browser");
}

export async function clearSession(profileId: number, userAgent: string, proxy?: ProxyConfig) {
  deleteSavedCookies(profileId);
  await closeSession(profileId);
  await getOrCreateSession(profileId, userAgent, proxy);
  log(`Session cleared for profile ${profileId}`, "browser");
}

// ── Auto-login via Puppeteer ─────────────────────────────────────────────────

// ── Cookie consent auto-dismissal ────────────────────────────────────────────
// Tries every known Instagram cookie banner selector and clicks Accept.
// Safe to call any time — silently does nothing if no banner is visible.
async function dismissCookieBanner(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      // Selectors for known Instagram / GDPR cookie buttons (text-based + attribute)
      const acceptTexts = [
        "allow all cookies",
        "allow essential and optional cookies",
        "accept all",
        "accept cookies",
        "allow cookies",
        "allow all",
        "akzeptieren",           // German
        "accepter tout",         // French
        "aceptar todo",          // Spanish
        "accetta tutto",         // Italian
        "alle cookies akzeptieren",
      ];

      // 1. Try Instagram's own data attribute
      const attrBtn = document.querySelector<HTMLElement>('[data-cookiebanner="accept_button"]');
      if (attrBtn) { attrBtn.click(); return; }

      // 2. Try role="dialog" buttons matching known text
      const allBtns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));
      for (const btn of allBtns) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();
        if (acceptTexts.some(t => txt.includes(t))) {
          btn.click();
          return;
        }
      }
    });
  } catch {
    // Page navigating or closed — ignore
  }
}

// ── Instagram post-login popup auto-dismissal ─────────────────────────────────
// Handles two common popups that appear after first login:
//   1. "The messaging tab has a new look" → click "OK"
//   2. "Save your login info?"            → click "Save Info"
// Safe to call repeatedly — does nothing when no matching popup is visible.
async function dismissInstagramPopups(page: Page): Promise<void> {
  try {
    await page.evaluate(() => {
      const allBtns = Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"]'));

      for (const btn of allBtns) {
        const txt = (btn.innerText || btn.textContent || "").trim().toLowerCase();

        // "Save your login info?" dialog → click "Save Info"
        if (txt === "save info" || txt === "save login info") {
          btn.click();
          return;
        }
      }

      // "The messaging tab has a new look" dialog → click "OK"
      // Look for a dialog/sheet whose body text mentions the messaging tab
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [role="alertdialog"]'));
      for (const dialog of dialogs) {
        const body = (dialog.innerText || dialog.textContent || "").toLowerCase();
        if (body.includes("messaging tab") || body.includes("new look")) {
          const okBtn = Array.from(dialog.querySelectorAll<HTMLElement>('button, [role="button"]'))
            .find(b => (b.innerText || b.textContent || "").trim().toLowerCase() === "ok");
          if (okBtn) { okBtn.click(); return; }
        }
      }
    });
  } catch {
    // Page navigating or closed — ignore
  }
}

function sendStatus(profileId: number, message: string) {
  const s = sessions.get(profileId);
  if (s?.ws?.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify({ type: "loginStatus", message }));
  }
  log(`[autoLogin:${profileId}] ${message}`, "browser");
}

export function sendLoginDone(profileId: number, ok: boolean, message: string) {
  const s = sessions.get(profileId);
  if (s?.ws?.readyState === WebSocket.OPEN) {
    s.ws.send(JSON.stringify({ type: "loginDone", ok, message }));
  }
  log(`[loginDone:${profileId}] ${ok ? "✅" : "❌"} ${message}`, "browser");
}

// Fill a field using real keyboard events so React's controlled inputs update correctly.
async function fillField(page: Page, selector: string, text: string) {
  await page.click(selector);
  // Select all existing text then delete it
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Backspace');
  // Type character-by-character — this fires the keyboard events React listens to
  await page.type(selector, text, { delay: 55 });
}

// Click at real mouse coordinates — same path as a manual canvas click.
async function realClick(page: Page, selector: string): Promise<boolean> {
  const el = await page.$(selector).catch(() => null);
  if (!el) return false;
  const box = await el.boundingBox().catch(() => null);
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await new Promise(r => setTimeout(r, 120));
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return true;
}

export async function browserAutoLogin(
  profileId: number,
  username: string,
  password: string,
  twoFAKey: string,
): Promise<{ ok: boolean; message: string }> {
  const s = sessions.get(profileId);
  if (!s) return { ok: false, message: "No active browser session" };

  const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

  try {
    // ── Step 1: Navigate to login page (skip if already there) ──────────────
    const currentUrl = s.page.url();
    if (!currentUrl.includes("instagram.com/accounts/login")) {
      sendStatus(profileId, "Navigating to Instagram login…");
      await s.page.goto("https://www.instagram.com/accounts/login/", {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      }).catch(() => null);
    }

    // Dismiss cookie banner if present
    await delay(1500);
    await dismissCookieBanner(s.page);
    await delay(400);

    // ── Step 2: Check for login form ─────────────────────────────────────────
    sendStatus(profileId, "Looking for login form…");
    const usernameInput = await s.page.waitForSelector('input[name="username"]', { timeout: 15000 }).catch(() => null);

    if (!usernameInput) {
      const currentUrl = s.page.url();
      if (!currentUrl.includes("accounts/login")) {
        await saveCookies(profileId, s.page);
        sendStatus(profileId, "✓ Already logged in — browser shows your account.");
        return { ok: true, message: "Already logged in" };
      }
      // Can't find the form — leave browser open showing whatever Instagram has
      sendStatus(profileId, "⚠ Login form not found — check the browser window for what Instagram is showing.");
      return { ok: false, message: "Login form not found. Check the browser window." };
    }

    // ── Step 3: Fill credentials ─────────────────────────────────────────────
    sendStatus(profileId, "Filling username…");
    await delay(500 + Math.random() * 300);
    await fillField(s.page, 'input[name="username"]', username);

    await delay(300 + Math.random() * 200);

    sendStatus(profileId, "Filling password…");
    await fillField(s.page, 'input[name="password"]', password);

    // ── Step 4: Submit ───────────────────────────────────────────────────────
    sendStatus(profileId, "Waiting for login button…");
    await delay(500);

    // Dump every button/role=button on the page so we know the real DOM
    const allBtns = await s.page.evaluate(() =>
      Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => {
        const r = (el as HTMLElement).getBoundingClientRect();
        return {
          tag: el.tagName,
          type: (el as HTMLButtonElement).type || '',
          text: (el as HTMLElement).innerText?.trim().slice(0, 40),
          disabled: (el as HTMLButtonElement).disabled ?? false,
          x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        };
      })
    ).catch(() => []);
    log(`[autoLogin:${profileId}] All buttons: ${JSON.stringify(allBtns)}`, 'browser');

    // Find the login button — match "Log in" / "Login" in text (ignore disabled state,
    // real mouse clicks can activate buttons regardless of HTML disabled attribute).
    const loginBtn = allBtns.find(b =>
      b.w > 50 && /log.?in/i.test(b.text)
    ) || allBtns.find(b => b.w > 100 && b.h > 20 && b.text.length > 0);

    sendStatus(profileId, "Submitting login…");

    if (loginBtn && loginBtn.w > 0) {
      log(`[autoLogin:${profileId}] Clicking: ${JSON.stringify(loginBtn)}`, 'browser');
      const cx = loginBtn.x + loginBtn.w / 2;
      const cy = loginBtn.y + loginBtn.h / 2;
      await s.page.mouse.move(cx, cy);
      await delay(120);
      await s.page.mouse.click(cx, cy);
    } else {
      // Last resort: Tab from password field to button, then press Enter
      log(`[autoLogin:${profileId}] No button found — using Tab+Enter`, 'browser');
      await s.page.focus('input[name="password"]');
      await s.page.keyboard.press('Tab');
      await delay(200);
      await s.page.keyboard.press('Enter');
    }

    // ── Step 5: Wait for Instagram to respond ────────────────────────────────
    sendStatus(profileId, "Login submitted — waiting for Instagram…");

    // Wait up to 10 s for the login form to disappear from the page
    await Promise.race([
      s.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }).catch(() => null),
      s.page.waitForFunction(() => {
        const t = document.body?.innerText || "";
        // The login form always contains this phrase — once it's gone, we've moved on
        return !t.includes("Username, email or mobile number");
      }, { timeout: 10000 }).catch(() => null),
    ]);

    // Wait for the new page content to actually render (2FA page loads after form goes)
    await s.page.waitForFunction(() =>
      (document.body?.innerText || "").length > 80, { timeout: 6000 }
    ).catch(() => null);
    await delay(300);
    await dismissCookieBanner(s.page);

    // ── Step 6: Detect what's on screen by content, not URL ──────────────────
    // The 2FA hash-route URL still contains "/accounts/login" — can't use URL alone.
    const pageText = await s.page.evaluate(() =>
      (document.body?.innerText || "").slice(0, 600).trim()
    ).catch(() => "");
    log(`[autoLogin:${profileId}] Page after submit: "${pageText.slice(0, 150)}"`, 'browser');
    const pageUrl = s.page.url();

    const is2FA = /authentication.app|6.digit|two.factor|verif|security.code|confirmation.code|backup.code|enter.the.code/i.test(pageText) ||
                  pageUrl.includes("/two_factor") || pageUrl.includes("challenge");

    const isLoggedIn = !pageText.includes("Username, email or mobile number") &&
                       !pageText.includes("Create new account") &&
                       !pageUrl.includes("/accounts/login");

    // ── Step 7: Auto-fill TOTP if 2FA screen detected ────────────────────────
    if (is2FA) {
      const keyClean = twoFAKey.replace(/\s+/g, "");
      if (keyClean) {
        sendStatus(profileId, "2FA screen — entering TOTP code automatically…");
        const code = await totpGenerate({ secret: keyClean });
        // Find the code input (could be any visible single input on the 2FA page)
        const codeInput = await s.page.$('input[inputmode="numeric"], input[name="verificationCode"], input[type="text"], input[type="tel"]').catch(() => null);
        if (codeInput) {
          await fillField(s.page, 'input[inputmode="numeric"], input[name="verificationCode"], input[type="text"], input[type="tel"]', code);
          await delay(400);
          // Click "Continue" button
          const contBtns = await s.page.evaluate(() =>
            Array.from(document.querySelectorAll('button, [role="button"]')).map((el) => {
              const r = (el as HTMLElement).getBoundingClientRect();
              return { text: (el as HTMLElement).innerText?.trim(), x: r.x, y: r.y, w: r.width, h: r.height };
            })
          ).catch(() => [] as any[]);
          const contBtn = contBtns.find((b: any) => /continue|verify|submit/i.test(b.text) && b.w > 50);
          if (contBtn) {
            await s.page.mouse.move(contBtn.x + contBtn.w / 2, contBtn.y + contBtn.h / 2);
            await delay(100);
            await s.page.mouse.click(contBtn.x + contBtn.w / 2, contBtn.y + contBtn.h / 2);
          } else {
            await s.page.keyboard.press("Enter");
          }
          await delay(3000);
          await saveCookies(profileId, s.page);
          sendStatus(profileId, `TOTP code entered — check browser for result.`);
          return { ok: true, message: "2FA code submitted" };
        } else {
          sendStatus(profileId, "2FA screen — enter the code in the browser window.");
          return { ok: true, message: "2FA screen shown" };
        }
      } else {
        sendStatus(profileId, "2FA screen — no TOTP key stored. Enter the code in the browser window.");
        return { ok: true, message: "2FA screen — manual entry needed" };
      }
    }

    if (isLoggedIn) {
      await saveCookies(profileId, s.page);
      sendStatus(profileId, "✓ Logged in — browser is showing your Instagram.");
      return { ok: true, message: "Login successful" };
    }

    // Still appears to be on the login page — report what's visible
    const snippet = pageText.slice(0, 150);
    const msg = snippet
      ? `Instagram is showing: "${snippet}" — handle it in the browser window.`
      : "Instagram is showing a challenge — check the browser window.";
    sendStatus(profileId, `⚠ ${msg}`);
    return { ok: false, message: msg };

  } catch (err: any) {
    const msg = err?.message || "Unknown error during login";
    sendStatus(profileId, `Error: ${msg}`);
    return { ok: false, message: msg };
  }
}
