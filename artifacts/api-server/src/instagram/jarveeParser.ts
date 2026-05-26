/**
 * Jarvee binary account file parser.
 *
 * Jarvee saves account exports as .NET BinaryFormatter output XOR'd byte-by-byte
 * with 0xFF.  Reversing the XOR gives a standard BinaryFormatter stream.
 *
 * Key observations from reverse-engineering:
 *  - All string values are stored as BinaryObjectString records:
 *      byte 0x06 | int32-LE objectId | LengthPrefixedString
 *  - Instagram usernames are base64-encoded in the account header
 *  - Passwords, proxies, and other fields are plain text
 *  - Per-account cluster (sorted by file offset):
 *      [status text] [2FA codes] [b64 username] [smtp host] [email pass]
 *      [IG password] [proxy host:port] [proxy username] [proxy password?]
 *      [full name] [note/label] [web UA (Chrome)] [device string …]
 *  - Follow sources appear as "followers/X" strings (X = target account)
 *  - Followed users appear as a large consecutive run of IG usernames
 *  - DM recipients: IG username appears 2 records after each large sent-DM text
 */

export interface JarveeAccount {
  username: string;
  password: string;
  proxyHost?: string;
  proxyPort?: number;
  proxyUsername?: string;
  proxyPassword?: string;
  email?: string;
  emailPassword?: string;        // password for the recovery email account
  twoFASecret?: string;          // TOTP 2FA secret key (base32)
  deviceString?: string;
  userAgentWeb?: string;
  accountLabel?: string;         // Jarvee account name/label (not the IG username)
  followSources: string[];       // usernames to follow followers of (target_followers)
  followedUsernames: string[];   // already-followed IG usernames (dedup list)
  dmRecipients: string[];        // already-DM'd IG usernames (dedup list)
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
  if (strStart + length > buf.length || length > 500_000) return null;
  try {
    const value = buf.slice(strStart, strStart + length).toString("utf8");
    return { value, endPos: strStart + length };
  } catch {
    return null;
  }
}

function extractAllStrings(decoded: Buffer): StringRecord[] {
  const records: StringRecord[] = [];
  for (let pos = 0; pos < decoded.length - 6; pos++) {
    if (decoded[pos] !== 0x06) continue;
    const objId = decoded.readInt32LE(pos + 1);
    if (objId <= 0 || objId >= 100_000_000) continue;
    const r = readLPS(decoded, pos + 5);
    if (r && r.value.length <= 200_000) {
      records.push({ offset: pos, id: objId, value: r.value });
    }
  }
  return records;
}

const PROXY_RE   = /^[\w.-]+:\d{2,5}$/;
const B64_RE     = /^[A-Za-z0-9+/]+=*$/;
const IG_UN_RE   = /^[a-zA-Z0-9_.]{3,30}$/;
const SMTP_RE    = /^smtp\./i;
const EMAIL_RE   = /^[^@]+@[^@]+\.[^@]+$/;
const URL_RE     = /^https?:\/\//i;
const DEVICE_RE  = /^\d+\/\d+;\s+\d+dpi;/;
const FOL_SRC_RE = /^followers\/([a-zA-Z0-9_.]{3,30})$/;
const NUMERIC_RE = /^\d+$/;
const SENT_DM_RE = /(?:Hey|Hiii|Hii|Hi|Heyy|Hows it going)/i;
// TOTP 2FA secrets use base32 alphabet (A-Z, 2-7), typically 16-64 chars.
// This discriminates them from base64 IG usernames (which contain lowercase/+//).
// Jarvee sometimes exports them with spaces (grouped format, e.g. "RGG2 7WSL LXC3 K2HT").
// We normalise (strip spaces) before testing so both forms are accepted.
const TOTP_RE    = /^[A-Z2-7]{16,64}=*$/;
function normaliseTOTP(s: string): string { return s.replace(/\s+/g, ""); }

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

/** Extract the "followed users" list from the first large run of IG usernames
 *  that contains a mix of styles (not pure fitness-hashtag words).
 *  Runs of ≥50 entries where >25% have digits or underscores → real accounts. */
function extractFollowedUsers(sortedById: StringRecord[]): string[] {
  const DAYS = new Set(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);

  let bestRun: string[] = [];
  let i = 0;
  while (i < sortedById.length) {
    const s = sortedById[i].value;
    if (!IG_UN_RE.test(s) || DAYS.has(s) || NUMERIC_RE.test(s) || FOL_SRC_RE.test(s) || s.length <= 2) {
      i++;
      continue;
    }
    // Potential start of a run
    const run: string[] = [s];
    let j = i + 1;
    while (j < sortedById.length) {
      const v = sortedById[j].value;
      if (IG_UN_RE.test(v) && !DAYS.has(v) && !NUMERIC_RE.test(v) && v.length >= 4) {
        run.push(v);
        j++;
      } else if (v.length <= 2 || v === "" || NUMERIC_RE.test(v) || DAYS.has(v)) {
        j++;
      } else {
        break;
      }
    }
    if (run.length >= 50) {
      const withDigitOrUnderscore = run.filter(u => /[0-9_]/.test(u)).length;
      const ratio = withDigitOrUnderscore / run.length;
      if (ratio > 0.25 && run.length > bestRun.length) {
        bestRun = run;
      }
    }
    i = j;
  }
  // Deduplicate while preserving order
  return [...new Set(bestRun)];
}

/** Extract DM recipients: the IG username that appears 1-3 records (by ID) after
 *  each large sent-DM text. */
function extractDmRecipients(sortedById: StringRecord[]): string[] {
  const idMap = new Map(sortedById.map(r => [r.id, r.value]));
  const sortedIds = sortedById.map(r => r.id).sort((a, b) => a - b);
  const idIndex = new Map(sortedIds.map((id, idx) => [id, idx]));

  const recipients = new Set<string>();
  for (const rec of sortedById) {
    if (rec.value.length < 80 || !SENT_DM_RE.test(rec.value)) continue;
    if (!rec.value.includes("\n") && rec.value.length < 120) continue;
    const idx = idIndex.get(rec.id);
    if (idx == null) continue;
    // Check next 4 sibling IDs for a valid IG username
    for (let k = 1; k <= 4; k++) {
      const nextId = sortedIds[idx + k];
      if (nextId == null) break;
      const v = idMap.get(nextId) ?? "";
      if (IG_UN_RE.test(v) && v.length >= 4 && !NUMERIC_RE.test(v)) {
        recipients.add(v);
        break;
      }
    }
  }
  return [...recipients];
}

export function parseJarveeBinary(buffer: Buffer): JarveeAccount[] {
  if (buffer.length < 20) throw new Error("File too small to be a Jarvee binary export");

  const decoded = Buffer.from(buffer.map(b => b ^ 0xff));

  if (decoded[0] !== 0x00 || decoded[1] !== 0x01) {
    throw new Error("Not a valid Jarvee binary file (unexpected header after XOR decode)");
  }

  const allRecords = extractAllStrings(decoded);
  if (allRecords.length === 0) throw new Error("No string records found — file may be corrupted");

  // Sort two ways: by offset (for proximity analysis) and by ID (for run detection)
  const sortedByOffset = [...allRecords].sort((a, b) => a.offset - b.offset);
  const sortedById     = [...allRecords].sort((a, b) => a.id - b.id);

  // ── Global data extraction (file-level, not per-account) ──────────────────

  // Follow sources: all unique "followers/X" strings
  const followSourceSet = new Set<string>();
  for (const r of allRecords) {
    const m = FOL_SRC_RE.exec(r.value);
    if (m) followSourceSet.add(m[1]);
  }
  const followSources = [...followSourceSet];

  // Followed users (largest real-account username run)
  const followedUsernames = extractFollowedUsers(sortedById);

  // DM recipients
  const dmRecipients = extractDmRecipients(sortedById);

  // ── Per-account extraction ────────────────────────────────────────────────
  const accounts: JarveeAccount[] = [];
  const usedOffsets = new Set<number>();

  for (let i = 0; i < sortedByOffset.length; i++) {
    const s = sortedByOffset[i];
    const username = decodeB64Username(s.value);
    if (!username || usedOffsets.has(s.offset)) continue;

    const window = sortedByOffset.slice(i + 1, i + 50);

    const proxyIdx = window.findIndex(w => parseProxyStr(w.value) !== null);
    if (proxyIdx < 0) continue;

    const proxy = parseProxyStr(window[proxyIdx].value)!;

    // ── True Jarvee binary layout (confirmed from hex analysis) ─────────────
    // Before proxy (reading left→right by file offset):
    //   [b64 username] … [IG password?] … [smtp host] [email pass] [proxy pass] [proxy host:port]
    // After proxy:
    //   [proxy username] …
    //
    // Key insight: the string IMMEDIATELY before proxy host:port is the PROXY password,
    // not the IG password.  The IG password lives before the smtp section and is often
    // absent (stored as a back-reference to null, invisible to the 0x06-only scanner).

    // Step 1: locate smtp host in the pre-proxy window
    const smtpIdx = window.findIndex(w => SMTP_RE.test(w.value));

    // Step 2: proxy password = first password-like string working backwards from proxy,
    //         but stopping before crossing into the smtp section.
    let proxyPassword = "";
    for (let k = proxyIdx - 1; k >= 0; k--) {
      const v = window[k].value;
      if (SMTP_RE.test(v)) break;           // don't cross into smtp territory
      if (EMAIL_RE.test(v)) continue;       // skip email addresses
      if (isLikelyPassword(v)) { proxyPassword = v; break; }
    }

    // Step 3: email password = first password-like string after smtp, before proxy password.
    let emailPassword = "";
    if (smtpIdx >= 0) {
      for (let k = smtpIdx + 1; k < proxyIdx; k++) {
        const v = window[k].value;
        if (v === proxyPassword) break;     // stop when we reach the proxy password
        if (!SMTP_RE.test(v) && isLikelyPassword(v)) { emailPassword = v; break; }
      }
    }

    // Step 4: IG password = password-like string before the smtp section.
    //         Often absent for accounts whose passwords were not exported.
    let password = "";
    const smtpBoundary = smtpIdx >= 0 ? smtpIdx : proxyIdx;
    for (let k = smtpBoundary - 1; k >= 0; k--) {
      if (isLikelyPassword(window[k].value)) { password = window[k].value; break; }
    }

    // Step 5: proxy username = first non-special string after proxy host:port.
    //         Limit to 2 records; only take a proxy password from after if we
    //         didn't already find one before the proxy.
    let proxyUsername = "";
    for (let k = proxyIdx + 1; k < Math.min(proxyIdx + 3, window.length); k++) {
      const candidate = window[k].value;
      if (
        parseProxyStr(candidate) !== null ||
        EMAIL_RE.test(candidate) ||
        URL_RE.test(candidate) ||
        candidate.length > 60 ||
        candidate.includes(" ")          // labels / names have spaces — skip them
      ) break;
      if (!proxyUsername) { proxyUsername = candidate; continue; }
      if (!proxyPassword && isLikelyPassword(candidate)) { proxyPassword = candidate; }
      break;
    }

    const emailItem = window.find(w => EMAIL_RE.test(w.value));
    const email = emailItem?.value ?? "";

    // 2FA TOTP secret: appears before the b64 username anchor in the binary cluster.
    // Look at the 15 records immediately preceding the anchor (reversed = nearest first).
    // Jarvee may export them space-grouped ("RGG2 7WSL LXC3 …") — normalise before testing.
    const priorWindow = sortedByOffset.slice(Math.max(0, i - 15), i).reverse();
    const twoFAItem = priorWindow.find(w => TOTP_RE.test(normaliseTOTP(w.value)));
    const twoFASecret = twoFAItem ? normaliseTOTP(twoFAItem.value) : "";

    const searchWindow = [...window, ...sortedByOffset.slice(i + 50, i + 150)];

    const deviceItem = searchWindow.find(w => DEVICE_RE.test(w.value));
    const deviceString = deviceItem?.value ?? "";

    const uaItem = searchWindow.find(w => /Mozilla\/5\.0/.test(w.value));
    const userAgentWeb = uaItem?.value ?? "";

    // Account label: Jarvee's "Name" field.
    // Binary layout after proxy: [proxy user] [proxy pass?] [full name] [label] [web UA] [device]
    // We skip proxy creds, UA, device string, emails, URLs, and proxy-like strings.
    // Of the remaining candidates, prefer strings with spaces or mixed case (typical label style)
    // over plain single-word values (which are more likely the IG full name).
    const afterProxyCandidates = window.slice(proxyIdx + 1).filter(w =>
      w.value.length >= 2 && w.value.length <= 120 &&
      !EMAIL_RE.test(w.value) && !URL_RE.test(w.value) &&
      !PROXY_RE.test(w.value) && !DEVICE_RE.test(w.value) && !TOTP_RE.test(w.value) &&
      w.value !== proxyUsername && w.value !== proxyPassword &&
      !/Mozilla/.test(w.value) && !SMTP_RE.test(w.value)
    );
    // Prefer a value that contains a space or is mixed-case (account labels often are),
    // otherwise fall back to the first candidate (which could be the IG full name / label).
    const accountLabelItem =
      afterProxyCandidates.find(w => w.value.includes(" ") || /[A-Z]/.test(w.value)) ??
      afterProxyCandidates[0];
    const accountLabel = accountLabelItem?.value ?? "";

    accounts.push({
      username,
      password,
      proxyHost:         proxy.host,
      proxyPort:         proxy.port,
      proxyUsername:     proxyUsername || undefined,
      proxyPassword:     proxyPassword || undefined,
      email:             email || undefined,
      emailPassword:     emailPassword || undefined,
      twoFASecret:       twoFASecret || undefined,
      deviceString:      deviceString || undefined,
      userAgentWeb:      userAgentWeb || undefined,
      accountLabel:      accountLabel || undefined,
      followSources,
      followedUsernames,
      dmRecipients,
    });

    usedOffsets.add(s.offset);
  }

  return accounts;
}
