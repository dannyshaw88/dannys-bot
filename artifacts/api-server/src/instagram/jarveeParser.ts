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
 *  - Account label appears as "AccountName | STATUS" (e.g. "AlterEgo_Fitness_SWQ | MODERATE")
 *  - Email is stored near the SMTP/POP/IMAP server settings section
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
const SMTP_RE    = /^(smtp|pop|imap)\./i;
const EMAIL_RE   = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const URL_RE     = /^https?:\/\//i;
const DEVICE_RE  = /^\d+\/\d+;\s+\d+dpi;/;
const FOL_SRC_RE = /^followers\/([a-zA-Z0-9_.]{3,30})$/;
const NUMERIC_RE = /^\d+$/;
const SENT_DM_RE = /(?:Hey|Hiii|Hii|Hi|Heyy|Hows it going)/i;
// Jarvee account label format: "AccountName | STATUS" or "Account Name | MODERATE"
// The pipe + uppercase status word is distinctive.
const JARVEE_LABEL_RE = /^.{2,80}\s*\|\s*[A-Z][A-Z0-9 _-]{1,20}$/;
// Jarvee account-status sentences — never a password.
const JARVEE_STATUS_RE = /^(The account is|Account is (waiting|running|paused|stopped|active)|This account)/i;
// Jarvee's serialized account identifier is metadata, never a credential.
const JARVEE_ID_RE = /^Instagram_[A-Za-z0-9_]+$/;
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

/** Attempt to base64-decode a string into a plaintext password.
 *  Jarvee sometimes base64-encodes the password the same way it encodes
 *  the username.  Only attempt if the raw string ends with '=' (real padding),
 *  and require the decoded value to be pure printable ASCII (0x20–0x7e). */
function decodeB64Password(s: string): string | null {
  // Only attempt if the raw string has base64 padding — this discriminates
  // actual base64-encoded values from coincidentally alphanumeric plaintext
  // passwords (e.g. "Fitness123" passes B64_RE but is plaintext, not base64).
  if (!s.endsWith("=")) return null;
  if (!B64_RE.test(s) || s.length < 8 || s.length > 120) return null;
  try {
    const dec = Buffer.from(s, "base64").toString("latin1");
    // Must be pure printable ASCII — reject anything with non-printable or
    // non-ASCII bytes (catches binary garbage and extended unicode).
    if (!/^[\x20-\x7e]+$/.test(dec)) return null;
    return isLikelyPassword(dec) ? dec : null;
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
  if (s.length < 4 || s.length > 100) return false;
  if (EMAIL_RE.test(s)) return false;
  if (URL_RE.test(s)) return false;
  if (SMTP_RE.test(s)) return false;
  if (PROXY_RE.test(s)) return false;
  if (DEVICE_RE.test(s)) return false;
  if (JARVEE_LABEL_RE.test(s)) return false;
  if (JARVEE_STATUS_RE.test(s)) return false;
  if (JARVEE_ID_RE.test(s)) return false;
  if (s.includes(" ")) return false; // passwords never contain spaces; Jarvee config labels often do
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

/** Returns the raw string records around the first detected b64-username anchor —
 *  useful for debugging which record contains the password. */
export function diagnoseJarveeBinary(buffer: Buffer): { offset: number; id: number; value: string }[] {
  if (buffer.length < 20) return [];
  const decoded = Buffer.from(buffer.map(b => b ^ 0xff));
  const allRecords = extractAllStrings(decoded);
  const sortedByOffset = [...allRecords].sort((a, b) => a.offset - b.offset);

  for (let i = 0; i < sortedByOffset.length; i++) {
    const s = sortedByOffset[i];
    if (TOTP_RE.test(normaliseTOTP(s.value))) continue;
    const username = decodeB64Username(s.value);
    if (!username) continue;
    const window = sortedByOffset.slice(i + 1, i + 80);
    const proxyIdx = window.findIndex(w => parseProxyStr(w.value) !== null);
    if (proxyIdx < 0) continue;
    // Return 10 records before anchor + anchor + first 30 records after anchor
    const before = sortedByOffset.slice(Math.max(0, i - 10), i);
    const after  = sortedByOffset.slice(i + 1, i + 31);
    return [
      ...before.map(r => ({ ...r, value: `[PRE]  ${r.value}` })),
      { ...s, value: `[ANCHOR→username="${username}"]  raw="${s.value}"` },
      ...after.map((r, idx) => ({
        ...r,
        value: `[+${String(idx + 1).padStart(2, "0")}] ${r.value}`,
      })),
    ];
  }
  return [];
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
  const usedOffsets  = new Set<number>();
  const knownPasswords = new Set<string>(); // raw binary values confirmed as passwords

  for (let i = 0; i < sortedByOffset.length; i++) {
    const s = sortedByOffset[i];
    // Skip records already consumed as part of a previous account's window.
    if (usedOffsets.has(s.offset)) continue;
    // Skip records whose raw value was already claimed as a password — Jarvee
    // sometimes base64-encodes the password the same way it encodes the username,
    // so decodeB64Username(passwordRecord) would otherwise yield the plaintext
    // password and be mistaken for a second account's username anchor.
    if (knownPasswords.has(s.value)) continue;
    // Skip TOTP secrets — they use base32 (A-Z, 2-7) which is a subset of base64.
    // Decoding them occasionally produces a short string matching IG_UN_RE.
    if (TOTP_RE.test(normaliseTOTP(s.value))) continue;
    const username = decodeB64Username(s.value);
    if (!username) continue;

    // Primary window: 80 records after the b64 username anchor
    const window = sortedByOffset.slice(i + 1, i + 80);

    const proxyIdx = window.findIndex(w => parseProxyStr(w.value) !== null);
    if (proxyIdx < 0) continue;

    const proxy = parseProxyStr(window[proxyIdx].value)!;

    // ── True Jarvee binary layout (confirmed from hex analysis) ─────────────
    // Before proxy (reading left→right by file offset):
    //   [b64 username] … [IG password?] … [smtp/pop/imap host] [email pass] [proxy pass] [proxy host:port]
    // After proxy:
    //   [proxy username] … [full name] [label "Name | STATUS"] [web UA] [device]
    //
    // Key insight: the string IMMEDIATELY before proxy host:port is the PROXY password,
    // not the IG password.  The IG password lives before the smtp section and is often
    // absent (stored as a back-reference to null, invisible to the 0x06-only scanner).

    // Step 1: locate smtp/pop/imap host in the pre-proxy window
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

    // Step 4: IG password.
    //
    // Confirmed binary layout (from hex analysis of real exports):
    //   [b64 username] → [smtp host] → [email password] → [IG password] → [proxy host:port]
    //
    // The IG password is the SECOND password-like string in the smtp→proxy window,
    // right after the email password.  If the smtp section is absent (no email configured),
    // the IG password is the first password-like string before the proxy.
    //
    // Fallback: some Jarvee versions serialise the password object before the username
    // anchor, so we also search the 40 records immediately preceding it.
    let password = "";

    // Primary: look inside smtp→proxy window, skipping the email password AND proxy
    // password we already found.  The proxy password sits immediately before the proxy
    // host:port record — if we don't exclude it here, it gets double-assigned as the
    // IG password too (the most common mis-import symptom).
    if (smtpIdx >= 0) {
      for (let k = smtpIdx + 1; k < proxyIdx; k++) {
        const v = window[k].value;
        if (v === emailPassword) continue;       // already claimed as email password
        if (v === proxyPassword) continue;       // already claimed as proxy password
        if (EMAIL_RE.test(v) || SMTP_RE.test(v)) continue;
        if (isLikelyPassword(v)) { password = v; break; }
      }
    }

    // Secondary: between anchor and smtp (no smtp section, or password lives here)
    if (!password) {
      const smtpBoundary = smtpIdx >= 0 ? smtpIdx : proxyIdx;
      for (let k = 0; k < smtpBoundary; k++) {
        const v = window[k].value;
        if (v === proxyPassword || v === emailPassword) continue;
        if (EMAIL_RE.test(v) || SMTP_RE.test(v) || PROXY_RE.test(v)) continue;
        if (isLikelyPassword(v)) { password = v; break; }
      }
    }

    // Tertiary: search backward in up to 40 records before the anchor.
    if (!password) {
      const priorWindow = sortedByOffset.slice(Math.max(0, i - 40), i).reverse();
      for (const pw of priorWindow) {
        const v = pw.value;
        if (v === proxyPassword || v === emailPassword) continue;
        if (TOTP_RE.test(normaliseTOTP(v))) continue;
        if (EMAIL_RE.test(v) || SMTP_RE.test(v) || PROXY_RE.test(v) || URL_RE.test(v)) continue;
        if (decodeB64Username(v)) continue;
        if (isLikelyPassword(v)) { password = v; break; }
      }
    }

    // Quaternary: some Jarvee versions base64-encode the password just like the
    // username.  Scan the entire pre-proxy window for a b64 string whose decoded
    // value passes isLikelyPassword().  Skip the anchor record itself and any
    // record already decoded as the username.
    if (!password) {
      const fullPreProxy = sortedByOffset.slice(i + 1, i + 1 + proxyIdx);
      for (const pw of fullPreProxy) {
        if (pw.value === s.value) continue; // skip anchor
        const decoded = decodeB64Password(pw.value);
        if (decoded && decoded !== username) { password = decoded; break; }
      }
    }

    // Quinary: Jarvee sometimes serialises the IG password and the email password
    // as the SAME BinaryObjectString object (same objectId, one 0x06 record and
    // one 0x09 MemberReference back to it).  The 0x06-only scanner sees the string
    // once and Step 3 claims it as emailPassword.  Step 4 then finds nothing.
    // When every search step above yielded nothing, fall back to emailPassword —
    // the account uses the same password for Instagram and the recovery email.
    if (!password && emailPassword) {
      password = emailPassword;
    }

    // Post-search b64 decode check: if the password found by primary/secondary/tertiary
    // steps is itself a base64-encoded string that decodes to a valid plaintext password,
    // replace it with the decoded version.  This handles the case where the primary search
    // finds the raw b64 blob (which passes isLikelyPassword on the raw value) before the
    // quaternary step has a chance to run.
    if (password && password !== username) {
      const decodedPw = decodeB64Password(password);
      if (decodedPw && decodedPw !== username) password = decodedPw;
    }

    // If the backward proxy-password search landed on the IG password, discard it —
    // the string between smtp and proxy is the IG password, not the proxy password.
    if (proxyPassword && proxyPassword === password) proxyPassword = "";

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
        JARVEE_LABEL_RE.test(candidate)   // labels have pipe — skip them
      ) break;
      if (!proxyUsername) { proxyUsername = candidate; continue; }
      if (!proxyPassword && isLikelyPassword(candidate)) { proxyPassword = candidate; }
      break;
    }

    // ── Email: search ONLY within the pre-proxy section ──────────────────────
    // The account email (used for Email Validation / SMTP login) is stored
    // near the SMTP/POP/IMAP host, which always appears BEFORE the proxy host.
    // Searching beyond the proxy picks up Contact Messaging emails (each contact
    // can have an associated email address) and other accounts' emails — both
    // of which are completely wrong for this account field.
    // Limit to window[0..proxyIdx-1]: the SMTP section only.
    const emailItem = window.slice(0, proxyIdx).find(w => EMAIL_RE.test(w.value));
    const email = emailItem?.value ?? "";

    // 2FA TOTP secret: Jarvee may place it either before the b64 username anchor
    // OR after the proxy host (in the same area as the label/device fields).
    // Search both locations; pre-anchor first (nearest to anchor), then post-proxy.
    // Jarvee may export them space-grouped ("RGG2 7WSL LXC3 …") — normalise before testing.
    const priorWindow15 = sortedByOffset.slice(Math.max(0, i - 15), i).reverse();
    const twoFAPreAnchor = priorWindow15.find(w => TOTP_RE.test(normaliseTOTP(w.value)));
    const twoFAPostProxy = !twoFAPreAnchor
      ? window.slice(proxyIdx + 1).find(w => TOTP_RE.test(normaliseTOTP(w.value)))
      : undefined;
    const twoFAItem = twoFAPreAnchor ?? twoFAPostProxy;
    const twoFASecret = twoFAItem ? normaliseTOTP(twoFAItem.value) : "";

    const searchWindow = [...window, ...sortedByOffset.slice(i + 80, i + 200)];

    const deviceItem = searchWindow.find(w => DEVICE_RE.test(w.value));
    const deviceString = deviceItem?.value ?? "";

    const uaItem = searchWindow.find(w => /Mozilla\/5\.0/.test(w.value));
    const userAgentWeb = uaItem?.value ?? "";

    // ── Account label: Jarvee's "Name" field ─────────────────────────────────
    // Jarvee labels appear in the format "AccountName | STATUS"
    // (e.g. "AlterEgo_Fitness_SWQ | MODERATE").  This pipe+STATUS pattern is
    // distinctive and should be matched first.  If no pipe-format label is found,
    // fall back to the first post-proxy string that has mixed case or spaces.
    const afterProxyCandidates = window.slice(proxyIdx + 1).filter(w =>
      w.value.length >= 2 && w.value.length <= 120 &&
      !EMAIL_RE.test(w.value) && !URL_RE.test(w.value) &&
      !PROXY_RE.test(w.value) && !DEVICE_RE.test(w.value) &&
      !TOTP_RE.test(w.value) && !TOTP_RE.test(normaliseTOTP(w.value)) &&
      w.value !== proxyUsername && w.value !== proxyPassword &&
      !/Mozilla/.test(w.value) && !SMTP_RE.test(w.value)
    );

    // Priority 1: string matching the "Name | STATUS" pipe format
    const pipeLabelItem = afterProxyCandidates.find(w => JARVEE_LABEL_RE.test(w.value));
    // Priority 2: any string with a space or mixed case (typical label style)
    const fallbackLabelItem =
      afterProxyCandidates.find(w => w.value.includes(" ") || /[A-Z]/.test(w.value)) ??
      afterProxyCandidates[0];
    const accountLabelItem = pipeLabelItem ?? fallbackLabelItem;
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

    // Mark the anchor offset as used.
    usedOffsets.add(s.offset);

    // Register the password's raw binary value so it can't be mistaken for a
    // base64 username anchor later in the same file.
    if (password) {
      const pwRecord = window.find(w => w.value === password) ??
        sortedByOffset.slice(Math.max(0, i - 40), i).find(w => w.value === password);
      if (pwRecord) {
        knownPasswords.add(pwRecord.value);
        usedOffsets.add(pwRecord.offset);
      }
    }

    // Mark all records within the parsed window as used so no field from this
    // account can accidentally trigger a false second-account anchor.
    for (const w of window) {
      usedOffsets.add(w.offset);
    }
  }

  return accounts;
}
