import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { WORKING_TREE_REV, isSecretPath, notebookCitationSchema, type NotebookCitation, type NotebookSource, type ReviewSnapshot } from "@consistency/schema";
import type { ReviewFinding } from "@consistency/schema";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import { sanitizePublicError } from "../security/redact";
import { snapshotIndexHeadSha, type NotebookStore, type SnapshotIndex } from "./store";
import { normaliseSnapshotPath, readSnapshotText, snapshotPathIsIndexed, snapshotRoot } from "./indexer";

const execFileAsync = promisify(execFile);

export type NotebookSourceSelection = {
  job: ReviewJob;
  source: NotebookSource;
  index?: SnapshotIndex;
  /**
   * Review-time snapshot for working-tree reviews (audit P1-06③). Present
   * only for jobs captured after snapshots existed; content reads prefer it
   * so Notebook citations keep pointing at what the review actually saw.
   */
  reviewSnapshot?: ReviewSnapshot;
};

export type RepositorySearchMatch = {
  file: string;
  score: number;
  content: string;
  citation: NotebookCitation;
};

export type NotebookToolContext = {
  notebookId: string;
  notebookStore: NotebookStore;
  jobs: ReviewJobStore;
  selections: NotebookSourceSelection[];
};

export class NotebookToolError extends Error {
  constructor(message: string, public readonly code = "NOTEBOOK_TOOL_ERROR") {
    super(message);
    this.name = "NotebookToolError";
  }
}

function citationFor(
  selection: NotebookSourceSelection,
  input: Omit<NotebookCitation, "id" | "repository" | "pullRequestNumber" | "jobId" | "headSha">
): NotebookCitation {
  // excerpt 必须非空：空文件或行区间超出时回退到文件路径
  const excerpt = input.excerpt.trim().length > 0 ? input.excerpt : input.file;
  const pullRequestNumber = selection.job.pullRequestNumber;
  return notebookCitationSchema.parse({
    id: `citation_${randomUUID()}`,
    repository: selection.job.repository,
    ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
    jobId: selection.job.id,
    headSha: selection.source.headSha,
    ...input,
    excerpt
  });
}

export function selectNotebookSources(
  notebookId: string,
  notebookStore: NotebookStore,
  jobs: ReviewJobStore,
  sourceJobIds?: string[]
): NotebookSourceSelection[] {
  const notebook = notebookStore.get(notebookId);
  if (!notebook) throw new NotebookToolError("Notebook not found", "NOTEBOOK_NOT_FOUND");
  const requested = sourceJobIds?.length
    ? [...new Set(sourceJobIds)]
    : notebook.sources.slice().sort((left, right) => right.headSha.localeCompare(left.headSha)).slice(0, 1).map(source => source.jobId);
  if (requested.length === 0) throw new NotebookToolError("Notebook has no review sources", "NOTEBOOK_SOURCE_MISSING");

  return requested.map(jobId => {
    const job = jobs.get(jobId);
    const source = notebookStore.getSourceForJob(notebookId, jobId);
    if (!job || !source) throw new NotebookToolError(`Review source ${jobId} is not part of this Notebook`, "NOTEBOOK_SOURCE_MISMATCH");
    if (job.repository !== notebook.repository || source.repository !== job.repository || source.headSha !== job.headSha || source.baseSha !== job.baseSha) {
      throw new NotebookToolError("Notebook source SHA or repository boundary does not match the selected job", "NOTEBOOK_SOURCE_MISMATCH");
    }
    return {
      job,
      source,
      index: notebookStore.getSnapshotIndex(job.repository, snapshotIndexHeadSha(job, source)),
      ...(job.accessMode === "local_git" && job.headSha === WORKING_TREE_REV
        ? { reviewSnapshot: jobs.getReviewSnapshot(jobId) }
        : {})
    };
  });
}

export function citationsFromFindings(selection: NotebookSourceSelection): NotebookCitation[] {
  const findings = selection.job.result?.findings ?? [];
  const exact = findings.flatMap(finding => {
    if (finding.startLine === undefined || finding.endLine === undefined) return [];
    return [citationFor(selection, {
      file: finding.file,
      startLine: finding.startLine,
      endLine: finding.endLine,
      excerpt: finding.evidence,
      kind: "finding"
    })];
  });
  if (exact.length > 0) return exact;

  // Hypothesis findings may not carry exact lines. If the deterministic Evidence Pack
  // records a primary risk region, preserve that bounded region instead of inventing
  // a line for the finding itself.
  return (selection.job.result?.retrieval?.packs ?? []).flatMap(pack => {
    const region = String(pack.query.metadata.primary_risk_region ?? "").match(/L(\d+)(?:-L?(\d+))?/i);
    if (!region) return [];
    const startLine = Number(region[1]);
    const endLine = Number(region[2] ?? region[1]);
    const excerpt = pack.selected_evidence[0]?.candidate.content ?? pack.file;
    return [citationFor(selection, {
      file: pack.file,
      startLine,
      endLine,
      excerpt,
      kind: "evidence"
    })];
  });
}

/**
 * Read a file's content for a selection. Working-tree reviews with a persisted
 * snapshot resolve the REVIEW-TIME content for changed files (audit P1-06③);
 * live-checkout indexes resolve the pinned index-time bytes. Everything else
 * reads the indexed snapshot from disk as before. The snapshot contents are the
 * context loader's already-redacted projection.
 */
function readSelectionText(selection: NotebookSourceSelection, file: string, maxBytes = 64 * 1024): string {
  const path = normaliseSnapshotPath(file);
  const reviewTime = selection.reviewSnapshot?.fileContents?.[path];
  if (reviewTime !== undefined) return reviewTime.slice(0, maxBytes);
  const entry = selection.index?.manifest.find(item => item.path === path);
  // The index-time pin is the durable content for indexes over a live checkout
  // (working tree or repoPath range review): live disk after capture is a
  // different tree. Legacy indexes without a pin fall back to the 2KB preview.
  const pinned = typeof entry?.content === "string"
    ? entry.content
    : selection.job.headSha === WORKING_TREE_REV ? entry?.preview : undefined;
  if (typeof pinned === "string") return pinned.slice(0, maxBytes);
  return readSnapshotText(selection.index!, path, maxBytes);
}

export function searchRepository(selection: NotebookSourceSelection, query: string, maxResults = 6): RepositorySearchMatch[] {
  if (!selection.index) return [];
  const tokens = query.toLowerCase().split(/[^a-zA-Z0-9_./-]+/).filter(token => token.length >= 2).slice(0, 10);
  const candidates: RepositorySearchMatch[] = [];
  for (const entry of selection.index.manifest.slice(0, 2_000)) {
    const metadata = [entry.path, ...(entry.symbols ?? []), ...(entry.imports ?? [])].join(" ").toLowerCase();
    let score = tokens.some(token => metadata.includes(token)) ? 4 : 0;
    let content = "";
    try {
      content = readSelectionText(selection, entry.path, 24 * 1024);
    } catch {
      continue;
    }
    const lower = content.toLowerCase();
    for (const token of tokens) {
      if (lower.includes(token)) score += 2;
      if (metadata.includes(token)) score += 1;
    }
    if (score === 0 && tokens.length > 0) continue;
    const firstToken = tokens.find(token => lower.includes(token));
    const line = firstToken ? lower.slice(0, lower.indexOf(firstToken)).split("\n").length : 1;
    const excerptLines = content.split("\n");
    const start = Math.max(1, line);
    const end = Math.min(excerptLines.length, start + 24);
    const excerpt = { content: excerptLines.slice(start - 1, end).join("\n"), startLine: start, endLine: end };
    candidates.push({
      file: entry.path,
      score: score || 1,
      content: excerpt.content,
      citation: citationFor(selection, {
        file: entry.path,
        startLine: excerpt.startLine,
        endLine: excerpt.endLine,
        excerpt: excerpt.content,
        kind: "file"
      })
    });
  }

  if (candidates.length === 0) {
    for (const entry of selection.index.manifest.slice(0, maxResults)) {
      try {
        const content = readSelectionText(selection, entry.path, 24 * 1024);
        const excerptLines = content.split("\n");
        const end = Math.max(1, Math.min(excerptLines.length, 24));
        const excerpt = { content: excerptLines.slice(0, end).join("\n"), startLine: 1, endLine: end };
        candidates.push({
          file: entry.path,
          score: 1,
          content: excerpt.content,
          citation: citationFor(selection, {
            file: entry.path,
            startLine: excerpt.startLine,
            endLine: excerpt.endLine,
            excerpt: excerpt.content,
            kind: "file"
          })
        });
      } catch {
        // Skip files that became unavailable while an index is being read.
      }
    }
  }
  return candidates.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file)).slice(0, maxResults);
}

export function readRepositoryFile(selection: NotebookSourceSelection, file: string, startLine = 1, endLine = 80): { content: string; citation: NotebookCitation } {
  if (!selection.index || !snapshotPathIsIndexed(selection.index, normaliseSnapshotPath(file))) {
    throw new NotebookToolError("The requested file is not available in this SHA-bound snapshot", "FILE_NOT_INDEXED");
  }
  const lines = readSelectionText(selection, file).split("\n");
  const start = Math.max(1, startLine);
  if (start > lines.length) {
    // Read caps (64KB per file) bound what a pinned snapshot can serve. Asking
    // beyond it is a labeled boundary, never a malformed citation or a silent
    // summary of bytes the snapshot does not hold.
    throw new NotebookToolError(
      `The requested lines are outside the pinned snapshot content for ${normaliseSnapshotPath(file)} (${lines.length} pinned lines available)`,
      "LINES_NOT_AVAILABLE"
    );
  }
  const end = Math.min(lines.length, Math.max(start, endLine));
  const content = lines.slice(start - 1, end).join("\n");
  return {
    content,
    citation: citationFor(selection, {
      file: normaliseSnapshotPath(file),
      startLine: start,
      endLine: end,
      excerpt: content,
      kind: "file"
    })
  };
}

export async function getDiff(selection: NotebookSourceSelection): Promise<{ content: string; citation?: NotebookCitation }> {
  if (!selection.index) throw new NotebookToolError("The PR snapshot is not indexed yet", "SNAPSHOT_NOT_READY");

  // Working-tree reviews have no head SHA to diff against; the persisted
  // review snapshot IS the review-time diff (audit P1-06③). Legacy jobs
  // captured before snapshots existed fail honestly below.
  if (selection.job.headSha === WORKING_TREE_REV) {
    if (!selection.reviewSnapshot) {
      throw new NotebookToolError("This working-tree review predates review snapshots; its diff is no longer resolvable", "SNAPSHOT_NOT_CAPTURED");
    }
    const content = selection.reviewSnapshot.files
      .map(file => `--- a/${file.previousPath ?? file.path}\n+++ b/${file.path}\n`
        + file.hunks.map(hunk => `${hunk.header}\n${hunk.content}`).join("\n"))
      .join("\n");
    return { content: content.slice(0, 512 * 1024) };
  }

  if (!/^[0-9a-f]{7,64}$/i.test(selection.job.baseSha ?? "") || !/^[0-9a-f]{7,64}$/i.test(selection.job.headSha ?? "")) {
    throw new NotebookToolError("The selected job does not contain valid Git object IDs", "INVALID_SHA");
  }
  // Three-dot (merge-base) semantics — the same range the review itself and
  // the Diff view used; two-dot here used to show a different diff than the
  // report for the same job.
  const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", `${selection.job.baseSha}...${selection.job.headSha}`, "--"], {
    cwd: snapshotRoot(selection.index),
    windowsHide: true,
    maxBuffer: 512 * 1024,
    encoding: "utf8"
  });
  const content = String(result.stdout).slice(0, 512 * 1024);
  return { content };
}

/**
 * A base read interpolates the path into a git tree spec (`<sha>:<path>`).
 * Only a repository-relative, NUL-free path may reach git, so a caller-supplied
 * path can never widen the read past the pinned snapshot tree.
 */
function repositoryRelativePath(path: string): string {
  const normalised = normaliseSnapshotPath(path);
  if (
    normalised.length === 0
    || normalised.startsWith("/")
    || /^[A-Za-z]:/.test(normalised)
    || normalised.split("/").includes("..")
    || normalised.includes("\0")
  ) {
    throw new NotebookToolError("The requested file must be a repository-relative path", "FILE_NOT_INDEXED");
  }
  return normalised;
}

export async function getBaseFile(selection: NotebookSourceSelection, file: string): Promise<{ content: string; citation: NotebookCitation }> {
  const path = normaliseSnapshotPath(file);
  const pinnedBase = selection.reviewSnapshot?.baseFileContents?.[path];
  if (pinnedBase !== undefined) {
    const content = pinnedBase.slice(0, 256 * 1024);
    return {
      content,
      citation: citationFor(selection, {
        file: path,
        startLine: 1,
        endLine: Math.max(1, content.split("\n").length),
        excerpt: content.slice(0, 8_000),
        kind: "diff"
      })
    };
  }
  if (!selection.index) {
    throw new NotebookToolError("The base file is not available in the SHA-bound snapshot", "FILE_NOT_INDEXED");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(selection.job.baseSha ?? "")) {
    throw new NotebookToolError("The selected job does not contain a valid base SHA", "INVALID_SHA");
  }
  const basePath = repositoryRelativePath(path);
  if (isSecretPath(basePath)) {
    throw new NotebookToolError("Secret-path files are not available in Notebook context", "FILE_NOT_INDEXED");
  }
  // The base side resolves from the pinned git object, NEVER from the live
  // checkout: a path the base revision never had (added or renamed at head) is
  // reported missing, while a path deleted at head still yields its reviewed
  // base bytes.
  let stdout: string;
  try {
    const result = await execFileAsync("git", ["show", `${selection.job.baseSha}:${basePath}`], {
      cwd: snapshotRoot(selection.index),
      windowsHide: true,
      maxBuffer: 256 * 1024,
      encoding: "utf8"
    });
    stdout = String(result.stdout);
  } catch (error) {
    const failure = error as { code?: unknown; stderr?: unknown };
    if (failure.code === "ENOENT") {
      throw new NotebookToolError("Git is not available to resolve the pinned base snapshot", "BASE_READ_FAILED");
    }
    if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      throw new NotebookToolError("The base file is larger than the Notebook read limit", "FILE_TOO_LARGE");
    }
    // "The base side never had this path" (added or renamed at head) is a
    // different fact from "the pinned base blob could not be read" — a shallow
    // or partial clone that cannot fetch it must not be reported as missing.
    const stderr = String(failure.stderr ?? "");
    if (/does not exist in|exists on disk, but not in|invalid object name|bad revision|unknown revision/i.test(stderr)) {
      throw new NotebookToolError(
        `The reviewed base snapshot ${selection.job.baseSha} does not contain ${basePath}`,
        "FILE_NOT_IN_BASE"
      );
    }
    throw new NotebookToolError(
      `The pinned base snapshot ${selection.job.baseSha} could not be read for ${basePath}: ${sanitizePublicError(stderr.trim() || "git show failed")}`,
      "BASE_READ_FAILED"
    );
  }
  if (stdout.includes("\0")) {
    throw new NotebookToolError("Binary files are not available in Notebook context", "FILE_NOT_INDEXED");
  }
  const content = stdout.slice(0, 256 * 1024);
  return {
    content,
    citation: citationFor(selection, {
      file: path,
      startLine: 1,
      endLine: Math.max(1, content.split("\n").length),
      excerpt: content.slice(0, 8_000),
      kind: "diff"
    })
  };
}

export function getEvidencePack(selection: NotebookSourceSelection): unknown {
  return selection.job.result?.retrieval ?? { packs: [], summary: "No deterministic Evidence Pack is persisted for this source." };
}

export function getReviewFindings(selection: NotebookSourceSelection): ReviewFinding[] {
  return selection.job.result?.findings ?? [];
}

export function generatePatchRequest(selection: NotebookSourceSelection, file: string, instruction: string): {
  repository: string;
  pullRequestNumber?: number;
  headSha: string;
  file: string;
  instruction: string;
  writesWorkspace: false;
} {
  if (!selection.index || !snapshotPathIsIndexed(selection.index, normaliseSnapshotPath(file))) {
    throw new NotebookToolError("Patch suggestions require a file present in the selected SHA", "FILE_NOT_INDEXED");
  }
  const pullRequestNumber = selection.job.pullRequestNumber;
  return {
    repository: selection.job.repository,
    ...(pullRequestNumber !== undefined ? { pullRequestNumber } : {}),
    headSha: selection.source.headSha,
    file: normaliseSnapshotPath(file),
    instruction: instruction.slice(0, 2_000),
    writesWorkspace: false
  };
}

export function dedupeCitations(citations: NotebookCitation[]): NotebookCitation[] {
  const seen = new Set<string>();
  return citations.filter(citation => {
    const key = `${citation.repository}:${citation.pullRequestNumber ?? "local"}:${citation.headSha}:${citation.file}:${citation.startLine}:${citation.endLine}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateNotebookAnswer(answer: string, citations: NotebookCitation[], selections: NotebookSourceSelection[]): { ok: true } | { ok: false; reason: string } {
  const allowed = new Set(selections.map(selection => `${selection.job.id}:${selection.source.headSha}`));
  if (citations.some(citation => !allowed.has(`${citation.jobId}:${citation.headSha}`))) {
    return { ok: false, reason: "A citation points outside the selected repository/PR/SHA boundary." };
  }
  if (!answer.trim()) return { ok: false, reason: "Notebook answer is empty." };
  if (citations.length === 0 && !answer.includes("当前上下文无法确认")) {
    return { ok: false, reason: "Code-grounded answers require at least one source citation." };
  }
  return { ok: true };
}
