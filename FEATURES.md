# Feature map

This file lists every feature of the reference design Swarmcast was built to cover: a peer-to-peer artifact distribution platform with a REST control plane, workers, Kafka, Redis and a React console. For each feature it shows where Swarmcast implements it and how it was tested.

Tests are marked:
- **T**: automated test (`npm test`, plus `test/kafka-redis.test.js`);
- **B**: checked by hand in the browser console;
- **A**: checked by hand against the live API or CLI.

## Control plane and data plane

| Reference feature | In Swarmcast | Tested |
|---|---|---|
| Stateless REST control plane that owns orchestration and lifecycle commands | `src/api` (Express). It records desired state and publishes directives; workers act on them | T, A |
| PostgreSQL as source of truth for metadata, chunk state and jobs | SQLite in WAL mode (`node:sqlite`). This is deliberate: a single binary with no database server. Kafka and Redis replace the bus and the leases, not the store (see README limits) | T |
| Horizontally scalable, crash-only Node.js workers | `src/cluster/worker.js`. Run `--scale worker=N`. A killed worker loses nothing committed | T (failover) |
| Content-addressable storage with dedup across transfers | `src/engine/storage.js` CAS keyed by SHA-256. A new artifact sharing pieces with an old one fills them from disk | T (CAS: 8 of 10 pieces reused) |
| Distributed leases with Redis `SETNX` and fencing tokens | `src/cluster/leases.js`: SQLite or Redis leases with fencing. A stale worker's writes match zero rows | T, T (Redis) |
| Kafka event bus for job dispatch and lifecycle events | `src/cluster/bus.js`: SQLite tail or Kafka (`SWARMCAST_BUS=kafka`) | T (Kafka) |
| Lease sweeper / resume abandoned transfers | Leases expire. Another worker takes over and resumes from the stored bitfield | T (failover) |
| Checkpointing and resume after restart | Per-placement bitfield is written every second, and resume skips verified pieces | T |
| Queue manager with max concurrent downloads | `maxActiveTorrents` per worker. Extra transfers are queued, and seeding doesn't count | A, B |
| Retry manager | Request timeouts re-queue blocks to other peers; failed peers back off; origin errors back off | T |
| S3 "cold start" bridge (first seed from a pre-signed URL) | `src/engine/origin.js`. `create-from-url` pulls a URL once and seeds it. With an `originUrl`, workers read missing pieces by HTTP Range when no peer has them, verify them and serve them to the swarm | T (origin), B |
| Internal peer discovery | Worker registry in the database, the built-in tracker, PEX (BEP 11) and the DHT | T |

## BitTorrent engine

| Reference feature | In Swarmcast | Tested |
|---|---|---|
| Bencode, torrent parser, torrent creator (single and multi-file) | `src/engine/bencode.js`, `metainfo.js` | T |
| Magnet links | Hex and base32 info hashes, `x.pe` peer hints | T |
| Peer wire protocol, piece manager, block requests | `wire.js`, `transfer.js`: rarest-first, 24-deep pipelining, endgame mode | T (swarm) |
| Extension protocol and metadata exchange | BEP 10 and BEP 9, so magnets work without a .torrent | T (swarm) |
| Tracker client | HTTP and UDP (BEP 3, 15, 23), plus a built-in HTTP tracker at `/announce` | T |
| DHT | Kademlia routing and KRPC: ping, find_node, get_peers, announce_peer | T (three-node DHT) |
| Upload manager / choking | Tit-for-tat with a 30 s optimistic slot and bad-piece peer banning | T |
| Throttler and speed limits | Token-bucket download and upload limits, set fleet-wide in Settings | T (throttle), B |
| Speed tracker and speed history | Per-transfer meters and a 2-minute fleet history (`/api/statistics/speed-history`) | B |
| File writer and file selection | Multi-file storage and `POST /:id/files/select` | T, B |

## API

| Reference endpoint | In Swarmcast | Tested |
|---|---|---|
| `/api/auth` register, login, Google OAuth (redirect and callback) | Same paths. Passwords use scrypt, sessions use JWT, and Google sign-in is optional | T, B |
| `/api/user/profile` (GET/PUT), `/password`, `/history` | Same | B |
| `/api/torrent` list, `/search`, `/:id`, `/:id/stats`, `/:id/files` | Same, plus `/:id/activity`, `/:id/torrent` and `/:id/download` (a file, or a tar for folders) | T, A, B |
| `/api/torrent/create`, `/upload`, `/create-from-file` | Same, plus `/create-from-url` | T, A, B |
| `/api/torrent/:id/start`, `/pause`, `/resume`, `/files/select`; PUT and DELETE `/:id` | Same. Delete takes `?deleteFiles=true`, which also removes a shared file's staged upload | T, B |
| `/api/statistics` global, engine, speed-history, dht, user | Same, plus `/nodes` and `/activity` | B |
| `/api/settings` get/put, `/speed-limits` | Same. Writes are admin-only | B |
| `/api/health`, `/ready`, `/startup`, `/metrics` | Same | A |
| X-Request-ID idempotency for CI retries | Stored for 24 h. A retry gets the first response with `Idempotent-Replay: true`; reusing an ID for a different request returns 422 | T, A |

## Observability and operations

| Reference feature | In Swarmcast | Tested |
|---|---|---|
| Prometheus metrics: API latency, queue depth, heartbeats, leases, CAS hit rate, dedup bytes | `/metrics` with HTTP histograms, bytes, CAS savings, leases, directive lag, transfers by state and origin bytes | T |
| OpenTelemetry tracing across REST, Kafka and workers | W3C `traceparent` propagation with an optional OTLP/HTTP exporter | A (log trace ids) |
| WebSocket progress streams | `/ws?token=` sends a transfer list every second and piece-level detail on subscribe | B (live console) |
| Grafana dashboards / observability stack | `docker compose --profile observability` starts Prometheus and Grafana with a provisioned dashboard | (compose) |
| Docker Compose deployment (local, prod, AWS micro) | One compose file with profiles: SQLite default, `kafka`, `observability`, and `--scale worker=N` | (compose) |
| Jenkins pipeline and SonarCloud scan | GitHub Actions CI (`.github/workflows/ci.yml`). No SonarCloud | — |
| Helm charts and Terraform | Not built. They were on the reference roadmap and never shipped there either | — |

## Console

| Reference screen or component | In Swarmcast console | Tested |
|---|---|---|
| Login page (email and password, Google) | `Login.tsx`. The first account becomes admin | B |
| Dashboard with torrent list and speed graph | `Transfers.tsx`: tiles, throughput chart, status tabs, filter and search | B |
| Universal dropzone (file, magnet or torrent) | `AddPanel.tsx`: share a file (drag and drop, with upload progress), magnet, .torrent, and "From a URL" for admins | B |
| Torrent detail modal | `Detail.tsx` drawer: overview, piece map, nodes, peers, files, activity; pause, resume, magnet, QR, .torrent, download, delete | B |
| File selector | Files tab with selection | B |
| QR code | QR for the magnet link | B |
| Settings page | Speed limits, active downloads per worker, profile, password, and pipeline snippet | B |
| Toasts, confirm dialog | In-app toasts and confirm dialogs (no browser dialogs) | B |
| Mobile nav | Bottom tab bar under 860 px. Every page checked at 390 px with no sideways scroll | B |

## Added in Swarmcast

- **Fleet rollout:** `replicas: "all"` or `N` places an artifact on every worker or on N of them.
- **Fleet and Activity pages:** worker health, DHT, tracker, cache savings, and a feed of every directive and lease. Account events are visible only to their owner and admins.
- **CLI** (`bin/swarmcast.js`): `push`, `add`, `ls`, `status`, `wait`, `pull`, and the offline `create`, `seed` and `get`.
- **Herd benchmark** (`npm run herd`): 20 nodes saved 91.8% of origin egress on one machine.
