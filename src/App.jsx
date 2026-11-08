import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler } from './api.js';
import { AppContext, bus } from './context.js';
import { Icon, Logo, LockedAlert, Toasts, ConfirmDialog, Spinner } from './components/ui.jsx';
import Welcome from './pages/Welcome.jsx';
import Login, { ChangePasswordForm } from './pages/Login.jsx';
import Requests from './pages/Requests.jsx';
import Ambulatorio from './pages/Ambulatorio.jsx';
import Archive from './pages/Archive.jsx';
import Admin from './pages/Admin.jsx';
import { Modal } from './components/ui.jsx';

const PAGES = [
  { path: '/richieste', label: 'Richieste' },
  { path: '/ambulatorio', label: 'Ambulatorio' },
  { path: '/archivio', label: 'Archivio' },
  { path: '/amministrazione', label: 'Amministrazione', admin: true },
];

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback((to, { replace = false } = {}) => {
    if (to === window.location.pathname) return;
    window.history[replace ? 'replaceState' : 'pushState']({}, '', to);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();
  const [user, setUser] = useState(undefined); // undefined = verifica in corso
  const [settings, setSettings] = useState({ aiEnabled: false, statuses: [] });
  const [doctors, setDoctors] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [locked, setLocked] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [live, setLive] = useState(false);
  const [logoVersion, setLogoVersion] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const toast = useCallback((message, type = 'info') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);

  const confirm = useCallback((opts) => new Promise((resolve) => {
    setConfirmState({
      ...opts,
      onConfirm: async () => { setConfirmState(null); resolve(true); },
      onCancel: () => { setConfirmState(null); resolve(false); },
    });
  }), []);

  const showLocked = useCallback((message) => setLocked({ message }), []);

  // Verifica sessione all'avvio.
  useEffect(() => {
    api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser((u) => {
        if (u) toast('Sessione scaduta: effettua di nuovo l\'accesso.', 'error');
        return null;
      });
    });
  }, [toast]);

  const ready = user && !user.mustChangePassword;

  const loadShared = useCallback(async () => {
    const [s, d, u] = await Promise.all([api.get('/settings'), api.get('/doctors'), api.get('/users/directory')]);
    setSettings(s);
    setDoctors(d);
    setDirectory(u);
  }, []);

  useEffect(() => {
    if (ready) loadShared().catch(() => {});
  }, [ready, loadShared]);

  // Connessione in tempo reale (Server-Sent Events).
  const firstHello = useRef(true);
  useEffect(() => {
    if (!ready) return undefined;
    firstHello.current = true;
    const es = new EventSource('/api/events');
    es.onmessage = (e) => {
      let evt;
      try { evt = JSON.parse(e.data); } catch { return; }
      if (evt.type === 'hello') {
        setLive(true);
        // Dopo una riconnessione ricarichiamo tutto per non perdere eventi.
        if (!firstHello.current) bus.emit({ type: 'resync' });
        firstHello.current = false;
        return;
      }
      if (evt.type === 'session:revoked') {
        es.close();
        setLive(false);
        setUser(null);
        toast('La tua sessione è stata chiusa dall\'amministratore o è scaduta.', 'error');
        return;
      }
      if (evt.type === 'settings:changed') api.get('/settings').then(setSettings).catch(() => {});
      if (evt.type === 'doctors:changed') api.get('/doctors').then(setDoctors).catch(() => {});
      if (evt.type === 'users:changed') api.get('/users/directory').then(setDirectory).catch(() => {});
      if (evt.type === 'logo:changed') setLogoVersion((v) => v + 1);
      bus.emit(evt);
    };
    es.onerror = () => {
      setLive(false);
      // Se la sessione non è più valida EventSource continuerebbe a riprovare: verifichiamo.
      api.get('/auth/me').then((r) => { if (!r.user) { es.close(); setUser(null); } }).catch(() => {});
    };
    return () => { es.close(); setLive(false); };
  }, [ready, toast]);

  useEffect(() => {
    if (ready && user.role !== 'admin' && path.startsWith('/amministrazione')) navigate('/richieste', { replace: true });
  }, [ready, user, path, navigate]);

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* già uscito */ }
    setUser(null);
    navigate('/login');
  };

  const ctx = useMemo(() => ({
    user, settings, doctors, directory, toast, confirm, showLocked, navigate, logoVersion,
    isAdmin: user?.role === 'admin', reloadShared: loadShared,
  }), [user, settings, doctors, directory, toast, confirm, showLocked, navigate, logoVersion, loadShared]);

  let content;
  if (path === '/' || path === '') {
    content = <Welcome onEnter={() => navigate(user ? '/richieste' : '/login')} logoVersion={logoVersion} />;
  } else if (user === undefined) {
    content = <div className="welcome"><Spinner /></div>;
  } else if (!user) {
    content = (
      <Login
        logoVersion={logoVersion}
        onLogin={(u) => {
          setUser(u);
          if (path === '/login' || !PAGES.some((p) => path.startsWith(p.path))) navigate('/richieste', { replace: true });
        }}
      />
    );
  } else if (user.mustChangePassword) {
    content = (
      <div className="welcome">
        <div className="card login-card">
          <Logo className="welcome-logo" version={logoVersion} />
          <h1>Cambia la password</h1>
          <p className="muted">È il tuo primo accesso (o la password è stata reimpostata): scegli una password personale.</p>
          <ChangePasswordForm onDone={(u) => { setUser(u); navigate('/richieste', { replace: true }); }} />
          <button type="button" className="btn btn-ghost" onClick={logout} style={{ marginTop: 8 }}>Esci</button>
        </div>
      </div>
    );
  } else {
    const page = PAGES.find((p) => path.startsWith(p.path) && (!p.admin || user.role === 'admin')) || PAGES[0];
    content = (
      <>
        <header className="app-header">
          <div className="header-inner">
            <button type="button" className="header-logo-btn" onClick={() => navigate('/')} aria-label="Pagina di benvenuto">
              <Logo version={logoVersion} />
            </button>
            <nav className={`nav ${menuOpen ? 'open' : ''}`} aria-label="Sezioni">
              {PAGES.filter((p) => !p.admin || user.role === 'admin').map((p) => (
                <button
                  type="button"
                  key={p.path}
                  className={page.path === p.path ? 'active' : ''}
                  aria-current={page.path === p.path ? 'page' : undefined}
                  onClick={() => { navigate(p.path); setMenuOpen(false); }}
                >
                  {p.label}
                </button>
              ))}
            </nav>
            <div className="header-user">
              <span className={`live-dot ${live ? 'on' : ''}`} title={live ? 'Sincronizzato in tempo reale' : 'Connessione in tempo reale assente: riconnessione…'} />
              <div className="user-chip">
                <strong>{user.displayName}</strong>
                <span>{user.role === 'admin' ? 'Amministratore · il Capo' : 'Operatore'}</span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setPwOpen(true)}>Password</button>
              <button type="button" className="btn btn-ghost btn-icon" onClick={logout} title="Esci" aria-label="Esci">
                <Icon name="logout" />
              </button>
              <button type="button" className="btn btn-ghost btn-icon menu-toggle" onClick={() => setMenuOpen((o) => !o)} aria-label="Menu" aria-expanded={menuOpen}>
                <Icon name="menu" />
              </button>
            </div>
          </div>
        </header>
        <main className="main">
          {page.path === '/richieste' && <Requests />}
          {page.path === '/ambulatorio' && <Ambulatorio />}
          {page.path === '/archivio' && <Archive />}
          {page.path === '/amministrazione' && <Admin />}
        </main>
        {pwOpen && (
          <Modal title="Cambia password" onClose={() => setPwOpen(false)} size="narrow">
            <ChangePasswordForm onDone={(u) => { setUser(u); setPwOpen(false); toast('Password aggiornata.', 'success'); }} />
          </Modal>
        )}
      </>
    );
  }

  return (
    <AppContext.Provider value={ctx}>
      {content}
      {locked && <LockedAlert message={locked.message} onClose={() => setLocked(null)} />}
      {confirmState && <ConfirmDialog {...confirmState} />}
      <Toasts items={toasts} />
    </AppContext.Provider>
  );
}
