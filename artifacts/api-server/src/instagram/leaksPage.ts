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
  .card.wide { grid-column: 1 / -1; }

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
    max-width: 260px;
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

  /* ── Font list ──────────────────────────────────────── */
  .font-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 8px;
  }
  .font-tag {
    font-size: 10px;
    padding: 2px 7px;
    border-radius: 4px;
    background: rgba(0,0,0,.05);
    font-family: 'Menlo', 'Consolas', monospace;
    color: var(--text);
  }
  .font-tag.present { background: var(--pass-bg); color: var(--pass); border: 1px solid rgba(34,197,94,.2); }

  /* ── Identity grid ──────────────────────────────────── */
  .identity-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
    gap: 12px;
    margin-top: 4px;
  }
  .identity-block {
    background: rgba(0,0,0,.03);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .identity-block .ib-label {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: .06em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .identity-block .ib-value {
    font-family: 'Menlo', 'Consolas', monospace;
    font-size: 11px;
    color: var(--text);
    word-break: break-all;
    line-height: 1.6;
  }
  .identity-block .ib-value.none { color: var(--muted); font-style: italic; }

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

  <!-- Account Identity (server-injected) -->
  <div class="card wide" id="card-identity">
    <div class="card-header">
      <div class="card-title"><span class="icon">🪪</span> Account Identity</div>
      <span class="badge info" id="badge-identity">INFO</span>
    </div>
    <div class="card-body" id="identity-body">
      <div class="identity-grid">
        <div class="identity-block">
          <div class="ib-label">Assigned Proxy</div>
          <div class="ib-value" id="id-proxy">—</div>
        </div>
        <div class="identity-block">
          <div class="ib-label">Proxy Type / Credentials</div>
          <div class="ib-value" id="id-proxy-meta">—</div>
        </div>
        <div class="identity-block">
          <div class="ib-label">Electron Routes Via</div>
          <div class="ib-value" id="id-session-proxy">—</div>
        </div>
        <div class="identity-block">
          <div class="ib-label">Session Proxy Rules</div>
          <div class="ib-value" id="id-proxy-rules">—</div>
        </div>
        <div class="identity-block">
          <div class="ib-label">EB User Agent</div>
          <div class="ib-value" id="id-eb-ua">—</div>
        </div>
        <div class="identity-block">
          <div class="ib-label">Mobile API User Agent</div>
          <div class="ib-value" id="id-api-ua">—</div>
        </div>
      </div>
    </div>
  </div>

  <!-- Public IP -->
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

  <!-- IP Match -->
  <div class="card" id="card-ipmatch">
    <div class="card-header">
      <div class="card-title"><span class="icon">🎯</span> Proxy IP Match</div>
      <span class="badge pending" id="badge-ipmatch"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="ipmatch-body">
      <div class="row"><span class="row-label">Status</span><span class="row-value muted">Waiting for IP…</span></div>
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

  <!-- DNS Leak -->
  <div class="card" id="card-dns">
    <div class="card-header">
      <div class="card-title"><span class="icon">🔍</span> DNS Leak</div>
      <span class="badge pending" id="badge-dns"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="dns-body">
      <div class="row"><span class="row-label">Status</span><span class="row-value muted">Running…</span></div>
    </div>
  </div>

  <!-- User Agent Match -->
  <div class="card" id="card-uamatch">
    <div class="card-header">
      <div class="card-title"><span class="icon">🔐</span> User Agent Match</div>
      <span class="badge pending" id="badge-uamatch"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="uamatch-body"></div>
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

  <!-- Font Fingerprint -->
  <div class="card" id="card-fonts">
    <div class="card-header">
      <div class="card-title"><span class="icon">🔠</span> Font Fingerprint</div>
      <span class="badge pending" id="badge-fonts"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="fonts-body"></div>
  </div>

  <!-- Network -->
  <div class="card" id="card-net">
    <div class="card-header">
      <div class="card-title"><span class="icon">📶</span> Network Info</div>
      <span class="badge info" id="badge-net">INFO</span>
    </div>
    <div class="card-body" id="net-body"></div>
  </div>

  <!-- Battery -->
  <div class="card" id="card-battery">
    <div class="card-header">
      <div class="card-title"><span class="icon">🔋</span> Battery API</div>
      <span class="badge pending" id="badge-battery"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="battery-body"></div>
  </div>

  <!-- Media Devices -->
  <div class="card" id="card-media">
    <div class="card-header">
      <div class="card-title"><span class="icon">📷</span> Media Devices</div>
      <span class="badge pending" id="badge-media"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="media-body"></div>
  </div>

  <!-- Permissions -->
  <div class="card" id="card-perms">
    <div class="card-header">
      <div class="card-title"><span class="icon">🔑</span> Permissions</div>
      <span class="badge pending" id="badge-perms"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="perms-body"></div>
  </div>

  <!-- Speech Synthesis -->
  <div class="card" id="card-speech">
    <div class="card-header">
      <div class="card-title"><span class="icon">🗣️</span> Speech Synthesis</div>
      <span class="badge info" id="badge-speech">INFO</span>
    </div>
    <div class="card-body" id="speech-body"></div>
  </div>

  <!-- Client Hints -->
  <div class="card" id="card-hints">
    <div class="card-header">
      <div class="card-title"><span class="icon">💡</span> Client Hints</div>
      <span class="badge pending" id="badge-hints"><span class="spinner"></span></span>
    </div>
    <div class="card-body" id="hints-body"></div>
  </div>

  <!-- Performance / Timing -->
  <div class="card" id="card-perf">
    <div class="card-header">
      <div class="card-title"><span class="icon">⏱️</span> Timing Precision</div>
      <span class="badge info" id="badge-perf">INFO</span>
    </div>
    <div class="card-body" id="perf-body"></div>
  </div>

</div>

<button class="rerun-btn" onclick="runAll()">↺ Re-run All Tests</button>

<canvas id="canvas-preview" width="220" height="50"></canvas>

<script>
// ── Account data injected by server ───────────────────────────────────────────
const ACCOUNT = __ACCOUNT_DATA__;

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
function setCardBorder(id, cls, extra) {
  const el = document.getElementById(id);
  if (el) el.className = 'card '+(extra||'')+cls;
}

// Simple DJB2 hash → hex
function hashStr(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Safety-net wrapper: guarantees a hung fetch/test (e.g. a proxy that accepts
// a TCP connection but never completes the 407 handshake) can never block the
// rest of the test suite forever. Internal per-test AbortController timeouts
// (e.g. testIP's 8s fetch timeout) are not always enough — some proxy hangs
// occur before the abort signal has any effect. This is a belt-and-suspenders
// outer timeout so every card always resolves to a definite state.
function withTimeout(promiseFactory, ms, onTimeoutLabel) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn('[leak-test] ' + onTimeoutLabel + ' exceeded ' + ms + 'ms — forcing timeout so the rest of the suite can continue.');
      resolve();
    }, ms);
    Promise.resolve()
      .then(promiseFactory)
      .catch((e) => console.warn('[leak-test] ' + onTimeoutLabel + ' threw:', e))
      .finally(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      });
  });
}

// Collect results for summary
const RESULTS = {};
const TOTAL_SCORED = 7; // IP, WebRTC, DNS, UAMatch, Bot, IPMatch, Fonts
function setResult(key, status, label) {
  RESULTS[key] = { status, label };
  updateSummary();
  updateScore();
}

function updateSummary() {
  const bar = document.getElementById('summary-bar');
  if (!bar) return;
  const order = ['IP','IPMatch','WebRTC','DNS','UAMatch','Bot','Fonts','Timezone','Navigator','Hardware','Canvas','Audio','WebGL','Network','Battery','Media','Perms','Speech','Hints','Timing'];
  bar.innerHTML = order.filter(k => RESULTS[k]).map(k => {
    const r = RESULTS[k];
    return '<div class="summary-item '+r.status+'"><span>'+k+'</span></div>';
  }).join('');
}

function updateScore() {
  const dot  = document.getElementById('hdr-dot');
  const pill = document.getElementById('score-pill');
  const scored = ['IP','IPMatch','WebRTC','DNS','UAMatch','Bot','Fonts'];
  const ready = scored.filter(k => RESULTS[k]);
  if (ready.length < TOTAL_SCORED) {
    if (dot)  dot.className = 'dot running';
    if (pill) { pill.className = 'score-pill pending'; pill.textContent = 'Running…'; }
    return;
  }
  const vals = scored.map(k => RESULTS[k]);
  const fails = vals.filter(r => r.status === 'fail').length;
  const warns = vals.filter(r => r.status === 'warn').length;
  if (dot) dot.className = (fails > 0 || warns > 0) ? 'dot done-warn' : 'dot done-ok';
  if (pill) {
    if (fails === 0 && warns === 0) {
      pill.className = 'score-pill good';
      pill.textContent = 'All Clear';
    } else {
      pill.className = 'score-pill bad';
      pill.textContent = (fails+warns) + ' Issue' + ((fails+warns) > 1 ? 's' : '');
    }
  }
}

// ── Test 0: Account Identity ──────────────────────────────────────────────────
function testIdentity() {
  const proxyEl       = document.getElementById('id-proxy');
  const proxyMetaEl   = document.getElementById('id-proxy-meta');
  const sessionProxyEl= document.getElementById('id-session-proxy');
  const proxyRulesEl  = document.getElementById('id-proxy-rules');
  const ebUaEl        = document.getElementById('id-eb-ua');
  const apiUaEl       = document.getElementById('id-api-ua');

  if (ACCOUNT.proxy) {
    if (proxyEl) { proxyEl.textContent = ACCOUNT.proxy; proxyEl.className = 'ib-value'; }
  } else {
    if (proxyEl) { proxyEl.textContent = 'No proxy assigned'; proxyEl.className = 'ib-value none'; }
  }

  // Proxy type + credentials
  if (proxyMetaEl) {
    if (ACCOUNT.proxy) {
      const type  = (ACCOUNT.proxyType || 'http').toUpperCase();
      const creds = ACCOUNT.proxyHasCredentials ? '🔑 Credentials set' : '⚠️ No credentials';
      proxyMetaEl.textContent = type + ' — ' + creds;
      proxyMetaEl.className   = 'ib-value' + (ACCOUNT.proxyHasCredentials ? '' : ' warn');
    } else {
      proxyMetaEl.textContent = 'N/A';
      proxyMetaEl.className   = 'ib-value none';
    }
  }

  // What Electron's routing engine resolved
  if (sessionProxyEl) {
    const sp = ACCOUNT.sessionResolvedProxy;
    if (sp) {
      const isDirect = sp === 'DIRECT';
      sessionProxyEl.textContent = sp;
      sessionProxyEl.className   = 'ib-value' + (isDirect && ACCOUNT.proxy ? ' red' : '');
      if (isDirect && ACCOUNT.proxy) {
        sessionProxyEl.title = 'WARNING: Electron resolved DIRECT even though a proxy is assigned. The proxy session config may not have been applied yet — try reopening the EB window.';
      }
    } else if (ACCOUNT.sessionStoredProxy && ACCOUNT.sessionStoredProxy.error) {
      sessionProxyEl.textContent = 'EB window not open';
      sessionProxyEl.className   = 'ib-value none';
    } else {
      sessionProxyEl.textContent = 'Not available';
      sessionProxyEl.className   = 'ib-value none';
    }
  }

  // Raw proxy rules string applied to the session
  if (proxyRulesEl) {
    const rules = ACCOUNT.sessionProxyRules;
    if (rules) {
      proxyRulesEl.textContent = rules;
      proxyRulesEl.className   = 'ib-value';
    } else {
      proxyRulesEl.textContent = 'Not available';
      proxyRulesEl.className   = 'ib-value none';
    }
  }

  if (ACCOUNT.ebUA) {
    if (ebUaEl) { ebUaEl.textContent = ACCOUNT.ebUA; ebUaEl.className = 'ib-value'; }
  } else {
    if (ebUaEl) { ebUaEl.textContent = 'Not set'; ebUaEl.className = 'ib-value none'; }
  }
  if (ACCOUNT.apiUA) {
    if (apiUaEl) { apiUaEl.textContent = ACCOUNT.apiUA; apiUaEl.className = 'ib-value'; }
  } else {
    if (apiUaEl) { apiUaEl.textContent = 'Not set'; apiUaEl.className = 'ib-value none'; }
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
    // api.ipify.org is IPv4-only (no AAAA record).  api64.ipify.org is the
    // Cloudflare-fronted dual-stack endpoint and supports QUIC/HTTP3, which
    // Chrome can open as a direct UDP connection that bypasses an HTTP proxy
    // — causing the real machine IPv6 to appear instead of the proxy IP.
    // Using the IPv4-only endpoint ensures the result always reflects the
    // proxied TCP path, giving an accurate proxy-IP-match result.
    const r = await makeFetch('https://api.ipify.org?format=json', 8000);
    const d = await r.json();
    const ip = d.ip || '—';
    if (display) { display.className = 'ip-addr'; display.textContent = ip; }
    let geoHtml = '';
    try {
      const g = await makeFetch('https://ipapi.co/'+ip+'/json/', 8000);
      const gd = await g.json();
      const isIPv6 = ip.includes(':');
      geoHtml = row('IP Version', isIPv6 ? 'IPv6' : 'IPv4', isIPv6 ? 'warn' : '')
              + row('Country', (gd.country_name||'?'))
              + row('City', gd.city||'?')
              + row('ISP / Org', gd.org||'?')
              + row('ASN', gd.asn||'?')
              + row('Timezone', gd.timezone||'?')
              + row('Hosting / DC', gd.is_datacenter ? 'YES — datacenter IP' : 'No', gd.is_datacenter ? 'warn' : 'green');
      window._detectedGeo = gd;
    } catch {}
    if (rows) rows.innerHTML = geoHtml;
    setBadge('badge-ip', 'info', 'INFO');
    setCardBorder('card-ip', '');
    setResult('IP', 'info', ip);
    window._detectedPublicIP = ip;
  } catch (e) {
    if (display) { display.className = 'ip-addr'; display.textContent = 'Timed out'; }
    const proxyStr = ACCOUNT.proxy || '';
    const timeoutMsg = proxyStr
      ? '<b>✅ The proxy IS blocking direct traffic (this is correct).</b><br><br>'
        + 'The EB session is routing through <code>' + proxyStr + '</code> — ipify.org timed out because the proxy is intercepting the request. '
        + 'The issue is that the <b>proxy server itself is not forwarding the request</b>.<br><br>'
        + '<b>Possible causes:</b><ul style="margin:4px 0 0 16px;padding:0">'
        + '<li>Proxy server is down or unreachable</li>'
        + '<li>Wrong username/password — proxy rejected the CONNECT request</li>'
        + '<li>Port ' + (ACCOUNT.proxyPort||'?') + ' is blocked by a firewall</li>'
        + '<li>Proxy server is blocking ipify.org specifically</li>'
        + '</ul><br>'
        + 'Check the <b>Proxy Type / Credentials</b> row above and the <b>Electron Routes Via</b> row. '
        + 'If Electron shows the proxy address correctly, the proxy config is applied — the issue is with the proxy server, not with Equinox.'
      : 'Could not reach ipify.org — connection timed out after 8s. No proxy is assigned, so this may be a network connectivity issue.';
    if (rows) rows.innerHTML = desc(timeoutMsg, proxyStr ? 'info' : 'warn');
    setBadge('badge-ip', proxyStr ? 'info' : 'warn', proxyStr ? 'INFO' : 'WARN');
    setResult('IP', proxyStr ? 'info' : 'warn', 'Timed out');
    window._detectedPublicIP = null;
  }
}

// ── Test 2: IP Match (proxy host vs detected IP) ───────────────────────────────
function testIPMatch() {
  const body = document.getElementById('ipmatch-body');
  const detectedIP = window._detectedPublicIP;
  const proxyStr = ACCOUNT.proxy || '';

  if (!proxyStr) {
    if (body) body.innerHTML = row('Assigned Proxy', 'None', 'muted')
      + desc('No proxy is assigned to this account. The connection is using the host machine\'s real IP.', 'warn');
    setBadge('badge-ipmatch', 'warn', 'WARN');
    setCardBorder('card-ipmatch', 'warn');
    setResult('IPMatch', 'warn', 'No proxy');
    return;
  }

  const proxyHost = ACCOUNT.proxyHost || '';
  const proxyPort = ACCOUNT.proxyPort || '';

  if (!detectedIP) {
    if (body) body.innerHTML = row('Assigned Proxy', proxyStr, '')
      + desc('Could not detect public IP — unable to compare against proxy.', 'warn');
    setBadge('badge-ipmatch', 'warn', 'WARN');
    setResult('IPMatch', 'warn', 'No IP');
    return;
  }

  // Check if proxyHost looks like an IP (IPv4 or IPv6)
  const isIP = /^[\d.:a-fA-F]+$/.test(proxyHost) && !proxyHost.includes('.com') && !proxyHost.includes('.net') && !proxyHost.includes('.org');

  let html = row('Assigned Proxy', proxyStr)
           + row('Detected IP', detectedIP);

  if (isIP) {
    const match = detectedIP === proxyHost || detectedIP.includes(proxyHost);
    html += row('Match', match ? '✓ MATCH' : '✗ MISMATCH', match ? 'green' : 'red');
    if (match) {
      html += desc('Detected IP matches the assigned proxy. Traffic is routing through the correct proxy server.', 'pass');
      setBadge('badge-ipmatch', 'pass', 'PASS');
      setCardBorder('card-ipmatch', 'pass');
      setResult('IPMatch', 'pass', 'Match');
    } else {
      html += desc('<strong>Detected IP does not match the proxy server IP.</strong><br><br>'
        + '<b>If the detected IP above is your machine\'s real IP</b> — the proxy is not routing traffic at all. '
        + 'The EB session is going direct. Check that the proxy is reachable, credentials are correct, and the proxy is assigned to this account.<br><br>'
        + '<b>If the detected IP is an unfamiliar residential address</b> — this is expected for residential proxies. '
        + 'The proxy host (' + proxyHost + ') is the provider\'s entry-point server; the exit IP is the residential address assigned to your session. '
        + 'These are always different by design.', 'fail');
      setBadge('badge-ipmatch', 'fail', 'FAIL');
      setCardBorder('card-ipmatch', 'fail');
      setResult('IPMatch', 'fail', 'Diff IP');
    }
  } else {
    html += row('Match', 'Proxy is a hostname — cannot verify in browser', 'muted');
    html += desc('The proxy uses a hostname (not a raw IP). Browser cannot resolve DNS to compare. Check that the IP shown above matches the expected proxy location.', '');
    setBadge('badge-ipmatch', 'info', 'INFO');
    setResult('IPMatch', 'info', 'Hostname');
  }

  if (body) body.innerHTML = html;
}

// ── Test 3: WebRTC Leak ───────────────────────────────────────────────────────
function testWebRTC() {
  return new Promise(resolve => {
    const body = document.getElementById('webrtc-body');
    const ips = { public: new Set(), private: new Set(), mdns: new Set() };

    function classify(ip) {
      if (!ip) return null;
      if (ip.endsWith('.local')) return 'mdns';
      if (ip.startsWith('10.') || ip.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 'private';
      if (ip === '127.0.0.1' || ip === '::1') return 'private';
      if (/^f[cd]/i.test(ip)) return 'private'; // IPv6 ULA
      if (/^fe80/i.test(ip)) return 'private'; // link-local
      if (ip.startsWith('::ffff:')) return null; // IPv4-mapped
      return 'public';
    }

    try {
      const pc = new RTCPeerConnection({ iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
      ]});
      pc.createDataChannel('eq');

      const timeout = setTimeout(() => { pc.close(); render(); resolve(); }, 7000);
      pc.onicecandidate = (e) => {
        if (!e.candidate?.candidate) return;
        const parts = e.candidate.candidate.split(' ');
        if (parts.length < 5) return;
        const ip = parts[4];
        const type = classify(ip);
        if (type) ips[type].add(ip);
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout); pc.close(); render(); resolve();
        }
      };
      pc.createOffer().then(o => pc.setLocalDescription(o)).catch(() => { clearTimeout(timeout); render(); resolve(); });
    } catch {
      if (body) body.innerHTML = desc('WebRTC API not available in this context.', '');
      setBadge('badge-webrtc', 'pass', 'N/A');
      setResult('WebRTC', 'pass', 'N/A');
      resolve();
    }

    function render() {
      const pubIPs = [...ips.public];
      const privIPs = [...ips.private];
      const mdnsIPs = [...ips.mdns];
      const publicIp = window._detectedPublicIP;
      const hasRealLeak = pubIPs.some(ip => ip !== publicIp);
      const hasIPv6Leak = pubIPs.some(ip => ip.includes(':'));

      let html = '';
      html += row('Gathering State', 'complete', 'green');
      html += row('Public IPs', pubIPs.length > 0 ? pubIPs.length : 'None', pubIPs.length > 0 ? 'warn' : 'green');
      html += row('IPv6 Exposed', hasIPv6Leak ? pubIPs.filter(i=>i.includes(':')).join(', ') : 'None', hasIPv6Leak ? 'red' : 'green');
      html += row('Private IPs', privIPs.length > 0 ? privIPs.length : 'None', '');
      html += row('mDNS Tokens', mdnsIPs.length > 0 ? mdnsIPs.length : 'None', 'muted');

      if (pubIPs.length > 0 || privIPs.length > 0 || mdnsIPs.length > 0) {
        html += '<div class="ip-list">';
        pubIPs.forEach(ip => { html += '<div class="ip-item public"><span>'+ip+'</span><span class="ip-type">'+(ip.includes(':') ? 'IPv6 PUBLIC' : 'PUBLIC')+'</span></div>'; });
        privIPs.forEach(ip => { html += '<div class="ip-item private"><span>'+ip+'</span><span class="ip-type">PRIVATE</span></div>'; });
        mdnsIPs.forEach(ip => { html += '<div class="ip-item mdns"><span>'+ip+'</span><span class="ip-type">mDNS</span></div>'; });
        html += '</div>';
      }

      if (hasRealLeak || hasIPv6Leak) {
        html += desc('⚠ WebRTC is exposing an IP that differs from your proxy. Your real IP or IPv6 address is visible to sites.', 'fail');
        setBadge('badge-webrtc', 'fail', 'LEAK');
        setCardBorder('card-webrtc', 'fail');
        setResult('WebRTC', 'fail', 'Leak!');
      } else if (pubIPs.length > 0) {
        html += desc('A public IP was found but matches your proxy IP — WebRTC is routing through the proxy correctly.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'OK');
      } else if (mdnsIPs.length > 0) {
        html += desc('Only mDNS tokens found (Chrome privacy mode). No real IPs exposed via WebRTC.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'mDNS');
      } else {
        html += desc('No ICE candidates generated. WebRTC is fully blocked or UDP is disabled. Most private configuration possible.', 'pass');
        setBadge('badge-webrtc', 'pass', 'PASS');
        setCardBorder('card-webrtc', 'pass');
        setResult('WebRTC', 'pass', 'Blocked');
      }

      if (body) body.innerHTML = html;
    }
  });
}

// ── Test 4: DNS Leak ──────────────────────────────────────────────────────────
async function testDNS() {
  const body = document.getElementById('dns-body');
  function tf(url, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    return fetch(url, { cache: 'no-store', signal: ctrl.signal }).finally(() => clearTimeout(t));
  }

  const ips = [];
  const sources = [];

  try {
    // Cloudflare trace — reveals IP as seen from Cloudflare's edge
    const r1 = await tf('https://1.1.1.1/cdn-cgi/trace', 5000);
    const t1 = await r1.text();
    const ipLine = t1.split('\n').find(l => l.startsWith('ip='));
    if (ipLine) { ips.push(ipLine.split('=')[1].trim()); sources.push('Cloudflare'); }
  } catch {}

  try {
    // api.ipify.org (NOT api64) — IPv4-only endpoint with no AAAA record and no
    // QUIC support.  api64.ipify.org is Cloudflare-fronted and dual-stack; Chrome
    // can open it via direct UDP/QUIC or IPv6, bypassing the HTTP proxy entirely
    // and exposing the real machine IPv6 — making the test report a false leak.
    const r2 = await tf('https://api.ipify.org?format=json', 5000);
    const d2 = await r2.json();
    if (d2.ip) { ips.push(d2.ip); sources.push('ipify'); }
  } catch {}

  try {
    // api4.my-ip.io (NOT api) — IPv4-only subdomain.  api.my-ip.io has an
    // AAAA record and Chrome opens it via a direct IPv6 socket that bypasses
    // the HTTP proxy entirely, exposing the real machine IPv6 — same failure
    // mode as api64.ipify.org (fixed in v1.0.611).  api4.my-ip.io has no
    // AAAA record so all requests must go through the proxy over TCP.
    const r3 = await tf('https://api4.my-ip.io/v2/ip.json', 5000);
    const d3 = await r3.json();
    if (d3.ip) { ips.push(d3.ip); sources.push('my-ip.io'); }
  } catch {}

  const detectedIP = window._detectedPublicIP;
  let html = '';
  const uniqueIPs = [...new Set(ips)];

  for (let i = 0; i < ips.length; i++) {
    const match = detectedIP && ips[i] === detectedIP;
    html += row(sources[i], ips[i], match ? 'green' : (detectedIP ? 'red' : ''));
  }

  if (uniqueIPs.length === 0) {
    html += desc('All DNS endpoint checks timed out — unable to verify DNS routing.', 'warn');
    setBadge('badge-dns', 'warn', 'WARN');
    setResult('DNS', 'warn', 'Timeout');
  } else if (uniqueIPs.length === 1) {
    const consistent = !detectedIP || uniqueIPs[0] === detectedIP;
    html += row('Unique IPs seen', uniqueIPs.length.toString(), 'green');
    if (consistent) {
      html += desc('All DNS resolvers returned the same IP as your proxy. DNS is routing consistently — no leak detected.', 'pass');
      setBadge('badge-dns', 'pass', 'PASS');
      setCardBorder('card-dns', 'pass');
      setResult('DNS', 'pass', 'OK');
    } else {
      html += desc('DNS resolvers returned an IP that differs from your detected public IP. DNS may be leaking outside the proxy.', 'warn');
      setBadge('badge-dns', 'warn', 'WARN');
      setCardBorder('card-dns', 'warn');
      setResult('DNS', 'warn', 'Different IP');
    }
  } else {
    html += row('Unique IPs seen', uniqueIPs.length.toString(), 'red');
    html += desc('⚠ Multiple different IPs returned by IP-check services. Different connections are routing through different paths — some traffic is bypassing the proxy (likely via IPv6 or QUIC/UDP direct connections).', 'fail');
    setBadge('badge-dns', 'fail', 'LEAK');
    setCardBorder('card-dns', 'fail');
    setResult('DNS', 'fail', 'Leak!');
  }

  if (body) body.innerHTML = html;
}

// ── Test 5: User Agent Match ──────────────────────────────────────────────────
function testUAMatch() {
  const body = document.getElementById('uamatch-body');
  const browserUA = navigator.userAgent;
  const assignedEbUA = ACCOUNT.ebUA || '';
  const assignedApiUA = ACCOUNT.apiUA || '';

  let html = '';
  html += row('Browser UA (actual)', browserUA);

  if (!assignedEbUA) {
    html += row('Assigned EB UA', 'Not set', 'muted');
    html += desc('No EB User Agent assigned to this account. Assign one in Account Settings to prevent UA fingerprinting.', 'warn');
    setBadge('badge-uamatch', 'warn', 'WARN');
    setCardBorder('card-uamatch', 'warn');
    setResult('UAMatch', 'warn', 'No UA set');
  } else {
    const exactMatch = browserUA === assignedEbUA;
    const partialMatch = !exactMatch && (browserUA.includes(assignedEbUA.slice(0, 40)) || assignedEbUA.includes(browserUA.slice(0, 40)));
    html += row('Assigned EB UA', assignedEbUA);
    html += row('Match', exactMatch ? '✓ EXACT MATCH' : (partialMatch ? '~ PARTIAL MATCH' : '✗ MISMATCH'), exactMatch ? 'green' : (partialMatch ? 'warn' : 'red'));
    if (assignedApiUA) {
      html += row('Mobile API UA', assignedApiUA);
    }
    if (exactMatch) {
      html += desc('The browser is using exactly the assigned EB User Agent. Instagram will see a consistent UA fingerprint.', 'pass');
      setBadge('badge-uamatch', 'pass', 'PASS');
      setCardBorder('card-uamatch', 'pass');
      setResult('UAMatch', 'pass', 'Match');
    } else if (partialMatch) {
      html += desc('Partial UA match. The browser UA shares content with the assigned UA but is not identical. This may indicate a version difference.', 'warn');
      setBadge('badge-uamatch', 'warn', 'WARN');
      setCardBorder('card-uamatch', 'warn');
      setResult('UAMatch', 'warn', 'Partial');
    } else {
      html += desc('⚠ The active browser UA does not match the assigned EB UA. Instagram may detect a UA fingerprint inconsistency between sessions.', 'fail');
      setBadge('badge-uamatch', 'fail', 'FAIL');
      setCardBorder('card-uamatch', 'fail');
      setResult('UAMatch', 'fail', 'Mismatch!');
    }
  }

  if (body) body.innerHTML = html;
}

// ── Test 6: Bot / WebDriver detection ────────────────────────────────────────
function testBot() {
  const body = document.getElementById('bot-body');
  const wd = navigator.webdriver;
  // Check BOTH conditions that make a webdriver patch correct:
  //   1. Value must be exactly false (not undefined — real Chrome never returns undefined)
  //   2. Must NOT be an own-instance property (real Chrome keeps it on Navigator.prototype)
  // Both are tested explicitly below so the old get:undefined / instance-shadow bug
  // shows red instead of silently passing a simple truthy test.
  const wdIsOwnProp = Object.prototype.hasOwnProperty.call(navigator, 'webdriver');
  const wdBad = wd !== false || wdIsOwnProp;
  const hasCDP = !!(window.cdc_adoQpoasnfa76pfcZLmcfl_Array || window.cdc_adoQpoasnfa76pfcZLmcfl_Promise || window.cdc_adoQpoasnfa76pfcZLmcfl_Symbol);
  const hasPhantom = !!(window.callPhantom || window._phantom || window.__phantomas);
  const hasSelenium = !!(window.__selenium_evaluate || window.__webdriver_evaluate || window.__driver_evaluate || window.$cdc_asdjflasutopfhvcZLmcfl_);
  const hasNightmare = !!window.__nightmare;
  const hasCypress = !!window.Cypress;
  const pluginsOk = navigator.plugins.length > 0;
  const mimeOk = navigator.mimeTypes.length > 0;
  const langOk = navigator.languages && navigator.languages.length > 0;
  const hardwareOk = navigator.hardwareConcurrency > 1;

  let html = '';
  var wdLabel = wd === undefined ? 'undefined (bad \u2014 automation tell)' :
                (wd === false && wdIsOwnProp) ? 'false (own-prop shadow \u2014 bad)' :
                wd === false ? 'false \u2713' : 'TRUE (bad)';
  html += row('navigator.webdriver', wdLabel, wdBad ? 'red' : 'green');
  if (wdIsOwnProp && wd === false) {
    html += desc('webdriver is false but is set as an own property on navigator instead of Navigator.prototype. Real Chrome keeps it on the prototype. Anti-bot scripts that call Object.getOwnPropertyDescriptor(navigator,"webdriver") will detect this shadow as an automation tell.', 'fail');
  }
  if (wd === undefined) {
    html += desc('navigator.webdriver is undefined. Real non-automated Chrome always returns false, never undefined. This is a known automation tell that Instagram\'s JS checks.', 'fail');
  }
  html += row('CDP artifacts', hasCDP ? 'FOUND' : 'None', hasCDP ? 'red' : 'green');
  html += row('PhantomJS artifacts', hasPhantom ? 'FOUND' : 'None', hasPhantom ? 'red' : 'green');
  html += row('Selenium artifacts', hasSelenium ? 'FOUND' : 'None', hasSelenium ? 'red' : 'green');
  html += row('Nightmare.js', hasNightmare ? 'FOUND' : 'None', hasNightmare ? 'red' : 'green');
  html += row('Cypress', hasCypress ? 'FOUND' : 'None', hasCypress ? 'warn' : 'green');
  html += row('Plugins', pluginsOk ? navigator.plugins.length+' found' : 'Empty — suspicious', pluginsOk ? 'green' : 'warn');
  html += row('MIME Types', mimeOk ? navigator.mimeTypes.length+' found' : 'Empty — suspicious', mimeOk ? 'green' : 'warn');
  html += row('Languages', langOk ? navigator.languages.join(', ') : 'None', langOk ? 'green' : 'warn');
  html += row('CPU Cores', hardwareOk ? navigator.hardwareConcurrency : '1 — suspicious', hardwareOk ? 'green' : 'warn');

  const isBot = wdBad || hasCDP || hasPhantom || hasSelenium || hasNightmare;
  if (isBot) {
    html += desc('\u26a0 Automation signals detected. Instagram\'s JS will flag this session. Ensure stealth patches are applied.', 'fail');
    setBadge('badge-bot', 'fail', 'FLAGGED');
    setCardBorder('card-bot', 'fail');
    setResult('Bot', 'fail', 'Flagged');
  } else {
    html += desc('No automation signals found. Browser appears as a normal user session to JavaScript-based bot detectors.', 'pass');
    setBadge('badge-bot', 'pass', 'CLEAN');
    setCardBorder('card-bot', 'pass');
    setResult('Bot', 'pass', 'Clean');
  }
  if (body) body.innerHTML = html;
}

// ── Test 7: Timezone ──────────────────────────────────────────────────────────
function testTimezone() {
  const body = document.getElementById('tz-body');
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = -new Date().getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const h = Math.floor(Math.abs(offset)/60).toString().padStart(2,'0');
  const m = (Math.abs(offset)%60).toString().padStart(2,'0');
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const geoTZ = window._detectedGeo?.timezone;
  let html = '';
  html += row('Browser Timezone', tz);
  html += row('UTC Offset', 'UTC'+sign+h+':'+m);
  html += row('Locale', locale);
  html += row('Date', new Date().toLocaleDateString('en-US',{timeZone:tz,weekday:'long',year:'numeric',month:'long',day:'numeric'}));
  if (geoTZ) {
    const tzMatch = tz === geoTZ;
    html += row('Proxy Geo Timezone', geoTZ, tzMatch ? 'green' : 'warn');
    html += row('TZ Consistent', tzMatch ? '✓ Yes' : '✗ Mismatch — browser TZ differs from proxy location', tzMatch ? 'green' : 'warn');
    if (!tzMatch) {
      html += desc('Browser timezone differs from the proxy\'s geographic timezone. Instagram may detect a location inconsistency. Consider adjusting the system timezone to match the proxy.', 'warn');
    }
  }
  if (body) body.innerHTML = html;
  setResult('Timezone', 'info', tz);
}

// ── Test 8: Navigator ─────────────────────────────────────────────────────────
function testNavigator() {
  const body = document.getElementById('nav-body');
  const n = navigator;
  let html = '';
  html += row('User Agent', n.userAgent);
  html += row('Platform', n.platform);
  html += row('App Version', n.appVersion.slice(0,80)+'…');
  html += row('Languages', n.languages.join(', '));
  html += row('Cookie Enabled', n.cookieEnabled ? 'Yes' : 'No');
  html += row('Do Not Track', n.doNotTrack ?? 'Not set', n.doNotTrack === '1' ? 'warn' : '');
  html += row('Plugins Count', n.plugins.length);
  html += row('MIME Types', n.mimeTypes.length);
  html += row('Online', n.onLine ? 'Yes' : 'No');
  html += row('Java Enabled', typeof n.javaEnabled === 'function' ? (n.javaEnabled() ? 'Yes' : 'No') : 'n/a');
  html += row('Vendor', n.vendor || 'n/a');
  html += row('App Name', n.appName);
  html += row('Product', n.product || 'n/a');
  if (n.connection) {
    const c = n.connection;
    html += row('Connection Type', c.effectiveType || c.type || '?');
    html += row('Downlink', c.downlink !== undefined ? c.downlink+'Mbps' : '?');
    html += row('RTT', c.rtt !== undefined ? c.rtt+'ms' : '?');
  }
  if (body) body.innerHTML = html;
  setResult('Navigator', 'info', n.platform);
}

// ── Test 9: Screen & Hardware ─────────────────────────────────────────────────
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
  html += row('Orientation Type', screen.orientation?.type ?? 'n/a');
  html += row('Inner Window', window.innerWidth+'×'+window.innerHeight);
  html += row('Outer Window', window.outerWidth+'×'+window.outerHeight);
  html += row('Screen Orient', window.screen.orientation?.angle !== undefined ? window.screen.orientation.angle+'°' : 'n/a');
  if (body) body.innerHTML = html;
  setResult('Hardware', 'info', s.width+'×'+s.height);
}

// ── Test 10: Canvas Fingerprint ───────────────────────────────────────────────
function testCanvas() {
  const body = document.getElementById('canvas-body');
  try {
    const c = document.getElementById('canvas-preview');
    const ctx = c.getContext('2d');
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
    const hash = hashStr(c.toDataURL());
    // Detect whether HTMLCanvasElement.prototype.toDataURL/toBlob have actually been
    // patched by the fingerprint-noise hook (armSilentWindowAntiDetection /
    // buildFingerprintScript), rather than hardcoding a static label. A native,
    // un-hooked implementation always stringifies to "[native code]"; our hook
    // replaces it with a real function body, so the absence of "[native code]"
    // is a reliable positive signal that the per-account canvas noise is active.
    const canvasHooked = !/\[native code\]/.test(HTMLCanvasElement.prototype.toDataURL.toString())
      || !/\[native code\]/.test(HTMLCanvasElement.prototype.toBlob.toString());
    let html = '';
    html += row('Canvas Hash', hash, 'muted');
    html += row('Canvas Protection', canvasHooked ? 'Noise active (hooked)' : 'No noise detected', canvasHooked ? 'green' : 'red');
    html += desc('Canvas hash is used to fingerprint browsers across sites. A consistent hash = normal browser. Randomized each reload = canvas noise is active.');
    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'Blocked / Error', 'green') + desc('Canvas API is blocked. This improves canvas fingerprint resistance.', 'pass');
  }
  setBadge('badge-canvas', 'info', 'INFO');
  setResult('Canvas', 'info', 'Done');
}

// ── Test 11: Audio Fingerprint ────────────────────────────────────────────────
async function testAudio() {
  const body = document.getElementById('audio-body');
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
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
    // Capture AudioContext state BEFORE closing — ctx.state after ctx.close()
    // ALWAYS returns "closed" regardless of what the context was doing, so the
    // old code always showed "closed" even on a fully healthy audio context.
    // A real browser AudioContext that was just created shows "running" here.
    const ctxStateCaptured = ctx.state;
    osc.stop();
    ctx.close();
    // Same detection approach as testCanvas(): a hooked AnalyserNode method no
    // longer stringifies to "[native code]" once buildFingerprintScript()/
    // armSilentWindowAntiDetection() has patched it with the per-account audio
    // noise seed.
    const audioHooked = !/\[native code\]/.test(AnalyserNode.prototype.getFloatFrequencyData.toString());
    let html = '';
    html += row('Audio Hash', hash, 'muted');
    html += row('Audio Protection', audioHooked ? 'Noise active (hooked)' : 'No noise detected', audioHooked ? 'green' : 'red');
    html += row('Context State', ctxStateCaptured, ctxStateCaptured === 'running' || ctxStateCaptured === 'suspended' ? 'green' : 'warn');
    html += row('Sample Rate', ctx.sampleRate + ' Hz');
    html += row('Channel Count', ctx.destination.channelCount || 'n/a');
    html += desc('Audio fingerprint reflects hardware/OS audio processing differences. Consistent for the same device; varies between real devices.');
    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'Blocked', 'green') + desc('Audio API is unavailable or blocked.', '');
  }
  setBadge('badge-audio', 'info', 'INFO');
  setResult('Audio', 'info', 'Done');
}

// ── Test 12: WebGL ────────────────────────────────────────────────────────────
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
    // WebGL2
    const gl2 = c.getContext('webgl2');
    html += row('WebGL 2', gl2 ? 'Supported' : 'Not supported', '');
    if (body) body.innerHTML = html;
  } catch {
    if (body) body.innerHTML = row('Status', 'Not available', 'muted');
  }
  setBadge('badge-webgl', 'info', 'INFO');
  setResult('WebGL', 'info', 'Done');
}

// ── Test 13: Font Fingerprint ─────────────────────────────────────────────────
function testFonts() {
  const body = document.getElementById('fonts-body');
  const TEST_FONTS = [
    'Arial','Arial Black','Arial Narrow','Calibri','Cambria','Comic Sans MS',
    'Courier','Courier New','Georgia','Helvetica','Impact','Lucida Console',
    'Lucida Sans Unicode','Microsoft Sans Serif','Palatino Linotype',
    'Segoe UI','Tahoma','Times New Roman','Trebuchet MS','Verdana',
    'Wingdings','Symbol','Webdings','Franklin Gothic Medium',
    'Century Gothic','Bookman Old Style','Garamond','Gill Sans MT',
  ];

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('getContext("2d") returned null');
    const BASELINE_FONT = 'monospace';
    const TEST_TEXT = 'mmmmmmmmmmlli';
    ctx.font = '72px ' + BASELINE_FONT;
    const baseW = ctx.measureText(TEST_TEXT).width;

    const present = [];
    for (const font of TEST_FONTS) {
      ctx.font = '72px '+font+', '+BASELINE_FONT;
      const w = ctx.measureText(TEST_TEXT).width;
      if (w !== baseW) present.push(font);
    }

    let html = '';
    html += row('Fonts Detected', present.length + ' / ' + TEST_FONTS.length, present.length > 5 ? 'green' : 'warn');
    html += row('Sample', present.slice(0,5).join(', ')+(present.length>5?'…':''), 'muted');
    html += '<div class="font-grid">';
    for (const f of TEST_FONTS) {
      const found = present.includes(f);
      html += '<span class="font-tag'+(found?' present':'')+'">'+f+'</span>';
    }
    html += '</div>';

    if (present.length < 3) {
      html += desc('Very few fonts detected. This is unusual and may indicate a sandboxed or headless environment — could be flagged by fingerprinting services.', 'warn');
      setBadge('badge-fonts', 'warn', 'WARN');
      setCardBorder('card-fonts', 'warn');
      setResult('Fonts', 'warn', present.length+' fonts');
    } else {
      html += desc('Font list is within normal range for a real user browser.');
      setBadge('badge-fonts', 'pass', 'PASS');
      setCardBorder('card-fonts', 'pass');
      setResult('Fonts', 'pass', present.length+' fonts');
    }

    if (body) body.innerHTML = html;
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'Canvas API error — ' + (e && e.message ? e.message : String(e)), 'muted');
    setBadge('badge-fonts', 'warn', 'WARN');
    setResult('Fonts', 'warn', 'Error');
  }
}

// ── Test 14: Network Info ─────────────────────────────────────────────────────
function testNetwork() {
  const body = document.getElementById('net-body');
  let html = '';
  const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (conn) {
    html += row('Effective Type', conn.effectiveType || '?');
    html += row('Type', conn.type || '?');
    html += row('Downlink', conn.downlink !== undefined ? conn.downlink+'Mbps' : '?');
    html += row('Downlink Max', conn.downlinkMax !== undefined ? conn.downlinkMax+'Mbps' : '?');
    html += row('RTT', conn.rtt !== undefined ? conn.rtt+'ms' : '?');
    html += row('Save Data', conn.saveData ? 'Yes' : 'No');
  } else {
    html += row('Network Info API', 'Not available', 'muted');
  }
  html += row('Online', navigator.onLine ? 'Yes' : 'No');
  if (body) body.innerHTML = html;
  setResult('Network', 'info', conn?.effectiveType || 'n/a');
}

// ── Test 15: Battery API ──────────────────────────────────────────────────────
async function testBattery() {
  const body = document.getElementById('battery-body');
  try {
    const bat = await navigator.getBattery();
    let html = '';
    html += row('Charging', bat.charging ? 'Yes' : 'No');
    html += row('Level', Math.round(bat.level * 100)+'%');
    html += row('Charging Time', bat.chargingTime === Infinity ? 'Not charging' : bat.chargingTime+'s');
    html += row('Discharging Time', bat.dischargingTime === Infinity ? '∞' : bat.dischargingTime+'s');
    html += desc('Battery API exposes device state. Real device = realistic values. Headless browser = often 100% charging with constant values.');
    if (body) body.innerHTML = html;
    setBadge('badge-battery', 'info', 'INFO');
  } catch {
    if (body) body.innerHTML = row('Status', 'API not available', 'muted');
    setBadge('badge-battery', 'info', 'N/A');
  }
  setResult('Battery', 'info', 'Done');
}

// ── Test 16: Media Devices ────────────────────────────────────────────────────
async function testMediaDevices() {
  const body = document.getElementById('media-body');
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter(d => d.kind === 'videoinput');
    const mics = devices.filter(d => d.kind === 'audioinput');
    const speakers = devices.filter(d => d.kind === 'audiooutput');
    let html = '';
    html += row('Video Inputs (Cameras)', cams.length || 'None', cams.length ? '' : 'muted');
    html += row('Audio Inputs (Mics)', mics.length || 'None', mics.length ? '' : 'muted');
    html += row('Audio Outputs', speakers.length || 'None', speakers.length ? '' : 'muted');
    cams.forEach((d,i) => { html += row('Camera '+(i+1), d.label || '(label hidden — needs permission)'); });
    mics.forEach((d,i) => { html += row('Mic '+(i+1), d.label || '(label hidden — needs permission)'); });
    html += desc('Real user browsers show camera/mic entries even without permission. Headless browsers often show 0 devices — a fingerprinting signal.');
    if (body) body.innerHTML = html;
    setBadge('badge-media', 'info', 'INFO');
  } catch (e) {
    if (body) body.innerHTML = row('Status', 'API error: '+e.message, 'muted');
    setBadge('badge-media', 'info', 'N/A');
  }
  setResult('Media', 'info', 'Done');
}

// ── Test 17: Permissions ──────────────────────────────────────────────────────
async function testPermissions() {
  const body = document.getElementById('perms-body');
  const permsToCheck = [
    'geolocation','notifications','camera','microphone',
    'clipboard-read','clipboard-write','push','midi','accelerometer',
    'gyroscope','magnetometer','payment-handler',
  ];
  let html = '';
  const results = await Promise.allSettled(
    permsToCheck.map(name => navigator.permissions.query({ name }))
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const state = r.value.state;
      const cls = state === 'granted' ? 'green' : state === 'denied' ? 'muted' : '';
      html += row(permsToCheck[i], state, cls);
    } else {
      html += row(permsToCheck[i], 'n/a', 'muted');
    }
  });
  if (body) body.innerHTML = html;
  setBadge('badge-perms', 'info', 'INFO');
  setResult('Perms', 'info', 'Done');
}

// ── Test 18: Speech Synthesis ─────────────────────────────────────────────────
function testSpeech() {
  const body = document.getElementById('speech-body');
  try {
    const synth = window.speechSynthesis;
    if (!synth) throw new Error('not available');
    const voices = synth.getVoices();
    let html = '';
    html += row('Voices Available', voices.length || '(loading…)');
    if (voices.length > 0) {
      const local = voices.filter(v => v.localService);
      const remote = voices.filter(v => !v.localService);
      html += row('Local Voices', local.length);
      html += row('Remote Voices', remote.length);
      const sample = voices.slice(0,4).map(v => v.name).join(', ');
      html += row('Sample', sample, 'muted');
    }
    html += desc('Speech synthesis voices vary by OS. This is a secondary fingerprinting signal used alongside canvas and audio hashes.');
    if (body) body.innerHTML = html;
  } catch {
    if (body) body.innerHTML = row('Status', 'Not available', 'muted');
  }
  setBadge('badge-speech', 'info', 'INFO');
  setResult('Speech', 'info', 'Done');
}

// ── Test 19: Client Hints ─────────────────────────────────────────────────────
async function testClientHints() {
  const body = document.getElementById('hints-body');
  let html = '';
  try {
    const ua = navigator.userAgentData;
    if (!ua) throw new Error('not available');
    html += row('Brand', ua.brands.map(b => b.brand+' '+b.version).join(', ') || 'n/a');
    html += row('Mobile', ua.mobile ? 'Yes' : 'No');
    html += row('Platform', ua.platform || 'n/a');
    try {
      const high = await ua.getHighEntropyValues(['architecture','bitness','model','platformVersion','uaFullVersion','fullVersionList']);
      html += row('Architecture', high.architecture || 'n/a');
      html += row('Bitness', high.bitness || 'n/a');
      html += row('Platform Version', high.platformVersion || 'n/a');
      html += row('Full UA Version', high.uaFullVersion || 'n/a');
      html += row('Model', high.model || '(desktop)');
    } catch {}
    html += desc('UA Client Hints are a newer fingerprinting vector. They must be consistent with the User Agent string — mismatches are detectable.');
    setBadge('badge-hints', 'info', 'INFO');
  } catch {
    html = row('Status', 'UA Client Hints not available (older Chrome or policy blocked)', 'muted');
    setBadge('badge-hints', 'info', 'N/A');
  }
  if (body) body.innerHTML = html;
  setResult('Hints', 'info', 'Done');
}

// ── Test 20: Timing Precision ─────────────────────────────────────────────────
function testTiming() {
  const body = document.getElementById('perf-body');
  const samples = [];
  for (let i = 0; i < 10; i++) samples.push(performance.now());
  const diffs = samples.slice(1).map((v,i) => v - samples[i]);
  // OLD logic: const minDiff = Math.min(...diffs) — broken because our 0.1ms
  // quantization makes rapid consecutive calls all return the SAME value
  // (they all land in the same 100µs bucket), so minDiff = 0 → falsely reported
  // as "full precision." 0 just means the calls were faster than one quantum.
  // NEW logic: look at the minimum NON-ZERO diff. If all diffs are zero (allSame),
  // the timer is clearly quantized — consecutive calls within one 0.1ms window
  // all returned the same bucket value, which is exactly what real Android Chrome
  // does with timer coarsening active.
  const nonZeroDiffs = diffs.filter(d => d > 0);
  const allSame = nonZeroDiffs.length === 0;
  const minNonZeroDiff = nonZeroDiffs.length > 0 ? Math.min(...nonZeroDiffs) : null;
  // Use 0.099 (not strict 0.1) to absorb IEEE-754 rounding: Math.round(x*10)/10
  // can produce 0.09999...8 instead of exactly 0.1 for certain inputs.
  const precisionReduced = allSame || (minNonZeroDiff !== null && minNonZeroDiff >= 0.099);
  const resolution = allSame
    ? '\u22640.1ms (quantized \u2014 all same bucket)'
    : (minNonZeroDiff !== null && minNonZeroDiff < 0.001)
      ? '<0.001ms (full precision)'
      : (minNonZeroDiff !== null ? minNonZeroDiff.toFixed(4)+'ms' : 'n/a');

  let html = '';
  html += row('Timer Resolution', resolution);
  html += row('performance.now()', samples[0].toFixed(4)+'ms');
  html += row('Date.now()', Date.now()+'ms (Unix)');
  html += row('Precision Reduced', precisionReduced ? 'Yes \u2014 coarsened for privacy' : 'No \u2014 full precision', precisionReduced ? 'green' : 'warn');
  html += desc('High-resolution timers can be used for timing attacks and hardware fingerprinting. Reduced precision (100\u00b5s+) is better for privacy.');
  if (body) body.innerHTML = html;
  setBadge('badge-perf', 'info', 'INFO');
  setResult('Timing', 'info', resolution);
}

// ── Run all ───────────────────────────────────────────────────────────────────
async function runAll() {
  // Reset
  Object.keys(RESULTS).forEach(k => delete RESULTS[k]);
  const hdrDot = document.getElementById('hdr-dot');
  const scorePill = document.getElementById('score-pill');
  if (hdrDot) hdrDot.className = 'dot running';
  if (scorePill) { scorePill.className = 'score-pill pending'; scorePill.textContent = 'Running\u2026'; }
  const summaryBar = document.getElementById('summary-bar');
  if (summaryBar) summaryBar.innerHTML = '';

  const resetBadge = (id) => setBadge(id, 'pending', '');
  ['badge-ip','badge-ipmatch','badge-webrtc','badge-dns','badge-uamatch','badge-bot','badge-fonts','badge-battery','badge-media','badge-perms','badge-hints']
    .forEach(resetBadge);

  // Instant sync tests — each individually guarded so one failure cannot crash
  // the whole runAll() async function and leave subsequent async cards frozen.
  var _syncTests = [
    ['Identity', testIdentity], ['Bot', testBot], ['UAMatch', testUAMatch],
    ['Timezone', testTimezone], ['Navigator', testNavigator], ['Hardware', testHardware],
    ['Canvas', testCanvas], ['WebGL', testWebGL], ['Network', testNetwork],
    ['Speech', testSpeech], ['Timing', testTiming], ['Fonts', testFonts],
  ];
  for (var _si = 0; _si < _syncTests.length; _si++) {
    try { _syncTests[_si][1](); } catch (e) { console.error('[leak-test] sync test "' + _syncTests[_si][0] + '" threw:', e); }
  }

  // Async tests. Wrapped in withTimeout() as a belt-and-suspenders guard:
  // testIP() already has an internal 8s AbortController timeout, but a proxy
  // that accepts a TCP connection and then never completes the 407 handshake
  // can leave the underlying fetch() promise unsettled past that point in
  // some Electron/Chromium builds — which used to hang this ENTIRE sequential
  // chain forever, leaving Battery/Media/Permissions/Client Hints stuck on
  // their initial "PENDING" badge since they're never even called. The outer
  // timeout guarantees runAll() always reaches the later tests.
  await withTimeout(() => testIP(), 12000, 'testIP');
  testIPMatch();  // needs IP result
  testWebRTC();   // async but fire-and-forget (resolved internally)

  await Promise.all([
    withTimeout(() => testDNS(), 12000, 'testDNS'),
    withTimeout(() => testAudio(), 12000, 'testAudio'),
    withTimeout(() => testBattery(), 12000, 'testBattery'),
    withTimeout(() => testMediaDevices(), 12000, 'testMediaDevices'),
    withTimeout(() => testPermissions(), 12000, 'testPermissions'),
    withTimeout(() => testClientHints(), 12000, 'testClientHints'),
  ]);

  // Auto-save snapshot for the account if this leak page is associated with a profile
  if (ACCOUNT && ACCOUNT.profileId) {
    try {
      const snapshot = JSON.stringify({
        capturedAt: new Date().toISOString(),
        results: Object.assign({}, RESULTS),
        proxy: ACCOUNT.proxy ?? null,
        proxyType: ACCOUNT.proxyType ?? null,
        ebUA: ACCOUNT.ebUA ?? null,
        apiUA: ACCOUNT.apiUA ?? null,
      });
      await fetch('/api/profiles/' + ACCOUNT.profileId + '/leak-snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ snapshot }),
      }).catch(() => {});
    } catch {}
  }
  // Signal completion so Puppeteer/Electron silent capture can detect when all tests are done
  try { window._leakTestDone = true; } catch {}
}

window.addEventListener('DOMContentLoaded', runAll);
// Voices load async
window.speechSynthesis?.addEventListener('voiceschanged', () => {
  const body = document.getElementById('speech-body');
  if (body) testSpeech();
});
</script>
</body>
</html>`;
