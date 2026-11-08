// Logica comune per richieste e appuntamenti: bozze private, pubblicazione,
// blocchi del Capo, cronologia delle versioni.
import { get, all, run, tx, now, userNames } from './db.js';
import { HttpError, lockedError, str } from './security.js';
import { isISODate, isTime, mondayOf, weekdayIndex, addDays } from '../shared/dates.js';
import { logActivity } from './log.js';
import { broadcast, sendToUser } from './realtime.js';

export const REQUEST_STATUSES = ['Nuova', 'In lavorazione', 'In attesa', 'Completata', 'Annullata'];

// ---------- Definizione dei tipi ----------

function sanitizeRequest(input) {
  const d = input || {};
  const date = d.date ? String(d.date) : '';
  if (date && !isISODate(date)) throw new HttpError(400, 'Data non valida.');
  const status = d.status ? String(d.status) : 'Nuova';
  if (!REQUEST_STATUSES.includes(status)) throw new HttpError(400, 'Stato non valido.');
  let attachments = Array.isArray(d.attachments) ? d.attachments : [];
  attachments = [...new Set(attachments.map((a) => String(typeof a === 'object' && a ? a.id : a)))].slice(0, 30);
  for (const id of attachments) {
    if (!get('SELECT id FROM files WHERE id = ?', id)) throw new HttpError(400, 'Allegato non trovato.');
  }
  return {
    title: str(d.title, 200, 'Titolo'),
    description: str(d.description, 20000, 'Descrizione'),
    client: str(d.client, 200, 'Cliente'),
    date,
    status,
    attachments,
  };
}

function validateRequestForPublish(d) {
  if (!d.title) throw new HttpError(400, 'Il titolo è obbligatorio per pubblicare.');
  if (!d.client) throw new HttpError(400, 'Il cliente è obbligatorio per pubblicare.');
  if (!d.date) throw new HttpError(400, 'La data è obbligatoria per pubblicare.');
}

function sanitizeAppointment(input) {
  const d = input || {};
  const operatorId = d.operator_id ? Number(d.operator_id) : null;
  if (operatorId && !get('SELECT id FROM users WHERE id = ?', operatorId)) throw new HttpError(400, 'Operatrice non valida.');
  const doctorId = d.doctor_id ? Number(d.doctor_id) : null;
  if (doctorId && !get('SELECT id FROM doctors WHERE id = ?', doctorId)) throw new HttpError(400, 'Medico non valido.');
  const day = d.day ? String(d.day) : '';
  if (day && !isISODate(day)) throw new HttpError(400, 'Giorno non valido.');
  if (day && weekdayIndex(day) > 5) throw new HttpError(400, 'L\'ambulatorio è aperto dal lunedì al sabato.');
  const time = d.time ? String(d.time) : '';
  if (time && !isTime(time)) throw new HttpError(400, 'Orario non valido (formato HH:MM).');
  return {
    operator_id: operatorId,
    doctor_id: doctorId,
    day,
    time,
    client: str(d.client, 200, 'Cliente'),
    docs_checked: !!d.docs_checked,
    notes: str(d.notes, 5000, 'Note'),
  };
}

function validateAppointmentForPublish(d) {
  const missing = [];
  if (!d.operator_id) missing.push('operatrice');
  if (!d.doctor_id) missing.push('medico');
  if (!d.day) missing.push('giorno');
  if (!d.time) missing.push('orario');
  if (!d.client) missing.push('cliente');
  if (missing.length) throw new HttpError(400, `Per pubblicare compila: ${missing.join(', ')}.`);
}

export const KINDS = {
  request: {
    table: 'requests',
    label: 'richiesta',
    fields: ['title', 'description', 'client', 'date', 'status', 'attachments'],
    sanitize: sanitizeRequest,
    validatePublish: validateRequestForPublish,
    describe: (d) => `"${d.title || 'senza titolo'}"`,
    event: 'requests:changed',
  },
  appointment: {
    table: 'appointments',
    label: 'appuntamento',
    fields: ['operator_id', 'doctor_id', 'day', 'time', 'client', 'docs_checked', 'notes'],
    sanitize: sanitizeAppointment,
    validatePublish: validateAppointmentForPublish,
    describe: (d) => `${d.client || 'senza cliente'} ${d.day || ''} ${d.time || ''}`.trim(),
    event: 'appointments:changed',
  },
};

export function kindDef(kind) {
  const k = KINDS[kind];
  if (!k) throw new HttpError(404, 'Tipo non valido.');
  return k;
}

// ---------- Lettura ----------

export function rowData(kind, row) {
  if (kind === 'request') {
    return {
      title: row.title, description: row.description, client: row.client,
      date: row.date || '', status: row.status, attachments: JSON.parse(row.attachments || '[]'),
    };
  }
  return {
    operator_id: row.operator_id, doctor_id: row.doctor_id, day: row.day || '', time: row.time || '',
    client: row.client, docs_checked: !!row.docs_checked, notes: row.notes,
  };
}

export function loadRow(kind, id) {
  const row = get(`SELECT * FROM ${kindDef(kind).table} WHERE id = ?`, Number(id));
  if (!row) throw new HttpError(404, 'Elemento non trovato (potrebbe essere stato eliminato).', 'NOT_FOUND');
  return row;
}

export function getDraft(kind, id, userId) {
  return get('SELECT * FROM drafts WHERE kind = ? AND item_id = ? AND user_id = ?', kind, id, userId) || null;
}

export function isWeekLocked(day) {
  if (!day || !isISODate(day)) return false;
  return !!get('SELECT 1 AS x FROM week_locks WHERE week_start = ?', mondayOf(day));
}

export function makeContext() {
  const users = userNames();
  const doctors = new Map(all('SELECT id, name, specialty FROM doctors').map((d) => [d.id, d]));
  const weekLocks = new Set(all('SELECT week_start FROM week_locks').map((w) => w.week_start));
  return { users, doctors, weekLocks };
}

function fileMeta(ids) {
  return ids
    .map((id) => get('SELECT id, original_name AS name, mime, size FROM files WHERE id = ?', id))
    .filter(Boolean);
}

export function withNames(kind, data, ctx) {
  if (kind === 'request') return { ...data, attachments: fileMeta(data.attachments || []) };
  const doc = ctx.doctors.get(data.doctor_id);
  return {
    ...data,
    operator_name: ctx.users.get(data.operator_id) || '',
    doctor_name: doc ? doc.name : '',
    doctor_specialty: doc ? doc.specialty : '',
  };
}

export function serialize(kind, row, draft, ctx) {
  const n = (id) => (id ? ctx.users.get(id) || '—' : null);
  const published = row.is_published ? withNames(kind, rowData(kind, row), ctx) : null;
  let draftOut = null;
  if (draft) {
    const data = JSON.parse(draft.data);
    draftOut = {
      ...withNames(kind, data, ctx),
      updatedAt: draft.updated_at,
      baseVersion: draft.base_version,
      stale: !!row.is_published && draft.base_version < row.version,
    };
  }
  const out = {
    kind,
    id: row.id,
    isPublished: !!row.is_published,
    version: row.version,
    published,
    draft: draftOut,
    locked: !!row.locked,
    lockedAt: row.locked_at,
    lockedByName: n(row.locked_by),
    authorName: n(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedByName: n(row.updated_by),
    publishedAt: row.published_at,
    publishedByName: n(row.published_by),
  };
  if (kind === 'appointment') {
    out.weekLocked = !!(row.is_published && row.day && ctx.weekLocks.has(mondayOf(row.day)));
    out.draftWeekLocked = !!(draftOut?.day && ctx.weekLocks.has(mondayOf(draftOut.day)));
  }
  return out;
}

export function serializeOne(kind, id, user) {
  const row = loadRow(kind, id);
  const draft = getDraft(kind, row.id, user.id);
  if (!row.is_published && !draft) throw new HttpError(404, 'Elemento non trovato.', 'NOT_FOUND');
  return serialize(kind, row, draft, makeContext());
}

// Elenco visibile all'utente: tutto il pubblicato + le proprie bozze.
export function listVisible(kind, user, { from, to } = {}) {
  const def = kindDef(kind);
  const ctx = makeContext();
  const drafts = new Map(
    all('SELECT * FROM drafts WHERE kind = ? AND user_id = ?', kind, user.id).map((d) => [d.item_id, d]),
  );
  let rows;
  if (kind === 'appointment' && from && to) {
    rows = all(`SELECT * FROM ${def.table} WHERE is_published = 1 AND day BETWEEN ? AND ?`, from, to);
    const ids = new Set(rows.map((r) => r.id));
    for (const d of drafts.values()) {
      if (ids.has(d.item_id)) continue;
      const day = JSON.parse(d.data).day;
      const r = get(`SELECT * FROM ${def.table} WHERE id = ?`, d.item_id);
      if (!r) continue;
      // Bozza (nuova o modifica) che cade nella settimana visualizzata, o senza giorno.
      if ((day && day >= from && day <= to) || (!day && !r.is_published)) rows.push(r);
    }
  } else {
    rows = all(`SELECT * FROM ${def.table} WHERE is_published = 1`);
    const ids = new Set(rows.map((r) => r.id));
    for (const d of drafts.values()) {
      if (ids.has(d.item_id)) continue;
      const r = get(`SELECT * FROM ${def.table} WHERE id = ?`, d.item_id);
      if (r) rows.push(r);
    }
  }
  return rows.map((r) => serialize(kind, r, drafts.get(r.id) || null, ctx));
}

// ---------- Permessi di modifica ----------

export function assertEditable(user, kind, row, newData) {
  if (user.role === 'admin') return;
  if (row?.locked) throw lockedError();
  if (kind === 'appointment') {
    if (row?.is_published && isWeekLocked(row.day)) throw lockedError();
    if (newData?.day && isWeekLocked(newData.day)) throw lockedError();
  }
}

// ---------- Scrittura ----------

function notifyDraft(kind, user, id) {
  sendToUser(user.id, { type: kindDef(kind).event, id, draft: true });
}

export function createItem(req, kind, input) {
  const def = kindDef(kind);
  const data = def.sanitize(input);
  assertEditable(req.user, kind, null, data);
  const id = tx(() => {
    const t = now();
    const r = run(
      `INSERT INTO ${def.table} (created_at, created_by, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
      t, req.user.id, t, req.user.id,
    );
    const newId = Number(r.lastInsertRowid);
    run(
      'INSERT INTO drafts (kind, item_id, user_id, data, base_version, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
      kind, newId, req.user.id, JSON.stringify(data), t, t,
    );
    logActivity(req, 'bozza_creata', `Nuova bozza di ${def.label} ${def.describe(data)}`, kind, newId);
    return newId;
  });
  notifyDraft(kind, req.user, id);
  return serializeOne(kind, id, req.user);
}

export function saveDraft(req, kind, id, input) {
  const def = kindDef(kind);
  const row = loadRow(kind, id);
  const existing = getDraft(kind, row.id, req.user.id);
  if (!row.is_published && !existing) throw new HttpError(404, 'Elemento non trovato.', 'NOT_FOUND');
  const data = def.sanitize(input);
  assertEditable(req.user, kind, row, data);
  const t = now();
  tx(() => {
    if (existing) {
      run('UPDATE drafts SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), t, existing.id);
    } else {
      run(
        'INSERT INTO drafts (kind, item_id, user_id, data, base_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        kind, row.id, req.user.id, JSON.stringify(data), row.version, t, t,
      );
    }
    logActivity(req, 'bozza_salvata', `Bozza salvata: ${def.label} ${def.describe(data)}`, kind, row.id);
  });
  notifyDraft(kind, req.user, row.id);
  return serializeOne(kind, row.id, req.user);
}

export function discardDraft(req, kind, id) {
  const def = kindDef(kind);
  const row = loadRow(kind, id);
  const draft = getDraft(kind, row.id, req.user.id);
  if (!draft) throw new HttpError(404, 'Nessuna bozza da annullare.');
  tx(() => {
    run('DELETE FROM drafts WHERE id = ?', draft.id);
    const others = get('SELECT COUNT(*) AS n FROM drafts WHERE kind = ? AND item_id = ?', kind, row.id).n;
    if (!row.is_published && others === 0) run(`DELETE FROM ${def.table} WHERE id = ?`, row.id);
    logActivity(req, 'bozza_annullata', `Bozza annullata: ${def.label} ${def.describe(JSON.parse(draft.data))}`, kind, row.id);
  });
  notifyDraft(kind, req.user, row.id);
  return { ok: true, deleted: !row.is_published };
}

function snapshot(kind, data, ctx) {
  const named = withNames(kind, data, ctx);
  if (kind === 'request') named.attachments = named.attachments.map((a) => ({ id: a.id, name: a.name }));
  return named;
}

export function addVersion(req, kind, itemId, version, action, data) {
  run(
    'INSERT INTO versions (kind, item_id, version, action, data, user_id, user_name, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    kind, itemId, version, action, JSON.stringify(data), req.user.id, req.user.displayName, now(),
  );
}

export function publish(req, kind, id, input) {
  const def = kindDef(kind);
  const row = loadRow(kind, id);
  const draft = getDraft(kind, row.id, req.user.id);
  if (!draft && !input) throw new HttpError(400, 'Non ci sono modifiche da pubblicare.');
  if (!row.is_published && !draft) throw new HttpError(404, 'Elemento non trovato.', 'NOT_FOUND');
  const data = def.sanitize(input || JSON.parse(draft.data));
  assertEditable(req.user, kind, row, data);
  def.validatePublish(data);
  const first = !row.is_published;
  const version = row.version + 1;
  const t = now();
  tx(() => {
    const sets = def.fields.map((f) => `${f} = ?`).join(', ');
    const values = def.fields.map((f) => (f === 'attachments' ? JSON.stringify(data[f]) : data[f]));
    run(
      `UPDATE ${def.table} SET ${sets}, is_published = 1, version = ?, published_at = ?, published_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      ...values, version, t, req.user.id, t, req.user.id, row.id,
    );
    if (draft) run('DELETE FROM drafts WHERE id = ?', draft.id);
    addVersion(req, kind, row.id, version, first ? 'Creazione' : 'Modifica', snapshot(kind, data, makeContext()));
    logActivity(req, 'pubblicazione', `${first ? 'Pubblicata nuova' : 'Pubblicata modifica di'} ${def.label} ${def.describe(data)}`, kind, row.id);
  });
  broadcast({ type: def.event, id: row.id });
  return serializeOne(kind, row.id, req.user);
}

export function setLock(req, kind, id, locked) {
  const def = kindDef(kind);
  const row = loadRow(kind, id);
  if (!row.is_published) throw new HttpError(400, 'Si possono bloccare solo elementi pubblicati.');
  const t = now();
  tx(() => {
    run(
      `UPDATE ${def.table} SET locked = ?, locked_at = ?, locked_by = ?, updated_at = ?, updated_by = ? WHERE id = ?`,
      locked ? 1 : 0, locked ? t : null, locked ? req.user.id : null, t, req.user.id, row.id,
    );
    addVersion(req, kind, row.id, row.version, locked ? 'Blocco' : 'Sblocco', snapshot(kind, rowData(kind, row), makeContext()));
    logActivity(req, locked ? 'blocco' : 'sblocco', `${locked ? 'Bloccato' : 'Sbloccato'}: ${def.label} ${def.describe(rowData(kind, row))}`, kind, row.id);
  });
  broadcast({ type: 'lock', kind, id: row.id, locked });
  broadcast({ type: def.event, id: row.id });
  return serializeOne(kind, row.id, req.user);
}

export function deleteItem(req, kind, id) {
  const def = kindDef(kind);
  const row = loadRow(kind, id);
  const data = rowData(kind, row);
  tx(() => {
    run(`DELETE FROM ${def.table} WHERE id = ?`, row.id);
    run('DELETE FROM drafts WHERE kind = ? AND item_id = ?', kind, row.id);
    run('DELETE FROM versions WHERE kind = ? AND item_id = ?', kind, row.id);
    logActivity(req, 'eliminazione', `Eliminato definitivamente: ${def.label} ${def.describe(data)}`, kind, row.id);
  });
  broadcast({ type: 'deleted', kind, id: row.id });
  broadcast({ type: def.event, id: row.id });
  return { ok: true };
}

export function listVersions(user, kind, id) {
  const row = loadRow(kind, id);
  if (!row.is_published && !getDraft(kind, row.id, user.id)) throw new HttpError(404, 'Elemento non trovato.');
  return all('SELECT * FROM versions WHERE kind = ? AND item_id = ? ORDER BY id DESC', kind, row.id).map((v) => ({
    ...v,
    data: JSON.parse(v.data),
  }));
}

// ---------- Settimane ----------

export function setWeekLock(req, weekStart, locked) {
  if (!isISODate(weekStart) || weekdayIndex(weekStart) !== 0) throw new HttpError(400, 'Settimana non valida.');
  const t = now();
  tx(() => {
    if (locked) {
      run('INSERT OR REPLACE INTO week_locks (week_start, locked_at, locked_by) VALUES (?, ?, ?)', weekStart, t, req.user.id);
    } else {
      run('DELETE FROM week_locks WHERE week_start = ?', weekStart);
    }
    addVersion(req, 'week', Number(weekStart.replaceAll('-', '')), 0, locked ? 'Blocco settimana' : 'Sblocco settimana', { weekStart });
    logActivity(req, locked ? 'blocco_settimana' : 'sblocco_settimana',
      `${locked ? 'Bloccata' : 'Sbloccata'} la settimana dal ${weekStart} al ${addDays(weekStart, 5)}`, 'week', null);
  });
  broadcast({ type: 'week-lock', weekStart, locked });
  broadcast({ type: 'appointments:changed' });
  return { weekStart, locked };
}

export function weekLocksInRange(from, to) {
  const users = userNames();
  return all('SELECT * FROM week_locks WHERE week_start BETWEEN ? AND ?', mondayOf(from), to).map((w) => ({
    weekStart: w.week_start,
    lockedAt: w.locked_at,
    lockedByName: users.get(w.locked_by) || '—',
  }));
}
