export type PublishErrorKind = "transient" | "permanent" | "rate_limited";

export class PublishError extends Error {
  constructor(
    message: string,
    readonly kind: PublishErrorKind,
    readonly status?: number,
    readonly retryAt?: Date
  ) {
    super(message);
    this.name = "PublishError";
  }
}

export class PermanentPublishError extends PublishError {
  constructor(message: string, status?: number) {
    super(message, "permanent", status);
    this.name = "PermanentPublishError";
  }
}

export class TransientPublishError extends PublishError {
  constructor(message: string, status?: number, retryAt?: Date) {
    super(message, "transient", status, retryAt);
    this.name = "TransientPublishError";
  }
}

export class RateLimitedPublishError extends PublishError {
  constructor(message: string, status?: number, retryAt?: Date) {
    super(message, "rate_limited", status, retryAt);
    this.name = "RateLimitedPublishError";
  }
}
