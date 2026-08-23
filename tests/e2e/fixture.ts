import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, type APIRequestContext } from "@playwright/test";

const apiUrl = "http://127.0.0.1:3001";
const apiToken = "e2e-api-token";
const desktopControlToken = "e2e-desktop-control-token";
export const e2eApiHeaders = { Authorization: `Bearer ${apiToken}` };

type RegisteredRepositoryResponse = {
  readonly repository: {
    readonly id: string;
  };
};

type LocalReviewResponse = {
  readonly jobId: string;
};

function isRegisteredRepositoryResponse(value: unknown): value is RegisteredRepositoryResponse {
  if (typeof value !== "object" || value === null || !("repository" in value)) return false;
  const { repository } = value;
  return typeof repository === "object" && repository !== null && "id" in repository && typeof repository.id === "string";
}

function isLocalReviewResponse(value: unknown): value is LocalReviewResponse {
  return typeof value === "object" && value !== null && "jobId" in value && typeof value.jobId === "string";
}

export function createE2eGitFixture(name = "e2e-fixture"): string {
  const root = process.env.CONSISTENCY_E2E_ROOT ?? join(tmpdir(), "consistency-e2e");
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: "pipe" });
  git(["init", "-q"]);
  git(["config", "user.email", "e2e@consistency.local"]);
  git(["config", "user.name", "ConsistenCy E2E"]);
  writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
  git(["add", "src.ts"]);
  git(["commit", "-q", "-m", "initial commit"]);
  writeFileSync(join(repo, "src.ts"), "export const a = 2;\nexport const b = 3;\n");
  return repo;
}

export async function createE2eLocalReview(request: APIRequestContext, name: string): Promise<{ readonly repositoryId: string; readonly jobId: string }> {
  const path = createE2eGitFixture(name);
  const registration = await request.post(`${apiUrl}/internal/repositories/local`, {
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "x-consistency-desktop-control": desktopControlToken
    },
    data: { path, displayName: name }
  });
  expect(registration.status()).toBe(201);
  const registrationBody: unknown = await registration.json();
  if (!isRegisteredRepositoryResponse(registrationBody)) throw new Error("Expected local repository registration to return an opaque repository ID");

  const repositoryId = registrationBody.repository.id;
  const review = await request.post(`${apiUrl}/reviews/local`, {
    headers: e2eApiHeaders,
    data: { repositoryId }
  });
  expect(review.status()).toBe(202);
  const reviewBody: unknown = await review.json();
  if (!isLocalReviewResponse(reviewBody)) throw new Error("Expected local review to return a job ID");

  return { repositoryId, jobId: reviewBody.jobId };
}
