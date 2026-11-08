// Backup completo dell'archivio (database + allegati + logo) in un unico file .zip,
// scaricabile dal Capo e ripristinabile dall'app stessa.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import AdmZip from 'adm-zip';
import { db, get, run, tx, now, DATA_DIR, UPLOAD_DIR, BRANDING_DIR } from './db.js';
import { HttpError } from './security.js';

const TABLES = ['users', 'settings', 'doctors', 'requests', 'appointments', 'drafts', 'week_locks', 'versions', 'files', 'activity_log'];
const SAFETY_DIR = path.join(DATA_DIR, 'backups');
const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function snapshotDb() {
  const tmp = path.join(DATA_DIR, `snapshot-${process.pid}-${Date.now()}.db`);
  db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  return tmp;
}

export function createBackup() {
  const tmp = snapshotDb();
  try {
    const zip = new AdmZip();
    zip.addLocalFile(tmp, '', 'ambulatorio.db');
    let files = 0;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      zip.addLocalFile(path.join(UPLOAD_DIR, f), 'uploads');
      files++;
    }
    for (const f of fs.readdirSync(BRANDING_DIR)) zip.addLocalFile(path.join(BRANDING_DIR, f), 'branding');
    const manifest = {
      app: 'ambulatorio',
      format: 1,
      createdAt: now(),
      counts: {
        richieste: get('SELECT COUNT(*) AS n FROM requests WHERE is_published = 1').n,
        appuntamenti: get('SELECT COUNT(*) AS n FROM appointments WHERE is_published = 1').n,
        allegati: files,
      },
    };
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)));
    return { buffer: zip.toBuffer(), filename: `Ambulatorio_Backup_${stamp()}.zip`, manifest };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Copia di sicurezza automatica prima di ogni ripristino (ne teniamo 5).
function safetyCopy() {
  fs.mkdirSync(SAFETY_DIR, { recursive: true });
  const { buffer } = createBackup();
  const name = `prima-del-ripristino_${stamp()}.zip`;
  fs.writeFileSync(path.join(SAFETY_DIR, name), buffer);
  const old = fs.readdirSync(SAFETY_DIR).filter((f) => f.startsWith('prima-del-ripristino_')).sort();
  while (old.length > 5) fs.rmSync(path.join(SAFETY_DIR, old.shift()), { force: true });
  return name;
}

const cols = (schema, table) => db.prepare(`PRAGMA ${schema}.table_info(${table})`).all().map((c) => c.name);

export function restoreBackup(buffer) {
  let zip;
  try {
    zip = new AdmZip(buffer);
  } catch {
    throw new HttpError(400, 'Il file non è un backup valido (zip non leggibile).');
  }
  const manifestEntry = zip.getEntry('manifest.json');
  const dbEntry = zip.getEntry('ambulatorio.db');
  let manifest = null;
  try { manifest = manifestEntry && JSON.parse(manifestEntry.getData().toString('utf8')); } catch { /* ignorato */ }
  if (!dbEntry || manifest?.app !== 'ambulatorio') throw new HttpError(400, 'Il file non è un backup di questa applicazione.');

  // Verifica del database contenuto nel backup.
  const tmp = path.join(DATA_DIR, `restore-${process.pid}-${Date.now()}.db`);
  fs.writeFileSync(tmp, dbEntry.getData());
  try {
    try {
      const check = new DatabaseSync(tmp, { readOnly: true });
      const ok = check.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n > 0;
      check.close();
      if (!ok) throw new Error('nessun amministratore');
    } catch {
      throw new HttpError(400, 'Il database nel backup è danneggiato o incompleto.');
    }

    const safety = safetyCopy();

    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS r`);
    try {
      tx(() => {
        run('DELETE FROM sessions');
        for (const t of [...TABLES].reverse()) run(`DELETE FROM main.${t}`);
        for (const t of TABLES) {
          const theirs = new Set(cols('r', t));
          const common = cols('main', t).filter((c) => theirs.has(c));
          if (!common.length) continue;
          const list = common.join(', ');
          db.exec(`INSERT INTO main.${t} (${list}) SELECT ${list} FROM r.${t}`);
        }
      });
    } finally {
      db.exec('DETACH DATABASE r');
    }

    // Allegati e logo: sostituiti con quelli del backup (nomi controllati, niente percorsi).
    for (const f of fs.readdirSync(UPLOAD_DIR)) fs.rmSync(path.join(UPLOAD_DIR, f), { force: true });
    for (const f of fs.readdirSync(BRANDING_DIR)) fs.rmSync(path.join(BRANDING_DIR, f), { force: true });
    let files = 0;
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const [dir, name, extra] = e.entryName.split('/');
      if (extra !== undefined) continue;
      if (dir === 'uploads' && /^[a-f0-9]{32}$/.test(name)) {
        fs.writeFileSync(path.join(UPLOAD_DIR, name), e.getData());
        files++;
      } else if (dir === 'branding' && /^logo\.(png|jpg|webp|svg)$/.test(name)) {
        fs.writeFileSync(path.join(BRANDING_DIR, name), e.getData());
      }
    }
    return { manifest, files, safety };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
