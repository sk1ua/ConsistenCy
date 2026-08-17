/**
 * Cordis module augmentation for the PR-2 vertical slice.
 *
 * The `ast` property is the service an Agent's fiber declares as an injected
 * dependency (`inject: ["ast"]`). It is provided per-agent into an isolated
 * context by the {@link CapabilityLifecycleAdapter}. Its VALUE is a
 * CapabilityBoundAstFacade — never the raw trusted handler.
 */

import type { Context } from "cordis";
import type { CapabilityBoundAstFacade } from "../facade/ast-facade.js";

declare module "cordis" {
  interface Context {
    /** Agent-scoped capability-bound AST facade (service). */
    ast?: CapabilityBoundAstFacade;
  }
}

export type { Context } from "cordis";
