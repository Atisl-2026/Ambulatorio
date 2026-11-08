// Gestione degli account (solo il Capo) e creazione del primo amministratore.
import { handler, json, serviceClient, getCaller, HttpError, logActivity, emit, USER_EMAIL_DOMAIN } from '../_shared/common.ts';

const BAN_FOREVER = '876000h';

function checkPassword(pw: unknown) {
  if (typeof pw !== 'string' || pw.length < 10) throw new HttpError(400, 'La password deve avere almeno 10 caratteri.');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'La password deve contenere lettere e numeri.');
  return pw;
}
function checkUsername(u: unknown) {
  const v = String(u ?? '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(v)) throw new HttpError(400, 'Nome utente: 3-40 caratteri tra lettere, numeri, punto, trattino.');
  return v;
}
function checkName(n: unknown) {
  const v = String(n ?? '').trim();
  if (!v) throw new HttpError(400, 'Il nome visualizzato è obbligatorio.');
  if (v.length > 100) throw new HttpError(400, 'Nome troppo lungo.');
  return v;
}

Deno.serve(handler(async (req, body) => {
  const db = serviceClient();
  const action = body.action;

  // ----- Primo avvio: nessun account esistente -----
  if (action === 'status') {
    const { count } = await db.from('profiles').select('id', { count: 'exact', head: true });
    return json({ needsSetup: (count ?? 0) === 0 });
  }
  if (action === 'bootstrap') {
    const { count } = await db.from('profiles').select('id', { count: 'exact', head: true });
    if ((count ?? 0) > 0) throw new HttpError(403, 'L\'amministratore esiste già.');
    const username = checkUsername(body.username);
    const displayName = checkName(body.displayName || 'Il Capo');
    const password = checkPassword(body.password);
    const { data, error } = await db.auth.admin.createUser({
      email: `${username}@${USER_EMAIL_DOMAIN}`, password, email_confirm: true, user_metadata: { username },
    });
    if (error || !data.user) throw new HttpError(400, `Creazione non riuscita: ${error?.message}`);
    const { error: e2 } = await db.from('profiles').insert({
      id: data.user.id, username, display_name: displayName, role: 'admin', must_change_password: false,
    });
    if (e2) {
      await db.auth.admin.deleteUser(data.user.id);
      throw new HttpError(409, 'L\'amministratore esiste già.');
    }
    await logActivity(db, { id: data.user.id, display_name: displayName }, 'utente_creato', `Creato l'account del Capo "${username}" (primo avvio)`);
    return json({ ok: true });
  }

  const me = await getCaller(req, db, { admin: true });

  if (action === 'create') {
    const username = checkUsername(body.username);
    const displayName = checkName(body.displayName);
    const role = body.role === 'admin' ? 'admin' : 'operator';
    const password = checkPassword(body.password);
    const { data: exists } = await db.from('profiles').select('id').eq('username', username).maybeSingle();
    if (exists) throw new HttpError(409, 'Nome utente già esistente.');
    const { data, error } = await db.auth.admin.createUser({
      email: `${username}@${USER_EMAIL_DOMAIN}`, password, email_confirm: true, user_metadata: { username },
    });
    if (error || !data.user) {
      throw new HttpError(400, /already/i.test(error?.message || '') ? 'Nome utente già esistente.' : `Creazione non riuscita: ${error?.message}`);
    }
    const { error: e2 } = await db.from('profiles').insert({
      id: data.user.id, username, display_name: displayName, role, must_change_password: true,
      created_by: me.id, updated_by: me.id,
    });
    if (e2) {
      await db.auth.admin.deleteUser(data.user.id);
      throw new HttpError(400, `Creazione non riuscita: ${e2.message}`);
    }
    await logActivity(db, me, 'utente_creato', `Creato account ${role === 'admin' ? 'amministratore' : 'operatore'} "${username}" (${displayName})`);
    await emit(db, 'users:changed');
    return json({ id: data.user.id });
  }

  if (action === 'update') {
    const { data: u } = await db.from('profiles').select('*').eq('id', body.id).maybeSingle();
    if (!u) throw new HttpError(404, 'Utente non trovato.');
    const changes: string[] = [];
    const displayName = body.displayName !== undefined ? checkName(body.displayName) : u.display_name;
    if (displayName !== u.display_name) changes.push(`nome → "${displayName}"`);
    const role = body.role === undefined ? u.role : body.role === 'admin' ? 'admin' : 'operator';
    if (role !== u.role) changes.push(`ruolo → ${role === 'admin' ? 'amministratore' : 'operatore'}`);
    const active = body.active === undefined ? u.active : !!body.active;
    if (active !== u.active) changes.push(active ? 'riattivato' : 'disattivato');
    if (u.id === me.id && (!active || role !== 'admin')) throw new HttpError(400, 'Non puoi disattivare o declassare il tuo stesso account.');
    if (u.role === 'admin' && (role !== 'admin' || !active)) {
      const { count } = await db.from('profiles').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('active', true);
      if ((count ?? 0) <= 1) throw new HttpError(400, 'Deve rimanere almeno un amministratore attivo.');
    }
    const authUpdate: Record<string, unknown> = {};
    if (body.password) {
      authUpdate.password = checkPassword(body.password);
      changes.push('password reimpostata');
    }
    if (active !== u.active) authUpdate.ban_duration = active ? 'none' : BAN_FOREVER;
    if (!changes.length) return json({ ok: true });
    if (Object.keys(authUpdate).length) {
      const { error } = await db.auth.admin.updateUserById(u.id, authUpdate);
      if (error) throw new HttpError(400, `Aggiornamento non riuscito: ${error.message}`);
    }
    await db.from('profiles').update({
      display_name: displayName, role, active,
      must_change_password: body.password ? true : u.must_change_password,
      updated_at: new Date().toISOString(), updated_by: me.id,
    }).eq('id', u.id);
    if (!active || role !== u.role || body.password) await emit(db, 'session:revoked', {}, u.id);
    await logActivity(db, me, 'utente_modificato', `Account "${u.username}": ${changes.join(', ')}`);
    await emit(db, 'users:changed');
    return json({ ok: true });
  }

  throw new HttpError(400, 'Azione non valida.');
}));
