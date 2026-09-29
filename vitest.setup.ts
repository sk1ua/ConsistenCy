import http from "node:http";
import https from "node:https";

// Same rationale as apps/api/vitest.setup.ts: keep-alive socket reuse between
// sequential loopback requests can collide with the HTTP server's idle-socket
// teardown when a test blocks the event loop longer than the server's 5s
// keepAliveTimeout (execFileSync/spawnSync git fixtures, synchronous SQLite
// work), surfacing as `read ECONNRESET` under full-suite load. Per-request
// connections remove the collision; assertions are unchanged. This root-level
// setup only applies to vitest invocations whose project root is the
// repository root; per-workspace runs keep their own configs.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
