/**
 * WorkingSet projection + provider-neutral rendering (PR-3).
 *
 * The WorkingSet is DERIVED from a ContextImage — it is never another
 * mutable source of truth. The initial deterministic rule: include pinned +
 * hot, exclude cold + evicted. Rendering projects the working set into a
 * provider-neutral physical representation; NO OpenAI/Anthropic/Gemini DTOs
 * ever leave the Kernel.
 *
 * COW != token savings: three Agents sharing the same immutable base pages
 * may still transmit the same prefix three times. COW saves host-side state
 * duplication, not provider tokens.
 */

import type {
  RenderedContext,
  RenderedContextPage,
  ResolvedPage,
  WorkingSetSnapshot,
} from "./types.js";
import { CONTEXT_PAGE_KIND_PRECEDENCE } from "./types.js";
import type { ImageRecord } from "./image.js";
import type { PageStore } from "./page-store.js";

/**
 * Canonical deterministic ordering: kind precedence first (policy → task →
 * diff → evidence → source → ast → symbol → tool-result → memory → summary),
 * then ContextPageId ascending by code-unit comparison. NEVER hash-map
 * insertion order.
 */
export function compareResolvedPages(a: ResolvedPage, b: ResolvedPage): number {
  const byKind = CONTEXT_PAGE_KIND_PRECEDENCE[a.page.kind] - CONTEXT_PAGE_KIND_PRECEDENCE[b.page.kind];
  if (byKind !== 0) return byKind;
  return a.page.id < b.page.id ? -1 : a.page.id > b.page.id ? 1 : 0;
}

export function orderResolvedPages(pages: Iterable<ResolvedPage>): ResolvedPage[] {
  return [...pages].sort(compareResolvedPages);
}

/** Resolve an image's page table into ordered ResolvedPage records. */
export function resolveImage(image: ImageRecord, store: PageStore): ResolvedPage[] {
  const resolved: ResolvedPage[] = [];
  for (const [pageId, residency] of image.refs) {
    const page = store.get(pageId);
    if (!page) {
      // Fail closed: an image referencing a missing page is corrupt state.
      throw new Error(`ContextImage ${image.id} references unknown page ${pageId}`);
    }
    resolved.push(Object.freeze({ page, residency }));
  }
  return orderResolvedPages(resolved);
}

/** Project the working set: pinned + hot only, canonically ordered. */
export function buildWorkingSet(
  image: ImageRecord,
  store: PageStore,
): WorkingSetSnapshot {
  const pages = resolveImage(image, store).filter(
    (entry) => entry.residency === "pinned" || entry.residency === "hot",
  );
  const estimatedTokens = pages.reduce((sum, entry) => sum + entry.page.estimatedTokens, 0);
  return Object.freeze({
    imageId: image.id,
    generation: image.generation,
    pages: Object.freeze(pages),
    estimatedTokens,
  });
}

/** Render the working set into a provider-neutral physical projection. */
export function renderContext(
  image: ImageRecord,
  store: PageStore,
): RenderedContext {
  const workingSet = buildWorkingSet(image, store);
  const pages: RenderedContextPage[] = workingSet.pages.map((entry) =>
    Object.freeze({
      pageId: entry.page.id,
      kind: entry.page.kind,
      residency: entry.residency,
      contentHash: entry.page.contentHash,
      estimatedTokens: entry.page.estimatedTokens,
      text: entry.page.text,
      source: entry.page.source,
      provenance: entry.page.provenance,
    }),
  );
  return Object.freeze({
    imageId: image.id,
    generation: image.generation,
    pages: Object.freeze(pages),
    estimatedTokens: workingSet.estimatedTokens,
  });
}
