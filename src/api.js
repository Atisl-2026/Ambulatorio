// Accesso ai dati tramite Supabase. Mantiene la stessa interfaccia "a percorsi" usata dalle pagine
// (api.get('/requests'), api.post('/requests/12/publish', …)) traducendola in chiamate al database
// (funzioni RPC con regole e permessi) e alle funzioni cloud.
import { supabase, SUPABASE_URL, SUPABASE_KEY, usernameToEmail } from './supabase.js';

export class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => { onUnauthorized = fn; };

function toApiError(error) {
  const m = /^PT(\d{3})$/.exec(error?.code || '');
  const status = m ? Number(m[1]) : error?.status || 400;
  let code;
  if (status === 423) code = 'LOCKED';
  else if (status === 404) code = 'NOT_FOUND';
  else if (status === 403 && /cambiare la password/.test(error?.message || '')) code = 'MUST_CHANGE_PASSWORD';
  let message = error?.message || 'Operazione non riuscita.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) message = 'Connessione non disponibile. Controlla la rete.';
  else if (!m && error?.code === '42501') message = 'Operazione non consentita.';
  const err = new ApiError(status, message, code);
  if (status === 401) onUnauthorized(err);
  return err;
}

async function rpc(name, args = {}) {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw toApiError(error);
  return data;
}

async function fn(name, body) {
  const { data: { session } } = await supabase.auth.getSession();
  let res;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: SUPABASE_KEY, Authorization: `Bearer ${session?.access_token || SUPABASE_KEY}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Connessione non disponibile. Controlla la rete.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(res.status, data.error || data.message || `Errore ${res.status}`, data.code);
    if (res.status === 401) onUnauthorized(err);
    throw err;
  }
  return data;
}

const logEvent = (action, details) => supabase.rpc('log_event', { p_action: action, p_details: details }).then(() => {}, () => {});

// ---------- Autenticazione ----------

export async function currentUser() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return null;
  const { data } = await supabase.rpc('my_profile');
  if (!data || !data.active) {
    await supabase.auth.signOut().catch(() => {});
    return null;
  }
  return data;
}

export async function login(username, password) {
  const { error } = await supabase.auth.signInWithPassword({ email: usernameToEmail(username), password });
  if (error) {
    if (/banned/i.test(error.message)) throw new ApiError(401, 'Account disattivato. Contatta l\'amministratore.');
    if (error.status === 429) throw new ApiError(429, 'Troppi tentativi. Riprova tra qualche minuto.');
    throw new ApiError(401, 'Nome utente o password errati.');
  }
  const user = await currentUser();
  if (!user) throw new ApiError(401, 'Account non attivo. Contatta l\'amministratore.');
  logEvent('accesso', 'Accesso effettuato');
  return user;
}

export async function logout() {
  await logEvent('uscita', 'Uscita dall\'applicazione');
  await supabase.auth.signOut().catch(() => {});
}

export async function changePassword(current, next) {
  if (typeof next !== 'string' || next.length < 10) throw new ApiError(400, 'La password deve avere almeno 10 caratteri.');
  if (!/[A-Za-z]/.test(next) || !/\d/.test(next)) throw new ApiError(400, 'La password deve contenere lettere e numeri.');
  if (next === current) throw new ApiError(400, 'La nuova password deve essere diversa da quella attuale.');
  const me = await rpc('my_profile');
  const { error: e1 } = await supabase.auth.signInWithPassword({ email: usernameToEmail(me.username), password: current });
  if (e1) throw new ApiError(400, 'La password attuale non è corretta.');
  const { error: e2 } = await supabase.auth.updateUser({ password: next });
  if (e2) throw new ApiError(400, /weak|short|length/i.test(e2.message) ? 'Password troppo debole.' : e2.message);
  return rpc('mark_password_changed');
}

export const setupStatus = () => fn('admin-users', { action: 'status' });
export const createFirstAdmin = (b) => fn('admin-users', { action: 'bootstrap', ...b });

// ---------- Allegati ----------

export async function uploadFile(file) {
  const { data: { user } } = await supabase.auth.getUser();
  const path = `${user.id}/${crypto.randomUUID()}`;
  const mime = file.type || 'application/octet-stream';
  const { error } = await supabase.storage.from('attachments').upload(path, file, { contentType: mime });
  if (error) throw new ApiError(400, /exceeded|too large/i.test(error.message) ? 'File troppo grande (max 15 MB).' : `Caricamento non riuscito: ${error.message}`);
  const { data, error: e2 } = await supabase.from('files').insert({ path, name: file.name.slice(0, 200), mime, size: file.size }).select().single();
  if (e2) throw toApiError(e2);
  return { id: data.id, name: data.name, mime: data.mime, size: data.size, path: data.path };
}

export async function openFile(att) {
  const inline = /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(att.mime || '');
  const { data, error } = await supabase.storage.from('attachments')
    .createSignedUrl(att.path, 120, inline ? undefined : { download: att.name });
  if (error) throw new ApiError(404, 'File non disponibile.');
  window.open(data.signedUrl, '_blank', 'noopener');
}

// ---------- Excel (generato sul dispositivo del Capo) ----------

async function saveBlob(blob, name) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = href;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 5000);
  return name;
}

async function exportCalendar(from, to, title, fileName) {
  const rows = await rpc('export_rows', { p_from: from, p_to: to });
  const [{ default: ExcelJS }, { buildCalendarXlsx }] = await Promise.all([import('exceljs'), import('@shared/excel.js')]);
  const bytes = await buildCalendarXlsx(ExcelJS, title, rows);
  logEvent('esportazione', `Esportato ${fileName} (${rows.length} appuntamenti)`);
  return saveBlob(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), fileName);
}

// ---------- Backup ----------

async function downloadBackup() {
  const dump = await rpc('backup_dump');
  const { zipSync, strToU8 } = await import('fflate');
  const files = { 'backup.json': strToU8(JSON.stringify(dump)) };
  for (const f of dump.tables.files) {
    const { data } = await supabase.storage.from('attachments').download(f.path);
    if (data) files[`allegati/${f.path}`] = new Uint8Array(await data.arrayBuffer());
  }
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `Ambulatorio_Backup_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.zip`;
  logEvent('backup', `Scaricato backup completo ${name} (${dump.tables.requests.length} richieste, ${dump.tables.appointments.length} appuntamenti, ${dump.tables.files.length} allegati)`);
  return saveBlob(new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' }), name);
}

async function restoreBackup(file) {
  const { unzipSync, strFromU8 } = await import('fflate');
  let entries;
  try {
    entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
  } catch {
    throw new ApiError(400, 'Il file non è un backup valido (zip non leggibile).');
  }
  if (!entries['backup.json']) throw new ApiError(400, 'Il file non è un backup di questa applicazione.');
  const dump = JSON.parse(strFromU8(entries['backup.json']));
  await rpc('backup_restore', { p: dump });
  let restored = 0;
  for (const f of dump.tables.files || []) {
    const bytes = entries[`allegati/${f.path}`];
    if (!bytes) continue;
    const { error } = await supabase.storage.from('attachments').upload(f.path, new Blob([bytes], { type: f.mime }), { upsert: true, contentType: f.mime });
    if (!error) restored++;
  }
  return { ok: true, files: restored };
}

// ---------- Instradamento dei percorsi ----------

const KIND = { requests: 'request', appointments: 'appointment' };
const num = (s) => Number(s);

async function route(method, url, body) {
  const [path, qs] = url.split('?');
  const q = Object.fromEntries(new URLSearchParams(qs || ''));
  const p = path.split('/').filter(Boolean);
  let m;

  if (path === '/settings' && method === 'GET') {
    const s = await rpc('get_settings');
    const me = await rpc('my_profile');
    if (me?.role === 'admin') s.aiConfigured = await fn('ai', { action: 'status' }).then((r) => r.configured, () => undefined);
    return s;
  }
  if (path === '/settings/ai' && method === 'PUT') return rpc('set_ai_enabled', { p_enabled: !!body.enabled });

  if (path === '/users/directory') return rpc('user_directory');
  if (path === '/users' && method === 'GET') return rpc('list_users');
  if (path === '/users' && method === 'POST') return fn('admin-users', { action: 'create', ...body });
  if ((m = /^\/users\/([\w-]+)$/.exec(path)) && method === 'PATCH') return fn('admin-users', { action: 'update', id: m[1], ...body });

  if (path === '/doctors' && method === 'GET') return rpc('list_doctors');
  if (path === '/doctors' && method === 'POST') return rpc('save_doctor', { p_id: null, p_name: body.name, p_specialty: body.specialty ?? '' });
  if ((m = /^\/doctors\/(\d+)$/.exec(path)) && method === 'PATCH') {
    return rpc('save_doctor', { p_id: num(m[1]), p_name: body.name ?? null, p_specialty: body.specialty ?? null, p_active: body.active ?? null });
  }

  if (KIND[p[0]]) {
    const kind = KIND[p[0]];
    if (p.length === 1 && method === 'GET') return rpc('list_items', { p_kind: kind, p_from: q.from || null, p_to: q.to || null });
    if (p.length === 1 && method === 'POST') return rpc('create_item', { p_kind: kind, p_data: body.data });
    if (p[1] === 'new' && p[2] === 'publish') return rpc('publish_item', { p_kind: kind, p_id: null, p_data: body.data });
    const id = num(p[1]);
    if (p.length === 2 && method === 'GET') return rpc('get_item', { p_kind: kind, p_id: id });
    if (p.length === 2 && method === 'DELETE') {
      const r = await rpc('delete_item', { p_kind: kind, p_id: id });
      if (r.paths?.length) await supabase.storage.from('attachments').remove(r.paths);
      return r;
    }
    if (p[2] === 'draft' && method === 'PUT') return rpc('save_draft', { p_kind: kind, p_id: id, p_data: body.data });
    if (p[2] === 'draft' && method === 'DELETE') return rpc('discard_draft', { p_kind: kind, p_id: id });
    if (p[2] === 'publish') return rpc('publish_item', { p_kind: kind, p_id: id, p_data: body.data ?? null });
    if (p[2] === 'lock') return rpc('set_item_lock', { p_kind: kind, p_id: id, p_locked: !!body.locked });
    if (p[2] === 'versions') return rpc('list_versions', { p_kind: kind, p_id: id });
  }

  if (path === '/weeks/locks') return rpc('week_locks_range', { p_from: q.from, p_to: q.to });
  if ((m = /^\/weeks\/([\d-]+)\/lock$/.exec(path))) return rpc('set_week_lock', { p_week: m[1], p_locked: !!body.locked });

  if (path === '/archive/search') return rpc('archive_search', { p: q });
  if (path === '/archive/weeks') return rpc('archive_weeks');
  if ((m = /^\/archive\/weeks\/([\d-]+)$/.exec(path))) {
    return method === 'DELETE' ? rpc('delete_week', { p_week: m[1] }) : rpc('archive_week', { p_week: m[1] });
  }

  if (path === '/logs') return rpc('list_logs', { p: q });

  if ((m = /^\/ai\/(summarize|ask|conflicts|report)$/.exec(path))) return fn('ai', { action: m[1], ...body });

  if (path === '/mail/settings' && method === 'GET') {
    const [s, st] = await Promise.all([rpc('get_mail_settings'), fn('monthly-email', { action: 'status' }).catch(() => ({}))]);
    return { ...s, configured: !!st.configured, from: st.from || null, sendHour: st.sendHour ?? 7 };
  }
  if (path === '/mail/settings' && method === 'PUT') {
    await rpc('set_mail_settings', { p_enabled: !!body.enabled, p_recipients: body.recipients || '' });
    return route('GET', '/mail/settings');
  }
  if (path === '/mail/send') {
    const r = await fn('monthly-email', { action: 'send', month: body.month, recipients: body.recipients });
    return { ...r, settings: await route('GET', '/mail/settings') };
  }

  throw new ApiError(404, `Operazione non disponibile: ${method} ${path}`);
}

export const api = {
  get: (url) => route('GET', url),
  post: (url, body = {}) => route('POST', url, body),
  put: (url, body = {}) => route('PUT', url, body),
  patch: (url, body = {}) => route('PATCH', url, body),
  del: (url) => route('DELETE', url),
  upload: (url, file) => {
    if (url === '/files') return uploadFile(file);
    if (url === '/backup/restore') return restoreBackup(file);
    if (url === '/settings/logo') return uploadLogo(file);
    throw new ApiError(404, 'Operazione non disponibile.');
  },
  download: async (url) => {
    const [path, qs] = url.split('?');
    const q = Object.fromEntries(new URLSearchParams(qs || ''));
    const { mondayFromWeekKey, addDays } = await import('@shared/dates.js');
    const { monthInfo, weekFileName } = await import('@shared/excel.js');
    if (path === '/export/week') {
      const monday = mondayFromWeekKey(q.week);
      if (!monday) throw new ApiError(400, 'Settimana non valida.');
      return exportCalendar(monday, addDays(monday, 5), `Settimana ${q.week}`, weekFileName(q.week));
    }
    if (path === '/export/month') {
      const info = monthInfo(q.month);
      if (!info) throw new ApiError(400, 'Mese non valido.');
      return exportCalendar(info.from, info.to, info.label, info.fileName);
    }
    if (path === '/backup') return downloadBackup();
    throw new ApiError(404, 'Operazione non disponibile.');
  },
};

async function uploadLogo(file) {
  const ok = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'].includes(file.type);
  if (!ok || file.size > 3 * 1024 * 1024) throw new ApiError(400, 'Carica un\'immagine PNG, JPG, WEBP o SVG (max 3 MB).');
  const { error } = await supabase.storage.from('branding').upload('logo', file, { upsert: true, contentType: file.type, cacheControl: '60' });
  if (error) throw new ApiError(400, `Caricamento non riuscito: ${error.message}`);
  await logEvent('logo', 'Logo aggiornato');
  return { ok: true };
}

export const basePath = (kind) => (kind === 'request' ? '/requests' : '/appointments');
