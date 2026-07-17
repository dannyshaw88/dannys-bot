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

import { BrowserWindow, BrowserView, Menu, session as electronSession, ipcMain, WebContents, dialog, shell, screen as eScreen } from "electron";
import http from "http";
import https from "https";
import fs from "fs";
import path from "path";
import net from "net";
import { createHmac } from "crypto";

// ── EB crash-step logger ──────────────────────────────────────────────────────
// Writes step-by-step progress and error lines directly to logs.log so the exact
// crash point in openEbWindow is visible in the log file (main process console.log
// is discarded in production — these file writes are the only way to capture it).
let _ebLogPath = "";
export function setEbLogPath(p: string): void { _ebLogPath = p; }
function _ebCrashLog(profileId: number | string, msg: string): void {
  const line = `[${new Date().toISOString()}] [EB:${profileId}] ${msg}\n`;
  try { process.stderr.write(line); } catch {}
  if (_ebLogPath) {
    try { fs.appendFileSync(_ebLogPath, line); } catch {}
  }
}

// ── Native toolbar (BrowserView) ───────────────────────────────────────────────
// The toolbar now lives in a native Electron BrowserView that floats on top of
// the Instagram window at the OS compositor level.  It is completely independent
// of the page DOM, so challenge pages, iframes, CSS transforms, overflow:hidden,
// and any other page-level styling CANNOT hide or remove it.
function buildNativeToolbarHtml(isGhost?: boolean): string {
  const styles = `*{box-sizing:border-box;margin:0;padding:0}body{height:92px;max-height:92px;overflow:hidden;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}#navbar{height:58px;display:flex;align-items:center;gap:4px;padding:0 8px;flex-shrink:0;overflow:hidden}button{height:30px;min-width:30px;padding:0 8px;background:transparent;border:1px solid #d1d5db;color:#6b7280;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:3px;white-space:nowrap;flex-shrink:0}button:hover{background:#f3f4f6;color:#374151}button:disabled{opacity:.5;cursor:default}.sep{width:1px;height:18px;background:#e2e8f0;margin:0 2px;flex-shrink:0}#url{flex:1;min-width:0;height:30px;padding:0 8px;background:#f9fafb;border:1px solid #d1d5db;border-radius:6px;color:#111827;font-size:12px;font-family:monospace;outline:none;-webkit-user-select:text;user-select:text}#url:focus{background:#fff;border-color:#3b82f6}#url::selection{background:#bfdbfe;color:#111827}#timer{font-size:11px;color:#9ca3af;white-space:nowrap;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;padding-right:2px}#tabbar{height:34px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:2px;padding:0 6px;overflow-x:auto;overflow-y:hidden;flex-shrink:0}#tabbar::-webkit-scrollbar{height:3px}#tabbar::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:3px}.tab{height:26px;max-width:160px;min-width:56px;display:flex;align-items:center;gap:3px;padding:0 8px;border-radius:4px;cursor:pointer;font-size:11px;color:#9ca3af;border:1px solid transparent;flex-shrink:0;overflow:hidden}.tab:hover{background:#f1f5f9;color:#374151}.tab.active{background:#fff;border-color:#d1d5db;color:#374151}.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tab-x{border:none!important;min-width:0!important;height:14px!important;width:14px!important;padding:0!important;font-size:13px!important;line-height:1;color:#9ca3af;flex-shrink:0;background:none!important}.tab-x:hover{color:#374151!important}.newtab{height:22px;min-width:22px;max-width:22px;padding:0!important;font-size:13px;border-style:dashed!important;color:#9ca3af;flex-shrink:0}`;

  // Ghost Browser (430px wide) — only nav + URL bar + Leak Check so the URL
  // input always has room.  Login/2FA/Phone/Email/EmailPass are account-window
  // tools not needed during signup.
  const ghostNavHtml = `<button title="Back" onclick="cmd('back')">&#9664;</button><button title="Forward" onclick="cmd('forward')">&#9654;</button><button title="Reload" onclick="cmd('reload')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button><button title="Instagram Home" onclick="cmd('navigate',{url:'https://www.instagram.com/'})"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button><span class="sep"></span><input id="url" type="text" spellcheck="false"><span class="sep"></span><button title="Run in-app leak test — checks IP, WebRTC, WebDriver, Canvas, Audio, WebGL and more" onclick="cmd('leak-check')">&#128737; Leak Check</button><span class="sep"></span><span id="timer">0:00</span>`;

  const navHtml = `<button title="Back" onclick="cmd('back')">&#9664;</button><button title="Forward" onclick="cmd('forward')">&#9654;</button><button title="Reload" onclick="cmd('reload')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg></button><button title="Instagram Home" onclick="cmd('navigate',{url:'https://www.instagram.com/'})"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button><span class="sep"></span><input id="url" type="text" spellcheck="false"><span class="sep"></span><button id="lbtn" title="Fill login fields and submit" onclick="doLogin()">Login</button><button title="Generate TOTP code" onclick="cmd('totp')">2FA</button><button title="Type phone number" onclick="cmd('phone')">Phone</button><button title="Type email address" onclick="cmd('email-user')">Email</button><button title="Type email password" onclick="cmd('email-pass')">Email Pass</button><button title="Run in-app leak test — checks IP, WebRTC, WebDriver, Canvas, Audio, WebGL and more" onclick="cmd('leak-check')">&#128737; Leak Check</button><span class="sep"></span><span id="timer">0:00</span>`;

  const script = `function cmd(c,p){return window.__eq&&window.__eq.command(c,p);}
function doLogin(){var b=document.getElementById('lbtn');if(!b)return;b.disabled=true;Promise.resolve(cmd('login')).then(function(){b.disabled=false;}).catch(function(){b.disabled=false;});}
var u=document.getElementById('url');
u.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var v=u.value.trim();if(v&&v.indexOf('http')!==0)v='https://'+v;cmd('navigate',{url:v});}});
// Select all text on click so the user can immediately type a new URL
// without having to manually Ctrl+A first.  Works even when the toolbar
// BrowserView is not the focused window — the select() call runs before
// any OS focus change resolves so it always succeeds.
u.addEventListener('click',function(){u.select();});
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
renderTabs();
`;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${styles}</style></head><body><div id="navbar">${navHtml}</div><div id="tabbar"></div><script>${script}<\/script></body></html>`;
}

// ── Minimal page-level utilities ───────────────────────────────────────────────
// Injected into the Instagram page on every navigation (not into the toolbar).
// Tracks the last focused input so paste-style buttons (Phone, Email, etc.)
// can target it after focus shifts to the toolbar button click.
// Also auto-dismisses Instagram's cookie consent banner.
// autoFill is only supplied when called from inside openEbWindow (main EB window).
// Tab BrowserViews and other callers pass nothing so they only get cookie dismiss + focus tracking.
// jsToken is a per-session random string (6 alphanumeric chars) baked into every
// __eq_* global name so Instagram's JS cannot fingerprint us by a fixed symbol name.
// Pass the same token for all executeJavaScript calls that read __eq_* globals
// (e.g. typeIntoFocused reads __eq${jsToken}_li for the last focused input).
function buildPageUtilsJs(autoFill?: { username: string; password: string }, jsToken = ""): string {
  const afJson = autoFill ? JSON.stringify(autoFill) : "null";
  const t = jsToken;
  return `(function(){
  if(window.__eq${t}_u)return;window.__eq${t}_u=true;

  // ── Push body below the native 92-px Equinox toolbar ─────────────────────
  if(!document.getElementById('__eq${t}_tb')){var _eq_s=document.createElement('style');_eq_s.id='__eq${t}_tb';_eq_s.textContent='body{padding-top:92px!important;box-sizing:border-box!important}';(document.head||document.documentElement).appendChild(_eq_s);}

  // ── Focus tracking (for toolbar paste buttons) ───────────────────────────
  window.__eq${t}_li=null;
  document.addEventListener('focusin',function(e){
    var _el=e.target;
    if(_el&&(_el.tagName==='INPUT'||_el.tagName==='TEXTAREA')){window.__eq${t}_li=_el;}
  },true);

  // ── Credential-aware auto-fill ───────────────────────────────────────────
  // Works on any URL — handles hard navigations, SPA pushState, and inline
  // login forms. Uses MutationObserver for instant reaction + polling fallback.
  var AF=${afJson};

  if(AF&&!window.__eq${t}_fd){
    var _doFill=function(){
      if(window.__eq${t}_fd)return;
      var uInp=document.querySelector('input[name="username"]');
      var pInp=document.querySelector('input[name="password"]');
      if(!uInp||!pInp)return;
      if(!uInp.getBoundingClientRect().width)return; // hidden / not yet visible
      window.__eq${t}_fd=true;
      if(window.__eq${t}_mo){window.__eq${t}_mo.disconnect();window.__eq${t}_mo=null;}
      if(window.__eq${t}_fp){clearInterval(window.__eq${t}_fp);window.__eq${t}_fp=null;}
      var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(uInp,AF.username);
      uInp.dispatchEvent(new Event('input',{bubbles:true}));
      setTimeout(function(){
        setter.call(pInp,AF.password);
        pInp.dispatchEvent(new Event('input',{bubbles:true}));
        // Poll up to 5 s for the submit button to become enabled (React re-renders async)
        var _bp=0;var _bi=setInterval(function(){
          if(++_bp>20){clearInterval(_bi);return;}
          var btn=document.querySelector('button[type="submit"]')
            ||Array.from(document.querySelectorAll('button')).find(function(b){var _bt=(b.innerText||b.textContent||'').trim();return/log[\s-]*in|sign[\s-]*in/i.test(_bt)&&b.getBoundingClientRect().width>50;});
          if(btn&&!btn.disabled){clearInterval(_bi);btn.click();}
        },250);
      },300);
    };
    // 1. Try immediately (form may already be in the DOM)
    _doFill();
    // 2. MutationObserver — fires instantly whenever DOM changes
    if(!window.__eq${t}_fd&&!window.__eq${t}_mo){
      window.__eq${t}_mo=new MutationObserver(function(){_doFill();});
      window.__eq${t}_mo.observe(document.documentElement,{childList:true,subtree:true});
      setTimeout(function(){if(window.__eq${t}_mo){window.__eq${t}_mo.disconnect();window.__eq${t}_mo=null;}},120000);
    }
    // 3. Polling fallback every 800 ms (belt-and-suspenders)
    if(!window.__eq${t}_fd&&!window.__eq${t}_fp){
      window.__eq${t}_fp=setInterval(function(){
        if(window.__eq${t}_fd){clearInterval(window.__eq${t}_fp);window.__eq${t}_fp=null;return;}
        _doFill();
      },800);
      setTimeout(function(){if(window.__eq${t}_fp){clearInterval(window.__eq${t}_fp);window.__eq${t}_fp=null;}},120000);
    }
  }

  // ── Cookie consent banner post-dismiss navigation ────────────────────────
  // The actual CLICK on the cookie button is done from the main process via
  // sendInputEvent (isTrusted=true, required for Instagram's React handlers).
  // This in-page interval only watches for the banner to disappear, then
  // navigates to the login page if needed (one time).
  if(!window.__eq${t}_ct){var _cks${t}=false;window.__eq${t}_ct=setInterval(function(){
    var __ACCEPT=['allow all cookies','accept all cookies','allow all','accept all','allow essential and optional cookies','accept cookies','allow cookies','alle cookies akzeptieren','accepter tout','aceptar todo','accetta tutto','tillåt alla','alle accepteren'];
    function _isCookieAcceptBtn(b){
      if(!b||!b.getBoundingClientRect||b.getBoundingClientRect().width<=0)return false;
      var _bt=(b.innerText||b.textContent||'').trim().toLowerCase();
      return __ACCEPT.indexOf(_bt)!==-1;
    }
    var btn=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]');
    if(!btn){
      var container=document.querySelector('[data-cookiebanner]')||document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');
      if(container){btn=Array.from(container.querySelectorAll('button,[role="button"],a')).find(_isCookieAcceptBtn)||null;}
    }
    if(!btn){btn=Array.from(document.querySelectorAll('button,[role="button"],a')).find(_isCookieAcceptBtn)||null;}
    if(btn){
      _cks${t}=true;
      // Do NOT click from here — untrusted JS events are ignored by Instagram's
      // React app. The main-process sendInputEvent timer handles the click.
    }else if(_cks${t}){
      // Banner was visible and is now gone (main process clicked it) — navigate to login.
      clearInterval(window.__eq${t}_ct);window.__eq${t}_ct=null;
      setTimeout(function(){
        if(AF&&window.__eq${t}_fd)return;
        var LOGIN_RE=/^log\s*in$/i;
        var loginEl=Array.from(document.querySelectorAll('a[href*="accounts/login"],a[href*="/login/"]')).find(function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
        if(!loginEl){loginEl=Array.from(document.querySelectorAll('a,button,[role="button"]')).find(function(el){var _et=(el.innerText||el.textContent||'').trim();return LOGIN_RE.test(_et)&&el.getBoundingClientRect().width>0;});}
        if(loginEl){
          var r2=loginEl.getBoundingClientRect();
          window.__eq${t}_pl={x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2)};
          loginEl.click();
        }
      },800);
    }
  },500);}
})();`;
}

// ── Module state ───────────────────────────────────────────────────────────────

let _serverPort = 0;
let _cookiesDir  = "";
let _iconPath    = "";

// ── Global IPC log forwarder ───────────────────────────────────────────────────
// The Electron main process runs in a separate OS process from the API server.
// Its console.log output goes to the Electron terminal, NOT to the server's log
// file (equinox-debug.log) that the user reads for debugging.
//
// This function sends every important log line to /api/ipc-log on the API server
// so it appears in the same pino log stream.  Fire-and-forget: failures are
// silently swallowed so a dropped log never blocks the automation flow.
//
// Use this for all session-critical events (session death, follow start/result,
// watchdog, error).  Routine poll/cookie lines stay console-only to keep the
// API log clean.
function _ipcLog(msg: string): void {
  console.log(msg);
  if (!_serverPort) return;
  fetch(`http://127.0.0.1:${_serverPort}/api/ipc-log`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({ message: msg }),
  }).catch(() => {});
}

// Tracks which profileIds are currently running a browser-follow so we
// don't start two simultaneous follows on the same EB window.
// One account = one browser = one follow at a time.
const _sfInProgress = new Set<number>();
// Bumped every time a ghost-signup starts OR the ghost browser is closed/reset.
// Each ghost-signup async block captures its own token at start and checks it
// before every long-running step — ensures a stale run cannot bleed into the next.
const _ghostSignupAbortTokens = new Map<number, number>();

// ── Silent-verify async result store ─────────────────────────────────────────
// /eb/silent-verify returns 202 immediately so the HTTP connection is never
// held open for minutes. doAutoLogin runs in the background and stores its
// result here. The API server polls /eb/silent-verify-status until done.
interface SilentVerifyResult {
  done: boolean;
  ok?: boolean;
  message?: string;
  cookies?: Array<{ name: string; value: string }>;
}
const _silentVerifyResults = new Map<number, SilentVerifyResult>();

interface EbEntry {
  win: BrowserWindow;
  username: string;
  proxy?: { host: string; port: number; user?: string; pass?: string; type?: string };
  partition: string;
  warmupActive?: boolean;
  /** Per-session random token baked into every __eq_* global name injected into the Instagram page. */
  jsToken?: string;
}
export const ebMap = new Map<number, EbEntry>();

// ── Real outgoing HTTP header capture ─────────────────────────────────────────
// The "Browser Fingerprint Check" only reads JS-visible window/navigator
// properties — it says NOTHING about the actual bytes Chrome puts on the wire.
// Instagram's server-side fingerprinting inspects the real request headers
// (Sec-CH-UA-*, Sec-Fetch-*, Accept-Language, User-Agent, header ORDER),
// which JS running in the page can never see and the old check never audited.
// Network.requestWillBeSentExtraInfo gives the actual wire-level headers,
// including ones Chrome's network layer adds after JS/webRequest hooks run —
// unlike Network.requestWillBeSent, which shows pre-network-layer headers.
interface CapturedHeaderSet {
  url:        string;
  method:     string;
  headers:    Record<string, string>;
  capturedAt: string;
}
const _headerCaptures = new Map<number, CapturedHeaderSet[]>();
const HEADER_CAPTURE_LIMIT = 25;

function _recordHeaderCapture(profileId: number, url: string, method: string, headers: Record<string, string>) {
  // Only keep requests to Instagram hosts — the ones Instagram's own fraud
  // system actually inspects. Ignore CDN/analytics noise.
  try {
    const host = new URL(url).hostname;
    if (!/(^|\.)instagram\.com$/.test(host) && !/(^|\.)facebook\.com$/.test(host)) return;
  } catch { return; }
  const list = _headerCaptures.get(profileId) ?? [];
  list.push({ url, method, headers, capturedAt: new Date().toISOString() });
  while (list.length > HEADER_CAPTURE_LIMIT) list.shift();
  _headerCaptures.set(profileId, list);
}

// Attaches a Network-domain listener that records every real outgoing request
// header set for this profile's EB window. Safe to call multiple times per
// window — CDP listener registration is idempotent per debugger instance and
// we guard with a WeakSet so we never double-subscribe the same webContents.
const _headerCaptureWired = new WeakSet<Electron.WebContents>();
function wireHeaderCapture(wc: Electron.WebContents, profileId: number) {
  if (_headerCaptureWired.has(wc)) return;
  _headerCaptureWired.add(wc);
  try {
    wc.debugger.sendCommand("Network.enable").catch(() => {});
  } catch { /* debugger not attached yet — Network.enable no-ops harmlessly */ }
  const onMessage = (_event: unknown, method: string, params: any) => {
    if (method !== "Network.requestWillBeSentExtraInfo") return;
    // associatedRequestId's actual URL/method comes from a matching
    // requestWillBeSent event, but extra-info headers are what's really sent
    // (Sec-Fetch-*, Cookie, Sec-CH-UA — added by the network layer after JS
    // and webRequest hooks run). We don't have the URL on this event alone,
    // so pair it via requestId with the most recent requestWillBeSent seen.
    const pending = _pendingReqMeta.get(params.requestId);
    if (!pending) return;
    _recordHeaderCapture(profileId, pending.url, pending.method, params.headers ?? {});
    _pendingReqMeta.delete(params.requestId);
  };
  const _pendingReqMeta = new Map<string, { url: string; method: string }>();
  const onMeta = (_event: unknown, method: string, params: any) => {
    if (method !== "Network.requestWillBeSent") return;
    _pendingReqMeta.set(params.requestId, { url: params.request?.url ?? "", method: params.request?.method ?? "GET" });
    // Cap map growth — drop stale entries after 200 pending
    if (_pendingReqMeta.size > 200) {
      const firstKey = _pendingReqMeta.keys().next().value;
      if (firstKey) _pendingReqMeta.delete(firstKey);
    }
  };
  wc.debugger.on("message", onMeta);
  wc.debugger.on("message", onMessage);
}

// ── ip-api.com timezone cache ─────────────────────────────────────────────────
// ip-api.com free tier allows 1,000 requests/day.  Without a cache, every
// openEbWindow call (one per account per EB open) consumes one request.
// Opening 50 accounts burns 50 requests; hitting the limit causes ALL accounts
// opened after that to fall back to the machine's real system timezone, which
// creates a cross-account timezone clustering signal Instagram can detect.
//
// Cache key: proxy host string.  Value: IANA timezone string (e.g. "America/Sao_Paulo").
// Scope: lifetime of the Electron process (cleared on app restart).
// Effect: all accounts sharing the same proxy host share one lookup per session.
const _tzCache = new Map<string, string>();

// ── EB Exit-IP Audit store ────────────────────────────────────────────────────
// Populated every time openEbWindow runs (before Instagram loads).
// Exposed via GET /eb/ip-audits so the API server and frontend can show results.
interface EbIpAuditResult {
  profileId: number;
  username: string;
  serverIp: string;   // machine real IP (direct https, no proxy)
  exitIp: string;     // session exit IP (ses.fetch, through proxy)
  proxy: string | null;
  proxyHost: string | null;
  leaking: boolean;   // true if exitIp === serverIp (proxy not routing)
  checkedAt: string;
}
const _ebIpAudits = new Map<number, EbIpAuditResult>();

// Helper: direct HTTPS GET (bypasses all proxies — gives real server IP)
function _directHttpsGet(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise(resolve => {
    const req = https.get(url, { timeout: timeoutMs }, res => {
      let body = "";
      res.on("data", (d: Buffer) => { body += d.toString(); });
      res.on("end", () => resolve(body));
    });
    req.on("error", () => resolve(""));
    req.on("timeout", () => { req.destroy(); resolve(""); });
  });
}

// ── CDP emulation serialization lock ────────────────────────────────────────
// Concurrent Emulation.setDeviceMetricsOverride / setTouchEmulationEnabled
// calls across multiple BrowserWindow instances cause a Chromium SIGSEGV crash
// on Windows in Electron 33 (same root cause as mobile:true crashing single
// windows — the emulation subsystem is not thread-safe at the Chromium level).
// Serialising the emulation-setup block (steps 20-21) means each window waits
// its turn before issuing the CDP commands, preventing simultaneous calls.
let _cdpEmuLocked = false;
const _cdpEmuQueue: (() => void)[] = [];
async function _acquireCdpEmuLock(): Promise<void> {
  if (!_cdpEmuLocked) { _cdpEmuLocked = true; return; }
  await new Promise<void>(resolve => _cdpEmuQueue.push(resolve));
}
function _releaseCdpEmuLock(): void {
  const next = _cdpEmuQueue.shift();
  if (next) next();
  else _cdpEmuLocked = false;
}

// Return the Electron session partition name for a profile.
// For regular accounts this is always 'persist:eb-{pid}'.
// For the Ghost (pid=-1) it varies per session — look it up in ebMap.
function ebPartition(pid: number): string {
  return ebMap.get(pid)?.partition ?? `persist:eb-${pid}`;
}

// Build the Electron session.setProxy() options object for a given proxy config.
//
// ALL proxy types (HTTP and SOCKS5) now use mode:'fixed_servers' + proxyRules
// with credentials embedded directly in the proxy URL.
//
// HISTORY — why we tried PAC script and why we reverted:
//   v1.0.607 switched HTTP proxies from fixed_servers to an inline pacScript
//   string.  The stated reason was that fixed_servers "silently falls back to
//   DIRECT when the proxy is slow or the 407 auth cycle fails."  However, the
//   evidence for that fallback was the DNS leak test showing 2 different IPs
//   (Cloudflare vs ipify).  That 2-IP result was subsequently diagnosed as a
//   false positive — ipify was returning the real IPv6 via a QUIC/UDP socket
//   that bypasses the HTTP proxy entirely (fixed in v1.0.611 by switching to
//   api.ipify.org).  The fixed_servers proxy was routing correctly the whole
//   time.  Switching to pacScript broke proxy routing entirely because Electron
//   33/34 silently ignores the pacScript inline-string option in some builds.
//
// WHY credentials are NOT embedded in the HTTP proxyRules URL:
//   Chromium's fixed_servers mode ONLY accepts bare host:port or scheme://host:port
//   in the proxyRules field for HTTP proxies.  Embedding credentials as
//   http://user:pass@host:port causes Chromium to emit ERR_NO_SUPPORTED_PROXIES
//   (code -336) and refuse to use the proxy at all — confirmed in Electron 33 /
//   Chromium 130 (v1.0.624).  Credentials for HTTP proxies must be supplied via
//   the webContents 'login' event when the proxy issues a 407 challenge.
//
//   SOCKS5 is different: socks5://user:pass@host:port IS supported by Chromium's
//   SOCKS5 resolver and credentials embedded there work correctly.
//
//   The 'login' event handler on win.webContents (and on tab BrowserViews and
//   hidden verify windows) handles the 407 challenge for HTTP proxies.
//
// IPv6 note: --disable-ipv6 is set as an app-level Chromium flag in main.ts,
//   so Chrome never resolves AAAA records or opens IPv6 sockets regardless of
//   the proxy config here.
function buildProxyConfig(proxy: { host: string; port: number; user?: string; pass?: string; type?: string }): Parameters<Electron.Session["setProxy"]>[0] {
  const creds = proxy.user ? `${encodeURIComponent(proxy.user)}:${encodeURIComponent(proxy.pass ?? "")}@` : "";
  if (proxy.type === "socks5") {
    return {
      mode: "fixed_servers",
      proxyRules: `socks5://${creds}${proxy.host}:${proxy.port}`,
      proxyBypassRules: "127.0.0.1;[::1];localhost",
    };
  }
  // HTTP/HTTPS proxy — credentials must NOT be embedded in the URL.
  // Chromium rejects http://user:pass@host:port in proxyRules with ERR_NO_SUPPORTED_PROXIES.
  // Credentials are supplied via the webContents 'login' event on 407 challenge.
  return {
    mode: "fixed_servers",
    proxyRules: `http://${proxy.host}:${proxy.port}`,
    proxyBypassRules: "127.0.0.1;[::1];localhost",
  };
}

// ── Chrome Client Hints build info ─────────────────────────────────────────────
//
// The UA string format "Chrome/131.0.0.0" is correct — Chrome on Android
// deliberately hides the patch version in the UA string since v101.
// BUT the Client Hints headers (Sec-CH-UA-Full-Version-List) and the JS API
// (navigator.userAgentData.getHighEntropyValues(['fullVersionList'])) DO expose
// the real build number.  Sending "131.0.0.0" there is an immediate bot signal —
// no real Chrome build has a zero patch version.
//
// GREASE brand algorithm: greaseBrands[floor(major/8) % 8]
//   greaseBrands = [" Not A;Brand"," Not;A Brand","Not A)Brand","Not)A;Brand",
//                   "Not;A)Brand","Not-A(Brand","Not A(Brand","Not/A)Brand"]
//   Chrome 120–127: floor(v/8)=15, 15%8=7  → "Not/A)Brand"
//   Chrome 128–135: floor(v/8)=16, 16%8=0  → " Not A;Brand"  (leading space)
//   Chrome 136–143: floor(v/8)=17, 17%8=1  → " Not;A Brand"  (leading space)
//
// Both the CDP Emulation.setUserAgentOverride call AND the injected JS fingerprint
// script must use these values, otherwise Sec-CH-UA-Full-Version-List and
// navigator.userAgentData.getHighEntropyValues() return different values.
const CHROME_BUILD_INFO: Record<string, { full: string; grease: string; greaseVer: string }> = {
  "124": { full: "124.0.6367.82",  grease: "Not/A)Brand",  greaseVer: "8" },
  "125": { full: "125.0.6422.165", grease: "Not/A)Brand",  greaseVer: "8" },
  "126": { full: "126.0.6478.202", grease: "Not/A)Brand",  greaseVer: "8" },
  "127": { full: "127.0.6533.119", grease: "Not/A)Brand",  greaseVer: "8" },
  "128": { full: "128.0.6613.137", grease: " Not A;Brand", greaseVer: "8" },
  "129": { full: "129.0.6668.103", grease: " Not A;Brand", greaseVer: "8" },
  "130": { full: "130.0.6723.107", grease: " Not A;Brand", greaseVer: "8" },
  "131": { full: "131.0.6778.260", grease: " Not A;Brand", greaseVer: "8" },
  "132": { full: "132.0.6834.163", grease: " Not A;Brand", greaseVer: "8" },
  "133": { full: "133.0.6943.137", grease: " Not A;Brand", greaseVer: "8" },
  "134": { full: "134.0.6998.135", grease: " Not A;Brand", greaseVer: "8" },
  "135": { full: "135.0.7049.114", grease: " Not A;Brand", greaseVer: "8" },
  "136": { full: "136.0.7103.125", grease: " Not;A Brand", greaseVer: "8" },
  "137": { full: "137.0.7151.55",  grease: " Not;A Brand", greaseVer: "8" },
  "138": { full: "138.0.7204.101", grease: " Not;A Brand", greaseVer: "8" },
  "139": { full: "139.0.7258.66",  grease: " Not;A Brand", greaseVer: "8" },
  "140": { full: "140.0.7312.45",  grease: " Not;A Brand", greaseVer: "8" },
};

// Real Android Chrome auto-updates within days of a new stable release — a
// device reporting a Chrome version that's been end-of-life for months is
// itself a fingerprint tell, independent of any header/TLS/device-ID check.
// Bump this whenever CHROME_BUILD_INFO gains a newer entry so every fallback
// site (UA generation, Client-Hints, injected JS) stays on a current version
// instead of silently drifting stale as real Chrome ships past it.
// refreshChromeVersion() keeps this up-to-date automatically at runtime.
let CURRENT_CHROME_MAJOR = "140";

function getChromeBuildInfo(majorVersion: string): { full: string; grease: string; greaseVer: string } {
  return CHROME_BUILD_INFO[majorVersion] ?? CHROME_BUILD_INFO[CURRENT_CHROME_MAJOR];
}

// ── Auto-updating Chrome stable version ───────────────────────────────────────
//
// Real Android Chrome auto-updates within days of a new stable release. Rather
// than manually bumping CURRENT_CHROME_MAJOR and CHROME_BUILD_INFO, we fetch
// the live stable version from Google's public Version History API at startup
// and once every 24 hours. On any network/parse error the in-process table is
// left untouched (silent fallback).
//
// GREASE brand is derived from the real Chromium rotation algorithm:
//   greaseBrands[floor(major/8) % 8]
// where greaseBrands is the 8-entry array documented at the CHROME_BUILD_INFO
// definition above. This matches real Chrome behavior indefinitely regardless
// of which milestone the auto-fetch returns.
//
// Concurrent refresh calls coalesce into a single in-flight request — the
// second caller awaits the same promise rather than issuing a duplicate fetch.
//
// Cache: 24 hours in-memory — no disk writes, no secrets required.

// Full 8-entry GREASE rotation from the Chromium source (greaseBrands array).
// Index = floor(chromeMajor / 8) % 8.
// Confirmed: index 7 → Chrome 120-127, index 0 → Chrome 128-135,
//            index 1 → Chrome 136-143.
const _GREASE_BRANDS: readonly string[] = [
  " Not A;Brand",  // 0 — Chrome 128-135 (confirmed)
  " Not;A Brand",  // 1 — Chrome 136-143 (confirmed)
  "Not A)Brand",   // 2 — Chrome 144-151 (from Chromium source)
  "Not)A;Brand",   // 3 — Chrome 152-159 (from Chromium source)
  "Not;A)Brand",   // 4 — Chrome 160-167 (from Chromium source)
  "Not-A(Brand",   // 5 — Chrome 168-175 (from Chromium source)
  "Not A(Brand",   // 6 — Chrome 176-183 (from Chromium source)
  "Not/A)Brand",   // 7 — Chrome 120-127 (confirmed)
];

function _inferGrease(major: number): { grease: string; greaseVer: string } {
  const idx = Math.floor(major / 8) % 8;
  return { grease: _GREASE_BRANDS[idx], greaseVer: "8" };
}

let _chromeVersionLastFetch = 0;
const _CHROME_VERSION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 h

// In-flight guard: coalesces concurrent calls into a single network request.
let _chromeVersionInFlight: Promise<void> | null = null;

function refreshChromeVersion(): Promise<void> {
  const now = Date.now();
  if (now - _chromeVersionLastFetch < _CHROME_VERSION_CACHE_TTL) return Promise.resolve();

  // Coalesce concurrent callers: return the same in-flight promise.
  if (_chromeVersionInFlight) return _chromeVersionInFlight;

  // Google Version History API — no key required, public endpoint.
  // Returns the latest Android stable Chrome version sorted descending.
  const url =
    "https://versionhistory.googleapis.com/v1/chrome/platforms/android" +
    "/channels/stable/versions?filter=endtime=none&orderBy=version%20desc&pageSize=1";

  _chromeVersionInFlight = new Promise<void>((resolve) => {
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let raw = "";
      res.on("data", (chunk: string) => { raw += chunk; });
      res.on("end", () => {
        try {
          const json  = JSON.parse(raw);
          const ver: string | undefined = json?.versions?.[0]?.version;
          if (ver && /^\d+\.\d+\.\d+\.\d+$/.test(ver)) {
            const major  = ver.split(".")[0];
            const majorN = parseInt(major, 10);

            // Extend the lookup table if this is a version we don't know yet.
            if (!CHROME_BUILD_INFO[major]) {
              CHROME_BUILD_INFO[major] = { full: ver, ..._inferGrease(majorN) };
              console.log(`[chromeVersion] Added Chrome ${major} (${ver}) to build table`);
            }

            // Update the fallback only if the fetched major is ≥ current.
            if (majorN >= parseInt(CURRENT_CHROME_MAJOR, 10)) {
              if (CURRENT_CHROME_MAJOR !== major) {
                console.log(`[chromeVersion] Updated CURRENT_CHROME_MAJOR: ${CURRENT_CHROME_MAJOR} → ${major}`);
                CURRENT_CHROME_MAJOR = major;
              }
            }

            // Mark attempt regardless of whether major advanced — prevents
            // hammering the endpoint when API returns a valid-but-older version.
            _chromeVersionLastFetch = Date.now();
          }
        } catch {
          // Parse error — leave table untouched, do not update cache timestamp
          // so the next interval can try again.
        }
        resolve();
      });
    });
    req.on("error", () => resolve()); // Network error — leave table untouched.
    req.on("timeout", () => { req.destroy(); resolve(); });
  }).finally(() => { _chromeVersionInFlight = null; });

  return _chromeVersionInFlight;
}

// ── Desktop Client-Hints metadata resolver ────────────────────────────────────
//
// BUG THIS FIXES (found 6 Jul 2026 via side-by-side leak-test comparison):
// Every desktop (non-mobile) CDP Emulation.setUserAgentOverride call in this
// file omitted `userAgentMetadata` entirely — only the mobile branch built it.
// With no override, Chromium computes navigator.userAgentData / Sec-CH-UA-*
// from the REAL HOST MACHINE, not from the account's declared browserUA. Result:
//   1. Every desktop-UA account on the same physical machine reported IDENTICAL
//      Sec-CH-UA-Platform / Architecture / Platform-Version / Bitness — a hard
//      cross-account correlation signal, regardless of how unique the rest of
//      the fingerprint (canvas/audio/UA string) was.
//   2. Those leaked real-host values were also internally inconsistent with the
//      account's own declared UA (e.g. UA says "Macintosh"/"X11; Linux" while
//      Client Hints said "Windows") — a textbook automation tell, since real
//      browsers always keep Sec-CH-UA-Platform in sync with the UA string.
// Fix: derive full Client-Hints metadata from the declared browserUA string so
// platform/architecture/platformVersion/bitness always match what the UA
// claims, and vary deterministically (hashed off the UA string itself, which
// already differs per profile) so different accounts don't collide either.
function _strHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h;
}

function buildDesktopUAMetadata(browserUA: string): {
  platform: string;
  navigatorPlatform: string;
  architecture: string;
  platformVersion: string;
  bitness: string;
} {
  const h = _strHash(browserUA);
  if (browserUA.includes("Macintosh")) {
    const macVersions = ["13.6.7", "14.4.1", "14.6.1", "15.0.1", "15.1.0"];
    const archOptions = ["arm", "x86"];
    return {
      platform: "macOS",
      navigatorPlatform: "MacIntel",
      architecture: archOptions[h % archOptions.length],
      platformVersion: macVersions[h % macVersions.length],
      bitness: "64",
    };
  }
  if (browserUA.includes("Linux") && !browserUA.includes("Android")) {
    return {
      platform: "Linux",
      navigatorPlatform: "Linux x86_64",
      architecture: "x86",
      platformVersion: "",
      bitness: "64",
    };
  }
  // Windows (default) — Windows NT 10.0 in the UA string covers both Win10 and
  // Win11; Sec-CH-UA-Platform-Version is how real Chrome actually distinguishes
  // them, so vary it per-account instead of leaking whatever build the host
  // machine happens to run.
  const winVersions = ["10.0.0", "13.0.0", "15.0.0", "15.0.0", "19.0.0"];
  return {
    platform: "Windows",
    navigatorPlatform: "Win32",
    architecture: "x86",
    platformVersion: winVersions[h % winVersions.length],
    bitness: "64",
  };
}

// ── Mobile device profile resolver ────────────────────────────────────────────
//
// Returns the CSS-pixel screen dimensions and DPR that the JS fingerprint script
// will select for this UA, so the CDP Emulation.setDeviceMetricsOverride call
// uses IDENTICAL values — no mismatch between JS-level overrides and Chromium's
// C++-level viewport geometry.
//
// The PRNG seed and profile-selection logic are an exact TypeScript mirror of the
// JS inside buildFingerprintScript() — changing either must keep them in sync.
//
// WHY THIS IS CRITICAL:
//   Without setDeviceMetricsOverride, Chromium's layout engine uses the real
//   BrowserWindow size (1280×820).  CSS @media (pointer:coarse) / (max-width:480px)
//   queries evaluate against the real viewport, so Instagram's React app renders
//   its desktop layout and applies desktop-specific JavaScript branches (e.g.
//   PointerEvent.pointerType === "mouse").  JS overrides to screen.width / innerWidth
//   only affect JS reads — they cannot change how Chromium measures the viewport
//   for CSS, layout, or native input handling.
const MOBILE_PROFILES: [number, number, number][] = [
  [360,808,3.0],[411,914,2.625],[411,914,2.625],[360,780,3.0],
  [360,780,3.0],[393,851,2.75],[412,915,2.625],[412,900,2.70],
  [393,873,2.75],[393,873,2.75],[393,868,2.75],[360,780,3.0],
];

function getMobileDeviceProfile(
  browserUA: string | null,
  apiUA: string | null,
): { width: number; height: number; dpr: number } | null {
  if (!browserUA) return null;
  const isMob = browserUA.includes("Mobile") || browserUA.includes("Android");
  if (!isMob) return null;

  // If the API UA carries explicit pixel dimensions, use them (highest fidelity).
  // Format: "34/14; 420dpi; 1080x2340; ..."
  if (apiUA) {
    const m = apiUA.match(/;\s*(\d+)dpi;\s*(\d+)x(\d+)/);
    if (m) {
      const dpi = +m[1], pW = +m[2], pH = +m[3];
      const dpr = Math.round(dpi / 160 * 10000) / 10000;
      return { width: Math.round(pW / dpr), height: Math.round(pH / dpr), dpr };
    }
  }

  // Mirror the PRNG-based selection from buildFingerprintScript so both pick the
  // same profile entry.  Seed: djb2-XOR of each UA character, same as the JS.
  let s = 5381;
  for (let i = 0; i < browserUA.length; i++) {
    s = (((s << 5) + s) ^ browserUA.charCodeAt(i)) >>> 0;
  }
  if (!s) s = 1;
  // One iteration of the LCG (matches the first _r() call selecting the profile)
  s = (Math.imul(1664525, s) + 1013904223) >>> 0;
  const idx = Math.floor((s / 0x100000000) * MOBILE_PROFILES.length);
  const p = MOBILE_PROFILES[idx] ?? MOBILE_PROFILES[0];
  return { width: p[0], height: p[1], dpr: p[2] };
}

// JavaScript injected as the FIRST addScriptToEvaluateOnNewDocument on every EB window.
// Deletes / shadows Electron-specific globals that Instagram's login JS probes.
// Even with contextIsolation:true + nodeIntegration:false, some Electron builds still
// leak window.require, window.process, window.module into the renderer context.
// Running this at document_start (before any page script) ensures they are invisible.
const ELECTRON_LEAK_SUPPRESSOR_JS = `(function () {
  // Names probed by Instagram's login JS to detect Electron/automation.
  var _ELEC = ['require','process','module','exports','_electron','__electron','__eq'];
  for (var _i = 0; _i < _ELEC.length; _i++) {
    var _k = _ELEC[_i];
    // Fast-path: already absent — nothing to do.
    if (typeof window[_k] === 'undefined') continue;
    // Step 1: attempt direct delete (own configurable property — the common case
    // for Electron globals that leak despite contextIsolation:true).
    var _deleted = false;
    try { _deleted = (delete window[_k]); } catch (_e) { _deleted = false; }
    if (_deleted && typeof window[_k] === 'undefined') continue;
    // Step 2: delete either failed or the value survived via the prototype chain.
    // Inspect the descriptor so we can choose the right remediation path.
    var _desc;
    try { _desc = Object.getOwnPropertyDescriptor(window, _k); } catch (_e) {}
    if (_desc && !_desc.configurable) {
      // Non-configurable own property — cannot be deleted or redefined.
      // If it is writable, zero it out so typeof probes return 'undefined'.
      try { if (_desc.writable) { window[_k] = undefined; } } catch (_e) {}
    } else {
      // Configurable (or on the prototype chain) — shadow it with a value
      // descriptor so both typeof and direct access return undefined.
      try {
        Object.defineProperty(window, _k, {
          value: undefined, writable: true, configurable: true, enumerable: false,
        });
      } catch (_e) {}
    }
  }
  // Scrub ChromeDriver / Selenium artefacts that Electron sometimes injects.
  try {
    Object.keys(window)
      .filter(function (k) {
        return k.indexOf('$cdc_') === 0 || k.indexOf('$chrome_') === 0 ||
               k === '__driver_evaluate' || k === '__webdriver_evaluate' ||
               k === '__selenium_evaluate' || k === '__fxdriver_evaluate';
      })
      .forEach(function (k) { try { delete window[k]; } catch (_e) {} });
  } catch (_e) {}
})();`;

// JavaScript injected into every EB page to block WebRTC TCP and UDP ICE candidates.
// Applied via CDP Page.addScriptToEvaluateOnNewDocument (runs before any page script)
// AND via dom-ready executeJavaScript (belt-and-suspenders if CDP is unavailable).
const WEBRTC_BLOCKER_JS = `(function () {
  var R = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!R) return;
  function B() {
    var pc = new R({});
    pc.createOffer  = function () { return Promise.reject(new DOMException('WebRTC disabled', 'NotAllowedError')); };
    pc.createAnswer = function () { return Promise.reject(new DOMException('WebRTC disabled', 'NotAllowedError')); };
    return pc;
  }
  try { B.prototype = R.prototype; } catch {}
  try { B.generateCertificate = R.generateCertificate.bind(R); } catch {}
  try { Object.defineProperty(window, 'RTCPeerConnection',        { get: function () { return B; }, configurable: true }); } catch {}
  try { Object.defineProperty(window, 'webkitRTCPeerConnection',  { get: function () { return B; }, configurable: true }); } catch {}
})();`;

// Applies the SAME anti-detection stack the main EB window gets (WebRTC block,
// canvas/WebGL/audio fingerprint spoof, UA + Client-Hints override) to a
// short-lived Mode-B silent-action window (silent-follow / silent-post /
// silent-search). Without this, those windows fall back to Electron's raw
// default fingerprint — a stark mismatch from the mobile identity Instagram
// already associated with the account's sessionid during EB login. Instagram
// treats "same session, suddenly different device" as a strong automated-abuse
// signal, which is exactly the pattern bulk follow/unfollow/DM actions produce
// if this is skipped. MUST be called before the window's first loadURL.
async function armSilentWindowAntiDetection(
  win: BrowserWindow,
  opts: { browserUA?: string | null; apiUA?: string | null; ebFingerprint?: EbFingerprintLite | string | null },
): Promise<void> {
  try {
    const browserUA = opts.browserUA ?? null;
    const apiUA = opts.apiUA ?? null;
    let fp: EbFingerprintLite | null = null;
    try {
      fp = typeof opts.ebFingerprint === "string" ? JSON.parse(opts.ebFingerprint) : (opts.ebFingerprint ?? null);
    } catch { fp = null; }
    const isMobile = !!browserUA && (browserUA.includes("Mobile") || isApiFormatUA(browserUA));
    const chromeMajor = browserUA?.match(/Chrome\/(\d+)/)?.[1] ?? CURRENT_CHROME_MAJOR;
    const buildInfo = getChromeBuildInfo(chromeMajor);
    const fpScript = buildFingerprintScript(isMobile, apiUA, fp, buildInfo.full, buildInfo.grease, buildInfo.greaseVer, null, browserUA);

    try { win.webContents.debugger.attach("1.3"); } catch { /* already attached */ }
    await Promise.race([
      (async () => {
        try {
          await win.webContents.debugger.sendCommand("Page.enable");
          await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: ELECTRON_LEAK_SUPPRESSOR_JS });
          await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: WEBRTC_BLOCKER_JS });
          await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: fpScript });
        } catch { /* CDP unavailable — fall back to setUserAgent below only */ }
      })(),
      new Promise<void>(r => setTimeout(r, 1500)),
    ]);

    if (browserUA) {
      try { win.webContents.setUserAgent(browserUA); } catch {}
      try {
        const desktopMeta = isMobile ? null : buildDesktopUAMetadata(browserUA);
        // Mobile metadata — extract Android version and device model from UA string
        const mobileAndroidVer = isMobile ? (browserUA.match(/Android\s+([0-9]+)/i)?.[1] ?? "14") + ".0.0" : "";
        const mobileModel = isMobile ? (browserUA.match(/Android [0-9]+;\s*([^)]+)\)/)?.[1]?.trim() ?? "") : "";
        await Promise.race([
          win.webContents.debugger.sendCommand("Emulation.setUserAgentOverride", {
            userAgent: browserUA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: isMobile ? "Linux armv8l" : (desktopMeta!.navigatorPlatform),
            userAgentMetadata: {
              brands: [
                { brand: buildInfo.grease,  version: buildInfo.greaseVer },
                { brand: "Chromium",         version: chromeMajor },
                { brand: "Google Chrome",    version: chromeMajor },
              ],
              fullVersionList: [
                { brand: buildInfo.grease,  version: buildInfo.greaseVer + ".0.0.0" },
                { brand: "Chromium",         version: buildInfo.full },
                { brand: "Google Chrome",    version: buildInfo.full },
              ],
              fullVersion: buildInfo.full,
              platform:        isMobile ? "Android"                   : desktopMeta!.platform,
              platformVersion: isMobile ? mobileAndroidVer            : desktopMeta!.platformVersion,
              architecture:    isMobile ? "arm"                       : desktopMeta!.architecture,
              model:           isMobile ? mobileModel                 : "",
              mobile:          isMobile,
              bitness:         isMobile ? "64"                        : desktopMeta!.bitness,
              wow64:           false,
            },
          }),
          new Promise<void>(r => setTimeout(r, 1500)),
        ]);
      } catch {}
    }
  } catch (err: any) {
    console.warn(`[armSilentWindowAntiDetection] failed: ${err?.message ?? err}`);
  }
}

// Mouse-hover suppressor injected into the ghost signup browser via CDP.
// When the user moves their real PC mouse over the Electron window, Chrome
// forwards native MouseEvent/PointerEvent hover events to the page. Instagram
// reads event.pointerType and navigator.maxTouchPoints to classify devices —
// hover events with pointerType:"mouse" are a hard desktop signal that a real
// Android phone never produces (phones have no hover concept).
//
// This script runs in the capture phase (first, before ANY page script) and
// calls stopImmediatePropagation() on every hover/movement event, so Instagram's
// listeners never see them. We deliberately do NOT block mousedown/mouseup/click/
// pointerdown/pointerup because those are used by our own CDP touch events
// (which arrive with pointerType:"touch" and are isTrusted=true).
const MOUSE_HOVER_BLOCKER_JS = `(function(){
  var BLOCK=['mousemove','mouseover','mouseout','mouseenter','mouseleave',
             'pointermove','pointerover','pointerout','pointerenter','pointerleave'];
  function block(e){ e.stopImmediatePropagation(); }
  BLOCK.forEach(function(t){
    window.addEventListener(t, block, true);
    document.addEventListener(t, block, true);
  });
})();`;

// Ghost-signup variant: blocks ALL mouse events (hover + click + down/up) so
// Instagram's JS never sees a mouse pointer during the automated signup flow.
// CDP synthesizeTapGesture fires touchstart/touchend (NOT mouse events) so the
// automation is unaffected. Physical mouse clicks from the user are blocked.
// Blocks all mouse-EXCLUSIVE events during ghost signup.
// DO NOT include 'click', 'pointerdown', 'pointerup' here — CDP synthesizeTapGesture
// fires touch events that result in a 'click' at the end (touchstart→touchend→click).
// Blocking 'click' kills that final event and React button handlers never fire.
// 'mousedown' / 'mouseup' are sufficient to defeat Instagram's mouse-detection:
// those events only fire for real mouse buttons and are never part of a touch sequence.
//
// Also injects a 'not-allowed' cursor style so the user sees a red stop icon when
// hovering over the Ghost Browser — a visual indicator that the window is in
// automation mode and mouse input is blocked.
const GHOST_MOUSE_BLOCKER_JS = `(function(){
  var BLOCK=['mousemove','mouseover','mouseout','mouseenter','mouseleave',
             'pointermove','pointerover','pointerout','pointerenter','pointerleave',
             'mousedown','mouseup','dblclick','contextmenu','auxclick'];
  function block(e){ e.stopImmediatePropagation(); }
  BLOCK.forEach(function(t){
    window.addEventListener(t, block, true);
    document.addEventListener(t, block, true);
  });
  // Inject cursor style so the user sees a blocked cursor over the ghost window.
  // Uses DOMContentLoaded if document.head isn't ready yet.
  function _injectCursor(){
    if(document.getElementById('__ghost-cur__')) return;
    var s=document.createElement('style');
    s.id='__ghost-cur__';
    s.textContent='html,body,*,*::before,*::after{cursor:not-allowed!important}';
    (document.head||document.documentElement).appendChild(s);
  }
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',_injectCursor,{once:true});
  } else {
    _injectCursor();
  }
})();`;

// Auto-dismisses Instagram's "You've reached your daily limit" screen-time overlay.
// Instagram injects this modal mid-session (no navigation change) — it blocks all
// interaction until explicitly closed by clicking the × in the top-right corner.
// The script uses MutationObserver so it fires whenever the overlay is injected,
// not just at page load.  Multiple click strategies are tried in order so it stays
// robust as Instagram A/B tests different markup for the dismiss button.
const DAILY_LIMIT_DISMISSER_JS = `(function(){
  'use strict';
  function _tryDismiss(){
    var b=document.body;
    if(!b)return;
    // Fast bail — don't touch the DOM unless the overlay text is present
    var txt=b.innerText||'';
    if(txt.indexOf('daily limit')===-1&&txt.indexOf('Daily limit')===-1)return;

    // Strategy 1 — button with a close-like aria-label (most reliable)
    var btns=document.querySelectorAll('button,[role="button"]');
    for(var i=0;i<btns.length;i++){
      var lbl=(btns[i].getAttribute('aria-label')||'').toLowerCase().trim();
      if(lbl==='close'||lbl==='dismiss'||lbl==='not now'||lbl==='maybe later'){
        btns[i].click();
        console.log('[daily-limit-dismisser] clicked close via aria-label="'+lbl+'"');
        return;
      }
    }

    // Strategy 2 — SVG element with aria-label containing "close" or "dismiss"
    var svgs=document.querySelectorAll('svg[aria-label]');
    for(var i=0;i<svgs.length;i++){
      var slbl=(svgs[i].getAttribute('aria-label')||'').toLowerCase();
      if(slbl.indexOf('close')!==-1||slbl.indexOf('dismiss')!==-1){
        var t=svgs[i].closest('button,[role="button"]')||svgs[i];
        t.click();
        console.log('[daily-limit-dismisser] clicked close via SVG aria-label');
        return;
      }
    }

    // Strategy 3 — find the container holding the overlay text, click its first button
    // Instagram's daily-limit modal typically has only one interactive element (×).
    var roots=document.querySelectorAll('[role="dialog"],[role="alertdialog"],section,article,div');
    for(var i=0;i<roots.length;i++){
      var r=roots[i];
      // Only check elements that directly contain the text (not every div)
      var ownText=(r.childNodes&&Array.from(r.childNodes).map(function(n){return n.textContent||'';}).join(''))||'';
      if(ownText.indexOf('daily limit')===-1&&ownText.indexOf('Daily limit')===-1)continue;
      var rb=r.querySelectorAll('button,[role="button"]');
      if(rb.length>0){
        rb[0].click();
        console.log('[daily-limit-dismisser] clicked first button in overlay container');
        return;
      }
    }

    // Strategy 4 — any button whose visible text is a close glyph (×, ✕, ✖, ⨯)
    for(var i=0;i<btns.length;i++){
      var tc=(btns[i].textContent||'').trim();
      if(tc==='×'||tc==='✕'||tc==='✖'||tc==='⨯'||tc==='⊗'){
        btns[i].click();
        console.log('[daily-limit-dismisser] clicked × glyph button');
        return;
      }
    }
  }

  // Run immediately in case modal is already in the DOM when this script executes
  try{_tryDismiss();}catch(_e){}

  // MutationObserver catches the overlay whenever Instagram injects it mid-session
  try{
    var _obs=new MutationObserver(function(){try{_tryDismiss();}catch(_e){}});
    function _start(){
      _obs.observe(document.body||document.documentElement,{childList:true,subtree:true});
    }
    if(document.readyState==='loading'){
      document.addEventListener('DOMContentLoaded',_start,{once:true});
    }else{
      _start();
    }
  }catch(_e){}
})();`;

// Ghost signup mobile fingerprint patch — injected AFTER the main _fpScript so it
// can override the values the desktop-mode fp script set.
//
// WHY THIS IS NEEDED:
//   The ghost browser window (profileId=-1) opens with no UA, so buildFingerprintScript
//   runs with isMobile=false → desktop branch → sets screen.width=1920, maxTouchPoints=0,
//   and skips navigator.connection / other mobile overrides.  CDP setDeviceMetricsOverride
//   sets the *rendering* viewport to 393×851, but JS Object.defineProperty on screen.width
//   takes precedence over the CDP override when Instagram's JS reads it.  Without this
//   patch, screen.width=1920 contradicts the Android UA — an instant bot signal.
//
// WHAT THIS PATCH ADDS BEYOND THE MAIN FP SCRIPT:
//   1. screen.width/height/availWidth/availHeight — corrected to Pixel 8 dimensions
//   2. window.devicePixelRatio / innerWidth / innerHeight / outerWidth / outerHeight
//   3. navigator.plugins → empty PluginArray  (Android Chrome has zero plugins;
//      Desktop Chrome exposes "PDF Viewer" etc. — a hard desktop signal)
//   4. navigator.connection.type → always "cellular" (the main fp script creates a
//      connection object only if none exists; Chrome always has one, so the fp
//      override was being skipped entirely, leaving type="wifi" from the OS)
//   5. DeviceMotionEvent / DeviceOrientationEvent emissions — real phones
//      continuously fire accelerometer/gyroscope data; desktop Chrome never does
const GHOST_SIGNUP_FP_PATCH_JS = `(function(){
  var _SW=393,_SH=851,_DPR=2.75;
  // ── Screen dimensions ─────────────────────────────────────────────────────────
  try{Object.defineProperty(screen,'width',{get:function(){return _SW;},configurable:true,enumerable:true});}catch(e){}
  try{Object.defineProperty(screen,'height',{get:function(){return _SH;},configurable:true,enumerable:true});}catch(e){}
  try{Object.defineProperty(screen,'availWidth',{get:function(){return _SW;},configurable:true,enumerable:true});}catch(e){}
  try{Object.defineProperty(screen,'availHeight',{get:function(){return _SH-56;},configurable:true,enumerable:true});}catch(e){}
  try{Object.defineProperty(screen,'colorDepth',{get:function(){return 24;},configurable:true});}catch(e){}
  try{Object.defineProperty(screen,'pixelDepth',{get:function(){return 24;},configurable:true});}catch(e){}
  try{Object.defineProperty(window,'devicePixelRatio',{get:function(){return _DPR;},configurable:true});}catch(e){}
  try{Object.defineProperty(window,'innerWidth',{get:function(){return _SW;},configurable:true});}catch(e){}
  try{Object.defineProperty(window,'innerHeight',{get:function(){return _SH;},configurable:true});}catch(e){}
  try{Object.defineProperty(window,'outerWidth',{get:function(){return _SW;},configurable:true});}catch(e){}
  try{Object.defineProperty(window,'outerHeight',{get:function(){return _SH;},configurable:true});}catch(e){}
  // ── navigator: platform + touch (belt-and-suspenders on top of CDP) ───────────
  try{Object.defineProperty(navigator,'platform',{get:function(){return 'Linux armv8l';},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'maxTouchPoints',{get:function(){return 10;},configurable:true});}catch(e){}
  // ── navigator.hardwareConcurrency: Pixel 8 has 8 cores (Tensor G3) ───────────
  // The desktop fp script picks from [4,6,8,8,8,12,16] — can land on 4, which
  // is wrong for a Pixel 8. Pin to 8 here as the canonical Pixel 8 core count.
  try{Object.defineProperty(navigator,'hardwareConcurrency',{get:function(){return 8;},configurable:true});}catch(e){}
  // ── navigator.languages: strip HTTP q-weight from JS array ────────────────────
  // Setting acceptLanguage:"en-US,en;q=0.9" in CDP causes Chrome to leak the
  // q-value into navigator.languages → ["en-US","en;q=0.9"]. Real Android Chrome
  // strips q-values: navigator.languages is always ["en-US","en"].
  try{
    var _rawLangs=Array.from(navigator.languages||[]);
    var _cleanLangs=_rawLangs.map(function(l){return l.split(';')[0].trim();}).filter(Boolean);
    if(_cleanLangs.length===0)_cleanLangs=['en-US','en'];
    Object.defineProperty(navigator,'languages',{get:function(){return _cleanLangs;},configurable:true});
    Object.defineProperty(navigator,'language',{get:function(){return _cleanLangs[0];},configurable:true});
  }catch(e){}
  // ── navigator.plugins: empty on Android Chrome ────────────────────────────────
  try{
    var _ep=Object.create(PluginArray.prototype);
    Object.defineProperty(_ep,'length',{get:function(){return 0;},configurable:true});
    Object.defineProperty(navigator,'plugins',{get:function(){return _ep;},configurable:true});
    var _em=Object.create(MimeTypeArray.prototype);
    Object.defineProperty(_em,'length',{get:function(){return 0;},configurable:true});
    Object.defineProperty(navigator,'mimeTypes',{get:function(){return _em;},configurable:true});
    Object.defineProperty(navigator,'pdfViewerEnabled',{get:function(){return false;},configurable:true});
  }catch(e){}
  // ── navigator.connection: force cellular/4g (not random wifi) ─────────────────
  try{
    var _nc=navigator.connection;
    if(_nc){
      try{Object.defineProperty(_nc,'type',{get:function(){return 'cellular';},configurable:true});}catch(e2){}
      try{Object.defineProperty(_nc,'effectiveType',{get:function(){return '4g';},configurable:true});}catch(e3){}
      // Seed once — stable between reads on the same page (real NetworkInformation
      // only changes when network conditions change, not on every property access).
      var _mob_dl=35+Math.round(Math.random()*25);
      var _mob_rtt=35+Math.round(Math.random()*30);
      try{Object.defineProperty(_nc,'downlink',{get:function(){return _mob_dl;},configurable:true});}catch(e4){}
      try{Object.defineProperty(_nc,'rtt',{get:function(){return _mob_rtt;},configurable:true});}catch(e5){}
    }
  }catch(e){}
  // ── DeviceMotionEvent: real phones always have active sensor emissions ─────────
  // A phone held normally shows near-zero jitter on x/y and ~-9.81 on y gravity.
  try{
    var _ax=0,_ay=0,_az=0;
    setInterval(function(){
      _ax+=( Math.random()-0.5)*0.025;_ay+=(Math.random()-0.5)*0.025;_az+=(Math.random()-0.5)*0.015;
      _ax=Math.max(-0.4,Math.min(0.4,_ax));_ay=Math.max(-0.4,Math.min(0.4,_ay));_az=Math.max(-0.2,Math.min(0.2,_az));
      try{
        var me=new DeviceMotionEvent('devicemotion');
        Object.defineProperty(me,'acceleration',{get:function(){return{x:_ax,y:_ay,z:_az};}});
        Object.defineProperty(me,'accelerationIncludingGravity',{get:function(){return{x:_ax,y:_ay-9.81,z:_az};}});
        Object.defineProperty(me,'rotationRate',{get:function(){return{alpha:(Math.random()-0.5)*1.2,beta:(Math.random()-0.5)*1.2,gamma:(Math.random()-0.5)*0.6};}});
        Object.defineProperty(me,'interval',{get:function(){return 16.67;}});
        window.dispatchEvent(me);
      }catch(e2){}
      try{
        var oe=new DeviceOrientationEvent('deviceorientation');
        Object.defineProperty(oe,'alpha',{get:function(){return 180+(Math.random()-0.5)*10;}});
        Object.defineProperty(oe,'beta',{get:function(){return (Math.random()-0.5)*5;}});
        Object.defineProperty(oe,'gamma',{get:function(){return (Math.random()-0.5)*3;}});
        Object.defineProperty(oe,'absolute',{get:function(){return false;}});
        window.dispatchEvent(oe);
      }catch(e3){}
    },16+Math.round(Math.random()*5));
  }catch(e){}
  // ── screen.orientation + window.orientation: must be portrait ────────────────
  // The fp script's desktop branch (isMobile=false, which ghost browser gets)
  // never touches orientation, so Electron defaults to landscape-primary.
  // setDeviceMetricsOverride sets portraitPrimary at the rendering level but does
  // NOT override the JavaScript screen.orientation object.
  try{
    var _ori={type:'portrait-primary',angle:0,onchange:null,
      lock:function(){return Promise.reject(new DOMException('Not supported','NotSupportedError'));},
      unlock:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
    Object.defineProperty(screen,'orientation',{get:function(){return _ori;},configurable:true});
  }catch(e){}
  try{Object.defineProperty(window,'orientation',{get:function(){return 0;},configurable:true});}catch(e){}
  // ── window.visualViewport: match the emulated 393×851 viewport ─────────────
  try{if(window.visualViewport){
    Object.defineProperty(window.visualViewport,'width',{get:function(){return 393;},configurable:true});
    Object.defineProperty(window.visualViewport,'height',{get:function(){return 851;},configurable:true});
    Object.defineProperty(window.visualViewport,'scale',{get:function(){return 1;},configurable:true});
  }}catch(e){}
  // ── window.ontouchstart: must be null (not undefined) on Android Chrome ─────
  // undefined = no touch support; null = touch capable, no handler registered.
  // The fp script only sets this in the mobile branch (isMobile=true).
  try{if(window.ontouchstart===undefined)window.ontouchstart=null;}catch(e){}
  // ── matchMedia: belt-and-suspenders on top of CDP setTouchEmulationEnabled ──
  // CDP touch emulation SHOULD flip (pointer:coarse) at Blink level, but the
  // fp script's mobile branch also patches matchMedia as extra insurance. Since
  // ghost browser runs the desktop branch, we replicate that patch here.
  try{
    var _oMM=window.matchMedia.bind(window);
    window.matchMedia=function(q){
      var _mql={matches:false,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
      if(/(pointer:\s*coarse|any-pointer:\s*coarse)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(hover:\s*none|any-hover:\s*none)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(pointer:\s*fine|any-pointer:\s*fine|hover:\s*hover|any-hover:\s*hover)/.test(q))return _mql;
      try{return _oMM(q);}catch(e2){return _mql;}
    };
  }catch(e){}
  // ── Remove desktop-only APIs absent from Android Chrome ───────────────────────
  // performance.memory is a non-standard Chrome extension not available on Android.
  // Instagram's device classifier checks "typeof performance.memory" to distinguish
  // mobile from desktop. We make it undefined to match the Android Chrome baseline.
  try{if(window.performance&&'memory' in window.performance){
    Object.defineProperty(performance,'memory',{get:function(){return undefined;},configurable:true});
  }}catch(e){}
  // navigator.keyboard (Keyboard Lock / Keyboard Map API) is desktop-only.
  // Present in desktop Chrome, absent in Android Chrome.
  try{if(navigator.keyboard!==undefined){
    Object.defineProperty(navigator,'keyboard',{get:function(){return undefined;},configurable:true});
  }}catch(e){}
})();`;

// Hardware fingerprint spoofing script injected into every EB page via CDP.
// Mirrors applyStealthScripts() in browserSession.ts exactly so the leak tool
// reports the same values that Account Settings shows (battery %, CPU cores,
// touch points, device memory, screen dimensions, connection).
//
// isMobile and apiUA are baked in as literals so the script is self-contained.
// The PRNG is seeded from navigator.userAgent (= the spoofed EB UA set via
// win.webContents.setUserAgent) — identical seed → identical values to the server.
interface EbFingerprintLite {
  webglVendor:    string;
  webglRenderer:  string;
  canvasNoise:    number;
  audioNoise:     number;
  mediaVideoId:   string;
  mediaAudioId:   string;
  mediaSpeakerId: string;
  fontSeed?:      number;
  speechProfile?: number;
}

// ── Human-like mouse click (Bézier curve path + realistic velocity) ───────────
// Generates a curved Bézier path from a random start near (0,0) to (tx,ty),
// firing mouseMoved events along the way before the final mouseDown/mouseUp.
// Real phones never jump directly from nowhere to a button — they leave a
// visible pointer trail.  The eased timing and per-step jitter make the path
// indistinguishable from a real finger gesture in Instagram's event logs.
async function humanMouseClick(
  wc: WebContents,
  tx: number,
  ty: number,
  sx = Math.round(tx * 0.1 + Math.random() * 20),
  sy = Math.round(ty * 0.1 + Math.random() * 20),
): Promise<void> {
  if (wc.isDestroyed()) return;

  const dx = tx - sx;
  const dy = ty - sy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 2) {
    // Already essentially at the target — just click
    wc.sendInputEvent({ type: "mouseDown", x: tx, y: ty, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 40 + Math.random() * 60));
    if (!wc.isDestroyed()) wc.sendInputEvent({ type: "mouseUp", x: tx, y: ty, button: "left", clickCount: 1 });
    return;
  }

  const steps = Math.max(8, Math.min(40, Math.round(dist / 10)));
  const totalMs = Math.max(80, Math.min(340, Math.round(dist * 0.7 + 50)));

  // Random control points — perturb perpendicular to travel direction
  const perpX = -dy / dist;
  const perpY =  dx / dist;
  const jiggle = (dist * 0.18 + 8) * (Math.random() > 0.5 ? 1 : -1);
  const c1x = sx + dx * 0.25 + perpX * jiggle * (0.5 + Math.random() * 0.5);
  const c1y = sy + dy * 0.25 + perpY * jiggle * (0.5 + Math.random() * 0.5);
  const c2x = sx + dx * 0.75 + perpX * jiggle * 0.4 * Math.random();
  const c2y = sy + dy * 0.75 + perpY * jiggle * 0.4 * Math.random();

  for (let i = 1; i <= steps; i++) {
    const raw = i / steps;
    // Cubic ease-in-out: slow start, fast middle, slow end
    const t = raw * raw * (3 - 2 * raw);
    const u = 1 - t;
    const mx = Math.round(u*u*u*sx + 3*u*u*t*c1x + 3*u*t*t*c2x + t*t*t*tx + (Math.random() - 0.5) * 1.2);
    const my = Math.round(u*u*u*sy + 3*u*u*t*c1y + 3*u*t*t*c2y + t*t*t*ty + (Math.random() - 0.5) * 1.2);
    if (!wc.isDestroyed()) wc.sendInputEvent({ type: "mouseMoved", x: mx, y: my } as any);
    const stepMs = (totalMs / steps) * (0.7 + Math.random() * 0.6);
    await new Promise(r => setTimeout(r, stepMs));
  }

  if (wc.isDestroyed()) return;
  wc.sendInputEvent({ type: "mouseDown", x: tx, y: ty, button: "left", clickCount: 1 });
  await new Promise(r => setTimeout(r, 35 + Math.random() * 55));
  if (!wc.isDestroyed()) wc.sendInputEvent({ type: "mouseUp", x: tx, y: ty, button: "left", clickCount: 1 });
}

// ── Human-like character-by-character CDP typing ───────────────────────────────
//
// WHY NOT Input.insertText for a full string:
//   Input.insertText delivers all characters as a single event — equivalent to
//   a clipboard paste.  Instagram's keystroke-timing analyser sees the entire
//   username/password arrive with 0 ms between characters, which is impossible
//   for a human typist.  This is a reliable bot signal regardless of isTrusted.
//
// HOW THIS WORKS:
//   For each character we fire:
//     rawKeyDown  (carries the char in `text` — required for React's synthetic
//                  onKeyDown to see the right key)
//     Input.insertText with ONE character  (triggers React onChange / nativeEvent
//                  input, updates controlled-input state)
//     keyUp       (completes the key lifecycle)
//   Then we wait a random 60–160 ms before the next character, with a 3 % chance
//   of a longer 300–800 ms "thinking" pause — matching the distribution of real
//   human typing on a mobile keyboard.
//
//   For 6-digit TOTP codes the min/max can be tightened (people type those faster).
async function typeTextCDP(
  dbg: Electron.Debugger,
  text: string,
  opts?: { minDelay?: number; maxDelay?: number; androidIme?: boolean },
): Promise<void> {
  const min       = opts?.minDelay  ?? 80;
  const max       = opts?.maxDelay  ?? 280;
  // androidIme=true: mimic Android virtual keyboard (IME) behaviour.
  // On Android every key fires keydown/keyup with key="Unidentified" and
  // windowsVirtualKeyCode=229 (VK_PROCESSKEY), NOT the actual char code.
  // Sending real Windows virtual key codes (e.g. 65 for 'A') is a hard
  // desktop signal Instagram's input-event analyser can read.
  const androidIme = opts?.androidIme ?? false;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const vk   = code >= 32 && code <= 126 ? code : 0;
    try {
      if (androidIme) {
        // Android IME path: keyCode 229 = VK_PROCESSKEY (standard for all
        // Android virtual keyboard input — character never appears in keydown)
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          key: "Unidentified",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode:  229,
        });
        await dbg.sendCommand("Input.insertText", { text: char });
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Unidentified",
          windowsVirtualKeyCode: 229,
          nativeVirtualKeyCode:  229,
        });
      } else {
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type: "rawKeyDown",
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode:  vk,
          unmodifiedText: char,
          text: char,
        });
        await dbg.sendCommand("Input.insertText", { text: char });
        await dbg.sendCommand("Input.dispatchKeyEvent", {
          type: "keyUp",
          windowsVirtualKeyCode: vk,
          nativeVirtualKeyCode:  vk,
          unmodifiedText: char,
          text: char,
        });
      }
    } catch {}
    // Human inter-key delay: base 80–280 ms + 8% chance of 400–1000 ms thinking pause
    const base  = min + Math.random() * (max - min);
    const pause = Math.random() < 0.08 ? 400 + Math.random() * 600 : 0;
    await new Promise<void>(r => setTimeout(r, Math.round(base + pause)));
  }
}

// ── CDP touch tap (replaces mouse clicks for mobile accounts) ─────────────────
//
// WHY NOT dispatchMouseEvent:
//   On a real Android phone, every tap fires touchstart → touchend → click.
//   CDP Input.dispatchMouseEvent fires mousedown + mouseup — events that NEVER
//   appear on a touchscreen device.  Instagram's React event handlers read
//   event.pointerType and event.sourceCapabilities.firesTouchEvents to distinguish
//   mouse from touch.  Sending mouse events when the UA claims Android Mobile is a
//   reliable bot signal detectable client-side without any server round-trip.
//
// HOW Input.synthesizeTapGesture WORKS:
//   Chromium synthesises a complete native touch gesture: touchstart → touchmove
//   (optional) → touchend → click, with correct pointerType="touch", isTrusted=true,
//   and sourceCapabilities.firesTouchEvents=true.  Instagram cannot distinguish this
//   from a finger tap on a real device.
//
// FALLBACK:
//   synthesizeTapGesture is available in all Chromium ≥ 72 builds (Electron ≥ 5).
//   If the command fails (e.g. a very old build or a race condition), we fall back
//   to dispatchMouseEvent so the flow doesn't break entirely.
async function cdpTapGesture(
  dbg: Electron.Debugger,
  x: number,
  y: number,
  opts?: { durationMs?: number },
): Promise<void> {
  const dur = opts?.durationMs ?? Math.round(50 + Math.random() * 80);
  try {
    await dbg.sendCommand("Input.synthesizeTapGesture", {
      x,
      y,
      duration:         dur,
      tapCount:         1,
      gestureSourceType: "touch",
    });
  } catch {
    // Fallback: dispatchMouseEvent with pointerType:"touch" so Instagram still
    // sees a touch-originated click (not a desktop mouse click) even if
    // synthesizeTapGesture failed. isTrusted=true because it comes from CDP.
    try {
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed",  x, y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
      await new Promise(r => setTimeout(r, 40 + Math.random() * 50));
      await dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
    } catch {}
  }
}

function buildFingerprintScript(isMobile: boolean, apiUA: string | null, fp?: EbFingerprintLite | null, chromeFullVer?: string | null, greaseBrand?: string | null, greaseBrandVer?: string | null, timezone?: string | null, browserUA?: string | null): string {
  const mf = isMobile ? 'true' : 'false';
  const af = apiUA ? JSON.stringify(apiUA) : 'null';
  // Bake real Client Hints values as literals so the injected script can use them
  // without needing access to the CHROME_BUILD_INFO table at runtime.
  const _cfv  = JSON.stringify(chromeFullVer  ?? null);  // e.g. "131.0.6778.260" or null
  const _gbr  = JSON.stringify(greaseBrand    ?? null);  // e.g. " Not A;Brand"   or null
  const _gbv  = JSON.stringify(greaseBrandVer ?? null);  // e.g. "8"              or null

  // Bake desktop Client Hints values so JS navigator.userAgentData.getHighEntropyValues()
  // returns architecture/platformVersion that MATCHES the CDP Emulation.setUserAgentOverride
  // metadata — without these, getHighEntropyValues('architecture') always returned "arm" for
  // desktop accounts while CDP correctly sent "x86" for Windows/Linux.
  const _dm = (!isMobile && browserUA) ? buildDesktopUAMetadata(browserUA) : null;
  const _daLiteral  = JSON.stringify(_dm?.architecture   ?? null);  // e.g. "x86" or null (mobile falls back to "arm" in-script)
  // Linux platformVersion is "" (empty string) — inject null so the JS fallback uses "" not "10.0.0".
  // truthy non-empty values (Windows/Mac) are injected as-is.
  const _dpvLiteral = JSON.stringify(_dm ? (_dm.platformVersion || null) : null);  // e.g. "10.0.0" | null

  // Per-account fingerprint values — baked in as literals when available so every
  // account has unique WebGL/canvas/audio/media-device data in the leak test.
  // Falls back to PRNG-derived values (seeded from UA hash) when not provided.
  let fpVars: string;
  if (fp) {
    fpVars = `var _WV=${JSON.stringify(fp.webglVendor)},_WR=${JSON.stringify(fp.webglRenderer)};`
           + `var _CN=${fp.canvasNoise},_AN=${fp.audioNoise};`
           + `var _MVID=${JSON.stringify(fp.mediaVideoId)},_MAID=${JSON.stringify(fp.mediaAudioId)},_MSID=${JSON.stringify(fp.mediaSpeakerId)};`
           + `var _FN=${fp.fontSeed ?? 50},_SP=${fp.speechProfile ?? 0};`;
  } else {
    fpVars = `var _WGPU=[["Qualcomm Technologies, Inc.","Adreno (TM) 750"],["Qualcomm Technologies, Inc.","Adreno (TM) 735"],["Qualcomm Technologies, Inc.","Adreno (TM) 720"],["ARM","Mali-G920 MC10"],["Google","Tensor G3"]];`
           + `var _gp=_WGPU[Math.floor(_r()*_WGPU.length)],_WV=_gp[0],_WR=_gp[1];`
           // Full 32-bit entropy for canvas index / audio LCG seed — see generateEbFingerprint()
           // in browserFingerprint.ts for why the old (2-254) / (1e-7 to 9e-7) ranges collapsed
           // to ~253 / ~9 distinct fingerprints at scale.
           + `var _CN=(Math.floor(_r()*4294967295)||1),_AN=(Math.floor(_r()*4294967295)||1);`
           + `var _hx=function(n){var s="";for(var i=0;i<n;i++){s+=("0"+Math.floor(_r()*256).toString(16)).slice(-2);}return s;};`
           + `var _MVID=_hx(16),_MAID=_hx(16),_MSID=_hx(16);`
           + `var _FN=_rI(1,99),_SP=_rI(0,7);`;
  }

  const _tzLiteral = timezone ? JSON.stringify(timezone) : 'null';
  const _ebFpSrc = `(function(){try{
  var _M=${mf},_A=${af},_TZ=${_tzLiteral};
  var _da=${_daLiteral},_dpv=${_dpvLiteral};
  var _ua=navigator.userAgent,_s=5381;
  for(var i=0;i<_ua.length;i++){_s=(((_s<<5)+_s)^_ua.charCodeAt(i))>>>0;}
  _s=_s||1;
  var _r=function(){_s=(Math.imul(1664525,_s)+1013904223)>>>0;return _s/0x100000000;};
  var _rI=function(lo,hi){return lo+Math.round(_r()*(hi-lo));};
  var _rp=function(a){return a[Math.floor(_r()*a.length)];};
  var _PROF=[[360,808,3.0,8,8],[411,914,2.625,8,9],[411,914,2.625,8,9],[360,780,3.0,8,10],
    [360,780,3.0,8,8],[393,851,2.75,8,8],[412,915,2.625,8,8],[412,900,2.70,8,8],
    [393,873,2.75,8,8],[393,873,2.75,8,8],[393,868,2.75,8,8],[360,780,3.0,8,8]];
  var _p=_rp(_PROF),_SW=_p[0],_SH=_p[1],_DPR=_p[2],_MEM=_p[3],_CORES=_p[4];
  if(_A){var _m=_A.match(/;\\s*(\\d+)dpi;\\s*(\\d+)x(\\d+)/);if(_m){
    var _dpi=+_m[1],_pW=+_m[2],_pH=+_m[3];
    _DPR=Math.round(_dpi/160*10000)/10000;_SW=Math.round(_pW/_DPR);_SH=Math.round(_pH/_DPR);_MEM=8;
    _CORES=/;\\s*Pixel 8[^9]/i.test(_A)?9:/exynos2400/i.test(_A)?10:8;}}
  var _BL=Math.round((0.60+_r()*0.39)*100)/100,_BC=_r()>0.35;
  var _BCT=_BC?_rI(0,3600):0,_BDT=_BC?Infinity:_rI(1800,28800);
  var _CT=_rp(["wifi","wifi","wifi","cellular"]),_CDL=Math.round(2+_r()*98),_CRT=_rI(10,150);
  ${fpVars}
  // ── ChromeDriver / Puppeteer artifact removal ────────────────────────────────
  // Electron injects $cdc_* / $chrome_* properties even with AutomationControlled
  // disabled.  These are the first thing bot-detection scripts check.
  try{var _dK=Object.keys(window).filter(function(k){return k.indexOf('$cdc_')===0||k.indexOf('$chrome_')===0||k==='__driver_evaluate'||k==='__webdriver_evaluate'||k==='__selenium_evaluate'||k==='__fxdriver_evaluate';});_dK.forEach(function(k){try{delete window[k];}catch(_e){}});}catch(_e){}
  // navigator.webdriver — patch the PROTOTYPE, not the instance.
  // Real Chrome (non-automated) exposes webdriver only on Navigator.prototype → false.
  // With --disable-blink-features=AutomationControlled the runtime value is already
  // false, but any Object.defineProperty() on the navigator *instance* creates a
  // detectable OWN property: Object.getOwnPropertyDescriptor(navigator,'webdriver')
  // returns undefined on a real browser, but would return our getter if we patched
  // the instance — a clear automation signal even when the returned value is false.
  // Fix: delete any accidental instance-level descriptor first, then enforce false
  // on the prototype so the own-property check returns undefined (clean).
  try{
    // Remove own-property descriptor if Electron somehow placed one.
    try{delete navigator.webdriver;}catch(_e){}
    // Redefine on the prototype so reads return false with no own-property trace.
    Object.defineProperty(Navigator.prototype,'webdriver',{
      get:function(){return false;},configurable:true,enumerable:true
    });
  }catch(e){}
  // Android Chrome 129 removed Java-plugin support — javaEnabled() must return false.
  // Electron returns true by default, which is a hard desktop/bot signal.
  // Direct assignment (navigator.javaEnabled = fn) silently fails — the Navigator
  // instance is sealed/the property is non-writable.  Patching the prototype works.
  try{Object.defineProperty(Navigator.prototype,'javaEnabled',{value:function(){return false;},writable:true,configurable:true});}catch(e){}
  if(_M){
    try{Object.defineProperty(screen,"width",{get:function(){return _SW;}});}catch(e){}
    try{Object.defineProperty(screen,"height",{get:function(){return _SH;}});}catch(e){}
    try{Object.defineProperty(screen,"availWidth",{get:function(){return _SW;}});}catch(e){}
    try{Object.defineProperty(screen,"availHeight",{get:function(){return _SH-30;}});}catch(e){}
    try{Object.defineProperty(screen,"colorDepth",{get:function(){return 24;}});}catch(e){}
    try{Object.defineProperty(screen,"pixelDepth",{get:function(){return 24;}});}catch(e){}
    try{Object.defineProperty(navigator,"maxTouchPoints",{get:function(){return 10;}});}catch(e){}
    try{Object.defineProperty(navigator,"platform",{get:function(){return "Linux armv8l";}});}catch(e){}
    try{Object.defineProperty(navigator,"hardwareConcurrency",{get:function(){return _CORES;}});}catch(e){}
    try{Object.defineProperty(navigator,"deviceMemory",{get:function(){return _MEM;}});}catch(e){}
    try{Object.defineProperty(window,"devicePixelRatio",{get:function(){return _DPR;}});}catch(e){}
    try{Object.defineProperty(window,"innerWidth",{get:function(){return _SW;}});}catch(e){}
    try{Object.defineProperty(window,"innerHeight",{get:function(){return _SH;}});}catch(e){}
    try{Object.defineProperty(screen,"isExtended",{get:function(){return false;}});}catch(e){}
    try{Object.defineProperty(window,"orientation",{get:function(){return 0;},configurable:true});}catch(e){}
    try{var _ori={type:"portrait-primary",angle:0,onchange:null,
      lock:function(){return Promise.reject(new DOMException("Not supported","NotSupportedError"));},
      unlock:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
      Object.defineProperty(screen,"orientation",{get:function(){return _ori;},configurable:true});}catch(e){}
    // navigator.connection: Chrome always has an existing NetworkInformation object,
    // so the old "only create if absent" block never ran — leaving the real type/
    // downlinkMax/etc. values visible (shows as "?" in the leak-test Network card).
    // Fix: always override properties on the existing object; only create a mock when
    // there is genuinely no connection object (e.g. non-Chrome Electron builds).
    try{
      var _nc2=(navigator).connection;
      if(_nc2){
        try{Object.defineProperty(_nc2,'type',{get:function(){return _CT;},configurable:true});}catch(_ce){}
        try{Object.defineProperty(_nc2,'effectiveType',{get:function(){return '4g';},configurable:true});}catch(_ce){}
        // Seed once — stable between reads on the same page.
        var _dt_dl=Math.max(1,Math.round(_CDL*(0.75+Math.random()*0.5)));
        var _dt_rtt=Math.max(5,Math.round(_CRT*(0.75+Math.random()*0.5)));
        try{Object.defineProperty(_nc2,'downlink',{get:function(){return _dt_dl;},configurable:true});}catch(_ce){}
        try{Object.defineProperty(_nc2,'rtt',{get:function(){return _dt_rtt;},configurable:true});}catch(_ce){}
        try{Object.defineProperty(_nc2,'saveData',{get:function(){return false;},configurable:true});}catch(_ce){}
        try{Object.defineProperty(_nc2,'downlinkMax',{get:function(){return Infinity;},configurable:true});}catch(_ce){}
      }else{
        var _cn={effectiveType:"4g",downlink:_CDL,rtt:_CRT,saveData:false,type:_CT,downlinkMax:Infinity,onchange:null,
          addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
        setInterval(function(){
          _cn.downlink=Math.max(1,Math.round(_CDL*(0.75+Math.random()*0.5)));
          _cn.rtt=Math.max(5,Math.round(_CRT*(0.75+Math.random()*0.5)));
        },25000+Math.random()*10000);
        try{Object.defineProperty(navigator,"connection",{get:function(){return _cn;},configurable:true});}catch(e){}
      }
    }catch(_ce){}
    try{var _oMM=window.matchMedia.bind(window);window.matchMedia=function(q){
      var _mql={matches:false,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
      if(/(pointer:\s*coarse|any-pointer:\s*coarse)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(hover:\s*none|any-hover:\s*none)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(pointer:\s*fine|any-pointer:\s*fine|hover:\s*hover|any-hover:\s*hover)/.test(q))return _mql;
      // prefers-color-scheme / prefers-reduced-motion: only intercept simple single-
      // feature queries. Compound queries (containing "and", "or", "not", commas) fall
      // through to native matchMedia — substring matching would misfire on e.g.
      // "not (prefers-color-scheme: light)" or "(prefers-color-scheme: dark) and (...)".
      // Android dark-mode is the majority default on modern devices; a server Electron
      // process returns "light" (no system dark mode), leaking host-OS identity.
      if(!/\band\b|\bor\b|\bnot\b|,/.test(q)){
        if(/prefers-color-scheme:\s*dark/.test(q))return Object.assign({},_mql,{matches:true});
        if(/prefers-color-scheme:\s*light/.test(q))return _mql;
        // prefers-reduced-motion: Android Chrome default is no-preference.
        if(/prefers-reduced-motion:\s*no-preference/.test(q))return Object.assign({},_mql,{matches:true});
        if(/prefers-reduced-motion:\s*reduce/.test(q))return _mql;
      }
      try{return _oMM(q);}catch(e2){return _mql;}
    };}catch(e){}
    try{if(window.visualViewport){
      Object.defineProperty(window.visualViewport,'width',{get:function(){return _SW;},configurable:true});
      Object.defineProperty(window.visualViewport,'height',{get:function(){return _SH;},configurable:true});
      Object.defineProperty(window.visualViewport,'scale',{get:function(){return 1;},configurable:true});
    }}catch(e){}
    try{Object.defineProperty(window,'outerWidth',{get:function(){return _SW;},configurable:true});}catch(e){}
    try{Object.defineProperty(window,'outerHeight',{get:function(){return _SH;},configurable:true});}catch(e){}
    try{if(window.ontouchstart===undefined)window.ontouchstart=null;}catch(e){}
    // Android Chrome has zero plugins and zero MIME types.
    // The ghost-signup patch already does this, but the regular EB fp script was
    // missing it — leaking Electron's real "PDF Viewer / Print" plugin entries
    // (5 plugins, 2 MIME types visible in Bot Detection on the leak-test page).
    try{
      var _ep2=Object.create(PluginArray.prototype);
      Object.defineProperty(_ep2,'length',{get:function(){return 0;},configurable:true});
      Object.defineProperty(navigator,'plugins',{get:function(){return _ep2;},configurable:true});
      var _em2=Object.create(MimeTypeArray.prototype);
      Object.defineProperty(_em2,'length',{get:function(){return 0;},configurable:true});
      Object.defineProperty(navigator,'mimeTypes',{get:function(){return _em2;},configurable:true});
    }catch(e){}
    // performance.memory is a non-standard Chrome extension absent on Android Chrome.
    // Instagram's device classifier checks "typeof performance.memory" to distinguish
    // mobile from desktop. The ghost-signup patch already does this — keep in sync.
    try{if(window.performance&&'memory' in window.performance){
      Object.defineProperty(performance,'memory',{get:function(){return undefined;},configurable:true});
    }}catch(e){}
    // navigator.keyboard (Keyboard Lock / Keyboard Map API) is desktop-only Chrome.
    // Present in Electron; absent on Android Chrome. Another clear desktop signal.
    try{if(navigator.keyboard!==undefined){
      Object.defineProperty(navigator,'keyboard',{get:function(){return undefined;},configurable:true});
    }}catch(e){}
  }else{
    try{Object.defineProperty(screen,"width",{get:function(){return 1920;}});}catch(e){}
    try{Object.defineProperty(screen,"height",{get:function(){return 1080;}});}catch(e){}
    try{Object.defineProperty(screen,"availWidth",{get:function(){return 1920;}});}catch(e){}
    try{Object.defineProperty(screen,"availHeight",{get:function(){return 1040;}});}catch(e){}
    try{Object.defineProperty(screen,"colorDepth",{get:function(){return 24;}});}catch(e){}
    try{Object.defineProperty(screen,"pixelDepth",{get:function(){return 24;}});}catch(e){}
    try{Object.defineProperty(navigator,"maxTouchPoints",{get:function(){return 0;}});}catch(e){}
    try{Object.defineProperty(navigator,"hardwareConcurrency",{get:function(){return _rp([4,6,8,8,8,12,16]);}});}catch(e){}
    try{Object.defineProperty(navigator,"deviceMemory",{get:function(){return _rp([8,8,16,32]);}});}catch(e){}
  }
  try{
    var _bt={charging:_BC,chargingTime:_BCT,dischargingTime:_BDT,level:_BL,
      onchargingchange:null,onchargingtimechange:null,ondischargingtimechange:null,onlevelchange:null,
      addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
    var _dp=0.0008+Math.random()*0.0004;
    setInterval(function(){
      if(_bt.charging){_bt.level=Math.min(1.0,Math.round((_bt.level+_dp)*10000)/10000);if(_bt.level>=1.0)_bt.chargingTime=0;}
      else{_bt.level=Math.max(0.05,Math.round((_bt.level-_dp)*10000)/10000);}
    },60000);
    navigator.getBattery=function(){return Promise.resolve(_bt);};
  }catch(e){}
  try{document.hasFocus=function(){return true;};}catch(e){}
  try{Object.defineProperty(document,'visibilityState',{get:function(){return 'visible';},configurable:true});}catch(e){}
  try{Object.defineProperty(document,'hidden',{get:function(){return false;},configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,"languages",{get:function(){return ["en-US","en"];}});}catch(e){}
  // window.chrome MUST be present on both Android Chrome and Desktop Chrome —
  // real Chrome (any platform, any version in our range) always exposes it as
  // long as navigator.vendor === "Google Inc.".  Deleting it entirely (the old
  // behaviour here) is itself a well-known bot signal: headless/automated
  // Chromium and older stealth-evasion scripts historically stripped window.chrome,
  // so detectors specifically check for its ABSENCE as a red flag. Real Android
  // Chrome's window.chrome is a minimal object (no loadTimes/csi — those were
  // removed from both desktop and mobile Chrome years ago), so we expose the
  // same minimal shape on both branches instead of contradicting the UA.
  // window.chrome.runtime must be a real object — detectors check
  // typeof window.chrome.runtime === 'object' and it must be truthy.
  // The old {runtime:undefined} value failed that test (WARN in browser check).
  try{
    var _cr={id:undefined,connect:function(){return{onMessage:{addListener:function(){}},onDisconnect:{addListener:function(){}},postMessage:function(){},disconnect:function(){}};},sendMessage:function(){},getManifest:function(){return null;},onMessage:{addListener:function(){},removeListener:function(){},hasListener:function(){return false;}},onConnect:{addListener:function(){},removeListener:function(){},hasListener:function(){return false;}}};
    if(!window.chrome){Object.defineProperty(window,'chrome',{value:{runtime:_cr},configurable:true,writable:true,enumerable:true});}
    else if(window.chrome&&!window.chrome.runtime){try{Object.defineProperty(window.chrome,'runtime',{value:_cr,configurable:true,writable:true});}catch(_e2){try{window.chrome.runtime=_cr;}catch(_e3){}}}
  }catch(_e){}
  try{var _oq=navigator.permissions&&navigator.permissions.query.bind(navigator.permissions);
    if(_oq){
      // Expand to all permissions that should be "prompt" on a real Android Chrome session.
      // Previously only "notifications" was overridden; clipboard-read/write, midi, and
      // payment-handler were returning "granted" (Electron defaults), which is a bot signal.
      var _PPROMPT=['notifications','clipboard-read','clipboard-write','midi','payment-handler','background-sync','geolocation','camera','microphone','accelerometer','gyroscope','magnetometer'];
      navigator.permissions.query=function(p){
        return _PPROMPT.indexOf(p.name)>=0?Promise.resolve({state:"prompt",onchange:null}):_oq(p);};
    }}catch(e){}
  try{
    if(window.WebGLRenderingContext){
      var _oE1=WebGLRenderingContext.prototype.getExtension;
      WebGLRenderingContext.prototype.getExtension=function(n){
        if(n==="WEBGL_debug_renderer_info")return{UNMASKED_VENDOR_WEBGL:0x9245,UNMASKED_RENDERER_WEBGL:0x9246};
        return _oE1.call(this,n);};
      var _oP1=WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter=function(p){
        if(p===0x9245)return _WV;if(p===0x9246)return _WR;return _oP1.call(this,p);};
    }
    if(window.WebGL2RenderingContext){
      var _oE2=WebGL2RenderingContext.prototype.getExtension;
      WebGL2RenderingContext.prototype.getExtension=function(n){
        if(n==="WEBGL_debug_renderer_info")return{UNMASKED_VENDOR_WEBGL:0x9245,UNMASKED_RENDERER_WEBGL:0x9246};
        return _oE2.call(this,n);};
      var _oP2=WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter=function(p){
        if(p===0x9245)return _WV;if(p===0x9246)return _WR;return _oP2.call(this,p);};
    }
  }catch(e){}
  try{
    var _oDTU=HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL=function(){
      if(!this.width||!this.height)return _oDTU.apply(this,arguments);
      try{
        var c=document.createElement('canvas');c.width=this.width;c.height=this.height;
        var cx=c.getContext('2d');cx.drawImage(this,0,0);
        var d=cx.getImageData(0,0,c.width,c.height);
        var idx=(_CN*4)%d.data.length;d.data[idx]=d.data[idx]^1;
        cx.putImageData(d,0,0);
        return _oDTU.apply(c,arguments);
      }catch(e2){return _oDTU.apply(this,arguments);}
    };
  }catch(e){}
  try{
    var _oDTB=HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob=function(cb,type,quality){
      if(!this.width||!this.height){_oDTB.call(this,cb,type,quality);return;}
      try{
        var c=document.createElement('canvas');c.width=this.width;c.height=this.height;
        var cx=c.getContext('2d');cx.drawImage(this,0,0);
        var d=cx.getImageData(0,0,c.width,c.height);
        var idx=(_CN*4)%d.data.length;d.data[idx]=d.data[idx]^1;
        cx.putImageData(d,0,0);
        _oDTB.call(c,cb,type,quality);
      }catch(e2){_oDTB.call(this,cb,type,quality);}
    };
  }catch(e){}
  try{Object.defineProperty(navigator,"pdfViewerEnabled",{get:function(){return false;}});}catch(e){}
  try{
    var _oGFF=AnalyserNode.prototype.getFloatFrequencyData;
    AnalyserNode.prototype.getFloatFrequencyData=function(a){
      _oGFF.call(this,a);
      if(a&&a.length>0){var _as=(_AN|1);for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;a[i]+=(_as/0x100000000)*0.0001-0.00005;}}
    };
    var _oGBF=AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData=function(a){
      _oGBF.call(this,a);
      if(a&&a.length>0){var _as=(_AN|1);for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;var v=a[i]+(_as/0x100000000>0.5?1:0);a[i]=Math.max(0,Math.min(255,v));}}
    };
    var _oGFT=AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData=function(a){
      _oGFT.call(this,a);
      if(a&&a.length>0){var _as=(_AN|1);for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;a[i]=Math.max(-1,Math.min(1,a[i]+(_as/0x100000000)*0.0001-0.00005));}}
    };
  }catch(e){}
  try{
    // Real Chrome reduces performance.now() resolution to ~0.1 ms to mitigate
    // Spectre timing attacks. Electron/Chromium in debug mode returns
    // full-microsecond precision — a clear non-browser signal. Clamp to 0.1 ms.
    var _oPNow=performance.now.bind(performance);
    performance.now=function(){return Math.round(_oPNow()*10)/10;};
  }catch(e){}
  try{
    // Real Android Chrome does NOT set DNT — navigator.doNotTrack is null.
    // Electron sets it to "1" by default (Chromium's built-in DNT preference
    // is ON in the Electron session), which is a fingerprint mismatch: Instagram
    // sees a "mobile Chrome" session with DNT=1 even though no Android user
    // ever enables DNT through Chrome's hidden settings.
    Object.defineProperty(navigator,'doNotTrack',{get:function(){return null;},configurable:true});
  }catch(e){}
  try{
    // Real behaviour was to CONCAT the fake device onto the host's real
    // enumerateDevices() result — meaning Instagram still saw the actual PC's
    // real camera/mic hardware (device count, group IDs) alongside the fake
    // Android entries. A phone never has an extra desktop webcam + headset
    // showing up next to its stock camera/mic. Now we IGNORE the real result
    // entirely and always return a fixed, realistic Android device set (one
    // rear + one front camera, one mic, one speaker) — matching a stock phone
    // and never leaking anything about the host PC's real hardware.
    if(navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices){
      navigator.mediaDevices.enumerateDevices=function(){
        return Promise.resolve([
          {deviceId:_MVID,groupId:_MVID.slice(0,8),kind:'videoinput',label:'',toJSON:function(){return {};}},
          {deviceId:_MVID.slice(0,16)+'f',groupId:_MVID.slice(0,8),kind:'videoinput',label:'',toJSON:function(){return {};}},
          {deviceId:_MAID,groupId:_MAID.slice(0,8),kind:'audioinput',label:'',toJSON:function(){return {};}},
          {deviceId:_MSID,groupId:_MSID.slice(0,8),kind:'audiooutput',label:'',toJSON:function(){return {};}}
        ]);
      };
    }
  }catch(e){}
  try{
    var _chm=_ua.match(/Chrome\\/([0-9]+)/);
    var _chv=_chm?_chm[1]:"${CURRENT_CHROME_MAJOR}";
    var _chp=_ua.indexOf("Android")>=0?"Android":_ua.indexOf("Macintosh")>=0?"macOS":_ua.indexOf("Linux")>=0?"Linux":"Windows";
    var _chmo=_ua.indexOf("Android")>=0&&_ua.indexOf("Mobile")>=0;
    // Real greased brand + version baked in from CHROME_BUILD_INFO at injection time.
    // Falls back to UA-derived values so old profiles without the info still work.
    var _GB=${_gbr}||(parseInt(_chv,10)>=128?" Not A;Brand":"Not/A)Brand");
    var _GBV=${_gbv}||"8";
    // Real full build version (e.g. "131.0.6778.260") — never ".0.0.0"
    var _CFV=${_cfv}||(_chv+".0.6778.260");
    var _chb=[{brand:_GB,version:_GBV},{brand:"Chromium",version:_chv},{brand:"Google Chrome",version:_chv}];
    var _chmdl=(function(){var mm=_ua.match(/Android [0-9]+;\\s*([^)]+)\\)/);return mm?mm[1].trim():"";})();
    // Android platform version derived from UA string — must match Sec-CH-UA-Platform-Version header.
    var _chav=(function(){var m=_ua.match(/Android[\\s/]+([0-9]+)/i);return m?(m[1]+".0.0"):"15.0.0";})();
    Object.defineProperty(navigator,"userAgentData",{
      get:function(){
        return{
          brands:_chb,mobile:_chmo,platform:_chp,
          getHighEntropyValues:function(h){
            var rv={brands:_chb,mobile:_chmo,platform:_chp};
            if(h.indexOf("platformVersion")>=0)rv.platformVersion=_M?_chav:(_dpv!=null?_dpv:"");
            if(h.indexOf("architecture")>=0)rv.architecture=_M?"arm":(_da||"x86");
            if(h.indexOf("bitness")>=0)rv.bitness="64";
            if(h.indexOf("model")>=0)rv.model=_chmdl;
            if(h.indexOf("uaFullVersion")>=0)rv.uaFullVersion=_CFV;
            if(h.indexOf("fullVersionList")>=0)rv.fullVersionList=_chb.map(function(b){return{brand:b.brand,version:b===_chb[0]?(_GBV+".0.0.0"):_CFV};});
            return Promise.resolve(rv);
          },
          toJSON:function(){return{brands:_chb,mobile:_chmo,platform:_chp};}
        };
      },configurable:true
    });
  }catch(e){}
  try{
    // All 28 fonts probed by the leak test + common external fingerprinters.
    // Per-account fontSeed (_FN, range 1-99) controls which subset appears
    // "installed" so 1,000 accounts each report a different font profile.
    // The hook fully controls measureText width for every controlled font:
    //   • present  → width clearly differs from monospace baseline
    //   • absent   → width equals monospace baseline (font appears not installed)
    // This hides genuine Windows fonts AND fakes absent fonts, per-account.
    // Sorted longest-first so indexOf matching is unambiguous:
    // 'Arial Black' / 'Arial Narrow' are found before the shorter 'Arial'.
    var _FVAR=['Franklin Gothic Medium','Microsoft Sans Serif','Lucida Sans Unicode',
      'Palatino Linotype','Bookman Old Style','Times New Roman','Century Gothic',
      'Lucida Console','Comic Sans MS','Arial Narrow','Trebuchet MS','Gill Sans MT',
      'Courier New','Arial Black','Arial','Calibri','Cambria','Courier','Georgia',
      'Helvetica','Impact','Segoe UI','Tahoma','Verdana','Wingdings','Symbol',
      'Webdings','Garamond'];
    // These fonts have Noto/metric-compatible equivalents on Android Chrome —
    // always shown as present so the account looks like a real mobile browser.
    var _FCORE=['Arial','Courier New','Georgia','Times New Roman','Verdana'];
    var _FP={};
    (function(){
      var _fh=function(f,s){var h=s>>>0;for(var i=0;i<f.length;i++){h=((h<<5)+h+f.charCodeAt(i))>>>0;}return h;};
      for(var _fi=0;_fi<_FVAR.length;_fi++){
        var _ff=_FVAR[_fi];
        if(_FCORE.indexOf(_ff)>=0){_FP[_ff]=true;continue;}
        // Non-core: 10-30% probability, unique per account via fontSeed
        _FP[_ff]=(_fh(_ff,_FN)%100)<Math.max(10,Math.min(30,Math.round(_FN/3)));
      }
    })();
    // Separate OffscreenCanvas for monospace baseline measurement — avoids
    // mutating this.font inside the hook which would be a detectable side-effect.
    // Helper canvas for monospace baseline measurement.
    // IMPORTANT: save _fpMT BEFORE installing the hook so it captures the native
    // (pre-hook) measureText bound to the correct context type.  Two failure modes:
    //   (a) OffscreenCanvas.getContext('2d') returns null → _fpX stays null, fallback runs.
    //   (b) OffscreenCanvas.getContext('2d') returns a NON-null OffscreenCanvasRenderingContext2D —
    //       calling CanvasRenderingContext2D.prototype.measureText with that as 'this' throws
    //       "Illegal invocation" because the two contexts are DIFFERENT prototype chains.
    // Solution: bind _fpX.measureText directly to _fpX so the call always uses the
    // native method for whatever context type was actually created (OffscreenCanvas OR
    // document canvas).  _fpMT(text) then works regardless of which branch ran.
    var _fpX=null;
    try{var _fpC=new OffscreenCanvas(400,40);_fpX=_fpC.getContext('2d');}catch(_fe){}
    if(!_fpX){try{var _fpD=document.createElement('canvas');_fpD.width=400;_fpD.height=40;_fpX=_fpD.getContext('2d');}catch(_fe2){}}
    // Capture the native measureText bound to _fpX NOW, before the hook replaces
    // CanvasRenderingContext2D.prototype.measureText below.
    var _fpMT=_fpX?_fpX.measureText.bind(_fpX):null;
    var _oMT=CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText=function(text){
      var r=_oMT.call(this,text);
      var fs=this.font||'';
      // Find the first controlled font name present in this font string
      var _mf=null;
      for(var _fi=0;_fi<_FVAR.length;_fi++){if(fs.indexOf(_FVAR[_fi])>=0){_mf=_FVAR[_fi];break;}}
      if(_mf===null)return r;
      // Guard: if OffscreenCanvas context failed to create (returns null in some
      // Chromium sandbox configurations), fall back to passing the real measurement
      // through unmodified rather than crashing the caller with a TypeError from
      // _oMT.call(null,...). Without this, testFonts() in the leak-test page throws
      // and crashes the entire runAll() async function, leaving every async card
      // (IP, WebRTC, DNS, Battery, Media, Permissions, Hints) frozen in its initial
      // "Fetching…" / "Running…" HTML state forever.
      if(!_fpX||!_fpMT)return r;
      // Extract font size (e.g. "72px") to use the same size on the helper canvas
      var _sz=(fs.match(/\d+(?:\.\d+)?(?:px|pt|em|rem)/)||['16px'])[0];
      _fpX.font=_sz+' monospace';
      // Use _fpMT (pre-bound to _fpX) instead of _oMT.call(_fpX, text).
      // _oMT is CanvasRenderingContext2D.prototype.measureText — calling it with an
      // OffscreenCanvasRenderingContext2D as 'this' throws "Illegal invocation".
      // _fpMT was bound to _fpX before hook installation, so it always uses the
      // correct native method for whatever context type _fpX actually is.
      var _bw=_fpMT(text).width;
      if(_FP[_mf]){
        // Font should appear present: width must differ from monospace baseline
        if(Math.abs(r.width-_bw)<0.01){
          // Font not truly installed — inject a detectable width difference
          return new Proxy(r,{get:function(t,k,rv){return k==='width'?_bw+1.5:Reflect.get(t,k,rv);}});
        }
        return r; // Truly installed and already different — pass through
      }else{
        // Font should appear NOT present: clamp to monospace baseline width
        return new Proxy(r,{get:function(t,k,rv){return k==='width'?_bw:Reflect.get(t,k,rv);}});
      }
    };
  }catch(e){}
  try{
    var _SVS=[
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google UK English Female',lang:'en-GB',localService:true,default:false,voiceURI:'Google UK English Female'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google UK English Male',lang:'en-GB',localService:true,default:false,voiceURI:'Google UK English Male'},{name:'Google Deutsch',lang:'de-DE',localService:false,default:false,voiceURI:'Google Deutsch'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google Espanol',lang:'es-ES',localService:false,default:false,voiceURI:'Google Espanol'},{name:'Google Francais',lang:'fr-FR',localService:false,default:false,voiceURI:'Google Francais'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google Hindi',lang:'hi-IN',localService:false,default:false,voiceURI:'Google Hindi'},{name:'Google Italiano',lang:'it-IT',localService:false,default:false,voiceURI:'Google Italiano'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google UK English Female',lang:'en-GB',localService:true,default:false,voiceURI:'Google UK English Female'},{name:'Google Portugues',lang:'pt-BR',localService:false,default:false,voiceURI:'Google Portugues'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google Mandarin',lang:'zh-CN',localService:false,default:false,voiceURI:'Google Mandarin'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google UK English Male',lang:'en-GB',localService:true,default:false,voiceURI:'Google UK English Male'},{name:'Google Espanol US',lang:'es-US',localService:false,default:false,voiceURI:'Google Espanol US'},{name:'Google Russian',lang:'ru-RU',localService:false,default:false,voiceURI:'Google Russian'}],
      [{name:'Google US English',lang:'en-US',localService:true,default:true,voiceURI:'Google US English'},{name:'Google Bahasa Indonesia',lang:'id-ID',localService:false,default:false,voiceURI:'Google Bahasa Indonesia'},{name:'Google Bangla',lang:'bn-BD',localService:false,default:false,voiceURI:'Google Bangla'}]
    ];
    var _SV=_SVS[_SP%_SVS.length];
    window.speechSynthesis.getVoices=function(){return _SV.slice();};
    var _oPAE=EventTarget.prototype.addEventListener;
    window.speechSynthesis.addEventListener=function(t,fn,opts){
      _oPAE.call(this,t,fn,opts);if(t==='voiceschanged'){try{fn.call(window.speechSynthesis,new Event('voiceschanged'));}catch(e2){}}
    };
  }catch(e){}
  try{
    var _WPS=(
      '(function(){'
      +'try{Object.defineProperty(self.navigator,"hardwareConcurrency",{get:function(){return '+_CORES+';}});}catch(e){}'
      +'try{Object.defineProperty(self.navigator,"deviceMemory",{get:function(){return '+_MEM+';}});}catch(e){}'
      +'try{Object.defineProperty(self.navigator,"platform",{get:function(){return"Linux armv8l";}});}catch(e){}'
      +'if(typeof OffscreenCanvas!=="undefined"){try{'
      +'var _pG=function(gl){if(!gl)return;'
      +'var _eO=gl.getExtension.bind(gl),_pO=gl.getParameter.bind(gl);'
      +'gl.getExtension=function(n){if(n==="WEBGL_debug_renderer_info")return{UNMASKED_VENDOR_WEBGL:37445,UNMASKED_RENDERER_WEBGL:37446};return _eO(n);};'
      +'gl.getParameter=function(p){if(p===37445)return '+JSON.stringify(_WV)+';if(p===37446)return '+JSON.stringify(_WR)+';return _pO(p);};};'
      +'var _oGC=OffscreenCanvas.prototype.getContext;'
      +'OffscreenCanvas.prototype.getContext=function(t,a){var g=_oGC.call(this,t,a);if(g&&(t==="webgl"||t==="webgl2"||t==="experimental-webgl"))_pG(g);return g;};'
      +'}catch(e){}}'
      +'})();'
    );
    var _WBlob=new Blob([_WPS],{type:'text/javascript'});
    var _WUrl=URL.createObjectURL(_WBlob);
    var _WOrig=window.Worker;
    if(_WOrig){
      window.Worker=function(url,opts){
        if(!opts||opts.type!=='module'){
          try{
            var _wu=typeof url==='string'?url:url.toString();
            var _wb=new Blob(['importScripts('+JSON.stringify(_WUrl)+');\\nimportScripts('+JSON.stringify(_wu)+');'],{type:'text/javascript'});
            return new _WOrig(URL.createObjectURL(_wb),opts);
          }catch(e2){}
        }
        return new _WOrig(url,opts);
      };
      try{window.Worker.prototype=_WOrig.prototype;}catch(e){}
      try{Object.defineProperty(window.Worker,'name',{value:'Worker'});}catch(e){}
    }
  }catch(e){}
  // ── Intl.DateTimeFormat timezone override ────────────────────────────────────
  // Emulation.setTimezoneOverride sets the V8 runtime's OS-level timezone BUT
  // Intl.DateTimeFormat reads from the ICU locale data, not the V8 timezone —
  // so Intl.DateTimeFormat().resolvedOptions().timeZone still returns the real
  // server timezone.  Instagram calls this to validate the session's timezone
  // against the proxy exit IP.  This override fixes the mismatch by wrapping
  // the constructor to always inject the correct timeZone option.
  if(_TZ){try{var _oDTF=Intl.DateTimeFormat;var _pDTF=function(l,o){return new _oDTF(l,Object.assign({},o||{},{timeZone:_TZ}));};_pDTF.prototype=_oDTF.prototype;_pDTF.supportedLocalesOf=_oDTF.supportedLocalesOf.bind(_oDTF);Intl.DateTimeFormat=_pDTF;}catch(_e){}}
  // ── Intl locale fix: RelativeTimeFormat / NumberFormat / PluralRules / Collator ─
  // Emulation.setUserAgentOverride acceptLanguage controls HTTP headers and
  // navigator.language but NOT the ICU locale used by other Intl constructors —
  // they read the process locale directly (e.g. may expose 'pt-BR' on a Linux
  // server even though navigator.language is 'en-US').  Force them to match.
  try{var _lang0=(navigator.languages&&navigator.languages[0])||'en-US';
    ['RelativeTimeFormat','NumberFormat','PluralRules','Collator'].forEach(function(n){
      var _o=(Intl)[n];if(!_o)return;
      var _p=function(l,o){return new _o(l!==undefined?l:_lang0,o);};
      try{_p.prototype=_o.prototype;}catch(_e){}
      try{_p.supportedLocalesOf=_o.supportedLocalesOf.bind(_o);}catch(_e){}
      try{(Intl)[n]=_p;}catch(_e){}
    });
  }catch(_e){}
}catch(e){}})();`;
  // Make every Object.defineProperty getter in the fp script configurable:true.
  // Without this, the desktop-mode fp script (which runs when ghost browser
  // opens without a mobile UA) locks screen.width=1920 etc. as non-configurable,
  // and the ghost-signup mobile patch injected later cannot override them.
  return _ebFpSrc.replace(/\{get:function\(\)/g, '{configurable:true,get:function()');
}

// ── Ghost Browser UA helpers ──────────────────────────────────────────────────
//
// Instagram's mobile API uses a compact UA format ("34/14; 420dpi; 1080x2340; ...")
// completely different from the browser UA Chrome sends ("Mozilla/5.0 (Linux; Android...").
// When the Ghost Browser receives the API-format UA it must be converted to the
// proper mobile Chrome UA before being set on the BrowserWindow — otherwise
// navigator.userAgent, Client Hints (Sec-CH-UA-*), navigator.platform, and the
// device fingerprint script all receive wrong values, exposing the Windows host.

/** Returns true if `ua` is an Instagram API-format UA ("34/14; 420dpi; ..."). */
function isApiFormatUA(ua: string): boolean {
  return !!ua && !ua.startsWith("Mozilla") && /^\d+\/\d+;\s*\d+dpi/i.test(ua);
}

/**
 * Parses an API-format UA and returns the equivalent mobile Chrome browser UA
 * along with the extracted Android version and device model for Client Hints.
 *
 * "34/14; 420dpi; 1080x2340; Motorola; motorola edge 40 pro; rtwo; Snapdragon8Gen2; en_US"
 * → { browserUA: "Mozilla/5.0 (Linux; Android 14; motorola edge 40 pro) AppleWebKit/537.36...",
 *     androidVersion: "14", deviceModel: "motorola edge 40 pro" }
 */
function apiUAToBrowserUA(apiUA: string): { browserUA: string; androidVersion: string; deviceModel: string } {
  const m = apiUA.match(/^\d+\/(\d+);\s*\d+dpi;\s*\d+x\d+;\s*[^;]+;\s*([^;]+)/i);
  const androidVersion = m ? m[1].trim() : "14";
  const deviceModel    = m ? m[2].trim() : "motorola edge 40 pro";
  // Use the actual Chromium major version bundled with this Electron build so
  // the advertised Chrome version matches reality.  Hardcoding "131" meant all
  // ghost/verify windows presented the same UA regardless of the Electron build,
  // which is a trivial bot-detection signal.
  const chromeMajor = process.versions.chrome?.split(".")[0] ?? CURRENT_CHROME_MAJOR;
  const browserUA = `Mozilla/5.0 (Linux; Android ${androidVersion}; ${deviceModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Mobile Safari/537.36`;
  return { browserUA, androidVersion, deviceModel };
}

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

// ── Chrome UA version bump helpers ────────────────────────────────────────────

/**
 * Rewrites the Chrome version inside a browser UA string.
 * e.g. "…Chrome/137.0.7151.55 Mobile…" → "…Chrome/140.0.7312.45 Mobile…"
 */
function rewriteChromeMajorInUA(ua: string, newFull: string): string {
  return ua.replace(/Chrome\/[\d.]+/, `Chrome/${newFull}`);
}

/**
 * Fire-and-forget: tell the API server to persist a Chrome-bumped UA for an
 * account. Only updates userAgentEmbedded + ebFingerprint — account status,
 * cookies, and device state are untouched.
 */
function pushUABumpToServer(profileId: number, newEmbeddedUA: string): void {
  if (!_serverPort) return;
  const body = JSON.stringify({ userAgentEmbedded: newEmbeddedUA });
  const req = http.request({
    hostname: "127.0.0.1",
    port:     _serverPort,
    path:     `/api/profiles/${profileId}/bump-chrome-ua`,
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
  win: BrowserWindow | { webContents: Electron.WebContents },
  username: string,
  password: string,
  twoFAKey: string,
  userAgent?: string,
): Promise<{ ok: boolean; message: string }> {
  const _t0 = Date.now();
  const _ts = () => `+${((Date.now() - _t0) / 1000).toFixed(1)}s`;
  console.log(`[doAutoLogin:${profileId}] @${username} — starting`);
  const wc  = win.webContents;
  const ses = electronSession.fromPartition(ebPartition(profileId));
  const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

  // Apply CDP user-agent override so Client Hints (Sec-CH-UA-*) headers match
  // the declared UA — same approach as openEbWindow.  Without this the hidden
  // window advertises "Windows / Mobile: false" via Client Hints regardless of
  // setUserAgent(), which Instagram fingerprints as an automation bot.
  if (userAgent) {
    try {
      try { wc.debugger.attach("1.3"); } catch {}
      wireHeaderCapture(wc, profileId);
      const _chromeMajor = (userAgent.match(/Chrome\/(\d+)/)?.[1]) ?? CURRENT_CHROME_MAJOR;
      const _isMob = userAgent.includes("Mobile") || userAgent.includes("Android");
      const _buildInfo = getChromeBuildInfo(_chromeMajor);
      // Extract Android version from UA string — must match Sec-CH-UA-Platform-Version.
      const _androidVer = userAgent.match(/Android\s+(\d+)/i)?.[1] ?? "15";
      // Extract device model from UA string for Sec-CH-UA-Model.
      const _model = userAgent.match(/Android\s+\d+;\s*([^)]+)\)/i)?.[1]?.trim() ?? "";
      const _desktopMeta = _isMob ? null : buildDesktopUAMetadata(userAgent);
      await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: "en-US,en;q=0.9",
        platform: _isMob ? "Linux armv8l" : _desktopMeta!.navigatorPlatform,
        userAgentMetadata: {
          brands: [
            { brand: _buildInfo.grease,  version: _buildInfo.greaseVer },
            { brand: "Chromium",         version: _chromeMajor },
            { brand: "Google Chrome",    version: _chromeMajor },
          ],
          fullVersionList: [
            { brand: _buildInfo.grease,  version: _buildInfo.greaseVer + ".0.0.0" },
            { brand: "Chromium",         version: _buildInfo.full },
            { brand: "Google Chrome",    version: _buildInfo.full },
          ],
          fullVersion: _buildInfo.full,
          platform: _isMob ? "Android" : _desktopMeta!.platform,
          platformVersion: _isMob ? _androidVer : _desktopMeta!.platformVersion,
          architecture: _isMob ? "arm" : _desktopMeta!.architecture,
          model: _isMob ? _model : "",
          mobile: _isMob,
          bitness: _isMob ? "64" : _desktopMeta!.bitness,
          wow64: false,
        },
      });
    } catch {}
  }

  // Navigate to login page
  console.log(`[doAutoLogin:${profileId}] ${_ts()} navigating to login page`);
  try {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Login page load timeout")), 30000);
      wc.once("did-finish-load", () => { clearTimeout(t); resolve(); });
      wc.loadURL("https://www.instagram.com/accounts/login/").catch(reject);
    });
  } catch (e: any) {
    console.error(`[doAutoLogin:${profileId}] ${_ts()} login page load FAILED: ${(e as any)?.message}`);
    return { ok: false, message: `Failed to load login page: ${e?.message}` };
  }
  console.log(`[doAutoLogin:${profileId}] ${_ts()} login page loaded`);
  await delay(2000);

  // ── Dismiss cookie banner before filling credentials (poll up to 6 s) ─────
  // Instagram overlays a cookie consent modal on the login page in some regions.
  // The banner is React-rendered and may appear 1-3 s after did-finish-load, so
  // a single check after 1.5 s is not enough — poll until we find it or give up.
  {
    const _CK_ACCEPT = ['allow all cookies','accept all cookies','allow all','accept all',
      'allow essential and optional cookies','accept cookies','allow cookies',
      'alle cookies akzeptieren','accepter tout','aceptar todo','accetta tutto','tillåt alla','alle accepteren'];
    const ckDetectJs = `(() => {
      const A = ${JSON.stringify(_CK_ACCEPT)};
      function m(b) {
        if (!b || !b.getBoundingClientRect) return null;
        const r = b.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        const t = (b.innerText||b.textContent||'').trim().toLowerCase();
        if (A.indexOf(t) === -1) return null;
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      }
      let b = document.querySelector('[data-cookiebanner="accept_button"]')
           || document.querySelector('[data-testid="cookie-policy-banner-accept"]');
      if (b) { const p = m(b); if (p) return p; }
      const c = document.querySelector('[data-cookiebanner]') || document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');
      if (c) { for (const el of c.querySelectorAll('button,[role="button"]')) { const p = m(el); if (p) return p; } }
      for (const el of document.querySelectorAll('button,[role="button"]')) { const p = m(el); if (p) return p; }
      return null;
    })()`;
    let ckPos: { x: number; y: number } | null = null;
    for (let attempt = 0; attempt < 12; attempt++) {
      ckPos = await wc.executeJavaScript(ckDetectJs).catch(() => null) as { x: number; y: number } | null;
      if (ckPos) break;
      await delay(500);
    }
    if (ckPos) {
      console.log(`[doAutoLogin:${profileId}] ${_ts()} cookie banner at (${ckPos.x},${ckPos.y}), dismissing`);
      try {
        try { wc.debugger.attach("1.3"); } catch {}
        await cdpTapGesture(wc.debugger, ckPos.x, ckPos.y);
        await delay(2000);
      } catch {}
    } else {
      console.log(`[doAutoLogin:${profileId}] ${_ts()} no cookie banner found`);
    }
  }

  // ── TAB TAB — move focus into the username field ──────────────────────────
  // The cookie banner leaves focus on the "Accept" button or nowhere.  Two Tab
  // presses advance focus through the page in DOM order, landing on the username
  // input — same behaviour as clicking Login in the nav bar.
  await delay(300);
  try {
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(60);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(150);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(60);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(300);
  } catch {}

  // ── Ensure debugger is attached for all CDP calls below ──────────────────
  // The if (userAgent) block above may have already attached it; attach() is
  // a no-op if already connected, so this is always safe.
  try { wc.debugger.attach("1.3"); } catch {}

  // ── Fill credentials via CDP Input events (isTrusted = true) ─────────────
  // CRITICAL: Instagram checks event.isTrusted on every input/click event.
  // JS-dispatched events (new Event(), new KeyboardEvent(), btn.click()) always
  // produce isTrusted = false — Instagram recognises this as bot input and flags
  // the account. CDP Input.dispatchMouseEvent and Input.insertText produce
  // OS-level events with isTrusted = true, indistinguishable from a real user.

  // Step 1: find the field centre-points via JS (we only need coordinates)
  const fields = await wc.executeJavaScript(`
    (async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      let uInp, pInp, tries = 0;
      while (tries++ < 20) {
        uInp = document.querySelector('input[name="username"]');
        pInp = document.querySelector('input[name="password"]');
        if (uInp && pInp) break;
        await wait(500);
      }
      if (!uInp || !pInp) return null;
      const ur = uInp.getBoundingClientRect();
      const pr = pInp.getBoundingClientRect();
      return {
        u: { x: Math.round(ur.left + ur.width / 2), y: Math.round(ur.top + ur.height / 2) },
        p: { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) },
      };
    })()
  `).catch(() => null) as { u: { x: number; y: number }; p: { x: number; y: number } } | null;

  if (!fields) {
    console.error(`[doAutoLogin:${profileId}] ${_ts()} login form fields NOT FOUND — bailing`);
    return { ok: false, message: "Could not find login form on Instagram login page" };
  }
  console.log(`[doAutoLogin:${profileId}] ${_ts()} login form found, filling credentials`);

  // Step 2: tap username field (touch event) + type via CDP
  // WHY cdpTapGesture instead of dispatchMouseEvent:
  //   synthesizeTapGesture fires touchstart→touchend→click with pointerType="touch".
  //   dispatchMouseEvent fires mousedown+mouseup — events that never appear on a
  //   real Android phone. Instagram reads event.pointerType to detect mouse input.
  try {
    await cdpTapGesture(wc.debugger, fields.u.x, fields.u.y);
    await delay(120);
    // Belt-and-suspenders: JS .focus() guarantees keyboard focus is on the
    // username input before CDP key events are dispatched. synthesizeTapGesture
    // fires touchstart/touchend but focus transfer can be asynchronous on some
    // Chromium builds — without this, Ctrl+A / Delete / typeText events go to
    // whatever element previously held focus (e.g. the cookie-banner dismiss link).
    await wc.executeJavaScript(
      `(document.querySelector('input[name="username"]')||document.querySelector('input[autocomplete="username"]'))?.focus()`
    ).catch(() => {});
    await delay(80);
    // Select-all + delete any pre-filled content before typing
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await delay(100);
    await typeTextCDP(wc.debugger, username);

    // Press Tab to move keyboard focus from username → password field.
    // This is required: Instagram shows an async username-validation spinner /
    // suggestion list after the username is typed, which can shift the password
    // field's DOM position. Without Tab the tap gesture below can land on the
    // spinner or the end of the username field, causing the password to be typed
    // into the username input. Tab moves focus deterministically regardless of
    // any re-render.
    await delay(150);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });

    // Wait for Instagram's async username validation to settle before tapping the
    // password field. Instagram re-renders the form (shows a checking-username
    // spinner / suggestion list) which shifts the password field position. Using
    // the pre-computed stale coordinates causes the tap to land in the wrong spot —
    // usually at the end of the username field or on the spinner — instead of the
    // password input. Re-querying after 700 ms gets the fresh post-render position.
    await delay(700);
    const freshPwdPos = await wc.executeJavaScript(`
      (() => {
        const p = document.querySelector('input[name="password"]');
        if (!p) return null;
        const r = p.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `).catch(() => null) as { x: number; y: number } | null;
    const pwdCoords = freshPwdPos ?? fields.p;

    // Step 3: tap password field (touch event) + type via CDP
    await cdpTapGesture(wc.debugger, pwdCoords.x, pwdCoords.y);
    await delay(150);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await delay(100);
    await typeTextCDP(wc.debugger, password, { androidIme: true });
  } catch (cdpErr: any) {
    console.error(`[doAutoLogin:${profileId}] ${_ts()} CDP form fill FAILED: ${cdpErr?.message}`);
    return { ok: false, message: `CDP form fill error: ${cdpErr?.message}` };
  }
  console.log(`[doAutoLogin:${profileId}] ${_ts()} credentials filled, submitting via Tab Tab Enter`);

  // Step 4: submit the login form.
  // Primary path: JS .click() on the submit button — unaffected by focus position
  // or Tab-order ambiguity (e.g. the eye/password-toggle icon sits between the
  // password field and the Login button in the DOM tab order and can steal focus).
  // Fallback: Tab Tab Enter via CDP for when the button isn't found in time.
  await delay(300);
  const submitted = await wc.executeJavaScript(`
    (() => {
      const b = document.querySelector('button[type="submit"]')
        || Array.from(document.querySelectorAll('button')).find(b => {
            const t = (b.innerText || b.textContent || '').trim();
            const r = b.getBoundingClientRect();
            return /log[\\s-]*in|sign[\\s-]*in/i.test(t) && r.width > 80 && !b.disabled;
          });
      if (!b || b.disabled) return false;
      b.click();
      return true;
    })()
  `).catch(() => false);
  if (!submitted) {
    // Fallback: Tab Tab Enter — skip past the password-visibility eye icon (Tab 1)
    // and any intermediate focusable element (Tab 2) to land on the Login button.
    console.warn(`[doAutoLogin:${profileId}] ${_ts()} submit button not found via JS — falling back to Tab Tab Enter`);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(80);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await delay(120);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await delay(60);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  }
  console.log(`[doAutoLogin:${profileId}] ${_ts()} form submitted (via ${submitted ? 'JS click' : 'Tab Tab Enter'})`)

  // Wait up to 30s for navigation away from the bare login page.
  // The 2FA page URL is "accounts/login/two_factor?..." — it still contains
  // "accounts/login", so the predicate must explicitly accept it, otherwise
  // the code waits the full 30 s before detecting 2FA (looks like it does nothing).
  console.log(`[doAutoLogin:${profileId}] ${_ts()} waiting for post-submit navigation (30s timeout)`);
  const postLoginUrl = await waitForNav(
    wc,
    url =>
      url.includes("instagram.com") &&
      (!url.includes("accounts/login/") || url.includes("two_factor") || /#/.test(url)),
    30000,
  );
  console.log(`[doAutoLogin:${profileId}] ${_ts()} post-submit URL: ${postLoginUrl ?? "(timeout/unchanged)"}`);
  await delay(1000);

  // ── Handle 2FA if required ─────────────────────────────────────────────────
  // Instagram uses several different input attributes across app versions —
  // check all known selectors so TOTP detection is robust.
  // NOTE: the current Instagram web login flow uses a plain input with
  // placeholder="Code" and no name/type/autocomplete attributes — this MUST
  // be in the list or the 2FA page is not detected at all.
  const _2FA_SELECTORS = [
    'input[name="verificationCode"]',
    'input[name="verification_code"]',
    'input[name="totp_code"]',
    'input[name="security_code"]',
    'input[name="code"]',
    'input[autocomplete="one-time-code"]',
    'input[inputmode="numeric"][maxlength="6"]',
    'input[aria-label*="security" i]',
    'input[aria-label*="code" i]',
    'input[aria-label*="digit" i]',
    'input[type="tel"][maxlength="6"]',
    'input[placeholder*="code" i]',
  ].join(", ");

  const needs2FA: boolean = await wc.executeJavaScript(
    `!!(document.querySelector(${JSON.stringify(_2FA_SELECTORS)}))`
  ).catch(() => false);

  if (needs2FA) {
    if (!twoFAKey) {
      console.warn(`[doAutoLogin:${profileId}] ${_ts()} 2FA required but no 2FA key — bailing`);
      return { ok: false, message: "2FA required but no 2FA key configured for this account" };
    }
    const code = generateTotp(twoFAKey);
    console.log(`[doAutoLogin:${profileId}] ${_ts()} 2FA page detected, TOTP code generated, filling via CDP`);

    // Focus the code input via JS (reliable regardless of tap coordinates),
    // clear any pre-filled content, then type the 6-digit TOTP code.
    await wc.executeJavaScript(`
      (() => {
        const inp = document.querySelector(${JSON.stringify(_2FA_SELECTORS)});
        if (inp) { inp.focus(); inp.select(); }
      })()
    `).catch(() => {});
    await delay(150);
    // Ctrl+A + Delete to clear pre-filled content
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await delay(80);
    await typeTextCDP(wc.debugger, code, { minDelay: 40, maxDelay: 100 });
    console.log(`[doAutoLogin:${profileId}] ${_ts()} TOTP code typed, submitting 2FA form`);

    // Submit: JS click on the Continue / submit button — same approach as the
    // main login button. The 2FA page uses "Continue" text, not type="submit".
    await delay(300);
    const tf2Submitted = await wc.executeJavaScript(`
      (() => {
        const b = document.querySelector('button[type="submit"]')
          || Array.from(document.querySelectorAll('button')).find(b => {
              const t = (b.innerText || b.textContent || '').trim();
              const r = b.getBoundingClientRect();
              return /continue|confirm|verify|submit/i.test(t) && r.width > 60 && !b.disabled;
            });
        if (!b || b.disabled) return false;
        b.click();
        return true;
      })()
    `).catch(() => false);
    if (!tf2Submitted) {
      // Fallback: Tab Tab Tab Enter via CDP (3 tabs to skip past the
      // "Trust this device" checkbox and any other focusable element
      // before landing on the Continue button).
      console.warn(`[doAutoLogin:${profileId}] ${_ts()} 2FA submit button not found — falling back to Tab Tab Tab Enter`);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await delay(80);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await delay(80);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
      await delay(120);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await delay(60);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
    // Wait for navigation away from the 2FA/login URL to the home page.
    // The 2FA page sits at accounts/login/# — we wait until the URL moves
    // to something that is NOT a login/two_factor page at all.
    await waitForNav(
      wc,
      url => url.includes("instagram.com") && !url.includes("accounts/login"),
      20000,
    );
    await delay(1000);
  }

  const finalUrl = wc.getURL();
  console.log(`[doAutoLogin:${profileId}] ${_ts()} final URL: ${finalUrl.slice(0, 120)}`);

  // Check for challenge redirect
  if (finalUrl.includes("update_risky_contactpoint") || finalUrl.includes("/challenge/")) {
    console.warn(`[doAutoLogin:${profileId}] ${_ts()} CHALLENGE detected — ${finalUrl.slice(0, 120)}`);
    return { ok: false, message: `Instagram challenge detected: ${finalUrl}` };
  }
  if (finalUrl.includes("accounts/suspended")) {
    console.warn(`[doAutoLogin:${profileId}] ${_ts()} SUSPENDED page detected`);
    return { ok: false, message: `Instagram is asking this account to confirm it is human (URL: ${finalUrl.slice(0, 80)})` };
  }
  // accounts/disabled after an automated login is most often a bot-detection
  // security check, NOT a permanent ban — the account works fine when the user
  // logs in manually.  Return a "captcha" style message (no "disabled" keyword)
  // so the route classifies it as "captcha" and prompts the user to open the EB,
  // rather than permanently marking the account as account_disabled.
  if (finalUrl.includes("accounts/disabled")) {
    console.warn(`[doAutoLogin:${profileId}] ${_ts()} DISABLED/security-verification page detected`);
    return { ok: false, message: `Instagram showed a security verification page during automated login. Open the embedded browser for this account, log in manually, then click Verify again.` };
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
    console.error(`[doAutoLogin:${profileId}] ${_ts()} NO SESSION COOKIE after login — errText="${errText}"`);
    return { ok: false, message: errText || "Login failed — no session cookie after submission" };
  }

  await syncCookies(profileId, ses);
  console.log(`[doAutoLogin:${profileId}] ${_ts()} LOGIN SUCCESS — session cookie confirmed`);
  return { ok: true, message: "Login successful" };
}

// ── Open / close window ────────────────────────────────────────────────────────

export async function openEbWindow(opts: {
  profileId: number;
  username:  string;
  proxy?:    { host: string; port: number; user?: string; pass?: string; type?: string };
  userAgent?: string;
  apiUA?:     string;
  password?: string;
  twoFAKey?: string;
  ebFingerprint?: EbFingerprintLite | null;
  /** Ghost Browser only — URL to load directly instead of the login page. */
  initialUrl?: string;
  /**
   * When true the window opens as a small (430×700) phone-sized window pinned
   * to the bottom-right corner of the screen.  The window is fully visible so
   * Chromium does NOT throttle it (minimised windows get throttled — timers
   * fire out of sequence and form-fill breaks).  Using a corner window means
   * the user can see the login happening without it blocking their screen.
   */
  verifyMode?: boolean;
  /** When true, skip all proxy setup and use the machine's home broadband (direct connection). */
  useHomeIp?: boolean;
  /**
   * When true the window is created and fully driven (navigate/evaluate/CDP)
   * exactly like a normal EB, but is NEVER shown to the user — the
   * ready-to-show handler skips show()/maximize() entirely. Used by the
   * automation engine's browser-only Human Session (Disable API mode) so
   * follow/unfollow/scroll/like/DM actions can run in the background without
   * a visible window. The window still lives in ebMap under the account's
   * normal partition, so it shares cookies/session with the regular EB.
   */
  silentMode?: boolean;
  /**
   * Whether this account has "Disable API" enabled in settings.
   * When true (API disabled) the close handler parks the window off-screen so
   * the automation engine can keep using the live EB session in the background.
   * When false (API active) the close handler allows the window to actually
   * close — no background browser session is needed, so the user gets a normal
   * maximised window on next open instead of restoring an off-screen one.
   */
  disableApi?: boolean;
}): Promise<void> {
  const { profileId, username, proxy, userAgent, apiUA, password, twoFAKey, ebFingerprint, initialUrl, verifyMode, useHomeIp, silentMode, disableApi } = opts;
  const isGhostBrowser = profileId === -1;
  // Per-session random token baked into every __eq_* global injected into the Instagram page.
  // Using a random suffix prevents Instagram's JS from fingerprinting us by a fixed symbol name.
  const jsToken = Math.random().toString(36).slice(2, 8);
  _ebCrashLog(profileId, `STEP-1: openEbWindow entry — username=@${username} proxy=${proxy ? proxy.host + ":" + proxy.port : "none"}`);

  // Focus existing window if already open (or hidden via close→hide handler)
  const existing = ebMap.get(profileId);
  if (existing && !existing.win.isDestroyed()) {
    // Ghost browser (profileId=-1): always destroy and recreate with a fresh session.
    // Ghost is a disposable identity — each open must start clean with the current proxy.
    // win.destroy() bypasses the close→hide handler and actually destroys the window.
    if (profileId === -1) {
      try { existing.win.destroy(); } catch { /* already destroyed */ }
      ebMap.delete(profileId);
      tabsStateMap.delete(profileId);
      toolbarViewMap.delete(profileId);
      // Fall through to create a new window below.
    } else {
      // Regular account: always re-apply proxy on every re-show.
      // Checking only for proxy changes is insufficient — sessions can lose their
      // proxy config between app restarts, and the fix for Electron 33's PAC timing
      // bug (switching to mode:'fixed_servers') must be applied even when the proxy
      // host/port is unchanged but the config format changed in a new app version.
      const newProxyKey = proxy
        ? `${proxy.type || "http"}:${proxy.host}:${proxy.port}`
        : "direct";
      const oldProxyKey = existing.proxy
        ? `${existing.proxy.type || "http"}:${existing.proxy.host}:${existing.proxy.port}`
        : "direct";
      const proxyChanged = newProxyKey !== oldProxyKey;
      const existingSes = electronSession.fromPartition(existing.partition);
      if (proxy) {
        // Same double-set + DNS flush treatment as the fresh-window path.
        // A single setProxy call can be overwritten by the persistent session's
        // on-disk proxy config loading in the background.  Two calls with a 150ms
        // gap ensure the final value is always ours.
        try { await existingSes.clearHostResolverCache(); } catch {}
        await existingSes.setProxy(buildProxyConfig(proxy));
        await new Promise(r => setTimeout(r, 150));
        await existingSes.setProxy(buildProxyConfig(proxy));
      } else {
        await existingSes.setProxy({ mode: "direct" });
      }
      try { existingSes.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch {}
      // Clear stale DNS cache so new proxy resolves fresh
      try { await existingSes.clearHostResolverCache(); } catch {}
      if (proxyChanged) {
        console.log(`[ebManager:${profileId}] Proxy changed (${oldProxyKey} → ${newProxyKey}), updating session proxy`);
        // Update the stored proxy — the login handler reads from ebMap dynamically.
        ebMap.set(profileId, { ...existing, proxy });
        // Reload so the new proxy takes effect for the current page.
        existing.win.webContents.reload();
      }
      const _wasHidden = !existing.win.isVisible();
      if (existing.win.isMinimized()) existing.win.restore();
      // Restore the window to the visible taskbar in case it was moved off-screen
      // by the close-handler (which uses setPosition+setSkipTaskbar instead of
      // hide() so Chromium's compositor keeps running during automation).
      existing.win.setSkipTaskbar(false);
      if (!isGhostBrowser && !existing.win.isMaximized()) {
        // Use explicit workArea bounds so the window never covers the Windows taskbar.
        // This also moves it back on-screen if the close-handler had parked it off-screen.
        const _eb = existing.win.getBounds();
        const _disp = eScreen.getDisplayNearestPoint({ x: _eb.x, y: _eb.y });
        existing.win.setBounds(_disp.workArea);
      }
      if (!existing.win.isVisible()) existing.win.show();
      existing.win.focus();

      // Toolbar is a native BrowserView — it is always present; nothing to re-inject.
      // If the current page is a chrome error or about:blank, navigate back to Instagram
      const currentUrl: string = existing.win.webContents.getURL();

      // Seed the toolbar URL bar immediately — did-navigate only fires on new
      // navigations, so if the window was hidden while already at a page the URL
      // bar would stay blank until the next navigation event.
      {
        const _tv = toolbarViewMap.get(profileId);
        if (_tv && !_tv.webContents.isDestroyed()) {
          _tv.webContents.executeJavaScript(
            `window.updateUrl && window.updateUrl(${JSON.stringify(currentUrl || "")})`
          ).catch(() => {});
        }
      }

      if (!currentUrl || currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank") {
        const existingSes2 = electronSession.fromPartition(existing.partition);
        const existingSessionCks = await existingSes2.cookies.get({ name: "sessionid", domain: ".instagram.com" });
        existing.win.webContents.loadURL(
          existingSessionCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
        ).catch(() => {});
      } else if (_wasHidden) {
        // Window was hidden (not minimized) — the renderer may have been suspended
        // and can show a blank frame when re-shown.  Reload if the URL is a safe
        // Instagram page (not mid-challenge or 2FA) to guarantee the content paints.
        const isSafe = currentUrl.includes("instagram.com") &&
          !currentUrl.includes("challenge") &&
          !currentUrl.includes("two_factor") &&
          !currentUrl.includes("2fa");
        if (isSafe) {
          existing.win.webContents.reload();
        }
      }

      // ── eb-shield confirmation for reused windows ────────────────────────────
      // openEbWindow returns early here (window already exists), which means the
      // normal [eb-shield] block further below never fires.  Without this log,
      // there is zero proof of what proxy/WebRTC policy is actually active on
      // the reused session — exactly the blind spot that made @dearcake79eke's
      // ban undetectable from logs alone.  We emit the same structured format so
      // grep-based log analysis treats reused and fresh sessions identically.
      // Fields match the fresh-session [eb-shield] block for parser/grep parity.
      {
        const _reusedProxyLine = proxy
          ? `✓ ${proxy.type || "http"}://${proxy.host}:${proxy.port}${proxyChanged ? " (proxy updated)" : " (unchanged, re-applied)"}`
          : useHomeIp
          ? "DISABLED — OS resolver (no proxy in this session)"
          : "DISABLED";
        console.log(
          `[eb-shield:${profileId}] @${username} ── REUSED WINDOW — LEAK PROTECTION RECONFIRMED\n` +
          `  proxy       : ${_reusedProxyLine}\n` +
          `  webrtc      : ✓ disable_non_proxied_udp (re-applied to existing session)\n` +
          `  doh         : persists from initial window open (session-level config survives reuse)\n` +
          `  quic        : DISABLED (app-level --disable-quic flag)\n` +
          `  ipv6        : DISABLED (app-level --disable-ipv6 flag)\n` +
          `  dns-prefetch: DISABLED (app-level --dns-prefetch-disable flag)\n` +
          `  dns-cache   : FLUSHED (clearHostResolverCache)\n` +
          `  note        : existing window reused — openEbWindow did not run fresh`
        );
      }
      return;
    }
  }

  // Ghost browser (profileId=-1) always gets a completely fresh in-memory session
  // (no 'persist:' prefix → Chromium never writes cookies, IndexedDB, cache, or
  //  any other state to disk → zero leakage into the next Ghost session).
  // Regular account EBs keep 'persist:eb-{id}' so their session survives app restarts.
  const partition = profileId === -1
    ? `eb-ghost-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    : `persist:eb-${profileId}`;
  _ebCrashLog(profileId, `STEP-2: creating session partition="${partition}"`);
  const ses = electronSession.fromPartition(partition);
  _ebCrashLog(profileId, "STEP-3: session created");

  // Configure proxy.
  // HTTP proxies use fixed_servers + proxyRules with embedded credentials.
  // SOCKS5 proxies also use fixed_servers with socks5:// proxyRules.
  // When useHomeIp=true the account deliberately uses the machine's home
  // broadband — proxy is skipped and the session runs as DIRECT.
  if (proxy) {
    const cfg = buildProxyConfig(proxy);
    _ebCrashLog(profileId, `STEP-4: setting proxy type=${proxy.type||"http"} host=${proxy.host}:${proxy.port}`);
    await ses.setProxy(cfg);
    _ebCrashLog(profileId, "STEP-5: proxy set (first pass)");
  } else if (useHomeIp) {
    _ebCrashLog(profileId, `STEP-4: useHomeIp=true — running DIRECT (home broadband) for @${username}`);
    await ses.setProxy({ mode: "direct" });
    _ebCrashLog(profileId, "STEP-5: direct mode set");
  } else {
    _ebCrashLog(profileId, `STEP-4: BLOCKED — no proxy assigned for @${username} (profileId=${profileId})`);
    throw new Error(`[IP-LEAK BLOCKED] Embedded browser for @${username} has no proxy assigned. Assign a proxy to this account before opening the browser.`);
  }

  // ── WebRTC IP-leak prevention (session level) ────────────────────────────
  // Belt-and-suspenders on top of the app.commandLine.appendSwitch() flags set
  // in main.ts. The session-level API enforces the policy for THIS specific
  // Electron session partition independently of the global Chrome switch,
  // covering any edge case where the global flag is not yet active at session
  // creation time (e.g. sessions created before app.whenReady fires).
  // "disable_non_proxied_udp": WebRTC ICE only produces candidates that flow
  // through the configured proxy.  HTTP/SOCKS proxies don't forward UDP, so
  // in practice no ICE candidates are emitted and the real IP is never revealed.
  // Track whether each session-level API applied successfully so the log
  // below can report actual applied state rather than assumed state.
  let _webrtcApplied = false;
  try {
    ses.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
    _webrtcApplied = true;
  } catch { /* non-fatal — older Electron builds may not expose this API */ }

  // ── DNS-over-HTTPS DISABLED intentionally ─────────────────────────────────
  // DoH was previously enabled to route DNS through Cloudflare.  This was
  // counter-productive: Chromium connects to cloudflare-dns.com:443 using the
  // machine's REAL IP (not the proxy), so Cloudflare's DNS-leak-test endpoint
  // sees the real IP and reports it as a leak.  The PAC-script proxy already
  // handles DNS correctly — FindProxyForURL returns "PROXY host:port" so Chrome
  // sends the target hostname via CONNECT and the proxy does the DNS resolution.
  // The client's real IP is never used for DNS lookups in that code path.
  // Disabling DoH removes the Cloudflare leak while keeping DNS leak-proof.
  let _dohApplied = false;
  try {
    (ses as any).setDnsOverHttpsConfig?.({ enabled: false });
    _dohApplied = true;
  } catch { /* non-fatal */ }

  // Flush any stale DNS cache that could route requests around the proxy
  try { await ses.clearHostResolverCache(); } catch {}
  _ebCrashLog(profileId, "STEP-6: DNS cache cleared, registering webRequest hooks");

  // ── Leak-shield confirmation log ──────────────────────────────────────────
  // Printed every time a session opens so the console confirms what protection
  // is actually active for this account.  Cross-check against the Leak Check
  // page — they should always agree.  Lines marked ⚠ mean the API call failed
  // (non-fatal) and that layer of protection may not be enforced.
  {
    const proxyLine = proxy
      ? `${proxy.type || "http"}://${proxy.host}:${proxy.port}`
      : useHomeIp
      ? "DIRECT (home broadband)"
      : "⚠ NONE — session blocked before reaching here";
    // For direct/home-IP sessions DNS goes through the OS resolver — DoH
    // disabled is still correct but the reason differs from the proxy path.
    const dohNote = proxy
      ? "DISABLED — proxy handles DNS resolution"
      : useHomeIp
      ? "DISABLED — OS resolver (no proxy in this session)"
      : "DISABLED";
    const webrtcLine = _webrtcApplied
      ? "✓ disable_non_proxied_udp (session-level + app-level flag)"
      : "⚠ session-level API unavailable — app-level flag only";
    const dohLine = _dohApplied
      ? `✓ ${dohNote}`
      : `⚠ setDnsOverHttpsConfig unavailable — ${dohNote}`;
    console.log(
      `[eb-shield:${profileId}] @${username} ── LEAK PROTECTION ACTIVE\n` +
      `  proxy       : ${proxyLine}\n` +
      `  webrtc      : ${webrtcLine}\n` +
      `  doh         : ${dohLine}\n` +
      `  quic        : DISABLED (app-level --disable-quic flag)\n` +
      `  ipv6        : DISABLED (app-level --disable-ipv6 flag)\n` +
      `  dns-prefetch: DISABLED (app-level --dns-prefetch-disable flag)\n` +
      `  dns-cache   : FLUSHED (clearHostResolverCache)`
    );
  }

  // ── ig_nrcb pre-seed ───────────────────────────────────────────────────────
  // ig_nrcb (non-removable cookie backup) tells Instagram this device has
  // previously accepted cookies.  On a completely fresh session the cookie is
  // absent, which triggers Instagram's cookie-consent challenge flow:
  //   scraping_warning → consent/?flow=user_cookie_choice_v2 → scraping_warning (loop)
  // Setting it to "1" before the first navigation prevents the challenge from
  // firing entirely.  Only set when absent so we never overwrite a real value
  // that Instagram has already written (device fingerprint continuity).
  (async () => {
    try {
      const existing = await ses.cookies.get({ name: "ig_nrcb", domain: ".instagram.com" });
      if (existing.length === 0) {
        await ses.cookies.set({
          url:            "https://www.instagram.com",
          name:           "ig_nrcb",
          value:          "1",
          domain:         ".instagram.com",
          path:           "/",
          secure:         true,
          sameSite:       "lax",
          expirationDate: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        });
        console.log(`[ebManager:${profileId}] ig_nrcb pre-seeded for fresh session`);
      }
    } catch { /* non-fatal */ }
  })();

  // ── Scraping-warning intercept ─────────────────────────────────────────────
  // Intercept /accounts/scraping_warning/ BEFORE Chrome follows the redirect so
  // the loop never starts.  Extract the 'next' param (the cookie-consent URL),
  // strip __coig_challenge_redirected=1 (the flag that makes consent/ loop back),
  // and redirect Chrome directly to the consent page.
  ses.webRequest.onBeforeRequest(
    { urls: ["*://www.instagram.com/accounts/scraping_warning/*"] },
    (details, callback) => {
      // Only intercept main-frame and sub-frame navigations.
      // Instagram's challenge/suspended pages can load subresources (images,
      // XHR, scripts) whose URLs happen to fall under the scraping_warning/
      // path — including CAPTCHA images.  Redirecting those subresource
      // requests breaks them (e.g. the CAPTCHA image shows as broken).
      // Pass all non-navigation resource types through immediately.
      if (details.resourceType !== "mainFrame" && details.resourceType !== "subFrame") {
        callback({});
        return;
      }
      try {
        const u = new URL(details.url);
        const nextRaw = u.searchParams.get("next");
        if (nextRaw && nextRaw.includes("/consent/")) {
          // Cookie-consent loop: scraping_warning → consent/?flow=user_cookie_choice_v2 → scraping_warning.
          // Break the loop by jumping directly to the consent page.
          // Keep __coig_challenge_redirected intact — stripping it causes recurrence.
          console.warn(`[ebManager:${profileId}] scraping_warning (cookie-consent loop) — redirecting to consent page`);
          callback({ redirectURL: nextRaw });
        } else {
          // Not a cookie-consent loop (e.g. "Automated behaviour detected" challenge).
          // Let Chrome load the scraping_warning page normally so the user can see
          // and interact with the challenge (e.g. click the blue dismiss button).
          console.warn(`[ebManager:${profileId}] scraping_warning (interactive challenge) — letting Chrome load it`);
          callback({});
        }
      } catch {
        callback({ redirectURL: "https://www.instagram.com/accounts/login/" });
      }
    }
  );

  // ── CSP removal — lets CAPTCHA images and challenge page resources load ──────
  // Instagram's challenge/suspended pages (and some consent pages) send a
  // Content-Security-Policy header whose img-src directive restricts image
  // loading to a subset of CDN origins.  In Electron's Chromium context the
  // dynamically-loaded CAPTCHA image (fetched via JS after page load) can fail
  // this check and render as a broken image, making it impossible for the user
  // to solve the CAPTCHA and unblock their account.
  // Stripping CSP (and the legacy X-Frame-Options) from Instagram responses in
  // the EB session fixes this without relaxing any other security boundary —
  // the EB is a dedicated Instagram browser already holding the account session,
  // so the same-origin isolation that CSP normally enforces is not meaningful here.
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers: Record<string, string | string[]> = { ...details.responseHeaders };
    // Delete case-insensitively (Electron lowercases response header keys on
    // some builds but not all, so delete both casings to be safe).
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "content-security-policy" ||
          lower === "content-security-policy-report-only" ||
          lower === "x-frame-options") {
        delete headers[key];
      }
    }
    callback({ responseHeaders: headers });
  });

  // ── Accept-Language header alignment ───────────────────────────────────────
  // navigator.languages is overridden in JS to ["en-US","en"], but the actual
  // HTTP Accept-Language header Chrome sends is determined by the process locale,
  // not the JS override.  This webRequest hook keeps them consistent so
  // Instagram never sees a mismatch between the HTTP header and navigator.languages.
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders;
    headers["Accept-Language"] = "en-US,en;q=0.9";
    callback({ requestHeaders: headers });
  });

  // Double-set proxy: the first call overrides the in-memory setting.
  // A short yield lets any disk-load race from the persistent session
  // profile complete, then we override again so the final value is ours.
  if (proxy) {
    _ebCrashLog(profileId, "STEP-7: proxy double-set start");
    await ses.setProxy(buildProxyConfig(proxy));
    await new Promise(r => setTimeout(r, 150));
    await ses.setProxy(buildProxyConfig(proxy));
    _ebCrashLog(profileId, "STEP-8: proxy double-set done");
  }

  // ── EXIT-IP AUDIT (STEP-8b) ───────────────────────────────────────────────
  // The single most reliable way to confirm whether the proxy is actually
  // routing this EB session BEFORE Instagram sees any traffic.
  //
  // ses.fetch() is Electron-session-scoped → routes through the configured proxy.
  // _directHttpsGet() is a raw Node.js https.get() → bypasses all proxies → real machine IP.
  //
  // If both return the SAME IP → the proxy is NOT routing → Instagram sees the
  // server's real IP on every request → accounts get flagged immediately.
  //
  // Results are stored in _ebIpAudits (queryable via GET /eb/ip-audits)
  // AND logged to equinox-debug.log via _ipcLog so they appear immediately.
  _ebCrashLog(profileId, "STEP-8b: exit-IP audit start");
  {
    let _auditServerIp = "unknown";
    let _auditExitIp   = "unknown";
    let _auditLeaking  = false;

    // Real server IP — direct Node.js https, no proxy
    try {
      const _body = await _directHttpsGet("https://api4.ipify.org?format=json", 5000);
      if (_body) _auditServerIp = (JSON.parse(_body) as { ip?: string }).ip ?? "unknown";
    } catch { /* non-fatal */ }

    if (proxy) {
      // Session-scoped fetch — must go through the configured proxy
      try {
        const _sesRes = await Promise.race([
          ses.fetch("https://api4.ipify.org?format=json").then(r => r.json() as Promise<{ ip?: string }>),
          new Promise<{ ip?: string }>((_, rej) => setTimeout(() => rej(new Error("timeout")), 8000)),
        ]);
        _auditExitIp = _sesRes?.ip ?? "fetch-failed";
      } catch (e: any) {
        _auditExitIp = `FETCH-FAILED(${String(e?.message ?? "unknown").slice(0, 60)})`;
      }

      _auditLeaking = (
        _auditServerIp !== "unknown" &&
        !_auditExitIp.startsWith("FETCH-FAILED") &&
        _auditExitIp !== "unknown" &&
        _auditServerIp === _auditExitIp
      );
    }

    const _auditMsg =
      `[EB-IP-AUDIT:${profileId}] @${username}\n` +
      `  server-real-ip  : ${_auditServerIp}\n` +
      `  browser-exit-ip : ${_auditExitIp}\n` +
      `  proxy           : ${proxy ? `${proxy.type || "http"}://${proxy.host}:${proxy.port}` : "NONE"}\n` +
      `  LEAKING         : ${_auditLeaking
        ? "⚠ YES — browser is routing through server real IP — PROXY NOT WORKING"
        : proxy
        ? "✓ NO — exit IP differs from server IP — proxy routing correctly"
        : "⚠ NO PROXY CONFIGURED"}`;

    console.log(_auditMsg);
    _ebCrashLog(profileId, _auditLeaking
      ? `STEP-8b: ⚠ IP LEAK — exitIp=${_auditExitIp} === serverIp=${_auditServerIp}`
      : `STEP-8b: audit done — exitIp=${_auditExitIp} serverIp=${_auditServerIp} leak=false`);
    _ipcLog(_auditMsg); // → equinox-debug.log via pino

    if (_auditLeaking) {
      console.error(
        `[EB-IP-AUDIT:${profileId}] ⚠⚠⚠ PROXY NOT ROUTING — ` +
        `@${username} is exposing real server IP (${_auditServerIp}) to Instagram ⚠⚠⚠`
      );
    }

    // Store for /eb/ip-audits query
    _ebIpAudits.set(profileId, {
      profileId,
      username,
      serverIp:  _auditServerIp,
      exitIp:    _auditExitIp,
      proxy:     proxy ? `${proxy.type || "http"}://${proxy.host}:${proxy.port}` : null,
      proxyHost: proxy?.host ?? null,
      leaking:   _auditLeaking,
      checkedAt: new Date().toISOString(),
    });
  }
  _ebCrashLog(profileId, "STEP-8b: exit-IP audit done");

  // Seed existing cookies into the Electron session
  _ebCrashLog(profileId, "STEP-9: loading cookies from file");
  await loadCookiesFromFile(profileId, ses);
  _ebCrashLog(profileId, "STEP-10: cookies loaded");

  // Ghost browser and verify-mode windows open at phone portrait dimensions.
  // Regular account EB windows open full-screen maximized.
  //
  // IMPORTANT: compute the target position BEFORE calling new BrowserWindow().
  // Setting position only in ready-to-show causes the window to briefly appear
  // at the default center-of-screen position first, then jump — the flash is
  // visible to the user even though show:false is set.  Passing x/y directly
  // to the constructor locks the position from creation time.
  // ── Resolve browser UA and API UA — BEFORE BrowserWindow creation ─────────
  // Moved here (was after STEP-12) so we can compute the mobile device profile
  // BEFORE new BrowserWindow() and pass the correct dims to the constructor.
  // This eliminates Emulation.setDeviceMetricsOverride entirely — that CDP call
  // was crashing Chromium (SIGSEGV) in Electron 33 on Windows even when only
  // one window called it.  Creating the window at the correct physical dimensions
  // means Chromium's layout engine sees a real mobile-sized viewport from the
  // start, so @media queries evaluate correctly without any CDP override at all.
  const _isApiFormat = !!userAgent && isApiFormatUA(userAgent);
  const _apiParsed   = _isApiFormat ? apiUAToBrowserUA(userAgent!) : null;
  let _browserUA   = _isApiFormat ? _apiParsed!.browserUA : (userAgent ?? null);
  const _resolvedApiUA = _isApiFormat ? userAgent! : (apiUA ?? null);
  const _androidVer  = _apiParsed?.androidVersion ?? (
    _browserUA?.match(/Android\s+(\d+)/i)?.[1] ?? "14"
  );
  const _deviceModel = _apiParsed?.deviceModel ?? (
    _browserUA?.match(/Android\s+\d+;\s*([^)]+)\)/i)?.[1]?.trim() ?? ""
  );
  if (_isApiFormat) {
    console.log(`[ebManager:${profileId}] API-format UA converted → browserUA="${_browserUA}" apiUA="${userAgent}"`);
  }
  let _fpIsMobile = !!_browserUA && (_browserUA.includes("Mobile") || isApiFormatUA(_browserUA));
  const _fpChromeMajor = _browserUA?.match(/Chrome\/(\d+)/)?.[1] ?? CURRENT_CHROME_MAJOR;
  // ── DEVICE FINGERPRINT CONTINUITY: no forced desktop-UA override ──────────
  // REMOVED (6 Jul 2026, ban-fix): this block used to force EVERY regular
  // (non-ghost, non-verify) account EB window into a shared, generic Windows
  // desktop Chrome UA whenever the account's assigned identity was mobile —
  // regardless of what device the account was actually verified/assigned as.
  //
  // Root cause of the "USER AGENT MISMATCH" leak-test FAIL and the reported
  // bans: this override ran on every human-session / manually-opened EB
  // window (the majority of an account's live browsing time), while
  // `verifyInstagramCredentials()`, the mobile API client, and the Mode-B
  // silent windows (`armSilentWindowAntiDetection` for follow/post/search)
  // all continued to use the account's REAL assigned mobile identity
  // (e.g. Android 13, OnePlus CPH2449) for the exact same sessionid/cookies.
  // Instagram therefore saw ONE session token presented from two wildly
  // different devices (Windows desktop vs Android phone) — a strong
  // automated-abuse / session-hijack signal, independent of proxy/IP
  // correctness. This directly violates the DEVICE FINGERPRINT CONTINUITY
  // RULE in replit.md (an account's assigned identity must never be swapped
  // for an unrelated one on any code path).
  //
  // Emulation.setDeviceMetricsOverride is intentionally NOT used — it causes a
  // SIGSEGV crash in Electron 33 on Windows regardless of call serialisation.
  // Regular EB windows now always render at the account's real device
  // viewport (see `_mobileProfile` below), so Chromium's CSS engine sees a
  // real mobile viewport and Instagram renders its mobile web UI — which the
  // EB-driven Make a Post click flow (see make-a-post-log.md) already
  // handles via UI-variation-tolerant selectors, and which is also what the
  // Mode-B silent-post window (`/eb/silent-post`, fresh temp window) has
  // always used successfully.
  //
  // Do NOT reintroduce a desktop-UA override for regular windows. If a
  // desktop-only UI is ever required again, it must be scoped to a single
  // short-lived action (not the account's persistent identity) and must not
  // touch `_browserUA`/`_fpIsMobile` used for the account's real session.
  // ── Chrome version bump: keep existing accounts on a current Chrome ──────────
  // Real Android phones auto-update Chrome within days of a new stable release.
  // An account that was verified on Chrome 137 will genuinely be running 140+ by
  // now — Instagram sees no Chrome version continuity because it auto-updates.
  // We therefore bump the Chrome major in _browserUA to CURRENT_CHROME_MAJOR
  // whenever the stored UA is behind, before applying any CDP overrides, so the
  // entire session (UA, Client-Hints, GREASE, fingerprint script) uses the same
  // up-to-date version.  The updated UA is persisted to the DB via a lightweight
  // fire-and-forget call so Mode-B silent windows pick it up automatically too.
  //
  // Ghost browser (-1) and verifyMode windows are excluded: ghost generates a
  // fresh UA each time, and verifyMode must not change the UA mid-verify flow.
  if (!isGhostBrowser && !verifyMode && _browserUA) {
    const storedMajorN = parseInt(_fpChromeMajor, 10);
    const currentMajorN = parseInt(CURRENT_CHROME_MAJOR, 10);
    if (storedMajorN < currentMajorN) {
      const newBuildInfo = getChromeBuildInfo(CURRENT_CHROME_MAJOR);
      const newBrowserUA = rewriteChromeMajorInUA(_browserUA, newBuildInfo.full);
      console.log(`[ebManager:${profileId}] Chrome UA bump: ${_fpChromeMajor} → ${CURRENT_CHROME_MAJOR} (${_browserUA.slice(0,60)} → ${newBrowserUA.slice(0,60)})`);
      _browserUA = newBrowserUA;
      // Persist to DB so Mode-B silent windows and future sessions use the
      // bumped UA.  Fire-and-forget — don't block window creation.
      pushUABumpToServer(profileId, newBrowserUA);
    }
  }
  // Re-derive _fpChromeMajor from _browserUA after any bump above.
  const _fpChromeMajorFinal = _browserUA?.match(/Chrome\/(\d+)/)?.[1] ?? CURRENT_CHROME_MAJOR;
  const _fpBuildInfo   = getChromeBuildInfo(_fpChromeMajorFinal);
  // _fpScript is built AFTER timezone resolution below so the resolved timezone
  // can be baked into the Intl.DateTimeFormat override inside the injected script.
  // Declared here so it's in scope for the fire-and-forget injection block.
  let _resolvedTz: string | null = null;
  let _fpScript: string; // assigned after timezone fetch
  // Mobile viewport profile — only applied when the account's UA is actually mobile.
  // Desktop UA accounts (_fpIsMobile=false) open at the full 1280×820 window size
  // and Instagram serves its desktop layout naturally — no viewport override needed.
  const _mobileProfile = (!isGhostBrowser && !verifyMode && _fpIsMobile)
    ? getMobileDeviceProfile(_browserUA, _resolvedApiUA ?? null)
    : null;

  _ebCrashLog(profileId, "STEP-11: creating BrowserWindow");
  let _initX: number | undefined;
  let _initY: number | undefined;
  if (isGhostBrowser || verifyMode || silentMode) {
    const { width: sw, height: sh } = eScreen.getPrimaryDisplay().workAreaSize;
    const ww = 430;
    const wh = 700;
    if (isGhostBrowser) {
      _initX = Math.max(0, sw - ww - 8);
      _initY = Math.max(0, Math.floor((sh - wh) / 2));
    } else {
      // Verify-mode and silentMode: position COMPLETELY OFF-SCREEN to the right
      // so the user never sees the window or interacts with it accidentally.
      // DO NOT minimize — Chromium throttles minimized windows (timers fire
      // seconds late, form-fill breaks, the whole verify sequence hangs).
      // An off-screen-but-shown window renders normally without throttling.
      _initX = sw + 10;
      _initY = Math.max(0, Math.floor((sh - wh) / 2));
    }
  }
  const win = new BrowserWindow({
    width:           (isGhostBrowser || verifyMode) ? 430 : 1280,
    height:          (isGhostBrowser || verifyMode) ? 700 : 820,
    x:               _initX,
    y:               _initY,
    title:           `@${username} — Aura Farming Browser`,
    icon:            _iconPath || undefined,
    autoHideMenuBar: true,
    show:            false,
    // Verify-mode windows are positioned off-screen so they never appear in the
    // taskbar or alt-tab switcher — the user should not see or interact with them.
    skipTaskbar:     (verifyMode || silentMode) ? true : false,
    webPreferences: {
      nodeIntegration:         false,
      contextIsolation:        true,
      sandbox:                 true,    // CRITICAL: prevents Electron from injecting window.require /
      // window.process into the renderer main-world. contextIsolation alone is
      // insufficient in some Electron builds — window.require is still injected
      // as a non-configurable property that page-script suppressors cannot delete.
      // sandbox:true fully sandboxes the renderer; the preload still works because
      // it only uses contextBridge + ipcRenderer, both available in sandbox mode.
      backgroundThrottling:    false,   // CRITICAL: prevents Chromium from throttling timers,
      // animations, and rendering when the window is hidden or off-screen.
      // Without this flag, waitFor() always times out, DOM elements never appear,
      // and every browser action (follow, stories, reels) silently returns 0.
      partition,
      // NOTE: ebToolbarPreload.js is intentionally NOT loaded on the main window.
      // That preload runs contextBridge.exposeInMainWorld("__eq", ...) which would
      // place window.__eq on the Instagram page's main world — a detectable branded
      // global.  The toolbar BrowserView (created below) carries the preload instead;
      // it has its own isolated renderer context so __eq stays out of the page.
    },
  });
  win.once("ready-to-show", () => {
    if (win.isDestroyed()) return;
    if (silentMode) {
      // Show off-screen (positioned at sw+10 by _initX) so Chromium renders
      // normally without background throttling.  Keeping the window fully
      // hidden causes Chromium to throttle JS execution and defer all
      // rendering — Follow buttons never appear in the DOM, making every
      // background follow/unfollow/contact action fail silently.
      // showInactive() marks the window as "shown" to the OS without
      // stealing focus or appearing on screen (it is off-screen at sw+10).
      win.showInactive();
      return;
    }
    if (isGhostBrowser || verifyMode) {
      if (verifyMode) {
        // Appear without stealing focus — NEVER minimize, Chromium throttles
        // minimised windows (timers fire seconds late, form-fill breaks).
        win.showInactive();
      } else {
        win.show();
      }
    } else {
      // All regular account EBs — maximize so the OS title-bar maximize
      // button shows as inactive (window is already maximized).
      // win.maximize() both maximizes AND shows the window, but calling
      // show() first ensures the window is visible before maximize fires.
      win.show();
      win.maximize();
    }
  });

  _ebCrashLog(profileId, "STEP-12: BrowserWindow created, registering in ebMap");
  // Register in ebMap IMMEDIATELY — before any async CDP/proxy/cookie work.
  // ready-to-show (above) fires and makes the window visible while the async
  // setup below is still running.  If ebMap.set were placed after that async
  // work (as it historically was, ~280 lines later), /eb/state?profileId=X
  // would return { open:false } for several seconds while the window is
  // visibly on screen — causing the frontend status poll to incorrectly
  // conclude the browser isn't open.  Registering here ensures the VERY NEXT
  // poll (within 5 s) sees { open:true } and the UI reflects reality.
  ebMap.set(profileId, { win, username, proxy, partition, jsToken });
  _ebCrashLog(profileId, "STEP-13: ebMap early-registration done");

  // Belt-and-suspenders proxy re-apply after first page load.
  // In Electron 33, a persistent session ('persist:eb-N') may re-load its
  // on-disk proxy config AFTER setProxy() resolves above, overwriting the newly
  // set PAC script with stale settings from the profile directory.  Re-calling
  // setProxy() once the first page has finished loading guarantees that the
  // correct proxy is active for all subsequent navigations in this session,
  // even if the disk-load race fired in between.
  if (proxy) {
    // Re-apply on every navigation start (before any page requests fire),
    // on full load completion, and on every committed navigation.
    // Using `on` (not `once`) so the proxy is re-applied for EVERY page load,
    // not just the first.  This defeats the persistent-session disk-load race
    // regardless of which load it fires on.  setProxy is a near-no-op when the
    // config has not changed, so recurring calls add negligible overhead.
    win.webContents.on("did-start-loading", () => {
      ses.setProxy(buildProxyConfig(proxy)).catch(() => {});
      ses.clearHostResolverCache().catch(() => {});
    });
    win.webContents.on("did-finish-load", () => {
      ses.setProxy(buildProxyConfig(proxy)).catch(() => {});
    });
    win.webContents.on("did-navigate", (_evt: any, url: string) => {
      ses.setProxy(buildProxyConfig(proxy)).catch(() => {});
    });
  }

  // ── Universal: detect Instagram session-death redirects ──────────────────
  // When Instagram server-side revokes a session, the browser is redirected to
  // the login page.  Without this handler there is zero logging — the user
  // just sees the account needs re-login with no trace of what triggered it.
  //
  // Instagram routes revocations via:
  //   - Clean navigations:  instagram.com/accounts/login/
  //   - Locale-prefixed:    instagram.com/de/accounts/login/
  //   - Subdomain/www:      www.instagram.com/accounts/login
  //   - Mid-redirect chain: will-redirect / did-redirect-navigation fire
  //     before the final did-navigate (we must handle all three so no path slips through)
  let _lastKnownGoodUrl = ""; // track last non-login URL so we know what page was active before death
  const _detectSessionDeath = (_evt: any, url: string) => {
    if (/instagram\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/accounts\/login/i.test(url)) {
      console.warn(
        `[eb-session-dead:${profileId}] ` +
        `@${username} BROWSER LOGGED OUT ` +
        `— login redirect detected at ${new Date().toISOString()} ` +
        `— login URL="${url.slice(0, 200)}" ` +
        `— prior URL="${_lastKnownGoodUrl.slice(0, 200)}" ` +
        `— partition=persist:eb-${profileId} ` +
        `— server-side session revocation; account needs re-verify`
      );
    } else if (url.includes("instagram.com")) {
      _lastKnownGoodUrl = url;
    }
  };
  win.webContents.on("did-navigate", _detectSessionDeath);
  win.webContents.on("did-redirect-navigation", _detectSessionDeath);

  // ── Guard: bail if window was destroyed during async setup ───────────────
  // Early ebMap.set (above) lets the frontend see the EB as open immediately.
  // If the user closes the BrowserPanel during setup, the IPC handler calls
  // win.destroy() — subsequent win.addBrowserView / CDP calls on a destroyed
  // window crash the main process.  Check here (after all the awaits for proxy,
  // cookies, timezone, UA, device metrics) before any further window operations.
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-1: window destroyed — returning early"); return; }
  _ebCrashLog(profileId, "STEP-14: guard-1 passed, attaching debugger");

  // ── WebRTC TCP-candidate leak prevention (CDP page-script injection) ──────
  // Chromium's `disable_non_proxied_udp` WebRTC policy blocks UDP ICE candidates
  // but NOT TCP ICE candidates ("SPDY PUBLIC" type), which bypass the policy and
  // can expose the real IPv6 address.  CDP injects WEBRTC_BLOCKER_JS before any
  // page script, so it runs at document_start on every navigation.
  //
  // Page.enable() must be called before Page.addScriptToEvaluateOnNewDocument —
  // without it the command may be silently rejected in some Electron builds.
  //
  // ── Pre-navigation CDP: timezone override ───────────────────────────────────
  // debugger.attach is synchronous — do it here, before the fire-and-forget block,
  // so we can call Emulation.setTimezoneOverride synchronously (awaited) before
  // loadURL fires. If this were inside the fire-and-forget block it would LOSE the
  // race: the block yields at the first `await Page.enable`, control returns to the
  // main function, and loadURL starts — meaning the signup page loads with the real
  // Windows system timezone, then subsequent pages get the proxy timezone.
  // Instagram fingerprinting detects that inconsistency and can invalidate the
  // confirmation code server-side (the "The confirmation code is invalid or has
  // expired" error on signup).
  //
  // Only Page.enable and addScriptToEvaluateOnNewDocument remain fire-and-forget
  // because those CAN hang in the packaged build. A dom-ready fallback below
  // covers the rare case where they fire after the first navigation starts.
  try { win.webContents.debugger.attach("1.3"); } catch { /* already attached or unavailable */ }
  wireHeaderCapture(win.webContents, profileId);

  if (proxy) {
    // Resolve proxy timezone — awaited here (max 5 s) so it's ready before loadURL.
    // Uses a session-scoped cache keyed by proxy host so ip-api.com's 1,000 req/day
    // free limit is not hit when many accounts share the same proxy or when the same
    // account's EB is closed and reopened.  Without the cache, opening 50 accounts
    // exhausts the quota and every subsequent account falls back to the machine's
    // real system timezone — a cross-account linking signal.
    _ebCrashLog(profileId, `STEP-15: starting timezone fetch for ${proxy.host}`);
    if (_tzCache.has(proxy.host)) {
      _resolvedTz = _tzCache.get(proxy.host)!;
      _ebCrashLog(profileId, `STEP-15b: timezone cache hit tz=${_resolvedTz}`);
    } else {
      try {
        const _tzAc = new AbortController();
        const _tzTimer = setTimeout(() => _tzAc.abort(), 5000);
        // Use ses.fetch() (session-scoped) so the request routes through the
        // account's proxy — the machine's real IP is never sent to ip-api.com.
        const tzRes = await ses.fetch(
          `http://ip-api.com/json/${encodeURIComponent(proxy.host)}?fields=timezone`,
          { signal: _tzAc.signal },
        );
        clearTimeout(_tzTimer);
        const tzJson = await tzRes.json() as { timezone?: string };
        if (tzJson.timezone) {
          _resolvedTz = tzJson.timezone;
          _tzCache.set(proxy.host, _resolvedTz);
        }
      } catch { /* ip-api unreachable — skip override, use machine timezone */ }
    }
    _ebCrashLog(profileId, `STEP-16: timezone fetch done tz=${_resolvedTz ?? "none"}`);

    if (_resolvedTz) {
      // Apply timezone before first navigation. Race against a 2 s safety timer so
      // a slow CDP response doesn't block openEbWindow indefinitely.
      try {
        await Promise.race([
          win.webContents.debugger.sendCommand("Emulation.setTimezoneOverride",
            { timezoneId: _resolvedTz }),
          new Promise<void>(r => setTimeout(r, 2000)),
        ]);
      } catch {}
    }
    _ebCrashLog(profileId, "STEP-17: CDP timezone done");
  }
  // No proxy → skip setTimezoneOverride → Chrome uses the real system timezone.
  // No UTC default — a timezone mismatch between Intl and Date.now() is an
  // instant bot signal.

  // Build the fingerprint injection script NOW — after timezone resolution —
  // so the resolved timezone can be baked into the Intl.DateTimeFormat override.
  // The timezone is null for no-proxy accounts, leaving Intl behaviour unchanged.
  _fpScript = buildFingerprintScript(_fpIsMobile, _resolvedApiUA ?? null, ebFingerprint ?? null, _fpBuildInfo.full, _fpBuildInfo.grease, _fpBuildInfo.greaseVer, _resolvedTz, _browserUA);

  // ── Fire-and-forget: script injection (Page commands CAN hang in packaged build) ─
  // Page.enable and addScriptToEvaluateOnNewDocument are kept fire-and-forget
  // because they can hang in the packaged app on some Windows builds.
  // UA/device/locale overrides are NOT here — they are awaited below before loadURL.
  void (async () => {
    try {
      await win.webContents.debugger.sendCommand("Page.enable");
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: ELECTRON_LEAK_SUPPRESSOR_JS });
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: WEBRTC_BLOCKER_JS });
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: _fpScript });
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: DAILY_LIMIT_DISMISSER_JS });
    } catch (err) {
      console.warn(`[ebManager:${profileId}] Page/script injection (fire-and-forget) failed:`, err);
    }
  })();

  // ── UA + device metrics + locale — AWAITED before loadURL ─────────────────
  // MUST complete before the first navigation.  Instagram reads the User-Agent
  // and Sec-CH-UA-* client-hint headers on the very first request to decide
  // whether to serve the mobile login page or return a blank/blocked response.
  // If these CDP commands are fire-and-forget, there is a race window where the
  // first loadURL fires before they take effect → Instagram sees the raw Electron
  // desktop UA → serves <html><head></head><body></body></html> (blank screen).
  // Each command is wrapped in Promise.race with a 1500 ms timeout so a slow CDP
  // response never blocks openEbWindow indefinitely.
  //
  // Belt-and-suspenders: also call the Electron WebContents API directly so the
  // correct UA is set for HTTP request headers even if CDP is slow or degraded.
  // Electron's setUserAgent() is synchronous and takes effect on the VERY NEXT
  // request — no CDP dependency, no timeout risk.
  if (_browserUA) {
    win.webContents.setUserAgent(_browserUA);
    _ebCrashLog(profileId, `STEP-17b: Electron setUserAgent applied (${_browserUA.slice(0, 60)})`);
  }
  _ebCrashLog(profileId, `STEP-18: UA override — browserUA=${_browserUA ? _browserUA.slice(0,60) : "none"} mobile=${_fpIsMobile}`);
  if (_browserUA) {
    try {
      const _desktopMeta2 = _fpIsMobile ? null : buildDesktopUAMetadata(_browserUA);
      await Promise.race([
        win.webContents.debugger.sendCommand("Emulation.setUserAgentOverride", {
          userAgent: _browserUA,
          acceptLanguage: "en-US,en;q=0.9",
          platform: _fpIsMobile ? "Linux armv8l" : _desktopMeta2!.navigatorPlatform,
          userAgentMetadata: {
            brands: [
              { brand: _fpBuildInfo.grease,  version: _fpBuildInfo.greaseVer },
              { brand: "Chromium",            version: _fpChromeMajorFinal },
              { brand: "Google Chrome",       version: _fpChromeMajorFinal },
            ],
            fullVersionList: [
              { brand: _fpBuildInfo.grease,  version: _fpBuildInfo.greaseVer + ".0.0.0" },
              { brand: "Chromium",            version: _fpBuildInfo.full },
              { brand: "Google Chrome",       version: _fpBuildInfo.full },
            ],
            platform:        _fpIsMobile ? "Android" : _desktopMeta2!.platform,
            platformVersion: _fpIsMobile ? _androidVer : _desktopMeta2!.platformVersion,
            architecture:    _fpIsMobile ? "arm" : _desktopMeta2!.architecture,
            model:           _fpIsMobile ? _deviceModel : "",
            mobile:          _fpIsMobile,
            bitness:         _fpIsMobile ? "64" : _desktopMeta2!.bitness,
            wow64:           false,
          },
        }),
        new Promise<void>(r => setTimeout(r, 1500)),
      ]);
      _ebCrashLog(profileId, "STEP-19: UA CDP override applied");
    } catch (uaErr) {
      _ebCrashLog(profileId, `STEP-19: UA CDP override FAILED: ${(uaErr as any)?.message}`);
    }
  }

  // ── Guard between UA and device metrics ──────────────────────────────────
  // The UA and timezone CDP commands above each use Promise.race with a timeout.
  // If the timeout fires, the command is still floating in the CDP queue.
  // Calling sendCommand("Emulation.setDeviceMetricsOverride") while floating
  // Emulation.* commands are pending crashes Chromium (SIGSEGV in main process).
  // Also: if the window was destroyed during those 1.5–2 s async waits, accessing
  // win.webContents.debugger on a destroyed window is an immediate SIGSEGV.
  // 100 ms drain delay + isDestroyed check before every CDP block fixes both.
  await new Promise(r => setTimeout(r, 100));
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-1b: window destroyed after UA CDP — returning early"); return; }

  // ── Touch emulation (ghost/verify windows only) ───────────────────────────
  // setDeviceMetricsOverride is NOT used — it causes a SIGSEGV crash in
  // Electron 33 on Windows regardless of call serialisation.
  // Touch emulation only applies when the account's UA is actually mobile.
  // Accounts with disableApi=true are assigned desktop UAs (_fpIsMobile=false)
  // and never reach this block.  Ghost/verify windows may still use a mobile UA.
  if (_fpIsMobile && !win.isDestroyed()) {
    _ebCrashLog(profileId, `STEP-20: setTouchEmulationEnabled (mobile ghost/verify window)`);
    try {
      await Promise.race([
        win.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled:        true,
          maxTouchPoints: 10,
        }),
        new Promise<void>(r => setTimeout(r, 3000)),
      ]);
      _ebCrashLog(profileId, "STEP-20b: touch emulation enabled");
    } catch (teErr) {
      _ebCrashLog(profileId, `STEP-20b: touch emulation FAILED: ${(teErr as any)?.message}`);
    }
  }

  // ── Locale override — match navigator.languages ────────────────────────────
  // Intl APIs (DateTimeFormat, NumberFormat, Collator) use the real system
  // locale unless overridden at the CDP level.
  // Drain delay + guard before locale (same floating-command protection)
  await new Promise(r => setTimeout(r, 100));
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-1d: window destroyed before locale — returning early"); return; }
  _ebCrashLog(profileId, "STEP-22: setLocaleOverride");
  try {
    await Promise.race([
      win.webContents.debugger.sendCommand("Emulation.setLocaleOverride", { locale: "en-US" }),
      new Promise<void>(r => setTimeout(r, 3000)),
    ]);
  } catch {}
  _ebCrashLog(profileId, "STEP-23: locale done");

  // ── Guard: bail if window was destroyed during CDP setup ─────────────────
  // The CDP awaits above (timezone up to 7 s + UA 1.5 s + device 1.5 s +
  // touch 1.5 s + locale 1.5 s = up to ~14 s) run without holding any lock.
  // If the user closes the BrowserPanel or the IPC handler calls win.destroy()
  // during that window, calling win.webContents.setWindowOpenHandler / on / etc.
  // on a destroyed window crashes the main process.
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-2: window destroyed after CDP — returning early"); return; }
  _ebCrashLog(profileId, "STEP-24: guard-2 passed, registering window handlers");

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

  // On close, move off-screen instead of hiding — win.hide() fully suspends
  // Chromium's compositor at the OS level.  Beyond what backgroundThrottling
  // covers: a hidden window gets zero frames composed, IntersectionObserver
  // reports nothing intersecting (viewport is effectively 0×0), and Instagram's
  // React SPA never mounts <article>/story-tray/Follow DOM nodes because its
  // virtualised lists skip off-viewport content.  That is the root cause of
  // "No Follow button found" / "0 story tray items" on hidden windows.
  //
  // Jarvee/SuSocial never call hide() on automation windows; they position them
  // far off the visible screen so Windows treats them as fully visible:
  //   • Chromium compositor keeps running (frames are produced normally)
  //   • IntersectionObserver sees real viewport intersections
  //   • Instagram's SPA hydrates feed/story/profile DOM as usual
  //   • backgroundThrottling:false keeps timers firing at full rate
  //
  // setSkipTaskbar(true) removes the window from the taskbar / alt-tab so the
  // user cannot accidentally click it back into view while it is off-screen.
  win.on("close", (event) => {
    // When Disable API is active the automation engine keeps using this EB
    // session in the background (silent follows, DMs, human jitter, etc.).
    // Park the window off-screen instead of closing so Chromium's compositor
    // keeps running and the live session stays warm.
    //
    // When Disable API is NOT active the automation engine uses the mobile API
    // for all actions — no background browser session is needed.  Allow the
    // window to close normally so the next manual open creates a fresh,
    // maximised window instead of restoring a hidden off-screen one.
    if (!disableApi) return; // let the window close naturally
    event.preventDefault();
    try {
      const bounds = win.getBounds();
      const _disp  = eScreen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y });
      const sw = _disp.workAreaSize.width;
      const sh = _disp.workAreaSize.height;
      const offX = sw + 10;
      const offY = Math.max(0, Math.floor((sh - bounds.height) / 2));
      win.setPosition(offX, offY);
      win.setSkipTaskbar(true);
    } catch {
      // Fallback: if setPosition fails (e.g. window already destroyed), ignore.
    }
  });

  win.on("closed", () => {
    ebMap.delete(profileId);
  });

  // Handle proxy authentication.
  // event.preventDefault() MUST be called — without it Electron ignores the
  // callback and either shows a dialog or cancels the request, causing a silent
  // fall-through to the home IP.  Reading from ebMap (instead of closing over
  // the constructor `proxy` arg) ensures updated credentials are used if the
  // proxy is changed while the window is open.
  win.webContents.on("login", (event, _req, _authInfo, callback) => {
    event.preventDefault();
    const current = ebMap.get(profileId);
    callback(current?.proxy?.user ?? "", current?.proxy?.pass ?? "");
  });

  // Apply the resolved browser UA.
  // CDP Emulation.setUserAgentOverride (fire-and-forget above) is the authoritative
  // override for Client Hints; this call ensures navigator.userAgent is correct even
  // if CDP didn't complete before the first navigation (packaged-app race condition).
  // NEVER pass the raw API-format UA ("34/14; 420dpi; ...") — it's not a valid browser UA.
  if (_browserUA) {
    win.webContents.setUserAgent(_browserUA);
  }

  // Store in map (include jsToken so executeJavaScript callers can look up the right __eq_* names)
  ebMap.set(profileId, { win, username, proxy, partition, jsToken });

  // Belt-and-suspenders WebRTC block: if CDP injection didn't complete before
  // the first navigation (e.g. debugger attach failed silently in packaged app),
  // executeJavaScript at dom-ready overrides RTCPeerConnection in the main world.
  // dom-ready fires after HTML parsing but before window.onload / setTimeout
  // callbacks — earlier than any real-world leak-test gather loop.
  win.webContents.on("dom-ready", () => {
    if (win.isDestroyed()) return;
    win.webContents.executeJavaScript(WEBRTC_BLOCKER_JS).catch(() => {});
    win.webContents.executeJavaScript(_fpScript).catch(() => {});
    win.webContents.executeJavaScript(DAILY_LIMIT_DISMISSER_JS).catch(() => {});
    // Ghost browser: keep mobile viewport active on every navigation so
    // Instagram always serves the mobile UI, even during manual browsing.
    if (isGhostBrowser) {
      try {
        win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true,
        }).catch(() => {});
        win.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
          enabled: true, maxTouchPoints: 10,
        }).catch(() => {});
        // CRITICAL for drum picker: without hover:none + pointer:coarse, Chromium
        // reports (hover:hover) to CSS media queries even in mobile mode, and Instagram
        // serves a plain text input instead of the drum-picker date selector.
        win.webContents.debugger.sendCommand("Emulation.setEmulatedMedia", {
          features: [
            { name: "hover",       value: "none"   },
            { name: "any-hover",   value: "none"   },
            { name: "pointer",     value: "coarse" },
            { name: "any-pointer", value: "coarse" },
          ],
        }).catch(() => {});
      } catch { /* CDP not yet ready — ghost-signup will re-apply before navigation */ }
    }
  });

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

    // ── Scraping-warning overlay ───────────────────────────────────────────
    // Instagram sends an empty-body HTML shell for this page; the React app
    // that normally fills it in is often blocked by CSP or cookie state, so
    // the user sees a completely white screen with no feedback.
    // Inject a visible banner so the account situation is always clear.
    if (navUrl.includes("/accounts/scraping_warning")) {
      _ebLog(`⚠️ scraping_warning page detected for @${username} — injecting overlay`);
      // Wait 2 s for any async page JS to run first; if the page already has
      // content we skip the inject, otherwise show our overlay.
      await new Promise(r => setTimeout(r, 2000));
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(`
          (function() {
            if (document.body && document.body.children.length > 0) return; // page has content
            var _swId = '__eq${jsToken}_sw';
            if (document.getElementById(_swId)) return;
            var d = document.createElement('div');
            d.id = _swId;
            d.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px;text-align:center;box-sizing:border-box;';
            d.innerHTML = '<div style="font-size:40px;margin-bottom:12px">⚠️</div>'
              + '<div style="font-size:18px;font-weight:700;color:#111;margin-bottom:8px">Automated Behaviour Detected</div>'
              + '<div style="font-size:13px;color:#555;max-width:380px;line-height:1.5">Instagram has flagged this account. You may need to log in manually, solve any challenge shown, and then re-verify the account in Aura Farming once the session is restored.</div>'
              + '<div style="margin-top:18px;font-size:11px;color:#999">Account: ' + ${JSON.stringify(username)} + '</div>';
            (document.body || document.documentElement).appendChild(d);
          })()
        `).catch(() => {});
      }
    }

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
    // Consent page auto-accept: fires when the scraping_warning intercept
    // redirects Chrome to the cookie-consent page.  Click "Allow all cookies"
    // automatically so the session can proceed without manual intervention.
    if (navUrl.includes("instagram.com/consent/") && navUrl.includes("user_cookie_choice")) {
      console.log(`[ebManager:${profileId}] consent page loaded — auto-accepting cookies`);
      await new Promise(r => setTimeout(r, 1800));
      if (!win.isDestroyed()) {
        win.webContents.executeJavaScript(`
          (function() {
            var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
            var accept = btns.find(function(b) {
              var t = (b.textContent || b.getAttribute('aria-label') || '').toLowerCase().trim();
              return t.includes('allow') || t.includes('accept') || t.includes('akzept') ||
                     t.includes('accepter') || t.includes('izin') || t.includes('kabul') ||
                     t.includes('alle') || t.includes('tout');
            });
            if (accept) { accept.click(); return 'clicked:' + accept.textContent.trim().slice(0,30); }
            // Fallback: first non-decline button
            var fallback = btns.find(function(b) {
              var t = (b.textContent || '').toLowerCase().trim();
              return !t.includes('decline') && !t.includes('reject') && !t.includes('refuse') && t.length > 2;
            });
            if (fallback) { fallback.click(); return 'fallback:' + fallback.textContent.trim().slice(0,30); }
            return 'no-button-found';
          })()
        `).then((r: unknown) => {
          console.log(`[ebManager:${profileId}] consent auto-accept result: ${r}`);
        }).catch(() => {});
      }
      return;
    }
    if (!navUrl.includes("instagram.com")) return;
    await new Promise(r => setTimeout(r, 600));
    await syncCookies(profileId, ses);
  });

  // ── Native toolbar BrowserView ────────────────────────────────────────────
  // Floats above the Instagram window at the OS compositor level.  The toolbar
  // is completely independent of the page DOM — challenge pages, iframes, CSS
  // transforms, overflow:hidden, and z-index stacking can NEVER hide it.
  // Guard: if the window was destroyed during the async CDP/UA/loadURL work above,
  // do not try to addBrowserView — calling it on a destroyed window crashes the
  // main process (Electron bug: addBrowserView with destroyed parent → SIGSEGV).
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-3: window destroyed before BrowserView — returning early"); return; }
  _ebCrashLog(profileId, "STEP-25: creating BrowserView toolbar");

  const toolbarView = new BrowserView({
    webPreferences: {
      partition,                   // same session so cookies are visible if needed
      preload: path.join(__dirname, "ebToolbarPreload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox:          true,      // prevent window.require leak (see main EB window comment)
      backgroundThrottling: false, // keep toolbar clock/URL bar live when window is hidden
    },
  });
  _ebCrashLog(profileId, "STEP-26: BrowserView created, calling addBrowserView");
  win.addBrowserView(toolbarView);
  _ebCrashLog(profileId, "STEP-27: addBrowserView done");
  toolbarViewMap.set(profileId, toolbarView);

  // Initialise tab state for this profile.
  tabsStateMap.set(profileId, {
    tabs: [{ id: 0, url: "", title: `@${username}` }],
    activeId: 0,
    nextId: 1,
    views: new Map(),
  });
  // Push initial tab list to toolbar once its BrowserView has loaded.
  // Also seed the URL bar — did-navigate may have fired before the toolbar JS
  // was ready (data: URI loads fast but not instant), so without this the URL
  // bar stays blank until the next navigation event.
  toolbarView.webContents.once("did-finish-load", () => {
    pushTabUpdate(profileId);
    const currentPageUrl = win.isDestroyed() ? "" : win.webContents.getURL();
    if (currentPageUrl && currentPageUrl !== "about:blank") {
      toolbarView.webContents.executeJavaScript(
        `window.updateUrl && window.updateUrl(${JSON.stringify(currentPageUrl)})`
      ).catch(() => {});
    }
  });

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
  const toolbarHtml = buildNativeToolbarHtml(isGhostBrowser);
  toolbarView.webContents.loadURL(
    `data:text/html;base64,${Buffer.from(toolbarHtml).toString("base64")}`
  ).catch(() => {});

  // ── Page-level utilities ────────────────────────────────────────────────
  // Injected into the Instagram page (NOT the toolbar) on every navigation.
  // Tracks the last focused input field, auto-dismisses cookie banners, and
  // (when credentials are available) polls for the login form and fills it.
  const injectPageUtils = () => {
    // Do NOT pass autoFill here — JS-injected form events have isTrusted = false,
    // which Instagram detects as bot input. The did-navigate handler below fills
    // the form via CDP Input events (isTrusted = true) instead.
    win.webContents.executeJavaScript(buildPageUtilsJs(undefined, jsToken)).catch(() => {});
  };
  win.webContents.on("dom-ready",       () => injectPageUtils());
  win.webContents.on("did-finish-load", () => injectPageUtils());

  // ── Diagnostic relay helper ───────────────────────────────────────────────
  // ebManager runs in the Electron main process — its console.log does NOT
  // appear in the API server debug log file the user reads. This helper fires
  // a fire-and-forget POST to /api/profiles/:id/eb-diag so the message shows
  // up in the server log, AND also writes to console for Electron DevTools.
  const _ebLog = (msg: string) => {
    console.log(`[ebManager:${profileId}] ${msg}`);
    if (_serverPort) {
      fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-diag`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ message: msg }),
      }).catch(() => {});
    }
  };

  // ── Main-process cookie banner auto-dismiss (CDP approach) ────────────────
  //
  // WHY CDP and not sendInputEvent:
  //   sendInputEvent/humanMouseClick sends an InputEvent to the renderer but
  //   Instagram's React app sometimes ignores it for <a> links because the
  //   event routing in some Electron builds doesn't produce a trusted "click"
  //   synthetic event that React's SyntheticEventSystem picks up.
  //   CDP Input.dispatchMouseEvent is exactly what Puppeteer uses internally —
  //   it is the lowest-level mechanism short of a real OS cursor move and is
  //   guaranteed to produce isTrusted=true events that React handles.
  //
  // WHY on every did-finish-load and NOT just once on open:
  //   The old approach started a single 60-second timer at window-open time.
  //   If the page loaded after 60 s, or the user navigated to another page,
  //   the timer was already dead and the banner was never dismissed.
  //   The new approach fires on every did-finish-load and did-navigate, so
  //   every page that shows the banner gets it dismissed.
  //
  // SAFETY: the detect script matches only an exact whitelist of labels so
  //   it cannot accidentally click login forms, 2FA dialogs, or Save-Info
  //   prompts. Instagram's cookie banner is always one of these strings.

  const _COOKIE_ACCEPT_LABELS = [
    'allow all cookies', 'accept all cookies',
    'allow all', 'accept all',
    'allow essential and optional cookies',
    'accept cookies', 'allow cookies',
    'alle cookies akzeptieren',
    'accepter tout',
    'aceptar todo',
    'accetta tutto',
    'tillåt alla',
    'alle accepteren',
  ];

  // Returns { x, y, label } of the accept button, or null if not present.
  const _COOKIE_DETECT_JS = `(() => {
    const ACCEPT = ${JSON.stringify(_COOKIE_ACCEPT_LABELS)};
    function match(b) {
      if (!b || !b.getBoundingClientRect) return null;
      const r = b.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      const t = (b.innerText||b.textContent||'').trim().toLowerCase();
      if (ACCEPT.indexOf(t) === -1) return null;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: t };
    }
    // 1. Instagram's own data attribute (most specific)
    let pos = match(document.querySelector('[data-cookiebanner="accept_button"]')
                 || document.querySelector('[data-testid="cookie-policy-banner-accept"]'));
    // 2. Inside a known cookie container
    if (!pos) {
      const c = document.querySelector('[data-cookiebanner]')
             || document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');
      if (c) { for (const b of c.querySelectorAll('button,[role="button"],a')) { pos = match(b); if (pos) break; } }
    }
    // 3. Anywhere on the page (exact whitelist only — safe)
    if (!pos) { for (const b of document.querySelectorAll('button,[role="button"],a')) { pos = match(b); if (pos) break; } }
    return pos;
  })()`;

  // cdpClickCookieBanner: detects the banner and clicks via CDP.
  // Called after every page load. Retries up to 8 times with 1.5 s gaps.
  let _cookieDismissRunning = false;
  const cdpClickCookieBanner = async () => {
    if (win.isDestroyed() || _cookieDismissRunning) return;
    _cookieDismissRunning = true;
    try {
      // Attach debugger if not already attached (idempotent)
      try { win.webContents.debugger.attach("1.3"); } catch {}

      for (let attempt = 0; attempt < 8; attempt++) {
        if (win.isDestroyed()) break;
        await new Promise(r => setTimeout(r, attempt === 0 ? 2500 : 1500));
        if (win.isDestroyed()) break;

        const _ccUrl = win.webContents.getURL();

        // ── Login-page notice ────────────────────────────────────────────────
        // Log when the EB lands on the login page (usually means session died),
        // but do NOT break — the cookie consent banner appears on this page too
        // (on first visit or after cookie-jar reset) and must still be dismissed.
        // If no banner is found the existing `if (!pos) break` below exits cleanly.
        if (/instagram\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/accounts\/login/i.test(_ccUrl)) {
          _ebLog(`CookieCheck#${attempt + 1} url="${_ccUrl.slice(0, 120)}" — on login page (session may be expired; checking for cookie banner before exiting)`);
          console.warn(`[eb-session-dead:${profileId}] @${username} CookieCheck detected login page at attempt ${attempt + 1} — session may be dead`);
        }

        const pos = await win.webContents.executeJavaScript(_COOKIE_DETECT_JS).catch(() => null) as
          { x: number; y: number; label: string } | null;

        _ebLog(`CookieCheck#${attempt + 1} url="${_ccUrl.slice(0, 80)}" detect=${pos ? `FOUND label="${pos.label}" at (${pos.x},${pos.y})` : "no-banner"}`);

        if (!pos) break; // banner gone (or never appeared) — stop

        // Use cdpTapGesture (synthesizeTapGesture) for mobile accounts — fires
        // touchstart→touchend→click with pointerType="touch", isTrusted=true.
        // For desktop UAs this still works because the fallback inside cdpTapGesture
        // sends dispatchMouseEvent if synthesizeTapGesture fails.
        // Layer 1: synthesizeTapGesture (touch events, isTrusted=true)
        try {
          await cdpTapGesture(win.webContents.debugger, pos.x, pos.y);
          _ebLog(`CookieBanner: touch tap dispatched at (${pos.x},${pos.y}) label="${pos.label}"`);
        } catch (cdpErr) {
          _ebLog(`CookieBanner: touch tap failed (${cdpErr})`);
        }
        // Layer 2: dispatchMouseEvent with pointerType:"touch" — belt-and-suspenders for
        // DPR coordinate mismatch. synthesizeTapGesture can silently misfire when
        // setDeviceMetricsOverride DPR>1 is active: the command succeeds but the tap lands
        // at the physical pixel position instead of the CSS pixel position.
        // dispatchMouseEvent uses genuine CSS pixel coordinates and is unaffected by the DPR
        // quirk. pointerType:"touch" preserves the phone identity — no mouse signals leak.
        await new Promise(r => setTimeout(r, 100));
        try {
          const _dbg = win.webContents.debugger;
          await _dbg.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed",  x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
          await new Promise(r => setTimeout(r, 60));
          await _dbg.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
          _ebLog(`CookieBanner: touch-typed fallback dispatched at (${pos.x},${pos.y})`);
        } catch {}
        // Layer 3: direct JS click — no coordinates needed, immune to all DPR issues.
        // Cookie banners do not check event.isTrusted so this fires reliably.
        await new Promise(r => setTimeout(r, 80));
        try {
          await win.webContents.executeJavaScript(`(function(){
            var A=${JSON.stringify(_COOKIE_ACCEPT_LABELS)};
            var b=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]');
            if(!b){for(var e of document.querySelectorAll('button,[role="button"],a')){var t=(e.innerText||e.textContent||'').trim().toLowerCase();if(A.indexOf(t)!==-1){b=e;break;}}}
            if(b){b.click();return true;}return false;
          })()`).catch(() => {});
        } catch {}
        // Wait then check if it actually dismissed
        await new Promise(r => setTimeout(r, 1300));
        if (win.isDestroyed()) break;
        const stillThere = await win.webContents.executeJavaScript(_COOKIE_DETECT_JS).catch(() => null);
        if (!stillThere) {
          _ebLog(`CookieBanner dismissed after ${attempt + 1} attempt(s)`);
          // After banner dismissal: if we're on the Instagram splash page (not on
          // the login form yet), detect and click the "Log In" button via CDP so
          // the navigation to accounts/login/ fires — which then triggers the
          // did-navigate auto-fill handler.
          if (!win.isDestroyed()) {
            await new Promise(r => setTimeout(r, 800));
            const _currentUrl = win.webContents.getURL();
            // Ghost Browser (profileId=-1) drives its own navigation via the
            // ghost-signup automation. Never auto-tap "Log In" for it — that
            // would redirect the signup flow away from the email-signup page.
            const _isSplash = profileId !== -1
              && _currentUrl.includes("instagram.com")
              && !_currentUrl.includes("accounts/login")
              && !_currentUrl.includes("two_factor")
              && !_currentUrl.startsWith("chrome-error://");
            if (_isSplash) {
              const _loginBtnJs = `(() => {
                const LOGIN_RE = /^log\\s*in$/i;
                function p(el) {
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) return null;
                  return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
                }
                let el = document.querySelector('a[href*="accounts/login"], a[href*="/login/"]');
                if (el) { const pos = p(el); if (pos) return pos; }
                for (const e of document.querySelectorAll('a, button, [role="button"]')) {
                  const t = (e.innerText || e.textContent || '').trim();
                  if (LOGIN_RE.test(t)) { const pos = p(e); if (pos) return pos; }
                }
                return null;
              })()`;
              const _loginPos = await win.webContents.executeJavaScript(_loginBtnJs).catch(() => null) as { x: number; y: number } | null;
              if (_loginPos) {
                _ebLog(`CookieBanner post-dismiss: splash page — tapping Log In at (${_loginPos.x},${_loginPos.y})`);
                try {
                  await cdpTapGesture(win.webContents.debugger, _loginPos.x, _loginPos.y);
                } catch {}
              }
            }
          }
          break;
        }
      }
    } catch (err) {
      _ebLog(`CookieBanner error: ${err}`);
    } finally {
      _cookieDismissRunning = false;
    }
  };

  // Trigger on every page load — covers initial open AND all subsequent navigations.
  win.webContents.on("did-finish-load", () => { cdpClickCookieBanner().catch(() => {}); });

  // ── Periodic session-alive poll ───────────────────────────────────────────
  // The "Continue as…" / logged-out state is a React SPA overlay — the URL
  // NEVER changes to /accounts/login/ so did-navigate never fires and every
  // URL-based detection method is completely blind to it.  This interval polls
  // the DOM every 30 s regardless of what the browser is doing, and fires a
  // loud log the moment a login-wall indicator is detected.
  //
  // This catches logouts caused by ANYTHING: mobile API calls, EB navigation,
  // Instagram server-side session revocation, cookie corruption — all of it.
  let _sessionAliveLastAlert = 0; // debounce — only log once per death event
  const _sessionAliveJS = `(function() {
    var url = location.href;
    // Hard login page (URL-based)
    if (/accounts\\/login|accounts\\/onetap|accounts\\/suspended/.test(url)) {
      return { dead: true, reason: 'login-url', url: url, title: document.title };
    }
    // SPA overlay: "Continue as…" button or standard "Log in" button visible
    var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
    for (var i = 0; i < btns.length; i++) {
      var t = (btns[i].innerText || btns[i].textContent || '').trim();
      var tl = t.toLowerCase();
      if (tl === 'log in' || tl.startsWith('continue as')) {
        return { dead: true, reason: 'spa-overlay', trigger: t.slice(0,60), url: url, title: document.title };
      }
    }
    // Password input visible (login form rendered)
    var pwd = document.querySelector('input[type="password"]');
    if (pwd && pwd.offsetParent !== null) {
      return { dead: true, reason: 'password-input', url: url, title: document.title };
    }
    return { dead: false };
  })()`;

  const _sessionAlivePoll = setInterval(async () => {
    if (win.isDestroyed()) { clearInterval(_sessionAlivePoll); return; }
    try {
      const result: any = await win.webContents.executeJavaScript(_sessionAliveJS, true).catch(() => null);
      if (!result?.dead) return;
      const now = Date.now();
      if (now - _sessionAliveLastAlert < 60_000) return; // already logged this death
      _sessionAliveLastAlert = now;
      // Use _ipcLog so this critical event appears in the API server log file,
      // not just the Electron console (which the user cannot see during normal operation).
      _ipcLog(
        `[eb-session-dead:${profileId}] ` +
        `@${username} SESSION DEAD DETECTED BY POLL ` +
        `— reason="${result.reason}" ` +
        `— trigger="${result.trigger ?? ""}" ` +
        `— url="${(result.url ?? "").slice(0, 200)}" ` +
        `— title="${(result.title ?? "").slice(0, 80)}" ` +
        `— priorUrl="${_lastKnownGoodUrl.slice(0, 200)}" ` +
        `— detectedAt=${new Date(now).toISOString()} ` +
        `— partition=persist:eb-${profileId}`
      );
    } catch { /* non-fatal */ }
  }, 30_000);
  win.on("closed", () => clearInterval(_sessionAlivePoll));

  // ── Ghost browser: auto-dismiss Instagram login/signup overlay modals ─────
  // When the Ghost browser (profileId === -1) browses Instagram logged out,
  // Instagram shows "Sign up to see more" / "Log in to" / "Save your login
  // info?" modal overlays after a few seconds. This dismisses them automatically
  // via CDP Input.dispatchMouseEvent (isTrusted=true, same as the cookie banner).
  //
  // Not applied to regular account EBs — those are always logged in and won't
  // see signup walls. The cookie consent banner is handled separately above.
  //
  // NOTE: this is safe for regular Ghost browsing. During the warmup reel flow,
  // a separate dismissOverlay() is scoped to that handler and not called (per the
  // warmup comment) to avoid mid-reel redirects. This listener only fires on
  // did-finish-load (hard navigations), not on the SPA reel transitions.
  if (profileId === -1) {
    // Scroll to top on every hard navigation — the signup page sometimes loads
    // scrolled down into the middle of the form, which confuses users.
    win.webContents.on("did-finish-load", () => {
      win.webContents.executeJavaScript("window.scrollTo(0,0);").catch(() => {});
    });

    const _GHOST_OVERLAY_JS = `(function(){
      function rect(el){
        if(!el)return null;
        var r=el.getBoundingClientRect();
        if(r.width<=0||r.height<=0)return null;
        return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      }
      // 1. Standard aria-label Close selectors
      var sels=[
        '[role="dialog"] button[aria-label="Close"]',
        '[role="dialog"] button[aria-label="close"]',
        '[role="presentation"] button[aria-label="Close"]',
        '[role="presentation"] button[aria-label="close"]',
        'button[aria-label="Close"]',
        'div[role="button"][aria-label="Close"]',
      ];
      for(var i=0;i<sels.length;i++){var p=rect(document.querySelector(sels[i]));if(p)return p;}
      // 2. Detect signup/login/save-info dialogs by their text, then find the dismiss button
      var containers=Array.from(document.querySelectorAll('[role="dialog"],[role="presentation"]'));
      for(var c=0;c<containers.length;c++){
        var txt=(containers[c].innerText||containers[c].textContent||'').toLowerCase();
        var isOverlay=txt.includes('sign up')||txt.includes('never miss')||
                      txt.includes('see photos')||txt.includes('see videos')||
                      txt.includes('log in to')||txt.includes('save your login')||
                      txt.includes('turn on notifications');
        if(!isOverlay)continue;
        var btns=Array.from(containers[c].querySelectorAll('button,div[role="button"]'));
        // Prefer explicit dismiss labels
        for(var b=0;b<btns.length;b++){
          var btxt=(btns[b].innerText||btns[b].textContent||'').trim().toLowerCase();
          if(btxt==='not now'||btxt==='dismiss'||btxt==='close'||btxt===''||btxt==='×'||btxt==='✕'){
            var p2=rect(btns[b]);if(p2)return p2;
          }
        }
        // Fallback: any button that is only an SVG icon (the X close button)
        for(var b2=0;b2<btns.length;b2++){
          if(btns[b2].querySelector('svg')&&!(btns[b2].innerText||btns[b2].textContent||'').trim().match(/[a-z]/i)){
            var p3=rect(btns[b2]);if(p3)return p3;
          }
        }
      }
      return null;
    })()`;

    let _ghostOverlayRunning = false;
    const cdpDismissGhostOverlay = async () => {
      // Skip during warmup — warmup uses CSS-based hiding so no click occurs.
      if (win.isDestroyed() || _ghostOverlayRunning || ebMap.get(-1)?.warmupActive) return;
      _ghostOverlayRunning = true;
      try {
        try { win.webContents.debugger.attach("1.3"); } catch {}
        // Poll up to 6 times — the overlay often appears 2-5 s after page load
        for (let attempt = 0; attempt < 6; attempt++) {
          if (win.isDestroyed()) break;
          await new Promise(r => setTimeout(r, attempt === 0 ? 3000 : 2000));
          if (win.isDestroyed()) break;
          const pos = await win.webContents.executeJavaScript(_GHOST_OVERLAY_JS)
            .catch(() => null) as { x: number; y: number } | null;
          if (!pos) break; // no overlay present
          // Capture current URL so we can recover if dismissing causes a redirect
          const beforeUrl = win.isDestroyed() ? "" : win.webContents.getURL();
          _ebLog(`GhostOverlay#${attempt + 1}: overlay at (${pos.x},${pos.y}), touch tap (beforeUrl=${beforeUrl.slice(0, 80)})`);
          try {
            await cdpTapGesture(win.webContents.debugger, pos.x, pos.y);
          } catch (cdpErr) {
            _ebLog(`GhostOverlay: CDP failed (${cdpErr}), falling back to humanMouseClick`);
            win.webContents.focus();
            await humanMouseClick(win.webContents, pos.x, pos.y);
          }
          await new Promise(r => setTimeout(r, 1200));
          if (win.isDestroyed()) break;
          // Check if dismissing the overlay triggered an unwanted navigation
          const afterUrl = win.webContents.getURL();
          const redirected = beforeUrl && afterUrl !== beforeUrl && (
            afterUrl.includes("accounts/login") ||
            afterUrl.includes("accounts/emailsignup") ||
            afterUrl.includes("accounts/signup") ||
            afterUrl === "https://www.instagram.com/" ||
            afterUrl === "https://www.instagram.com"
          );
          if (redirected) {
            _ebLog(`GhostOverlay: dismiss caused redirect (→ ${afterUrl.slice(0, 80)}), recovering to previous page`);
            const recoverUrl = beforeUrl.includes("instagram.com") ? beforeUrl : "https://www.instagram.com/";
            win.webContents.loadURL(recoverUrl).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
            break; // overlay is gone (page changed), no need to re-poll
          }
          const stillThere = await win.webContents.executeJavaScript(_GHOST_OVERLAY_JS).catch(() => null);
          if (!stillThere) {
            _ebLog(`GhostOverlay: dismissed after ${attempt + 1} attempt(s)`);
            break;
          }
        }
      } catch (err) {
        _ebLog(`GhostOverlay error: ${err}`);
      } finally {
        _ghostOverlayRunning = false;
      }
    };

    // Fire on every hard navigation (did-finish-load) AND on a 7-second interval.
    // Instagram's signup/login overlay is injected via JS 3–8 s AFTER did-finish-load
    // fires — the interval catches it reliably without waiting for another navigation.
    win.webContents.on("did-finish-load", () => { cdpDismissGhostOverlay().catch(() => {}); });
    const _ghostOverlayInterval = setInterval(() => {
      if (win.isDestroyed()) { clearInterval(_ghostOverlayInterval); return; }
      if (!ebMap.get(-1)?.warmupActive) cdpDismissGhostOverlay().catch(() => {});
    }, 7000);
    win.on("closed", () => clearInterval(_ghostOverlayInterval));
  }

  win.webContents.on("did-fail-load", async (_e, code, desc, url) => {
    console.error(`[ebManager] did-fail-load for @${username}: code=${code} desc=${desc} url=${url}`);
    // Push the error to the server log AND to the address bar relay so it's visible
    if (url && url.includes("instagram.com")) {
      fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${profileId}/eb-fail`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ code, desc, url }),
      }).catch(() => {});
    }
    // ERR_TOO_MANY_REDIRECTS on scraping_warning — Instagram's anti-bot redirect loop
    // between /accounts/scraping_warning/ and /consent/?flow=user_cookie_choice_v2.
    // After successful 2FA the sessionid cookie already exists, so navigating directly
    // to instagram.com/ bypasses the broken redirect chain and lands on the home feed.
    if (code === -310 && url && url.includes("scraping_warning")) {
      try {
        const scrapingUrl = new URL(url);
        const nextRaw = scrapingUrl.searchParams.get("next") ?? "";
        if (nextRaw.includes("/consent/")) {
          // Cookie-consent loop: redirect to the consent page to break the cycle.
          console.warn(`[ebManager] scraping_warning (cookie-consent loop) for @${username} — navigating to consent`);
          await new Promise(r => setTimeout(r, 1500));
          if (!win.isDestroyed()) win.webContents.loadURL(nextRaw).catch(() => {});
        } else {
          // Interactive challenge (e.g. "Automated behaviour detected").
          // Navigate to the scraping_warning page itself so the user can see it.
          console.warn(`[ebManager] scraping_warning (interactive challenge) for @${username} — loading challenge page`);
          await new Promise(r => setTimeout(r, 1500));
          if (!win.isDestroyed()) win.webContents.loadURL(url).catch(() => {});
        }
      } catch {
        const recoveryCks = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
        await new Promise(r => setTimeout(r, 1500));
        if (!win.isDestroyed()) win.webContents.loadURL(
          recoveryCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
        ).catch(() => {});
      }
    }
  });

  // Prevent Instagram's page <title> from overriding the window title.
  // Without this, Electron replaces "@username — Equinox Browser" with "Instagram".
  win.webContents.on("page-title-updated", (e) => {
    e.preventDefault();
    win.setTitle(`@${username} — Aura Farming Browser`);
    const ts = tabsStateMap.get(profileId);
    if (ts && ts.tabs[0]) { ts.tabs[0].title = `@${username}`; pushTabUpdate(profileId); }
  });

  // Right-click context menu: cut / copy / paste / select-all + debug tools
  win.webContents.on("context-menu", (_e, params) => {
    const tpl: Electron.MenuItemConstructorOptions[] = [];
    if (params.editFlags.canCut)   tpl.push({ role: "cut" });
    if (params.editFlags.canCopy)  tpl.push({ role: "copy" });
    if (params.editFlags.canPaste) tpl.push({ role: "paste" });
    tpl.push({ type: "separator" }, { role: "selectAll" });
    tpl.push({ type: "separator" });
    tpl.push({
      label: "View Page Source",
      click: async () => {
        try {
          const html = await win.webContents.executeJavaScript("document.documentElement.outerHTML");
          const savePath = path.join(_cookiesDir, `source-${profileId}-${Date.now()}.txt`);
          fs.writeFileSync(savePath, String(html), "utf8");
          console.log(`[ebManager:${profileId}] Page source saved: ${savePath}`);
          shell.openPath(savePath).catch(() => {});
        } catch (err) {
          console.error(`[ebManager:${profileId}] View Source failed:`, err);
        }
      },
    });
    Menu.buildFromTemplate(tpl).popup({ window: win });
  });

  // SPA navigations (Instagram pushState) don't fire did-navigate/did-finish-load —
  // update the toolbar URL bar directly from the main process.
  win.webContents.on("did-navigate-in-page", (_e, navUrl) => {
    console.log(`[ebDiag:${profileId}] did-navigate-in-page url="${navUrl}"`);
    const tv = toolbarViewMap.get(profileId);
    if (tv && !tv.webContents.isDestroyed()) {
      tv.webContents.executeJavaScript(
        `window.updateUrl && window.updateUrl(${JSON.stringify(navUrl)})`
      ).catch(() => {});
    }
    const ts = tabsStateMap.get(profileId);
    if (ts && ts.tabs[0] && ts.activeId === 0) ts.tabs[0].url = navUrl;

    // ── Post-2FA blank-screen recovery (SPA pushState path) ───────────────
    // After 2FA verification Instagram's SPA does history.pushState to
    // accounts/login/# (a hash route the React app doesn't render), leaving a
    // blank page.  Wait 3 s then check: if a 2FA input is still visible the
    // user is still typing — leave it.  If blank, force-navigate to the feed.
    if (navUrl.includes("accounts/login/") && /#/.test(navUrl)) {
      console.warn(`[ebDiag:${profileId}] did-navigate-in-page hit accounts/login/# — scheduling 3s blank-screen check`);
      setTimeout(async () => {
        if (win.isDestroyed()) return;
        const cur = win.webContents.getURL();
        if (!cur.includes("accounts/login/")) {
          console.log(`[ebDiag:${profileId}] 3s check: already navigated away to "${cur}" — no recovery needed`);
          return;
        }
        let bodySnap = "{}";
        try {
          bodySnap = await win.webContents.executeJavaScript(
            `JSON.stringify({ bodyLen: document.body.innerHTML.trim().length, children: document.body.children.length, title: document.title })`
          );
        } catch {}
        const has2FA: boolean = await win.webContents.executeJavaScript(`
          !!(document.querySelector(
            'input[name="verificationCode"],input[name="verification_code"],' +
            'input[name="totp_code"],input[name="security_code"],' +
            'input[autocomplete="one-time-code"],input[inputmode="numeric"][maxlength="6"],' +
            'input[aria-label*="code" i],input[aria-label*="digit" i]'
          ))
        `).catch(() => false);
        if (has2FA) {
          console.log(`[ebDiag:${profileId}] 3s check: 2FA form visible — not interrupting. body=${bodySnap}`);
          return;
        }
        console.warn(`[ebDiag:${profileId}] 3s check: accounts/login/# with no 2FA form — recovering. body=${bodySnap}`);
        const sCks = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" }).catch(() => [] as Electron.Cookie[]);
        win.webContents.loadURL(
          sCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
        ).catch(() => {});
      }, 3000);
    }
  });

  // ── Comprehensive blank-screen diagnostics + general recovery ─────────────
  // Fires on EVERY full-page load (not SPA pushState — those go to did-navigate-in-page).
  // Logs URL + body state + session cookie presence on every load so we can pinpoint
  // which URL causes the blank screen even when it's not accounts/login/#.
  // Also performs general blank-screen recovery: if any Instagram page finishes
  // loading with an empty body and no 2FA form, navigates to feed or login.
  //
  // RATE-LIMITED: the recovery reloads with a 1500 ms delay and stops after 3
  // consecutive blank-page attempts.  Without the limit the handler fires on the
  // blank result of its own recovery loadURL → infinite reload loop.  The counter
  // resets whenever a page with actual content loads successfully.
  let _blankRecoveryCount = 0;
  win.webContents.on("did-finish-load", async () => {
    // Wrap entire body — async event handlers with no outer catch create
    // unhandled promise rejections that crash the Electron main process.
    try {
      if (win.isDestroyed()) return;
      const url = win.webContents.getURL();
      if (!url.startsWith("http")) return; // skip about:blank, devtools, data: etc.

      // ── Diagnostic snapshot ───────────────────────────────────────────────
      let snapshot = "{}";
      try {
        snapshot = await win.webContents.executeJavaScript(`
          JSON.stringify({
            childCount: document.body ? document.body.children.length : -1,
            bodyLen: document.body ? document.body.innerHTML.trim().length : -1,
            title: document.title.slice(0, 80),
            readyState: document.readyState,
          })
        `);
      } catch {}
      const diagSes = electronSession.fromPartition(`persist:eb-${profileId}`);
      const diagCks = await diagSes.cookies.get({ name: "sessionid", domain: ".instagram.com" }).catch(() => [] as Electron.Cookie[]);
      console.log(`[ebDiag:${profileId}] did-finish-load url="${url}" session=${diagCks.length > 0 ? "present" : "absent"} body=${snapshot}`);

      // ── General blank-screen recovery ─────────────────────────────────────
      if (!url.includes("instagram.com")) {
        _blankRecoveryCount = 0; // reset on non-Instagram pages
        return;
      }
      let snap: { childCount?: number; bodyLen?: number } = {};
      try { snap = JSON.parse(snapshot); } catch {}
      if ((snap.bodyLen ?? 9999) > 200) {
        _blankRecoveryCount = 0; // page rendered content — nothing to do, reset counter
        return;
      }

      // Don't interrupt 2FA entry
      const has2FA: boolean = await win.webContents.executeJavaScript(`
        !!(document.querySelector(
          'input[name="verificationCode"],input[name="verification_code"],' +
          'input[name="totp_code"],input[name="security_code"],' +
          'input[autocomplete="one-time-code"],input[inputmode="numeric"][maxlength="6"],' +
          'input[aria-label*="code" i],input[aria-label*="digit" i]'
        ))
      `).catch(() => false);
      if (has2FA) {
        console.log(`[ebDiag:${profileId}] blank body but 2FA form present — not recovering`);
        return;
      }

      _blankRecoveryCount++;
      if (_blankRecoveryCount > 3) {
        console.warn(`[ebDiag:${profileId}] blank-screen recovery reached retry limit (${_blankRecoveryCount}) — stopping to avoid reload loop. User can manually reload.`);
        return;
      }

      // Wait 1500 ms before reloading so the proxy has time to settle.
      // Without this delay the recovery reload fires into the same race condition
      // that caused the blank page, gets another blank, and loops.
      console.warn(`[ebDiag:${profileId}] BLANK BODY on "${url}" (bodyLen=${snap.bodyLen ?? "?"},children=${snap.childCount ?? "?"}) — attempt ${_blankRecoveryCount}/3, recovering in 1500 ms to ${diagCks.length > 0 ? "feed" : "login"}`);
      await new Promise(r => setTimeout(r, 1500));
      if (win.isDestroyed()) return;
      // Abort recovery if the user navigated away during the delay
      if (win.webContents.getURL() !== url) return;
      win.webContents.loadURL(
        diagCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
      ).catch(() => {});
    } catch (err) {
      console.warn(`[ebDiag:${profileId}] did-finish-load handler error (non-fatal):`, err);
    }
  });

  win.webContents.on("did-fail-load", (_e, errorCode, errorDesc, validatedUrl, isMainFrame) => {
    if (win.isDestroyed() || !isMainFrame) return;
    if (errorCode === -3) return; // ERR_ABORTED — user navigated away, expected
    console.warn(`[ebDiag:${profileId}] did-fail-load url="${validatedUrl}" code=${errorCode} desc="${errorDesc}"`);
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    if (win.isDestroyed()) return;
    console.error(`[ebDiag:${profileId}] render-process-gone reason="${details.reason}" exitCode=${details.exitCode}`);
  });

  win.webContents.on("unresponsive", () => {
    if (win.isDestroyed()) return;
    console.warn(`[ebDiag:${profileId}] page-unresponsive`);
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

  // Navigate to the initial URL.
  // Ghost browsers (profileId < 0, any slot): load the provided initialUrl directly —
  // never auto-navigate to Instagram, the warmup handles all navigation.
  // silentMode windows: skip the initial loadURL entirely. The automation caller
  // (ensureSilentEbOpen → goto()) will navigate as its very first action. Firing
  // loadURL here and then having goto() fire a second loadURL immediately after
  // creates a double-navigation race: during the abort/reload transition between
  // the two navigations, executeJavaScript resolves undefined (no JS context) →
  // waitFor() receives undefined (falsy, not an exception) for up to 20 s → timeout.
  // Regular account EBs: go to homepage if sessionid exists, otherwise login page.
  if (win.isDestroyed()) { _ebCrashLog(profileId, "GUARD-4: window destroyed before loadURL — returning early"); return; }
  _ebCrashLog(profileId, "STEP-28: guard-4 passed, calling loadURL");
  if (silentMode) {
    _ebCrashLog(profileId, "STEP-29: silentMode — skipping initial loadURL (automation goto() will navigate)");
  } else if (profileId < 0) {
    win.webContents.loadURL(initialUrl || "about:blank").catch(() => {});
    _ebCrashLog(profileId, `STEP-29: ghost loadURL called — ${initialUrl || "about:blank"}`);
  } else {
    const sessionCksForNav = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
    if (!win.isDestroyed()) {
      const navTarget = sessionCksForNav.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/";
      _ebCrashLog(profileId, `STEP-29: loadURL → ${navTarget} (sessionid=${sessionCksForNav.length > 0})`);
      win.webContents.loadURL(navTarget).catch(() => {});
      _ebCrashLog(profileId, "STEP-30: loadURL called OK — openEbWindow complete");
    } else {
      _ebCrashLog(profileId, "GUARD-5: window destroyed before final loadURL after cookies.get");
    }
  }

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
          // ── Phase 1: detect cookie banner (detect-only JS, no events) ────────
          // Returns button centre coordinates if banner is present, null otherwise.
          // The actual click uses sendInputEvent (isTrusted=true, required for React).
          const _afCkDetectJs = `(() => {
            const _CK_ACCEPT = ${JSON.stringify(_COOKIE_ACCEPT_LABELS)};
            function _isCkBtn(b) {
              if (!b || !b.getBoundingClientRect) return false;
              if (b.getBoundingClientRect().width <= 0) return false;
              const t = (b.innerText||b.textContent||'').trim().toLowerCase();
              return _CK_ACCEPT.indexOf(t) !== -1;
            }
            let b = document.querySelector('[data-cookiebanner="accept_button"]')
                 || document.querySelector('[data-testid="cookie-policy-banner-accept"]');
            if (!b) {
              const c = document.querySelector('[data-cookiebanner]') || document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');
              if (c) b = Array.from(c.querySelectorAll('button,[role="button"]')).find(_isCkBtn) || null;
            }
            if (!b) b = Array.from(document.querySelectorAll('button,[role="button"]')).find(_isCkBtn) || null;
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
          })()`;
          const ckPos = await win.webContents.executeJavaScript(_afCkDetectJs).catch(() => null) as
            { x: number; y: number } | null;

          if (ckPos) {
            console.log(`[ebManager] @${username} — auto-fill: cookie banner at (${ckPos.x},${ckPos.y}), human-click`);
            win.webContents.focus();
            await humanMouseClick(win.webContents, ckPos.x, ckPos.y);
            // Wait for the banner to dismiss and any resulting navigation to settle
            await new Promise(r => setTimeout(r, 3000));
            if (win.isDestroyed()) { _autoFillBusy = false; return; }
          }

          // ── Phase 2: fill login form via CDP (isTrusted = true) ──────────────
          // JS-injected events (new Event, btn.click) produce isTrusted = false —
          // Instagram detects these as bot input. CDP Input events are OS-level
          // and produce isTrusted = true, identical to a real user typing.
          try { win.webContents.debugger.attach("1.3"); } catch {}
          const _afFields = await win.webContents.executeJavaScript(`
            (async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              let uInp, pInp, tries = 0;
              while (tries++ < 20) {
                uInp = document.querySelector('input[name="username"]');
                pInp = document.querySelector('input[name="password"]');
                if (uInp && pInp) break;
                await wait(500);
              }
              if (!uInp || !pInp) return null;
              const ur = uInp.getBoundingClientRect();
              const pr = pInp.getBoundingClientRect();
              return {
                u: { x: Math.round(ur.left + ur.width / 2), y: Math.round(ur.top + ur.height / 2) },
                p: { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) },
              };
            })()
          `).catch(() => null) as { u: { x: number; y: number }; p: { x: number; y: number } } | null;

          if (_afFields) {
            try {
              const _d = win.webContents.debugger;
              const _ms = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
              await cdpTapGesture(_d, _afFields.u.x, _afFields.u.y);
              await _ms(150);
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
              await _ms(100);
              await typeTextCDP(_d, username);
              await cdpTapGesture(_d, _afFields.p.x, _afFields.p.y);
              await _ms(150);
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
              await _ms(100);
              await typeTextCDP(_d, password, { androidIme: true });
              for (let _bi = 0; _bi < 20; _bi++) {
                const _bp = await win.webContents.executeJavaScript(`
                  (() => {
                    const b = document.querySelector('button[type="submit"]')
                      || Array.from(document.querySelectorAll('button')).find(b => /log[\\s-]*in|sign[\\s-]*in/i.test((b.innerText||b.textContent||'').trim()))
                      || document.querySelector('form button:not([type="button"])');
                    if (!b || b.disabled) return null;
                    const r = b.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return null;
                    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                  })()
                `).catch(() => null) as { x: number; y: number } | null;
                if (_bp) {
                  await cdpTapGesture(_d, _bp.x, _bp.y);
                  break;
                }
                await _ms(250);
              }
            } catch (e: any) {
              console.warn(`[ebManager] @${username} CDP login fill failed:`, e?.message);
            }
          }

        } else if (on2FA && twoFAKey) {
          const code = generateTotp(twoFAKey);
          // 2FA fill via CDP (isTrusted = true)
          try { win.webContents.debugger.attach("1.3"); } catch {}
          const _af2Pos = await win.webContents.executeJavaScript(`
            (async () => {
              const wait = ms => new Promise(r => setTimeout(r, ms));
              let inp, tries = 0;
              while (tries++ < 20) {
                inp = document.querySelector(
                  'input[name="verificationCode"], input[aria-label*="security" i], ' +
                  'input[aria-label*="code" i], input[autocomplete="one-time-code"]'
                );
                if (inp) break;
                await wait(500);
              }
              if (!inp) return null;
              const r = inp.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return null;
              return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
            })()
          `).catch(() => null) as { x: number; y: number } | null;

          if (_af2Pos) {
            try {
              const _d = win.webContents.debugger;
              const _ms = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
              await cdpTapGesture(_d, _af2Pos.x, _af2Pos.y);
              await _ms(150);
              await typeTextCDP(_d, code, { minDelay: 40, maxDelay: 100 });
              for (let _bi = 0; _bi < 16; _bi++) {
                const _bp = await win.webContents.executeJavaScript(`
                  (() => {
                    const b = document.querySelector('button[type="submit"]');
                    if (!b || b.disabled) return null;
                    const r = b.getBoundingClientRect();
                    if (r.width <= 0 || r.height <= 0) return null;
                    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
                  })()
                `).catch(() => null) as { x: number; y: number } | null;
                if (_bp) {
                  await cdpTapGesture(_d, _bp.x, _bp.y);
                  break;
                }
                await _ms(250);
              }
            } catch (e: any) {
              console.warn(`[ebManager] @${username} CDP 2FA fill failed:`, e?.message);
            }
          }

        } else if (on2FA && !twoFAKey) {
          console.warn(`[ebManager] @${username} — 2FA page detected but no 2FA key stored`);
        }
      } finally {
        // Hold the lock for 90 s — prevents the auto-fill from firing again if Instagram
        // redirects back to the login page after a wrong password, which would otherwise
        // create a loop. The toolbar Login button still works for manual retries.
        await new Promise(r => setTimeout(r, 90000));
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

    // Helper: type text into the renderer's currently-focused input via CDP
    // (isTrusted = true — JS-injected events are isTrusted = false).
    // CDP Input.insertText routes to whatever element currently has focus,
    // so we first restore focus to __eq_lastInput via CDP mouse click, then insert.
    const typeIntoFocused = async (text: string) => {
      try { wc.debugger.attach("1.3"); } catch {}
      // Re-focus the last input the user was in (clicking the toolbar button
      // shifted browser focus to the toolbar BrowserView).
      const _fpt = ebMap.get(foundPid)?.jsToken ?? "";
      const focusPos = await wc.executeJavaScript(`(function(){
        var el=window['__eq${_fpt}_li']||null;
        if(!el||el.tagName==='BUTTON'||el===document.body)return null;
        var r=el.getBoundingClientRect();
        if(r.width<=0||r.height<=0)return null;
        return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
      })()`).catch(() => null) as { x: number; y: number } | null;
      if (focusPos) {
        try {
          await cdpTapGesture(wc.debugger, focusPos.x, focusPos.y);
          await new Promise<void>(r => setTimeout(r, 60));
          await typeTextCDP(wc.debugger, text);
        } catch {}
      }
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

      case "leak-check": {
        if (_serverPort) {
          const _lkEntry = ebMap.get(foundPid);
          const _lkProxy = _lkEntry?.proxy
            ? `&proxyHost=${encodeURIComponent(_lkEntry.proxy.host)}&proxyPort=${encodeURIComponent(_lkEntry.proxy.port)}`
            : "";
          // Pass the live browser UA so the Ghost (which has no DB record) can show it
          // in the UA Match panel. For regular accounts the server reads it from the DB,
          // but for Ghost (profileId=-1) there is no row so we must pass it explicitly.
          const _lkUA = _lkEntry?.win
            ? `&ebUA=${encodeURIComponent(_lkEntry.win.webContents.getUserAgent())}`
            : "";
          wc.loadURL(`http://127.0.0.1:${_serverPort}/api/browser/leaks?profileId=${foundPid}${_lkProxy}${_lkUA}`).catch(() => {});
        }
        break;
      }

      case "login": {
        // Fill username + password into the visible Instagram login form via CDP
        // (isTrusted = true). All JS-injected events (new Event, btn.click()) produce
        // isTrusted = false — Instagram detects this as bot input. CDP Input events
        // are OS-level and are indistinguishable from a real user typing.
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const _lgUsr: string = p.username ?? "";
          const _lgPwd: string = p.password ?? "";
          try { wc.debugger.attach("1.3"); } catch {}

          // ── Login macro (new layout) ───────────────────────────────────────────
          // Sequence:
          //   paste username → Tab → paste password → Tab → Tab → Enter
          //   wait 10 s
          //   generate TOTP ("Generate Code" from account settings 2FA section)
          //   paste code into browser → Tab × 4 → Enter
          //
          // "Paste" here means Input.insertText (CDP), which delivers text as a
          // single insert event — identical to a real clipboard paste in the browser.

          const _cdpFillLogin = async (targetWc: typeof wc) => {
            const _ms = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
            const _d = targetWc.debugger;

            // Cookie banner: detect position via JS (read-only), click via CDP
            const _ckDetect = `(() => {
              function _ckOk(b){if(!b||!b.getBoundingClientRect)return false;if(b.getBoundingClientRect().width<=0)return false;var t=(b.innerText||b.textContent||'').trim().toLowerCase();return t.includes('cookie')&&!/decline|reject|refuse|necessary only|essential only/.test(t);}
              let b=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]');
              if(!b){const c=document.querySelector('[data-cookiebanner]')||document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');if(c)b=Array.from(c.querySelectorAll('button,[role="button"]')).find(_ckOk)||null;}
              if(!b)b=Array.from(document.querySelectorAll('button,[role="button"]')).find(_ckOk)||null;
              if(!b)return null;
              const r=b.getBoundingClientRect();
              if(r.width<=0||r.height<=0)return null;
              return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
            })()`;
            for (let _ck = 0; _ck < 10; _ck++) {
              const _ckPos = await targetWc.executeJavaScript(_ckDetect).catch(() => null) as { x: number; y: number } | null;
              if (_ckPos) {
                await cdpTapGesture(_d, _ckPos.x, _ckPos.y);
                await _ms(2000);
                break;
              }
              await _ms(500);
            }

            // Wait for username + password fields to appear
            const _flds = await targetWc.executeJavaScript(`
              (async () => {
                const wait = ms => new Promise(r => setTimeout(r, ms));
                let uInp, pInp, t = 0;
                while (t++ < 20) {
                  uInp = document.querySelector('input[name="username"]') || document.querySelector('input[autocomplete="username"]');
                  pInp = document.querySelector('input[type="password"]') || document.querySelector('input[autocomplete="current-password"]') || document.querySelector('input[name="password"]');
                  if (uInp && pInp) break;
                  await wait(300);
                }
                if (!uInp || !pInp) return 'navigate';
                const ur = uInp.getBoundingClientRect();
                const pr = pInp.getBoundingClientRect();
                return {
                  u: { x: Math.round(ur.left + ur.width / 2), y: Math.round(ur.top + ur.height / 2) },
                  p: { x: Math.round(pr.left + pr.width / 2), y: Math.round(pr.top + pr.height / 2) },
                };
              })()
            `).catch(() => 'navigate') as { u: { x: number; y: number }; p: { x: number; y: number } } | 'navigate';

            if (_flds === 'navigate') return 'navigate';

            // ── Step 1: paste username ──────────────────────────────────────────
            // Tap + JS-focus the username field (belt-and-suspenders: touch events
            // are async on some Chromium builds; .focus() is synchronous).
            await cdpTapGesture(_d, _flds.u.x, _flds.u.y);
            await _ms(120);
            await targetWc.executeJavaScript(
              `(document.querySelector('input[name="username"]')||document.querySelector('input[autocomplete="username"]'))?.focus()`
            ).catch(() => {});
            await _ms(150);
            // Clear any existing value, then paste
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _ms(80);
            await _d.sendCommand("Input.insertText", { text: _lgUsr });
            await _ms(300);

            // ── Step 2: Tab × 2 (username → password) ───────────────────────────
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(150);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(200);

            // ── Step 3: paste password ──────────────────────────────────────────
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _ms(80);
            await _d.sendCommand("Input.insertText", { text: _lgPwd });
            await _ms(300);

            // ── Steps 4-6: Tab → Tab → Enter (submit login form) ───────────────
            // Tab 1: blur/validate the password field (enables the Log in button).
            // Tab 2: skip past any interstitial focusable (eye icon / "Save info?").
            // Enter: submit.
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(150);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(300 + Math.floor(Math.random() * 200));
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });

            return 'ok';
          };

          // Bring the EB window to front — clicking the toolbar button shifts OS focus
          // to the toolbar BrowserView, which causes CDP tap events on the Instagram
          // page to silently fail.  Focus the window first so the page's webContents
          // receives the CDP input events correctly.
          foundWin.focus();
          await new Promise<void>(r => setTimeout(r, 120));
          const _inline = await _cdpFillLogin(wc).catch(() => 'navigate');
          if (_inline === 'navigate') {
            // Not on the login page — navigate there and fill after load
            const _fillAfterLoad = async () => {
              if (wc.isDestroyed()) return;
              await new Promise<void>(res => setTimeout(res, 1500));
              if (wc.isDestroyed()) return;
              try { wc.debugger.attach("1.3"); } catch {}
              await _cdpFillLogin(wc).catch(() => {});
            };
            wc.once('did-finish-load', _fillAfterLoad);
            wc.loadURL('https://www.instagram.com/accounts/login/').catch(() => {
              wc.removeListener('did-finish-load', _fillAfterLoad);
            });
            break; // navigate path: 2FA not run (inline fill didn't execute)
          }

          // ── Steps 7-13: 2FA (only runs when inline fill succeeded) ─────────
          // Step 7: wait 10 s for Instagram to navigate to the 2FA page
          await new Promise<void>(r => setTimeout(r, 10000));

          // Step 8: "account settings → Generate Code" — generate the TOTP code
          // from the profile's stored 2FA secret (equivalent of clicking the
          // "Generate Code" button in the Equinox account settings 2FA section).
          const _2faKey = (p.twoFASecretKey ?? "").trim();
          if (_2faKey) {
            try { wc.debugger.attach("1.3"); } catch {}
            const _2faCode = generateTotp(_2faKey);
            const _ms2 = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
            const _d2 = wc.debugger;

            // Step 9: find the OTP input field (same selector set as the 2FA toolbar button)
            const _OTP_SELS = [
              'input[autocomplete="one-time-code"]',
              'input[name="verificationCode"]',
              'input[name="verification_code"]',
              'input[name="security_code"]',
              'input[name="totp_code"]',
              'input[name="code"]',
              'input[inputmode="numeric"]',
              'input[inputmode="numeric"][maxlength="6"]',
              'input[maxlength="6"]',
              'input[aria-label*="security" i]',
              'input[aria-label*="code" i]',
              'input[aria-label*="verif" i]',
              'input[aria-label*="authenticat" i]',
              'input[type="tel"][maxlength="6"]',
              'input[data-testid*="verification" i]',
              'input[data-testid*="code" i]',
            ].join(",");
            let _otpPos: { x: number; y: number } | null = null;
            for (let _ti = 0; _ti < 10 && !_otpPos; _ti++) {
              _otpPos = await wc.executeJavaScript(`(function(){
                var el=document.querySelector(${JSON.stringify(_OTP_SELS)})||null;
                if(!el){
                  var all=Array.from(document.querySelectorAll('input'));
                  var visible=all.filter(function(i){
                    if(i.type==='password'||i.type==='email'||i.name==='username'||i.name==='password')return false;
                    var r=i.getBoundingClientRect();return r.width>0&&r.height>0;
                  });
                  if(visible.length===1){el=visible[0];}
                  else{el=visible.find(function(i){return i.type==='tel'||i.inputMode==='numeric'||/code|verif|otp|totp/i.test(i.name+' '+i.id+' '+i.placeholder);});}
                  var _li=window['__eq${ebMap.get(foundPid)?.jsToken ?? ""}_li'];if(!el&&_li&&_li.tagName==='INPUT')el=_li;
                }
                if(!el||el.tagName!=='INPUT')return null;
                var r=el.getBoundingClientRect();
                if(r.width<=0||r.height<=0)return null;
                return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
              })()`).catch(() => null) as { x: number; y: number } | null;
              if (!_otpPos) await _ms2(500);
            }

            if (_otpPos) {
              // Tap to focus the OTP field
              await cdpTapGesture(_d2, _otpPos.x, _otpPos.y);
              await _ms2(120);
            }

            // Step 9b: Tab × 2 before pasting the code (matches the 2FA toolbar macro)
            for (let _ti = 0; _ti < 2; _ti++) {
              await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms2(60);
              await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms2(120);
            }

            // Step 10: paste the generated code into the browser
            await _d2.sendCommand("Input.insertText", { text: _2faCode });
            await _ms2(300);

            // Steps 11-13: Tab × 3 → Enter (submit 2FA form)
            for (let _ti = 0; _ti < 3; _ti++) {
              await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms2(60);
              await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms2(120);
            }
            await _ms2(200);
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await _ms2(60);
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
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
        // Use ebPartition() — not the hardcoded format — so Ghost browser tabs
        // (pid=-1) correctly inherit the Ghost session (and its proxy) instead of
        // falling into a fresh 'persist:eb--1' session with no proxy configured.
        const partition = ebPartition(foundPid);
        const tabView = new BrowserView({
          webPreferences: {
            partition,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,           // prevent window.require leak (see main EB window comment)
            // CRITICAL: without this, Chromium throttles timers/rAF/lazy-loading
            // for this BrowserView whenever the parent EB window is hidden,
            // minimized, or occluded on Windows — Instagram's virtualized feed,
            // story tray, and follow button never finish rendering, so every
            // DOM check silently returns undefined/empty. See EB Multi-Tab IPC
            // Fix Log in replit.md.
            backgroundThrottling: false,
          },
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
        tabView.webContents.on("dom-ready",       () => tabView.webContents.executeJavaScript(buildPageUtilsJs(undefined, ebMap.get(foundPid)?.jsToken ?? "")).catch(() => {}));
        tabView.webContents.on("did-finish-load", () => tabView.webContents.executeJavaScript(buildPageUtilsJs(undefined, ebMap.get(foundPid)?.jsToken ?? "")).catch(() => {}));
        // Supply proxy credentials for authenticated proxies in tab BrowserViews.
        // The main EB window has a login handler on win.webContents, but tab views
        // are separate webContents and need their own handler for the 407 response.
        tabView.webContents.on("login", (event: any, _req: any, _authInfo: any, callback: any) => {
          event.preventDefault();
          const _tabEntry = ebMap.get(foundPid);
          callback(_tabEntry?.proxy?.user ?? "", _tabEntry?.proxy?.pass ?? "");
        });
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
        // 2FA toolbar button macro.
        // The 2FA input field is already selected/focused by default, so:
        //   generate TOTP ("Generate Code" from account settings 2FA section)
        //   → Tab × 2 → paste code into browser (Input.insertText)
        //   → Tab × 3 → Enter
        try {
          try { wc.debugger.attach("1.3"); } catch {}
          const _r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const _p = await _r.json() as any;
          const _key = (_p.twoFASecretKey ?? "").trim();
          if (_key) {
            const _code = generateTotp(_key);
            const _ms = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
            const _d = wc.debugger;

            // Tab × 2 before pasting the code
            for (let _ti = 0; _ti < 2; _ti++) {
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms(60);
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms(120);
            }

            // Paste the generated code into the 2FA input
            await _d.sendCommand("Input.insertText", { text: _code });
            await _ms(200);

            // Tab × 3 → Enter (submit 2FA form)
            for (let _ti = 0; _ti < 3; _ti++) {
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms(60);
              await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
              await _ms(120);
            }
            await _ms(200);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
          }
        } catch {}
        break;
      }

      case "phone": {
        // Fill the phone number into the visible phone field via CDP.
        // Falls back to the last-focused field (typeIntoFocused) if the
        // specific selectors don't match the current page layout.
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/settings`);
          const s = await r.json() as any;
          const num = (s.preFilledPhoneNumber ?? "").trim();
          if (!num) break;
          try { wc.debugger.attach("1.3"); } catch {}
          const _ms2 = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
          const _d2 = wc.debugger;
          // Find the phone input centre via JS (read-only — no events fired here)
          const _PHONE_SELS = [
            'input[name="mobile_number"]',
            'input[name="phone"]',
            'input[name="phone_number"]',
            'input[autocomplete="tel"]',
            'input[type="tel"]',
            'input[inputmode="tel"]',
            'input[aria-label*="phone" i]',
            'input[aria-label*="mobile" i]',
            'input[placeholder*="phone" i]',
            'input[placeholder*="mobile" i]',
          ].join(",");
          const phonePos = await wc.executeJavaScript(`(function(){
            var SELS=${JSON.stringify(_PHONE_SELS)};
            var el=document.querySelector(SELS)||null;
            if(!el){
              // Broader fallback: any visible text/tel input that isn't username/password
              var inputs=Array.from(document.querySelectorAll('input[type="text"],input[type="tel"],input:not([type])'));
              el=inputs.find(function(i){
                if(i.name==='username'||i.name==='password'||i.type==='password')return false;
                var r=i.getBoundingClientRect();
                return r.width>0&&r.height>0;
              })||null;
            }
            if(!el)return null;
            var r=el.getBoundingClientRect();
            if(r.width<=0||r.height<=0)return null;
            return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
          })()`).catch(() => null) as { x: number; y: number } | null;

          if (phonePos) {
            // Touch tap to focus the phone field
            await cdpTapGesture(_d2, phonePos.x, phonePos.y);
            await _ms2(120);
            // Select-all + delete to clear existing value
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _ms2(80);
            // Type digits with human timing
            await typeTextCDP(_d2, num);
            // Tab-blur to trigger form validation
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms2(50);
            await _d2.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
          } else {
            // Fallback: type into whatever field the user last had focus on
            await typeIntoFocused(num);
          }
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
        const ses = electronSession.fromPartition(ebPartition(foundPid));
        await ses.clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "filesystem", "cachestorage", "shadercache", "websql", "serviceworkers"],
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

      // ── GET /eb/resolve-proxy ─────────────────────────────────────────────────
      // Calls Electron session.resolveProxy() to show what the browser ACTUALLY
      // routes through for a given URL.  Used by the leak-test page for diagnostics.
      if (req.method === "GET" && u.pathname === "/eb/resolve-proxy") {
        const pid        = Number(u.searchParams.get("profileId") ?? "-1");
        const testUrl    = u.searchParams.get("url") || "https://api.ipify.org/";
        const entry      = ebMap.get(pid);
        if (!entry || entry.win.isDestroyed()) {
          return send(res, 200, { resolved: null, partition: null, storedProxy: null, error: "EB window not open" });
        }
        const ses      = electronSession.fromPartition(entry.partition);
        const resolved = await ses.resolveProxy(testUrl).catch((e: any) => `ERROR: ${e?.message}`);
        const stored   = entry.proxy;
        const proxyRules = stored
          ? (buildProxyConfig(stored) as any).proxyRules ?? "(no proxyRules)"
          : "direct://";
        console.log(`[EB:resolve-proxy] pid=${pid} url=${testUrl} electron-resolved="${resolved}" applied-rules="${proxyRules}"`);
        return send(res, 200, {
          resolved,
          partition:  entry.partition,
          proxyRules,
          storedProxy: stored ? {
            host:           stored.host,
            port:           stored.port,
            type:           stored.type || "http",
            hasCredentials: !!(stored.user),
            user:           stored.user ? `${stored.user.slice(0,2)}***` : null,
          } : null,
        });
      }

      // ── GET /eb/ip-audits ─────────────────────────────────────────────────────
      // Returns the exit-IP audit result for every EB session opened since the
      // last app start.  Used by GET /api/eb-ip-audits on the API server side.
      if (req.method === "GET" && u.pathname === "/eb/ip-audits") {
        return send(res, 200, { audits: Array.from(_ebIpAudits.values()) });
      }

      // ── GET /eb/browser-check ────────────────────────────────────────────────
      // Executes JavaScript inside the live EB window to capture what the browser
      // is actually presenting — Electron leak flags, touch emulation, platform
      // spoof, WebGL renderer, chrome object integrity, canvas noise.
      // These are the signals Instagram's login JS evaluates; none are visible in
      // server-side logs.  Requires the EB window to be open for this profileId.
      if (req.method === "GET" && u.pathname === "/eb/browser-check") {
        const pid   = Number(u.searchParams.get("profileId") ?? "-1");
        const entry = ebMap.get(pid);
        if (!entry || entry.win.isDestroyed()) {
          return send(res, 200, {
            open:     false,
            error:    "EB window not open — open the browser for this account first, then re-run",
            checks:   null,
            checkedAt: new Date().toISOString(),
          });
        }
        const wc  = entry.win.webContents;
        const url = wc.getURL();
        let raw: Record<string, unknown> = {};
        try {
          raw = await wc.executeJavaScript(`(function () {
            const R = {};
            // ── Electron globals (must all be absent) ──────────────────────────
            R.webdriver  = navigator.webdriver;
            R.hasProcess = typeof window.process   !== 'undefined';
            // Instagram's login page defines window.require as their own AMD/Haste
            // module loader — it is NOT Electron's Node.js require.  Only flag as
            // an Electron leak if the require carries Node.js-specific properties
            // (main, cache, extensions) that Electron's native require has but
            // Instagram's module loader does not.
            R.hasRequire = typeof window.require !== 'undefined' && (
              typeof window.require.main       !== 'undefined' ||
              typeof window.require.cache      !== 'undefined' ||
              typeof window.require.extensions !== 'undefined'
            );
            R.hasModule  = typeof window.module    !== 'undefined';
            R.hasElectron = typeof window._electron !== 'undefined';
            // ── Navigator ─────────────────────────────────────────────────────
            R.userAgent           = navigator.userAgent;
            R.platform            = navigator.platform;
            R.vendor              = navigator.vendor;
            R.language            = navigator.language;
            R.languages           = Array.from(navigator.languages || []);
            R.hardwareConcurrency = navigator.hardwareConcurrency;
            R.deviceMemory        = navigator.deviceMemory || null;
            R.maxTouchPoints      = navigator.maxTouchPoints;
            R.doNotTrack          = navigator.doNotTrack;
            // ── Touch ─────────────────────────────────────────────────────────
            R.ontouchstart  = 'ontouchstart'  in window;
            R.ontouchend    = 'ontouchend'    in window;
            R.pointerEvents = typeof window.PointerEvent !== 'undefined';
            // ── Chrome object ─────────────────────────────────────────────────
            R.hasChromeObj       = typeof window.chrome !== 'undefined';
            R.chromeRuntimeOk    = !!(window.chrome && window.chrome.runtime && typeof window.chrome.runtime === 'object');
            R.chromeLoadTimesOk  = !!(window.chrome && typeof window.chrome.loadTimes === 'function');
            R.chromeCsiOk        = !!(window.chrome && typeof window.chrome.csi === 'function');
            // ── Screen / viewport ─────────────────────────────────────────────
            R.screenWidth      = screen.width;
            R.screenHeight     = screen.height;
            R.colorDepth       = screen.colorDepth;
            R.devicePixelRatio = window.devicePixelRatio;
            R.innerWidth       = window.innerWidth;
            R.innerHeight      = window.innerHeight;
            R.outerWidth       = window.outerWidth;
            R.outerHeight      = window.outerHeight;
            // ── WebGL ─────────────────────────────────────────────────────────
            try {
              const c  = document.createElement('canvas');
              const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
              if (gl) {
                const ext = gl.getExtension('WEBGL_debug_renderer_info');
                R.webglVendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : '(ext unavailable)';
                R.webglRenderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '(ext unavailable)';
                R.webglVersion  = gl.getParameter(gl.VERSION);
                R.webglSLVersion = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
              } else { R.webglError = 'context null'; }
            } catch (e) { R.webglError = String(e); }
            // ── Canvas noise check ────────────────────────────────────────────
            // Draw identical instructions twice; if canvas noise injection is
            // working, the data URLs will differ slightly between windows.
            try {
              const c = document.createElement('canvas');
              c.width = 300; c.height = 60;
              const ctx = c.getContext('2d');
              ctx.textBaseline = 'top';
              ctx.font = '18px Arial';
              ctx.fillStyle = '#f60';
              ctx.fillRect(0, 0, 300, 60);
              ctx.fillStyle = '#069';
              ctx.fillText('AuraFarmingNoise-\u2665', 2, 2);
              ctx.fillStyle = 'rgba(102,204,0,0.8)';
              ctx.fillText('AuraFarmingNoise', 4, 4);
              R.canvasSnip = c.toDataURL('image/png').substring(22, 120);
            } catch (e) { R.canvasError = String(e); }
            // ── Network info hint ─────────────────────────────────────────────
            try {
              const nc = navigator.connection;
              if (nc) { R.connEffType = nc.effectiveType; R.connType = nc.type; }
            } catch (_) {}
            // ── Automation hints ──────────────────────────────────────────────
            R.puppeteerDetect = !!(navigator.webdriver);
            // Check for an OWN-property descriptor on the navigator instance.
            // Real Chrome: Object.getOwnPropertyDescriptor(navigator,'webdriver') === undefined
            //              (the property lives on Navigator.prototype only).
            // Broken suppression: defineProperty on the instance creates an own
            // descriptor that detector scripts probe to identify automation tools
            // even when the returned value is false/undefined.
            try {
              R.webdriverOwnDesc = Object.getOwnPropertyDescriptor(navigator, 'webdriver') !== undefined;
            } catch (_) { R.webdriverOwnDesc = false; }
            R.permissions = null;
            try {
              // Checking notification permission synchronously
              R.permissions = Notification.permission;
            } catch (_) {}
            return R;
          })()`);
        } catch (e: any) {
          return send(res, 200, {
            open:      true,
            url,
            error:     `JS execution failed (page may still be loading): ${(e?.message ?? String(e)).slice(0, 120)}`,
            checks:    null,
            checkedAt: new Date().toISOString(),
          });
        }

        // ── Interpret raw signals → structured check results ──────────────────
        const ua         = String(raw.userAgent ?? "");
        const isMobileUA = /Android|iPhone|iPad/.test(ua);
        const platform   = String(raw.platform ?? "");

        type BcStatus = "pass" | "fail" | "warn" | "info";
        interface BcCheck { title: string; status: BcStatus; label: string; detail: Record<string, unknown> }
        const checks: Record<string, BcCheck> = {};

        // 1. Electron leak
        const leaks: string[] = [];
        if (raw.hasProcess)  leaks.push("window.process");
        if (raw.hasRequire)  leaks.push("window.require");
        if (raw.hasModule)   leaks.push("window.module");
        if (raw.hasElectron) leaks.push("window._electron");
        if (raw.webdriver === true)  leaks.push("navigator.webdriver=true");
        if (raw.webdriver !== false) leaks.push(`navigator.webdriver=${JSON.stringify(raw.webdriver)} (should be false)`);
        if (raw.webdriverOwnDesc)    leaks.push("navigator.webdriver is an own-property (prototype-only in real Chrome)");
        checks.electronLeak = {
          title:  "Electron Leak",
          status: leaks.length > 0 ? "fail" : "pass",
          label:  leaks.length > 0
            ? `EXPOSED: ${leaks.join(", ")} — Instagram login JS can detect Electron`
            : "Clean — no Electron globals visible to page JS",
          detail: {
            "window.process":        String(raw.hasProcess),
            "window.require":        String(raw.hasRequire),
            "window.module":         String(raw.hasModule),
            "window._electron":      String(raw.hasElectron),
            "navigator.webdriver":   String(raw.webdriver),
          },
        };

        // 2. Touch emulation
        const tp = Number(raw.maxTouchPoints ?? 0);
        checks.touchEmulation = {
          title:  "Touch Emulation",
          status: isMobileUA && tp === 0 ? "fail" : isMobileUA && !raw.ontouchstart ? "warn" : "pass",
          label:  isMobileUA && tp === 0
            ? `maxTouchPoints=0 but UA claims mobile — touch emulation NOT applied (login events will look wrong)`
            : isMobileUA && !raw.ontouchstart
            ? `maxTouchPoints=${tp} OK but ontouchstart not in window`
            : `maxTouchPoints=${tp} — touch emulation active`,
          detail: {
            maxTouchPoints: String(tp),
            ontouchstart:   String(raw.ontouchstart),
            ontouchend:     String(raw.ontouchend),
            isMobileUA:     String(isMobileUA),
          },
        };

        // 3. Platform spoof
        const platformWrong = isMobileUA && (platform === "Win32" || platform === "Win64" || platform.toLowerCase().includes("windows"));
        checks.platformSpoof = {
          title:  "Platform Spoof",
          status: platformWrong ? "fail" : "pass",
          label:  platformWrong
            ? `navigator.platform="${platform}" contradicts Android UA — detectable by 2 lines of JS`
            : `navigator.platform="${platform}" — consistent with UA claim`,
          detail: {
            platform:         platform,
            expectedForAndroid: "Linux armv8l  /  Linux aarch64",
            isMobileUA:       String(isMobileUA),
            userAgentSnip:    ua.substring(0, 80),
          },
        };

        // 4. Chrome object integrity
        checks.chromeObject = {
          title:  "Chrome Object",
          status: !raw.hasChromeObj ? "fail" : !raw.chromeRuntimeOk ? "warn" : "pass",
          label:  !raw.hasChromeObj
            ? "window.chrome missing — fingerprinted as non-Chrome"
            : !raw.chromeRuntimeOk
            ? "window.chrome present but chrome.runtime structure is wrong"
            : "window.chrome + chrome.runtime look correct",
          detail: {
            hasChromeObj:    String(raw.hasChromeObj),
            chromeRuntimeOk: String(raw.chromeRuntimeOk),
            chromeLoadTimes: String(raw.chromeLoadTimesOk),
            chromeCsi:       String(raw.chromeCsiOk),
          },
        };

        // 5. WebGL renderer
        const renderer = String(raw.webglRenderer ?? "").toLowerCase();
        const isSoft   = renderer.includes("swiftshader") || renderer.includes("mesa") ||
                         renderer.includes("llvm") || renderer.includes("virgl") ||
                         renderer.includes("softpipe") || renderer.includes("lavapipe");
        checks.webglRenderer = {
          title:  "WebGL Renderer",
          status: raw.webglError ? "warn" : isSoft ? "fail" : "pass",
          label:  raw.webglError
            ? `WebGL query error: ${raw.webglError}`
            : isSoft
            ? `Software renderer: "${raw.webglRenderer}" — flags as VM/headless to Instagram`
            : `${raw.webglRenderer}`,
          detail: {
            vendor:   String(raw.webglVendor   ?? ""),
            renderer: String(raw.webglRenderer ?? ""),
            version:  String(raw.webglVersion  ?? ""),
          },
        };

        // 6. Canvas noise
        const canvasSnip = String(raw.canvasSnip ?? "");
        checks.canvasNoise = {
          title:  "Canvas Noise",
          status: raw.canvasError ? "warn" : canvasSnip.length > 10 ? "info" : "warn",
          label:  raw.canvasError
            ? `Canvas error: ${raw.canvasError}`
            : "Canvas rendered — compare snips across two windows to verify noise is different per-session",
          detail: {
            canvasDataSnip: canvasSnip,
            note: "If noise injection is working, this string will differ between different account windows",
          },
        };

        console.log(`[EB:browser-check:${pid}] url=${url} leaks=${leaks.length} touch=${tp} platform=${platform} renderer=${raw.webglRenderer}`);

        return send(res, 200, {
          open:      true,
          url,
          profileId: pid,
          checkedAt: new Date().toISOString(),
          checks,
          raw,
        });
      }

      // ── GET /eb/header-check ─────────────────────────────────────────────────
      // Audits the ACTUAL bytes Chrome puts on the wire for requests to Instagram/
      // Facebook — not JS-visible window/navigator properties. The Browser
      // Fingerprint Check above can pass 100% while the real HTTP headers are
      // still wrong: Sec-CH-UA-* mismatched with the UA string, Accept-Language
      // header not matching navigator.languages, missing Sec-Fetch-* headers,
      // Sec-CH-UA-Mobile disagreeing with the claimed device — these are exactly
      // the things Instagram's server-side fingerprinting checks, and login never
      // goes through the CycleTLS/API path at all, so the "API Leak Check" tab
      // audits an entirely different — and for this flow, unused — code path.
      if (req.method === "GET" && u.pathname === "/eb/header-check") {
        const pid   = Number(u.searchParams.get("profileId") ?? "-1");
        const entry = ebMap.get(pid);
        if (!entry || entry.win.isDestroyed()) {
          return send(res, 200, {
            open:      false,
            error:     "EB window not open — open the browser for this account first, then re-run",
            captures:  [],
            checkedAt: new Date().toISOString(),
          });
        }
        // Ensure capture is wired even if the window was opened before this
        // endpoint existed (e.g. long-running session).
        wireHeaderCapture(entry.win.webContents, pid);

        const captures = _headerCaptures.get(pid) ?? [];
        if (captures.length === 0) {
          return send(res, 200, {
            open:      true,
            url:       entry.win.webContents.getURL(),
            profileId: pid,
            checkedAt: new Date().toISOString(),
            captures:  [],
            checks:    null,
            note:      "No requests to instagram.com/facebook.com captured yet — navigate or re-run login, then re-check.",
          });
        }

        const latest = captures[captures.length - 1];
        const h = Object.fromEntries(
          Object.entries(latest.headers).map(([k, v]) => [k.toLowerCase(), v]),
        );
        const ua = h["user-agent"] ?? "";
        const isMobileUA = /Android|iPhone|iPad/.test(ua);

        type HcStatus = "pass" | "fail" | "warn" | "info";
        interface HcCheck { title: string; status: HcStatus; label: string; detail: Record<string, unknown> }
        const checks: Record<string, HcCheck> = {};

        // 1. Sec-CH-UA-Mobile vs UA string
        const chMobile = h["sec-ch-ua-mobile"];
        const chMobileWrong = isMobileUA ? chMobile !== "?1" : chMobile === "?1";
        checks.chUaMobile = {
          title:  "Sec-CH-UA-Mobile Consistency",
          status: chMobile === undefined ? "warn" : chMobileWrong ? "fail" : "pass",
          label:  chMobile === undefined
            ? "Sec-CH-UA-Mobile header missing from the real request"
            : chMobileWrong
            ? `Sec-CH-UA-Mobile=${chMobile} contradicts User-Agent (isMobileUA=${isMobileUA}) — a real wire-level tell`
            : `Sec-CH-UA-Mobile=${chMobile} — consistent with UA`,
          detail: { "sec-ch-ua-mobile": String(chMobile), userAgentSnip: ua.slice(0, 80) },
        };

        // 2. Sec-CH-UA-Platform vs claimed device
        const chPlatform = h["sec-ch-ua-platform"];
        const expectedPlatform = isMobileUA ? "Android" : null;
        const chPlatformWrong = expectedPlatform !== null && chPlatform !== `"${expectedPlatform}"` && chPlatform !== expectedPlatform;
        checks.chUaPlatform = {
          title:  "Sec-CH-UA-Platform Consistency",
          status: chPlatform === undefined ? "warn" : chPlatformWrong ? "fail" : "pass",
          label:  chPlatform === undefined
            ? "Sec-CH-UA-Platform header missing from the real request"
            : chPlatformWrong
            ? `Sec-CH-UA-Platform=${chPlatform} does not match expected "${expectedPlatform}"`
            : `Sec-CH-UA-Platform=${chPlatform} — consistent`,
          detail: { "sec-ch-ua-platform": String(chPlatform) },
        };

        // 3. Accept-Language header consistency (server-side, not just navigator.languages)
        const acceptLang = h["accept-language"] ?? "";
        checks.acceptLanguage = {
          title:  "Accept-Language Header",
          status: acceptLang ? "pass" : "warn",
          label:  acceptLang
            ? `Accept-Language: ${acceptLang}`
            : "Accept-Language header missing from the real outgoing request",
          detail: { "accept-language": acceptLang },
        };

        // 4. Sec-Fetch-* headers — Chrome always sends Site/Mode/Dest on every
        // request. Sec-Fetch-User is the exception: real Chrome ONLY sends it
        // on a top-level navigation with user activation (mode=navigate) — it
        // is correctly ABSENT on fetch/XHR calls (mode=cors/no-cors/same-origin),
        // which is most of what Instagram's login/session traffic actually is.
        // Treating its absence on a non-navigate request as a fail was a false
        // positive in the original version of this check.
        const alwaysRequired = ["sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"];
        const missingAlways  = alwaysRequired.filter(k => h[k] === undefined);
        const isNavigate     = h["sec-fetch-mode"] === "navigate";
        const secFetchUser   = h["sec-fetch-user"];
        const userHeaderWrong = isNavigate ? secFetchUser === undefined : secFetchUser !== undefined;
        const secFetchIssues = [
          ...missingAlways,
          ...(userHeaderWrong ? ["sec-fetch-user"] : []),
        ];
        checks.secFetch = {
          title:  "Sec-Fetch-* Headers",
          status: secFetchIssues.length > 0 ? "fail" : "pass",
          label:  secFetchIssues.length > 0
            ? isNavigate && secFetchUser === undefined
              ? "Missing Sec-Fetch-User on a navigation request — real Chrome always sends it on top-level navigations"
              : !isNavigate && secFetchUser !== undefined
              ? `Sec-Fetch-User present on a non-navigation (mode=${h["sec-fetch-mode"]}) request — real Chrome never sends it outside navigation`
              : `Missing: ${missingAlways.join(", ")} — real Chrome always sends Sec-Fetch-Site/Mode/Dest`
            : isNavigate
            ? "All Sec-Fetch-* headers present and correct for a navigation request"
            : `Sec-Fetch-Site/Mode/Dest present and correct for a ${h["sec-fetch-mode"]} request (Sec-Fetch-User correctly absent — not a navigation)`,
          detail: {
            "sec-fetch-site": String(h["sec-fetch-site"]),
            "sec-fetch-mode": String(h["sec-fetch-mode"]),
            "sec-fetch-dest": String(h["sec-fetch-dest"]),
            "sec-fetch-user": String(secFetchUser),
            isNavigationRequest: String(isNavigate),
          },
        };

        // 5. User-Agent header vs CDP override
        checks.userAgentHeader = {
          title:  "User-Agent Header",
          status: ua ? "pass" : "fail",
          label:  ua ? ua : "User-Agent header missing entirely — cannot have come from a real browser",
          detail: { "user-agent": ua },
        };

        // 6. Sec-CH-UA (the un-suffixed brand-list header — distinct from
        // Sec-CH-UA-Mobile/-Platform checked above). Chrome always sends it on
        // any request once client hints are active; its brand list must match
        // the Chrome version implied by the User-Agent.
        const chUa = h["sec-ch-ua"];
        const chromeMajor = ua.match(/Chrome\/(\d+)/)?.[1];
        const chUaMismatch = !!chUa && !!chromeMajor && !chUa.includes(chromeMajor);
        checks.chUaBrands = {
          title:  "Sec-CH-UA Brand List",
          status: chUa === undefined ? "fail" : chUaMismatch ? "fail" : "pass",
          label:  chUa === undefined
            ? "Sec-CH-UA header missing — real Chrome sends this on every request"
            : chUaMismatch
            ? `Sec-CH-UA brand version doesn't include Chrome/${chromeMajor} from the User-Agent`
            : `Sec-CH-UA: ${chUa}`,
          detail: { "sec-ch-ua": String(chUa), chromeMajorFromUA: String(chromeMajor) },
        };

        // 7. Accept / Accept-Encoding — always present on real navigations;
        // missing Accept-Encoding in particular is a classic non-browser tell
        // (most HTTP client libraries omit brotli/gzip negotiation Chrome sends).
        const accept = h["accept"];
        const acceptEncoding = h["accept-encoding"];
        checks.acceptHeaders = {
          title:  "Accept / Accept-Encoding",
          status: (!accept || !acceptEncoding) ? "fail" : "pass",
          label:  (!accept || !acceptEncoding)
            ? `Missing: ${[!accept && "Accept", !acceptEncoding && "Accept-Encoding"].filter(Boolean).join(", ")}`
            : `Accept: ${accept} · Accept-Encoding: ${acceptEncoding}`,
          detail: { accept: String(accept), "accept-encoding": String(acceptEncoding) },
        };

        // 8. Cookie header — must be present once a session exists, and must
        // NOT be present as an empty string (proxy stripping Set-Cookie upstream
        // shows up here as a request that never carries a session cookie back).
        const cookieHeader = h["cookie"];
        checks.cookieHeader = {
          title:  "Cookie Header",
          status: cookieHeader === undefined ? "info" : cookieHeader.length === 0 ? "warn" : "pass",
          label:  cookieHeader === undefined
            ? "No Cookie header on this request (expected before any session cookies are set)"
            : cookieHeader.length === 0
            ? "Cookie header present but EMPTY — a proxy or session issue may be stripping cookies"
            : `Cookie header present (${cookieHeader.split(";").length} cookie(s))`,
          detail: { cookiePresent: String(cookieHeader !== undefined), cookieCount: String(cookieHeader ? cookieHeader.split(";").length : 0) },
        };

        // 9. Header count sanity — a real Chrome navigation to instagram.com
        // carries roughly 10-15 headers (host, connection, sec-ch-ua*, upgrade-
        // insecure-requests, user-agent, accept, sec-fetch-*, accept-encoding,
        // accept-language, cookie). A request with far fewer is missing some of
        // the above individually-checked headers AND likely others besides.
        const headerCount = Object.keys(latest.headers).length;
        checks.headerCount = {
          title:  "Header Count Sanity",
          status: headerCount < 8 ? "fail" : headerCount < 10 ? "warn" : "pass",
          label:  `${headerCount} headers captured — real Chrome sends ~10-15 on an instagram.com request`,
          detail: { headerCount: String(headerCount), headerNames: Object.keys(latest.headers) },
        };

        // 10. Raw header dump for manual audit — header ORDER also matters to
        // Instagram's fingerprinting and can only be judged by eye here.
        checks.rawHeaders = {
          title:  "All Real Request Headers (raw)",
          status: "info",
          label:  `${headerCount} headers captured for ${latest.method} ${latest.url}`,
          detail: latest.headers,
        };

        console.log(`[EB:header-check:${pid}] url=${latest.url} headers=${Object.keys(latest.headers).length} captures=${captures.length}`);

        return send(res, 200, {
          open:      true,
          url:       entry.win.webContents.getURL(),
          profileId: pid,
          checkedAt: new Date().toISOString(),
          checks,
          captures,
        });
      }

      // ── GET /eb/cookies ────────────────────────────────────────────────────────
      if (req.method === "GET" && u.pathname === "/eb/cookies") {
        const pid = Number(u.searchParams.get("profileId"));
        const ses = electronSession.fromPartition(ebPartition(pid));
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
        const parsedFp: EbFingerprintLite | null = body.ebFingerprint
          ? (typeof body.ebFingerprint === "string" ? JSON.parse(body.ebFingerprint) : body.ebFingerprint)
          : null;
        // Fire-and-forget: respond immediately so the React browser panel can
        // open without waiting for the full Electron window setup (proxy double-set,
        // cookie loading, event handler registration, initial navigation).
        // The window shows via ready-to-show as soon as Chromium is ready.
        // Errors are logged to the console — they don't block the UI.
        openEbWindow({
          profileId: pid,
          username:  body.username  ?? String(pid),
          password:  body.password,
          twoFAKey:  body.twoFAKey,
          proxy:     body.proxy,
          useHomeIp: body.useHomeIp === true,
          userAgent: body.userAgent,
          apiUA:     body.apiUA,
          ebFingerprint: parsedFp,
          initialUrl: body.initialUrl ?? undefined,
          verifyMode: body.verifyMode === true,
          silentMode: body.silentMode === true,
        }).catch(err => console.error(`[eb:open:${pid}] openEbWindow error:`, err?.message ?? err));
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
          if (pid >= 0) {
            // Regular account EB: save cookies so the session survives app restarts.
            const ses = electronSession.fromPartition(ebPartition(pid));
            await saveCookiesToFile(pid, ses);
          } else {
            // Ghost Browser (pid < 0): NEVER save cookies — it is a throwaway identity.
            // Saving and reloading cookies is exactly what causes the "previous signup
            // attempt still showing" bug: the stale Instagram session (suspended/flagged)
            // gets written to cookies--1.json here and pumped back into the brand-new
            // in-memory partition on the next /eb/open, making Instagram redirect to
            // /accounts/suspended/ immediately.  Delete any leftover file from before
            // this fix so the next open always starts with a completely clean slate.
            try { fs.unlinkSync(cookieFilePath(pid)); } catch { /* no file — fine */ }
          }
          // destroy() bypasses the "close" event handler that hides the window,
          // so this actually removes the window rather than hiding it to tray.
          e.win.destroy();
        } else if (pid < 0) {
          // Window already closed/destroyed — still clean up any stale cookies file.
          try { fs.unlinkSync(cookieFilePath(pid)); } catch { /* no file — fine */ }
        }
        // Invalidate any running ghost-signup async block so it stops cleanly
        // rather than continuing to run against a destroyed WebContents.
        if (pid < 0) { const s = -pid; _ghostSignupAbortTokens.set(s, (_ghostSignupAbortTokens.get(s) ?? 0) + 1); }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/navigate ──────────────────────────────────────────────────────
      // IMPORTANT: when the EB window has tabs open, e.win.webContents is the
      // native toolbar/shell frame — NOT the active tab's Instagram page. Using
      // it directly silently navigates the wrong WebContents (same bug class
      // already fixed for doAutoLogin's silent-verify path above). Must resolve
      // the active tab's WebContents via getActiveWc() first.
      if (req.method === "POST" && u.pathname === "/eb/navigate") {
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          const targetWc = getActiveWc(pid) ?? e.win.webContents;
          console.log(`[eb-ipc:${pid}] /eb/navigate → url="${body.url}" target=${targetWc === e.win.webContents ? "win.webContents (shell/no-tabs)" : "active tab BrowserView"}`);
          targetWc.loadURL(body.url).catch((err: any) => {
            console.log(`[eb-ipc:${pid}] /eb/navigate loadURL error: ${err?.message}`);
          });
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/clear-session ─────────────────────────────────────────────────
      // Clears the Electron session storage (all cookies + localStorage + IndexedDB)
      // for the account's partition, then navigates the open EB window (if any) to
      // the Instagram login page.  Called by the clear-session-cookies API route so
      // the user sees the login page immediately after pressing "Clear Cookies".
      if (req.method === "POST" && u.pathname === "/eb/clear-session") {
        const partition = ebPartition(pid);
        const ses = electronSession.fromPartition(partition);
        for (const origin of ["https://www.instagram.com", "https://i.instagram.com"]) {
          await ses.clearStorageData({
            origin,
            storages: ["cookies", "localstorage", "indexdb", "serviceworkers", "cachestorage"] as any,
          }).catch(() => {});
        }
        // Belt-and-suspenders: remove all .instagram.com cookies by name
        const allCks = await ses.cookies.get({ domain: ".instagram.com" }).catch(() => [] as Electron.Cookie[]);
        for (const c of allCks) {
          await ses.cookies.remove("https://www.instagram.com", c.name).catch(() => {});
          await ses.cookies.remove("https://instagram.com", c.name).catch(() => {});
        }
        const e = ebMap.get(pid);
        if (e && !e.win.isDestroyed()) {
          e.win.webContents.loadURL("https://www.instagram.com/accounts/login/").catch(() => {});
          console.log(`[clear-session:${pid}] Electron session cleared + window navigated to login`);
        } else {
          console.log(`[clear-session:${pid}] Electron session cleared (no open window)`);
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/evaluate ──────────────────────────────────────────────────────
      // Root cause of "all element queries return undefined while side-effect
      // scripts (scrollBy etc.) appear to work": this handler was always running
      // executeJavaScript against e.win.webContents (the toolbar/shell frame)
      // instead of the active tab's BrowserView WebContents. Once tabs are open,
      // the shell frame has no Instagram DOM at all, so every querySelector-based
      // check silently evaluates against the wrong document and returns undefined
      // — but scrollBy/dispatchEvent-style calls don't throw either, since they're
      // valid no-op calls on any window, which is why they looked like they "worked".
      // Fixed by resolving the active tab via getActiveWc(), same as doAutoLogin.
      if (req.method === "POST" && u.pathname === "/eb/evaluate") {
        const e = ebMap.get(pid);
        if (!e || e.win.isDestroyed()) return send(res, 404, { error: "window not open" });
        const targetWc = getActiveWc(pid) ?? e.win.webContents;
        const targetKind = targetWc === e.win.webContents ? "win.webContents (shell/no-tabs)" : "active tab BrowserView";
        const targetUrl = (() => { try { return targetWc.getURL(); } catch { return "(no getURL)"; } })();
        const result = await targetWc.executeJavaScript(body.script)
          .catch((err: any) => ({ __error: err?.message }));
        console.log(`[eb-ipc:${pid}] /eb/evaluate target=${targetKind} url="${targetUrl}" resultType=${typeof result} result=${JSON.stringify(result)?.slice(0, 200)}`);
        return send(res, 200, { result });
      }

      // ── POST /eb/set-cookies ───────────────────────────────────────────────────
      if (req.method === "POST" && u.pathname === "/eb/set-cookies") {
        const ses = electronSession.fromPartition(ebPartition(pid));
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
        const ses = electronSession.fromPartition(ebPartition(pid));
        for (const name of (body.names ?? [])) {
          await ses.cookies.remove("https://www.instagram.com", name).catch(() => {});
          await ses.cookies.remove("https://instagram.com",     name).catch(() => {});
        }
        return send(res, 200, { ok: true });
      }

      // ── POST /eb/silent-follow ──────────────────────────────────────────────────
      // Performs a browser-based follow without requiring the user to have the EB
      // window open.  Two modes:
      //
      // A) EB is already open → reuse that window (navigate to target, follow,
      //    navigate back to previous page — same as before).
      //
      // B) EB is NOT open → create a temporary hidden BrowserWindow using the
      //    same session partition (persist:eb-{pid}) which already has the
      //    account's Instagram cookies from the last EB login.  Perform the
      //    follow in the hidden window, then destroy it when done.
      //
      // ONE session per account is the rule.  In mode B the hidden window uses
      // the same persist: partition as the regular EB so Chrome sees it as the
      // same profile — not a new device.  We never register it in ebMap so the
      // frontend correctly shows the EB as "not open".
      if (req.method === "POST" && u.pathname === "/eb/silent-follow") {
        const targetUsername: string = (body.targetUsername ?? "").trim();
        if (!pid || !targetUsername) return send(res, 400, { error: "profileId and targetUsername required" });

        // Serialise follows per-account — the engine should not send two
        // simultaneous follows for the same profile, but guard here too.
        if (_sfInProgress.has(pid)) {
          _ipcLog(`[eb:silent-follow:${pid}] follow already in progress for this window — returning retry-next-cycle`);
          return send(res, 200, { ok: false, status: "follow_blocked", reason: "concurrent-limit — will retry automatically next cycle" });
        }
        _sfInProgress.add(pid);

        // Determine whether to use the existing open EB window (mode A) or a
        // temporary hidden window (mode B).
        const ebEntry = ebMap.get(pid);
        const ebIsOpen = !!(ebEntry && !ebEntry.win.isDestroyed());

        let sfWin: BrowserWindow;
        let sfTempWin: BrowserWindow | null = null; // created only in mode B

        if (ebIsOpen) {
          // Mode A — reuse the existing open EB window.
          sfWin = ebEntry!.win;
          _ipcLog(`[eb:silent-follow:${pid}] mode A — reusing open EB window for @${targetUsername}`);
        } else {
          // Mode B — create a temporary hidden BrowserWindow.
          // The persist: partition already holds the account's Instagram cookies
          // so the hidden window is logged in without any extra login step.
          const sfPartition = `persist:eb-${pid}`;
          const sfSes = electronSession.fromPartition(sfPartition);

          // ── Inject account cookies into the session ─────────────────────────
          // The persist:eb-{pid} partition is empty when the EB has never been
          // opened in this Electron session.  Without cookies, Instagram sees a
          // logged-out browser and redirects every profile URL to the homepage
          // (not /accounts/login/ — so the login-wall check doesn't catch it).
          // We inject the igApiCookies from the DB so the hidden window is
          // authenticated before the first navigation.
          const rawCookies: string = (body.igApiCookies as string | null | undefined) ?? "";
          if (rawCookies) {
            const cookiePairs = rawCookies.split(";").map(s => s.trim()).filter(Boolean);
            for (const pair of cookiePairs) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx < 1) continue;
              const name  = pair.slice(0, eqIdx).trim();
              const value = pair.slice(eqIdx + 1).trim();
              if (!name || !value) continue;
              try {
                await sfSes.cookies.set({
                  url:      "https://www.instagram.com",
                  name,
                  value,
                  domain:   ".instagram.com",
                  path:     "/",
                  secure:   true,
                  httpOnly: name === "sessionid" || name === "csrftoken",
                  sameSite: "no_restriction" as any,
                });
              } catch (ckErr: any) {
                _ipcLog(`[WARN] [eb:silent-follow:${pid}] cookie inject failed for "${name}": ${ckErr?.message}`);
              }
            }
            _ipcLog(`[eb:silent-follow:${pid}] mode B — injected ${cookiePairs.length} cookies into session (${cookiePairs.map(p => p.split("=")[0]).join(",")})`);
          } else {
            _ipcLog(`[WARN] [eb:silent-follow:${pid}] mode B — no igApiCookies provided; session will be unauthenticated`);
          }

          // ── Hard proxy gate ──────────────────────────────────────────────────
          // Every account MUST have a proxy.  If no proxy is present in the
          // request body — or if Chromium rejects the proxy config — we ABORT
          // immediately.  Silently proceeding without a proxy would route every
          // background follow/unfollow through the operator's real home IP,
          // which Instagram sees as hundreds of simultaneous actions from one
          // address — the root cause of mass bans.
          const bodyProxy = body.proxy as { host?: string; port?: number; user?: string; pass?: string; type?: string } | null | undefined;
          if (!bodyProxy?.host || !bodyProxy?.port) {
            _sfInProgress.delete(pid);
            _ipcLog(`[ERROR] [eb:silent-follow:${pid}] mode B — no proxy configured for this account; action aborted to prevent real IP leak`);
            return send(res, 400, { error: `No proxy configured for account ${pid} — action aborted to prevent real IP leak` });
          }
          try {
            await sfSes.clearHostResolverCache();
            await sfSes.setProxy(buildProxyConfig(bodyProxy as any));
          } catch (proxyErr: any) {
            _sfInProgress.delete(pid);
            _ipcLog(`[ERROR] [eb:silent-follow:${pid}] mode B — proxy set failed; action aborted to prevent real IP leak: ${proxyErr?.message}`);
            return send(res, 500, { error: `Proxy setup failed for account ${pid} — action aborted to prevent real IP leak: ${proxyErr?.message}` });
          }

          // Position completely off-screen and call showInactive() immediately
          // after creation — before ANY loadURL call.  This must happen before
          // the first navigation, not inside ready-to-show (which only fires
          // after the page loads, too late to prevent throttling of that load).
          const { width: _sfSw } = eScreen.getPrimaryDisplay().workAreaSize;
          sfTempWin = new BrowserWindow({
            width:       1280,
            height:      820,
            x:           _sfSw + 10, // off the right edge of every monitor
            y:           0,
            show:        false,
            skipTaskbar: true,
            webPreferences: {
              nodeIntegration:  false,
              contextIsolation: true,
              sandbox:          true,  // prevent window.require leak
              partition:        sfPartition,
              backgroundThrottling: false,
            },
          });
          // Show immediately — off-screen so user never sees it, but Chromium
          // treats it as a normal visible window (no timer throttling, no
          // deferred renderer initialization).
          sfTempWin.showInactive();
          // Supply proxy credentials for 407 challenges.  Without this handler
          // Electron cancels the auth challenge and the request falls through
          // to the machine's real IP — silently leaking the home broadband
          // address to Instagram for every background follow/unfollow action.
          sfTempWin.webContents.on("login", (event: any, _rq: any, _auth: any, cb: any) => {
            event.preventDefault();
            cb(bodyProxy?.user ?? "", bodyProxy?.pass ?? "");
          });
          // Apply the account's real fingerprint/UA BEFORE the first navigation —
          // otherwise this window runs with Electron's raw default fingerprint,
          // a mismatch from the mobile identity Instagram associated with this
          // account's sessionid at login (see armSilentWindowAntiDetection doc).
          await armSilentWindowAntiDetection(sfTempWin, {
            browserUA: (body.userAgent as string | undefined) ?? null,
            apiUA: (body.apiUA as string | undefined) ?? null,
            ebFingerprint: body.ebFingerprint ?? null,
          });
          sfWin = sfTempWin;
          _ipcLog(`[eb:silent-follow:${pid}] mode B — created off-screen background window (partition=${sfPartition}) for @${targetUsername}`);
        }

        // Remember where the browser is now so we can restore it when done
        // (only relevant in mode A — mode B destroys the window).
        const prevUrl = ebIsOpen ? (() => {
          try {
            const u2 = sfWin.webContents.getURL();
            return u2 && u2 !== "about:blank" ? u2 : "https://www.instagram.com/";
          } catch { return "https://www.instagram.com/"; }
        })() : "https://www.instagram.com/";

        // Cleanup helper: mode A navigates back; mode B destroys the temp window.
        const sfCleanup = () => {
          if (sfTempWin) {
            try { if (!sfTempWin.isDestroyed()) sfTempWin.destroy(); } catch {}
            sfTempWin = null;
          } else {
            try { sfWin.webContents.loadURL(prevUrl).catch(() => {}); } catch {}
          }
        };

        // Watchdog — if the whole operation hangs, clean up and respond.
        let sfSettled = false;
        const sfWatchdog = setTimeout(() => {
          if (sfSettled) return;
          sfSettled = true;
          _sfInProgress.delete(pid);
          _ipcLog(`[ERROR] [eb:silent-follow:${pid}] WATCHDOG — handler exceeded 80s for @${targetUsername}`);
          sfCleanup();
          try { send(res, 200, { ok: false, status: "follow_blocked", reason: "watchdog_timeout — follow took too long" }); } catch {}
        }, 80_000);

        const sfRespond = (status: number, payload: any) => {
          if (sfSettled) return;
          sfSettled = true;
          clearTimeout(sfWatchdog);
          send(res, status, payload);
        };

        // Back-compat alias so all existing sfRestoreUrl() calls below work
        // without touching the rest of the handler.
        const sfRestoreUrl = sfCleanup;

        try {
          const profileUrl = `https://www.instagram.com/${encodeURIComponent(targetUsername)}/`;
          _ipcLog(`[eb:silent-follow:${pid}] START target=@${targetUsername} prevUrl="${prevUrl.slice(0, 100)}" → ${profileUrl}`);

          // Navigate the existing window to the target's profile.
          const _sfT0 = Date.now();
          let sfNavError: Error | null = null;
          const _sfLoadResult = await Promise.race([
            sfWin.webContents.loadURL(profileUrl)
              .then(() => "ok" as const)
              .catch((e: Error) => { sfNavError = e; return "err" as const; }),
            new Promise<"timeout">(r => setTimeout(() => r("timeout"), 30_000)),
          ]);
          if (_sfLoadResult === "timeout") {
            // Stop the pending navigation immediately.  If we don't, subsequent
            // executeJavaScript calls queue behind the in-flight navigation and
            // block for another 30-60s until the proxy/TCP layer times out —
            // which is what burns the 80s watchdog even though the individual
            // JS polls all have their own timeouts.
            try { sfWin.webContents.stop(); } catch {}
            _ipcLog(`[WARN] [eb:silent-follow:${pid}] loadURL hit 30s cap at T+${Date.now() - _sfT0}ms — stopped navigation, proceeding with partially loaded page`);
          } else {
            _ipcLog(`[eb:silent-follow:${pid}] loadURL ${_sfLoadResult} in ${Date.now() - _sfT0}ms`);
          }
          if (sfNavError) {
            const msg = (sfNavError as Error).message ?? String(sfNavError);
            _ipcLog(`[WARN] [eb:silent-follow:${pid}] loadURL failed — ${msg}`);
            sfRestoreUrl();
            return sfRespond(200, { ok: false, status: "follow_blocked", reason: `Browser navigation failed: ${msg}` });
          }

          // ── Login-wall detection ──────────────────────────────────────────────
          const landedUrl: string = (() => { try { return sfWin.webContents.getURL(); } catch { return ""; } })();
          const isLoginUrl = /instagram\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/accounts\/login/i.test(landedUrl)
            || landedUrl.includes("/accounts/onetap/")
            || landedUrl.includes("/accounts/suspended/");

          const isLoginDom: boolean = isLoginUrl ? false : await Promise.race([
            sfWin.webContents.executeJavaScript(`
              (function() {
                var pwdInput = document.querySelector('input[type="password"]');
                if (pwdInput && pwdInput.offsetParent !== null) return true;
                var btns = Array.from(document.querySelectorAll('button, [role="button"]'));
                for (var i = 0; i < btns.length; i++) {
                  var t = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
                  if (t === 'log in' || t.startsWith('continue as')) return true;
                }
                if (document.title.toLowerCase().includes('log in') ||
                    document.title.toLowerCase().includes('sign up')) return true;
                return false;
              })()
            `, true).catch(() => false),
            new Promise<false>(r => setTimeout(() => r(false), 5_000)),
          ]);

          const isLoginPage = isLoginUrl || isLoginDom;

          // ── Checkpoint / suspicious-activity detection ────────────────────────
          const isCheckpointPage: boolean = isLoginPage ? false : await Promise.race([
            sfWin.webContents.executeJavaScript(`
              (function() {
                var url = location.href.toLowerCase();
                if (url.includes('/challenge/') || url.includes('/accounts/suspicious')) return true;
                var bodyText = (document.body ? document.body.innerText : '').toLowerCase();
                var markers = [
                  'we suspect automated behavior',
                  'we detected unusual activity',
                  "confirm it\'s you",
                  'help us confirm',
                  'suspicious activity',
                  'action blocked',
                  'try again later',
                ];
                return markers.some(function(m) { return bodyText.indexOf(m) !== -1; });
              })()
            `, true).catch(() => false),
            new Promise<false>(r => setTimeout(() => r(false), 5_000)),
          ]);

          _ipcLog(`[eb:silent-follow:${pid}] landed → "${landedUrl.slice(0, 200)}" loginUrl=${isLoginUrl} loginDom=${isLoginDom} checkpoint=${isCheckpointPage}`);

          if (isCheckpointPage) {
            _ipcLog(`[WARN] [eb:silent-follow:${pid}] CHECKPOINT DETECTED on @${targetUsername}'s page — url="${landedUrl.slice(0, 200)}"`);
            sfRestoreUrl();
            return sfRespond(200, { ok: false, status: "checkpoint_detected", reason: "Instagram checkpoint/suspicious-activity page shown — halt further automation on this account until manually reviewed" });
          }

          if (isLoginPage) {
            const reason = isLoginDom ? "Continue-as overlay (DOM)" : "login redirect (URL)";
            _ipcLog(`[WARN] [eb:silent-follow:${pid}] SESSION EXPIRED — ${reason}. Account needs re-verify.`);
            sfRestoreUrl();
            return sfRespond(200, { ok: false, status: "follow_blocked", reason: "session_expired — browser session logged out" });
          }

          // ── Poll for Follow button ────────────────────────────────────────────
          _ipcLog(`[eb:silent-follow:${pid}] polling for Follow button (T+${Date.now() - _sfT0}ms since loadURL start)`);
          let _btnOuterTimer: ReturnType<typeof setTimeout>;
          const btnInfo: any = await Promise.race([
            sfWin.webContents.executeJavaScript(`
              new Promise(function(resolve) {
                var tries = 0, MAX = 40; // 20 s
                function isFollow(el) {
                  var l = ((el.getAttribute ? el.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                  var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                  // aria-label may be "Follow" OR "Follow @username" — starts-with handles both;
                  // exclude "following" (already following) and "follow request sent".
                  if (l && (l === 'follow' || l === 'follow back' || (l.startsWith('follow ') && !l.startsWith('following') && !l.startsWith('follow request')))) return true;
                  return t === 'follow' || t === 'follow back';
                }
                function isAlready(el) {
                  var l = ((el.getAttribute ? el.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                  var t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                  if (l && (l.startsWith('following') || l.startsWith('requested') || l.startsWith('follow request'))) return true;
                  return t === 'following' || t === 'requested';
                }
                function check() {
                  var cands = Array.from(document.querySelectorAll('button, [role="button"]'));
                  var followBtn = cands.find(function(b) { return !b.disabled && isFollow(b); });
                  if (followBtn) {
                    var r = followBtn.getBoundingClientRect();
                    if (r.width > 0 && r.height > 0) {
                      resolve({ found: true, x: r.left, y: r.top, w: r.width, h: r.height });
                      return;
                    }
                  }
                  var alreadyBtn = cands.find(function(b) { return isAlready(b); });
                  if (alreadyBtn) { resolve({ found: false, alreadyFollowing: true }); return; }
                  if (++tries >= MAX) { resolve({ found: false, timedOut: true }); return; }
                  setTimeout(check, 500);
                }
                check();
              })
            `, true).catch(() => ({ found: false, timedOut: true })),
            new Promise<{ found: false; timedOut: true; contextDestroyed: true }>(r => {
              _btnOuterTimer = setTimeout(() => {
                _ipcLog(`[WARN] [eb:silent-follow:${pid}] btnInfo poll hit 25s outer timeout`);
                r({ found: false, timedOut: true, contextDestroyed: true });
              }, 25_000);
            }),
          ]);
          clearTimeout(_btnOuterTimer!);

          if (btnInfo?.found) {
            const acctSeed = ((pid * 2654435761) >>> 0) / 0x100000000;
            // No pre-click dwell — this is an invisible background window.
            // Human-sim delays serve no purpose here and only add latency.

            // Re-query rect to get the freshest button position (React may still
            // be settling after page load).
            const freshRect: any = await Promise.race([
              sfWin.webContents.executeJavaScript(`
                (function() {
                  var btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(b) {
                    if (b.disabled) return false;
                    var l = ((b.getAttribute ? b.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                    var t = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                    if (l && (l === 'follow' || l === 'follow back' || (l.startsWith('follow ') && !l.startsWith('following') && !l.startsWith('follow request')))) return true;
                    return t === 'follow' || t === 'follow back';
                  });
                  if (!btn) return null;
                  var r = btn.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0) return null;
                  return { x: r.left, y: r.top, w: r.width, h: r.height };
                })()
              `, true).catch(() => null),
              new Promise<null>(r => setTimeout(() => r(null), 5_000)),
            ]);

            const rect = freshRect ?? btnInfo;
            const tapX = Math.round(rect.x + (0.30 + acctSeed * 0.40) * rect.w);
            const tapY = Math.round(rect.y + (0.35 + ((acctSeed * 7919) % 0.30)) * rect.h);

            // Click strategy:
            // - Mode A (EB open, normal on-screen window): try CDP tap first — it
            //   fires real mouse events at the exact pixel.  Fall back to JS click
            //   if CDP fails.
            // - Mode B (off-screen background window): skip CDP tap entirely.
            //   CDP Input events dispatched to a window positioned beyond the
            //   screen edge are silently swallowed by the OS hit-testing layer on
            //   Windows.  cdpTapGesture() doesn't throw in that case — it just
            //   returns success without the click reaching the DOM.  JS click()
            //   bypasses all coordinate/OS hit-testing and is 100% reliable for
            //   off-screen windows.
            const sfDbg = sfWin.webContents.debugger;
            let dbgAttached = false;
            const useCdp = !sfTempWin; // mode A only
            try {
              if (useCdp) {
                try { sfDbg.attach("1.3"); dbgAttached = true; } catch {}
              }
              let cdpOk = false;
              if (dbgAttached) {
                try { await cdpTapGesture(sfDbg, tapX, tapY); cdpOk = true; } catch {}
              }
              // Always also fire JS click — harmless if CDP already worked, essential
              // in mode B and as a safety net when CDP tap is swallowed silently.
              await Promise.race([
                sfWin.webContents.executeJavaScript(`
                  (function() {
                    var btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(function(b) {
                      if (b.disabled) return false;
                      var l = ((b.getAttribute ? b.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                      var t = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                      if (l && (l === 'follow' || l === 'follow back' || (l.startsWith('follow ') && !l.startsWith('following') && !l.startsWith('follow request')))) return true;
                      return t === 'follow' || t === 'follow back';
                    });
                    if (btn) { btn.click(); return true; }
                    return false;
                  })()
                `, true).catch(() => false),
                new Promise<boolean>(r => setTimeout(() => r(false), 3_000)),
              ]);
              _ipcLog(`[eb:silent-follow:${pid}] click dispatched (cdp=${cdpOk}, js=always, tap=${tapX},${tapY})`);

              // Confirm state change to Following/Requested.
              // Wait up to 30 seconds — Instagram's UI can be slow on proxied
              // connections and there is no benefit to timing out early.
              let confirmed = false;
              const confirmDeadline = Date.now() + 30_000;
              while (Date.now() < confirmDeadline) {
                await new Promise(r => setTimeout(r, 300));
                const state: any = await Promise.race([
                  sfWin.webContents.executeJavaScript(`
                    (function() {
                      var cands = Array.from(document.querySelectorAll('button, [role="button"]'));
                      var done = cands.some(function(b) {
                        var l = ((b.getAttribute ? b.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                        var t = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                        return (l && (l.startsWith('following') || l.startsWith('requested') || l.startsWith('follow request'))) || t === 'following' || t === 'requested';
                      });
                      var stillFollow = cands.some(function(b) {
                        var l = ((b.getAttribute ? b.getAttribute('aria-label') : '') || '').toLowerCase().trim();
                        var t = (b.innerText || b.textContent || '').replace(/\\s+/g, ' ').toLowerCase().trim();
                        return (l && (l === 'follow' || l === 'follow back' || (l.startsWith('follow ') && !l.startsWith('following') && !l.startsWith('follow request')))) || t === 'follow' || t === 'follow back';
                      });
                      return { done: done, stillFollow: stillFollow };
                    })()
                  `, true).catch(() => null),
                  new Promise<null>(r => setTimeout(() => r(null), 2_000)),
                ]);
                if (state?.done) { confirmed = true; break; }
                if (!state?.stillFollow && !state?.done) { confirmed = true; break; }
              }

              if (!confirmed) {
                // The click fired but Instagram's UI never flipped to "Following".
                // Do NOT count this as a follow — return failure so the engine
                // does not log a follow that never happened.
                _ipcLog(`[WARN] [eb:silent-follow:${pid}] click sent but Following state NOT confirmed for @${targetUsername} — returning failure`);
                sfRestoreUrl();
                return sfRespond(200, { ok: false, status: "follow_blocked", reason: "tap_not_confirmed — click fired but Instagram did not register the follow" });
              }
            } finally {
              if (dbgAttached) try { sfDbg.detach(); } catch {}
            }

            _ipcLog(`[eb:silent-follow:${pid}] followed @${targetUsername} ✓ (tap ${tapX},${tapY} confirmed)`);
            sfRestoreUrl();
            return sfRespond(200, { ok: true });

          } else if (btnInfo?.alreadyFollowing) {
            _ipcLog(`[eb:silent-follow:${pid}] already following @${targetUsername}`);
            sfRestoreUrl();
            return sfRespond(200, { ok: true, status: "already_following", reason: "Already following" });

          } else {
            // Button not found. If context was destroyed (outer timeout), bail fast.
            if ((btnInfo as any)?.contextDestroyed) {
              _ipcLog(`[WARN] [eb:silent-follow:${pid}] Follow button not found — renderer context destroyed (outer 25s timeout). Restoring URL.`);
              sfRestoreUrl();
              return sfRespond(200, { ok: false, status: "follow_blocked", reason: "Follow button not found on page" });
            }

            // Context alive — do a login-wall re-check: initial check may have run
            // on a partially-loaded page and returned false incorrectly.
            const _rcUrl: string = (() => { try { return sfWin.webContents.getURL(); } catch { return ""; } })();
            const _rcIsLoginUrl = /instagram\.com(?:\/[a-z]{2}(?:-[a-z]{2})?)?\/accounts\/login/i.test(_rcUrl)
              || _rcUrl.includes("/accounts/onetap/")
              || _rcUrl.includes("/accounts/suspended/");
            const _rcIsLoginDom: boolean = _rcIsLoginUrl ? false : await Promise.race([
              sfWin.webContents.executeJavaScript(`
                (function() {
                  var pwdInput = document.querySelector('input[type="password"]');
                  if (pwdInput && pwdInput.offsetParent !== null) return true;
                  var btns = Array.from(document.querySelectorAll('button,[role="button"]'));
                  for (var i = 0; i < btns.length; i++) {
                    var t = (btns[i].innerText || btns[i].textContent || '').trim().toLowerCase();
                    if (t === 'log in' || t.startsWith('continue as')) return true;
                  }
                  return false;
                })()
              `, true).catch(() => false),
              new Promise<false>(r => setTimeout(() => r(false), 3_000)),
            ]);
            if (_rcIsLoginUrl || _rcIsLoginDom) {
              const _rcReason = _rcIsLoginDom ? "Continue-as overlay (DOM)" : "login redirect (URL)";
              _ipcLog(`[WARN] [eb:silent-follow:${pid}] SESSION EXPIRED (re-check after poll) — ${_rcReason} url="${_rcUrl.slice(0, 200)}"`);
              sfRestoreUrl();
              return sfRespond(200, { ok: false, status: "follow_blocked", reason: "session_expired — browser session logged out" });
            }

            _ipcLog(`[WARN] [eb:silent-follow:${pid}] Follow button not found on @${targetUsername}'s page (timed out after 20s) — url="${_rcUrl.slice(0, 200)}"`);
            sfRestoreUrl();
            return sfRespond(200, { ok: false, status: "follow_blocked", reason: "Follow button not found on page" });
          }
        } catch (sfErr: any) {
          _ipcLog(`[ERROR] [eb:silent-follow:${pid}] error: ${sfErr?.message}`);
          sfRestoreUrl();
          return sfRespond(200, { ok: false, status: "follow_blocked", reason: sfErr?.message ?? "Unknown error" });
        } finally {
          _sfInProgress.delete(pid);
          _ipcLog(`[eb:silent-follow:${pid}] done (in-progress cleared)`);
        }
      }

      // ── POST /eb/silent-post ───────────────────────────────────────────────────
      // Performs a browser-based Instagram post using the embedded browser.
      //
      // Mode A: EB window already open for this profile → reuse it.
      //   The visible browser navigates through the post flow, then restores
      //   the previous URL when done.
      //
      // Mode B: No EB window open → create a temporary off-screen 1280×820
      //   window using the same persist: partition (which holds the account's
      //   Instagram cookies from the last EB login).  Destroyed when done.
      //
      // Navigation flow (matches Instagram's current desktop web UI):
      //   1. Navigate to https://www.instagram.com/
      //   2. Hover over the "+" Create button in the left sidebar
      //   3. Click "Create" from the expanded nav menu
      //   4. Click "Post" from the submenu
      //   5. Inject image via CDP DOM.setFileInputFiles on the hidden file input
      //   6. Next (crop) → Next (filter) → type caption → Share
      //   7. Wait for "Your post has been shared" confirmation
      //   8. Mode A: restore prevUrl; Mode B: destroy temp window
      if (req.method === "POST" && u.pathname === "/eb/silent-post") {
        const imageBase64: string = body.imageBase64 ?? "";
        const caption: string     = String(body.caption ?? "");
        if (!pid || !imageBase64) return send(res, 400, { error: "profileId and imageBase64 required" });

        const tmpPath = path.join(_cookiesDir, `silent-post-${pid}-${Date.now()}.jpg`);
        try { fs.writeFileSync(tmpPath, Buffer.from(imageBase64, "base64")); }
        catch (we: any) { return send(res, 500, { ok: false, message: `Failed to write temp image: ${we?.message}` }); }

        // ── Mode A vs Mode B ────────────────────────────────────────────────
        const spEbEntry = ebMap.get(pid);
        const spEbIsOpen = !!(spEbEntry && !spEbEntry.win.isDestroyed());
        let spWin: BrowserWindow;
        let spTempWin: BrowserWindow | null = null;

        // Safety net: if anything in Mode B window setup throws before spCleanup
        // is defined, make sure the temp file is always deleted.
        let _spTmpUnlinked = false;
        const _spSafeUnlink = () => { if (!_spTmpUnlinked) { _spTmpUnlinked = true; try { fs.unlinkSync(tmpPath); } catch {} } };

        if (spEbIsOpen) {
          // Mode A — reuse the existing open EB window (user will see it move)
          spWin = spEbEntry!.win;
          _ipcLog(`[eb:silent-post:${pid}] mode A — reusing open EB window`);
        } else {
          // Mode B — off-screen 1280×820 window with same persist: partition
          const spPartition = `persist:eb-${pid}`;
          const spSes = electronSession.fromPartition(spPartition);

          // Inject cookies from the account's cookie file so the hidden window
          // is authenticated before the first navigation
          try {
            const cfPath = cookieFilePath(pid);
            if (fs.existsSync(cfPath)) {
              const rawCookies: any[] = JSON.parse(fs.readFileSync(cfPath, "utf8"));
              for (const c of rawCookies) {
                await spSes.cookies.set({
                  url: "https://www.instagram.com",
                  name: c.name, value: c.value,
                  domain: c.domain ?? ".instagram.com",
                  path:   c.path   ?? "/",
                  secure: true, sameSite: "no_restriction",
                }).catch(() => {});
              }
            }
          } catch { /* rely on partition cookies */ }

          // ── Hard proxy gate ──────────────────────────────────────────────────
          // Every account MUST route through its assigned proxy.  If the proxy
          // cannot be resolved or set we ABORT — never proceed on the home IP.
          let _spUA: string | undefined;
          let _spApiUA: string | undefined;
          let _spFingerprint: EbFingerprintLite | null = null;
          let _spProxyCreds: { user?: string; pass?: string } | null = null;
          try {
            const proxyRes = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${pid}/eb-proxy`);
            if (!proxyRes.ok) throw new Error(`eb-proxy fetch returned ${proxyRes.status}`);
            const pd: any = await proxyRes.json();
            if (!pd.proxy?.host || !pd.proxy?.port) {
              _spSafeUnlink();
              _ipcLog(`[ERROR] [eb:silent-post:${pid}] mode B — no proxy configured for this account; action aborted to prevent real IP leak`);
              return send(res, 400, { error: `No proxy configured for account ${pid} — action aborted to prevent real IP leak` });
            }
            _spProxyCreds = { user: pd.proxy.user, pass: pd.proxy.pass };
            await spSes.clearHostResolverCache().catch(() => {});
            await spSes.setProxy(buildProxyConfig(pd.proxy));
            if (pd.userAgent) _spUA = pd.userAgent;
            if (pd.apiUA) _spApiUA = pd.apiUA;
            if (pd.ebFingerprint) _spFingerprint = pd.ebFingerprint;
          } catch (proxyErr: any) {
            _spSafeUnlink();
            _ipcLog(`[ERROR] [eb:silent-post:${pid}] mode B — proxy fetch/set failed; action aborted to prevent real IP leak: ${proxyErr?.message}`);
            return send(res, 500, { error: `Proxy setup failed for account ${pid} — action aborted to prevent real IP leak: ${proxyErr?.message}` });
          }

          const { width: _spSw } = eScreen.getPrimaryDisplay().workAreaSize;
          spTempWin = new BrowserWindow({
            width: 1280, height: 820,
            x: _spSw + 10, y: 0, // off right edge — never visible
            show: false, skipTaskbar: true,
            webPreferences: {
              nodeIntegration: false, contextIsolation: true,
              sandbox: true,          // prevent window.require leak
              partition: spPartition,
              backgroundThrottling: false,
            },
          });
          // showInactive before first navigation so Chromium doesn't throttle
          spTempWin.showInactive();
          // Supply proxy credentials for 407 challenges.  Without this handler
          // Electron cancels the auth challenge and the request falls through
          // to the machine's real IP — silently leaking home broadband to Instagram.
          spTempWin.webContents.on("login", (event: any, _rq: any, _auth: any, cb: any) => {
            event.preventDefault();
            cb(_spProxyCreds?.user ?? "", _spProxyCreds?.pass ?? "");
          });
          // Apply the account's real fingerprint/UA BEFORE the first navigation —
          // otherwise this window runs with Electron's raw default fingerprint,
          // a mismatch from the mobile identity Instagram associated with this
          // account's sessionid at login (see armSilentWindowAntiDetection doc).
          await armSilentWindowAntiDetection(spTempWin, {
            browserUA: _spUA ?? null,
            apiUA: _spApiUA ?? null,
            ebFingerprint: _spFingerprint ?? null,
          });
          if (_spUA) spTempWin.webContents.setUserAgent(_spUA);
          spWin = spTempWin;
          _ipcLog(`[eb:silent-post:${pid}] mode B — created off-screen 1280×820 window`);
        }

        // Remember previous URL (mode A: restore when done; mode B: N/A)
        const spPrevUrl = spEbIsOpen ? (() => {
          try { const u2 = spWin.webContents.getURL(); return u2 && u2 !== "about:blank" ? u2 : "https://www.instagram.com/"; } catch { return "https://www.instagram.com/"; }
        })() : "https://www.instagram.com/";

        const spCleanup = () => {
          if (spTempWin) {
            try { if (!spTempWin.isDestroyed()) spTempWin.destroy(); } catch {}
            spTempWin = null;
          } else {
            // Mode A: navigate back to where the user was
            try { spWin.webContents.loadURL(spPrevUrl).catch(() => {}); } catch {}
          }
          _spSafeUnlink(); // idempotent — safe to call multiple times
        };

        let spSettled = false;
        const spWatchdog = setTimeout(() => {
          if (spSettled) return;
          spSettled = true;
          _ipcLog(`[ERROR] [eb:silent-post:${pid}] WATCHDOG — handler exceeded 120s`);
          spCleanup();
          try { send(res, 200, { ok: false, message: "watchdog_timeout — post took too long" }); } catch {}
        }, 120_000);

        try {
          // ── Attach CDP debugger ───────────────────────────────────────────
          const dbg = spWin.webContents.debugger;
          try { dbg.attach("1.3"); } catch { /* already attached */ }
          // Race with a 8s timeout so a newly-created window that isn't yet
          // ready for CDP doesn't block the handler for the full 120s watchdog.
          await Promise.race([
            dbg.sendCommand("DOM.enable").catch(() => {}),
            new Promise(r => setTimeout(r, 8000)),
          ]);

          // ── Navigate to Instagram homepage ────────────────────────────────
          _ipcLog(`[eb:silent-post:${pid}] navigating to instagram.com homepage`);
          await Promise.race([
            spWin.webContents.loadURL("https://www.instagram.com/").catch(() => {}),
            new Promise(r => setTimeout(r, 30_000)),
          ]);

          // ── Wait until logged in ──────────────────────────────────────────
          const spLoggedIn = await new Promise<boolean>(resolve => {
            let tries = 0;
            const t = setInterval(() => {
              const url = spWin.isDestroyed() ? "" : spWin.webContents.getURL();
              if (url.includes("instagram.com") && !url.includes("/accounts/login") && !url.includes("/auth_platform/") && url !== "about:blank") {
                clearInterval(t); resolve(true); return;
              }
              if (++tries >= 60) { clearInterval(t); resolve(false); }
            }, 500);
          });
          if (!spLoggedIn) throw new Error("Instagram page not ready — account not logged in");

          // Force visibilityState=visible so Instagram's SPA actually hydrates
          // the left nav even when the EB window is off-screen/not shown to
          // the user. Without this, Chrome reports visibilityState="hidden" →
          // Instagram suppresses hydration of nav buttons → every selector for
          // the Create button comes back empty even though the page "loaded".
          // Same fix already applied to viewTimelineFeed / likeTimelinePosts /
          // the Follow button and story tray flows in automationEngine.ts —
          // was missing here, which is why this flow always failed at
          // "Could not find Create button" regardless of click mechanism.
          await spWin.webContents.executeJavaScript(`
            (function() {
              try { Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true }); } catch (e) {}
              try { Object.defineProperty(document, 'hidden', { get: () => false, configurable: true }); } catch (e) {}
              document.dispatchEvent(new Event('visibilitychange'));
            })()
          `, true).catch(() => {});

          // Allow the left sidebar nav to fully render
          await new Promise(r => setTimeout(r, 1000));

          // ── Step 1 + 2: Poll for the Create ("+" plus) button, hover it, then
          // click it — combined into ONE retry loop (up to 20s).
          //
          // BUG HISTORY: this used to be a single fixed 3s sleep followed by a
          // ONE-SHOT selector check with no retry — every other wait in this
          // same flow (file input, Next, Share, Done — see spClickBtnText and
          // spFileInputFound below) already used a proper poll-until-found loop.
          // That inconsistency was the actual root cause of the intermittent
          // "Could not find Create button" failures: a hard navigation to
          // instagram.com/ can take longer than 3s to hydrate the left nav
          // depending on proxy latency/machine speed, so the one-shot check
          // would sometimes run before the sidebar existed at all — with no
          // retry, it failed immediately and the cleanup step then reloaded
          // the previous URL, which is exactly what looked like "hovers over
          // Create, then the homepage just refreshes" to the user.
          // This does NOT retry the actual post/click action against Instagram
          // multiple times — it only waits for the UI to be ready, then performs
          // exactly one hover + one click, same as every other step here.
          _ipcLog(`[eb:silent-post:${pid}] locating Create button (poll up to 20s)`);
          const spFindCreateJs = `
            (function() {
              var btn = null;
              // 1. aria-label exact matches (most reliable when sidebar is expanded)
              btn = document.querySelector('[aria-label="New post"], [aria-label="Create"], [aria-label="create"]');
              // 2. Broad aria-label substring — catches "Create" inside longer labels
              if (!btn) btn = document.querySelector('[aria-label*="reate"]');
              // 3. href-based
              if (!btn) btn = document.querySelector('a[href="/create/"], a[href*="/create"]');
              // 4. Visible text "Create" in any span/anchor (sidebar expanded)
              if (!btn) {
                var spans = Array.from(document.querySelectorAll('nav span, [role="navigation"] span, a span, div span'));
                var createSpan = spans.find(function(s) { return s.textContent.trim() === 'Create' && s.offsetHeight > 0; });
                if (createSpan) btn = createSpan.closest('a, [role="link"], [role="button"], button') || createSpan;
              }
              // 5. Any element (including collapsed icons) whose accessible text is "Create"
              if (!btn) {
                var els = Array.from(document.querySelectorAll('a, [role="link"], [role="button"], button'));
                btn = els.find(function(el) {
                  var lbl = (el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
                  return lbl === 'create' || lbl === 'new post' || lbl.includes('create post');
                }) || null;
              }
              // 6. SVG title matching
              if (!btn) {
                var titles = Array.from(document.querySelectorAll('svg title'));
                var ct = titles.find(function(t) { var tx = (t.textContent || '').toLowerCase(); return tx === 'create' || tx.includes('new post'); });
                if (ct) btn = ct.closest('a, [role="link"], button') || null;
              }
              if (!btn || btn.offsetHeight === 0) return { found: false, x: 0, y: 0 };
              var rect = btn.getBoundingClientRect();
              return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
            })()
          `;
          // Helper: dispatch a REAL trusted click via CDP at (x, y) — mousePressed
          // then mouseReleased. Confirmed root cause (v1.1.353 log evidence:
          // "found the Create button but the click never registered" on every
          // single attempt, for every account): the hover mousemove is a real
          // CDP-dispatched event (isTrusted=true) and visibly worked, but the
          // click was a synthetic in-page element.click()/PointerEvent
          // (isTrusted=false always, per spec — script-dispatched events can
          // never be trusted). Instagram's Create button silently ignores
          // untrusted clicks on this specific control, which is exactly why
          // hovering "highlighted" it but nothing else ever happened. This
          // same real-CDP-click pattern is already used elsewhere in this file
          // (ghost-signup nav, cookie banner dismissal) for the same reason.
          const spRealClick = async (x: number, y: number) => {
            await dbg.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed", x, y, button: "left", clickCount: 1,
            }).catch(() => {});
            await new Promise(r => setTimeout(r, 60));
            await dbg.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased", x, y, button: "left", clickCount: 1,
            }).catch(() => {});
          };

          let spClickedCreate = false;
          let spCreateOpenedDialogDirectly = false;
          const spCreateDeadline = Date.now() + 20_000;
          let spLastFoundButNotClicked = false;
          while (Date.now() < spCreateDeadline) {
            if (spWin.isDestroyed()) break;
            const spCreatePos: { x: number; y: number; found: boolean } =
              await spWin.webContents.executeJavaScript(spFindCreateJs, true).catch(() => ({ found: false, x: 0, y: 0 }));

            if (spCreatePos.found) {
              spLastFoundButNotClicked = true;
              // Dispatch a mousemove to the button's centre — triggers sidebar expansion
              await dbg.sendCommand("Input.dispatchMouseEvent", {
                type: "mouseMoved", x: spCreatePos.x, y: spCreatePos.y,
                button: "none", clickCount: 0,
              }).catch(() => {});
              await new Promise(r => setTimeout(r, 800)); // wait for hover/expand animation

              // Re-fetch the position AFTER the hover animation — the sidebar
              // expands on hover (icon-only → icon+text), which shifts the
              // button's centre. Clicking the stale pre-hover coordinate can
              // miss the button entirely even though it was "found".
              const spFreshPos: { x: number; y: number; found: boolean } =
                await spWin.webContents.executeJavaScript(spFindCreateJs, true).catch(() => ({ found: false, x: 0, y: 0 }));
              const clickX = spFreshPos.found ? spFreshPos.x : spCreatePos.x;
              const clickY = spFreshPos.found ? spFreshPos.y : spCreatePos.y;

              _ipcLog(`[eb:silent-post:${pid}] clicking Create nav item at (${clickX}, ${clickY}) via trusted CDP click`);
              await spRealClick(clickX, clickY);
              await new Promise(r => setTimeout(r, 700));

              // Verify the click actually did something. This UI has two
              // observed behaviours depending on Instagram's current
              // rollout/account bucket:
              //   (a) a dropdown appears with a "Post" menu item that must be
              //       clicked separately (older/desktop-width layout), or
              //   (b) clicking "Create" opens the "Create new post" upload
              //       dialog DIRECTLY — no intermediate "Post" menu item ever
              //       appears at all.
              // v1.1.358: previously this only checked for case (a). When an
              // account hit case (b), the check for "Post" text never
              // matched, the code assumed the click failed, and it re-clicked
              // Create over and over for 20s before giving up with "found
              // the Create button and clicked it, but the Post dropdown
              // never opened" — even though the upload dialog was already
              // open and waiting the whole time. Now we detect either case.
              const spMenuOrDialogState: { menu: boolean; dialog: boolean } = await spWin.webContents.executeJavaScript(`
                (function() {
                  var all = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], a, span'));
                  var menu = all.some(function(el) { return el.textContent.trim() === 'Post' && el.offsetHeight > 0; });
                  var bodyText = document.body.innerText || '';
                  var dialog = /select from computer/i.test(bodyText) || /create new post/i.test(bodyText) || /drag (photos|photo) and videos here/i.test(bodyText);
                  return { menu: menu, dialog: dialog };
                })()
              `, true).catch(() => ({ menu: false, dialog: false }));

              if (spMenuOrDialogState.menu || spMenuOrDialogState.dialog) {
                spClickedCreate = true;
                spCreateOpenedDialogDirectly = spMenuOrDialogState.dialog && !spMenuOrDialogState.menu;
                break;
              }
              // Click didn't open the menu or dialog — loop again (re-find + re-hover + re-click).
            }
            await new Promise(r => setTimeout(r, 500));
          }

          if (!spClickedCreate) {
            const reason = spLastFoundButNotClicked
              ? "found the Create button and clicked it, but neither the Post dropdown nor the upload dialog ever opened"
              : "the Create button never appeared in the Instagram left nav after 20s — is the account logged in?";
            throw new Error(`Could not click Create button — ${reason}`);
          }
          await new Promise(r => setTimeout(r, 500));

          // ── Step 3: Click "Post" from the submenu (skipped if Create already
          // opened the upload dialog directly — see v1.1.358 note above) ─────
          if (spCreateOpenedDialogDirectly) {
            _ipcLog(`[eb:silent-post:${pid}] Create opened the upload dialog directly — no Post submenu on this account, skipping`);
          } else {
            // Same fix as Step 1: use a real trusted CDP click, and poll up to
            // 10s in case the dropdown is still animating in.
            _ipcLog(`[eb:silent-post:${pid}] clicking Post from submenu`);
            const spFindPostJs = `
              (function() {
                var all = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="option"], a, span'));
                var postItem = all.find(function(el) {
                  return el.textContent.trim() === 'Post' && el.offsetHeight > 0;
                });
                if (!postItem) return { found: false, x: 0, y: 0 };
                var clickable = postItem.closest('button, a, [role="menuitem"]') || postItem;
                clickable.scrollIntoView({ behavior: 'instant', block: 'center' });
                var rect = clickable.getBoundingClientRect();
                return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
              })()
            `;
            let spClickedPost = false;
            const spPostDeadline = Date.now() + 10_000;
            while (Date.now() < spPostDeadline) {
              if (spWin.isDestroyed()) break;
              const spPostPos: { x: number; y: number; found: boolean } =
                await spWin.webContents.executeJavaScript(spFindPostJs, true).catch(() => ({ found: false, x: 0, y: 0 }));
              if (spPostPos.found) {
                await spRealClick(spPostPos.x, spPostPos.y);
                await new Promise(r => setTimeout(r, 600));
                spClickedPost = true;
                break;
              }
              // While waiting for the "Post" item, also re-check whether the
              // upload dialog appeared directly in the meantime (some
              // accounts show a brief empty dropdown before redirecting
              // straight into the dialog).
              const spDialogAppeared: boolean = await spWin.webContents.executeJavaScript(`
                (function() {
                  var bodyText = document.body.innerText || '';
                  return /select from computer/i.test(bodyText) || /create new post/i.test(bodyText);
                })()
              `, true).catch(() => false);
              if (spDialogAppeared) { spClickedPost = true; break; }
              await new Promise(r => setTimeout(r, 400));
            }

            if (!spClickedPost) throw new Error("Could not find Post option in the Create submenu");
          }
          await new Promise(r => setTimeout(r, 2000));

          // ── Step 4: Click "Select from Computer", then inject image via CDP ─
          // v1.1.357 root-cause fix: clicking "Select from Computer" is a REAL
          // trusted click on a control wired to a native <input type="file">.
          // A real trusted click on that control does not just "wire up" a
          // hidden input for us to inject into later — it makes Chromium try
          // to open the actual OS-native file-picker dialog, exactly like a
          // human clicking it would. In an automated/hidden Electron window
          // nothing is there to interact with that native dialog, so it sits
          // open forever; the page underneath never receives a file, and
          // whatever outer watchdog/retry logic is driving this call
          // eventually times out and reloads the page — which is exactly the
          // "circles back to the homepage, refreshes, then recycles" symptom
          // reported in production. Confirmed by the attached page source:
          // the <input type="file"> already exists in the DOM on the initial
          // drag-and-drop screen, before the button is ever clicked — so
          // "wait for a file input to appear" always passed instantly and hid
          // the real problem, which is the native dialog opening afterward.
          //
          // Fix: use CDP's Page.setInterceptFileChooserDialog. This tells
          // Chromium to intercept the file chooser BEFORE it becomes a real
          // OS dialog and instead emit a Page.fileChooserOpened event with
          // the backendNodeId of the input that triggered it. We answer that
          // event directly with DOM.setFileInputFiles — the native dialog is
          // never shown, so there is nothing left to hang or time out on.
          _ipcLog(`[eb:silent-post:${pid}] arming file-chooser interception`);
          await dbg.sendCommand("Page.enable").catch(() => {});
          await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: true });

          const spFileChooserPromise = new Promise<number | null>(resolve => {
            let settled = false;
            const onMessage = (_event: any, method: string, params: any) => {
              if (method !== "Page.fileChooserOpened" || settled) return;
              settled = true;
              dbg.removeListener("message", onMessage);
              resolve(typeof params?.backendNodeId === "number" ? params.backendNodeId : null);
            };
            dbg.on("message", onMessage);
            setTimeout(() => {
              if (settled) return;
              settled = true;
              dbg.removeListener("message", onMessage);
              resolve(null);
            }, 15_000);
          });

          _ipcLog(`[eb:silent-post:${pid}] clicking "Select from Computer"`);
          const spFindSelectComputerJs = `
            (function() {
              var all = Array.from(document.querySelectorAll('button, [role="button"]'));
              var btn = all.find(function(el) {
                var t = (el.textContent || '').trim();
                return (t === 'Select from computer' || t === 'Select From Computer' || t === 'Select from Computer') && el.offsetHeight > 0;
              });
              if (!btn) return { found: false, x: 0, y: 0 };
              btn.scrollIntoView({ behavior: 'instant', block: 'center' });
              var rect = btn.getBoundingClientRect();
              return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
            })()
          `;
          let spClickedSelectComputer = false;
          const spSelectComputerDeadline = Date.now() + 15_000;
          while (Date.now() < spSelectComputerDeadline) {
            if (spWin.isDestroyed()) break;
            const spPos: { x: number; y: number; found: boolean } =
              await spWin.webContents.executeJavaScript(spFindSelectComputerJs, true).catch(() => ({ found: false, x: 0, y: 0 }));
            if (spPos.found) {
              await spRealClick(spPos.x, spPos.y);
              spClickedSelectComputer = true;
              break;
            }
            await new Promise(r => setTimeout(r, 400));
          }
          if (!spClickedSelectComputer) {
            await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
            throw new Error('Could not find "Select from Computer" button — Create new post dialog did not open');
          }

          _ipcLog(`[eb:silent-post:${pid}] waiting for intercepted file chooser`);
          const spBackendNodeId = await spFileChooserPromise;
          await dbg.sendCommand("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          if (spBackendNodeId == null) {
            throw new Error("File chooser never opened after clicking \"Select from Computer\" (native dialog interception timed out)");
          }
          await dbg.sendCommand("DOM.setFileInputFiles", {
            files: [tmpPath],
            backendNodeId: spBackendNodeId,
          });
          _ipcLog(`[eb:silent-post:${pid}] image injected via intercepted file chooser`);
          await new Promise(r => setTimeout(r, 2500));

          // ── Helper: find a visible button's centre coords by exact text ────
          const spFindBtnPos = async (text: string): Promise<{ found: boolean; x: number; y: number }> =>
            spWin.webContents.executeJavaScript(`
              (function(t) {
                var all = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"]'));
                var btn = all.find(function(el) { return (el.textContent || '').trim() === t && el.offsetHeight > 0; });
                if (!btn) return { found: false, x: 0, y: 0 };
                btn.scrollIntoView({ behavior: 'instant', block: 'center' });
                var rect = btn.getBoundingClientRect();
                return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
              })(${JSON.stringify(text)})
            `, true).catch(() => ({ found: false, x: 0, y: 0 }));

          // ── Helper: poll-click a button by its exact visible text, using a
          // real trusted CDP click (see spRealClick above — the root cause of
          // every prior "Make a Post" failure at every step was Instagram
          // silently ignoring synthetic/untrusted clicks). After clicking,
          // confirms the SAME button is gone from screen before declaring
          // success — if it's still there, the click didn't register and we
          // click again. Safe to auto-retry for idempotent nav buttons
          // (Next) since re-clicking "Next" twice on the same screen has no
          // side effect. NOT used for Share (see spClickBtnTextOnce below) to
          // avoid any risk of double-posting.
          const spClickBtnText = async (text: string, timeoutMs: number): Promise<boolean> => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (spWin.isDestroyed()) return false;
              const pos = await spFindBtnPos(text);
              if (pos.found) {
                await spRealClick(pos.x, pos.y);
                await new Promise(r => setTimeout(r, 900));
                const stillThere = await spFindBtnPos(text);
                if (!stillThere.found) return true;
                // Button still on screen — click didn't register, or Instagram
                // hasn't transitioned yet. Loop and try again.
              }
              await new Promise(r => setTimeout(r, 500));
            }
            return false;
          };

          // ── Helper: find + click a button exactly once (no auto-retry).
          // Used for Share/Done where a duplicate click carries real risk
          // (double-posting). Callers are expected to verify success
          // separately (e.g. the "post shared" confirmation poll below).
          const spClickBtnTextOnce = async (text: string, timeoutMs: number): Promise<boolean> => {
            const deadline = Date.now() + timeoutMs;
            while (Date.now() < deadline) {
              if (spWin.isDestroyed()) return false;
              const pos = await spFindBtnPos(text);
              if (pos.found) {
                await spRealClick(pos.x, pos.y);
                return true;
              }
              await new Promise(r => setTimeout(r, 500));
            }
            return false;
          };

          // ── Crop step → Next ──────────────────────────────────────────────
          _ipcLog(`[eb:silent-post:${pid}] clicking Next (crop)`);
          if (!await spClickBtnText("Next", 12000)) throw new Error("Crop Next button not found");
          await new Promise(r => setTimeout(r, 2000));

          // ── Filter step → Next ────────────────────────────────────────────
          _ipcLog(`[eb:silent-post:${pid}] clicking Next (filter)`);
          await spClickBtnText("Next", 12000);
          await new Promise(r => setTimeout(r, 2000));

          // ── Caption step ──────────────────────────────────────────────────
          if (caption) {
            _ipcLog(`[eb:silent-post:${pid}] typing caption (${caption.length} chars)`);
            await spWin.webContents.executeJavaScript(`
              (function() {
                var el = document.querySelector("textarea[aria-label*='caption'], textarea[aria-label*='Caption']")
                  || document.querySelector("div[aria-label*='caption'] textarea")
                  || document.querySelector("div[contenteditable='true']")
                  || document.querySelector("textarea");
                if (el) { el.focus(); el.click(); }
              })()
            `, true).catch(() => {});
            await new Promise(r => setTimeout(r, 300));
            for (const char of caption.slice(0, 2200)) {
              await dbg.sendCommand("Input.dispatchKeyEvent", { type: "char", text: char }).catch(() => {});
            }
            // Typing "@" or "#" can leave Instagram's mention/hashtag
            // autocomplete dropdown open over the caption box. If that
            // dropdown is still up when we compute the Share button's
            // coordinates below, the real click can land on the dropdown
            // (or the photo behind it) instead of Share.
            //
            // BUG (found in production): sending Escape UNCONDITIONALLY here
            // — even when no autocomplete dropdown was actually open — was
            // caught by the "Create new post" modal itself, not by a
            // dropdown. Instagram's modal treats Escape exactly like
            // clicking the white X in the top-right corner: it discards the
            // post immediately. Since most captions never contain "@" or
            // "#", the dropdown was almost never actually open, so this was
            // silently discarding nearly every post right after typing the
            // caption. Fix: only send Escape when a mention/hashtag
            // suggestion dropdown is actually present in the DOM.
            const spDropdownOpen: boolean = await spWin.webContents.executeJavaScript(`
              (function() {
                return !!document.querySelector('[role="listbox"], [role="option"], ul[id*="mention"], div[id*="mention"]');
              })()
            `, true).catch(() => false);
            if (spDropdownOpen) {
              _ipcLog(`[eb:silent-post:${pid}] mention/hashtag dropdown detected — dismissing with Escape`);
              await dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, key: "Escape" }).catch(() => {});
              await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, key: "Escape" }).catch(() => {});
              await new Promise(r => setTimeout(r, 500));
            }
          }

          // ── Click Share ───────────────────────────────────────────────────
          // v1.1.362 fix: confirmed root cause of every prior "clicking photo
          // instead of Share" failure. The caption step renders a transparent
          // "Click photo to tag people" hit-target ([role="button"]) that sits
          // above the header in the DOM stacking order. Coordinate-based CDP
          // clicks at the Share button's (x,y) are intercepted by this overlay
          // even though Share is visually above it — z-index/stacking context
          // in Instagram's React tree puts the overlay on top of the dialog header.
          //
          // Fix: before dispatching the CDP click, use document.elementsFromPoint
          // to find every element sitting above the Share button at its click
          // coordinates and temporarily set pointer-events:none on them. The CDP
          // click then reaches the Share button directly. Pointer events are
          // restored immediately after the click so the page is left in its
          // normal state. The Share button is identified as the topmost "Share"
          // candidate by minimum getBoundingClientRect().top (header = smallest Y).
          _ipcLog(`[eb:silent-post:${pid}] clicking Share`);
          // Random per-post key so the overlay-save property on the page window
          // is not a fixed detectable name (same principle as __eq jsToken).
          const spOvlKey = '__sp' + Math.random().toString(36).slice(2, 8);
          const spShareClickOk = await (async () => {
            const deadline = Date.now() + 15_000;
            while (Date.now() < deadline) {
              if (spWin.isDestroyed()) return false;
              // Step 1: find topmost Share button, disable blocking overlays
              const spSharePrep: { found: boolean; x: number; y: number } =
                await spWin.webContents.executeJavaScript(`
                  (function() {
                    var all = Array.from(document.querySelectorAll('button, [role="button"], [type="submit"]'));
                    var candidates = all.filter(function(el) {
                      return (el.textContent || '').trim() === 'Share' && el.offsetHeight > 0;
                    });
                    if (candidates.length === 0) return { found: false, x: 0, y: 0 };
                    // Pick topmost — the header Share button has the smallest Y
                    var btn = candidates.reduce(function(a, b) {
                      return a.getBoundingClientRect().top <= b.getBoundingClientRect().top ? a : b;
                    });
                    btn.scrollIntoView({ behavior: 'instant', block: 'nearest' });
                    var rect = btn.getBoundingClientRect();
                    var cx = Math.round(rect.left + rect.width / 2);
                    var cy = Math.round(rect.top + rect.height / 2);
                    // Disable pointer-events on any elements stacked above the
                    // Share button at its click point, so the CDP click reaches
                    // the button instead of being intercepted by an overlay.
                    var stack = document.elementsFromPoint(cx, cy);
                    var saved = [];
                    for (var i = 0; i < stack.length; i++) {
                      var el = stack[i];
                      if (el === btn || el.tagName === 'HTML' || el.tagName === 'BODY') break;
                      saved.push({ el: el, prev: el.style.pointerEvents });
                      el.style.pointerEvents = 'none';
                    }
                    window['${spOvlKey}'] = saved;
                    return { found: true, x: cx, y: cy };
                  })()
                `, true).catch(() => ({ found: false, x: 0, y: 0 }));
              if (!spSharePrep.found) {
                await new Promise(r => setTimeout(r, 500));
                continue;
              }
              // Steps 2+3: trusted CDP click, then ALWAYS restore pointer-events
              // even if the click throws (try/finally guarantees restoration).
              const spRestore = () => spWin.isDestroyed() ? Promise.resolve() :
                spWin.webContents.executeJavaScript(`
                  (function() {
                    var saved = window['${spOvlKey}'] || [];
                    for (var i = 0; i < saved.length; i++) {
                      saved[i].el.style.pointerEvents = saved[i].prev;
                    }
                    delete window['${spOvlKey}'];
                  })()
                `, true).catch(() => {});
              try {
                await spRealClick(spSharePrep.x, spSharePrep.y);
              } finally {
                await spRestore();
              }
              return true;
            }
            return false;
          })();
          if (!spShareClickOk) throw new Error("Share button not found");

          // ── Wait for "Your post has been shared" confirmation ─────────────
          _ipcLog(`[eb:silent-post:${pid}] waiting for post-shared confirmation`);
          const spConfirmed = await new Promise<boolean>(resolve => {
            let tries = 0;
            const poll = setInterval(async () => {
              if (spWin.isDestroyed()) { clearInterval(poll); resolve(false); return; }
              const found: boolean = await spWin.webContents.executeJavaScript(`
                (function() {
                  var t = document.body.innerText || '';
                  return t.includes('Your post has been shared') || t.includes('Post shared');
                })()
              `, true).catch(() => false);
              if (found) { clearInterval(poll); resolve(true); return; }
              if (++tries >= 30) { clearInterval(poll); resolve(false); }
            }, 500);
          });

          if (spConfirmed) {
            _ipcLog(`[eb:silent-post:${pid}] clicking Done`);
            await spClickBtnTextOnce("Done", 5000);
            await new Promise(r => setTimeout(r, 500));
          }

          _ipcLog(`[eb:silent-post:${pid}] post completed ✓`);
          spSettled = true;
          clearTimeout(spWatchdog);
          spCleanup();
          return send(res, 200, { ok: true, mediaId: String(Date.now()) });

        } catch (spErr: any) {
          if (spSettled) return; // watchdog already responded
          spSettled = true;
          clearTimeout(spWatchdog);
          _ipcLog(`[ERROR] [eb:silent-post:${pid}] error: ${spErr?.message}`);
          spCleanup();
          return send(res, 200, { ok: false, message: spErr?.message ?? "Unknown error" });
        }
      }

      // ── POST /eb/silent-search ─────────────────────────────────────────────────
      // Performs a browser-based Instagram username search using the left-nav Search UI.
      // Types the username character-by-character into the search bar, waits for the
      // dropdown, and clicks the exact username match — exactly as a human would.
      //
      // Mode A: EB window already open → reuse it (navigate back when done).
      // Mode B: EB not open → create a temporary hidden BrowserWindow with the
      //   account's persist: partition (already holds Instagram cookies) and destroy
      //   it when done.
      if (req.method === "POST" && u.pathname === "/eb/silent-search") {
        const ssUsername: string = (body.username ?? "").trim();
        if (!pid || !ssUsername) return send(res, 400, { error: "profileId and username required" });

        const ssEbEntry = ebMap.get(pid);
        const ssEbIsOpen = !!(ssEbEntry && !ssEbEntry.win.isDestroyed());

        let ssWin: BrowserWindow;
        let ssTempWin: BrowserWindow | null = null;

        if (ssEbIsOpen) {
          ssWin = ssEbEntry!.win;
          _ipcLog(`[eb:silent-search:${pid}] mode A — reusing open EB window`);
        } else {
          const ssPartition = `persist:eb-${pid}`;
          const ssSes = electronSession.fromPartition(ssPartition);
          const rawCookies: string = (body.igApiCookies as string | null | undefined) ?? "";
          if (rawCookies) {
            const cookiePairs = rawCookies.split(";").map((s: string) => s.trim()).filter(Boolean);
            for (const pair of cookiePairs) {
              const eqIdx = pair.indexOf("=");
              if (eqIdx < 1) continue;
              const name  = pair.slice(0, eqIdx).trim();
              const value = pair.slice(eqIdx + 1).trim();
              if (!name || !value) continue;
              try {
                await ssSes.cookies.set({
                  url: "https://www.instagram.com", name, value,
                  domain: ".instagram.com", path: "/", secure: true,
                  httpOnly: name === "sessionid" || name === "csrftoken",
                  sameSite: "no_restriction" as any,
                });
              } catch {}
            }
          }
          // ── Hard proxy gate ──────────────────────────────────────────────────
          // Every account MUST route through its assigned proxy.  If no proxy
          // is present in the request body — or if Chromium rejects the config
          // — we ABORT immediately.  Silently proceeding on the home IP would
          // expose the operator's real address to Instagram.
          const bodyProxy = body.proxy as { host?: string; port?: number; user?: string; pass?: string; type?: string } | null | undefined;
          if (!bodyProxy?.host || !bodyProxy?.port) {
            _ipcLog(`[ERROR] [eb:silent-search:${pid}] mode B — no proxy configured for this account; action aborted to prevent real IP leak`);
            return send(res, 400, { error: `No proxy configured for account ${pid} — action aborted to prevent real IP leak` });
          }
          try {
            await ssSes.clearHostResolverCache();
            await ssSes.setProxy(buildProxyConfig(bodyProxy as any));
          } catch (proxyErr: any) {
            _ipcLog(`[ERROR] [eb:silent-search:${pid}] mode B — proxy set failed; action aborted to prevent real IP leak: ${proxyErr?.message}`);
            return send(res, 500, { error: `Proxy setup failed for account ${pid} — action aborted to prevent real IP leak: ${proxyErr?.message}` });
          }
          const { width: _ssSw } = eScreen.getPrimaryDisplay().workAreaSize;
          ssTempWin = new BrowserWindow({
            width: 1280, height: 820,
            x: _ssSw + 10, y: 0,
            show: false, skipTaskbar: true,
            webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: ssPartition, backgroundThrottling: false },
          });
          ssTempWin.showInactive();
          // Supply proxy credentials for 407 challenges.  Without this handler
          // Electron cancels the auth challenge and the request falls through
          // to the machine's real IP — silently leaking home broadband to Instagram.
          ssTempWin.webContents.on("login", (event: any, _rq: any, _auth: any, cb: any) => {
            event.preventDefault();
            cb(bodyProxy?.user ?? "", bodyProxy?.pass ?? "");
          });
          // Apply the account's real fingerprint/UA BEFORE the first navigation —
          // otherwise this window runs with Electron's raw default fingerprint,
          // a mismatch from the mobile identity Instagram associated with this
          // account's sessionid at login (see armSilentWindowAntiDetection doc).
          await armSilentWindowAntiDetection(ssTempWin, {
            browserUA: (body.userAgent as string | undefined) ?? null,
            apiUA: (body.apiUA as string | undefined) ?? null,
            ebFingerprint: body.ebFingerprint ?? null,
          });
          ssWin = ssTempWin;
          _ipcLog(`[eb:silent-search:${pid}] mode B — created off-screen window for "${ssUsername}"`);
        }

        const ssPrevUrl = ssEbIsOpen ? (() => {
          try { const u2 = ssWin.webContents.getURL(); return (u2 && u2 !== "about:blank") ? u2 : "https://www.instagram.com/"; } catch { return "https://www.instagram.com/"; }
        })() : "https://www.instagram.com/";

        const ssCleanup = () => {
          if (ssTempWin) { try { if (!ssTempWin.isDestroyed()) ssTempWin.destroy(); } catch {} ssTempWin = null; }
          else { try { ssWin.webContents.loadURL(ssPrevUrl).catch(() => {}); } catch {} }
        };

        let ssSettled = false;
        const ssWatchdog = setTimeout(() => {
          if (ssSettled) return; ssSettled = true;
          _ipcLog(`[ERROR] [eb:silent-search:${pid}] WATCHDOG — exceeded 60s for "${ssUsername}"`);
          ssCleanup();
          try { send(res, 200, { ok: false }); } catch {}
        }, 60_000);

        const ssRespond = (status: number, payload: any) => {
          if (ssSettled) return; ssSettled = true;
          clearTimeout(ssWatchdog); send(res, status, payload);
        };

        try {
          // Ensure we're on instagram.com so the left-nav search button is present.
          const currentUrl: string = (() => { try { return ssWin.webContents.getURL(); } catch { return ""; } })();
          const isOnInstagram = /instagram\.com/.test(currentUrl);
          if (!isOnInstagram) {
            _ipcLog(`[eb:silent-search:${pid}] navigating to instagram.com home`);
            await Promise.race([
              ssWin.webContents.loadURL("https://www.instagram.com/").catch(() => {}),
              new Promise(r => setTimeout(r, 20_000)),
            ]);
          }

          // Step 1: click the left-nav Search button.
          _ipcLog(`[eb:silent-search:${pid}] clicking Search nav button`);
          await Promise.race([
            ssWin.webContents.executeJavaScript(`
              (function() {
                var candidates = Array.from(document.querySelectorAll('a, [role="link"], [role="button"], button, span'));
                var btn = candidates.find(function(el) {
                  var label = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                  var href  = (el.href || el.getAttribute('href') || '').toLowerCase();
                  var text  = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').toLowerCase().trim();
                  return label === 'search' || href.includes('/search') || text === 'search';
                });
                if (btn) { btn.click(); return true; }
                return false;
              })()
            `, true).catch(() => false),
            new Promise(r => setTimeout(r, 3_000)),
          ]);

          // Wait up to 3s for the search input to appear.
          let ssInput: boolean = false;
          const ssInputDeadline = Date.now() + 3_000;
          while (Date.now() < ssInputDeadline && !ssInput) {
            await new Promise(r => setTimeout(r, 200));
            ssInput = await Promise.race([
              ssWin.webContents.executeJavaScript(`!!(document.querySelector('input[aria-label="Search input"], input[placeholder="Search"], [data-testid="search-input"], input[type="text"]'))`, true).catch(() => false),
              new Promise<boolean>(r => setTimeout(() => r(false), 500)),
            ]);
          }

          if (!ssInput) {
            _ipcLog(`[WARN] [eb:silent-search:${pid}] search input not found after clicking nav — aborting`);
            ssCleanup();
            return ssRespond(200, { ok: false });
          }

          // Step 2: focus the search input.
          await ssWin.webContents.executeJavaScript(`
            (function() {
              var inp = document.querySelector('input[aria-label="Search input"], input[placeholder="Search"], [data-testid="search-input"], input[type="text"]');
              if (inp) { inp.focus(); inp.click(); return true; }
              return false;
            })()
          `, true).catch(() => false);

          // Step 3: type the username character-by-character with random delays (50–150ms).
          _ipcLog(`[eb:silent-search:${pid}] typing "${ssUsername}" char by char`);
          for (const ch of ssUsername) {
            await ssWin.webContents.executeJavaScript(`
              (function() {
                var inp = document.querySelector('input[aria-label="Search input"], input[placeholder="Search"], [data-testid="search-input"], input[type="text"]');
                if (!inp) return;
                var nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSet.call(inp, inp.value + ${JSON.stringify(ch)});
                inp.dispatchEvent(new Event('input', { bubbles: true }));
                inp.dispatchEvent(new Event('change', { bubbles: true }));
              })()
            `, true).catch(() => {});
            await new Promise(r => setTimeout(r, 50 + Math.floor(Math.random() * 100)));
          }

          // Step 4: wait up to 5s for dropdown results to appear.
          _ipcLog(`[eb:silent-search:${pid}] waiting for search results dropdown`);
          let ssResultsReady = false;
          const ssResultsDeadline = Date.now() + 5_000;
          while (Date.now() < ssResultsDeadline && !ssResultsReady) {
            await new Promise(r => setTimeout(r, 300));
            ssResultsReady = await Promise.race([
              ssWin.webContents.executeJavaScript(`
                (function() {
                  var items = document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] a, [role="none"] a, .x9f619 a');
                  return items.length > 0;
                })()
              `, true).catch(() => false),
              new Promise<boolean>(r => setTimeout(() => r(false), 500)),
            ]);
          }

          if (!ssResultsReady) {
            _ipcLog(`[WARN] [eb:silent-search:${pid}] no results appeared for "${ssUsername}" — still returning ok (search typed)`);
            ssCleanup();
            return ssRespond(200, { ok: true }); // typing was done even if no dropdown appeared
          }

          // Step 5: click the exact username match in the dropdown.
          _ipcLog(`[eb:silent-search:${pid}] clicking exact match for "${ssUsername}" in results`);
          const ssClicked: boolean = await Promise.race([
            ssWin.webContents.executeJavaScript(`
              (function() {
                var target = ${JSON.stringify(ssUsername.toLowerCase())};
                var candidates = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] a, [role="none"] a, .x9f619 a, [tabindex="0"] span'));
                for (var i = 0; i < candidates.length; i++) {
                  var el = candidates[i];
                  var text = (el.innerText || el.textContent || '').replace(/\\s+/g,' ').toLowerCase().trim();
                  if (text === target || text.startsWith(target + '\\n') || text.startsWith(target + ' ')) {
                    el.click();
                    return true;
                  }
                }
                // Fallback: click first result
                if (candidates.length > 0) { candidates[0].click(); return true; }
                return false;
              })()
            `, true).catch(() => false),
            new Promise<boolean>(r => setTimeout(() => r(false), 3_000)),
          ]);

          _ipcLog(`[eb:silent-search:${pid}] search complete — clicked=${ssClicked}; waiting for profile page to load before restoring URL`);
          // Wait up to 6 s for the URL to change to a profile page (the click
          // triggers an SPA navigation to instagram.com/<username>/).  Only then
          // start the dwell so the account genuinely registers a profile-page
          // visit in Instagram's session telemetry.
          if (ssClicked) {
            const navDeadline = Date.now() + 6_000;
            while (Date.now() < navDeadline) {
              await new Promise(r => setTimeout(r, 300));
              const currentHref: string = await Promise.race([
                ssWin.webContents.executeJavaScript(`window.location.href`, true).catch(() => ""),
                new Promise<string>(r => setTimeout(() => r(""), 500)),
              ]);
              // SPA navigation landed when the URL is no longer the search or
              // home page — any /username/ path counts as a profile page.
              if (currentHref && !/\/search\/|instagram\.com\/?$/.test(currentHref)) {
                _ipcLog(`[eb:silent-search:${pid}] navigated to profile: ${currentHref}`);
                break;
              }
            }
            // Dwell on the profile page for 3–5 s (human-like read time).
            await new Promise(r => setTimeout(r, 3000 + Math.floor(Math.random() * 2000)));
          }
          ssCleanup();
          return ssRespond(200, { ok: true });

        } catch (ssErr: any) {
          _ipcLog(`[ERROR] [eb:silent-search:${pid}] error: ${ssErr?.message}`);
          ssCleanup();
          return ssRespond(200, { ok: false });
        }
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
        const result = await doAutoLogin(pid, e.win, body.username, body.password, body.twoFAKey ?? "", body.userAgent);
        return send(res, 200, result);
      }

      // ── GET /eb/silent-verify-status ───────────────────────────────────────────
      // Polls the result of a previously-started silent verify.
      // Returns { done: false } while still running, or the full result when done.
      // The result is deleted from the map once retrieved so memory doesn't leak.
      if (req.method === "GET" && u.pathname === "/eb/silent-verify-status") {
        const statusPid = Number(u.searchParams.get("profileId") ?? "0");
        const result = _silentVerifyResults.get(statusPid);
        if (!result) return send(res, 200, { done: false, error: "unknown" });
        if (result.done) _silentVerifyResults.delete(statusPid);
        return send(res, 200, result);
      }

      if (req.method === "POST" && u.pathname === "/eb/run-leak-test") {
        // Run the full leak page in a hidden BrowserWindow on the account's session
        // partition.  The proxy is already configured on the partition from the
        // verify flow that just completed, so all DNS / IP tests go through the
        // proxy automatically.  Instagram never sees this window — show: false.
        // The caller (browserSession.ts) passes the complete pre-rendered HTML
        // (with ACCOUNT data injected, profileId=null to suppress auto-save).
        const partition = ebPartition(pid);
        let leakWin: BrowserWindow | null = null;
        try {
          leakWin = new BrowserWindow({
            show: false,
            width: 1280,
            height: 720,
            webPreferences: {
              partition,
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,          // prevent window.require leak
              backgroundThrottling: false,
            },
          });
          // Supply proxy credentials for 407 challenges — without this the
          // leak-test requests fall through to the real machine IP, making the
          // WebRTC / DNS / IP-match results meaningless (they'd reflect the
          // home broadband, not the proxy, even though the proxy IS configured).
          leakWin.webContents.on("login", (event: any, _rq: any, _auth: any, cb: any) => {
            event.preventDefault();
            const _lkProxy = ebMap.get(pid)?.proxy;
            cb(_lkProxy?.user ?? "", _lkProxy?.pass ?? "");
          });

          // Load via data URL so no web server is needed.  Inline scripts are
          // allowed on data URLs (no server-supplied CSP can block them).
          const dataUrl = "data:text/html;charset=utf-8," + encodeURIComponent(body.html ?? "");
          await leakWin.loadURL(dataUrl);

          // Poll for _leakTestDone (set by runAll() in leaksPage.ts).  40s max.
          const deadline = Date.now() + 40_000;
          while (Date.now() < deadline) {
            await new Promise<void>(r => setTimeout(r, 500));
            const done: boolean = await leakWin.webContents
              .executeJavaScript("!!window._leakTestDone")
              .catch(() => true);
            if (done) break;
          }

          const resultsJson: string = await leakWin.webContents
            .executeJavaScript("JSON.stringify(window.RESULTS || {})")
            .catch(() => "{}");

          leakWin.destroy();
          leakWin = null;

          // Runtime-normalize: JSON.parse result is unknown — coerce each entry
          // to a safe shape before trusting .status / .label.
          const rawResults: unknown = JSON.parse(resultsJson);
          const results: Record<string, { status: string; label: string }> = {};
          if (rawResults && typeof rawResults === "object") {
            for (const [k, v] of Object.entries(rawResults as Record<string, unknown>)) {
              if (v && typeof v === "object") {
                const entry = v as Record<string, unknown>;
                results[k] = {
                  status: typeof entry.status === "string" ? entry.status : "unknown",
                  label:  typeof entry.label  === "string" ? entry.label  : String(entry.status ?? "?"),
                };
              }
            }
          }

          // ── Leak-shield sync log ─────────────────────────────────────────────
          // Shows exactly what this account's browser is exposing right now.
          // Compare these lines against the Leak Check page — they must match.
          // Statuses: pass=✓  fail=✗  warn=⚠  info=ℹ  (anything else = ?)
          const ICON: Record<string, string> = { pass: "✓", fail: "✗", warn: "⚠", info: "ℹ" };
          const KEY_ORDER = [
            "IP", "IPMatch", "WebRTC", "DNS", "UAMatch", "Bot",
            "Timezone", "Navigator", "Hardware", "Canvas", "Audio",
            "WebGL", "Fonts", "Network", "Battery", "Media",
            "Perms", "Speech", "Hints", "Timing",
          ];
          const missing = KEY_ORDER.filter(k => !results[k]);
          const fails   = KEY_ORDER.filter(k => results[k]?.status === "fail");
          const warns   = KEY_ORDER.filter(k => results[k]?.status === "warn");
          const lines   = KEY_ORDER.map(k => {
            const r = results[k];
            if (!r) return `  ${k.padEnd(10)}: — (not captured)`;
            const icon = ICON[r.status] ?? "?";
            return `  ${k.padEnd(10)}: ${icon} ${r.label}`;
          });
          // Only claim ALL CLEAR when every expected key was captured and clean.
          const headline = fails.length
            ? `✗ ${fails.length} FAIL${fails.length > 1 ? "S" : ""} — ${fails.join(", ")}`
            : warns.length
            ? `⚠ ${warns.length} WARN — ${warns.join(", ")}`
            : missing.length
            ? `⚠ INCOMPLETE — ${missing.length} checks not captured (${missing.join(", ")})`
            : `✓ ALL CLEAR (${KEY_ORDER.length}/${KEY_ORDER.length} checks)`;
          console.log(
            `[run-leak-test:${pid}] RESULTS — ${headline}\n` +
            lines.join("\n")
          );
          return send(res, 200, { ok: true, results });
        } catch (err: any) {
          if (leakWin && !leakWin.isDestroyed()) { try { leakWin.destroy(); } catch {} }
          console.error(`[run-leak-test:${pid}] error: ${err?.message}`);
          return send(res, 500, { error: err?.message });
        }
      }

      if (req.method === "POST" && u.pathname === "/eb/silent-verify") {
        console.log(`[silent-verify:${pid}] @${body.username} — handler entered`);
        const partition = ebPartition(pid);
        const ses = electronSession.fromPartition(partition);
        // setProxy has no built-in timeout and can deadlock if the Chromium network
        // service is busy — race it against a 10s abort so the handler never hangs.
        const setProxyWithTimeout = (cfg: Parameters<typeof ses.setProxy>[0]) =>
          Promise.race([
            ses.setProxy(cfg),
            new Promise<void>((_, rej) => setTimeout(() => rej(new Error("setProxy timeout (10s)")), 10_000)),
          ]);
        if (body.proxy) {
          console.log(`[silent-verify:${pid}] @${body.username} — setProxy #1 (${body.proxy.host}:${body.proxy.port})`);
          await setProxyWithTimeout(buildProxyConfig(body.proxy));
          console.log(`[silent-verify:${pid}] @${body.username} — setProxy #1 done`);
          try { await ses.clearHostResolverCache(); } catch {}
          await new Promise(r => setTimeout(r, 150));
          console.log(`[silent-verify:${pid}] @${body.username} — setProxy #2`);
          await setProxyWithTimeout(buildProxyConfig(body.proxy));
          console.log(`[silent-verify:${pid}] @${body.username} — setProxy #2 done`);
          try { (ses as any).setDnsOverHttpsConfig?.({ enabled: false }); } catch {}
        } else {
          console.log(`[silent-verify:${pid}] @${body.username} — no proxy, setting direct`);
          await setProxyWithTimeout({ proxyRules: "direct://" });
          console.log(`[silent-verify:${pid}] @${body.username} — direct proxy set done`);
        }
        try { ses.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch {}

        // ── Skip auto-login if already logged in ─────────────────────────────
        // IMPORTANT: check for an existing live sessionid BEFORE calling
        // loadCookiesFromFile.  Instagram rotates the sessionid during active
        // browsing.  If we load the file first, we silently overwrite the live
        // (current) sessionid with the stale value from the last save —
        // Instagram then sees the old sessionid value arrive mid-session and
        // fires __coig_ufac=1 (cookie integrity violation → instant ban).
        // If there is already a live session, return immediately without
        // touching any cookies at all.
        const _preCheck = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
        if (_preCheck.length > 0) {
          console.log(`[silent-verify:${pid}] @${body.username} — live sessionid found BEFORE file load — skipping loadCookiesFromFile to preserve live session`);
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

        // No live session — safe to load cookies from file (no live session to overwrite).
        console.log(`[silent-verify:${pid}] @${body.username} — no live sessionid — loading cookies from file`);
        await loadCookiesFromFile(pid, ses);
        console.log(`[silent-verify:${pid}] @${body.username} — cookies loaded`);

        // ── Pick the window to run verify in ─────────────────────────────────
        // The verify route calls /eb/open before hitting this endpoint, so the
        // EB window should already be in ebMap.  Poll briefly to let openEbWindow
        // finish registering (it fires-and-forgets from the /eb/open handler).
        {
          const _pollDeadline = Date.now() + 10_000;
          while (!ebMap.has(pid) && Date.now() < _pollDeadline) {
            await new Promise(r => setTimeout(r, 400));
          }
        }
        const _openEb    = ebMap.get(pid);
        const _useVisible = !!(_openEb && !_openEb.win.isDestroyed());
        let _hiddenWin: BrowserWindow | null = null;
        let _verifyWin: BrowserWindow;

        if (_useVisible) {
          _verifyWin = _openEb!.win;
          if (!_verifyWin.isVisible()) _verifyWin.show();
          _verifyWin.focus();
          console.log(`[silent-verify:${pid}] @${body.username} — visible EB window found, using it`);
        } else {
          // Fallback: no EB window in ebMap yet — open a visible BrowserWindow
          // so the user can watch the login flow (show: true, not hidden).
          _hiddenWin = new BrowserWindow({
            width: 1280,
            height: 820,
            show: true,
            skipTaskbar: false,
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,          // prevent window.require leak
              partition,
              backgroundThrottling: false,
            },
          });
          _verifyWin = _hiddenWin;

          void (async () => {
            try {
              try { _hiddenWin!.webContents.debugger.attach("1.3"); } catch {}
              await _hiddenWin!.webContents.debugger.sendCommand("Page.enable");
              await _hiddenWin!.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: ELECTRON_LEAK_SUPPRESSOR_JS });
              await _hiddenWin!.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: WEBRTC_BLOCKER_JS });
            } catch {}
          })();
          _hiddenWin.webContents.on("dom-ready", () => {
            _hiddenWin!.webContents.executeJavaScript(WEBRTC_BLOCKER_JS).catch(() => {});
          });
          if (body.proxy) {
            _hiddenWin.webContents.on("login", (ev: any, _rq: any, _auth: any, cb: any) => {
              ev.preventDefault();
              cb(body.proxy.user ?? "", body.proxy.pass ?? "");
            });
          }
          if (body.userAgent) {
            _hiddenWin.webContents.setUserAgent(body.userAgent);
          }
          console.log(`[silent-verify:${pid}] @${body.username} — no open EB, using hidden window`);
        }

        // ── FIRE AND FORGET — return 202 immediately ──────────────────────────
        // doAutoLogin can take several minutes. Returning 202 immediately keeps the
        // HTTP connection from timing out; the API server polls /eb/silent-verify-status.
        _silentVerifyResults.set(pid, { done: false });
        send(res, 202, { pending: true, profileId: pid });

        console.log(`[silent-verify:${pid}] @${body.username} — 202 sent, starting doAutoLogin (${_useVisible ? "visible EB" : "visible fallback window"})`);
        ;(async () => {
          try {
            // When using the visible EB window, getActiveWc returns the active
            // tab's BrowserView WebContents — NOT win.webContents which is the
            // toolbar frame.  Using the toolbar frame means doAutoLogin's CDP
            // commands run against the nav-bar HTML, not the Instagram page,
            // so the login fields are never found and cookies are never set.
            const _activeWc = _useVisible ? getActiveWc(pid) : null;
            const _loginTarget = _useVisible
              ? { webContents: _activeWc ?? _verifyWin.webContents }
              : _verifyWin;
            const _wcUrl = (() => { try { return (_loginTarget as any).webContents?.getURL?.() ?? "(no getURL)"; } catch { return "(error)"; } })();
            console.log(`[silent-verify:${pid}] @${body.username} — _loginTarget: _useVisible=${_useVisible} getActiveWc=${_activeWc ? "BrowserView" : "null"} wcUrl="${_wcUrl}"`);
            const loginResult = await doAutoLogin(pid, _loginTarget, body.username, body.password, body.twoFAKey ?? "", body.userAgent);
            const c1 = await ses.cookies.get({ domain: ".instagram.com" });
            const c2 = await ses.cookies.get({ domain: "instagram.com" });
            const seen = new Set<string>();
            const cookies = [...c1, ...c2].filter(c => {
              if (seen.has(c.name)) return false;
              seen.add(c.name);
              return true;
            }).map(c => ({ name: c.name, value: c.value }));
            console.log(`[silent-verify:${pid}] @${body.username} — doAutoLogin complete ok=${loginResult.ok}`);
            _silentVerifyResults.set(pid, { done: true, ...loginResult, cookies });
          } catch (err: any) {
            console.error(`[silent-verify:${pid}] @${body.username} — doAutoLogin threw: ${err?.message}`);
            _silentVerifyResults.set(pid, { done: true, ok: false, message: err?.message ?? "Silent verify error", cookies: [] });
          } finally {
            // Only destroy the window if we created a hidden one — never destroy
            // the user's visible EB window.
            if (_hiddenWin) {
              try { _hiddenWin.destroy(); } catch {}
            }
          }
        })();

        return; // response already sent above
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

        const ses = electronSession.fromPartition(ebPartition(pid));
        // indexdb and filesystem are intentionally included — Instagram stores
        // device tokens (mid, ig_did) in IndexedDB as a backup. Omitting indexdb
        // from the clear list causes those tokens to survive the wipe and get
        // re-set as cookies the next time Instagram loads, leaking the device
        // identity into the next session. This was the root cause of Ghost browser
        // sessions being linked to the same device after "Start from Fresh".
        await ses.clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "filesystem", "cachestorage", "shadercache", "websql", "serviceworkers"],
        }).catch(() => {});

        const fp = cookieFilePath(pid);
        try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {}

        return send(res, 200, { ok: true });
      }

      // ── POST /eb/ghost-warmup ─────────────────────────────────────────────────
      // Runs a lightweight warmup sequence on the Ghost Browser native window:
      // scrolls the Instagram feed, optionally visits reels and profile pages.
      // Progress is relayed to the API server via /api/signup/browser/warmup-step
      // so the frontend status bar updates in real time.
      if (req.method === "POST" && u.pathname === "/eb/ghost-warmup") {
        const e = ebMap.get(-1);
        if (!e || e.win.isDestroyed()) {
          return send(res, 200, { ok: false, error: "Ghost Browser is not open" });
        }
        send(res, 200, { ok: true });

        const {
          reelsMin = 1, reelsMax = 3,
          reelsIdleMin = 5, reelsIdleMax = 12,
        } = body as any;

        const randInt = (lo: number, hi: number) =>
          Math.floor(Math.random() * (hi - lo + 1)) + lo;
        const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

        const relayStep = (msg: string) => {
          if (_serverPort) {
            fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/warmup-step`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ msg }),
            }).catch(() => {});
          }
        };

        const relayDone = () => {
          if (_serverPort) {
            fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/warmup-done`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({}),
            }).catch(() => {});
          }
        };

        // Run warmup asynchronously — don't block the IPC response
        // Set warmupActive so cdpDismissGhostOverlay doesn't fire during reel viewing.
        const _warmupEntry = ebMap.get(-1);
        if (_warmupEntry) _warmupEntry.warmupActive = true;
        (async () => {
          const wc = e.win.webContents;

          // Cookie accept labels defined LOCALLY so this handler is self-contained.
          // Do NOT reference _COOKIE_ACCEPT_LABELS from openEbWindow — that variable
          // is in a different function scope and causes a ReferenceError here which
          // silently kills the warmup by jumping to the catch block.
          const WARMUP_COOKIE_LABELS = [
            'allow all cookies', 'accept all cookies',
            'allow all', 'accept all',
            'allow essential and optional cookies',
            'accept cookies', 'allow cookies',
            'alle cookies akzeptieren',
            'accepter tout', 'aceptar todo', 'accetta tutto',
            'tillåt alla', 'alle accepteren',
          ];

          // nav() waits for the page to actually finish loading.
          //
          // KEY FIXES vs the old approach:
          // 1. ERR_ABORTED (-3) is IGNORED — this fires when our loadURL() aborts
          //    an earlier in-flight navigation (e.g. openEbWindow's fire-and-forget
          //    loadURL("accounts/login/") is still pending when warmup calls
          //    loadURL("instagram.com")).  Resolving on ERR_ABORTED means nav()
          //    returns before the page is usable, causing all subsequent
          //    executeJavaScript calls to throw "Execution context destroyed".
          // 2. Named listeners — explicitly removed from BOTH paths so there are
          //    no orphaned once() handlers polluting future nav() calls.
          // 3. 1-second post-load settling gap before returning — lets the page JS
          //    context fully initialise so executeJavaScript never sees a stale ctx.
          const nav = (url: string) => new Promise<void>(resolve => {
            console.log(`[warmup] nav() START: ${url}`);
            let settled = false;
            const settle = (reason: string) => {
              if (settled) return;
              settled = true;
              wc.removeListener("did-finish-load", onFinish);
              wc.removeListener("did-fail-load",   onFail);
              clearTimeout(timer);
              console.log(`[warmup] nav() SETTLE (${reason}): ${url}`);
              // 1-second breathing room so the page JS context is ready
              setTimeout(resolve, 1000);
            };
            const onFinish = () => settle("did-finish-load");
            const onFail   = (_e: unknown, code: number, desc: string) => {
              if (code === -3) {
                // ERR_ABORTED — our loadURL cancelled an older in-flight nav,
                // or vice versa.  The page is still loading; keep waiting.
                console.log(`[warmup] nav() ERR_ABORTED (ignored, still waiting): ${url}`);
                return;
              }
              settle(`did-fail-load code=${code} desc=${desc}`);
            };
            const timer = setTimeout(() => settle("30s timeout"), 30000);
            wc.on("did-finish-load", onFinish);
            wc.on("did-fail-load",   onFail);
            wc.loadURL(url).catch((err: any) => {
              // loadURL() promise rejects when the navigation is superseded (the
              // same as ERR_ABORTED for us).  Keep waiting for did-finish-load.
              console.log(`[warmup] nav() loadURL rejected (${err?.message}), still waiting: ${url}`);
            });
          });

          const js  = (script: string) => wc.executeJavaScript(script).catch((err: any) => {
            console.log(`[warmup] executeJavaScript error (ignored): ${err?.message}`);
            return null;
          });

          const scrollFeed = () => js(`(function(){
            var dist = ${randInt(800, 2400)};
            var step  = Math.ceil(dist / 20);
            var i = 0;
            var t = setInterval(function(){
              window.scrollBy(0, step + Math.random() * 10 - 5);
              if (++i >= 20) clearInterval(t);
            }, 80 + Math.random() * 40);
          })()`);

          // Dismiss Instagram sign-up / login overlay prompts (the modal that
          // appears after a few seconds on a public profile page asking you to
          // sign up).  Uses CDP Input.dispatchMouseEvent so the click produces
          // isTrusted=true events that React's event system handles correctly.
          // The cookie banner uses the same mechanism and works reliably.
          const dismissOverlay = async () => {
            const pos = await js(`(function(){
              function rect(el){
                if(!el)return null;
                var r=el.getBoundingClientRect();
                if(r.width<=0||r.height<=0)return null;
                return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
              }
              var sels=[
                '[role="dialog"] button[aria-label="Close"]',
                '[role="dialog"] button[aria-label="close"]',
                '[role="presentation"] button[aria-label="Close"]',
                '[role="presentation"] button[aria-label="close"]',
                'button[aria-label="Close"]',
                'div[role="button"][aria-label="Close"]',
              ];
              for(var i=0;i<sels.length;i++){var p=rect(document.querySelector(sels[i]));if(p)return p;}
              // Fallback: detect "Never miss a post" / "See photos" sign-up wall by modal text,
              // then find an X/close button inside that modal (SVG-only or "Not now" label).
              var containers=Array.from(document.querySelectorAll('[role="dialog"],[role="presentation"]'));
              for(var c=0;c<containers.length;c++){
                var txt=(containers[c].innerText||containers[c].textContent||'').toLowerCase();
                if(txt.includes('sign up')||txt.includes('never miss')||txt.includes('see photos')||txt.includes('see videos')||txt.includes('log in to')){
                  var btns=Array.from(containers[c].querySelectorAll('button,div[role="button"]'));
                  for(var b=0;b<btns.length;b++){
                    var btxt=(btns[b].innerText||btns[b].textContent||'').trim().toLowerCase();
                    if(btxt===''||btxt==='×'||btxt==='✕'||btxt==='not now'||btxt==='dismiss'||btxt==='close'||(btxt.length<4&&btns[b].querySelector('svg'))){
                      var p2=rect(btns[b]);if(p2)return p2;
                    }
                  }
                  // Last resort: first button that contains only an SVG (the X icon)
                  for(var b2=0;b2<btns.length;b2++){
                    if(btns[b2].querySelector('svg')&&!(btns[b2].innerText||btns[b2].textContent||'').trim().match(/[a-z]/i)){
                      var p3=rect(btns[b2]);if(p3)return p3;
                    }
                  }
                }
              }
              return null;
            })()`);
            if (pos && typeof pos === "object" && "x" in (pos as any)) {
              const p = pos as { x: number; y: number };
              console.log(`[warmup] dismissOverlay: CDP click at (${p.x},${p.y})`);
              try { wc.debugger.attach("1.3"); } catch {}
              try {
                await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
                  type: "mousePressed", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: 0,
                });
                await sleep(80);
                await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
                  type: "mouseReleased", x: p.x, y: p.y, button: "left", clickCount: 1, modifiers: 0,
                });
                console.log(`[warmup] dismissOverlay: done`);
                await sleep(700);
              } catch (err) {
                console.log(`[warmup] dismissOverlay: CDP error: ${err}`);
              }
            } else {
              console.log(`[warmup] dismissOverlay: no overlay found`);
            }
          };

          try {
            console.log(`[warmup] START — reels:${reelsMin}-${reelsMax}`);

            // ── 0. Fetch trending reel URLs via API server (HikerAPI) BEFORE any navigation ──
            let reelUrls: string[] = [];
            if (_serverPort) {
              try {
                relayStep("Fetching trending reels…");
                const r = await fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/trending-reels?n=${reelsMax + 2}`);
                const j = await r.json() as any;
                if (Array.isArray(j.urls) && j.urls.length > 0) {
                  reelUrls = j.urls as string[];
                  relayStep(`Got ${reelUrls.length} trending reel(s) via HikerAPI ✓`);
                  console.log(`[warmup] HikerAPI reels: ${reelUrls.join(", ")}`);
                } else {
                  console.log(`[warmup] HikerAPI returned no urls: ${JSON.stringify(j)}`);
                }
              } catch (e: any) {
                console.log(`[warmup] trending-reels fetch warning: ${e?.message}`);
              }
            }
            if (reelUrls.length === 0) {
              relayStep("No HikerAPI reels — using Reels feed fallback");
              reelUrls = ["https://www.instagram.com/reels/"];
            }

            // ── 1. Wait for any in-flight navigation to settle ──────────────────────────
            if (wc.isLoading()) {
              relayStep("Waiting for browser to initialize…");
              console.log(`[warmup] initial wait: browser still loading`);
              await new Promise<void>(res => {
                let done = false;
                const finish = () => { if (!done) { done = true; clearTimeout(t); wc.removeListener("did-finish-load", finish); wc.removeListener("did-fail-load", failCb); res(); } };
                const failCb = (_e: unknown, code: number) => {
                  if (code === -3) { console.log(`[warmup] initial wait: ERR_ABORTED (ignored)`); return; }
                  finish();
                };
                const t = setTimeout(() => { console.log(`[warmup] initial wait: 8s timeout`); finish(); }, 8000);
                wc.on("did-finish-load", finish);
                wc.on("did-fail-load",   failCb);
              });
              console.log(`[warmup] initial wait: done`);
            } else {
              console.log(`[warmup] initial wait: browser already idle`);
            }
            await sleep(800);

            // ── 2. Navigate directly to each trending reel — no homepage stop ───────────
            const reelCount = randInt(reelsMin, reelsMax);
            console.log(`[warmup] reelCount=${reelCount}, urls available=${reelUrls.length}`);
            for (let i = 0; i < reelCount; i++) {
              const url = reelUrls[i] ?? reelUrls[reelUrls.length - 1];
              const label = url.replace("https://www.instagram.com", "ig.com");
              relayStep(`Viewing trending reel ${i + 1}/${reelCount} — ${label}…`);
              console.log(`[warmup] reel ${i + 1}/${reelCount}: nav to ${url}`);
              await nav(url);
              await sleep(1500 + Math.random() * 1000);

              // Dismiss cookie banner
              await js(`(function(){
                var ACCEPT = ${JSON.stringify(WARMUP_COOKIE_LABELS)};
                function ok(b){if(!b)return false;var r=b.getBoundingClientRect();if(r.width<=0)return false;return ACCEPT.indexOf((b.innerText||b.textContent||'').trim().toLowerCase())!==-1;}
                var btn=document.querySelector('[data-cookiebanner="accept_button"]')||Array.from(document.querySelectorAll('button,[role="button"],a')).find(ok);
                if(btn){btn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}
              })()`);
              await sleep(800);
              // Hide the signup/login overlay via CSS — avoids the click-triggered redirect
              // that clicking the X button causes. The overlay is invisible but stays in the
              // DOM, so the warmup looks like a real viewer without triggering navigation.
              await js(`(function(){
                var els=document.querySelectorAll('[role="dialog"],[role="presentation"]');
                for(var i=0;i<els.length;i++){
                  var txt=(els[i].innerText||els[i].textContent||'').toLowerCase();
                  if(txt.includes('sign up')||txt.includes('never miss')||txt.includes('log in to')||txt.includes('see photos')||txt.includes('see videos')){
                    els[i].style.setProperty('display','none','important');
                    console.log('[warmup] CSS-hid overlay: '+txt.slice(0,40));
                  }
                }
              })()`);
              await sleep(300);

              // Watch the reel for the configured idle time — no scrolling, just viewing.
              const idleMs = randInt(reelsIdleMin, reelsIdleMax) * 1000;
              const pollMs = 3000;
              const polls  = Math.max(1, Math.floor(idleMs / pollMs));
              console.log(`[warmup] reel ${i + 1}: watching ${idleMs}ms (${polls} polls)`);
              let reelRedirected = false;
              for (let p = 0; p < polls; p++) {
                await sleep(pollMs);
                // Check for unexpected redirect (e.g. session expiry) — break out, move on.
                // Do NOT call dismissOverlay() mid-watch — same redirect risk.
                const midUrl = wc.getURL();
                if (midUrl && !midUrl.includes('/reel/') && !midUrl.startsWith('about:')) {
                  const isLogin    = midUrl.includes('accounts/login') || midUrl.includes('accounts/emailsignup');
                  const isHomepage = midUrl === 'https://www.instagram.com/' || midUrl === 'https://www.instagram.com';
                  const isChallenge = midUrl.includes('/challenge/') || midUrl.includes('update_risky_contactpoint');
                  const redirectType = isChallenge ? 'CHALLENGE' : isLogin ? 'LOGIN-PAGE' : isHomepage ? 'HOMEPAGE' : 'OTHER';
                  console.log(`[warmup] mid-watch REDIRECT [${redirectType}] poll=${p}/${polls} expected="${url}" got="${midUrl}"`);
                  relayStep(`⚠ Redirect [${redirectType}] at poll ${p + 1} — moving on`);
                  reelRedirected = true;
                  break;
                }
              }
              if (!reelRedirected) {
                const remainder = idleMs - polls * pollMs;
                if (remainder > 100) await sleep(remainder);
              }
              relayStep(`Reel ${i + 1}/${reelCount} done`);
            }

            console.log(`[warmup] COMPLETE`);
            relayStep("Warm-up complete ✓");
          } catch (err: any) {
            console.log(`[warmup] CAUGHT ERROR: ${err?.message ?? String(err)}\n${err?.stack ?? ""}`);
            relayStep(`Warm-up error: ${err?.message ?? "unknown"}`);
          } finally {
            relayDone();
            const _weDone = ebMap.get(-1);
            if (_weDone) _weDone.warmupActive = false;
          }
        })().catch((err: any) => {
          console.log(`[warmup] OUTER CATCH: ${err?.message ?? String(err)}`);
          const _weDone2 = ebMap.get(-1);
          if (_weDone2) _weDone2.warmupActive = false;
          relayDone();
        });

        return;
      }

      // ── POST /eb/ghost-signup ───────────────────────────────────────────────
      // Fully automated Instagram account creation flow using CDP touch events.
      // The browser must already be open (Ghost Browser, profileId -1).
      // Flow: navigate → accept cookies → "Create new account" → "Sign up with
      // email" → fill email → wait for code → DOB → name → username → terms.
      // Progress is relayed to the API server via /api/signup/browser/ghost-signup-step.
      if (req.method === "POST" && u.pathname === "/eb/ghost-signup") {
        const {
          slot: _slot,
          email, username, password, dob,
          websitesToVisit = [],
          websitesMin = 1, websitesMax = 3,
          internalLinksMin = 2, internalLinksMax = 5,
          timeOnSiteMin = 1, timeOnSiteMax = 3,
          timeOnLinksMin = 1, timeOnLinksMax = 2,
          youtubeVideosMin = 0, youtubeVideosMax = 0,
          youtubeWatchMin = 2, youtubeWatchMax = 5,
        } = body as {
          slot?: number;
          email: string; username: string; password: string; dob: string;
          websitesToVisit?: string[];
          websitesMin?: number; websitesMax?: number;
          internalLinksMin?: number; internalLinksMax?: number;
          timeOnSiteMin?: number; timeOnSiteMax?: number;
          timeOnLinksMin?: number; timeOnLinksMax?: number;
          youtubeVideosMin?: number; youtubeVideosMax?: number;
          youtubeWatchMin?: number; youtubeWatchMax?: number;
        };
        const slot = Number(_slot ?? 1) || 1;
        const e = ebMap.get(-slot);
        if (!e || e.win.isDestroyed()) {
          return send(res, 200, { ok: false, error: `Ghost Browser slot ${slot} is not open` });
        }

        if (!email || !username || !password || !dob) {
          return send(res, 200, { ok: false, error: "email, username, password, and dob are required" });
        }

        send(res, 200, { ok: true });

        (async () => {
          // Capture abort token for this specific signup run + slot.
          // If the ghost browser is closed (which bumps the slot's abort token),
          // or a new signup is started, isAborted() returns true and all
          // polled sleeps reject immediately so the async block exits cleanly.
          _ghostSignupAbortTokens.set(slot, (_ghostSignupAbortTokens.get(slot) ?? 0) + 1);
          const _mySignupToken = _ghostSignupAbortTokens.get(slot)!;
          const isAborted = () => _ghostSignupAbortTokens.get(slot) !== _mySignupToken || e.win.isDestroyed();
          const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
          // Polled sleep that aborts within 500 ms when the browser is closed.
          const sleepOrAbort = (ms: number) => new Promise<void>((resolve, reject) => {
            const POLL = 500;
            let elapsed = 0;
            const check = () => {
              if (isAborted()) return reject(new Error("ghost-signup aborted"));
              elapsed += POLL;
              if (elapsed >= ms) return resolve();
              setTimeout(check, Math.min(POLL, ms - elapsed));
            };
            setTimeout(check, Math.min(POLL, ms));
          });

          const relay = (msg: string) => {
            console.log(`[ghost-signup slot=${slot}] ${msg}`);
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ msg, slot }),
              }).catch(() => {});
            }
          };

          const relayDone = async () => {
            // Extract Instagram session cookies from the ghost browser's Chrome session.
            // These are stored server-side so "Add to Equinox" can include them in the profile.
            let harvestedCookies: string | null = null;
            try {
              if (!e.win.isDestroyed()) {
                const allCookies = await e.win.webContents.session.cookies.get({ url: "https://www.instagram.com" });
                const wantedNames = new Set(["sessionid", "csrftoken", "ds_user_id", "mid", "ig_did", "ig_nrcb"]);
                const parts = allCookies
                  .filter(c => wantedNames.has(c.name))
                  .map(c => `${c.name}=${c.value}`);
                if (parts.some(p => p.startsWith("sessionid="))) harvestedCookies = parts.join(";");
              }
            } catch {}
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  msg: "✅ Signup flow complete! Click 'Add to Aura Farming' to save the account.",
                  done: true,
                  slot,
                  cookies: harvestedCookies,
                }),
              }).catch(() => {});
            }
          };

          // wc was previously missing from this scope — the IIFE crashed
          // silently at the first bare wc.executeJavaScript() call, before
          // relay() was ever invoked, so zero progress ever reached the UI.
          const wc = e.win.webContents;
          console.log(`[ghost-signup] IIFE started — wc ok=${!wc.isDestroyed()} serverPort=${_serverPort}`);

          // Attach debugger (no-op if already attached)
          try { wc.debugger.attach("1.3"); } catch {}

          // Inject scripts before navigating to Instagram.
          // addScriptToEvaluateOnNewDocument fires on every subsequent navigation in order:
          //   1st: WEBRTC_BLOCKER_JS         (injected when ghost window opened)
          //   2nd: _fpScript desktop         (injected when ghost window opened, isMobile=false)
          //   3rd: MOUSE_HOVER_BLOCKER       (injected here)
          //   4th: GHOST_SIGNUP_FP_PATCH     (injected here — overrides desktop fp values)
          //   5th: per-session canvas patch  (injected here — unique fingerprint per signup)
          // buildFingerprintScript now emits configurable:true getters so steps 4-5 can win.

          // ── Per-session unique canvas / WebGL / audio fingerprint ──────────────
          // CRITICAL: the fp script PRNG is seeded from the UA hash. Ghost browser
          // always uses "Pixel 8" UA → same seed → same canvas hash, same WebGL
          // renderer, same audio fingerprint on EVERY signup. Instagram clusters
          // accounts by canvas fingerprint and bans in bulk. This patch generates
          // a fresh set of random values per signup session and re-overrides the
          // prototype methods the fp script already patched.
          // Full 32-bit entropy — previously 2-254 / 1e-7-9e-7 collapsed to ~253 / ~9 distinct
          // fingerprints at scale (see generateEbFingerprint() in browserFingerprint.ts).
          const _gpCN   = (Math.floor(Math.random() * 4294967295) >>> 0) || 1;
          const _gpAN   = (Math.floor(Math.random() * 4294967295) >>> 0) || 1;
          const _gpWGPU = [
            ["Qualcomm Technologies, Inc.", "Adreno (TM) 750"],
            ["Qualcomm Technologies, Inc.", "Adreno (TM) 735"],
            ["Qualcomm Technologies, Inc.", "Adreno (TM) 720"],
            ["Qualcomm Technologies, Inc.", "Adreno (TM) 740"],
            ["ARM", "Mali-G920 MC10"],
            ["ARM", "Mali-G715 MC5"],
            ["Google", "Tensor G3"],
            ["Google", "Tensor G4"],
          ];
          const [_gpWV, _gpWR] = _gpWGPU[Math.floor(Math.random() * _gpWGPU.length)];
          const _ghostCanvasScript = `(function(){
  var _CN=${_gpCN},_AN=${_gpAN};
  var _WV=${JSON.stringify(_gpWV)},_WR=${JSON.stringify(_gpWR)};
  try{
    HTMLCanvasElement.prototype.toDataURL=function(){
      if(!this.width||!this.height)return Object.getPrototypeOf(HTMLCanvasElement.prototype).toDataURL.apply(this,arguments);
      try{var c=document.createElement('canvas');c.width=this.width;c.height=this.height;var cx=c.getContext('2d');cx.drawImage(this,0,0);var d=cx.getImageData(0,0,c.width,c.height);d.data[(_CN*4)%d.data.length]^=1;cx.putImageData(d,0,0);return Object.getPrototypeOf(HTMLCanvasElement.prototype).toDataURL.apply(c,arguments);}catch(e2){return Object.getPrototypeOf(HTMLCanvasElement.prototype).toDataURL.apply(this,arguments);}
    };
    HTMLCanvasElement.prototype.toBlob=function(cb,type,quality){
      if(!this.width||!this.height){HTMLCanvasElement.prototype.toBlob.call(this,cb,type,quality);return;}
      try{var c=document.createElement('canvas');c.width=this.width;c.height=this.height;var cx=c.getContext('2d');cx.drawImage(this,0,0);var d=cx.getImageData(0,0,c.width,c.height);d.data[(_CN*4)%d.data.length]^=1;cx.putImageData(d,0,0);HTMLCanvasElement.prototype.toBlob.call(c,cb,type,quality);}catch(e2){HTMLCanvasElement.prototype.toBlob.call(this,cb,type,quality);}
    };
  }catch(e){}
  try{
    if(window.WebGLRenderingContext){WebGLRenderingContext.prototype.getParameter=function(p){if(p===0x9245)return _WV;if(p===0x9246)return _WR;return WebGLRenderingContext.prototype.getParameter.call(this,p);};}
    if(window.WebGL2RenderingContext){WebGL2RenderingContext.prototype.getParameter=function(p){if(p===0x9245)return _WV;if(p===0x9246)return _WR;return WebGL2RenderingContext.prototype.getParameter.call(this,p);};}
  }catch(e){}
  try{
    var _S=(_AN|1);
    AnalyserNode.prototype.getFloatFrequencyData=function(a){var _oGFF=AnalyserNode.prototype.getFloatFrequencyData;_oGFF.call(this,a);if(a&&a.length>0){var s=_S;for(var i=0;i<a.length;i++){s=Math.imul(1664525,s)+1013904223>>>0;a[i]+=(s/0x100000000)*0.0001-0.00005;}}};
    AnalyserNode.prototype.getByteFrequencyData=function(a){var _oGBF=AnalyserNode.prototype.getByteFrequencyData;_oGBF.call(this,a);if(a&&a.length>0){var s=_S;for(var i=0;i<a.length;i++){s=Math.imul(1664525,s)+1013904223>>>0;var v=a[i]+(s/0x100000000>0.5?1:0);a[i]=Math.max(0,Math.min(255,v));}}};
  }catch(e){}
})();`;

          try {
            await wc.debugger.sendCommand("Page.enable");
          } catch {}
          try {
            await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: ELECTRON_LEAK_SUPPRESSOR_JS });
          } catch {}
          try {
            await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: GHOST_MOUSE_BLOCKER_JS });
          } catch {}
          try {
            await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: GHOST_SIGNUP_FP_PATCH_JS });
          } catch {}
          try {
            await wc.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: _ghostCanvasScript });
          } catch {}
          // Also execute on the currently-loaded page (addScriptToEvaluateOnNewDocument
          // only applies to future navigations — we need it on the page that's already open)
          wc.executeJavaScript(GHOST_MOUSE_BLOCKER_JS).catch(() => {});
          wc.executeJavaScript(GHOST_SIGNUP_FP_PATCH_JS).catch(() => {});
          wc.executeJavaScript(_ghostCanvasScript).catch(() => {});
          wc.on("dom-ready", () => {
            wc.executeJavaScript(GHOST_MOUSE_BLOCKER_JS).catch(() => {});
            wc.executeJavaScript(GHOST_SIGNUP_FP_PATCH_JS).catch(() => {});
            wc.executeJavaScript(_ghostCanvasScript).catch(() => {});
          });

          const js = (script: string): Promise<any> =>
            wc.executeJavaScript(script).catch((err: any) => {
              console.log(`[ghost-signup] js error: ${err?.message}`);
              return null;
            });

          // CDP touch tap (isTrusted, invisible to Instagram as a mouse event)
          const tap = async (x: number, y: number) => {
            try {
              await wc.debugger.sendCommand("Input.synthesizeTapGesture", {
                x, y, duration: 60, tapCount: 1, gestureSourceType: "touch",
              });
              await sleep(120);
            } catch {
              // Fallback: dispatchMouseEvent with pointerType:"touch" — isTrusted=true from CDP,
              // no desktop mouse signature. Identical to what a real phone generates.
              try {
                await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
                  type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch",
                });
                await sleep(80);
                await wc.debugger.sendCommand("Input.dispatchMouseEvent", {
                  type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch",
                });
              } catch {}
            }
          };

          // Type text into the currently-focused element — character by character
          // with human-like inter-key delays. typeTextCDP fires rawKeyDown +
          // Input.insertText (1 char) + keyUp per character, so Instagram's
          // keystroke-timing analyser sees natural inter-character gaps, not a paste.
          // androidIme:true → keyCode=229/Unidentified on every key, matching how
          // Android's virtual keyboard actually fires events (not Windows key codes).
          const typeText = async (text: string, opts?: { minDelay?: number; maxDelay?: number }) => {
            try {
              await typeTextCDP(wc.debugger, text, { ...(opts ?? {}), androidIme: true });
            } catch {}
          };

          // Tap element then clear existing content and type new text.
          // MOBILE-ONLY: synthesizeTapGesture to focus, JS to clear value (no Ctrl+A/Delete),
          // then typeTextCDP to type character-by-character with human delays.
          // No mouse events. Full-string Input.insertText is NOT used here — it
          // delivers all characters as a single paste event with 0 ms inter-char gap.
          const clearAndType = async (x: number, y: number, text: string) => {
            // JS focus FIRST — focus() fires React's synthetic onFocus so the input
            // becomes the active element and React's state is updated.
            // We do NOT call .click() here — that would dispatch a MouseEvent which
            // leaks desktop pointer identity. The CDP tap below fires the touch event.
            try {
              await js(`(function(){
                // elementFromPoint finds the exact element at the coordinates
                var el = document.elementFromPoint(${x}, ${y});
                // Walk up in case we hit a wrapper div instead of the input
                var found = el;
                while (found && found.tagName !== 'INPUT' && found.tagName !== 'TEXTAREA') {
                  found = found.parentElement;
                  if (!found || found === document.body) { found = el; break; }
                }
                if (found) { found.focus(); }
              })()`);
            } catch {}
            // Belt-and-suspenders: CDP tap as well
            await tap(x, y);
            await sleep(400);
            // Clear via JS using the native property setter so React's controlled state resets.
            // Use activeElement first, fall back to elementFromPoint in case tap stole focus.
            try {
              await js(`(function(){
                var el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                  el = document.elementFromPoint(${x}, ${y});
                }
                if (!el) return;
                var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (setter && setter.set) { setter.set.call(el, ''); }
                else { el.value = ''; }
                el.dispatchEvent(new Event('input',  { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
              })()`);
            } catch {}
            await sleep(120);
            // Suppress browser autocomplete BEFORE typing. Chrome's email-type input
            // can auto-complete the @domain.com suffix mid-keystroke (e.g. while CDP
            // types "user@gmail" character-by-character, Chrome appends ".com" from
            // its suggestion — then CDP continues typing ".com" again, producing
            // "user@gmail.com.com"). Killing autocomplete/autocorrect prevents this.
            try {
              await js(`(function(){
                var el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                  el = document.elementFromPoint(${x}, ${y});
                }
                if (!el) return;
                el.setAttribute('autocomplete', 'off');
                el.setAttribute('autocorrect', 'off');
                el.setAttribute('autocapitalize', 'none');
                el.setAttribute('spellcheck', 'false');
              })()`);
            } catch {}
            // Ctrl+A then Backspace — select and remove any content Instagram
            // re-populated in the field after the JS clear (e.g. "@gmail.com"
            // domain suggestion). Without this the typed email appends to the
            // suggestion and produces "user@gmail.com@gmail.com".
            try {
              await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
              await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",      key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
              await sleep(60);
              await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 });
              await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",      key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, modifiers: 0 });
              await sleep(60);
            } catch {}
            // Type character-by-character via typeTextCDP — fires rawKeyDown +
            // Input.insertText (1 char) + keyUp per character with 80–280 ms human
            // inter-key delays. Instagram's keystroke-timing analyser sees natural
            // gaps; a full-string Input.insertText would look like an instant paste.
            // androidIme:true sends key="Unidentified" / vk=229 (VK_PROCESSKEY)
            // which is how Android virtual keyboards actually fire events.
            try {
              await typeTextCDP(wc.debugger, text, { androidIme: true });
            } catch {}
            await sleep(300);
            // Instagram's React JS can fire a post-type domain suggestion
            // (e.g. types "nosov-pavel@gmx.com", IG appends " @gmx.com" →
            // "nosov-pavel@gmx.com @gmx.com"). Force-set the value back to
            // exactly `text` via the native setter, then fire React events so
            // the controlled input accepts the corrected value.
            try {
              const fieldVal = await js(`(function(){
                var el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                  el = document.elementFromPoint(${x}, ${y});
                }
                return el ? el.value : null;
              })()`);
              relay(`[clearAndType] Field value after type: "${fieldVal}" (expected ${text.length} chars)`);
              if (typeof fieldVal === 'string' && fieldVal !== text) {
                relay(`[clearAndType] Mismatch detected — force-setting to expected value`);
                try {
                  await js(`(function(){
                    var el = document.activeElement;
                    if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                      el = document.elementFromPoint(${x}, ${y});
                    }
                    if (!el) return;
                    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                    var val = ${JSON.stringify(text)};
                    if (setter && setter.set) { setter.set.call(el, val); }
                    else { el.value = val; }
                    el.dispatchEvent(new Event('input',  { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  })()`);
                } catch {}
              }
            } catch {}
          };

          // JS helper: find any button/link by text content, return centre coords
          const findByTextScript = (needles: string[]) => `(function(){
            var ns=${JSON.stringify(needles.map(n=>n.toLowerCase()))};
            var els=Array.from(document.querySelectorAll('button,a,div[role="button"],span[role="button"]'));
            for(var i=0;i<ns.length;i++){
              var el=els.find(function(e){return(e.innerText||e.textContent||'').trim().toLowerCase().includes(ns[i]);});
              if(el){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}
            }
            return null;
          })()`;

          // JS helper: find an input field by name/placeholder/aria-label
          const findInputScript = (attrs: string[]) => `(function(){
            var a=${JSON.stringify(attrs)};
            for(var i=0;i<a.length;i++){
              var sels=['[name="'+a[i]+'"]','[placeholder="'+a[i]+'"]','[aria-label="'+a[i]+'"]'];
              for(var s=0;s<sels.length;s++){var el=document.querySelector(sels[s]);if(el){var r=el.getBoundingClientRect();if(r.width>0&&r.height>0)return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};}}
            }
            // Fallback: first visible text/email/password input
            var inputs=Array.from(document.querySelectorAll('input[type="text"],input[type="email"],input[type="password"],input:not([type])'));
            for(var j=0;j<inputs.length;j++){var r2=inputs[j].getBoundingClientRect();if(r2.width>0&&r2.height>0)return{x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2)};}
            return null;
          })()`;

          // Wait for element by text, tap it, return true/false
          const waitAndTap = async (needles: string[], label: string, timeoutMs = 20000): Promise<boolean> => {
            const start = Date.now();
            while (Date.now() - start < timeoutMs) {
              const pos = await js(findByTextScript(needles)) as {x:number;y:number}|null;
              if (pos) {
                relay(`Tapping "${label}"…`);
                await tap(pos.x, pos.y);
                await sleep(900);
                return true;
              }
              await sleep(1200);
            }
            relay(`⚠ "${label}" not found after ${Math.round(timeoutMs/1000)}s`);
            return false;
          };

          // Wait for a page load with timeout
          const navAndWait = async (url: string) => {
            relay(`Navigating to ${url}…`);
            await new Promise<void>(resolve => {
              let done = false;
              const finish = () => { if (!done) { done = true; clearTimeout(t); wc.removeListener("did-finish-load", onFinish); wc.removeListener("did-fail-load", onFail); resolve(); } };
              const onFinish = () => finish();
              const onFail = (_: any, code: number) => { if (code === -3) return; finish(); };
              const t = setTimeout(finish, 25000);
              wc.on("did-finish-load", onFinish);
              wc.on("did-fail-load", onFail);
              wc.loadURL(url).catch(() => {});
            });
            await sleep(2000);
          };

          // ── Website Warm-Up (visits BEFORE Instagram signup) ────────────────
          // Visits a shuffled random selection of user-supplied websites first.
          // On each site: accepts cookie consent, spends time reading, clicks
          // internal links, spends time on those too. This establishes a
          // natural browsing history in the browser session before any
          // Instagram touchpoint — exactly as Jarvee's warm-up phase works.
          const _rndInt = (min: number, max: number) =>
            min >= max ? min : min + Math.floor(Math.random() * (max - min + 1));

          const _shuffle = <T,>(arr: T[]): T[] => {
            const a = [...arr];
            for (let i = a.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [a[i], a[j]] = [a[j], a[i]];
            }
            return a;
          };

          if (websitesToVisit.length > 0) {
            const pickCount = Math.min(
              _rndInt(websitesMin, websitesMax),
              websitesToVisit.length,
            );
            const sites = _shuffle(websitesToVisit).slice(0, pickCount);
            relay(`🌐 Warm-up: visiting ${sites.length} website(s) before signup…`);

            for (const siteUrl of sites) {
              // Stop immediately if the browser was closed or a new signup started
              if (isAborted()) break;
              try {
                relay(`🌐 Warm-up: navigating to ${siteUrl}…`);
                await new Promise<void>(resolve => {
                  let done = false;
                  const finish = () => {
                    if (!done) { done = true; clearTimeout(t); wc.removeListener("did-finish-load", onF); wc.removeListener("did-fail-load", onFail2); resolve(); }
                  };
                  const onF = () => finish();
                  const onFail2 = (_: any, code: number) => { if (code === -3) return; finish(); };
                  const t = setTimeout(finish, 30000);
                  wc.on("did-finish-load", onF);
                  wc.on("did-fail-load", onFail2);
                  wc.loadURL(siteUrl).catch(() => {});
                });
                if (isAborted()) break;
                await sleep(2500);

                // Accept cookie consent — try many common patterns
                const _cookieAcceptScript = `(async function(){
                  var selectors = [
                    'button[id*="accept"]','button[id*="cookie"]','button[id*="consent"]',
                    'button[class*="accept"]','button[class*="cookie"]','button[class*="consent"]',
                    'button[class*="agree"]','button[class*="allow"]',
                    'a[id*="accept"]','a[class*="accept"]','a[class*="consent"]',
                    '#accept-all','#acceptAll','#accept_all','#cookieAccept',
                    '.cookie-accept','.cookieAccept','.cookie-ok','.accept-cookies',
                    '[data-testid="accept"]','[data-action*="accept"]',
                  ];
                  var texts = ['accept all','accept cookies','i agree','allow all','ok, i agree','agree','allow','accept','got it','i understand','dismiss','close'];
                  // Try selector match first
                  for (var s of selectors) {
                    var el = document.querySelector(s);
                    if (el) { el.click(); return 'selector:'+s; }
                  }
                  // Text content match on visible buttons/links
                  var candidates = Array.from(document.querySelectorAll('button,a,div[role="button"],span[role="button"]'));
                  for (var t of texts) {
                    var found = candidates.find(function(c){ return (c.innerText||c.textContent||'').trim().toLowerCase().startsWith(t); });
                    if (found) { found.click(); return 'text:'+t; }
                  }
                  return null;
                })()`;
                try {
                  const accepted = await wc.executeJavaScript(_cookieAcceptScript).catch(() => null);
                  if (accepted) relay(`🍪 Warm-up: accepted cookie consent (${accepted})`);
                } catch {}
                await sleep(1500);

                // Spend time on this site — use sleepOrAbort so closing the
                // browser while sleeping doesn't leave a zombie run alive for minutes.
                if (isAborted()) break;
                const siteWaitMs = _rndInt(timeOnSiteMin, timeOnSiteMax) * 60 * 1000;
                relay(`⏱ Warm-up: spending ${Math.round(siteWaitMs/60000)} min on ${siteUrl}…`);
                await sleepOrAbort(siteWaitMs);

                // Click internal links
                const linkCount = _rndInt(internalLinksMin, internalLinksMax);
                relay(`🔗 Warm-up: clicking ${linkCount} internal link(s)…`);
                for (let li = 0; li < linkCount; li++) {
                  try {
                    const _origin = new URL(siteUrl).origin;
                    const _linkScript = `(function(){
                      var links = Array.from(document.querySelectorAll('a[href]')).filter(function(a){
                        try { var h = new URL(a.href); return h.origin === '${_origin}' && h.pathname !== location.pathname && !a.href.includes('#'); } catch { return false; }
                      });
                      if (!links.length) return null;
                      var l = links[Math.floor(Math.random()*links.length)];
                      var r = l.getBoundingClientRect();
                      if (r.width > 0 && r.height > 0) { l.click(); return l.href; }
                      return null;
                    })()`;
                    const href = await wc.executeJavaScript(_linkScript).catch(() => null);
                    if (href) {
                      relay(`🔗 Warm-up: clicked internal link → ${href}`);
                      await sleep(2500);
                      // Accept cookies on sub-page too
                      try { await wc.executeJavaScript(_cookieAcceptScript).catch(() => null); } catch {}
                      const linkWaitMs = _rndInt(timeOnLinksMin, timeOnLinksMax) * 60 * 1000;
                      await sleep(linkWaitMs);
                    }
                  } catch {}
                }
              } catch (wErr: any) {
                // Abort errors from sleepOrAbort — stop the whole warm-up loop
                if (isAborted()) { relay("🛑 Warm-up stopped — Ghost Browser was closed"); break; }
                relay(`⚠ Warm-up: error on ${siteUrl}: ${wErr?.message ?? String(wErr)}`);
              }
            }
            if (isAborted()) return; // don't proceed to Instagram signup
            relay(`✅ Website warm-up complete`);
          }

          // ── YouTube Warm-Up ─────────────────────────────────────────────────
          // Visits YouTube and watches X–Y random videos for X–Y minutes each.
          // Runs BEFORE mobile UA is set so YouTube serves the desktop version.
          const _ytCount = _rndInt(youtubeVideosMin, youtubeVideosMax);
          if (_ytCount > 0) {
            if (isAborted()) return;
            try {
              relay(`📺 YouTube warm-up: watching ${_ytCount} video(s)…`);

              // Force desktop viewport so YouTube does NOT redirect to m.youtube.com.
              // The fingerprint patch injected earlier overrides screen dimensions in JS
              // but does not affect the Emulation layer that Chrome uses for responsive
              // redirect decisions. Setting a wide desktop viewport here ensures YouTube
              // serves the full desktop SPA, not the mobile version.
              try {
                await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
                  width: 1280, height: 800, deviceScaleFactor: 1, mobile: false,
                  screenWidth: 1280, screenHeight: 800,
                });
              } catch {}

              // Navigate to desktop YouTube homepage
              relay("📺 YouTube warm-up: navigating to YouTube…");
              await new Promise<void>(resolve => {
                let done = false;
                const finish = () => {
                  if (!done) {
                    done = true;
                    clearTimeout(t);
                    wc.removeListener("did-finish-load", onF);
                    wc.removeListener("did-fail-load", onFail);
                    resolve();
                  }
                };
                const onF = () => finish();
                const onFail = (_: any, code: number) => { if (code === -3) return; finish(); };
                const t = setTimeout(finish, 30000);
                wc.on("did-finish-load", onF);
                wc.on("did-fail-load", onFail);
                // Use ?app=desktop as belt-and-suspenders to force the full site
                wc.loadURL("https://www.youtube.com/?app=desktop").catch(() => {});
              });
              if (isAborted()) return;

              // Wait for YouTube SPA to initially render
              await sleep(3000);

              // Accept YouTube cookie / consent overlay if present.
              // NOTE: the existing CookieBanner system (which runs on all EB pages) may dismiss
              // the overlay before this script runs. In that case this returns null. Either way
              // we wait for the post-consent page reload below — that wait must happen regardless
              // of who dismissed the banner, because YouTube does a full page reload after consent.
              const _ytConsentScript = `(async function(){
                var texts = ['accept all','i agree','agree to the use','accept the use','accept'];
                var cands = Array.from(document.querySelectorAll(
                  'button, div[role="button"], tp-yt-paper-button, ytd-button-renderer button'
                ));
                for (var i = 0; i < texts.length; i++) {
                  var found = cands.find(function(c){
                    return (c.innerText||c.textContent||'').trim().toLowerCase().startsWith(texts[i]);
                  });
                  if (found) { found.click(); return 'accepted:' + texts[i]; }
                }
                return null;
              })()`;
              try {
                const accepted = await wc.executeJavaScript(_ytConsentScript).catch(() => null);
                if (accepted) relay(`🍪 YouTube: dismissed consent overlay (${accepted})`);
              } catch {}

              // Always wait for the post-consent page reload + SPA render.
              // YouTube reloads the full page after consent regardless of who dismissed it,
              // so we listen for did-finish-load and then add an extra buffer for the SPA.
              relay(`📺 YouTube warm-up: waiting for page to load…`);
              await new Promise<void>(resolve => {
                let done = false;
                const finish = () => { if (!done) { done = true; clearTimeout(t); wc.removeListener("did-finish-load", onF); resolve(); } };
                const onF = () => finish();
                const t = setTimeout(finish, 12000);
                wc.on("did-finish-load", onF);
              });
              await sleep(4000); // extra buffer for lazy-loaded SPA video grid
              if (isAborted()) return;

              // Helper: scan the current page for a /watch?v= video URL.
              // YouTube serves either the desktop SPA (ytd-* elements) or the mobile SPA
              // (ytm-* elements) depending on what window.innerWidth returns. The fingerprint
              // patch in Ghost Browser injects window.innerWidth=393, so YouTube usually renders
              // the mobile layout — we must include mobile selectors here.
              const _findVideoScript = `(function(){
                var thumbs = [];
                // Desktop YouTube selectors
                thumbs = Array.from(document.querySelectorAll(
                  'ytd-rich-item-renderer a#thumbnail[href],' +
                  'ytd-video-renderer a#thumbnail[href],' +
                  'ytd-compact-video-renderer a.ytd-thumbnail[href],' +
                  'a.ytd-thumbnail[href^="/watch"]'
                ));
                // Mobile YouTube selectors (ytm-* elements, used when window.innerWidth<=480)
                if (!thumbs.length) {
                  thumbs = Array.from(document.querySelectorAll(
                    'ytm-compact-video-renderer a.media-item-thumbnail-container[href],' +
                    'ytm-rich-item-renderer a[href*="/watch"],' +
                    'ytm-video-with-context-renderer a[href*="/watch"],' +
                    'ytm-slim-video-metadata-renderer a[href*="/watch"]'
                  ));
                }
                // Universal fallback: any /watch?v= link on the page
                if (!thumbs.length) {
                  thumbs = Array.from(document.querySelectorAll('a[href*="/watch?v="]'));
                }
                if (!thumbs.length) return null;
                var pick = thumbs[Math.floor(Math.random() * Math.min(8, thumbs.length))];
                var href = pick ? pick.getAttribute('href') : null;
                if (!href) return null;
                try { return new URL(href, 'https://www.youtube.com').href; } catch { return null; }
              })()`;

              for (let vi = 0; vi < _ytCount; vi++) {
                if (isAborted()) break;
                try {
                  let videoUrl = await wc.executeJavaScript(_findVideoScript).catch(() => null);

                  // If homepage has no videos (rare but can happen on first load), try a
                  // YouTube search results page which always has video links even on mobile.
                  if (!videoUrl || typeof videoUrl !== "string") {
                    relay(`📺 YouTube warm-up: no videos on homepage, trying search page…`);
                    await new Promise<void>(resolve => {
                      let done = false;
                      const finish = () => { if (!done) { done = true; clearTimeout(t); wc.removeListener("did-finish-load", onF); resolve(); } };
                      const onF = () => finish();
                      const t = setTimeout(finish, 15000);
                      wc.on("did-finish-load", onF);
                      wc.loadURL("https://www.youtube.com/results?search_query=trending+videos+2024").catch(() => {});
                    });
                    await sleep(3000);
                    if (isAborted()) break;
                    videoUrl = await wc.executeJavaScript(_findVideoScript).catch(() => null);
                  }

                  if (!videoUrl || typeof videoUrl !== "string") {
                    relay(`📺 YouTube warm-up: no videos found, skipping remaining`);
                    break;
                  }

                  relay(`📺 YouTube warm-up: watching video ${vi + 1}/${_ytCount}…`);
                  await new Promise<void>(resolve => {
                    let done = false;
                    const finish = () => {
                      if (!done) {
                        done = true;
                        clearTimeout(t);
                        wc.removeListener("did-finish-load", onF);
                        wc.removeListener("did-fail-load", onFail);
                        resolve();
                      }
                    };
                    const onF = () => finish();
                    const onFail = (_: any, code: number) => { if (code === -3) return; finish(); };
                    const t = setTimeout(finish, 20000);
                    wc.on("did-finish-load", onF);
                    wc.on("did-fail-load", onFail);
                    wc.loadURL(videoUrl).catch(() => {});
                  });
                  if (isAborted()) break;

                  await sleep(2500);
                  const watchMs = _rndInt(youtubeWatchMin, youtubeWatchMax) * 60 * 1000;
                  relay(`📺 YouTube warm-up: watching for ${Math.round(watchMs / 60000)} min…`);
                  await sleepOrAbort(watchMs);

                  if (isAborted()) break;

                  // Navigate back to homepage for the next video pick
                  if (vi < _ytCount - 1) {
                    await new Promise<void>(resolve => {
                      let done = false;
                      const finish = () => {
                        if (!done) {
                          done = true;
                          clearTimeout(t);
                          wc.removeListener("did-finish-load", onF);
                          wc.removeListener("did-fail-load", onFail);
                          resolve();
                        }
                      };
                      const onF = () => finish();
                      const onFail = (_: any, code: number) => { if (code === -3) return; finish(); };
                      const t = setTimeout(finish, 15000);
                      wc.on("did-finish-load", onF);
                      wc.on("did-fail-load", onFail);
                      wc.loadURL("https://www.youtube.com/?app=desktop").catch(() => {});
                    });
                    await sleep(3000);
                  }
                } catch (ytVidErr: any) {
                  if (isAborted()) break;
                  relay(`⚠ YouTube warm-up: video ${vi + 1} error: ${ytVidErr?.message ?? String(ytVidErr)}`);
                }
              }

              if (!isAborted()) relay(`✅ YouTube warm-up complete`);
            } catch (ytErr: any) {
              if (!isAborted()) relay(`⚠ YouTube warm-up error: ${ytErr?.message ?? String(ytErr)}`);
            }
          }

          if (_ytCount > 0 || websitesToVisit.length > 0) {
            relay(`✅ All warm-up complete — starting Instagram signup now…`);
          }

          // One final guard: if closed between warm-up ending and signup starting
          if (isAborted()) return;

          try {
            // ── Mobile emulation setup (MUST run before Step 0) ─────────────
            // The Ghost Browser window is 1280×820 with no UA set by default.
            // On DESKTOP Instagram, clicking "Sign up" opens an in-page modal
            // with NO URL change — waitForUrl("/accounts/signup/phone") would
            // time out forever because that URL only exists in the MOBILE flow.
            // Forcing mobile UA + viewport here ensures Instagram renders its
            // mobile SPA so clicking "Sign up" navigates to /accounts/signup/phone.
            relay("[mobile-setup] Forcing mobile layout via CDP (required for signup URL flow)…");
            try {
              await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
                userAgent: `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CURRENT_CHROME_MAJOR}.0.0.0 Mobile Safari/537.36`,
                acceptLanguage: "en-US,en;q=0.9",
                platform: "Linux armv8l",
                userAgentMetadata: {
                  brands: [
                    { brand: getChromeBuildInfo(CURRENT_CHROME_MAJOR).grease,   version: getChromeBuildInfo(CURRENT_CHROME_MAJOR).greaseVer },
                    { brand: "Chromium",       version: CURRENT_CHROME_MAJOR },
                    { brand: "Google Chrome",  version: CURRENT_CHROME_MAJOR },
                  ],
                  fullVersionList: [
                    { brand: getChromeBuildInfo(CURRENT_CHROME_MAJOR).grease,   version: getChromeBuildInfo(CURRENT_CHROME_MAJOR).greaseVer + ".0.0.0" },
                    { brand: "Chromium",       version: getChromeBuildInfo(CURRENT_CHROME_MAJOR).full },
                    { brand: "Google Chrome",  version: getChromeBuildInfo(CURRENT_CHROME_MAJOR).full },
                  ],
                  platform:        "Android",
                  platformVersion: "14",
                  architecture:    "arm",
                  model:           "Pixel 8",
                  mobile:          true,
                  bitness:         "64",
                  wow64:           false,
                },
              });
              await wc.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
                width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true,
                screenOrientation: { type: "portraitPrimary", angle: 0 },
              });
              await wc.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
                enabled: true, maxTouchPoints: 10,
              });
              // CRITICAL for drum picker: setDeviceMetricsOverride does NOT change CSS
              // media query hover/pointer features. Without this, Chromium still reports
              // (hover:hover) and (pointer:fine) — desktop media queries — even at mobile
              // dimensions. Instagram checks (hover:none) + (pointer:coarse) to decide
              // whether to render the drum-picker date selector or a plain text input.
              await wc.debugger.sendCommand("Emulation.setEmulatedMedia", {
                features: [
                  { name: "hover",       value: "none"   },
                  { name: "any-hover",   value: "none"   },
                  { name: "pointer",     value: "coarse" },
                  { name: "any-pointer", value: "coarse" },
                ],
              });
              relay(`[mobile-setup] ✅ Mobile UA=Pixel 8 Chrome/${CURRENT_CHROME_MAJOR} viewport=393x851 dpr=2.75 touch=on hover=none pointer=coarse`);
            } catch (mobileErr: any) {
              relay(`[mobile-setup] ⚠ Could not set mobile layout: ${mobileErr?.message ?? String(mobileErr)} — desktop layout may be active, signup flow may fail`);
            }

          // ── Fingerprint diagnostic (logged to relay before first page load) ──
          // This snapshot is taken AFTER all CDP overrides are applied and AFTER
          // all addScriptToEvaluateOnNewDocument scripts are registered.
          // The values shown here are what Instagram's JavaScript would read.
          // Log it before navigation so we have a baseline even if the page fails.
          try {
            const _fpSnap = await wc.executeJavaScript(`(function(){
              var c=navigator.connection;
              return JSON.stringify({
                'ua':           navigator.userAgent.slice(0,80),
                'platform':     navigator.platform,
                'maxTouch':     navigator.maxTouchPoints,
                'hw':           navigator.hardwareConcurrency,
                'mem':          navigator.deviceMemory,
                'sw':           screen.width,
                'sh':           screen.height,
                'orientation':  screen.orientation?screen.orientation.type:'(none)',
                'winOri':       window.orientation,
                'dpr':          window.devicePixelRatio,
                'iw':           window.innerWidth,
                'ih':           window.innerHeight,
                'pointer':      window.matchMedia('(pointer:coarse)').matches,
                'hover':        window.matchMedia('(hover:none)').matches,
                'conn':         c?c.type:'(none)',
                'eff':          c?c.effectiveType:'(none)',
                'perf.mem':     typeof performance.memory,
                'kbd':          typeof navigator.keyboard,
                'ontouchstart': window.ontouchstart,
                'plugins':      navigator.plugins.length,
                'pdfViewer':    navigator.pdfViewerEnabled,
                'langs':        JSON.stringify(navigator.languages),
                'vvpW':         window.visualViewport?window.visualViewport.width:'(none)',
              });
            })()`);
            relay(`[fp-diag] ${_fpSnap}`);
          } catch (fpErr: any) {
            relay(`[fp-diag] snapshot failed: ${fpErr?.message}`);
          }

            // ── Step 0: Navigate to Instagram homepage ───────────────────────
            // Start from the homepage so Instagram's SPA can set device cookies
            // naturally before we proceed. Direct navigation to emailsignup/ or
            // accounts/signup/ is blocked/aborted by Instagram's redirect logic
            // on fresh sessions — landing on the homepage first avoids code=-3.
            await navAndWait("https://www.instagram.com/");

            // ── Step 1: Accept cookie banner — verify dismissed before continuing ─
            // Each step in the flow gates on the previous step being CONFIRMED done.
            // The cookie banner must be GONE before we proceed to the email field.
            // If it cannot be dismissed after 5 attempts the flow stops with an error.
            relay("Checking for cookie banner…");
            const COOKIE_LABELS = [
              "allow all cookies", "accept all cookies", "allow all", "accept all",
              "allow essential and optional cookies", "accept cookies",
              "allow cookies", "alle cookies akzeptieren", "accepter tout",
              "aceptar todo", "accetta tutto", "tillåt alla", "alle accepteren",
            ];
            // Cookie banner click — tap only (no mouse events)
            const clickCookieAt = async (pos: {x:number;y:number}) => {
              // L1: touch tap (synthesizeTapGesture) — pointerType="touch", no mouse signature
              await tap(pos.x, pos.y);
              await sleep(300);
              // L2: JS .click() — coordinate-independent fallback, fires no mouse events
              try {
                await js(`(function(){
                  var A=${JSON.stringify(COOKIE_LABELS)};
                  var b=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]');
                  if(!b){for(var e of document.querySelectorAll('button,[role="button"],a')){var t=(e.innerText||e.textContent||'').trim().toLowerCase();if(A.indexOf(t)!==-1){b=e;break;}}}
                  if(b){b.click();return true;}return false;
                })()`);
              } catch {}
            };

            {
              // Phase A: poll up to 7 s for the banner to appear after page load
              let initialPos: {x:number;y:number}|null = null;
              for (let poll = 0; poll < 14; poll++) {
                initialPos = await js(findByTextScript(COOKIE_LABELS)) as {x:number;y:number}|null;
                if (initialPos) break;
                await sleep(500);
              }

              if (!initialPos) {
                relay("✅ No cookie banner — proceeding…");
              } else {
                // Phase B: click and VERIFY dismissed — up to 5 attempts
                let cookieDismissed = false;
                for (let attempt = 1; attempt <= 5; attempt++) {
                  // Re-detect position on each attempt (banner may have shifted)
                  const pos = await js(findByTextScript(COOKIE_LABELS)) as {x:number;y:number}|null;
                  if (!pos) {
                    // Already gone (previous attempt worked)
                    cookieDismissed = true;
                    relay(`✅ Cookie banner dismissed (confirmed on attempt ${attempt})`);
                    break;
                  }
                  relay(`Accepting cookies… (attempt ${attempt}/5)`);
                  await clickCookieAt(pos);
                  // Wait for React to unmount the banner
                  await sleep(2000);
                  // Verify it actually disappeared
                  const check = await js(findByTextScript(COOKIE_LABELS)) as {x:number;y:number}|null;
                  if (!check) {
                    cookieDismissed = true;
                    relay(`✅ Cookie banner dismissed (attempt ${attempt})`);
                    break;
                  }
                  relay(`Banner still visible after attempt ${attempt} — retrying…`);
                  if (attempt < 5) await sleep(1000);
                }

                if (!cookieDismissed) {
                  relay("❌ Cookie banner could not be dismissed after 5 attempts. Please click 'Allow all cookies' manually and restart the signup flow.");
                  return;
                }
              }
              // Extra settling time so any post-dismiss navigation completes
              await sleep(3000);
            }

            // ── Step 2: Homepage → phone gate → email form — CLICK ONLY, no URL teleporting ──
            // Every navigation must happen by clicking a real on-screen element.
            // navAndWait() (loadURL) is NEVER used here — Instagram detects programmatic
            // navigation and treats it as suspicious. Each sub-step gates on the URL
            // being CONFIRMED before the next step runs.
            {
              // Helper: poll wc.getURL() until condition is true, with rich debug output
              const waitForUrl = async (
                condition: (url: string) => boolean,
                label: string,
                timeoutMs = 25000,
              ): Promise<boolean> => {
                const start = Date.now();
                let lastUrl = "";
                while (Date.now() - start < timeoutMs) {
                  const url = wc.getURL();
                  if (url !== lastUrl) {
                    relay(`[url-gate] Waiting for "${label}" — URL: ${url}`);
                    lastUrl = url;
                  }
                  if (condition(url)) {
                    relay(`✅ [url-gate] Reached "${label}" — URL: ${url}`);
                    return true;
                  }
                  await sleep(600);
                }
                relay(`❌ [url-gate] Timed out (${timeoutMs / 1000}s) waiting for "${label}" — last URL: ${wc.getURL()}`);
                return false;
              };

              // Dump all clickable elements for debugging
              const dumpClickables = async (tag: string) => {
                const items = await js(`(function(){
                  return Array.from(document.querySelectorAll('button,a,div[role="button"],span[role="button"]'))
                    .map(function(e){return(e.innerText||e.textContent||'').trim().replace(/\\s+/g,' ').slice(0,80);})
                    .filter(function(t){return t.length>1;})
                    .slice(0,30);
                })()`);
                relay(`[debug/${tag}] Clickable elements: ${JSON.stringify(items)}`);
              };

              const curUrl = wc.getURL();
              relay(`[step2] URL at start of Step 2: ${curUrl}`);

              const onEmailForm = curUrl.includes("emailsignup") || curUrl.includes("signup/email");
              const onPhoneGate = !onEmailForm && (curUrl.includes("accounts/signup/phone") || (curUrl.includes("accounts/signup") && !curUrl.includes("email")));
              const onHomepage  = !onEmailForm && !onPhoneGate;

              relay(`[step2] onHomepage=${onHomepage}  onPhoneGate=${onPhoneGate}  onEmailForm=${onEmailForm}`);
              await dumpClickables("step2-start");

              // ── 2a: On homepage — CLICK "Sign up", wait for /accounts/signup/phone ──
              if (onHomepage) {
                relay("[step2a] On homepage — looking for 'Sign up' button to CLICK (no URL teleport)…");

                const SIGNUP_LABELS = [
                  "sign up", "create new account", "create account",
                  "get started", "join now", "s'inscrire",
                  "registrarse", "iscriviti", "registrieren",
                ];

                // Retry loop: click, then wait for URL gate. Up to 3 attempts.
                let reachedPhone = false;
                for (let attempt = 1; attempt <= 3 && !reachedPhone; attempt++) {
                  relay(`[step2a] Attempt ${attempt}/3 — searching for Sign Up button…`);
                  await dumpClickables(`step2a-attempt${attempt}`);

                  const pos = await js(findByTextScript(SIGNUP_LABELS)) as {x:number;y:number}|null;
                  relay(`[step2a] Sign Up button found: ${pos ? `x=${pos.x} y=${pos.y}` : "NOT FOUND"}`);

                  if (!pos) {
                    relay(`[step2a] ⚠ Sign Up button not found on attempt ${attempt} — waiting 2s before retry…`);
                    await sleep(2000);
                    continue;
                  }

                  // Navigation strategy: use CDP dispatchMouseEvent with pointerType:"touch".
                  // synthesizeTapGesture misfires on SPA navigation due to a DPR coordinate
                  // mismatch (CSS px ≠ physical px when DPR>1 is active via setDeviceMetrics).
                  // dispatchMouseEvent uses genuine CSS pixel coordinates AND accepts pointerType
                  // so Instagram's React sees a trusted touch-typed click — identical to what a
                  // real Android Chrome produces when the user taps an anchor.
                  // NO JS element.click() — that dispatches an isTrusted=false MouseEvent.
                  relay(`[step2a] Resolving Sign Up target coords for touch-typed CDP click…`);
                  const signupNavTarget = await js(`(function(){
                    var anchors = Array.from(document.querySelectorAll('a'));
                    // Priority 1: anchor with signup href — use its bounding rect centre
                    var byHref = anchors.find(function(a){
                      var h = a.getAttribute('href') || '';
                      return h.includes('/accounts/signup') && !h.includes('email') && !h.includes('phone') && !h.includes('login');
                    });
                    if (byHref) { var r=byHref.getBoundingClientRect(); if(r.width>0) return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),found:'href:'+byHref.getAttribute('href')}; }
                    // Priority 2: visible button/link with signup text
                    var byText = Array.from(document.querySelectorAll('a,button,div[role="button"],span[role="button"]'))
                      .find(function(e){
                        var r = e.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) return false;
                        var t = (e.innerText||e.textContent||'').trim().toLowerCase();
                        return t === 'sign up' || t === 'create new account' || t === 'create account';
                      });
                    if (byText) { var r2=byText.getBoundingClientRect(); return {x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2),found:'text:'+(byText.textContent||'').trim().slice(0,40)}; }
                    return null;
                  })()`);
                  relay(`[step2a] Sign Up nav target: ${signupNavTarget ? JSON.stringify(signupNavTarget) : "null — no signup element found"}`);
                  if (signupNavTarget) {
                    const nx = (signupNavTarget as any).x as number;
                    const ny = (signupNavTarget as any).y as number;
                    // Fire touch-typed CDP click: isTrusted=true, pointerType="touch"
                    try {
                      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed",  x: nx, y: ny, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
                      await sleep(60);
                      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: nx, y: ny, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
                      relay(`[step2a] Touch-typed CDP click dispatched at (${nx},${ny})`);
                    } catch {}
                  }
                  // Belt-and-suspenders: also synthesizeTapGesture
                  await tap(pos.x, pos.y);
                  await sleep(1500);

                  relay(`[step2a] Post-click URL: ${wc.getURL()}`);

                  // Wait up to 20s for the URL to reach /accounts/signup/phone
                  reachedPhone = await waitForUrl(
                    url => url.includes("accounts/signup/phone") || (url.includes("accounts/signup") && !url.includes("email")),
                    "/accounts/signup/phone",
                    20000,
                  );

                  if (!reachedPhone) {
                    relay(`[step2a] ⚠ URL did not reach phone gate after attempt ${attempt} — URL: ${wc.getURL()}`);
                    // Dump page state to understand what went wrong
                    const title = await js(`document.title`);
                    const snippet = await js(`document.body?.innerText?.slice(0,400)`);
                    relay(`[debug] Page title: ${title}`);
                    relay(`[debug] Page snippet: ${snippet}`);
                  }
                }

                if (!reachedPhone) {
                  relay("❌ [step2a] Never reached /accounts/signup/phone after 3 click attempts — stopping.");
                  relay("[debug] Possible causes: Sign Up button not found, Instagram redirected to login, or SPA routing blocked click.");
                  return;
                }

                relay(`✅ [step2a] Confirmed on phone gate — URL: ${wc.getURL()}`);
                await sleep(1500); // let page settle before next click
              }

              // ── 2b: On phone gate — CLICK "Sign up with email", wait for /accounts/signup/email ──
              // This step only runs if we are NOT already on the email form.
              // We must be on /accounts/signup/phone (confirmed above) before clicking.
              if (!onEmailForm) {
                relay(`[step2b] On phone gate (URL: ${wc.getURL()}) — looking for 'Sign up with email' to CLICK…`);
                await dumpClickables("step2b-phone-gate");

                const EMAIL_LABELS = [
                  "sign up with email", "sign up with email address",
                  "use email", "use email address", "use your email address",
                  "email address",
                ];

                let reachedEmail = false;
                for (let attempt = 1; attempt <= 3 && !reachedEmail; attempt++) {
                  relay(`[step2b] Attempt ${attempt}/3 — searching for 'Sign up with email'…`);

                  const emailPos = await js(findByTextScript(EMAIL_LABELS)) as {x:number;y:number}|null;
                  relay(`[step2b] 'Sign up with email' found: ${emailPos ? `x=${emailPos.x} y=${emailPos.y}` : "NOT FOUND"}`);

                  if (!emailPos) {
                    relay(`[step2b] ⚠ Not found on attempt ${attempt} — waiting 2s…`);
                    await dumpClickables(`step2b-attempt${attempt}-not-found`);
                    await sleep(2000);
                    continue;
                  }

                  // Same touch-typed CDP click strategy as step 2a — no JS element.click().
                  relay(`[step2b] Resolving 'Sign up with email' coords for touch-typed CDP click…`);
                  const emailNavTarget = await js(`(function(){
                    // Priority 1: anchor with emailsignup href
                    var byHref = Array.from(document.querySelectorAll('a')).find(function(a){
                      var h = a.getAttribute('href') || '';
                      return h.includes('emailsignup') || h.includes('signup/email');
                    });
                    if (byHref) { var r=byHref.getBoundingClientRect(); if(r.width>0) return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),found:'href:'+byHref.getAttribute('href')}; }
                    // Priority 2: visible element with email signup text
                    var byText = Array.from(document.querySelectorAll('a,button,div[role="button"],span[role="button"]'))
                      .find(function(e){
                        var r = e.getBoundingClientRect();
                        if (r.width <= 0 || r.height <= 0) return false;
                        var t = (e.innerText||e.textContent||'').trim().toLowerCase();
                        return t.includes('sign up with email') || t.includes('use email') || t === 'email address';
                      });
                    if (byText) { var r2=byText.getBoundingClientRect(); return {x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2),found:'text:'+(byText.textContent||'').trim().slice(0,40)}; }
                    return null;
                  })()`);
                  relay(`[step2b] Email nav target: ${emailNavTarget ? JSON.stringify(emailNavTarget) : "null — no element found"}`);
                  if (emailNavTarget) {
                    const enx = (emailNavTarget as any).x as number;
                    const eny = (emailNavTarget as any).y as number;
                    try {
                      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed",  x: enx, y: eny, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
                      await sleep(60);
                      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: enx, y: eny, button: "left", clickCount: 1, modifiers: 0, pointerType: "touch" });
                      relay(`[step2b] Touch-typed CDP click dispatched at (${enx},${eny})`);
                    } catch {}
                  }
                  // Belt-and-suspenders: synthesizeTapGesture
                  await tap(emailPos.x, emailPos.y);
                  await sleep(1500);

                  relay(`[step2b] Post-click URL: ${wc.getURL()}`);

                  // Wait up to 20s for the URL to reach /accounts/signup/email
                  reachedEmail = await waitForUrl(
                    url => url.includes("emailsignup") || url.includes("signup/email"),
                    "/accounts/signup/email",
                    20000,
                  );

                  if (!reachedEmail) {
                    relay(`[step2b] ⚠ URL did not reach email form after attempt ${attempt} — URL: ${wc.getURL()}`);
                    const title2 = await js(`document.title`);
                    const snippet2 = await js(`document.body?.innerText?.slice(0,400)`);
                    relay(`[debug] Page title: ${title2}`);
                    relay(`[debug] Page snippet: ${snippet2}`);
                    await dumpClickables(`step2b-attempt${attempt}-after-fail`);
                  }
                }

                if (!reachedEmail) {
                  relay("❌ [step2b] Never reached /accounts/signup/email after 3 click attempts — stopping.");
                  relay("[debug] Possible causes: 'Sign up with email' not found, wrong element tapped, or Instagram SPA routing failed.");
                  return;
                }

                relay(`✅ [step2b] Confirmed on email signup form — URL: ${wc.getURL()}`);
                await sleep(1500); // let form settle before filling
              }

              relay(`[step2] Step 2 complete ✅ — URL: ${wc.getURL()}`);
            }

            // ── Step 3: Fill email address ────────────────────────────────────
            // Verify the email field is actually on screen before attempting to type
            relay("Waiting for email field…");
            let emailPos: {x:number;y:number}|null = null;
            for (let poll = 0; poll < 10; poll++) {
              emailPos = await js(findInputScript([
                "emailOrPhone", "email", "Email", "Mobile Number or Email", "Mobile number or email address",
              ])) as {x:number;y:number}|null;
              if (emailPos) break;
              await sleep(800);
            }
            if (!emailPos) { relay("❌ Email field not found after 8 s — cookie banner may still be visible or page did not load correctly. Stopping."); return; }
            relay("✅ Email field found — filling…");
            await clearAndType(emailPos.x, emailPos.y, email);
            await sleep(600);

            // Click Next — verify the button exists before continuing to code-wait step
            const nextOk = await waitAndTap(["next", "continue"], "Next (after email)");
            if (!nextOk) { relay("❌ 'Next' button not found after email entry — stopping. The email may have been rejected or the form layout changed."); return; }
            await sleep(3500);

            // ── Step 4: Verification code — poll until frontend provides it ───
            relay("⏳ Waiting for verification code — use 'Fetch from IMAP' or type it manually and click 'Submit Code'…");
            let verifyCode = "";
            const codeTimeout = Date.now() + 5 * 60 * 1000; // 5 min
            while (!verifyCode && Date.now() < codeTimeout) {
              try {
                if (_serverPort) {
                  const cr = await fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-code-peek?slot=${slot}`);
                  const cj = await cr.json() as any;
                  if (cj.code) { verifyCode = String(cj.code).trim(); break; }
                }
              } catch {}
              await sleep(3000);
            }

            if (!verifyCode) { relay("⚠ Timed out waiting for verification code (5 min)"); return; }

            relay(`Got code: ${verifyCode} — entering…`);
            await sleep(500);

            const codePos = await js(findInputScript([
              "code", "confirmationCode", "Confirmation code", "Enter confirmation code", "Verification code",
            ])) as {x:number;y:number}|null;
            if (codePos) {
              await clearAndType(codePos.x, codePos.y, verifyCode);
              await sleep(500);
              await waitAndTap(["next", "confirm", "continue", "verify"], "Next (after code)");
              await sleep(3000);
            } else {
              relay("⚠ Code input not found — entering via keyboard only");
              await typeText(verifyCode);
              await sleep(500);
              await waitAndTap(["next", "confirm", "continue"], "Next (after code)");
              await sleep(3000);
            }

            // ── Step 4b: Password page (appears before DOB in current IG flow) ─
            // Instagram's email signup now shows password on its own step right
            // after the email-verification code. Detect it and fill before DOB.
            let passwordFilled = false;
            {
              relay(`[debug] Checking for password page — URL: ${wc.getURL()}`);
              let pwPosEarly = await js(findInputScript([
                "password", "Password", "Create a password",
              ])) as {x:number;y:number}|null;
              relay(`[debug] Password field detected: ${pwPosEarly ? `yes at ${pwPosEarly.x},${pwPosEarly.y}` : "no"}`);
              if (!pwPosEarly) {
                // Give the page a moment to finish transitioning
                await sleep(1800);
                pwPosEarly = await js(findInputScript([
                  "password", "Password", "Create a password",
                ])) as {x:number;y:number}|null;
                relay(`[debug] Password field after 1.8s wait: ${pwPosEarly ? `yes at ${pwPosEarly.x},${pwPosEarly.y}` : "no"}`);
              }
              if (pwPosEarly) {
                relay("Password page detected — filling password…");
                await clearAndType(pwPosEarly.x, pwPosEarly.y, password);
                await sleep(800);
                const pwNextOk = await waitAndTap(["next", "continue"], "Next (after password)");
                if (!pwNextOk) relay("⚠ 'Next' not found after password — Instagram may be showing a validation error. Check the browser window.");

                // Wait for a POSITIVE indicator that we've left the password page:
                // poll for the DOB month selector to appear (not just for the password
                // field to disappear — the field can hide mid-animation while still
                // being the focused element, causing the next clearAndType to type into it).
                relay("Waiting for DOB page to appear after password…");
                const dobReadyDeadline = Date.now() + 12000;
                let dobReady = false;
                while (Date.now() < dobReadyDeadline) {
                  await sleep(700);
                  const curUrl = wc.getURL();
                  // Check for DOB selects (native or aria-label)
                  const hasDob = await js(`(function(){
                    var s=document.querySelector('select[aria-label*="Month"],select[aria-label*="month"],[aria-label*="Month"],[aria-label*="month"],select');
                    if(s){var r=s.getBoundingClientRect();if(r.width>0&&r.height>0)return true;}
                    // Also check for the password field being gone AND URL changed
                    var pw=document.querySelector('input[type="password"]');
                    return !pw || pw.getBoundingClientRect().width===0;
                  })()`);
                  relay(`[debug] DOB wait — URL: ${curUrl} | dobSignal: ${hasDob}`);
                  if (hasDob) { dobReady = true; break; }
                }
                if (!dobReady) relay("⚠ DOB page did not appear within 12 s after password — proceeding anyway");
                await sleep(800); // extra settle
                passwordFilled = true;
                relay(`[debug] Password step complete. URL now: ${wc.getURL()}`);
              }
            }

            // ── Step 5: Date of Birth ─────────────────────────────────────────
            relay(`[debug] Starting DOB step — URL: ${wc.getURL()}`);
            relay("Filling date of birth…");
            const dobParts = dob.split("/");
            const dobDay   = parseInt(dobParts[0] ?? "15", 10);
            const dobMonth = parseInt(dobParts[1] ?? "6",  10);
            const dobYear  = parseInt(dobParts[2] ?? "1995", 10);

            // ── Method 1: Drum / scroll-wheel picker (mobile Instagram UI) ──────
            // Mobile Instagram shows a spinning drum picker — 3 scrollable columns
            // (Month, Day, Year) where you SWIPE up/down to change the value.
            // There are no <select> elements and no text inputs; the drums have
            // role="listbox" / role="option" ARIA attributes.
            // We scroll each column using CDP synthesizeScrollGesture (touch gesture)
            // so it looks exactly like a human finger swiping the drum.
            const drumProbe = await js(`(function(){
              var cols=Array.from(document.querySelectorAll('[role="listbox"]'));
              if(!cols.length) return null;
              var result=[];
              for(var i=0;i<cols.length;i++){
                var col=cols[i];
                var items=Array.from(col.querySelectorAll('[role="option"]'));
                if(items.length<2) continue;
                var rect=col.getBoundingClientRect();
                if(!rect.width||!rect.height) continue;
                var r0=items[0].getBoundingClientRect();
                var r1=items.length>1?items[1].getBoundingClientRect():null;
                var itemH=r1?Math.abs(r1.top-r0.top):44;
                if(itemH<8) itemH=44;
                // Find currently centered item (visible in the column window)
                var midY=rect.top+rect.height/2,bestK=0,bestD=1e9;
                for(var k=0;k<items.length;k++){
                  var ir=items[k].getBoundingClientRect();
                  var d=Math.abs((ir.top+ir.height/2)-midY);
                  if(d<bestD){bestD=d;bestK=k;}
                }
                result.push({
                  label:(col.getAttribute('aria-label')||'').toLowerCase(),
                  cx:Math.round(rect.left+rect.width/2),
                  cy:Math.round(rect.top+rect.height/2),
                  items:items.map(function(it){return(it.innerText||it.textContent||'').trim();}),
                  curIdx:bestK,
                  itemH:Math.round(itemH)
                });
              }
              return result.length>=2?result:null;
            })()`) as {label:string;cx:number;cy:number;items:string[];curIdx:number;itemH:number}[]|null;

            if (drumProbe && drumProbe.length >= 2) {
              relay(`[debug] DOB: drum picker detected (${drumProbe.length} columns)`);
              const monthNames = ["january","february","march","april","may","june","july","august","september","october","november","december"];
              for (const col of drumProbe) {
                const lbl   = col.label;
                const items = col.items;
                let targetIdx = -1;

                // Identify column type by label or item content
                const isMonthCol = lbl.includes("month") || items.some(v => monthNames.includes(v.toLowerCase()));
                const isYearCol  = lbl.includes("year")  || items.some(v => parseInt(v) > 1900 && parseInt(v) < 2100);
                const isDayCol   = lbl.includes("day")   || (!isMonthCol && !isYearCol);

                if (isMonthCol) {
                  targetIdx = items.findIndex(v => {
                    const n = parseInt(v);
                    if (!isNaN(n)) return n === dobMonth;
                    return monthNames.indexOf(v.toLowerCase()) + 1 === dobMonth;
                  });
                } else if (isYearCol) {
                  targetIdx = items.findIndex(v => parseInt(v) === dobYear);
                } else if (isDayCol) {
                  targetIdx = items.findIndex(v => parseInt(v) === dobDay);
                }

                if (targetIdx === -1) {
                  relay(`[debug] DOB drum: col="${lbl}" — target not found in items, skipping`);
                  continue;
                }
                const delta = targetIdx - col.curIdx;
                if (delta === 0) {
                  relay(`[debug] DOB drum: col="${lbl}" already at target (idx=${targetIdx})`);
                  continue;
                }
                // Swipe: yDistance negative = scroll UP = higher-indexed items come into view
                const yDist = -(delta * col.itemH);
                relay(`[debug] DOB drum: col="${lbl}" curIdx=${col.curIdx} targetIdx=${targetIdx} delta=${delta} yDist=${yDist} itemH=${col.itemH}`);
                try {
                  await wc.debugger.sendCommand("Input.synthesizeScrollGesture", {
                    x: col.cx,
                    y: col.cy,
                    xDistance: 0,
                    yDistance: yDist,
                    speed: 350 + Math.round(Math.random() * 100),
                    gestureSourceType: "touch",
                  });
                } catch (scrollErr: any) {
                  relay(`[debug] DOB drum scroll err: ${scrollErr?.message}`);
                }
                await sleep(500 + Math.round(Math.random() * 300));
              }
              await sleep(800);
            } else {
              // ── Method 2: Native <select> dropdowns (desktop/hybrid UI) ────────
              await js(`(function(){
                var selects=Array.from(document.querySelectorAll('select'));
                for(var i=0;i<selects.length;i++){
                  var s=selects[i];
                  var opts=Array.from(s.options).map(function(o){return o.text||o.value;});
                  var hasMonthName=opts.some(function(o){return/january|february|march|april|may|june|july|august|september|october|november|december/i.test(o);});
                  var hasMonthNum=opts.some(function(o){return o.trim()==='1'||o.trim()==='01';});
                  if(hasMonthName||hasMonthNum){
                    for(var k=0;k<s.options.length;k++){
                      var ov=s.options[k].value;
                      if(ov===${dobMonth}||ov==='${String(dobMonth).padStart(2,"0")}'){
                        s.selectedIndex=k;s.dispatchEvent(new Event('change',{bubbles:true}));break;
                      }
                    }
                  } else if(opts.some(function(o){return parseInt(o)>1900&&parseInt(o)<2100;})){
                    for(var k2=0;k2<s.options.length;k2++){
                      if(s.options[k2].value=='${dobYear}'||s.options[k2].text=='${dobYear}'){
                        s.selectedIndex=k2;s.dispatchEvent(new Event('change',{bubbles:true}));break;
                      }
                    }
                  } else if(opts.some(function(o){return parseInt(o)>0&&parseInt(o)<=31;})){
                    for(var k3=0;k3<s.options.length;k3++){
                      if(s.options[k3].value=='${dobDay}'||s.options[k3].value==='${String(dobDay).padStart(2,"0")}'){
                        s.selectedIndex=k3;s.dispatchEvent(new Event('change',{bubbles:true}));break;
                      }
                    }
                  }
                }
                function setNativeVal(sel,val){var el=document.querySelector(sel);if(!el||el.tagName!=='SELECT')return;var nativeInputValueSetter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;nativeInputValueSetter.call(el,val);el.dispatchEvent(new Event('change',{bubbles:true}));}
                setNativeVal('[aria-label*="Month"],[aria-label*="month"]','${dobMonth}');
                setNativeVal('[aria-label*="Day"],[aria-label*="day"]','${dobDay}');
                setNativeVal('[aria-label*="Year"],[aria-label*="year"]','${dobYear}');
              })()`);
              await sleep(800);

              // ── Method 3: Combined text input "Birthday (MM/DD/YYYY)" ──────────
              // IMPORTANT: do NOT use clearAndType here.
              // clearAndType taps the field first → on mobile Instagram that opens
              // the drum picker overlay → then it tries to type text while the picker
              // is open → characters land nowhere.  Instead: tap → wait → re-probe
              // for the picker (it only appears AFTER a tap) → if found scroll it,
              // if not found set value via the JS native-value-setter (React-safe).
              const dobDiag = await js(`(function(){
                var selects=Array.from(document.querySelectorAll('select')).filter(function(s){var r=s.getBoundingClientRect();return r.width>0;});
                var inputs=Array.from(document.querySelectorAll('input')).filter(function(i){
                  if(i.type==='hidden'||i.type==='submit'||i.type==='button'||i.type==='checkbox'||i.type==='radio') return false;
                  var r=i.getBoundingClientRect(); return r.width>0&&r.height>0;
                });
                return {selectCount:selects.length,inputs:inputs.map(function(i){return{type:i.type,placeholder:i.placeholder,aria:i.getAttribute('aria-label'),val:i.value};})};
              })()`);
              relay(`[debug] DOB DOM — selects:${(dobDiag as any)?.selectCount} visibleInputs:${JSON.stringify((dobDiag as any)?.inputs)}`);

              if (((dobDiag as any)?.selectCount ?? 0) === 0) {
                const dobTextInputPos = await js(`(function(){
                  var inputs=Array.from(document.querySelectorAll('input'));
                  var inp=inputs.find(function(i){
                    var lbl=(i.getAttribute('aria-label')||i.placeholder||i.getAttribute('name')||'').toLowerCase();
                    return lbl.includes('birthday')||lbl.includes('birth')||lbl.includes('mm/dd')||lbl.includes('dd/mm')||lbl.includes('date');
                  });
                  if(!inp){
                    inp=inputs.find(function(i){
                      if(i.type==='hidden'||i.type==='submit'||i.type==='button'||i.type==='checkbox'||i.type==='radio'||i.type==='password') return false;
                      var r=i.getBoundingClientRect(); return r.width>0&&r.height>0;
                    });
                  }
                  if(!inp) return null;
                  var r=inp.getBoundingClientRect();
                  return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),placeholder:inp.placeholder,aria:inp.getAttribute('aria-label')};
                })()`);
                if (dobTextInputPos) {
                  const mm = String(dobMonth).padStart(2, "0");
                  const dd = String(dobDay).padStart(2, "0");
                  const dateStr = `${mm}/${dd}/${dobYear}`;
                  relay(`[debug] DOB text input at (${(dobTextInputPos as any).x},${(dobTextInputPos as any).y}) — tapping to check if picker opens…`);

                  // Step 1: tap field (may open drum picker overlay on mobile)
                  await tap((dobTextInputPos as any).x, (dobTextInputPos as any).y);
                  await sleep(900); // wait for picker animation

                  // Step 2: re-probe for drum picker AFTER the tap
                  const drumAfterTap = await js(`(function(){
                    var cols=Array.from(document.querySelectorAll('[role="listbox"]'));
                    if(!cols.length)return null;
                    var result=[];
                    for(var i=0;i<cols.length;i++){
                      var col=cols[i];var items=Array.from(col.querySelectorAll('[role="option"]'));
                      if(items.length<2)continue;
                      var rect=col.getBoundingClientRect();if(!rect.width||!rect.height)continue;
                      var r0=items[0].getBoundingClientRect();
                      var r1=items.length>1?items[1].getBoundingClientRect():null;
                      var itemH=r1?Math.abs(r1.top-r0.top):44;if(itemH<8)itemH=44;
                      var midY=rect.top+rect.height/2,bestK=0,bestD=1e9;
                      for(var k=0;k<items.length;k++){var ir=items[k].getBoundingClientRect();var d=Math.abs((ir.top+ir.height/2)-midY);if(d<bestD){bestD=d;bestK=k;}}
                      result.push({label:(col.getAttribute('aria-label')||'').toLowerCase(),cx:Math.round(rect.left+rect.width/2),cy:Math.round(rect.top+rect.height/2),items:items.map(function(it){return(it.innerText||it.textContent||'').trim();}),curIdx:bestK,itemH:Math.round(itemH)});
                    }
                    return result.length>=2?result:null;
                  })()`);

                  if (drumAfterTap && (drumAfterTap as any[]).length >= 2) {
                    // Drum picker appeared after the tap — scroll each column to target
                    relay(`[debug] DOB: drum picker appeared after tap (${(drumAfterTap as any[]).length} cols) — scrolling…`);
                    const monthNamesM3 = ["january","february","march","april","may","june","july","august","september","october","november","december"];
                    for (const col of drumAfterTap as {label:string;cx:number;cy:number;items:string[];curIdx:number;itemH:number}[]) {
                      const lbl = col.label; const items = col.items;
                      let targetIdx = -1;
                      const isMonthCol = lbl.includes("month") || items.some(v => monthNamesM3.includes(v.toLowerCase()));
                      const isYearCol  = lbl.includes("year")  || items.some(v => parseInt(v) > 1900 && parseInt(v) < 2100);
                      const isDayCol   = lbl.includes("day")   || (!isMonthCol && !isYearCol);
                      if (isMonthCol)     { targetIdx = items.findIndex(v => { const n=parseInt(v); if(!isNaN(n)) return n===dobMonth; return monthNamesM3.indexOf(v.toLowerCase())+1===dobMonth; }); }
                      else if (isYearCol) { targetIdx = items.findIndex(v => parseInt(v) === dobYear); }
                      else if (isDayCol)  { targetIdx = items.findIndex(v => parseInt(v) === dobDay); }
                      if (targetIdx === -1) { relay(`[debug] DOB drum post-tap: col="${lbl}" target not found`); continue; }
                      const delta = targetIdx - col.curIdx;
                      if (delta === 0) { relay(`[debug] DOB drum post-tap: col="${lbl}" already at target`); continue; }
                      relay(`[debug] DOB drum post-tap: col="${lbl}" delta=${delta} yDist=${-(delta*col.itemH)}`);
                      try {
                        await wc.debugger.sendCommand("Input.synthesizeScrollGesture", {
                          x: col.cx, y: col.cy, xDistance: 0, yDistance: -(delta * col.itemH),
                          speed: 350 + Math.round(Math.random() * 100), gestureSourceType: "touch",
                        });
                      } catch {}
                      await sleep(500 + Math.round(Math.random() * 300));
                    }
                    await sleep(800);
                  } else {
                    // No picker — plain editable text input.
                    // Use clearAndType (tap + native clear + typeTextCDP character-by-character)
                    // so Instagram sees individual keystrokes instead of a programmatic paste.
                    // The JS native setter approach looks like a paste to Instagram's input
                    // heuristics and can trigger bot detection.
                    relay(`[debug] DOB: no picker after tap — typing "${dateStr}" character by character…`);
                    await clearAndType((dobTextInputPos as any).x, (dobTextInputPos as any).y, dateStr);
                    await sleep(400);
                  }
                } else {
                  relay("⚠ DOB: no drum, no selects, no text input found — tapping Next anyway");
                }
              }
            }

            // The mobile drum-picker dialog has a "SET" confirmation button;
            // the regular flow uses "Next" / "Continue". Accept all three.
            await waitAndTap(["set", "next", "continue"], "Set/Next (after DOB)");
            await sleep(2800);

            // ── Step 6: Full name ──────────────────────────────────────────────
            // A real user ALWAYS fills in their name. An empty name field at
            // account creation is a strong bot signal — Instagram's risk model
            // sees blank-name accounts and flags them at the final submit step.
            // Generate a random but realistic first + last name from common pools.
            const _firstNames = ["Emma","Liam","Olivia","Noah","Ava","James","Sophia","William","Isabella","Oliver","Charlotte","Benjamin","Amelia","Elijah","Mia","Lucas","Harper","Mason","Evelyn","Logan","Abigail","Ethan","Emily","Aiden","Ella","Jackson","Elizabeth","Sebastian","Camila","Mateo","Luna","Jack","Sofia","Owen","Chloe","Samuel","Victoria","Ryan","Riley","Daniel","Aria","Luke","Madison","Gabriel","Layla","Alexander","Penelope","Jayden","Grace","Christopher"];
            const _lastNames = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Wilson","Martinez","Anderson","Taylor","Thomas","Hernandez","Moore","Martin","Jackson","Thompson","White","Lopez","Lee","Gonzalez","Harris","Clark","Lewis","Robinson","Walker","Perez","Hall","Young","Allen","Sanchez","Wright","King","Scott","Green","Baker","Adams","Nelson","Hill","Ramirez","Campbell","Mitchell","Roberts","Carter","Phillips","Evans","Turner","Torres","Parker"];
            const _randFirst = _firstNames[Math.floor(Math.random() * _firstNames.length)];
            const _randLast  = _lastNames[Math.floor(Math.random() * _lastNames.length)];
            const _fullName  = `${_randFirst} ${_randLast}`;
            relay(`Name screen — filling "${_fullName}"…`);

            // Wait for the name field to appear
            const namePos = await js(`(function(){
              var inputs = Array.from(document.querySelectorAll('input'));
              var n = inputs.find(function(el){
                var a=(el.getAttribute('aria-label')||'').toLowerCase();
                var p=(el.placeholder||'').toLowerCase();
                var nm=(el.name||'').toLowerCase();
                return a.includes('name')||p.includes('name')||nm.includes('name')||nm==='fullName';
              });
              if(!n)return null;
              var r=n.getBoundingClientRect();
              return r.width>0&&r.height>0?{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}:null;
            })()`);
            if (namePos) {
              await clearAndType(namePos.x, namePos.y, _fullName);
              await sleep(800);
            } else {
              // Name field not found — skip gracefully (field may be optional or hidden)
              relay("⚠ Name field not found — skipping name (field may not be present in this flow)");
            }

            const nameNextOk = await waitAndTap(["next", "continue", "skip"], "Next (after name)", 8000);
            if (!nameNextOk) {
              await tap(400, 100);
              await sleep(500);
              await waitAndTap(["next", "continue"], "Next (after name, retry)");
            }
            await sleep(2800);

            // ── Step 7: Username ──────────────────────────────────────────────
            relay("Filling username…");
            const unamePos = await js(findInputScript([
              "username", "Username", "user name", "Choose a username",
            ])) as {x:number;y:number}|null;
            if (unamePos) {
              await clearAndType(unamePos.x, unamePos.y, username);
              await sleep(1200);
              await waitAndTap(["next", "continue"], "Next (after username)");
              await sleep(2800);
            } else {
              relay("⚠ Username field not found");
            }

            // ── Step 8: Password (fallback — only if Step 4b didn't already fill it) ─
            if (!passwordFilled) {
              const pwPos = await js(findInputScript([
                "password", "Password", "Create a password",
              ])) as {x:number;y:number}|null;
              if (pwPos) {
                relay("Filling password (late-stage)…");
                await clearAndType(pwPos.x, pwPos.y, password);
                await sleep(500);
                await waitAndTap(["next", "continue"], "Next (after password)");
                await sleep(2800);
              }
            }

            // ── Step 9: Accept terms ──────────────────────────────────────────
            relay("Accepting terms…");
            await waitAndTap(["i agree", "agree to", "accept", "next", "continue", "done"], "I agree (terms)");
            await sleep(2000);

            await relayDone();
          } catch (err: any) {
            relay(`⚠ Signup error: ${err?.message ?? String(err)}`);
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ msg: `⚠ Signup error: ${err?.message ?? String(err)}`, done: true, slot }),
              }).catch(() => {});
            }
          }
        })().catch((err: any) => {
          console.log(`[ghost-signup] OUTER CATCH: ${err?.message ?? String(err)}`);
        });

        return;
      }

      send(res, 404, { error: "not found" });
    } catch (e: any) {
      send(res, 500, { error: e?.message ?? String(e) });
    }
  });

  // Node.js 18+ defaults requestTimeout to 300 000 ms (5 minutes).
  // The silent-verify doAutoLogin can legitimately run longer than that —
  // Node kills the TCP connection at exactly 300 s, which lands as a
  // "fetch failed" error in electronSilentVerify(). Disable both timeouts
  // so the IPC connection stays open for as long as the handler needs.
  server.requestTimeout = 0;
  server.headersTimeout = 0;

  // Fetch the latest stable Chrome version immediately at startup, then
  // refresh every 24 h so UAs never drift stale again without manual bumps.
  refreshChromeVersion();
  setInterval(refreshChromeVersion, _CHROME_VERSION_CACHE_TTL).unref();

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
