// Side drawer with everything about one transfer.
import { useEffect, useState } from 'react';
import { api, ago, bytes, eta, rate, type Activity, type Transfer } from '../lib/api';
import { useDetail, upsert, drop } from '../lib/live';
import { PieceMap } from './charts';
import { Badge, Bar, Confirm, CopyButton, Icon, QR, useToast } from './ui';

type Tab = 'overview' | 'nodes' | 'peers' | 'files' | 'activity';

export function Detail({ t, onClose }: { t: Transfer; onClose: () => void }) {
  const toast = useToast();
  const d = useDetail(t.id);
  const [tab, setTab] = useState<Tab>('overview');
  const [confirm, setConfirm] = useState(false);
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [showQr, setShowQr] = useState(false);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [onClose]);

  const act = async (fn: () => Promise<Transfer>, msg: string) => {
    try { upsert(await fn()); toast('info', msg); } catch (e) { toast('err', (e as Error).message); }
  };
  const paused = t.desired === 'paused';

  return (
    <aside className="drawer" aria-label={`Details for ${t.name}`}>
      <header className="drawer-head">
        <div className="drawer-title">
          <Badge status={t.status} />
          <h2 title={t.name}>{t.name}</h2>
          <code className="hash" title="Info hash">{t.infoHash}</code>
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close details"><Icon name="close" /></button>
      </header>

      <div className="drawer-actions">
        {paused
          ? <button className="btn btn-sm" onClick={() => act(() => api.resume(t.id), 'Resuming')}><Icon name="play" size={15} />Resume</button>
          : <button className="btn btn-sm" onClick={() => act(() => api.pause(t.id), 'Pausing')}><Icon name="pause" size={15} />Pause</button>}
        <CopyButton text={t.magnetURI} label="Copy magnet" />
        <button className="btn btn-sm" onClick={() => setShowQr((v) => !v)}><Icon name="qr" size={15} />QR</button>
        {t.totalPieces > 0 && <a className="btn btn-sm" href={api.torrentUrl(t.id)} download><Icon name="file" size={15} />.torrent</a>}
        {t.downloadable && <a className="btn btn-sm" href={api.downloadUrl(t.id)} download><Icon name="download" size={15} />Download</a>}
        <button className="btn btn-sm btn-ghost-danger" onClick={() => setConfirm(true)}><Icon name="trash" size={15} />Delete</button>
      </div>

      {showQr && (
        <div className="qr-card">
          <QR text={t.magnetURI} />
          <div><strong>Scan to fetch</strong><p className="small muted">Any BitTorrent client that reads magnet links can join this swarm. On a private fleet, peers also need to reach the workers' peer port.</p></div>
        </div>
      )}

      <div className="progress-block">
        <div className="row-between"><strong>{t.progress.toFixed(1)}%</strong><span className="muted">{bytes(t.size * t.progress / 100)} of {bytes(t.size)}</span></div>
        <Bar value={t.progress} status={t.status} />
        {t.error && <p className="error small">{t.error}</p>}
      </div>

      <nav className="tabs" role="tablist">
        {(['overview', 'nodes', 'peers', 'files', 'activity'] as Tab[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k[0].toUpperCase() + k.slice(1)}{k === 'nodes' ? ` ${t.nodes.length}` : k === 'peers' ? ` ${t.peers.connected}` : k === 'files' && t.files.length ? ` ${t.files.length}` : ''}
          </button>
        ))}
      </nav>

      <div className="drawer-body">
        {tab === 'overview' && (
          <>
            <dl className="facts">
              <div><dt>Download</dt><dd>{rate(t.downloadSpeed)}</dd></div>
              <div><dt>Upload</dt><dd>{rate(t.uploadSpeed)}</dd></div>
              <div><dt>Time left</dt><dd>{eta(t.eta)}</dd></div>
              <div><dt>Peers</dt><dd>{t.peers.connected} <span className="muted">({t.seeds} seeds)</span></dd></div>
              <div><dt>Pieces</dt><dd>{t.completedPieces} / {t.totalPieces || '?'}</dd></div>
              <div><dt>Replicas</dt><dd>{t.replicas === 'all' ? 'every worker' : t.replicas}</dd></div>
              <div><dt>Received</dt><dd>{bytes(t.downloaded)}</dd></div>
              <div><dt>Sent</dt><dd>{bytes(t.uploaded)}</dd></div>
              <div><dt>From local cache</dt><dd>{bytes(t.dedupBytes)}</dd></div>
              <div><dt>Wasted</dt><dd>{bytes(d?.wasted || 0)}</dd></div>
              <div><dt>Added</dt><dd>{ago(t.addedAt)}{t.uploadedBy ? ` by ${t.uploadedBy.username}` : ''}</dd></div>
              <div><dt>Completed</dt><dd>{t.completedAt ? ago(t.completedAt) : '—'}</dd></div>
            </dl>
            <h3 className="sub">Pieces</h3>
            <PieceMap map={d?.bitfield || []} />
            {t.trackers.length > 0 && (<><h3 className="sub">Trackers</h3><ul className="plain mono small">{t.trackers.map((x) => <li key={x}>{x}</li>)}</ul></>)}
          </>
        )}
        {tab === 'nodes' && <Nodes t={t} />}
        {tab === 'peers' && <Peers peers={d?.peerList || []} />}
        {tab === 'files' && <Files t={t} />}
        {tab === 'activity' && <ActivityList id={t.id} />}
      </div>

      {confirm && (
        <Confirm title="Delete transfer?" danger confirmLabel="Delete" onClose={() => setConfirm(false)}
          body={<>Workers stop seeding <strong>{t.name}</strong> and the transfer disappears for everyone.</>}
          onConfirm={async () => { try { const r = await api.remove(t.id, deleteFiles); drop(t.id); toast('ok', r.message); onClose(); } catch (e) { toast('err', (e as Error).message); } }}>
          <label className="check"><input type="checkbox" checked={deleteFiles} onChange={(e) => setDeleteFiles(e.target.checked)} />Also delete downloaded data on the workers</label>
          {t.hasSource && <p className="small muted">The original uploaded file is kept either way.</p>}
        </Confirm>
      )}
    </aside>
  );
}

function Nodes({ t }: { t: Transfer }) {
  if (!t.nodes.length) return <p className="muted">No worker has picked this up yet. If it stays like this, check the Fleet page for live workers.</p>;
  return (
    <table className="table compact">
      <thead><tr><th>Worker</th><th>State</th><th>Progress</th><th>Speed</th><th>Peers</th></tr></thead>
      <tbody>
        {t.nodes.map((n) => (
          <tr key={n.nodeId}>
            <td><span className={`dot ${n.nodeStatus === 'up' ? 'dot-up' : 'dot-down'}`} />{n.nodeId}<div className="small muted">{n.host} · {ago(n.updatedAt)}</div></td>
            <td><Badge status={n.state} /></td>
            <td style={{ minWidth: 90 }}><Bar value={n.progress} status={n.state} /><span className="small">{n.progress.toFixed(1)}%</span></td>
            <td className="small nowrap">↓ {rate(n.downloadSpeed)}<br />↑ {rate(n.uploadSpeed)}</td>
            <td>{n.peers}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Peers({ peers }: { peers: { address: string; client: string | null; source: string; downloadSpeed: number; uploadSpeed: number; progress: number; choked: boolean; interested: boolean }[] }) {
  if (!peers.length) return <p className="muted">No peers connected right now.</p>;
  return (
    <table className="table compact">
      <thead><tr><th>Address</th><th>Client</th><th>Has</th><th>Speed</th><th>Flags</th></tr></thead>
      <tbody>
        {peers.map((p) => (
          <tr key={p.address}>
            <td className="mono small">{p.address}<div className="muted">{p.source}</div></td>
            <td className="small">{p.client || '—'}</td>
            <td className="small">{p.progress}%</td>
            <td className="small nowrap">↓ {rate(p.downloadSpeed)}<br />↑ {rate(p.uploadSpeed)}</td>
            <td className="small mono" title="C = they choke us, I = they want our pieces">{p.choked ? 'C' : '·'}{p.interested ? 'I' : '·'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Files({ t }: { t: Transfer }) {
  const toast = useToast();
  const [sel, setSel] = useState<Set<number>>(new Set(t.files.filter((f) => f.selected).map((f) => f.index)));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setSel(new Set(t.files.filter((f) => f.selected).map((f) => f.index))); }, [t.files, dirty]);
  if (!t.files.length) return <p className="muted">The file list appears once metadata has been fetched.</p>;
  const toggle = (i: number) => { const n = new Set(sel); n.has(i) ? n.delete(i) : n.add(i); setSel(n); setDirty(true); };
  return (
    <>
      <div className="row-between">
        <span className="muted small">{sel.size} of {t.files.length} selected · {bytes(t.files.filter((f) => sel.has(f.index)).reduce((n, f) => n + f.length, 0))}</span>
        <span className="row gap">
          <button className="btn btn-sm" onClick={() => { setSel(new Set(t.files.map((f) => f.index))); setDirty(true); }}>All</button>
          <button className="btn btn-sm btn-primary" disabled={!dirty || !sel.size} onClick={async () => {
            try { await api.selectFiles(t.id, [...sel]); setDirty(false); toast('ok', 'File selection saved'); } catch (e) { toast('err', (e as Error).message); }
          }}>Save selection</button>
        </span>
      </div>
      <ul className="files">
        {t.files.map((f) => (
          <li key={f.index}>
            <label className="check">
              <input type="checkbox" checked={sel.has(f.index)} onChange={() => toggle(f.index)} disabled={!t.isOwner} />
              <span className="mono small file-path" title={f.path}>{f.path}</span>
            </label>
            <span className="small muted">{bytes(f.length)}</span>
            <span className="file-bar"><Bar value={f.progress} status={f.progress >= 100 ? 'seeding' : 'downloading'} /></span>
          </li>
        ))}
      </ul>
    </>
  );
}

function ActivityList({ id }: { id: string }) {
  const [list, setList] = useState<Activity[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.activity(id).then((a) => alive && setList(a)).catch(() => {});
    load(); const iv = setInterval(load, 4000);
    return () => { alive = false; clearInterval(iv); };
  }, [id]);
  if (!list) return <p className="muted">Loading…</p>;
  return (
    <ol className="timeline">
      {list.map((a) => (
        <li key={a.id}>
          <span className="tl-event">{a.event.replace('transfer.', '')}</span>
          <span className="small muted">{a.nodeId || ''}{a.requestId ? ` · ${a.requestId.slice(0, 18)}` : ''}</span>
          <time className="small muted" title={a.at}>{ago(a.at)}</time>
        </li>
      ))}
    </ol>
  );
}
