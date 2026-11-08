import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUnauthorizedHandler, currentUser, logout as apiLogout, setupStatus } from './api.js';
import { supabase, SUPABASE_URL } from './supabase.js';
import { AppContext, bus } from './context.js';
import { Icon, Logo, LockedAlert, Toasts, ConfirmDialog, Spinner, Modal } from './components/ui.jsx';
import Welcome from './pages/Welcome.jsx';
import Login, { ChangePasswordForm, FirstAdminForm } from './pages/Login.jsx';
import Requests from './pages/Requests.jsx';
import Ambulatorio from './pages/Ambulatorio.jsx';
import Archive from './pages/Archive.jsx';
import Admin from './pages/Admin.jsx';

const PAGES = [
  { path: '/richieste', label: 'Richieste' },
  { path: '/ambulatorio', label: 'Ambulatorio' },
  { path: '/archivio', label: 'Archivio' },
  { path: '/amministrazione', label: 'Amministrazione', admin: true },
];
const IDLE_MS = 2 * 60 * 60 * 1000; // uscita automatica dopo 2 ore di inattività

// Navigazione con "#/percorso": funziona su GitHub Pages e nelle app installate.
const readPath = () => (window.location.hash.replace(/^#/, '').split('?')[0]) || '/';
function usePath() {
  const [path, setPath] = useState(readPath);
  useEffect(() => {
    const on = () => setPath(readPath());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const navigate = useCallback((to, { replace = false } = {}) => {
    if (to === readPath()) return;
    if (replace) window.history.replaceState({}, '', `#${to}`);
    else window.history.pushState({}, '', `#${to}`);
    setPath(to);
    window.scrollTo(0, 0);
  }, []);
  return [path, navigate];
}

export default function App() {
  const [path, navigate] = usePath();
  const [user, setUser] = useState(undefined); // undefined = verifica in corso
  const [needsSetup, setNeedsSetup] = useState(false);
  const [settings, setSettings] = useState({ aiEnabled: false, statuses: [] });
  const [doctors, setDoctors] = useState([]);
  const [directory, setDirectory] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [locked, setLocked] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [live, setLive] = useState(false);
  const [logoVersion, setLogoVersion] = useState(() => Date.now());
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

  // Verifica sessione all'avvio (e se serve creare il primo amministratore).
  useEffect(() => {
    currentUser().then(async (u) => {
      setUser(u);
      if (!u) setNeedsSetup(await setupStatus().then((s) => s.needsSetup, () => false));
    }).catch(() => setUser(null));
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') setUser(null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      supabase.auth.signOut().catch(() => {});
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

  // Il Capo comunica al database l'indirizzo delle funzioni cloud (serve all'invio mensile automatico).
  useEffect(() => {
    if (ready && user.role === 'admin') {
      supabase.rpc('register_functions_url', { p_url: `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1` }).then(() => {}, () => {});
    }
  }, [ready, user]);

  // Tempo reale: ascolto degli eventi pubblicati dal database.
  const firstSub = useRef(true);
  useEffect(() => {
    if (!ready) return undefined;
    firstSub.current = true;
    let channel;
    (async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (session) supabase.realtime.setAuth(session.access_token);
      channel = supabase.channel('ambulatorio-eventi')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' }, ({ new: row }) => {
          const evt = { type: row.type, ...(row.payload || {}) };
          if (evt.type === 'session:revoked') {
            apiLogout().finally(() => setUser(null));
            toast('La tua sessione è stata chiusa dall\'amministratore.', 'error');
            return;
          }
          if (evt.type === 'settings:changed') api.get('/settings').then(setSettings).catch(() => {});
          if (evt.type === 'doctors:changed') api.get('/doctors').then(setDoctors).catch(() => {});
          if (evt.type === 'users:changed') api.get('/users/directory').then(setDirectory).catch(() => {});
          if (evt.type === 'logo:changed') setLogoVersion(Date.now());
          bus.emit(evt);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            setLive(true);
            // Dopo una riconnessione ricarichiamo tutto per non perdere eventi.
            if (!firstSub.current) bus.emit({ type: 'resync' });
            firstSub.current = false;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            setLive(false);
          }
        });
    })();
    // Il token di accesso si rinnova: lo passiamo anche al canale in tempo reale.
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'TOKEN_REFRESHED' && session) supabase.realtime.setAuth(session.access_token);
    });
    const onFocus = () => bus.emit({ type: 'resync' });
    window.addEventListener('online', onFocus);
    return () => {
      sub.subscription.unsubscribe();
      window.removeEventListener('online', onFocus);
      if (channel) supabase.removeChannel(channel);
      setLive(false);
    };
  }, [ready, toast]);

  // Uscita automatica per inattività.
  useEffect(() => {
    if (!user) return undefined;
    let last = Date.now();
    const touch = () => { last = Date.now(); };
    const events = ['pointerdown', 'keydown', 'touchstart', 'scroll'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last > IDLE_MS) {
        apiLogout().finally(() => setUser(null));
        toast('Sei stato disconnesso per inattività.', 'info');
      }
    }, 60000);
    return () => { clearInterval(t); events.forEach((e) => window.removeEventListener(e, touch)); };
  }, [user, toast]);

  useEffect(() => {
    if (ready && user.role !== 'admin' && path.startsWith('/amministrazione')) navigate('/richieste', { replace: true });
  }, [ready, user, path, navigate]);

  const logout = async () => {
    await apiLogout();
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
  } else if (!user && needsSetup) {
    content = (
      <div className="welcome">
        <div className="card login-card">
          <Logo className="welcome-logo" version={logoVersion} />
          <h1 style={{ textAlign: 'center' }}>Primo avvio</h1>
          <p className="muted small">Non esiste ancora nessun account: crea quello del Capo (amministratore). Potrà poi creare gli account degli operatori.</p>
          <FirstAdminForm onDone={async (u) => { setNeedsSetup(false); setUser(u); navigate('/amministrazione', { replace: true }); }} />
        </div>
      </div>
    );
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
              <button type="button" className="nav-mobile-only" onClick={() => { setPwOpen(true); setMenuOpen(false); }}>Cambia password</button>
            </nav>
            <div className="header-user">
              <span className={`live-dot ${live ? 'on' : ''}`} title={live ? 'Sincronizzato in tempo reale' : 'Connessione in tempo reale assente: riconnessione…'} />
              <div className="user-chip">
                <strong>{user.displayName}</strong>
                <span>{user.role === 'admin' ? 'Amministratore · il Capo' : 'Operatore'}</span>
              </div>
              <button type="button" className="btn btn-ghost btn-sm hide-mobile" onClick={() => setPwOpen(true)}>Password</button>
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
