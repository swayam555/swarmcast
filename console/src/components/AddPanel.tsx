// "New transfer": paste a magnet, drop a .torrent, or share any file from this browser.
import { useRef, useState, type DragEvent } from 'react';
import { api, bytes, type Transfer } from '../lib/api';
import { upsert } from '../lib/live';
import { Icon, Modal, useToast } from './ui';

export function AddPanel({ onClose, onAdded }: { onClose: () => void; onAdded: (t: Transfer) => void }) {
  const toast = useToast();
  const [tab, setTab] = useState<'share' | 'magnet' | 'torrent'>('share');
  const [magnet, setMagnet] = useState('');
  const [replicas, setReplicas] = useState('1');
  const [file, setFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const pick = (f: File | undefined | null) => {
    if (!f) return;
    setError(null);
    if (f.name.endsWith('.torrent')) setTab('torrent');
    else if (tab === 'torrent') setTab('share');
    setFile(f);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault(); setOver(false);
    const text = e.dataTransfer.getData('text/plain');
    if (text?.startsWith('magnet:')) { setTab('magnet'); setMagnet(text); return; }
    pick(e.dataTransfer.files?.[0]);
  };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      let t: Transfer;
      if (tab === 'magnet') {
        if (!magnet.trim().startsWith('magnet:?')) throw new Error('Paste a link that starts with magnet:?');
        t = await api.addMagnet(magnet.trim(), replicas);
      } else if (tab === 'torrent') {
        if (!file) throw new Error('Choose a .torrent file');
        t = await api.uploadTorrent(file, replicas);
      } else {
        if (!file) throw new Error('Choose a file to share');
        t = await api.shareFile(file, replicas, setProgress);
      }
      upsert(t); onAdded(t);
      toast('ok', tab === 'share' ? `Sharing ${t.name}` : `Added ${t.name}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally { setBusy(false); setProgress(0); }
  };

  return (
    <Modal title="New transfer" onClose={onClose}>
      <div className="modal-body">
        <div className="seg" role="tablist">
          {(['share', 'magnet', 'torrent'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setError(null); }}>
              {k === 'share' ? 'Share a file' : k === 'magnet' ? 'Magnet link' : '.torrent file'}
            </button>
          ))}
        </div>

        {tab === 'magnet' ? (
          <label className="field">
            <span>Magnet link</span>
            <textarea rows={4} value={magnet} onChange={(e) => setMagnet(e.target.value)} placeholder="magnet:?xt=urn:btih:…" spellCheck={false} className="mono" />
          </label>
        ) : (
          <div className={`drop ${over ? 'over' : ''}`} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
            onClick={() => input.current?.click()} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && input.current?.click()}>
            <input ref={input} type="file" hidden accept={tab === 'torrent' ? '.torrent,application/x-bittorrent' : undefined} onChange={(e) => pick(e.target.files?.[0])} />
            <Icon name={tab === 'torrent' ? 'file' : 'upload'} size={28} />
            {file ? (
              <p><strong>{file.name}</strong><br /><span className="muted">{bytes(file.size)}</span></p>
            ) : (
              <p><strong>{tab === 'torrent' ? 'Drop a .torrent file' : 'Drop any file to share it'}</strong><br /><span className="muted">or click to browse</span></p>
            )}
            {tab === 'share' && <p className="small muted">The control plane hashes it, a worker seeds it, and you get a magnet link and QR code to hand out.</p>}
          </div>
        )}

        <label className="field inline">
          <span>Replicate to</span>
          <select value={replicas} onChange={(e) => setReplicas(e.target.value)}>
            <option value="1">one worker</option>
            <option value="2">two workers</option>
            <option value="3">three workers</option>
            <option value="all">every worker (fleet rollout)</option>
          </select>
        </label>

        {busy && tab === 'share' && progress > 0 && <div className="bar bar-blue"><span style={{ width: `${progress * 100}%` }} /></div>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <footer className="modal-foot">
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? (progress ? `Uploading ${Math.round(progress * 100)}%` : 'Working…') : tab === 'share' ? 'Share' : 'Add transfer'}</button>
      </footer>
    </Modal>
  );
}
