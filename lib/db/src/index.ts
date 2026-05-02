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
    password TEXT
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
`);

// Add new columns if they don't exist yet (safe to run on existing DBs)
const existingCols = sqlite.prepare("pragma table_info(profiles)").all() as { name: string }[];
const colNames = new Set(existingCols.map((c) => c.name));
if (!colNames.has("ig_device_state")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN ig_device_state TEXT;`);
}
if (!colNames.has("ig_api_cookies")) {
  sqlite.exec(`ALTER TABLE profiles ADD COLUMN ig_api_cookies TEXT;`);
}

// Add new columns to sources and followed_users if they don't exist
const sourcesCols = sqlite.prepare("pragma table_info(sources)").all() as { name: string }[];
const sourcesColNames = new Set(sourcesCols.map((c) => c.name));
if (!sourcesColNames.has("target_user_id")) {
  sqlite.exec(`ALTER TABLE sources ADD COLUMN target_user_id TEXT NOT NULL DEFAULT '';`);
}
if (!sourcesColNames.has("hashtag_cursor")) {
  sqlite.exec(`ALTER TABLE sources ADD COLUMN hashtag_cursor TEXT NOT NULL DEFAULT '';`);
}
const followedUsersCols = sqlite.prepare("pragma table_info(followed_users)").all() as { name: string }[];
const followedUsersColNames = new Set(followedUsersCols.map((c) => c.name));
if (!followedUsersColNames.has("instagram_user_id")) {
  sqlite.exec(`ALTER TABLE followed_users ADD COLUMN instagram_user_id TEXT NOT NULL DEFAULT '';`);
}

// Cleanup: keep only named API operations — remove human-session noise and raw
// URL-path entries that were logged by older code. Cap to newest 5000 rows.
sqlite.exec(`
  DELETE FROM instagram_api_calls WHERE operation_name NOT IN (
    'Login','Follow','UnfollowUser','SendDM','UnsendDM',
    'HashtagScrape','FollowersScrape','GetUserByUsername',
    'GetUserProfile','GetOwnUser','SearchUser','LikeMedia','Auto Like'
  );
  DELETE FROM instagram_api_calls WHERE id NOT IN (
    SELECT id FROM instagram_api_calls ORDER BY id DESC LIMIT 5000
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

export const db = drizzle(sqlite, { schema });
export * from "./schema";
