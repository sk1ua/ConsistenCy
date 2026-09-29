/**
 * FakeAstService — the PR-2 trusted synthetic service.
 *
 * This is deliberately NOT tree-sitter (that arrives in PR-4). It is a tiny
 * deterministic handler that exists solely to prove the vertical slice:
 *
 *   Agent → CapabilityBoundFacade → SyscallGateway
 *         → Kernel authorization → trusted handler
 *
 * The handler lives BELOW the SyscallGateway. Agents never receive a
 * reference to it; they only receive a {@link CapabilityBoundAstFacade} whose
 * `query()` method routes through the Kernel.
 */

export interface FakeAstQueryParams {
  readonly query: string;
}

export interface FakeAstQueryResult {
  /** Deterministic echo of the query — proves the handler ran. */
  readonly matched: string;
  readonly engine: "fake-ast";
}

let invocationCount = 0;

/**
 * The trusted handler. Only reachable through SyscallGateway.invoke, i.e.
 * only after CapabilityBroker.authorise() has ALLOWED the call.
 */
export function fakeAstQuery(params: FakeAstQueryParams): FakeAstQueryResult {
  invocationCount += 1;
  return { matched: `echo:${params.query}`, engine: "fake-ast" };
}

/** How many times the trusted handler has actually executed (test hook). */
export function getFakeAstInvocationCount(): number {
  return invocationCount;
}

/** Reset the trusted-handler counter between tests. */
export function resetFakeAstInvocationCount(): void {
  invocationCount = 0;
}
