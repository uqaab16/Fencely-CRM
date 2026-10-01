import { useState } from 'react';
import { api, saveSession } from '../api';

export default function Login({ onLogin, toast, appName = 'Fencely CRM' }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const { token, email: userEmail } = await api.login(email.trim(), password);
      saveSession(token, userEmail);
      onLogin({ token, email: userEmail });
      toast('success', `Welcome back${userEmail ? `, ${userEmail}` : ''}.`);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={submit}>
        <div className="login-logo">🧱</div>
        <h1>{appName}</h1>
        <p className="login-sub">Contractor outreach • Australia</p>

        {error && <div className="login-error" role="alert">{error}</div>}

        <label className="field">
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            placeholder="Your password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </div>
  );
}
