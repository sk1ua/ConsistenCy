/**
 * `consistency review` — runs one real review on a local checkout.
 *
 * This is a second host for the existing review runtime, not a second review
 * implementation: it assembles the same `ReviewWorkflowDependencies` the daemon
 * assembles (`apps/api/src/jobs/worker.ts:89`) and calls the same
 * `createReviewRuntime`. Nothing about analysis, agents, or the kernel is
 * re-implemented here — the only new decisions are where configuration comes
 * from, how progress is reported, and which persistence backend is honest for a
 * one-shot process.
 */

import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { WORKING_TREE_REV, type ReviewReport, type Severity } from "@consistency/schema";
import { InMemoryJobQueue } from "@consistency/api/jobQueue";
import { DeterministicAnalyzer } from "@consistency/api/review/deterministic";
import { createContextBuilder } from "@consistency/api/review/context/contextRouter";
import { createReviewLLMProvider } from "@consistency/api/review/llm/factory";
import { createReviewRuntime } from "@consistency/api/review/workloadRuntime";
import {
  cliArtifactRoot,
  installRoot,
  loadCliConfig,
  resolveEngineRoot,
  resolveLeanEnabled,
  resolveLeanReviewer,
  resolveLeanMaintFilter,
  resolveLeanSecondSample,
  resolveLeanGeneralist,
  resolveLeanVote,
  resolveReportWithheld,
  resolveRangeReadFromGit,
  resolveCompactContext,
  resolveLeanConsistencyStrict,
  resolveLeanStrictMerge,
  resolveScoreRubricV2,
  resolveMemoryEnabled,
  resolvePythonPath
} from "./config";
import type { ReviewOptions } from "./args";
import {
  DEFAULT_THRESHOLD,
  collectConstraints,
  capabilityConstraints,
  exitCodeFor,
  renderReport,
  severityRank
} from "./report";
import { paletteFor, shouldUseColor, type Palette } from "./terminal";

export type CommandIO = {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** False when stderr is not a TTY, so piped runs stay quiet. */
  progress: boolean;
  palette: Palette;
  environment?: NodeJS.ProcessEnv;
};

export function createCommandIO(options: ReviewOptions, environment = process.env): CommandIO {
  const stdoutIsTty = Boolean((process.stdout as { isTTY?: boolean }).isTTY);
  const stderrIsTty = Boolean((process.stderr as { isTTY?: boolean }).isTTY);
  const useColor = shouldUseColor({ isTTY: stdoutIsTty }, environment, options.color);
  return {
    stdout: text => { process.stdout.write(text); },
    stderr: text => { process.stderr.write(text); },
    progress: stderrIsTty && options.json === false,
    palette: paletteFor(useColor),
    environment
  };
}

/** Thrown for conditions the user can fix by changing their invocation. */
export class ReviewSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewSetupError";
  }
}

function parseSeverity(value: string | undefined): Severity {
  if (value === undefined) return DEFAULT_THRESHOLD;
  if (value in severityRank) return value as Severity;
  throw new ReviewSetupError(`--threshold 只接受 critical|high|medium|low|info，收到 ${value}`);
}

/**
 * Cheap preflight so a misconfigured machine fails in milliseconds instead of
 * after the first LLM call. Deliberately checks only what would otherwise waste
 * a run: an unreadable repository and a missing provider.
 */
export function preflight(options: ReviewOptions, root: string): string[] {
  const warnings: string[] = [];
  const repoPath = resolve(options.repoPath);
  if (!existsSync(repoPath)) {
    throw new ReviewSetupError(`仓库路径不存在：${repoPath}`);
  }
  if (!statSync(repoPath).isDirectory()) {
    throw new ReviewSetupError(`--repo 需要指向目录：${repoPath}`);
  }
  // A checkout without .git still reviews, but only as opaque text: the
  // deterministic engine has nothing to diff against. Say so rather than
  // producing a report that looks like a normal review.
  if (!existsSync(join(repoPath, ".git"))) {
    warnings.push(`${repoPath} 看起来不是 git 仓库（缺 .git），区间 diff 与 git 证据不可用`);
  }
  const pythonPath = resolvePythonPath(loadCliConfig(root).config, root);
  // A bare command name is resolved through PATH by the spawn itself, so only
  // an absolute-looking path that is missing is worth warning about.
  if (/[\\/]/.test(pythonPath) && !existsSync(pythonPath)) {
    warnings.push(`配置的 Python 解释器不存在：${pythonPath}（确定性证据层不可用）`);
  }
  return warnings;
}

/**
 * The single place a report is turned into output + an exit code. Kept apart
 * from execution so the render path can be exercised without a provider.
 */
export function reportExitCode(
  report: ReviewReport,
  result: { capabilitiesIssued?: number; capabilitiesRevoked?: number },
  threshold: Severity
): 0 | 1 | 2 {
  return exitCodeFor(report, [...collectConstraints(report), ...capabilityConstraints(result)], threshold);
}

export async function runReview(options: ReviewOptions, io: CommandIO): Promise<0 | 1 | 2> {
  const root = installRoot();
  const { config } = loadCliConfig(root);
  const threshold = parseSeverity(options.threshold);

  for (const warning of preflight(options, root)) {
    io.stderr(`${io.palette.yellow("!")} ${warning}\n`);
  }

  const repoPath = resolve(options.repoPath);

  // Provider selection mirrors the daemon exactly: settings first, then a
  // per-run override. --model/--provider are useless without it, so failing
  // loudly here beats discovering mid-run that the flag was ignored.
  const provider = createReviewLLMProvider(config, {
    provider: options.provider,
    model: options.model
  });
  if (provider === undefined) {
    throw new ReviewSetupError(
      "没有可用的 LLM provider。先用 `npm run setup` 或 `npm run config -- set llm.provider <deepseek|openai|anthropic>` 配置；" +
      "产品运行时不允许 mock provider（AGENTS.md:8）。"
    );
  }

  // A one-shot process has nothing to read a database back from, and writing
  // the daemon's SQLite (jobs/reports tables) would leave rows nobody consumes.
  // The in-memory store satisfies the same ReviewJobStore interface, and the
  // report is taken from the run result rather than round-tripped through it.
  const jobStore = new InMemoryJobQueue();
  const artifacts = cliArtifactRoot(config, root);
  const workspaceRoot = join(artifacts, "workspaces");

  // Held in a local so it can be shut down on every exit path: the engine is a
  // child process, and leaving it idle keeps this one-shot host alive forever
  // after the report has already been printed.
  const analyzer = new DeterministicAnalyzer(
    resolvePythonPath(config, root),
    config.CONSISTENCY_ENGINE_MODULE,
    [],
    resolveEngineRoot(config, root)
  );

  const runtime = createReviewRuntime({
    contextBuilder: createContextBuilder({
      github: {} as never,
      ...(resolveRangeReadFromGit(io.environment ?? process.env) ? { rangeReadFromGit: true } : {})
    }),
    provider,
    jobStore,
    deterministicAnalyzer: analyzer,
    reportLanguage: options.reportLanguage ?? "zh-CN",
    maxFindingsPerSpecialist: config.CONSISTENCY_MAX_FINDINGS_PER_SPECIALIST,
    minFindingScore: config.CONSISTENCY_MIN_FINDING_SCORE,
    maxReportedFindings: config.CONSISTENCY_MAX_REPORTED_FINDINGS,
    maxFindingsPerFile: config.CONSISTENCY_MAX_FINDINGS_PER_FILE,
    deterministicScope: config.CONSISTENCY_DETERMINISTIC_SCOPE,
    memoryEnabled: resolveMemoryEnabled(options, io.environment ?? process.env),
    lean: resolveLeanEnabled(io.environment ?? process.env),
    leanReviewer: resolveLeanReviewer(io.environment ?? process.env),
    leanMaintFilter: resolveLeanMaintFilter(io.environment ?? process.env),
    leanSecondSample: resolveLeanSecondSample(io.environment ?? process.env),
    ...(resolveLeanGeneralist(io.environment ?? process.env) ? { leanGeneralist: true } : {}),
    ...(resolveLeanVote(io.environment ?? process.env) ? { leanVote: true } : {}),
    reportWithheld: resolveReportWithheld(io.environment ?? process.env),
    scoreRubricV2: resolveScoreRubricV2(io.environment ?? process.env),
    compactContext: resolveCompactContext(io.environment ?? process.env),
    leanConsistencyStrict: resolveLeanConsistencyStrict(io.environment ?? process.env),
    leanStrictMerge: resolveLeanStrictMerge(io.environment ?? process.env),
    workspaceRoot
  });

  const repositoryFullName = basename(repoPath);
  const range = options.baseRef !== undefined;
  const baseSha = range ? (options.baseRef as string) : "HEAD";
  const headSha = range ? (options.headRef as string) : WORKING_TREE_REV;
  const job = jobStore.enqueue({
    // The job kind vocabulary has no working-tree variant
    // (`apps/api/src/jobQueue.ts:22`), and production local reviews use
    // "pull_request" too (`apps/api/src/trigger/local.ts:134`).
    kind: "pull_request",
    repository: repositoryFullName,
    repoPath,
    accessMode: "local_git",
    baseSha,
    headSha,
    llmProvider: options.provider,
    llmModel: options.model,
    action: "cli_review"
  });

  // The store's report guard only accepts `running` or `awaiting_publish`
  // (`apps/api/src/jobQueue.ts:271`), and the daemon reaches `running` through
  // the worker's claim (`apps/api/src/jobs/worker.ts` -> `claimNextQueued()`).
  // This one-shot host has no worker, so it transitions the job itself;
  // without this the review runs to completion and then throws on persistence.
  if (jobStore.markRunning(job.id) === undefined) {
    throw new ReviewSetupError(`无法把审查任务置为 running（job ${job.id}）`);
  }

  const startedAt = Date.now();
  if (io.progress) {
    const scope = range ? `${options.baseRef}..${options.headRef}` : "工作区改动";
    io.stderr(`${io.palette.dim(`审查 ${repositoryFullName} · ${scope}`)}\n`);
  }

  // Field mapping copies `workflowInput()` (`apps/api/src/jobs/worker.ts:25-51`)
  // rather than spreading the job: the store calls the field `repository`, the
  // workflow calls it `repositoryFullName`, and spreading would silently pass
  // neither. The engine must be torn down on every path, including a throwing
  // review: it is a live child process, not a pooled resource.
  try {
    const result = await runtime.run({
      jobId: job.id,
      repositoryFullName,
      repoPath,
      accessMode: "local_git",
      baseSha,
      headSha,
      publicationPolicy: "disabled"
    });

    if (io.progress) {
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      io.stderr(`${io.palette.dim(`完成 · ${seconds}s · ${result.report.llmProvider ?? "?"}/${result.report.llmModel ?? "?"}`)}\n`);
    }

    if (options.json) {
      io.stdout(`${JSON.stringify(result.report, null, 2)}\n`);
    } else {
      io.stdout(`${renderReport(result.report, {
        palette: io.palette,
        verbose: options.verbose,
        limit: options.limit
      })}\n`);
    }

    return reportExitCode(result.report, result, threshold);
  } finally {
    // Engine teardown must never mask the review's own outcome.
    await analyzer.shutdown().catch(() => undefined);
  }
}
