// Ripristino automatico dell'archivio dal Google Drive dell'amministratore.
// Va importato PRIMA di db.js: se il database locale non esiste (es. hosting senza disco
// permanente) e GOOGLE_REFRESH_TOKEN è impostato, scarica l'ultimo backup dal Drive.
import fs from 'node:fs';
import path from 'node:path';
import { GoogleDriveStore, ROOT_FOLDER_NAME, SUBFOLDERS } from './drive.js';

export const restoreState = { attempted: false, ok: false, failed: false, message: null };

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const DB_PATH = path.join(DATA_DIR, 'ambulatorio.db');

if (!fs.existsSync(DB_PATH) && process.env.GOOGLE_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  restoreState.attempted = true;
  try {
    const store = new GoogleDriveStore(process.env.GOOGLE_REFRESH_TOKEN);
    const root = await store.findFolder(ROOT_FOLDER_NAME);
    const dbFolder = root && await store.findFolder(SUBFOLDERS.db, root);
    const fileId = dbFolder && await store.findFile('ambulatorio.db', dbFolder);
    if (fileId) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(`${DB_PATH}.download`, await store.download(fileId));
      fs.renameSync(`${DB_PATH}.download`, DB_PATH);
      restoreState.ok = true;
      restoreState.message = 'Archivio ripristinato dal Google Drive dell\'amministratore.';
    } else {
      restoreState.message = 'Nessun backup trovato sul Drive: avvio con un archivio nuovo.';
    }
  } catch (err) {
    restoreState.failed = true;
    restoreState.message = `Ripristino dal Drive non riuscito (${err.message}). La sincronizzazione resta sospesa per non sovrascrivere l'archivio sul Drive.`;
  }
  console.log(`[Drive] ${restoreState.message}`);
}
