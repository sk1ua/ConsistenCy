/**
 * ContextManager — the Kernel's single virtual-context-memory service.
 *
 * Owns:
 *   - the immutable page store,
 *   - the ContextImage registry (page tables + fork lineage),
 *   - explicit residency operations (attach / detach / setResidency /
 *     evict / pageIn),
 *   - WorkingSet projection and provider-neutral rendering,
 *   - in-memory checkpoint / restore.
 *
 * Small and focused: no automatic eviction policy, no summarization, no
 * retrieval, no embedding scoring, no persistence backend, no Cordis, no
 * provider SDKs. Residency changes are ALWAYS explicit operations.
 *
 * SECURITY: Context VM is state management, not authorization. Page
 * membership grants no capability — authorization stays exclusively in the
 * CapabilityBroker / SyscallGateway.
 */

import type { ContextImageId } from "../identity/context-image.js";
import {
  type ContextCheckpoint,
  type ContextImageSnapshot,
  type ContextPage,
  type ContextPageId,
  type CreatePageSpec,
  type RenderedContext,
  type Residency,
  type ResolvedPage,
  type WorkingSetSnapshot,
} from "./types.js";
import {
  CheckpointCorruptionError,
  ImageIdConflictError,
  ImageNotFoundError,
  InvalidResidencyTransitionError,
  PageNotFoundError,
  PinnedPageEvictionError,
  PageNotAttachedError,
} from "./errors.js";
import { PageStore } from "./page-store.js";
import { ImageRegistry, type ImageRecord } from "./image.js";
import {
  buildWorkingSet,
  renderContext,
  resolveImage,
} from "./working-set.js";
import {
  buildCheckpoint,
  parseCheckpoint,
  serializeCheckpoint,
  validateCheckpointShape,
  verifyCheckpointIntegrity,
} from "./checkpoint.js";

export interface RestoreOptions {
  /** Optional replacement identity; must not already exist. */
  readonly imageId?: ContextImageId;
}

export class ContextManager {
  readonly #pages = new PageStore();
  readonly #images = new ImageRegistry();

  // -------------------------------------------------------------------------
  // Pages
  // -------------------------------------------------------------------------

  /**
   * Create a new immutable page revision. Semantic changes NEVER mutate a
   * page — create a new revision and replace the image reference instead.
   */
  createPage(spec: CreatePageSpec): ContextPageId {
    return this.#pages.create(spec).id;
  }

  getPage(id: ContextPageId): ContextPage | undefined {
    return this.#pages.get(id);
  }

  // -------------------------------------------------------------------------
  // Images
  // -------------------------------------------------------------------------

  createImage(id?: ContextImageId): ContextImageId {
    return this.#images.create(id).id;
  }

  getImage(id: ContextImageId): ContextImageSnapshot | undefined {
    const image = this.#images.get(id);
    if (!image) return undefined;
    return this.#imageSnapshot(image);
  }

  /**
   * Fork an image. The child receives a snapshot COPY of the parent's page
   * table (O(references)) sharing all immutable page objects — page content
   * is never deep-copied. Later parent mutations do NOT flow into existing
   * children.
   */
  fork(parentImageId: ContextImageId, childId?: ContextImageId): ContextImageId {
    return this.#images.fork(parentImageId, childId).id;
  }

  /**
   * Attach a page to an image (residency defaults to "hot"). Throws if the
   * page is already attached — the revision flow is detach → attach(new
   * revision), never in-place mutation.
   */
  attach(
    imageId: ContextImageId,
    pageId: ContextPageId,
    residency: Residency = "hot",
  ): ContextImageSnapshot {
    if (!this.#pages.has(pageId)) {
      throw new PageNotFoundError(pageId);
    }
    this.#images.attach(imageId, pageId, residency);
    return this.getImage(imageId)!;
  }

  /** Remove a page reference from the image. */
  detach(imageId: ContextImageId, pageId: ContextPageId): ContextImageSnapshot {
    this.#images.detach(imageId, pageId);
    return this.getImage(imageId)!;
  }

  /**
   * Explicit residency transition. All transitions are allowed EXCEPT
   * pinned → evicted, which fails closed — unpin first.
   */
  setResidency(
    imageId: ContextImageId,
    pageId: ContextPageId,
    residency: Residency,
  ): ContextImageSnapshot {
    const current = this.#requireAttachedResidency(imageId, pageId);
    if (current === "pinned" && residency === "evicted") {
      throw new PinnedPageEvictionError(imageId, pageId);
    }
    this.#images.setResidency(imageId, pageId, residency);
    return this.getImage(imageId)!;
  }

  /**
   * Evict a hot/cold page. Pinned pages fail closed. Evicted pages leave the
   * working set but remain restorable via {@link pageIn}.
   */
  evict(imageId: ContextImageId, pageId: ContextPageId): ContextImageSnapshot {
    const current = this.#requireAttachedResidency(imageId, pageId);
    if (current === "pinned") {
      throw new PinnedPageEvictionError(imageId, pageId);
    }
    if (current === "evicted") {
      throw new InvalidResidencyTransitionError(imageId, pageId, current, "evicted");
    }
    this.#images.setResidency(imageId, pageId, "evicted");
    return this.getImage(imageId)!;
  }

  /**
   * Page-in an evicted page: restores resident state ("hot") with identical
   * content, contentHash and provenance. No retrieval/search — the page is
   * already held by the Context VM.
   */
  pageIn(imageId: ContextImageId, pageId: ContextPageId): ContextImageSnapshot {
    const current = this.#requireAttachedResidency(imageId, pageId);
    if (current !== "evicted") {
      throw new InvalidResidencyTransitionError(imageId, pageId, current, "hot");
    }
    this.#images.setResidency(imageId, pageId, "hot");
    return this.getImage(imageId)!;
  }

  // -------------------------------------------------------------------------
  // Projection
  // -------------------------------------------------------------------------

  /** Resolve the image's effective pages in canonical deterministic order. */
  resolve(imageId: ContextImageId): readonly ResolvedPage[] {
    const image = this.#requireImage(imageId);
    return Object.freeze(resolveImage(image, this.#pages));
  }

  /** Project the working set: pinned + hot only (cold/evicted excluded). */
  workingSet(imageId: ContextImageId): WorkingSetSnapshot {
    const image = this.#requireImage(imageId);
    return buildWorkingSet(image, this.#pages);
  }

  /** Render the working set into a provider-neutral physical projection. */
  render(imageId: ContextImageId): RenderedContext {
    const image = this.#requireImage(imageId);
    return renderContext(image, this.#pages);
  }

  // -------------------------------------------------------------------------
  // Checkpoint / restore
  // -------------------------------------------------------------------------

  /** Build a serializable, self-contained checkpoint of the image. */
  checkpoint(imageId: ContextImageId): ContextCheckpoint {
    const image = this.#requireImage(imageId);
    return buildCheckpoint(image, this.#pages);
  }

  serializeCheckpoint(checkpoint: ContextCheckpoint): string {
    return serializeCheckpoint(checkpoint);
  }

  parseCheckpoint(raw: string): ContextCheckpoint {
    return parseCheckpoint(raw);
  }

  /**
   * Restore an image from a checkpoint (object or serialized string).
   *
   * - Fails closed on corruption: every stored contentHash is verified
   *   against the restored text.
   * - Page ids already present must carry identical content (otherwise
   *   {@link CheckpointCorruptionError}).
   * - Returns the restored image id: the checkpoint identity when free,
   *   otherwise `options.imageId`, otherwise a fresh generated id. Semantic
   *   state — page table, residencies, lineage, generation, content — is
   *   preserved; JavaScript object identity is not (nor required).
   */
  restore(
    checkpoint: ContextCheckpoint | string,
    options: RestoreOptions = {},
  ): ContextImageId {
    const cp = typeof checkpoint === "string"
      ? parseCheckpoint(checkpoint)
      : validateCheckpointShape(checkpoint);
    verifyCheckpointIntegrity(cp);

    // Seed pages (content-verified above).
    for (const page of cp.pages) {
      const existing = this.#pages.get(page.id);
      if (existing) {
        if (existing.contentHash !== page.contentHash) {
          throw new CheckpointCorruptionError(
            `page ${page.id} collides with existing different content`,
            page.id,
          );
        }
        continue; // reuse the identical existing immutable page
      }
      this.#pages.create({
        id: page.id,
        kind: page.kind,
        text: page.text,
        estimatedTokens: page.estimatedTokens,
        source: page.source,
        provenance: page.provenance,
      });
    }

    // Seed the image.
    const imageId = options.imageId ?? cp.image.id;
    if (this.#images.get(imageId)) {
      throw new ImageIdConflictError(imageId);
    }
    const record: ImageRecord = {
      id: imageId,
      generation: cp.image.generation,
      base: cp.image.base
        ? { imageId: cp.image.base.imageId, generation: cp.image.base.generation }
        : undefined,
      refs: new Map(cp.image.pages.map((ref) => [ref.pageId, ref.residency])),
    };
    this.#images.seed(record);
    return imageId;
  }

  // -------------------------------------------------------------------------
  // Internal (tests / debugging only — never expose mutable internals)
  // -------------------------------------------------------------------------

  /**
   * @internal Structural-sharing invariant counters. Never part of the
   * public contract.
   */
  _debugStats(): { readonly imageCount: number; readonly pageObjectCount: number } {
    return { imageCount: this.#images.count(), pageObjectCount: this.#pages.count() };
  }

  /**
   * @internal Raw immutable page object identity for structural-sharing
   * proofs (pages are frozen; nothing mutable leaks).
   */
  _debugPageObject(pageId: ContextPageId): ContextPage | undefined {
    return this.#pages.get(pageId);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  #requireImage(imageId: ContextImageId): ImageRecord {
    const image = this.#images.get(imageId);
    if (!image) {
      throw new ImageNotFoundError(imageId);
    }
    return image;
  }

  #requireAttachedResidency(imageId: ContextImageId, pageId: ContextPageId): Residency {
    const image = this.#requireImage(imageId);
    const residency = image.refs.get(pageId);
    if (residency === undefined) {
      throw new PageNotAttachedError(imageId, pageId);
    }
    return residency;
  }

  #imageSnapshot(image: ImageRecord): ContextImageSnapshot {
    const pages = resolveImage(image, this.#pages).map((entry) =>
      Object.freeze({ pageId: entry.page.id, residency: entry.residency }),
    );
    return Object.freeze({
      id: image.id,
      generation: image.generation,
      base: image.base
        ? Object.freeze({ imageId: image.base.imageId, generation: image.base.generation })
        : undefined,
      pages: Object.freeze(pages),
    });
  }
}

/** Convenience re-export for id construction. */
export { asContextImageId } from "../identity/context-image.js";
