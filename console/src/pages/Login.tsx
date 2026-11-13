import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, auth } from '../lib/api';
import { Icon } from '../components/ui';

declare global { interface Window { google?: { accounts: { id: { initialize: (o: object) => void; renderButton: (el: HTMLElement, o: object) => void } } } } }

export function Login({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [form, setForm] = useState({ username: '', email: '', password: '' });
  const [error, setError] = useState<string | null>(new URLSearchParams(location.hash.split('?')[1]).get('error'));
  const [busy, setBusy] = useState(false);
  const [googleId, setGoogleId] = useState<string | null>(null);
  const gBtn = useRef<HTMLDivElement>(null);

  useEffect(() => { api.config().then((c) => setGoogleId(c.googleClientId)).catch(() => {}); }, []);
  useEffect(() => {
    if (!googleId || !gBtn.current) return;
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true;
    s.onload = () => {
      window.google?.accounts.id.initialize({ client_id: googleId, callback: async (r: { credential: string }) => {
        try { const { token } = await api.google(r.credential); auth.set(token); onAuthed(); } catch (e) { setError((e as Error).message); }
      } });
      if (gBtn.current) window.google?.accounts.id.renderButton(gBtn.current, { theme: 'outline', size: 'large', width: 320, text: mode === 'login' ? 'signin_with' : 'signup_with' });
    };
    document.body.appendChild(s);
    return () => { s.remove(); };
  }, [googleId, mode, onAuthed]);

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setBusy(true); setError(null);
    try {
      const { token } = mode === 'login' ? await api.login(form.email, form.password) : await api.register(form.username, form.email, form.password);
      auth.set(token); onAuthed();
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const field = (k: keyof typeof form) => ({ value: form[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value }) });

  return (
    <div className="login">
      <section className="login-pitch">
        <div className="brand brand-lg"><Icon name="wave" size={26} />Shoal</div>
        <h1>Move a 70 GB checkpoint to fifty machines without paying for it fifty times.</h1>
        <p>Shoal pulls an artifact once, verifies it piece by piece, and lets your workers hand pieces to each other over the local network. The origin sends about one copy and the fleet does the rest.</p>
        <ul className="pitch-points">
          <li><strong>~92% less origin egress</strong> in the bundled 20-node benchmark</li>
          <li><strong>Crash-only workers.</strong> Leases with fencing tokens hand work to a survivor.</li>
          <li><strong>Pipeline-friendly.</strong> Idempotent API keyed on X-Request-ID, plus a CLI.</li>
        </ul>
      </section>
      <section className="login-card">
        <h2>{mode === 'login' ? 'Sign in' : 'Create an account'}</h2>
        <p className="muted small">{mode === 'login' ? 'Use the account you registered on this control plane.' : 'The first account on a fresh install becomes the admin.'}</p>
        <form onSubmit={submit} noValidate>
          {mode === 'register' && <label className="field"><span>Username</span><input autoComplete="username" required minLength={3} {...field('username')} /></label>}
          <label className="field"><span>Email</span><input type="email" autoComplete="email" required {...field('email')} /></label>
          <label className="field"><span>Password</span><input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required minLength={8} {...field('password')} />
            {mode === 'register' && <small className="muted">At least 8 characters.</small>}</label>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
        </form>
        {googleId && <><div className="or"><span>or</span></div><div ref={gBtn} className="gbtn" /></>}
        <p className="small switch">
          {mode === 'login' ? 'No account yet?' : 'Already registered?'}{' '}
          <button className="link" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}>{mode === 'login' ? 'Create one' : 'Sign in'}</button>
        </p>
      </section>
    </div>
  );
}
