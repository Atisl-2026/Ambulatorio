// Test del backend Supabase (da eseguire con Supabase locale avviato: `npx supabase start`).
//   node tests/backend.test.mjs
import { createClient } from '@supabase/supabase-js';

const URL = process.env.SUPABASE_URL || 'http://127.0.0.1:54321';
const KEY = process.env.SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DOMAIN = 'utenti.ambulatorio.app';
if (!KEY || !SERVICE) throw new Error('Imposta SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY (vedi `npx supabase status`).');

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const client = () => createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const fn = async (c, name, body) => {
  const { data: { session } } = await c.auth.getSession();
  const r = await fetch(`${URL}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: KEY, Authorization: `Bearer ${session?.access_token || KEY}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};
const login = async (c, u, p) => (await c.auth.signInWithPassword({ email: `${u}@${DOMAIN}`, password: p })).error;
const rpc = async (c, name, args) => { const { data, error } = await c.rpc(name, args); return { data, error, status: error ? Number(error.code?.replace('PT', '')) || error.code : 200 }; };

const svc = createClient(URL, SERVICE, { auth: { persistSession: false } });
const admin = client();
const op = client();
const op2 = client();

let r = await fn(admin, 'admin-users', { action: 'status' });
ok(r.body.needsSetup === true, 'primo avvio: serve creare il Capo');
r = await fn(admin, 'admin-users', { action: 'bootstrap', username: 'capo', displayName: 'Il Capo', password: 'NuovaPass2026' });
ok(r.body.ok, 'creato il Capo');
r = await fn(admin, 'admin-users', { action: 'bootstrap', username: 'altro', password: 'Altrapass2026' });
ok(r.status === 403, 'secondo "primo avvio" rifiutato');
ok(!(await login(admin, 'capo', 'NuovaPass2026')), 'login del Capo');
ok((await login(client(), 'capo', 'sbagliata1234')) !== null, 'password errata rifiutata');

r = await fn(admin, 'admin-users', { action: 'create', username: 'maria', displayName: 'Maria Rossi', role: 'operator', password: 'Operatrice123' });
ok(r.body.id, 'creata operatrice'); const mariaId = r.body.id;
await fn(admin, 'admin-users', { action: 'create', username: 'anna', displayName: 'Anna Verdi', role: 'operator', password: 'Operatrice456' });
ok(!(await login(op, 'maria', 'Operatrice123')), 'login operatrice');
r = await rpc(op, 'list_items', { p_kind: 'request' });
ok(r.status === 403, 'bloccata finché non cambia la password');
await op.auth.updateUser({ password: 'MariaPass2026' }); await rpc(op, 'mark_password_changed');
await login(op2, 'anna', 'Operatrice456'); await op2.auth.updateUser({ password: 'AnnaPass2026' }); await rpc(op2, 'mark_password_changed');
r = await rpc(op, 'list_items', { p_kind: 'request' });
ok(r.status === 200 && Array.isArray(r.data), 'dopo il cambio password può lavorare');

// Permessi lato database
r = await fn(op, 'admin-users', { action: 'create', username: 'x', displayName: 'x', password: 'Abcdefgh1234' });
ok(r.status === 403, 'operatrice non può creare utenti');
ok((await rpc(op, 'set_ai_enabled', { p_enabled: true })).status === 403, 'operatrice non può attivare l\'IA');
ok((await rpc(op, 'export_rows', { p_from: '2026-11-01', p_to: '2026-11-30' })).status === 403, 'operatrice non può esportare');
ok((await rpc(op, 'list_logs', { p: {} })).status === 403, 'operatrice non legge il registro');
ok((await op.from('requests').insert({ title: 'x', created_by: mariaId })).error, 'scrittura diretta nelle tabelle vietata');
ok((await op.from('admin_settings').select('*')).error, 'impostazioni riservate non leggibili');
r = await rpc(client(), 'list_items', { p_kind: 'request' });
ok(r.error, 'senza login nessun dato');

// Realtime: Anna ascolta gli eventi
const seen = [];
const ch = op2.channel('test').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, (p) => seen.push(p.new));
await op2.realtime.setAuth((await op2.auth.getSession()).data.session.access_token);
await new Promise((res) => ch.subscribe((s) => s === 'SUBSCRIBED' && res()));
await sleep(2000);

// Bozza → pubblicazione
r = await rpc(op, 'create_item', { p_kind: 'request', p_data: { title: 'Pratica invalidità', client: 'Giuseppe Verdi', date: '2026-11-09', description: 'Prima bozza' } });
ok(r.data && !r.data.isPublished && r.data.draft, 'bozza creata'); const rid = r.data.id;
ok((await rpc(op2, 'list_items', { p_kind: 'request' })).data.length === 0, 'bozza invisibile alle colleghe');
ok((await rpc(admin, 'list_items', { p_kind: 'request' })).data.length === 0, 'bozza invisibile anche al Capo');
await sleep(800);
ok(!seen.some((e) => e.type === 'requests:changed'), 'nessun evento in tempo reale per la bozza altrui');
r = await rpc(op, 'publish_item', { p_kind: 'request', p_id: rid });
ok(r.data?.isPublished && r.data.version === 1, 'pubblicata');
await sleep(1500);
ok(seen.some((e) => e.type === 'requests:changed' && e.payload.id === rid), 'evento in tempo reale ricevuto dalla collega');
r = await rpc(op2, 'list_items', { p_kind: 'request' });
ok(r.data.length === 1 && r.data[0].published.title === 'Pratica invalidità', 'pubblicata visibile a tutti');
r = await rpc(op2, 'save_draft', { p_kind: 'request', p_id: rid, p_data: { ...r.data[0].published, attachments: [], description: 'Modifica di Anna' } });
ok(r.data?.draft?.description === 'Modifica di Anna', 'modifica di Anna resta in bozza');
ok((await rpc(op, 'get_item', { p_kind: 'request', p_id: rid })).data.published.description === 'Prima bozza', 'gli altri vedono ancora la versione pubblicata');

// Blocco del Capo
r = await rpc(admin, 'set_item_lock', { p_kind: 'request', p_id: rid, p_locked: true });
ok(r.data?.locked, 'il Capo blocca');
await sleep(1200);
ok(seen.some((e) => e.type === 'lock' && e.payload.id === rid && e.payload.locked), 'evento di blocco in tempo reale');
r = await rpc(op2, 'publish_item', { p_kind: 'request', p_id: rid });
ok(r.status === 423 && r.error.message === 'BLOCCATO DAL CAPO', 'pubblicazione bloccata: BLOCCATO DAL CAPO');
ok((await rpc(op, 'save_draft', { p_kind: 'request', p_id: rid, p_data: { title: 'x', client: 'y', date: '2026-11-09' } })).status === 423, 'bozza bloccata');
ok((await rpc(op, 'set_item_lock', { p_kind: 'request', p_id: rid, p_locked: false })).status === 403, 'operatrice non può sbloccare');
r = await rpc(admin, 'publish_item', { p_kind: 'request', p_id: rid, p_data: { title: 'Pratica invalidità (capo)', client: 'Giuseppe Verdi', date: '2026-11-09' } });
ok(r.data?.version === 2, 'il Capo modifica anche se bloccato');
await rpc(admin, 'set_item_lock', { p_kind: 'request', p_id: rid, p_locked: false });
r = await rpc(op2, 'publish_item', { p_kind: 'request', p_id: rid });
ok(r.data?.published.description === 'Modifica di Anna', 'sbloccato: Anna pubblica');
ok((await rpc(op, 'list_versions', { p_kind: 'request', p_id: rid })).data.length === 5, 'cronologia: 5 versioni');

// Allegati
const path = `${mariaId}/${crypto.randomUUID()}`;
ok(!(await op.storage.from('attachments').upload(path, new Blob(['referto di prova'], { type: 'text/plain' }))).error, 'upload nella propria cartella');
ok((await op.storage.from('attachments').upload(`${(await op2.auth.getUser()).data.user.id}/x`, new Blob(['x']))).error, 'upload nella cartella altrui vietato');
const { data: frow, error: ferr } = await op.from('files').insert({ path, name: 'referto.txt', mime: 'text/plain', size: 16 }).select().single();
ok(!ferr, 'registrazione allegato ' + (ferr?.message || ''));
r = await rpc(op, 'create_item', { p_kind: 'request', p_data: { title: 'Con allegato', client: 'Rossi', date: '2026-11-10', attachments: [frow.id] } });
const rid2 = r.data.id;
ok(r.data.draft.attachments[0]?.name === 'referto.txt', 'allegato collegato alla bozza');
ok((await op2.storage.from('attachments').download(path)).error, 'allegato di una bozza non scaricabile dalle colleghe');
await rpc(op, 'publish_item', { p_kind: 'request', p_id: rid2 });
r = await op2.storage.from('attachments').download(path);
ok(!r.error && (await r.data.text()) === 'referto di prova', 'dopo la pubblicazione è scaricabile');

// Ambulatorio
const { data: doc } = await rpc(admin, 'save_doctor', { p_id: null, p_name: 'Dott. Mario Bianchi', p_specialty: 'Medicina legale' });
ok((await rpc(op, 'save_doctor', { p_id: null, p_name: 'x', p_specialty: '' })).status === 403, 'operatrice non gestisce i medici');
const app = (day, time, client, extra = {}) => ({ operator_id: mariaId, doctor_id: doc.id, day, time, client, ...extra });
r = await rpc(op, 'publish_item', { p_kind: 'appointment', p_id: null, p_data: app('2026-11-10', '09:30', 'Luca Neri', { docs_checked: true, notes: 'Portare referti' }) });
ok(r.data?.isPublished && r.data.published.doctor_name === 'Dott. Mario Bianchi', 'appuntamento pubblicato'); const aid = r.data.id;
await rpc(op, 'publish_item', { p_kind: 'appointment', p_id: null, p_data: app('2026-11-10', '09:30', 'Sara Blu') });
ok((await rpc(op, 'publish_item', { p_kind: 'appointment', p_id: null, p_data: app('2026-11-15', '09:30', 'Dom') })).status === 400, 'domenica rifiutata');
r = await rpc(op, 'publish_item', { p_kind: 'appointment', p_id: null, p_data: { client: 'Incompleto' } });
ok(r.status === 400 && /operatrice, medico, giorno, orario/.test(r.error.message), 'dati mancanti: ' + r.error?.message);
ok((await rpc(admin, 'set_week_lock', { p_week: '2026-11-09', p_locked: true })).data?.locked, 'il Capo blocca la settimana');
ok((await rpc(op, 'save_draft', { p_kind: 'appointment', p_id: aid, p_data: app('2026-11-10', '10:00', 'Luca Neri') })).status === 423, 'settimana bloccata: modifica vietata');
ok((await rpc(op, 'create_item', { p_kind: 'appointment', p_data: { day: '2026-11-12', client: 'Nuovo' } })).status === 423, 'settimana bloccata: nuovo vietato');
r = await rpc(op, 'list_items', { p_kind: 'appointment', p_from: '2026-11-09', p_to: '2026-11-14' });
ok(r.data.length === 2 && r.data[0].weekLocked, 'elenco segnala la settimana bloccata');
await rpc(admin, 'set_item_lock', { p_kind: 'appointment', p_id: aid, p_locked: true });
await rpc(admin, 'set_week_lock', { p_week: '2026-11-09', p_locked: false });
ok((await rpc(op, 'save_draft', { p_kind: 'appointment', p_id: aid, p_data: app('2026-11-10', '10:00', 'Luca Neri') })).status === 423, 'blocco del singolo appuntamento');

// Archivio
ok((await rpc(op, 'archive_search', { p: { q: 'luca' } })).data.total === 1, 'archivio: ricerca testo');
ok((await rpc(op, 'archive_search', { p: { doctor: String(doc.id) } })).data.total === 2, 'archivio: per medico');
ok((await rpc(op, 'archive_search', { p: { client: 'giuseppe', from: '2026-11-01', to: '2026-11-30' } })).data.total === 1, 'archivio: cliente e date');
r = await rpc(op, 'archive_weeks');
ok(r.data[0]?.weekKey === '2026-W46' && r.data[0].count === 2, 'archivio settimane');
ok((await rpc(op, 'archive_week', { p_week: '2026-11-09' })).data.history.some((v) => v.kind === 'week'), 'cronologia settimana con i blocchi');
ok((await rpc(op, 'delete_item', { p_kind: 'request', p_id: rid })).status === 403, 'operatrice non può eliminare');

// Export ed email
r = await rpc(admin, 'export_rows', { p_from: '2026-11-01', p_to: '2026-11-30' });
ok(r.data?.length === 2 && r.data[0].doctor === 'Dott. Mario Bianchi', 'righe per l\'Excel');
ok((await rpc(admin, 'set_mail_settings', { p_enabled: true, p_recipients: 'non-valida' })).status === 400, 'email non valida rifiutata');
r = await rpc(admin, 'set_mail_settings', { p_enabled: true, p_recipients: 'direzione@esempio.it' });
ok(r.data?.enabled && r.data.lastMonth === '2026-10', 'invio mensile attivo (mese passato già segnato)');
r = await fn(admin, 'monthly-email', { action: 'send', month: '2026-11' });
ok(r.body.filename === 'Ambulatorio_Novembre_2026.xlsx' && r.body.count === 2, 'invio manuale: ' + JSON.stringify(r.body));
r = await fn(op, 'monthly-email', { action: 'send', month: '2026-11' });
ok(r.status === 403, 'operatrice non può inviare');
r = await fetch(`${URL}/functions/v1/monthly-email`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': 'sbagliato' }, body: '{"mode":"cron"}' });
ok(r.status === 401, 'pianificatore con segreto errato rifiutato');
const { data: sec } = await svc.from('admin_settings').select('value').eq('key', 'cron_secret').single();
await svc.from('admin_settings').upsert({ key: 'monthly_email_last_month', value: '2026-09' });
r = await (await fetch(`${URL}/functions/v1/monthly-email`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': sec.value }, body: '{"mode":"cron"}' })).json();
ok(r.filename === 'Ambulatorio_Ottobre_2026.xlsx', 'invio automatico del mese precedente: ' + JSON.stringify(r));
r = await (await fetch(`${URL}/functions/v1/monthly-email`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': sec.value }, body: '{"mode":"cron"}' })).json();
ok(r.skipped === 'già inviato', 'nessun doppio invio');

// IA
r = await fn(admin, 'ai', { action: 'ask', question: 'ciao' });
ok(r.status === 403 && r.body.code === 'AI_DISABLED', 'IA disattivata: nessun invio');
await rpc(admin, 'set_ai_enabled', { p_enabled: true });
r = await fn(admin, 'ai', { action: 'ask', question: 'ciao' });
ok(r.status === 503 && r.body.code === 'AI_NOT_CONFIGURED', 'IA attiva senza chiave: messaggio chiaro');
ok((await fn(op, 'ai', { action: 'ask', question: 'ciao' })).status === 403, 'operatrice non usa l\'IA');

// Backup e ripristino
const { data: dump } = await rpc(admin, 'backup_dump');
ok(dump?.tables?.requests?.length === 2, 'backup: dati esportati');
ok((await rpc(op, 'backup_dump')).status === 403, 'operatrice non scarica backup');
await rpc(admin, 'delete_item', { p_kind: 'request', p_id: rid });
ok((await rpc(admin, 'list_items', { p_kind: 'request' })).data.length === 1, 'eliminazione definitiva');
ok((await rpc(admin, 'backup_restore', { p: dump })).data?.ok, 'ripristino');
ok((await rpc(admin, 'list_items', { p_kind: 'request' })).data.length === 2, 'dati tornati come nel backup');
r = await rpc(admin, 'create_item', { p_kind: 'request', p_data: { title: 'Dopo ripristino' } });
ok(r.data?.id > rid2, 'contatori riallineati dopo il ripristino');

// Disattivazione
seen.length = 0;
r = await fn(admin, 'admin-users', { action: 'update', id: mariaId, active: false });
ok(r.body.ok, 'operatrice disattivata');
ok((await rpc(op, 'list_items', { p_kind: 'request' })).status === 401, 'sessione della disattivata non più valida');
ok((await login(client(), 'maria', 'MariaPass2026')) !== null, 'la disattivata non può più accedere');
r = await rpc(admin, 'list_logs', { p: { limit: 200 } });
ok(r.data.total > 25, `registro attività: ${r.data.total} voci`);

await op2.removeAllChannels();
console.log(failures ? `\n${failures} TEST FALLITI` : '\nTutti i test superati.');
process.exit(failures ? 1 : 0);
