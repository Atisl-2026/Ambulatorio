import { useCallback, useEffect, useState } from 'react';
import { api, basePath, openFile } from '../api.js';
import { useApp, useEvent } from '../context.js';
import { Icon, Modal, Spinner, LockBadge, StateBadges } from '../components/ui.jsx';
import { VersionList, FIELD_LABELS, fieldValue } from '../components/History.jsx';
import { formatDate, formatDateTime, weekLabel, addDays } from '@shared/dates.js';

export default function Archive() {
  const [tab, setTab] = useState('items');
  return (
    <>
      <div className="page-head">
        <h1>Archivio</h1>
      </div>
      <p className="muted small" style={{ marginTop: -8 }}>
        Ogni richiesta, documento, appuntamento e calendario settimanale pubblicato è conservato qui con la cronologia completa delle modifiche.
      </p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'items'} className={tab === 'items' ? 'active' : ''} onClick={() => setTab('items')}>Documenti e appuntamenti</button>
        <button type="button" role="tab" aria-selected={tab === 'weeks'} className={tab === 'weeks' ? 'active' : ''} onClick={() => setTab('weeks')}>Calendari settimanali</button>
      </div>
      {tab === 'items' ? <ItemSearch /> : <WeekArchive />}
    </>
  );
}

const EMPTY = { q: '', client: '', doctor: '', operator: '', from: '', to: '', kind: '' };

function ItemSearch() {
  const { doctors, directory } = useApp();
  const [f, setF] = useState(EMPTY);
  const [applied, setApplied] = useState(EMPTY);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);

  const load = useCallback(async () => {
    try {
      const qs = new URLSearchParams(Object.entries(applied).filter(([, v]) => v)).toString();
      setData(await api.get(`/archive/search?${qs}`));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [applied]);
  useEffect(() => { load(); }, [load]);
  useEvent(['requests:changed', 'appointments:changed', 'deleted', 'lock'], () => load());

  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));
  const submit = (e) => { e.preventDefault(); setApplied(f); };

  return (
    <>
      <form className="card card-pad" onSubmit={submit} style={{ marginBottom: 16 }}>
        <div className="grid-3">
          <div className="field"><label htmlFor="s-q">Testo</label><input id="s-q" className="input" type="search" value={f.q} onChange={set('q')} placeholder="Parole nel titolo, descrizione, note…" /></div>
          <div className="field"><label htmlFor="s-c">Cliente</label><input id="s-c" className="input" value={f.client} onChange={set('client')} /></div>
          <div className="field">
            <label htmlFor="s-k">Tipo</label>
            <select id="s-k" className="input" value={f.kind} onChange={set('kind')}>
              <option value="">Tutti</option><option value="request">Richieste / documenti</option><option value="appointment">Appuntamenti</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-d">Medico</label>
            <select id="s-d" className="input" value={f.doctor} onChange={set('doctor')}>
              <option value="">Tutti</option>
              {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor="s-o">Operatore</label>
            <select id="s-o" className="input" value={f.operator} onChange={set('operator')}>
              <option value="">Tutti</option>
              {directory.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
            </select>
          </div>
          <div className="grid-2" style={{ gap: '0 10px' }}>
            <div className="field"><label htmlFor="s-f">Dal</label><input id="s-f" className="input" type="date" value={f.from} onChange={set('from')} /></div>
            <div className="field"><label htmlFor="s-t">Al</label><input id="s-t" className="input" type="date" value={f.to} onChange={set('to')} /></div>
          </div>
        </div>
        <div className="row">
          <button type="submit" className="btn btn-primary"><Icon name="search" /> Cerca</button>
          <button type="button" className="btn btn-ghost" onClick={() => { setF(EMPTY); setApplied(EMPTY); }}>Azzera filtri</button>
        </div>
      </form>
      {error && <div className="error-box">{error}</div>}
      {!data ? <Spinner /> : (
        <div className="card table-wrap">
          <div className="card-pad small muted" style={{ paddingBottom: 0 }}>
            {data.total} risultati{data.total > data.results.length ? ` (mostrati i primi ${data.results.length})` : ''}
          </div>
          {data.results.length === 0 ? <div className="empty">Nessun elemento trovato.</div> : (
            <table className="table responsive">
              <thead><tr><th>Tipo</th><th>Data</th><th>Elemento</th><th>Cliente</th><th>Ultima modifica</th><th /></tr></thead>
              <tbody>
                {data.results.map((r) => (
                  <tr key={`${r.kind}-${r.id}`} className="clickable" onClick={() => setOpen(r)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(r); }}>
                    <td data-label="Tipo"><span className="badge">{r.kind === 'request' ? 'Richiesta' : 'Appuntamento'}</span></td>
                    <td data-label="Data">{formatDate(r.date)}{r.time ? ` ${r.time}` : ''}</td>
                    <td data-label="Elemento"><b>{r.title}</b><div className="small muted">{r.subtitle}</div></td>
                    <td data-label="Cliente">{r.client}</td>
                    <td data-label="Ultima modifica" className="small">{r.updatedByName}<br /><span className="muted">{formatDateTime(r.updatedAt)}</span></td>
                    <td>{r.locked && <LockBadge />}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
      {open && <ArchiveDetail kind={open.kind} id={open.id} onClose={() => setOpen(null)} />}
    </>
  );
}

function ArchiveDetail({ kind, id, onClose }) {
  const { isAdmin, confirm, toast } = useApp();
  const [item, setItem] = useState(null);
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      const [it, vs] = await Promise.all([api.get(`${basePath(kind)}/${id}`), api.get(`${basePath(kind)}/${id}/versions`)]);
      setItem(it);
      setVersions(vs);
    } catch (err) {
      setError(err.message);
    }
  }, [kind, id]);
  useEffect(() => { load(); }, [load]);
  useEvent(['deleted', 'lock', kind === 'request' ? 'requests:changed' : 'appointments:changed'], (evt) => {
    if (evt.type === 'deleted' && evt.kind === kind && evt.id === id) { onClose(); return; }
    load();
  });

  const remove = async () => {
    const ok = await confirm({
      title: 'Eliminare definitivamente?',
      message: `${kind === 'request' ? 'La richiesta' : 'L\'appuntamento'} #${id} e tutta la sua cronologia verranno eliminati per sempre. L'operazione non è reversibile.`,
      confirmLabel: 'Elimina definitivamente',
      danger: true,
      requireText: 'ELIMINA',
    });
    if (!ok) return;
    try {
      await api.del(`${basePath(kind)}/${id}`);
      toast('Elemento eliminato definitivamente.');
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const data = item?.published;
  return (
    <Modal
      title={`${kind === 'request' ? 'Richiesta' : 'Appuntamento'} #${id}`}
      badge={item && <StateBadges item={{ ...item, draft: null }} />}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          {isAdmin && item && <button type="button" className="btn btn-danger" onClick={remove}><Icon name="trash" /> Elimina definitivamente</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Chiudi</button>
        </>
      )}
    >
      {error && <div className="error-box">{error}</div>}
      {!item && !error && <Spinner />}
      {data && (
        <>
          <h3>Versione attuale</h3>
          <p className="small muted">
            Creato da {item.authorName} il {formatDateTime(item.createdAt)} · ultima modifica di {item.updatedByName} il {formatDateTime(item.updatedAt)}
          </p>
          <dl className="kv card card-pad" style={{ marginBottom: 20 }}>
            {FIELD_LABELS[kind].map(([k, label]) => (
              <div key={k} style={{ display: 'contents' }}>
                <dt>{label}</dt>
                <dd>
                  {k === 'attachments' && data.attachments.length
                    ? data.attachments.map((a) => (
                      <div key={a.id}>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => openFile(a).catch((e) => toast(e.message, 'error'))}>{a.name}</button>
                      </div>
                    ))
                    : fieldValue(k, data[k])}
                </dd>
              </div>
            ))}
          </dl>
          <h3>Cronologia delle versioni</h3>
          {versions ? <VersionList versions={versions} /> : <Spinner />}
        </>
      )}
    </Modal>
  );
}

function WeekArchive() {
  const [weeks, setWeeks] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setWeeks(await api.get('/archive/weeks')); setError(''); } catch (err) { setError(err.message); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEvent(['appointments:changed', 'week-lock', 'deleted'], () => load());

  if (error) return <div className="error-box">{error}</div>;
  if (!weeks) return <Spinner />;
  if (!weeks.length) return <div className="card empty">Nessun calendario settimanale archiviato.</div>;
  return (
    <>
      <div className="card table-wrap">
        <table className="table responsive">
          <thead><tr><th>Settimana</th><th>Appuntamenti</th><th>Documenti controllati</th><th>Medici</th><th>Ultimo aggiornamento</th><th /></tr></thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart} className="clickable" onClick={() => setOpen(w.weekStart)} tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpen(w.weekStart); }}>
                <td data-label="Settimana"><b>{w.weekKey}</b><div className="small muted">{weekLabel(w.weekStart)}</div></td>
                <td data-label="Appuntamenti">{w.count}</td>
                <td data-label="Documenti controllati">{w.docsChecked} / {w.count}</td>
                <td data-label="Medici">{w.doctors}</td>
                <td data-label="Ultimo aggiornamento" className="small">{formatDateTime(w.lastUpdate) || '—'}</td>
                <td>{w.locked && <LockBadge />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <WeekDetail weekStart={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function WeekDetail({ weekStart, onClose }) {
  const { isAdmin, confirm, toast } = useApp();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await api.get(`/archive/weeks/${weekStart}`)); } catch (err) { setError(err.message); }
  }, [weekStart]);
  useEffect(() => { load(); }, [load]);
  useEvent(['appointments:changed', 'week-lock'], () => load());

  const remove = async () => {
    const ok = await confirm({
      title: 'Eliminare il calendario della settimana?',
      message: `${weekLabel(weekStart)}\n\nTutti gli appuntamenti della settimana (${data.appointments.length}) e la loro cronologia verranno eliminati per sempre.`,
      confirmLabel: 'Elimina definitivamente',
      danger: true,
      requireText: 'ELIMINA',
    });
    if (!ok) return;
    try {
      await api.del(`/archive/weeks/${weekStart}`);
      toast('Calendario settimanale eliminato.');
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  return (
    <Modal
      title={weekLabel(weekStart)}
      badge={data?.locked && <LockBadge />}
      onClose={onClose}
      size="wide"
      footer={(
        <>
          {isAdmin && data && <button type="button" className="btn btn-danger" onClick={remove}><Icon name="trash" /> Elimina calendario</button>}
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Chiudi</button>
        </>
      )}
    >
      {error && <div className="error-box">{error}</div>}
      {!data ? !error && <Spinner /> : (
        <>
          <p className="small muted">Dal {formatDate(weekStart)} al {formatDate(addDays(weekStart, 5))} · sola consultazione</p>
          {data.appointments.length === 0 ? <p className="muted">Nessun appuntamento.</p> : (
            <div className="table-wrap" style={{ marginBottom: 20 }}>
              <table className="table responsive">
                <thead><tr><th>Operatrice</th><th>Medico</th><th>Giorno</th><th>Orario</th><th>Cliente</th><th>Documenti</th><th>Note</th></tr></thead>
                <tbody>
                  {data.appointments.map((a) => (
                    <tr key={a.id} className={a.locked ? 'is-locked' : ''}>
                      <td data-label="Operatrice">{a.operator_name}</td>
                      <td data-label="Medico">{a.doctor_name}</td>
                      <td data-label="Giorno">{formatDate(a.day, { weekday: true })}</td>
                      <td data-label="Orario"><b>{a.time}</b></td>
                      <td data-label="Cliente">{a.client}</td>
                      <td data-label="Documenti">{a.docs_checked ? <span className="docs-ok">✓</span> : <span className="docs-no">✗</span>}</td>
                      <td data-label="Note" style={{ whiteSpace: 'pre-wrap' }}>{a.notes}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <h3>Cronologia della settimana</h3>
          <VersionList versions={data.history} kindOf={(v) => v.kind} />
        </>
      )}
    </Modal>
  );
}
