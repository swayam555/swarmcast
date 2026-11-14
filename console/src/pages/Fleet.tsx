import { useEffect, useState } from 'react';
import { api, ago, bytes, rate, type WorkerNode, type GlobalStats, type Activity } from '../lib/api';
import { Empty, Icon } from '../components/ui';

export function Fleet() {
  const [nodes, setNodes] = useState<WorkerNode[] | null>(null);
  const [g, setG] = useState<GlobalStats | null>(null);
  useEffect(() => {
    const load = () => { api.nodes().then(setNodes).catch(() => {}); api.global().then(setG).catch(() => {}); };
    load(); const iv = setInterval(load, 3000); return () => clearInterval(iv);
  }, []);
  const up = (nodes || []).filter((n) => n.status === 'up');

  return (
    <div className="page">
      <header className="page-head"><div><h1>Fleet</h1><p className="muted">Workers, peer discovery and the local cache.</p></div></header>
      <section className="tiles">
        <div className="tile"><span className="tile-k">Workers up</span><span className="tile-v">{up.length}<small> / {nodes?.length ?? '—'}</small></span><span className="tile-s">heartbeat every 3 s, down after 20 s</span></div>
        <div className="tile"><span className="tile-k">DHT</span><span className="tile-v">{g?.dht.running ? `${g.dht.nodes} nodes` : 'off'}</span><span className="tile-s">{g?.dht.running ? `UDP ${g.dht.port}` : 'set SWARMCAST_DHT=on to join'}</span></div>
        <div className="tile"><span className="tile-k">Built-in tracker</span><span className="tile-v">{g?.tracker.swarms ?? 0} swarms</span><span className="tile-s">{g?.tracker.peers ?? 0} announced peers</span></div>
        <div className="tile"><span className="tile-k">Cache savings</span><span className="tile-v">{bytes(g?.cas.dedupBytes || 0)}</span><span className="tile-s">pieces reused instead of downloaded</span></div>
      </section>
      <section className="panel">
        <div className="panel-head"><h2>Workers</h2><span className="muted small">Start more with <code>npm run worker</code></span></div>
        {nodes === null ? <div className="skeleton" /> : !nodes.length ? <Empty icon="server" title="No workers registered"><p className="muted">Start one with <code>SWARMCAST_ROLE=worker npm start</code>.</p></Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Worker</th><th>Peer port</th><th>Holding</th><th>Speed</th><th>Moved</th><th>DHT</th><th>Heartbeat</th></tr></thead>
              <tbody>
                {nodes.map((n) => (
                  <tr key={n.id} className={n.status !== 'up' ? 'dim' : ''}>
                    <td><span className={`dot ${n.status === 'up' ? 'dot-up' : 'dot-down'}`} /><strong>{n.id}</strong><div className="small muted">{n.host} · up since {ago(n.started_at)}</div></td>
                    <td className="mono">{n.peer_port}</td>
                    <td>{n.stats?.held ?? 0} {(n.stats?.held ?? 0) === 1 ? "transfer" : "transfers"}<div className="small muted">{n.stats?.peers ?? 0} peer links</div></td>
                    <td className="small">{rate(n.stats?.totalDownloadSpeed || 0)}<br />{rate(n.stats?.totalUploadSpeed || 0)}</td>
                    <td className="small">{bytes(n.stats?.totalDownloaded || 0)} in<br />{bytes(n.stats?.totalUploaded || 0)} out</td>
                    <td className="small">{n.stats?.dht?.running ? `${n.stats.dht.nodes} nodes` : 'off'}</td>
                    <td className="small">{n.status === 'up' ? ago(n.heartbeat_at) : <span className="neg">down {ago(n.heartbeat_at)}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

const EVENT_TEXT: Record<string, string> = {
  'transfer.created': 'created', 'transfer.assigned': 'assigned to a worker', 'transfer.metadata': 'metadata fetched', 'transfer.completed': 'finished downloading',
  'transfer.paused': 'paused', 'transfer.resumed': 'resumed', 'transfer.pause': 'pause requested', 'transfer.resume': 'resume requested', 'transfer.start': 'start requested',
  'transfer.deleted': 'deleted', 'transfer.removed': 'removed from a worker', 'transfer.fenced': 'lease lost (fenced)', 'transfer.error': 'error',
  'node.up': 'worker joined', 'node.down': 'worker missed heartbeats', 'user.registered': 'account created', 'user.login': 'signed in', 'settings.updated': 'fleet settings changed', 'peer.banned': 'peer banned for bad data',
};

export function ActivityPage() {
  const [list, setList] = useState<Activity[] | null>(null);
  useEffect(() => { const load = () => api.feed(150).then(setList).catch(() => {}); load(); const iv = setInterval(load, 3000); return () => clearInterval(iv); }, []);
  return (
    <div className="page">
      <header className="page-head"><div><h1>Activity</h1><p className="muted">Every directive, lease and lifecycle change, newest first.</p></div></header>
      <section className="panel">
        {list === null ? <div className="skeleton" /> : !list.length ? <Empty icon="pulse" title="Quiet so far" /> : (
          <ol className="timeline big">
            {list.map((a) => (
              <li key={a.id}>
                <span className={`tl-dot ${a.event.includes('error') || a.event.includes('down') || a.event.includes('fenced') || a.event.includes('banned') ? 'bad' : a.event.includes('completed') ? 'good' : ''}`} />
                <div>
                  <div><strong>{a.name || a.nodeId || a.userName || 'Fleet'}</strong> {EVENT_TEXT[a.event] || a.event}</div>
                  <div className="small muted">
                    {a.nodeId && <span><Icon name="server" size={12} /> {a.nodeId} </span>}
                    {a.requestId && <span className="mono">req {a.requestId.slice(0, 24)} </span>}
                    {a.detail && 'message' in a.detail && <span className="neg">{String(a.detail.message)}</span>}
                  </div>
                </div>
                <time className="small muted" title={a.at}>{ago(a.at)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
