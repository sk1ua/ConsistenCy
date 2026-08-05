import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWireAnalyzeResponse,
  parseWireComposeReviewResponse,
  wireAnalyzeRequestSchema,
  wireComposeReviewRequestSchema,
  wireRelevantContextRequestSchema,
  wireRelevantContextResponseSchema,
  wireRecordReviewRequestSchema,
  wireRecordReviewResponseSchema,
  wireRunWorkflowRequestSchema,
  wireRunWorkflowResponseSchema,
  type DomainAnalyzeResponse,
  type DomainComposeReviewResponse,
  type RelevantContext,
  type WireAnalyzeRequest,
  type WireComposeReviewRequest,
  type WireRelevantContextResponse,
  type WireRunWorkflowResponse
} from "@consistency/schema";

export type DeterministicFileInput = {
  path: string;
  content: string;
  baseline?: string;
  language?: string;
  diffHunks?: string[];
};

export type DeterministicResult = DomainAnalyzeResponse;

export const MAX_STDOUT_LINE_BYTES = 10 * 1024 * 1024; // 10 MB limit
export const MAX_STDERR_TAIL_BYTES = 64 * 1024; // 64 KB memory limit

export type ManagedProcess = {
  proc: ChildProcess;
  generation: number;
  state: "running" | "closing";
  closePromise: Promise<void>;
  teardownPromise?: Promise<void>;
  stderrTail: Buffer;
  writeQueue: Promise<void>;
};

type PendingRequest = {
  action: "analyze" | "compose_review" | "relevant_context" | "run_workflow" | "record_review";
  managedProc: ManagedProcess;
  resolve: (v: any) => void;
  reject: (e: Error) => void;
};

/**
 * Injectable spawn factory. Defaults to the real `spawn` from node:child_process.
 * Injecting a fake factory in tests enables precise control of stdin/stdout/stderr
 * streams without spawning real OS processes.
 */
export type SpawnFn = (
  command: string,
  args: ReadonlyArray<string>,
  options: SpawnOptions
) => ChildProcess;

/**
 * Validates that a timeout value is a positive safe integer.
 * Exported for unit testing.
 * @throws {RangeError} if the value is not a positive safe integer.
 */
export function parseTimeoutMs(value: number | undefined): number {
  const timeout = value ?? 60_000;
  if (!Number.isSafeInteger(timeout) || timeout <= 0) {
    throw new RangeError(`timeoutMs must be a positive safe integer, got: ${timeout}`);
  }
  return timeout;
}

/**
 * Builds a WireComposeReviewRequest from domain-level arguments.
 * Exported for unit testing.
 *
 * This is the single source of truth for the compose_review wire format:
 * - `timeoutMs` is a TS-only field and MUST NOT be forwarded to Python.
 * - `tokenBudget` (camelCase) is converted to `token_budget` (snake_case).
 */
export function buildComposeReviewWireRequest(
  id: string,
  fileResults: Array<{ path: string; risk_score: number; findings: string[] }>,
  options?: { timeoutMs?: number; tokenBudget?: number }
): WireComposeReviewRequest {
  // Destructure to explicitly drop timeoutMs from the wire payload.
  const { timeoutMs: _ignored, tokenBudget } = options ?? {};

  const wireOptions: Record<string, unknown> = {};
  if (tokenBudget !== undefined) {
    // Explicit snake_case conversion: camelCase must not leak to wire.
    wireOptions.token_budget = tokenBudget;
  }

  return {
    id,
    action: "compose_review",
    files: fileResults.map(f => ({
      path: f.path,
      risk_score: f.risk_score,
      findings: f.findings
    })),
    options: Object.keys(wireOptions).length > 0 ? wireOptions : undefined
  };
}

/**
 * DeterministicAnalyzer manages the Python-based engine process lifecycle via JSON-over-stdio IPC.
 *
 * Shutdown ordering contract (enforced in fatalProtocolViolation):
 *   1. Collect all pending request handlers for this generation.
 *   2. Kill the process and await the real 'close' event (all stdio streams drained).
 *   3. Reject the collected handlers AFTER close.
 *
 * This ensures:
 *   - No new generation can be spawned before the old one is fully closed
 *     (ensureProcess waits on activeGenerations closePromises).
 *   - The reject callbacks in analyze/composeReview are never called concurrently
 *     with active stdio operations.
 */
export class DeterministicAnalyzer {
  private currentManagedProcess: ManagedProcess | null = null;
  private activeGenerations: Set<ManagedProcess> = new Set();
  private pending: Map<string, PendingRequest> = new Map();
  private counter = 0;
  private generationCounter = 0;
  private isShuttingDown = false;

  /**
   * Create a new DeterministicAnalyzer.
   * @param pythonPath Path to the Python executable. Defaults to "python".
   * @param engineModule The Python module to run as the engine. Defaults to "engine".
   * @param engineArgs Additional CLI args for the Python module. Defaults to [].
   * @param cwd Working directory for spawning Python engine. Defaults to project root.
   * @param spawnFn Injectable spawn factory. Defaults to node:child_process spawn.
   */
  constructor(
    private pythonPath = "python",
    private engineModule = "engine",
    private engineArgs: string[] = [],
    private cwd?: string,
    private spawnFn: SpawnFn = spawn
  ) {}

  /**
   * Single-flight teardown for a managed process.
   *
   * Ordering: collect → kill → await real close → reject.
   * Subsequent calls return the same in-flight promise (single-flight guarantee).
   */
  private fatalProtocolViolation(managedProc: ManagedProcess, error: Error): Promise<void> {
    if (managedProc.teardownPromise) {
      return managedProc.teardownPromise;
    }

    managedProc.teardownPromise = (async () => {
      managedProc.state = "closing";
      if (this.currentManagedProcess === managedProc) {
        this.currentManagedProcess = null;
      }

      const tailText = managedProc.stderrTail.length > 0
        ? managedProc.stderrTail.toString("utf8").split("\n").map(l => l.trim()).filter(Boolean).slice(-5).join("; ")
        : "";
      const tailContext = tailText ? ` (stderr tail: ${tailText.slice(0, 500)})` : "";
      const finalError = new Error(`${error.message}${tailContext}`);

      // Step 1: Collect doomed handlers WITHOUT rejecting yet.
      // This runs synchronously (before the first await) so there is no
      // window between collection and kill where a late response could
      // accidentally resolve a request that is about to be torn down.
      const doomedRequests: PendingRequest[] = [];
      for (const [id, req] of Array.from(this.pending.entries())) {
        if (req.managedProc === managedProc) {
          this.pending.delete(id);
          doomedRequests.push(req);
        }
      }

      // Step 2: Destroy stdio streams and kill process safely.
      // Individual try/catch blocks ensure errors during stream destruction
      // or SIGTERM cannot bypass the real closePromise barrier.
      for (const stream of [
        managedProc.proc.stdin,
        managedProc.proc.stdout,
        managedProc.proc.stderr,
      ]) {
        try {
          stream?.destroy();
        } catch {
          // Teardown must continue to the real close barrier.
        }
      }

      try {
        managedProc.proc.kill("SIGTERM");
      } catch {
        // Still schedule SIGKILL and wait for the real close event.
      }

      const killTimeout = setTimeout(() => {
        try {
          managedProc.proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 1000);

      // Step 2a: Await the REAL 'close' event. The 'close' event fires only
      // after all stdio streams are fully closed — not merely after 'exit'.
      await managedProc.closePromise.finally(() => clearTimeout(killTimeout));

      // Step 3: Reject all collected handlers AFTER real close.
      // At this point activeGenerations no longer contains this managedProc,
      // so ensureProcess is free to spawn a new generation.
      for (const req of doomedRequests) {
        req.reject(finalError);
      }
    })();

    return managedProc.teardownPromise;
  }

  private async ensureProcess(): Promise<ManagedProcess> {
    if (this.isShuttingDown) {
      throw new Error("DeterministicAnalyzer is shutting down");
    }

    if (this.currentManagedProcess && this.currentManagedProcess.state === "running" && !this.currentManagedProcess.proc.killed) {
      return this.currentManagedProcess;
    }

    // Wait for all in-flight teardowns to complete before spawning.
    if (this.activeGenerations.size > 0) {
      await Promise.all(Array.from(this.activeGenerations).map(m => m.closePromise));
    }

    if (this.isShuttingDown) {
      throw new Error("DeterministicAnalyzer is shutting down");
    }

    // Re-check after awaiting teardowns: another concurrent caller may have
    // already spawned a new process while we were waiting.
    if (this.currentManagedProcess && this.currentManagedProcess.state === "running" && !this.currentManagedProcess.proc.killed) {
      return this.currentManagedProcess;
    }

    const moduleDirectory = dirname(fileURLToPath(import.meta.url));
    const projectRoot = this.cwd ?? resolve(moduleDirectory, "../../../..");

    const inheritedEnv = { ...process.env };
    // Public GitHub credentials belong only to the TypeScript API process;
    // the deterministic Python engine never needs repository read tokens.
    delete inheritedEnv.GITHUB_PUBLIC_READ_TOKEN;
    const env = {
      ...inheritedEnv,
      // Force UTF-8 mode for the engine subprocess. On non-UTF-8 locales
      // (e.g. Chinese Windows GBK/cp936) Python's default stdin/stdout
      // encoding would mangle multi-byte file names and contents, breaking
      // the JSON-over-stdio protocol.
      PYTHONUTF8: "1",
      PYTHONPATH: process.env.PYTHONPATH
        ? `${projectRoot}${delimiter}${process.env.PYTHONPATH}`
        : projectRoot
    };

    const generation = ++this.generationCounter;
    const proc = this.spawnFn(
      this.pythonPath,
      ["-u", "-m", this.engineModule, ...this.engineArgs],
      { stdio: ["pipe", "pipe", "pipe"], cwd: projectRoot, env }
    );

    let resolveClose!: () => void;
    const closePromise = new Promise<void>((resolve) => {
      resolveClose = resolve;
    });

    const managedProc: ManagedProcess = {
      proc,
      generation,
      state: "running",
      closePromise,
      stderrTail: Buffer.alloc(0),
      writeQueue: Promise.resolve()
    };

    this.activeGenerations.add(managedProc);
    this.currentManagedProcess = managedProc;

    proc.on("error", (err) => {
      process.stderr.write(`[Python Engine Error] Generation ${generation}: ${err.message}\n`);
      void this.fatalProtocolViolation(managedProc, new Error(`Python engine spawn/IPC error: ${err.message}`));
    });

    // Permanent stdin error listener — must remain active for the full lifetime
    // of the process, not just during a drain wait. This catches broken-pipe
    // errors that occur when the Python process closes its stdin read end while
    // the parent is (or later tries) writing.
    proc.stdin?.on("error", (err) => {
      process.stderr.write(`[Python Engine Stdin Error] Generation ${generation}: ${err.message}\n`);
      void this.fatalProtocolViolation(managedProc, new Error(`Python engine stdin error: ${err.message}`));
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[Python Engine Stderr] ${chunk.toString("utf8")}`);
      managedProc.stderrTail = Buffer.concat([managedProc.stderrTail, chunk]).subarray(-MAX_STDERR_TAIL_BYTES);
    });

    let stdoutBuffer = Buffer.alloc(0);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer = Buffer.concat([stdoutBuffer, chunk]);

      let newlineIndex = stdoutBuffer.indexOf(0x0a);
      while (newlineIndex !== -1) {
        const lineBuffer = stdoutBuffer.subarray(0, newlineIndex);
        stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);

        if (lineBuffer.length > MAX_STDOUT_LINE_BYTES) {
          void this.fatalProtocolViolation(managedProc, new Error("Fatal Protocol Violation: stdout line exceeded max buffer limit"));
          return;
        }

        const line = lineBuffer.toString("utf8").trim();
        if (line) {
          this.handleResponseLine(managedProc, line);
        }

        newlineIndex = stdoutBuffer.indexOf(0x0a);
      }

      if (stdoutBuffer.length > MAX_STDOUT_LINE_BYTES) {
        void this.fatalProtocolViolation(managedProc, new Error("Fatal Protocol Violation: stdout line exceeded max buffer limit without newline"));
      }
    });

    // 'exit' fires when the process terminates, but stdio streams may still be
    // open (e.g. inherited by child processes). Do NOT resolve closePromise here.
    proc.on("exit", (code, signal) => {
      if (managedProc.state === "running") {
        void this.fatalProtocolViolation(
          managedProc,
          new Error(`Python engine process exited unexpectedly (code: ${code}, signal: ${signal})`)
        );
      }
    });

    // 'close' fires only after all stdio streams are fully drained and closed.
    // This is the authoritative signal that the generation is done.
    proc.on("close", () => {
      managedProc.state = "closing";
      if (this.currentManagedProcess === managedProc) {
        this.currentManagedProcess = null;
      }
      this.activeGenerations.delete(managedProc);
      resolveClose();
    });

    return managedProc;
  }

  private handleResponseLine(managedProc: ManagedProcess, line: string): void {
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch {
      void this.fatalProtocolViolation(managedProc, new Error(`Fatal Protocol Violation: Invalid JSON line on stdout: ${line}`));
      return;
    }

    if (!raw || typeof raw !== "object") {
      void this.fatalProtocolViolation(managedProc, new Error("Fatal Protocol Violation: stdout payload is not a JSON object"));
      return;
    }

    const reqId = raw.id;
    if (!reqId || typeof reqId !== "string") {
      void this.fatalProtocolViolation(managedProc, new Error(`Fatal Protocol Violation: Response missing valid string 'id': ${JSON.stringify(raw)}`));
      return;
    }

    const handler = this.pending.get(reqId);
    if (!handler) {
      void this.fatalProtocolViolation(managedProc, new Error(`Fatal Protocol Violation: Response received for unknown request id '${reqId}'`));
      return;
    }

    if (handler.managedProc !== managedProc) {
      // Stale response from a previous generation: discard silently.
      return;
    }

    let domainResponse: any;
    try {
      if (handler.action === "compose_review") {
        domainResponse = parseWireComposeReviewResponse(raw);
      } else if (handler.action === "relevant_context") {
        domainResponse = wireRelevantContextResponseSchema.parse(raw);
      } else if (handler.action === "run_workflow") {
        domainResponse = wireRunWorkflowResponseSchema.parse(raw);
      } else if (handler.action === "record_review") {
        domainResponse = wireRecordReviewResponseSchema.parse(raw);
      } else {
        domainResponse = parseWireAnalyzeResponse(raw);
      }
    } catch (schemaErr) {
      void this.fatalProtocolViolation(managedProc, schemaErr instanceof Error ? schemaErr : new Error(String(schemaErr)));
      return;
    }

    this.pending.delete(reqId);
    handler.resolve(domainResponse);
  }

  private writeStdin(managedProc: ManagedProcess, line: string): Promise<void> {
    const writeOperation = async () => {
      const proc = managedProc.proc;
      if (!proc.stdin || proc.stdin.destroyed || managedProc.state !== "running") {
        throw new Error("Process stdin is not writable");
      }

      const payload = line + "\n";
      const accepted = proc.stdin.write(payload, "utf8");
      if (!accepted) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (err: Error) => { cleanup(); reject(err); };
          const onClose = () => { cleanup(); reject(new Error("Process closed while waiting for stdin drain")); };
          const cleanup = () => {
            proc.stdin?.removeListener("drain", onDrain);
            proc.stdin?.removeListener("error", onError);
            proc.removeListener("close", onClose);
          };
          proc.stdin?.once("drain", onDrain);
          proc.stdin?.once("error", onError);
          proc.once("close", onClose);
        });
      }
    };

    managedProc.writeQueue = managedProc.writeQueue
      .then(writeOperation)
      .catch(async (err) => {
        void this.fatalProtocolViolation(managedProc, err instanceof Error ? err : new Error(String(err)));
        throw err;
      });

    return managedProc.writeQueue;
  }

  /**
   * Request an analysis from the Python engine.
   * @param files The files to analyze.
   * @param options Analysis options. `timeoutMs` must be a positive safe integer.
   * @returns The deterministic analysis result in domain camelCase.
   */
  async analyze(
    files: DeterministicFileInput[],
    options?: {
      agents?: string[];
      includeEvidencePack?: boolean;
      tokenBudget?: number;
      timeoutMs?: number;
    }
  ): Promise<DomainAnalyzeResponse> {
    const timeoutMs = parseTimeoutMs(options?.timeoutMs);
    const managedProc = await this.ensureProcess();
    const id = `req_ana_${++this.counter}_${Date.now()}`;

    const rawRequest: WireAnalyzeRequest = {
      id,
      action: "analyze",
      files: files.map(f => ({
        path: f.path,
        content: f.content,
        baseline: f.baseline ?? "",
        language: f.language ?? "",
        diff_hunks: f.diffHunks ?? [],
      })),
      options: {
        agents: options?.agents ?? ["style", "structural", "semantic", "duplication", "security"],
        include_evidence_pack: options?.includeEvidencePack ?? true,
        token_budget: options?.tokenBudget ?? 2000,
      },
    };

    const validatedRequest = wireAnalyzeRequestSchema.parse(rawRequest);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          // Trigger single-flight teardown. It will collect this pending request
          // and reject it AFTER real close — do not self-reject here.
          void this.fatalProtocolViolation(
            managedProc,
            new Error(`Deterministic analysis timed out after ${timeoutMs}ms for request ${id}`)
          );
        }
      }, timeoutMs);

      this.pending.set(id, {
        action: "analyze",
        managedProc,
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.writeStdin(managedProc, JSON.stringify(validatedRequest)).catch(() => {
        // fatalProtocolViolation has been triggered inside writeStdin's catch chain.
        // It will collect this pending request and reject it after real close.
      });
    });
  }

  /**
   * Fold a completed review's findings into the repository's project memory.
   *
   * Findings previously open against a covered file that this review no longer
   * reports are marked resolved and become historical fixes, so the next review
   * of that file can see both what is outstanding and what was already fixed.
   */
  async recordReview(input: {
    indexPath: string;
    jobId: string;
    reference: string;
    reportedAt: string;
    coveredFiles: string[];
    findings: Array<{ file: string; title: string; severity: string }>;
    timeoutMs?: number;
  }): Promise<{ recorded: number; resolved: number }> {
    const timeoutMs = parseTimeoutMs(input.timeoutMs);
    const managedProc = await this.ensureProcess();
    const id = `req_rec_${++this.counter}_${Date.now()}`;

    const validatedRequest = wireRecordReviewRequestSchema.parse({
      id,
      action: "record_review",
      index_path: input.indexPath,
      job_id: input.jobId,
      reference: input.reference,
      reported_at: input.reportedAt,
      covered_files: input.coveredFiles,
      findings: input.findings
    });

    const response = await new Promise<{ ok: boolean; recorded?: number; resolved?: number; error?: string }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          void this.fatalProtocolViolation(
            managedProc,
            new Error(`Record review timed out after ${timeoutMs}ms for request ${id}`)
          );
        }
      }, timeoutMs);

      this.pending.set(id, {
        action: "record_review",
        managedProc,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });

      this.writeStdin(managedProc, JSON.stringify(validatedRequest)).catch(() => {
        // fatalProtocolViolation already collected and rejected this request.
      });
    });

    if (!response.ok) throw new Error(response.error ?? "Failed to record review");
    return { recorded: response.recorded ?? 0, resolved: response.resolved ?? 0 };
  }

  /**
   * Run a named workflow through the DAG engine.
   *
   * `workspacePath` is intentionally optional and omitted by the review path:
   * supplying it lets subprocess steps run external tools inside the checkout,
   * which is unsafe when the checkout is a clone of an untrusted repository.
   */
  async runWorkflow(
    workflow: string,
    files: DeterministicFileInput[],
    options?: { workspacePath?: string; maxParallelism?: number; timeoutMs?: number }
  ): Promise<WireRunWorkflowResponse> {
    const timeoutMs = parseTimeoutMs(options?.timeoutMs);
    const managedProc = await this.ensureProcess();
    const id = `req_wf_${++this.counter}_${Date.now()}`;

    const validatedRequest = wireRunWorkflowRequestSchema.parse({
      id,
      action: "run_workflow",
      workflow,
      files: files.map(file => ({
        path: file.path,
        content: file.content,
        baseline: file.baseline ?? "",
        language: file.language ?? "",
        diff_hunks: file.diffHunks ?? []
      })),
      workspace_path: options?.workspacePath ?? null,
      options: { max_parallelism: options?.maxParallelism ?? 4 }
    });

    return new Promise<WireRunWorkflowResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          void this.fatalProtocolViolation(
            managedProc,
            new Error(`Workflow run timed out after ${timeoutMs}ms for request ${id}`)
          );
        }
      }, timeoutMs);

      this.pending.set(id, {
        action: "run_workflow",
        managedProc,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });

      this.writeStdin(managedProc, JSON.stringify(validatedRequest)).catch(() => {
        // fatalProtocolViolation already collected and rejected this request.
      });
    });
  }

  /**
   * Ask the engine for historical and structural context around the changed
   * files: who calls them, what relates to them, and what past reviews found.
   *
   * Failures here are not fatal to a review — context is an enrichment, so the
   * caller is expected to proceed without it rather than abort.
   */
  async relevantContext(
    files: DeterministicFileInput[],
    targets: string[],
    options?: { limit?: number; indexPath?: string; timeoutMs?: number }
  ): Promise<Record<string, RelevantContext>> {
    const timeoutMs = parseTimeoutMs(options?.timeoutMs);
    const managedProc = await this.ensureProcess();
    const id = `req_ctx_${++this.counter}_${Date.now()}`;

    const validatedRequest = wireRelevantContextRequestSchema.parse({
      id,
      action: "relevant_context",
      files: files.map(file => ({
        path: file.path,
        content: file.content,
        baseline: file.baseline ?? "",
        language: file.language ?? ""
      })),
      targets,
      index_path: options?.indexPath ?? null,
      options: { limit: options?.limit ?? 10 }
    });

    const response = await new Promise<WireRelevantContextResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          void this.fatalProtocolViolation(
            managedProc,
            new Error(`Relevant context timed out after ${timeoutMs}ms for request ${id}`)
          );
        }
      }, timeoutMs);

      this.pending.set(id, {
        action: "relevant_context",
        managedProc,
        resolve: (value) => { clearTimeout(timeout); resolve(value); },
        reject: (error) => { clearTimeout(timeout); reject(error); }
      });

      this.writeStdin(managedProc, JSON.stringify(validatedRequest)).catch(() => {
        // fatalProtocolViolation already collected and rejected this request.
      });
    });

    if (!response.ok) throw new Error(response.error);
    return response.contexts;
  }

  /**
   * Request composed review scoring and summary from the Python engine.
   * @param fileResults Results of analyzed files.
   * @param options Composing options. `timeoutMs` must be a positive safe integer.
   * @returns Composed review response in domain camelCase.
   */
  async composeReview(
    fileResults: Array<{ path: string; risk_score: number; findings: string[] }>,
    options?: {
      timeoutMs?: number;
      tokenBudget?: number;
    }
  ): Promise<DomainComposeReviewResponse> {
    const timeoutMs = parseTimeoutMs(options?.timeoutMs);
    const managedProc = await this.ensureProcess();
    const id = `req_comp_${++this.counter}_${Date.now()}`;

    // buildComposeReviewWireRequest strips timeoutMs and converts tokenBudget → token_budget.
    const rawRequest = buildComposeReviewWireRequest(id, fileResults, options);
    const validatedRequest = wireComposeReviewRequestSchema.parse(rawRequest);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.pending.has(id)) {
          void this.fatalProtocolViolation(
            managedProc,
            new Error(`Compose review timed out after ${timeoutMs}ms for request ${id}`)
          );
        }
      }, timeoutMs);

      this.pending.set(id, {
        action: "compose_review",
        managedProc,
        resolve: (v) => { clearTimeout(timeout); resolve(v); },
        reject: (e) => { clearTimeout(timeout); reject(e); },
      });

      this.writeStdin(managedProc, JSON.stringify(validatedRequest)).catch(() => {
        // fatalProtocolViolation handles rejection after real close.
      });
    });
  }

  /**
   * Get status of current managed process.
   */
  status(): { running: boolean; generation: number; pendingCount: number } {
    return {
      running: Boolean(this.currentManagedProcess && this.currentManagedProcess.state === "running"),
      generation: this.currentManagedProcess?.generation ?? 0,
      pendingCount: this.pending.size
    };
  }

  /**
   * Gracefully shut down the Python engine process.
   * Uses fatalProtocolViolation to ensure pending requests are rejected after real close.
   */
  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    this.currentManagedProcess = null;
    const allGenerations = Array.from(this.activeGenerations);
    await Promise.all(allGenerations.map(m => this.fatalProtocolViolation(m, new Error("DeterministicAnalyzer is shutting down"))));
  }
}
