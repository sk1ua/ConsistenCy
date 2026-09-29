/**
 * COW fork tests — AC-CTX-7 … AC-CTX-11.
 *
 * fork() snapshot-copies the page TABLE and shares immutable page objects.
 * Child overlays are private; later parent mutations never retroactively
 * alter existing children (no spooky-action-at-a-distance).
 */

import { describe, it, expect } from "vitest";
import {
  ContextManager,
  asContextImageId,
  asContextPageId,
  type ContextPageId,
  type Residency,
} from "../index.js";

function makePage(manager: ContextManager, id: string, text = `content of ${id}`): ContextPageId {
  return manager.createPage({
    id: asContextPageId(id),
    kind: "source",
    text,
    estimatedTokens: 10,
    provenance: { producer: "test", producerVersion: "1.0.0" },
  });
}

function resolvedView(manager: ContextManager, imageId: ReturnType<ContextManager["createImage"]>) {
  return manager.resolve(imageId).map((e) => ({
    pageId: e.page.id,
    kind: e.page.kind,
    residency: e.residency,
    hash: e.page.contentHash,
  }));
}

describe("ContextManager — COW fork semantics", () => {
  it("AC-CTX-7: fork(parent) initially resolves equal to parent", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    const b = makePage(manager, "B");
    const c = makePage(manager, "C");
    manager.attach(parent, a, "pinned");
    manager.attach(parent, b, "hot");
    manager.attach(parent, c, "cold");

    const child = manager.fork(parent);
    expect(resolvedView(manager, child)).toEqual(resolvedView(manager, parent));
    // Lineage recorded.
    expect(manager.getImage(child)!.base).toEqual({
      imageId: parent,
      generation: manager.getImage(parent)!.generation,
    });
  });

  it("AC-CTX-8: child overlay mutation does not modify parent", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    const b = makePage(manager, "B");
    const d = makePage(manager, "D");
    manager.attach(parent, a, "hot");
    manager.attach(parent, b, "hot");
    const before = resolvedView(manager, parent);

    const child = manager.fork(parent);
    manager.attach(child, d, "hot"); // add
    manager.detach(child, b); // remove
    manager.setResidency(child, a, "pinned"); // change residency

    expect(resolvedView(manager, child)).not.toEqual(before);
    expect(resolvedView(manager, parent)).toEqual(before); // parent unchanged
  });

  it("AC-CTX-9: Child A mutation does not modify Child B", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    const b = makePage(manager, "B");
    const d = makePage(manager, "D");
    manager.attach(parent, a, "hot");
    manager.attach(parent, b, "hot");

    const childA = manager.fork(parent);
    const childB = manager.fork(parent);
    const baseline = resolvedView(manager, parent);

    manager.attach(childA, d, "pinned");
    manager.detach(childA, b);

    expect(resolvedView(manager, childA)).not.toEqual(baseline);
    expect(resolvedView(manager, childB)).toEqual(baseline); // sibling untouched
    expect(resolvedView(manager, parent)).toEqual(baseline);
  });

  it("AC-CTX-10: later parent mutation does not change existing children", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    const b = makePage(manager, "B");
    const e = makePage(manager, "E");
    manager.attach(parent, a, "hot");
    manager.attach(parent, b, "hot");

    const childA = manager.fork(parent);
    const childB = manager.fork(parent);
    const childBaseline = resolvedView(manager, childA);

    // Parent mutation AFTER the forks: attach E, evict B.
    manager.attach(parent, e, "hot");
    manager.evict(parent, b);

    expect(resolvedView(manager, parent)).not.toEqual(childBaseline);
    // Children observed the snapshot at fork time — never rewritten.
    expect(resolvedView(manager, childA)).toEqual(childBaseline);
    expect(resolvedView(manager, childB)).toEqual(childBaseline);
  });

  it("AC-CTX-11: fork shares immutable page objects — no deep copy", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    const b = makePage(manager, "B");
    const c = makePage(manager, "C");
    manager.attach(parent, a, "hot");
    manager.attach(parent, b, "hot");
    manager.attach(parent, c, "cold");

    const before = manager._debugStats();
    expect(before.pageObjectCount).toBe(3);

    const child = manager.fork(parent);
    const after = manager._debugStats();

    // No new page OBJECTS were created by the fork (only a page table).
    expect(after.pageObjectCount).toBe(3);
    expect(after.imageCount).toBe(before.imageCount + 1);

    // Direct identity proof: parent and child resolve the SAME page object.
    const parentPage = manager.resolve(parent).find((e) => e.page.id === a)!.page;
    const childPage = manager.resolve(child).find((e) => e.page.id === a)!.page;
    expect(childPage).toBe(parentPage);
  });

  it("red-team: child cannot mutate a shared page's content through any public API", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    manager.attach(parent, a, "hot");
    const child = manager.fork(parent);

    // There is no API to edit page text; semantic change = new revision.
    const revision = manager.createPage({
      id: asContextPageId("A-rev2"),
      kind: "source",
      text: "revised content",
      provenance: { producer: "test", producerVersion: "1.0.0" },
    });
    manager.detach(child, a);
    manager.attach(child, revision, "hot");

    // The parent still holds the ORIGINAL page object with original text.
    expect(manager.resolve(parent)[0]!.page.text).toBe("content of A");
    expect(manager.resolve(child).map((e) => e.page.id)).toEqual([revision]);
    expect(manager.resolve(child)[0]!.page.contentHash).not.toBe(
      manager.resolve(parent)[0]!.page.contentHash,
    );
  });

  it("red-team: forking an empty image is a valid no-op snapshot", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const child = manager.fork(parent);
    expect(manager.resolve(child)).toEqual([]);
    manager.attach(parent, makePage(manager, "A"), "hot");
    expect(manager.resolve(child)).toEqual([]); // snapshot semantics hold
  });

  it("red-team: residency changes in one fork never bleed into another", () => {
    const manager = new ContextManager();
    const parent = manager.createImage();
    const a = makePage(manager, "A");
    manager.attach(parent, a, "hot");
    const childA = manager.fork(parent);
    const childB = manager.fork(parent);

    manager.setResidency(childA, a, "pinned");
    expect(manager.resolve(childA)[0]!.residency as Residency).toBe("pinned");
    expect(manager.resolve(childB)[0]!.residency as Residency).toBe("hot");
    expect(manager.resolve(parent)[0]!.residency as Residency).toBe("hot");
  });

  it("typed errors: fork/attach against unknown images", () => {
    const manager = new ContextManager();
    expect(() => manager.fork(asContextImageId("ghost"))).toThrow(/Unknown ContextImage/);
    expect(() => manager.evict(asContextImageId("ghost"), asContextPageId("p"))).toThrow(/Unknown ContextImage/);
    expect(() => manager.pageIn(asContextImageId("ghost"), asContextPageId("p"))).toThrow(/Unknown ContextImage/);
    expect(() => manager.setResidency(asContextImageId("ghost"), asContextPageId("p"), "hot")).toThrow(/Unknown ContextImage/);
  });
});
