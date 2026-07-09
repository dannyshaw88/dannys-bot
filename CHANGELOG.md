# Changelog

All notable changes to Equinox are documented here.

---

## [1.1.432] — 2026-07-09

### Mobile Farm — mirror is now a real scrcpy session, not `screenrecord`

**The ask:** v1.1.431 replaced screenshot-polling with `adb exec-out
screenrecord --output-format=h264`, which was a real improvement in framerate
but had a fatal flaw on the hardware actually being used to test this: MIUI
(and other OEM skins) freeze `screenrecord`'s *virtual* display the moment the
keyguard re-engages or the real screen sleeps. The previous release masked
this with a stall-detector that force-restarted `screenrecord` every time it
went silent — which meant the mirror never actually looked "live," it looked
like it kept reverting to screenshots, because it was constantly restarting a
short-lived recording rather than streaming continuously.

**What changed:** the mirror now runs the real `scrcpy` server
(https://github.com/Genymobile/scrcpy) — the same server nearly every phone
farm/emulator dashboard is built on — instead of `screenrecord`. Its capture
path uses Android's native `SurfaceControl`/display APIs against the *real*
display (the same path system screen recording itself uses), so it doesn't
have the virtual-display freeze mode that made the previous approach flaky.

Concretely:
- The official prebuilt `scrcpy-server-v3.1` jar is now vendored in the repo
  (`artifacts/api-server/vendor/`) and copied into the build output — no
  scrcpy installation or root is required on either the host or the phone.
- A new module implements scrcpy's wire protocol directly (no shelling out to
  the scrcpy client binary): pushes the jar to `/data/local/tmp/`, launches it
  via `app_process`, opens the tunneled video + control sockets, and parses
  the one-time device-name/codec/resolution header before treating the rest
  as a continuous raw H.264 Annex-B stream.
- The existing WebCodecs-based frontend decoder is unchanged — scrcpy's
  stream is Annex-B just like `screenrecord`'s was, so the same demuxer
  (`src/lib/h264Stream.ts`) and `<canvas>` pipeline just keep working.
- **Taps and key presses now go through scrcpy's own control socket** instead
  of `adb shell input tap`/`input keyevent`. Scrcpy's touch-injection protocol
  takes the coordinates *plus* the frame size they were computed against and
  scales to real touchscreen pixels on-device, which replaces the old manual
  `wm size`-based rescale hack entirely — that hack was a likely source of
  "taps land slightly off" reports on devices where the mirrored resolution
  didn't exactly match `wm size`.
- If no scrcpy session is active for a device yet, tap/key routes still fall
  back to plain `adb shell` calls, so the on-screen buttons keep working even
  before/without a live mirror connection.

**Not yet verified against physical hardware from this environment** — the
protocol implementation is written against scrcpy's documented, versioned
wire format (confirmed against the exact vendored v3.1 server binary's option
table), but this change needs a real USB-connected phone to confirm frame
delivery and touch accuracy end-to-end.

---

## [1.1.431] — 2026-07-09

### Mobile Farm — real-time H.264 video mirroring (replaces screenshot polling)

**The ask:** the mirror was built on `adb exec-out screencap -p` — one full PNG
capture per frame, 150–400ms each. Even at a 150ms poll interval that's a hard
ceiling on responsiveness that no amount of tuning could remove; the previous
release's notes said as much. Instant, on-the-fly mobile automation needs a
real video stream, not repeated screenshots.

**What changed:** a new `/api/mobile/video/:serial` WebSocket endpoint spawns
the on-device `screenrecord` binary (built into Android since API 19 — no
scrcpy, root, or extra install needed) with `--output-format=h264` and pipes
its raw Annex-B elementary stream straight from `adb exec-out` to the browser,
frame by frame, with no polling loop and no per-frame process spawn. Because
`screenrecord` has a hard ~180s `--time-limit`, the server transparently
respawns it on exit and keeps streaming — the client sees at most a brief gap.

On the frontend, a small Annex-B demuxer (`src/lib/h264Stream.ts`) buffers
incoming bytes, splits them into per-frame access units, and feeds them to the
browser's native WebCodecs `VideoDecoder` (Electron/Chromium have full
hardware-accelerated support). Decoded frames are drawn straight to the
existing mirror `<canvas>`, so tap-mapping, letterboxing, and the nav bar are
unchanged. If WebCodecs isn't available, or `screenrecord` isn't supported on
a given device/Android build, the client automatically falls back to the old
PNG-polling endpoint — nothing regresses on unsupported setups.

This also incidentally removes the old "screen is off or locked" false-asleep
state during normal use: because the video stream keeps flowing continuously
(and the session still disables the screen timeout + sends a wake keyevent on
connect, same as before), there's no more discrete "0-byte capture" signal to
misinterpret as the phone being asleep while it's actually just idle.

**Nav bar buttons now log their attempts:** Back/Home/Recent/Power/Vol+/Vol−
previously fired silently with no confirmation of success or failure. They now
write to the stream log panel exactly like taps already did, so a failed
keyevent (bad serial, adb hiccup, etc.) is visible instead of looking like a
dead button.

## [1.1.430] — 2026-07-09

### Mobile Farm — fixed click mapping, added click logging, faster frame cadence

**Root cause of "nothing is clickable":** the phone screen area was made
flexible (`flex-1`) in 1.1.429 to fix a height-collapse bug, but the canvas
keeps `object-fit: contain`. Once the screen area's box stopped being a
locked 9:16 rectangle, its aspect ratio almost never matches the phone's
real aspect ratio, so the canvas image gets letterboxed inside the box.
Tap coordinates were still being computed against the *full* box
(`getBoundingClientRect()`), not the actual letterboxed image rectangle —
so every tap landed on the wrong on-device pixel. Fixed by computing the
real displayed image rectangle (accounting for the letterbox offset) and
mapping clicks relative to that instead.

**Debug log now captures clicks:** tapping, waking, and their
success/failure are now written to the stream log panel — previously the
log only recorded WebSocket/connection events, so a failed tap left no
trace at all. Clicks that land in letterbox padding (outside the actual
phone image) are also logged instead of silently doing nothing.

**Frame cadence:** the screencap loop's idle delay was lowered from 250ms
to 150ms between frames. Note: the dominant part of the mirror's latency
is the per-frame `adb exec-out screencap -p` capture itself (typically
150–400ms on-device, depending on the phone), which is inherent to using
discrete PNG screenshots rather than a continuous video stream. This
change makes the loop responsive without further scrcpy work.
Truly "instant" (~30fps) mirroring would require switching to a
continuous H.264 stream (e.g. scrcpy, already stubbed as
`/api/mobile/devices/:serial/scrcpy/start`) instead of screencap polling
— worth a follow-up if sub-100ms feedback is required for automation.

---

## [1.1.429] — 2026-07-09

### Mobile Farm — layout split, on-device debug log removed, click-to-wake fixed

**Layout:** the phone slot now sits in the left half of the page at full
available height (aspect-ratio locked to 9:16, capped by whichever of the
half-width or full-height is the tighter constraint). The right half is a
new "Automation Settings" panel — per-device auto-reply toggle, action delay
range, max actions/day, and a free-text notes field. Settings persist
server-side per serial in `mobile-instances.json` via two new endpoints,
`GET/POST /api/mobile/devices/:serial/automation-settings`, following the
same pattern already used for proxy assignment.

**Debug log removed from the phone screen itself:** the always-visible
green-text debug log that used to overlay the bottom ~45% of the phone
canvas is gone. The phone slot now only shows connection/asleep/error
state text; verbose per-frame logging still happens (kept as a no-op-safe
internal log function for future use) but nothing is rendered on the phone
screen anymore.

**Click-to-wake fixed — root cause:** the phone `<canvas>` was rendered with
`display: none` whenever the stream wasn't in the "live" state. When the
screen went to sleep, the server-side auto-wake loop (added in 1.1.428) kept
running, but the client dropped straight to an overlay `<div>` with no click
handler — so a user's tap to help wake the phone was never sent anywhere,
and the visible "waking up" feedback only ever came from the slow ~1s
backend poll. Fixed by: (1) keeping the canvas mounted and clickable in
every state past "connecting", (2) treating server messages matching
"screen is off / locked" as a distinct `asleep` status with its own "tap to
wake" hint instead of the generic error state, (3) sending an immediate
`KEYCODE_WAKEUP` keyevent request on click when not live, instead of
silently dropping the tap, and (4) reducing the backend's off-screen poll
back-off from 1000ms to 400ms so the wake feedback loop feels responsive.

### CI — removed a second, independently-triggered Windows installer workflow

`build-windows.yml` was a real (non-stub) duplicate of the canonical
`build-windows-installer.yml` — different secret names, no
`--ignore-scripts` on install — that also ran on every push to `main`. Two
installer builds racing on every push made "which run actually failed" hard
to diagnose. Deprecated it the same way the three earlier duplicates were
handled: header comment + inert `workflow_call`-only stub, kept in the repo
because deletion of tracked workflow files is blocked in this environment.
`build-windows-installer.yml` remains the single source of truth for the
Windows installer pipeline.

---

## [1.1.428] — 2026-07-09

### Mobile Farm — auto-wake screen + back-off when screen is off

**Problem:** `screencap` returns 0 bytes when the phone screen turns off.  The
old loop treated every 0-byte frame identically to other errors — sending the
same JSON error message to the client every 250 ms (dozens of messages per
second) and never attempting to wake the screen.

**Fix — three changes in the screencap WebSocket handler:**

1. **Disable screen timeout on connect** — immediately after the WS handshake,
   save the current `screen_off_timeout` value then set it to `2147483647` ms
   (~24 days) via `adb shell settings put system screen_off_timeout`.  This
   prevents the phone from sleeping while the mirror is open.  The original
   value is restored in the `ws.on("close")` handler.

2. **Auto-wake on 0 bytes** — when `screencap` returns 0 bytes, send
   `adb shell input keyevent 224` (KEYCODE_WAKEUP) to turn the screen back on.
   The first WAKEUP is also sent immediately on connect so the screen is on
   from the moment the session starts.

3. **Back-off + deduplicated errors** — a `screenOffStreak` counter tracks
   consecutive 0-byte frames.  The loop delays 1 000 ms (instead of 250 ms)
   between attempts while the screen is off, and the client error message is
   sent only once per streak + every 20th iteration (~20 s) rather than on
   every frame.  When a valid PNG comes back, a `{ info: "Screen woke up" }`
   message is sent once and the streak resets.

---

## [1.1.427] — 2026-07-09

### Mobile Farm — fix instant WS disconnect (socket.destroy race) + 1-slot layout

#### Root cause of "WS open → immediately closed code=1006"
`registerInstagramRoutes` registers its own `httpServer.on("upgrade")` listener
**after** the mobile one.  Node EventEmitter calls all listeners in registration
order.  When a `/api/mobile/screen/…` upgrade arrives:

1. Mobile handler runs first → calls `screenWss.handleUpgrade(...)`, takes
   ownership of the socket, starts the screencap loop.
2. Instagram handler runs second → URL doesn't match its patterns → hits the
   catch-all `socket.destroy()` that was written with the comment
   "No other upgrade handlers".  This destroys the socket the mobile WS server
   already owns → client sees `code=1006` (no close frame, TCP reset).

**Fix (two lines):**
- `mobile.ts`: set `(socket as any).__wsHandled = true` before calling
  `handleUpgrade` so the flag is on the socket before the instagram listener runs.
- `instagram.ts`: guard the `socket.destroy()` with
  `if (!(socket as any).__wsHandled)` — if the mobile handler already claimed
  it, skip the destroy entirely.

#### UI: single slot, left side, vertically centred
- `TOTAL_SLOTS` reduced to 1
- Slot container changed from `justify-center` row to `items-center justify-start`
  with `minHeight: calc(100vh - 120px)` so the slot sits vertically centred on
  the left side of the page at a fixed 280 px width

---

## [1.1.426] — 2026-07-09

### Mobile Farm — fix WebSocket port (Electron serves frontend + API on same port)

**Root cause of "WS error readyState=0 / code=1006 / never connects":**

The v1.1.425 build changed `makeWsUrl()` to always connect to
`ws://127.0.0.1:8082/...` (the Replit dev `__API_PORT__`).  In Electron the
API server does NOT run on 8082 — it finds a free port at startup (preferred
32987, falls back to random).  The frontend is served by the same Express
process on that same dynamic port.  So `window.location.host` is
`127.0.0.1:32987` and IS the correct WebSocket target.  Connecting to 8082
failed immediately with ECONNREFUSED, which in the browser WebSocket API
surfaces as `readyState=0` + `code=1006` — exactly what the debug log showed.

**Fix:** `makeWsUrl()` reverted to `window.location.host` (with `ws:`/`wss:`
derived from `window.location.protocol`).  The `__API_PORT__` fallback is kept
only for environments where `window.location.host` is empty.

---

## [1.1.425] — 2026-07-09

### Mobile Farm — 4-slot row, Electron WebSocket fix, visible debug log

#### Layout: 4 slots in a single centred row (was 8 in 4×2 grid)
- `TOTAL_SLOTS` reduced to 4 — one row, slots flex-centred with `justify-center`
- Each slot is `max-w-[260px] flex-1` so they fill available space evenly and
  stay centred at any window width
- Empty slot phone outline and "Slot N" label remain for unoccupied positions

#### Root cause of "never connects" — wrong WebSocket host in Electron
In Electron the frontend is loaded from a local file or internal server.
`window.location.host` is either empty (`""`) or a `localhost:PORT` that points
at the renderer/dev server, **not** the Express API.  The Vite proxy (`ws: true`)
is only present in the Replit dev environment — it is absent in the built Electron
app.  So every WebSocket connection was going to the wrong host and silently
failing before the server ever saw it.

**Fix — `makeWsUrl()` always uses `127.0.0.1:__API_PORT__`:**
```ts
function makeWsUrl(serial: string): string {
  const port = __API_PORT__ || "8082";
  return `ws://127.0.0.1:${port}/api/mobile/screen/${encodeURIComponent(serial)}`;
}
```
`__API_PORT__` is injected by Vite at build time from `process.env.API_PORT`,
so it is always correct regardless of environment.  No dependency on
`window.location.host`.

#### Visible debug log panel inside each slot
Every LiveCanvas now renders a scrollable green-on-black log panel in the
lower half of the slot, showing timestamped events in real time:
- `[N] Connecting → ws://127.0.0.1:8082/api/mobile/screen/…`
- `WS open — waiting for first frame…`
- `SERVER ERROR: <message forwarded from server>`
- `WS closed — code=NNN reason="…"`
- `First frame! (NNNN bytes)`  /  `10s timeout — no frames received`
No dev tools required — the log is visible directly in the running Electron window.

#### Server-side debug logging (mobile.ts)
The WebSocket upgrade handler now emits structured `logger.info/warn/error`
entries at every lifecycle stage so they appear in the Electron log file:
- upgrade URL received + regex match result
- ADB toolset path at connection time
- `adb devices` output at the moment of WS upgrade (shows actual device state)
- Device-not-ready guard: closes WS immediately with a descriptive error message
  if state ≠ `"device"` instead of spawning a silent loop
- Per-frame log (every 1st and then every 20th frame): raw byte count, first 4
  bytes as hex, CRLF-strip applied, valid PNG result, stderr from ADB
- Send errors, spawn errors, loop-end summary

---

## [1.1.424] — 2026-07-09

### Mobile Farm — Inline Phone Slots & Screencap CRLF Fix

#### Problem: screen mirror opened as a full-screen modal instead of inline
"View Screen" replaced the entire Equinox window with a black overlay.
The user couldn't see other slots while a phone was streaming, and the
size (340 px wide modal) made it impossible to fit multiple phones on screen.

**Fix — 8 inline phone slots, always visible:**
The Mobile Farm page now shows a **4 × 2 grid of fixed phone slots** (220 px each),
styled as portrait phone frames. There is no "View Screen" button and no modal overlay.

- **Auto-stream** — as soon as a phone reaches `device` (Ready) state the canvas inside
  its slot starts streaming automatically. No click required.
- **Empty slots** — the remaining slots (up to 8 total) show a faint phone outline SVG
  and a "Slot N" label so the grid always fills the screen.
- **33 % smaller** — slots are 220 px wide (vs the previous 340 px modal), allowing
  four across in the content area at common resolutions.
- **Nav bar per slot** — Back, Home, Recent, Power, Vol+, Vol− appear at the bottom of
  each slot only when a phone is streaming.
- **State labels in slot header** — "Live" (green pulse), "Auth needed" (yellow),
  "Offline" (red), "empty" (dim) — at a glance without opening anything.
- **Setup panels unchanged** — the ADB-not-found and no-phones-detected panels continue
  to appear in the main area below the grid header.

#### Problem: phone screen stays black / keeps reconnecting on Xiaomi
On Windows, `adb exec-out screencap -p` passes binary PNG data through a pseudo-TTY
layer that on some ADB versions converts bare `\n` (0x0A) bytes to `\r\n` (0x0D 0x0A).
Because PNG files contain `\n` bytes inside their zlib-compressed data blocks, this
CRLF insertion corrupts the PNG header and/or the compressed stream — resulting in an
image that cannot be decoded (black canvas), or a PNG that fails the `length > 100` check
and is silently discarded.

**Fix — server-side CRLF stripping + PNG signature validation:**
- New `isPng(buf)` helper — checks the first 4 bytes for the PNG magic number
  (`\x89 P N G`, i.e. `0x89 0x50 0x4E 0x47`). Used as a gate before sending.
- New `stripCrlf(buf)` helper — single-pass O(n) strip using `Buffer.allocUnsafe`
  and direct byte indexing (no JS array push) for efficiency on 5–8 MB frames.
  Returns the original buffer unchanged if no CRLF pairs are found (zero-copy).
- **Detection & application:** after collecting stdout chunks into `frame`, the server
  checks `isPng(frame)`. If the check fails it calls `stripCrlf(frame)` and rechecks.
  Only a validated PNG is sent over the WebSocket. If the frame is still not a valid PNG
  after stripping, a JSON error message is sent to the client instead of silently dropping
  the frame — so the user sees "screencap returned invalid data" rather than an eternally
  blank screen.
- Frame interval bumped from 200 ms to 250 ms to reduce ADB pressure on the phone.

---

## [1.1.423] — 2026-07-09

### Mobile Farm — Phone-Sized Screen Mirror & Reliable Stream Recovery

#### Problem 1: Screen mirror opened full-window instead of phone-sized
The "View Screen" overlay covered the entire Equinox window with a full-screen black
background (CSS `fixed inset-0`). The phone's screen canvas was centred in it but still
filled the available area, which on a wide monitor stretched the portrait phone image
across hundreds of pixels and looked nothing like a phone screen.

**Fix:** The overlay now uses a **phone-shaped panel** — 340 px wide with a rounded
frame (`border-radius: 2.5rem`) — centred over a semi-transparent dimmed backdrop.
The panel is divided into three sections:
- Compact status bar at the top (device name, Android version, fps/status, × close button)
- Phone screen area whose `aspect-ratio` is locked to the phone's native resolution once
  the first frame arrives (default `9/16` while waiting). The canvas fills it at `width: 100%`.
- Android nav buttons in a compact row at the bottom of the panel, matching the phone width.

Clicking anywhere outside the phone panel closes the overlay (same as Escape).

#### Problem 2: "Connecting…" spinner stuck forever with no useful feedback
The previous WebSocket implementation opened a single connection and never recovered if
it failed silently. On Xiaomi devices (and some others), `adb exec-out screencap -p` can
take several seconds to produce the first frame, or the lock screen can cause it to hang
entirely with no error output — leaving the WebSocket open but silent.

**Root causes:**
- No timeout: if the WebSocket connected successfully but ADB never returned a frame,
  `connected` became `true` and the canvas was shown (empty), but if the connection was
  lost before `onopen` fired, `connected` stayed `false` and the spinner ran forever.
- No reconnect: once the WebSocket closed (USB glitch, server restart, ADB hiccup),
  the component stayed dead.

**Fixes:**

1. **Two-phase loading state** — `connected` (WebSocket handshake done) and `hasFrame`
   (at least one PNG frame received) are tracked separately. The UI now shows distinct
   messages for each state:
   - "Connecting to Xiaomi…" — WebSocket not yet open
   - "Waiting for screen…" — WebSocket open but no frame yet
   - `N fps` — live stream running normally

2. **10-second no-frame timeout** — started the moment `ws.onopen` fires. If no binary
   frame arrives within 10 s the user sees: *"No screen data received. Make sure the
   phone is unlocked — screencap doesn't work on the lock screen on some devices."*
   This covers the silent-hang case on Xiaomi/MIUI.

3. **Auto-reconnect loop** — `ws.onclose` schedules a fresh `connect()` call after 2 s,
   so a brief USB disconnect or server hiccup recovers without any user action.

4. **Inline Retry button** — shown in the error state alongside the error message.
   Clicking it closes the stale WebSocket immediately (triggering the reconnect path)
   rather than waiting for the 2-second timer.

5. **Electron host fallback** — the WebSocket URL now falls back to
   `127.0.0.1:${__API_PORT__}` if `window.location.host` is empty, which can happen
   under certain Electron protocol configurations.

---

## [1.1.422] — 2026-07-09

### Mobile Farm — Live In-App Phone Screen Mirror

#### Root cause of "Unexpected token '<', '<!DOCTYPE...' is not valid JSON" error
Every button on the Mobile page (View Screen, Link Instagram account, etc.) was returning
a raw HTML 404 page instead of JSON because `registerMobileRoutes()` was never called
in `src/index.ts`. The function existed but was completely disconnected from the Express
app, so every `/api/mobile/devices/...` request hit the frontend's catch-all 404 handler
and returned the Vite dev HTML page. Calling `r.json()` on that HTML produced the
"Unexpected token '<'" error. Fixed by importing and calling `registerMobileRoutes(httpServer, app)`
in `index.ts` before `registerInstagramRoutes`.

#### Live phone screen streaming (WebSocket, no external tools)
Previous behaviour: "Open screen mirror" spawned an external `scrcpy` process that opened
a separate OS-level window outside of Equinox. If scrcpy was not installed the call threw
and produced the JSON error above (compounded with the missing route registration).

New behaviour: the phone screen is streamed **inside** Equinox with no external tools:

- New WebSocket endpoint `/api/mobile/screen/:serial` registered on the `httpServer`
  upgrade event. On connection the server opens a loop: `adb -s <serial> exec-out screencap -p`
  → collect stdout (raw PNG bytes) → send as a binary WebSocket frame → sleep 200 ms → repeat.
  Runs at approximately 4–5 fps. The loop terminates cleanly when the WebSocket closes.

- New REST endpoint `GET /api/mobile/devices/:serial/screen-size` — runs
  `adb shell wm size` and parses the `WxH` result. Used by the frontend to report
  the phone's native resolution in the overlay header.

- Vite dev-server proxy updated to `ws: true` so WebSocket upgrades on `/api/*` paths
  are correctly forwarded to the API server during development.

#### New "View Screen" UI — full-screen overlay inside Equinox
The small "Open screen mirror" button that launched an external window is replaced by a
**"View Screen"** button on each phone card (only visible when state is `device` / Ready).

Clicking it opens a full-screen dark overlay that covers the entire Equinox window:

- **Live canvas** — binary PNG frames from the WebSocket are decoded via `createObjectURL`
  and drawn onto a `<canvas>` element. The canvas preserves the phone's native aspect ratio
  and scales to fill the available area.

- **Click-to-tap** — a click anywhere on the canvas maps the display coordinates back to
  native phone coordinates using the canvas's `getBoundingClientRect()` and the stored
  natural resolution, then fires `POST /api/mobile/devices/:serial/input/tap` with the
  exact `{x, y}` pixel position. The phone receives a real ADB tap at that location.

- **Android nav buttons** at the bottom bar:
  - Back (KEYCODE 4)
  - Home (KEYCODE 3)
  - Recent apps (KEYCODE 187)
  - Power / lock screen (KEYCODE 26)
  - Volume up (KEYCODE 24)
  - Volume down (KEYCODE 25)
  All send `POST /api/mobile/devices/:serial/input/key`.

- **Keyboard shortcut** — pressing `Escape` closes the overlay.

- **Status bar** — shows phone model, Android version, live FPS counter (updated every second),
  and the phone's native resolution once the first frame arrives.

- **Error states** — if ADB is not found or the WebSocket fails to connect, a clear error
  message is shown inside the overlay rather than a silent blank screen.

#### Files changed
- `artifacts/api-server/src/index.ts` — import + call `registerMobileRoutes`
- `artifacts/api-server/src/routes/mobile.ts` — signature changed to `(httpServer, app)`;
  added `ws`, `spawn`, `execFile` imports; added WebSocket screen-stream handler; added
  `GET /api/mobile/devices/:serial/screen-size` endpoint
- `artifacts/dannys-bot/src/pages/MobilePage.tsx` — rewrote `MirrorButton` → `ScreenMirrorOverlay`;
  added `PhoneCard` mirror state; added `NavBtn` component; added click-to-tap; added
  Escape-key handler; removed dead scrcpy toggle logic
- `artifacts/dannys-bot/vite.config.ts` — `ws: true` on `/api` proxy entry

---

## [1.1.417] — 2026-07-09

### Critical Fix — `navigator.webdriver` returning wrong value from wrong location

The suppressor introduced previously had two bugs that were described in the v1.1.415 changelog as fixed, but were never actually applied to the code:

**Bug 1 — Wrong value (`undefined` instead of `false`)**
Real Chrome always returns `false` for `navigator.webdriver` when not under automation. Returning `undefined` is a value no real browser ever produces — Instagram's JS fingerprinting explicitly distinguishes `true` / `false` / `undefined` and treats `undefined` as a broken suppression attempt. This is arguably worse than returning `true` because `undefined` is a specific signature of a tool that tried and failed to hide itself.

**Bug 2 — Own-property on `navigator` instance instead of `Navigator.prototype`**
In real Chrome, `navigator.webdriver` lives only on `Navigator.prototype`. That means `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` returns `undefined` on a real browser — there is no own-property descriptor on the instance. Our `Object.defineProperty(navigator, 'webdriver', ...)` call created an own-property descriptor on the instance. Anti-bot scripts (including Instagram's) probe this specifically: finding an own descriptor on `navigator` is an independent automation signal even when the returned value is `false`.

**Fix:**
- `delete navigator.webdriver` first (clears any Electron-placed own descriptor)
- `Object.defineProperty(Navigator.prototype, 'webdriver', {get: () => false})` — prototype only, matches real Chrome exactly
- Leak check enhanced: now captures `webdriverOwnDesc` (own-property signal) separately and flags `webdriver !== false` as a distinct leak entry

**Impact:** Every EB session was leaking an unambiguous automation signal on every page load, passively, with no actions required — explaining bans within 30 minutes of login.

---

## [1.1.416] — 2026-07-09

### Security — Equinox Global Leak Fix (EB Environment Hardening)

#### `window.__eq` removed from Instagram's page context

The main EB `BrowserWindow` was loading `ebToolbarPreload.js` as its preload, which calls `contextBridge.exposeInMainWorld("__eq", ...)`. This placed a permanent, named `window.__eq` object on the Instagram page's main world — a branded global that any JavaScript running on the page (including Instagram's own detection scripts) could probe to definitively identify the browser as Equinox.

**What changed:**
- `ebToolbarPreload.js` is now loaded **only** on the toolbar `BrowserView`, which has its own isolated renderer context. The main `BrowserWindow` no longer carries the preload, so Instagram's page world never receives `window.__eq`.
- `'__eq'` added to the `_ELEC` array in `ELECTRON_LEAK_SUPPRESSOR_JS` as a belt-and-suspenders measure: even if `window.__eq` were somehow re-introduced by a future preload misconfiguration, it would be deleted/shadowed before any page script could read it.

**Files:** `artifacts/electron/src/ebManager.ts`

---

#### All `__eq_*` globals and DOM IDs randomized per EB session

`buildPageUtilsJs()` injected a fixed set of global variables and DOM element IDs into every Instagram page it ran on:

| Before (fixed, detectable) | Role |
|---|---|
| `window.__eq_utils_loaded` | Sentinel — prevents double-injection |
| `window.__eq_lastInput` | Last focused `<input>` / `<textarea>` |
| `window.__eq_fill_done` | Auto-fill completion flag |
| `window.__eq_mo` | MutationObserver reference |
| `window.__eq_fill_poll` | Polling interval reference |
| `window.__eq_cookie_tick` | Cookie-banner polling interval |
| `window.__eq_postCkLoginPos` | Login-link click coordinates |
| DOM ID `__eq_tb` | Toolbar padding `<style>` tag |
| DOM ID `__eq-scraping-warn` | Scraping-warning overlay |

Instagram's detection JS (loaded on every page) could probe for any of these fixed names with a simple `typeof window.__eq_lastInput !== 'undefined'` check and instantly fingerprint the session as Equinox-automated.

**What changed:**
- `buildPageUtilsJs()` now accepts a `jsToken` parameter (6-char random alphanumeric string, e.g. `"k4m8rx"`) generated once per EB window open.
- Every `__eq_*` global name and DOM ID bakes the token in: `__eq_utils_loaded` → `__eq${token}_u`, `__eq_lastInput` → `__eq${token}_li`, `__eq_tb` (DOM ID) → `__eq${token}_tb`, etc.
- The token is stored in `EbEntry.jsToken` so that all other `executeJavaScript` calls outside `buildPageUtilsJs` — `typeIntoFocused`, OTP field detection, scraping-warning overlay, tab BrowserViews — look up the correct randomized name from `ebMap`.
- A new session generates a new token, so even if Instagram records global names from one session, they are useless for the next.

**Files:** `artifacts/electron/src/ebManager.ts` — `EbEntry` interface, `buildPageUtilsJs()`, `openEbWindow()`, `typeIntoFocused`, OTP detection, `injectPageUtils`, tab view injection

---

#### `window.__shareOverlaysSaved` renamed to a random key per post

The silent-post Share-button click handler temporarily saved pointer-event state to `window.__shareOverlaysSaved` — another fixed, detectable global name on the post window's page.

**What changed:** A random `spOvlKey` is generated per Share-click attempt (`'__sp' + Math.random().toString(36).slice(2, 8)`). The overlay state is stored and retrieved under this random key for the duration of the CDP click, then deleted.

**Files:** `artifacts/electron/src/ebManager.ts` — silent-post Share click block

---

## [1.1.415] — 2026-07-09

### Added

#### Chrome Version Check — new CHECKS tab card for every account

A new **Chrome Version Check** card appears on the CHECKS tab of every account's detail page. It shows:

- **Browser (EB) Chrome Version** — the Chrome major stored in the account's browser identity vs the current stable release, with a `PASS` / `WARN` / `FAIL` verdict. `WARN` = 1–2 versions behind; `FAIL` = 3+ versions behind (static bot signal on every login).
- **Current Stable Chrome (Live)** — fetched from Google's public Version History API at check time (24 h in-memory cache on the API server, no secrets required). Shows the full version string (e.g. `140.0.7312.45`).
- **Instagram API User-Agent** — confirms the API UA is present. Notes that Chrome version is not embedded in Instagram's private API format (app/SDK version only) so the browser check is the relevant signal.
- **Bump to Current Chrome Now** button — one click rewrites the stored UA to the current stable version and regenerates the account fingerprint. Equivalent to a phone auto-updating Chrome — no re-verify, no status change, no cookie wipe.

**Files:**
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/profiles/:id/chrome-version-check` (structured check endpoint with live Google API fetch + 24 h cache)
- `artifacts/api-server/src/routes/instagram.ts` — `POST /api/profiles/:id/bump-chrome-ua` extended to support `requestCurrentBump: true` (auto-fetches current version and rewrites UA without caller needing to supply it)
- `artifacts/dannys-bot/src/components/ChromeVersionCheck.tsx` — new check component (pass/warn/fail cards, detail expansion, Bump Now button)
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — ChromeVersionCheck added to CHECKS tab alongside ApiLeakCheck, BrowserCheck, HeaderCheck

---

#### Chrome version auto-refreshes at runtime — no more manual bumps

The app now fetches the real current stable Chrome version from Google's public Version History API at startup and every 24 hours. When a new Chrome release ships the app picks it up automatically — no code push, no manual constant bump, no guessing.

**What this solves:** Stale Chrome versions were a static, session-independent bot signal present on every login regardless of IP, proxy, or account history. Discovering this required weeks of ban investigation. The auto-refresh makes it impossible to silently drift stale again.

**How it works:**
- `refreshChromeVersion()` in `ebManager.ts` fetches `versionhistory.googleapis.com` at startup and on a 24 h interval. If a newer major is detected it extends the `CHROME_BUILD_INFO` lookup table with the correct full build number and GREASE brand, then updates `CURRENT_CHROME_MAJOR`.
- GREASE brand uses the real Chromium rotation algorithm: `greaseBrands[floor(major/8) % 8]` across an 8-entry confirmed cycle — future-proof for any upcoming Chrome milestone, not a 3-band approximation.
- Concurrent calls coalesce into a single in-flight request (no duplicate fetches on rapid startup).
- On any network/parse error the existing table is left untouched — silent fallback, never a crash.
- `CURRENT_CHROME_MAJOR` default bumped from `"139"` to `"140"` to match the newest bundled `CHROME_BUILD_INFO` entry (better offline fallback).

---

#### Existing accounts auto-bump Chrome version on next EB open

When an existing account's EB window is opened, its stored Chrome major is compared to `CURRENT_CHROME_MAJOR`. If it's behind, the UA is rewritten to the new version *before* CDP applies it — the entire session (UA string, Client-Hints brands, GREASE, injected fingerprint script) uses the updated version from the first request. The bumped UA is then persisted to the database so Mode-B silent windows (follow/post/DM automation) pick it up on their next run too.

**What this mimics:** Real Android phones auto-update Chrome within days of a release. An account still reporting Chrome 137 in July 2026 when the phone would naturally be on 140+ is a static tell. This closes that gap transparently.

**What it does NOT touch:** `accountStatus`, cookies (`igApiCookies`), device state (`igDeviceState`), or `credentialsDirty`. A Chrome version bump is indistinguishable from normal phone behavior — it must never trigger a re-verify loop.

**Ghost browser** (profileId = -1) and **verifyMode** windows are explicitly excluded: ghost generates a fresh identity each time; verifyMode must not change the UA mid-flow.

**Files:**
- `artifacts/electron/src/ebManager.ts` — `rewriteChromeMajorInUA()`, `pushUABumpToServer()`, bump block inside `openEbWindow()`
- `artifacts/electron/src/ebManager.ts` — `refreshChromeVersion()`, `_GREASE_BRANDS[]`, `_inferGrease()`, startup + interval hook in `startEbIpcServer()`
- `artifacts/api-server/src/routes/instagram.ts` — `POST /api/profiles/:id/bump-chrome-ua` (updates `userAgentEmbedded` + `ebFingerprint` only)

### Fixed

- **Ghost mobile setup GREASE brand** — the hardcoded `"Not_A Brand"` in the ghost browser's `Emulation.setUserAgentOverride` Client-Hints metadata was replaced with `getChromeBuildInfo(CURRENT_CHROME_MAJOR).grease`. The ghost path now uses the same dynamically-correct GREASE as every other EB window.
- **Desktop fallback Chrome UA** — `DESKTOP_BROWSER_UA` in `routes/instagram.ts` updated from `Chrome/139.0.0.0` to `Chrome/140.0.0.0` to match the rest of the UA pool.

---

## [1.1.406] — 2026-07-08

### Added

#### Browser Fingerprint Check — see what Instagram's login JS actually sees inside the EB window

Added a "Browser Fingerprint Check" section to the CHECKS tab (renamed from "API CHECKS"). Runs `executeJavaScript` inside the live Electron browser window and returns structured pass/warn/fail results for the signals Instagram evaluates during the login flow itself — none of which were previously visible in any log.

**Checks run:**
- **Electron Leak** — `window.process`, `window.require`, `window.module`, `window._electron`, `navigator.webdriver` — must all be absent/false; if any are present, Instagram's login JS can definitively identify the browser as Electron
- **Touch Emulation** — `maxTouchPoints` must be ≥1 for a mobile UA; 0 means touch emulation was not applied, so login tap events are typed as keyboard events (bot signal)
- **Platform Spoof** — `navigator.platform` must be Linux-based for an Android UA; "Win32" directly contradicts the mobile UA claim and is a trivial JS detection
- **Chrome Object** — `window.chrome` and `chrome.runtime` must exist and be structured like real Chrome; missing or malformed = fingerprinted as non-Chrome
- **WebGL Renderer** — software renderers (SwiftShader, Mesa, LLVM, Lavapipe) flag as VM/headless to Instagram's fingerprinting pipeline
- **Canvas Noise** — captures a canvas data URL snip; compare across two open account windows to verify noise injection is producing different outputs per-session

**How to use:** Open the browser for an account (click BROWSER tab), then go to CHECKS → Run Browser Check. The window must be live. Results also show the URL the browser is currently on for context.

**Files:**
- `artifacts/electron/src/ebManager.ts` — `GET /eb/browser-check` IPC handler using `webContents.executeJavaScript()`
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/profiles/:id/browser-check` proxy endpoint
- `artifacts/dannys-bot/src/components/BrowserCheck.tsx` — new UI component
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — tab renamed "CHECKS", BrowserCheck added below ApiLeakCheck

---

## [1.1.405] — 2026-07-08

### Added

#### EB Session Proxy Audit — definitive real-time leak detection for every browser session

Built a systematic IP leak logger that fires **before Instagram sees any traffic**, every time an embedded browser session opens. Eliminates guesswork by capturing the actual exit IP the Electron session uses vs the server's real IP, then flagging whether the proxy is routing correctly.

**Root cause of the ban wave:** With 10 accounts banned immediately from login, the two most likely culprits are (a) proxy not routing (browser exits via real server IP, Instagram sees the same IP on every account) and (b) multiple accounts sharing the same exit IP, competing for Instagram's ~3-new-logins-per-IP-per-6-hours quota. Both are now detected and logged automatically.

**How the audit works:**

Every call to `openEbWindow()` in `ebManager.ts` now runs an exit-IP audit immediately after the proxy double-set (STEP-8b), before `loadCookiesFromFile` and before `loadURL`:

1. **Server real IP** — fetched via a raw Node.js `https.get()` call that bypasses all Electron sessions and proxies. This is the IP Instagram would see if the proxy fails.
2. **Browser exit IP** — fetched via `ses.fetch()` (Electron session-scoped), which routes through the configured proxy. This is what Instagram actually sees.
3. **Leak detection** — if both IPs match → proxy is not routing → accounts will be banned. If multiple sessions share the same exit IP → they are competing for Instagram's per-IP login quota.

**Where to find the log:**
- `equinox-debug.log` — search `EB-IP-AUDIT` for a per-account block that shows server IP, browser exit IP, proxy config, and LEAKING: YES/NO
- `[EB:N]` crash-step log — STEP-8b entries show the audit result inline with the session setup sequence

**The audit result is also queryable via API:**

`GET /api/eb-ip-audits` returns the audit map for all sessions opened since last app start. Only populated in Electron mode (EB_IPC_PORT set). The Electron IPC server exposes it at `GET /eb/ip-audits`.

**New frontend page — EB IP AUDIT (sidebar nav item):**

Navigate to `/eb-audit` in the app. Shows:
- **IP Leaks** — count of sessions where exit IP === server real IP (proxy broken)
- **Shared Exit IPs** — count of accounts competing on the same proxy exit IP
- **Per-session table** — account, proxy config, server real IP, browser exit IP, result (OK / LEAK / SHARED IP / check failed)
- **Leak alert** — red banner with exact fix instructions if any session is leaking
- **Shared IP alert** — amber banner explaining the per-IP login quota risk

**Files:**
- `artifacts/electron/src/ebManager.ts` — `import https from "https"`, `EbIpAuditResult` interface, `_ebIpAudits` Map, `_directHttpsGet()` helper, STEP-8b exit-IP audit block (in `openEbWindow`), `GET /eb/ip-audits` IPC route handler
- `artifacts/api-server/src/routes/instagram.ts` — `GET /api/eb-ip-audits` endpoint
- `artifacts/dannys-bot/src/components/EbProxyAudit.tsx` — new audit UI component (summary cards + per-session table + alert banners)
- `artifacts/dannys-bot/src/pages/EbAuditPage.tsx` — page wrapper
- `artifacts/dannys-bot/src/App.tsx` — `/eb-audit` route added
- `artifacts/dannys-bot/src/components/layout/Sidebar.tsx` — "EB IP AUDIT" nav item added

---

## [1.1.404] — 2026-07-08

### Fixed

#### API Checks tab now appears on the correct profile detail page

The API Leak Check tab (introduced in v1.1.403) was wired into `ProfileDetail.tsx` — a legacy component that exists in the codebase but is **not** the file the Wouter router renders for `/profiles/:id`. The router imports and renders `ProfileDetailsPage.tsx`. As a result, the "API Checks" tab was invisible in the running app despite the backend endpoint and frontend component being fully functional.

**Root cause:** Two similarly-named files exist in `src/pages/`:
- `ProfileDetail.tsx` — older/legacy version, not rendered by any active route
- `ProfileDetailsPage.tsx` — the live file, used by `App.tsx`'s route for `/profiles/:id`

The tab import, tab button entry, and `Tabs.Content` panel were all added to the wrong file.

**Fix:** Added the three required changes to `ProfileDetailsPage.tsx`:
1. `import { ApiLeakCheck } from "@/components/ApiLeakCheck"` at the top
2. `{ value: "api-checks", label: "API CHECKS", icon: Shield }` entry in the horizontal tab bar array (alongside ACCOUNT SETTINGS and HUMAN SESSION TOOL)
3. `<Tabs.Content value="api-checks">` panel rendering `<ApiLeakCheck profileId={profile.id} />` after the existing session-log panel

The tab is now visible and functional on every profile's detail page.

**Files:**
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — import, tab button, and content panel added

---

## [1.1.403] — 2026-07-08

### Added

#### API Leak Check — server-side diagnostic for mobile API traffic integrity

New diagnostic tool accessible from the **API Checks** tab on every account's detail page (profile detail → "API Checks"). Runs four checks against the account's proxy and stored device state without opening a browser. Complements the existing browser-based Leak Check page.

**Why this was needed:** The browser Leak Check page works by running real JavaScript inside the embedded browser (canvas fingerprint, WebRTC, IP echo, navigator properties) and comparing results against expectations. For mobile API calls, there is no browser — so the same class of leak has no equivalent test. An audit query ("check all signals for API calls") identified the gap: we could fix specific bugs (v1.1.402 fixed Accept-Language and JA3 per-call), but without an active test there was no way to confirm completeness or catch regressions.

**Endpoint:** `GET /api/profiles/:id/api-leak-check`
**UI:** "API Checks" tab on the profile detail page — click **Run Checks** to execute all four checks on demand. Results display as pass/fail/warn cards with expandable detail rows.

**Check 1 — Proxy IP routing:**
Sends a real HTTPS request through the account's assigned proxy to two independent IP-echo services (ipify.org and Cloudflare's `1.1.1.1/cdn-cgi/trace`). Confirms the exit IP is not leaking through the server's real address. Warns if multiple different exit IPs are returned (split routing). For hostname-based proxies where the host itself is not an IP, the match check is skipped with an explanatory note (rotating/hostname proxies have no fixed exit IP to compare against). Fails if the proxy is unreachable or returns no response.

**Check 2 — Header geo-consistency:**
Geo-resolves the proxy's exit IP (socks5-aware: HTTP proxies use `resolveProxyGeo` direct TCP tunnel; socks5 proxies use a `SocksProxyAgent` fetch to ip-api.com). From the country code, derives:
- `X-IG-App-Locale` / `X-IG-Device-Locale` / `X-IG-Mapped-Locale` — e.g. `en_GB` for a UK proxy
- `Accept-Language` — e.g. `en-GB,en;q=0.9` (via `localeToAcceptLanguage`)
- `X-IG-Timezone-Offset` — UTC offset in seconds derived from the IANA timezone name using `Intl.DateTimeFormat`

These are the exact header values `_buildMobileHeaders()` will actually send on every API call. The check also validates the locale suffix baked into the stored `userAgentApi` string — if the UA locale (`en_IN`) contradicts the proxy's expected locale (`en_GB`), that is flagged as a mismatch (the UA string is sent as-is; the runtime geo lookup corrects the IG headers but not the UA string itself).

**Check 3 — TLS / JA3 fingerprint:**
Makes a live probe through CycleTLS to `api.ipify.org` using the account's proxy and a realistic Instagram Android User-Agent. Confirms:
- CycleTLS (Go subprocess) is initialised and routing correctly — the OkHttp4 Android JA3 is active
- If CycleTLS is down, the check fails immediately with `TLS-BLOCKED` rather than silently falling back to raw OpenSSL (which would expose the server's OpenSSL JA3 — a clear bot fingerprint)
- Reports the two JA3 strings in effect: `OKHTTP4_JA3` for bootstrap/read calls, `CHROME120_JA3` for write calls (friendships/create, media/like, DM)
- Reports the probe exit IP for cross-reference against the Proxy IP check

**Check 4 — Device ID sanity:**
Parses `igDeviceState` from the profile DB row and validates all four persistent device identifiers:
- `uuid` — must be a valid RFC 4122 UUID (any version v1–v5, not v4-only)
- `phone_id` — same
- `device_id` (`android_id`) — must be `android-{16 hex chars}` or a valid UUID
- `igDid` — must be a valid RFC 4122 UUID

Warns if any are missing (account not yet verified or device state cleared), fails if any are malformed. Also checks for duplicate values across the four fields — duplicate IDs create a non-unique device fingerprint detectable as automation.

**Not checked (documented gap, same as before):** `browserProxy.ts`'s preview-fetch handler still hardcodes `en-US` and does not route through the account's proxy — a separate, larger fix.

**Files:**
- `artifacts/api-server/src/routes/instagram.ts` — new `GET /api/profiles/:id/api-leak-check` endpoint (~190 lines)
- `artifacts/api-server/src/instagram/tlsTransport.ts` — `OKHTTP4_JA3` exported (was `const`, now `export const`)
- `artifacts/dannys-bot/src/components/ApiLeakCheck.tsx` — new frontend component (idle → run → 4 cards + summary bar)
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — "API Checks" tab added (note: earlier in this session the tab was mistakenly wired to `ProfileDetail.tsx`, which is not the file the router renders — corrected in v1.1.404)

---

## [1.1.402] — 2026-07-08

### Fixed

#### API-call leak audit: Accept-Language still hardcoded `en-US`, and follow JA3 fingerprint was never actually conditional

Follow-up to the v1.1.400/401 EB browser-leak fixes. The user asked whether the same class of leak existed on the **API side** (plain HTTPS mobile-API calls have no JS, so the `navigator.webdriver` fix does not apply there — but headers/TLS fingerprint are the API-call equivalent of a browser leak). An audit of every outbound mobile-API header found two real gaps:

1. **`Accept-Language` hardcoded to `en-US,en;q=0.9` in 13 call sites** in `instagramWebClient.ts`, while `X-IG-App-Locale` / `X-IG-Device-Locale` / `X-IG-Mapped-Locale` were already correctly derived from the proxy's exit country (`resolveProxyGeo` → `countryToIgLocale`). A UK-proxy account was sending `X-IG-App-Locale: en_GB` alongside `Accept-Language: en-US,en;q=0.9` on every single API call — an internal contradiction visible on literally every request, not just at EB login.

   **Fix:** added a `_acceptLanguage` getter on `InstagramWebClient` that derives the header from `this._locale` via the (now-exported) `localeToAcceptLanguage()` in `browserSession.ts`, and replaced all 13 hardcoded occurrences with `this._acceptLanguage`.

2. **Follow calls (`friendships/create`) always used Chrome 120 JA3, even when a Bearer token (`X-IG-Authorization`) was present.** The existing comment described intent to use Android/OkHttp4 JA3 when a Bearer token is available (matching the Android headers + Bearer token that a real app sends together) and Chrome JA3 only as the no-Bearer fallback — but the code unconditionally passed `ja3Override: CHROME120_JA3`, so authenticated follows still went out as Chrome-TLS + (partially Android) headers, a fingerprint mismatch on exactly the call type most associated with follow-related bans.

   **Fix:** `ja3Override` on the follow call is now `this._deviceAuthorization ? undefined : CHROME120_JA3` — `undefined` falls through to the transport's default `OKHTTP4_JA3` (Android), matching the full Android header set kept when auth is present; `CHROME120_JA3` is used only when auth is absent, matching the Android-header-stripped path already in place for that case.

**Also confirmed correct (no change needed):** `X-IG-Timezone-Offset`, User-Agent/`_fullMobileUA`, `radio_type`, and `phone_id` handling were already consistent with the proxy geo and account UA.

**Three more locale-consistency gaps found while wiring this up, same root cause (a static `en-US` default where a proxy-geo lookup was available but not used):**

- `followChallengeRedirects` (challenge/checkpoint redirect follower — plain HTTPS hops straight to instagram.com over the account's proxy) now resolves Accept-Language from `resolveProxyGeo(proxy.host, proxy.port, ...)` instead of a hardcoded default.
- `createSignupBrowser` (Puppeteer browser used during account signup) now does the same via `opts.proxyHost`.
- `createInstagramAccountViaEBForm` (EB-driven signup form flow) now does the same via its `proxyHost` param.

**Not fixed (out of scope, flagged for follow-up):** `browserProxy.ts`'s `handleBrowserProxy` handler still sends a hardcoded `en-US` Accept-Language and does not route its `fetch()` through the account's assigned proxy at all — a larger, separate gap than a header default.

**Files:** `artifacts/api-server/src/instagram/instagramWebClient.ts` · `artifacts/api-server/src/instagram/browserSession.ts` (exported `localeToAcceptLanguage`)

---

## [1.1.401] — 2026-07-08

### Fixed

#### API UA locale now written to the DB immediately at device-ID assignment time

The previous fix (v1.1.400) only patched the locale in the live EB session — the DB still stored whatever locale was baked into the UA pool entry (e.g. `en_IN` for a Samsung SM-A055F originally registered in India), so the UI always showed the wrong locale and every code path that read `profile.userAgentApi` directly from the DB sent the wrong value.

**Root cause:** The UA pool entries have baked-in locale suffixes from the country where the device model was first registered. Accounts on UK/US proxies were being assigned pool entries with `en_IN`, `de_DE`, etc. — and these were written directly to the DB at two points: Reset Device IDs and account creation.

**Fix — three layers:**

1. **Reset Device IDs handler** (`/api/profiles/:id/reset-device-ids`): after picking the UA from the pool, the profile's assigned proxy is looked up and `resolveProxyGeo` is called. The locale suffix in `userAgentApi` is patched before saving to the DB. The EB fingerprint (`ebFingerprint`) is also regenerated from the locale-correct API UA. Non-fatal: if the proxy is unreachable or unassigned, the pool locale is preserved.

2. **Account creation** (`POST /api/profiles`): if a proxy is assigned at creation time, the auto-selected `userAgentApi` is patched with the proxy locale before the profile row is written.

3. **Session-launch persist (belt-and-suspenders)**: when `getOrCreateSession` resolves the proxy geo (which it already did to set the timezone and Accept-Language), it now also writes the locale-corrected `userAgentApi` back to the DB. This covers accounts that had the wrong locale baked in before this fix — next time their EB opens, the DB is automatically corrected.

**New exports in `browserSession.ts`:** `resolveProxyGeo`, `countryToIgLocale` (previously module-private, now exported so the routes layer can call them directly).

**Files:** `artifacts/api-server/src/routes/instagram.ts` · `artifacts/api-server/src/instagram/browserSession.ts`

---

## [1.1.400] — 2026-07-08

### Fixed

#### `navigator.webdriver` was returning `undefined` instead of `false` — causing bans on EB login with no API calls

**Root cause:** The stealth script in `browserSession.ts` (`applyStealthScripts`) patched `navigator.webdriver` with:
```js
Object.defineProperty(navigator, "webdriver", { get: () => undefined });
```
This violated the spec in two distinct, detectable ways:

1. **Wrong value:** Real non-automated Chrome always returns `false` for `navigator.webdriver`. The spec mandates `false` when automation is not active. Returning `undefined` is a value no real browser ever produces — Instagram's JS fingerprinting distinguishes `undefined` from `false` and treats `undefined` as an automation tell.

2. **Wrong location:** The property was patched as an own property directly on the `navigator` instance, not on `Navigator.prototype`. Real Chrome sets it on the prototype. Anti-bot scripts (and likely Instagram's) call `Object.getOwnPropertyDescriptor(navigator, 'webdriver')` to check whether it is an own-instance property — finding one is an additional, independent automation signal even when the value is falsy.

Both flaws are present in the existing code and either one alone is sufficient to trigger detection. Together they produced an automation fingerprint that fired at page-load time, before any API call, explaining why accounts were banned within 30 minutes of an EB login with zero API activity, and why fresh 4G IPs did not help (the leak is JS-level, not IP-level).

The **Leak Check** page compounded the problem: the `testBot()` function only checked `if (wd)` (truthy), so both `undefined` and `false` showed green. The bug could have been running undetected for any length of time.

**Fix (`browserSession.ts` — `applyStealthScripts`):**
```js
// Step 1: remove any own-instance shadow
try { delete navigator.webdriver; } catch (_) {}
// Step 2: patch Navigator.prototype — spec-correct location, returns false
Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false, configurable: true });
```

**Fix (`leaksPage.ts` — `testBot`):**
- Explicitly checks `wd === false` (not just falsy) — flags `undefined` as red
- Checks `Object.prototype.hasOwnProperty.call(navigator, 'webdriver')` — flags own-instance shadow as red even when the value is false
- Displays a distinct label for each failure mode: `undefined (bad — automation tell)`, `false (own-prop shadow — bad)`, or `false ✓`
- The `isBot` flag now includes `wdBad` (either wrong value or wrong location) so the card correctly shows FLAGGED when the patch is absent or broken

**Files:** `artifacts/api-server/src/instagram/browserSession.ts` · `artifacts/api-server/src/instagram/leaksPage.ts`

---

#### API UA locale and `Accept-Language` header now match proxy exit country

**Root cause:** All API user-agent strings in the UA pool end with a locale suffix (e.g. `; en_US`, `; en_GB`). These were static — the suffix in the pool entry was baked in at pool-authoring time and never updated to reflect the actual proxy country assigned to an account. For UK proxies this meant the API UA claimed `en_US` (a US device) while the IP was clearly UK — a geographic inconsistency Instagram can detect. Similarly, the `Accept-Language` HTTP header was hardcoded to `en-US,en;q=0.9` for all sessions regardless of proxy country.

**Fix:** The existing `resolveProxyTimezone` function (which already calls `ip-api.com` through the proxy to detect the exit-IP timezone) has been extended to also fetch `countryCode` in the same request (`fields=timezone,countryCode`). The function is renamed `resolveProxyGeo` and returns `{ timezone, countryCode }`.

At EB session launch (inside `getOrCreateSession`):
- The country code is mapped to an Instagram locale string (`GB → en_GB`, `US → en_US`, etc.) via a comprehensive `COUNTRY_TO_IG_LOCALE` table covering 40+ countries.
- The locale suffix at the end of the API UA string is replaced in-place via `patchApiUALocale()` — the stored DB value is not mutated; only the live session copy is patched.
- The patched UA is stored in the `Session` context (`session.userAgentApi`) so the automation engine picks it up via `getSessionUserAgentApi(profileId)` when calling `setDeviceInfo`.
- An `Accept-Language` header matching the locale (`en-GB,en;q=0.9` for GB, `en-US,en;q=0.9` for US, etc.) is injected into the Puppeteer page via `setExtraHTTPHeaders` immediately after the stealth scripts are applied.

If the geo lookup fails (proxy unreachable, ip-api.com timeout, etc.) the fallback remains `en-US,en;q=0.9` and the stored API UA locale is left unchanged — fully non-fatal.

**New exports in `browserSession.ts`:**
- `patchApiUALocale(apiUA, locale)` — replaces the locale suffix in an API UA string
- `getSessionUserAgentApi(profileId)` — returns the live session's geo-patched API UA

**Files:** `artifacts/api-server/src/instagram/browserSession.ts` · `artifacts/api-server/src/instagram/automationEngine.ts`

---

## [1.1.399] — 2026-07-08

### Fixed

#### EB browser toolbar "Login" and "2FA" macros used the wrong Tab-key sequence, out of step with Instagram's current login form focus order

**Root cause:** Both the manual "Login" toolbar button (which pastes username/password and submits) and the manual "2FA" toolbar button (which pastes a generated TOTP code and submits) in the embedded browser (EB) had Tab-key counts that no longer matched Instagram's field/focus order:

- **Login macro:** after pasting the username it sent only a single `Tab` before pasting the password (`paste username → Tab → paste password → Tab, Tab → Enter`), skipping over a focusable element between the two fields.
- **2FA macro (toolbar button):** it pasted the code immediately into whatever was focused, with no leading `Tab`s at all, then sent four trailing `Tab`s before `Enter`.
- **2FA macro (inline, automatic continuation right after a login submit):** same missing leading `Tab`s and one extra trailing `Tab` as the toolbar button version.

**Fix:** All three macros now use the corrected sequence:
- **Login:** paste username → `Tab, Tab` → paste password → `Tab, Tab` → `Enter`.
- **2FA (toolbar button and inline auto-continuation):** `Tab, Tab` → paste code → `Tab, Tab, Tab` → `Enter`.

All key events are still dispatched via `Input.dispatchKeyEvent`/`Input.insertText` over CDP (OS-level, `isTrusted = true`) — unchanged from the existing anti-detection approach, only the Tab counts and paste ordering changed.

**File:** `artifacts/electron/src/ebManager.ts` — `case "login"` (`_cdpFillLogin` username→password Tab step, inline 2FA continuation) and `case "totp"` (2FA toolbar button macro)

---

## [1.1.398] — 2026-07-08

### Changed

#### Verify Account: Phase 0 anonymous pre-auth calls removed — verify sequence now starts directly with the live session

**Background:** The cold-start verify sequence previously opened with three calls fired against a clean (cookie-free) HTTP client before the session cookie was ever injected:

1. `GET /api/v1/zr/token/result/` — anonymous zero-rating probe (GetTokenResult)
2. `POST /api/v1/launcher/sync/` — anonymous device config download, no `_uid` (SendMobileConfig)
3. `GET /api/v1/zr/token/result/` — second zero-rating probe immediately after launcher/sync

These calls were modelled on the Jarvee cold-start flow, which starts from zero — no cookies, no session, performing an anonymous device probe before ever loading credentials. In that context the Phase 0 sequence makes sense: Instagram sees a clean device handshake rather than a direct cookie injection.

**Why they are wrong for this app:** Every account in Equinox goes through the embedded browser (EB) login flow first, which harvests `sessionid`, `csrftoken`, `ds_user_id`, `mid`, and `ig_did` directly from Chrome's cookie jar. By the time `verifyInstagramCredentials` is called on the cookie-restore path, a live session already exists — there is no cold-start condition to simulate. Firing three anonymous calls against a device that already has an active session is unnecessary extra API surface, adds latency (the anonymous `launcher/sync` had a 20-second hard cap to prevent slow-proxy hangs), and contributes nothing to session health or bearer-token capture.

**Fix:** Phase 0a, 0b, and 0c removed entirely from the cookie-restore path. The sequence now begins at Phase 1.

**New verify sequence (cookie-restore path):**

| Step | Call | Purpose |
|------|------|---------|
| Phase 1 | Load session cookie | Inject `sessionid` + all EB cookies into mobile API client |
| Phase 1.5 | `POST /api/v1/launcher/sync/` with `_uid` | Authenticated config download — the only launcher/sync call needed; Instagram issues Bearer token here |
| Phase 2a | `POST /api/v1/accounts/get_account_family/` | Session confirmation probe |
| Phase 2b | `POST /api/v1/qe/sync/` (bare, unsigned) | ABD (Automated Behaviour Detected) probe |
| Phase 2c | `POST /api/v1/qe/sync/` (FetchConfig) + `POST /api/v1/banyan/banyan/` | Config + Banyan (shuffled order) |
| Phase 2d | Random endpoint pool | API-throttled additional probes per account settings |

**Before:** 7 API calls (GetTokenResult × 2, SendMobileConfig × 2, GetAccountFamily, FetchConfig, Banyan)
**After:** 4 API calls (SendMobileConfig × 1, GetAccountFamily, FetchConfig, Banyan) + Phase 2d pool

The 20-second hard cap on anonymous `launcher/sync` is also gone — it existed solely to prevent the anonymous Phase 0b call from starving the rest of the sequence on high-latency proxies. The authenticated Phase 1.5 `launcher/sync` is governed by `loginApiThrottle` (the account's API Control settings) like every other Phase 1.5+ call.

**File:** `artifacts/api-server/src/instagram/instagramLogin.ts` — `verifyInstagramCredentials`, cookie-restore path (Phase 0a/0b/0c block removed)

---

### Fixed

#### BrowserPanel: Leak Check, AI Selfie, and Upload to Instagram used hardcoded port `:8080` to construct API origin — broken in any environment where API runs on a different port

**Root cause:** Three actions inside `BrowserPanel.tsx` constructed absolute API origins with a hardcoded fallback port of `:8080`:

```ts
const apiOrigin = port === "5000"
  ? `${protocol}//${hostname}:8080`
  : `${protocol}//${hostname}${port ? `:${port}` : ""}`;
```

The API server runs on port `8082` in all configured workflows. Any `fetch` call or Puppeteer navigation URL built from this expression was targeting the wrong port, causing connection refused on all three actions.

The three affected actions:
- **Leak Check** — constructs a URL and sends it to Puppeteer via `send({ type: "navigate", url })` for in-browser leak testing
- **Generate AI Selfie** — `POST /api/ai/generate-selfie` called via `fetch`
- **Upload to Instagram** — `POST /api/browser/{profileId}/files` called via `fetch`

**Fix — fetch calls (AI Selfie, Upload):** Replaced the absolute-origin construction with relative `/api/...` URLs. These calls are made by the browser, go through Vite's reverse proxy (`/api → localhost:${API_PORT}`), and have always been port-agnostic when expressed as relative paths. No origin construction needed at all.

**Fix — Puppeteer navigation (Leak Check):** A relative URL cannot be used here because `send({ type: "navigate" })` is forwarded server-side to Puppeteer's `page.goto()`, which requires an absolute URL (a relative URL would resolve against whatever page the embedded browser is currently on — e.g. Instagram). The API port is now injected at Vite build time as `__API_PORT__` via `vite.config.ts`'s `define` block, and the Leak Check URL is constructed as:

```ts
const apiOrigin = `${protocol}//${hostname}:${__API_PORT__}`;
const url = `${apiOrigin}/api/browser/leaks?profileId=${profileId}`;
```

This correctly resolves to the API server's port regardless of which workflow is running.

**Files:**
- `artifacts/dannys-bot/src/components/BrowserPanel.tsx` — Leak Check, AI Selfie generate, Upload to Instagram
- `artifacts/dannys-bot/vite.config.ts` — `define: { __API_PORT__: JSON.stringify(apiPort) }`
- `artifacts/dannys-bot/src/vite-env.d.ts` — `declare const __API_PORT__: string` (TypeScript declaration)

---

#### dannys-bot `package.json` scripts used a pinned pnpm store absolute path for Vite — broken after any lockfile update or reinstall

**Root cause:** The `dev`, `build`, and `serve` scripts in `artifacts/dannys-bot/package.json` called Vite via a fully-expanded pnpm content-addressable store path:

```
node ../../node_modules/.pnpm/vite@7.3.2_@types+node@25.3.5_jiti@2.6.1_lightningcss@1.31.1_tsx@4.21.0_yaml@2.8.4/node_modules/vite/bin/vite.js
```

This path encodes the exact resolved dependency graph metadata of the entire `node_modules/.pnpm` tree. Any change to a transitive dependency version (even in an unrelated package) regenerates the pnpm store layout and invalidates the path, causing `Cannot find module` on the next cold start — exactly the failure mode observed after the project was imported to Replit with no `node_modules`.

**Fix:** Replaced with the canonical `vite` bin invocation, which pnpm resolves correctly from `node_modules/.bin` regardless of the underlying store layout:

```json
"dev": "vite --config vite.config.ts --host 0.0.0.0"
```

**File:** `artifacts/dannys-bot/package.json`

---

## [1.1.397] — 2026-07-08

### Fixed

#### DM inbox permanently returning 4415001 "Prompt has contribution" even on accounts with empty DM inboxes and no pending prompts

**Root cause:** All `direct_v2/inbox` and `direct_v2/threads` calls were routed through `mobileSessionGet`, which targets `i.instagram.com` using the mobile API cookie jar (`mobileCookieJar`). Instagram's `i.instagram.com` mobile API applies a device-level DM registration gate: accounts whose `ig_did` has not been through Instagram's native mobile DM onboarding flow return 4415001 "Prompt has contribution" on `direct_v2/inbox`, even when the session is fully valid and the EB (embedded browser) can access DMs without any issue. This is identical in nature to the follow/repost `i.instagram.com` vs `www.instagram.com` host mismatch fixed in earlier versions — the mobile API path is stricter about unregistered device IDs for DM-specific endpoints, while the web session path bypasses the device-registration gate entirely.

The bug was confirmed by observing that:
- `GET /api/v1/users/{uid}/info/` via `mobileSessionGet` → HTTP 200 ✓
- `GET /api/v1/news/inbox/` via `mobileSessionGet` → HTTP 200 ✓
- `GET /api/v1/direct_v2/inbox/` via `mobileSessionGet` → HTTP 400, 4415001 ✗
- DM inbox in the EB (instagram.com/direct/inbox/) → fully accessible, empty, zero prompts ✓

All three API calls used identical cookies, headers, and proxy. The gate is endpoint-specific and device-identity-specific, not session-specific.

**Fix:** All `direct_v2/inbox` and `direct_v2/threads` fetches now check `this.isLoggedIn` (web EB session present in `cookieJar`) and route through `webGet` (`www.instagram.com` + EB web cookies) when a web session is available, falling back to `mobileSessionGet` only when no web session exists. This is the same pattern used by `_followViaWebEndpoint` and `_configureViaWebEndpoint`.

**Call sites updated:**
- `getDirectMessages()` — simple inbox check used by the EB-only DM emulation path
- `getDirectMessagesInternal()` Step 2 (inbox overview fetch) and Step 3 (individual thread opens)
- `getDMThreadsWithContent()` — full inbox fetch used by the auto-reply scanner
- `shareStoryViaDm()` — inbox fetch used to find an existing thread to share a story into
- `getThreadIdWithUser()` inbox scan — fallback thread-ID lookup after `get_by_participants`

**Result confirmed in log:** `[webClient] getDirectMessagesInternal: Step 2 — webGet (www.instagram.com)` → `inbox OK — 0 thread(s)` — no gate, no 4415001.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `getDirectMessages`, `getDirectMessagesInternal`, `getDMThreadsWithContent`, `shareStoryViaDm`, `getThreadIdWithUser`

---

#### `persistentBadging=true` query parameter removed from all `direct_v2/inbox` URLs

**Reason:** The `persistentBadging=true` parameter explicitly asks Instagram to evaluate whether any interactive "contribution" is pending for the DM feature and return 4415001 if so. Removed from all six call sites as a secondary hygiene fix. The primary fix (host switch above) is what resolved the gate; this removal prevents any future regression where the parameter re-triggers the gate even on accounts where the web session is unavailable.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts`

---

#### Phase 2a `users/{uid}/info` warm-up added to `_buildWarmedIgClient` before `news/inbox`

**Context:** The documented Jarvee Phase 2 warm-up sequence for DM access is `user.info → news.inbox`. The implementation only called `news/inbox`. Added `GET /api/v1/users/{uid}/info/` via `mobileSessionGet` as Phase 2a immediately before the Phase 2b `news/inbox` call, matching the documented spec. Error handling: propagate if `logoutReason` is present (real session kill), swallow all other errors non-fatally. An explicit warning is logged when `ownUserId` is unavailable and Phase 2a must be skipped. Note: this warm-up change did not resolve the 4415001 gate (that required the host switch above), but it correctly implements the documented sequence for completeness.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_buildWarmedIgClient`

---

#### Vite dev server API proxy target hardcoded to port 8080 instead of reading from environment

**Root cause:** `artifacts/dannys-bot/vite.config.ts` hardcoded the API reverse-proxy target as `http://localhost:8080`, but the API server runs on port 8082. The frontend's `/api/` requests were being proxied to the wrong port in development, causing all API calls from the Vite dev server to fail with connection refused.

**Fix:** Proxy target now reads from the `API_PORT` environment variable (default `8082`): `` `http://localhost:${process.env.API_PORT ?? 8082}` ``.

**File:** `artifacts/dannys-bot/vite.config.ts`

---

#### `.replit` legacy workflow port alignment

**Fix:** Updated the pre-existing hand-configured "API Server" and "Start application" workflow run commands in `.replit` to use `PORT=8082` and `PORT=5000 API_PORT=8082` respectively, matching the port contract established by the API server's actual binding.

**File:** `.replit`

---

## [1.1.396] — 2026-07-08

### Fixed

#### Duplicate live automation engine — Replit auto-added a second "API Server" workflow that ran a full second `AutomationEngine` against the same live Instagram account concurrently

**Root cause:** The platform auto-registered artifacts for the project, which created its own managed workflow (`artifacts/api-server: API Server`) running the exact same `pnpm --filter @workspace/api-server run dev` script as the pre-existing hand-configured `API Server` workflow. Both processes ran independent `AutomationEngine` instances polling and mutating the same live `@miguelsilvayq84` Instagram session at once — a genuine concurrent-session ban risk, not just wasted compute. The two processes also had different `process.cwd()` values, so each wrote to its own separate `database.db` file, but almost certainly shared the underlying session/cookie state on disk, compounding the race. `removeWorkflow` cannot remove artifact-managed workflows, so the duplicate could not simply be deleted — it had to be neutralized at the code level.

**Fix:** Added a cross-process single-instance lock to `AutomationEngine`:
- Atomic acquire via `fs.link()` (test-and-set) against a lock file in `os.tmpdir()` (not `process.cwd()`-relative, since the two duplicate processes have different working directories but share the same container filesystem).
- Stale-lock takeover after 30s of no renewal, so a crashed owner never permanently starves the other process.
- Periodic renewal every 10s with token verification, so a process that loses the lock notices within one renewal cycle and stops its automation loops (`reconcile()`/`restoreResumingAccounts()` intervals).
- Graceful lock release on `SIGTERM`/`SIGINT`/`exit`, so a normal workflow restart hands the lock to the new process immediately instead of making it wait out the full 30s staleness window.
- `reconcile()` itself now checks lock ownership and no-ops if this process is not the owner — closing a gap where a manual UI action (e.g. toggling a tool on) could otherwise trigger `reconcile()` on the non-owner process and launch a duplicate runner even though its periodic loop was stopped.

The losing process now serves HTTP only (still fully functional for reads/dashboard) and never touches the live Instagram session.

**Files:** `artifacts/api-server/src/instagram/automationEngine.ts` — new lock fields/methods (`LOCK_PATH`, `_tryAcquireOrTakeover`, `_renewLock`, `_startLoops`, `_stopLoops`, `_releaseLockSync`, `_beginAcquireLoop`), rewritten `start()`, lock guard added to `reconcile()`.

---

#### CycleTLS sidecar crash-loop when two API server processes run at once — both hard-coded to the same fixed port 9119

**Root cause:** Each `AutomationEngine` process spawns its own CycleTLS Go sidecar for TLS/JA3 fingerprinting, and the library defaults to a fixed port (9119). With two API server processes running (see above), the second one to start always crash-looped with `bind: address already in use`.

**Fix:** Added `findFreeTcpPort()` in `tlsTransport.ts` — binds a throwaway socket to port 0, reads back the OS-assigned free port, then passes `{ port }` into `initCycleTLS()`. Each process now gets its own free port at startup instead of racing for a shared fixed one.

**File:** `artifacts/api-server/src/instagram/tlsTransport.ts`

---

#### DM check silently masked real session kills as a soft "gated" skip instead of surfacing them as session-expired

**Root cause:** `_buildWarmedIgClient()`'s warm-up step (`news/inbox` call) classified errors using `isNetworkErr = !e?.response`, under the documented assumption that `mobileSessionGet()` "returns null on Instagram-level 4xx errors, throws only on network failure." That assumption no longer matched the actual implementation: `mobileSessionGet()` throws on **every** HTTP status ≥ 400, including genuine session-kill responses (HTTP 403 with `logout_reason`), and its thrown errors never carried a `.response` property. As a result, `isNetworkErr` was always `true`, so every real session kill fell through to a `currentUser()` fallback. That fallback had its own bug — it only checked `cuJ !== null`, not the response body's `status` field — so a `200 OK` response carrying `{status:"fail"}` (a genuine Instagram-level rejection, observed live) was incorrectly read as a successful warm-up. Net effect: a dead session was reported as "warmed up," the actual `direct_v2/inbox/` call then failed with an unrelated `4415001` error, and that got mislabeled as a soft, skippable "gate" — completely hiding the real session-expiry root cause from account-health monitoring.

**Fix:**
- `mobileSessionGet()` now attaches structured `.httpStatus` and `.logoutReason` metadata to every thrown error, so callers can reliably tell "Instagram responded with a real HTTP status" apart from a genuine transport/network failure.
- `_buildWarmedIgClient()`'s catch block now classifies on that metadata: a real `logoutReason` is treated as a genuine session kill and rethrown immediately (propagating as `session_expired`, which the existing `checkSessionErr`/`applyAccountLevelError` pipeline already handles correctly) instead of being papered over by the `currentUser()` fallback; only a truly response-less error (no `.httpStatus` at all) triggers that fallback; any other real HTTP error (e.g. `4415001`) is still treated as "connected, warm" as before.
- The `currentUser()` fallback now also requires `cuJ?.status !== "fail"` before considering the warm-up successful.
- `_sendDmViaIgClient()` now catches a session-kill throw from the warm-up step and returns its existing `"session_expired"` sentinel instead of letting the error propagate uncaught.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `mobileSessionGet`, `_buildWarmedIgClient`, `_sendDmViaIgClient`

---

## [1.1.395] — 2026-07-08

### Fixed

#### Make-a-Post / Repost: configure failing with "something went wrong during media publish" — same root cause as follow fix (no Bearer token, HMAC-signed Android body)

**Root cause:** Identical to the follow issue fixed in v1.1.393. `_configureViaIgClient` sends an HMAC-signed Android body to `i.instagram.com/api/v1/media/configure/`. When no Bearer token is present, Instagram returns HTTP 500 `{"status":"fail","message":"We're sorry, but something went wrong during media publish. Please try again."}`. The signed body contains `device_id: android-…`, `_uid`, `_uuid`, Android device fields — the same Android-identity contradiction that triggers the Bearer gate on the follow endpoint.

The rupload step succeeds without Bearer (it's a binary upload, not an identity-sensitive write action). Only configure requires Bearer because it is the write action that commits the media to the account.

**Fix:** Added `_configureViaWebEndpoint` — a direct mirror of `_followViaWebEndpoint`. When `_configureViaIgClient` returns null with a "something went wrong" error and `_deviceAuthorization` is absent (auth=MISSING), the configure is retried via:

- `POST www.instagram.com/api/v1/media/configure/`
- Plain unsigned URL-encoded body: `upload_id={id}&caption={caption}&source_type=4`
- Uses `webPost` — EB web cookies (`cookieJar`), `X-CSRFToken`, Chrome UA
- No HMAC signature, no Android device fields
- Instagram's infrastructure shares upload state across `i.` and `www.` subdomains when a valid web `sessionid` is present

On success returns `media.id` (or `uploadId` when response is `{"status":"ok"}` without an id field). Full error handling: checkpoint, challenge, feedback_required, login_required all mapped to appropriate `_lastConfigureError` values.

The mobile-first path is fully preserved — accounts with a valid Bearer token use the signed Android path and never touch the fallback. The web fallback fires only on the specific failure + no-auth combination, matching the follow pattern exactly.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — new `_configureViaWebEndpoint` method + hook in `runAttempt`

---

## [1.1.394] — 2026-07-08

### Fixed

#### API call export: operation wrappers (FollowedUser, LikeMedia, ViewStories, etc.) incorrectly showed transport "JA3" instead of "Equinox"

**Root cause:** The `setLogger` callback in `automationEngine.ts` hardcoded `transport: "ja3"` for every entry written to `instagram_api_calls`, regardless of whether the log row originated from a real HTTP hit to Instagram's servers or from a high-level operation wrapper tracked by `timed()`.

Two distinct code paths both call `logCallFn`:

- **`_logTransport()`** — fires once per real outbound HTTP request (e.g. `FriendshipsCreate`, `MediaLike`, `HashtagScrape`). These are genuine network hits to Instagram and correctly carry `transport: "ja3"`.
- **`timed()`** — fires once per named operation block (e.g. `FollowedUser`, `LikeMedia`, `ViewStories`, `ViewHighlights`, `ViewReels`, `VisitNotifications`, `VisitOwnProfile`, `Login`). These are internal bookkeeping rows — no direct HTTP call is made at this level; the actual HTTP calls are already logged by `_logTransport()` inside the same block.

Because both paths used the same `transport: "ja3"` value, the API call export (Excel/CSV) showed `FollowedUser` with `transport=JA3`, which is misleading — `FollowedUser` is an internal Equinox event, not a network request to Instagram.

**Fix:** Added a fifth parameter `isTransportCall?: boolean` to the `ApiCallLogger` type. `_logTransport()` passes `true`; `timed()` does not (defaults to `undefined`/falsy). The `setLogger` callback now evaluates:

```
transport: isTransportCall ? "ja3" : "Equinox"
```

**Result in the export:**
- `FriendshipsCreate`, `WebFriendshipsFollow`, `MediaLike`, `HashtagScrape`, etc. → `transport: JA3` ✓
- `FollowedUser`, `LikeMedia`, `ViewStories`, `ViewHighlights`, `ViewReels`, `VisitNotifications`, `VisitOwnProfile`, `Login`, `MobileLogin`, etc. → `transport: Equinox` ✓

**Files:**
- `artifacts/api-server/src/instagram/instagramWebClient.ts` — `ApiCallLogger` type signature + `_logTransport` call site
- `artifacts/api-server/src/instagram/automationEngine.ts` — `setLogger` callback

---

#### `_followViaWebEndpoint`: `status:"ok"` catch-all now logs a warning before optimistic return

When `www.instagram.com/api/v1/friendships/create/{userId}/` returns `{"status":"ok"}` without any of the expected follow-state fields (`friendship_status`, `result`, `following`, `outgoing_request`), the code previously returned success silently. A `console.warn` is now emitted so any unexpected edge-case responses are visible in the debug log for tightening later.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaWebEndpoint`

---

#### `human-session/run-now` endpoint: reverted

A `POST /api/profiles/:profileId/tools/human-session/run-now` endpoint was added during v1.1.393 debugging to wake the HS runner for accounts where the standalone follow runner is permanently blocked. This was reverted — the HS tool structure is by design and the endpoint was not part of the agreed-upon fix scope.

**File:** `artifacts/api-server/src/routes/instagram.ts`

---

## [1.1.393] — 2026-07-07

### Fixed

#### Follow failing with "something went wrong" — Android HMAC-signed body triggers Bearer gate regardless of headers

**Root cause (confirmed from WIRE log):** v1.1.392 stripped all Android-specific HTTP headers when the Bearer token was absent, but the HMAC-signed request body sent to `i.instagram.com/api/v1/friendships/create/{userId}/` is irrevocably Android-native in format:

```
device_id=android-a9490ca72c983130&radio_type=wifi-none&nav_chain=com.bloks.www.ig.na.home:…
```

Instagram verifies the HMAC signature and parses the body. Seeing `device_id: android-…` and `radio_type: wifi-none` in the payload (regardless of what headers accompany it) causes it to treat the request as originating from the Android app — which Instagram gates behind a `Authorization: Bearer IGT:2:…` token. The header stripping in v1.1.392 was necessary but not sufficient: the body itself carries the Android identity.

**Fix:** `_followViaMobileSession` now includes a web-endpoint fallback. When the mobile API returns `{"status":"fail","message":"We're sorry, but something went wrong"}` **and** no Bearer token is present (`auth=MISSING`) **and** the account has a valid EB web session (`cookieJar` contains a `sessionid` cookie), the follow is retried via `_followViaWebEndpoint`:

- Hits `POST www.instagram.com/api/v1/friendships/create/{userId}/`
- Body: plain `user_id={userId}` — **no HMAC signature**, no Android fields
- Uses `webPost` — plain `WEB_UA` (Chrome), `cookieJar` (EB web cookies), `X-CSRFToken` header
- Instagram accepts this as a normal web-app follow and does **not** apply the Bearer-token gate
- Returns `{"friendship_status":{"following":true,...},"status":"ok"}` on success

The mobile-first path is fully preserved: `_bootstrapWwwClaim` still runs before every follow attempt, so accounts that can recover a Bearer token (fresh EB login → cold-start sequence) will use the mobile path successfully. The web fallback only fires on the specific failure + no-auth combination.

**When auth IS present:** all existing behaviour is unchanged — the signed Android body + all Android headers + Bearer token is the correct payload for a fully verified account.

**Also added:** `POST /api/profiles/:profileId/tools/human-session/run-now` API endpoint that calls `triggerHumanSession`. For HS-managed accounts the standalone follow runner is permanently blocked (follows run inside the HS queue), so the existing follow `run-now` endpoint had no effect — this endpoint wakes the HS runner within 1 second instead.

**Files:**
- `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaMobileSession` status=fail branch + new `_followViaWebEndpoint` method
- `artifacts/api-server/src/routes/instagram.ts` — new `human-session/run-now` endpoint

---

## [1.1.392] — 2026-07-07

### Fixed

#### Follow failing with "something went wrong" — Chrome JA3 + Android headers contradiction triggers Bearer gate

**Root cause (confirmed from WIRE log):** The no-Bearer Chrome-JA3 follow path was only stripping two Android headers (`X-IG-WWW-Claim: "0"` and `X-FB-HTTP-Engine: Liger`) but leaving five more Android-specific headers in the request:

- `X-IG-Android-ID: android-<deviceId>` — Android device ID (Chrome never sends this)
- `X-Bloks-Version-Id: ce555e5500…` — Android Bloks framework version
- `X-Bloks-Is-Layout-RTL: false` — Android Bloks RTL flag
- `X-Pigeon-Session-Id: <uuid>` — Android/app session tracker
- `X-Pigeon-Rawclienttime: <timestamp>` — Android app timing metric

Instagram checks **both** the TLS JA3 fingerprint AND the HTTP headers when deciding whether to apply the Bearer-token gate. Sending Chrome 120 JA3 with Android HTTP headers is a detectable contradiction — Instagram applies the Bearer gate anyway, returning `HTTP 200 {"message":"We're sorry, but something went wrong","status":"fail"}`.

The account was not follow-blocked. The session cookies (`sessionid`) were valid — Phase 2e `users/{id}/info` returned HTTP 200 with the real user object. The only issue was the missing Bearer token, which caused Instagram to reject the write action.

**Fix:** When `auth=MISSING` (no Bearer token in `igDeviceState`), strip ALL headers that identify the client as Android — not just the two that were already stripped. The full stripped set is now:
- `X-IG-WWW-Claim: "0"` (was already stripped)
- `X-FB-HTTP-Engine: Liger` (was already stripped)
- `X-IG-Android-ID` ← **new**
- `X-Bloks-Version-Id` ← **new**
- `X-Bloks-Is-Layout-RTL` ← **new**
- `X-Pigeon-Session-Id` ← **new**
- `X-Pigeon-Rawclienttime` ← **new**

When `Authorization: Bearer IGT:2:…` IS present, all headers are kept — real Android app v431+ sends the full set together with the Bearer token on every authenticated call.

**File:** `artifacts/api-server/src/instagram/instagramWebClient.ts` — `_followViaMobileSession`, no-Bearer header stripping block (~line 2354)

---

## [1.1.391] — 2026-07-07

### Fixed

#### Follow failing with "BLOCKED / api_error: something went wrong" — missing Authorization Bearer token after all bootstrap phases

**Root cause:** When an account's EB session had expired (stale or never fully bootstrapped cookies), every bootstrap phase in `_bootstrapWwwClaim` (2a `get_account_family` → 2b `qe/sync` → 2c `banyan/banyan` → 2c' `launcher/sync` → 2d multi-probe → 2e `igReq` direct) returned `claim=none, auth=none`. Instagram app v431+ requires the `Authorization: Bearer IGT:2:…` header on every `friendships/create` write call — without it, the server returns HTTP 200 `{"message":"We're sorry, but something went wrong","status":"fail"}`, which the code correctly catches but labels as `follow_blocked`, making it look like the account is action-blocked when it isn't at all.

**Why Bootstrap phases returned no tokens:** The account's session was stale — the stored `igApiCookies` had either expired or the session had never gone through a complete EB-first cold-start that includes the `ig-set-authorization` token exchange. All bootstrap phases ran against a dead session and received no `ig-set-www-claim` or `ig-set-authorization` response headers.

**The fix the agent applied for the affected account:** Forced a manual re-verify through the EB (open browser → fresh EB login → full Jarvee cold-start sequence → `ig-set-authorization` Bearer token written to `igDeviceState`). After re-verify, `auth=present` appears in the follow log and follows go through correctly.

#### Stage Bootstrap re-schedules manual Verify — re-verify now always runs immediately

**Root cause (the harder problem):** The `POST /api/profiles/:id/verify` route contained a `stageBootstrapEnabled` guard that fired unconditionally whenever a fresh EB session was found — regardless of whether the account already had a working mobile session from a previous verify. Any account with Stage Bootstrap enabled would be sent back into the "staging" (delayed) state every single time the user clicked Verify, even when they explicitly wanted to run the bootstrap immediately to refresh an expired Bearer token. The only workaround was to temporarily disable `stageBootstrapEnabled` in the DB, run verify, then re-enable it.

**Fix:** The verify route now checks whether the account already had `igApiCookies` containing a `sessionid` *before* this verify run started (using the `profile` snapshot loaded at the top of the route, before fresh cookies are written). If `igApiCookies` already had a session, this is a **re-verify of an existing account** — not a brand-new first-time EB login. In that case the `stageBootstrapEnabled` staging gate is bypassed and the bootstrap runs immediately. Stage Bootstrap delay continues to apply only to genuinely new accounts being verified for the first time (where `igApiCookies` is empty before the EB login).

**File:** `artifacts/api-server/src/routes/instagram.ts` — Stage Bootstrap block inside `POST /api/profiles/:id/verify`

**Invariant added:**
```
_hadPreviousSession = !!(profile.igApiCookies ?? "").includes("sessionid=")
stageBootstrapEnabled gate: only fires when !_hadPreviousSession
```

---

## [1.1.390] — 2026-07-07

### Fixed

#### Stage Bootstrap fires instantly when delay value is corrupted in the database — Node.js 32-bit setTimeout overflow

**Root cause:** Node.js's `setTimeout` uses a 32-bit signed integer internally. Any delay value above 2,147,483,647 ms (~24.8 days) wraps around and is treated as 1 ms, firing the callback almost immediately. The stored `stageBootstrapDelayMin` in the database was 1,185,334 minutes (cause unknown — likely a UI input that was accepted without bounds-checking), which produced a delay of 71,120,068,753 ms — well above the 32-bit limit. The overflow caused the Stage Bootstrap timer to fire in ~1 ms, triggering the full API cold-start immediately after every verify even though the user expected a delayed warm-up.

**Three-layer fix — all in `artifacts/api-server/src/routes/instagram.ts`:**

1. **`scheduleStagingBootstrap` — hard clamp to 32-bit safe max:**  
   Before calling `setTimeout`, the delay is now clamped to `Math.min(delayMs, 2_147_483_647)`. Any corrupted DB value can never cause an overflow-triggered instant fire. The log line now shows both the clamped and raw delay in minutes for visibility.

2. **Verify path — clamp raw DB minutes to [1, 9999] before converting to ms:**  
   `stageBootstrapDelayMin` and `stageBootstrapDelayMax` are now clamped to a maximum of 9,999 minutes (≈7 days) before multiplication by 60,000. This prevents a corrupted value from even reaching the `scheduleStagingBootstrap` call with an overflowing number.

3. **Startup recovery — detect and heal overflow-corrupted `stagingBootstrapFiresAt` timestamps:**  
   On server startup the staging recovery loop re-schedules accounts still in "staging" state by computing `remainingMs = firesAt - now`. If a previous overflow set `stagingBootstrapFiresAt` to a date years in the future, `remainingMs` would be enormous and the account would be stuck in staging indefinitely. The loop now detects any remaining time > 7 days, logs a warning identifying it as an overflow artifact, and runs the bootstrap immediately instead.

---

## [1.1.389] — 2026-07-07

### Fixed

#### HikerAPI Sync Profile toggle ignored — per-account setting now always respected

**Root cause:** The automation engine's reconcile loop loaded all profiles into memory once at the start of each reconcile cycle (`storage.getProfiles()`), then passed those snapshot objects directly to `runProfileSync(profile)`. Any change the user made to the per-account **HikerAPI** sync toggle (`syncUseHiker`) in Account Settings was written to the database by the 800 ms debounce autosave — but if the reconcile happened to fire between when the user toggled the setting and when the autosave completed, `runProfileSync` received the stale snapshot value (`syncUseHiker = true`) and called HikerAPI regardless of what the user had set.

**Fix:** The reconcile loop now calls `this.syncProfile(profile.id)` (the public method) instead of the private `this.runProfileSync(profile)` directly. `syncProfile` always re-reads the profile from the database as its first step before making any HikerAPI / account-sync decision. This guarantees the freshest `syncUseHiker` value is used on every sync, regardless of reconcile timing.

**File:** `artifacts/api-server/src/instagram/automationEngine.ts` — reconcile loop, profile sync timer block

---

#### Stage Bootstrap and other settings ignored when Verify is clicked immediately after changing them

**Root cause:** Account Settings uses an 800 ms debounce autosave: every field change schedules a PATCH to the server 800 ms later. The Verify button reads settings fresh from the database. If the user enabled **Stage Bootstrap** (or toggled off the HikerAPI sync toggle, or changed any other account setting) and clicked Verify within those 800 ms, the database still held the old values — the verify route saw `stageBootstrapEnabled = false` and ran the full API cold-start immediately instead of entering the delayed staging flow.

**Fix — synchronous pre-verify flush:** `_executeVerify` now checks whether a debounce save is pending (via `saveTimerRef.current !== null`). If so, it:
1. Cancels the pending timer
2. Immediately fires `updateProfileMutation` with the current `formData` and awaits its completion
3. Only then calls the verify endpoint

This guarantees the database reflects the user's latest settings before the verify route runs. If the flush save fails (e.g. a transient network error), a destructive toast warns the user that some settings may not be reflected in this verify run — verify still proceeds rather than silently blocking.

**Fix — double-save prevention:** The `scheduleAutoSave` timer callback now nulls out `saveTimerRef.current` before firing its mutation. Previously the ref held a stale timer ID even after the timer fired, causing `_executeVerify` to treat an already-completed save as "pending" and issue a duplicate PATCH on every verify call. With the ref correctly cleared, the explicit flush only fires when there is genuinely an unsaved change in flight.

**Files:**
- `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — `scheduleAutoSave` (timer callback cleanup) + `_executeVerify` (pre-verify flush with error toast)

---

## [1.1.388] — 2026-07-07

### Fixed

#### EB window opens off-screen when Disable API is off — close handler now account-aware

**Root cause:** The `close` event handler in `openEbWindow()` (`ebManager.ts`) unconditionally called `event.preventDefault()` and repositioned every EB window off-screen (`setPosition(sw+10, ...)` + `setSkipTaskbar(true)`) when the user clicked the close button. This behaviour exists so that accounts running in **Disable API** mode keep their Chromium compositor alive for background automation (silent follows, DMs, human jitter, etc.). For non-Disable-API accounts the automation engine uses the mobile API — no live background session is needed — but the window was still being parked off-screen. On the next manual open the reuse path in `openEbWindow` found the hidden window and called `setBounds(workArea)` to restore it, but users reported the window still appearing minimised/off-screen.

**Fix:** Added `disableApi?: boolean` to the `openEbWindow` opts. The close handler now checks: if `disableApi` is false, `return` immediately (native close proceeds — window actually closes). If `disableApi` is true, the existing off-screen parking logic runs as before.

**Call chain updated:**
- `/api/profiles/:id/eb-proxy` (`routes/instagram.ts`) — now includes `disableApi` in its response.
- `open-browser-window` IPC handler (`main.ts`) — reads `disableApi` from `/eb-proxy` and passes it to `openEbWindow`.
- `openEbWindow` opts type and destructure (`ebManager.ts`) — adds `disableApi` field.

---

## [1.1.387] — 2026-07-07

### New — Stage Bootstrap added to Copy Settings

Stage Bootstrap (`stageBootstrapEnabled`, `stageBootstrapDelayMin`, `stageBootstrapDelayMax`) is now a named option in the Copy Account Settings dialog under **API & Performance**. Selecting it merges the enabled toggle and the Min/Max delay window from the source account into each target account's existing `apiLimits` blob without touching any other rate-limit fields.

**File:** `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx` — `ACCOUNT_COPY_GROUPS` and `handleAccountCopy`

---

## [1.1.386] — 2026-07-07

### Fixed

#### Stage Bootstrap inputs — removed artificial 120-minute cap and forced-minimum clamping

**Problem:** The Stage Bootstrap Min and Max delay number inputs in Account Settings had `max={120}` attributes hard-coded in the JSX, silently preventing the user from entering any value above 120 minutes. Additionally, the `onChange` handlers used `Math.max(1, ...)` on Min and `Math.max(min, v)` on Max, which forced values up to 1 and to `min` respectively on every keystroke — making it impossible to type a lower number without the field jumping back up.

**Fix:** Removed both `max={120}` attributes. Removed the `Math.max` clamping from both onChange handlers. Values are now accepted exactly as typed — no hidden floors or ceilings imposed by the UI. The user is free to set any delay range they choose.

**File:** `artifacts/dannys-bot/src/pages/ProfileDetailsPage.tsx`

---

#### Cookie consent banner auto-dismissal — third retry pass for slow React renders

**Problem:** Instagram's cookie consent banner is React-controlled and may take 3–4 seconds to mount into the DOM after a page navigation commits. The existing `framenavigated` handler ran two dismissal passes at 1.5 s gaps, but that window was too tight for the slowest-rendering dialogs on first load — the banner could survive both passes and remain visible.

**Fix:** Added a third `dismissCookieBanner()` pass via `setTimeout` at 3 000 ms after each `framenavigated` event. This ensures the consent dialog is caught even if React takes longer than usual to render it after navigation, without any risk of interfering with mid-redirect flows (the delay is safely after any typical 3xx redirect chain).

**File:** `artifacts/api-server/src/instagram/browserSession.ts`

---

#### Human Session EB browser jitter — gated on Disable API mode

**Problem:** The Human Session tool's EB browser jitter block (notifications visit, own-profile visit, Settings via hamburger, Your Activity via hamburger, and other EB-driven actions) was enqueued and executed regardless of whether the API was active or disabled. When the API is enabled, the account's session is fully managed via Instagram's mobile API — background browser navigation is not needed, burns unnecessary request budget, and can create confusing behavioral signals.

**Fix:** Added an early return at the top of the `humanSession` enqueue async function: if `disableApi` is `false` (API is active), the entire EB jitter block is skipped with a log line (`HS queue — humanSession EB skipped (API active)`). The EB jitter path only runs when `Disable API` is explicitly enabled in Account Settings, which is its intended use case.

**File:** `artifacts/api-server/src/instagram/automationEngine.ts`

---

## [1.1.385] — 2026-07-07

### New — Stage Bootstrap (deferred API cold-start)

After the browser logs in and harvests the session cookies, the API cold-start sequence can now be intentionally delayed by a configurable random window (X–Y minutes, set per-account in Settings → Stage Bootstrap).

**Why:** Running the browser login and the mobile API cold-start back-to-back on the same account within seconds hits multiple endpoint families in a short burst, which reduces trust score and puts the account on a tightrope from the start. The staged delay lets the EB session settle naturally before any mobile API traffic begins.

**Account status during wait:** A new orange **Staging** pill is shown in the Accounts list with a live countdown timer displaying the remaining minutes until the API bootstrap fires.

**Restart-safe:** The fire timestamp (`stagingBootstrapFiresAt`) is persisted in the database. On server restart, any account still in staging has its remaining delay recomputed from the saved timestamp and the timer is rescheduled automatically — no manual intervention needed.

**Implementation:** `artifacts/api-server/src/routes/instagram.ts` — `scheduleStagingBootstrap()` / `runStagedBootstrap()` / startup recovery IIFE. DB column: `staging_bootstrap_fires_at`. Frontend: orange pill in `ProfilesPage.tsx`, Setting controls in `ProfileDetailsPage.tsx`.

### Improved — Full endpoint visibility in API Calls export

Previously, all HTTP requests made inside a named timed operation (e.g. `ViewTimelineFeedSeen`, `LikeMedia`, `FollowedUser`) were suppressed from the individual log — only the outer named entry appeared in the export. This meant that for every operation, the actual endpoints hit were invisible.

**Fix:** Removed the `_inTimedCall` early-return guard from `_logTransport()` in `instagramWebClient.ts`. Every individual endpoint call now logs its own row regardless of whether it runs inside a `timed()` wrapper. Error propagation to the outer named entry is preserved via `_lastTimedCallIsError`.

---

## [1.1.384] — 2026-07-07

### Fixed

#### Critical — Verify overwrites live sessionid with stale file value → __coig_ufac=1 ban

**Root cause:** In `/eb/silent-verify` (`ebManager.ts`), `loadCookiesFromFile()` was called **before** the existing-session check. Instagram rotates the `sessionid` cookie during active browsing. If the `cookies-{id}.json` file held the original login-time sessionid (30+ minutes old), the file-load silently overwrote the live, current sessionid in the Electron session partition. Any subsequent request from the browser then carried the stale sessionid value — Instagram's cookie origin integrity guard (`__coig_ufac=1`) detects this as a cookie being replayed from a different device/time and triggers an instant suspension.

**Confirmed by log:** The ban URL always contained `?__coig_ufac=1`. Verify completed with `"Using existing EB session"` (no Instagram HTTP calls) — but `loadCookiesFromFile` had already run and the overwrite had already happened before the early return.

**Fix:** Check for a live `sessionid` in the Electron session **before** calling `loadCookiesFromFile`. If a live session exists, return immediately without touching any cookies at all. Only call `loadCookiesFromFile` when there is no active session (i.e. the EB needs to be bootstrapped from the saved cookie file for a fresh login).

---

## [1.1.383] — 2026-07-07

### Fixed

#### Critical — Mobile UA + stale desktop GPU fingerprint causing instant bans (root cause of 3-day ban wave)

**Root cause:** When accounts had desktop UAs (v1.1.291–v1.1.365), `generateEbFingerprint()` was called with `desktopMode=true`, storing a desktop GPU renderer string (e.g. `"ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"`) in the `ebFingerprint` DB column. When v1.1.366 reverted the UA back to mobile Android, only `userAgentEmbedded`/`userAgentApi` were updated — the stored `ebFingerprint` was NOT regenerated. From that point, every EB open and every Mode-B silent-window action sent Instagram a physically impossible hardware combination: Android 14 mobile UA + NVIDIA RTX Direct3D11 WebGL renderer. Instagram detects this as an immediate device-mismatch/session-hijack signal → instant ban.

The coherence check in `browserSession.ts` (introduced to catch desktop-GPU mismatches within the desktop-UA era) only ran when `isDesktopUA = true`. It completely missed the reverse case: mobile UA + stale desktop GPU in DB.

**Two-part fix:**

1. **Startup migration** (`routes/instagram.ts`): on every server start, scans all profiles with a mobile UA and regenerates any `ebFingerprint` that contains a desktop GPU string (`Direct3D11`, `ANGLE (Apple`, `ANGLE (NVIDIA`, `ANGLE (AMD`, `ANGLE (Intel`). Fixes all affected accounts immediately — without waiting for each EB to be opened manually. Logged as `[startup:fp-fix]`.

2. **Per-session coherence check** (`browserSession.ts`): extended the existing desktop-coherence guard to also catch Case B (mobile UA + any desktop GPU string). Now runs on every EB open for both desktop and mobile UA accounts, covering any account that slips through the startup migration.

---

## [1.1.379] — 2026-07-06

### Added

#### Leak Protection — Console shield logs for EB sessions, API client, and browser-only accounts

Three new structured log lines now fire at the critical points in every account session so you can confirm leak protection is active in real time and cross-check it against the Leak Check page.

---

##### `[eb-shield:ID]` — fires every time an Embedded Browser session opens (`ebManager.ts › openEbWindow`)

Printed immediately after the proxy, WebRTC policy, DoH, and DNS-cache setup steps complete. Reports the **actual applied state** of each protection layer — not assumed state — so any layer that failed to apply (e.g. `setWebRTCIPHandlingPolicy` unavailable on an older Electron build) shows `⚠` instead of `✓`.

```
[eb-shield:123] @username ── LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  webrtc      : ✓ disable_non_proxied_udp (session-level + app-level flag)
  doh         : ✓ DISABLED — proxy handles DNS resolution
  quic        : DISABLED (app-level --disable-quic flag)
  ipv6        : DISABLED (app-level --disable-ipv6 flag)
  dns-prefetch: DISABLED (app-level --dns-prefetch-disable flag)
  dns-cache   : FLUSHED (clearHostResolverCache)
```

- `webrtc` and `doh` lines carry `✓` when the session-level API applied, `⚠` when it threw (non-fatal; app-level flag still applies).
- `doh` note adapts: proxy sessions say "proxy handles DNS resolution"; home-IP (`useHomeIp=true`) sessions say "OS resolver (no proxy in this session)".

---

##### `[run-leak-test:ID]` — fires after every leak test (`ebManager.ts › /eb/run-leak-test handler`)

Replaces the previous single-line count log with a per-field breakdown that mirrors all 20 checks on the Leak Check page. The headline summarises the worst finding; each check line shows the same status icon and label the UI shows.

```
[run-leak-test:123] RESULTS — ✓ ALL CLEAR (20/20 checks)
  IP        : ✓ 185.x.x.x (proxy)
  IPMatch   : ✓ Matched
  WebRTC    : ✓ No leak
  DNS       : ✓ No leak
  UAMatch   : ✓ Match
  Bot       : ✓ Not detected
  Timezone  : ✓ ...
  ...
```

Headline rules (in priority order):
- `✗ N FAIL(S) — key1, key2` — one or more `fail` results
- `⚠ N WARN — key1, key2` — warnings with no failures
- `⚠ INCOMPLETE — N checks not captured (key1, …)` — test page timed out or crashed before all 20 keys were written; **never shows ALL CLEAR when checks are missing** (previous behaviour was a false green)
- `✓ ALL CLEAR (20/20 checks)` — only when all 20 keys are present and none are `fail`/`warn`

Result JSON is runtime-normalised before logging (`unknown → { status, label }`) so a partial or malformed RESULTS object degrades gracefully rather than throwing.

**Cross-check rule:** `[eb-shield]` proxy host and `[run-leak-test]` IP result must agree. Any discrepancy means a request bypassed the proxy.

---

##### `[api-shield:ID]` — fires when an API client is created and when disableApi mode blocks it (`instagramWebClient.ts`, `automationEngine.ts`)

**Mobile API active path** (printed in `InstagramWebClient` constructor after the hard-gate check):

```
[api-shield:123] ── MOBILE API LEAK PROTECTION ACTIVE
  proxy       : http://p.host:8080
  hard-gate   : ✓ constructor blocks if proxy absent
  tls-gate    : ✓ tlsRequest blocks if proxy absent
  cycleTLS    : ✓ patchIgClientTls throws if CycleTLS fails (no Node.js TLS fallback)
```

Port is normalised — if the proxy URL has no explicit port, the scheme default is used (`http→80`, `https→443`, `socks5→1080`) so the log never shows `host:`.

**Browser-only / Disable API path** (printed in `ensureClient` when `disableApi=true`):

```
[api-shield:123] @username ── BROWSER-ONLY MODE
  mobile-api  : ✗ BLOCKED (disableApi=true — ensureClient returns null)
  eb          : EB session will be attempted for this account; proxy is
                enforced there — look for [eb-shield:123] in the log.
                If no [eb-shield] line appears, the EB session did not open.
```

The note is intentionally conditional: `disableApi=true` suppresses all API calls but does not guarantee an EB session — if the EB fails to open (e.g. `ensureSilentEbOpen` error) no `[eb-shield]` line appears, making the gap immediately visible in the log.

---

## [1.1.378] — 2026-07-06

### Fixed

#### EB Leak Test — Audio Context state always showed "closed" (false negative)

**Root cause:** The `testAudio()` function in the leak test called `ctx.close()` on line 1277 and then read `ctx.state` on line 1286 — after the close. An AudioContext transitions to `"closed"` state when `.close()` is called, regardless of what state it was in before. So the field always displayed `"closed"` even on a fully healthy, running audio context, making it impossible to tell from the leak test whether the AudioContext was behaving normally.

**Fix:** Capture `ctx.state` into `ctxStateCaptured` immediately before calling `ctx.close()`. The row now shows `"running"` (the correct value for a freshly created AudioContext) and is coloured green for `running`/`suspended`, amber for anything else.

---

#### EB Leak Test — Timer Precision falsely reported "No — full precision" despite 0.1ms quantisation being active

**Root cause:** The old timing test sampled `performance.now()` 10 times in a tight synchronous loop and checked `Math.min(...diffs)`. With our 0.1ms quantisation override (`Math.round(t*10)/10`), all 10 calls happen within the same 100 µs bucket and return the **same** value — giving diffs of exactly `0`. The test's threshold `minDiff > 0.1` evaluated to `false`, so it reported "full precision" even though our clamp was working correctly. This was a false alarm: real Android Chrome with timer coarsening produces the same pattern.

**Fix:** Replaced the brittle `minDiff` check with a `nonZeroDiffs`/`allSame` approach:
- `allSame = true` (all diffs are zero) → timer is quantised, all calls fell in the same bucket → report "coarsened."
- `minNonZeroDiff ≥ 0.099ms` (epsilon-adjusted for IEEE-754 rounding) → timer steps are coarse → report "coarsened."
- Only if non-zero diffs exist AND the smallest is `< 0.001ms` → true full precision → report "full precision."
The resolution label also now says `≤0.1ms (quantised — all same bucket)` for the common case, making it immediately clear what's happening.

---

#### EB Fingerprint — `navigator.doNotTrack` leaked as `"1"` (Electron default)

**Root cause:** Electron's Chromium session has DNT (Do Not Track) enabled by default. Every EB window therefore exposed `navigator.doNotTrack === "1"` to Instagram. Real Android Chrome never sets DNT — the preference is buried in a rarely-visited settings page and the default is off — so `navigator.doNotTrack` on a real Android Chrome session returns `null`. Instagram and third-party fingerprinting scripts can detect this mismatch.

**Fix:** Added an `Object.defineProperty` override to `buildFingerprintScript` immediately after the `performance.now` clamp:
```javascript
Object.defineProperty(navigator, 'doNotTrack', { get: function(){ return null; }, configurable: true });
```
This runs via `Page.addScriptToEvaluateOnNewDocument` on every page navigation in the EB, restoring the correct `null` value before any page script can read it.

---

#### EB Browser — WebGL 2 context unavailable on some GPU/driver configurations

**Root cause:** Chrome maintains a GPU blocklist (a list of GPU/driver combinations with known rendering bugs) and denies `canvas.getContext('webgl2')` for GPUs on that list. On some Windows machines this caused WebGL 2 to be unavailable in the EB, even though Android Chrome 128 supports WebGL 2 on every supported Android device. The mismatch is detectable by Instagram's client-side fingerprinting probes.

**Fix:** Added `app.commandLine.appendSwitch("ignore-gpu-blocklist")` to `main.ts`. This instructs Chromium to ignore the denylist and attempt hardware-accelerated WebGL 2 on all GPUs. Trade-off: may cause minor rendering glitches on genuinely buggy drivers, but the EB is automation-only (no user-visible rendering quality requirement) so this is acceptable.

---

## [1.1.377] — 2026-07-06

### Fixed

#### Human Session Tool (Disable API mode) — "Suggested for you" page no longer prevents Explore from firing

**Root cause:** When an account follows no users, Instagram's home feed shows a full-page "Suggested for you" layout. These suggestion cards are wrapped in `<article>` elements — the same selector used by `waitFor('article')` — so the feed-detection check returned `feedHadPosts = true` even when no real posts were present. The Explore-page block (`followSuggestedUsersIfEmptyEnabled`) never fired because it depends on `feedHadPosts = false`.

A second problem: a defensive post-scroll re-check at the end of the viewTimelineFeed block used `document.querySelector('article')` to recover from slow SPA renders. Since suggestion cards also match `article`, this re-check would silently restore `feedHadPosts = true` even after the suggestions page was correctly identified, cancelling the fix.

**Fix (two coordinated parts):**
1. **Detection** — after `waitFor('article')` succeeds, a new `page.evaluate()` check runs to distinguish real posts from suggestions. The check is intentionally conservative: it only triggers when (a) ALL article elements on the page lack a `<time>` child (real feed posts always contain a timestamp; suggestion cards never do) AND (b) a "Suggested for you" heading is found as a leaf text node. A mixed feed — one that contains both real posts and a suggestions section — will always have at least one `<time>`-containing article, so the check never false-positives there. If detected: `feedHadPosts = false`, `_ebSuggestionsPageDetected = true`.
2. **Re-check guard** — the post-scroll defensive re-check is now skipped when `_ebSuggestionsPageDetected = true`, preventing suggestion-card `<article>` elements from undoing the detection. The re-check selector is also tightened to `article time` so it only counts articles with a real timestamp, not bare structural wrappers.

---

#### Human Session Tool (Disable API mode) — Execution Order fields now work

**Root cause:** `runBrowserOnlyHumanSession` (the code path taken when **Disable API** is enabled on an account) was a flat sequential `if`-block. Every action always ran in the same hard-coded order regardless of the OrderMin/OrderMax values configured in the Human Session Tool settings. The order queue that the standard (API) path uses in `runHumanSessionTools` had never been ported to the browser-only path.

**Fix:** `runBrowserOnlyHumanSession` now uses the same queue pattern as `runHumanSessionTools`:
- `EbQueueEntry` type + `ebQueue` array + `ebEnqueue` helper that reads each action's `OrderMin`/`OrderMax` setting and assigns a random sort value in that range.
- All ten major actions are enqueued: `humanJitter`, `viewTimelineFeed`, `viewReels`, `checkTimelineStories`, `checkDm`, `likeTimelinePosts`, `follow`, `unfollow`, `contact`, `repost`.
- `ebQueue.sort((a, b) => b.order - a.order)` then executes them in descending order (higher order = runs first) — identical to the non-EB queue convention.
- The resolved execution order is logged at session start: `[EB-only] session order: viewTimeline → likeTimeline → …`
- `saveTimelinePosts`, `shareTimelinePosts`, and `explorePage` remain sequential after the queue — they have no order keys and depend on `feedCount` / `feedHadPosts` set by `viewTimelineFeed`.

---

## [1.1.374] — 2026-07-06

### Fixed

#### Human Session Tool — View Reels: reel count now accurate + ArrowDown works reliably

**Root cause:** The reels page was missing the `document.visibilityState = "visible"` override before the reel-watching loop. Without it, Instagram's SPA keeps the reel feed in a throttled / non-hydrated state when the EB window is off-screen, which means the video element is present but the reel player is not fully initialised. Separately, `page.keyboard.press("ArrowDown")` was firing without a preceding `document.body.focus()`, so the key event was silently dropped when no DOM element had focus.

**What was happening:** The reel loop always incremented `watched` once per `ArrowDown` press regardless of whether the reel player actually advanced, so the session log could report e.g. 9 reels watched while the user watching the EB saw only 1 reel play.

**Fix:**
1. Applies the same `Object.defineProperty(visibilityState → "visible") + dispatchEvent(visibilitychange)` override already used by `viewTimelineFeed`, `likeTimelinePosts`, `checkTimelineStories`, and the Follow/story flows — now also applied right before the reel-watching loop starts.
2. Calls `document.body.focus()` immediately before each `ArrowDown` press so the key event is always delivered to the document and reaches the reel player's keyboard handler.

---

#### Human Session Tool — View Reels: EB no longer stays parked on `/reels/` after the block finishes

**Root cause:** The View Reels block navigated to `instagram.com/reels/` and left the EB there with no cleanup navigation. If `checkTimelineStories` was disabled (or skipped by chance), no subsequent block navigated away, so the EB finished the session — and started the next one — on `/reels/`. Users saw the EB jump unexpectedly to the Reels page immediately after the final action of the previous session.

**Fix:** After the reel-watching loop (and after any reel-like logging), a `nav("https://www.instagram.com/", "home (after reels)")` call returns the EB to the home feed before proceeding to the next block. This is guarded by `!state.stop.stopped` so it is skipped on early session termination.

---

#### Human Session Tool — Watch Stories: removed gratuitous home-page reload between each story user

**Root cause:** The story-watching loop called `nav("https://www.instagram.com/", ...)` at the **top of every iteration** — including iterations 2, 3, 4, etc. After pressing `Escape` to dismiss a story, Instagram's overlay closes and the browser is already on the home feed; a second full navigation to the same URL caused a complete page reload the user perceived as the EB "bouncing" back and forth between the home feed and the story viewer for every single user in the tray.

Additionally, the original design comment ("always navigate home so the tray is in a clean state") was correct for iteration 0 only — the story tray's "first unseen" pointer already advances automatically after a story is fully dismissed via `Escape`, so subsequent iterations naturally see the next unread user without any navigation.

**Fix:** The `nav(home)` call is now guarded by `if (i === 0)`. Iterations 1 through N skip the navigation entirely; the visibilityState override and tray-selector wait that follow immediately re-hydrate and query the already-loaded home feed. Net effect: N story-tray interactions now produce 1 home-feed navigation (at the start) instead of N, eliminating the bouncing behaviour.

---

#### Human Session Tool — Web Browsing block collapses when disabled

**Root cause:** The Web Browsing section's tab bar ("Settings" / "Sites Visited") and the content panel below it were rendered unconditionally — they always appeared even when the `webBrowsingEnabled` checkbox was off. This differed from every other tool block in the Human Session panel, which hides its detail rows when unchecked.

**Fix:** The tab bar and both content panels (Settings and Sites Visited log) are now wrapped in `{!!settings.webBrowsingEnabled && (...)}`. When the checkbox is off the header row alone is visible, matching the collapsed pattern used by all other tool blocks.

---

## [1.1.373] — 2026-07-06

### Added

#### Web Browsing — new standalone block in Human Session Tool (last, after Contact Tool)

A dedicated **Web Browsing** block has been added to the Human Session Tool. It appears as the last header block, positioned after the Contact Tool, matching the same cyan-header layout as Follow / Unfollow / Contact.

**What it does:**
- During any Human Session run, the engine visits a configured list of external websites using the same headless-browser cookie-baker engine already used by the standalone Cookie Baker tool. This builds genuine, per-account browser history that Instagram sees when inspecting the Chrome cookie jar — the same cookies the EB writes into `browser-data/cookies-{profileId}.json`.
- Sites are visited with real scroll dwell time, optional internal-link traversal, and cookie banner dismissal — identical to the Cookie Baker behaviour.

**UI features:**
- Enabled checkbox, Order % and Skip Chance % ranges on the header row (same pattern as all other HS blocks).
- **Settings tab**: URL textarea (one URL per line), "Visit at random" checkbox, Sites to Visit / Internal Links / Time on Site / Time on Internal Links min–max pairs.
- **Sites Visited log tab**: shows every past web browsing session with each site visited, time spent, and internal links followed — pulled from `/api/profiles/:id/cookie-baker/activity`.
- **"Split across accounts" button**: distributes all URLs in the current account's list evenly across every account — no duplicates. E.g. 100 URLs × 10 profiles → each profile gets 10 unique URLs. The current profile's slice updates immediately in the UI.

**Copy Settings integration:**
- Web Browsing Settings group added to the Human Session Copy Settings dialog (after Contact Tool Settings).
- Sub-options: Enabled, Execution order, Skip chance %, Visit at random, **Website URLs** (separate checkbox — tick to include URLs in the copy; when unticked only settings are copied, URLs stay per-account), Sites to visit range, Internal links range, Time on site range, Time on links range.

**Engine wiring (automationEngine.ts):**
- `enqueue("webBrowsing", ...)` added to the Human Session queue, before `queue.sort()`. Controlled by `webBrowsingEnabled` / `webBrowsingSkipMin/Max` / `webBrowsingOrderMin/Max`. Maps all `webBrowsing*` settings keys to `runCookieBakerSession`'s expected params (`sites`, `sitesMin/Max`, `visitRandom`, `internalLinksMin/Max`, `scrollDelayMin/Max`, `internalScrollDelayMin/Max`). Each completed session is logged via `logAction` + `logGhostBrowserCall` and appears in the Actions log.

#### Ghost Browser Signup — website warm-up removed (moved to Human Session Tool)

All website warm-up configuration has been removed from the Ghost Browser Signup panel:
- Removed state, localStorage persistence, and payload fields: `websitesToVisit`, `websitesMin/Max`, `internalLinksMin/Max`, `timeOnSiteMin/Max`, `timeOnLinksMin/Max`.
- Removed the "Warm-up Websites" textarea and "Websites to Visit / Internal Links / Time on Site / Time on Links" XY-field rows from the UI.
- Removed the "Visiting Sites" step from the signup progress tracker — the progress stepper now shows `["YouTube Warm-up", "Instagram Signup"]` (or just `["Instagram Signup"]` when Skip Warmup is ticked).
- YouTube warm-up, Skip Warmup toggle, and all YouTube settings remain fully intact.
- The `calcStepProgress` function's settings shape updated to remove the now-unused `websitesMin/Max/Count` fields.

The website-visiting capability now lives exclusively in the Human Session Tool's Web Browsing block, where it runs on a schedule during live Instagram sessions rather than only at account-creation time. This gives Instagram a richer, ongoing browsing history rather than a one-off pre-signup burst.

---

## [1.1.372] — 2026-07-06

### Added

New `expandCaptionPercentMin/Max` sub-setting row above the Reel Chance row. When configured, the engine scrolls back through the feed after the main scroll pass and clicks the "… more" button on posts with probability `expandCaptionPercent`%, simulating a user who reads the full caption of posts they find interesting. The button search matches any `[role="button"]` or `<button>` element whose trimmed text ends with "more" (handles ASCII "...", Unicode "…", and locale variants). Logged with Ghost Browser transport.

---

## [1.1.325] — 2026-07-04

### Fixed

#### Human Session Tool — View Timeline Feed sub-settings (Like% and Watch Reels) now actually run in browser/Disable-API mode

**Root causes found and fixed:**

1. **Likes sub-setting was never wired into the browser path.** The `Like%` control in the View Timeline Feed sub-row sets `likeTimelinePostsPercentMin/Max`, but the browser-only `viewTimelineFeed` block only scrolled — it never acted on those settings. Meanwhile, the separate `likeTimelinePostsEnabled` block (which uses a different count-based setting, `likeTimelinePostsMin/Max`) ran independently only when that standalone toggle was also on. Result: `Like%` in the feed sub-settings silently did nothing in browser mode.

2. **Watch Reels was completely absent from the browser path.** Reel watching via `reelWatchChance*`/`reelWatchCount*`/`reelWatchPercent*` only existed inside the mobile-API `viewTimelineFeed` implementation. There was no browser equivalent, so the reels sub-setting never fired regardless of how it was configured.

3. **`waitFor` helper was declared after the `viewTimelineFeed` block.** Moving the helper inside the block would have caused a TDZ `ReferenceError` at runtime. Moved the `waitFor` declaration to immediately after `nav`, before all browser action blocks, so it is available throughout the session.

**What now happens in browser mode with View Timeline Feed enabled:**
- After scrolling the feed, a like pass runs using `likeTimelinePostsPercentMin/Max` (the exact % shown in the UI), computing a proportional like count from `feedCount`. Zero is a valid outcome for low percentages.
- After likes, a reel-chance roll using `reelWatchChanceMin/Max` determines whether to watch reels. If the roll passes, navigates to `instagram.com/reels/`, waits for a video element, then dwells for `reelWatchPercent`% of an estimated reel duration per reel before pressing ArrowDown, repeating `reelWatchCount` times. Both actions are logged with "Ghost Browser" transport.

**Bounds safety:** all `min`/`max` pairs are clamped to `[0, 100]` and swapped if inverted before use, preventing silent no-ops from bad settings.

---

## [1.1.324] — 2026-07-04

### Added

- Copy Settings (Accounts Manager) now includes a "Disable API" toggle in the Browser Actions group, merged into the same single-PATCH `apiLimits` copy block used by the other browser-action settings (avoids the race/stale-overwrite bug and the "Nothing to copy" false toast).
- `logGhostBrowserCall()` helper in `automationEngine.ts` mirrors every browser-driven action into `storage.createInstagramApiCall` with `source: "Ghost Browser"` / `transport: "Ghost Browser"` so these actions appear in the Actions log and CSV export exactly like real API calls.
- `resolveOperationName()` in the `/api/logs/export` CSV route now maps `source === "Ghost Browser"` rows to the correct tool label (Follow Tool / Contact Tool / Human Session Tool) instead of falling back to the raw internal operation name.
- New Human Session browser sub-features: save post (`saveMediaEnabled` + `saveMediaPercent` chance), share post (`sharePostPercentMin`/`sharePostPercentMax` chance), and Explore page visit (`followSuggestedUsersIfEmptyEnabled`) — all wired through the embedded browser and logged via `logGhostBrowserCall`.

---

## [1.1.275] — 2026-07-01

### Fixed

- **ig-set-authorization never captured through CycleTLS**: `patchIgClientTls` replaces the entire `got` HTTP pipeline with CycleTLS, which bypassed Instagram's response interceptor that normally reads `ig-set-authorization` and `ig-set-www-claim` headers into `ig.state`. Both headers are now read from raw CycleTLS response headers and written directly to `ig.state.authorization` / `ig.state.igWWWClaim` so that `_absorbIgClientState()` can persist them to `igDeviceState` and the DB.

---

## [1.1.0] — Initial Release

### Features

- Multi-account Instagram automation: follow, unfollow, DMs, contact messaging, auto-reply
- Embedded browser (Puppeteer/Chrome) for EB-first authentication — every session originates from a real browser login
- Jarvee two-stage handshake: EB login → cookie extraction → mobile API session via `mobileBootstrapFromWebCookies`
- Device fingerprint continuity: `mid`, `ig_did`, `ig_nrcb`, `ig_did` preserved across all sessions; never regenerated unless user explicitly resets
- HikerAPI integration for hashtag/location/follower scraping
- CycleTLS (OkHttp4 JA3 fingerprint) for all mobile API requests — matches real Android Instagram app TLS fingerprint
- Proxy slot manager with per-account sticky IP assignment
- Human session simulation: timeline browsing, story viewing, DM checks between automation actions
- SQLite database (portable, single-file) with Drizzle ORM
- Electron desktop app wrapper with auto-updater (NSIS Windows installer)
- React + Vite + shadcn/ui frontend served from the Electron main process
