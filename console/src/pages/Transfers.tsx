import { useEffect, useMemo, useState } from 'react';
import { api, bytes, eta, rate, type Transfer, type GlobalStats } from '../lib/api';
import { useLive, upsert } from '../lib/live';
import { Throughput } from '../components/charts';
import { AddPanel } from '../components/AddPanel';
import { Detail } from '../components/Detail';
import { Badge, Bar, Empty, Icon, useToast } from '../components/ui';

const FILTERS = [
  ['all', 'All'], ['active', 'Active'], ['seeding', 'Seeding'], ['paused', 'Paused'], ['problem', 'Needs attention'],
] as const;
type Filter = typeof FILTERS[number][0];
const matches = (t: Transfer, f: Filter) => f === 'all' ? true
  : f === 'active' ? ['downloading', 'fetching_metadata', 'checking', 'queued', 'pending'].includes(t.status)
  : f === 'seeding' ? t.status === 'seeding'
  : f === 'paused' ? t.status === 'paused'
  : ['error', 'lost'].includes(t.status);

export function Transfers({ admin = false }: { admin?: boolean }) {
  const live = useLive();
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [g, setG] = useState<GlobalStats | null>(null);

  useEffect(() => { const load = () => api.global().then(setG).catch(() => {}); load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, []);
  useEffect(() => {
    const onDrop = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); setAdding(true); } };
    const prevent = (e: DragEvent) => e.preventDefault();
    window.addEventListener('drop', onDrop); window.addEventListener('dragover', prevent);
    return () => { window.removeEventListener('drop', onDrop); window.removeEventListener('dragover', prevent); };
  }, []);

  const list = useMemo(() => (live.torrents || []).filter((t) => matches(t, filter) && (!q || t.name.toLowerCase().includes(q.toLowerCase()) || t.infoHash.startsWith(q.toLowerCase()))), [live.torrents, filter, q]);
  const open = (live.torrents || []).find((t) => t.id === openId) || null;
  const s = live.stats;

  const toggle = async (t: Transfer) => {
    try { upsert(t.desired === 'paused' ? await api.resume(t.id) : await api.pause(t.id)); } catch (e) { toast('err', (e as Error).message); }
  };

  return (
    <div className={`page ${open ? 'with-drawer' : ''}`}>
      <header className="page-head">
        <div><h1>Transfers</h1><p className="muted">Artifacts moving through the fleet, live.</p></div>
        <button className="btn btn-primary" onClick={() => setAdding(true)}><Icon name="plus" size={16} />New transfer</button>
      </header>

      <section className="tiles">
        <div className="tile"><span className="tile-k">Fleet download</span><span className="tile-v">{rate(s?.totalDownloadSpeed || 0)}</span><span className="tile-s">{bytes(s?.totalDownloaded || 0)} received this session</span></div>
        <div className="tile"><span className="tile-k">Fleet upload</span><span className="tile-v">{rate(s?.totalUploadSpeed || 0)}</span><span className="tile-s">{bytes(s?.totalUploaded || 0)} sent peer-to-peer</span></div>
        <div className="tile"><span className="tile-k">Active transfers</span><span className="tile-v">{g?.database.activeTorrents ?? '—'}<small> / {g?.database.totalTorrents ?? '—'}</small></span><span className="tile-s">{s?.queued || 0} queued · {s?.peers || 0} peer links</span></div>
        <div className="tile"><span className="tile-k">Workers</span><span className="tile-v">{s?.workers ?? '—'}</span><span className="tile-s">{bytes(g?.cas.dedupBytes || 0)} served from local cache</span></div>
      </section>

      <section className="panel">
        <div className="panel-head"><h2>Throughput</h2><span className="muted small">last 2 minutes, all workers</span></div>
        <Throughput samples={live.samples} />
      </section>

      <section className="panel">
        <div className="toolbar">
          <div className="chips" role="tablist">
            {FILTERS.map(([k, label]) => {
              const n = (live.torrents || []).filter((t) => matches(t, k)).length;
              return <button key={k} role="tab" aria-selected={filter === k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{label}<span>{n}</span></button>;
            })}
          </div>
          <label className="search"><Icon name="search" size={16} /><input placeholder="Filter by name or hash" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter transfers" /></label>
        </div>

        {live.torrents === null ? <div className="skeleton-list">{[0, 1, 2].map((i) => <div key={i} className="skeleton" />)}</div>
          : !live.torrents.length ? (
            <Empty icon="upload" title="Nothing moving yet">
              <p className="muted">Drop a file anywhere on this page to share it, or paste a magnet link.</p>
              <button className="btn btn-primary" onClick={() => setAdding(true)}>New transfer</button>
            </Empty>
          ) : !list.length ? <Empty icon="search" title="No transfers match"><button className="btn" onClick={() => { setFilter('all'); setQ(''); }}>Clear filters</button></Empty>
          : (
            <ul className="tlist">
              {list.map((t) => (
                <li key={t.id} className={`trow ${openId === t.id ? 'selected' : ''}`}>
                  <button className="trow-main" onClick={() => setOpenId(t.id)} aria-label={`Open ${t.name}`}>
                    <div className="trow-top">
                      <span className="trow-name" title={t.name}>{t.name}</span>
                      <Badge status={t.status} />
                    </div>
                    <Bar value={t.progress} status={t.status} />
                    <div className="trow-meta">
                      <span>{t.progress.toFixed(1)}% of {bytes(t.size)}</span>
                      <span>↓ {rate(t.downloadSpeed)}</span>
                      <span>↑ {rate(t.uploadSpeed)}</span>
                      <span>{t.peers.connected} peers</span>
                      <span>{t.nodes.length} {t.nodes.length === 1 ? 'worker' : 'workers'}{t.replicas === 'all' ? ' (fleet)' : ''}</span>
                      {t.eta > 0 && <span>{eta(t.eta)} left</span>}
                      {t.dedupBytes > 0 && <span className="pos">{bytes(t.dedupBytes)} from cache</span>}
                    </div>
                  </button>
                  <div className="trow-actions">
                    <button className="icon-btn" onClick={() => toggle(t)} aria-label={t.desired === 'paused' ? 'Resume' : 'Pause'} title={t.desired === 'paused' ? 'Resume' : 'Pause'}>
                      <Icon name={t.desired === 'paused' ? 'play' : 'pause'} />
                    </button>
                    {t.downloadable && <a className="icon-btn" href={api.downloadUrl(t.id)} download aria-label="Download" title="Download"><Icon name="download" /></a>}
                  </div>
                </li>
              ))}
            </ul>
          )}
      </section>

      {open && <Detail t={open} onClose={() => setOpenId(null)} />}
      {adding && <AddPanel admin={admin} onClose={() => setAdding(false)} onAdded={(t) => setOpenId(t.id)} />}
    </div>
  );
}
