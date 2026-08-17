/**
 * Context VM errors — typed, fail-closed semantics.
 *
 * Invalid operations NEVER silently mutate context state. Every failure
 * carries a dedicated error class with the relevant identifiers.
 */

import type { ContextImageId } from "../identity/context-image.js";
import type { ContextPageId, Residency } from "./types.js";

export class ContextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextError";
  }
}

export class PageNotFoundError extends ContextError {
  readonly pageId: ContextPageId;
  constructor(pageId: ContextPageId) {
    super(`Unknown ContextPage: ${pageId}`);
    this.name = "PageNotFoundError";
    this.pageId = pageId;
  }
}

export class ImageNotFoundError extends ContextError {
  readonly imageId: ContextImageId;
  constructor(imageId: ContextImageId) {
    super(`Unknown ContextImage: ${imageId}`);
    this.name = "ImageNotFoundError";
    this.imageId = imageId;
  }
}

export class PageAlreadyExistsError extends ContextError {
  readonly pageId: ContextPageId;
  constructor(pageId: ContextPageId) {
    super(`ContextPage already exists: ${pageId}`);
    this.name = "PageAlreadyExistsError";
    this.pageId = pageId;
  }
}

export class PageAlreadyAttachedError extends ContextError {
  readonly imageId: ContextImageId;
  readonly pageId: ContextPageId;
  constructor(imageId: ContextImageId, pageId: ContextPageId) {
    super(`ContextPage ${pageId} is already attached to image ${imageId}`);
    this.name = "PageAlreadyAttachedError";
    this.imageId = imageId;
    this.pageId = pageId;
  }
}

export class PageNotAttachedError extends ContextError {
  readonly imageId: ContextImageId;
  readonly pageId: ContextPageId;
  constructor(imageId: ContextImageId, pageId: ContextPageId) {
    super(`ContextPage ${pageId} is not attached to image ${imageId}`);
    this.name = "PageNotAttachedError";
    this.imageId = imageId;
    this.pageId = pageId;
  }
}

/**
 * PINNED pages must never be silently discarded. Evicting them directly is
 * rejected; the caller must first transition pinned → hot/cold explicitly.
 */
export class PinnedPageEvictionError extends ContextError {
  readonly imageId: ContextImageId;
  readonly pageId: ContextPageId;
  constructor(imageId: ContextImageId, pageId: ContextPageId) {
    super(
      `ContextPage ${pageId} is pinned in image ${imageId}; unpin it (pinned → hot/cold) before evicting`,
    );
    this.name = "PinnedPageEvictionError";
    this.imageId = imageId;
    this.pageId = pageId;
  }
}

export class InvalidResidencyTransitionError extends ContextError {
  readonly imageId: ContextImageId;
  readonly pageId: ContextPageId;
  readonly from: Residency;
  readonly to: Residency;
  constructor(imageId: ContextImageId, pageId: ContextPageId, from: Residency, to: Residency) {
    super(`Invalid residency transition for ${pageId} in image ${imageId}: ${from} -> ${to}`);
    this.name = "InvalidResidencyTransitionError";
    this.imageId = imageId;
    this.pageId = pageId;
    this.from = from;
    this.to = to;
  }
}

/** Malformed checkpoint (bad JSON / wrong shape / unknown format). */
export class CheckpointFormatError extends ContextError {
  constructor(message: string) {
    super(`Invalid checkpoint format: ${message}`);
    this.name = "CheckpointFormatError";
  }
}

/**
 * Checkpoint integrity failure: a page's stored contentHash does not match
 * the hash of its restored text, or ids collide with incompatible state.
 * Restore always fails closed — corruption is never silently accepted.
 */
export class CheckpointCorruptionError extends ContextError {
  readonly pageId?: ContextPageId;
  constructor(message: string, pageId?: ContextPageId) {
    super(`Checkpoint corruption: ${message}`);
    this.name = "CheckpointCorruptionError";
    this.pageId = pageId;
  }
}

export class ImageIdConflictError extends ContextError {
  readonly imageId: ContextImageId;
  constructor(imageId: ContextImageId) {
    super(`ContextImage id already exists: ${imageId}`);
    this.name = "ImageIdConflictError";
    this.imageId = imageId;
  }
}
