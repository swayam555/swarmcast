import { useEffect, useState, type FormEvent } from 'react';
import { api, bytes, type Settings as S, type User } from '../lib/api';
import { useToast } from '../components/ui';

const MB = 1024 * 1024;

export function Settings({ user, onUser, onLogout }: { user: User; onUser: (u: User) => void; onLogout: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<S | null>(null);
  const [limits, setLimits] = useState({ down: '0', up: '0', active: '5' });
  const [profile, setProfile] = useState({ username: user.username, email: user.email });
  const [pw, setPw] = useState({ current: '', next: '' });
  const admin = user.role === 'admin';

  useEffect(() => {
    api.settings().then((x) => { setS(x); setLimits({ down: String(x.speedLimits.download / MB), up: String(x.speedLimits.upload / MB), active: String(x.maxActiveTorrents) }); }).catch((e) => toast('err', e.message));
  }, [toast]);

  const saveFleet = async (e: FormEvent) => {
    e.preventDefault();
    const down = Number(limits.down); const up = Number(limits.up); const active = Number(limits.active);
    if (![down, up].every((n) => Number.isFinite(n) && n >= 0)) return toast('err', 'Speed limits must be 0 or more');
    if (!Number.isInteger(active) || active < 1 || active > 100) return toast('err', 'Active transfers must be between 1 and 100');
    try {
      const r = await api.saveSettings({ maxActiveTorrents: active, speedLimits: { download: Math.round(down * MB), upload: Math.round(up * MB) } });
      setS(r.settings); toast('ok', 'Fleet settings saved. Workers apply them within a second.');
    } catch (err) { toast('err', (err as Error).message); }
  };
  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try { onUser(await api.updateProfile(profile)); toast('ok', 'Profile updated'); } catch (err) { toast('err', (err as Error).message); }
  };
  const savePw = async (e: FormEvent) => {
    e.preventDefault();
    try { await api.changePassword(pw.current, pw.next); setPw({ current: '', next: '' }); toast('ok', 'Password changed'); } catch (err) { toast('err', (err as Error).message); }
  };

  return (
    <div className="page">
      <header className="page-head"><div><h1>Settings</h1><p className="muted">Fleet-wide limits and your account.</p></div></header>
      <div className="grid-2">
        <section className="panel">
          <div className="panel-head"><h2>Fleet limits</h2>{!admin && <span className="small muted">read-only: admins only</span>}</div>
          <form onSubmit={saveFleet} className="form">
            <fieldset disabled={!admin}>
              <label className="field"><span>Download limit per worker (MB/s)</span><input inputMode="decimal" value={limits.down} onChange={(e) => setLimits({ ...limits, down: e.target.value })} /><small className="muted">0 = unlimited</small></label>
              <label className="field"><span>Upload limit per worker (MB/s)</span><input inputMode="decimal" value={limits.up} onChange={(e) => setLimits({ ...limits, up: e.target.value })} /><small className="muted">0 = unlimited. Seeding keeps working when throttled.</small></label>
              <label className="field"><span>Active downloads per worker</span><input inputMode="numeric" value={limits.active} onChange={(e) => setLimits({ ...limits, active: e.target.value })} /><small className="muted">Extra transfers wait in a queue. Seeding doesn't count.</small></label>
              <button className="btn btn-primary">Save fleet settings</button>
            </fieldset>
          </form>
          {s && (
            <dl className="facts small-facts">
              <div><dt>Bus</dt><dd>{s.bus}</dd></div>
              <div><dt>Leases</dt><dd>{s.leases}</dd></div>
              <div><dt>DHT</dt><dd>{s.dht.running ? `${s.dht.nodes} nodes` : 'off'}</dd></div>
              <div><dt>Current limits</dt><dd>{s.speedLimits.download ? `${bytes(s.speedLimits.download)}/s` : '∞'} ↓ · {s.speedLimits.upload ? `${bytes(s.speedLimits.upload)}/s` : '∞'} ↑</dd></div>
              <div className="wide"><dt>Trackers</dt><dd className="mono small">{s.trackers.join(', ')}</dd></div>
            </dl>
          )}
        </section>
        <div className="stack">
          <section className="panel">
            <div className="panel-head"><h2>Profile</h2><span className="small muted">{user.role}{user.google ? ' · Google linked' : ''}</span></div>
            <form onSubmit={saveProfile} className="form">
              <label className="field"><span>Username</span><input value={profile.username} onChange={(e) => setProfile({ ...profile, username: e.target.value })} /></label>
              <label className="field"><span>Email</span><input type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} /></label>
              <div className="row gap"><button className="btn">Save profile</button><button type="button" className="btn btn-quiet" onClick={onLogout}>Sign out</button></div>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>Password</h2></div>
            <form onSubmit={savePw} className="form">
              <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} /></label>
              <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} /></label>
              <button className="btn" disabled={pw.next.length < 8}>Change password</button>
            </form>
          </section>
          <section className="panel">
            <div className="panel-head"><h2>From a pipeline</h2></div>
            <pre className="code">{`curl -X POST ${location.origin}/api/torrent/create \\
  -H "Authorization: Bearer $SHOAL_TOKEN" \\
  -H "X-Request-ID: rollout-$(date +%F)-001" \\
  -H "Content-Type: application/json" \\
  -d '{"magnetURI":"magnet:?xt=urn:btih:…","replicas":"all"}'`}</pre>
            <p className="small muted">Retrying with the same X-Request-ID returns the first response instead of creating a duplicate.</p>
          </section>
        </div>
      </div>
    </div>
  );
}
