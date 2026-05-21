/**
 * ebManager.ts — Native Electron BrowserWindow EB management.
 *
 * Replaces the Puppeteer + CDP screencast pipeline with proper native
 * Electron BrowserWindow instances (one per account), exactly like
 * Jarvee's CEF-based embedded browser approach.
 *
 * The API server communicates with this manager via a local HTTP IPC
 * server on EB_IPC_PORT.  Cookie updates are pushed back to the API
 * server at serverPort via HTTP.
 */

import { BrowserWindow, session as electronSession } from "electron";
import http from "http";
import fs from "fs";
import path from "path";
import net from "net";
import { createHmac } from "crypto";

// ── Module state ───────────────────────────────────────────────────────────────

let _serverPort = 0;
let _cookiesDir  = "";
let _iconPath    = "";

interface EbEntry {
  win: BrowserWindow;
  proxy?: { host: string; port: number; user?: string; pass?: string };
}
const ebMap = new Map<number, EbEntry>();

// ── Cookie file helpers ────────────────────────────────────────────────────────

function cookieFilePath(profileId: number): string {
  return path.join(_cookiesDir, `cookies-${profileId}.json`);
}

async function loadCookiesFromFile(profileId: number, ses: Electron.Session): Promise<void> {
  const fp = cookieFilePath(profileId);
  if (!fs.existsSync(fp)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const c of raw) {
      if (!c.name || !c.value) continue;
      const domain: string = c.domain ?? ".instagram.com";
      await ses.cookies.set({
        url:            `https://${domain.replace(/^\./, "") || "instagram.com"}`,
        name:           c.name,
        value:          c.value,
        domain:         domain,
        path:           c.path  ?? "/",
        secure:         c.secure  ?? true,
        httpOnly:       c.httpOnly ?? false,
        expirationDate: (c.expires && c.expires !== -1) ? c.expires : undefined,
        sameSite:       "no_restriction",
      }).catch(() => {});
    }
    console.log(`[ebManager:${profileId}] Loaded cookies from file (${raw.length})`);
  } catch (e) {
    console.warn(`[ebManager:${profileId}] loadCookiesFromFile failed:`, e);
  }
}

async function saveCookiesToFile(profileId: number, ses: Electron.Session): Promise<void> {
  try {
    const c1 = await ses.cookies.get({ domain: ".instagram.com" });
    const c2 = await ses.cookies.get({ domain:  "instagram.com" });
    const seen = new Set<string>();
    const all = [...c1, ...c2].filter(c => {
      if (seen.has(c.name)) return false;
      seen.add(c.name);
      return true;
    });
    if (!all.length) return;
    const asFile = all.map(c => ({
      name:      c.name,
      value:     c.value,
      domain:    c.domain    ?? ".instagram.com",
      path:      c.path      ?? "/",
      expires:   c.expirationDate ?? -1,
      httpOnly:  c.httpOnly  ?? false,
      secure:    c.secure    ?? true,
      session:   !c.expirationDate,
      sameSite:  "None",
    }));
    fs.mkdirSync(_cookiesDir, { recursive: true });
    fs.writeFileSync(cookieFilePath(profileId), JSON.stringify(asFile, null, 2));
    console.log(`[ebManager:${profileId}] Saved ${asFile.length} cookies to file`);
  } catch (e) {
    console.warn(`[ebManager:${profileId}] saveCookiesToFile failed:`, e);
  }
}

function pushCookiesToServer(profileId: number, cookies: { name: string; value: string }[]): void {
  if (!_serverPort) return;
  const body = JSON.stringify({ cookies });
  const req = http.request({
    hostname: "127.0.0.1",
    port:     _serverPort,
    path:     `/api/profiles/${profileId}/eb-cookies`,
    method:   "POST",
    headers: {
      "Content-Type":   "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
  });
  req.on("error", () => {});
  req.write(body);
  req.end();
}

async function syncCookies(profileId: number, ses: Electron.Session): Promise<void> {
  await saveCookiesToFile(profileId, ses);
  const c1 = await ses.cookies.get({ domain: ".instagram.com" });
  const c2 = await ses.cookies.get({ domain:  "instagram.com" });
  const seen = new Set<string>();
  const all = [...c1, ...c2].filter(c => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
  pushCookiesToServer(profileId, all.map(c => ({ name: c.name, value: c.value })));
}

// ── Simple TOTP (RFC-6238, base32 key, SHA-1, 6-digit) ────────────────────────

function generateTotp(base32Key: string): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const key = base32Key.replace(/\s+/g, "").toUpperCase();
  let bits = 0, acc = 0;
  const bytes: number[] = [];
  for (const ch of key) {
    const idx = CHARS.indexOf(ch);
    if (idx < 0) continue;
    acc = (acc << 5) | idx;
    bits += 5;
    if (bits >= 8) { bytes.push((acc >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  const keyBuf = Buffer.from(bytes);
  const ctr = Math.floor(Date.now() / 30000);
  const ctBuf = Buffer.alloc(8);
  ctBuf.writeUInt32BE(Math.floor(ctr / 0x100000000), 0);
  ctBuf.writeUInt32BE(ctr & 0xffffffff, 4);
  const hmac = createHmac("sha1", keyBuf).update(ctBuf).digest();
  const off   = hmac[hmac.length - 1] & 0xf;
  const code  = ((hmac[off] & 0x7f) << 24) |
                ((hmac[off+1] & 0xff) << 16) |
                ((hmac[off+2] & 0xff) <<  8) |
                 (hmac[off+3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// ── Wait for navigation helper ─────────────────────────────────────────────────

function waitForNav(
  wc: Electron.WebContents,
  predicate: (url: string) => boolean,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wc.removeListener("did-navigate", handler);
      wc.removeListener("did-navigate-in-page", handler);
      resolve(wc.getURL());
    }, timeoutMs);
    const handler = (_: unknown, url: string) => {
      if (predicate(url)) {
        clearTimeout(timer);
        wc.removeListener("did-navigate", handler);
        wc.removeListener("did-navigate-in-page", handler);
        resolve(url);
      }
    };
    wc.on("did-navigate", handler);
    wc.on("did-navigate-in-page", handler);
  });
}

// ── Auto-login ─────────────────────────────────────────────────────────────────

async function doAutoLogin(
  profileId: number,
  win: BrowserWindow,
  username: string,
  password: string,
  twoFAKey: string,
): Promise<{ ok: boolean; message: string }> {
  const wc  = win.webContents;
  const ses = electronSession.fromPartition(`persist:eb-${profileId}`);
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // Navigate to login page
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Login page load timeout")), 30000);
      wc.once("did-finish-load", () => { clearTimeout(t); resolve(); });
      wc.loadURL("https://www.instagram.com/accounts/login/").catch(reject);
    });
  } catch (e: any) {
    return { ok: false, message: `Failed to load login page: ${e?.message}` };
  }
  await delay(1500);

  // Fill credentials using React-compatible native setter
  const fillResult: boolean = await wc.executeJavaScript(`
    (async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      let uInp, pInp, tries = 0;
      while (tries++ < 20) {
        uInp = document.querySelector('input[name="username"]');
        pInp = document.querySelector('input[name="password"]');
        if (uInp && pInp) break;
        await wait(500);
      }
      if (!uInp || !pInp) return false;
      setter.call(uInp, ${JSON.stringify(username)});
      uInp.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(200);
      setter.call(pInp, ${JSON.stringify(password)});
      pInp.dispatchEvent(new Event("input", { bubbles: true }));
      await wait(400);
      const btn = document.querySelector('button[type="submit"]');
      if (btn && !btn.disabled) btn.click();
      return true;
    })()
  `).catch(() => false);

  if (!fillResult) {
    return { ok: false, message: "Could not find login form on Instagram login page" };
  }

  // Wait up to 30s for navigation away from login page
  const postLoginUrl = await waitForNav(
    wc,
    url => url.includes("instagram.com") && !url.includes("accounts/login"),
    30000,
  );
  await delay(1000);

  // Handle 2FA if required
  const needs2FA: boolean = await wc.executeJavaScript(`
    !!document.querySelector('input[name="verificationCode"], input[aria-label*="security" i], input[aria-label*="code" i]')
  `).catch(() => false);

  if (needs2FA) {
    if (!twoFAKey) {
      return { ok: false, message: "2FA required but no 2FA key configured for this account" };
    }
    const code = generateTotp(twoFAKey);
    await wc.executeJavaScript(`
      (async () => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        const inp = document.querySelector('input[name="verificationCode"], input[aria-label*="security" i], input[aria-label*="code" i]');
        if (!inp) return;
        setter.call(inp, ${JSON.stringify(code)});
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        await wait(400);
        const btn = document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      })()
    `).catch(() => {});
    await waitForNav(
      wc,
      url => url.includes("instagram.com") && !url.includes("two_factor"),
      20000,
    );
    await delay(1000);
  }

  const finalUrl = wc.getURL();

  // Check for challenge redirect
  if (
    finalUrl.includes("update_risky_contactpoint") ||
    finalUrl.includes("/challenge/") ||
    finalUrl.includes("accounts/suspended") ||
    finalUrl.includes("accounts/disabled")
  ) {
    return { ok: false, message: `Instagram challenge detected: ${finalUrl}` };
  }

  // Verify session cookie exists
  const sessionCookies = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
  if (!sessionCookies.length) {
    // Try reading the error message Instagram showed
    const errText: string = await wc.executeJavaScript(`
      (() => {
        const el = document.querySelector('#slfErrorAlert, [data-testid="login-error-message"], form p[role="alert"], ._ab2z');
        return el ? el.textContent.trim().slice(0, 200) : "";
      })()
    `).catch(() => "");
    return { ok: false, message: errText || "Login failed — no session cookie after submission" };
  }

  await syncCookies(profileId, ses);
  return { ok: true, message: "Login successful" };
}

// ── Open / close window ────────────────────────────────────────────────────────

export async function openEbWindow(opts: {
  profileId: number;
  username:  string;
  proxy?:    { host: string; port: number; user?: string; pass?: string };
  userAgent?: string;
}): Promise<void> {
  const { profileId, username, proxy, userAgent } = opts;

  // Focus existing window if already open
  const existing = ebMap.get(profileId);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    existing.win.focus();
    return;
  }

  const partition = `persist:eb-${profileId}`;
  const ses = electronSession.fromPartition(partition);

  // Configure proxy
  if (proxy) {
    await ses.setProxy({ proxyRules: `${proxy.host}:${proxy.port}` });
  } else {
    await ses.setProxy({ proxyRules: "direct://" });
  }

  // Seed existing cookies into the Electron session
  await loadCookiesFromFile(profileId, ses);

  const win = new BrowserWindow({
    width:           1280,
    height:          820,
    title:           `@${username} — Equinox Browser`,
    icon:            _iconPath || undefined,
    autoHideMenuBar: true,
    show:            true,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      partition,
    },
  });

  // Handle proxy authentication
  win.webContents.on("login", (_event, _req, _authInfo, callback) => {
    callback(proxy?.user ?? "", proxy?.pass ?? "");
  });

  // Apply user agent
  if (userAgent) {
    win.webContents.setUserAgent(userAgent);
  }

  // Store in map
  ebMap.set(profileId, { win, proxy });

  win.on("closed", () => {
    ebMap.delete(profileId);
  });

  // Sync cookies + push URL change on every navigation
  win.webContents.on("did-navigate", async (_e, navUrl) => {
    if (navUrl.startsWith("chrome-error://")) return;
    // Push URL change to BrowserPanel address bar (via server WS relay)
    fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-nav`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: navUrl }),
    }).catch(() => {});
    if (!navUrl.includes("instagram.com")) return;
    await new Promise(r => setTimeout(r, 600));
    await syncCookies(profileId, ses);
  });

  // Navigate to Instagram
  const hasCookies = fs.existsSync(cookieFilePath(profileId));
  win.webContents.loadURL(
    hasCookies
      ? "https://www.instagram.com/"
      : "https://www.instagram.com/accounts/login/",
  ).catch(() => {});
}

// ── IPC HTTP request/response helpers ─────────────────────────────────────────

function parseBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", d => { buf += d; });
    req.on("end",  () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, code: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(body);
}

// ── Start the IPC HTTP server ──────────────────────────────────────────────────

export function startEbIpcServer(
  serverPort: number,
  cookiesDir:  string,
  iconPath:    string,
): Promise<number> {
  _serverPort = serverPort;
  _cookiesDir  = cookiesDir;
  _iconPath    = iconPath;

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");

    try {
      // ── GET /eb/state ──────────────────────────────────────────────────────────
      if (req.method === "GET" && u.pathname === "/eb/state") {
        const pid = Number(u.searchParams.get("profileId"));
        const e   = ebMap.get(pid);
        if (!e || e.win.isDestroyed()) return send(res, 200, { open: false, url: "" });
        return send(res, 200, { open: true, url: e.win.webContents.getURL() });
      }

      // ── GET /eb/cookies ────────────────────────────────────────────────────────
      if (req.method === "GET" && u.pathname === "/eb/cookies") {
        const pid = Number(u.searchParams.get("profileId"));
        const ses = electronSession.fromPartition(`persist:eb-${pid}`);
        const c1  = await ses.cookies.get({ domain: ".instagram.com" });
        const c2  = await ses.cookies.get({ domain:  "instagram.com" });
        const c3  = await ses.cookies.get({ domain: ".i.instagram.com" });
        const seen = new Set<string>();
        const all  = [...c1, ...c2, ...c3].filter(c => {
          if (seen.has(c.name)) return false;
          seen.add(c.name);
          return true;
        });
        return send(res, 200, { cookies: all.map(c => ({ name: c.name, value: c.value })) });
      }

      const body = await parseBody(req);
      const pid  = Number(body.profileId ?? 0);

      // ── POST /eb/open ──────────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/open") {
        await openEbWindow({
          profileId: pid,
          username:  body.username  ?? String(pid),
          proxy:     body.proxy,
          userAgent: body.userAgent,
        });
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/focus ─────────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/focus") {
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          if (e.win.isMinimized()) e.win.restore();
          e.win.focus();
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/close ─────────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/close") {
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          // Save cookies before closing
          const ses = electronSession.fromPartition(`persist:eb-${pid}`);
          await saveCookiesToFile(pid, ses);
          e.win.close();
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/navigate ──────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/navigate") {
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          e.win.webContents.loadURL(body.url).catch(() => {});
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/evaluate ──────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/evaluate") {
        const e = ebMap.get(pid);
        if (!e || e.win.isDestroyed()) return send(res, 404, { error: "window not open" });
        const result = await e.win.webContents.executeJavaScript(body.script)
          .catch((err: any) => ({ __error: err?.message }));
        return send(res, 200, { result });
      }

      // ── POST /eb/set-cookies ───────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/set-cookies") {
        const ses = electronSession.fromPartition(`persist:eb-${pid}`);
        for (const c of (body.cookies ?? [])) {
          await ses.cookies.set({
            url:      "https://www.instagram.com",
            name:     c.name,
            value:    c.value,
            domain:   c.domain ?? ".instagram.com",
            path:     c.path   ?? "/",
            secure:   true,
            sameSite: "no_restriction",
          }).catch(() => {});
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/delete-cookies ────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/delete-cookies") {
        const ses = electronSession.fromPartition(`persist:eb-${pid}`);
        for (const name of (body.names ?? [])) {
          await ses.cookies.remove("https://www.instagram.com", name).catch(() => {});
          await ses.cookies.remove("https://instagram.com",     name).catch(() => {});
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/auto-login ────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/auto-login") {
        // Ensure window is open
        let e = ebMap.get(pid);
        if (!e || e.win.isDestroyed()) {
          await openEbWindow({
            profileId: pid,
            username:  body.username  ?? String(pid),
            proxy:     body.proxy,
            userAgent: body.userAgent,
          });
          e = ebMap.get(pid)!;
        }
        const result = await doAutoLogin(pid, e.win, body.username, body.password, body.twoFAKey ?? "");
        return send(res, 200, result);
      }

      // ── POST /eb/input ────────────────────────────────────────────────────────
      // Accepts the same message shapes BrowserPanel sends via send().
      // Routes: navigate, reload, back, forward, type, keydown, newTab.
      if (req.method === "POST" && u.pathname === "/eb/input") {
        const e = ebMap.get(pid);
        if (!e || e.win.isDestroyed()) return send(res, 200, { ok: true, skipped: true });
        const wc = e.win.webContents;
        const { type, url, text, key } = body;
        switch (type) {
          case "navigate":
            if (url) wc.loadURL(url).catch(() => {});
            break;
          case "reload":
            wc.reloadIgnoringCache();
            break;
          case "back":
            if (wc.navigationHistory?.canGoBack?.()) wc.navigationHistory.goBack();
            else if ((wc as any).canGoBack?.()) (wc as any).goBack();
            break;
          case "forward":
            if (wc.navigationHistory?.canGoForward?.()) wc.navigationHistory.goForward();
            else if ((wc as any).canGoForward?.()) (wc as any).goForward();
            break;
          case "type":
          case "keydown":
            if (text || key) {
              // Use executeJavaScript to type into the currently-focused element.
              // Uses React's native input-value setter so controlled components update.
              const chars = text ?? key ?? "";
              const script = `(function(){
                const el = document.activeElement;
                if (!el) return;
                if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
                  const setter = Object.getOwnPropertyDescriptor(
                    Object.getPrototypeOf(el), 'value'
                  )?.set;
                  if (setter) setter.call(el, el.value + ${JSON.stringify(chars)});
                  else el.value = el.value + ${JSON.stringify(chars)};
                  el.dispatchEvent(new Event('input', { bubbles: true }));
                  el.dispatchEvent(new Event('change', { bubbles: true }));
                } else {
                  el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(chars)}, bubbles: true }));
                }
              })()`;
              await wc.executeJavaScript(script).catch(() => {});
            }
            break;
          case "newTab":
            // Open instagram home in same window (native tabs not available)
            wc.loadURL(url ?? "https://www.instagram.com/").catch(() => {});
            break;
          default:
            break;
        }
        // Bring the window to focus so the user can see the result
        if (e.win.isMinimized()) e.win.restore();
        e.win.focus();
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/wipe ──────────────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/wipe") {
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          e.win.close();
          await new Promise(r => setTimeout(r, 800));
        }
        ebMap.delete(pid);

        const ses = electronSession.fromPartition(`persist:eb-${pid}`);
        await ses.clearStorageData({
          storages: ["cookies", "localstorage", "cachestorage", "shadercache", "websql", "serviceworkers"],
        }).catch(() => {});

        const fp = cookieFilePath(pid);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}

        return send(res, 200, { ok: true });
      }

      send(res, 404, { error: "not found" });
    } catch (e: any) {
      send(res, 500, { error: e?.message ?? String(e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      console.log(`[ebManager] IPC server started on port ${port}`);
      resolve(port);
    });
    server.on("error", reject);
  });
}
