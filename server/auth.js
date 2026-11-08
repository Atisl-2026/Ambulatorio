import { get, run, now } from './db.js';
import { HttpError, randomToken, sha256 } from './security.js';

export const COOKIE = 'amb_sid';
const IDLE_MS = Number(process.env.SESSION_IDLE_MINUTES || 120) * 60 * 1000;
const MAX_MS = Number(process.env.SESSION_MAX_HOURS || 12) * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieSecure(req) {
  if (process.env.COOKIE_SECURE === 'false') return false;
  if (process.env.COOKIE_SECURE === 'true') return true;
  return req.secure;
}

export function createSession(req, res, userId) {
  const token = randomToken();
  const t = Date.now();
  run(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?)',
    sha256(token), userId, new Date(t).toISOString(), new Date(t + IDLE_MS).toISOString(), req.ip,
  );
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: cookieSecure(req),
    maxAge: MAX_MS,
    path: '/',
  });
}

export function destroySession(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
  res.clearCookie(COOKIE, { path: '/' });
}

// Restituisce l'utente della sessione valida (e prolunga la scadenza per inattività).
export function sessionUser(req, { touch = true } = {}) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const hash = sha256(token);
  const s = get(
    `SELECT s.token_hash, s.created_at, s.expires_at, u.id, u.username, u.display_name, u.role, u.active, u.must_change_password
     FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`,
    hash,
  );
  if (!s) return null;
  const t = Date.now();
  if (Date.parse(s.expires_at) < t || Date.parse(s.created_at) + MAX_MS < t || !s.active) {
    run('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  if (touch) {
    const exp = Math.min(t + IDLE_MS, Date.parse(s.created_at) + MAX_MS);
    run('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', new Date(exp).toISOString(), hash);
  }
  return {
    id: s.id,
    username: s.username,
    displayName: s.display_name,
    role: s.role,
    mustChangePassword: !!s.must_change_password,
    sessionHash: hash,
  };
}

export function sessionStillValid(sessionHash) {
  const s = get(
    'SELECT s.expires_at, s.created_at, u.active FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?',
    sessionHash,
  );
  return !!s && s.active && Date.parse(s.expires_at) > Date.now() && Date.parse(s.created_at) + MAX_MS > Date.now();
}

export function requireAuth(req, _res, next) {
  const user = sessionUser(req);
  if (!user) throw new HttpError(401, 'Sessione scaduta o non valida. Effettua di nuovo l\'accesso.', 'UNAUTHENTICATED');
  req.user = user;
  // Finché la password iniziale non è cambiata, consentiamo solo le rotte di autenticazione.
  if (user.mustChangePassword && !req.originalUrl.startsWith('/api/auth/')) {
    throw new HttpError(403, 'Devi cambiare la password prima di continuare.', 'MUST_CHANGE_PASSWORD');
  }
  next();
}

export function requireAdmin(req, _res, next) {
  if (req.user?.role !== 'admin') throw new HttpError(403, 'Funzione riservata all\'amministratore.', 'FORBIDDEN');
  next();
}

// Protezione CSRF: le richieste che modificano dati devono arrivare dal nostro client.
export function csrfGuard(req, _res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('X-Requested-With') !== 'AmbulatorioApp') {
    throw new HttpError(403, 'Richiesta non consentita.', 'CSRF');
  }
  next();
}
