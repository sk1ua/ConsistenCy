import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  DeterministicAnalyzer,
  buildComposeReviewWireRequest,
  parseTimeoutMs,
  type SpawnFn
} from "./deterministic";

// ---------------------------------------------------------------------------
// Pure function unit tests (no process spawning)
// ---------------------------------------------------------------------------

describe("parseTimeoutMs", () => {
  it("returns 60_000 for undefined (default)", () => {
    expect(parseTimeoutMs(undefined)).toBe(60_000);
  });

  it("accepts a valid positive safe integer", () => {
    expect(parseTimeoutMs(1)).toBe(1);
    expect(parseTimeoutMs(5_000)).toBe(5_000);
  });

  it("throws RangeError for negative value", () => {
    expect(() => parseTimeoutMs(-1)).toThrow(RangeError);
    expect(() => parseTimeoutMs(-1)).toThrow(/positive safe integer/);
  });

  it("throws RangeError for zero", () => {
    expect(() => parseTimeoutMs(0)).toThrow(RangeError);
  });

  it("throws RangeError for NaN", () => {
    expect(() => parseTimeoutMs(NaN)).toThrow(RangeError);
  });

  it("throws RangeError for Infinity", () => {
    expect(() => parseTimeoutMs(Infinity)).toThrow(RangeError);
  });

  it("throws RangeError for a non-integer float", () => {
    expect(() => parseTimeoutMs(100.5)).toThrow(RangeError);
  });
});

describe("buildComposeReviewWireRequest", () => {
  it("does NOT include timeoutMs in wire options", () => {
    const req = buildComposeReviewWireRequest(
      "test_id",
      [{ path: "a.py", risk_score: 0.5, findings: [] }],
      { timeoutMs: 5_000, tokenBudget: 1_000 }
    );
    expect(req.options).not.toHaveProperty("timeoutMs");
  });

  it("converts tokenBudget (camelCase) to token_budget (snake_case) in wire options", () => {
    const req = buildComposeReviewWireRequest(
      "test_id",
      [],
      { tokenBudget: 2_000 }
    );
    expect(req.options).toHaveProperty("token_budget", 2_000);
    expect(req.options).not.toHaveProperty("tokenBudget");
  });

  it("sets options to undefined when only timeoutMs is provided", () => {
    const req = buildComposeReviewWireRequest("test_id", [], { timeoutMs: 5_000 });
    expect(req.options).toBeUndefined();
  });

  it("sets options to undefined when no options object is provided", () => {
    const req = buildComposeReviewWireRequest("test_id", []);
    expect(req.options).toBeUndefined();
  });

  it("maps file results to wire format correctly", () => {
    const req = buildComposeReviewWireRequest("test_id", [
      { path: "a.py", risk_score: 0.3, findings: ["finding1"] }
    ]);
    expect(req.files).toHaveLength(1);
    expect(req.files[0]).toMatchObject({ path: "a.py", risk_score: 0.3, findings: ["finding1"] });
  });
});

// ---------------------------------------------------------------------------
// SpawnFn-based unit tests (fake ChildProcess, no real Python)
// ---------------------------------------------------------------------------

/**
 * Creates a minimal fake ChildProcess using PassThrough streams and EventEmitter.
 * The fake proc.kill() simulates a clean process exit after SIGTERM/SIGKILL:
 *   - Sets proc.killed = true
 *   - Emits 'exit', destroys all streams, then emits 'close' via setImmediate
 */
function createFakeProcess() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const proc = new EventEmitter() as any;
  proc.stdin = stdin;
  proc.stdout = stdout;
  proc.stderr = stderr;
  proc.killed = false;
  proc.kill = (signal?: string) => {
    if (!proc.killed) {
      proc.killed = true;
      setImmediate(() => {
        proc.emit("exit", null, signal ?? "SIGTERM");
        stdin.destroy();
        stdout.destroy();
        stderr.destroy();
        proc.emit("close", null, signal ?? "SIGTERM");
      });
    }
    return true;
  };

  return { proc, stdin, stdout, stderr };
}

describe("DeterministicAnalyzer — SpawnFn injection", { timeout: 5_000 }, () => {
  it("permanent stdin error listener rejects pending AFTER real close with 'Python engine stdin error'", async () => {
    // This test proves that proc.stdin.on("error") fires and triggers fatalProtocolViolation,
    // which then rejects the pending request only after the real 'close' event.
    let capturedStdin!: PassThrough;
    let closeEmitted = false;

    const spawnFn: SpawnFn = () => {
      const { proc, stdin } = createFakeProcess();
      capturedStdin = stdin;

      // Intercept the 'close' event to track ordering
      const origEmit = proc.emit.bind(proc);
      proc.emit = (event: string, ...args: any[]) => {
        if (event === "close") closeEmitted = true;
        return origEmit(event, ...args);
      };

      return proc;
    };

    const analyzer = new DeterministicAnalyzer("python", "engine", [], undefined, spawnFn);

    // Start a pending analyze request (no Python process will respond)
    const analyzePromise = analyzer.analyze([{ path: "test.py", content: "x = 1" }]);

    // Wait one tick for ensureProcess to attach the permanent stdin error listener
    await new Promise<void>(r => setImmediate(r));

    // Emit error on stdin — this must fire the permanent listener
    capturedStdin.emit("error", new Error("EPIPE"));

    // The promise must reject with the stdin error message
    await expect(analyzePromise).rejects.toThrow(/Python engine stdin error.*EPIPE/);

    // Crucially: close must have been emitted before the rejection was delivered
    expect(closeEmitted).toBe(true);

    await analyzer.shutdown();
  });

  it("pending requests are rejected after real close, not before kill", async () => {
    // Verify the kill → close → reject ordering by tracking event sequence.
    const events: string[] = [];
    let capturedStdin!: PassThrough;

    const spawnFn: SpawnFn = () => {
      const { proc, stdin } = createFakeProcess();
      capturedStdin = stdin;

      const origKill = proc.kill.bind(proc);
      proc.kill = (signal?: string) => {
        events.push("kill");
        return origKill(signal);
      };

      const origEmit = proc.emit.bind(proc);
      proc.emit = (event: string, ...args: any[]) => {
        if (event === "close") events.push("close");
        return origEmit(event, ...args);
      };

      return proc;
    };

    const analyzer = new DeterministicAnalyzer("python", "engine", [], undefined, spawnFn);

    const analyzePromise = analyzer.analyze([{ path: "test.py", content: "x = 1" }]);
    analyzePromise.catch(() => { events.push("reject"); });

    await new Promise<void>(r => setImmediate(r));
    capturedStdin.emit("error", new Error("EPIPE"));

    await expect(analyzePromise).rejects.toThrow(/Python engine stdin error/);

    // Order must be: kill → close → reject
    expect(events).toEqual(["kill", "close", "reject"]);

    await analyzer.shutdown();
  });

  it("does not reject pending requests when SIGTERM throws EPERM until real close event fires", async () => {
    let capturedProc!: any;
    let rejected = false;

    const spawnFn: SpawnFn = () => {
      const { proc } = createFakeProcess();
      capturedProc = proc;

      // Override kill to throw EPERM on SIGTERM
      proc.kill = (signal?: string) => {
        if (signal === "SIGTERM" || !signal) {
          const err = new Error("EPERM: operation not permitted");
          (err as any).code = "EPERM";
          throw err;
        }
        return true;
      };

      return proc;
    };

    const analyzer = new DeterministicAnalyzer("python", "engine", [], undefined, spawnFn);
    const analyzePromise = analyzer.analyze([{ path: "test.py", content: "x = 1" }]);
    analyzePromise.catch(() => { rejected = true; });

    await new Promise<void>(r => setImmediate(r));

    // Trigger teardown via stdin error
    capturedProc.stdin.emit("error", new Error("EPIPE"));

    // Give time for SIGTERM error to be thrown and caught
    await new Promise<void>(r => setTimeout(r, 50));

    // Pending request MUST NOT be rejected yet because 'close' has not been emitted!
    expect(rejected).toBe(false);

    // Now emit real close event
    capturedProc.emit("close", null, "SIGKILL");

    // NOW it must reject
    await expect(analyzePromise).rejects.toThrow(/Python engine stdin error/);
    expect(rejected).toBe(true);

    await analyzer.shutdown();
  });

  it("handles stdin backpressure cleanly when write returns false until drain is emitted", async () => {
    let writeCount = 0;
    let capturedProc!: any;
    let capturedStdin!: PassThrough;

    const spawnFn: SpawnFn = () => {
      const { proc, stdin } = createFakeProcess();
      capturedProc = proc;
      capturedStdin = stdin;

      const origWrite = stdin.write.bind(stdin);
      stdin.write = (chunk: any, encoding?: any, cb?: any) => {
        writeCount++;
        if (writeCount === 1) {
          // First write returns false to simulate backpressure
          return false;
        }
        return origWrite(chunk, encoding, cb);
      };

      return proc;
    };

    const analyzer = new DeterministicAnalyzer("python", "engine", [], undefined, spawnFn);

    // Send two concurrent requests
    const promise1 = analyzer.analyze([{ path: "file1.py", content: "x = 1" }]);
    const promise2 = analyzer.analyze([{ path: "file2.py", content: "y = 2" }]);

    await new Promise<void>(r => setImmediate(r));

    // Before drain, only 1 write attempt should have occurred
    expect(writeCount).toBe(1);

    // Emit drain event on stdin
    capturedStdin.emit("drain");
    await new Promise<void>(r => setImmediate(r));

    // After drain, second write should have executed
    expect(writeCount).toBe(2);

    // Now teardown and ensure both promises end cleanly
    capturedProc.kill();
    await expect(promise1).rejects.toThrow();
    await expect(promise2).rejects.toThrow();

    // Verify drain listener was cleaned up
    expect(capturedStdin.listenerCount("drain")).toBe(0);

    await analyzer.shutdown();
  });
});

// ---------------------------------------------------------------------------
// Integration tests with real Python engine
// ---------------------------------------------------------------------------

describe("DeterministicAnalyzer Protocol & Process Lifecycle", { timeout: 15_000 }, () => {
  it("executes real Python engine stdio process for analyze and composeReview", async () => {
    const analyzer = new DeterministicAnalyzer("python", "engine");

    try {
      const analyzeResult = await analyzer.analyze([
        {
          path: "sample.py",
          content: "def add(a, b):\n    return a + b\n",
          baseline: "def add(a, b):\n    return a - b\n",
          language: "python"
        }
      ]);

      expect(analyzeResult.id).toMatch(/^req_ana_\d+_\d+$/);
      expect(analyzeResult.ok).toBe(true);
      if (!analyzeResult.ok) throw new Error("analyze failed");
      expect(analyzeResult.files).toHaveLength(1);

      const file0 = analyzeResult.files[0];
      expect(file0).toBeDefined();
      if (!file0) return;

      expect(file0.path).toBe("sample.py");
      expect(typeof file0.riskScore).toBe("number");
      expect(typeof file0.riskLabel).toBe("string");

      const composeResult = await analyzer.composeReview([
        {
          path: "sample.py",
          risk_score: file0.riskScore,
          findings: file0.findings
        }
      ]);

      expect(composeResult.id).toMatch(/^req_comp_\d+_\d+$/);
      expect(composeResult.ok).toBe(true);
      if (!composeResult.ok) throw new Error("compose failed");
      expect(typeof composeResult.overallScore).toBe("number");
      expect(typeof composeResult.riskLevel).toBe("string");

      const status = analyzer.status();
      expect(status.running).toBe(true);
      expect(status.generation).toBeGreaterThan(0);
    } finally {
      await analyzer.shutdown();
      expect(analyzer.status().running).toBe(false);
    }
  });

  it("handles invalid stdout, kills process, and cleanly respawns on THE SAME analyzer instance with isolated temp state", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "consistency-test-"));
    const stateFile = join(tempDir, "mock_state");
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["invalid_then_valid", "--state-file", stateFile]);

    try {
      // First request fails with Fatal Protocol Violation
      await expect(analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ])).rejects.toThrow(/Fatal Protocol Violation: Invalid JSON line/);

      // Second request ON THE SAME INSTANCE automatically respawns process and succeeds!
      const result = await analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ]);

      expect(result.ok).toBe(true);
    } finally {
      await analyzer.shutdown();
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  it("handles response schema parsing failure via fatal protocol violation", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["schema_invalid"]);

    try {
      await expect(analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ])).rejects.toThrow(/files/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("handles null id response via fatal protocol violation", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["null_id"]);

    try {
      await expect(analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ])).rejects.toThrow(/Response missing valid string 'id'/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("handles unknown id response via fatal protocol violation", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["unknown_id"]);

    try {
      await expect(analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ])).rejects.toThrow(/Response received for unknown request id/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("handles stdout line exceeding buffer limit without newline", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["no_newline_large"]);

    try {
      await expect(analyzer.analyze([
        { path: "test.py", content: "x = 1" }
      ])).rejects.toThrow(/exceeded max buffer limit/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("rejects blank string path before sending to process", async () => {
    const analyzer = new DeterministicAnalyzer("python", "engine");

    try {
      await expect(analyzer.analyze([
        { path: "   ", content: "x = 1" }
      ])).rejects.toThrow(/Expected a non-blank string/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("handles analyze timeout and triggers fatal violation", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["sleep_forever"]);

    try {
      await expect(analyzer.analyze([{ path: "slow.py", content: "sleep" }], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("handles composeReview timeout and triggers fatal violation", async () => {
    const analyzer = new DeterministicAnalyzer("python", "tests.fixtures.mock_engine", ["sleep_forever"]);

    try {
      await expect(analyzer.composeReview([{ path: "test.py", risk_score: 0.5, findings: [] }], { timeoutMs: 100 })).rejects.toThrow(/timed out/);
    } finally {
      await analyzer.shutdown();
    }
  });

  it("rejects new requests when shutting down", async () => {
    const analyzer = new DeterministicAnalyzer("python", "engine");
    await analyzer.shutdown();
    await expect(analyzer.analyze([{ path: "test.py", content: "x = 1" }])).rejects.toThrow(/shutting down/);
  });

  it("rejects invalid timeoutMs before spawning process", async () => {
    const analyzer = new DeterministicAnalyzer("python", "engine");

    try {
      await expect(analyzer.analyze([{ path: "test.py", content: "x = 1" }], { timeoutMs: -1 })).rejects.toThrow(/positive safe integer/);
    } finally {
      await analyzer.shutdown();
    }
  });
});
