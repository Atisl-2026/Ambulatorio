import { createContext, useContext, useEffect, useRef } from 'react';

export const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

// Piccolo bus di eventi per la sincronizzazione in tempo reale.
const listeners = new Set();
export const bus = {
  emit(evt) {
    for (const l of [...listeners]) l(evt);
  },
  on(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

// Esegue handler(evt) quando arriva un evento il cui tipo è in `types`.
export function useEvent(types, handler) {
  const ref = useRef(handler);
  ref.current = handler;
  const key = types.join('|');
  useEffect(() => {
    const set = new Set(key.split('|'));
    return bus.on((evt) => {
      if (set.has(evt.type) || evt.type === 'resync') ref.current(evt);
    });
  }, [key]);
}
