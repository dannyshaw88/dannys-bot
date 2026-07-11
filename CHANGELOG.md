# Changelog

All notable changes to Equinox are documented here.

---

## [1.1.484] — 2026-07-11

### Fix: close-Instagram gesture swiped UP, which does nothing on this device's recents screen (CRITICAL)

Screenshot evidence showed this farm's phones use a Xiaomi "floating windows"
recents carousel, not stock Android recents — cards sit side by side (up to
two visible at once) and are dismissed by dragging them off the LEFT edge,
not by swiping up. The previous close-Instagram code swiped the Instagram
card upward (the stock-Android gesture), which is a no-op on this launcher,
so Instagram was never actually dismissed by the "real gesture" and every
cycle silently fell through to a force-stop instead.

Fix: `closeInstagramViaRecents` now drags the left-most visible card off the
left edge of the screen, and repeats this (up to 5 times) since dismissing
one card slides the next into the left-most slot — matching the confirmed
real interaction ("if more than one app is open, keep dragging the very-left
one to the left; if only one is open, it's already centred").

### Fix: story share icon scan missed a visibly-present paper-plane icon on some devices

The icon-detection scan only looked in the bottom 70–97% of the screen for
the like/share icon row. That band was calibrated against one specific
phone's screenshot; this farm runs multiple phone models with different
screen aspect ratios, and on a device where the reply bar sits higher up,
the real icon row fell outside the band entirely — the scan found nothing
and logged "sharing disabled" even though the paper-plane icon was visibly
on screen. Widened the scan band to 55–99% of screen height. Also added a
one-line log of the actual device resolution at the start of each stories
run so a mismatch like this is visible in the log immediately instead of
requiring another guess-and-check round.

---

## [1.1.483] — 2026-07-11

### Fix: story share-to-DM (and like) taps landing on the home feed (root-cause, not another icon heuristic)

Every prior fix in the story loop patched *how* icons were detected (pixel
scan, gap filters, keyboard-check safety nets), but never questioned the
underlying assumption that once a story opened, it would still be open for
the rest of the per-slide loop and for the entire multi-step DM-share
sequence. It doesn't: Instagram stories auto-advance on their own ~5-6s
timer regardless of what the script is doing, and the DM-share sequence
(icon scan → tap paper-plane → wait → pick recipient → wait → tap Send) adds
up to several seconds of scripted waits on its own. A short/fast story, or a
share sequence that simply took too long, let the story exit back to the
home feed mid-sequence — and every tap coded after that point kept firing
blind at the real screen underneath (the feed), which is how a scheduled
"share via DM" turned into an accidental like on a home-feed Reel, "literally
not even in our flow."

Fix: added a cheap live check (`stillInStoryViewer()`, via the existing
`findHomeTab` bottom-nav probe) before *every* tap in the per-slide loop —
before the like double-tap, before starting the share sequence, after the
paper-plane tap, after picking a recipient and right before the final Send
tap, and before the "advance to next slide" tap. The instant any check shows
we've left the story viewer, the loop stops issuing further taps entirely
instead of assuming the next screen is still a story. Also capped the
pre-share watch time (max 2000ms when a share is scheduled, down from up to
100% of the slide) and trimmed the DM-share sequence's own waits (1200→900ms,
1500→900ms) so the whole sequence has a realistic chance of finishing before
a slide's own timer runs out.

Also fixed a stale type signature on `pickAndOpenRandomStory` (declared
`Promise<number>` while actually returning `{ slot, opened }` since v1.1.482)
that was silently masking real type errors at its call site.

---

## [1.1.482] — 2026-07-11

### Fix: story like/share landing on home feed when tray tap missed (CRITICAL)

`pickAndOpenRandomStory` logged whether the story viewer opened or not but
returned only the slot number — the caller (`runViewStoriesFromFeedLoop`) never
saw the open/fail status and always proceeded to run like and share actions
regardless. When the tray tap missed (e.g. hit the follow badge), the phone
was still showing the home feed, and the next action — a double-tap at story
centre coordinates — landed on whatever post was on screen and liked it.

Fix: `pickAndOpenRandomStory` now returns `{ slot, opened }`. If `opened` is
false the story loop exits immediately with 0 stories watched instead of
running actions on the wrong screen.

### Fix: phone left on recents screen after close step

`closeInstagramViaRecents` opens the recents overview to attempt the
swipe-to-dismiss gesture, then force-stops the process. It correctly closed
Instagram but left the phone sitting on the recents screen (the overview
animation was still showing). The subsequent swipe-up + sleep then locked the
phone on the recents view, so the next cycle woke to an unexpected screen.

Fix: added `KEYCODE_HOME` (keycode 3) immediately after
`closeInstagramViaRecents` returns so the launcher is foregrounded before the
sleep command locks the screen.

---

## [1.1.481] — 2026-07-11

### Fix: phone screen still waking on restart (stay_on_while_plugged_in persisted from old sessions)

`stay_awake=false` (added in v1.1.480) stopped scrcpy from *setting* the
`STAY_ON_WHILE_PLUGGED_IN` system flag, but it cannot *clear* a value that was
already set by a previous session. The flag persists on the device indefinitely
after any session that used `stay_awake=true` — including every session prior
to v1.1.480. Added an explicit `adb shell settings put global stay_on_while_plugged_in 0`
command before each scrcpy spawn. This resets the flag from whatever previous
session left it before the new session begins.

### Fix: Account Settings — deleted slots reappear, typed values forgotten on tab switch

Two separate persistence bugs:

**Deleted slots reappear:** the server was padding the saved slot array back to
5 entries on every POST (`while length < 5, push empty`). A user deleting down
to 2 slots would see them save as 2, server would save as 5, and the UI would
reload 5. Removed server padding — the server now stores exactly as many slots
as the UI sent.

**Typed values forgotten when switching tabs:** `AccountSettingsPanel` is
conditionally rendered (`activeTab === "account" && <AccountSettingsPanel…/>`),
so it unmounts every time the user navigates to a different tab. The save
debounce used `return () => clearTimeout(t)` as its React cleanup, which React
calls on unmount — silently cancelling any in-flight save that hadn't fired
within 400 ms of the tab change. Replaced with a `useRef`-held timer that
debounces between keystrokes but is not tied to the component lifecycle.

### Fix: story share — now scans for icon before tapping (skip if not available)

Previously: always tapped at fixed right-edge coordinates, then checked if the
keyboard opened to determine if sharing was disabled. This always disturbed the
story (briefly opening the message field) even when sharing was obviously off.

Now: runs `findStoryActionIcons()` before any tap. If ≥2 icons are detected the
rightmost is the paper-plane — its actual coordinates are used for the tap. If
0 or 1 icons are found (sharing disabled or ambiguous), the story continues
without touching the screen at all. Keyboard check is retained as a final
safety net for the rare case where the icon scan mislabels a cluster.

### Fix: close-Instagram — was wasting 25 seconds on 5 guaranteed-to-fail recents swipes

On Xiaomi HyperOS, MIUI memory management locks apps in the recents stack so
the swipe-to-dismiss gesture never kills the process. The 5-attempt loop took
~25 seconds before reaching the force-stop fallback, all 5 passes failing in
user testing. Reduced to 1 attempt; if Instagram is still running after it,
force-stop fires immediately.

### Improved: cycle log now shows completion status after each step

Added `✓` confirmation lines after: screen unlock, Instagram open, Instagram
close, airplane mode on/off. Previously only "about to do X" lines appeared;
now both the intent and the result are visible.

---

## [1.1.480] — 2026-07-11

### Fix: phone screen waking on software restart with toggle on

Root cause: scrcpy's `stay_awake=true` option (present since the mirror
was introduced) sets Android's `STAY_ON_WHILE_PLUGGED_IN` system flag on the
device the instant scrcpy connects. On Xiaomi/MIUI, that system flag wakes
the physical screen immediately — even though `power_on=false` (added in
v1.1.478) blocks scrcpy's own screen-on action, `STAY_ON_WHILE_PLUGGED_IN`
fires through a completely independent code path. This wake occurred on
every connect, including the automatic mirror connection that fires when
the automation toggle is left on and the software restarts. Changed to
`stay_awake=false`: scrcpy no longer modifies the device's stay-awake
setting. The automation cycle's own explicit `wakeScreen()` call (which
happens at the start of each tick when the screen is genuinely needed) is
unaffected.

### Fix: story Like and Share taps consistently missing (keyboard opens instead)

Root cause (pixel scan): Instagram renders the entire story reply-bar — the
message input field, the heart icon, and the paper-plane icon — on a
hardware-accelerated canvas with zero accessible elements in the
UIAutomator tree. The previous approach used a pixel-brightness scan of a
screenshot to locate the icon glyphs. The "Send message" placeholder text
is white on the same dark scrim as the icons, and word-breaks in the text
produce bright clusters that are similar in width and count to real icon
clusters. The gap-isolation filter that was supposed to reject text
clusters consistently failed under real conditions, causing taps to land
inside the message text field (opening the keyboard) rather than on the
icons.

Two-part fix:

**Like — double-tap on story content (no icon detection)**
Instagram registers a double-tap anywhere on the story image as a Like —
the same gesture used in the feed. Changed from "scan for heart icon, tap
it" to `doubleTap(w×50%, h×44%)`. No screenshot required, no cluster
analysis, works regardless of which icons the story owner has enabled.

**Share — fixed right-edge coordinates**
The paper-plane (Send to DM) icon is always the rightmost element in the
story bar and sits consistently at approximately 92% screen width × 91%
screen height on standard Instagram layouts. Changed from "scan for
rightmost cluster" to a direct tap at `(w×92%, h×91%)`. Added a keyboard
check: if the tap lands in the message field (story owner has sharing
disabled), the keyboard is detected, the code backs out, and the share is
skipped cleanly for that story.

---

## [1.1.479] — 2026-07-11

### Fix: story like/share misses on short stories

Root cause: `findStoryActionIcons` (the screenshot + pixel decode call) was
happening AFTER the watch-% sleep. On a short story (1–6 s) at even a moderate
view %, the screenshot call ate into the remaining story time, and if the story
auto-advanced during it the subsequent taps landed on the next story's icons
(or worse, empty space). Between the Like tap and the Share tap there was also
a 400–600 ms sleep — another window for a short story to advance.

Three-part fix:
1. **Pre-scan at story load** — `findStoryActionIcons` is now called at the
   very start of each loop iteration, before the watch-% sleep, while the story
   is freshly loaded and icons are definitely visible. The saved coordinates are
   used directly for both Like and Share; no second screenshot is taken.
2. **Minimum watchMs floor raised 400 → 1500 ms** — ensures even a 1-second
   story gives the bot enough runway to watch and act before it auto-advances.
3. **Like → Share inter-tap gap cut 400–600 ms → 100 ms** — once Like lands
   (no keyboard = confirmed success), Share is tapped almost immediately so the
   story has no gap to advance between the two actions.

---

## [1.1.478] — 2026-07-11

### Fix (real root cause this time): phone screen turning on just from opening the Mobile tool
Every previous attempt at this bug (getprop caching, removing app-level
wakeScreen calls) missed the actual cause: the vendored scrcpy-server is
started with `power_on=true`, which is scrcpy's own built-in behavior —
it forces the physical screen on the instant its mirror session starts,
completely independent of any wakeScreen()/sleepScreen() call this app
makes. Since the live-mirror view auto-connects whenever the automation
toggle is left on from a previous session (by design, so you can watch
an in-progress run), simply reopening the Mobile tool after a restart —
with the toggle still on from before — silently started a mirror
session, which woke the screen. Changed to `power_on=false`: the mirror
now shows whatever state the screen is already in instead of forcing it
on. The automation cycle's own explicit wake step (used when it actually
needs the screen) is untouched.

### Fix: story Like/Share taps swapped — a message-field tap landed first
On a story with the reply bar showing, a tap meant for Like landed in
the "Type a message" field instead, then (after backing out of that) the
tap meant for Share landed on the real Like button instead of Share.
Root cause: Instagram lays this bar out as [message field] [heart]
[paper-plane], left to right — the detection code assumed the leftmost
bright cluster it found was always the Like icon, but a stray fragment
of the message-field's placeholder text can pass the existing
icon-shape filter and sit to the left of the real heart, which then
shifted every index over by one (the fake entry became "Like", the real
heart became "Share"). The real Like and Share icons always sit right
next to each other with a small, consistent gap; a text fragment is
isolated from them by a much bigger gap. The scan now measures the gaps
between candidate clusters and drops anything separated from the
tightly-packed real icon group by an outsized gap, so a leftover text
fragment can no longer be mistaken for an icon.

### Improved: Log tab now shows story Like/Share detection detail
Every story Like/Share attempt now logs what the icon scan actually
found (coordinates, count) and the outcome of the tap (liked, opened
share sheet, hit the keyboard by mistake and backed out, or skipped
because the icons weren't distinguishable) — so if this class of bug
resurfaces, the Log tab shows exactly what was detected instead of
requiring another live reproduction to diagnose.

---

## [1.1.477] — 2026-07-11

### Fix: story-tray tap could hit a "Suggested for you" follow badge instead of viewing the story
Instagram overlays a small "+"/follow badge on the bottom-right corner of
some story-tray bubbles (accounts you don't follow yet). The tap point
used to land dead-centre on the bubble, which for those accounts could
land on the badge and silently follow them instead of opening their
story. The tap is now biased toward the upper-left of the bubble, away
from that corner, and — since blind coordinate tweaks alone have missed
before — the code now also verifies the tap actually opened a story
(checking that the feed's bottom nav bar is gone) and logs the outcome
either way, so a still-wrong tap shows up clearly in the Log tab instead
of failing silently.

### Fix: closing Instagram via Recents could miss the card on grid-style overview layouts
The close-Instagram step assumed the recent-apps switcher always shows
one card centred on screen and swiped left from the middle. Some OEM
overview layouts (confirmed from a screenshot: MIUI showing two recent
apps side by side) don't centre a single card there, so the blind swipe
could miss it entirely. The routine now reads the accessibility tree for
the actual "Instagram" card each attempt and swipes it away from its own
real position (or falls back to the old centred guess if the label isn't
found), logging which path ran and whether Instagram was confirmed
closed after each attempt.

### Fix: phone screen lighting up just from opening the Mobile Farm tool
Opening the Mobile tool (or the page remounting after a server restart)
made the connected phone flicker/wake, even with no automation running.
Cause: the device list endpoint re-ran 2–3 `adb shell getprop` calls for
every connected phone on every 3-second poll, forever, for as long as the
tab was open — each one re-touches the USB link to the device. Those
properties (manufacturer, Android version, model) never change while a
phone stays plugged in, so they're now read once per connection and
cached, cutting that repeated `adb shell` traffic to near zero.

### Diagnostics: richer Log tab detail for stories and closing Instagram
Both fixes above also add step-by-step log lines (tap coordinates,
whether a detected UI element was used or a fallback guess, and the
verified before/after Instagram-running state per attempt) so the next
round of tap-position debugging has concrete evidence to work from
instead of another guess.

---

## [1.1.476] — 2026-07-11

### Fix: feed Like tapped the wrong post's icon, opening a reply box instead
On a normal feed post, a Like tap sometimes opened a reply/message
compose box (mistaken by you for a Comment tap) instead of liking the
post, even though the same detection logic had just fixed this exact
class of bug for Stories/Reels.

**Root cause:** Android's RecyclerView-backed feed keeps the post
scrolling out of the top of the screen and the post/Reel-repost card
scrolling into the bottom BOTH alive in the accessibility hierarchy
during a scroll — so `uiautomator dump` can report more than one
`content-desc="Like"` node at the same time. The code took the FIRST
one it found in document order, which is not necessarily the post
actually centred on screen. When it picked the wrong post's Like
button, the "everything else on that row" scan (`findFeedActionIcons`)
swept in unrelated elements from a totally different card — including
a Reel/repost card's wide message/reply text field — and, by
elimination, mistook it for Comment/Repost/Send.

**Fix:** the Like-button scan now always selects the node closest to
the vertical centre of the screen (the post actually being viewed),
not just the first match. The row-scan also now rejects any clickable
element wider than a real action icon (and explicitly excludes
`EditText` compose fields), so even if a wide reply box ever lines up
on the same row as the correct Like button, it can never be mistaken
for one of the small square icons.

---

## [1.1.475] — 2026-07-11

### New: Copy button on the Log panel
Added a "Copy" button next to Clear on the Mobile Log tab — copies the
full visible log to your clipboard in one click, so you can paste it
straight into a bug report without selecting text by hand.

### Fix: story Like/Share could open the reply keyboard instead of tapping the icon
On a story with only the Like icon available (comments/shares disabled
by the owner), the like/share automation sometimes tapped into the
reply text box and opened the keyboard instead of liking or sharing —
even though the very next story, which had all 3 icons, worked
correctly.

**Root cause:** the story icon bar has no accessible elements at all
(Instagram draws it on a canvas), so icons are located by scanning
on-screen pixels for small bright clusters against the dark bottom
scrim. The reply box's placeholder text ("Send message") sits in that
same region and can itself split into a couple of bright, icon-sized
clusters. When a story has just one real icon (the heart), that
placeholder-text row can end up with *more* clusters than the real
one-icon row and win the row-selection tie-break, so the tap lands on
the text field instead of the heart.

**Fix, two layers:**
1. Icon rows now also require their clusters to be similar widths to
   each other — real icons are all the same size, while the
   placeholder's "words" ("Send" vs "message") vary a lot more in width,
   so uneven rows are no longer treated as a valid icon bar.
2. As a backstop, after tapping a detected Like or Share icon the bot
   now checks whether the on-screen keyboard actually opened. If it did,
   that tap hit the wrong control — it immediately backs out (no typing,
   nothing sent) and logs it clearly as a missed like/share rather than
   leaving a half-open reply box or silently miscounting it as
   successful.

---

## [1.1.474] — 2026-07-11

### Fix: feed Like/Share taps hit the wrong icon when a post had comments or shares disabled

While scrolling the main feed, a share action opened the Comment
reply/compose box instead of the intended Share sheet. Root cause: the
feed's Like button position was found dynamically per post (via the
accessibility tree), but Comment/Share-to-Feed/Share-via-DM were still
tapped at fixed 30.4%/48.1%/66.0% screen-width offsets measured once from
a single screenshot where all four action-bar icons happened to be
present. Post/profile owners can disable comments and/or shares
individually per post, which removes that icon from the bar and shifts
everything after the gap to the left — so those fixed offsets only ever
lined up with the right icon by coincidence. On a post with fewer icons
than that reference screenshot, the "share" X landed on whatever the
Comment button had shifted into, opening the reply keyboard instead.

**Fix:** added `findFeedActionIcons()`, which reads the real
accessibility tree for whatever post is on screen right now and works
out each icon's actual position (or its absence) instead of assuming a
fixed layout — the same principle already applied to the story-viewer
like/share fix. Since Instagram doesn't reorder these icons, only omits
disabled ones, their identity can usually be worked out for certain by
elimination (e.g. if all 3 of Comment/Repost/Send are present, order
alone fixes which is which; if Comment is positively labeled and exactly
2 icons remain, those must be Repost + Send). When the remaining icons
can't be told apart with confidence, the action is skipped for that post
entirely rather than guessing — the same "skip rather than risk the
wrong control" rule used for stories. Like tapping is unaffected; this
only changes how Comment/Share-to-Feed/Share-via-DM icons are located.
The log now also records which of Comment/Share-to-Feed/Share-via-DM
were detected on each post, to make this easier to diagnose from the Log
tab if it ever needs a closer look on a specific device/layout.

---

## [1.1.473] — 2026-07-11

### Fix: story like/share taps missed on reposted Reels and privacy-restricted stories

Story likes and shares were blind-tapping a single hardcoded screen
coordinate. A `screen-layout-scan` on a real device showed why that could
never work: Instagram draws the story action bar entirely on canvas with
**zero accessible child elements** — there is no content-desc, text, or
resource-id for "Like" or "Share" to search for in the story viewer. Worse,
that bar's position and icon count both change depending on content —
reposted Reels use a different, higher bar than a plain story — and per-story
owner settings (likes/comments/shares can each be individually disabled,
which removes icons and re-centers the rest). One fixed `(x%, y%)` pair could
only ever match one of those layouts; on every other layout the tap landed on
the reply text field or the story background and silently did nothing.

**Fix:** added a pixel-based icon locator (`findStoryActionIcons` in
`androidManager.ts`) that captures a real screenshot via
`adb exec-out screencap -p`, decodes it with a small dependency-free PNG
decoder (Node's built-in `zlib`, no new packages), and scans the bottom of
the screen for Instagram's dark gradient scrim plus the bright icon glyphs
sitting on it. Instagram always keeps Like leftmost and Share/Send rightmost
regardless of how many icons sit between them, so the story loop now taps
whichever icon is actually on screen instead of a guessed spot. If only one
icon is found (can't distinguish Like from Share) or none at all (that story
has them disabled), the action is skipped rather than risking a tap on the
wrong control. If the screenshot approach is unavailable on a given device,
it falls back to the previous accessibility-tree/fixed-coordinate behavior so
nothing regresses. Feed-level like/share logic is untouched — this only
changes the story-viewing loop.

### UI: merged "View Stories from Feed" into the Step 2 card

"View Stories from Feed" was showing as its own step (STEP3) even though it
runs as part of the same feed-viewing pass as the like/share settings above
it — there's no separate step 3 in the actual automation cycle. It now lives
inside the Step 2 card, under a border separator beneath the like/share
settings, with its own "(STEP3)" label removed. Added a bit more breathing
room between the "(STEP2)" label and the "View Feed" title.

---

## [1.1.472] — 2026-07-11

### Fix: mirror catch-up lag (spawnSync→async) + Send button never pressed

**Mirror "10–20 second black then catch-up" — root cause found and fixed:**  
`_uiDump` (every UIAutomator accessibility dump) used `spawnSync`, which
blocks Node's **entire** event loop while it runs — typically 4–5 s on this
device. While blocked, `ws.send()` calls queued up in `ws.bufferedAmount`
since Node had no cycles to flush the socket. After the `spawnSync` returned,
`bufferedAmount` was well past the 800 KB watchdog threshold → watchdog fired
→ killed screenrecord → client cleared decoder and canvas → new screenrecord
started → "catch-up." This happened on every UIAutomator call (ads-choice
check, interstitials check, `isFeedbackOrSurveyCard`, `findLikeButton`, etc.)
— multiple times per cycle.  
**Fix:** `_uiDump` now uses async `spawn` with Promise wrappers and explicit
kill-on-timeout. The event loop is free during the entire dump, the video
WebSocket flushes normally, `bufferedAmount` stays near zero, the watchdog
never fires spuriously. No logic changes — identical timeout values (5 s dump,
4 s pull), just non-blocking.

**Share-to-DM "Send" button never pressed:**  
Two problems: (1) the wait after tapping the recipient avatar was 700 ms —
not long enough for Instagram to render the blue Send button. (2) The fallback
when `findButtonByLabel("Send")` returned null was `pressBack`, which
dismissed the sheet instead of sending.  
**Fix:** wait increased to 1500 ms. `sendShareSheet` now accepts `w, h` and
falls back to a coordinate tap at `(w×0.422, h×0.948)` — the consistent
screen position of the Send button across all tested Instagram versions —
so a DM share always completes even if the UIAutomator label lookup misses.

---

## [1.1.471] — 2026-07-11

### Fix: strip client-side frame-drop / clientLag loop (back to basics)

The frame-drop + bidirectional lag-signal code added in v1.1.469 created a
self-reinforcing feedback loop:

1. `decodeQueueSize > 8` → skip every non-keyframe
2. Keyframes arrive ~1–2×/sec → effective frame rate collapses to ~1 fps
3. Queue never drains because no delta frames are being decoded
4. `lagSinceRef` fires → send `{ clientLag }` to server → server kills screenrecord
5. Client flushes decoder + clears canvas → blank screen
6. New screenrecord starts → back to step 1

**Fix:** removed all client-side queue inspection, frame dropping, `lagSinceRef`,
and `clientLag` signal entirely. The decode loop is now: demux → configure if
needed → `decoder.decode()` → done. WebCodecs drains its own queue at GPU
speed; the server-side `ws.bufferedAmount` watchdog (original design, never
removed) handles genuine TCP send-buffer backlog without any client involvement.

---

## [1.1.470] — 2026-07-11

### Fix: mirror colour revert (pink tint), UIAutomator 20s silent hang

**Mirror colour — revert sRGB canvas (pink/red tint introduced in v1.1.469):**  
Forcing `colorSpace: "srgb"` on the 2D canvas context caused the browser to
apply a BT.601→sRGB chroma conversion on every VideoFrame blit. Android
screenrecord H.264 has no VUI colour info, so WebCodecs defaults to BT.601;
converting BT.601 to sRGB inverts the Cb/Cr signs — producing a strong
pink/red tint across the entire mirror. Reverted: `getContext("2d")` with no
colour-space option passes YCbCr through unchanged, which matches what the
phone display actually shows. Context caching is retained (no perf regression).

**UIAutomator 20-second silent hang:**  
`_uiDump` (UIAutomator accessibility dump) had a 10 s `spawnSync` timeout.
During the Instagram splash/loading screen the accessibility tree is being
rebuilt continuously; UIAutomator consistently timed out at the full 10 s,
then the `adb pull` added another 6 s — 16 s per call, invisible in the log.
Two calls in `dismissAdsChoiceDialog` = the 20-second black hole seen between
`[4.6s] Checking for launch dialogs` and `[24.9s] Starting feed scroll`.  
**Fixes:**
- `_uiDump` hard timeout: 10 000 → 5 000 ms (adb shell), 6 000 → 4 000 ms (adb pull)
- Added `tLog` lines before AND after every dialog scan call:  
  `UIAutomator: scanning for ads-choice dialog…` → `No ads-choice dialog — continuing`  
  `UIAutomator: scanning for other launch popups…` → `No launch popup — feed ready`  
  Every second of the startup sequence is now visible in the Log tab.

---

## [1.1.469] — 2026-07-11

### Fix: mirror lag, blue tint, IG open delay, log timestamps

**Mirror lag — bidirectional resync:**  
The server-side lag watchdog only detected backlog in the TCP send buffer
(`ws.bufferedAmount`). If the client's GPU WebCodecs decoder fell behind (the
client received frames fast but decoded them slowly), the server never noticed
and the lag compounded forever. Added client→server `{ clientLag }` signal:
when the client's decode queue has been over 8 frames for >800 ms it sends the
signal, the server immediately kills and restarts screenrecord, and the client
clears its decoder and canvas simultaneously — lag collapses to near-zero on
the very next keyframe (~0.5 s) instead of draining the old backlog.

**Blue discoloration — colour space fix:**  
Android's screenrecord outputs H.264 with BT.601 implied by the profile (no
VUI colour info), but the phone's display is BT.709/sRGB. The canvas
`getContext("2d")` was called fresh every frame with no `colorSpace` option, so
the browser defaulted to BT.601 matrix for the VideoFrame→canvas blit — the
resulting colour shift was most visible in the status-bar blue tones in the
top-right. Fix: `getContext("2d", { colorSpace: "srgb", alpha: false })` is
now called once and cached; `colorSpace:"srgb"` forces the sRGB pipeline that
matches Android's display, eliminating the tint. The canvas also immediately
clears to black on every decoder reset so no stale frame bleeds through.

**Bitrate 8 → 4 Mbps:**  
Halves the data volume per second which directly halves how fast the decode
queue fills. Mirror quality at 4 Mbps over USB is unchanged.

**IG open delay reduced:**  
- Post-launch wait: 2000 ms → 1200 ms  
- `dismissAdsChoiceDialog` taps: 1200/500/1200/1200 ms → 800/400/800/800 ms  
Total saving when the ads dialog appears: ~2.4 s.

**Log tab — elapsed timestamps:**  
Every automation step log line now starts with `[Xs]` elapsed time so the
user can see exactly which step is taking time (e.g. `[4.2s] ▶ Checking for
launch dialogs…`).

---

## [1.1.468] — 2026-07-11

### Fix: video mirror DRM restart speed + share-DM tapping wrong target

**Video mirror — 4 s restart when DRM-blocked:**
The "no real frame yet" stall threshold was 8 s (v1.1.467), which was actually
*slower* than the original 6 s constant timeout. On MIUI/Xiaomi, scrcpy gets
DRM-blocked the moment Instagram's feed loads video content — the stream
produces only a 46-byte metadata packet then goes silent. The old 6 s constant
meant scrcpy cycled quickly and would occasionally catch a real frame in the
brief window between DRM re-engagements. Raising it to 8 s made those
catch-windows rarer, which is why the mirror appeared worse.
**Fix:** drop the "no real frame" threshold to 4 s (faster than before).
The three tiers are now:  
- No real IDR frame yet → **4 s** (aggressive restart, punch through DRM)
- Real frames flowing + automation active → **30 s** (UIAutomator patience)
- Real frames flowing + idle → **6 s** (normal watchdog)

**Share-DM — tapping drag-handle instead of user bubble:**
The avatar slot y-coordinates (0.625 / 0.740) were calculated assuming the
share sheet starts at ~50% of screen height. A live accessibility dump on the
user's 1080×2226 device showed the sheet actually starts at y=1651 (74.2%):
- y=0.625 × 2226 = 1391 px → above the sheet entirely (taps the post behind it)
- y=0.740 × 2226 = 1647 px → right at the drag-handle pill (y≈1672), which
  causes the sheet to **expand to full screen** instead of selecting a recipient.
  This was the "clicking to expand to see more users" bug.
**Fix:** updated all four avatar slots to y=0.786 (y=1749 on this device,
measured directly from the scan) with x positions measured from the scan:
- Bubble 1: x=0.151 (163 px)
- Bubble 2: x=0.328 (354 px)
- Bubble 3: x=0.487 (526 px)
- Bubble 4: x=0.642 (693 px)

---

## [1.1.466] — 2026-07-11 (hotfix included)

### Fix: Human Session Tool stalls + empty log during automation cycles

**Root cause — three separate problems found from the log:**

1. **Stall watchdog was too aggressive during automation** — the 6-second
   no-data threshold is correct for an idle mirror session (screen off = stall
   immediately). But during an active automation cycle the phone is busy running
   adb commands: each `dismissAdsChoiceDialog` and `dismissInstagramInterstitials`
   call fires a UIAutomator accessibility dump that takes 1–2 s, and they're
   called in sequence — `dismissAdsChoiceDialog` + `dismissInstagramInterstitials`
   on launch + `dismissInstagramInterstitials` on each scroll. On a loaded MIUI
   device these can chain to 4–6 s with no screenrecord output, which fired the
   watchdog right in the middle of legitimate work. The watchdog killed
   screenrecord, the restart got a brief burst of frames (resetting the
   `stallNotified` flag), then stalled again — causing the repeating "Stream
   stalled" messages seen in the log.
   **Fix:** stall threshold raised from 6 s → 30 s while
   `automationCycleInProgress` contains this serial. Drops back to 6 s the
   moment the cycle ends. The stall message is also updated to say
   *"Stream paused — automation busy (UIAutomator / adb). Restarting stream…"*
   instead of "screen may be off" when automation is active.

2. **Log panel was completely blank during automation** — the cycle runs as a
   single blocking HTTP POST. No intermediate steps were ever pushed to the
   client. The user saw "Cycle starting" then silence, assumed everything was
   frozen, and turned off the toggle — aborting a cycle that was actually
   running fine.
   **Fix:** added a `videoSessionWS` map (`serial → WebSocket`) that the video
   stream handler populates when a client connects and clears on disconnect.
   Added `sendVideoLog(serial, msg)` helper that pushes `{ info: msg }` through
   that socket. The Log panel now shows real-time step-by-step progress from
   the automation backend:
   - `▶ Waking screen…`
   - `▶ Unlocking screen…`
   - `▶ Opening Instagram…`
   - `▶ Checking for launch dialogs…`
   - `▶ Starting feed scroll — N posts`
   - `  Scroll 1/3`, `  Scroll 2/3`, `  Scroll 3/3` (per-scroll via `onLog`
     callback added to `runCheckFeedLoop`)
   - `▶ Feed done — N likes, N feed-shares, N DM-shares`
   - `▶ Starting stories (up to N)` / `▶ Stories done — N watched`
   - `▶ Closing Instagram…`
   - `▶ Airplane mode ON — recycling network…` / `▶ Airplane mode OFF`
   - `▶ Locking phone — cycle complete ✓`

3. **Video delay does NOT cause automation delay** — the automation sends adb
   commands directly to the phone, completely independently of the video
   stream. The video is for monitoring only. The user was seeing a false
   correlation: the automation was running fine while the video stream stalled.
   With the new progress messages this is now self-evident from the log.

---

## [1.1.465] — 2026-07-11

### UI: Redesigned Mobile sidebar icon; Windows installer CI now builds on every push to main

**Redesigned Mobile nav icon** — The Mobile entry in the left sidebar now uses a
redrawn smartphone icon. The previous icon was a plain rectangle with a flat screen
cutout and a thin home-indicator bar. The new icon is modelled on a modern Android/
iPhone form factor:

- **Punch-hole camera** — a small filled circle centred at the top of the phone body
  replaces the old featureless top bezel, making the icon immediately readable at the
  32 × 32 px size it renders at in the sidebar.
- **Side buttons** — two volume buttons on the right edge and a power button on the
  left edge are rendered as low-opacity rounded rectangles. They add depth and silhouette
  detail without cluttering the icon at small sizes.
- **Pill home indicator** — slightly wider and taller than the previous thin bar, keeping
  the modern full-screen phone language.
- **Tighter body proportions** — the phone body now uses `rx=3.5` (was `rx=2.5`), giving
  it more pronounced rounded corners that match the iOS/Android aesthetic.

No behaviour, routing, or data is affected — purely visual.

**Windows installer CI trigger extended to push → main** — `build-windows-installer.yml`
previously only ran on `v*` tag pushes and manual `workflow_dispatch`. It now also
triggers on every push to the `main` branch, so a fresh `Equinox-Installer` artifact is
produced automatically after each commit without needing to cut a tag. The artifact is
uploaded to GitHub Actions as before; the `Publish to GitHub Release` step still only
runs on tag pushes, so no spurious releases are created from regular commits.

---

## [1.1.464] — 2026-07-11

### Fix: Mirror lag, app-open delay, share-sheet expansion bug; remove stories tooltip

**Mirror stream lag (up to 10 seconds behind)** — Two-layer fix:

*Server side:* The lag watchdog threshold was lowered from 2 MB to 800 KB (~0.8 s of
video at 8 Mbps) and the poll interval halved from 1 s to 500 ms, so the server
detects a backing-up send buffer and kills/restarts screenrecord twice as fast.

*Client side (the real fix):* When the server restarted screenrecord, the WebCodecs
decoder still had a large queue of old frames to drain before it would show the new
live ones — meaning the visible lag persisted even after the server restart. Now:
(a) On receiving the server's "resyncing" info message, the client immediately flushes
and closes the decoder, so old queued frames are dropped instantly.
(b) Client-side backpressure gate: if `decoder.decodeQueueSize > 8`, delta (non-key)
frames are skipped until a keyframe arrives. If the queue exceeds 20 even on keyframes,
the decoder is hard-flushed. This caps lag at well under 1 s without server involvement.

**Instagram app sits for ~10 seconds before scrolling starts** — Two sources of dead
time were cut:

*Initial app launch:* The fixed wait after `launchInstagram()` was reduced from 3 500 ms
to 2 000 ms. The `dismissAdsChoiceDialog` and `dismissInstagramInterstitials` calls that
follow each do a full UIAutomator accessibility dump (~1–2 s each), so the total pre-
scroll pause is still adequate for app loading but no longer has a dead 3.5 s visible
pause while the feed is already loaded.

*After feed-scrolling ends, before stories:* The fixed wait for the story tray to
repopulate after tapping the Home tab was reduced from 10 000 ms to 5 000 ms. The 10 s
value was a conservative upper bound from an early test; on the user's device the tray
reliably reloads in 3–5 s, making the second half of the 10 s wait pure dead time.

**Share-to-DM broke the flow — tapping a user expanded the list instead** — The
`SHARE_SHEET_AVATAR_SLOTS` y-percentages (0.525 and 0.667 of full screen height) were
landing too high in the "Send to" bottom sheet. On the user's 1080×2226 device:
- 0.525 × 2226 ≈ 1169 px → right on the sheet's search bar
- The sheet's drag-handle sits at ~50 % Y, so taps at 52.5 % were near the drag zone
- When Android interprets a tap near the drag handle as a swipe, the sheet expands to
  full screen — exactly what the user described ("scrolled upwards / expanded the list")

Fixed by moving both rows down to y=0.625 (1391 px) and y=0.740 (1647 px), which land
squarely in the avatar/conversation rows, well clear of the handle and search bar.

**Removed tooltip text** from the Stories settings panel (the "Set stories to 0 to skip.
Opens one random story bubble…" paragraph the user asked to delete).

---

## [1.1.463] — 2026-07-11

### Fix: Share-to-DM never actually sent, story likes never landed

Diagnosed from a screen-layout scan + screenshot the user provided of the
real Share sheet, and a scan taken mid-story.

**Share-to-DM (feed posts and stories) never sent anything.** Both flows
tapped the paper-plane/share icon to open the recipient picker, then just
pressed Back — no recipient was ever selected and Send was never tapped.
It only ever opened and closed the sheet.

**Fix:** After opening the picker, tap a random recipient avatar from the
quick-share grid (calibrated from the user's screenshot — a 3×2 grid of
avatars below the search box), wait for the checkmark/Send button to
appear, then look up and tap the real "Send" button via the accessibility
tree (same reliable by-label lookup already used for Repost/Close). If Send
can't be found, it falls back to Back so a stuck sheet can't block the
rest of the cycle. Applies to both the feed's share-via-DM action and a
story's share-via-DM action.

**Story likes were never clicked.** `findLikeButton()` was expected to work
in the story viewer the same way it does in the feed, with a fixed-pixel
fallback (15.1% X, 97.8% Y) if it didn't. A fresh screen-layout scan taken
mid-story showed the story viewer exposes only 3 opaque containers total —
there is no accessible Like element in stories at all, so it always fell
through to the fallback tap — and that scan also showed the real
reply/action bar sits at 92.4–93.8% Y (center ~93.1%), not 97.8%. The old
Y value was tapping below the actual bar, missing the heart entirely.

**Fix:** Corrected the story like/share-icon fallback Y coordinate to
93.1%.

**Caveat:** neither fix has been verified against a live device in this
sandbox (no adb/device access here) — the DM-recipient-grid and story
action-bar coordinates are calibrated from the screenshot/scan the user
supplied, not confirmed live. Please test a cycle and report back if a
tap still misses.

---

## [1.1.462] — 2026-07-11

### Fix: Mirror lag/FPS drift + close-all-apps only dismissed one stray app

**Mirror lag / "no longer 30fps":** The live H.264 mirror (`/api/mobile/video/:serial`)
piped `screenrecord`'s stdout straight into `ws.send()` with no backpressure
check. If the browser (or the Node event loop itself — e.g. some *other*,
unrelated code change adding a slow synchronous block) couldn't drain the
socket as fast as the device produced video, Node silently queued the
backlog in `ws.bufferedAmount` forever. TCP/WS backpressure doesn't
self-correct: once the queue starts growing, the stream keeps falling
further behind real time — which looks exactly like "stopped being smooth
30fps" / "awful lag" — and previously only a full page reconnect cleared it.

**Fix:** Added a 1s-interval watchdog per mirror session. If
`ws.bufferedAmount` backs up past ~2 seconds of video (2MB at the stream's
8Mbps bit rate), it kills the current `screenrecord` process — the existing
restart logic immediately relaunches it with a clean IDR frame and an empty
send queue — instead of leaving the growing backlog to compound for the
rest of the session. Lag is now bounded and self-healing rather than
sensitive to whatever else the process happens to be doing at the time.

**Close-all-apps only swiped away one card:** `closeInstagramViaRecents()`
opened the recents switcher and swiped away exactly one card. When more
than one app ends up stacked in recents — an accidental tap opened
something, or the phone's own background activity launched an app on top
of Instagram — only the topmost card got dismissed, leaving the others
still open for the next cycle.

**Fix:** The "open recents, swipe the top card left" gesture now repeats
5 times in a row at the end of the flow before the cycle continues. Each
pass is a no-op once recents is already empty, so this is safe even when
there was only ever one app to close.

---

## [1.1.461] — 2026-07-11

### Fix: Mobile feed loop was acting on non-post content (ads, embedded Reels, Instagram's own "feedback" / snooze cards)

**Root cause:** Instagram doesn't always serve a normal post in the feed —
sometimes it's an embedded Reel, a sponsored ad, or (after its own
suggested-content flow fires) a "Thanks for your feedback" card with
"Undo" / "Snooze all suggested sets of reels in feed for 30 days" /
"Manage content preferences". None of these expose the same Like/Share/Send
action row a normal post does. Share-to-feed and share-via-DM tapped fixed
on-screen coordinates regardless of what was actually on screen, so when one
of these non-post cards took a post's place, the tap landed on "Undo",
"Manage content preferences", or whatever else happened to be there instead
— derailing the rest of the cycle. This is what caused the accidental
feedback-form click reported during a live run.

**Fix — `runCheckFeedLoop` (`artifacts/api-server/src/routes/mobile.ts`) now
gates every action on a confirmed action bar:**
1. Like/share-feed/share-DM chances are still rolled independently up front
   (same statistics as before), but nothing is tapped until the current
   screen is checked.
2. New `android.isFeedbackOrSurveyCard()` detects Instagram's feedback/snooze
   card by its on-screen text ("Thanks for your feedback", "Snooze all
   suggested", "Manage content preferences", "See fewer/more posts like
   this", ad-rating prompts). If present, all three actions are skipped for
   that item — no tap fires at all, and the loop just scrolls past.
3. Otherwise, `android.findLikeButton()` is used as the actual-post check.
   If no Like button is found on screen (embedded Reel, ad, or content still
   animating in from the scroll), like, share-to-feed, and share-to-DM are
   *all* skipped — previously only the like was skipped while share-to-feed
   and share-to-DM still fired blind.
4. When a Like button **is** found, its real Y position (`rowY`) is used to
   position the share-to-feed and share-to-DM taps, instead of a separately
   guessed fixed action-bar percentage — this keeps the three actions
   aligned to the actual post on screen even when its height differs from
   the last one (carousel, longer caption, etc.).

**New helper:** `isFeedbackOrSurveyCard(serial)` in `androidManager.ts` —
single ui-dump text match against Instagram's known feedback/survey/ad-rating
card strings.

This can't guarantee Instagram never serves something unusual, but the tool
now only clicks like/share/DM when it has positively confirmed a normal
post's action bar is on screen — it no longer taps blind at a fixed spot and
hopes a real post is still there.

---

## [1.1.460] — 2026-07-11

### Fix: Share button coordinates were hitting Comment → Reels tab triggered

**Root cause:** `shareIconX` was set to 33% X, which landed exactly on the
Comment button (scan-confirmed bounds 27–34% X). Opening the comment section
caused every subsequent share-flow tap to miss, and the swipe-to-dismiss
(going to 90–95% Y) crossed the bottom nav bar, where the Reels tab at 50% X
got triggered — sending the phone to the Reels section mid-cycle.

**Fix — correct coordinates (confirmed from screen-layout scan, 1080×2226):**
- Share to feed (circular arrows / repost): 48.1% X, 70.2% Y
- Share to DM (paper plane): 66.0% X, 70.2% Y
- Action bar Y: 70.2% (was 72%)

**Fix — share-to-feed flow now uses the accessibility tree:**
1. Tap the repost icon at correct coords
2. `findButtonByLabel("Repost")` — finds the Repost button in the share sheet
   via ui-dump rather than guessing a fixed percentage position
3. After tapping Repost, `findButtonByLabel("Close")` detects the first-time
   "You reposted X's post" confirmation popup and taps its blue Close button
4. If "Repost" is not found in the sheet (didn't open), `pressBack` to cancel

**Fix — share-to-DM dismiss changed to `pressBack`:**
The old swipe-to-dismiss was the direct cause of the Reels tab tap. Using
`pressBack` closes the DM picker safely with no nav bar risk.

**New helper:** `findButtonByLabel(serial, label)` in `androidManager.ts` —
finds any clickable element by exact text/content-desc match via ui-dump.

**UI:** All 5 stories settings (Stories to watch, % to watch, Like %, Share DM %)
collapsed onto a single flex row.

---

## [1.1.459] — 2026-07-11

### Rework: Stories settings — total story count, per-story like %, per-story share DM %

**Removed:** "Users to watch" — the concept of per-user story sessions is gone.

**Renamed:** "Slides per user" → **"Stories to watch"** (min/max). This is now
the total number of story slides watched in one session regardless of which
account they belong to. Set both to 0 to skip story viewing entirely.

**Behaviour change:** The bot taps one random story bubble to open the viewer,
then advances through stories one at a time (tap right side) until the
configured count is reached, then swipes down to exit. No separate "user"
loop.

**Added:** **"Like stories %"** (min/max). Per-story chance to tap the heart
icon. Uses the accessibility tree (`content-desc="Like"`) with a pixel-
coordinate fallback (15.1% X, 97.8% Y from the scan on the user's device).

**Added:** **"Share stories via DM %"** (min/max). Per-story chance to tap
the paper-plane / send icon (43.2% X, 97.8% Y), open the DM picker, then
close it without sending — registers the share intent in a human-looking
way.

All three new percentage fields default to 0 (opt-in).

---

## [1.1.458] — 2026-07-11

### Fix: automation now dismisses Instagram interstitial popups automatically

Instagram randomly shows blocking popups mid-cycle ("Your notifications are
off", "Save your login info?", permission dialogs, etc.). Previously these
would silently stall the automation since every subsequent tap would land on
the popup instead of the feed/story.

New `dismissInstagramInterstitials()` function in `androidManager.ts`:
- Does a quick ui-dump and looks for any of these dismiss labels in order:
  "Not now", "Skip", "Maybe Later", "No thanks", "Later", "Dismiss",
  "Don't Allow", "Deny", "Cancel"
- Taps the first match and waits 600 ms for the modal to close
- Never taps positive-action buttons ("Turn on", "Allow", "Continue") so
  it can't accidentally grant unwanted permissions

Called automatically at three points per cycle:
1. **After Instagram launches** — catches the notifications prompt that
   often appears on first open
2. **Every feed scroll** — catches popups that appear mid-browse
3. **Before story viewing starts** — catches the notifications prompt that
   often fires again when the feed refreshes after tapping Home

If nothing needs dismissing the call is a no-op (one fast ui-dump, no tap).
Dismissed popup labels are recorded in the cycle `steps` log.

---

## [1.1.457] — 2026-07-11

### Improve: "Scan Story Tray" → "📋 Scan Screen Layout" (general-purpose)

The old scanner only looked at the top 20% of the screen and silently
skipped any element without a content-desc/resource-id/text label —
which is exactly why Instagram's story bubbles showed up as "no named
elements found" (they have no accessibility label at all).

The new `GET /api/mobile/devices/:serial/screen-layout-scan` endpoint:
- Scans the **entire screen**, not just the top strip
- Includes **every element** with a non-zero bounding box, labelled or not
- Reports pixel coordinates **and** screen-percentage equivalents so
  results are device-independent
- Groups elements into three vertical zones (top / middle / bottom)
- Marks clickable (tappable) elements with ● vs containers with ○
- Can be run before implementing any new tap or swipe feature to get
  real coordinates instead of guessing — avoids the 20-version guessing
  cycle that plagued the story-tray work

The Log-tab button is renamed to **📋 Scan Screen Layout** to reflect
that it works for any screen, not just the story tray.

---

## [1.1.456] — 2026-07-11

### Fix: like button was double-tapped (like then instantly unlike)

The automation was calling `doubleTap()` on the heart icon, which pressed
it twice in quick succession — once to like, once to unlike. Changed to a
single `tap()`. Double-tap belongs on the post image/video (the gesture
Instagram uses to like from anywhere), not on the dedicated button.

### Fix: story tray coordinates corrected from real screenshot data

Three wrong values in `pickAndOpenRandomStory()` were stacking up to make
the gesture consistently miss:

| Setting | Old | New | Why |
|---|---|---|---|
| `storyBarY` | `h × 8.5%` | `h × 14%` | 8.5% lands in Instagram's header bar above the tray; 14% puts the tap in the middle of the bubble row (verified against 1080×2226 screenshot) |
| `firstStoryX` | `w × 22%` | `w × 37%` | 22% lands on the user's own "Your story +" slot which opens the camera; first friend's bubble starts at ~37% |
| `spacing` | `w × 14%` | `w × 18.5%` | Measured bubble-to-bubble gap from screenshot; previous value compressed slots into each other |

### Fix: story opening gesture changed from swipe to tap

The "hold-and-slide-right" swipe was scrolling/flinging the story tray
(or accidentally hitting the Reels tab) rather than opening a story.
Opening a story on Instagram requires a **single tap** on the bubble.
`pickAndOpenRandomStory` now picks a random slot (1–4 visible friends)
and taps its centre directly — no swipe involved.

---

## [1.1.455] — 2026-07-11

### Add: "Scan Story Tray" button in the Log tab

Instead of asking the user to run adb commands in a terminal, a one-click
button now does the coordinate discovery for us:

1. User opens Instagram on the phone and navigates to the Home tab so the
   story tray is visible.
2. In the app, they open the **Log** tab and click **🔍 Scan Story Tray**.
3. The app calls a new `GET /api/mobile/devices/:serial/story-tray-scan`
   endpoint which runs `uiautomator dump`, parses every accessibility node
   whose vertical centre sits in the top 20 % of the screen, and returns
   the real pixel coordinates (plus resource-id / content-desc / text) for
   each named element found there.
4. Each line is printed directly into the Log panel — no terminal needed.

This tells us exactly what Y coordinate and element labels Instagram puts
on the story-tray row, so we can fix the tap/swipe coordinates with real
data instead of guessing percentages.

---

## [1.1.454] — 2026-07-10

### Fix: hold-and-slide gesture opened the Reels tab instead of a story

- The two-step tray navigation added in 1.1.452 (a separate swipe to
  scroll the tray when the random target wasn't on screen, followed by a
  second swipe to actually pick the bubble) was almost certainly the cause
  — two independent `input swipe` calls starting close to the top of the
  screen can each be misread as unrelated gestures instead of one
  continuous scrub, and something in that chain ended up on the Reels tab.
- Removed the separate scroll step entirely. `pickAndOpenRandomStory()` now
  does exactly ONE hold-and-slide-right gesture per pick, with the random
  target clamped to whatever bubbles are actually visible on screen (up to
  10) instead of scrolling to reach further ones.
- Tightened the story-tray Y coordinate to `h * 0.085` — per user
  confirmation the tray sits top-central and is a thin band (~15px tall on
  their device), so precision on Y matters more than X here.

---

## [1.1.453] — 2026-07-10

### Debug: added a raw UI-dump endpoint to stop guessing story-tray coordinates

- The hold-and-slide gesture in 1.1.452 landed on the Reels tab instead of a
  story bubble — screen-percentage guesses for the tray position/spacing
  have now been wrong twice (Home tab, then the story tray).
- Added `dumpUi()` (exported from `androidManager.ts`) and a debug endpoint,
  `GET /api/mobile/devices/:serial/ui-dump`, that returns the device's real
  accessibility tree (resource-ids, content-desc, on-screen bounds) so the
  next story-tray fix can target the actual elements instead of another
  percentage guess. No behavior change to the automation cycle itself in
  this release.

---

## [1.1.452] — 2026-07-10

### Fix: Stories step opened the viewer but never picked/clicked a story

- The Home-tab fix landed correctly (stories bar now visible at the top),
  but the tap that opens a story was still landing on nothing clickable.
- Replaced the fixed "tap the first story" behavior with a hold-and-slide
  gesture: press down on the story tray and slide right, releasing on a
  randomly chosen bubble (position 1-10, 1-indexed after "Your story") so
  the same bubble isn't always picked — added `pickAndOpenRandomStory()` in
  `mobile.ts`, which scrolls the tray first if the chosen position isn't yet
  on screen, then does the slide as one slow drag (900-1400ms) so it reads
  as a deliberate press-and-drag rather than a flick.
- Changed the between-users transition: once all slides for the current
  user are watched and more users remain, the story is closed with a
  *slight* downward drag back to the feed, and the pick-and-slide-right
  cycle runs again for the next user (rather than swiping left within the
  viewer as before). The last user still exits with a full downward swipe.

---

## [1.1.451] — 2026-07-10

### Fix: toggling on manually now runs the first cycle immediately again

- The 1.1.450 fix made the first cycle always wait the configured Run-every
  interval — but that also delayed the case where the user deliberately
  flips the toggle off then back on, which should still start right away.
- Added `setEnabledByUser`, used only by the master toggle's `onCheckedChange`.
  It marks a ref before flipping `enabled` on, so the run-loop effect can
  tell "user just turned this on" (run immediately) apart from "settings
  loaded with `enabled` already true" i.e. app restart with a phone's
  toggle left on from before (wait the configured interval, as fixed in
  1.1.450). Plain settings changes / initial load never set the ref, so
  restarts still wait as intended.

---

## [1.1.450] — 2026-07-10

### Fix: Home-tab tap landing on a feed post, and automation cycle firing instantly on toggle-on/restart

#### Fix: Stories step tapped a feed post instead of the bottom-nav Home icon

- The Home-tab tap before Stories used fixed screen percentages (10% width,
  97.5% height), which on this device/screen ratio landed on a post in the
  feed instead of the actual house icon in the bottom nav.
- Added `findHomeTab()` in `androidManager.ts`, which reads Instagram's
  accessibility tree for the bottom-nav Home tab (`content-desc="Home"`,
  with a resource-id fallback) and taps its real on-screen centre instead of
  a guessed position. Falls back to the old percentage tap only if the
  element genuinely isn't found.

#### Fix: Automation cycle ran instantly instead of waiting the configured interval

- When the master toggle was already on and the app restarted (or the
  toggle was flipped on), the automation cycle fired immediately instead of
  waiting a randomized delay from the "Run every X to Y minutes" setting.
- The effect that drives the cycle loop called `runCycle()` directly on
  mount. Now the very first cycle is scheduled with the same randomized
  min/max wait used between subsequent cycles, so enabling the tool (or
  restarting with it already enabled) always waits before the first run
  instead of executing on update/restart.

---

## [1.1.449] — 2026-07-10

### Fix: Mobile automation cycle — ads-consent modal and Stories not watching

#### Fix: Meta's "ads choice" consent screen silently blocked the automation cycle

- Instagram occasionally shows a full-screen EU/UK ads-consent modal on
  launch ("Make a choice about your ads" → **Get started** → select **Use
  for free with ads** → **Continue** → **Agree**). It's a full-screen overlay
  that blocks everything behind it, so once it appeared every subsequent
  scripted tap in the cycle (feed scroll, likes, stories) landed on the
  modal instead of the feed and the rest of the run silently did nothing.
- Added `dismissAdsChoiceDialog()` in `androidManager.ts`: takes a single UI
  dump after Instagram launches, and only acts if the dump actually matches
  the ads-choice screen (checks for "choice about your ads" / "Get started"
  text together with an ads reference) — it will not fire on unrelated
  dialogs that happen to share a button label. If it matches, it walks
  Get started → Use for free with ads → Continue → Agree in sequence,
  waiting for each screen to advance. No-op (one UI dump, zero taps) when
  the dialog isn't present.
- Wired into `automation-cycle` immediately after `launch-instagram` and
  before feed scrolling starts, with an extra 1s settle delay if the dialog
  was actually dismissed.

#### Fix: Stories (Step 3) not opening after feed scrolling — Home-tab wait was too short

- Reported symptom: after all feed scrolling finished, there was a 45+
  second wait, then the feed scrolled back to the top, and the Stories step
  finished immediately without anything actually being watched.
- Root cause: the automation cycle already tapped the Instagram bottom-nav
  Home icon to force the feed back to the top before starting the stories
  loop (this was a fix from a previous release), but only waited **1.5
  seconds** afterward before tapping the stories tray. The stories tray does
  not repopulate that fast after a Home-forced refresh — it needs up to
  ~10 seconds — so the tap landed on empty space, no story ever opened, and
  the stories loop ran through its timing with nothing on screen to show
  for it.
- Fix: increased the post-Home-tap wait from 1.5s to 10s in
  `runViewStoriesFromFeedLoop`'s call site in `automation-cycle`, giving the
  stories tray time to fully reload before the first story tap.

---

## [1.1.447] — 2026-07-10

### Account Settings, Inject Profile Browsing (Step 2), and Ghost Browser slot management

#### Feature: Delete button for each Instagram Account Slot

- **Account Settings (Mobile tab) now has a Delete button on every Instagram
  Account Slot row**, placed immediately after the 2FA "Generate" button.
  Clicking it removes that slot's username, password, and 2FA/TOTP secret
  fields, and keeps the per-slot UI state (show/hide password, generated TOTP
  code, TOTP error) correctly aligned with the remaining slots — no more
  need to blank out a slot manually to "remove" it.

#### UI: "+ Add Instagram Account Slot" button is now left-aligned and text-width

- Previously this button stretched the full width of the panel
  (`className="w-full"`). It is now wrapped in a left-aligned flex container
  and sized to fit its own label (`w-fit`), matching the left-aligned,
  content-sized style used elsewhere in Account Settings instead of looking
  like a stray full-width bar under the slot list.

#### Feature: "Share to Feed" percentage field added to Inject Profile Browsing (Step 2)

- **A new X–Y percentage field, "Share to Feed", now sits directly after the
  Like field** in the Inject Profile Browsing settings used by Step 2 of the
  automation config. When it fires, the engine clicks the double-arrow
  "share to own feed" button on a random post from the profile being
  browsed — the same underlying action already used by the timeline
  "Share Post" feature, `client.sharePostToFeed(mediaId)`, but now triggerable
  from profile browsing sessions with its own Min/Max chance and Min/Max
  queue-order weight (`injectProfileBrowsingShareToFeedPctMin/Max` and
  `injectProfileBrowsingShareToFeedPctOrderMin/Max`).
- **"Share via DM" (send to a random user) now sits directly to the right of
  "Share to Feed" on the same row**, right after Like. This existing field
  (`injectProfileBrowsingShareToDmPct*`) previously lived in its own row much
  further down the panel, disconnected from the Like/engagement fields it
  logically belongs with — the old standalone "Share to DM" row has been
  removed to avoid a duplicate control.

#### Backend: new "share to feed" action in the profile-browsing engagement queue

- The automation engine's per-profile engagement queue (the same
  order-weighted queue that runs Like, Save Media, Watch Stories, Comment,
  and Share to DM) now also enqueues a "share to feed" action when
  `injectProfileBrowsingShareToFeedPctMax > 0` and the profile has posts
  loaded. It rolls the configured percentage, picks a random post from the
  profile, calls `sharePostToFeed`, and logs the result via `logAction`
  (`share_post`) exactly like the existing timeline share-to-feed feature —
  errors are swallowed as non-critical, matching the Share to DM action's
  error-handling pattern.

---

## [1.1.446] — 2026-07-10

### Mobile tab — UI overhaul, phone wake bug fix, canvas black screen on power

#### UI: STEP1 card now contains "Run every" interval on the same bordered card

- **"Run every X–Y minutes" is now inside the same bordered wrapper as the
  STEP1 toggle**, on the row directly below it. Previously the interval row
  sat outside the card as a loose row, making it visually disconnected from
  the toggle it controls. It is now clearly part of the STEP1 configuration
  block — toggling on and setting the interval are both done inside the same
  bordered card.

#### Feature: toggle shows "Active" + next-run timestamp between cycles

- **When the automation toggle is on and a cycle has just finished, the
  status now shows "Active" with a "Next run at HH:MM on DD/MM/YYYY"
  line underneath it**, instead of staying on "Running" until the next cycle
  begins. This tells you exactly when the tool will fire again without having
  to guess based on your configured interval.
  - While a cycle is actually executing, the status shows "Running" as
    before.
  - The timestamp is calculated from the random gap drawn at the end of each
    cycle (`cycleIntervalMin`–`cycleIntervalMax` minutes) so it reflects the
    real next-fire time, not just an average.
  - Toggling off clears the timestamp immediately.

#### Feature: "Final Step" section added below STEP2

- **A new "(FINAL STEP)" bordered card sits below the STEP2 View Feed
  card.** It describes the close-and-recycle step that always runs at the
  end of every automation cycle: *"Close the Instagram app and Airplane Mode
  will be activated for 15–20 seconds, then Airplane Mode will be turned
  off."* This makes the three-phase cycle (STEP1 → STEP2 → FINAL STEP)
  visible and self-documenting in the UI.

#### UI: Account Settings — all three fields on one row per slot

- **Username, Password, and 2FA OTP Secret are now on a single horizontal
  row per slot**, instead of three separate stacked rows. The previous layout
  used three `space-y` blocks per slot, making five slots take up an
  unreasonable amount of vertical space. The new layout keeps the same fields
  in a compact `flex-wrap` row with labels above each input — the card still
  wraps cleanly on narrow panels.
  - "Generate Code" button shortened to "Generate" to keep the row tighter.
  - Labels reduced from `text-sm` to `text-xs` to match the denser layout.

#### UI: Account Settings — "Slot N" renamed to "Instagram Account Slot N"

- **Each slot header now reads "INSTAGRAM ACCOUNT SLOT N"** instead of the
  generic "SLOT N". This makes the purpose of each card unambiguous —
  especially relevant now that slots can be added dynamically.

#### Feature: Account Settings — "Add Instagram Account Slot" button

- **A "+ Add Instagram Account Slot" button below the last slot lets you add
  as many slots as you need**, beyond the default 5. Each press appends a new
  empty card. All per-slot UI state (show/hide password, TOTP code, TOTP
  error) is correctly extended when a new slot is added.
  - The backend `max(5)` Zod cap on the `slots` array has been removed. The
    API now accepts any number of slots — existing 5-slot data is unaffected.
    On load the UI preserves however many slots the server stored.

#### Bug fix: Power button now shows a true black screen (no cached frame)

- **When you press the Power button to lock the phone, the mirror canvas
  immediately clears to solid black** — no more seeing the last captured
  frame (wallpaper, lock screen, or Instagram) sitting on screen making the
  phone appear to still be on.
  - Two complementary paths:
    1. **Immediate** — the Power button calls `clearToBlack()` directly on
       the canvas via a `useImperativeHandle` ref, before the keyevent even
       reaches the device. The canvas goes black the instant you click.
    2. **Automatic** — a `useEffect` inside `LiveCanvas` also clears the
       canvas whenever `status` transitions to `"asleep"`, which covers
       automation-triggered power-offs (airplane-mode cycle, etc.) where the
       user didn't press Power themselves.
  - `LiveCanvas` is now a `forwardRef` component so `PhoneSlot` can hold a
    typed `LiveCanvasHandle` ref (`{ clearToBlack: () => void }`).

#### Bug fix: phone no longer wakes constantly from sleep on its own

- **Root cause identified and fixed: the server-side WebSocket stream handlers
  were sending `KEYCODE_WAKEUP` (adb input keyevent 224) automatically from
  four separate locations**, causing the phone to wake up every few seconds
  even with no tools running and the user having done nothing:

  | Location | Frequency |
  |---|---|
  | Screenshot WS — on every client connect | Every 2–3 s (client reconnects when stream drops after phone sleeps) |
  | Screenshot WS — screencap loop | Every 400 ms while `screencap` returned 0 bytes (screen off) |
  | Video WS — on every client connect | Every 2–3 s |
  | Video WS — stall timer | Every 6 s when `screenrecord` produced no data (which always happens when screen is off) |

  All four automatic `KEYCODE_WAKEUP` calls are removed. `wm dismiss-keyguard`
  (which can also trigger a display wake on some OEM skins) is removed from
  the same connect and stall-timer paths.

  Wake is now **exclusively user-triggered**: tapping the mirror canvas sends
  a `KEYCODE_WAKEUP` via the `/api/mobile/devices/:serial/input/key` endpoint,
  which is the only legitimate path. The phone now sleeps correctly between
  automation cycles and stays asleep until you explicitly tap the mirror or
  the automation engine wakes it as part of a new cycle.

  The screen-timeout suppression (`screen_off_timeout → 2147483647`) is kept:
  it prevents the phone from auto-sleeping on its own timer *while you are
  actively watching the mirror*, which is the intended behaviour. It is
  restored on WS disconnect.

---

## [1.1.445] — 2026-07-10

### Mobile tab — swipe fix (no hold), interval timer, persistent settings, UI polish

#### Bug fix: Instagram recents dismiss — plain swipe, no long press

- **Fixed: the long-press + drag caused MIUI to show a context bubble menu
  instead of dismissing the Instagram card.** The correct gesture on MIUI is
  a simple click-drag left — touch down, move left ~40 % of screen width,
  lift — with no hold at the start point. The gesture is now a plain
  `input swipe` with 220 ms duration and no preceding hold command. The
  force-stop fallback (`pidof` check) is still in place for any case where
  the gesture misses.

#### Bug fix: settings no longer reset on app update

- **Fixed: every time a new version of Equinox was installed, the Human
  Session Tool settings (scroll count, delays, like %, enabled state) reset
  to defaults.** Root cause: the config file (`mobile-instances.json`) was
  stored at `process.cwd()`, which on Windows points at the app's install
  directory — that directory is overwritten on every update. The file is now
  stored in the Electron `userData` directory (`%APPDATA%\Equinox`) which is
  never touched by the installer. Settings survive updates the same way the
  database and cookies already do.
  - `EQUINOX_DATA_DIR` env var added to the server spawn block in Electron
    main, set to `app.getPath("userData")`.
  - `configFilePath()` in the API server now reads
    `process.env.EQUINOX_DATA_DIR ?? process.cwd()` so the dev environment
    (no env var) is unaffected.

#### Feature: "Run every X to Y minutes" cycle interval

- **A new "Run every … minutes" row appears directly below the STEP1 toggle.**
  When the toggle is switched on, the tool waits a random amount of time
  between the two configured values (in minutes) before starting each new
  automation cycle. Previously the gap was derived from the per-action delay
  seconds, which was the wrong field entirely. The new fields default to
  20–30 minutes and are saved to `mobile-instances.json` along with all
  other settings.
  - Both input fields enforce a minimum of 1 minute; the run loop also
    defensively clamps to ≥ 1 before scheduling so a stored zero can never
    produce an immediate tight loop.

#### UI: model name in header top right

- The device model name (e.g. "Xiaomi 23076RN8DY") now sits on the **right
  side of the "Human Session Tool" title row** instead of below it on a
  second line, keeping the header compact.

## [1.1.444] — 2026-07-10

### Mobile tab — recents swipe fix (MIUI), 5-slot Account Settings, UI polish

#### Bug fix: Instagram recents dismiss now uses long-press + drag-left (MIUI)

- **Fixed: swiping the Instagram card off the recents screen still wasn't
  working after the previous upward-swipe attempt.** On Xiaomi MIUI the
  upward gesture scrolled the recents *overview* rather than dismissing the
  card; MIUI requires a long-press to enter drag mode followed by a drag-left
  to dismiss. The gesture is now: hold touch for 650 ms at the card centre
  (enters drag mode), then drag left to x=0 over 350 ms. Both input commands
  run inside a single `adb shell` session with no connection gap between them,
  so the touch stream is continuous from Android's perspective. The force-stop
  fallback (`pidof` check) is still in place for any device where the gesture
  doesn't land.

#### Account Settings — 5 slots with 2FA OTP

- **The Account Settings tab now shows 5 independent slots (Slot 1–5)** instead
  of a single username/password pair. Each slot is a separate card with:
  - **Username** field (25-character visual width — wider input scrolls but
    the field itself stays compact).
  - **Password** field (same 25-character width) with a Show/Hide toggle.
  - **2FA OTP Secret** field + **Generate Code** button. Entering a TOTP secret
    key and clicking Generate Code computes the current 6-digit one-time
    password (SHA-1 HMAC, 30-second window — the same algorithm used in the
    desktop Accounts Manager). The code is shown inline and copied to the
    clipboard automatically.
- Slots save automatically as you type (600 ms debounce), linked to the phone
  by serial. Any phone that had a single account saved in the old format is
  automatically migrated into Slot 1 on first load — no data loss.
- API: `GET /api/mobile/devices/:serial/account` and
  `POST /api/mobile/devices/:serial/account` now exchange
  `{ slots: [{ username, password, totpSecret? }, …] }` (5 entries). The GET
  endpoint also transparently migrates the old `{ username, password }` shape
  so old saved data is never lost.

#### Human Session Tool UI

- **Toggle border snaps to the width of its content** — the card no longer
  stretches full-width; it wraps tightly around the (STEP1) label, switch, and
  state word.
- **"(STEP1)" label moved before the toggle switch** so the read order is:
  step label → toggle → state word. Previously it was baked into the state word
  ("Disabled (STEP1)") which looked odd when the tool became Active/Running.
- **"Automatically scrolling and liking on this phone" subtitle removed** — the
  switch state word (Running / Active / Disabled) is sufficient; the extra line
  added noise.
- **"(STEP2)" prefix added to the View Feed section title** so the two steps
  are sequentially numbered: (STEP1) enable the toggle, (STEP2) configure the
  View Feed settings.
- **Scroll and Delay fields now sit directly next to each other** (flex layout
  instead of a two-column grid) — the previous grid gave each group a full
  50 % column, leaving a large gap between them.

## [1.1.443] — 2026-07-10

### Mobile tab — Human Session Tool UI overhaul + MIUI recents-swipe fix

#### Bug fix: Instagram swipe-to-close now works on Xiaomi / MIUI devices

- **Fixed: at the end of each automation cycle, Instagram was supposed to be
  swiped off the screen in the recent-apps switcher, but the card never actually
  moved — it stayed floating on screen while airplane mode activated around it.**
  Root cause: the previous gesture swiped *horizontally* from right to left
  across the card (`w×0.85 → 0, same Y`). That is the stock AOSP/Pixel
  dismiss direction; on Xiaomi MIUI the recents overview requires an *upward*
  swipe to dismiss a card, and a horizontal drag does nothing. The gesture now
  swipes vertically from the card's centre upward to the top of the screen.
- **Increased the post-recents-open wait from 700 ms to 1 200 ms.** MIUI's
  overview animation takes noticeably longer than stock Android to settle; the
  old 700 ms wait sometimes meant the swipe fired while the cards were still
  animating in, causing the gesture to land on the wrong element. The longer
  wait lets the animation finish before the dismiss gesture fires.
- The force-stop fallback is still in place: after the swipe, the cycle checks
  `pidof com.instagram.android` and only force-stops if the process is still
  alive — so the cycle always exits with Instagram fully closed regardless of
  whether the gesture landed cleanly on a given OEM launcher.

#### Human Session Tool UI — toggle, labels, and layout

- **Toggle switch moved to the left of the status label.** Previously the toggle
  sat on the far right of the header card and the status text was on the left.
  The switch is now the first element, followed immediately by the status word,
  matching the natural left-to-right read order ("flip this to enable").
- **"Disabled" state now reads "Disabled (STEP1)"** to make it immediately clear
  to new users that enabling this toggle is the first step to start the
  automation.
- **"Tool is idle" subtitle removed.** When the toggle is off, no secondary
  line of text is shown — the label "Disabled (STEP1)" is sufficient. The
  subtitle ("Automatically scrolling and liking on this phone") still appears
  when the toggle is on, so the running state remains descriptive.
- **"VIEW FEED" section title added** above the scroll/delay/like controls.
  The settings card previously had no heading, making it unclear what the
  numbers referred to. The bold uppercase label now groups those controls
  under a named section.
- **"Like this % of viewed posts" shortened to "Like % of viewed posts"**
  — the original wording was unnecessarily wordy; the shorter form is
  consistent with similar labels elsewhere in the app.

## [1.1.442] — 2026-07-10

### Mobile tab — one-click ADB setup, no manual install

- **The "ADB not found" screen now has a "Set up ADB automatically" button.**
  It downloads Google's official platform-tools package for your OS,
  unzips it into the app's own folder, and wires it up — no more manually
  downloading a zip, extracting it, and pasting a folder path. The old
  manual "paste a folder" option is still there (collapsed behind "I'd
  rather point at a folder myself") for anyone who wants it.
  - New backend route: `POST /api/mobile/adb-auto-install`.
  - Downloaded tooling lives in `artifacts/api-server/vendor/platform-tools/`
    (gitignored — it's fetched on demand per machine, not committed).

## [1.1.441] — 2026-07-10

### Human Session Tool — full power-on/open/run/close/airplane-recycle lifecycle

- **The master toggle now runs a full real-phone lifecycle each cycle**,
  not just a scroll/like loop. On every recycle while the toggle is on:
  1. Wakes the phone (`KEYCODE_WAKEUP`, not a plain power-button toggle —
     see below).
  2. Opens Instagram and gives it a moment to finish loading.
  3. Runs the scroll/like tools using whatever settings are currently
     configured (unchanged from before).
  4. Closes Instagram by opening the recent-apps switcher and swiping its
     card away — a real gesture, not a background `force-stop` — and
     verifies the process actually exited, force-stopping only as a
     fallback if the swipe didn't land on a given device/launcher.
  5. Turns airplane mode on, waits a randomized 15-20s, then turns it back
     off, to force a fresh network session before the next cycle.
  6. Swipes up and puts the screen back to sleep, ready for the next
     recycle to start clean.
  - **Note on "press power"**: a literal `KEYCODE_POWER` press just
    *toggles* the screen — if the phone happened to already be awake when
    a cycle started, "pressing power to wake it" would instead turn it
    off and run every following step blind. Used the explicit
    wake/sleep keycodes instead so the on/off state at each end of the
    cycle is always correct regardless of what it was before.
  - New backend route: `POST /api/mobile/devices/:serial/automation-cycle`
    (the standalone `/check-feed` endpoint still exists unchanged, for any
    other manual use).

## [1.1.440] — 2026-07-10

### Human Session Tool — Mobile tab no longer auto-wakes the phone; Check Feed resilience fixes

- **Fixed: opening the Mobile tab instantly woke the phone and started
  streaming the feed**, as if a click had happened off-screen. The phone
  mirror (`LiveCanvas`) used to mount and connect automatically the moment
  a device showed as ready, regardless of which tab you were even looking
  at. It now only starts once you explicitly press the on-screen **Power**
  button, or the Human Session Tool's automation toggle is switched on —
  simply having a phone plugged in or visiting the tab never starts the
  stream by itself anymore. A "Press Power to view this phone's screen"
  placeholder shows in the idle state.
- **Fixed: a failed double-tap during a Check Feed run silently ended the
  entire cycle early.** `doubleTap` failures (transient adb/USB hiccups)
  were thrown out of the run loop uncaught, aborting every scroll/like
  after the first failure — which looked like "100% like chance did
  nothing" even though the like-chance math itself was already correct.
  Each double-tap attempt is now wrapped so one bad tap is logged and
  skipped instead of killing the rest of the run; the response now also
  reports `likeFailures` alongside `likes`.
- **Reduced the "3 scrolls turned into ~8" over-scroll.** Swipe gestures
  were short and fast enough (350-500ms) that Android kept flinging the
  feed for a moment after the finger lifted, stacking extra scroll
  distance on top of each configured scroll. Swipes are now slower
  (550-750ms) with a short settle pause afterward so the feed stops
  exactly where the gesture ends, and the like double-tap jitter radius
  was tightened so a jittered tap can never land near the screen edges/nav
  bar.

## [1.1.439] — 2026-07-10

### Human Session Tool — real fix for double-tap-to-like, tabs (Account Settings / Human Session Tool / Log)

- **Fixed: manually double-tapping a post on the phone mirror still didn't
  like it.** The previous fix only covered the automated Check Feed loop —
  a manual double-tap from the operator clicking the mirrored screen was
  still sent as two independent `/input/tap` requests, each its own adb
  round-trip, so the same latency problem broke it. The pointer handler now
  holds a lone tap for 350ms; if a second tap lands nearby within that
  window it cancels the pending single tap and sends one combined
  `/input/double-tap` request instead, which reaches the device as a single
  `adb shell` call with both taps and an on-device pause — matching what
  the automated loop already does.
- **Brought back a visible activity log.** Previously the log callback
  wasn't actually wired to anything, so nothing appeared anywhere. There's
  now a real **Log** tab that shows every tap, swipe, key press, and
  automation cycle as it happens, for debugging exactly this kind of issue.
- **Split the right panel into three tabs**, in this order: **Account
  Settings**, **Human Session Tool**, **Log**.
  - **Account Settings** (new) — link an Instagram username/password to
    this specific phone; saves automatically as you type.
  - **Human Session Tool** — the existing scroll/like automation panel,
    unchanged in behavior.
  - **Log** — the new activity log, with a Clear button.
  - Switching tabs no longer interrupts anything: the Human Session Tool's
    run-loop (and its settings load/autosave) now lives at the page level
    instead of inside the tab's panel, so it keeps running in the
    background even while you're looking at Account Settings or the Log.

## [1.1.438] — 2026-07-10

### Human Session Tool — master toggle, autosave, fixed double-tap like

- **Removed the "Save settings" button.** Every field (including the new
  master toggle) now saves automatically on change, debounced by 500ms so
  rapid edits don't spam the server. A save error still surfaces inline if
  one occurs.
- **Removed the "Check Feed" button.** In its place, a master toggle at the
  top of the panel switches the whole tool on or off. While on, it runs
  Check-Feed cycles (scroll count drawn from the configured range) back to
  back, with the configured delay between both scrolls and cycles, until
  switched off. The toggle state is persisted per device so it survives a
  page reload.
- **Removed** the "Scroll the Instagram feed currently shown on the phone"
  description text and the scroll-count summary message — neither carried
  information the toggle/log don't already cover.
- **Layout:** "Scroll this many times" and "Delay between actions" now sit
  side by side in the same row instead of stacked.
- **Fixed: double-tap-to-like didn't actually like posts.** The like
  gesture sent two separate `adb shell input tap` calls, each its own
  process spawn / adb round-trip (100-300ms+). That pushed the real gap
  between the two on-device taps well past Instagram's double-tap
  recognition window, so Instagram saw two independent single taps instead
  of a like. Both taps now fire inside one `adb shell` invocation with an
  on-device `sleep` between them (`androidManager.doubleTap`), keeping the
  gap tight and consistent regardless of adb/USB latency.

## [1.1.437] — 2026-07-10

### Mobile Farm — renamed to "Human Session Tool", real inter-action delay, per-day cap and notes removed, new like-percentage feature

Follow-up to 1.1.436's Check Feed feature, based on further testing feedback:

- **Fixed: delay between actions wasn't functional.** The "delay between
  actions" setting (e.g. 5–10 seconds) was saved but never actually used —
  `check-feed` paused for a hardcoded 600–1100ms between scrolls regardless
  of what was configured. It now sends `delayMinSec`/`delayMaxSec` to the
  backend and genuinely waits a random duration in that range (in seconds,
  converted to ms) between each scroll.
- **Removed "Maximum actions per day"** — field, type, schema, and UI all
  dropped.
- **Removed the "Notes" textarea** — field, type, schema, and UI all dropped.
- **Input fields narrowed** to a 4-digit width (was full-width) across every
  number field in the panel, with matching value clamping (0–9999, or 0–100
  for percentages) enforced in code since HTML `maxLength` isn't reliably
  applied to `type="number"` inputs.
- **Panel retitled "Human Session Tool"** — the standalone "Automation
  Settings" heading is gone; Check Feed is now presented as just the first
  setting inside this single tool rather than its own separate feature.
- **New: like a percentage of viewed posts.** Two more inputs — "Like this %
  of viewed posts" (X to Y%, e.g. 3–5%) — add a like step to Check Feed.
  Each run draws one random like-rate from that range (e.g. ~4%), then after
  every scroll independently rolls that chance to double-tap the post left
  on screen (Instagram's like gesture), with human-like settle/tap timing
  and small coordinate jitter so every like doesn't land on the exact same
  pixel. The Check Feed result message now reports how many likes landed
  alongside the scroll count.

## [1.1.436] — 2026-07-10

### Mobile Farm — fixed mirror letterboxing, dropped the Stream log, replaced Auto-reply with Check Feed

**Black bars on either side of the phone mirror:** the phone shell was
hard-coded to a `9/16` aspect ratio (Tailwind `aspect-[9/16]`), but real
device resolutions (e.g. 1080×2400, 1080×2460) aren't exactly 9:16 — the
mismatch left the canvas's `object-fit: contain` letterboxing the image with
black padding on the left/right. The shell now tracks the device's *real*
reported resolution (threaded up via a new `onDimensions` callback:
`LiveCanvas` → `PhoneSlot` → `MobilePage`) and sets `aspectRatio` on the
wrapper dynamically from that, falling back to `9/16` only until the first
frame arrives. The tracked resolution is also reset whenever the connected
device's serial changes (or it disconnects), so a stale ratio from a
previous phone can never linger and briefly letterbox the next one.

**Stream log removed:** the on-screen "Stream log" panel (`DebugLogPanel`)
under Automation Settings has been removed entirely — it was a debugging aid
during development that's no longer needed day-to-day.

**"Auto-reply" replaced with "Check Feed":** the per-device Automation
Settings panel no longer has an Auto-reply toggle. In its place is a
**Check Feed** control: two number inputs ("Scroll this many times", e.g. 5
to 10) and a **Check Feed** button. Pressing it sends a random number of
downward swipes (uniformly chosen between the min/max) to whatever is
currently on the device's screen — this only drives the scroll gesture
itself; opening Instagram / navigating to the feed first is intentionally
out of scope for now and will be layered on separately.

- Backend: `AutomationSettings` per device now stores `feedScrollMin` /
  `feedScrollMax` instead of `autoReplyEnabled` (isolated to the Mobile Farm
  tab's own config file — unrelated to the separate Auto Reply tool used
  elsewhere in the app for DM automation, which is untouched).
- New endpoint: `POST /api/mobile/devices/:serial/check-feed` — resolves the
  device's real screen size via `adb shell wm size`, then issues N swipes
  (random 350–500ms duration, random 600–1100ms pacing between each) from
  ~78% down the screen to ~22%. Guarded by a per-serial in-progress lock so
  overlapping requests against the same device 409 instead of interleaving
  swipes.

## [1.1.435] — 2026-07-10

### Mobile Farm — reverted the video mirror back to `screenrecord`; scrcpy never worked on real hardware

**The problem:** v1.1.432 replaced the `screenrecord`-based H.264 mirror with a
from-scratch scrcpy-server protocol client, intended to fix `screenrecord`'s
MIUI keyguard-freeze issue. Across every real-device test since (v1.1.432
through v1.1.434, including a v1.1.433 error-surfacing pass and a v1.1.434
logcat-fallback pass), the scrcpy session **never once completed its
handshake** — the client always hit `Failed to read scrcpy video header:
socket closed before header was fully read` before a single frame arrived.
The client-side fallback then dropped to the old PNG-polling screenshot
stream, which is what actually shipped to the user every time: not "a slower
video," but zero video at all, silently.

**Investigation:** decompiled the vendored `scrcpy-server-v3.1` jar's option
table and cross-referenced it against the real scrcpy v3.1 server source
(`Options.java`, `Server.java`, `DesktopConnection.java`, `Streamer.java`).
The wire protocol implementation in `scrcpyServer.ts` (socket order, header
layout, control-message byte layout) matches the real server exactly — the
bug is not a protocol mismatch we could find from static analysis. The most
likely remaining explanation is that the on-device video capture step itself
(`SurfaceEncoder`/`MediaCodec` configuration against this specific phone's
hardware encoder) throws before `writeVideoHeader()` ever runs, closing the
socket the client is blocked reading from — but confirming that requires
actual `adb logcat` output from the failing device, which isn't available
from this environment. No physical Android hardware is reachable here to
test further.

**The fix:** reverted the `/api/mobile/video/:serial` WebSocket route and the
`/input/tap` and `/input/key` routes to the `screenrecord`-based
implementation from v1.1.431 — the last version confirmed to actually stream
real H.264 frames at close to 30fps on this hardware. This restores:
- `adb exec-out screenrecord --output-format=h264` piped straight to the
  browser over WebSocket, decoded client-side with WebCodecs.
- Automatic respawn on `screenrecord`'s 180s `--time-limit` cap, plus a 6s
  stall watchdog that force-restarts the stream (re-poking wake + keyguard
  dismiss) if the OEM virtual-display freeze re-occurs — this was always a
  known trade-off of the `screenrecord` approach, not a new regression.
  When it stalls, it recovers in a few seconds rather than going dark.
- Server-side tap coordinate rescaling: `screenrecord` may downscale its
  output relative to the device's real `wm size` (encoder alignment
  constraints), so `/input/tap` now rescales `x`/`y` against `wm size`
  again when the client's reported video frame size doesn't match.

The scrcpy protocol client (`src/mobile/scrcpyServer.ts` and the vendored
`scrcpy-server-v3.1` jar) is left in the repo, unused, for whoever picks up
the logcat root-cause investigation next — do not wire it back into the
video route without first confirming a real device actually streams frames
through it.

**Also fixed:** removed the dead `activeScrcpySessions` map and its tap/key
routing, which had silently fallen back to unscaled `adb shell input tap`
whenever no scrcpy session existed (i.e. always, in practice) — this is what
made taps land on the wrong pixel on any device where `screenrecord` streams
at a size other than the panel's native resolution.

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
