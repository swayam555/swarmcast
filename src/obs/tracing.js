// W3C trace-context propagation and an optional OTLP/HTTP (JSON) span exporter.
// Set OTEL_EXPORTER_OTLP_ENDPOINT (e.g. http://localhost:4318) to ship spans to
// a collector / Tempo / Jaeger; otherwise spans are only used for log correlation.
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export const als = new AsyncLocalStorage();
const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const service = process.env.OTEL_SERVICE_NAME || 'swarmcast';
const buffer = [];

export function parseTraceparent(h) {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(h || '');
  return m ? { traceId: m[1], parentId: m[2], flags: m[3] } : null;
}

export function startSpan(name, { parent, attributes = {} } = {}) {
  const ctx = parent || als.getStore()?.span;
  const span = {
    name, traceId: ctx?.traceId || randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'),
    parentId: ctx?.spanId || ctx?.parentId || undefined, start: Date.now() * 1e6, attributes: { ...attributes }, status: 0,
  };
  span.end = (status = 0) => { span.endTime = Date.now() * 1e6; span.status = status; if (endpoint) buffer.push(span); };
  span.traceparent = () => `00-${span.traceId}-${span.spanId}-01`;
  return span;
}

/** Express middleware: continue an incoming trace (or start one) and expose traceparent on the response. */
export function tracing() {
  return (req, res, next) => {
    const incoming = parseTraceparent(req.get('traceparent'));
    const span = startSpan(`${req.method} ${req.path}`, { parent: incoming ? { traceId: incoming.traceId, spanId: incoming.parentId } : undefined, attributes: { 'http.method': req.method, 'http.target': req.originalUrl, 'request.id': req.id } });
    res.set('traceparent', span.traceparent());
    req.span = span;
    res.on('finish', () => { span.attributes['http.status_code'] = res.statusCode; span.end(res.statusCode >= 500 ? 2 : 1); });
    als.run({ span }, next);
  };
}

const attr = (o) => Object.entries(o).filter(([, v]) => v !== undefined).map(([key, v]) => ({ key, value: typeof v === 'number' ? { intValue: v } : { stringValue: String(v) } }));

async function flush() {
  if (!endpoint || !buffer.length) return;
  const spans = buffer.splice(0, 500);
  const body = {
    resourceSpans: [{
      resource: { attributes: attr({ 'service.name': service }) },
      scopeSpans: [{ scope: { name: 'swarmcast' }, spans: spans.map((s) => ({ traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentId, name: s.name, kind: 2, startTimeUnixNano: String(s.start), endTimeUnixNano: String(s.endTime), attributes: attr(s.attributes), status: { code: s.status } })) }],
    }],
  };
  try { await fetch(`${endpoint.replace(/\/$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) }); } catch { /* collector down: drop */ }
}
if (endpoint) setInterval(flush, 2000).unref();
