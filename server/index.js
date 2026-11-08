import './tz.js';
import './restore.js';
import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { get, all, run, tx, now, getSetting, setSetting, ensureAdmin, userNames, UPLOAD_DIR, BRANDING_DIR } from './db.js';
import {
  HttpError, hashPassword, verifyPassword, checkPasswordStrength, loginBlocked, registerFailure, clearFailures, norm, str,
} from './security.js';
import { createSession, destroySession, sessionUser, requireAuth, requireAdmin, csrfGuard } from './auth.js';
import { attachClient, broadcast, revokeUser, onlineCount, onSharedChange } from './realtime.js';
import { logActivity } from './log.js';
import {
  KINDS, REQUEST_STATUSES, kindDef, listVisible, serializeOne, createItem, saveDraft, discardDraft, publish, setLock,
  deleteItem, listVersions, setWeekLock, weekLocksInRange, makeContext, rowData, withNames,
} from './entities.js';
import { aiConfigured, aiEnabled, summarizeRequest, askArchive, conflictReport, periodReport } from './ai.js';
import { exportWeek, exportMonth } from './export.js';
import { driveConfigured, SCOPES, oauthClient, exchangeCode, encrypt, revoke } from './drive.js';
import {
  driveStatus, runSync, scheduleSync, startDriveSync, ensureLocalFile, deleteRemote, refreshToken, resetDriveState,
} from './driveSync.js';
import { isISODate, mondayOf, addDays, weekKey } from '../shared/dates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT || 3000);
// Modalità HTTPS: TLS gestito dal server, oppure da un proxy davanti (FORCE_HTTPS / COOKIE_SECURE).
const HTTPS_MODE = !!process.env.TLS_CERT_FILE || process.env.FORCE_HTTPS === 'true' || process.env.COOKIE_SECURE === 'true';

ensureAdmin();

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'style-src': ["'self'", "'unsafe-inline'"],
      'connect-src': ["'self'"],
      'upgrade-insecure-requests': HTTPS_MODE ? [] : null,
    },
  },
  strictTransportSecurity: HTTPS_MODE ? { maxAge: 31536000 } : false,
}));

// Forza HTTPS quando l'app è dietro un proxy che termina TLS.
if (process.env.FORCE_HTTPS === 'true') {
  app.use((req, res, next) => (req.secure ? next() : res.redirect(301, `https://${req.headers.host}${req.originalUrl}`)));
}

app.use('/api', express.json({ limit: '1mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', csrfGuard);

const api = express.Router();
app.use('/api', api);

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, role: u.role, mustChangePassword: u.mustChangePassword });

// ================= Autenticazione =================

api.post('/auth/login', (req, res) => {
  const username = String(req.body?.username || '').trim();
  const password = String(req.body?.password || '');
  const key = `${req.ip}|${username.toLowerCase()}`;
  if (loginBlocked(key)) throw new HttpError(429, 'Troppi tentativi falliti. Riprova tra 15 minuti.');
  const u = get('SELECT * FROM users WHERE username = ?', username);
  const ok = u && verifyPassword(password, u.password_hash);
  if (!ok || !u.active) {
    registerFailure(key);
    logActivity(req, 'accesso_fallito', `Tentativo di accesso fallito per "${username.slice(0, 50)}"${u && !u.active ? ' (account disattivato)' : ''}`);
    throw new HttpError(401, u && ok && !u.active ? 'Account disattivato. Contatta l\'amministratore.' : 'Nome utente o password errati.');
  }
  clearFailures(key);
  createSession(req, res, u.id);
  req.user = { id: u.id, displayName: u.display_name };
  logActivity(req, 'accesso', 'Accesso effettuato');
  res.json({ user: publicUser({ id: u.id, username: u.username, displayName: u.display_name, role: u.role, mustChangePassword: !!u.must_change_password }) });
});

api.post('/auth/logout', (req, res) => {
  const u = sessionUser(req, { touch: false });
  if (u) {
    req.user = u;
    logActivity(req, 'uscita', 'Uscita dall\'applicazione');
  }
  destroySession(req, res);
  res.json({ ok: true });
});

api.get('/auth/me', (req, res) => {
  const u = sessionUser(req);
  res.json({ user: u ? publicUser(u) : null });
});

api.post('/auth/password', requireAuth, (req, res) => {
  const { current, next: newPw } = req.body || {};
  const u = get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!verifyPassword(String(current || ''), u.password_hash)) throw new HttpError(400, 'La password attuale non è corretta.');
  const weak = checkPasswordStrength(newPw);
  if (weak) throw new HttpError(400, weak);
  if (newPw === current) throw new HttpError(400, 'La nuova password deve essere diversa da quella attuale.');
  run('UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = ?, updated_by = ? WHERE id = ?',
    hashPassword(newPw), now(), req.user.id, req.user.id);
  // Chiude le altre sessioni dell'utente.
  run('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', req.user.id, req.user.sessionHash);
  logActivity(req, 'password_cambiata', 'Password personale modificata');
  res.json({ user: publicUser({ ...req.user, mustChangePassword: false }) });
});

// Ritorno da Google dopo l'autorizzazione del Drive. Il cookie di sessione (SameSite=Strict)
// non arriva in questa navigazione: l'identità è garantita dal parametro "state" monouso.
const driveStates = new Map();
api.get('/drive/callback', async (req, res) => {
  const st = driveStates.get(String(req.query.state || ''));
  driveStates.delete(String(req.query.state || ''));
  if (!st || st.expires < Date.now()) return res.redirect('/amministrazione?drive=errore');
  if (req.query.error || !req.query.code) return res.redirect('/amministrazione?drive=annullato');
  try {
    const { refreshToken: token, email } = await exchangeCode(String(req.query.code));
    if (!token) return res.redirect('/amministrazione?drive=errore');
    setSetting('drive_token_enc', encrypt(token), st.userId);
    setSetting('drive_account', email || '', st.userId);
    setSetting('drive_connected_at', now(), st.userId);
    req.user = { id: st.userId, displayName: st.displayName };
    logActivity(req, 'impostazioni', `Collegato il Google Drive dell'amministratore${email ? ` (${email})` : ''}`);
    runSync().catch(() => {});
    res.redirect('/amministrazione?drive=ok');
  } catch (err) {
    console.error('[Drive] collegamento non riuscito:', err?.message);
    res.redirect('/amministrazione?drive=errore');
  }
});

api.use(requireAuth);

// ================= Tempo reale =================

api.get('/events', (req, res) => attachClient(req, res));

// ================= Impostazioni =================

api.get('/settings', (req, res) => {
  res.json({
    aiEnabled: aiEnabled(),
    aiConfigured: req.user.role === 'admin' ? aiConfigured() : undefined,
    statuses: REQUEST_STATUSES,
    online: req.user.role === 'admin' ? onlineCount() : undefined,
  });
});

api.put('/settings/ai', requireAdmin, (req, res) => {
  const enabled = !!req.body?.enabled;
  setSetting('ai_enabled', enabled ? '1' : '0', req.user.id);
  logActivity(req, 'impostazioni', `Intelligenza artificiale ${enabled ? 'ATTIVATA' : 'DISATTIVATA'}`);
  broadcast({ type: 'settings:changed' });
  res.json({ aiEnabled: enabled });
});

// ================= Logo =================

const LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

function findLogo() {
  for (const dir of [BRANDING_DIR, path.join(ROOT, 'branding')]) {
    for (const ext of ['png', 'jpg', 'webp', 'svg']) {
      const p = path.join(dir, `logo.${ext}`);
      if (fs.existsSync(p)) return p;
    }
  }
  return path.join(ROOT, 'public', 'logo-placeholder.svg');
}

// Il logo è pubblico (serve nella pagina di benvenuto): non contiene dati personali.
app.get('/logo', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(findLogo());
});

api.post('/settings/logo', requireAdmin, logoUpload.single('file'), (req, res) => {
  const ext = req.file && LOGO_TYPES[req.file.mimetype];
  if (!ext) throw new HttpError(400, 'Carica un\'immagine PNG, JPG, WEBP o SVG (max 3 MB).');
  for (const e of Object.values(LOGO_TYPES)) fs.rmSync(path.join(BRANDING_DIR, `logo.${e}`), { force: true });
  fs.writeFileSync(path.join(BRANDING_DIR, `logo.${ext}`), req.file.buffer);
  logActivity(req, 'impostazioni', 'Logo aggiornato');
  broadcast({ type: 'logo:changed' });
  res.json({ ok: true });
});

// ================= Archivio Google Drive (solo Capo) =================

api.get('/drive/status', requireAdmin, (req, res) => res.json(driveStatus()));

api.post('/drive/connect', requireAdmin, (req, res) => {
  if (!driveConfigured()) {
    throw new HttpError(400, 'Collegamento non configurato sul server: servono GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET e PUBLIC_URL.');
  }
  const state = crypto.randomBytes(24).toString('base64url');
  driveStates.set(state, { userId: req.user.id, displayName: req.user.displayName, expires: Date.now() + 10 * 60 * 1000 });
  const url = oauthClient().generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: SCOPES, state, include_granted_scopes: true });
  res.json({ url });
});

api.post('/drive/sync', requireAdmin, async (req, res) => {
  if (!refreshToken()) throw new HttpError(400, 'Il Google Drive non è collegato.');
  await runSync();
  res.json(driveStatus());
});

api.post('/drive/disconnect', requireAdmin, async (req, res) => {
  if (process.env.GOOGLE_REFRESH_TOKEN) {
    throw new HttpError(400, 'Il collegamento è impostato nella variabile GOOGLE_REFRESH_TOKEN del server: rimuovila per scollegare.');
  }
  const token = refreshToken();
  if (token) await revoke(token);
  for (const k of ['drive_token_enc', 'drive_account', 'drive_connected_at']) run('DELETE FROM settings WHERE key = ?', k);
  resetDriveState();
  logActivity(req, 'impostazioni', 'Scollegato il Google Drive (i file già archiviati restano sul Drive)');
  res.json(driveStatus());
});

// Valore da copiare nella variabile GOOGLE_REFRESH_TOKEN per il ripristino automatico.
api.post('/drive/token', requireAdmin, (req, res) => {
  const token = refreshToken();
  if (!token) throw new HttpError(400, 'Il Google Drive non è collegato.');
  logActivity(req, 'impostazioni', 'Visualizzato il codice di collegamento del Drive');
  res.json({ token });
});

// ================= Utenti =================

const userOut = (u, names) => ({
  id: u.id, username: u.username, displayName: u.display_name, role: u.role, active: !!u.active,
  mustChangePassword: !!u.must_change_password,
  createdAt: u.created_at, createdByName: names.get(u.created_by) || null,
  updatedAt: u.updated_at, updatedByName: names.get(u.updated_by) || null,
});

// Elenco minimo per i menu a tendina (operatrice).
api.get('/users/directory', (req, res) => {
  res.json(all('SELECT id, display_name AS displayName, role, active FROM users ORDER BY display_name')
    .map((u) => ({ ...u, active: !!u.active })));
});

api.get('/users', requireAdmin, (req, res) => {
  const names = userNames();
  res.json(all('SELECT * FROM users ORDER BY role, display_name').map((u) => userOut(u, names)));
});

function validUsername(s) {
  const v = String(s || '').trim();
  if (!/^[A-Za-z0-9._-]{3,40}$/.test(v)) throw new HttpError(400, 'Nome utente: 3-40 caratteri tra lettere, numeri, punto, trattino.');
  return v;
}

api.post('/users', requireAdmin, (req, res) => {
  const b = req.body || {};
  const username = validUsername(b.username);
  const displayName = str(b.displayName, 100, 'Nome');
  if (!displayName) throw new HttpError(400, 'Il nome visualizzato è obbligatorio.');
  const role = b.role === 'admin' ? 'admin' : 'operator';
  const weak = checkPasswordStrength(b.password);
  if (weak) throw new HttpError(400, weak);
  if (get('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'Nome utente già esistente.');
  const t = now();
  const r = run(
    `INSERT INTO users (username, display_name, role, password_hash, active, must_change_password, created_at, created_by, updated_at, updated_by)
     VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?)`,
    username, displayName, role, hashPassword(b.password), t, req.user.id, t, req.user.id,
  );
  logActivity(req, 'utente_creato', `Creato account ${role === 'admin' ? 'amministratore' : 'operatore'} "${username}" (${displayName})`, 'user', Number(r.lastInsertRowid));
  broadcast({ type: 'users:changed' });
  res.status(201).json(userOut(get('SELECT * FROM users WHERE id = ?', r.lastInsertRowid), userNames()));
});

api.patch('/users/:id', requireAdmin, (req, res) => {
  const u = get('SELECT * FROM users WHERE id = ?', Number(req.params.id));
  if (!u) throw new HttpError(404, 'Utente non trovato.');
  const b = req.body || {};
  const changes = [];
  const displayName = b.displayName !== undefined ? str(b.displayName, 100, 'Nome') : u.display_name;
  if (!displayName) throw new HttpError(400, 'Il nome visualizzato è obbligatorio.');
  if (displayName !== u.display_name) changes.push(`nome → "${displayName}"`);
  const role = b.role === undefined ? u.role : b.role === 'admin' ? 'admin' : 'operator';
  if (role !== u.role) changes.push(`ruolo → ${role === 'admin' ? 'amministratore' : 'operatore'}`);
  const active = b.active === undefined ? !!u.active : !!b.active;
  if (active !== !!u.active) changes.push(active ? 'riattivato' : 'disattivato');
  const isSelf = u.id === req.user.id;
  if (isSelf && (!active || role !== 'admin')) throw new HttpError(400, 'Non puoi disattivare o declassare il tuo stesso account.');
  if (u.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").n;
    if (admins <= 1) throw new HttpError(400, 'Deve rimanere almeno un amministratore attivo.');
  }
  let passwordHash = u.password_hash;
  let mustChange = u.must_change_password;
  if (b.password) {
    const weak = checkPasswordStrength(b.password);
    if (weak) throw new HttpError(400, weak);
    passwordHash = hashPassword(b.password);
    mustChange = 1;
    changes.push('password reimpostata');
  }
  if (!changes.length) return res.json(userOut(u, userNames()));
  run(
    'UPDATE users SET display_name = ?, role = ?, active = ?, password_hash = ?, must_change_password = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    displayName, role, active ? 1 : 0, passwordHash, mustChange, now(), req.user.id, u.id,
  );
  if (!active || role !== u.role || b.password) {
    run('DELETE FROM sessions WHERE user_id = ?', u.id);
    revokeUser(u.id);
  }
  logActivity(req, 'utente_modificato', `Account "${u.username}": ${changes.join(', ')}`, 'user', u.id);
  broadcast({ type: 'users:changed' });
  res.json(userOut(get('SELECT * FROM users WHERE id = ?', u.id), userNames()));
});

// ================= Medici =================

const doctorOut = (d, names) => ({
  id: d.id, name: d.name, specialty: d.specialty, active: !!d.active,
  createdAt: d.created_at, createdByName: names.get(d.created_by) || null,
  updatedAt: d.updated_at, updatedByName: names.get(d.updated_by) || null,
});

api.get('/doctors', (req, res) => {
  const names = userNames();
  res.json(all('SELECT * FROM doctors ORDER BY active DESC, name').map((d) => doctorOut(d, names)));
});

api.post('/doctors', requireAdmin, (req, res) => {
  const name = str(req.body?.name, 120, 'Nome medico');
  if (!name) throw new HttpError(400, 'Il nome del medico è obbligatorio.');
  const specialty = str(req.body?.specialty, 120, 'Specialità');
  const t = now();
  const r = run('INSERT INTO doctors (name, specialty, active, created_at, created_by, updated_at, updated_by) VALUES (?, ?, 1, ?, ?, ?, ?)',
    name, specialty, t, req.user.id, t, req.user.id);
  logActivity(req, 'medico_creato', `Aggiunto medico ${name}${specialty ? ` (${specialty})` : ''}`, 'doctor', Number(r.lastInsertRowid));
  broadcast({ type: 'doctors:changed' });
  res.status(201).json(doctorOut(get('SELECT * FROM doctors WHERE id = ?', r.lastInsertRowid), userNames()));
});

api.patch('/doctors/:id', requireAdmin, (req, res) => {
  const d = get('SELECT * FROM doctors WHERE id = ?', Number(req.params.id));
  if (!d) throw new HttpError(404, 'Medico non trovato.');
  const name = req.body?.name !== undefined ? str(req.body.name, 120, 'Nome medico') : d.name;
  if (!name) throw new HttpError(400, 'Il nome del medico è obbligatorio.');
  const specialty = req.body?.specialty !== undefined ? str(req.body.specialty, 120, 'Specialità') : d.specialty;
  const active = req.body?.active !== undefined ? !!req.body.active : !!d.active;
  run('UPDATE doctors SET name = ?, specialty = ?, active = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    name, specialty, active ? 1 : 0, now(), req.user.id, d.id);
  logActivity(req, 'medico_modificato', `Medico ${d.name} aggiornato${active !== !!d.active ? (active ? ' (riattivato)' : ' (disattivato)') : ''}`, 'doctor', d.id);
  broadcast({ type: 'doctors:changed' });
  res.json(doctorOut(get('SELECT * FROM doctors WHERE id = ?', d.id), userNames()));
});

// ================= Richieste e appuntamenti =================

// Nuovo elemento pubblicato subito (senza bozza salvata in precedenza).
for (const [base, kind] of [['requests', 'request'], ['appointments', 'appointment']]) {
  api.post(`/${base}/new/publish`, (req, res) => {
    const def = kindDef(kind);
    const data = def.sanitize(req.body?.data);
    def.validatePublish(data);
    const item = createItem(req, kind, data);
    res.json(publish(req, kind, item.id, data));
  });
}

function kindRoutes(base, kind) {
  api.get(`/${base}`, (req, res) => {
    const { from, to } = req.query;
    if (kind === 'appointment' && !(isISODate(from) && isISODate(to))) throw new HttpError(400, 'Intervallo date non valido.');
    res.json(listVisible(kind, req.user, { from, to }));
  });
  api.get(`/${base}/:id`, (req, res) => res.json(serializeOne(kind, req.params.id, req.user)));
  api.post(`/${base}`, (req, res) => res.status(201).json(createItem(req, kind, req.body?.data)));
  api.put(`/${base}/:id/draft`, (req, res) => res.json(saveDraft(req, kind, req.params.id, req.body?.data)));
  api.delete(`/${base}/:id/draft`, (req, res) => res.json(discardDraft(req, kind, req.params.id)));
  api.post(`/${base}/:id/publish`, (req, res) => res.json(publish(req, kind, req.params.id, req.body?.data)));
  api.post(`/${base}/:id/lock`, requireAdmin, (req, res) => res.json(setLock(req, kind, req.params.id, !!req.body?.locked)));
  api.delete(`/${base}/:id`, requireAdmin, (req, res) => {
    const r = deleteItem(req, kind, req.params.id);
    if (kind === 'request') cleanupOrphanFiles();
    res.json(r);
  });
  api.get(`/${base}/:id/versions`, (req, res) => res.json(listVersions(req.user, kind, req.params.id)));
}
kindRoutes('requests', 'request');
kindRoutes('appointments', 'appointment');


// ================= Settimane =================

api.get('/weeks/locks', (req, res) => {
  const { from, to } = req.query;
  if (!isISODate(from) || !isISODate(to)) throw new HttpError(400, 'Intervallo non valido.');
  res.json(weekLocksInRange(from, to));
});

api.post('/weeks/:weekStart/lock', requireAdmin, (req, res) => {
  res.json(setWeekLock(req, req.params.weekStart, !!req.body?.locked));
});

// ================= Archivio =================

api.get('/archive/search', (req, res) => {
  const { q = '', client = '', doctor = '', operator = '', from = '', to = '', kind = '' } = req.query;
  const ctx = makeContext();
  const text = norm(q).trim();
  const cl = norm(client).trim();
  const doctorId = doctor ? Number(doctor) : null;
  const operatorId = operator ? Number(operator) : null;
  const inRange = (d) => (!from || (d && d >= from)) && (!to || (d && d <= to));
  const results = [];

  if (kind !== 'appointment' && !doctorId) {
    for (const r of all('SELECT * FROM requests WHERE is_published = 1')) {
      const d = withNames('request', rowData('request', r), ctx);
      const refDate = d.date || r.created_at.slice(0, 10);
      if (!inRange(refDate)) continue;
      if (cl && !norm(d.client).includes(cl)) continue;
      if (operatorId && ![r.created_by, r.published_by, r.updated_by].includes(operatorId)) continue;
      if (text && !norm(`${d.title} ${d.description} ${d.client} ${d.status} ${d.attachments.map((a) => a.name).join(' ')}`).includes(text)) continue;
      results.push({
        kind: 'request', id: r.id, date: refDate, title: d.title, client: d.client, subtitle: d.status,
        authorName: ctx.users.get(r.created_by) || '—', updatedAt: r.updated_at, updatedByName: ctx.users.get(r.updated_by) || '—',
        locked: !!r.locked, version: r.version,
      });
    }
  }
  if (kind !== 'request') {
    for (const a of all('SELECT * FROM appointments WHERE is_published = 1')) {
      const d = withNames('appointment', rowData('appointment', a), ctx);
      if (!inRange(d.day)) continue;
      if (cl && !norm(d.client).includes(cl)) continue;
      if (doctorId && d.doctor_id !== doctorId) continue;
      if (operatorId && ![d.operator_id, a.created_by, a.published_by, a.updated_by].includes(operatorId)) continue;
      if (text && !norm(`${d.client} ${d.notes} ${d.doctor_name} ${d.doctor_specialty} ${d.operator_name}`).includes(text)) continue;
      results.push({
        kind: 'appointment', id: a.id, date: d.day, time: d.time, title: `${d.client} — ${d.doctor_name}`, client: d.client,
        subtitle: `${d.time} · ${d.doctor_name} · operatrice ${d.operator_name}${d.docs_checked ? ' · documenti ✓' : ''}`,
        authorName: ctx.users.get(a.created_by) || '—', updatedAt: a.updated_at, updatedByName: ctx.users.get(a.updated_by) || '—',
        locked: !!a.locked, version: a.version,
      });
    }
  }
  results.sort((x, y) => (y.date || '').localeCompare(x.date || '') || (y.time || '').localeCompare(x.time || ''));
  res.json({ total: results.length, results: results.slice(0, 500) });
});

api.get('/archive/weeks', (req, res) => {
  const ctx = makeContext();
  const weeks = new Map();
  const ensure = (monday) => {
    if (!weeks.has(monday)) {
      weeks.set(monday, { weekStart: monday, weekKey: weekKey(monday), count: 0, docsChecked: 0, doctors: new Set(), lastUpdate: null, locked: ctx.weekLocks.has(monday) });
    }
    return weeks.get(monday);
  };
  for (const a of all('SELECT day, docs_checked, doctor_id, updated_at FROM appointments WHERE is_published = 1 AND day IS NOT NULL')) {
    const w = ensure(mondayOf(a.day));
    w.count++;
    if (a.docs_checked) w.docsChecked++;
    if (a.doctor_id) w.doctors.add(a.doctor_id);
    if (!w.lastUpdate || a.updated_at > w.lastUpdate) w.lastUpdate = a.updated_at;
  }
  for (const m of ctx.weekLocks) ensure(m);
  res.json([...weeks.values()]
    .map((w) => ({ ...w, doctors: w.doctors.size }))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart)));
});

api.get('/archive/weeks/:weekStart', (req, res) => {
  const monday = req.params.weekStart;
  if (!isISODate(monday)) throw new HttpError(400, 'Settimana non valida.');
  const sat = addDays(monday, 5);
  const ctx = makeContext();
  const appointments = all('SELECT * FROM appointments WHERE is_published = 1 AND day BETWEEN ? AND ? ORDER BY day, time', monday, sat)
    .map((a) => ({ id: a.id, locked: !!a.locked, updatedAt: a.updated_at, updatedByName: ctx.users.get(a.updated_by) || '—', ...withNames('appointment', rowData('appointment', a), ctx) }));
  const history = all(
    `SELECT * FROM versions WHERE (kind = 'appointment' AND json_extract(data, '$.day') BETWEEN ? AND ?)
       OR (kind = 'week' AND item_id = ?) ORDER BY id DESC LIMIT 500`,
    monday, sat, Number(monday.replaceAll('-', '')),
  ).map((v) => ({ ...v, data: JSON.parse(v.data) }));
  res.json({ weekStart: monday, locked: ctx.weekLocks.has(monday), appointments, history });
});

api.delete('/archive/weeks/:weekStart', requireAdmin, (req, res) => {
  const monday = req.params.weekStart;
  if (!isISODate(monday)) throw new HttpError(400, 'Settimana non valida.');
  const ids = all('SELECT id FROM appointments WHERE day BETWEEN ? AND ?', monday, addDays(monday, 5)).map((a) => a.id);
  tx(() => {
    for (const id of ids) {
      run('DELETE FROM appointments WHERE id = ?', id);
      run("DELETE FROM drafts WHERE kind = 'appointment' AND item_id = ?", id);
      run("DELETE FROM versions WHERE kind = 'appointment' AND item_id = ?", id);
    }
    run('DELETE FROM week_locks WHERE week_start = ?', monday);
    run("DELETE FROM versions WHERE kind = 'week' AND item_id = ?", Number(monday.replaceAll('-', '')));
    logActivity(req, 'eliminazione', `Eliminato definitivamente il calendario della settimana ${weekKey(monday)} (${ids.length} appuntamenti)`, 'week', null);
  });
  for (const id of ids) broadcast({ type: 'deleted', kind: 'appointment', id });
  broadcast({ type: 'appointments:changed' });
  res.json({ ok: true, deleted: ids.length });
});

// ================= Allegati =================

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
  }),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 15) * 1024 * 1024 },
});

api.post('/files', upload.single('file'), (req, res) => {
  if (!req.file) throw new HttpError(400, 'Nessun file ricevuto.');
  const id = crypto.randomBytes(12).toString('hex');
  // multer decodifica il nome come latin1: lo riportiamo in UTF-8.
  const original = Buffer.from(req.file.originalname, 'latin1').toString('utf8').slice(0, 200);
  run('INSERT INTO files (id, original_name, mime, size, stored_name, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, original, req.file.mimetype || 'application/octet-stream', req.file.size, req.file.filename, req.user.id, now());
  logActivity(req, 'allegato_caricato', `Caricato allegato "${original}"`, 'file', null);
  res.status(201).json({ id, name: original, mime: req.file.mimetype, size: req.file.size });
});

function canReadFile(user, f) {
  if (user.role === 'admin' || f.uploaded_by === user.id) return true;
  const pattern = `%"${f.id}"%`;
  if (get('SELECT 1 AS x FROM requests WHERE is_published = 1 AND attachments LIKE ?', pattern)) return true;
  return !!get("SELECT 1 AS x FROM drafts WHERE kind = 'request' AND user_id = ? AND data LIKE ?", user.id, pattern);
}

api.get('/files/:id', async (req, res) => {
  const f = get('SELECT * FROM files WHERE id = ?', String(req.params.id));
  if (!f || !canReadFile(req.user, f)) throw new HttpError(404, 'File non trovato.');
  const p = await ensureLocalFile(f).catch(() => null);
  if (!p) throw new HttpError(404, 'File non trovato.');
  const inline = req.query.inline === '1' && /^(image\/(png|jpeg|gif|webp)|application\/pdf)$/.test(f.mime);
  res.set('Content-Type', f.mime);
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.original_name)}`);
  res.sendFile(p);
});

function cleanupOrphanFiles() {
  const cutoff = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  for (const f of all('SELECT * FROM files WHERE uploaded_at < ?', cutoff)) {
    const pattern = `%"${f.id}"%`;
    const used = get('SELECT 1 AS x FROM requests WHERE attachments LIKE ?', pattern)
      || get("SELECT 1 AS x FROM drafts WHERE kind = 'request' AND data LIKE ?", pattern);
    if (!used) {
      run('DELETE FROM files WHERE id = ?', f.id);
      deleteRemote(f.drive_id);
      fs.rmSync(path.join(UPLOAD_DIR, f.stored_name), { force: true });
    }
  }
}

// ================= Registro attività =================

api.get('/logs', requireAdmin, (req, res) => {
  const { user = '', action = '', q = '', from = '', to = '' } = req.query;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const where = [];
  const params = [];
  if (user) { where.push('user_id = ?'); params.push(Number(user)); }
  if (action) { where.push('action = ?'); params.push(String(action)); }
  if (q) { where.push('details LIKE ?'); params.push(`%${String(q)}%`); }
  if (isISODate(from)) { where.push('at >= ?'); params.push(`${from}T00:00:00`); }
  if (isISODate(to)) { where.push('at <= ?'); params.push(`${to}T23:59:59.999Z`); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = get(`SELECT COUNT(*) AS n FROM activity_log ${w}`, ...params).n;
  const rows = all(`SELECT * FROM activity_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  const actions = all('SELECT DISTINCT action FROM activity_log ORDER BY action').map((r) => r.action);
  res.json({ total, rows, actions });
});

// ================= Intelligenza artificiale (solo Capo) =================

api.post('/ai/summarize', requireAdmin, async (req, res) => {
  const out = await summarizeRequest(req.body?.id);
  logActivity(req, 'ia', `Riassunto IA della richiesta #${req.body?.id}`, 'request', Number(req.body?.id));
  res.json(out);
});
api.post('/ai/ask', requireAdmin, async (req, res) => {
  const out = await askArchive(req.body?.question);
  logActivity(req, 'ia', 'Ricerca IA nell\'archivio');
  res.json(out);
});
api.post('/ai/conflicts', requireAdmin, async (req, res) => {
  const out = await conflictReport(req.body?.period === 'month' ? 'month' : 'week', String(req.body?.value || ''));
  logActivity(req, 'ia', `Verifica conflitti IA (${out.label})`);
  res.json(out);
});
api.post('/ai/report', requireAdmin, async (req, res) => {
  const period = req.body?.period === 'month' ? 'month' : 'week';
  const value = String(req.body?.value || '');
  if (period === 'week' && !isISODate(value)) throw new HttpError(400, 'Settimana non valida.');
  const out = await periodReport(period, value);
  logActivity(req, 'ia', `Riepilogo IA (${out.label})`);
  res.json(out);
});

// ================= Esportazione Excel (solo Capo) =================

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
async function sendXlsx(req, res, result) {
  logActivity(req, 'esportazione', `Esportato ${result.filename} (${result.count} appuntamenti)`);
  res.set('Content-Type', XLSX);
  res.set('Content-Disposition', `attachment; filename="${result.filename}"`);
  res.send(Buffer.from(result.buffer));
}
api.get('/export/week', requireAdmin, async (req, res) => sendXlsx(req, res, await exportWeek(String(req.query.week || ''), req.user.displayName)));
api.get('/export/month', requireAdmin, async (req, res) => sendXlsx(req, res, await exportMonth(String(req.query.month || ''), req.user.displayName)));

// ================= Errori API =================

api.use((req, _res, next) => next(new HttpError(404, 'Risorsa non trovata.')));

app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    err = new HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'File troppo grande.' : 'Caricamento non valido.');
  }
  if (err?.type === 'entity.parse.failed') err = new HttpError(400, 'Dati non validi.');
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof HttpError)) console.error(err);
  if (res.headersSent) return;
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) ? 'Errore interno del server.' : err.message, code: err.code });
});

// ================= Client web =================

if (fs.existsSync(DIST)) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST, 'index.html'));
  });
} else {
  app.get('/', (req, res) => res.send('Client non compilato: esegui "npm run build".'));
}

// ================= Avvio =================

let server;
if (process.env.TLS_CERT_FILE && process.env.TLS_KEY_FILE) {
  server = https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT_FILE), key: fs.readFileSync(process.env.TLS_KEY_FILE) }, app);
} else {
  server = http.createServer(app);
}
onSharedChange(() => scheduleSync());
startDriveSync();

server.listen(PORT, () => {
  console.log(`Ambulatorio in ascolto su ${process.env.TLS_CERT_FILE ? 'https' : 'http'}://localhost:${PORT}`);
});

export { app, KINDS, kindDef };
