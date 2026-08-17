/**
 * Context VM types — the virtual-context-memory contract (PR-3).
 *
 * An Agent's virtual context is a ContextImage: an ordered, residency-aware
 * view over immutable semantic ContextPages. The physical prompt/messages
 * representation is derived ONLY at render time through a WorkingSet
 * projection. Virtual context != physical model context.
 *
 * COW semantics: pages are immutable and shared; every image owns its own
 * page-table (reference → residency map). fork() copies the page table
 * (O(references)) but shares all page objects — it never deep-copies page
 * content. Fork observes the parent's effective state at fork time; later
 * parent mutations never retroactively alter an existing child.
 */

import type { ContextImageId } from "../identity/context-image.js";
import type { AgentId } from "../agent/types.js";

/** Branded, serializable ContextPage identifier. */
export type ContextPageId = string & { readonly __brand: "ContextPageId" };

/** Cast a plain string to a ContextPageId after validating it is non-empty. */
export function asContextPageId(raw: string): ContextPageId {
  if (!raw || raw.trim() === "") {
    throw new TypeError("ContextPageId must be non-empty");
  }
  return raw as ContextPageId;
}

/** The semantic kinds a ContextPage may carry. */
export type ContextPageKind =
  | "policy"
  | "task"
  | "diff"
  | "source"
  | "ast"
  | "symbol"
  | "evidence"
  | "tool-result"
  | "memory"
  | "summary";

export const CONTEXT_PAGE_KINDS: readonly ContextPageKind[] = [
  "policy",
  "task",
  "diff",
  "source",
  "ast",
  "symbol",
  "evidence",
  "tool-result",
  "memory",
  "summary",
];

/**
 * Deterministic render precedence: lower number renders earlier. Secondary
 * ordering is ContextPageId ascending (code-unit comparison) — never
 * hash-map insertion order.
 */
export const CONTEXT_PAGE_KIND_PRECEDENCE: Readonly<Record<ContextPageKind, number>> = {
  policy: 0,
  task: 1,
  diff: 2,
  evidence: 3,
  source: 4,
  ast: 5,
  symbol: 6,
  "tool-result": 7,
  memory: 8,
  summary: 9,
};

/** Residency classes. State lives in the IMAGE overlay, not on shared pages. */
export type Residency = "pinned" | "hot" | "cold" | "evicted";

export const RESIDENCIES: readonly Residency[] = ["pinned", "hot", "cold", "evicted"];

export function isResidency(value: unknown): value is Residency {
  return typeof value === "string" && (RESIDENCIES as readonly string[]).includes(value);
}

/**
 * Optional source identity of the page content. Repository pages carry
 * repo+sha+path; workload/agent pages carry their producer identity.
 * Policy/task pages may omit `source` entirely.
 */
export type SourceRef =
  | { readonly kind: "repository"; readonly repository: string; readonly sha: string; readonly path: string }
  | { readonly kind: "agent"; readonly agentId: AgentId }
  | { readonly kind: "workload"; readonly workload: string };

/**
 * Required traceability metadata for every page. `repository`/`sha` are
 * optional because policy/task/tool pages have no repository origin — we
 * never invent fake repository values for them.
 */
export interface PageProvenance {
  readonly repository?: string;
  readonly sha?: string;
  /** Who produced this page, e.g. "policy-loader", "workload-review". */
  readonly producer: string;
  readonly producerVersion: string;
}

/**
 * A ContextPage — an immutable semantic unit of ingested context.
 *
 * Content is text-first (a producer serializes structured data itself).
 * `contentHash` is the SHA-256 hex digest of `text` (UTF-8); the same text
 * always hashes identically. Pages never mutate: semantic changes produce a
 * NEW page revision which replaces the reference in the image overlay.
 */
export interface ContextPage {
  readonly id: ContextPageId;
  readonly kind: ContextPageKind;
  readonly source?: SourceRef;
  /** SHA-256 hex digest of `text`. */
  readonly contentHash: string;
  /** Immutable semantic content. */
  readonly text: string;
  /**
   * Producer-supplied, provider-neutral token ESTIMATE. Never treated as
   * actual provider tokens.
   */
  readonly estimatedTokens: number;
  readonly provenance: PageProvenance;
}

/** Spec for creating a new immutable page revision. */
export interface CreatePageSpec {
  readonly id?: ContextPageId;
  readonly kind: ContextPageKind;
  readonly text: string;
  /** Producer-supplied estimate; defaults to 0 (unknown) — never invented. */
  readonly estimatedTokens?: number;
  readonly source?: SourceRef;
  readonly provenance: PageProvenance;
}

/** A page reference together with its image-local residency. */
export interface ResolvedPage {
  readonly page: ContextPage;
  readonly residency: Residency;
}

/** Frozen public view of an image's identity + page table. */
export interface ContextImageSnapshot {
  readonly id: ContextImageId;
  readonly generation: number;
  /** Lineage recorded at fork time (metadata; resolution is self-contained). */
  readonly base?: { readonly imageId: ContextImageId; readonly generation: number };
  /** Canonically ordered (kind precedence, then page id). */
  readonly pages: readonly { readonly pageId: ContextPageId; readonly residency: Residency }[];
}

/** Frozen projection of the image's working set (pinned + hot only). */
export interface WorkingSetSnapshot {
  readonly imageId: ContextImageId;
  readonly generation: number;
  /** Canonically ordered. */
  readonly pages: readonly ResolvedPage[];
  /** Sum of the included pages' producer-supplied estimates. */
  readonly estimatedTokens: number;
}

/** One segment of the provider-neutral rendered context. */
export interface RenderedContextPage {
  readonly pageId: ContextPageId;
  readonly kind: ContextPageKind;
  readonly residency: Residency;
  readonly contentHash: string;
  readonly estimatedTokens: number;
  readonly text: string;
  readonly source?: SourceRef;
  readonly provenance: PageProvenance;
}

/**
 * Provider-neutral physical-context projection. NO provider-specific DTOs:
 * OpenAI/Anthropic/Gemini adapters belong to later LLM integration, not the
 * Kernel.
 */
export interface RenderedContext {
  readonly imageId: ContextImageId;
  readonly generation: number;
  /** Canonically ordered, pinned + hot pages from the working set. */
  readonly pages: readonly RenderedContextPage[];
  readonly estimatedTokens: number;
}

// ---------------------------------------------------------------------------
// Checkpoint
// ---------------------------------------------------------------------------

/** Serializable, self-contained checkpoint of one ContextImage. */
export interface ContextCheckpoint {
  readonly format: "consistency.context.v1";
  readonly image: {
    readonly id: ContextImageId;
    readonly generation: number;
    readonly base?: { readonly imageId: ContextImageId; readonly generation: number };
    /** Canonically ordered page-table (reference → residency). */
    readonly pages: readonly { readonly pageId: ContextPageId; readonly residency: Residency }[];
  };
  /** Full immutable page records (content included) for all referenced pages. */
  readonly pages: readonly ContextPage[];
}
