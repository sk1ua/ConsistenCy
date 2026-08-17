/**
 * ContextImageId — an opaque reference to an Agent's virtual context image.
 *
 * PR-3 (Context VM) will implement the actual ContextImage/ContextPage model.
 * This file defines ONLY the identifier/reference contract so that the Agent
 * Control Block and Scheduler can refer to context images without any Context
 * VM behavior existing yet.
 *
 * Deliberately no behavior here: no pages, no working set, no COW, no
 * rendering. Those arrive in PR-3.
 */

/** Opaque, serializable reference to a ContextImage (PR-3). */
export type ContextImageId = string & { readonly __brand: "ContextImageId" };

/** Cast a plain string to a ContextImageId after validating it is non-empty. */
export function asContextImageId(raw: string): ContextImageId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("ContextImageId must be non-empty");
  }
  return raw as ContextImageId;
}
