export const LEAKS_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Equinox — Leak Test</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg: #ffffff;
    --surface: #f8fafc;
    --border: #e2e8f0;
    --text: #111827;
    --muted: #6b7280;
    --pass: #16a34a;
    --pass-bg: rgba(22,163,74,0.10);
    --fail: #dc2626;
    --fail-bg: rgba(220,38,38,0.10);
    --warn: #d97706;
    --warn-bg: rgba(217,119,6,0.10);
    --info: #2563eb;
    --info-bg: rgba(37,99,235,0.10);
    --neutral: #9ca3af;
    --neutral-bg: rgba(156,163,175,0.10);
  }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    line-height: 1.5;
    min-height: 100vh;
    padding: 0 0 40px 0;
  }

  /* ── Header ─────────────────────────────────────────── */
  .header {
    background: var(--surface);
    border-bottom: 1px solid var(--border);
    padding: 18px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    z-index: 10;
  }
  .header-title {
    font-size: 16px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--text);
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .header-title .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--muted);
    animation: pulse 2s infinite;
  }
  .header-title .dot.running { background: var(--warn); }
  .header-title .dot.done-ok { background: var(--pass); animation: none; }
  .header-title .dot.done-warn { background: var(--fail); animation: none; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

  .header-score {
    font-size: 12px;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .score-pill {
    font-weight: 700;
    font-size: 12px;
    padding: 2px 10px;
    border-radius: 20px;
    border: 1px solid;
  }
  .score-pill.good  { color: var(--pass); border-color: var(--pass); background: var(--pass-bg); }
  .score-pill.bad   { color: var(--fail); border-color: var(--fail); background: var(--fail-bg); }
  .score-pill.pending { color: var(--muted); border-color: var(--border); }

  /* ── Summary bar ────────────────────────────────────── */
  .summary-bar {
    margin: 20px 24px 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 14px 18px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }
  .summary-item {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    font-weight: 600;
    padding: 3px 10px;
    border-radius: 20px;
    border: 1px solid var(--border);
  }
  .summary-item.pass { color: var(--pass); background: var(--pass-bg); border-color: rgba(34,197,94,.25); }
  .summary-item.fail { color: var(--fail); background: var(--fail-bg); border-color: rgba(239,68,68,.25); }
  .summary-item.warn { color: var(--warn); background: var(--warn-bg); border-color: rgba(245,158,11,.25); }
  .summary-item.info { color: var(--info); background: var(--info-bg); border-color: rgba(59,130,246,.25); }

  /* ── Grid ───────────────────────────────────────────── */
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    gap: 16px;
    padding: 16px 24px 0;
  }

  /* ── Card ───────────────────────────────────────────── */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    transition: border-color .15s;
  }
  .card.pass { border-color: rgba(34,197,94,.30); }
  .card.fail { border-color: rgba(239,68,68,.40); }
  .card.warn { border-color: rgba(245,158,11,.30); }

  .card-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 14px 10px;
    border-bottom: 1px solid var(--border);
  }
  .card-title {
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 700;
    font-size: 12px;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .card-title .icon { font-size: 15px; }

  .badge {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: .08em;
    padding: 2px 8px;
    border-radius: 20px;
    border: 1px solid;
    text-transform: uppercase;
  }
  .badge.pass  { color: var(--pass); background: var(--pass-bg); border-color: rgba(34,197,94,.3); }
  .badge.fail  { color: var(--fail); background: var(--fail-bg); border-color: rgba(239,68,68,.3); }
  .badge.warn  { color: var(--warn); background: var(--warn-bg); border-color: rgba(245,158,11,.3); }
  .badge.info  { color: var(--info); background: var(--info-bg); border-color: rgba(59,130,246,.3); }
  .badge.pending { color: var(--muted); border-color: var(--border); }

  .card-body { padding: 12px 14px; }

  /* ── Rows ───────────────────────────────────────────── */
  .row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 10px;
    padding: 5px 0;
    border-bottom: 1px solid rgba(0,0,0,.06);
    font-size: 12px;
  }
  .row:last-child { border-bottom: none; }
  .row-label { color: var(--muted); flex-shrink: 0; }
  .row-value {
    font-family: 'Menlo', 'Consolas', monospace;
    color: var(--text);
    text-align: right;
    word-break: break-all;
    max-width: 240px;
  }
  .row-value.red   { color: var(--fail); font-weight: 700; }
  .row-value.green { color: var(--pass); font-weight: 700; }
  .row-value.warn  { color: var(--warn); font-weight: 700; }
  .row-value.muted { color: var(--muted); }

  /* ── IP Hero ────────────────────────────────────────── */
  .ip-hero {
    text-align: center;
    padding: 16px 0 10px;
  }
  .ip-hero .ip-label { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; margin-bottom: 6px; }
  .ip-hero .ip-addr {
    font-size: 26px;
    font-weight: 800;
    font-family: 'Menlo', 'Consolas', monospace;
    color: var(--text);
    letter-spacing: .02em;
  }
  .ip-hero .ip-addr.loading { color: var(--muted); font-size: 18px; }

  /* ── WebRTC IP list ─────────────────────────────────── */
  .ip-list { margin: 8px 0 0; }
  .ip-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    background: rgba(0,0,0,.03);
    border-radius: 6px;
    margin-bottom: 4px;
    font-size: 12px;
    font-family: 'Menlo', 'Consolas', monospace;
  }
  .ip-item .ip-type {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .ip-item.public  { background: var(--fail-bg); border: 1px solid rgba(239,68,68,.25); }
  .ip-item.private { background: rgba(255,255,255,.03); }
  .ip-item.mdns    { background: rgba(255,255,255,.02); }

  /* ── Canvas preview ─────────────────────────────────── */
  #canvas-preview { display: none; }

  /* ── Description ────────────────────────────────────── */
  .desc {
    font-size: 11px;
    color: var(--muted);
    margin-top: 8px;
    line-height: 1.5;
    padding: 7px 9px;
    background: rgba(0,0,0,.03);
    border-radius: 6px;
  }
  .desc.warn { color: var(--warn); background: var(--warn-bg); border: 1px solid rgba(217,119,6,.2); }
  .desc.fail { color: var(--fail); background: var(--fail-bg); border: 1px solid rgba(220,38,38,.2); }
  .desc.pass { color: var(--pass); background: var(--pass-bg); border: 1px solid rgba(22,163,74,.2); }

  /* ── Rerun button ───────────────────────────────────── */
  .rerun-btn {
    display: block;
    margin: 20px auto 0;
    padding: 8px 24px;
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
    letter-spacing: .04em;
    cursor: pointer;
    transition: border-color .15s, color .15s;
  }
  .rerun-btn:hover { border-color: var(--info); color: var(--info); }

  /* ── Wide card ──────────────────────────────────────── */
  .card.wide { grid-column: 1 / -1; }

  /* ── Loading spinner ─────────────────────────────────── */
  .spinner {
    width: 14px; height: 14px;
    border: 2px solid var(--border);
    border-top-color: var(--info);
    border-radius: 50%;
    animation: spin .7s linear infinite;
    display: inline-block;
    vertical-align: middle;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
</head>
<body>

<div class="header">
  <div class="header-title">
    <span class="dot" id="hdr-dot"></span>
    __LEAK_TEST_TITLE__
  </div>
  <div class="header-score">
    <span>Overall</span>
    <span class="score-pill pending" id="score-pill">Running…</span>
  </div>
</div>

<div class="summary-bar" id="summary-bar"></div>

<div class="grid">

  <!-- IP Detection -->
  <div class="card" id="card-ip">
    <div class="card-header">
      <div class="card-title"><span class="icon">🌐</span> Public IP</div>
      <span class="badge pending" id="badge-ip"><span class="spinner"></span></span>
    </div>
    <div class="card-body">
      <div class="ip-hero">
        <div class="ip-label">Detected IP Address</div>
        <div class="ip-addr loading" id="ip-display">Fetching…</div>
      </div>
      <div id="ip-rows"></div>
    </div>
  </div>

  <!-- WebRTC Leak -->
  <div class="card" id="card-webrtc">
    <div class="card-header">
      <div class="card-title"><span class="icon">📡</span> WebRTC Leak</div>
      <span class="badge pending" id="badge-webrtc"><span class="spinner"></span></span>
    </div>
    <div class="card-body">
      <div id="webrtc-body">
        <div class="row">
          <span class="row-label">ICE Gathering</span>
          <span class="row-value muted">Running…</span>
        </div>
      </div>
    </div>
  </div>

  <!-- Bot / WebDriver detection -->
  <div class="card" id="card-bot">
    <div class="card-header">
      <div class="card-title"><span class="icon">🤖</span> Bot Detection</div>
      <span class="badge pending" id="badge-bot"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="bot-body"></div>
  </div>

  <!-- Timezone -->
  <div class="card" id="card-tz">
    <div class="card-header">
      <div class="card-title"><span class="icon">🕐</span> Timezone</div>
      <span class="badge info" id="badge-tz">INFO</span>
    </div>
    <div class="card-body" id="tz-body"></div>
  </div>

  <!-- User Agent & Navigator -->
  <div class="card wide" id="card-nav">
    <div class="card-header">
      <div class="card-title"><span class="icon">🧭</span> Navigator</div>
      <span class="badge info" id="badge-nav">INFO</span>
    </div>
    <div class="card-body" id="nav-body"></div>
  </div>

  <!-- Screen & Hardware -->
  <div class="card" id="card-hw">
    <div class="card-header">
      <div class="card-title"><span class="icon">🖥️</span> Screen &amp; Hardware</div>
      <span class="badge info" id="badge-hw">INFO</span>
    </div>
    <div class="card-body" id="hw-body"></div>
  </div>

  <!-- Canvas Fingerprint -->
  <div class="card" id="card-canvas">
    <div class="card-header">
      <div class="card-title"><span class="icon">🎨</span> Canvas Fingerprint</div>
      <span class="badge info" id="badge-canvas">INFO</span>
    </div>
    <div class="card-body" id="canvas-body"></div>
  </div>

  <!-- Audio Fingerprint -->
  <div class="card" id="card-audio">
    <div class="card-header">
      <div class="card-title"><span class="icon">🎵</span> Audio Fingerprint</div>
      <span class="badge info" id="badge-audio">INFO</span>
    </div>
    <div class="card-body" id="audio-body"></div>
  </div>

  <!-- WebGL -->
  <div class="card" id="card-webgl">
    <div class="card-header">
      <div class="card-title"><span class="icon">⚡</span> WebGL / GPU</div>
      <span class="badge info" id="badge-webgl">INFO</span>
    </div>
    <div class="card-body" id="webgl-body"></div>
  </div>

</div>

<button class="rerun-btn" onclick="runAll()">↺ Re-run All Tests</button>

<canvas id="canvas-preview" width="220" height="50"></canvas>

<script>
// ── Helpers ───────────────────────────────────────────────────────────────────
function row(label, value, cls) {
  return '<div class="row"><span class="row-label">'+label+'</span><span class="row-value'+(cls?' '+cls:'')+'">'+value+'</span></div>';
}
function desc(text, cls) {
  return '<div class="desc'+(cls?' '+cls:'')+'">'+text+'</div>';
}
function setBadge(id, status, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.className = 'badge '+status;
  el.textContent = label || status.toUpperCase();
}
function setCardBorder(id, cls) {
  const el = document.getElementById(id);
  if (el) el.className = 'card '+(id==='card-nav'?'wide ':'')+cls;
}

// Simple DJB2 hash → hex
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Collect results for summary
const RESULTS = {};
function setResult(key, status, label) {
  RESULTS[key] = { status, label };
  updateSummary();
  updateScore();
}

function updateSummary() {
  const bar = document.getElementById('summary-bar');
  if (!bar) return;
  const order = ['IP', 'WebRTC', 'WebDriver', 'Timezone', 'Navigator', 'Hardware', 'Canvas', 'Audio', 'WebGL'];
  bar.innerHTML = order.filter(k => RESULTS[k]).map(k => {
    const r = RESULTS[k];
    return '<div class="summary-item '+r.status+'"><span>'+k+'</span></div>';
  }).join('');
}

function updateScore() {
  const dot  = document.getElementById('hdr-dot');
  const pill = document.getElementById('score-pill');
  const vals = Object.values(RESULTS);
  const total = 9;
  if (vals.length < total) {
    if (dot)  dot.className = 'dot running';
    if (pill) { pill.className = 'score-pill pending'; pill.textContent = 'Running…'; }
    return;
  }
  const fails = vals.filter(r => r.status === 'fail' || r.status === 'warn').length;
  if (dot) dot.className = fails > 0 ? 'dot done-warn' : 'dot done-ok';
  if (pill) {
    if (fails === 0) {
      pill.className = 'score-pill good';
      pill.textContent = 'All Clear';
    } else {
      pill.className = 'score-pill bad';
      pill.textContent = fails + ' Issue' + (fails > 1 ? 's' : '');
    }
  }
}

// ── Test 1: Public IP ─────────────────────────────────────────────────────────
async function testIP() {
  const display = document.getElementById('ip-display');
  const rows    = document.getElementById('ip-rows');
  function makeFetch(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal }).finally(() => clearTimeout(t));
  }
  try {
    const r = await makeFetch('https://api64.ipify.org?format=json', 8000);
    const d = await r.json();
    const ip = d.ip || '—';
    if (display) { display.className = 'ip-addr'; display.textContent = ip; }
    // geo lookup
    let geoHtml = '';
    try {
      const g = await makeFetch('https://ipapi.co/'+ip+'/json/', 8000);
      const gd = await g.json();
      geoHtml = row('Country', (gd.country_name||'?')+' '+((gd.country_code||'').toLowerCase()?'🏳️':''))
              + row('City', gd.city||'?')
              + row('ISP / Org', gd.org||'?')
              + row('Timezone', gd.timezone||'?');
    } catch {}
    if (rows) rows.innerHTML = geoHtml;
    setBadge('badge-ip', 'info', 'INFO');
    setCardBorder('card-ip', '');
    setResult('IP', 'info', ip);
    window._detectedPublicIP = ip;
  } catch (e) {
    if (display) { display.className = 'ip-addr'; display.textContent = 'Timed out'; }
    if (rows) rows.innerHTML = desc('Could not reach ipify.org — the proxy may be blocking external requests or the connection timed out after 8 s.', 'warn');
    setBadge('badge-ip', 'warn', 'WARN');
    setResult('IP', 'warn', 'Offline?');
  }
}

// ── Test 2: WebRTC Leak ───────────────────────────────────────────────────────
function testWebRTC() {
  return new Promise(resolve => {
    const body = document.getElementById('webrtc-body');
    const ips = { public: new Set(), private: new Set(), mdns: new Set() };

    function classify(ip) {
      if (!ip) return null;
      if (ip.endsWith('.local')) return 'mdns';
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return 'private';
      if (ip === '127.0.0.1' || ip === '::1') return 'private';
      if (ip.startsWith('fc') || ip.startsWith('fd')) return 'private'; // IPv6 ULA
      if (ip.startsWith('fe80')) return 'private'; // link-local
      if (ip.includes(':') && ip.startsWith('::ffff:')) return null; // IPv4-mapped
      return 'public';
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ]});
      pc.createDataChannel('x');

      const timeout = setTimeout(() => {
        pc.close();
        render();
        resolve();
      }, 6000);

      pc.onicecandidate = (e) => {
        if (!e.candidate || !e.candidate.candidate) return;
        const cand = e.candidate.candidate;
        // Extract IP from candidate string
        const parts = cand.split(' ');
        if (parts.length < 5) return;
        const ip = parts[4];
        const type = classify(ip);
        if (type) ips[type].add(ip);
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          pc.close();
          render();
          resolve();
        }
      };

      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => {
        clearTimeout(timeout);
        render();
        resolve();
      });
    } catch {
      if (body) body.innerHTML = desc('WebRTC API not available in this browser context.', '');
      setBadge('badge-webrtc', 'info', 'N/A');
      setResult('WebRTC', 'pass', 'N/A');
      resolve();
    }

    function render() {
      const pubIPs = [...ips.public];
      const privIPs = [...ips.private];
      const mdnsIPs = [...ips.mdns];

      const publicIp = window._detectedPublicIP;
      const hasRealPublicLeak = pubIPs.some(ip => ip !== publicIp);

      let html = '';

      html += row('Gathering State', 'complete', 'green');
      html += row('Public IPs found', pubIPs.length > 0 ? pubIPs.length : 'None', pubIPs.length > 0 ? 'warn' : 'green');
      html += row('Private IPs', privIPs.length > 0 ? privIPs.length : 'None', '');
      html += row('mDNS tokens', mdnsIPs.length > 0 ? mdnsIPs.length : 'None', 'muted');

      if (pubIPs.length > 0 || privIPs.length > 0 || mdnsIPs.length > 0) {
        html += '<div class="ip-list">';
        pubIPs.forEach(ip => { html += '<div class="ip-item public"><span>'+ip+'</span><span class="ip-type">PUBLIC</span></div>'; });
        privIPs.forEach(ip => { html += '<div class="ip-item private"><span>'+ip+'</span><span class="ip-type">PRIVATE</span></div>'; });
        mdnsIPs.forEach(ip => { html += '<div class="ip-item mdns"><span>'+ip+'</span><span class="ip-type">mDNS</span></div>'; });
        html += '</div>';
      }

      if (hasRealPublicLeak) {
        html += desc('⚠ WebRTC is leaking a public IP that differs from your detected proxy IP. Your real IP may be exposed to websites.', 'fail');
        setBadge('badge-webrtc', 'fail', 'LEAK');
        setCardBorder('card-webrtc', 'fail');
        setResult('WebRTC', 'fail', 'Leak!');
      } else if (pubIPs.length > 0) {
        html += desc('A public IP was found but it matches your detected proxy IP. This is normal — WebRTC is going through the proxy correctly.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'OK');
      } else if (privIPs.length > 0) {
        html += desc('Only private/LAN IPs found — no public IP leak. Your proxy IP is not exposed via WebRTC.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'OK');
      } else if (mdnsIPs.length > 0) {
        html += desc('Only mDNS tokens found (Chrome\'s privacy mode). No real IPs are exposed via WebRTC.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'OK');
      } else {
        html += desc('No ICE candidates found. WebRTC may be fully blocked or the proxy is intercepting UDP. This is the most private configuration.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'Blocked');
      }

      if (body) body.innerHTML = html;
    }
  });
}

// ── Test 3: Bot / WebDriver ───────────────────────────────────────────────────
function testBot() {
  const body = document.getElementById('bot-body');
  const wd = navigator.webdriver;
  const hasCDP = !!(window.cdc_adoQpoasnfa76pfcZLmcfl_Array || window.cdc_adoQpoasnfa76pfcZLmcfl_Promise);
  const hasPhantom = !!(window.callPhantom || window._phantom);
  const hasSelenium = !!(window.__selenium_evaluate || window.__webdriver_evaluate || window.__driver_evaluate);

  let html = '';
  html += row('navigator.webdriver', wd ? 'TRUE' : 'false', wd ? 'red' : 'green');
  html += row('CDP artifacts', hasCDP ? 'FOUND' : 'None', hasCDP ? 'red' : 'green');
  html += row('PhantomJS artifacts', hasPhantom ? 'FOUND' : 'None', hasPhantom ? 'red' : 'green');
  html += row('Selenium artifacts', hasSelenium ? 'FOUND' : 'None', hasSelenium ? 'red' : 'green');

  const isBot = wd || hasCDP || hasPhantom || hasSelenium;
  if (isBot) {
    html += desc('⚠ Bot detection signals present. Instagram\'s JavaScript may flag this session. Review your EB user agent and ensure stealth scripts are active.', 'fail');
    setBadge('badge-bot', 'fail', 'FLAGGED');
    setCardBorder('card-bot', 'fail');
    setResult('WebDriver', 'fail', 'Flagged');
  } else {
    html += desc('No automation signals detected. The browser appears to be a normal user session to JavaScript-based bot detectors.', 'pass');
    setBadge('badge-bot', 'pass', 'CLEAN');
    setCardBorder('card-bot', 'pass');
    setResult('WebDriver', 'pass', 'Clean');
  }
  if (body) body.innerHTML = html;
}

// ── Test 4: Timezone ──────────────────────────────────────────────────────────
function testTimezone() {
  const body = document.getElementById('tz-body');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(offset)/60).toString().padStart(2,'0');
  const m = (Math.abs(offset)%60).toString().padStart(2,'0');
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  let html = '';
  html += row('Timezone', tz);
  html += row('UTC Offset', 'UTC'+sign+h+':'+m);
  html += row('Locale', locale);
  html += row('Date', new Date().toLocaleDateString('en-US',{timeZone:tz,weekday:'long',year:'numeric',month:'long',day:'numeric'}));
  if (body) body.innerHTML = html;
  setResult('Timezone', 'info', tz);
}

// ── Test 5: Navigator ─────────────────────────────────────────────────────────
function testNavigator() {
  const body = document.getElementById('nav-body');
  const n = navigator;
  let html = '';
  html += row('User Agent', n.userAgent);
  html += row('Platform', n.platform);
  html += row('App Version', n.appVersion.slice(0,60)+'…');
  html += row('Languages', n.languages.join(', '));
  html += row('Cookie Enabled', n.cookieEnabled ? 'Yes' : 'No');
  html += row('Do Not Track', n.doNotTrack ?? 'Not set', n.doNotTrack === '1' ? 'warn' : '');
  html += row('Plugins Count', n.plugins.length);
  html += row('MIME Types', n.mimeTypes.length);
  html += row('Online', n.onLine ? 'Yes' : 'No');
  if (n.connection) {
    const c = n.connection;
    html += row('Connection Type', c.effectiveType || c.type || '?');
  }
  if (body) body.innerHTML = html;
  setResult('Navigator', 'info', n.platform);
}

// ── Test 6: Screen & Hardware ─────────────────────────────────────────────────
function testHardware() {
  const body = document.getElementById('hw-body');
  const s = screen;
  const dpr = window.devicePixelRatio;
  const cpu = navigator.hardwareConcurrency;
  const mem = navigator.deviceMemory;
  let html = '';
  html += row('Resolution', s.width+'×'+s.height);
  html += row('Available', s.availWidth+'×'+s.availHeight);
  html += row('Color Depth', s.colorDepth+' bit');
  html += row('Pixel Ratio', dpr+'x');
  html += row('CPU Cores', cpu !== undefined ? cpu : '?');
  html += row('Device Memory', mem !== undefined ? mem+' GB' : '?');
  html += row('Touch Points', navigator.maxTouchPoints ?? 0);
  if (body) body.innerHTML = html;
  setResult('Hardware', 'info', s.width+'×'+s.height);
}

// ── Test 7: Canvas Fingerprint ────────────────────────────────────────────────
function testCanvas() {
  const body = document.getElementById('canvas-body');
  try {
    const c = document.getElementById('canvas-preview') as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#f60';
    ctx.fillRect(0, 0, 220, 50);
    ctx.fillStyle = '#069';
    ctx.font = 'bold 14px Arial';
    ctx.fillText('Equinox Leak Test 🔍', 4, 18);
    ctx.fillStyle = 'rgba(102,204,0,0.7)';
    ctx.font = '11px sans-serif';
    ctx.fillText('Canvas fingerprint check', 4, 36);
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.arc(180, 25, 18, 0, Math.PI * 2);
    ctx.stroke();
    const data = c.toDataURL().slice(22, 100);
    const hash = hashStr(c.toDataURL());
    let html = '';
    html += row('Canvas Hash', hash, 'muted');
    html += row('Noise Detected', 'No');
    html += desc('The canvas hash is used by websites to fingerprint your browser. Consistent across sessions = normal browser. Changes each reload = canvas noise protection active (good for privacy).');
    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'Blocked / Error', 'green') + desc('Canvas API is blocked or restricted. This improves canvas fingerprint resistance.', 'pass');
  }
  setBadge('badge-canvas', 'info', 'INFO');
  setResult('Canvas', 'info', 'Done');
}

// ── Test 8: Audio Fingerprint ─────────────────────────────────────────────────
async function testAudio() {
  const body = document.getElementById('audio-body');
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const analyser = ctx.createAnalyser();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(analyser);
    analyser.connect(gain);
    gain.connect(ctx.destination);
    osc.start(0);
    analyser.fftSize = 2048;
    await new Promise(r => setTimeout(r, 100));
    const buf = new Float32Array(analyser.frequencyBinCount);
    analyser.getFloatFrequencyData(buf);
    const sample = Array.from(buf.slice(0, 20)).map(v => v.toFixed(2)).join(',');
    const hash = hashStr(sample);
    osc.stop();
    ctx.close();
    let html = '';
    html += row('Audio Hash', hash, 'muted');
    html += row('Context State', ctx.state);
    html += row('Sample Rate', ctx.sampleRate + ' Hz');
    html += desc('The audio context fingerprint reflects subtle differences in hardware/OS audio processing. Like canvas, it varies between real devices but stays consistent for the same device.');
    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'Blocked', 'green') + desc('Audio API is unavailable or blocked.', '');
  }
  setBadge('badge-audio', 'info', 'INFO');
  setResult('Audio', 'info', 'Done');
}

// ── Test 9: WebGL ─────────────────────────────────────────────────────────────
function testWebGL() {
  const body = document.getElementById('webgl-body');
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) throw new Error('no webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor   = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
    const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const version  = gl.getParameter(gl.VERSION);
    const glslVer  = gl.getParameter(gl.SHADING_LANGUAGE_VERSION);
    const extsCount = gl.getSupportedExtensions()?.length ?? 0;
    let html = '';
    html += row('Vendor', vendor);
    html += row('Renderer', renderer);
    html += row('WebGL Version', version.split(' ').slice(0,3).join(' '));
    html += row('GLSL Version', glslVer.split(' ').slice(0,3).join(' '));
    html += row('Extensions', extsCount+' supported');
    if (body) body.innerHTML = html;
  } catch {
    if (body) body.innerHTML = row('Status', 'Not available', 'muted');
  }
  setBadge('badge-webgl', 'info', 'INFO');
  setResult('WebGL', 'info', 'Done');
}

// ── Run all ───────────────────────────────────────────────────────────────────
async function runAll() {
  // Reset
  Object.keys(RESULTS).forEach(k => delete RESULTS[k]);
  document.getElementById('hdr-dot')!.className = 'dot running';
  document.getElementById('score-pill')!.className = 'score-pill pending';
  document.getElementById('score-pill')!.textContent = 'Running…';
  document.getElementById('summary-bar')!.innerHTML = '';

  const resetBadge = (id) => setBadge(id, 'pending', '');
  ['badge-ip','badge-webrtc','badge-bot','badge-tz','badge-nav','badge-hw','badge-canvas','badge-audio','badge-webgl']
    .forEach(resetBadge);

  // Run synchronous tests immediately
  testBot();
  testTimezone();
  testNavigator();
  testHardware();
  testCanvas();

  // Run async tests in parallel
  await Promise.all([
    testIP().then(() => testWebRTC()), // WebRTC needs IP result for comparison
    testAudio(),
  ]);

  testWebGL(); // fast, sync
}

window.addEventListener('DOMContentLoaded', runAll);
</script>
</body>
</html>`;
