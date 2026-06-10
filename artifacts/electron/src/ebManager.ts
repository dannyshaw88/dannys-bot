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
  const styles = `*{box-sizing:border-box;margin:0;padding:0}body{height:92px;max-height:92px;overflow:hidden;background:#fff;border-bottom:1px solid #e2e8f0;display:flex;flex-direction:column;font-family:-apple-system,"Segoe UI",sans-serif;-webkit-user-select:none;user-select:none}#navbar{height:58px;display:flex;align-items:center;gap:4px;padding:0 8px;flex-shrink:0;overflow:hidden}button{height:30px;min-width:30px;padding:0 8px;background:transparent;border:1px solid #d1d5db;color:#6b7280;border-radius:6px;cursor:pointer;font-size:12px;font-family:inherit;display:flex;align-items:center;gap:3px;white-space:nowrap}button:hover{background:#f3f4f6;color:#374151}button:disabled{opacity:.5;cursor:default}.sep{width:1px;height:18px;background:#e2e8f0;margin:0 2px;flex-shrink:0}#url{flex:1;min-width:0;height:30px;padding:0 8px;background:#f9fafb;border:1px solid #d1d5db;border-radius:6px;color:#111827;font-size:12px;font-family:monospace;outline:none;-webkit-user-select:text;user-select:text}#url:focus{background:#fff;border-color:#3b82f6}#url::selection{background:#bfdbfe;color:#111827}#timer{font-size:11px;color:#9ca3af;white-space:nowrap;min-width:34px;text-align:right;font-variant-numeric:tabular-nums;padding-right:2px}#tabbar{height:34px;background:#f8fafc;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:2px;padding:0 6px;overflow-x:auto;overflow-y:hidden;flex-shrink:0}#tabbar::-webkit-scrollbar{height:3px}#tabbar::-webkit-scrollbar-thumb{background:#d1d5db;border-radius:3px}.tab{height:26px;max-width:160px;min-width:56px;display:flex;align-items:center;gap:3px;padding:0 8px;border-radius:4px;cursor:pointer;font-size:11px;color:#9ca3af;border:1px solid transparent;flex-shrink:0;overflow:hidden}.tab:hover{background:#f1f5f9;color:#374151}.tab.active{background:#fff;border-color:#d1d5db;color:#374151}.tab-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.tab-x{border:none!important;min-width:0!important;height:14px!important;width:14px!important;padding:0!important;font-size:13px!important;line-height:1;color:#9ca3af;flex-shrink:0;background:none!important}.tab-x:hover{color:#374151!important}.newtab{height:22px;min-width:22px;max-width:22px;padding:0!important;font-size:13px;border-style:dashed!important;color:#9ca3af;flex-shrink:0}`;

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
        // Poll up to 5 s for the submit button to become enabled (React re-renders async)
        var _bp=0;var _bi=setInterval(function(){
          if(++_bp>20){clearInterval(_bi);return;}
          var btn=document.querySelector('button[type="submit"]')
            ||Array.from(document.querySelectorAll('button')).find(function(b){var t=(b.innerText||b.textContent||'').trim();return/log[\s-]*in|sign[\s-]*in/i.test(t)&&b.getBoundingClientRect().width>50;});
          if(btn&&!btn.disabled){clearInterval(_bi);btn.click();}
        },250);
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
        if(AF&&window.__eq_fill_done)return;
        var LOGIN_RE=/^log\s*in$/i;
        var loginEl=Array.from(document.querySelectorAll('a[href*="accounts/login"],a[href*="/login/"]')).find(function(el){var r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
        if(!loginEl){loginEl=Array.from(document.querySelectorAll('a,button,[role="button"]')).find(function(el){var t=(el.innerText||el.textContent||'').trim();return LOGIN_RE.test(t)&&el.getBoundingClientRect().width>0;});}
        if(loginEl){
          var r2=loginEl.getBoundingClientRect();
          window.__eq_postCkLoginPos={x:Math.round(r2.left+r2.width/2),y:Math.round(r2.top+r2.height/2)};
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
};

function getChromeBuildInfo(majorVersion: string): { full: string; grease: string; greaseVer: string } {
  return CHROME_BUILD_INFO[majorVersion] ?? { full: `${majorVersion}.0.6778.260`, grease: " Not A;Brand", greaseVer: "8" };
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
      try{Object.defineProperty(_nc,'downlink',{get:function(){return 35+Math.round(Math.random()*25);},configurable:true});}catch(e4){}
      try{Object.defineProperty(_nc,'rtt',{get:function(){return 35+Math.round(Math.random()*30);},configurable:true});}catch(e5){}
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

function buildFingerprintScript(isMobile: boolean, apiUA: string | null, fp?: EbFingerprintLite | null, chromeFullVer?: string | null, greaseBrand?: string | null, greaseBrandVer?: string | null): string {
  const mf = isMobile ? 'true' : 'false';
  const af = apiUA ? JSON.stringify(apiUA) : 'null';
  // Bake real Client Hints values as literals so the injected script can use them
  // without needing access to the CHROME_BUILD_INFO table at runtime.
  const _cfv  = JSON.stringify(chromeFullVer  ?? null);  // e.g. "131.0.6778.260" or null
  const _gbr  = JSON.stringify(greaseBrand    ?? null);  // e.g. " Not A;Brand"   or null
  const _gbv  = JSON.stringify(greaseBrandVer ?? null);  // e.g. "8"              or null

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

  const _ebFpSrc = `(function(){try{
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
            if(h.indexOf("platformVersion")>=0)rv.platformVersion=_chav;
            if(h.indexOf("architecture")>=0)rv.architecture="arm";
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
  userAgent?: string,
): Promise<{ ok: boolean; message: string }> {
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
      const _chromeMajor = (userAgent.match(/Chrome\/(\d+)/)?.[1]) ?? "131";
      const _isMob = userAgent.includes("Mobile") || userAgent.includes("Android");
      const _buildInfo = getChromeBuildInfo(_chromeMajor);
      // Extract Android version from UA string — must match Sec-CH-UA-Platform-Version.
      const _androidVer = userAgent.match(/Android\s+(\d+)/i)?.[1] ?? "15";
      // Extract device model from UA string for Sec-CH-UA-Model.
      const _model = userAgent.match(/Android\s+\d+;\s*([^)]+)\)/i)?.[1]?.trim() ?? "";
      await wc.debugger.sendCommand("Emulation.setUserAgentOverride", {
        userAgent,
        acceptLanguage: "en-US,en;q=0.9",
        platform: _isMob ? "Linux armv8l" : "Win32",
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
          platform: _isMob ? "Android" : "Windows",
          platformVersion: _isMob ? _androidVer : "10.0.0",
          architecture: _isMob ? "arm" : "x86",
          model: _isMob ? _model : "",
          mobile: _isMob,
          bitness: _isMob ? "64" : "",
          wow64: false,
        },
      });
    } catch {}
  }

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
      console.log(`[doAutoLogin:${profileId}] @${username} — cookie banner at (${ckPos.x},${ckPos.y}), dismissing via touch tap`);
      try {
        try { wc.debugger.attach("1.3"); } catch {}
        await cdpTapGesture(wc.debugger, ckPos.x, ckPos.y);
        await delay(2000);
      } catch {}
    }
  }

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
    return { ok: false, message: "Could not find login form on Instagram login page" };
  }

  // Step 2: tap username field (touch event) + type via CDP
  // WHY cdpTapGesture instead of dispatchMouseEvent:
  //   synthesizeTapGesture fires touchstart→touchend→click with pointerType="touch".
  //   dispatchMouseEvent fires mousedown+mouseup — events that never appear on a
  //   real Android phone. Instagram reads event.pointerType to detect mouse input.
  try {
    await cdpTapGesture(wc.debugger, fields.u.x, fields.u.y);
    await delay(150);
    // Select-all + delete any pre-filled content before typing
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await delay(100);
    await typeTextCDP(wc.debugger, username);

    // Step 3: tap password field (touch event) + type via CDP
    await cdpTapGesture(wc.debugger, fields.p.x, fields.p.y);
    await delay(150);
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await delay(100);
    await typeTextCDP(wc.debugger, password);
  } catch (cdpErr: any) {
    console.warn(`[doAutoLogin:${profileId}] CDP form fill failed: ${cdpErr?.message}`);
    return { ok: false, message: `CDP form fill error: ${cdpErr?.message}` };
  }

  // Step 4: poll for submit button position, tap via touch gesture
  {
    let btnPos: { x: number; y: number } | null = null;
    for (let i = 0; i < 20; i++) {
      btnPos = await wc.executeJavaScript(`
        (() => {
          const b = document.querySelector('button[type="submit"]')
            || Array.from(document.querySelectorAll('button')).find(b => /log[\\s-]*in|sign[\\s-]*in/i.test((b.innerText || b.textContent || '').trim()))
            || document.querySelector('form button:not([type="button"])');
          if (!b || b.disabled) return null;
          const r = b.getBoundingClientRect();
          if (r.width <= 0 || r.height <= 0) return null;
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()
      `).catch(() => null) as { x: number; y: number } | null;
      if (btnPos) break;
      await delay(250);
    }
    if (btnPos) {
      await cdpTapGesture(wc.debugger, btnPos.x, btnPos.y);
    } else {
      // Fallback: Enter via CDP (still isTrusted = true)
      console.warn(`[doAutoLogin:${profileId}] submit button not found — sending Enter via CDP`);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await delay(60);
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    }
  }

  // Wait up to 30s for navigation away from the bare login page.
  // The 2FA page URL is "accounts/login/two_factor?..." — it still contains
  // "accounts/login", so the predicate must explicitly accept it, otherwise
  // the code waits the full 30 s before detecting 2FA (looks like it does nothing).
  const postLoginUrl = await waitForNav(
    wc,
    url =>
      url.includes("instagram.com") &&
      (!url.includes("accounts/login/") || url.includes("two_factor") || /#/.test(url)),
    30000,
  );
  await delay(1000);

  // ── Handle 2FA if required ─────────────────────────────────────────────────
  // Instagram uses several different input attributes across app versions —
  // check all known selectors so TOTP detection is robust.
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
  ].join(", ");

  const needs2FA: boolean = await wc.executeJavaScript(
    `!!(document.querySelector(${JSON.stringify(_2FA_SELECTORS)}))`
  ).catch(() => false);

  if (needs2FA) {
    if (!twoFAKey) {
      return { ok: false, message: "2FA required but no 2FA key configured for this account" };
    }
    const code = generateTotp(twoFAKey);
    console.log(`[doAutoLogin:${profileId}] @${username} — 2FA page detected, filling TOTP code via CDP`);

    // Find the TOTP input centre-point via JS, then fill + submit via CDP
    const tfPos = await wc.executeJavaScript(`
      (() => {
        const SELS = ${JSON.stringify(_2FA_SELECTORS)};
        const inp = document.querySelector(SELS);
        if (!inp) return null;
        const r = inp.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0) return null;
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `).catch(() => null) as { x: number; y: number } | null;

    if (tfPos) {
      try {
        await cdpTapGesture(wc.debugger, tfPos.x, tfPos.y);
        await delay(150);
        await typeTextCDP(wc.debugger, code, { minDelay: 40, maxDelay: 100 });
      } catch {}
    }

    // Poll for 2FA submit button, tap via touch gesture
    {
      let tf2BtnPos: { x: number; y: number } | null = null;
      for (let i = 0; i < 16; i++) {
        tf2BtnPos = await wc.executeJavaScript(`
          (() => {
            const b = document.querySelector('button[type="submit"]');
            if (!b || b.disabled) return null;
            const r = b.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return null;
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()
        `).catch(() => null) as { x: number; y: number } | null;
        if (tf2BtnPos) break;
        await delay(250);
      }
      if (tf2BtnPos) {
        await cdpTapGesture(wc.debugger, tf2BtnPos.x, tf2BtnPos.y);
      } else {
        // Fallback: Enter via CDP
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
        await delay(60);
        await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      }
    }
    await waitForNav(
      wc,
      url => url.includes("instagram.com") && !url.includes("two_factor"),
      20000,
    );
    await delay(1000);
  }

  const finalUrl = wc.getURL();

  // Check for challenge redirect
  if (finalUrl.includes("update_risky_contactpoint") || finalUrl.includes("/challenge/")) {
    return { ok: false, message: `Instagram challenge detected: ${finalUrl}` };
  }
  if (finalUrl.includes("accounts/suspended")) {
    return { ok: false, message: `Instagram is asking this account to confirm it is human (URL: ${finalUrl.slice(0, 80)})` };
  }
  // accounts/disabled after an automated login is most often a bot-detection
  // security check, NOT a permanent ban — the account works fine when the user
  // logs in manually.  Return a "captcha" style message (no "disabled" keyword)
  // so the route classifies it as "captcha" and prompts the user to open the EB,
  // rather than permanently marking the account as account_disabled.
  if (finalUrl.includes("accounts/disabled")) {
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
  const isGhostBrowser = profileId === -1;

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
      if (!isGhostBrowser && !existing.win.isMaximized()) existing.win.maximize();
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
    await ses.setProxy(buildProxyConfig(proxy));
    await new Promise(r => setTimeout(r, 150));
    await ses.setProxy(buildProxyConfig(proxy));
  }

  // Seed existing cookies into the Electron session
  await loadCookiesFromFile(profileId, ses);

  // Ghost browser (profileId -1) opens at phone portrait dimensions, not maximized.
  // Regular account EB windows open full-screen maximized.
  const win = new BrowserWindow({
    width:           isGhostBrowser ? 430 : 1280,
    height:          isGhostBrowser ? 932 : 820,
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
  win.once("ready-to-show", () => {
    win.show();
    if (isGhostBrowser) {
      // Position ghost browser at the absolute right edge of the primary display
      const { width: sw, height: sh } = eScreen.getPrimaryDisplay().workAreaSize;
      const { width: ww, height: wh } = win.getBounds();
      const gx = Math.max(0, sw - ww - 8);
      const gy = Math.max(0, Math.floor((sh - wh) / 2));
      win.setPosition(gx, gy);
    } else {
      win.maximize();
    }
  });

  // Register in ebMap IMMEDIATELY — before any async CDP/proxy/cookie work.
  // ready-to-show (above) fires and makes the window visible while the async
  // setup below is still running.  If ebMap.set were placed after that async
  // work (as it historically was, ~280 lines later), /eb/state?profileId=X
  // would return { open:false } for several seconds while the window is
  // visibly on screen — causing the frontend status poll to incorrectly
  // conclude the browser isn't open.  Registering here ensures the VERY NEXT
  // poll (within 5 s) sees { open:true } and the UI reflects reality.
  ebMap.set(profileId, { win, username, proxy, partition });

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
  const _fpChromeMajor = _browserUA?.match(/Chrome\/(\d+)/)?.[1] ?? "131";
  const _fpBuildInfo   = getChromeBuildInfo(_fpChromeMajor);
  const _fpScript = buildFingerprintScript(_fpIsMobile, _resolvedApiUA ?? null, ebFingerprint ?? null, _fpBuildInfo.full, _fpBuildInfo.grease, _fpBuildInfo.greaseVer);
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
          // Use the real full build version and correct GREASE brand from the lookup table.
          // _fpBuildInfo is already resolved above from the UA's Chrome major version.
          await win.webContents.debugger.sendCommand("Emulation.setUserAgentOverride", {
            userAgent: _browserUA,
            acceptLanguage: "en-US,en;q=0.9",
            platform: _fpIsMobile ? "Linux armv8l" : "Win32",
            ...(_fpIsMobile ? {
              userAgentMetadata: {
                brands: [
                  { brand: _fpBuildInfo.grease,  version: _fpBuildInfo.greaseVer },
                  { brand: "Chromium",            version: _fpChromeMajor },
                  { brand: "Google Chrome",       version: _fpChromeMajor },
                ],
                fullVersionList: [
                  { brand: _fpBuildInfo.grease,  version: _fpBuildInfo.greaseVer + ".0.0.0" },
                  { brand: "Chromium",            version: _fpBuildInfo.full },
                  { brand: "Google Chrome",       version: _fpBuildInfo.full },
                ],
                platform:        "Android",
                platformVersion: _androidVer,
                architecture:    "arm",
                model:           _deviceModel,
                mobile:          true,
                bitness:         "64",
                wow64:           false,
              },
            } : {}),
          });
          console.log(`[ebManager:${profileId}] Emulation.setUserAgentOverride: UA="${_browserUA.slice(0, 80)}" mobile=${_fpIsMobile} grease="${_fpBuildInfo.grease}" full="${_fpBuildInfo.full}"`);
        } catch (uaErr) {
          console.warn(`[ebManager:${profileId}] Emulation.setUserAgentOverride failed:`, uaErr);
        }
      }

      // ── Mobile device metrics override ────────────────────────────────────────
      // CRITICAL for anti-detect: without this, Chromium's C++ layout engine uses
      // the real BrowserWindow size (1280×820) even though the JS fingerprint
      // overrides screen.width/innerWidth.  JS overrides only affect JS reads —
      // they cannot change how Chromium evaluates CSS @media queries, computes
      // layout, or classifies input events (PointerEvent.pointerType stays "mouse").
      //
      // setDeviceMetricsOverride with mobile:true makes Chromium:
      //   • evaluate @media (pointer:coarse) and (max-width:Xpx) against mobile dims
      //   • render the Instagram mobile SPA layout (not desktop)
      //   • report PointerEvent.pointerType="touch" for native touch input
      //   • apply the correct devicePixelRatio at the compositor level
      //
      // setTouchEmulationEnabled enables Chromium's native touch input stack so that
      // Input.synthesizeTapGesture produces real touchstart/touchend events (not
      // mouse events with a wrong pointer type).
      if (_fpIsMobile) {
        const _mobileProfile = getMobileDeviceProfile(_browserUA, _resolvedApiUA ?? null);
        if (_mobileProfile) {
          try {
            await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
              width:             _mobileProfile.width,
              height:            _mobileProfile.height,
              deviceScaleFactor: _mobileProfile.dpr,
              mobile:            true,
              screenOrientation: { type: "portraitPrimary", angle: 0 },
            });
            console.log(`[ebManager:${profileId}] setDeviceMetricsOverride: ${_mobileProfile.width}x${_mobileProfile.height} dpr=${_mobileProfile.dpr}`);
          } catch (dmErr) {
            console.warn(`[ebManager:${profileId}] setDeviceMetricsOverride failed:`, dmErr);
          }
          try {
            await win.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
              enabled:        true,
              maxTouchPoints: 10,
            });
            console.log(`[ebManager:${profileId}] setTouchEmulationEnabled: touch input stack active`);
          } catch (teErr) {
            console.warn(`[ebManager:${profileId}] setTouchEmulationEnabled failed:`, teErr);
          }
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
    // Ghost browser: keep mobile viewport active on every navigation so
    // Instagram always serves the mobile UI, even during manual browsing.
    if (isGhostBrowser) {
      try {
        win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
          width: 393, height: 851, deviceScaleFactor: 2.75, mobile: true,
          screenOrientation: { type: "portraitPrimary", angle: 0 },
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
            if (document.getElementById('__eq-scraping-warn')) return;
            var d = document.createElement('div');
            d.id = '__eq-scraping-warn';
            d.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;z-index:999999;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px;text-align:center;box-sizing:border-box;';
            d.innerHTML = '<div style="font-size:40px;margin-bottom:12px">⚠️</div>'
              + '<div style="font-size:18px;font-weight:700;color:#111;margin-bottom:8px">Automated Behaviour Detected</div>'
              + '<div style="font-size:13px;color:#555;max-width:380px;line-height:1.5">Instagram has flagged this account. You may need to log in manually, solve any challenge shown, and then re-verify the account in Equinox once the session is restored.</div>'
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
    // Do NOT pass autoFill here — JS-injected form events have isTrusted = false,
    // which Instagram detects as bot input. The did-navigate handler below fills
    // the form via CDP Input events (isTrusted = true) instead.
    win.webContents.executeJavaScript(buildPageUtilsJs()).catch(() => {});
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
    win.setTitle(`@${username} — Equinox Browser`);
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
  win.webContents.on("did-finish-load", async () => {
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
    if (!url.includes("instagram.com")) return;
    let snap: { childCount?: number; bodyLen?: number } = {};
    try { snap = JSON.parse(snapshot); } catch {}
    if ((snap.bodyLen ?? 9999) > 200) return; // page rendered content — nothing to do

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

    console.warn(`[ebDiag:${profileId}] BLANK BODY on "${url}" (bodyLen=${snap.bodyLen ?? "?"},children=${snap.childCount ?? "?"}) — recovering to ${diagCks.length > 0 ? "feed" : "login"}`);
    win.webContents.loadURL(
      diagCks.length > 0 ? "https://www.instagram.com/" : "https://www.instagram.com/accounts/login/"
    ).catch(() => {});
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
              await typeTextCDP(_d, password);
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

    // Helper: type text into the renderer's currently-focused input via CDP
    // (isTrusted = true — JS-injected events are isTrusted = false).
    // CDP Input.insertText routes to whatever element currently has focus,
    // so we first restore focus to __eq_lastInput via CDP mouse click, then insert.
    const typeIntoFocused = async (text: string) => {
      try { wc.debugger.attach("1.3"); } catch {}
      // Re-focus the last input the user was in (clicking the toolbar button
      // shifted browser focus to the toolbar BrowserView).
      const focusPos = await wc.executeJavaScript(`(function(){
        var el=window.__eq_lastInput||null;
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

          // Shared CDP fill helper — used for both the inline and post-navigate cases
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

            // Find field positions via JS
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
                if (!uInp && !pInp) return 'navigate';
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

            // Fill username via CDP touch tap
            await cdpTapGesture(_d, _flds.u.x, _flds.u.y);
            await _ms(150);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _ms(100);
            await typeTextCDP(_d, _lgUsr);

            // Tab key advances focus to the password field (most reliable on
            // Instagram's mobile login page — coordinate tapping alone can land
            // on the wrong element if Instagram rerenders between the username
            // type and the tap).
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(50);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(300);

            // Belt-and-suspenders: also tap the password field by coordinate
            await cdpTapGesture(_d, _flds.p.x, _flds.p.y);
            await _ms(150);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp",   key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
            await _ms(100);
            await typeTextCDP(_d, _lgPwd);

            // Tab out of the password field — triggers React's onBlur/onChange
            // validation cycle which enables the "Log in" button. Without this,
            // Instagram's React form keeps the button disabled because it hasn't
            // seen a blur event, and the poll loop below always gets null.
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(50);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
            await _ms(500 + Math.floor(Math.random() * 400));

            // Poll for submit button, tap via touch gesture
            for (let _bi = 0; _bi < 20; _bi++) {
              const _bp = await targetWc.executeJavaScript(`
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
                return 'ok';
              }
              await _ms(250);
            }
            // Fallback: Enter via CDP
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            await _ms(60);
            await _d.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
            return 'ok';
          };

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
        // Fill the TOTP code into the OTP input via CDP (isTrusted = true).
        // The old approach used JS setter.call + dispatchEvent — all isTrusted=false,
        // identical to the bot signal the login form fix addressed.
        try {
          const r = await fetch(`http://127.0.0.1:${_serverPort}/api/profiles/${foundPid}`);
          const p = await r.json() as any;
          const key = (p.twoFASecretKey ?? "").trim();
          if (key) {
            const code = generateTotp(key);
            try { wc.debugger.attach("1.3"); } catch {}
            const _ms = (ms: number) => new Promise<void>(res => setTimeout(res, ms));
            const _d = wc.debugger;

            // Step 1: find the OTP input centre via JS (read-only — no events fired here)
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
            // Retry loop: Instagram's 2FA page may take a moment to render the input.
            let totpPos: { x: number; y: number } | null = null;
            for (let _ti = 0; _ti < 10 && !totpPos; _ti++) {
              totpPos = await wc.executeJavaScript(`(function(){
                var SELS=${JSON.stringify(_OTP_SELS)};
                var el=document.querySelector(SELS)||null;
                if(!el){
                  // Broad fallback: any visible input that isn't username/password/email.
                  // If exactly one such input exists on the page, that must be the code field.
                  var all=Array.from(document.querySelectorAll('input'));
                  var visible=all.filter(function(i){
                    if(i.type==='password'||i.type==='email'||i.name==='username'||i.name==='password')return false;
                    var r=i.getBoundingClientRect();
                    return r.width>0&&r.height>0;
                  });
                  if(visible.length===1){el=visible[0];}
                  else{el=visible.find(function(i){return i.type==='tel'||i.inputMode==='numeric'||/code|verif|otp|totp/i.test(i.name+' '+i.id+' '+i.placeholder);});}
                  if(!el&&window.__eq_lastInput&&window.__eq_lastInput.tagName==='INPUT')el=window.__eq_lastInput;
                }
                if(!el||el.tagName!=='INPUT')return null;
                var r=el.getBoundingClientRect();
                if(r.width<=0||r.height<=0)return null;
                return{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};
              })()`).catch(() => null) as { x: number; y: number } | null;
              if (!totpPos) await _ms(500);
            }

            if (totpPos) {
              // Step 2: touch tap to focus the field
              await cdpTapGesture(_d, totpPos.x, totpPos.y);
              await _ms(120);

              // Step 3: type each digit via typeTextCDP (isTrusted=true, human timing)
              // Wider 50–230ms range with occasional longer pauses — humans glance
              // back at the authenticator app between digits, so timing is uneven.
              await typeTextCDP(_d, code, { minDelay: 200, maxDelay: 600 });

              // Natural pause: a real person reads the code, checks it looks right,
              // then moves to click Submit. 700–1500ms is the realistic human range.
              await _ms(700 + Math.floor(Math.random() * 800));

              // Step 4: find + click the submit/confirm/continue button via CDP
              for (let _bi = 0; _bi < 16; _bi++) {
                const _bp = await wc.executeJavaScript(`(function(){
                  var SUBMIT=['confirm','continue','submit','verify','next','done','ok'];
                  var btns=Array.from(document.querySelectorAll('button[type="submit"],button,[role="button"]'));
                  for(var i=0;i<btns.length;i++){
                    var t=(btns[i].innerText||btns[i].textContent||'').trim().toLowerCase();
                    var rc=btns[i].getBoundingClientRect();
                    if(rc.width>0&&rc.height>0&&SUBMIT.some(function(s){return t.indexOf(s)!==-1;})){
                      return{x:Math.round(rc.left+rc.width/2),y:Math.round(rc.top+rc.height/2)};
                    }
                  }
                  return null;
                })()`).catch(() => null) as { x: number; y: number } | null;
                if (_bp) {
                  await cdpTapGesture(_d, _bp.x, _bp.y);
                  break;
                }
                await _ms(200);
              }
            }
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
          userAgent: body.userAgent,
          apiUA:     body.apiUA,
          ebFingerprint: parsedFp,
          initialUrl: body.initialUrl ?? undefined,
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
        const result = await doAutoLogin(pid, e.win, body.username, body.password, body.twoFAKey ?? "", body.userAgent);
        return send(res, 200, result);
      }

      // ── POST /eb/silent-verify ─────────────────────────────────────────────────
      // Full EB login in a hidden (never-shown) BrowserWindow.
      // Used by the Verify button so no EB window pops up during verification.
      // Opens hidden window → loads existing cookies → auto-login → extract cookies
      // → destroy window → return { ok, message, cookies }.
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
        console.log(`[silent-verify:${pid}] @${body.username} — loading cookies from file`);
        await loadCookiesFromFile(pid, ses);
        console.log(`[silent-verify:${pid}] @${body.username} — cookies loaded`);

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

        console.log(`[silent-verify:${pid}] @${body.username} — hidden window created, calling doAutoLogin`);
        try {
          const loginResult = await doAutoLogin(pid, hiddenWin, body.username, body.password, body.twoFAKey ?? "", body.userAgent);
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

      // ── POST /eb/ghost-signup ───────────────────────────────────────────────
      // Fully automated Instagram account creation flow using CDP touch events.
      // The browser must already be open (Ghost Browser, profileId -1).
      // Flow: navigate → accept cookies → "Create new account" → "Sign up with
      // email" → fill email → wait for code → DOB → name → username → terms.
      // Progress is relayed to the API server via /api/signup/browser/ghost-signup-step.
      if (req.method === "POST" && u.pathname === "/eb/ghost-signup") {
        const e = ebMap.get(-1);
        if (!e || e.win.isDestroyed()) {
          return send(res, 200, { ok: false, error: "Ghost Browser is not open" });
        }

        const {
          email, username, password, dob,
          websitesToVisit = [],
          websitesMin = 1, websitesMax = 3,
          internalLinksMin = 2, internalLinksMax = 5,
          timeOnSiteMin = 1, timeOnSiteMax = 3,
          timeOnLinksMin = 1, timeOnLinksMax = 2,
        } = body as {
          email: string; username: string; password: string; dob: string;
          websitesToVisit?: string[];
          websitesMin?: number; websitesMax?: number;
          internalLinksMin?: number; internalLinksMax?: number;
          timeOnSiteMin?: number; timeOnSiteMax?: number;
          timeOnLinksMin?: number; timeOnLinksMax?: number;
        };
        if (!email || !username || !password || !dob) {
          return send(res, 200, { ok: false, error: "email, username, password, and dob are required" });
        }

        send(res, 200, { ok: true });

        (async () => {
          const wc = e.win.webContents;
          const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

          const relay = (msg: string) => {
            console.log(`[ghost-signup] ${msg}`);
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ msg }),
              }).catch(() => {});
            }
          };

          const relayDone = () => {
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ msg: "✅ Signup flow complete! Click 'Add to Equinox' to save the account.", done: true }),
              }).catch(() => {});
            }
          };

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
          const _gpCN   = 2 + Math.floor(Math.random() * 252);
          const _gpAN   = (Math.random() * 0.0000008 + 0.0000001).toFixed(16);
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
    var _S=Math.round(_AN*1e7)|1;
    AnalyserNode.prototype.getFloatFrequencyData=function(a){var _oGFF=AnalyserNode.prototype.getFloatFrequencyData;_oGFF.call(this,a);if(a&&a.length>0){var s=_S;for(var i=0;i<a.length;i++){s=Math.imul(1664525,s)+1013904223>>>0;a[i]+=(s/0x100000000)*0.0001-0.00005;}}};
    AnalyserNode.prototype.getByteFrequencyData=function(a){var _oGBF=AnalyserNode.prototype.getByteFrequencyData;_oGBF.call(this,a);if(a&&a.length>0){var s=_S;for(var i=0;i<a.length;i++){s=Math.imul(1664525,s)+1013904223>>>0;var v=a[i]+(s/0x100000000>0.5?1:0);a[i]=Math.max(0,Math.min(255,v));}}};
  }catch(e){}
})();`;

          try {
            await wc.debugger.sendCommand("Page.enable");
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
            // Type character-by-character via typeTextCDP — fires rawKeyDown +
            // Input.insertText (1 char) + keyUp per character with 80–280 ms human
            // inter-key delays. Instagram's keystroke-timing analyser sees natural
            // gaps; a full-string Input.insertText would look like an instant paste.
            // androidIme:true sends key="Unidentified" / vk=229 (VK_PROCESSKEY)
            // which is how Android virtual keyboards actually fire events.
            try {
              await typeTextCDP(wc.debugger, text, { androidIme: true });
            } catch {}
            await sleep(150);
            // Verify the text actually landed in the field (helps diagnose future issues)
            try {
              const fieldVal = await js(`(function(){
                var el = document.activeElement;
                if (!el || (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA')) {
                  el = document.elementFromPoint(${x}, ${y});
                }
                return el ? el.value : null;
              })()`);
              relay(`[clearAndType] Field value after type: "${fieldVal}" (expected ${text.length} chars)`);
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

                // Spend time on this site
                const siteWaitMs = _rndInt(timeOnSiteMin, timeOnSiteMax) * 60 * 1000;
                relay(`⏱ Warm-up: spending ${Math.round(siteWaitMs/60000)} min on ${siteUrl}…`);
                await sleep(siteWaitMs);

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
                relay(`⚠ Warm-up: error on ${siteUrl}: ${wErr?.message ?? String(wErr)}`);
              }
            }
            relay(`✅ Warm-up complete — starting Instagram signup now…`);
          }

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
                userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
                acceptLanguage: "en-US,en;q=0.9",
                platform: "Linux armv8l",
                userAgentMetadata: {
                  brands: [
                    { brand: "Not_A Brand",   version: "8" },
                    { brand: "Chromium",       version: "131" },
                    { brand: "Google Chrome",  version: "131" },
                  ],
                  fullVersionList: [
                    { brand: "Not_A Brand",   version: "8.0.0.0" },
                    { brand: "Chromium",       version: "131.0.6778.204" },
                    { brand: "Google Chrome",  version: "131.0.6778.204" },
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
              relay("[mobile-setup] ✅ Mobile UA=Pixel 8 Chrome/131 viewport=393x851 dpr=2.75 touch=on hover=none pointer=coarse");
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
                  const cr = await fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-code-peek`);
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
                    // Set value via JS native setter so React's controlled state updates
                    // without any keyboard or touch simulation (most reliable approach).
                    relay(`[debug] DOB: no picker after tap — setting "${dateStr}" via JS native setter…`);
                    const jsSetResult = await js(`(function(){
                      var el=document.activeElement;
                      if(!el||(el.tagName!=='INPUT'&&el.tagName!=='TEXTAREA')){
                        var inputs=Array.from(document.querySelectorAll('input'));
                        el=inputs.find(function(i){var lbl=(i.getAttribute('aria-label')||i.placeholder||'').toLowerCase();return lbl.includes('birthday')||lbl.includes('mm/dd')||lbl.includes('date');});
                      }
                      if(!el)return null;
                      var setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value');
                      if(setter&&setter.set){
                        setter.set.call(el,'${dateStr}');
                        el.dispatchEvent(new Event('input',{bubbles:true,composed:true}));
                        el.dispatchEvent(new Event('change',{bubbles:true,composed:true}));
                        return el.value;
                      }
                      return null;
                    })()`);
                    relay(`[debug] DOB native setter result: "${jsSetResult}"`);
                    await sleep(500);
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

            relayDone();
          } catch (err: any) {
            relay(`⚠ Signup error: ${err?.message ?? String(err)}`);
            if (_serverPort) {
              fetch(`http://127.0.0.1:${_serverPort}/api/signup/browser/ghost-signup-step`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ msg: `⚠ Signup error: ${err?.message ?? String(err)}`, done: true }),
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
