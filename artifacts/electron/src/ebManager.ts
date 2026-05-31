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

import { BrowserWindow, BrowserView, Menu, session as electronSession, ipcMain, WebContents } from "electron";
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

  const navHtml = `<button title="Back" onclick="cmd('back')">&#9664;</button><button title="Forward" onclick="cmd('forward')">&#9654;</button><button title="Reload" onclick="cmd('reload')">&#8635;</button><button title="Instagram Home" onclick="cmd('navigate',{url:'https://www.instagram.com/'})"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></button><span class="sep"></span><input id="url" type="text" spellcheck="false"><span class="sep"></span><button id="lbtn" title="Fill login fields and submit" onclick="doLogin()">Login</button><button title="Generate TOTP code" onclick="cmd('totp')">2FA</button><button title="Type phone number" onclick="cmd('phone')">Phone</button><button title="Type email address" onclick="cmd('email-user')">Email</button><button title="Type email password" onclick="cmd('email-pass')">Email Pass</button><button title="Run in-app leak test — checks IP, WebRTC, WebDriver, Canvas, Audio, WebGL and more" onclick="cmd('leak-check')" style="color:#16a34a;border-color:#16a34a;font-weight:600">&#128737; Leak Check</button><span class="sep"></span><span id="timer">0:00</span>`;

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
// autoFill is only supplied when called from inside openEbWindow (main EB window).
// Tab BrowserViews and other callers pass nothing so they only get cookie dismiss + focus tracking.
function buildPageUtilsJs(autoFill?: { username: string; password: string }): string {
  const afJson = autoFill ? JSON.stringify(autoFill) : "null";
  return `(function(){
  if(window.__eq_utils_loaded)return;window.__eq_utils_loaded=true;

  // ── Push body below the native 92-px Equinox toolbar ─────────────────────
  if(!document.getElementById('__eq_tb')){var _eq_s=document.createElement('style');_eq_s.id='__eq_tb';_eq_s.textContent='body{padding-top:92px!important;box-sizing:border-box!important}';(document.head||document.documentElement).appendChild(_eq_s);}

  // ── Focus tracking (for toolbar paste buttons) ───────────────────────────
  window.__eq_lastInput=null;
  document.addEventListener('focusin',function(e){
    var t=e.target;
    if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA')){window.__eq_lastInput=t;}
  },true);

  // ── Credential-aware auto-fill ───────────────────────────────────────────
  // Works on any URL — handles hard navigations, SPA pushState, and inline
  // login forms. Uses MutationObserver for instant reaction + polling fallback.
  var AF=${afJson};

  if(AF&&!window.__eq_fill_done){
    var _doFill=function(){
      if(window.__eq_fill_done)return;
      var uInp=document.querySelector('input[name="username"]');
      var pInp=document.querySelector('input[name="password"]');
      if(!uInp||!pInp)return;
      if(!uInp.getBoundingClientRect().width)return; // hidden / not yet visible
      window.__eq_fill_done=true;
      if(window.__eq_mo){window.__eq_mo.disconnect();window.__eq_mo=null;}
      if(window.__eq_fill_poll){clearInterval(window.__eq_fill_poll);window.__eq_fill_poll=null;}
      var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(uInp,AF.username);
      uInp.dispatchEvent(new Event('input',{bubbles:true}));
      setTimeout(function(){
        setter.call(pInp,AF.password);
        pInp.dispatchEvent(new Event('input',{bubbles:true}));
        setTimeout(function(){
          var btn=document.querySelector('button[type="submit"]');
          if(btn&&!btn.disabled)btn.click();
        },500);
      },300);
    };
    // 1. Try immediately (form may already be in the DOM)
    _doFill();
    // 2. MutationObserver — fires instantly whenever DOM changes
    if(!window.__eq_fill_done&&!window.__eq_mo){
      window.__eq_mo=new MutationObserver(function(){_doFill();});
      window.__eq_mo.observe(document.documentElement,{childList:true,subtree:true});
      setTimeout(function(){if(window.__eq_mo){window.__eq_mo.disconnect();window.__eq_mo=null;}},120000);
    }
    // 3. Polling fallback every 800 ms (belt-and-suspenders)
    if(!window.__eq_fill_done&&!window.__eq_fill_poll){
      window.__eq_fill_poll=setInterval(function(){
        if(window.__eq_fill_done){clearInterval(window.__eq_fill_poll);window.__eq_fill_poll=null;return;}
        _doFill();
      },800);
      setTimeout(function(){if(window.__eq_fill_poll){clearInterval(window.__eq_fill_poll);window.__eq_fill_poll=null;}},120000);
    }
  }

  // ── Cookie consent banner post-dismiss navigation ────────────────────────
  // The actual CLICK on the cookie button is done from the main process via
  // sendInputEvent (isTrusted=true, required for Instagram's React handlers).
  // This in-page interval only watches for the banner to disappear, then
  // navigates to the login page if needed (one time).
  if(!window.__eq_cookie_tick){var __eq_ck_seen=false;window.__eq_cookie_tick=setInterval(function(){
    var __ACCEPT=['allow all cookies','accept all cookies','allow all','accept all','allow essential and optional cookies','accept cookies','allow cookies','alle cookies akzeptieren','accepter tout','aceptar todo','accetta tutto','tillåt alla','alle accepteren'];
    function _isCookieAcceptBtn(b){
      if(!b||!b.getBoundingClientRect||b.getBoundingClientRect().width<=0)return false;
      var t=(b.innerText||b.textContent||'').trim().toLowerCase();
      return __ACCEPT.indexOf(t)!==-1;
    }
    var btn=document.querySelector('[data-cookiebanner="accept_button"]')||document.querySelector('[data-testid="cookie-policy-banner-accept"]');
    if(!btn){
      var container=document.querySelector('[data-cookiebanner]')||document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');
      if(container){btn=Array.from(container.querySelectorAll('button,[role="button"],a')).find(_isCookieAcceptBtn)||null;}
    }
    if(!btn){btn=Array.from(document.querySelectorAll('button,[role="button"],a')).find(_isCookieAcceptBtn)||null;}
    if(btn){
      __eq_ck_seen=true;
      // Do NOT click from here — untrusted JS events are ignored by Instagram's
      // React app. The main-process sendInputEvent timer handles the click.
    }else if(__eq_ck_seen){
      // Banner was visible and is now gone (main process clicked it) — navigate to login.
      clearInterval(window.__eq_cookie_tick);window.__eq_cookie_tick=null;
      setTimeout(function(){
        if(AF&&window.__eq_doAutoFill())return;
        var LOGIN_RE=/^log\s*in$/i;
        var loginEl=Array.from(document.querySelectorAll('a[href*="accounts/login"],a[href*="/login/"]')).find(function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
        if(!loginEl){loginEl=Array.from(document.querySelectorAll('a,button')).find(function(el){var t=(el.innerText||el.textContent||'').trim();return LOGIN_RE.test(t)&&el.getBoundingClientRect().width>0;});}
        if(loginEl){loginEl.click();}
      },800);
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
  proxy?: { host: string; port: number; user?: string; pass?: string; type?: string };
  partition: string;
  warmupActive?: boolean;
}
export const ebMap = new Map<number, EbEntry>();

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

function buildFingerprintScript(isMobile: boolean, apiUA: string | null, fp?: EbFingerprintLite | null): string {
  const mf = isMobile ? 'true' : 'false';
  const af = apiUA ? JSON.stringify(apiUA) : 'null';

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
           + `var _CN=(_rI(2,254)),_AN=(_r()*0.0000008+0.0000001);`
           + `var _hx=function(n){var s="";for(var i=0;i<n;i++){s+=("0"+Math.floor(_r()*256).toString(16)).slice(-2);}return s;};`
           + `var _MVID=_hx(16),_MAID=_hx(16),_MSID=_hx(16);`
           + `var _FN=_rI(1,99),_SP=_rI(0,7);`;
  }

  return `(function(){try{
  var _M=${mf},_A=${af};
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
  try{Object.defineProperty(navigator,"webdriver",{get:function(){return undefined;}});}catch(e){}
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
    if(!(navigator).connection){
      var _cn={effectiveType:"4g",downlink:_CDL,rtt:_CRT,saveData:false,type:_CT,onchange:null,
        addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
      setInterval(function(){
        _cn.downlink=Math.max(1,Math.round(_CDL*(0.75+Math.random()*0.5)));
        _cn.rtt=Math.max(5,Math.round(_CRT*(0.75+Math.random()*0.5)));
      },25000+Math.random()*10000);
      try{Object.defineProperty(navigator,"connection",{get:function(){return _cn;},configurable:true});}catch(e){}
    }
    try{var _oMM=window.matchMedia.bind(window);window.matchMedia=function(q){
      var _mql={matches:false,media:q,onchange:null,addListener:function(){},removeListener:function(){},addEventListener:function(){},removeEventListener:function(){},dispatchEvent:function(){return true;}};
      if(/(pointer:\s*coarse|any-pointer:\s*coarse)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(hover:\s*none|any-hover:\s*none)/.test(q))return Object.assign({},_mql,{matches:true});
      if(/(pointer:\s*fine|any-pointer:\s*fine|hover:\s*hover|any-hover:\s*hover)/.test(q))return _mql;
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
  try{window.chrome={app:{isInstalled:false},runtime:{},loadTimes:function(){return{};},csi:function(){return{};}};} catch(e){}
  try{var _oq=navigator.permissions&&navigator.permissions.query.bind(navigator.permissions);
    if(_oq){navigator.permissions.query=function(p){
      return p.name==="notifications"?Promise.resolve({state:"prompt",onchange:null}):_oq(p);};}}catch(e){}
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
      if(a&&a.length>0){var _as=Math.round(_AN*1e7)|1;for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;a[i]+=(_as/0x100000000)*0.0001-0.00005;}}
    };
    var _oGBF=AnalyserNode.prototype.getByteFrequencyData;
    AnalyserNode.prototype.getByteFrequencyData=function(a){
      _oGBF.call(this,a);
      if(a&&a.length>0){var _as=Math.round(_AN*1e7)|1;for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;var v=a[i]+(_as/0x100000000>0.5?1:0);a[i]=Math.max(0,Math.min(255,v));}}
    };
    var _oGFT=AnalyserNode.prototype.getFloatTimeDomainData;
    AnalyserNode.prototype.getFloatTimeDomainData=function(a){
      _oGFT.call(this,a);
      if(a&&a.length>0){var _as=Math.round(_AN*1e7)|1;for(var i=0;i<a.length;i++){_as=Math.imul(1664525,_as)+1013904223>>>0;a[i]=Math.max(-1,Math.min(1,a[i]+(_as/0x100000000)*0.0001-0.00005));}}
    };
  }catch(e){}
  try{
    if(navigator.mediaDevices&&navigator.mediaDevices.enumerateDevices){
      var _oED=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices=function(){
        return _oED().then(function(devs){
          return devs.concat([
            {deviceId:_MVID,groupId:_MVID.slice(0,8),kind:'videoinput',label:'',toJSON:function(){return {};}},
            {deviceId:_MAID,groupId:_MAID.slice(0,8),kind:'audioinput',label:'',toJSON:function(){return {};}},
            {deviceId:_MSID,groupId:_MSID.slice(0,8),kind:'audiooutput',label:'',toJSON:function(){return {};}}
          ]);
        });
      };
    }
  }catch(e){}
  try{
    var _chm=_ua.match(/Chrome\\/([0-9]+)/);
    var _chv=_chm?_chm[1]:"131";
    var _chp=_ua.indexOf("Android")>=0?"Android":"Windows";
    var _chmo=_ua.indexOf("Android")>=0&&_ua.indexOf("Mobile")>=0;
    var _chb=[{brand:"Chromium",version:_chv},{brand:"Google Chrome",version:_chv},{brand:"Not_A Brand",version:"99"}];
    var _chmdl=(function(){var mm=_ua.match(/Android [0-9]+;\\s*([^)]+)\\)/);return mm?mm[1].trim():"";})();
    Object.defineProperty(navigator,"userAgentData",{
      get:function(){
        return{
          brands:_chb,mobile:_chmo,platform:_chp,
          getHighEntropyValues:function(h){
            var rv={brands:_chb,mobile:_chmo,platform:_chp};
            if(h.indexOf("platformVersion")>=0)rv.platformVersion="15.0.0";
            if(h.indexOf("architecture")>=0)rv.architecture="arm";
            if(h.indexOf("bitness")>=0)rv.bitness="64";
            if(h.indexOf("model")>=0)rv.model=_chmdl;
            if(h.indexOf("uaFullVersion")>=0)rv.uaFullVersion=_chv+".0.0.0";
            if(h.indexOf("fullVersionList")>=0)rv.fullVersionList=_chb.map(function(b){return{brand:b.brand,version:_chv+".0.0.0"};});
            return Promise.resolve(rv);
          },
          toJSON:function(){return{brands:_chb,mobile:_chmo,platform:_chp};}
        };
      },configurable:true
    });
  }catch(e){}
  try{
    var _FVAR=['Garamond','Gill Sans MT','Bookman Old Style','Century Gothic','Franklin Gothic Medium','Webdings','Wingdings','Palatino Linotype','Lucida Sans Unicode','Trebuchet MS','Symbol','Comic Sans MS'];
    var _FP={};
    (function(){var _fh=function(f,s){var h=s>>>0;for(var i=0;i<f.length;i++){h=((h<<5)+h+f.charCodeAt(i))>>>0;}return h;};
      for(var _fi=0;_fi<_FVAR.length;_fi++){var _ff=_FVAR[_fi];_FP[_ff]=(_fh(_ff,_FN)%100)<_FN;}})();
    var _oMT=CanvasRenderingContext2D.prototype.measureText;
    CanvasRenderingContext2D.prototype.measureText=function(text){
      var r=_oMT.call(this,text);
      var fs=this.font||'';
      for(var _fn in _FP){if(_FP[_fn]&&fs.indexOf(_fn)>=0){
        return new Proxy(r,{get:function(t,k){return k==='width'?t.width+0.01:Reflect.get(t,k,t);}});
      }}
      return r;
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
}catch(e){}})();`;
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
  const browserUA = `Mozilla/5.0 (Linux; Android ${androidVersion}; ${deviceModel}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36`;
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
  const ses = electronSession.fromPartition(ebPartition(profileId));
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
  proxy?:    { host: string; port: number; user?: string; pass?: string; type?: string };
  userAgent?: string;
  apiUA?:     string;
  password?: string;
  twoFAKey?: string;
  ebFingerprint?: EbFingerprintLite | null;
  /** Ghost Browser only — URL to load directly instead of the login page. */
  initialUrl?: string;
}): Promise<void> {
  const { profileId, username, proxy, userAgent, apiUA, password, twoFAKey, ebFingerprint, initialUrl } = opts;

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
      if (existing.win.isMinimized()) existing.win.restore();
      if (!existing.win.isMaximized()) existing.win.maximize();
      if (!existing.win.isVisible()) existing.win.show();
      existing.win.focus();
      // Toolbar is a native BrowserView — it is always present; nothing to re-inject.
      // If the current page is a chrome error or about:blank, navigate back to Instagram
      const currentUrl: string = existing.win.webContents.getURL();
      if (!currentUrl || currentUrl.startsWith("chrome-error://") || currentUrl === "about:blank") {
        const existingSes = electronSession.fromPartition(existing.partition);
        const existingSessionCks = await existingSes.cookies.get({ name: "sessionid", domain: ".instagram.com" });
        existing.win.webContents.loadURL(
          existingSessionCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
        ).catch(() => {});
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
  const ses = electronSession.fromPartition(partition);

  // Configure proxy.
  // HTTP proxies use fixed_servers + proxyRules with embedded credentials.
  // SOCKS5 proxies also use fixed_servers with socks5:// proxyRules.
  if (proxy) {
    const cfg = buildProxyConfig(proxy);
    console.log(`[EB:open:${profileId}] Setting proxy — type=${proxy.type||"http"} host=${proxy.host}:${proxy.port} hasCredentials=${!!(proxy.user)} proxyRules=${(cfg as any).proxyRules}`);
    await ses.setProxy(cfg);
  } else {
    console.log(`[EB:open:${profileId}] No proxy configured — using direct:// (real machine IP will be exposed)`);
    await ses.setProxy({ proxyRules: "direct://" });
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
  try {
    ses.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
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
  try {
    (ses as any).setDnsOverHttpsConfig?.({ enabled: false });
  } catch { /* non-fatal */ }

  // Flush any stale DNS cache that could route requests around the proxy
  try { await ses.clearHostResolverCache(); } catch {}

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
    await ses.setProxy(buildProxyConfig(proxy));
    await new Promise(r => setTimeout(r, 150));
    await ses.setProxy(buildProxyConfig(proxy));
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
    win.webContents.on("did-navigate", () => {
      ses.setProxy(buildProxyConfig(proxy)).catch(() => {});
    });
  }

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

  if (proxy) {
    // Resolve proxy timezone — awaited here (max 5 s) so it's ready before loadURL.
    let _resolvedTz: string | null = null;
    try {
      const _tzAc = new AbortController();
      const _tzTimer = setTimeout(() => _tzAc.abort(), 5000);
      const tzRes = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(proxy.host)}?fields=timezone`,
        { signal: _tzAc.signal },
      );
      clearTimeout(_tzTimer);
      const tzJson = await tzRes.json() as { timezone?: string };
      if (tzJson.timezone) _resolvedTz = tzJson.timezone;
    } catch { /* ip-api unreachable — skip override, use machine timezone */ }

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
  }
  // No proxy → skip setTimezoneOverride → Chrome uses the real system timezone.
  // No UTC default — a timezone mismatch between Intl and Date.now() is an
  // instant bot signal.

  // ── Fire-and-forget: script injection + locale override ─────────────────────
  // Page.enable and addScriptToEvaluateOnNewDocument CAN hang in the packaged
  // app, so they remain fire-and-forget. Timezone is already set above.
  // ── Resolve browser UA and API UA ─────────────────────────────────────────
  // The Ghost Browser may receive an API-format UA ("34/14; 420dpi; ...")
  // instead of a proper mobile Chrome UA ("Mozilla/5.0 (Linux; Android ...").
  // Always ensure the BrowserWindow uses the correct mobile Chrome UA format.
  const _isApiFormat = !!userAgent && isApiFormatUA(userAgent);
  const _apiParsed   = _isApiFormat ? apiUAToBrowserUA(userAgent!) : null;
  const _browserUA   = _isApiFormat ? _apiParsed!.browserUA : (userAgent ?? null);
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

  const _fpIsMobile = !!_browserUA && (_browserUA.includes("Mobile") || isApiFormatUA(_browserUA));
  const _fpScript   = buildFingerprintScript(_fpIsMobile, _resolvedApiUA ?? null, ebFingerprint ?? null);
  void (async () => {
    try {
      // debugger already attached before this block
      await win.webContents.debugger.sendCommand("Page.enable");
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: WEBRTC_BLOCKER_JS });
      await win.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: _fpScript });

      // ── UA + Client Hints via CDP ──────────────────────────────────────────
      // win.webContents.setUserAgent() alone does NOT update the Sec-CH-UA-*
      // headers — Chromium generates those from the Electron binary's compiled-in
      // platform info (Windows / Mobile: false).  CDP Emulation.setUserAgentOverride
      // overrides BOTH navigator.userAgent AND all Client Hints headers in one call,
      // fixing the "Platform: Windows / Mobile: No" leak that Instagram detects.
      if (_browserUA) {
        try {
          const _chromeMajor = (_browserUA.match(/Chrome\/(\d+)/)?.[1]) ?? "131";
          const _chromeFull  = (_browserUA.match(/Chrome\/([\d.]+)/)?.[1]) ?? "131.0.6778.204";
          await win.webContents.debugger.sendCommand("Emulation.setUserAgentOverride", {
            userAgent: _browserUA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: _fpIsMobile ? "Linux armv8l" : "Win32",
            ...(_fpIsMobile ? {
              userAgentMetadata: {
                brands: [
                  { brand: "Not_A Brand",   version: "8" },
                  { brand: "Chromium",       version: _chromeMajor },
                  { brand: "Google Chrome",  version: _chromeMajor },
                ],
                fullVersionList: [
                  { brand: "Not_A Brand",   version: "8.0.0.0" },
                  { brand: "Chromium",       version: _chromeFull },
                  { brand: "Google Chrome",  version: _chromeFull },
                ],
                platform:        "Android",
                platformVersion: _androidVer,
                architecture:    "",
                model:           _deviceModel,
                mobile:          true,
                bitness:         "",
                wow64:           false,
              },
            } : {}),
          });
          console.log(`[ebManager:${profileId}] Emulation.setUserAgentOverride: UA="${_browserUA.slice(0, 80)}" mobile=${_fpIsMobile} platform=${_fpIsMobile ? "Android" : "Win32"}`);
        } catch (uaErr) {
          console.warn(`[ebManager:${profileId}] Emulation.setUserAgentOverride failed:`, uaErr);
        }
      }

      // ── Locale override — match navigator.languages ─────────────────────────
      // Intl APIs (DateTimeFormat, NumberFormat, Collator) use the real system
      // locale unless overridden at the CDP level.
      try {
        await win.webContents.debugger.sendCommand("Emulation.setLocaleOverride",
          { locale: "en-US" });
      } catch {}

    } catch (err) {
      console.warn(`[ebManager:${profileId}] WebRTC/fingerprint CDP injection failed:`, err);
    }
  })();

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

  // Store in map
  ebMap.set(profileId, { win, username, proxy, partition });

  // Belt-and-suspenders WebRTC block: if CDP injection didn't complete before
  // the first navigation (e.g. debugger attach failed silently in packaged app),
  // executeJavaScript at dom-ready overrides RTCPeerConnection in the main world.
  // dom-ready fires after HTML parsing but before window.onload / setTimeout
  // callbacks — earlier than any real-world leak-test gather loop.
  win.webContents.on("dom-ready", () => {
    win.webContents.executeJavaScript(WEBRTC_BLOCKER_JS).catch(() => {});
    win.webContents.executeJavaScript(_fpScript).catch(() => {});
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
  // Tracks the last focused input field, auto-dismisses cookie banners, and
  // (when credentials are available) polls for the login form and fills it.
  const injectPageUtils = () => {
    const af = password ? { username, password } : undefined;
    win.webContents.executeJavaScript(buildPageUtilsJs(af)).catch(() => {});
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

        const pos = await win.webContents.executeJavaScript(_COOKIE_DETECT_JS).catch(() => null) as
          { x: number; y: number; label: string } | null;

        _ebLog(`CookieCheck#${attempt + 1} url="${win.webContents.getURL().slice(0, 80)}" detect=${pos ? `FOUND label="${pos.label}" at (${pos.x},${pos.y})` : "no-banner"}`);

        if (!pos) break; // banner gone (or never appeared) — stop

        // Use CDP Input.dispatchMouseEvent — same mechanism Puppeteer uses,
        // produces isTrusted=true events that React's synthetic event system
        // handles correctly for both <button> and <a> elements.
        try {
          await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mousePressed", x: pos.x, y: pos.y,
            button: "left", clickCount: 1, modifiers: 0,
          });
          await new Promise(r => setTimeout(r, 60));
          await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
            type: "mouseReleased", x: pos.x, y: pos.y,
            button: "left", clickCount: 1, modifiers: 0,
          });
          _ebLog(`CookieBanner: CDP click dispatched at (${pos.x},${pos.y}) label="${pos.label}"`);
        } catch (cdpErr) {
          // CDP failed — fall back to sendInputEvent
          _ebLog(`CookieBanner: CDP failed (${cdpErr}), falling back to sendInputEvent`);
          win.webContents.focus();
          await humanMouseClick(win.webContents, pos.x, pos.y);
        }
        // Wait then check if it actually dismissed
        await new Promise(r => setTimeout(r, 1500));
        if (win.isDestroyed()) break;
        const stillThere = await win.webContents.executeJavaScript(_COOKIE_DETECT_JS).catch(() => null);
        if (!stillThere) {
          _ebLog(`CookieBanner dismissed after ${attempt + 1} attempt(s)`);
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
          _ebLog(`GhostOverlay#${attempt + 1}: overlay at (${pos.x},${pos.y}), CDP click (beforeUrl=${beforeUrl.slice(0, 80)})`);
          try {
            await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mousePressed", x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 0,
            });
            await new Promise(r => setTimeout(r, 60));
            await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseReleased", x: pos.x, y: pos.y, button: "left", clickCount: 1, modifiers: 0,
            });
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

  // Navigate to the initial URL.
  // Ghost Browser (profileId=-1): load the provided initialUrl (a trending reel) directly —
  // never load the login page or homepage, the warmup handles all navigation.
  // Regular account EBs: go to homepage if sessionid exists, otherwise login page.
  if (profileId === -1) {
    win.webContents.loadURL(initialUrl || "about:blank").catch(() => {});
  } else {
    const sessionCksForNav = await ses.cookies.get({ name: "sessionid", domain: ".instagram.com" });
    win.webContents.loadURL(
      sessionCksForNav.length > 0
        ? "https://www.instagram.com/"
        : "https://www.instagram.com/accounts/login/",
    ).catch(() => {});
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

          // ── Phase 2: fill login form ─────────────────────────────────────────
          await win.webContents.executeJavaScript(`
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
            // Safe: matches any button containing "cookie" but not "decline/reject/refuse"
            function _ckOk(b){if(!b||!b.getBoundingClientRect)return false;if(b.getBoundingClientRect().width<=0)return false;var t=(b.innerText||b.textContent||'').trim().toLowerCase();return t.includes('cookie')&&!/decline|reject|refuse|necessary only|essential only/.test(t);}
            for (let cb = 0; cb < 10; cb++) {
              const ckBtn = (
                document.querySelector('[data-cookiebanner="accept_button"]') ||
                document.querySelector('[data-testid="cookie-policy-banner-accept"]') ||
                (()=>{const c=document.querySelector('[data-cookiebanner]')||document.querySelector('[class*="CookieBanner"],[class*="cookie-banner"],[id*="cookie"]');return c?Array.from(c.querySelectorAll('button,[role="button"]')).find(_ckOk)||null:null;})() ||
                Array.from(document.querySelectorAll('button,[role="button"]')).find(_ckOk)
              );
              if (ckBtn) {
                try{ckBtn.dispatchEvent(new MouseEvent('mouseover',{bubbles:true,cancelable:true,view:window}));}catch(e){}
                try{ckBtn.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,composed:true,isPrimary:true,pointerId:1}));}catch(e){}
                try{ckBtn.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,cancelable:true,view:window}));}catch(e){}
                try{ckBtn.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,cancelable:true,composed:true,isPrimary:true,pointerId:1}));}catch(e){}
                try{ckBtn.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,cancelable:true,view:window}));}catch(e){}
                try{ckBtn.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window}));}catch(e){}
                ckBtn.click();
                await wait(800);
                break;
              }
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
        // Use ebPartition() — not the hardcoded format — so Ghost browser tabs
        // (pid=-1) correctly inherit the Ghost session (and its proxy) instead of
        // falling into a fresh 'persist:eb--1' session with no proxy configured.
        const partition = ebPartition(foundPid);
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
        await openEbWindow({
          profileId: pid,
          username:  body.username  ?? String(pid),
          password:  body.password,
          twoFAKey:  body.twoFAKey,
          proxy:     body.proxy,
          userAgent: body.userAgent,
          apiUA:     body.apiUA,
          ebFingerprint: parsedFp,
          initialUrl: body.initialUrl ?? undefined,
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
          const ses = electronSession.fromPartition(ebPartition(pid));
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
        const partition = ebPartition(pid);
        const ses = electronSession.fromPartition(partition);
        if (body.proxy) {
          await ses.setProxy(buildProxyConfig(body.proxy));
          try { await ses.clearHostResolverCache(); } catch {}
          await new Promise(r => setTimeout(r, 150));
          await ses.setProxy(buildProxyConfig(body.proxy));
          try { (ses as any).setDnsOverHttpsConfig?.({ enabled: false }); } catch {}
        } else {
          await ses.setProxy({ proxyRules: "direct://" });
        }
        try { ses.setWebRTCIPHandlingPolicy("disable_non_proxied_udp"); } catch {}
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

        // Apply the same WebRTC block as the regular EB window (CDP + dom-ready fallback).
        void (async () => {
          try {
            try { hiddenWin.webContents.debugger.attach("1.3"); } catch {}
            await hiddenWin.webContents.debugger.sendCommand("Page.enable");
            await hiddenWin.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: WEBRTC_BLOCKER_JS });
          } catch {}
        })();
        hiddenWin.webContents.on("dom-ready", () => {
          hiddenWin.webContents.executeJavaScript(WEBRTC_BLOCKER_JS).catch(() => {});
        });

        if (body.proxy) {
          hiddenWin.webContents.on("login", (ev: any, _rq: any, _auth: any, cb: any) => {
            ev.preventDefault();
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
