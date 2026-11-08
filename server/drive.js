// Archivio sul Google Drive dell'amministratore.
// L'app usa solo lo scope "drive.file": vede e modifica esclusivamente i file che ha creato lei.
import crypto from 'node:crypto';
import { drive as driveApi, auth as gauth } from '@googleapis/drive';

export const SCOPES = [
  'https://www.googleapis.com/auth/drive.file',
  'openid',
  'email',
];
export const ROOT_FOLDER_NAME = process.env.DRIVE_FOLDER_NAME || 'Ambulatorio – Archivio';
export const SUBFOLDERS = {
  db: 'Database (backup)',
  files: 'Allegati',
  weeks: 'Calendari settimanali',
  months: 'Calendari mensili',
  requests: 'Richieste',
};
const FOLDER_MIME = 'application/vnd.google-apps.folder';

export function driveConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.PUBLIC_URL);
}

export function redirectUri() {
  return `${String(process.env.PUBLIC_URL || '').replace(/\/+$/, '')}/api/drive/callback`;
}

export function oauthClient(refreshToken) {
  const c = new gauth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, redirectUri());
  if (refreshToken) c.setCredentials({ refresh_token: refreshToken });
  return c;
}

// Cifratura del token salvato nel database (chiave derivata dal client secret).
function key() {
  return crypto.createHash('sha256').update(`ambulatorio-drive|${process.env.GOOGLE_CLIENT_SECRET || ''}`).digest();
}
export function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}
export function decrypt(payload) {
  try {
    const [iv, tag, enc] = String(payload).split('.').map((s) => Buffer.from(s, 'base64'));
    const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const q = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

// Operazioni su Drive. Isolate qui per poterle sostituire nei test.
export class GoogleDriveStore {
  constructor(refreshToken) {
    this.d = driveApi({ version: 'v3', auth: oauthClient(refreshToken) });
  }

  async findFolder(name, parentId) {
    const parent = parentId ? ` and '${q(parentId)}' in parents` : '';
    const r = await this.d.files.list({
      q: `mimeType = '${FOLDER_MIME}' and name = '${q(name)}' and trashed = false${parent}`,
      fields: 'files(id, name)',
      orderBy: 'createdTime',
      spaces: 'drive',
    });
    return r.data.files?.[0]?.id || null;
  }

  async ensureFolder(name, parentId) {
    const found = await this.findFolder(name, parentId);
    if (found) return found;
    const r = await this.d.files.create({
      requestBody: { name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined },
      fields: 'id',
    });
    return r.data.id;
  }

  async findFile(name, parentId) {
    const r = await this.d.files.list({
      q: `name = '${q(name)}' and '${q(parentId)}' in parents and trashed = false`,
      fields: 'files(id, name, modifiedTime)',
      orderBy: 'modifiedTime desc',
    });
    return r.data.files?.[0]?.id || null;
  }

  // Aggiorna il file se esiste ancora, altrimenti lo crea. Restituisce l'id.
  async upsert({ fileId, name, parentId, mime, data }) {
    const { Readable } = await import('node:stream');
    const media = () => ({ mimeType: mime, body: Readable.from(data) });
    if (fileId) {
      try {
        const r = await this.d.files.update({ fileId, media: media(), requestBody: { name }, fields: 'id' });
        return r.data.id;
      } catch (err) {
        if (![403, 404].includes(err?.code ?? err?.status)) throw err;
      }
    }
    const r = await this.d.files.create({ requestBody: { name, parents: [parentId] }, media: media(), fields: 'id' });
    return r.data.id;
  }

  async remove(fileId) {
    try {
      await this.d.files.delete({ fileId });
    } catch (err) {
      if ((err?.code ?? err?.status) !== 404) throw err;
    }
  }

  async download(fileId) {
    const r = await this.d.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    return Buffer.from(r.data);
  }
}

export async function exchangeCode(code) {
  const c = oauthClient();
  const { tokens } = await c.getToken(code);
  let email = null;
  if (tokens.id_token) {
    try {
      email = JSON.parse(Buffer.from(tokens.id_token.split('.')[1], 'base64url').toString('utf8')).email || null;
    } catch { /* email non disponibile */ }
  }
  return { refreshToken: tokens.refresh_token || null, accessToken: tokens.access_token, email };
}

export async function revoke(refreshToken) {
  try {
    await oauthClient().revokeToken(refreshToken);
  } catch { /* già revocato */ }
}
