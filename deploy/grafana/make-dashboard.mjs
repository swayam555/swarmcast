// Generates deploy/grafana/dashboards/shoal-fleet.json (node deploy/grafana/make-dashboard.mjs)
import { writeFileSync } from 'node:fs';

const ds = { type: 'prometheus', uid: 'prom' };
const panel = (id, title, type, exprs, gridPos, legends = []) => ({
  id, title, type, gridPos, datasource: ds,
  targets: [].concat(exprs).map((expr, i) => ({ expr, refId: String.fromCharCode(65 + i), legendFormat: legends[i] || '' })),
});

const dashboard = {
  title: 'Shoal fleet', uid: 'shoal-fleet', schemaVersion: 39, refresh: '10s', time: { from: 'now-30m', to: 'now' },
  panels: [
    panel(1, 'Fleet throughput (bytes/s)', 'timeseries', ['shoal_download_speed_bytes', 'shoal_upload_speed_bytes'], { x: 0, y: 0, w: 12, h: 8 }, ['download', 'upload']),
    panel(2, 'Workers', 'stat', 'shoal_active_workers', { x: 12, y: 0, w: 4, h: 8 }),
    panel(3, 'Directive lag (s)', 'stat', 'shoal_queue_lag_seconds', { x: 16, y: 0, w: 4, h: 8 }),
    panel(4, 'Bytes served from CAS', 'stat', 'sum(shoal_cas_dedup_bytes_total)', { x: 20, y: 0, w: 4, h: 8 }),
    panel(5, 'Transfers by state', 'bargauge', 'shoal_transfers', { x: 0, y: 8, w: 8, h: 8 }, ['{{state}}']),
    panel(6, 'HTTP requests/s', 'timeseries', 'sum by (route) (rate(shoal_http_requests_total[1m]))', { x: 8, y: 8, w: 8, h: 8 }, ['{{route}}']),
    panel(7, 'HTTP p95 latency', 'timeseries', 'histogram_quantile(0.95, sum by (le, route) (rate(shoal_http_request_duration_seconds_bucket[5m])))', { x: 16, y: 8, w: 8, h: 8 }, ['{{route}}']),
    panel(8, 'Leases acquired / lost', 'timeseries', ['rate(shoal_lease_acquired_total[5m])', 'rate(shoal_lease_lost_total[5m])'], { x: 0, y: 16, w: 12, h: 8 }, ['acquired', 'lost']),
    panel(9, 'Idempotent replays', 'timeseries', 'rate(shoal_idempotent_replays_total[5m])', { x: 12, y: 16, w: 12, h: 8 }),
  ],
};
writeFileSync(new URL('./dashboards/shoal-fleet.json', import.meta.url), JSON.stringify(dashboard, null, 2));
console.log('wrote dashboards/shoal-fleet.json');
