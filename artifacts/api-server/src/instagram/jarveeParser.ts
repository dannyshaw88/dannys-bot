/**
 * Jarvee binary account file parser.
 *
 * Jarvee saves account exports as .NET BinaryFormatter output XOR'd byte-by-byte
 * with 0xFF.  Reversing the XOR gives a standard BinaryFormatter stream.
 *
 * Key observations from reverse-engineering:
 *  - All string values are stored as BinaryObjectString records:
 *      byte 0x06 | int32-LE objectId | LengthPrefixedString
 *  - Instagram usernames are base64-encoded
 *  - Passwords, proxies, and other fields are plain text
 *  - Per-account cluster (sorted by file offset):
 *      [status text] [2FA codes] [b64 username] [smtp host] [email pass]
 *      [IG password] [proxy host:port] [proxy username] [proxy password?]
 *      [full name] [note/label] [web UA] [device string …]
 */

export interface JarveeAccount {
  username: string;
  password: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  email?: string;
  deviceString?: string;
  userAgentWeb?: string;
  note?: string;
}

interface StringRecord {
  offset: number;
  id: number;
  value: string;
}

function readLPS(buf: Buffer, pos: number): { value: string; endPos: number } | null {
  let length = 0;
  let shift = 0;
  let i = 0;
  for (; i < 5; i++) {
    if (pos + i >= buf.length) return null;
    const b = buf[pos + i];
    length |= (b & 0x7f) << shift;
    shift += 7;
    if (!(b & 0x80)) { i++; break; }
  }
  const strStart = pos + i;
  if (strStart + length > buf.length || length > 100_000) return null;
  try {
    const value = buf.slice(strStart, strStart + length).toString("utf8");
    return { value, endPos: strStart + length };
  } catch {
    return null;
  }
}

function extractBinaryObjectStrings(decoded: Buffer): StringRecord[] {
  const records: StringRecord[] = [];
  for (let pos = 0; pos < decoded.length - 6; pos++) {
    if (decoded[pos] !== 0x06) continue;
    const objId = decoded.readInt32LE(pos + 1);
    if (objId <= 0 || objId >= 2_000_000) continue;
    const r = readLPS(decoded, pos + 5);
    if (r && r.value.length <= 5000) {
      records.push({ offset: pos, id: objId, value: r.value });
    }
  }
  return records;
}

const PROXY_RE = /^[\w.-]+:\d{2,5}$/;
const B64_RE   = /^[A-Za-z0-9+/]+=*$/;
const IG_UN_RE = /^[a-zA-Z0-9_.]{3,30}$/;
const SMTP_RE  = /^smtp\./i;
const EMAIL_RE = /^[^@]+@[^@]+\.[^@]+$/;
const URL_RE   = /^https?:\/\//i;
const DEVICE_RE = /^\d+\/\d+;\s+\d+dpi;/;

function decodeB64Username(s: string): string | null {
  if (!B64_RE.test(s) || s.length < 8 || s.length > 60) return null;
  try {
    const dec = Buffer.from(s, "base64").toString("utf8");
    return IG_UN_RE.test(dec) ? dec : null;
  } catch {
    return null;
  }
}

function parseProxyStr(s: string): { host: string; port: number } | null {
  if (!PROXY_RE.test(s)) return null;
  const colon = s.lastIndexOf(":");
  const host = s.slice(0, colon);
  const port = parseInt(s.slice(colon + 1), 10);
  if (!host || isNaN(port)) return null;
  return { host, port };
}

function isLikelyPassword(s: string): boolean {
  if (s.length < 4 || s.length > 60) return false;
  if (EMAIL_RE.test(s)) return false;
  if (URL_RE.test(s)) return false;
  if (SMTP_RE.test(s)) return false;
  if (PROXY_RE.test(s)) return false;
  if (DEVICE_RE.test(s)) return false;
  if (s.includes(" ") && s.split(" ").length > 3) return false;
  return true;
}

export function parseJarveeBinary(buffer: Buffer): JarveeAccount[] {
  if (buffer.length < 20) throw new Error("File too small to be a Jarvee binary export");

  const decoded = Buffer.from(buffer.map(b => b ^ 0xff));

  if (decoded[0] !== 0x00 || decoded[1] !== 0x01) {
    throw new Error("Not a valid Jarvee binary file (unexpected header after XOR decode)");
  }

  const strings = extractBinaryObjectStrings(decoded);
  if (strings.length === 0) throw new Error("No string records found — file may be corrupted");

  const accounts: JarveeAccount[] = [];
  const usedOffsets = new Set<number>();

  for (let i = 0; i < strings.length; i++) {
    const s = strings[i];
    const username = decodeB64Username(s.value);
    if (!username || usedOffsets.has(s.offset)) continue;

    const window = strings.slice(i + 1, i + 50);

    const proxyIdx = window.findIndex(w => parseProxyStr(w.value) !== null);
    if (proxyIdx < 0) continue;

    const proxyRecord = window[proxyIdx];
    const proxy = parseProxyStr(proxyRecord.value)!;

    const password = (() => {
      for (let k = proxyIdx - 1; k >= 0; k--) {
        if (isLikelyPassword(window[k].value)) return window[k].value;
      }
      return "";
    })();

    let proxyUsername = "";
    let proxyPassword = "";
    for (let k = proxyIdx + 1; k < Math.min(proxyIdx + 4, window.length); k++) {
      const candidate = window[k].value;
      if (!parseProxyStr(candidate) && !EMAIL_RE.test(candidate) && !URL_RE.test(candidate) && candidate.length <= 60) {
        if (!proxyUsername) { proxyUsername = candidate; continue; }
        if (!proxyPassword && isLikelyPassword(candidate)) { proxyPassword = candidate; break; }
      }
    }

    const emailItem = window.find(w => EMAIL_RE.test(w.value));
    const email = emailItem?.value ?? "";

    const deviceItem = [...window, ...strings.slice(i + 50, i + 150)]
      .find(w => DEVICE_RE.test(w.value));
    const deviceString = deviceItem?.value ?? "";

    const uaItem = [...window, ...strings.slice(i + 50, i + 150)]
      .find(w => /Mozilla\/5\.0/.test(w.value));
    const userAgentWeb = uaItem?.value ?? "";

    const noteItem = window.slice(proxyIdx + 1).find(w =>
      w.value.length >= 3 && w.value.length <= 100 &&
      !EMAIL_RE.test(w.value) && !URL_RE.test(w.value) &&
      !PROXY_RE.test(w.value) && !DEVICE_RE.test(w.value) &&
      w.value !== proxyUsername && w.value !== proxyPassword &&
      !/Mozilla/.test(w.value)
    );
    const note = noteItem?.value ?? "";

    accounts.push({
      username,
      password,
      proxyHost: proxy.host,
      proxyPort: proxy.port,
      proxyUsername: proxyUsername || undefined,
      proxyPassword: proxyPassword || undefined,
      email: email || undefined,
      deviceString: deviceString || undefined,
      userAgentWeb: userAgentWeb || undefined,
      note: note || undefined,
    });

    usedOffsets.add(s.offset);
  }

  return accounts;
}
