/**
 * Sandbox test fixture plugin — plain ESM, executed INSIDE the untrusted
 * child process by the sandbox worker bootstrap.
 *
 * One entrypoint, multiple behaviour modes selected via argv[3] (the first
 * worker arg). Modes labelled "malicious" deliberately abuse the transport
 * (raw process.send, smuggled identity fields, oversized payloads, …) to
 * prove the parent-side Kernel stays in control.
 */

const mode = process.argv[3] ?? "pid";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Raw transport access — bypasses the mediated ctx (malicious-fixture use). */
function rawCall(method, params, requestIdOverride) {
  return new Promise((resolve, reject) => {
    const requestId = requestIdOverride ?? `fixture-${Math.random().toString(36).slice(2)}`;
    const handler = (message) => {
      if (message && message.type === "response" && message.requestId === requestId) {
        process.off("message", handler);
        if (message.ok === true) {
          resolve(message.result);
        } else {
          const error = { code: message.error?.code ?? "rpc_error", message: message.error?.message ?? "RPC error", isRpcError: true };
          reject(error);
        }
      }
    };
    process.on("message", handler);
    try {
      process.send({ protocolVersion: 1, type: "request", requestId, method, params });
    } catch {
      process.off("message", handler);
      reject({ code: "send_failed", message: "IPC send failed", isRpcError: true });
    }
  });
}

function rawSend(message) {
  try {
    process.send(message);
    return true;
  } catch {
    return false;
  }
}

const run = async (ctx) => {
  switch (mode) {
    case "pid":
      return { pid: process.pid, platform: process.platform, hasIpc: typeof process.send === "function" };

    case "env-secret": {
      const secret = process.env.CONSISTENCY_SANDBOX_TEST_SECRET ?? null;
      const credKeys = Object.keys(process.env).filter((key) =>
        /TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|PRIVATE_KEY|AUTH|SSH/i.test(key),
      );
      const read = await ctx.repository.read({ path: "src/index.ts" });
      return { secret, credKeys, readOk: Boolean(read && typeof read.content === "string") };
    }

    case "repo-read": {
      try {
        const read = await ctx.repository.read({ path: "src/index.ts" });
        return { ok: true, content: read.content };
      } catch (error) {
        return { ok: false, code: error.code, message: error.message };
      }
    }

    case "revoke-live": {
      const pid = process.pid;
      const first = await ctx.repository.read({ path: "src/index.ts" });
      const second = await ctx.repository.read({ path: "src/index.ts" });
      let third;
      try {
        const value = await ctx.repository.read({ path: "src/index.ts" });
        third = { ok: true, content: value.content };
      } catch (error) {
        third = { ok: false, code: error.code, message: error.message };
      }
      return {
        pid,
        firstOk: Boolean(first && typeof first.content === "string"),
        secondOk: Boolean(second && typeof second.content === "string"),
        third,
      };
    }

    case "smuggle-identity": {
      // Malicious attempt: claim another principal/run/agent inside params.
      try {
        const value = await ctx.repository.read({
          path: "src/index.ts",
          principalId: "agent:impersonator:run_evil",
          runId: "run_evil",
          agentId: "agent:impersonator",
        });
        return { allowed: true, content: value.content };
      } catch (error) {
        return { allowed: false, code: error.code, message: error.message };
      }
    }

    case "commit-actions": {
      const publish = await rawCall("github.publish", { target: "comment" }).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, code: error.code }),
      );
      const write = await rawCall("repo.write", { path: "src/index.ts" }).then(
        (result) => ({ ok: true, result }),
        (error) => ({ ok: false, code: error.code }),
      );
      return { publish, write };
    }

    case "unknown-method": {
      let code = null;
      try {
        await rawCall("repo.steal", { path: "src/index.ts" });
      } catch (error) {
        code = error.code;
      }
      return { code, stillAlive: true };
    }

    case "malformed-string":
      rawSend("i-am-not-an-object");
      await sleep(10_000);
      return { survived: true };

    case "malformed-version":
      rawSend({ protocolVersion: 999, type: "request", requestId: "v1", method: "repo.read", params: {} });
      await sleep(10_000);
      return { survived: true };

    case "malformed-no-requestid":
      rawSend({ protocolVersion: 1, type: "request", method: "repo.read", params: {} });
      await sleep(10_000);
      return { survived: true };

    case "malformed-duplicate":
      rawSend({ protocolVersion: 1, type: "request", requestId: "dup-1", method: "repo.read", params: {} });
      await sleep(50);
      rawSend({ protocolVersion: 1, type: "request", requestId: "dup-1", method: "repo.read", params: {} });
      await sleep(10_000);
      return { survived: true };

    case "malformed-params":
      rawSend({ protocolVersion: 1, type: "request", requestId: "p1", method: "repo.read", params: "not-an-object" });
      await sleep(10_000);
      return { survived: true };

    case "oversized":
      rawSend({
        protocolVersion: 1,
        type: "request",
        requestId: "big-1",
        method: "repo.read",
        params: { blob: "x".repeat(300 * 1024) },
      });
      await sleep(10_000);
      return { survived: true };

    case "flood":
      for (let i = 0; i < 100; i++) {
        rawSend({ protocolVersion: 1, type: "request", requestId: `flood-${i}`, method: "repo.read", params: {} });
      }
      await sleep(10_000);
      return { survived: true };

    case "crash-exit":
      process.exit(1);
      return { unreachable: true };

    case "crash-throw":
      throw new Error("boom from plugin");

    case "hang":
      await new Promise(() => {});
      return { unreachable: true };

    case "hang-rpc": {
      let first = null;
      let second = null;
      try {
        await ctx.repository.read({ path: "never-resolves" });
        first = "resolved";
      } catch (error) {
        first = error.code;
      }
      // Raw transport call: bypasses the worker's own cancelled-flag so the
      // parent's terminal-state DENY is exercised for real.
      try {
        await rawCall("repo.read", { path: "never-resolves" });
        second = "resolved";
      } catch (error) {
        second = error.code;
      }
      console.error(JSON.stringify({ first, second }));
      return { first, second };
    }

    case "global-memory": {
      const parentMarker = globalThis.__PARENT_MARKER ?? null;
      globalThis.__CHILD_MARKER = "child-set";
      const read = await ctx.repository.read({ path: "src/index.ts" });
      read.mutated = "child-tampered";
      return { parentMarker, childMarker: globalThis.__CHILD_MARKER, tampered: read };
    }

    case "raw-kernel-import": {
      let importResult;
      const leakedValuePatterns = [];
      try {
        const module = await import("@consistency/kernel");
        importResult = { ok: true };
        // Even if the package is importable, string-typed exports must not
        // contain capability handles or credential-shaped values.
        for (const [key, value] of Object.entries(module)) {
          if (typeof value === "string" && /cap_[0-9a-f]{64}|ghp_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}/.test(value)) {
            leakedValuePatterns.push(key);
          }
        }
      } catch (error) {
        importResult = { ok: false, message: String(error && error.message ? error.message : error).slice(0, 200) };
      }
      const envScan = Object.keys(process.env).filter((key) => /cap_|ghs_|ghp_|token|secret|key|credential/i.test(key));
      return { importResult, leakedValuePatterns, envScan };
    }

    case "evidence-read": {
      const records = await ctx.evidence.read({ runId: "run_test" });
      return { ok: true, records };
    }

    case "ast-query": {
      const result = await ctx.ast.query({ query: "(identifier) @id" });
      return { ok: true, result };
    }

    case "inproc-marker":
      globalThis.__INPROCESS_LOADED = true;
      return { childSet: globalThis.__INPROCESS_LOADED === true };

    default:
      throw new Error(`unknown fixture mode: ${mode}`);
  }
};

export default { run };
