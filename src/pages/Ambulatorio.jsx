import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useApp, useEvent } from '../context.js';
import { Icon, Modal, StateBadges, LockBadge, Spinner } from '../components/ui.jsx';
import { useDraftEditor, toForm } from '../components/useDraftEditor.js';
import { EditorStatus, EditorFooter } from '../components/EditorParts.jsx';
import {
  addDays, mondayOf, todayISO, weekDays, weekLabel, weekKey, DAYS_LONG, formatDate, weekdayIndex, formatDateTime, MONTHS,
} from '@shared/dates.js';

function initialMonday() {
  const t = todayISO();
  return weekdayIndex(t) === 6 ? addDays(t, 1) : mondayOf(t);
}

export default function Ambulatorio() {
  const { isAdmin, doctors, directory, toast, confirm, user } = useApp();
  const [monday, setMonday] = useState(initialMonday);
  const [items, setItems] = useState(null);
  const [lockedWeeks, setLockedWeeks] = useState(() => new Map());
  const [view, setView] = useState(() => (window.innerWidth < 640 ? 'table' : 'calendar'));
  const [fDoctor, setFDoctor] = useState('');
  const [fOperator, setFOperator] = useState('');
  const [fDocs, setFDocs] = useState('');
  const [editing, setEditing] = useState(null);
  const [error, setError] = useState('');
  const saturday = addDays(monday, 5);
  const days = weekDays(monday);
  const today = todayISO();

  const load = useCallback(async () => {
    try {
      const [apps, locks] = await Promise.all([
        api.get(`/appointments?from=${monday}&to=${saturday}`),
        api.get(`/weeks/locks?from=${monday}&to=${saturday}`),
      ]);
      setItems(apps);
      setLockedWeeks((prev) => {
        const m = new Map(prev);
        m.delete(monday);
        for (const l of locks) m.set(l.weekStart, l);
        return m;
      });
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, [monday, saturday]);

  useEffect(() => { setItems(null); load(); }, [load]);
  useEvent(['appointments:changed', 'lock', 'week-lock', 'deleted'], (evt) => {
    if ((evt.type === 'lock' || evt.type === 'deleted') && evt.kind !== 'appointment') return;
    if (evt.type === 'week-lock') {
      setLockedWeeks((prev) => {
        const m = new Map(prev);
        if (evt.locked) m.set(evt.weekStart, { weekStart: evt.weekStart });
        else m.delete(evt.weekStart);
        return m;
      });
    }
    load();
  });

  const isWeekLocked = useCallback((day) => !!day && lockedWeeks.has(mondayOf(day)), [lockedWeeks]);
  const weekLock = lockedWeeks.get(monday);
  const weekLocked = !!weekLock;
  const canCreate = isAdmin || !weekLocked;

  const view_ = (it) => it.draft || it.published || {};
  const filtered = useMemo(() => (items || [])
    .filter((it) => {
      const d = view_(it);
      if (fDoctor && String(d.doctor_id) !== fDoctor) return false;
      if (fOperator && String(d.operator_id) !== fOperator) return false;
      if (fDocs === 'yes' && !d.docs_checked) return false;
      if (fDocs === 'no' && d.docs_checked) return false;
      return true;
    })
    .sort((a, b) => `${view_(a).day} ${view_(a).time}`.localeCompare(`${view_(b).day} ${view_(b).time}`)), [items, fDoctor, fOperator, fDocs]);

  const byDay = useMemo(() => {
    const m = new Map(days.map((d) => [d, []]));
    const undated = [];
    for (const it of filtered) {
      const d = view_(it).day;
      if (m.has(d)) m.get(d).push(it);
      else if (!d) undated.push(it);
    }
    return { m, undated };
  }, [filtered, days]);

  const toggleWeekLock = async () => {
    if (!weekLocked) {
      const ok = await confirm({
        title: 'Bloccare la settimana?',
        message: `${weekLabel(monday)}\n\nGli operatori non potranno più inserire o modificare appuntamenti di questa settimana. Chi sta modificando verrà interrotto.`,
        confirmLabel: 'Blocca settimana',
        danger: true,
      });
      if (!ok) return;
    }
    try {
      await api.post(`/weeks/${monday}/lock`, { locked: !weekLocked });
      toast(weekLocked ? 'Settimana sbloccata.' : 'Settimana BLOCCATA.', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const exportWeek = async () => {
    try {
      const name = await api.download(`/export/week?week=${weekKey(monday)}`);
      toast(`Scaricato ${name}`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  // Mese "principale" della settimana (quello del giovedì).
  const weekMonth = addDays(monday, 3).slice(0, 7);
  const sendMonthEmail = async () => {
    const [y, m] = weekMonth.split('-').map(Number);
    const ok = await confirm({
      title: 'Inviare il calendario per email?',
      message: `Verrà inviato il calendario Excel di ${MONTHS[m - 1]} ${y} all'indirizzo impostato in Amministrazione → Backup e invio email.`,
      confirmLabel: 'Invia',
    });
    if (!ok) return;
    try {
      const r = await api.post('/mail/send', { month: weekMonth });
      toast(`Inviato ${r.filename} a ${r.to.join(', ')}.`, 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const openNew = (day) => {
    if (!canCreate) return;
    setEditing({ item: null, day: day || (days.includes(today) ? today : monday) });
  };

  const activeDoctors = doctors.filter((d) => d.active);

  return (
    <>
      <div className="page-head">
        <h1>Ambulatorio</h1>
        <span className="spacer" />
        {isAdmin && (
          <>
            <button type="button" className={`btn ${weekLocked ? '' : 'btn-danger'}`} onClick={toggleWeekLock}>
              <Icon name={weekLocked ? 'unlock' : 'lock'} /> {weekLocked ? 'Sblocca settimana' : 'Blocca settimana'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={exportWeek}>
              <Icon name="download" /> Excel settimana
            </button>
            <button type="button" className="btn" onClick={sendMonthEmail}>Invia mese per email</button>
          </>
        )}
        <button type="button" className="btn btn-primary" onClick={() => openNew()} disabled={!canCreate}>
          <Icon name="plus" /> Nuovo appuntamento
        </button>
      </div>

      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between' }}>
        <div className="week-nav">
          <button type="button" className="btn btn-icon" onClick={() => setMonday(addDays(monday, -7))} aria-label="Settimana precedente"><Icon name="left" /></button>
          <button type="button" className="btn" onClick={() => setMonday(initialMonday())}>Oggi</button>
          <button type="button" className="btn btn-icon" onClick={() => setMonday(addDays(monday, 7))} aria-label="Settimana successiva"><Icon name="right" /></button>
          <span className="week-title">{weekLabel(monday)}</span>
        </div>
        <div className="seg" role="group" aria-label="Vista">
          <button type="button" className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendario</button>
          <button type="button" className={view === 'table' ? 'active' : ''} onClick={() => setView('table')}>Tabella</button>
        </div>
      </div>

      {weekLocked && (
        <div className="lock-banner" role="status">
          <LockBadge />
          <span>
            {isAdmin
              ? `Settimana bloccata${weekLock.lockedByName ? ` da ${weekLock.lockedByName} il ${formatDateTime(weekLock.lockedAt)}` : ''}. Gli operatori la vedono in sola lettura.`
              : 'Questa settimana è in sola lettura: non è possibile inserire o modificare appuntamenti.'}
          </span>
        </div>
      )}

      <div className="filters">
        <div className="field">
          <label htmlFor="f-doc">Medico</label>
          <select id="f-doc" className="input" value={fDoctor} onChange={(e) => setFDoctor(e.target.value)}>
            <option value="">Tutti i medici</option>
            {doctors.map((d) => <option key={d.id} value={d.id}>{d.name}{d.active ? '' : ' (non attivo)'}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-op">Operatrice</label>
          <select id="f-op" className="input" value={fOperator} onChange={(e) => setFOperator(e.target.value)}>
            <option value="">Tutte</option>
            {directory.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-docs">Documenti controllati</label>
          <select id="f-docs" className="input" value={fDocs} onChange={(e) => setFDocs(e.target.value)}>
            <option value="">Tutti</option>
            <option value="yes">✓ Controllati</option>
            <option value="no">Da controllare</option>
          </select>
        </div>
      </div>

      {error && <div className="error-box">{error}</div>}
      {!items ? <Spinner /> : view === 'calendar' ? (
        <>
          <div className="week-grid">
            {days.map((d, i) => {
              const list = byDay.m.get(d) || [];
              return (
                <section key={d} className={`day-col ${d === today ? 'today' : ''}`} aria-label={`${DAYS_LONG[i]} ${formatDate(d)}`}>
                  <div className="day-head">
                    <span className="d-name">{DAYS_LONG[i]}</span>
                    <span className="d-date">{formatDate(d, { year: false })}</span>
                    <span className="badge count">{list.length}</span>
                    {canCreate && (
                      <button type="button" className="btn btn-ghost btn-sm btn-icon" onClick={() => openNew(d)} aria-label={`Nuovo appuntamento ${DAYS_LONG[i]}`}>
                        <Icon name="plus" size={16} />
                      </button>
                    )}
                  </div>
                  <div className="day-body">
                    {list.length === 0 && <span className="small muted" style={{ padding: 4 }}>Nessun appuntamento</span>}
                    {list.map((it) => <ApptCard key={it.id} it={it} weekLocked={weekLocked} onOpen={() => setEditing({ item: it })} />)}
                  </div>
                </section>
              );
            })}
          </div>
          {byDay.undated.length > 0 && (
            <div className="card card-pad" style={{ marginTop: 14 }}>
              <h3>Bozze senza giorno</h3>
              <div className="stack">
                {byDay.undated.map((it) => <ApptCard key={it.id} it={it} weekLocked={false} onOpen={() => setEditing({ item: it })} />)}
              </div>
            </div>
          )}
        </>
      ) : (
        <WeekTable items={filtered} weekLocked={weekLocked} onOpen={(it) => setEditing({ item: it })} />
      )}

      {editing && (
        <AppointmentEditor
          item={editing.item}
          defaultDay={editing.day}
          defaultOperator={user.id}
          doctors={doctors}
          activeDoctors={activeDoctors}
          directory={directory}
          isWeekLocked={isWeekLocked}
          onClose={(changed) => { setEditing(null); if (changed) load(); }}
        />
      )}
    </>
  );
}

function ApptCard({ it, weekLocked, onOpen }) {
  const d = it.draft || it.published || {};
  const locked = it.locked || it.weekLocked || weekLocked;
  return (
    <button type="button" className={`appt ${it.draft ? 'draft' : ''} ${locked ? 'locked' : ''}`} onClick={onOpen}>
      <span className="row" style={{ gap: 6 }}>
        <span className="a-time">{d.time || '--:--'}</span>
        {d.docs_checked ? <span className="docs-ok" title="Documenti controllati">✓ doc</span> : <span className="docs-no small" title="Documenti da controllare">doc ✗</span>}
      </span>
      <span className="a-client">{d.client || <span className="muted">(cliente?)</span>}</span>
      <span className="a-meta">{d.doctor_name || 'medico?'} · {d.operator_name || 'operatrice?'}</span>
      {(locked || it.draft) && <StateBadges item={{ ...it, weekLocked: it.weekLocked || weekLocked }} />}
    </button>
  );
}

function WeekTable({ items, weekLocked, onOpen }) {
  if (!items.length) return <div className="card empty">Nessun appuntamento in questa settimana.</div>;
  return (
    <div className="card table-wrap">
      <table className="table responsive">
        <thead>
          <tr>
            <th>Operatrice</th><th>Medico</th><th>Giorno</th><th>Orario</th><th>Cliente</th><th>Documenti controllati</th><th>Note</th><th>Stato</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => {
            const d = it.draft || it.published || {};
            const locked = it.locked || it.weekLocked || weekLocked;
            return (
              <tr key={it.id} className={`clickable ${it.draft ? 'is-draft' : ''} ${locked ? 'is-locked' : ''}`} onClick={() => onOpen(it)}
                tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpen(it); }}>
                <td data-label="Operatrice">{d.operator_name || '—'}</td>
                <td data-label="Medico">{d.doctor_name || '—'}</td>
                <td data-label="Giorno">{d.day ? formatDate(d.day, { weekday: true }) : '—'}</td>
                <td data-label="Orario"><b>{d.time || '—'}</b></td>
                <td data-label="Cliente">{d.client || '—'}</td>
                <td data-label="Documenti controllati">{d.docs_checked ? <span className="docs-ok">✓</span> : <span className="docs-no">✗</span>}</td>
                <td data-label="Note" style={{ maxWidth: 280, whiteSpace: 'pre-wrap' }}>{d.notes || ''}</td>
                <td data-label="Stato"><StateBadges item={{ ...it, weekLocked: it.weekLocked || weekLocked }} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function AppointmentEditor({ item, defaultDay, defaultOperator, doctors, activeDoctors, directory, isWeekLocked, onClose }) {
  const ed = useDraftEditor({
    kind: 'appointment',
    item,
    initialData: item
      ? toForm('appointment', item.draft || item.published)
      : toForm('appointment', { operator_id: defaultOperator, day: defaultDay, time: '' }),
    onClose,
    isWeekLocked,
  });
  const { form, setForm, readOnly, current } = ed;
  const sunday = form.day && weekdayIndex(form.day) === 6;
  const operators = directory.filter((u) => u.active || u.id === Number(form.operator_id));
  const doctorOptions = doctors.filter((d) => d.active || d.id === Number(form.doctor_id));

  return (
    <Modal
      title={current ? `Appuntamento #${current.id}` : 'Nuovo appuntamento'}
      badge={<StateBadges item={current ? { ...current, weekLocked: current.weekLocked || isWeekLocked(current.published?.day) } : null} />}
      onClose={ed.requestClose}
      footer={<EditorFooter ed={ed} />}
    >
      <EditorStatus ed={ed} kindLabel="appuntamento" />
      <div className="grid-2">
        <div className="field">
          <label htmlFor="a-op">1. Operatrice che prende l'appuntamento *</label>
          <select id="a-op" className="input" value={form.operator_id} onChange={(e) => setForm({ operator_id: Number(e.target.value) || '' })} disabled={readOnly}>
            <option value="">— scegli —</option>
            {operators.map((u) => <option key={u.id} value={u.id}>{u.displayName}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="a-doc">2. Medico *</label>
          <select id="a-doc" className="input" value={form.doctor_id} onChange={(e) => setForm({ doctor_id: Number(e.target.value) || '' })} disabled={readOnly}>
            <option value="">— scegli —</option>
            {doctorOptions.map((d) => <option key={d.id} value={d.id}>{d.name}{d.specialty ? ` · ${d.specialty}` : ''}{d.active ? '' : ' (non attivo)'}</option>)}
          </select>
          {activeDoctors.length === 0 && <span className="hint">Nessun medico in elenco: l'amministratore deve aggiungerli in Amministrazione → Medici.</span>}
        </div>
        <div className="field">
          <label htmlFor="a-day">3. Giorno *</label>
          <input id="a-day" className="input" type="date" value={form.day} onChange={(e) => setForm({ day: e.target.value })} disabled={readOnly} />
          {sunday && <span className="hint" style={{ color: 'var(--red)' }}>L'ambulatorio è aperto dal lunedì al sabato.</span>}
          {!readOnly && !ed.isAdmin && form.day && isWeekLocked(form.day) && (
            <span className="hint" style={{ color: 'var(--red)' }}>La settimana scelta è BLOCCATA DAL CAPO.</span>
          )}
        </div>
        <div className="field">
          <label htmlFor="a-time">4. Orario *</label>
          <input id="a-time" className="input" type="time" step={300} value={form.time} onChange={(e) => setForm({ time: e.target.value })} disabled={readOnly} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="a-client">5. Cliente *</label>
        <input id="a-client" className="input" value={form.client} onChange={(e) => setForm({ client: e.target.value })} disabled={readOnly} maxLength={200} />
      </div>
      <div className="field">
        <span className="label">6. Documenti controllati</span>
        <label className="check">
          <input type="checkbox" checked={form.docs_checked} onChange={(e) => setForm({ docs_checked: e.target.checked })} disabled={readOnly} />
          {form.docs_checked ? <span className="docs-ok">✓ Documenti controllati</span> : <span>Da controllare</span>}
        </label>
      </div>
      <div className="field">
        <label htmlFor="a-notes">7. Note</label>
        <textarea id="a-notes" className="input" rows={3} value={form.notes} onChange={(e) => setForm({ notes: e.target.value })} disabled={readOnly} />
      </div>
    </Modal>
  );
}
