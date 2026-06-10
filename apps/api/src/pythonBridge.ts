import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAnalysisResult, parsePRReport, type AnalysisResult, type PRReport } from "@consistency/schema";

const apiDir = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(apiDir, "../../..");
export const backendCli = resolve(repoRoot, "backend/cli.py");

export type ProcessResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

export type RunProcess = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
  }
) => Promise<ProcessResult>;

export type AnalyzeFileRequest = {
  currentFile: string;
  baselineFile: string;
};

export type PRReportRequest = {
  repoPath: string;
  baseSha: string;
  headSha: string;
  baselineCommits?: number;
  maxCommits?: number;
};

export class PythonBridgeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "PythonBridgeError";
  }
}

export const defaultRunProcess: RunProcess = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGTERM");
      reject(new PythonBridgeError("Python analysis timed out", "PYTHON_TIMEOUT"));
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
    });
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.on("error", error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new PythonBridgeError("Failed to start Python analysis", "PYTHON_SPAWN_FAILED", error));
    });
    child.on("close", exitCode => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ exitCode, stdout, stderr });
    });
  });

export function buildAnalyzeFileArgs(request: AnalyzeFileRequest): string[] {
  return [backendCli, "analyze-file", request.currentFile, request.baselineFile, "--json-output"];
}

export function buildPRReportArgs(request: PRReportRequest): string[] {
  return [
    backendCli,
    "pr-report",
    "--repo",
    request.repoPath,
    "--base",
    request.baseSha,
    "--head",
    request.headSha,
    "--baseline-commits",
    String(request.baselineCommits ?? 50),
    "--max-commits",
    String(request.maxCommits ?? 40),
    "--json-output"
  ];
}

export function parseAnalyzeFileRequest(input: unknown): AnalyzeFileRequest {
  if (!input || typeof input !== "object") {
    throw new PythonBridgeError("Request body must be a JSON object", "INVALID_REQUEST");
  }
  const body = input as Record<string, unknown>;
  if (typeof body.currentFile !== "string" || body.currentFile.length === 0) {
    throw new PythonBridgeError("currentFile is required", "INVALID_REQUEST");
  }
  if (typeof body.baselineFile !== "string" || body.baselineFile.length === 0) {
    throw new PythonBridgeError("baselineFile is required", "INVALID_REQUEST");
  }
  return {
    currentFile: body.currentFile,
    baselineFile: body.baselineFile
  };
}

export async function analyzeFileWithPython(
  request: AnalyzeFileRequest,
  options: {
    runProcess?: RunProcess;
    timeoutMs?: number;
  } = {}
): Promise<AnalysisResult> {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const result = await runProcess("python", buildAnalyzeFileArgs(request), {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: resolve(repoRoot, "backend")
    },
    timeoutMs: options.timeoutMs ?? 30_000
  });

  if (result.exitCode !== 0) {
    throw new PythonBridgeError("Python analysis failed", "PYTHON_EXIT_NONZERO", {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 4000)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new PythonBridgeError("Python analysis returned invalid JSON", "PYTHON_INVALID_JSON", {
      stdout: result.stdout.slice(0, 1000),
      error
    });
  }

  try {
    return parseAnalysisResult(parsed);
  } catch (error) {
    throw new PythonBridgeError("Python analysis JSON failed schema validation", "PYTHON_SCHEMA_INVALID", error);
  }
}

export async function buildPRReportWithPython(
  request: PRReportRequest,
  options: {
    runProcess?: RunProcess;
    timeoutMs?: number;
  } = {}
): Promise<PRReport> {
  const runProcess = options.runProcess ?? defaultRunProcess;
  const result = await runProcess("python", buildPRReportArgs(request), {
    cwd: repoRoot,
    env: {
      ...process.env,
      PYTHONPATH: resolve(repoRoot, "backend")
    },
    timeoutMs: options.timeoutMs ?? 120_000
  });

  if (result.exitCode !== 0) {
    throw new PythonBridgeError("Python PR report failed", "PYTHON_PR_REPORT_EXIT_NONZERO", {
      exitCode: result.exitCode,
      stderr: result.stderr.slice(0, 4000)
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new PythonBridgeError("Python PR report returned invalid JSON", "PYTHON_PR_REPORT_INVALID_JSON", {
      stdout: result.stdout.slice(0, 1000),
      error
    });
  }

  try {
    return parsePRReport(parsed);
  } catch (error) {
    throw new PythonBridgeError("Python PR report JSON failed schema validation", "PYTHON_PR_REPORT_SCHEMA_INVALID", error);
  }
}
