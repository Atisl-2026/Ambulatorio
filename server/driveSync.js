// Sincronizzazione dell'archivio verso il Google Drive dell'amministratore.
// Struttura sul Drive:
//   Ambulatorio – Archivio/
//     Database (backup)/   ambulatorio.db (sempre aggiornato) + una copia al giorno (30 giorni)
//     Allegati/            i documenti allegati alle richieste pubblicate
//     Calendari settimanali/  Ambulatorio_Settimana_AAAA-Wnn.xlsx
//     Calendari mensili/      Ambulatorio_<Mese>_<Anno>.xlsx
//     Richieste/              Registro_richieste.xlsx
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, get, all, run, now, getSetting, setSetting, DATA_DIR, UPLOAD_DIR } from './db.js';
import { GoogleDriveStore, ROOT_FOLDER_NAME, SUBFOLDERS, driveConfigured, decrypt, redirectUri } from './drive.js';
import { exportWeek, exportMonth, exportRequests } from './export.js';
import { restoreState } from './restore.js';
import { mondayOf, weekKey, toISO, MONTHS } from '../shared/dates.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DAILY_KEEP = 30;

let storeFactory = (token) => new GoogleDriveStore(token);
export const setStoreFactory = (fn) => { storeFactory = fn; };

export function refreshToken() {
  return process.env.GOOGLE_REFRESH_TOKEN || decrypt(getSetting('drive_token_enc', '') || '') || null;
}
export const driveConnected = () => !!refreshToken();

function loadState() {
  try { return JSON.parse(getSetting('drive_state', '{}') || '{}'); } catch { return {}; }
}
const saveState = (s) => setSetting('drive_state', JSON.stringify(s), null);
const sha = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex');

// ---------- Pianificazione ----------

let timer = null;
let running = null;
let again = false;

export function scheduleSync(delayMs = 15000) {
  if (!driveConnected()) return;
  clearTimeout(timer);
  timer = setTimeout(() => { runSync().catch(() => {}); }, delayMs);
}

export async function runSync() {
  if (running) {
    again = true;
    return running;
  }
  running = doSync().finally(() => {
    running = null;
    if (again) {
      again = false;
      scheduleSync(1000);
    }
  });
  return running;
}

export function startDriveSync() {
  setInterval(() => scheduleSync(0), 10 * 60 * 1000).unref();
  scheduleSync(5000);
}

// ---------- Sincronizzazione ----------

async function doSync() {
  const token = refreshToken();
  if (!token) return loadState();
  const st = loadState();
  if (restoreState.failed) {
    st.lastError = restoreState.message;
    saveState(st);
    return st;
  }
  st.running = true;
  try {
    const store = storeFactory(token);
    const root = await store.ensureFolder(ROOT_FOLDER_NAME, null);
    const folders = { root };
    for (const [k, name] of Object.entries(SUBFOLDERS)) folders[k] = await store.ensureFolder(name, root);
    st.folders = folders;

    await syncAttachments(store, folders);
    await syncGroups(store, st, 'weeks', folders.weeks, weekGroups(), (m) => exportWeek(weekKey(m), 'Archivio automatico'));
    await syncGroups(store, st, 'months', folders.months, monthGroups(), (ym) => exportMonth(ym, 'Archivio automatico'));
    await syncGroups(store, st, 'requests', folders.requests, requestGroups(), () => exportRequests('Archivio automatico'));
    await syncDatabase(store, st, folders.db);

    st.lastSync = now();
    st.lastError = null;
  } catch (err) {
    st.lastError = describe(err);
    st.lastErrorAt = now();
    console.error('[Drive] sincronizzazione non riuscita:', err?.message || err);
  } finally {
    st.running = false;
    saveState(st);
  }
  return st;
}

function describe(err) {
  const code = err?.code ?? err?.status ?? err?.response?.status;
  const msg = err?.response?.data?.error_description || err?.response?.data?.error?.message || err?.message || String(err);
  if (msg === 'invalid_grant' || /invalid_grant/.test(msg)) return 'Autorizzazione Google scaduta o revocata: ricollega il Drive.';
  if (code === 403 && /quota|storage/i.test(msg)) return 'Spazio sul Google Drive esaurito.';
  return `Errore Google Drive${code ? ` (${code})` : ''}: ${msg}`;
}

// Firma dei nomi (utenti/medici): se cambiano, si rigenerano i file.
function namesStamp() {
  const u = get('SELECT MAX(updated_at) AS m FROM users').m;
  const d = get('SELECT MAX(updated_at) AS m FROM doctors').m;
  return `${u}|${d}`;
}

function weekGroups() {
  const stamp = namesStamp();
  const locks = new Map(all('SELECT week_start, locked_at FROM week_locks').map((w) => [w.week_start, w.locked_at]));
  const groups = new Map();
  for (const a of all('SELECT * FROM appointments WHERE is_published = 1 AND day IS NOT NULL ORDER BY id')) {
    const m = mondayOf(a.day);
    if (!groups.has(m)) groups.set(m, []);
    groups.get(m).push(a);
  }
  const out = new Map();
  for (const [m, rows] of groups) out.set(m, { sig: sha([rows, locks.get(m) || null, stamp]), name: `Ambulatorio_Settimana_${weekKey(m)}.xlsx` });
  return out;
}

function monthGroups() {
  const stamp = namesStamp();
  const locks = all('SELECT week_start FROM week_locks').map((w) => w.week_start);
  const groups = new Map();
  for (const a of all('SELECT * FROM appointments WHERE is_published = 1 AND day IS NOT NULL ORDER BY id')) {
    const ym = a.day.slice(0, 7);
    if (!groups.has(ym)) groups.set(ym, []);
    groups.get(ym).push(a);
  }
  const out = new Map();
  for (const [ym, rows] of groups) {
    const [y, mo] = ym.split('-').map(Number);
    out.set(ym, { sig: sha([rows, locks, stamp]), name: `Ambulatorio_${MONTHS[mo - 1]}_${y}.xlsx` });
  }
  return out;
}

function requestGroups() {
  const rows = all('SELECT * FROM requests WHERE is_published = 1 ORDER BY id');
  const out = new Map();
  if (rows.length) out.set('registro', { sig: sha([rows, namesStamp()]), name: 'Registro_richieste.xlsx' });
  return out;
}

// Carica/aggiorna solo i file la cui firma è cambiata; elimina quelli non più presenti.
async function syncGroups(store, st, key, folderId, groups, build) {
  st[key] = st[key] || {};
  const known = st[key];
  for (const [id, g] of groups) {
    if (known[id]?.sig === g.sig) continue;
    const { buffer } = await build(id);
    // Se lo stato locale è andato perso, riusa il file già presente sul Drive invece di duplicarlo.
    const existing = known[id]?.fileId || await store.findFile(g.name, folderId);
    const fileId = await store.upsert({ fileId: existing, name: g.name, parentId: folderId, mime: XLSX, data: Buffer.from(buffer) });
    known[id] = { sig: g.sig, fileId, at: now() };
    saveState(st);
  }
  for (const id of Object.keys(known)) {
    if (groups.has(id)) continue;
    if (known[id].fileId) await store.remove(known[id].fileId);
    delete known[id];
    saveState(st);
  }
}

async function syncAttachments(store, folders) {
  const pending = all('SELECT * FROM files WHERE drive_id IS NULL ORDER BY uploaded_at');
  for (const f of pending) {
    // Solo gli allegati di richieste pubblicate: le bozze restano private.
    const req = get('SELECT id FROM requests WHERE is_published = 1 AND attachments LIKE ? ORDER BY id LIMIT 1', `%"${f.id}"%`);
    if (!req) continue;
    const p = path.join(UPLOAD_DIR, f.stored_name);
    if (!fs.existsSync(p)) continue;
    const id = await store.upsert({
      name: `Richiesta ${req.id} - ${f.original_name}`, parentId: folders.files, mime: f.mime, data: fs.readFileSync(p),
    });
    run('UPDATE files SET drive_id = ? WHERE id = ?', id, f.id);
  }
}

async function syncDatabase(store, st, folderId) {
  const marker = `${get('SELECT MAX(id) AS m FROM activity_log').m}|${namesStamp()}`;
  const today = toISO(new Date());
  st.daily = st.daily || {};
  if (st.dbMarker === marker && st.daily[today]) return;
  const tmp = path.join(DATA_DIR, `backup-${process.pid}.db`);
  fs.rmSync(tmp, { force: true });
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  try {
    const data = fs.readFileSync(tmp);
    st.dbFileId = await store.upsert({ fileId: st.dbFileId || await store.findFile('ambulatorio.db', folderId), name: 'ambulatorio.db', parentId: folderId, mime: 'application/x-sqlite3', data });
    if (!st.daily[today]) {
      st.daily[today] = await store.upsert({ fileId: await store.findFile(`ambulatorio_${today}.db`, folderId), name: `ambulatorio_${today}.db`, parentId: folderId, mime: 'application/x-sqlite3', data });
    }
    const days = Object.keys(st.daily).sort();
    while (days.length > DAILY_KEEP) {
      const old = days.shift();
      await store.remove(st.daily[old]);
      delete st.daily[old];
    }
    st.dbMarker = marker;
    st.dbAt = now();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- Allegati: copia locale mancante (es. dopo un ripristino) ----------

export async function ensureLocalFile(f) {
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (fs.existsSync(p)) return p;
  if (!f.drive_id || !driveConnected()) return null;
  const data = await storeFactory(refreshToken()).download(f.drive_id);
  fs.writeFileSync(p, data);
  return p;
}

export function deleteRemote(fileId) {
  if (!fileId || !driveConnected()) return;
  storeFactory(refreshToken()).remove(fileId).catch((e) => console.error('[Drive] eliminazione non riuscita:', e?.message));
}

// ---------- Stato per l'amministratore ----------

export function driveStatus() {
  const st = loadState();
  return {
    configured: driveConfigured(),
    connected: driveConnected(),
    fromEnv: !!process.env.GOOGLE_REFRESH_TOKEN,
    account: getSetting('drive_account', null),
    connectedAt: getSetting('drive_connected_at', null),
    folderUrl: st.folders?.root ? `https://drive.google.com/drive/folders/${st.folders.root}` : null,
    folderName: ROOT_FOLDER_NAME,
    lastSync: st.lastSync || null,
    lastError: st.lastError || null,
    running: !!running,
    counts: {
      weeks: Object.keys(st.weeks || {}).length,
      months: Object.keys(st.months || {}).length,
      requests: Object.keys(st.requests || {}).length ? 1 : 0,
      attachments: get('SELECT COUNT(*) AS n FROM files WHERE drive_id IS NOT NULL').n,
      dailyBackups: Object.keys(st.daily || {}).length,
    },
    dbAt: st.dbAt || null,
    restore: restoreState.attempted ? restoreState : null,
    redirectUri: redirectUri(),
  };
}

export function resetDriveState() {
  setSetting('drive_state', '{}', null);
  run('UPDATE files SET drive_id = NULL');
}
