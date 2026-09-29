import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

if (Number(process.versions.node.split(".")[0]) < 22) {
  throw new Error(`API bundle smoke requires Node >= 22.x; received ${process.version}`);
}

const root = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "consistency-api-bundle-"));
const token = "bundle-smoke-session-token";

function freePort() {
  return new Promise((resolvePort, reject) => {
    const socket = createServer();
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      const port = typeof address === "object" && address ? address.port : 0;
      socket.close(error => error ? reject(error) : resolvePort(port));
    });
  });
}

const port = await freePort();
const child = spawn(process.execPath, [join(root, "apps", "api", "dist", "server.cjs")], {
  cwd: root,
  windowsHide: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    PORT: String(port),
    DATABASE_PATH: join(temporaryRoot, "consistency.db"),
    CONSISTENCY_WORKSPACE_ROOT: join(temporaryRoot, "workspaces"),
    CONSISTENCY_SETTINGS_ROOT: join(temporaryRoot, "settings"),
    CONSISTENCY_ENGINE_ROOT: join(root, "engine"),
    CONSISTENCY_PYTHON_PATH: process.env.CONSISTENCY_PYTHON_PATH ?? join(root, ".venv", "Scripts", "python.exe"),
    CONSISTENCY_LOCAL_REVIEW_ROOTS: join(temporaryRoot, "repositories"),
    CONSISTENCY_ALLOWED_ORIGINS: "consistency://app",
    CONSISTENCY_API_TOKEN: token,
    CONSISTENCY_LOAD_ENV_FILE: "false",
    CONSISTENCY_WORKERS_ENABLED: "false",
    CONSISTENCY_HEARTBEAT_ENABLED: "false"
  }
});

let stderr = "";
child.stderr.on("data", chunk => { stderr += chunk.toString(); });

try {
  const deadline = Date.now() + 20_000;
  let healthy = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` }
      });
      healthy = response.ok;
      if (healthy) break;
    } catch {
      // The server is still starting.
    }
    await new Promise(resolveWait => setTimeout(resolveWait, 200));
  }
  if (!healthy) throw new Error(`Bundled API failed its health check${stderr ? `: ${stderr.trim()}` : ""}`);
  console.log(`Bundled API smoke passed on an ephemeral loopback port (${port})`);
} finally {
  child.kill();
  await new Promise(resolveExit => {
    if (child.exitCode !== null) return resolveExit();
    const timeout = setTimeout(resolveExit, 5_000);
    child.once("exit", () => { clearTimeout(timeout); resolveExit(); });
  });
  const normalizedTemp = resolve(tmpdir()) + sep;
  const normalizedTarget = resolve(temporaryRoot);
  if (!normalizedTarget.startsWith(normalizedTemp)) {
    throw new Error(`Refusing to remove unexpected smoke directory: ${normalizedTarget}`);
  }
  rmSync(normalizedTarget, { recursive: true, force: true });
}
