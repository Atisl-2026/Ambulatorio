import { useState } from 'react';
import { Icon, LockBadge, StateBadges } from './ui.jsx';
import { formatDateTime } from '@shared/dates.js';
import History from './History.jsx';

export function EditorStatus({ ed, kindLabel }) {
  const { current, readOnly, isAdmin } = ed;
  return (
    <>
      {readOnly && (
        <div className="lock-banner" role="alert">
          <LockBadge />
          <span>Questo {kindLabel} è in sola lettura: non può essere modificato.</span>
        </div>
      )}
      {isAdmin && current && (current.locked || current.weekLocked) && (
        <div className="lock-banner">
          <LockBadge />
          <span>
            {current.locked ? `Bloccato da ${current.lockedByName} il ${formatDateTime(current.lockedAt)}.` : 'La settimana è bloccata.'}
            {' '}Come amministratore puoi comunque modificarlo.
          </span>
        </div>
      )}
      {current?.draft?.stale && (
        <div className="info-banner">
          Attenzione: dopo la tua bozza qualcuno ha pubblicato una versione più recente. Pubblicando, la tua bozza la sostituirà.
        </div>
      )}
      {current && (
        <p className="small muted" style={{ marginTop: -4 }}>
          {current.isPublished
            ? <>Pubblicato da <b>{current.publishedByName}</b> il {formatDateTime(current.publishedAt)} · versione {current.version} · creato da {current.authorName}</>
            : <>Bozza creata da te il {formatDateTime(current.createdAt)}: non è ancora visibile agli altri.</>}
          {current.draft && <> · bozza salvata il {formatDateTime(current.draft.updatedAt)}</>}
        </p>
      )}
    </>
  );
}

export function EditorFooter({ ed, extra }) {
  const { current, readOnly, isAdmin, busy, dirty } = ed;
  const [showHistory, setShowHistory] = useState(false);
  return (
    <>
      {current?.isPublished && (
        <button type="button" className="btn btn-sm" onClick={() => setShowHistory(true)}>
          <Icon name="history" size={16} /> Cronologia
        </button>
      )}
      {isAdmin && current?.isPublished && (
        <button type="button" className={`btn btn-sm ${current.locked ? '' : 'btn-danger'}`} onClick={ed.toggleLock} disabled={busy}>
          <Icon name={current.locked ? 'unlock' : 'lock'} size={16} /> {current.locked ? 'Sblocca' : 'Blocca'}
        </button>
      )}
      {isAdmin && current?.isPublished && (
        <button type="button" className="btn btn-sm" onClick={ed.remove} disabled={busy} title="Elimina definitivamente">
          <Icon name="trash" size={16} /> Elimina
        </button>
      )}
      {extra}
      <span className="spacer" />
      {readOnly ? (
        <button type="button" className="btn" onClick={() => ed.requestClose()}>Chiudi</button>
      ) : (
        <>
          {current?.draft && <button type="button" className="btn btn-ghost" onClick={ed.discard} disabled={busy}>Scarta bozza</button>}
          <button type="button" className="btn" onClick={() => ed.requestClose()}>Annulla</button>
          <button type="button" className="btn btn-secondary" onClick={ed.saveDraft} disabled={busy || (!dirty && !!current)}>
            Salva bozza
          </button>
          <button type="button" className="btn btn-primary" onClick={ed.publish} disabled={busy || (!dirty && !current?.draft)}>
            Pubblica
          </button>
        </>
      )}
      {showHistory && <History kind={current.kind} id={current.id} onClose={() => setShowHistory(false)} />}
    </>
  );
}

export function EditorTitleBadges({ item }) {
  return <StateBadges item={item} />;
}
