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

import { BrowserWindow, Menu, session as electronSession, ipcMain } from "electron";
import http from "http";
import fs from "fs";
import path from "path";
import net from "net";
import { createHmac } from "crypto";

// ── Toolbar injection script ───────────────────────────────────────────────────
// Injected via executeJavaScript into the EB window after every full page load.
// Uses window.__eq (exposed by ebToolbarPreload.ts via contextBridge) to route
// all button actions through IPC → ipcMain handler → eb-toolbar-cmd.
// username is embedded via JSON.stringify so any character is safe.
function buildToolbarJs(_username: string): string {
  return `(function(){
  if(document.getElementById('__eq_bar__'))return;
  var bar=document.createElement('div');
  bar.id='__eq_bar__';
  bar.style.cssText='position:fixed;top:0;left:0;right:0;height:44px;z-index:2147483647;background:#ffffff;border-bottom:1px solid #e2e8f0;display:flex;align-items:center;gap:4px;padding:0 8px;font-family:-apple-system,"Segoe UI",sans-serif;box-shadow:0 1px 4px rgba(0,0,0,.06);';
  function mkBtn(title,html,onclick,extra){
    var b=document.createElement('button');
    b.title=title;b.innerHTML=html;b.onclick=onclick;
    b.style.cssText='height:30px;min-width:30px;padding:0 8px;background:transparent;border:1px solid #d1d5db;color:#374151;border-radius:5px;cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:4px;white-space:nowrap;'+(extra||'');
    b.onmouseenter=function(){b.style.background='#f3f4f6';};
    b.onmouseleave=function(){b.style.background='transparent';};
    return b;
  }
  function sep(){var s=document.createElement('span');s.style.cssText='width:1px;height:20px;background:#e2e8f0;margin:0 2px;flex-shrink:0;';return s;}
  function cmd(c,p){return window.__eq&&window.__eq.command(c,p);}
  // Track the last input/textarea the user focused so paste-style buttons
  // (Phone, Email, etc.) can target it even after focus shifts to the button.
  window.__eq_lastInput=null;
  document.addEventListener('focusin',function(e){
    var t=e.target;
    if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA')&&t.id!=='__eq_url__'){
      window.__eq_lastInput=t;
    }
  },true);
  bar.appendChild(mkBtn('Back','&#9664;',function(){cmd('back');}));
  bar.appendChild(mkBtn('Forward','&#9654;',function(){cmd('forward');}));
  bar.appendChild(mkBtn('Reload','&#8635;',function(){cmd('reload');}));
  bar.appendChild(mkBtn('Instagram Home','&#8962;',function(){cmd('navigate',{url:'https://www.instagram.com/'});}));
  bar.appendChild(mkBtn('New tab','&#43;',function(){cmd('new-tab');}));
  bar.appendChild(sep());
  var inp=document.createElement('input');
  inp.id='__eq_url__';inp.value=location.href;
  inp.style.cssText='flex:1;min-width:0;height:30px;padding:0 10px;background:#f9fafb;border:1px solid #d1d5db;border-radius:5px;color:#111827;font-size:12px;font-family:monospace;outline:none;box-sizing:border-box;';
  inp.onfocus=function(){inp.style.borderColor='#3b82f6';inp.select();};
  inp.onblur=function(){inp.style.borderColor='#d1d5db';};
  inp.onkeydown=function(e){if(e.key==='Enter'){e.preventDefault();var u=inp.value.trim();if(u&&u.indexOf('http')!==0)u='https://'+u;cmd('navigate',{url:u});}};
  bar.appendChild(inp);
  bar.appendChild(sep());
  var loginBtn=mkBtn('Find username & password fields on this page and fill them in','&#8594; Login',function(){loginBtn.disabled=true;loginBtn.style.opacity='0.5';Promise.resolve(cmd('login')).then(function(){loginBtn.disabled=false;loginBtn.style.opacity='1';});},'border-color:#3b82f6;color:#1d4ed8;');
  bar.appendChild(loginBtn);
  bar.appendChild(mkBtn('Generate TOTP code and type it into the focused field','&#128273; 2FA',function(){cmd('totp');}));
  bar.appendChild(mkBtn('Type pre-filled phone number into the focused field','&#128242; Phone',function(){cmd('phone');}));
  bar.appendChild(mkBtn('Type email address into the focused field','&#9993; Email',function(){cmd('email-user');}));
  bar.appendChild(mkBtn('Type email password into the focused field','&#128274; Email Pass',function(){cmd('email-pass');}));
  bar.appendChild(sep());
  var timerEl=document.createElement('span');
  timerEl.title='Time since browser was opened';
  timerEl.style.cssText='font-size:11px;color:#6b7280;white-space:nowrap;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;padding-right:2px;';
  var _start=parseInt(sessionStorage.getItem('__eq_open_ts')||'0',10);
  if(!_start){_start=Date.now();try{sessionStorage.setItem('__eq_open_ts',String(_start));}catch(e){}}
  function _tick(){var s=Math.floor((Date.now()-_start)/1000),m=Math.floor(s/60);s=s%60;timerEl.textContent=m+':'+(s<10?'0':'')+s;}
  _tick();setInterval(_tick,1000);
  bar.appendChild(timerEl);
  document.body.prepend(bar);
  window.__eq_syncUrl=function(u){var el=document.getElementById('__eq_url__');if(el&&document.activeElement!==el)el.value=u;};
})();`;
}

// ── Module state ───────────────────────────────────────────────────────────────

let _serverPort = 0;
let _cookiesDir  = "";
let _iconPath    = "";

interface EbEntry {
  win: BrowserWindow;
  username: string;
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

  // Focus existing window if already open (or hidden via close→hide handler)
  const existing = ebMap.get(profileId);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    if (!existing.win.isVisible()) existing.win.show();
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
      preload: path.join(__dirname, "ebToolbarPreload.js"),
    },
  });

  // Block sub-browsers: any window.open() or target="_blank" link Instagram fires
  // would normally spawn a brand-new BrowserWindow child. Instead, intercept every
  // new-window request and load the URL inside this same window so only 1 EB exists
  // per account at all times.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url && !url.startsWith("about:") && !url.startsWith("chrome-error://")) {
      win.webContents.loadURL(url).catch(() => {});
    }
    return { action: "deny" };
  });

  // Hide to tray on close (matching main-window behaviour) so the EB session
  // survives an accidental X-click. The /eb/close IPC endpoint calls win.destroy()
  // directly when the user explicitly closes from the BrowserPanel.
  win.on("close", (event) => {
    event.preventDefault();
    win.hide();
  });

  win.on("closed", () => {
    ebMap.delete(profileId);
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
  ebMap.set(profileId, { win, username, proxy });

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

  // Inject the toolbar overlay after every full page load
  win.webContents.on("did-finish-load", () => {
    win.webContents.executeJavaScript(buildToolbarJs(username)).catch(() => {});
  });

  // Prevent Instagram's page <title> from overriding the window title.
  // Without this, Electron replaces "@username — Equinox Browser" with "Instagram".
  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(`@${username} — Equinox Browser`);
  });

  // Right-click context menu: cut / copy / paste / select-all
  win.webContents.on("context-menu", (_e, params) => {
    const tpl: Electron.MenuItemConstructorOptions[] = [];
    if (params.editFlags.canCut)   tpl.push({ role: "cut" });
    if (params.editFlags.canCopy)  tpl.push({ role: "copy" });
    if (params.editFlags.canPaste) tpl.push({ role: "paste" });
    tpl.push({ type: "separator" }, { role: "selectAll" });
    Menu.buildFromTemplate(tpl).popup({ window: win });
  });

  // SPA navigations (Instagram pushState) don't fire did-finish-load —
  // the toolbar DOM survives, just update the URL bar.
  win.webContents.on("did-navigate-in-page", (_e, navUrl) => {
    win.webContents.executeJavaScript(
      `window.__eq_syncUrl && window.__eq_syncUrl(${JSON.stringify(navUrl)})`
    ).catch(() => {});
  });

  // Navigate to Instagram
  const hasCookies = fs.existsSync(cookieFilePath(profileId));
  win.webContents.loadURL(
    hasCookies
      ? "https://www.instagram.com/"
      : "https://www.instagram.com/accounts/login/",
  ).catch(() => {});
}

// ── Toolbar IPC handler ────────────────────────────────────────────────────────

let _toolbarIpcRegistered = false;

function setupToolbarIpc(): void {
  if (_toolbarIpcRegistered) return;
  _toolbarIpcRegistered = true;

  ipcMain.handle("eb-toolbar-cmd", async (event, cmd: string, payload?: any) => {
    // Identify which profile's EB window sent this command
    const sender = event.sender;
    let foundPid = 0;
    let foundWin: BrowserWindow | null = null;
    for (const [pid, entry] of ebMap.entries()) {
      if (!entry.win.isDestroyed() && entry.win.webContents === sender) {
        foundPid = pid;
        foundWin = entry.win;
        break;
      }
    }
    if (!foundPid || !foundWin) return;

    const wc = foundWin.webContents;

    // Helper: type text into the renderer's currently-focused input (same script
    // used by /eb/input so behaviour is identical to BrowserPanel typing)
    const typeIntoFocused = async (text: string) => {
      const chars = JSON.stringify(text);
      // Use __eq_lastInput (set by focusin listener in the toolbar) so paste
      // works even though clicking the button shifts focus away from the field.
      await wc.executeJavaScript(`(function(){
        var el=window.__eq_lastInput||document.activeElement;
        if(!el||el.tagName==='BUTTON'||el===document.body)return;
        var proto=Object.getPrototypeOf(el);
        var desc=Object.getOwnPropertyDescriptor(proto,'value')||Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value');
        var setter=desc&&desc.set;
        var cur=el.value||'';
        if(setter){setter.call(el,cur+${chars});el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));}
        else{el.value=cur+${chars};el.dispatchEvent(new Event('input',{bubbles:true}));}
        el.focus();
      })()`).catch(() => {});
    };

    switch (cmd) {
      case "back":
        if ((wc.navigationHistory as any)?.canGoBack?.()) (wc.navigationHistory as any).goBack();
        else if ((wc as any).canGoBack?.()) (wc as any).goBack();
        break;

      case "forward":
        if ((wc.navigationHistory as any)?.canGoForward?.()) (wc.navigationHistory as any).goForward();
        else if ((wc as any).canGoForward?.()) (wc as any).goForward();
        break;

      case "reload":
        wc.reloadIgnoringCache();
        break;

      case "navigate":
        if (payload?.url) wc.loadURL(payload.url).catch(() => {});
        break;

      case "login": {
        // Fill username + password into the visible Instagram login form.
        // Searches the current page for the fields first; navigates to the
        // login page only if they aren't present yet.
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const usr = JSON.stringify(p.username ?? "");
          const pwd = JSON.stringify(p.password ?? "");
          await wc.executeJavaScript(`(async () => {
            const wait = ms => new Promise(res => setTimeout(res, ms));
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            const fill = (el, val) => {
              setter.call(el, val);
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            let uInp = document.querySelector('input[name="username"]') || document.querySelector('input[autocomplete="username"]');
            let pInp = document.querySelector('input[name="password"]') || document.querySelector('input[type="password"]');
            if (!uInp && !pInp) {
              window.location.href = 'https://www.instagram.com/accounts/login/';
              return;
            }
            if (uInp) { fill(uInp, ${usr}); uInp.focus(); }
            await wait(250);
            if (pInp) { fill(pInp, ${pwd}); pInp.focus(); }
            await wait(400);
            const btn = document.querySelector('button[type="submit"]');
            if (btn && !btn.disabled) btn.click();
          })()`).catch(() => {});
        } catch {}
        break;
      }

      case "new-tab": {
        // Open a second browser window sharing the same session partition
        const entry = ebMap.get(foundPid);
        const partition = `persist:eb-${foundPid}`;
        const tabWin = new BrowserWindow({
          width: 1280, height: 900,
          title: `@${entry?.username ?? foundPid} — Equinox Browser`,
          icon: _iconPath || undefined,
          webPreferences: {
            partition,
            preload: require("path").join(__dirname, "ebToolbarPreload.js"),
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        const tabUsr = entry?.username ?? String(foundPid);
        tabWin.webContents.on("did-finish-load", () => {
          tabWin.webContents.executeJavaScript(buildToolbarJs(tabUsr)).catch(() => {});
        });
        tabWin.webContents.on("page-title-updated", (e) => {
          e.preventDefault();
          tabWin.setTitle(`@${tabUsr} — Equinox Browser`);
        });
        tabWin.webContents.on("context-menu", (_e, params) => {
          const tpl: Electron.MenuItemConstructorOptions[] = [];
          if (params.editFlags.canCut)   tpl.push({ role: "cut" });
          if (params.editFlags.canCopy)  tpl.push({ role: "copy" });
          if (params.editFlags.canPaste) tpl.push({ role: "paste" });
          tpl.push({ type: "separator" }, { role: "selectAll" });
          Menu.buildFromTemplate(tpl).popup({ window: tabWin });
        });
        tabWin.loadURL("https://www.instagram.com/").catch(() => {});
        tabWin.show();
        break;
      }

      case "totp": {
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const key = (p.twoFASecretKey ?? "").trim();
          if (key) {
            const code = generateTotp(key);
            await typeIntoFocused(code);
          }
        } catch {}
        break;
      }

      case "phone": {
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/settings`);
          const s = await r.json() as any;
          const num = (s.preFilledPhoneNumber ?? "").trim();
          if (num) await typeIntoFocused(num);
        } catch {}
        break;
      }

      case "email-user": {
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const val = (p.emailValidationUsername ?? "").trim();
          if (val) await typeIntoFocused(val);
        } catch {}
        break;
      }

      case "email-pass": {
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const val = (p.emailValidationPassword ?? "").trim();
          if (val) await typeIntoFocused(val);
        } catch {}
        break;
      }

      case "clear": {
        // Wipe the session: destroy window, clear storage, delete cookie file
        foundWin.destroy();
        await new Promise(r => setTimeout(r, 200));
        ebMap.delete(foundPid);
        const ses = electronSession.fromPartition(`persist:eb-${foundPid}`);
        await ses.clearStorageData({
          storages: ["cookies", "localstorage", "cachestorage", "shadercache", "websql", "serviceworkers"],
        }).catch(() => {});
        const fp = cookieFilePath(foundPid);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}
        break;
      }

      default:
        break;
    }
  });
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
  setupToolbarIpc();

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
          // destroy() bypasses the "close" event handler that hides the window,
          // so this actually removes the window rather than hiding it to tray.
          e.win.destroy();
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

      // ── POST /eb/silent-verify ─────────────────────────────────────────────────
      // Full EB login in a hidden (never-shown) BrowserWindow.
      // Used by the Verify button so no EB window pops up during verification.
      // Opens hidden window → loads existing cookies → auto-login → extract cookies
      // → destroy window → return { ok, message, cookies }.
      if (req.method === "POST" && u.pathname === "/eb/silent-verify") {
        const partition = `persist:eb-${pid}`;
        const ses = electronSession.fromPartition(partition);
        if (body.proxy) {
          await ses.setProxy({ proxyRules: `${body.proxy.host}:${body.proxy.port}` });
        } else {
          await ses.setProxy({ proxyRules: "direct://" });
        }
        await loadCookiesFromFile(pid, ses);

        const hiddenWin = new BrowserWindow({
          width: 1280,
          height: 820,
          show: false,
          skipTaskbar: true,
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition,
          },
        });

        if (body.proxy) {
          hiddenWin.webContents.on("login", (_ev: any, _rq: any, _auth: any, cb: any) => {
            cb(body.proxy.user ?? "", body.proxy.pass ?? "");
          });
        }
        if (body.userAgent) {
          hiddenWin.webContents.setUserAgent(body.userAgent);
        }

        try {
          const loginResult = await doAutoLogin(pid, hiddenWin, body.username, body.password, body.twoFAKey ?? "");
          const c1 = await ses.cookies.get({ domain: ".instagram.com" });
          const c2 = await ses.cookies.get({ domain: "instagram.com" });
          const seen = new Set<string>();
          const cookies = [...c1, ...c2].filter(c => {
            if (seen.has(c.name)) return false;
            seen.add(c.name);
            return true;
          }).map(c => ({ name: c.name, value: c.value }));
          hiddenWin.destroy();
          return send(res, 200, { ...loginResult, cookies });
        } catch (err: any) {
          try { hiddenWin.destroy(); } catch {}
          return send(res, 200, { ok: false, message: err?.message ?? "Silent verify error", cookies: [] });
        }
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
          e.win.destroy();
          await new Promise(r => setTimeout(r, 200));
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

// ── Public helper used by main.ts IPC handlers ─────────────────────────────────

/** Bring an already-open EB window to the front, or no-op if not open. */
export function focusEbWindow(profileId: number): void {
  const e = ebMap.get(profileId);
  if (e && !e.win.isDestroyed()) {
    if (e.win.isMinimized()) e.win.restore();
    if (!e.win.isVisible()) e.win.show();
    e.win.focus();
  }
}
