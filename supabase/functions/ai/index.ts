// Assistente IA del Capo (Anthropic Claude). Nessun dato viene inviato se l'IA è disattivata.
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0';
import { handler, json, serviceClient, getCaller, HttpError, logActivity } from '../_shared/common.ts';
import { formatDate, mondayOf, addDays, monthRange, MONTHS, weekLabel } from '../_shared/dates.js';

const MODEL = Deno.env.get('AI_MODEL') || 'claude-opus-5-5';
const MAX_ARCHIVE_CHARS = 700000;

const SYSTEM = `Sei l'assistente dell'amministratore ("il Capo") di un ufficio di patronato con ambulatorio medico convenzionato (èpaca Coldiretti).
Rispondi sempre in italiano, con tono professionale e conciso. Usa titoletti brevi ed elenchi puntati quando aiutano la lettura.
Basati esclusivamente sui dati forniti nei tag <archivio>, <documento> o <appuntamenti>: se un'informazione non c'è, dillo chiaramente invece di supporre.
Quando citi un elemento indica il suo identificativo (es. "Richiesta #12" o "Appuntamento #40") così l'amministratore può ritrovarlo.
I dati sono informazioni riservate di clienti: non aggiungere commenti sulle persone oltre a quanto richiesto.`;

function encodeBase64(bytes: Uint8Array) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const esc = (s: unknown) => String(s ?? '').replace(/</g, '‹').replace(/>/g, '›');

async function ask(content: Anthropic.Beta.BetaContentBlockParam[] | string) {
  const client = new Anthropic({ apiKey: Deno.env.get('ANTHROPIC_API_KEY') });
  let message;
  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      // @ts-ignore parametro beta del fallback lato server
      fallbacks: 'default',
      output_config: { effort: 'medium' },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new HttpError(502, 'Chiave API dell\'IA non valida.');
    if (err instanceof Anthropic.RateLimitError) throw new HttpError(503, 'Servizio IA momentaneamente sovraccarico: riprova tra poco.');
    if (err instanceof Anthropic.APIConnectionError) throw new HttpError(503, 'Impossibile contattare il servizio IA.');
    if (err instanceof Anthropic.APIError) throw new HttpError(502, `Errore del servizio IA: ${err.message}`);
    throw err;
  }
  if (message.stop_reason === 'refusal') throw new HttpError(422, 'L\'assistente IA non ha potuto elaborare questa richiesta.');
  const text = message.content.filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
  return { text, truncated: message.stop_reason === 'max_tokens' };
}

type Ctx = { users: Map<string, string>; doctors: Map<number, { name: string; specialty: string }>; files: Map<string, { name: string; path: string; mime: string; size: number }> };

async function context(db: ReturnType<typeof serviceClient>): Promise<Ctx> {
  const [{ data: u }, { data: d }, { data: f }] = await Promise.all([
    db.from('profiles').select('id, display_name'),
    db.from('doctors').select('id, name, specialty'),
    db.from('files').select('id, name, path, mime, size'),
  ]);
  return {
    users: new Map((u || []).map((x) => [x.id, x.display_name])),
    doctors: new Map((d || []).map((x) => [x.id, { name: x.name, specialty: x.specialty }])),
    files: new Map((f || []).map((x) => [x.id, x])),
  };
}

function requestText(r: any, ctx: Ctx) {
  const att = (r.attachments || []).map((id: string) => ctx.files.get(id)?.name).filter(Boolean);
  return `<richiesta id="${r.id}">
Titolo: ${esc(r.title)}
Cliente: ${esc(r.client)}
Data: ${r.date ? formatDate(r.date) : '—'}
Stato: ${r.status}${r.locked ? ' (bloccata dal Capo)' : ''}
Autore: ${esc(ctx.users.get(r.created_by) || '—')} · ultima modifica ${r.updated_at} di ${esc(ctx.users.get(r.updated_by) || '—')}
Allegati: ${att.map(esc).join(', ') || 'nessuno'}
Descrizione:
${esc(r.description) || '—'}
</richiesta>`;
}

function appointmentLine(a: any, ctx: Ctx) {
  const doc = ctx.doctors.get(a.doctor_id);
  return `#${a.id} | ${a.day} (${formatDate(a.day, { weekday: true, year: false })}) ${a.time} | Medico: ${esc(doc?.name)}${doc?.specialty ? ` (${esc(doc.specialty)})` : ''} | Cliente: ${esc(a.client)} | Operatrice: ${esc(ctx.users.get(a.operator_id))} | Documenti controllati: ${a.docs_checked ? 'sì' : 'no'}${a.locked ? ' | BLOCCATO' : ''}${a.notes ? ` | Note: ${esc(a.notes).replace(/\s+/g, ' ')}` : ''}`;
}

function periodRange(period: string, value: string) {
  if (period === 'week') {
    const monday = mondayOf(value);
    return { from: monday, to: addDays(monday, 5), label: weekLabel(monday) };
  }
  const r = monthRange(value);
  if (!r) throw new HttpError(400, 'Mese non valido.');
  return { from: r.from, to: r.to, label: `${MONTHS[r.month - 1]} ${r.year}` };
}

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const me = await getCaller(req, db, { admin: true });
  const configured = !!Deno.env.get('ANTHROPIC_API_KEY');
  if (body.action === 'status') return json({ configured });

  const { data: s } = await db.from('settings').select('value').eq('key', 'ai_enabled').maybeSingle();
  if (s?.value !== '1') throw new HttpError(403, 'L\'assistente IA è disattivato.', 'AI_DISABLED');
  if (!configured) throw new HttpError(503, 'Chiave API dell\'IA non configurata (segreto ANTHROPIC_API_KEY su Supabase).', 'AI_NOT_CONFIGURED');
  const ctx = await context(db);

  if (body.action === 'summarize') {
    const { data: r } = await db.from('requests').select('*').eq('id', body.id).eq('is_published', true).maybeSingle();
    if (!r) throw new HttpError(404, 'Richiesta non trovata o non ancora pubblicata.');
    const content: any[] = [];
    const skipped: string[] = [];
    let budget = 24 * 1024 * 1024;
    for (const fid of r.attachments || []) {
      const f = ctx.files.get(fid);
      if (!f) continue;
      const supported = f.mime === 'application/pdf' || ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(f.mime) || f.mime.startsWith('text/');
      if (!supported || f.size > budget) { skipped.push(f.name); continue; }
      const { data: blob } = await db.storage.from('attachments').download(f.path);
      if (!blob) { skipped.push(f.name); continue; }
      const bytes = new Uint8Array(await blob.arrayBuffer());
      budget -= bytes.length;
      if (f.mime === 'application/pdf') {
        content.push({ type: 'document', title: f.name, source: { type: 'base64', media_type: 'application/pdf', data: encodeBase64(bytes) } });
      } else if (f.mime.startsWith('image/')) {
        content.push({ type: 'text', text: `Immagine allegata: ${esc(f.name)}` });
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: encodeBase64(bytes) } });
      } else {
        content.push({ type: 'text', text: `<documento nome="${esc(f.name)}">\n${esc(new TextDecoder().decode(bytes))}\n</documento>` });
      }
    }
    content.push({ type: 'text', text: `${requestText(r, ctx)}
${skipped.length ? `\nAllegati non leggibili dall'assistente (formato non supportato o troppo grandi): ${skipped.map(esc).join(', ')}\n` : ''}
Riassumi questa richiesta e gli eventuali documenti allegati: in poche righe il contenuto essenziale, poi i punti da fare o le scadenze, poi eventuali informazioni mancanti o incongruenze.` });
    const out = await ask(content);
    await logActivity(db, me, 'ia', `Riassunto IA della richiesta #${r.id}`);
    return json({ ...out, skipped });
  }

  if (body.action === 'ask') {
    const q = String(body.question || '').trim();
    if (!q) throw new HttpError(400, 'Scrivi una domanda.');
    if (q.length > 2000) throw new HttpError(400, 'Domanda troppo lunga.');
    const { data: reqs } = await db.from('requests').select('*').eq('is_published', true).order('date', { ascending: false });
    const { data: apps } = await db.from('appointments').select('*').eq('is_published', true).order('day', { ascending: false });
    const parts: string[] = [];
    const lines: string[] = [];
    let size = 0;
    for (const r of reqs || []) {
      const t = requestText(r, ctx);
      if (size + t.length > MAX_ARCHIVE_CHARS / 2) break;
      parts.push(t); size += t.length;
    }
    for (const a of apps || []) {
      const t = appointmentLine(a, ctx);
      if (size + t.length > MAX_ARCHIVE_CHARS) break;
      lines.push(t); size += t.length;
    }
    const partial = parts.length < (reqs || []).length || lines.length < (apps || []).length;
    const note = partial
      ? `NOTA: l'archivio è molto grande; sono inclusi solo gli elementi più recenti (${parts.length} richieste su ${(reqs || []).length}, ${lines.length} appuntamenti su ${(apps || []).length}). Se la risposta potrebbe trovarsi in elementi più vecchi, segnalalo.\n`
      : '';
    const out = await ask(`Data odierna: ${new Date().toISOString().slice(0, 10)}
${note}<archivio>
<richieste>
${parts.join('\n') || 'nessuna'}
</richieste>
<appuntamenti formato="id | giorno orario | medico | cliente | operatrice | documenti | note">
${lines.join('\n') || 'nessuno'}
</appuntamenti>
</archivio>

Domanda dell'amministratore: ${esc(q)}`);
    await logActivity(db, me, 'ia', 'Ricerca IA nell\'archivio');
    return json({ ...out, partial });
  }

  if (body.action === 'conflicts' || body.action === 'report') {
    const period = body.period === 'month' ? 'month' : 'week';
    const { from, to, label } = periodRange(period, String(body.value || ''));
    const { data: apps } = await db.from('appointments').select('*').eq('is_published', true).gte('day', from).lte('day', to).order('day').order('time');
    const list = apps || [];
    if (body.action === 'conflicts') {
      const groups = new Map<string, any[]>();
      for (const a of list) {
        if (!a.doctor_id || !a.day || !a.time) continue;
        const k = `${a.doctor_id}|${a.day}|${a.time}`;
        groups.set(k, [...(groups.get(k) || []), a]);
      }
      const conflicts = [...groups.values()].filter((g) => g.length > 1).map((g) => ({
        doctor: ctx.doctors.get(g[0].doctor_id)?.name || '—', day: g[0].day, time: g[0].time,
        appointments: g.map((a) => ({ id: a.id, client: a.client, operator: ctx.users.get(a.operator_id) || '—' })),
      }));
      const found = conflicts.length
        ? conflicts.map((c) => `- ${c.doctor}, ${c.day} ore ${c.time}: ${c.appointments.map((a) => `#${a.id} ${esc(a.client)}`).join(', ')}`).join('\n')
        : 'nessuno';
      const out = await ask(`<appuntamenti periodo="${label}">
${list.map((a) => appointmentLine(a, ctx)).join('\n') || 'nessuno'}
</appuntamenti>

Conflitti esatti già rilevati automaticamente (stesso medico, stesso giorno, stesso orario):
${found}

Analizza gli appuntamenti del periodo ${label}. Elenca: 1) i conflitti (stesso medico allo stesso orario), 2) possibili sovrapposizioni ravvicinate dello stesso medico (meno di 15 minuti di distanza) o di uno stesso cliente in due posti contemporaneamente, 3) appuntamenti con documenti non ancora controllati. Per ogni problema proponi un'azione concreta. Se non ci sono problemi, dillo in una riga.`);
      await logActivity(db, me, 'ia', `Verifica conflitti IA (${label})`);
      return json({ ...out, conflicts, label });
    }
    const { data: reqs } = await db.from('requests').select('*').eq('is_published', true)
      .or(`and(date.gte.${from},date.lte.${to}),and(updated_at.gte.${from},updated_at.lte.${to}T23:59:59)`);
    const out = await ask(`<appuntamenti periodo="${label}">
${list.map((a) => appointmentLine(a, ctx)).join('\n') || 'nessuno'}
</appuntamenti>
<archivio>
${(reqs || []).map((r) => requestText(r, ctx)).join('\n') || 'nessuna richiesta nel periodo'}
</archivio>

Genera un riepilogo ${period === 'week' ? 'della settimana' : 'del mese'} (${label}) per l'amministratore: numero di appuntamenti per medico e per giorno, carico di lavoro delle operatrici, documenti ancora da controllare, richieste aperte e completate con i punti salienti, eventuali criticità. Chiudi con 3-5 priorità per il periodo successivo.`);
    await logActivity(db, me, 'ia', `Riepilogo IA (${label})`);
    return json({ ...out, label });
  }

  throw new HttpError(400, 'Azione non valida.');
}));
