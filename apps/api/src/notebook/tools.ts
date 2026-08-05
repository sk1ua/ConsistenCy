import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { notebookCitationSchema, type NotebookCitation, type NotebookSource } from "@consistency/schema";
import type { ReviewFinding } from "@consistency/schema";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";
import type { NotebookStore, SnapshotIndex } from "./store";
import { normaliseSnapshotPath, readSnapshotLines, readSnapshotText, snapshotPathIsIndexed, snapshotRoot } from "./indexer";

const execFileAsync = promisify(execFile);

export type NotebookSourceSelection = {
  job: ReviewJob;
  source: NotebookSource;
  index?: SnapshotIndex;
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
  return notebookCitationSchema.parse({
    id: `citation_${randomUUID()}`,
    repository: selection.job.repository,
    pullRequestNumber: selection.job.pullRequestNumber,
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
      index: notebookStore.getSnapshotIndex(job.repository, source.headSha)
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

export function searchRepository(selection: NotebookSourceSelection, query: string, maxResults = 6): RepositorySearchMatch[] {
  if (!selection.index) return [];
  const tokens = query.toLowerCase().split(/[^a-zA-Z0-9_./-]+/).filter(token => token.length >= 2).slice(0, 10);
  const candidates: RepositorySearchMatch[] = [];
  for (const entry of selection.index.manifest.slice(0, 2_000)) {
    const metadata = [entry.path, ...(entry.symbols ?? []), ...(entry.imports ?? [])].join(" ").toLowerCase();
    let score = tokens.some(token => metadata.includes(token)) ? 4 : 0;
    let content = "";
    try {
      content = readSnapshotText(selection.index, entry.path, 24 * 1024);
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
    const excerpt = readSnapshotLines(selection.index, entry.path, line, line + 24);
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
        const excerpt = readSnapshotLines(selection.index, entry.path, 1, 24);
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
  const excerpt = readSnapshotLines(selection.index, file, startLine, Math.min(endLine, startLine + 119));
  return {
    content: excerpt.content,
    citation: citationFor(selection, {
      file: normaliseSnapshotPath(file),
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
      excerpt: excerpt.content,
      kind: "file"
    })
  };
}

export async function getDiff(selection: NotebookSourceSelection): Promise<{ content: string; citation?: NotebookCitation }> {
  if (!selection.index) throw new NotebookToolError("The PR snapshot is not indexed yet", "SNAPSHOT_NOT_READY");
  if (!/^[0-9a-f]{7,64}$/i.test(selection.job.baseSha ?? "") || !/^[0-9a-f]{7,64}$/i.test(selection.job.headSha ?? "")) {
    throw new NotebookToolError("The selected job does not contain valid Git object IDs", "INVALID_SHA");
  }
  const result = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", `${selection.job.baseSha}..${selection.job.headSha}`, "--"], {
    cwd: snapshotRoot(selection.index),
    windowsHide: true,
    maxBuffer: 512 * 1024,
    encoding: "utf8"
  });
  const content = String(result.stdout).slice(0, 512 * 1024);
  return { content };
}

export async function getBaseFile(selection: NotebookSourceSelection, file: string): Promise<{ content: string; citation: NotebookCitation }> {
  if (!selection.index || !snapshotPathIsIndexed(selection.index, normaliseSnapshotPath(file))) {
    throw new NotebookToolError("The base file is not available in the SHA-bound snapshot", "FILE_NOT_INDEXED");
  }
  if (!/^[0-9a-f]{7,64}$/i.test(selection.job.baseSha ?? "")) {
    throw new NotebookToolError("The selected job does not contain a valid base SHA", "INVALID_SHA");
  }
  const path = normaliseSnapshotPath(file);
  const result = await execFileAsync("git", ["show", `${selection.job.baseSha}:${path}`], {
    cwd: snapshotRoot(selection.index),
    windowsHide: true,
    maxBuffer: 256 * 1024,
    encoding: "utf8"
  });
  const content = String(result.stdout).slice(0, 256 * 1024);
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
  pullRequestNumber: number;
  headSha: string;
  file: string;
  instruction: string;
  writesWorkspace: false;
} {
  if (!selection.index || !snapshotPathIsIndexed(selection.index, normaliseSnapshotPath(file))) {
    throw new NotebookToolError("Patch suggestions require a file present in the selected SHA", "FILE_NOT_INDEXED");
  }
  return {
    repository: selection.job.repository,
    pullRequestNumber: selection.job.pullRequestNumber!,
    headSha: selection.source.headSha,
    file: normaliseSnapshotPath(file),
    instruction: instruction.slice(0, 2_000),
    writesWorkspace: false
  };
}

export function dedupeCitations(citations: NotebookCitation[]): NotebookCitation[] {
  const seen = new Set<string>();
  return citations.filter(citation => {
    const key = `${citation.repository}:${citation.pullRequestNumber}:${citation.headSha}:${citation.file}:${citation.startLine}:${citation.endLine}`;
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
