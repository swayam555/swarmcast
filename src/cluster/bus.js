// Directive bus between the control plane and workers.
// 'sqlite' (default): an append-only directives table that workers tail.
// 'kafka': topic shoal.jobs.dispatch (keyed by transfer id) + shoal.events.
// Directives are nudges; the desired state on the transfer row is authoritative,
// so a lost or duplicated message can't put the fleet in a wrong state.

export const TOPIC_JOBS = 'shoal.jobs.dispatch';
export const TOPIC_EVENTS = 'shoal.events';

export function createBus({ driver = 'sqlite', db, brokers, clientId = 'shoal' } = {}) {
  if (driver === 'kafka') return new KafkaBus(brokers, clientId);
  return new SqliteBus(db);
}

class SqliteBus {
  constructor(db) { this.db = db; this.kind = 'sqlite'; this.timers = []; }

  async publish(type, payload, { requestId } = {}) {
    this.db.run('INSERT INTO directives(type, payload, request_id, created_at) VALUES (?,?,?,?)', type, JSON.stringify(payload), requestId || null, Date.now());
    // keep the table small: an hour of history is plenty for late joiners
    this.db.run('DELETE FROM directives WHERE created_at < ?', Date.now() - 3600_000);
  }

  /** Tail new directives from now on. */
  async subscribe(handler, { pollMs = 250 } = {}) {
    let last = this.db.get('SELECT COALESCE(MAX(seq), 0) AS s FROM directives').s;
    const t = setInterval(async () => {
      const rows = this.db.all('SELECT seq, type, payload, request_id FROM directives WHERE seq > ? ORDER BY seq LIMIT 200', last);
      for (const r of rows) {
        last = r.seq;
        try { await handler({ type: r.type, payload: JSON.parse(r.payload), requestId: r.request_id }); } catch { /* handler logs */ }
      }
    }, pollMs);
    t.unref?.();
    this.timers.push(t);
  }

  lag() { return 0; }
  async close() { this.timers.forEach(clearInterval); }
}

class KafkaBus {
  constructor(brokers, clientId) { this.brokers = brokers; this.clientId = clientId; this.kind = 'kafka'; this.lagMs = 0; }
  async kafka() {
    if (!this.k) {
      const { Kafka, logLevel } = await import('kafkajs');
      this.k = new Kafka({ clientId: this.clientId, brokers: String(this.brokers || 'localhost:9092').split(','), logLevel: logLevel.WARN });
    }
    return this.k;
  }
  async publish(type, payload, { requestId } = {}) {
    if (!this.producer) { this.producer = (await this.kafka()).producer({ idempotent: true, maxInFlightRequests: 1 }); await this.producer.connect(); }
    await this.producer.send({
      topic: type.startsWith('EVENT_') ? TOPIC_EVENTS : TOPIC_JOBS,
      messages: [{ key: String(payload.transferId || 'fleet'), value: JSON.stringify({ type, payload }), headers: { 'x-request-id': requestId || '' } }],
    });
  }
  /** Every worker sees every directive (each uses its own group) — workers decide by lease. */
  async subscribe(handler, { groupId } = {}) {
    const consumer = (await this.kafka()).consumer({ groupId: groupId || `${this.clientId}-${process.pid}-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: TOPIC_JOBS, fromBeginning: false });
    await consumer.run({
      eachMessage: async ({ message }) => {
        this.lagMs = Date.now() - Number(message.timestamp);
        const { type, payload } = JSON.parse(message.value.toString());
        await handler({ type, payload, requestId: message.headers?.['x-request-id']?.toString() || null });
      },
    });
    this.consumer = consumer;
  }
  lag() { return this.lagMs; }
  async close() { await this.consumer?.disconnect().catch(() => {}); await this.producer?.disconnect().catch(() => {}); }
}
