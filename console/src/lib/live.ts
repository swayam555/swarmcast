// Live state over the control plane's WebSocket, with REST fallback while it reconnects.
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api, auth, type Transfer, type FleetStats, type Sample, type Detail, type Activity } from './api';

type Conn = 'connecting' | 'live' | 'offline';
interface State { conn: Conn; torrents: Transfer[] | null; stats: FleetStats | null; samples: Sample[]; events: Activity[] }

let state: State = { conn: 'connecting', torrents: null, stats: null, samples: [], events: [] };
const listeners = new Set<() => void>();
const detailListeners = new Map<string, Set<(d: Detail) => void>>();
const set = (p: Partial<State>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };

let ws: WebSocket | null = null;
let retry = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

function startPolling() {
  if (poll) return;
  const tick = async () => { try { set({ torrents: await api.list() }); } catch { /* offline */ } };
  tick();
  poll = setInterval(tick, 3000);
}
function stopPolling() { clearInterval(poll); poll = undefined; }

export function connect() {
  if (!auth.token || (ws && ws.readyState <= 1)) return;
  clearTimeout(timer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(auth.token)}`);
  set({ conn: 'connecting' });
  ws.onopen = () => { retry = 0; set({ conn: 'live' }); stopPolling(); for (const id of detailListeners.keys()) ws?.send(JSON.stringify({ subscribe: id })); };
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.type === 'torrents') {
      const samples = msg.sample ? [...state.samples, msg.sample].slice(-120) : state.samples;
      set({ torrents: msg.torrents, stats: msg.stats, samples });
    } else if (msg.type === 'detail') {
      detailListeners.get(msg.id)?.forEach((fn) => fn(msg.detail));
    } else if (msg.type === 'event') {
      set({ events: [msg.event, ...state.events].slice(0, 100) });
      window.dispatchEvent(new CustomEvent('shoal:event', { detail: msg.event }));
    }
  };
  ws.onclose = (e) => {
    ws = null;
    if (e.code === 4401 || !auth.token) { set({ conn: 'offline' }); return; }
    set({ conn: 'offline' });
    startPolling();
    retry = Math.min(retry + 1, 6);
    timer = setTimeout(connect, 500 * 2 ** retry);
  };
}

export function disconnect() { clearTimeout(timer); stopPolling(); ws?.close(); ws = null; state = { conn: 'connecting', torrents: null, stats: null, samples: [], events: [] }; }

export function useLive() {
  return useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, () => state);
}

/** Merge a REST result into the live list immediately (so actions feel instant). */
export function upsert(t: Transfer) {
  const list = state.torrents || [];
  const i = list.findIndex((x) => x.id === t.id);
  set({ torrents: i >= 0 ? list.map((x) => (x.id === t.id ? t : x)) : [t, ...list] });
}
export function drop(id: string) { set({ torrents: (state.torrents || []).filter((t) => t.id !== id) }); }

/** Piece-level detail for one transfer, pushed every second while subscribed. */
export function useDetail(id: string | null) {
  const [d, setD] = useState<Detail | null>(null);
  const idRef = useRef(id);
  idRef.current = id;
  useEffect(() => {
    if (!id) return;
    setD(null);
    api.detail(id).then((x) => idRef.current === id && setD(x)).catch(() => {});
    const fn = (x: Detail) => setD(x);
    if (!detailListeners.has(id)) detailListeners.set(id, new Set());
    detailListeners.get(id)!.add(fn);
    if (ws?.readyState === 1) ws.send(JSON.stringify({ subscribe: id }));
    const fallback = setInterval(() => { if (state.conn !== 'live') api.detail(id).then(setD).catch(() => {}); }, 2000);
    return () => {
      clearInterval(fallback);
      const s = detailListeners.get(id); s?.delete(fn);
      if (s && !s.size) { detailListeners.delete(id); if (ws?.readyState === 1) ws.send(JSON.stringify({ unsubscribe: id })); }
    };
  }, [id]);
  return d;
}
