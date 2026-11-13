#!/usr/bin/env node
// Standalone data-plane worker (SHOAL_ROLE=worker). Shares the DB with the API.
process.env.SHOAL_ROLE = 'worker';
const { startShoal } = await import('./server.js');
const s = await startShoal();
const shutdown = async () => { await s.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
