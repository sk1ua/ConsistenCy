import http from "node:http";
import https from "node:https";

// The API test suite talks to in-process createApiServer() servers over the
// loopback with node:http and the default global agents (keep-alive since
// Node 19). Node servers close idle keep-alive sockets after the 5s server
// keepAliveTimeout. Several tests deliberately block this worker's event loop
// for longer than that between sequential HTTP calls (execFileSync/spawnSync
// git fixtures, synchronous SQLite work). When the loop is blocked past the
// keepAliveTimeout, the overdue socket destroy fires right after the loop
// unblocks — landing on a socket that already carries the next request's
// bytes — and the client can fail with `read ECONNRESET`, a transport race
// rather than an assertion failure.
//
// Reproduction matrix (measured 2026-09-27, HEAD 0b20fa2, Windows, 24 logical
// cores, Node v25.8.1 — the repo declares Node 22 in .node-version/.nvmrc, so
// this is NOT the declared baseline):
//
//   workers | files | tests | duration | exit | ECONNRESET
//   --------+-------+-------+----------+------+-----------
//      4    |  96   |  946  |  26.13s  |   0  |     0
//      8    |  96   |  946  |  16.75s  |   0  |     0
//     23    |  96   |  946  |  17.65s  |   0  |     0
//
// So the race did NOT reproduce on 2026-09-27: nothing to observe, nothing to
// fix. This mitigation is kept as a defensive guard because the race WAS
// observed historically — `postOversizedJson` in src/http.test.ts retries an
// identical probe after ECONNRESET/EPIPE, and that retry was added together
// with this file — and because a passing run cannot prove a race is absent.
// Full evidence: docs/upstream-reuse-ledger.md §9.
//
// Swapping in non-keep-alive global agents makes every request open its own
// connection, removing the pooled-socket reuse that makes the collision
// possible. Assertions and product code are unchanged; loopback connection
// setup cost per request is negligible.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
