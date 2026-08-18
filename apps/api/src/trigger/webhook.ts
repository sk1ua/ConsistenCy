import { z } from "zod";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ReviewJob, ReviewJobStore } from "../jobQueue";

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
  status: "ignored" | "enqueued" | "duplicate";
  event: string;
  deliveryId: string;
  job?: ReviewJob;
  reason?: string;
};

export function headerValue(headers: WebhookHeaders, name: string): string | undefined {
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

const pullRequestPayloadSchema = z.object({
  action: z.string(),
  pull_request: z.object({
    number: z.number(),
    base: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{7,64}$/i) }),
  }),
  repository: z.object({ full_name: z.string() }),
  installation: z.object({ id: z.number() }),
  sender: z.object({ login: z.string() }),
});

function enqueuePullRequest(
  payload: unknown,
  deliveryId: string,
  jobs: ReviewJobStore,
  llmConfigured = true
): WebhookResult {
  const parseResult = pullRequestPayloadSchema.safeParse(payload);
  if (!parseResult.success) {
    // If it is just a ping or something else, or missing action, we can check basic action string before failing
    const basicActionSchema = z.object({ action: z.string().optional() }).passthrough();
    const basicParsed = basicActionSchema.safeParse(payload);
    const action = basicParsed.success ? basicParsed.data.action : undefined;

    if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(action ?? "")) {
      const acceptance = jobs.recordWebhookDelivery({
        deliveryId,
        event: "pull_request",
        action,
        status: "ignored"
      });
      return acceptance.duplicate
        ? { status: "duplicate", event: "pull_request", deliveryId, reason: "delivery already processed" }
        : { status: "ignored", event: "pull_request", deliveryId, reason: `ignored action ${action ?? "unknown"}` };
    }

    throw new WebhookError("Pull request webhook is missing required fields", "INVALID_PULL_REQUEST", 400);
  }

  const data = parseResult.data;

  if (!["opened", "reopened", "synchronize", "ready_for_review"].includes(data.action)) {
    const acceptance = jobs.recordWebhookDelivery({
      deliveryId,
      event: "pull_request",
      action: data.action,
      status: "ignored"
    });
    return acceptance.duplicate
      ? { status: "duplicate", event: "pull_request", deliveryId, reason: "delivery already processed" }
      : { status: "ignored", event: "pull_request", deliveryId, reason: `ignored action ${data.action}` };
  }

  if (!llmConfigured) {
    const acceptance = jobs.recordWebhookDelivery({
      deliveryId,
      event: "pull_request",
      action: data.action,
      status: "ignored"
    });
    return acceptance.duplicate
      ? { status: "duplicate", event: "pull_request", deliveryId, reason: "delivery already processed" }
      : { status: "ignored", event: "pull_request", deliveryId, reason: "llm provider not configured" };
  }

  const acceptance = jobs.acceptWebhookJob({
    delivery: { deliveryId, event: "pull_request", action: data.action },
    job: {
      kind: "pull_request",
      repository: data.repository.full_name,
      pullRequestNumber: data.pull_request.number,
      baseSha: data.pull_request.base.sha,
      headSha: data.pull_request.head.sha,
      installationId: data.installation.id,
      senderLogin: data.sender.login,
      action: data.action
    }
  });

  return acceptance.duplicate
    ? { status: "duplicate", event: "pull_request", deliveryId, reason: "delivery already processed" }
    : { status: "enqueued", event: "pull_request", deliveryId, job: acceptance.job };
}

export function processGitHubWebhook(options: {
  headers: WebhookHeaders;
  body: Buffer;
  secret: string;
  jobs: ReviewJobStore;
  llmConfigured?: boolean;
}): WebhookResult {
  const event = headerValue(options.headers, "x-github-event");
  const deliveryId = headerValue(options.headers, "x-github-delivery");
  if (!event || !deliveryId) {
    throw new WebhookError("Missing GitHub webhook headers", "MISSING_WEBHOOK_HEADERS", 400);
  }

  const signature = headerValue(options.headers, "x-hub-signature-256");
  if (!verifyGitHubSignature(options.body, signature, options.secret)) {
    throw new WebhookError("Invalid GitHub webhook signature", "INVALID_SIGNATURE", 401);
  }

  try {
    let payload: unknown;
    try {
      payload = options.body.length > 0 ? JSON.parse(options.body.toString("utf8")) : {};
    } catch {
      throw new WebhookError("Webhook body must be valid JSON", "INVALID_JSON", 400);
    }

    if (!payload || typeof payload !== "object") {
      throw new WebhookError("Webhook payload must be a JSON object", "INVALID_PAYLOAD", 400);
    }

    if (event === "ping") {
      const acceptance = options.jobs.recordWebhookDelivery({ deliveryId, event, status: "ignored" });
      return acceptance.duplicate
        ? { status: "duplicate", event, deliveryId, reason: "delivery already processed" }
        : { status: "ignored", event, deliveryId, reason: "pong" };
    }

    if (event === "pull_request") {
      return enqueuePullRequest(payload, deliveryId, options.jobs, options.llmConfigured !== false);
    }

    if (event === "push") {
      const actionSchema = z.object({ action: z.string().optional() }).passthrough();
      const parsedAction = actionSchema.safeParse(payload);

      const acceptance = options.jobs.recordWebhookDelivery({
        deliveryId,
        event,
        action: parsedAction.success ? parsedAction.data.action : undefined,
        status: "ignored"
      });
      return acceptance.duplicate
        ? { status: "duplicate", event, deliveryId, reason: "delivery already processed" }
        : { status: "ignored", event, deliveryId, reason: "push reviews are not supported" };
    }

    const acceptance = options.jobs.recordWebhookDelivery({ deliveryId, event, status: "ignored" });
    return acceptance.duplicate
      ? { status: "duplicate", event, deliveryId, reason: "delivery already processed" }
      : { status: "ignored", event, deliveryId, reason: `unsupported event ${event}` };
  } catch (error) {
    if (error instanceof WebhookError && !options.jobs.getWebhookDelivery(deliveryId)) {
      options.jobs.recordWebhookDelivery({ deliveryId, event, status: "failed" });
    }
    throw error;
  }
}
