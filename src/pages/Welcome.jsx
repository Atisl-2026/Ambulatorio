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
      </div>
    </div>
  );
}
