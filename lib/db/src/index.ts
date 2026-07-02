import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import path from "path";
import * as schema from "./schema";

const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), "database.db");

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS proxies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER NOT NULL,
    username TEXT,
    password TEXT,
    proxy_type TEXT DEFAULT 'http',
    adapter_name TEXT,
    rotate_every_min INTEGER,
    rotate_every_max INTEGER
  );

  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    email TEXT,
    proxy_id INTEGER,
    proxy_host TEXT,
    proxy_port INTEGER,
    proxy_username TEXT,
    proxy_password TEXT,
    status TEXT NOT NULL DEFAULT 'idle',
    account_status TEXT NOT NULL DEFAULT 'pending',
    status_message TEXT,
    user_agent_api TEXT,
    user_agent_embedded TEXT,
    api_limits TEXT DEFAULT '{"requestsMin":5,"requestsMax":10,"everySecondsMin":30,"everySecondsMax":60}',
    browser_direct_connection INTEGER DEFAULT 1,
    credentials_dirty INTEGER DEFAULT 1,
    account_label TEXT,
    tags TEXT,
    date_of_birth TEXT,
    notes TEXT,
    phone_number TEXT,
    two_fa_secret_key TEXT,
    backup_codes TEXT,
    email_validation_username TEXT,
    email_validation_password TEXT,
    email_validation_pop3_server TEXT,
    email_validation_port TEXT,
    active_timer_enabled INTEGER DEFAULT 0,
    active_timer_start TEXT,
    active_timer_end TEXT,
    follow_via_browser INTEGER DEFAULT 0,
    sync_enabled INTEGER DEFAULT 0,
    sync_interval_min INTEGER,
    sync_interval_max INTEGER,
    sync_use_hiker INTEGER DEFAULT 0,
    followers_count INTEGER,
    following_count INTEGER,
    posts_count INTEGER,
    last_synced_at TEXT
  );

  CREATE TABLE IF NOT EXISTS tools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    settings TEXT DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    value TEXT NOT NULL,
    rank INTEGER,
    nr_posts INTEGER
  );

  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS instagram_api_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    operation_name TEXT NOT NULL,
    date TEXT NOT NULL,
    message TEXT DEFAULT '',
    source TEXT DEFAULT '',
    nav_chain TEXT DEFAULT '',
    ip_address TEXT DEFAULT '',
    duration_ms INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS followed_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    instagram_username TEXT NOT NULL,
    source_value TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT '',
    followed_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS session_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    tool_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    target_username TEXT NOT NULL,
    source_value TEXT NOT NULL DEFAULT '',
    source_type TEXT NOT NULL DEFAULT '',
    result TEXT NOT NULL DEFAULT 'ok',
    detail TEXT DEFAULT '',
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS global_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS hashtag_cursors (
    hashtag TEXT PRIMARY KEY,
    cursor TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS scraped_users_global (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instagram_user_id TEXT NOT NULL UNIQUE,
    instagram_username TEXT NOT NULL,
    scraped_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS skipped_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instagram_username TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    skipped_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reposted_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    tool_id INTEGER NOT NULL,
    source_username TEXT NOT NULL,
    media_id TEXT NOT NULL,
    shortcode TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    thumbnail_url TEXT NOT NULL DEFAULT '',
    reposted_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contact_dm_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    instagram_username TEXT NOT NULL,
    instagram_user_id TEXT NOT NULL DEFAULT '',
    sent_at TEXT NOT NULL,
    message_preview TEXT NOT NULL DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS contact_pending_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    instagram_username TEXT NOT NULL,
    instagram_user_id TEXT NOT NULL DEFAULT '',
    message_type TEXT NOT NULL,
    message_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    queued_at TEXT NOT NULL,
    sent_at TEXT,
    dm_thread_id TEXT,
    dm_item_id TEXT,
    unsend_at TEXT
  );

  CREATE TABLE IF NOT EXISTS api_created_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    password TEXT NOT NULL,
    email TEXT NOT NULL,
    proxy_host TEXT,
    proxy_port INTEGER,
    proxy_username TEXT,
    proxy_password TEXT,
    bio TEXT,
    imap_server TEXT,
    imap_port INTEGER,
    imap_pass TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    instagram_user_id TEXT,
    session_cookies TEXT,
    error_message TEXT,
    steps TEXT,
    added_to_accounts INTEGER DEFAULT 0,
    profile_id INTEGER,
    user_agent_api TEXT,
    api_limits TEXT,
    date_of_birth TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    tier TEXT NOT NULL DEFAULT 'starter',
    account_limit INTEGER NOT NULL DEFAULT 15,
    active INTEGER NOT NULL DEFAULT 1,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    expires_at TEXT
  );

  CREATE TABLE IF NOT EXISTS banned_accounts_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    proxy_host TEXT DEFAULT '',
    banned_at TEXT NOT NULL,
    endpoint_count INTEGER DEFAULT 0,
    endpoint_snapshot TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS automated_behaviour_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    proxy_host TEXT DEFAULT '',
    flagged_at TEXT NOT NULL,
    endpoint_count INTEGER DEFAULT 0,
    endpoint_snapshot TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS captcha_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    proxy_host TEXT DEFAULT '',
    flagged_at TEXT NOT NULL,
    endpoint_count INTEGER DEFAULT 0,
    endpoint_snapshot TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS locked_accounts_analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    proxy_host TEXT DEFAULT '',
    flagged_at TEXT NOT NULL,
    endpoint_count INTEGER DEFAULT 0,
    endpoint_snapshot TEXT DEFAULT '[]'
  );
`);

// Seed owner license account if not already present
{
  const ownerExists = sqlite.prepare("SELECT 1 FROM licenses WHERE LOWER(username) = 'equinox'").get();
  if (!ownerExists) {
    sqlite.prepare(
      "INSERT INTO licenses (username, password_hash, tier, account_limit, active, is_admin, created_at) VALUES (?, ?, 'owner', 9999, 1, 1, ?)"
    ).run("EQUINOX", "6b371d058acf35caefe10819c1ee07bee49f9fdfe19869f63a7d4c3cc836e01f", new Date().toISOString());
    console.log("[db] Owner license account seeded");
  }
}

// ── Schema migrations for existing databases ────────────────────────────────
// SQLite does not support IF NOT EXISTS on ALTER TABLE, so we try/catch each.
const _migrations: string[] = [
  "ALTER TABLE proxies ADD COLUMN proxy_type TEXT DEFAULT 'http'",
  "ALTER TABLE licenses ADD COLUMN expires_at TEXT",
  "ALTER TABLE proxies ADD COLUMN import_linked INTEGER DEFAULT 0",
  "ALTER TABLE proxies ADD COLUMN adapter_name TEXT",
  "ALTER TABLE proxies ADD COLUMN rotate_every_min INTEGER",
  "ALTER TABLE proxies ADD COLUMN rotate_every_max INTEGER",
];
for (const sql of _migrations) {
  try { sqlite.exec(sql); } catch { /* column already exists */ }
}

// Add new columns if they don't exist yet (safe to run on existing DBs)
const existingCols = sqlite.prepare("pragma table_info(profiles)").all() as { name: string }[];
const colNames = new Set(existingCols.map((c) => c.name));
if (!colNames.has("ig_device_state")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN ig_device_state TEXT;`);
}
if (!colNames.has("ig_api_cookies")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN ig_api_cookies TEXT;`);
}
if (!colNames.has("creator_mode")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN creator_mode INTEGER DEFAULT 0;`);
}
if (!colNames.has("locked")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN locked INTEGER DEFAULT 0;`);
}
if (!colNames.has("cookie_baker_settings")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN cookie_baker_settings TEXT;`);
}
if (!colNames.has("status_message")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN status_message TEXT;`);
}
if (!colNames.has("eb_fingerprint")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN eb_fingerprint TEXT;`);
}
if (!colNames.has("leak_snapshot")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN leak_snapshot TEXT;`);
}
if (!colNames.has("is_template")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN is_template INTEGER DEFAULT 0;`);
}
if (!colNames.has("template_id")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN template_id TEXT;`);
}
// Correct data: real accounts (no template_id) that somehow got is_template=1 are not
// TrustScore templates — reset them so they show up in the accounts page.
sqlite.exec(`
  UPDATE profiles
  SET is_template = 0
  WHERE is_template = 1 AND (template_id IS NULL OR template_id = '');
`);
if (!colNames.has("resuming_until")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN resuming_until TEXT;`);
}
if (!colNames.has("resuming_prev_status")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN resuming_prev_status TEXT;`);
}
if (!colNames.has("use_home_ip")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN use_home_ip INTEGER DEFAULT 0;`);
}
if (!colNames.has("created_at")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN created_at TEXT;`);
  // Backfill from "Added: YYYY-MM-DD HH:MM:SS UTC" stamps already written to notes
  sqlite.exec(`
    UPDATE profiles
    SET created_at = (
      CASE
        WHEN notes LIKE '%Added: ____-__-__ __:__:__ UTC%'
        THEN replace(
               replace(
                 substr(notes, instr(notes, 'Added: ') + 7, 19),
                 ' ', 'T'
               ) || 'Z',
               '',''
             )
        ELSE NULL
      END
    )
    WHERE created_at IS NULL;
  `);
}
if (!colNames.has("valid_since")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN valid_since TEXT;`);
}
if (!colNames.has("follow_via_browser")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN follow_via_browser INTEGER DEFAULT 0;`);
}
// Backfill: any account currently "valid" with no valid_since gets created_at as the
// starting point (falls back to NOW if created_at is also null).  Runs every startup
// but only touches rows that still have a null valid_since, so it's fully idempotent.
sqlite.exec(`
  UPDATE profiles
  SET valid_since = COALESCE(created_at, datetime('now'))
  WHERE account_status = 'valid' AND (valid_since IS NULL OR valid_since = '');
`);

// Add new columns to sources and followed_users if they don't exist
const sourcesCols = sqlite.prepare("pragma table_info(sources)").all() as { name: string }[];
const sourcesColNames = new Set(sourcesCols.map((c) => c.name));
if (!sourcesColNames.has("target_user_id")) {
  sqlite.exec(`ALTER TABLE sources ADD COLUMN target_user_id TEXT NOT NULL DEFAULT '';`);
}
if (!sourcesColNames.has("hashtag_cursor")) {
  sqlite.exec(`ALTER TABLE sources ADD COLUMN hashtag_cursor TEXT NOT NULL DEFAULT '';`);
}
if (!sourcesColNames.has("enabled")) {
  sqlite.exec(`ALTER TABLE sources ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;`);
}
const followedUsersCols = sqlite.prepare("pragma table_info(followed_users)").all() as { name: string }[];
const followedUsersColNames = new Set(followedUsersCols.map((c) => c.name));
if (!followedUsersColNames.has("instagram_user_id")) {
  sqlite.exec(`ALTER TABLE followed_users ADD COLUMN instagram_user_id TEXT NOT NULL DEFAULT '';`);
}

// Add posted_shortcode to reposted_posts if missing (added in schema but not yet migrated)
const repostedPostsCols = sqlite.prepare("pragma table_info(reposted_posts)").all() as { name: string }[];
const repostedPostsColNames = new Set(repostedPostsCols.map((c) => c.name));
if (!repostedPostsColNames.has("posted_shortcode")) {
  sqlite.exec(`ALTER TABLE reposted_posts ADD COLUMN posted_shortcode TEXT NOT NULL DEFAULT '';`);
}

// Add username to instagram_api_calls if missing (added to schema after initial table creation)
const igApiCallsCols = sqlite.prepare("pragma table_info(instagram_api_calls)").all() as { name: string }[];
const igApiCallsColNames = new Set(igApiCallsCols.map((c) => c.name));
if (!igApiCallsColNames.has("username")) {
  sqlite.exec(`ALTER TABLE instagram_api_calls ADD COLUMN username TEXT DEFAULT '';`);
}
if (!igApiCallsColNames.has("is_error")) {
  sqlite.exec(`ALTER TABLE instagram_api_calls ADD COLUMN is_error INTEGER DEFAULT 0;`);
}
if (!igApiCallsColNames.has("transport")) {
  sqlite.exec(`ALTER TABLE instagram_api_calls ADD COLUMN transport TEXT DEFAULT 'ja3';`);
}

// Pre-status-change hit tracker — records the last API endpoint called before each status change.
// Linked by both profile_id and username so data survives EQX export/import cycles.
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS pre_status_change_hits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id INTEGER NOT NULL,
    username TEXT DEFAULT '',
    operation_name TEXT NOT NULL,
    from_status TEXT DEFAULT '',
    to_status TEXT NOT NULL,
    occurred_at TEXT NOT NULL
  );
`);

// DEVICE ISOLATION GUARD
// Two passes run on every startup:
//
// Pass 1 — Legacy format: clear any ig_device_state that lacks the `v` version
//   marker. These were generated by the old seed (userAgentApi alone, without
//   username) and may share UUIDs with other accounts — including accounts that
//   have since been deleted from this DB or existed in external tools (Jarvee).
//   Affected accounts re-generate a fresh unique fingerprint on next verify.
//
// Pass 2 — Duplicate UUIDs: even among v2 states, if two accounts somehow end
//   up with the same UUID, clear them both so they regenerate independently.
{
  // Pass 1: wipe unversioned (old-seed) device states
  const legacyResult = sqlite.prepare(`
    UPDATE profiles SET ig_device_state = NULL
    WHERE ig_device_state IS NOT NULL
      AND json_extract(ig_device_state, '$.v') IS NULL
  `).run();
  if (legacyResult.changes > 0) {
    console.error(`[db] DEVICE ISOLATION pass1: cleared ${legacyResult.changes} legacy (unversioned) device states — accounts must be re-verified`);
  }

  // Pass 2: wipe any v2 states whose UUID is shared across multiple profiles
  const dupeRows = sqlite.prepare(`
    SELECT id FROM profiles
    WHERE ig_device_state IS NOT NULL
      AND json_extract(ig_device_state, '$.uuid') IN (
        SELECT json_extract(ig_device_state, '$.uuid') AS uuid
        FROM profiles
        WHERE ig_device_state IS NOT NULL
        GROUP BY uuid
        HAVING COUNT(*) > 1
      )
  `).all() as { id: number }[];

  if (dupeRows.length > 0) {
    const clearDeviceState = sqlite.prepare("UPDATE profiles SET ig_device_state = NULL WHERE id = ?");
    const clearAll = sqlite.transaction((rows: { id: number }[]) => {
      for (const row of rows) clearDeviceState.run(row.id);
    });
    clearAll(dupeRows);
    console.error(`[db] DEVICE ISOLATION pass2: cleared ${dupeRows.length} accounts with shared device UUIDs — they must be re-verified`);
  }
}

// Migrate new context columns onto all 4 analytics tables (existing installs)
{
  const analyticsTableMap: Record<string, string> = {
    banned_accounts_analytics: "banned_accounts_analytics",
    automated_behaviour_analytics: "automated_behaviour_analytics",
    captcha_analytics: "captcha_analytics",
    locked_accounts_analytics: "locked_accounts_analytics",
  };
  const newAnalyticsCols = [
    "verify_count_last_24h INTEGER DEFAULT 0",
    "account_age_days INTEGER",
    "proxy_account_count INTEGER DEFAULT 0",
    "follow_count_before_ban INTEGER DEFAULT 0",
    "session_to_action_ratio TEXT",
    "span_hours TEXT",
    "last_operation_before_ban TEXT",
    "user_agent_api TEXT",
    "user_agent_embedded TEXT",
    "ig_device_state TEXT",
    "eb_fingerprint TEXT",
    "leak_snapshot TEXT",
  ];
  for (const table of Object.keys(analyticsTableMap)) {
    const cols = sqlite.prepare(`pragma table_info(${table})`).all() as { name: string }[];
    const colSet = new Set(cols.map(c => c.name));
    for (const colDef of newAnalyticsCols) {
      const colName = colDef.split(" ")[0];
      if (!colSet.has(colName)) {
        try { sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${colDef};`); } catch { /* already exists */ }
      }
    }
  }
}

// Cap to newest 1,000,000 rows — effectively unlimited for any real-world usage
// so that exported API call history is never silently discarded on restart.
// The previous 5000-row global cap was far too low: a single Verify All run on
// 100 accounts inserts ~1000 rows, so the history was being erased after just
// a few restarts.
sqlite.exec(`
  DELETE FROM instagram_api_calls WHERE id NOT IN (
    SELECT id FROM instagram_api_calls ORDER BY id DESC LIMIT 1000000
  );
`);

// Ensure every profile has a human_sessions tool record (safe to run on existing DBs)
const profileIds = sqlite.prepare("SELECT id FROM profiles").all() as { id: number }[];
const insertHumanSession = sqlite.prepare(
  `INSERT INTO tools (profile_id, type, enabled, settings)
   SELECT ?, 'human_sessions', 0, '{}'
   WHERE NOT EXISTS (SELECT 1 FROM tools WHERE profile_id = ? AND type = 'human_sessions')`
);
for (const { id } of profileIds) {
  insertHumanSession.run(id, id);
}

export { sqlite };
export const db = drizzle(sqlite, { schema });
export * from "./schema";
