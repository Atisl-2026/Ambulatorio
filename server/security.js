import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const LOCKED_MESSAGE = 'BLOCCATO DAL CAPO';
export const lockedError = () => new HttpError(423, LOCKED_MESSAGE, 'LOCKED');

const SCRYPT = { N: 16384, r: 8, p: 1 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const [alg, saltB64, hashB64] = String(stored || '').split('$');
  if (alg !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(expected, actual);
}

export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'La password deve avere almeno 10 caratteri.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'La password deve contenere lettere e numeri.';
  return null;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

// Limitatore semplice dei tentativi di accesso falliti.
const failures = new Map();
const WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 8;
export function loginBlocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > WINDOW) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILS;
}
export function registerFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > WINDOW) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
export const clearFailures = (key) => failures.delete(key);

// Normalizzazione stringhe per la ricerca (senza accenti, minuscolo).
export const norm = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function str(v, max, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' && typeof v !== 'number') throw new HttpError(400, `Campo non valido: ${field}`);
  const s = String(v).trim();
  if (s.length > max) throw new HttpError(400, `Il campo "${field}" supera i ${max} caratteri.`);
  return s;
}
