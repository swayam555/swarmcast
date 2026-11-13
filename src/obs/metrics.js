// Small Prometheus registry: counters, gauges and histograms rendered in the
// text exposition format. Avoids pulling a metrics library into the image.

const fmtLabels = (l) => {
  const keys = Object.keys(l || {});
  if (!keys.length) return '';
  return `{${keys.sort().map((k) => `${k}="${String(l[k]).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`).join(',')}}`;
};

const HELP = {
  shoal_http_requests_total: ['counter', 'HTTP requests by method, route and status'],
  shoal_http_request_duration_seconds: ['histogram', 'HTTP request latency'],
  shoal_bytes_downloaded_total: ['counter', 'Payload bytes received from peers'],
  shoal_bytes_uploaded_total: ['counter', 'Payload bytes sent to peers'],
  shoal_cas_dedup_bytes_total: ['counter', 'Bytes satisfied from the content-addressed store instead of the network'],
  shoal_pieces_verified_total: ['counter', 'Pieces that passed SHA-1 verification'],
  shoal_transfers_completed_total: ['counter', 'Transfers that finished downloading'],
  shoal_directives_published_total: ['counter', 'Directives published by the control plane'],
  shoal_directives_consumed_total: ['counter', 'Directives consumed by workers'],
  shoal_lease_acquired_total: ['counter', 'Placement leases acquired'],
  shoal_lease_lost_total: ['counter', 'Placement leases lost (fenced out)'],
  shoal_idempotent_replays_total: ['counter', 'Requests answered from the idempotency store'],
  shoal_worker_leases_held: ['gauge', 'Leases currently held by a worker'],
  shoal_transfers: ['gauge', 'Transfers by state'],
  shoal_active_workers: ['gauge', 'Workers with a fresh heartbeat'],
  shoal_queue_lag_seconds: ['gauge', 'Directive bus lag'],
  shoal_download_speed_bytes: ['gauge', 'Fleet download speed (bytes/s)'],
  shoal_upload_speed_bytes: ['gauge', 'Fleet upload speed (bytes/s)'],
  shoal_cas_hit_ratio: ['gauge', 'CAS hit ratio'],
  shoal_ws_clients: ['gauge', 'Connected WebSocket clients'],
};
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];

export class Metrics {
  constructor() { this.series = new Map(); this.collectors = []; }
  key(name, labels) { return name + fmtLabels(labels); }

  inc(name, by = 1, labels) {
    const k = this.key(name, labels);
    const s = this.series.get(k) || { name, labels, value: 0 };
    s.value += by; this.series.set(k, s);
  }
  set(name, value, labels) { this.series.set(this.key(name, labels), { name, labels, value }); }
  observe(name, seconds, labels) {
    const k = this.key(name, labels);
    let h = this.series.get(k);
    if (!h) { h = { name, labels, hist: true, buckets: BUCKETS.map(() => 0), sum: 0, count: 0 }; this.series.set(k, h); }
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
    h.sum += seconds; h.count++;
  }
  /** Register a function that refreshes gauges right before a scrape. */
  collect(fn) { this.collectors.push(fn); }

  async render() {
    for (const fn of this.collectors) { try { await fn(this); } catch { /* best effort */ } }
    const byName = new Map();
    for (const s of this.series.values()) { if (!byName.has(s.name)) byName.set(s.name, []); byName.get(s.name).push(s); }
    const lines = [];
    for (const [name, list] of [...byName].sort()) {
      const [type, help] = HELP[name] || ['gauge', name];
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const s of list) {
        if (s.hist) {
          BUCKETS.forEach((b, i) => lines.push(`${name}_bucket${fmtLabels({ ...s.labels, le: b })} ${s.buckets[i]}`));
          lines.push(`${name}_bucket${fmtLabels({ ...s.labels, le: '+Inf' })} ${s.count}`);
          lines.push(`${name}_sum${fmtLabels(s.labels)} ${s.sum}`, `${name}_count${fmtLabels(s.labels)} ${s.count}`);
        } else lines.push(`${name}${fmtLabels(s.labels)} ${s.value}`);
      }
    }
    const mem = process.memoryUsage();
    lines.push('# TYPE process_resident_memory_bytes gauge', `process_resident_memory_bytes ${mem.rss}`);
    lines.push('# TYPE process_uptime_seconds gauge', `process_uptime_seconds ${Math.round(process.uptime())}`);
    return `${lines.join('\n')}\n`;
  }
}

/** Express middleware recording request count + latency by matched route (low cardinality). */
export function httpMetrics(metrics) {
  return (req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : (res.statusCode === 404 ? 'unmatched' : req.baseUrl || req.path);
      const secs = Number(process.hrtime.bigint() - start) / 1e9;
      metrics.inc('shoal_http_requests_total', 1, { method: req.method, route, status: res.statusCode });
      metrics.observe('shoal_http_request_duration_seconds', secs, { method: req.method, route });
    });
    next();
  };
}
