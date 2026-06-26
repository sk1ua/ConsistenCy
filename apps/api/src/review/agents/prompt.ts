import type { PRReviewContext } from "@consistency/schema";
import type { ExecutableReviewAgent } from "./types";

const AGENT_FOCUS: Record<ExecutableReviewAgent, string> = {
  Security: "webhook validation, leaked credentials, path traversal, command injection, CORS, authorization, arbitrary file reads, and GitHub token misuse",
  Correctness: "state transitions, error paths, webhook event boundaries, job execution, persistence, and failures after report generation",
  Maintainability: "module ownership, duplicated types, route complexity, agent interfaces, schema reuse, and coupling",
  Test: "specific missing tests for webhook signatures, delivery deduplication, SQLite, workflow behavior, mock providers, path safety, and UI smoke coverage",
  Style: "naming, API response consistency, error shape consistency, frontend organization, and file naming"
};

function numbered(content: string): string {
  return content.split(/\r?\n/).map((line, index) => `${index + 1}: ${line}`).join("\n");
}

export function buildAgentPrompt(agent: ExecutableReviewAgent, context: PRReviewContext): {
  systemPrompt: string;
  userPrompt: string;
} {
  const files = Object.entries(context.fileContents)
    .map(([path, content]) => `FILE ${path}\n${numbered(content)}`)
    .join("\n\n")
    .slice(0, 140_000);
  const metadata = Object.entries(context.projectMetadata)
    .map(([path, content]) => `METADATA ${path}\n${content}`)
    .join("\n\n")
    .slice(0, 30_000);
  return {
    systemPrompt: [
      `You are the ConsistenCy ${agent} review agent.`,
      `Focus only on ${AGENT_FOCUS[agent]}.`,
      "Do not invent findings. A confirmed finding requires direct evidence, a repository-relative file path, and exact line numbers visible in the supplied file content.",
      "Use likely only when evidence is strong but incomplete. Use hypothesis when uncertainty remains and explain that uncertainty.",
      "Return no finding when the supplied context does not prove a problem."
    ].join(" "),
    userPrompt: [
      `Repository: ${context.repositoryFullName}`,
      `Pull request: #${context.pullRequestNumber}`,
      `Base/head: ${context.baseSha}..${context.headSha}`,
      `Changed files: ${context.changedFiles.map(file => `${file.path} (${file.status})`).join(", ")}`,
      `DIFF\n${context.diff.slice(0, 80_000)}`,
      files,
      metadata
    ].join("\n\n")
  };
}
