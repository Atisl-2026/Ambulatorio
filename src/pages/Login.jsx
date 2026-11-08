import { useState } from 'react';
import { api } from '../api.js';
import { Logo } from '../components/ui.jsx';

export default function Login({ onLogin, logoVersion }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const r = await api.post('/auth/login', { username, password });
      onLogin(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="welcome">
      <form className="card login-card" onSubmit={submit}>
        <Logo className="welcome-logo" version={logoVersion} />
        <h1 style={{ textAlign: 'center' }}>Accesso</h1>
        <p className="muted small" style={{ textAlign: 'center' }}>Area riservata al personale autorizzato.</p>
        {error && <div className="error-box" role="alert">{error}</div>}
        <div className="field">
          <label htmlFor="u">Nome utente</label>
          <input id="u" className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required autoFocus />
        </div>
        <div className="field">
          <label htmlFor="p">Password</label>
          <input id="p" className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </div>
        <button type="submit" className="btn btn-primary btn-lg" style={{ width: '100%' }} disabled={busy}>
          {busy ? 'Accesso in corso…' : 'Accedi'}
        </button>
      </form>
    </div>
  );
}

export function ChangePasswordForm({ onDone }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');
    if (next !== repeat) return setError('Le due password non coincidono.');
    setBusy(true);
    try {
      const r = await api.post('/auth/password', { current, next });
      onDone(r.user);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && <div className="error-box" role="alert">{error}</div>}
      <div className="field">
        <label htmlFor="pc">Password attuale</label>
        <input id="pc" className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
      </div>
      <div className="field">
        <label htmlFor="pn">Nuova password</label>
        <input id="pn" className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        <span className="hint">Almeno 10 caratteri, con lettere e numeri.</span>
      </div>
      <div className="field">
        <label htmlFor="pr">Ripeti nuova password</label>
        <input id="pr" className="input" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
      </div>
      <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%' }}>Salva password</button>
    </form>
  );
}
