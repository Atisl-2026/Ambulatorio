import { Logo } from '../components/ui.jsx';

export default function Welcome({ onEnter, logoVersion }) {
  return (
    <div className="welcome">
      <div className="card welcome-card">
        <Logo className="welcome-logo" version={logoVersion} />
        <div className="rules">
          <p className="rule"><b>Regola numero 1:</b> Il capo ha sempre ragione.</p>
          <p className="rule"><b>Regola numero 2:</b> Nel caso improbabile in cui abbia torto, si applica automaticamente la regola numero 1</p>
        </div>
        <button type="button" className="btn btn-primary btn-lg" onClick={onEnter} autoFocus>Entra</button>
        <InstallHints />
      </div>
    </div>
  );
}

// Suggerimenti di installazione (solo se l'app è aperta nel browser e non già installata).
function InstallHints() {
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  if (standalone) return null;
  const ua = navigator.userAgent;
  const apk = import.meta.env.VITE_APK_URL;
  if (/android/i.test(ua) && apk) {
    return <p className="small" style={{ marginTop: 20 }}><a href={apk}>📱 Scarica l'app per Android (APK)</a></p>;
  }
  if (/iphone|ipad/i.test(ua)) {
    return <p className="small muted" style={{ marginTop: 20 }}>Per installarla su iPhone: tocca <b>Condividi</b> e poi <b>Aggiungi alla schermata Home</b>.</p>;
  }
  return null;
}
