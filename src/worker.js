#!/usr/bin/env node
// Standalone data-plane worker (SWARMCAST_ROLE=worker). Shares the DB with the API.
process.env.SWARMCAST_ROLE = 'worker';
const { startSwarmcast } = await import('./server.js');
const s = await startSwarmcast();
const shutdown = async () => { await s.stop().catch(() => {}); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
