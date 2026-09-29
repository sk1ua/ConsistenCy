/**
 * Sandbox plugin contract — the ONLY surface an untrusted plugin sees.
 *
 * The context exposes a tiny mediated API over the narrow RPC channel:
 *
 *   ctx.repository.read({ path })
 *   ctx.evidence.read({ ... })
 *   ctx.ast.query({ query })
 *
 * Every call crosses the process boundary and is authorised per-call by the
 * Kernel on the trusted parent side. The plugin NEVER receives:
 *
 *   - the Kernel object, CapabilityBroker, SyscallGateway,
 *   - raw capability handles or capability metadata,
 *   - process handles, sockets, or raw filesystem/network access,
 *   - provider/GitHub credentials.
 *
 * Deliberately absent from PR-6A: github.publish, repo.write, audit.read,
 * raw shell, raw filesystem, raw network, process.env.
 */

export interface SandboxRepositoryApi {
  /** Read one repository file through the Kernel (repo.read syscall). */
  read(params: { readonly path: string }): Promise<unknown>;
}

export interface SandboxEvidenceApi {
  /** Read evidence records through the Kernel (evidence.read syscall). */
  read(params: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxAstApi {
  /** Query an AST snapshot through the Kernel (ast.query syscall). */
  query(params: { readonly query: string }): Promise<unknown>;
}

export interface SandboxPluginContext {
  readonly repository: SandboxRepositoryApi;
  readonly evidence: SandboxEvidenceApi;
  readonly ast: SandboxAstApi;
}

/**
 * The minimal plugin-side contract. `run` resolves with a JSON-serializable
 * result (size-bounded) or rejects; either way the session terminates
 * cleanly under parent control.
 */
export interface SandboxPlugin {
  run(ctx: SandboxPluginContext): Promise<unknown> | unknown;
}
