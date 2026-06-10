import { createHmac, timingSafeEqual } from "node:crypto";
import type { InMemoryJobQueue, ReviewJob } from "./jobQueue";

export class WebhookError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number
  ) {
    super(message);
    this.name = "WebhookError";
  }
}

export type WebhookHeaders = Record<string, string | string[] | undefined>;

export type WebhookResult = {
  status: "ignored" | "enqueued";
  event: string;
  deliveryId: string;
  job?: ReviewJob;
  reason?: string;
};

function headerValue(headers: WebhookHeaders, name: string): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(direct)) {
    return direct[0];
  }
  if (typeof direct === "string") {
    return direct;
  }

  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  const value = found?.[1];
  if (Array.isArray(value)) {
    return value[0];
  }
  return typeof value === "string" ? value : undefined;
}

export function verifyGitHubSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const signatureBuffer = Buffer.from(signature, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (signatureBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return timingSafeEqual(signatureBuffer, expectedBuffer);
}

function payloadObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object") {
    throw new WebhookError("Webhook payload must be a JSON object", "INVALID_PAYLOAD", 400);
  }
  return input as Record<string, unknown>;
}

function nestedRecord(input: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = input[key];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringField(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberField(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

function installationId(payload: Record<string, unknown>): number | undefined {
  return numberField(nestedRecord(payload, "installation"), "id");
}

function repositoryName(payload: Record<string, unknown>): string | undefined {
  return stringField(nestedRecord(payload, "repository"), "full_name");
}

function enqueuePullRequest(
  payload: Record<string, unknown>,
  deliveryId: string,
  jobs: InMemoryJobQueue
): WebhookResult {
  const action = stringField(payload, "action");
  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action ?? "")) {
    return { status: "ignored", event: "pull_request", deliveryId, reason: `ignored action ${action ?? "unknown"}` };
  }

  const pullRequest = nestedRecord(payload, "pull_request");
  const base = nestedRecord(pullRequest, "base");
  const head = nestedRecord(pullRequest, "head");
  const repository = repositoryName(payload);
  const pullRequestNumber = numberField(pullRequest, "number");
  const baseSha = stringField(base, "sha");
  const headSha = stringField(head, "sha");

  if (!repository || !pullRequestNumber || !baseSha || !headSha) {
    throw new WebhookError("Pull request webhook is missing required fields", "INVALID_PULL_REQUEST", 400);
  }

  const job = jobs.enqueue({
    kind: "pull_request",
    deliveryId,
    repository,
    pullRequestNumber,
    baseSha,
    headSha,
    installationId: installationId(payload)
  });

  return { status: "enqueued", event: "pull_request", deliveryId, job };
}

function enqueuePush(payload: Record<string, unknown>, deliveryId: string, jobs: InMemoryJobQueue): WebhookResult {
  const ref = stringField(payload, "ref");
  if (!ref?.endsWith("/main") && !ref?.endsWith("/master")) {
    return { status: "ignored", event: "push", deliveryId, reason: `ignored ref ${ref ?? "unknown"}` };
  }

  const repository = repositoryName(payload);
  const headSha = stringField(payload, "after");
  if (!repository || !headSha) {
    throw new WebhookError("Push webhook is missing required fields", "INVALID_PUSH", 400);
  }

  const job = jobs.enqueue({
    kind: "push",
    deliveryId,
    repository,
    headSha,
    ref,
    installationId: installationId(payload)
  });

  return { status: "enqueued", event: "push", deliveryId, job };
}

export function processGitHubWebhook(options: {
  headers: WebhookHeaders;
  body: Buffer;
  secret?: string;
  jobs: InMemoryJobQueue;
}): WebhookResult {
  const event = headerValue(options.headers, "x-github-event");
  const deliveryId = headerValue(options.headers, "x-github-delivery");
  if (!event || !deliveryId) {
    throw new WebhookError("Missing GitHub webhook headers", "MISSING_WEBHOOK_HEADERS", 400);
  }

  if (options.secret) {
    const signature = headerValue(options.headers, "x-hub-signature-256");
    if (!verifyGitHubSignature(options.body, signature, options.secret)) {
      throw new WebhookError("Invalid GitHub webhook signature", "INVALID_SIGNATURE", 401);
    }
  }

  let parsed: unknown;
  try {
    parsed = options.body.length > 0 ? JSON.parse(options.body.toString("utf8")) : {};
  } catch {
    throw new WebhookError("Webhook body must be valid JSON", "INVALID_JSON", 400);
  }

  const payload = payloadObject(parsed);
  if (event === "ping") {
    return { status: "ignored", event, deliveryId, reason: "pong" };
  }
  if (event === "pull_request") {
    return enqueuePullRequest(payload, deliveryId, options.jobs);
  }
  if (event === "push") {
    return enqueuePush(payload, deliveryId, options.jobs);
  }

  return { status: "ignored", event, deliveryId, reason: `unsupported event ${event}` };
}
