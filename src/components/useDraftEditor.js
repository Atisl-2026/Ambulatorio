import { useCallback, useState } from 'react';
import { api, basePath } from '../api.js';
import { useApp, useEvent } from '../context.js';
import { mondayOf } from '../../shared/dates.js';

const EVENT = { request: 'requests:changed', appointment: 'appointments:changed' };

// Logica comune agli editor: bozza privata → Pubblica, blocchi del Capo in tempo reale.
export function useDraftEditor({ kind, item, initialData, onClose, isWeekLocked = () => false }) {
  const { isAdmin, toast, showLocked, confirm } = useApp();
  const [current, setCurrent] = useState(item || null);
  const [form, setFormState] = useState(initialData);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const base = basePath(kind);

  const origDay = kind === 'appointment'
    ? (current?.draft?.day || current?.published?.day || initialData.day || '')
    : '';
  const weekLockedNow = kind === 'appointment' && !!origDay && isWeekLocked(origDay);
  const lockedForMe = !isAdmin && !!(current?.locked || current?.weekLocked || weekLockedNow);
  const readOnly = lockedForMe;

  const setForm = useCallback((patch) => {
    setFormState((f) => ({ ...f, ...(typeof patch === 'function' ? patch(f) : patch) }));
    setDirty(true);
  }, []);

  const interrupt = useCallback(() => {
    onClose(true);
    showLocked();
  }, [onClose, showLocked]);

  const reload = useCallback(async () => {
    if (!current) return null;
    try {
      const fresh = await api.get(`${base}/${current.id}`);
      setCurrent(fresh);
      return fresh;
    } catch (err) {
      if (err.status === 404) {
        onClose(true);
        toast('L\'elemento non è più disponibile (eliminato).', 'error');
      }
      return null;
    }
  }, [base, current, onClose, toast]);

  // Eventi in tempo reale che riguardano l'elemento aperto.
  useEvent(['lock', 'week-lock', 'deleted', EVENT[kind]], async (evt) => {
    if (!current) {
      if (evt.type === 'week-lock' && evt.locked && !isAdmin && origDay && evt.weekStart === mondayOf(origDay)) interrupt();
      return;
    }
    if (evt.type === 'deleted' && evt.kind === kind && evt.id === current.id) {
      onClose(true);
      toast('L\'elemento è stato eliminato definitivamente dall\'amministratore.', 'error');
      return;
    }
    const affects = (evt.type === 'lock' && evt.kind === kind && evt.id === current.id)
      || (evt.type === 'week-lock' && kind === 'appointment' && origDay && evt.weekStart === mondayOf(origDay));
    if (affects && evt.locked && !isAdmin && !readOnly) {
      interrupt();
      return;
    }
    if (affects || evt.type === 'resync' || (evt.type === EVENT[kind] && evt.id === current.id)) {
      const fresh = await reload();
      // Se l'utente sta solo guardando, mostriamo subito la versione aggiornata.
      if (fresh && !dirty && !fresh.draft && fresh.published) setFormState(toForm(kind, fresh.published));
    }
  });

  const handleError = useCallback((err) => {
    if (err.code === 'LOCKED') interrupt();
    else toast(err.message, 'error');
  }, [interrupt, toast]);

  const run = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (err) {
      handleError(err);
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const saveDraft = () => run(async () => {
    const data = toPayload(kind, form);
    const saved = current
      ? await api.put(`${base}/${current.id}/draft`, { data })
      : await api.post(base, { data });
    setCurrent(saved);
    setDirty(false);
    toast('Bozza salvata: è visibile solo a te finché non premi "Pubblica".', 'success');
    return saved;
  });

  const publish = () => run(async () => {
    const data = toPayload(kind, form);
    const saved = current
      ? await api.post(`${base}/${current.id}/publish`, { data })
      : await api.post(`${base}/new/publish`, { data });
    setDirty(false);
    toast('Pubblicato: ora è visibile a tutti gli utenti.', 'success');
    onClose(true);
    return saved;
  });

  const discard = async () => {
    if (!current?.draft) return;
    const ok = await confirm({
      title: 'Scartare la bozza?',
      message: current.isPublished
        ? 'Le modifiche non pubblicate andranno perse. Resterà la versione pubblicata.'
        : 'La bozza non è mai stata pubblicata e verrà eliminata.',
      confirmLabel: 'Scarta bozza',
      danger: true,
    });
    if (!ok) return;
    await run(async () => {
      const r = await api.del(`${base}/${current.id}/draft`);
      toast('Bozza scartata.');
      if (r.deleted) onClose(true);
      else {
        const fresh = await reload();
        if (fresh?.published) setFormState(toForm(kind, fresh.published));
        setDirty(false);
      }
    });
  };

  const toggleLock = () => run(async () => {
    const fresh = await api.post(`${base}/${current.id}/lock`, { locked: !current.locked });
    setCurrent(fresh);
    toast(fresh.locked ? 'Elemento BLOCCATO: gli operatori lo vedono in sola lettura.' : 'Elemento sbloccato.', 'success');
  });

  const remove = async () => {
    const ok = await confirm({
      title: 'Eliminare definitivamente?',
      message: 'L\'elemento e tutta la sua cronologia verranno eliminati per sempre, per tutti gli utenti. L\'operazione non è reversibile.',
      confirmLabel: 'Elimina definitivamente',
      danger: true,
      requireText: 'ELIMINA',
    });
    if (!ok) return;
    await run(async () => {
      await api.del(`${base}/${current.id}`);
      toast('Elemento eliminato definitivamente.');
      onClose(true);
    });
  };

  const requestClose = async () => {
    if (dirty && !readOnly) {
      const ok = await confirm({
        title: 'Chiudere senza salvare?',
        message: 'Hai modifiche non salvate. Se chiudi andranno perse.',
        confirmLabel: 'Chiudi senza salvare',
        danger: true,
      });
      if (!ok) return;
    }
    onClose(false);
  };

  return {
    current, form, setForm, dirty, busy, readOnly, lockedForMe, isAdmin,
    saveDraft, publish, discard, toggleLock, remove, requestClose, setCurrent,
  };
}

export function toForm(kind, data) {
  if (kind === 'request') {
    return {
      title: data?.title || '', description: data?.description || '', client: data?.client || '',
      date: data?.date || '', status: data?.status || 'Nuova', attachments: data?.attachments || [],
    };
  }
  return {
    operator_id: data?.operator_id || '', doctor_id: data?.doctor_id || '', day: data?.day || '', time: data?.time || '',
    client: data?.client || '', docs_checked: !!data?.docs_checked, notes: data?.notes || '',
  };
}

function toPayload(kind, form) {
  if (kind === 'request') return { ...form, attachments: form.attachments.map((a) => a.id) };
  return { ...form, operator_id: form.operator_id || null, doctor_id: form.doctor_id || null };
}
