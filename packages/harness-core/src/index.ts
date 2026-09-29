/**
 * @consistency/harness-core — PR-2 vertical slice.
 *
 * This package binds Cordis lifecycle to Kernel capabilities. It is
 * intentionally minimal: one synthetic Agent, one capability-bound facade,
 * one trusted synthetic service. No review agents, no scheduler, no context
 * VM, no parallel authorization authority.
 *
 * NOTE: the trusted service handlers (`src/service/fake-ast.ts`) are
 * deliberately NOT exported from the public surface — Agents only ever
 * receive capability-bound facades whose methods route through the Kernel's
 * SyscallGateway.
 */

// Runtime (Kernel ↔ Cordis binding)
export { HarnessRuntime } from "./runtime/harness.js";
export type { AgentAttachment, HarnessRuntimeOptions } from "./runtime/harness.js";
export { CapabilityLifecycleAdapter } from "./runtime/adapter.js";
export { SchedulerAgentBridge } from "./runtime/scheduler-bridge.js";
export type { AgentFiberHandle, AgentFiberInstrumentation } from "./runtime/scheduler-bridge.js";
export { SandboxAgentBridge } from "./runtime/sandbox-bridge.js";
export { buildRunRuntimeSnapshot } from "./runtime/observability.js";
export type { BuildRunRuntimeSnapshotOptions } from "./runtime/observability.js";

// Capability-bound facade (what Agents actually receive)
export { CapabilityBoundAstFacade } from "./facade/ast-facade.js";
export type { AstQueryParams, AstQueryResult } from "./facade/ast-facade.js";

// Synthetic agent (Cordis Fiber)
export {
  createEchoAgent,
  createEchoAgentInstrumentation,
} from "./agent/echo-agent.js";
export type { EchoAgentInstrumentation } from "./agent/echo-agent.js";
