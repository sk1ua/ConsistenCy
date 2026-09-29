/**
 * CapabilityBoundAstFacade — the only object an Agent receives for AST access.
 *
 * The facade CACHES exactly three things (per the PR-2 contract):
 *   - the Agent's Principal,
 *   - the opaque Kernel-issued capability handle,
 *   - the resource descriptor.
 *
 * Every `query()` call enters `SyscallGateway.invoke`, which performs a fresh
 * `CapabilityBroker.authorise()` (subject × action × resource × scope ×
 * budget × expiry × revocation) on EVERY call. The trusted handler
 * ({@link fakeAstQuery}) is wired inside this module and is only invoked
 * AFTER the Kernel allows the call — a stale facade can never reach it.
 */

import {
  CapabilityError,
  type ASTResource,
  type CapabilityHandle,
  type Principal,
  type SyscallGateway,
} from "@consistency/kernel";
import { fakeAstQuery, type FakeAstQueryResult } from "../service/fake-ast.js";

export interface AstQueryParams {
  /** The query string to evaluate against the synthetic AST. */
  readonly query: string;
  /** Optional SHA pin, checked against the capability's scope when declared. */
  readonly sha?: string;
  /** Optional path, checked against the capability's scope paths when declared. */
  readonly path?: string;
}

export type AstQueryResult = FakeAstQueryResult;

export interface CapabilityBoundAstFacadeOptions {
  readonly principal: Principal;
  readonly handle: CapabilityHandle;
  readonly resource: ASTResource;
  readonly gateway: SyscallGateway;
}

export class CapabilityBoundAstFacade {
  readonly #principal: Principal;
  readonly #handle: CapabilityHandle;
  readonly #resource: ASTResource;
  readonly #gateway: SyscallGateway;

  constructor(options: CapabilityBoundAstFacadeOptions) {
    this.#principal = options.principal;
    this.#handle = options.handle;
    this.#resource = options.resource;
    this.#gateway = options.gateway;
  }

  /**
   * Agent-facing operation.
   *
   * @throws {CapabilityError} with a typed `reason` when the Kernel denies
   *   the syscall (wrong/revoked/expired capability, scope violation, budget
   *   exhaustion…). The trusted handler is NOT invoked on denial.
   */
  query(params: AstQueryParams): Promise<AstQueryResult> {
    return this.#gateway.invoke(
      {
        principal: this.#principal,
        handle: this.#handle,
        action: "ast.query",
        resource: this.#resource,
        sha: params.sha,
        path: params.path,
      },
      // Trusted handler — supplied by the harness runtime, invisible to the
      // Agent. Runs only after Kernel authorization succeeds.
      () => ({ value: fakeAstQuery(params) }),
    );
  }
}
