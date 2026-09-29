/**
 * CommitCoordinator errors.
 *
 * These are distinct from the capability broker's 9 {@link DenyReason}s: they
 * describe the *dispatch* contract (how an irreversible external mutation must
 * be routed), not whether a presented capability matches an action/resource.
 */

/**
 * Thrown by `SyscallGateway.invoke` when a caller attempts to dispatch an
 * intent-class syscall (`github.publish` / `repo.write`) inline. Direct
 * dispatch is hard-denied BEFORE authorisation — the handler is never called.
 */
export class CommitCoordinatorRequiredError extends Error {
  /** Stable machine-readable reason, independent of locale/message. */
  readonly reason = "coordinator_required" as const;
  /** The action whose direct dispatch was denied. */
  readonly action: string;

  constructor(action: string) {
    super(
      `Direct dispatch of intent-class syscall '${action}' is denied; ` +
      `route it through the CommitCoordinator`,
    );
    this.name = "CommitCoordinatorRequiredError";
    this.action = action;
  }
}

/**
 * Thrown by `CommitCoordinator.accept` when a request is structurally
 * incompatible with the commit-intent contract (e.g. a non-commit action).
 */
export class CommitIntentRejectedError extends Error {
  /** Stable machine-readable reason. */
  readonly reason = "not_commit_action" as const;
  /** The offending action, when known. */
  readonly action: string;

  constructor(action: string, detail?: string) {
    super(
      detail ??
      `Action '${action}' is not a commit-intent action; only ` +
      `github.publish and repo.write may be routed through the CommitCoordinator`,
    );
    this.name = "CommitIntentRejectedError";
    this.action = action;
  }
}

/**
 * Wraps a failure of the durable intent sink (Outbox persistence). The
 * coordinator performs no external mutation itself; a sink failure means the
 * intent was NOT durably accepted and may be retried.
 */
export class CommitSinkError extends Error {
  override readonly cause: unknown;

  constructor(cause: unknown) {
    super(
      `Commit intent sink failed to persist the durable intent: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "CommitSinkError";
    this.cause = cause;
  }
}
