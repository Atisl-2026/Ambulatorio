// Invio del calendario mensile in Excel per email, tramite la casella dell'ufficio (SMTP).
// - "cron": chiamata ogni ora dal database; invia il mese precedente una sola volta, dal 1° del mese.
// - "send": invio manuale del Capo per un mese scelto.
// - "status": stato della configurazione.
import ExcelJS from 'npm:exceljs@4.4.0';
import nodemailer from 'npm:nodemailer@10.4.0';
import { handler, json, serviceClient, getCaller, HttpError, logActivity } from '../_shared/common.ts';
import { buildCalendarXlsx, monthInfo } from '../_shared/excel.js';
import { mondayOf } from '../_shared/dates.js';

const SEND_HOUR = Number(Deno.env.get('MONTHLY_EMAIL_HOUR') || 7);
const smtpConfigured = () => !!Deno.env.get('SMTP_HOST');
const from = () => Deno.env.get('MAIL_FROM') || Deno.env.get('SMTP_USER') || '';

type Db = ReturnType<typeof serviceClient>;

async function aget(db: Db, key: string) {
  const { data } = await db.from('admin_settings').select('value').eq('key', key).maybeSingle();
  return data?.value ?? null;
}
async function aset(db: Db, key: string, value: string) {
  await db.from('admin_settings').upsert({ key, value, updated_at: new Date().toISOString() });
}

// Ora italiana, indipendentemente dal fuso del server.
function romeNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date()).map((p) => [p.type, p.value]));
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) };
}
function previousMonth() {
  const { y, m } = romeNow();
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

async function monthRows(db: Db, fromDay: string, toDay: string) {
  const [{ data: apps }, { data: users }, { data: docs }, { data: locks }] = await Promise.all([
    db.from('appointments').select('*').eq('is_published', true).gte('day', fromDay).lte('day', toDay).order('day').order('time'),
    db.from('profiles').select('id, display_name'),
    db.from('doctors').select('id, name, specialty'),
    db.from('week_locks').select('week_start'),
  ]);
  const u = new Map((users || []).map((x) => [x.id, x.display_name]));
  const d = new Map((docs || []).map((x) => [x.id, x]));
  const wl = new Set((locks || []).map((x) => x.week_start));
  return (apps || []).map((a) => ({
    operator: u.get(a.operator_id) || '', doctor: d.get(a.doctor_id)?.name || '', specialty: d.get(a.doctor_id)?.specialty || '',
    day: a.day, time: a.time, client: a.client, docs: a.docs_checked, notes: a.notes, locked: a.locked,
    weekLocked: wl.has(mondayOf(a.day)), updatedBy: u.get(a.updated_by) || '', updatedAt: a.updated_at,
  }));
}

function parseRecipients(text: string) {
  return String(text || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
}

async function send(db: Db, ym: string, who: { id: string | null; display_name: string } | null, to: string[]) {
  if (!smtpConfigured()) throw new HttpError(400, 'Invio email non configurato: mancano i dati della casella di posta (SMTP_HOST, SMTP_USER, SMTP_PASS) nei segreti di Supabase.');
  const info = monthInfo(ym);
  if (!info) throw new HttpError(400, 'Mese non valido.');
  if (!to.length) throw new HttpError(400, 'Nessun indirizzo email di destinazione impostato.');
  const rows = await monthRows(db, info.from, info.to);
  const xlsx = await buildCalendarXlsx(ExcelJS, info.label, rows, 'Invio automatico');
  const port = Number(Deno.env.get('SMTP_PORT') || 465);
  const transport = nodemailer.createTransport({
    host: Deno.env.get('SMTP_HOST'), port,
    secure: Deno.env.get('SMTP_SECURE') ? Deno.env.get('SMTP_SECURE') === 'true' : port === 465,
    auth: Deno.env.get('SMTP_USER') ? { user: Deno.env.get('SMTP_USER'), pass: Deno.env.get('SMTP_PASS') } : undefined,
    connectionTimeout: 20000,
  });
  try {
    await transport.sendMail({
      from: from(),
      to: to.join(', '),
      subject: `Calendario ambulatorio – ${info.label}`,
      text: `Buongiorno,\n\nin allegato il calendario dell'ambulatorio di ${info.label} (${rows.length} appuntamenti) in formato Excel.\n\nMessaggio inviato ${who ? `da ${who.display_name}` : 'automaticamente'} dall'app Ambulatorio – èpaca Coldiretti.\nIl file contiene dati personali di clienti: non inoltrarlo a persone non autorizzate.`,
      attachments: [{ filename: info.fileName, content: xlsx, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }],
    });
  } catch (err) {
    const msg = `Invio non riuscito: ${(err as any)?.response || (err as Error).message}`;
    await aset(db, 'monthly_email_last_error', `${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} – ${msg}`);
    await logActivity(db, who, 'invio_email', `${msg} (${info.fileName})`);
    throw new HttpError(502, msg);
  }
  await aset(db, 'monthly_email_last_error', '');
  await logActivity(db, who, 'invio_email', `Inviato ${info.fileName} (${rows.length} appuntamenti) a ${to.join(', ')}`);
  return { filename: info.fileName, count: rows.length, to };
}

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();

  if (body.mode === 'cron') {
    const secret = req.headers.get('x-cron-secret') || '';
    if (!secret || secret !== await aget(db, 'cron_secret')) throw new HttpError(401, 'Non autorizzato.');
    if (!smtpConfigured() || await aget(db, 'monthly_email_enabled') !== '1') return json({ skipped: 'disattivato' });
    const now = romeNow();
    if (now.d === 1 && now.h < SEND_HOUR) return json({ skipped: 'troppo presto' });
    const ym = previousMonth();
    if (await aget(db, 'monthly_email_last_month') === ym) return json({ skipped: 'già inviato' });
    const last = Number(await aget(db, 'monthly_email_last_attempt') || 0);
    if (Date.now() - last < 55 * 60 * 1000) return json({ skipped: 'nuovo tentativo più tardi' });
    await aset(db, 'monthly_email_last_attempt', String(Date.now()));
    const r = await send(db, ym, null, parseRecipients(await aget(db, 'monthly_email_to') || ''));
    await aset(db, 'monthly_email_last_month', ym);
    await aset(db, 'monthly_email_last_sent_at', new Date().toISOString());
    return json(r);
  }

  const me = await getCaller(req, db, { admin: true });
  if (body.action === 'status') return json({ configured: smtpConfigured(), from: from() || null, sendHour: SEND_HOUR });
  if (body.action === 'send') {
    const ym = String(body.month || '');
    const override = body.recipients ? parseRecipients(body.recipients) : null;
    const r = await send(db, ym, me, override || parseRecipients(await aget(db, 'monthly_email_to') || ''));
    // Se è il mese appena concluso, l'invio automatico non lo ripete.
    if (ym === previousMonth() && !override) {
      await aset(db, 'monthly_email_last_month', ym);
      await aset(db, 'monthly_email_last_sent_at', new Date().toISOString());
    }
    return json(r);
  }
  throw new HttpError(400, 'Azione non valida.');
}));
