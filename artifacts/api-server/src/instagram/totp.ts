import { createHmac } from "crypto";

/**
 * Generate a TOTP code from a base32-encoded secret.
 * Pure Node.js crypto — no otplib, no minimum-length restrictions.
 * Handles any valid base32 secret (including Instagram's 16-char secrets).
 */
export function generateTotp(base32Secret: string, digits = 6, period = 30): string {
  const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = base32Secret.toUpperCase().replace(/[\s=]/g, "");
  if (!clean) throw new Error("TOTP secret is empty");

  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    const idx = CHARS.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!bytes.length) throw new Error("TOTP secret decoded to zero bytes — check the base32 key");
  const key = Buffer.from(bytes);

  const counter = Math.floor(Date.now() / 1000 / period);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);

  const hmac = createHmac("sha1", key).update(msg).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const otp =
    (((hmac[offset] & 0x7f) << 24) |
      (hmac[offset + 1] << 16) |
      (hmac[offset + 2] << 8) |
      hmac[offset + 3]) %
    10 ** digits;

  return otp.toString().padStart(digits, "0");
}
