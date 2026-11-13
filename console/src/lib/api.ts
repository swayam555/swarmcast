// Typed client for the Shoal control plane.

export type Status = 'pending' | 'queued' | 'checking' | 'fetching_metadata' | 'downloading' | 'seeding' | 'paused' | 'error' | 'stopped' | 'lost' | 'removing';

export interface NodePlacement { nodeId: string; host: string; nodeStatus: string; state: Status; progress: number; downloadSpeed: number; uploadSpeed: number; peers: number; dedupBytes: number; updatedAt: string }
export interface FileEntry { index: number; name: string; path: string; length: number; selected: boolean; progress: number }
export interface Transfer {
  id: string; name: string; infoHash: string; magnetURI: string; size: number; status: Status; desired: string; replicas: string; error: string | null;
  progress: number; fleetProgress: number; downloadSpeed: number; uploadSpeed: number; downloaded: number; uploaded: number; dedupBytes: number; eta: number;
  seeds: number; leeches: number; peers: { connected: number; total: number }; completedPieces: number; totalPieces: number; files: FileEntry[]; trackers: string[];
  addedAt: string; completedAt: string | null; isOwner: boolean; hasSource: boolean; origin: string | null; originBytes: number; uploadedBy: { _id: string; username: string } | null; nodes: NodePlacement[]; downloadable: boolean;
}
export interface PeerInfo { address: string; client: string | null; source: string; downloadSpeed: number; uploadSpeed: number; progress: number; choked: boolean; choking: boolean; interested: boolean }
export interface Detail {
  infoHash: string; pieceCount: number; completedPieces: number; activePieces: number; pendingRequests: number; wasted: number;
  bitfield: number[]; peerList: PeerInfo[]; nodes: NodePlacement[]; state: Status; percentage: number;
}
export interface FleetStats { totalDownloadSpeed: number; totalUploadSpeed: number; activeTorrents: number; totalTorrents: number; totalDownloaded: number; totalUploaded: number; peers: number; queued: number; workers: number }
export interface GlobalStats { database: { totalTorrents: number; totalUsers: number; activeTorrents: number }; engine: FleetStats; dht: { enabled: boolean; running: boolean; nodes: number; port?: number; nodeId?: string; workers?: number }; tracker: { swarms: number; peers: number }; cas: { dedupBytes: number }; timestamp: string }
export interface Sample { timestamp: number; downloadSpeed: number; uploadSpeed: number }
export interface User { _id: string; username: string; email: string; role: 'user' | 'admin'; createdAt: string; google: boolean }
export interface Settings { downloadPath: string; maxActiveTorrents: number; port: number; dht: GlobalStats['dht']; speedLimits: { download: number; upload: number }; trackers: string[]; bus: string; leases: string }
export interface WorkerNode { id: string; host: string; peer_port: number; dht_port: number | null; status: string; started_at: string; heartbeat_at: string; stats: (FleetStats & { dht?: GlobalStats['dht']; held?: number }) | null }
export interface Activity { id: number; event: string; detail: Record<string, unknown> | null; at: string; nodeId?: string | null; name?: string | null; requestId?: string | null; userName?: string | null }

const TOKEN_KEY = 'shoal.token';
export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set(t: string) { localStorage.setItem(TOKEN_KEY, t); },
  clear() { localStorage.removeItem(TOKEN_KEY); },
};

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }

async function call<T>(method: string, path: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string>) };
  if (auth.token) headers.authorization = `Bearer ${auth.token}`;
  if (body !== undefined && !(body instanceof Blob) && !(body instanceof ArrayBuffer)) headers['content-type'] = 'application/json';
  const res = await fetch(path, { ...init, method, headers, body: body === undefined ? undefined : body instanceof Blob || body instanceof ArrayBuffer ? body : JSON.stringify(body) });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (res.status === 401 && auth.token) { auth.clear(); window.dispatchEvent(new Event('shoal:logout')); }
  if (!res.ok) throw new ApiError(res.status, data?.error || res.statusText);
  return data as T;
}

export const api = {
  config: () => call<{ googleClientId: string | null }>('GET', '/api/auth/config'),
  login: (email: string, password: string) => call<{ token: string }>('POST', '/api/auth/login', { email, password }),
  register: (username: string, email: string, password: string) => call<{ token: string }>('POST', '/api/auth/register', { username, email, password }),
  google: (credential: string) => call<{ token: string }>('POST', '/api/auth/google', { credential }),
  profile: () => call<User>('GET', '/api/user/profile'),
  updateProfile: (p: { username?: string; email?: string }) => call<User>('PUT', '/api/user/profile', p),
  changePassword: (currentPassword: string, newPassword: string) => call<{ message: string }>('PUT', '/api/user/password', { currentPassword, newPassword }),
  history: () => call<Activity[]>('GET', '/api/user/history'),

  list: () => call<Transfer[]>('GET', '/api/torrent'),
  search: (q: string) => call<Transfer[]>('GET', `/api/torrent/search?q=${encodeURIComponent(q)}`),
  get: (id: string) => call<Transfer>('GET', `/api/torrent/${id}`),
  detail: (id: string) => call<Detail>('GET', `/api/torrent/${id}/stats`),
  activity: (id: string) => call<Activity[]>('GET', `/api/torrent/${id}/activity`),
  addMagnet: (magnetURI: string, replicas: string) => call<Transfer>('POST', '/api/torrent/create', { magnetURI, replicas }),
  fromUrl: (url: string, name: string, replicas: string) => call<Transfer>('POST', '/api/torrent/create-from-url', { url, name: name || undefined, replicas }),
  uploadTorrent: (file: File, replicas: string) => call<Transfer>('POST', `/api/torrent/upload?replicas=${encodeURIComponent(replicas)}`, file),
  shareFile: (file: File, replicas: string, onProgress?: (p: number) => void) => new Promise<Transfer>((resolve, reject) => {
    // XHR (not fetch) so we can report upload progress for large files.
    const x = new XMLHttpRequest();
    x.open('POST', `/api/torrent/create-from-file?replicas=${encodeURIComponent(replicas)}`);
    if (auth.token) x.setRequestHeader('authorization', `Bearer ${auth.token}`);
    x.setRequestHeader('x-filename', encodeURIComponent(file.name));
    x.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    x.onload = () => { const d = JSON.parse(x.responseText || '{}'); x.status < 300 ? resolve(d) : reject(new ApiError(x.status, d.error || 'Upload failed')); };
    x.onerror = () => reject(new ApiError(0, 'Network error during upload'));
    x.send(file);
  }),
  start: (id: string) => call<Transfer>('POST', `/api/torrent/${id}/start`),
  pause: (id: string) => call<Transfer>('POST', `/api/torrent/${id}/pause`),
  resume: (id: string) => call<Transfer>('POST', `/api/torrent/${id}/resume`),
  update: (id: string, p: { name?: string; replicas?: string }) => call<Transfer>('PUT', `/api/torrent/${id}`, p),
  remove: (id: string, deleteFiles: boolean) => call<{ message: string }>('DELETE', `/api/torrent/${id}?deleteFiles=${deleteFiles}`),
  files: (id: string) => call<{ files: FileEntry[]; selectedCount: number; totalCount: number }>('GET', `/api/torrent/${id}/files`),
  selectFiles: (id: string, fileIndices: number[]) => call<{ files: FileEntry[] }>('POST', `/api/torrent/${id}/files/select`, { fileIndices }),
  downloadUrl: (id: string) => `/api/torrent/${id}/download?token=${encodeURIComponent(auth.token || '')}`,
  torrentUrl: (id: string) => `/api/torrent/${id}/torrent?token=${encodeURIComponent(auth.token || '')}`,

  global: () => call<GlobalStats>('GET', '/api/statistics/global'),
  history2: () => call<{ history: Sample[] }>('GET', '/api/statistics/speed-history'),
  nodes: () => call<WorkerNode[]>('GET', '/api/statistics/nodes'),
  feed: (limit = 60) => call<Activity[]>('GET', `/api/statistics/activity?limit=${limit}`),
  settings: () => call<Settings>('GET', '/api/settings'),
  saveSettings: (s: { maxActiveTorrents?: number; speedLimits?: { download: number; upload: number } }) => call<{ settings: Settings }>('PUT', '/api/settings', s),
  health: () => call<{ status: string }>('GET', '/api/health'),
};

// ------------------------------------------------------------------ formatting
export function bytes(n: number, digits = 1) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? digits : 0)} ${u[i]}`;
}
export const rate = (n: number) => `${bytes(n)}/s`;
export function eta(sec: number) {
  if (sec < 0 || !Number.isFinite(sec)) return '—';
  if (sec === 0) return 'done';
  const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}
export function ago(iso: string | number) {
  const d = (Date.now() - new Date(iso).getTime()) / 1000;
  if (d < 5) return 'just now';
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
export const STATUS_LABEL: Record<string, string> = {
  pending: 'Waiting for a worker', queued: 'Queued', checking: 'Verifying', fetching_metadata: 'Fetching metadata', downloading: 'Downloading',
  seeding: 'Seeding', paused: 'Paused', error: 'Error', stopped: 'Stopped', lost: 'Worker lost', removing: 'Removing',
};
