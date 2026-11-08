import { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useApp, useEvent } from '../context.js';
import { Icon, Modal, Spinner, Switch, RichText, Logo } from '../components/ui.jsx';
import {
  formatDateTime, todayISO, mondayOf, addDays, weekKey, weekLabel, MONTHS, formatDate,
} from '../../shared/dates.js';

const TABS = [
  ['users', 'Utenti'],
  ['drive', 'Archivio Google Drive'],
  ['doctors', 'Medici'],
  ['ai', 'Intelligenza artificiale'],
  ['export', 'Esportazione Excel'],
  ['log', 'Registro attività'],
  ['settings', 'Impostazioni'],
];

const DRIVE_RESULT = {
  ok: ['Google Drive collegato: l\'archivio viene copiato nel Drive dell\'amministratore.', 'success'],
  annullato: ['Collegamento al Google Drive annullato.', 'info'],
  errore: ['Collegamento al Google Drive non riuscito. Riprova.', 'error'],
};

export default function Admin() {
  const { settings, toast } = useApp();
  const [tab, setTab] = useState(() => (new URLSearchParams(window.location.search).has('drive') ? 'drive' : 'users'));
  // Ritorno dalla pagina di autorizzazione di Google.
  useEffect(() => {
    const r = new URLSearchParams(window.location.search).get('drive');
    if (!r) return;
    const [msg, type] = DRIVE_RESULT[r] || DRIVE_RESULT.errore;
    toast(msg, type);
    window.history.replaceState({}, '', '/amministrazione');
  }, [toast]);
  return (
    <>
      <div className="page-head">
        <h1>Amministrazione</h1>
        <span className="badge badge-admin">Area del Capo</span>
        <span className="spacer" />
        <span className={`badge ${settings.aiEnabled ? 'badge-ok' : ''}`}>{settings.aiEnabled ? 'IA attiva' : 'IA disattivata'}</span>
      </div>
      <div className="tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button type="button" key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>
      {tab === 'users' && <Users />}
      {tab === 'drive' && <DrivePanel />}
      {tab === 'doctors' && <Doctors />}
      {tab === 'ai' && <AiPanel />}
      {tab === 'export' && <ExportPanel />}
      {tab === 'log' && <ActivityLog />}
      {tab === 'settings' && <SettingsPanel />}
    </>
  );
}

// ================= Utenti =================

function randomPassword() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  let s = '';
  for (let i = 0; i < 10; i++) s += chars[arr[i] % chars.length];
  return s + digits[arr[10] % digits.length] + digits[arr[11] % digits.length];
}

function Users() {
  const { toast, user: me } = useApp();
  const [users, setUsers] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => api.get('/users').then(setUsers).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => { load(); }, [load]);
  useEvent(['users:changed'], () => load());

  const toggleActive = async (u) => {
    try {
      await api.patch(`/users/${u.id}`, { active: !u.active });
      toast(u.active ? `Account di ${u.displayName} disattivato: la sessione è stata chiusa.` : `Account di ${u.displayName} riattivato.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <div className="row" style={{ marginBottom: 12 }}>
        <p className="muted small" style={{ margin: 0, flex: 1 }}>Crea, modifica e disattiva gli account. Ogni modifica è registrata con autore, data e ora.</p>
        <button type="button" className="btn btn-primary" onClick={() => setEdit({})}><Icon name="plus" /> Nuovo account</button>
      </div>
      {!users ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table responsive">
            <thead><tr><th>Nome</th><th>Utente</th><th>Ruolo</th><th>Stato</th><th>Creato</th><th>Ultima modifica</th><th /></tr></thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="Nome"><b>{u.displayName}</b></td>
                  <td data-label="Utente">{u.username}</td>
                  <td data-label="Ruolo">{u.role === 'admin' ? <span className="badge badge-admin">Amministratore</span> : <span className="badge">Operatore</span>}</td>
                  <td data-label="Stato">
                    {u.active ? <span className="badge badge-ok">Attivo</span> : <span className="badge badge-locked">Disattivato</span>}
                    {u.mustChangePassword && <div className="small muted">password da cambiare</div>}
                  </td>
                  <td data-label="Creato" className="small">{formatDateTime(u.createdAt)}<br /><span className="muted">{u.createdByName || 'sistema'}</span></td>
                  <td data-label="Ultima modifica" className="small">{formatDateTime(u.updatedAt)}<br /><span className="muted">{u.updatedByName || '—'}</span></td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn btn-sm" onClick={() => setEdit(u)}>Modifica</button>
                      {u.id !== me.id && (
                        <button type="button" className={`btn btn-sm ${u.active ? 'btn-danger' : 'btn-secondary'}`} onClick={() => toggleActive(u)}>
                          {u.active ? 'Disattiva' : 'Riattiva'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <UserForm user={edit.id ? edit : null} onClose={() => setEdit(null)} />}
    </>
  );
}

function UserForm({ user, onClose }) {
  const { toast, user: me } = useApp();
  const [f, setF] = useState({ username: user?.username || '', displayName: user?.displayName || '', role: user?.role || 'operator', password: user ? '' : randomPassword() });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (user) {
        const body = { displayName: f.displayName, role: f.role };
        if (f.password) body.password = f.password;
        await api.patch(`/users/${user.id}`, body);
        toast('Account aggiornato.', 'success');
      } else {
        await api.post('/users', f);
        toast(`Account creato. Comunica all'utente la password temporanea: ${f.password}`, 'success');
      }
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={user ? `Modifica account · ${user.username}` : 'Nuovo account'}
      onClose={onClose}
      size="narrow"
      footer={<><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Annulla</button><button type="submit" form="user-form" className="btn btn-primary" disabled={busy}>Salva</button></>}
    >
      <form id="user-form" onSubmit={submit}>
        {error && <div className="error-box">{error}</div>}
        {!user && (
          <div className="field">
            <label htmlFor="uf-u">Nome utente</label>
            <input id="uf-u" className="input" value={f.username} onChange={set('username')} autoCapitalize="none" required />
          </div>
        )}
        <div className="field">
          <label htmlFor="uf-n">Nome visualizzato</label>
          <input id="uf-n" className="input" value={f.displayName} onChange={set('displayName')} required placeholder="es. Maria Rossi" />
        </div>
        <div className="field">
          <label htmlFor="uf-r">Ruolo</label>
          <select id="uf-r" className="input" value={f.role} onChange={set('role')} disabled={user?.id === me.id}>
            <option value="operator">Operatore</option>
            <option value="admin">Amministratore</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="uf-p">{user ? 'Reimposta password (facoltativo)' : 'Password temporanea'}</label>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input id="uf-p" className="input" value={f.password} onChange={set('password')} autoComplete="new-password" required={!user} />
            <button type="button" className="btn btn-sm" onClick={() => setF((p) => ({ ...p, password: randomPassword() }))}>Genera</button>
          </div>
          <span className="hint">L'utente dovrà cambiarla al primo accesso. Almeno 10 caratteri con lettere e numeri.</span>
        </div>
      </form>
    </Modal>
  );
}

// ================= Medici =================

function Doctors() {
  const { doctors, toast } = useApp();
  const [name, setName] = useState('');
  const [specialty, setSpecialty] = useState('');
  const [edit, setEdit] = useState(null);

  const add = async (e) => {
    e.preventDefault();
    try {
      await api.post('/doctors', { name, specialty });
      setName('');
      setSpecialty('');
      toast('Medico aggiunto.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };
  const update = async (d, patch) => {
    try {
      await api.patch(`/doctors/${d.id}`, patch);
      toast('Medico aggiornato.', 'success');
      setEdit(null);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <>
      <form className="card card-pad" onSubmit={add} style={{ marginBottom: 16 }}>
        <h3>Aggiungi medico</h3>
        <div className="grid-3">
          <div className="field"><label htmlFor="d-n">Nome e cognome</label><input id="d-n" className="input" value={name} onChange={(e) => setName(e.target.value)} required placeholder="es. Dott. Mario Bianchi" /></div>
          <div className="field"><label htmlFor="d-s">Specialità</label><input id="d-s" className="input" value={specialty} onChange={(e) => setSpecialty(e.target.value)} placeholder="es. Medicina legale" /></div>
          <div className="field"><span className="label">&nbsp;</span><button type="submit" className="btn btn-primary"><Icon name="plus" /> Aggiungi</button></div>
        </div>
      </form>
      {doctors.length === 0 ? <div className="card empty">Nessun medico in elenco.</div> : (
        <div className="card table-wrap">
          <table className="table responsive">
            <thead><tr><th>Medico</th><th>Specialità</th><th>Stato</th><th>Ultima modifica</th><th /></tr></thead>
            <tbody>
              {doctors.map((d) => (
                <tr key={d.id}>
                  <td data-label="Medico"><b>{d.name}</b></td>
                  <td data-label="Specialità">{d.specialty || '—'}</td>
                  <td data-label="Stato">{d.active ? <span className="badge badge-ok">In elenco</span> : <span className="badge">Non attivo</span>}</td>
                  <td data-label="Ultima modifica" className="small">{formatDateTime(d.updatedAt)} · {d.updatedByName || '—'}</td>
                  <td>
                    <div className="row">
                      <button type="button" className="btn btn-sm" onClick={() => setEdit(d)}>Modifica</button>
                      <button type="button" className="btn btn-sm" onClick={() => update(d, { active: !d.active })}>{d.active ? 'Disattiva' : 'Riattiva'}</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <DoctorForm doctor={edit} onSave={(p) => update(edit, p)} onClose={() => setEdit(null)} />}
    </>
  );
}

function DoctorForm({ doctor, onSave, onClose }) {
  const [name, setName] = useState(doctor.name);
  const [specialty, setSpecialty] = useState(doctor.specialty);
  return (
    <Modal title="Modifica medico" onClose={onClose} size="narrow"
      footer={<><span className="spacer" /><button type="button" className="btn" onClick={onClose}>Annulla</button><button type="button" className="btn btn-primary" onClick={() => onSave({ name, specialty })}>Salva</button></>}>
      <div className="field"><label htmlFor="df-n">Nome e cognome</label><input id="df-n" className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
      <div className="field"><label htmlFor="df-s">Specialità</label><input id="df-s" className="input" value={specialty} onChange={(e) => setSpecialty(e.target.value)} /></div>
    </Modal>
  );
}

// ================= Selettori periodo =================

function WeekPicker({ value, onChange }) {
  return (
    <div className="row">
      <button type="button" className="btn btn-icon" onClick={() => onChange(addDays(value, -7))} aria-label="Settimana precedente"><Icon name="left" /></button>
      <input className="input" type="date" style={{ maxWidth: 170 }} value={value} onChange={(e) => e.target.value && onChange(mondayOf(e.target.value))} aria-label="Un giorno della settimana" />
      <button type="button" className="btn btn-icon" onClick={() => onChange(addDays(value, 7))} aria-label="Settimana successiva"><Icon name="right" /></button>
      <span className="small"><b>{weekKey(value)}</b> · {weekLabel(value)}</span>
    </div>
  );
}

function MonthPicker({ value, onChange }) {
  const [y, m] = value.split('-').map(Number);
  const years = [];
  for (let i = new Date().getFullYear() + 1; i >= 2020; i--) years.push(i);
  return (
    <div className="row">
      <select className="input" style={{ maxWidth: 160 }} value={m} onChange={(e) => onChange(`${y}-${String(e.target.value).padStart(2, '0')}`)} aria-label="Mese">
        {MONTHS.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
      </select>
      <select className="input" style={{ maxWidth: 110 }} value={y} onChange={(e) => onChange(`${e.target.value}-${String(m).padStart(2, '0')}`)} aria-label="Anno">
        {years.map((yy) => <option key={yy}>{yy}</option>)}
      </select>
    </div>
  );
}

const thisMonth = () => todayISO().slice(0, 7);

// ================= Esportazione =================

function ExportPanel() {
  const { toast } = useApp();
  const [week, setWeek] = useState(mondayOf(todayISO()));
  const [month, setMonth] = useState(thisMonth());
  const [busy, setBusy] = useState(false);
  const dl = async (url) => {
    setBusy(true);
    try {
      const name = await api.download(url);
      toast(`Scaricato ${name}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-grid">
      <div className="card card-pad">
        <h3>Calendario settimanale</h3>
        <p className="small muted">Scegli la settimana (dal lunedì al sabato).</p>
        <WeekPicker value={week} onChange={setWeek} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 14 }} disabled={busy} onClick={() => dl(`/export/week?week=${weekKey(week)}`)}>
          <Icon name="download" /> Scarica Ambulatorio_Settimana_{weekKey(week)}.xlsx
        </button>
      </div>
      <div className="card card-pad">
        <h3>Calendario mensile</h3>
        <p className="small muted">Scegli il mese.</p>
        <MonthPicker value={month} onChange={setMonth} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 14 }} disabled={busy} onClick={() => dl(`/export/month?month=${month}`)}>
          <Icon name="download" /> Scarica Ambulatorio_{MONTHS[Number(month.slice(5)) - 1]}_{month.slice(0, 4)}.xlsx
        </button>
      </div>
      <div className="card card-pad small muted" style={{ gridColumn: '1 / -1' }}>
        Il file contiene tutte le colonne del calendario (operatrice, medico, giorno, orario, cliente, documenti controllati, note) più stato di blocco e ultima modifica,
        con intestazioni formattate e filtri attivi. Sono esportati solo gli appuntamenti pubblicati.
      </div>
    </div>
  );
}

// ================= Intelligenza artificiale =================

function AiPanel() {
  const { settings, toast, reloadShared } = useApp();
  const [busy, setBusy] = useState(false);
  const toggle = async (enabled) => {
    setBusy(true);
    try {
      await api.put('/settings/ai', { enabled });
      await reloadShared();
      toast(enabled ? 'IA attivata.' : 'IA disattivata: nessun dato verrà inviato a servizi di IA.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="stack">
      <div className="card card-pad">
        <Switch checked={settings.aiEnabled} onChange={toggle} disabled={busy} label={settings.aiEnabled ? 'IA attiva' : 'IA disattivata'} />
        <p className="small muted" style={{ marginTop: 10, marginBottom: 0 }}>
          Con l'IA disattivata ogni funzione di intelligenza artificiale sparisce dall'interfaccia e il server rifiuta qualsiasi invio di dati a servizi di IA.
          Con l'IA attiva, i dati necessari a ciascuna richiesta (richieste, appuntamenti, allegati da riassumere) vengono inviati al servizio Anthropic Claude solo quando premi un pulsante qui sotto.
        </p>
        {settings.aiEnabled && settings.aiConfigured === false && (
          <div className="error-box" style={{ marginTop: 12, marginBottom: 0 }}>
            Chiave API non configurata sul server: imposta la variabile d'ambiente ANTHROPIC_API_KEY e riavvia l'applicazione.
          </div>
        )}
      </div>
      {settings.aiEnabled && <AiAssistant />}
    </div>
  );
}

function AiResult({ state }) {
  if (!state) return null;
  if (state.loading) return <div className="ai-output"><Spinner label="L'assistente sta elaborando…" /></div>;
  if (state.error) return <div className="error-box" style={{ marginTop: 12 }}>{state.error}</div>;
  return (
    <div className="ai-output">
      {state.conflicts && (
        <div className={state.conflicts.length ? 'lock-banner' : 'info-banner'} style={{ display: 'block' }}>
          {state.conflicts.length
            ? <>Conflitti esatti rilevati: {state.conflicts.map((c) => `${c.doctor} ${formatDate(c.day, { weekday: true })} ore ${c.time} (${c.appointments.map((a) => `#${a.id} ${a.client}`).join(', ')})`).join(' · ')}</>
            : 'Nessun conflitto esatto (stesso medico, stesso giorno e orario).'}
        </div>
      )}
      {state.partial && <div className="info-banner">Archivio molto grande: analizzati solo gli elementi più recenti.</div>}
      <RichText text={state.text} />
      {state.truncated && <p className="small muted">(risposta troncata per lunghezza)</p>}
    </div>
  );
}

function AiAssistant() {
  const [question, setQuestion] = useState('');
  const [askState, setAskState] = useState(null);
  const [cPeriod, setCPeriod] = useState('week');
  const [cWeek, setCWeek] = useState(mondayOf(todayISO()));
  const [cMonth, setCMonth] = useState(thisMonth());
  const [cState, setCState] = useState(null);
  const [rPeriod, setRPeriod] = useState('week');
  const [rWeek, setRWeek] = useState(mondayOf(todayISO()));
  const [rMonth, setRMonth] = useState(thisMonth());
  const [rState, setRState] = useState(null);

  const call = async (url, body, set) => {
    set({ loading: true });
    try {
      set(await api.post(url, body));
    } catch (err) {
      set({ error: err.message });
    }
  };

  return (
    <div className="stack">
      <div className="ai-box">
        <span className="ai-tag"><Icon name="sparkle" size={12} /> Assistente IA</span>
        <h3 style={{ marginTop: 8 }}>Cerca nell'archivio con una domanda</h3>
        <form onSubmit={(e) => { e.preventDefault(); call('/ai/ask', { question }, setAskState); }}>
          <textarea className="input" rows={2} value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="es. Quali richieste del cliente Rossi sono ancora aperte? Quanti appuntamenti ha avuto il dott. Bianchi a ottobre?" />
          <button type="submit" className="btn btn-secondary" style={{ marginTop: 8 }} disabled={!question.trim() || askState?.loading}>Chiedi</button>
        </form>
        <AiResult state={askState} />
      </div>

      <div className="ai-box">
        <span className="ai-tag"><Icon name="sparkle" size={12} /> Assistente IA</span>
        <h3 style={{ marginTop: 8 }}>Conflitti e sovrapposizioni negli appuntamenti</h3>
        <PeriodSelect period={cPeriod} setPeriod={setCPeriod} week={cWeek} setWeek={setCWeek} month={cMonth} setMonth={setCMonth} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} disabled={cState?.loading}
          onClick={() => call('/ai/conflicts', { period: cPeriod, value: cPeriod === 'week' ? cWeek : cMonth }, setCState)}>
          Verifica conflitti
        </button>
        <AiResult state={cState} />
      </div>

      <div className="ai-box">
        <span className="ai-tag"><Icon name="sparkle" size={12} /> Assistente IA</span>
        <h3 style={{ marginTop: 8 }}>Riepilogo della settimana o del mese</h3>
        <PeriodSelect period={rPeriod} setPeriod={setRPeriod} week={rWeek} setWeek={setRWeek} month={rMonth} setMonth={setRMonth} />
        <button type="button" className="btn btn-secondary" style={{ marginTop: 10 }} disabled={rState?.loading}
          onClick={() => call('/ai/report', { period: rPeriod, value: rPeriod === 'week' ? rWeek : rMonth }, setRState)}>
          Genera riepilogo
        </button>
        <AiResult state={rState} />
      </div>
      <p className="small muted">Per riassumere una singola richiesta o documento, aprila dalla sezione Richieste e premi "Riassumi con IA".</p>
    </div>
  );
}

function PeriodSelect({ period, setPeriod, week, setWeek, month, setMonth }) {
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="seg" role="group" aria-label="Periodo">
        <button type="button" className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')}>Settimana</button>
        <button type="button" className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>Mese</button>
      </div>
      {period === 'week' ? <WeekPicker value={week} onChange={setWeek} /> : <MonthPicker value={month} onChange={setMonth} />}
    </div>
  );
}

// ================= Registro attività =================

const ACTION_LABELS = {
  accesso: 'Accesso', accesso_fallito: 'Accesso fallito', uscita: 'Uscita', password_cambiata: 'Password cambiata',
  bozza_creata: 'Bozza creata', bozza_salvata: 'Bozza salvata', bozza_annullata: 'Bozza scartata', pubblicazione: 'Pubblicazione',
  blocco: 'Blocco', sblocco: 'Sblocco', blocco_settimana: 'Blocco settimana', sblocco_settimana: 'Sblocco settimana',
  eliminazione: 'Eliminazione', utente_creato: 'Utente creato', utente_modificato: 'Utente modificato',
  medico_creato: 'Medico creato', medico_modificato: 'Medico modificato', impostazioni: 'Impostazioni',
  esportazione: 'Esportazione', ia: 'Uso IA', allegato_caricato: 'Allegato caricato',
};

function ActivityLog() {
  const { directory, toast } = useApp();
  const [f, setF] = useState({ user: '', action: '', q: '', from: '', to: '' });
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState(null);
  const limit = 50;
  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(f).filter(([, v]) => v)), limit, offset }).toString();
      setData(await api.get(`/logs?${qs}`));
    } catch (err) {
      toast(err.message, 'error');
    }
  }, [f, offset, toast]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => { setOffset(0); setF((p) => ({ ...p, [k]: e.target.value })); };

  return (
    <>
      <div className="filters">
        <div className="field"><label htmlFor="l-u">Utente</label>
          <select id="l-u" className="input" value={f.user} onChange={set('user')}>
            <option value="">Tutti</option>{directory.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="l-a">Azione</label>
          <select id="l-a" className="input" value={f.action} onChange={set('action')}>
            <option value="">Tutte</option>{(data?.actions || []).map((a) => <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>)}
          </select>
        </div>
        <div className="field"><label htmlFor="l-q">Testo</label><input id="l-q" className="input" type="search" value={f.q} onChange={set('q')} /></div>
        <div className="field"><label htmlFor="l-f">Dal</label><input id="l-f" className="input" type="date" value={f.from} onChange={set('from')} /></div>
        <div className="field"><label htmlFor="l-t">Al</label><input id="l-t" className="input" type="date" value={f.to} onChange={set('to')} /></div>
        <button type="button" className="btn" onClick={load}>Aggiorna</button>
      </div>
      {!data ? <Spinner /> : (
        <>
          <div className="card table-wrap">
            <table className="table responsive">
              <thead><tr><th>Data e ora</th><th>Utente</th><th>Azione</th><th>Dettagli</th><th>IP</th></tr></thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id}>
                    <td data-label="Data e ora" style={{ whiteSpace: 'nowrap' }}>{formatDateTime(r.at)}</td>
                    <td data-label="Utente">{r.user_name || '—'}</td>
                    <td data-label="Azione"><span className={`badge ${/blocco|eliminazione|fallito/.test(r.action) && !r.action.startsWith('sblocco') ? 'badge-locked' : ''}`}>{ACTION_LABELS[r.action] || r.action}</span></td>
                    <td data-label="Dettagli">{r.details}</td>
                    <td data-label="IP" className="small muted">{r.ip}</td>
                  </tr>
                ))}
                {data.rows.length === 0 && <tr><td colSpan={5} className="empty">Nessuna attività.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="pager">
            <span className="small muted">{data.total ? `${offset + 1}–${Math.min(offset + limit, data.total)} di ${data.total}` : ''}</span>
            <button type="button" className="btn btn-sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>Precedenti</button>
            <button type="button" className="btn btn-sm" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>Successivi</button>
          </div>
        </>
      )}
    </>
  );
}

// ================= Impostazioni =================

function SettingsPanel() {
  const { toast, logoVersion, settings } = useApp();
  const [busy, setBusy] = useState(false);
  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      await api.upload('/settings/logo', file);
      toast('Logo aggiornato per tutti gli utenti.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="admin-grid">
      <div className="card card-pad">
        <h3>Logo</h3>
        <p className="small muted">Il logo compare nella pagina di benvenuto, nel login e nell'intestazione di ogni pagina.</p>
        <div style={{ background: '#fff', border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 }}>
          <Logo className="welcome-logo" version={logoVersion} />
        </div>
        <input type="file" id="logo-file" className="sr-only" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => upload(e.target.files[0])} />
        <label htmlFor="logo-file" className="btn btn-secondary">{busy ? 'Caricamento…' : 'Carica nuovo logo'}</label>
      </div>
      <div className="card card-pad">
        <h3>Stato del sistema</h3>
        <ul className="small" style={{ paddingLeft: 18 }}>
          <li>Utenti collegati in tempo reale: <b>{settings.online ?? '—'}</b></li>
          <li>Intelligenza artificiale: <b>{settings.aiEnabled ? 'attiva' : 'disattivata'}</b></li>
          <li>Accesso solo autenticato, sessioni con scadenza per inattività, password cifrate (scrypt).</li>
          <li>Permessi verificati dal server su ogni operazione.</li>
        </ul>
      </div>
    </div>
  );
}

// ================= Archivio Google Drive =================

function DrivePanel() {
  const { toast, confirm } = useApp();
  const [st, setSt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState(null);
  const load = useCallback(() => api.get('/drive/status').then(setSt).catch((e) => toast(e.message, 'error')), [toast]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn) => {
    setBusy(true);
    try { await fn(); } catch (err) { toast(err.message, 'error'); } finally { setBusy(false); }
  };
  const connect = () => act(async () => {
    const { url } = await api.post('/drive/connect');
    window.location.href = url;
  });
  const syncNow = () => act(async () => {
    const s = await api.post('/drive/sync');
    setSt(s);
    toast(s.lastError ? s.lastError : 'Archivio sincronizzato sul Drive.', s.lastError ? 'error' : 'success');
  });
  const disconnect = async () => {
    const ok = await confirm({
      title: 'Scollegare il Google Drive?',
      message: 'L\'app smetterà di copiare l\'archivio sul Drive. I file già presenti nel Drive restano dove sono.',
      confirmLabel: 'Scollega', danger: true,
    });
    if (ok) act(async () => { setSt(await api.post('/drive/disconnect')); setToken(null); toast('Drive scollegato.'); });
  };
  const showToken = () => act(async () => setToken((await api.post('/drive/token')).token));

  if (!st) return <Spinner />;
  return (
    <div className="stack">
      <div className="card card-pad">
        <h3>Archivio nel Google Drive dell'amministratore</h3>
        <p className="small muted">
          Tutto l'archivio viene copiato automaticamente in una cartella del tuo Google Drive, <b>{st.folderName}</b>, pochi secondi dopo ogni modifica:
          calendari settimanali e mensili in Excel, registro delle richieste, allegati dei documenti pubblicati e copia completa del database
          (una aggiornata di continuo più una al giorno per 30 giorni). Le bozze non pubblicate non vengono copiate.
          L'app può vedere solo i file che crea lei, non il resto del tuo Drive.
        </p>
        {!st.configured && !st.connected && (
          <div className="info-banner">
            Prima di collegare il Drive bisogna configurare sul server <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code> e <code>PUBLIC_URL</code> (vedi README, sezione "Archivio su Google Drive").
            URI di reindirizzamento da autorizzare su Google: <code>{st.redirectUri}</code>
          </div>
        )}
        {st.restore && (
          <div className={st.restore.failed ? 'lock-banner' : 'info-banner'} style={{ display: 'block' }}>{st.restore.message}</div>
        )}
        {st.connected ? (
          <>
            <div className="row" style={{ marginBottom: 10 }}>
              <span className="badge badge-ok">Collegato</span>
              {st.account && <span>Account: <b>{st.account}</b></span>}
              {st.connectedAt && <span className="small muted">dal {formatDateTime(st.connectedAt)}</span>}
              {st.fromEnv && <span className="small muted">(impostato dal server)</span>}
            </div>
            <ul className="small" style={{ paddingLeft: 18 }}>
              <li>Ultima sincronizzazione: <b>{st.running ? 'in corso…' : (st.lastSync ? formatDateTime(st.lastSync) : 'non ancora eseguita')}</b></li>
              <li>Calendari settimanali: {st.counts.weeks} · mensili: {st.counts.months} · registro richieste: {st.counts.requests ? 'sì' : 'no'}</li>
              <li>Allegati archiviati: {st.counts.attachments} · copie giornaliere del database: {st.counts.dailyBackups}{st.dbAt ? ` (ultima ${formatDateTime(st.dbAt)})` : ''}</li>
            </ul>
            {st.lastError && <div className="error-box">{st.lastError}</div>}
            <div className="row">
              {st.folderUrl && <a className="btn btn-secondary" href={st.folderUrl} target="_blank" rel="noreferrer">Apri la cartella nel Drive</a>}
              <button type="button" className="btn btn-primary" onClick={syncNow} disabled={busy}>{busy ? 'Sincronizzazione…' : 'Sincronizza ora'}</button>
              {!st.fromEnv && <button type="button" className="btn btn-ghost" onClick={disconnect} disabled={busy}>Scollega</button>}
            </div>
          </>
        ) : (
          <button type="button" className="btn btn-primary btn-lg" onClick={connect} disabled={busy || !st.configured}>
            Collega il Google Drive dell'amministratore
          </button>
        )}
      </div>
      {st.connected && !st.fromEnv && (
        <div className="card card-pad">
          <h3>Ripristino automatico (consigliato)</h3>
          <p className="small muted">
            Se l'app gira su un servizio senza disco permanente, a ogni riavvio può ripartire dall'ultima copia sul Drive.
            Per attivarlo, copia questo codice nella variabile <code>GOOGLE_REFRESH_TOKEN</code> del server. È una chiave di accesso: non condividerla.
          </p>
          {token ? (
            <textarea className="input" readOnly rows={3} value={token} onFocus={(e) => e.target.select()} style={{ fontFamily: 'monospace' }} />
          ) : (
            <button type="button" className="btn" onClick={showToken} disabled={busy}>Mostra il codice</button>
          )}
        </div>
      )}
    </div>
  );
}
