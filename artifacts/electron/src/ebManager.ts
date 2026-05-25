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

import { BrowserWindow, BrowserView, Menu, session as electronSession, ipcMain } from "electron";
import http from "http";
import fs from "fs";
import path from "path";
import net from "net";
import { createHmac } from "crypto";

// ── Native toolbar (BrowserView) ───────────────────────────────────────────────
// The toolbar now lives in a native Electron BrowserView that floats on top of
// the Instagram window at the OS compositor level.  It is completely independent
// of the page DOM, so challenge pages, iframes, CSS transforms, overflow:hidden,
// and any other page-level styling CANNOT hide or remove it.
function buildNativeToolbarHtml(): string {
  const styles = `*{box-sizing:border-box;margin:0;padding:0}body{height:92px;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}#navbar{height:58px;display:flex;align-items:center;gap:4px;padding:0 8px;flex-shrink:0}button{height:30px;min-width:30px;padding:0 8px;background:transparent;border:1px solid #d1d5db;color:#6b7280;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:3px;white-space:nowrap}button:hover{background:#f3f4f6;color:#374151}button:disabled{opacity:.5;cursor:default}.sep{width:1px;height:18px;background:#e2e8f0;margin:0 2px;flex-shrink:0}#url{flex:1;min-width:0;height:30px;padding:0 8px;background:#f9fafb;border:1px solid #d1d5db;border-radius:6px;color:#111827;font-size:12px;font-family:monospace;outline:none;-webkit-user-select:text;user-select:text}#url:focus{border-color:#3b82f6}#timer{font-size:11px;color:#9ca3af;white-space:nowrap;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;padding-right:2px}#tabbar{height:34px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:2px;padding:0 6px;overflow-x:auto;overflow-y:hidden;flex-shrink:0}#tabbar::-webkit-scrollbar{height:3px}#tabbar::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:3px}.tab{height:26px;max-width:160px;min-width:56px;display:flex;align-items:center;gap:3px;padding:0 8px;border-radius:4px;cursor:pointer;font-size:11px;color:#9ca3af;border:1px solid transparent;flex-shrink:0;overflow:hidden}.tab:hover{background:#f1f5f9;color:#374151}.tab.active{background:#fff;border-color:#d1d5db;color:#374151}.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tab-x{border:none!important;min-width:0!important;height:14px!important;width:14px!important;padding:0!important;font-size:13px!important;line-height:1;color:#9ca3af;flex-shrink:0;background:none!important}.tab-x:hover{color:#374151!important}.newtab{height:22px;min-width:22px;max-width:22px;padding:0!important;font-size:13px;border-style:dashed!important;color:#9ca3af;flex-shrink:0}`;

  const navHtml = `<button title="Back" onclick="cmd('back')">&#9664;</button><button title="Forward" onclick="cmd('forward')">&#9654;</button><button title="Reload" onclick="cmd('reload')">&#8635;</button><button title="Instagram Home" onclick="cmd('navigate',{url:'https://www.instagram.com/'})"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button><span class="sep"></span><input id="url" type="text" spellcheck="false"><span class="sep"></span><button id="lbtn" title="Fill login fields and submit" onclick="doLogin()">Login</button><button title="Generate TOTP code" onclick="cmd('totp')">2FA</button><button title="Type phone number" onclick="cmd('phone')">Phone</button><button title="Type email address" onclick="cmd('email-user')">Email</button><button title="Type email password" onclick="cmd('email-pass')">Email Pass</button><span class="sep"></span><span id="timer">0:00</span>`;

  const script = `function cmd(c,p){return window.__eq&&window.__eq.command(c,p);}
function doLogin(){var b=document.getElementById('lbtn');if(!b)return;b.disabled=true;Promise.resolve(cmd('login')).then(function(){b.disabled=false;}).catch(function(){b.disabled=false;});}
var u=document.getElementById('url');
u.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var v=u.value.trim();if(v&&v.indexOf('http')!==0)v='https://'+v;cmd('navigate',{url:v});}});
window.updateUrl=function(url){if(document.activeElement!==u)u.value=url;};
var _s=Date.now();
function tick(){var s=Math.floor((Date.now()-_s)/1000),m=Math.floor(s/60);s=s%60;document.getElementById('timer').textContent=m+':'+(s<10?'0':'')+s;}
tick();setInterval(tick,1000);
var _tabs=[{id:0,title:'Instagram',url:''}],_aid=0;
window.updateTabs=function(tabs,activeId){_tabs=tabs;_aid=activeId;renderTabs();};
function renderTabs(){
  var tb=document.getElementById('tabbar');if(!tb)return;tb.innerHTML='';
  for(var i=0;i<_tabs.length;i++){(function(t){
    var d=document.createElement('div');d.className='tab'+(_aid===t.id?' active':'');
    var sp=document.createElement('span');sp.className='tab-title';sp.textContent=t.title||'New Tab';d.appendChild(sp);
    if(_tabs.length>1){var x=document.createElement('button');x.className='tab-x';x.title='Close tab';x.innerHTML='&times;';x.onclick=function(e){e.stopPropagation();cmd('close-tab',{id:t.id});};d.appendChild(x);}
    d.onclick=function(){cmd('switch-tab',{id:t.id});};
    tb.appendChild(d);
  })(_tabs[i]);}
  var nb=document.createElement('button');nb.className='newtab';nb.title='New tab';nb.textContent='+';nb.onclick=function(){cmd('new-tab');};
  tb.appendChild(nb);
}
renderTabs();`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="navbar">${navHtml}</div><div id="tabbar"></div><script>${script}<\/script></body></html>`;
}

// ── Minimal page-level utilities ───────────────────────────────────────────────
// Injected into the Instagram page on every navigation (not into the toolbar).
// Tracks the last focused input so paste-style buttons (Phone, Email, etc.)
// can target it after focus shifts to the toolbar button click.
// Also auto-dismisses Instagram's cookie consent banner.
function buildPageUtilsJs(): string {
  return `(function(){
  if(window.__eq_utils_loaded)return;window.__eq_utils_loaded=true;
  window.__eq_lastInput=null;
  document.addEventListener('focusin',function(e){
    var t=e.target;
    if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA')){window.__eq_lastInput=t;}
  },true);
  if(!window.__eq_cookie_tick){window.__eq_cookie_tick=setInterval(function(){
    var ACCEPT=/allow all cookies|allow all|accept all|accept cookies|allow cookies|akzeptieren|alle cookies|accepter tout|aceptar todo|accetta tutto|tillåt alla/i;
    var btn=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]')||Array.from(document.querySelectorAll('button,[role="button"]')).find(function(b){var t=(b.innerText||b.textContent||'').trim();return ACCEPT.test(t)&&b.getBoundingClientRect().width>0;});
    if(btn){
      btn.click();
      clearInterval(window.__eq_cookie_tick);
      window.__eq_cookie_tick=null;
      // After cookie dismiss: if we're on the homepage (not yet on the login form),
      // auto-click the "Log in" button (top-right) so the login form appears and
      // the auto-fill handler can fill credentials and submit.
      setTimeout(function(){
        if(document.querySelector('input[name="username"]'))return; // already on login form
        var LOGIN_RE=/^log\s*in$/i;
        var loginEl=Array.from(document.querySelectorAll('a[href*="accounts/login"],a[href*="/login/"]')).find(function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
        if(!loginEl){loginEl=Array.from(document.querySelectorAll('a,button')).find(function(el){var t=(el.innerText||el.textContent||'').trim();return LOGIN_RE.test(t)&&el.getBoundingClientRect().width>0;});}
        if(loginEl){loginEl.click();}
      },1200);
    }
  },500);}
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
export const ebMap = new Map<number, EbEntry>();
// Native toolbar BrowserView per profile — floats above all page content.
const toolbarViewMap = new Map<number, BrowserView>();

// ── Tab state ──────────────────────────────────────────────────────────────────

const TOOLBAR_H = 92; // nav row (58 px) + tab bar (34 px)

interface TabState {
  tabs: Array<{ id: number; url: string; title: string }>;
  activeId: number;
  nextId: number;
  views: Map<number, BrowserView>;
}
const tabsStateMap = new Map<number, TabState>();

function pushTabUpdate(profileId: number): void {
  const tv = toolbarViewMap.get(profileId);
  if (!tv || tv.webContents.isDestroyed()) return;
  const state = tabsStateMap.get(profileId);
  if (!state) return;
  tv.webContents.executeJavaScript(
    `window.updateTabs && window.updateTabs(${JSON.stringify(state.tabs)}, ${state.activeId})`
  ).catch(() => {});
}

function getActiveWc(profileId: number): Electron.WebContents | null {
  const entry = ebMap.get(profileId);
  if (!entry || entry.win.isDestroyed()) return null;
  const state = tabsStateMap.get(profileId);
  if (!state || state.activeId === 0) return entry.win.webContents;
  const view = state.views.get(state.activeId);
  if (!view || view.webContents.isDestroyed()) return entry.win.webContents;
  return view.webContents;
}

function switchToTab(profileId: number, tabId: number): void {
  const state = tabsStateMap.get(profileId);
  const entry = ebMap.get(profileId);
  if (!state || !entry || entry.win.isDestroyed()) return;
  const win = entry.win;
  state.activeId = tabId;
  // Remove all content BrowserViews from window
  for (const view of state.views.values()) {
    win.removeBrowserView(view);
  }
  // Add active content view if it's not tab 0 (tab 0 = window's own webContents)
  if (tabId !== 0) {
    const view = state.views.get(tabId);
    if (view && !view.webContents.isDestroyed()) {
      win.addBrowserView(view);
      const [w, h] = win.getContentSize();
      view.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(1, h - TOOLBAR_H) });
    }
  }
  // Re-add toolbar BrowserView on top of everything
  const tv = toolbarViewMap.get(profileId);
  if (tv && !tv.webContents.isDestroyed()) {
    win.removeBrowserView(tv);
    win.addBrowserView(tv);
  }
  pushTabUpdate(profileId);
}

// ── Cookie file helpers ────────────────────────────────────────────────────────

export function cookieFilePath(profileId: number): string {
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

  // Wait up to 30s for navigation away from the bare login page.
  // The 2FA page URL is "accounts/login/two_factor?..." — it still contains
  // "accounts/login", so the predicate must explicitly accept it, otherwise
  // the code waits the full 30 s before detecting 2FA (looks like it does nothing).
  const postLoginUrl = await waitForNav(
    wc,
    url =>
      url.includes("instagram.com") &&
      (!url.includes("accounts/login/") || url.includes("two_factor")),
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
  password?: string;
  twoFAKey?: string;
}): Promise<void> {
  const { profileId, username, proxy, userAgent, password, twoFAKey } = opts;

  // Focus existing window if already open (or hidden via close→hide handler)
  const existing = ebMap.get(profileId);
  if (existing && !existing.win.isDestroyed()) {
    if (existing.win.isMinimized()) existing.win.restore();
    if (!existing.win.isVisible()) existing.win.show();
    existing.win.focus();
    // Toolbar is a native BrowserView — it is always present; nothing to re-inject.
    // If the current page is a chrome error or about:blank, navigate back to Instagram
    const currentUrl: string = existing.win.webContents.getURL();
    if (!currentUrl || currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank") {
      const existingSes = electronSession.fromPartition(`persist:eb-${profileId}`);
      const existingSessionCks = await existingSes.cookies.get({ name: "sessionid", domain: ".instagram.com" });
      existing.win.webContents.loadURL(
        existingSessionCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
      ).catch(() => {});
    }
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
    show:            false,
    webPreferences: {
      nodeIntegration:  false,
      contextIsolation: true,
      partition,
      preload: path.join(__dirname, "ebToolbarPreload.js"),
    },
  });
  win.once("ready-to-show", () => { win.show(); win.maximize(); });

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

  // Chrome-error recovery: auto-navigate back to Instagram when the page hits
  // chrome-error://. This handles ERR_TOO_MANY_REDIRECTS (Instagram's post-2FA
  // redirect chain) and similar transient errors. The session cookie is already
  // set by the time 2FA completes, so navigating directly to instagram.com/
  // bypasses the broken redirect chain and lands on the home page.
  // Allow up to 3 consecutive auto-recoveries before giving up.
  let chromeErrorRecoveryCount = 0;

  // Sync cookies + push URL change on every navigation
  win.webContents.on("did-navigate", async (_e, navUrl) => {
    if (navUrl.startsWith("chrome-error://")) {
      // Always push the error URL to the address bar relay so the user sees it
      fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-nav`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ url: navUrl }),
      }).catch(() => {});
      chromeErrorRecoveryCount++;
      console.warn(`[ebManager] chrome-error for @${username} (#${chromeErrorRecoveryCount})`);
      if (chromeErrorRecoveryCount <= 3) {
        // Wait 2 s then navigate directly to Instagram, bypassing the broken chain
        await new Promise(r => setTimeout(r, 2000));
        if (!win.isDestroyed()) {
          const recoveryCks = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
          win.webContents.loadURL(
            recoveryCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/",
          ).catch(() => {});
        }
      }
      return;
    }
    chromeErrorRecoveryCount = 0; // Reset counter on any successful navigation
    // Push URL change to BrowserPanel address bar (via server WS relay)
    fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-nav`, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ url: navUrl }),
    }).catch(() => {});
    // Also update the native toolbar's URL bar
    {
      const tv = toolbarViewMap.get(profileId);
      if (tv && !tv.webContents.isDestroyed()) {
        tv.webContents.executeJavaScript(
          `window.updateUrl && window.updateUrl(${JSON.stringify(navUrl)})`
        ).catch(() => {});
      }
    }
    if (!navUrl.includes("instagram.com")) return;
    await new Promise(r => setTimeout(r, 600));
    await syncCookies(profileId, ses);
  });

  // ── Native toolbar BrowserView ────────────────────────────────────────────
  // Floats above the Instagram window at the OS compositor level.  The toolbar
  // is completely independent of the page DOM — challenge pages, iframes, CSS
  // transforms, overflow:hidden, and z-index stacking can NEVER hide it.
  const toolbarView = new BrowserView({
    webPreferences: {
      partition,                   // same session so cookies are visible if needed
      preload: path.join(__dirname, "ebToolbarPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.addBrowserView(toolbarView);
  toolbarViewMap.set(profileId, toolbarView);

  // Initialise tab state for this profile.
  tabsStateMap.set(profileId, {
    tabs: [{ id: 0, url: "", title: `@${username}` }],
    activeId: 0,
    nextId: 1,
    views: new Map(),
  });
  // Push initial tab list to toolbar once its BrowserView has loaded.
  toolbarView.webContents.once("did-finish-load", () => pushTabUpdate(profileId));

  // Position the toolbar at the very top of the window.
  // setAutoResize keeps the width in sync with window resize automatically.
  const updateToolbarBounds = () => {
    if (win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    toolbarView.setBounds({ x: 0, y: 0, width: w, height: TOOLBAR_H });
    // Also resize the active content BrowserView (for tab > 0)
    const ts = tabsStateMap.get(profileId);
    if (ts && ts.activeId !== 0) {
      const cv = ts.views.get(ts.activeId);
      if (cv && !cv.webContents.isDestroyed()) {
        cv.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(1, h - TOOLBAR_H) });
      }
    }
  };
  toolbarView.setAutoResize({ width: true, height: false });
  win.on("resize", updateToolbarBounds);
  // Also update once immediately after ready-to-show / maximize.
  win.once("ready-to-show", () => setImmediate(updateToolbarBounds));

  // Load the toolbar HTML from a base64 data URI.
  // The preload (ebToolbarPreload.js) exposes window.__eq so the toolbar
  // buttons can call cmd() → ipcRenderer.invoke('eb-toolbar-cmd', ...).
  const toolbarHtml = buildNativeToolbarHtml();
  toolbarView.webContents.loadURL(
    `data:text/html;base64,${Buffer.from(toolbarHtml).toString("base64")}`
  ).catch(() => {});

  // ── Page-level utilities ────────────────────────────────────────────────
  // Injected into the Instagram page (NOT the toolbar) on every navigation.
  // Tracks the last focused input field and auto-dismisses cookie banners.
  const injectPageUtils = () => {
    win.webContents.executeJavaScript(buildPageUtilsJs()).catch(() => {});
  };
  win.webContents.on("dom-ready",       () => injectPageUtils());
  win.webContents.on("did-finish-load", () => injectPageUtils());

  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[ebManager] did-fail-load for @${username}: code=${code} desc=${desc} url=${url}`);
    // Push the error to the server log AND to the address bar relay so it's visible
    if (url && url.includes("instagram.com")) {
      fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-fail`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, desc, url }),
      }).catch(() => {});
    }
  });

  // Prevent Instagram's page <title> from overriding the window title.
  // Without this, Electron replaces "@username — Equinox Browser" with "Instagram".
  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(`@${username} — Equinox Browser`);
    const ts = tabsStateMap.get(profileId);
    if (ts && ts.tabs[0]) { ts.tabs[0].title = `@${username}`; pushTabUpdate(profileId); }
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

  // SPA navigations (Instagram pushState) don't fire did-navigate/did-finish-load —
  // update the toolbar URL bar directly from the main process.
  win.webContents.on("did-navigate-in-page", (_e, navUrl) => {
    const tv = toolbarViewMap.get(profileId);
    if (tv && !tv.webContents.isDestroyed()) {
      tv.webContents.executeJavaScript(
        `window.updateUrl && window.updateUrl(${JSON.stringify(navUrl)})`
      ).catch(() => {});
    }
    const ts = tabsStateMap.get(profileId);
    if (ts && ts.tabs[0] && ts.activeId === 0) ts.tabs[0].url = navUrl;
  });

  win.on("closed", () => {
    toolbarViewMap.delete(profileId);
    const ts = tabsStateMap.get(profileId);
    if (ts) {
      for (const v of ts.views.values()) {
        try { (v.webContents as any).destroy?.(); } catch {}
      }
    }
    tabsStateMap.delete(profileId);
  });

  // Navigate to Instagram.
  // Only go to the homepage if there is already an active sessionid in the
  // Electron session (loaded from the cookie file above). When only device
  // tokens (mid, ig_did) exist but no sessionid, navigate directly to the
  // login page so the auto-fill handler fires immediately without the user
  // having to do anything.
  const sessionCksForNav = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
  win.webContents.loadURL(
    sessionCksForNav.length > 0
      ? "https://www.instagram.com/"
      : "https://www.instagram.com/accounts/login/",
  ).catch(() => {});

  // ── Page-detection auto-fill ──────────────────────────────────────────────
  // Detects every navigation to the Instagram login page or 2FA page and
  // automatically fills + submits the form. Fires on the initial open AND on
  // any subsequent navigation (session expiry, re-login, manual back, etc.).
  // Credentials must be stored on the profile — if password is empty nothing fires.
  if (password) {
    let _autoFillBusy = false;

    win.webContents.on("did-navigate", async (_e: any, navUrl: string) => {
      if (_autoFillBusy || win.isDestroyed()) return;
      if (navUrl.startsWith("chrome-error://")) return;

      const onLogin = navUrl.includes("accounts/login/") && !navUrl.includes("two_factor");
      const on2FA   = navUrl.includes("two_factor");
      if (!onLogin && !on2FA) return;

      _autoFillBusy = true;
      console.log(`[ebManager] @${username} — auto-fill detected ${on2FA ? "2FA" : "login"} page`);

      // Short wait for React to mount the form after navigation commits
      await new Promise(r => setTimeout(r, 1500));
      if (win.isDestroyed()) { _autoFillBusy = false; return; }

      try {
        if (onLogin) {
          await win.webContents.executeJavaScript(`
            (async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));

              // ── Step 1: dismiss cookie consent banner if present ──────────────
              // Instagram shows a GDPR cookie dialog in many regions. It sits on
              // top of the login form. We must click "Allow all cookies" before
              // the login inputs become interactive.
              // Try for up to 5 s; skip if not present.
              for (let t = 0; t < 10; t++) {
                // Selector set covers current and past Instagram cookie banners
                const cookieBtn = (
                  document.querySelector('button[data-cookiebanner="accept_button"]') ||
                  [...document.querySelectorAll('button')].find(b =>
                    /allow all cookies|accept all|consenti a|accepter tous|alle zulassen|aceptar todo|tillåt alla/i
                      .test(b.textContent)
                  ) ||
                  document.querySelector('[data-testid="cookie-policy-banner-accept"]') ||
                  document.querySelector('[class*="cookie"] button:last-of-type')
                );
                if (cookieBtn) {
                  cookieBtn.click();
                  await wait(1000); // wait for the banner to dismiss
                  break;
                }
                await wait(500);
              }

              // ── Step 2: fill login form ───────────────────────────────────────
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
              let uInp, pInp, tries = 0;
              while (tries++ < 20) {
                uInp = document.querySelector('input[name="username"]');
                pInp = document.querySelector('input[name="password"]');
                if (uInp && pInp) break;
                await wait(500);
              }
              if (!uInp || !pInp) return;
              setter.call(uInp, ${JSON.stringify(username)});
              uInp.dispatchEvent(new Event("input", { bubbles: true }));
              await wait(300);
              setter.call(pInp, ${JSON.stringify(password)});
              pInp.dispatchEvent(new Event("input", { bubbles: true }));
              await wait(500);
              const btn = document.querySelector('button[type="submit"]');
              if (btn && !btn.disabled) btn.click();
            })()
          `).catch((e: any) => console.warn(`[ebManager] @${username} login fill failed:`, e?.message));

        } else if (on2FA && twoFAKey) {
          const code = generateTotp(twoFAKey);
          await win.webContents.executeJavaScript(`
            (async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
              let inp, tries = 0;
              while (tries++ < 20) {
                inp = document.querySelector(
                  'input[name="verificationCode"], input[aria-label*="security" i], ' +
                  'input[aria-label*="code" i], input[autocomplete="one-time-code"]'
                );
                if (inp) break;
                await wait(500);
              }
              if (!inp) return;
              setter.call(inp, ${JSON.stringify(code)});
              inp.dispatchEvent(new Event("input", { bubbles: true }));
              await wait(400);
              const btn = document.querySelector('button[type="submit"]');
              if (btn) btn.click();
            })()
          `).catch((e: any) => console.warn(`[ebManager] @${username} 2FA fill failed:`, e?.message));

        } else if (on2FA && !twoFAKey) {
          console.warn(`[ebManager] @${username} — 2FA page detected but no 2FA key stored`);
        }
      } finally {
        // Hold the lock for 3 s so a rapid re-navigation doesn't re-trigger immediately
        await new Promise(r => setTimeout(r, 3000));
        _autoFillBusy = false;
      }
    });
  }
}

// ── Toolbar IPC handler ────────────────────────────────────────────────────────

let _toolbarIpcRegistered = false;

function setupToolbarIpc(): void {
  if (_toolbarIpcRegistered) return;
  _toolbarIpcRegistered = true;

  ipcMain.handle("eb-toolbar-cmd", async (event, cmd: string, payload?: any) => {
    // Identify which profile's EB window sent this command.
    // Commands can come from the native toolbar BrowserView OR (for new-tab windows)
    // from the Instagram page webContents. Check both sources.
    const sender = event.sender;
    let foundPid = 0;
    let foundWin: BrowserWindow | null = null;

    // 1. Check if sender is a toolbar BrowserView webContents
    for (const [pid, tv] of toolbarViewMap.entries()) {
      if (!tv.webContents.isDestroyed() && tv.webContents === sender) {
        foundPid = pid;
        foundWin = ebMap.get(pid)?.win ?? null;
        break;
      }
    }
    // 2. Fall back: check if sender is the EB window's own webContents
    //    (used by new-tab windows that still inject the toolbar into the page)
    if (!foundPid) {
      for (const [pid, entry] of ebMap.entries()) {
        if (!entry.win.isDestroyed() && entry.win.webContents === sender) {
          foundPid = pid;
          foundWin = entry.win;
          break;
        }
      }
    }
    if (!foundPid || !foundWin) return;

    const wc = getActiveWc(foundPid) ?? foundWin.webContents;

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
          const _needsNav = await wc.executeJavaScript(`(async () => {
            const wait = ms => new Promise(res => setTimeout(res, ms));
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            const fill = (el, val) => {
              setter.call(el, val);
              el.dispatchEvent(new Event('input',  { bubbles: true }));
              el.dispatchEvent(new Event('change', { bubbles: true }));
            };
            // Dismiss cookie consent banner first (up to 5 s)
            for (let cb = 0; cb < 10; cb++) {
              const ckBtn = (
                document.querySelector('[data-cookiebanner="accept_button"]') ||
                document.querySelector('[data-testid="cookie-policy-banner-accept"]') ||
                [...document.querySelectorAll('button,[role="button"]')].find(b =>
                  /allow all cookies|accept all|alle zulassen|aceptar todo|accepter tout/i.test(b.textContent) &&
                  b.getBoundingClientRect().width > 0
                )
              );
              if (ckBtn) { ckBtn.click(); await wait(800); break; }
              await wait(500);
            }
            // Poll up to 10 × 300 ms for React to mount the login form
            let uInp, pInp, t = 0;
            while (t++ < 10) {
              uInp = document.querySelector('input[name="username"]') || document.querySelector('input[autocomplete="username"]');
              pInp = document.querySelector('input[name="password"]') || document.querySelector('input[type="password"]');
              if (uInp || pInp) break;
              await wait(300);
            }
            if (!uInp && !pInp) return 'navigate';
            if (uInp) { fill(uInp, ${usr}); uInp.focus(); }
            await wait(250);
            if (pInp) { fill(pInp, ${pwd}); pInp.focus(); }
            await wait(400);
            const btn = document.querySelector('button[type="submit"]');
            if (btn && !btn.disabled) btn.click();
          })()`).catch(() => 'navigate');
        if (_needsNav === 'navigate') {
          // Not on the login page — navigate there and fill after load using the
          // freshly-fetched credentials (avoids relying on stale did-navigate creds).
          const _fillAfterLoad = async () => {
            if (wc.isDestroyed()) return;
            await new Promise(r => setTimeout(r, 1500));
            if (wc.isDestroyed()) return;
            await wc.executeJavaScript(`(async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              const fill = (el, val) => {
                setter.call(el, val);
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              };
              let uInp, pInp, t = 0;
              while (t++ < 20) {
                uInp = document.querySelector('input[name="username"]') || document.querySelector('input[autocomplete="username"]');
                pInp = document.querySelector('input[name="password"]') || document.querySelector('input[type="password"]');
                if (uInp && pInp) break;
                await wait(500);
              }
              if (!uInp || !pInp) return;
              fill(uInp, ${usr}); uInp.focus();
              await wait(300);
              fill(pInp, ${pwd}); pInp.focus();
              await wait(400);
              const btn = document.querySelector('button[type="submit"]');
              if (btn && !btn.disabled) btn.click();
            })()`).catch(() => {});
          };
          wc.once('did-finish-load', _fillAfterLoad);
          wc.loadURL('https://www.instagram.com/accounts/login/').catch(() => {
            wc.removeListener('did-finish-load', _fillAfterLoad);
          });
        }
        } catch {}
        break;
      }

      case "new-tab": {
        // Open a new tab as a BrowserView within the same EB window.
        const entry = ebMap.get(foundPid);
        const state = tabsStateMap.get(foundPid);
        if (!entry || entry.win.isDestroyed() || !state) break;
        const tabWin = entry.win;
        const newTabId = state.nextId++;
        const partition = `persist:eb-${foundPid}`;
        const tabView = new BrowserView({
          webPreferences: { partition, contextIsolation: true, nodeIntegration: false },
        });
        state.views.set(newTabId, tabView);
        state.tabs.push({ id: newTabId, url: "https://www.google.com/", title: "New Tab" });
        const _pushNavUrl = (navUrl: string) => {
          const s = tabsStateMap.get(foundPid);
          if (!s) return;
          const tab = s.tabs.find(t => t.id === newTabId);
          if (tab) tab.url = navUrl;
          if (s.activeId === newTabId) {
            const tv = toolbarViewMap.get(foundPid);
            if (tv && !tv.webContents.isDestroyed()) {
              tv.webContents.executeJavaScript(
                `window.updateUrl && window.updateUrl(${JSON.stringify(navUrl)})`
              ).catch(() => {});
            }
          }
        };
        tabView.webContents.on("did-navigate",         (_e: any, u: string) => _pushNavUrl(u));
        tabView.webContents.on("did-navigate-in-page", (_e: any, u: string) => _pushNavUrl(u));
        tabView.webContents.on("page-title-updated", (_e: any, title: string) => {
          const s = tabsStateMap.get(foundPid);
          if (!s) return;
          const tab = s.tabs.find(t => t.id === newTabId);
          if (tab) tab.title = title.slice(0, 25) || "New Tab";
          pushTabUpdate(foundPid);
        });
        tabView.webContents.on("context-menu", (_e: any, params: any) => {
          const tpl: Electron.MenuItemConstructorOptions[] = [];
          if (params.editFlags.canCut)   tpl.push({ role: "cut" });
          if (params.editFlags.canCopy)  tpl.push({ role: "copy" });
          if (params.editFlags.canPaste) tpl.push({ role: "paste" });
          tpl.push({ type: "separator" }, { role: "selectAll" });
          Menu.buildFromTemplate(tpl).popup({ window: tabWin });
        });
        tabView.webContents.on("dom-ready",       () => tabView.webContents.executeJavaScript(buildPageUtilsJs()).catch(() => {}));
        tabView.webContents.on("did-finish-load", () => tabView.webContents.executeJavaScript(buildPageUtilsJs()).catch(() => {}));
        tabView.webContents.loadURL("https://www.google.com/").catch(() => {});
        switchToTab(foundPid, newTabId);
        break;
      }

      case "switch-tab": {
        if (payload?.id !== undefined) {
          const switchState = tabsStateMap.get(foundPid);
          const switchTabId = Number(payload.id);
          switchToTab(foundPid, switchTabId);
          if (switchState) {
            const tv = toolbarViewMap.get(foundPid);
            if (tv && !tv.webContents.isDestroyed()) {
              let url = "";
              if (switchTabId === 0) {
                url = foundWin.webContents.getURL();
              } else {
                const sv = switchState.views.get(switchTabId);
                url = (sv && !sv.webContents.isDestroyed()) ? sv.webContents.getURL() : "";
              }
              tv.webContents.executeJavaScript(
                `window.updateUrl && window.updateUrl(${JSON.stringify(url)})`
              ).catch(() => {});
            }
          }
        }
        break;
      }

      case "close-tab": {
        const closeState = tabsStateMap.get(foundPid);
        const closeId = Number(payload?.id ?? 0);
        if (!closeState || closeId === 0) break; // never close tab 0
        const viewToClose = closeState.views.get(closeId);
        closeState.views.delete(closeId);
        closeState.tabs = closeState.tabs.filter(t => t.id !== closeId);
        if (closeState.activeId === closeId) {
          const nextTab = closeState.tabs[closeState.tabs.length - 1];
          switchToTab(foundPid, nextTab?.id ?? 0);
        } else {
          pushTabUpdate(foundPid);
        }
        if (viewToClose && !viewToClose.webContents.isDestroyed()) {
          foundWin.removeBrowserView(viewToClose);
          try { (viewToClose.webContents as any).destroy?.(); } catch {}
        }
        break;
      }

      case "totp": {
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const key = (p.twoFASecretKey ?? "").trim();
          if (key) {
            const code = generateTotp(key);
            const codeJson = JSON.stringify(code);
            // Actively find the OTP input, fill it, then click Continue/Submit.
            // Falls back to the last-focused field if no standard OTP selector matches.
            await wc.executeJavaScript(`(async function(){
              var delay=function(ms){return new Promise(function(r){setTimeout(r,ms);});};
              var code=${codeJson};
              var OTP=[
                'input[autocomplete="one-time-code"]',
                'input[name="verificationCode"]',
                'input[name="verification_code"]',
                'input[name="security_code"]',
                'input[name="totp_code"]',
                'input[name="code"]',
                'input[inputmode="numeric"]'
              ];
              var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
              var filled=false;
              for(var i=0;i<OTP.length;i++){
                var el=document.querySelector(OTP[i]);
                if(!el)continue;
                var rc=el.getBoundingClientRect();
                if(rc.width===0||rc.height===0)continue;
                el.focus();
                setter.call(el,'');
                el.dispatchEvent(new Event('input',{bubbles:true}));
                await delay(80);
                setter.call(el,code);
                el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
                filled=true;
                break;
              }
              if(!filled){
                var fe=window.__eq_lastInput||document.activeElement;
                if(fe&&fe.tagName==='INPUT'){
                  setter.call(fe,code);
                  fe.dispatchEvent(new Event('input',{bubbles:true}));
                  fe.dispatchEvent(new Event('change',{bubbles:true}));
                }
              }
              await delay(350);
              var SUBMIT=['confirm','continue','submit','verify','next','done','ok'];
              var btns=Array.from(document.querySelectorAll('button,[role="button"],input[type="submit"]'));
              for(var j=0;j<btns.length;j++){
                var txt=(btns[j].innerText||btns[j].textContent||'').trim().toLowerCase();
                var rc2=btns[j].getBoundingClientRect();
                if(SUBMIT.some(function(t){return txt.indexOf(t)!==-1;})&&rc2.width>0&&rc2.height>0){
                  btns[j].click();
                  break;
                }
              }
            })()`).catch(()=>{});
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
          password:  body.password,
          twoFAKey:  body.twoFAKey,
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

        // ── Skip auto-login if already logged in (same check as Puppeteer path) ──
        // The Electron session already has cookies loaded from the file. If there is
        // already a sessionid, the account is logged in — run doAutoLogin would just
        // try to log in again (finding no login form) and fail with a misleading error.
        const existingSession = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
        if (existingSession.length > 0) {
          console.log(`[silent-verify:${pid}] @${body.username} — sessionid found in Electron session, skipping auto-login`);
          const c1 = await ses.cookies.get({ domain: ".instagram.com" });
          const c2 = await ses.cookies.get({ domain: "instagram.com" });
          const seen = new Set<string>();
          const cookies = [...c1, ...c2].filter(c => {
            if (seen.has(c.name)) return false;
            seen.add(c.name);
            return true;
          }).map(c => ({ name: c.name, value: c.value }));
          return send(res, 200, { ok: true, message: "Using existing EB session", cookies });
        }

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
