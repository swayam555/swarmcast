# Shoal

Peer-assisted distribution for very large artifacts: model checkpoints, dataset shards, VM images, build outputs.

When fifty machines need the same 70 GB file at the same time, pulling it fifty times from object storage saturates the NAT gateway and multiplies egress cost. Shoal pulls it once. Every piece is SHA-1 verified, and workers trade pieces with each other over the BitTorrent wire protocol inside your network.

```
                POST /api/torrent/create  (X-Request-ID: rollout-042)
   CI / you  ─────────────────────────────►  Control plane (REST + WebSocket + /announce tracker)
                                                  │  desired state → SQLite (WAL)
                                                  │  directive     → bus (SQLite tail | Kafka)
                       ┌──────────────────────────┼──────────────────────────┐
                       ▼                          ▼                          ▼
                   Worker A  ◄──── pieces ────►  Worker B  ◄──── pieces ────► Worker N
                 lease + fence                lease + fence                lease + fence
                 CAS (sha256)                 CAS (sha256)                 CAS (sha256)
```

## What's in it

| Area | What it does |
|---|---|
| **Protocol** (`src/engine`) | Bencode, .torrent creation/parsing (single and multi-file), magnet links (hex + base32), peer wire protocol (BEP 3), extension protocol (BEP 10), metadata exchange so magnets work without a .torrent (BEP 9), peer exchange (BEP 11), HTTP + UDP tracker clients (BEP 3/15/23), and a built-in HTTP tracker. |
| **Swarm logic** | Rarest-first piece selection, 24-deep request pipelining, endgame mode capped at 2 requesters per block, tit-for-tat choking with a 30 s optimistic slot, bad-piece peer banning, request timeouts, token-bucket throttles. |
| **DHT** (`src/dht`) | Kademlia routing table and KRPC over UDP: `ping`, `find_node`, `get_peers`, `announce_peer`, with rotating tokens. |
| **CAS** | Verified pieces are stored by SHA-256. A new artifact that shares pieces with an old one (e.g. a fine-tune of a checkpoint you already have) is filled from local disk, not the network. |
| **Control plane** | Users (scrypt passwords, JWT, optional Google sign-in), transfers, per-worker placements, activity log, idempotency store, settings. |
| **Workers** | Crash-only. Each placement is held under a lease with a fencing token. Progress writes are fenced, so a stalled worker that comes back can't overwrite its successor. A killed worker's lease expires and another worker resumes the transfer. |
| **Fleet rollout** | `replicas: "all"` puts the artifact on every worker; `replicas: 3` on any three. Workers find each other through the DB registry, the tracker, PEX and the DHT. |
| **Idempotency** | Mutating calls with `X-Request-ID` are stored for 24 h. A CI retry gets the first response back (`Idempotent-Replay: true`), and reusing an ID for a different request returns 422. The ID shows up on every worker's activity entry. |
| **Observability** | Prometheus `/metrics` (HTTP rate and latency histograms, bytes, CAS savings, leases, directive lag, transfers by state); W3C `traceparent` propagation with an optional OTLP/HTTP span exporter; a provisioned Grafana dashboard. |
| **Console** (`console/`) | React + TypeScript. Live over WebSocket with REST fallback. Transfers with filters and search, a drag-and-drop "share any file" flow with magnet + QR, a detail drawer (piece map, workers, peers, file selection, activity), Fleet, Activity and Settings pages. Mobile layout with a bottom tab bar. |
| **CLI** (`bin/shoal.js`) | `login`, `push`, `add`, `ls`, `status`, `pause`, `resume`, `rm`, `wait`, `pull`, plus offline `create`, `seed` and `get` that need no server. |

## Run it

Node 22.5+ (it uses the built-in `node:sqlite`).

```bash
npm install
(cd console && npm install && npm run build)   # the API serves the built console
npm start                                      # control plane + one worker on :3029
SHOAL_ROLE=worker SHOAL_DATA_DIR=data/w2 SHOAL_PEER_PORT=0 npm start   # add workers
```

Open http://localhost:3029. The first account you register becomes the admin.

For console development, run `cd console && npm run dev` (Vite on :5173, proxied to :3029).

### Docker

```bash
docker compose up -d                       # control plane + 2 workers, SQLite plumbing
docker compose up -d --scale worker=6
SHOAL_BUS=kafka SHOAL_LEASES=redis docker compose --profile kafka up -d
docker compose --profile observability up -d   # Prometheus :9090, Grafana :3000
```

## From a pipeline

```bash
curl -X POST http://localhost:3029/api/torrent/create \
  -H "Authorization: Bearer $SHOAL_SERVICE_TOKEN" \
  -H "X-Request-ID: model-rollout-2026-11-13-001" \
  -H "Content-Type: application/json" \
  -d '{"magnetURI":"magnet:?xt=urn:btih:…","replicas":"all"}'

shoal push ./checkpoint.safetensors --replicas all --request-id "$CI_PIPELINE_ID"
shoal wait <id> --timeout 1800      # exits 0 once every placement is seeding
```

### API

| Method | Path | |
|---|---|---|
| POST | `/api/auth/register`, `/api/auth/login`, `/api/auth/google` | JWT |
| GET/PUT | `/api/user/profile`, PUT `/api/user/password`, GET `/api/user/history` | |
| GET | `/api/torrent`, `/api/torrent/search?q=` | list, scoped to the user (admins see all) |
| POST | `/api/torrent/create` | magnet `{magnetURI, replicas, autoStart}` |
| POST | `/api/torrent/upload` | raw `.torrent` body |
| POST | `/api/torrent/create-from-file` | raw file body + `X-Filename`; hashed and seeded by a worker |
| GET | `/api/torrent/:id`, `/:id/stats`, `/:id/activity`, `/:id/files`, `/:id/torrent`, `/:id/download` | `/download` streams a file, or a tar for folders |
| POST | `/api/torrent/:id/start`, `/pause`, `/resume`, `/files/select` | |
| PUT / DELETE | `/api/torrent/:id` (`?deleteFiles=true`) | |
| GET | `/api/statistics`, `/global`, `/engine`, `/speed-history`, `/dht`, `/nodes`, `/user`, `/activity` | |
| GET/PUT | `/api/settings`, POST `/api/settings/speed-limits`, GET `/api/settings/dht` | admin-only writes |
| GET | `/api/health`, `/api/ready`, `/api/startup`, `/metrics`, `/announce` | unauthenticated |
| WS | `/ws?token=` | per-second transfer list + fleet stats; `{subscribe: id}` for piece-level detail |

## Tests

```bash
npm test     # 14 tests: protocol, DHT, leases, swarm, cluster, failover, CAS
KAFKA_BROKERS=localhost:9092 REDIS_URL=redis://localhost:6379 node --test test/kafka-redis.test.js
npm run herd -- --nodes 20 --size-mb 32 --origin-limit-mb 20
```

What the suites check:

- **Swarm**: a node fetches a multi-file folder by magnet alone (metadata over the wire), and a third node pulls from both. Every byte is hash-checked.
- **Cluster**: an API plus three workers. One upload fans out to all three; a retry with the same request ID replays; pause and resume reach every worker; the browser download matches the source byte for byte; delete cleans up.
- **Failover**: a worker is killed mid-transfer without releasing anything. Its lease expires, a new worker takes over and finishes, and the dead node is marked down.
- **CAS**: v2 of an artifact shares 8 of 10 pieces with v1, so exactly 2 pieces cross the network.
- **Kafka + Redis**: the same rollout with directives on Kafka and leases in Redis.

### Benchmark (`test/load/herd-report.json`, 20 nodes, 32 MiB, origin capped at 20 MB/s, one machine)

| Origin egress | Naive (20 × pull) | Saved | Wasted bytes | p95 finish |
|---|---|---|---|---|
| 52.7 MiB | 640 MiB | **91.8%** | 0.5 MiB | 15.1 s |

These numbers come from loopback on one laptop. On a real network, latency and link speeds will change the timings.

## Configuration

See `.env.example`. Key settings: `SHOAL_ROLE` (`all` / `api` / `worker`), `SHOAL_BUS` (`sqlite` / `kafka`), `SHOAL_LEASES` (`sqlite` / `redis`), `SHOAL_DHT`, `SHOAL_ADVERTISE_HOST`, `SHOAL_SERVICE_TOKEN`, `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, `OTEL_EXPORTER_OTLP_ENDPOINT`.

## Limits

- State lives in SQLite. API and workers must share the database file: one host, or a shared volume as in the compose file. Kafka and Redis replace the bus and the leases, not the database.
- Downloads through the console stream from the worker's disk, which again assumes a shared filesystem with the API.
- There is no S3 or HTTP "first seed" yet. The first copy must come from an upload or from an existing BitTorrent seed.
- IPv6 compact peers (BEP 7), uTP and protocol encryption aren't implemented.

## License

MIT
