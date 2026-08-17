/**
 * Render ordering + token estimation tests — AC-CTX-15 … AC-CTX-16.
 */

import { describe, it, expect } from "vitest";
import {
  ContextManager,
  asContextPageId,
  type ContextPageId,
  type ContextPageKind,
} from "../index.js";

function makePage(
  manager: ContextManager,
  id: string,
  kind: ContextPageKind,
  tokens = 10,
): ContextPageId {
  return manager.createPage({
    id: asContextPageId(id),
    kind,
    text: `content of ${id}`,
    estimatedTokens: tokens,
    provenance: { producer: "test", producerVersion: "1.0.0" },
  });
}

describe("ContextManager — deterministic render projection", () => {
  it("AC-CTX-15: render order follows kind precedence with deterministic tiebreak", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();

    // Attach in scrambled order, across all ten kinds.
    const summary = makePage(manager, "s1", "summary", 1);
    const policy = makePage(manager, "p1", "policy", 2);
    const tool = makePage(manager, "t1", "tool-result", 3);
    const ast = makePage(manager, "a1", "ast", 4);
    const diff = makePage(manager, "d1", "diff", 5);
    const symbol = makePage(manager, "y1", "symbol", 6);
    const evidence = makePage(manager, "e1", "evidence", 7);
    const memory = makePage(manager, "m1", "memory", 8);
    const task = makePage(manager, "k1", "task", 9);
    const sourceA = makePage(manager, "source-z", "source", 10);
    const sourceB = makePage(manager, "source-a", "source", 11);

    for (const pid of [
      summary,
      sourceB,
      ast,
      policy,
      memory,
      tool,
      diff,
      sourceA,
      evidence,
      symbol,
      task,
    ]) {
      manager.attach(imageId, pid, "hot");
    }

    const expectedOrder = [
      policy, // policy
      task, // task
      diff, // diff
      evidence, // evidence
      sourceB, // source (pageId "source-a" < "source-z" → tiebreak)
      sourceA, // source
      ast, // ast
      symbol, // symbol
      tool, // tool-result
      memory, // memory
      summary, // summary
    ];
    const first = manager.render(imageId).pages.map((p) => p.pageId);
    const second = manager.render(imageId).pages.map((p) => p.pageId);

    expect(first).toEqual(expectedOrder);
    expect(second).toEqual(first); // never hash-map insertion order
    expect(manager.render(imageId)).toEqual(manager.render(imageId));
  });

  it("AC-CTX-16: working set estimated token total is the sum of included pages", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const pinned = makePage(manager, "pin", "policy", 100);
    const hot = makePage(manager, "hot", "source", 50);
    const cold = makePage(manager, "cold", "memory", 30);
    const evicted = makePage(manager, "evicted", "ast", 20);

    manager.attach(imageId, pinned, "pinned");
    manager.attach(imageId, hot, "hot");
    manager.attach(imageId, cold, "cold");
    manager.attach(imageId, evicted, "hot");
    manager.evict(imageId, evicted);

    const workingSet = manager.workingSet(imageId);
    expect(workingSet.estimatedTokens).toBe(150);

    const rendered = manager.render(imageId);
    expect(rendered.estimatedTokens).toBe(150);
    expect(rendered.pages.map((p) => p.pageId)).toEqual([pinned, hot]);
  });

  it("red-team: rendering never includes evicted or cold pages", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const hot = makePage(manager, "hot", "source");
    const cold = makePage(manager, "cold", "summary");
    const evicted = makePage(manager, "evicted", "policy");

    manager.attach(imageId, hot, "hot");
    manager.attach(imageId, cold, "cold");
    manager.attach(imageId, evicted, "hot");
    manager.evict(imageId, evicted);

    const rendered = manager.render(imageId);
    expect(rendered.pages.map((p) => p.pageId)).toEqual([hot]);
    expect(rendered.pages.some((p) => p.residency === "cold")).toBe(false);
    expect(rendered.pages.some((p) => p.residency === "evicted")).toBe(false);
  });

  it("red-team: render output is provider-neutral (no provider DTOs)", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const policy = makePage(manager, "pol", "policy", 5);
    manager.attach(imageId, policy, "pinned");

    const rendered = manager.render(imageId);
    expect(rendered).toMatchObject({
      imageId,
      estimatedTokens: 5,
    });
    expect(rendered.pages[0]).toMatchObject({
      pageId: policy,
      kind: "policy",
      residency: "pinned",
      estimatedTokens: 5,
      text: "content of pol",
    });
    // No provider-specific shape: only the documented neutral fields exist.
    expect(Object.keys(rendered.pages[0]!).sort()).toEqual([
      "contentHash",
      "estimatedTokens",
      "kind",
      "pageId",
      "provenance",
      "residency",
      "source",
      "text",
    ]);
  });
});
