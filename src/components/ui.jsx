import { useEffect, useRef, useState } from 'react';
import { logoUrl } from '../supabase.js';

const PLACEHOLDER = `${import.meta.env.BASE_URL}logo-placeholder.svg`;

// ---------- Icone (SVG inline) ----------
const paths = {
  lock: 'M7 10V7a5 5 0 0 1 10 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Zm2 0h6V7a3 3 0 0 0-6 0v3Z',
  unlock: 'M7 10V7a5 5 0 0 1 9.6-1.9l-1.8.8A3 3 0 0 0 9 7v3h9a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h1Z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6V5Z',
  close: 'M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6 10.6 12 5 6.4 6.4 5Z',
  left: 'M15.4 6.4 14 5l-7 7 7 7 1.4-1.4L9.8 12l5.6-5.6Z',
  right: 'M8.6 6.4 10 5l7 7-7 7-1.4-1.4 5.6-5.6-5.6-5.6Z',
  menu: 'M4 6h16v2H4V6Zm0 5h16v2H4v-2Zm0 5h16v2H4v-2Z',
  check: 'M9.5 16.2 5.3 12l-1.4 1.4 5.6 5.6L20.1 8.4 18.7 7 9.5 16.2Z',
  download: 'M11 4h2v8.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3V4ZM5 18h14v2H5v-2Z',
  history: 'M13 3a9 9 0 1 1-8.5 12h2.1A7 7 0 1 0 6 9.3L8.6 12H2V5.4l2.6 2.6A9 9 0 0 1 13 3Zm-1 5h2v4.6l3.4 2-1 1.7L12 13.8V8Z',
  sparkle: 'M12 2l1.8 5.2L19 9l-5.2 1.8L12 16l-1.8-5.2L5 9l5.2-1.8L12 2Zm7 12 .9 2.6 2.6.9-2.6.9L19 21l-.9-2.6-2.6-.9 2.6-.9L19 14ZM5 15l.7 1.8 1.8.7-1.8.7L5 20l-.7-1.8-1.8-.7 1.8-.7L5 15Z',
  trash: 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h2v-8h-2Zm4 0v8h2v-8h-2Z',
  paperclip: 'M16.5 6.5 9 14a1.5 1.5 0 0 0 2.1 2.1l7.1-7.1a3.5 3.5 0 0 0-5-5L5.6 11.6a5.5 5.5 0 0 0 7.8 7.8l6.4-6.4 1.4 1.4-6.4 6.4a7.5 7.5 0 1 1-10.6-10.6L11.8 2.6a5.5 5.5 0 0 1 7.8 7.8l-7.1 7.1A3.5 3.5 0 0 1 7.6 12.6L15 5.1l1.5 1.4Z',
  logout: 'M10 4H5v16h5v2H3V2h7v2Zm6.6 3.6L21 12l-4.4 4.4-1.4-1.4 2-2H9v-2h8.2l-2-2 1.4-1.4Z',
  search: 'M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3Zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
};
export function Icon({ name, size = 18, title }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      <path d={paths[name]} />
    </svg>
  );
}

// Logo caricato dal Capo (Storage pubblico); se non c'è, segnaposto incluso nell'app.
export function Logo({ className = 'header-logo', version = 0 }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [version]);
  return (
    <img
      className={className}
      src={failed ? PLACEHOLDER : logoUrl(version)}
      onError={() => setFailed(true)}
      alt="èpaca Coldiretti – Aggiungiamo valore al valore · Apulia Diagnostic"
    />
  );
}

// ---------- Badge ----------
export function LockBadge({ label = 'BLOCCATO DAL CAPO' }) {
  return (
    <span className="badge badge-locked" role="status">
      <Icon name="lock" size={13} /> {label}
    </span>
  );
}

export function StateBadges({ item }) {
  if (!item) return null;
  const locked = item.locked || item.weekLocked;
  return (
    <span className="badges">
      {locked && <LockBadge />}
      {item.draft && !item.isPublished && <span className="badge badge-draft">BOZZA · visibile solo a te</span>}
      {item.draft && item.isPublished && <span className="badge badge-draft">Modifiche in bozza</span>}
      {item.isPublished && !item.draft && <span className="badge badge-published">Pubblicato</span>}
    </span>
  );
}

// ---------- Modale ----------
export function Modal({ title, onClose, children, footer, size = '', labelledBy, badge }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <div className={`modal ${size}`} role="dialog" aria-modal="true" aria-label={labelledBy || title} tabIndex={-1} ref={ref}>
        {title && (
          <div className="modal-head">
            <h2>{title}</h2>
            {badge}
            {onClose && (
              <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Chiudi">
                <Icon name="close" />
              </button>
            )}
          </div>
        )}
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ title, message, confirmLabel = 'Conferma', danger, requireText, onConfirm, onCancel }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = !requireText || text.trim().toUpperCase() === requireText;
  return (
    <Modal
      title={title}
      onClose={onCancel}
      size="narrow"
      footer={(
        <>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel}>Annulla</button>
          <button
            type="button"
            className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`}
            disabled={!ok || busy}
            onClick={async () => { setBusy(true); try { await onConfirm(); } finally { setBusy(false); } }}
          >
            {confirmLabel}
          </button>
        </>
      )}
    >
      <p style={{ whiteSpace: 'pre-wrap' }}>{message}</p>
      {requireText && (
        <div className="field">
          <label htmlFor="confirm-text">Per confermare scrivi <b>{requireText}</b></label>
          <input id="confirm-text" className="input" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </div>
      )}
    </Modal>
  );
}

export function LockedAlert({ message, onClose }) {
  return (
    <Modal onClose={onClose} size="narrow" labelledBy="BLOCCATO DAL CAPO">
      <div className="locked-alert" role="alert">
        <div className="big-lock"><Icon name="lock" size={44} /></div>
        <h2>BLOCCATO DAL CAPO</h2>
        <p>{message || 'L\'elemento è stato bloccato dall\'amministratore: le modifiche non salvate sono state interrotte. Ora è disponibile solo in lettura.'}</p>
        <button type="button" className="btn btn-primary btn-lg" onClick={onClose} autoFocus>Ho capito</button>
      </div>
    </Modal>
  );
}

export function Toasts({ items }) {
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => <div key={t.id} className={`toast ${t.type}`}>{t.message}</div>)}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="track" />
      <span>{label}</span>
    </label>
  );
}

export function Spinner({ label = 'Caricamento…' }) {
  return <span className="row muted"><span className="spinner" /> {label}</span>;
}

// ---------- Mini-renderer Markdown (testo IA) senza HTML grezzo ----------
function inline(text, keyBase) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') && p.endsWith('**')
    ? <strong key={`${keyBase}-${i}`}>{p.slice(2, -2)}</strong>
    : p));
}
export function RichText({ text }) {
  const lines = String(text || '').split('\n');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) {
      const Tag = list.ordered ? 'ol' : 'ul';
      out.push(<Tag key={`l${out.length}`}>{list.items.map((t, i) => <li key={i}>{inline(t, i)}</li>)}</Tag>);
      list = null;
    }
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    let m;
    if ((m = /^\s*[-*•]\s+(.*)$/.exec(line))) {
      if (!list || list.ordered) { flush(); list = { ordered: false, items: [] }; }
      list.items.push(m[1]);
    } else if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      if (!list || !list.ordered) { flush(); list = { ordered: true, items: [] }; }
      list.items.push(m[1]);
    } else {
      flush();
      if ((m = /^(#{1,4})\s+(.*)$/.exec(line))) {
        const Tag = m[1].length <= 2 ? 'h3' : 'h4';
        out.push(<Tag key={i}>{inline(m[2], i)}</Tag>);
      } else if (line.trim() === '---') {
        out.push(<hr key={i} />);
      } else if (line.trim()) {
        out.push(<p key={i}>{inline(line, i)}</p>);
      }
    }
  });
  flush();
  return <div>{out}</div>;
}

export const fmtSize = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
