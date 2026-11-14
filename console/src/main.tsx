import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { api, auth, type User } from './lib/api';
import { connect, disconnect, useLive } from './lib/live';
import { Icon, ToastHost } from './components/ui';
import { Login } from './pages/Login';
import { Transfers } from './pages/Transfers';
import { Fleet, ActivityPage } from './pages/Fleet';
import { Settings } from './pages/Settings';
import './styles.css';

const ROUTES = [
  { path: 'transfers', label: 'Transfers', icon: 'layers' },
  { path: 'fleet', label: 'Fleet', icon: 'server' },
  { path: 'activity', label: 'Activity', icon: 'pulse' },
  { path: 'settings', label: 'Settings', icon: 'gear' },
] as const;

function useRoute() {
  const read = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'transfers';
  const [r, setR] = useState(read);
  useEffect(() => { const f = () => setR(read()); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return r;
}

function ConnPill() {
  const { conn } = useLive();
  const label = conn === 'live' ? 'Live' : conn === 'connecting' ? 'Connecting' : 'Reconnecting';
  return <span className={`conn conn-${conn}`} title={conn === 'offline' ? 'WebSocket dropped; polling every 3 s until it returns' : 'Streaming updates every second'}><i />{label}</span>;
}

function App() {
  const route = useRoute();
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(Boolean(auth.token));

  // Google redirect flow lands on #/auth?token=…
  if (location.hash.startsWith('#/auth?')) {
    const t = new URLSearchParams(location.hash.split('?')[1]).get('token');
    if (t) { auth.set(t); history.replaceState(null, '', '#/transfers'); }
  }

  const load = useCallback(async () => {
    if (!auth.token) { setChecking(false); return; }
    try { setUser(await api.profile()); connect(); } catch { auth.clear(); setUser(null); } finally { setChecking(false); }
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { const out = () => { disconnect(); setUser(null); }; window.addEventListener('swarmcast:logout', out); return () => window.removeEventListener('swarmcast:logout', out); }, []);

  if (checking) return <div className="boot"><Icon name="wave" size={32} /></div>;
  if (!user) return <Login onAuthed={() => { setChecking(true); load(); location.hash = '#/transfers'; }} />;

  const logout = () => { auth.clear(); disconnect(); setUser(null); location.hash = ''; };
  const page = route === 'fleet' ? <Fleet /> : route === 'activity' ? <ActivityPage /> : route === 'settings' ? <Settings user={user} onUser={setUser} onLogout={logout} /> : <Transfers admin={user.role === 'admin'} />;

  return (
    <div className="shell">
      <aside className="side">
        <a className="brand" href="#/transfers"><Icon name="wave" size={22} />Swarmcast</a>
        <nav>
          {ROUTES.map((r) => (
            <a key={r.path} href={`#/${r.path}`} className={route === r.path ? 'on' : ''} aria-current={route === r.path ? 'page' : undefined}>
              <Icon name={r.icon} />{r.label}
            </a>
          ))}
        </nav>
        <div className="side-foot">
          <ConnPill />
          <div className="me"><span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><div><strong>{user.username}</strong><span className="small muted">{user.role}</span></div></div>
          <button className="btn btn-sm btn-quiet" onClick={logout}><Icon name="logout" size={15} />Sign out</button>
        </div>
      </aside>
      <main className="main">{page}</main>
      <nav className="tabbar" aria-label="Sections">
        {ROUTES.map((r) => (
          <a key={r.path} href={`#/${r.path}`} className={route === r.path ? 'on' : ''}><Icon name={r.icon} /><span>{r.label}</span></a>
        ))}
      </nav>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><ToastHost><App /></ToastHost></StrictMode>);
