import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useApp, useEvent } from '../context.js';
import { Icon, Modal, StateBadges, Spinner, RichText, fmtSize } from '../components/ui.jsx';
import { useDraftEditor, toForm } from '../components/useDraftEditor.js';
import { EditorStatus, EditorFooter } from '../components/EditorParts.jsx';
import { formatDate, todayISO } from '../../shared/dates.js';
import { norm } from '../util.js';

export default function Requests() {
  const { settings } = useApp();
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [onlyDrafts, setOnlyDrafts] = useState(false);
  const [editing, setEditing] = useState(null); // { item } | { item: null } per nuova

  const load = useCallback(async () => {
    try {
      setItems(await api.get('/requests'));
      setError('');
    } catch (err) {
      setError(err.message);
    }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEvent(['requests:changed', 'lock', 'deleted'], (evt) => {
    if (evt.type === 'lock' && evt.kind !== 'request') return;
    load();
  });

  const view = (it) => it.draft || it.published || {};
  const filtered = useMemo(() => {
    if (!items) return [];
    const t = norm(q);
    return items
      .filter((it) => {
        const d = view(it);
        if (status && d.status !== status) return false;
        if (onlyDrafts && !it.draft) return false;
        if (t && !norm(`${d.title} ${d.client} ${d.description} ${it.authorName}`).includes(t)) return false;
        return true;
      })
      .sort((a, b) => (view(b).date || b.createdAt).localeCompare(view(a).date || a.createdAt) || b.id - a.id);
  }, [items, q, status, onlyDrafts]);

  return (
    <>
      <div className="page-head">
        <h1>Richieste e documenti</h1>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={() => setEditing({ item: null })}>
          <Icon name="plus" /> Nuova richiesta
        </button>
      </div>
      <div className="filters">
        <div className="field">
          <label htmlFor="rq">Cerca</label>
          <input id="rq" className="input" type="search" placeholder="Titolo, cliente, testo…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="rs">Stato</label>
          <select id="rs" className="input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">Tutti</option>
            {settings.statuses.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <label className="check" style={{ marginBottom: 2 }}>
          <input type="checkbox" checked={onlyDrafts} onChange={(e) => setOnlyDrafts(e.target.checked)} /> Solo le mie bozze
        </label>
      </div>
      {error && <div className="error-box">{error}</div>}
      {!items ? <Spinner /> : filtered.length === 0 ? (
        <div className="card empty">Nessuna richiesta trovata.</div>
      ) : (
        <div className="req-list">
          {filtered.map((it) => {
            const d = view(it);
            const locked = it.locked;
            return (
              <button
                type="button"
                key={it.id}
                className={`card req-card ${it.draft ? 'draft' : ''} ${locked ? 'locked' : ''}`}
                onClick={() => setEditing({ item: it })}
              >
                <StateBadges item={it} />
                <h3>{d.title || <span className="muted">(senza titolo)</span>}</h3>
                <div className="row small">
                  <span className="badge">{d.status}</span>
                  {d.client && <span><b>Cliente:</b> {d.client}</span>}
                </div>
                <div className="meta">
                  {d.date ? formatDate(d.date) : 'senza data'} · autore {it.authorName}
                  {d.attachments?.length ? <> · <Icon name="paperclip" size={12} /> {d.attachments.length}</> : null}
                </div>
              </button>
            );
          })}
        </div>
      )}
      {editing && (
        <RequestEditor
          item={editing.item}
          onClose={(changed) => { setEditing(null); if (changed) load(); }}
        />
      )}
    </>
  );
}

function RequestEditor({ item, onClose }) {
  const { settings, isAdmin, toast } = useApp();
  const ed = useDraftEditor({
    kind: 'request',
    item,
    initialData: item ? toForm('request', item.draft || item.published) : toForm('request', { date: todayISO() }),
    onClose,
  });
  const { form, setForm, readOnly, current } = ed;
  const fileRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [ai, setAi] = useState(null);

  const upload = async (files) => {
    setUploading(true);
    try {
      for (const f of files) {
        const meta = await api.upload('/files', f);
        setForm((prev) => ({ attachments: [...prev.attachments, meta] }));
      }
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const summarize = async () => {
    setAi({ loading: true });
    try {
      const r = await api.post('/ai/summarize', { id: current.id });
      setAi({ text: r.text, skipped: r.skipped });
    } catch (err) {
      setAi({ error: err.message });
    }
  };

  const canAi = isAdmin && settings.aiEnabled && current?.isPublished;

  return (
    <Modal
      title={current ? `Richiesta #${current.id}` : 'Nuova richiesta'}
      badge={<StateBadges item={current} />}
      onClose={ed.requestClose}
      footer={<EditorFooter ed={ed} extra={canAi && (
        <button type="button" className="btn btn-sm" onClick={summarize} disabled={ai?.loading}>
          <Icon name="sparkle" size={16} /> Riassumi con IA
        </button>
      )} />}
    >
      <EditorStatus ed={ed} kindLabel="documento" />
      <div className="field">
        <label htmlFor="r-title">Titolo *</label>
        <input id="r-title" className="input" value={form.title} onChange={(e) => setForm({ title: e.target.value })} disabled={readOnly} maxLength={200} />
      </div>
      <div className="grid-3">
        <div className="field">
          <label htmlFor="r-client">Cliente *</label>
          <input id="r-client" className="input" value={form.client} onChange={(e) => setForm({ client: e.target.value })} disabled={readOnly} maxLength={200} />
        </div>
        <div className="field">
          <label htmlFor="r-date">Data *</label>
          <input id="r-date" className="input" type="date" value={form.date} onChange={(e) => setForm({ date: e.target.value })} disabled={readOnly} />
        </div>
        <div className="field">
          <label htmlFor="r-status">Stato</label>
          <select id="r-status" className="input" value={form.status} onChange={(e) => setForm({ status: e.target.value })} disabled={readOnly}>
            {settings.statuses.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label htmlFor="r-desc">Descrizione</label>
        <textarea id="r-desc" className="input" rows={6} value={form.description} onChange={(e) => setForm({ description: e.target.value })} disabled={readOnly} />
      </div>
      <div className="field">
        <span className="label">Allegati</span>
        {form.attachments.length > 0 ? (
          <ul className="attachments">
            {form.attachments.map((a) => (
              <li key={a.id}>
                <Icon name="paperclip" size={16} />
                <a href={`/api/files/${a.id}${/pdf|image/.test(a.mime || '') ? '?inline=1' : ''}`} target="_blank" rel="noreferrer">{a.name}</a>
                <span className="small muted">{a.size ? fmtSize(a.size) : ''}</span>
                {!readOnly && (
                  <button type="button" className="btn btn-ghost btn-sm" aria-label={`Rimuovi ${a.name}`}
                    onClick={() => setForm((p) => ({ attachments: p.attachments.filter((x) => x.id !== a.id) }))}>
                    <Icon name="close" size={16} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        ) : <span className="small muted">Nessun allegato.</span>}
        {!readOnly && (
          <div>
            <input ref={fileRef} type="file" multiple className="sr-only" id="r-files" onChange={(e) => upload([...e.target.files])} />
            <label htmlFor="r-files" className="btn btn-sm" style={{ marginTop: 6 }}>
              <Icon name="paperclip" size={16} /> {uploading ? 'Caricamento…' : 'Aggiungi allegati'}
            </label>
          </div>
        )}
      </div>
      {current && <p className="small muted">Autore: <b>{current.authorName}</b></p>}
      {ai && canAi && (
        <div className="ai-box">
          <span className="ai-tag"><Icon name="sparkle" size={12} /> Riassunto IA</span>
          {ai.loading && <div style={{ marginTop: 10 }}><Spinner label="L'assistente sta leggendo la richiesta…" /></div>}
          {ai.error && <div className="error-box" style={{ marginTop: 10 }}>{ai.error}</div>}
          {ai.text && <div className="ai-output"><RichText text={ai.text} /></div>}
          {ai.skipped?.length > 0 && <p className="small muted">Allegati non letti: {ai.skipped.join(', ')}</p>}
        </div>
      )}
    </Modal>
  );
}
