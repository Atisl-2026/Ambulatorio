import { useEffect, useState } from 'react';
import { api, basePath } from '../api.js';
import { Modal, Spinner } from './ui.jsx';
import { formatDate, formatDateTime } from '@shared/dates.js';

export const FIELD_LABELS = {
  request: [
    ['title', 'Titolo'], ['client', 'Cliente'], ['date', 'Data'], ['status', 'Stato'],
    ['description', 'Descrizione'], ['attachments', 'Allegati'],
  ],
  appointment: [
    ['operator_name', 'Operatrice'], ['doctor_name', 'Medico'], ['day', 'Giorno'], ['time', 'Orario'],
    ['client', 'Cliente'], ['docs_checked', 'Documenti controllati'], ['notes', 'Note'],
  ],
};

export function fieldValue(key, v) {
  if (key === 'attachments') return (v || []).map((a) => a.name).join(', ') || '—';
  if (key === 'docs_checked') return v ? '✓ Sì' : '✗ No';
  if (key === 'date' || key === 'day') return v ? formatDate(v, { weekday: key === 'day' }) : '—';
  return v === '' || v === null || v === undefined ? '—' : String(v);
}

const actionClass = (a) => (a.startsWith('Blocco') ? 'badge-locked' : a.startsWith('Sblocco') ? 'badge-ok' : a === 'Creazione' ? 'badge-published' : 'badge-admin');

export function VersionList({ versions, kindOf }) {
  if (!versions.length) return <p className="muted">Nessuna versione registrata.</p>;
  return (
    <ol className="timeline">
      {versions.map((v, i) => {
        const kind = kindOf ? kindOf(v) : v.kind;
        if (kind === 'week') {
          return (
            <li key={v.id}>
              <div className="t-head">
                <span className={`badge ${actionClass(v.action)}`}>{v.action}</span>
                <b>{v.user_name}</b><span className="muted small">{formatDateTime(v.at)}</span>
              </div>
            </li>
          );
        }
        // Versione precedente dello stesso elemento (per evidenziare le differenze).
        const prev = versions.slice(i + 1).find((x) => x.kind === v.kind && x.item_id === v.item_id);
        const fields = FIELD_LABELS[kind] || [];
        return (
          <li key={v.id}>
            <div className="t-head">
              <span className={`badge ${actionClass(v.action)}`}>{v.action}</span>
              {kindOf && <span className="badge">{kind === 'appointment' ? `Appuntamento #${v.item_id}` : `#${v.item_id}`}</span>}
              <span className="small">versione {v.version}</span>
              <b>{v.user_name}</b>
              <span className="muted small">{formatDateTime(v.at)}</span>
            </div>
            <dl className="kv">
              {fields.map(([k, label]) => {
                const val = fieldValue(k, v.data[k]);
                const changed = prev && fieldValue(k, prev.data[k]) !== val;
                return (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{label}</dt>
                    <dd><span className={changed ? 'changed' : ''} title={changed ? `Prima: ${fieldValue(k, prev.data[k])}` : undefined}>{val}</span></dd>
                  </div>
                );
              })}
            </dl>
          </li>
        );
      })}
    </ol>
  );
}

export default function History({ kind, id, onClose }) {
  const [versions, setVersions] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`${basePath(kind)}/${id}/versions`).then(setVersions).catch((e) => setError(e.message));
  }, [kind, id]);
  return (
    <Modal title={`Cronologia versioni · ${kind === 'request' ? 'Richiesta' : 'Appuntamento'} #${id}`} onClose={onClose} size="wide">
      <p className="small muted">Ogni pubblicazione, blocco e sblocco viene registrato con autore, data e ora. I campi evidenziati sono cambiati rispetto alla versione precedente.</p>
      {error && <div className="error-box">{error}</div>}
      {!versions && !error ? <Spinner /> : versions && <VersionList versions={versions} />}
    </Modal>
  );
}
