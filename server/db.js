import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hashPassword } from './security.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const BRANDING_DIR = path.join(DATA_DIR, 'branding');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(BRANDING_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'ambulatorio.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','operator')),
  password_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, created_by INTEGER,
  updated_at TEXT NOT NULL, updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT, updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS doctors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  specialty TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, created_by INTEGER,
  updated_at TEXT NOT NULL, updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  client TEXT NOT NULL DEFAULT '',
  date TEXT,
  status TEXT NOT NULL DEFAULT 'Nuova',
  attachments TEXT NOT NULL DEFAULT '[]',
  is_published INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  published_at TEXT, published_by INTEGER,
  locked INTEGER NOT NULL DEFAULT 0, locked_at TEXT, locked_by INTEGER,
  created_at TEXT NOT NULL, created_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL, updated_by INTEGER
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_id INTEGER,
  doctor_id INTEGER,
  day TEXT,
  time TEXT,
  client TEXT NOT NULL DEFAULT '',
  docs_checked INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  is_published INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  published_at TEXT, published_by INTEGER,
  locked INTEGER NOT NULL DEFAULT 0, locked_at TEXT, locked_by INTEGER,
  created_at TEXT NOT NULL, created_by INTEGER NOT NULL,
  updated_at TEXT NOT NULL, updated_by INTEGER
);
CREATE INDEX IF NOT EXISTS idx_appointments_day ON appointments(day);
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  data TEXT NOT NULL,
  base_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (kind, item_id, user_id)
);
CREATE TABLE IF NOT EXISTS week_locks (
  week_start TEXT PRIMARY KEY,
  locked_at TEXT NOT NULL,
  locked_by INTEGER
);
CREATE TABLE IF NOT EXISTS versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,
  data TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_item ON versions(kind, item_id);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  original_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  stored_name TEXT NOT NULL,
  uploaded_by INTEGER,
  uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  kind TEXT,
  item_id INTEGER,
  details TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_log_at ON activity_log(at);
`);

// Migrazioni leggere.
if (!db.prepare('PRAGMA table_info(files)').all().some((c) => c.name === 'drive_id')) {
  db.exec('ALTER TABLE files ADD COLUMN drive_id TEXT');
}

const stmtCache = new Map();
function stmt(sql) {
  let s = stmtCache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}
const clean = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? (p ? 1 : 0) : p));
export const get = (sql, ...p) => stmt(sql).get(...clean(p));
export const all = (sql, ...p) => stmt(sql).all(...clean(p));
export const run = (sql, ...p) => stmt(sql).run(...clean(p));

let txDepth = 0;
export function tx(fn) {
  if (txDepth > 0) return fn();
  db.exec('BEGIN IMMEDIATE');
  txDepth++;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth--;
  }
}

export const now = () => new Date().toISOString();

export function getSetting(key, fallback = null) {
  const r = get('SELECT value FROM settings WHERE key = ?', key);
  return r ? r.value : fallback;
}
export function setSetting(key, value, userId) {
  run(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, String(value), now(), userId,
  );
}

export function userNames() {
  const map = new Map();
  for (const u of all('SELECT id, display_name FROM users')) map.set(u.id, u.display_name);
  return map;
}

// Primo avvio: crea l'account del Capo.
export function ensureAdmin() {
  const count = get('SELECT COUNT(*) AS n FROM users').n;
  if (count > 0) return;
  const username = process.env.ADMIN_USERNAME || 'capo';
  const generated = !process.env.ADMIN_PASSWORD;
  const password = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const t = now();
  run(
    `INSERT INTO users (username, display_name, role, password_hash, active, must_change_password, created_at, updated_at)
     VALUES (?, ?, 'admin', ?, 1, 1, ?, ?)`,
    username, process.env.ADMIN_NAME || 'Il Capo', hashPassword(password), t, t,
  );
  console.log('\n==============================================');
  console.log(' Creato account amministratore ("il Capo")');
  console.log(`   utente:   ${username}`);
  console.log(`   password: ${generated ? password : '(quella impostata in ADMIN_PASSWORD)'}`);
  console.log(' Al primo accesso verrà chiesto di cambiarla.');
  console.log('==============================================\n');
}
