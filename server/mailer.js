// Invio automatico mensile del calendario Excel a un indirizzo email prestabilito,
// tramite la casella di posta dell'ufficio (SMTP). Nessun altro servizio esterno.
import nodemailer from 'nodemailer';
import { getSetting, setSetting, now } from './db.js';
import { HttpError } from './security.js';
import { exportMonth } from './export.js';
import { logActivity } from './log.js';
import { MONTHS, monthRange } from '../shared/dates.js';

const SYSTEM_REQ = { user: { id: null, displayName: 'Invio automatico' }, ip: null };
const SEND_HOUR = Number(process.env.MONTHLY_EMAIL_HOUR || 7);
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

export const mailConfigured = () => !!process.env.SMTP_HOST;

let transport = null;
function getTransport() {
  if (!transport) {
    const port = Number(process.env.SMTP_PORT || 587);
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
      requireTLS: port !== 465 && process.env.SMTP_REQUIRE_TLS !== 'false',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
      connectionTimeout: 20000,
    });
  }
  return transport;
}

export function parseRecipients(text) {
  const list = String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (list.length > 5) throw new HttpError(400, 'Al massimo 5 indirizzi email.');
  for (const e of list) if (!EMAIL_RE.test(e) || e.length > 200) throw new HttpError(400, `Indirizzo email non valido: ${e}`);
  return list;
}

export const previousMonth = (d = new Date()) => {
  const p = new Date(d.getFullYear(), d.getMonth() - 1, 15);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
};
const monthName = (ym) => {
  const r = monthRange(ym);
  return `${MONTHS[r.month - 1]} ${r.year}`;
};

export function mailSettings() {
  return {
    configured: mailConfigured(),
    from: process.env.MAIL_FROM || process.env.SMTP_USER || null,
    enabled: getSetting('monthly_email_enabled', '0') === '1',
    recipients: getSetting('monthly_email_to', ''),
    lastMonth: getSetting('monthly_email_last_month', null),
    lastSentAt: getSetting('monthly_email_last_sent_at', null),
    lastError: getSetting('monthly_email_last_error', null),
    nextMonth: previousMonth(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1)),
    sendHour: SEND_HOUR,
  };
}

export function updateMailSettings(req, { enabled, recipients }) {
  const list = parseRecipients(recipients);
  if (enabled && !list.length) throw new HttpError(400, 'Inserisci almeno un indirizzo email.');
  const wasEnabled = getSetting('monthly_email_enabled', '0') === '1';
  setSetting('monthly_email_to', list.join(', '), req.user.id);
  setSetting('monthly_email_enabled', enabled ? '1' : '0', req.user.id);
  // All'attivazione non inviamo subito il mese passato: il primo invio sarà il prossimo 1° del mese.
  if (enabled && !wasEnabled) setSetting('monthly_email_last_month', previousMonth(), req.user.id);
  logActivity(req, 'impostazioni', `Invio mensile del calendario ${enabled ? `ATTIVO verso ${list.join(', ')}` : 'disattivato'}`);
  return mailSettings();
}

export async function sendMonthlyCalendar(ym, req = SYSTEM_REQ, recipientsOverride) {
  if (!mailConfigured()) throw new HttpError(400, 'Invio email non configurato sul server (SMTP_HOST, SMTP_USER, SMTP_PASS).');
  if (!monthRange(ym)) throw new HttpError(400, 'Mese non valido.');
  const to = parseRecipients(recipientsOverride ?? getSetting('monthly_email_to', ''));
  if (!to.length) throw new HttpError(400, 'Nessun indirizzo email di destinazione impostato.');
  const { buffer, filename, count } = await exportMonth(ym, 'Invio automatico');
  const name = monthName(ym);
  try {
    await getTransport().sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: to.join(', '),
      subject: `Calendario ambulatorio – ${name}`,
      text: `Buongiorno,\n\nin allegato il calendario dell'ambulatorio di ${name} (${count} appuntamenti) in formato Excel.\n\nMessaggio inviato ${req === SYSTEM_REQ ? 'automaticamente' : `da ${req.user.displayName}`} dall'applicazione Ambulatorio – èpaca Coldiretti / Apulia Diagnostic.\nIl file contiene dati personali di clienti: non inoltrarlo a persone non autorizzate.`,
      attachments: [{ filename, content: Buffer.from(buffer), contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
  } catch (err) {
    const msg = `Invio non riuscito: ${err.response || err.message}`;
    setSetting('monthly_email_last_error', `${new Date().toLocaleString('it-IT')} – ${msg}`, req.user.id);
    logActivity(req, 'invio_email', `${msg} (${filename})`);
    throw new HttpError(502, msg);
  }
  setSetting('monthly_email_last_error', '', req.user.id);
  logActivity(req, 'invio_email', `Inviato ${filename} (${count} appuntamenti) a ${to.join(', ')}`);
  return { filename, count, to };
}

// Controllo periodico: dal giorno 1 del mese (dalle ore SEND_HOUR) invia il mese precedente,
// una sola volta. Se il server era spento, recupera appena riparte; in caso di errore riprova ogni ora.
let lastAttempt = 0;
async function tick() {
  if (!mailConfigured() || getSetting('monthly_email_enabled', '0') !== '1') return;
  const d = new Date();
  if (d.getDate() === 1 && d.getHours() < SEND_HOUR) return;
  const ym = previousMonth(d);
  if (getSetting('monthly_email_last_month', null) === ym) return;
  if (Date.now() - lastAttempt < 60 * 60 * 1000) return;
  lastAttempt = Date.now();
  try {
    await sendMonthlyCalendar(ym);
    setSetting('monthly_email_last_month', ym, null);
    setSetting('monthly_email_last_sent_at', now(), null);
  } catch (err) {
    console.error('[Email] invio mensile non riuscito:', err.message);
  }
}

export function startMonthlyMailer() {
  setInterval(() => { tick().catch(() => {}); }, 10 * 60 * 1000).unref();
  setTimeout(() => { tick().catch(() => {}); }, 15000).unref();
}

export const _test = { tick, previousMonth, resetAttempt: () => { lastAttempt = 0; } };
