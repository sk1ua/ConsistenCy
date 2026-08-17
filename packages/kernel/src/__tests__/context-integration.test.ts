/**
 * Context VM integration / boundaries — AC-CTX-17 … AC-CTX-19.
 *
 * - AC-CTX-17: the Context VM has zero Cordis dependency and no provider-SDK
 *   leakage (kernel stays provider-neutral).
 * - AC-CTX-18: ContextPage membership does NOT grant capability
 *   authorization — proven against the REAL CapabilityBroker/SyscallGateway.
 * - AC-CTX-19: an ACB can reference a ContextImageId without ContextManager
 *   depending on the Scheduler.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AgentRegistry,
  CapabilityBroker,
  CapabilityError,
  ContextManager,
  MemoryJournal,
  SyscallGateway,
  asAgentId,
  asCapabilityHandle,
  asContextPageId,
  asRunId,
  makePrincipalId,
  type ASTResource,
  type Principal,
  type RepositoryResource,
} from "../index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KERNEL_ROOT = path.resolve(HERE, "../..");

describe("Context VM — dependency boundaries", () => {
  it("AC-CTX-17: Context VM has zero Cordis dependency and no provider SDK leakage", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(KERNEL_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    expect(pkg.dependencies ?? {}).not.toHaveProperty("cordis");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("cordis");

    const contextDir = path.join(KERNEL_ROOT, "src", "context");
    const files = fs
      .readdirSync(contextDir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => path.join(contextDir, e.name));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, `${path.basename(file)} imports cordis`).not.toMatch(
        /(?:from\s+|require\s*\()\s*["']cordis/,
      );
      // Provider SDKs must never leak into the Kernel.
      for (const sdk of ["openai", "anthropic", "@google/generative-ai", "deepseek", "ollama", "langchain"]) {
        expect(source, `${path.basename(file)} imports ${sdk}`).not.toMatch(
          new RegExp(`(?:from\\s+|require\\s*\\()\\s*["'][^"']*${sdk}`),
        );
      }
      // No VALUE dependency on scheduler/agent modules (type-only imports
      // like `import type { AgentId }` are erased and allowed).
      expect(source, `${path.basename(file)} value-imports scheduler/agent`).not.toMatch(
        /^import\s+(?!type)[^'"]*['"]\.\.\/(?:scheduler|agent)/m,
      );
    }
  });

  it("AC-CTX-18: ContextPage membership does NOT grant capability authorization", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const gateway = new SyscallGateway(broker);
    const principal: Principal = {
      id: makePrincipalId("agent", "ctx-test", "run-1"),
      kind: "agent",
      runId: "run-1",
    };

    // The agent's context image contains a repository SOURCE page.
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const sourcePage = manager.createPage({
      id: asContextPageId("src"),
      kind: "source",
      text: "const secret = process.env.GITHUB_TOKEN;",
      estimatedTokens: 12,
      source: { kind: "repository", repository: "sk1ua/ConsistenCy", sha: "abc123", path: "src/x.ts" },
      provenance: { repository: "sk1ua/ConsistenCy", sha: "abc123", producer: "test", producerVersion: "1.0.0" },
    });
    manager.attach(imageId, sourcePage, "hot");
    expect(manager.resolve(imageId)).toHaveLength(1);

    // The agent holds ONLY an ast.query capability — nothing for repo.read.
    const astResource: ASTResource = { kind: "ast", snapshotId: "snap-1" };
    const astHandle = broker.issue({ subject: principal, action: "ast.query", resource: astResource });
    const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

    // Possessing the source page in context does NOT authorize repo.read.
    let handlerInvoked = false;
    await expect(
      gateway.invoke(
        { principal, handle: astHandle, action: "repo.read", resource: repo },
        () => {
          handlerInvoked = true;
          return { value: "should never run" };
        },
      ),
    ).rejects.toMatchObject({ name: "CapabilityError", reason: "action_mismatch" } satisfies Partial<CapabilityError>);
    expect(handlerInvoked).toBe(false);

    // And with an unknown handle, still denied.
    await expect(
      gateway.invoke(
        { principal, handle: asCapabilityHandle(`cap_${"f".repeat(64)}`), action: "repo.read", resource: repo },
        () => ({ value: "never" }),
      ),
    ).rejects.toMatchObject({ reason: "unknown_capability" });
  });

  it("AC-CTX-19: an ACB can reference a ContextImageId; ContextManager has no Scheduler dependency", () => {
    const manager = new ContextManager();
    const imageId = manager.createImage();
    const policyPage = manager.createPage({
      id: asContextPageId("pol"),
      kind: "policy",
      text: "review policy",
      provenance: { producer: "test", producerVersion: "1.0.0" },
    });
    manager.attach(imageId, policyPage, "pinned");

    const registry = new AgentRegistry();
    const agent = registry.register({
      id: asAgentId("ctx-agent"),
      runId: asRunId("run-1"),
      priority: 0,
      executionDomain: "in-process",
      contextImage: imageId,
    });

    expect(agent.contextImage).toBe(imageId);
    // The referenced image resolves independently through the ContextManager.
    expect(manager.resolve(agent.contextImage!).map((e) => e.page.id)).toEqual([policyPage]);

    // Structural boundary: context sources never value-import scheduler/agent.
    const contextDir = path.join(KERNEL_ROOT, "src", "context");
    for (const file of fs.readdirSync(contextDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = fs.readFileSync(path.join(contextDir, file), "utf8");
      expect(source, file).not.toMatch(/^import\s+(?!type)[^'"]*['"]\.\.\/(?:scheduler|agent)/m);
    }
  });
});
