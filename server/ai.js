// Assistente IA per il Capo. Nessun dato viene inviato se l'IA è disattivata:
// ogni rotta passa da requireAiEnabled() prima di costruire qualsiasi richiesta.
import fs from 'node:fs';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { all, get, getSetting, UPLOAD_DIR } from './db.js';
import { HttpError } from './security.js';
import { makeContext, rowData, withNames } from './entities.js';
import { formatDate, mondayOf, addDays, monthRange, MONTHS, weekLabel } from '../shared/dates.js';

const MODEL = process.env.AI_MODEL || 'claude-opus-5-5';
let client = null;

export function aiConfigured() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function aiEnabled() {
  return getSetting('ai_enabled', '0') === '1';
}

export function requireAiEnabled() {
  if (!aiEnabled()) throw new HttpError(403, 'L\'assistente IA è disattivato.', 'AI_DISABLED');
  if (!aiConfigured()) {
    throw new HttpError(503, 'Chiave API dell\'IA non configurata sul server (variabile ANTHROPIC_API_KEY).', 'AI_NOT_CONFIGURED');
  }
}

const SYSTEM = `Sei l'assistente dell'amministratore ("il Capo") di un ufficio di patronato con ambulatorio medico convenzionato (èpaca Coldiretti / Apulia Diagnostic).
Rispondi sempre in italiano, con tono professionale e conciso. Usa titoletti brevi ed elenchi puntati quando aiutano la lettura.
Basati esclusivamente sui dati forniti nei tag <archivio>, <documento> o <appuntamenti>: se un'informazione non c'è, dillo chiaramente invece di supporre.
Quando citi un elemento indica il suo identificativo (es. "Richiesta #12" o "Appuntamento #40") così l'amministratore può ritrovarlo.
I dati sono informazioni riservate di clienti: non aggiungere commenti sulle persone oltre a quanto richiesto.`;

async function ask(userContent) {
  if (!client) client = new Anthropic();
  let message;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content: userContent }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'Chiave API dell\'IA non valida.');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Servizio IA momentaneamente sovraccarico: riprova tra poco.');
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, 'Impossibile contattare il servizio IA.');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Errore del servizio IA: ${err.message}`);
    throw err;
  }
  if (message.stop_reason === 'refusal') {
    throw new HttpError(422, 'L\'assistente IA non ha potuto elaborare questa richiesta.');
  }
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return { text, truncated: message.stop_reason === 'max_tokens' };
}

// ---------- Preparazione dati ----------

const esc = (s) => String(s ?? '').replace(/</g, '‹').replace(/>/g, '›');

function requestText(r, ctx) {
  const d = withNames('request', rowData('request', r), ctx);
  return `<richiesta id="${r.id}">
Titolo: ${esc(d.title)}
Cliente: ${esc(d.client)}
Data: ${d.date ? formatDate(d.date) : '—'}
Stato: ${d.status}${r.locked ? ' (bloccata dal Capo)' : ''}
Autore: ${esc(ctx.users.get(r.created_by) || '—')} · ultima modifica ${r.updated_at} di ${esc(ctx.users.get(r.updated_by) || '—')}
Allegati: ${d.attachments.map((a) => esc(a.name)).join(', ') || 'nessuno'}
Descrizione:
${esc(d.description) || '—'}
</richiesta>`;
}

function appointmentLine(a, ctx) {
  const d = withNames('appointment', rowData('appointment', a), ctx);
  return `#${a.id} | ${d.day} (${formatDate(d.day, { weekday: true, year: false })}) ${d.time} | Medico: ${esc(d.doctor_name)}${d.doctor_specialty ? ` (${esc(d.doctor_specialty)})` : ''} | Cliente: ${esc(d.client)} | Operatrice: ${esc(d.operator_name)} | Documenti controllati: ${d.docs_checked ? 'sì' : 'no'}${a.locked ? ' | BLOCCATO' : ''}${d.notes ? ` | Note: ${esc(d.notes).replace(/\s+/g, ' ')}` : ''}`;
}

const MAX_ARCHIVE_CHARS = 700000;

// ---------- Funzioni ----------

export async function summarizeRequest(id) {
  requireAiEnabled();
  const r = get('SELECT * FROM requests WHERE id = ? AND is_published = 1', Number(id));
  if (!r) throw new HttpError(404, 'Richiesta non trovata o non ancora pubblicata.');
  const ctx = makeContext();
  const content = [];
  const skipped = [];
  let budget = 24 * 1024 * 1024;
  for (const fid of JSON.parse(r.attachments || '[]')) {
    const f = get('SELECT * FROM files WHERE id = ?', fid);
    if (!f) continue;
    const p = path.join(UPLOAD_DIR, f.stored_name);
    if (!fs.existsSync(p) || f.size > budget) {
      skipped.push(f.original_name);
      continue;
    }
    if (f.mime === 'application/pdf') {
      content.push({ type: 'document', title: f.original_name, source: { type: 'base64', media_type: 'application/pdf', data: fs.readFileSync(p).toString('base64') } });
      budget -= f.size;
    } else if (['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.mime)) {
      content.push({ type: 'text', text: `Immagine allegata: ${esc(f.original_name)}` });
      content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: fs.readFileSync(p).toString('base64') } });
      budget -= f.size;
    } else if (f.mime.startsWith('text/')) {
      content.push({ type: 'text', text: `<documento nome="${esc(f.original_name)}">\n${esc(fs.readFileSync(p, 'utf8'))}\n</documento>` });
      budget -= f.size;
    } else {
      skipped.push(f.original_name);
    }
  }
  content.push({
    type: 'text',
    text: `${requestText(r, ctx)}
${skipped.length ? `\nAllegati non leggibili dall'assistente (formato non supportato o troppo grandi): ${skipped.map(esc).join(', ')}\n` : ''}
Riassumi questa richiesta e gli eventuali documenti allegati: in poche righe il contenuto essenziale, poi i punti da fare o le scadenze, poi eventuali informazioni mancanti o incongruenze.`,
  });
  return { ...(await ask(content)), skipped };
}

export async function askArchive(question) {
  requireAiEnabled();
  const q = String(question || '').trim();
  if (!q) throw new HttpError(400, 'Scrivi una domanda.');
  if (q.length > 2000) throw new HttpError(400, 'Domanda troppo lunga.');
  const ctx = makeContext();
  const reqs = all('SELECT * FROM requests WHERE is_published = 1 ORDER BY COALESCE(date, created_at) DESC');
  const apps = all('SELECT * FROM appointments WHERE is_published = 1 ORDER BY day DESC, time DESC');
  const parts = [];
  let size = 0;
  let included = { requests: 0, appointments: 0 };
  for (const r of reqs) {
    const t = requestText(r, ctx);
    if (size + t.length > MAX_ARCHIVE_CHARS / 2) break;
    parts.push(t);
    size += t.length;
    included.requests++;
  }
  const lines = [];
  for (const a of apps) {
    const t = appointmentLine(a, ctx);
    if (size + t.length > MAX_ARCHIVE_CHARS) break;
    lines.push(t);
    size += t.length;
    included.appointments++;
  }
  const partial = included.requests < reqs.length || included.appointments < apps.length;
  const note = partial
    ? `NOTA: l'archivio è molto grande; sono inclusi solo gli elementi più recenti (${included.requests} richieste su ${reqs.length}, ${included.appointments} appuntamenti su ${apps.length}). Se la risposta potrebbe trovarsi in elementi più vecchi, segnalalo.\n`
    : '';
  const text = `Data odierna: ${new Date().toISOString().slice(0, 10)}
${note}<archivio>
<richieste>
${parts.join('\n') || 'nessuna'}
</richieste>
<appuntamenti formato="id | giorno orario | medico | cliente | operatrice | documenti | note">
${lines.join('\n') || 'nessuno'}
</appuntamenti>
</archivio>

Domanda dell'amministratore: ${esc(q)}`;
  return { ...(await ask(text)), partial, included };
}

function periodRange(period, value) {
  if (period === 'week') {
    const monday = mondayOf(value);
    return { from: monday, to: addDays(monday, 5), label: weekLabel(monday) };
  }
  const r = monthRange(value);
  if (!r) throw new HttpError(400, 'Mese non valido.');
  return { from: r.from, to: r.to, label: `${MONTHS[r.month - 1]} ${r.year}` };
}

export function findConflicts(from, to) {
  const ctx = makeContext();
  const apps = all('SELECT * FROM appointments WHERE is_published = 1 AND day BETWEEN ? AND ? ORDER BY day, time', from, to);
  const groups = new Map();
  for (const a of apps) {
    if (!a.doctor_id || !a.day || !a.time) continue;
    const key = `${a.doctor_id}|${a.day}|${a.time}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(a);
  }
  const conflicts = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const d = ctx.doctors.get(list[0].doctor_id);
    conflicts.push({
      doctor: d?.name || '—',
      day: list[0].day,
      time: list[0].time,
      appointments: list.map((a) => ({ id: a.id, client: a.client, operator: ctx.users.get(a.operator_id) || '—' })),
    });
  }
  return { conflicts, apps, ctx };
}

export async function conflictReport(period, value) {
  requireAiEnabled();
  const { from, to, label } = periodRange(period, value);
  const { conflicts, apps, ctx } = findConflicts(from, to);
  const found = conflicts.length
    ? conflicts.map((c) => `- ${c.doctor}, ${c.day} ore ${c.time}: ${c.appointments.map((a) => `#${a.id} ${esc(a.client)}`).join(', ')}`).join('\n')
    : 'nessuno';
  const text = `<appuntamenti periodo="${label}">
${apps.map((a) => appointmentLine(a, ctx)).join('\n') || 'nessuno'}
</appuntamenti>

Conflitti esatti già rilevati automaticamente (stesso medico, stesso giorno, stesso orario):
${found}

Analizza gli appuntamenti del periodo ${label}. Elenca: 1) i conflitti (stesso medico allo stesso orario), 2) possibili sovrapposizioni ravvicinate dello stesso medico (meno di 15 minuti di distanza) o di uno stesso cliente in due posti contemporaneamente, 3) appuntamenti con documenti non ancora controllati. Per ogni problema proponi un'azione concreta. Se non ci sono problemi, dillo in una riga.`;
  return { ...(await ask(text)), conflicts, label };
}

export async function periodReport(period, value) {
  requireAiEnabled();
  const { from, to, label } = periodRange(period, value);
  const ctx = makeContext();
  const apps = all('SELECT * FROM appointments WHERE is_published = 1 AND day BETWEEN ? AND ? ORDER BY day, time', from, to);
  const reqs = all(
    `SELECT * FROM requests WHERE is_published = 1 AND (date BETWEEN ? AND ? OR substr(updated_at, 1, 10) BETWEEN ? AND ?)
     ORDER BY date`, from, to, from, to,
  );
  const text = `<appuntamenti periodo="${label}">
${apps.map((a) => appointmentLine(a, ctx)).join('\n') || 'nessuno'}
</appuntamenti>
<archivio>
${reqs.map((r) => requestText(r, ctx)).join('\n') || 'nessuna richiesta nel periodo'}
</archivio>

Genera un riepilogo ${period === 'week' ? 'della settimana' : 'del mese'} (${label}) per l'amministratore: numero di appuntamenti per medico e per giorno, carico di lavoro delle operatrici, documenti ancora da controllare, richieste aperte e completate con i punti salienti, eventuali criticità. Chiudi con 3-5 priorità per il periodo successivo.`;
  return { ...(await ask(text)), label };
}
