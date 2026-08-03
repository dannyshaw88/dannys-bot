/**
 * Minimal Annex-B H.264 demuxer for live streaming via WebCodecs.
 *
 * `adb exec-out screenrecord --output-format=h264` emits a continuous raw
 * Annex-B elementary stream (NAL units separated by 00 00 01 / 00 00 00 01
 * start codes) with no container. WebCodecs' VideoDecoder needs one
 * `EncodedVideoChunk` per *access unit* (one video frame's worth of NAL
 * units), so this class buffers incoming bytes, finds NAL boundaries, and
 * groups them into per-frame chunks.
 *
 * A frame boundary is only "the next slice NAL" when each frame has exactly
 * one slice — encoders frequently split a picture into multiple slices
 * (multi-slice frames), which would otherwise get fragmented into multiple
 * bogus access units and destabilize the decoder. To detect a real new
 * picture we read `first_mb_in_slice` (the first Exp-Golomb field of every
 * slice header, per ITU-T H.264 §7.3.3) — it is 0 only for the first slice
 * of a picture.
 */

export type Nalu = { type: number; data: Uint8Array };

function findStartCodes(buf: Uint8Array): number[] {
  const positions: number[] = [];
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
      positions.push(i);
    }
  }
  return positions;
}

/** Strips H.264 emulation-prevention bytes (00 00 03 -> 00 00) from a short RBSP prefix. */
function unescapeRbsp(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeroRun = 0;
  for (const b of bytes) {
    if (zeroRun >= 2 && b === 0x03) { zeroRun = 0; continue; }
    out.push(b);
    zeroRun = b === 0 ? zeroRun + 1 : 0;
  }
  return new Uint8Array(out);
}

/**
 * Reads the first Exp-Golomb-coded field (`first_mb_in_slice`) from a slice
 * NAL's RBSP. `nalPayload` must start at the NAL header byte.
 * Returns null if there isn't enough data to decode it.
 */
function readFirstMbInSlice(nalPayload: Uint8Array): number | null {
  // Skip the 1-byte NAL header; unescape a small prefix of the RBSP (the
  // field is always within the first few bytes for any real resolution).
  const rbsp = unescapeRbsp(nalPayload.subarray(1, Math.min(nalPayload.length, 12)));
  if (rbsp.length === 0) return null;

  let bitPos = 0;
  const totalBits = rbsp.length * 8;
  const readBit = (): number | null => {
    if (bitPos >= totalBits) return null;
    const byte = rbsp[bitPos >> 3];
    const bit = (byte >> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  // ue(v): count leading zero bits, then read that many bits + a stop bit.
  let leadingZeros = 0;
  for (;;) {
    const bit = readBit();
    if (bit === null) return null;
    if (bit === 1) break;
    leadingZeros++;
    if (leadingZeros > 24) return null; // corrupt / not enough data
  }
  let value = 1;
  for (let i = 0; i < leadingZeros; i++) {
    const bit = readBit();
    if (bit === null) return null;
    value = (value << 1) | bit;
  }
  return value - 1;
}

/** Parses profile_idc / constraint flags / level_idc out of a raw SPS NAL payload (post start-code, post NAL header byte) and returns a WebCodecs codec string like "avc1.640028". */
export function spsToCodecString(spsPayload: Uint8Array): string {
  // spsPayload[0] is the NAL header byte itself; profile/constraints/level follow.
  const profileIdc = spsPayload[1];
  const constraintFlags = spsPayload[2];
  const levelIdc = spsPayload[3];
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  return `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}`;
}

export class AnnexBDemuxer {
  private pending: Uint8Array = new Uint8Array(0);
  private sps: Uint8Array | null = null;

  /** Feed raw bytes as they arrive off the wire. Returns any complete access units found (may be zero or more). */
  push(chunk: Uint8Array): { data: Uint8Array; keyFrame: boolean }[] {
    const combined = new Uint8Array(this.pending.length + chunk.length);
    combined.set(this.pending, 0);
    combined.set(chunk, this.pending.length);

    const starts = findStartCodes(combined);
    if (starts.length < 2) {
      // Not enough NAL boundaries yet to safely cut a unit — keep buffering.
      this.pending = combined;
      return [];
    }

    const units: { data: Uint8Array; keyFrame: boolean }[] = [];
    let unitStart = starts[0];
    let sawSlice = false;
    let unitHasKey = false;

    for (let i = 0; i < starts.length; i++) {
      const nalStart = starts[i];
      const headerByte = combined[nalStart + 3];
      const nalType = headerByte & 0x1f;
      const isSlice = nalType === 1 || nalType === 5;

      if (nalType === 7) {
        // Cache SPS payload (from this start code to the next one) for codec-string detection.
        const nextStart = starts[i + 1] ?? combined.length;
        this.sps = combined.slice(nalStart + 3, nextStart);
      }

      if (isSlice) {
        const nextStart = starts[i + 1] ?? combined.length;
        const firstMb = readFirstMbInSlice(combined.subarray(nalStart + 3, nextStart));
        // firstMb === 0 means this slice starts a *new* picture. Any other
        // slice (firstMb > 0, or undecodable because the NAL is still
        // arriving) belongs to the picture already in progress.
        const startsNewPicture = firstMb === 0 || firstMb === null;
        if (sawSlice && startsNewPicture) {
          // New access unit begins here — flush everything before it,
          // tagged with whatever key-frame status the *previous* unit
          // actually had (must be read before we start tracking the new one).
          units.push({ data: combined.slice(unitStart, nalStart), keyFrame: unitHasKey });
          unitStart = nalStart;
          unitHasKey = false;
        }
        if (nalType === 5) unitHasKey = true;
        sawSlice = true;
      }
    }

    // Keep the tail (from the last confirmed unit boundary onward) buffered —
    // we can't be sure it's complete until the next chunk arrives.
    this.pending = combined.slice(unitStart);
    return units;
  }

  /** The most recently seen SPS NAL payload, if any — used to build the WebCodecs codec string once. */
  getSps(): Uint8Array | null {
    return this.sps;
  }
}
