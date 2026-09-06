---
name: Mobile mirror uses real H.264 video stream, not screenshot polling
description: Why the phone-mirror uses screenrecord + WebCodecs instead of adb screencap polling, and the Annex-B demux constraint that matters if touched again.
---

The Mobile Farm phone mirror streams via `adb exec-out screenrecord --output-format=h264` piped raw over a WebSocket (`/api/mobile/video/:serial`), decoded client-side with WebCodecs `VideoDecoder` (Annex-B demuxer in `src/lib/h264Stream.ts`). The old `/api/mobile/screen/:serial` PNG-polling endpoint still exists only as an automatic fallback (WebCodecs unsupported, or server reports `{fatal:true}` when `screenrecord` produces no bytes).

**Why:** per-frame `adb exec-out screencap -p` costs 150-400ms each — a hard ceiling no polling-interval tuning could beat, and not adequate for on-the-fly mobile automation. `screenrecord` is built into Android (API 19+, no scrcpy/root needed) and streams continuously.

**How to apply:** if fixing/extending this again —
- Annex-B access-unit boundaries must be detected via `first_mb_in_slice == 0` in the slice header (Exp-Golomb), not "next slice NAL seen" — multi-slice frames are common and the naive rule fragments a single picture into multiple decoder chunks.
- `screenrecord` hard-caps each invocation at ~180s; the backend must auto-respawn on exit or the stream silently stops.
- An explicitly opened mirror owns a reference-counted screen-timeout lease and a periodic `KEYCODE_WAKEUP` keepalive; reconnect cleanup must not restore the OEM timeout while another mirror WebSocket is still live.
- The Power button must derive its label/action from recent decoded-frame status, not only the requested manual-live flag; a black timed-out mirror must offer WAKEUP, not SLEEP.
- Do not regress to screenshot polling as the primary path — it's now the fallback only.
