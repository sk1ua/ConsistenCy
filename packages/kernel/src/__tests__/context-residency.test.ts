/**
 * Residency tests — AC-CTX-4 … AC-CTX-6.
 *
 * Explicit residency semantics: pinned pages are protected from direct
 * eviction; hot/cold pages evict out of the working set; pageIn restores
 * resident state with identical content, hash and provenance. No automatic
 * eviction policy exists.
 */

import { describe, it, expect } from "vitest";
import {
  ContextManager,
  PinnedPageEvictionError,
  InvalidResidencyTransitionError,
  asContextPageId,
  type ContextPageId,
  type ContextPageKind,
} from "../index.js";

function makePage(
  manager: ContextManager,
  id: string,
  kind: ContextPageKind,
  tokens = 25,
): ContextPageId {
  return manager.createPage({
    id: asContextPageId(id),
    kind,
    text: `content of ${id}`,
    estimatedTokens: tokens,
    provenance: { producer: "test", producerVersion: "1.0.0" },
  });
}

describe("ContextManager — residency semantics", () => {
  it("AC-CTX-4: working set contains pinned + hot and excludes cold + evicted", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pinned = makePage(manager, "pin", "policy", 100);
    const hot = makePage(manager, "hot", "source", 50);
    const cold = makePage(manager, "cold", "memory", 30);
    const gone = makePage(manager, "gone", "ast", 20);

    manager.attach(imageId, pinned, "pinned");
    manager.attach(imageId, hot, "hot");
    manager.attach(imageId, cold, "cold");
    manager.attach(imageId, gone, "hot");
    manager.evict(imageId, gone);

    const workingSet = manager.workingSet(imageId);
    expect(workingSet.pages.map((e) => e.page.id)).toEqual([pinned, hot]);
    expect(workingSet.estimatedTokens).toBe(150);

    // resolve() still sees ALL pages (including evicted) with their state,
    // canonically ordered by kind (policy, source, ast, memory).
    expect(manager.resolve(imageId).map((e) => e.residency)).toEqual([
      "pinned",
      "hot",
      "evicted",
      "cold",
    ]);
  });

  it("AC-CTX-5: a pinned page cannot be directly evicted", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pinned = makePage(manager, "pin", "policy");

    manager.attach(imageId, pinned, "pinned");

    expect(() => manager.evict(imageId, pinned)).toThrow(PinnedPageEvictionError);
    expect(() => manager.setResidency(imageId, pinned, "evicted")).toThrow(
      PinnedPageEvictionError,
    );

    // Explicit unpin first, then eviction is allowed.
    manager.setResidency(imageId, pinned, "hot");
    expect(() => manager.evict(imageId, pinned)).not.toThrow();
    expect(manager.resolve(imageId)[0]!.residency).toBe("evicted");

    // The page was never lost: pageIn restores it.
    manager.pageIn(imageId, pinned);
    expect(manager.resolve(imageId)[0]!.residency).toBe("hot");
  });

  it("AC-CTX-6: evict → pageIn round-trip preserves content, hash and provenance", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pageId = makePage(manager, "src", "source", 40);
    manager.attach(imageId, pageId, "hot");

    const before = manager.getPage(pageId)!;
    manager.evict(imageId, pageId);

    // Evicted: absent from the working set (and therefore from render).
    expect(manager.workingSet(imageId).pages).toHaveLength(0);
    expect(manager.render(imageId).pages).toHaveLength(0);
    expect(manager.resolve(imageId)[0]!.residency).toBe("evicted");

    manager.pageIn(imageId, pageId);
    const after = manager.getPage(pageId)!;
    const resolved = manager.resolve(imageId)[0]!;

    expect(resolved.residency).toBe("hot");
    expect(after.contentHash).toBe(before.contentHash);
    expect(after.text).toBe(before.text);
    expect(after.provenance).toEqual(before.provenance);
    expect(after.estimatedTokens).toBe(before.estimatedTokens);
    expect(manager.workingSet(imageId).pages.map((e) => e.page.id)).toEqual([pageId]);
  });

  it("typed errors for invalid residency operations", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pageId = makePage(manager, "p", "source");
    manager.attach(imageId, pageId, "hot");

    // pageIn on a non-evicted page is rejected.
    expect(() => manager.pageIn(imageId, pageId)).toThrow(InvalidResidencyTransitionError);
    // evict on an already-evicted page is rejected.
    manager.evict(imageId, pageId);
    expect(() => manager.evict(imageId, pageId)).toThrow(InvalidResidencyTransitionError);
    // residency ops on unattached pages are rejected.
    expect(() => manager.setResidency(imageId, asContextPageId("nope"), "hot")).toThrow(
      /not attached/,
    );
  });

  it("residency transitions never mutate the shared page record", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pageId = makePage(manager, "p", "source");
    manager.attach(imageId, pageId, "hot");

    const pageSnapshot = JSON.stringify(manager.getPage(pageId));
    manager.setResidency(imageId, pageId, "cold");
    manager.setResidency(imageId, pageId, "pinned");
    manager.setResidency(imageId, pageId, "cold"); // unpin first…
    manager.setResidency(imageId, pageId, "evicted"); // …then evict
    manager.pageIn(imageId, pageId);

    // The immutable page itself was never altered by any residency change.
    expect(JSON.stringify(manager.getPage(pageId))).toBe(pageSnapshot);
  });
});
