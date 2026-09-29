/**
 * CommitCoordinator + intent-dispatch gate tests — AC-COMMIT-1..9.
 *
 * AC-COMMIT-1: direct dispatch of github.publish via SyscallGateway is DENIED
 *              (CommitCoordinatorRequiredError) and the handler is never called.
 * AC-COMMIT-2: direct dispatch of repo.write via SyscallGateway is DENIED.
 * AC-COMMIT-3: llm.invoke remains DIRECT (commit/direct) — handler runs inline.
 * AC-COMMIT-4: CommitCoordinator.accept rejects a non-commit action.
 * AC-COMMIT-5: revocation before acceptance → CapabilityError, no sink, deny event.
 * AC-COMMIT-6: successful accept persists exactly one durable intent.
 * AC-COMMIT-7: repeated idempotencyKey returns `duplicate` without re-persisting.
 * AC-COMMIT-8: intent + audit never contain a raw capability handle.
 * AC-COMMIT-9: payload body never appears in the audit journal (hash only).
 */

import { describe, it, expect } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityError } from "../capability/errors.js";
import { asCapabilityHandle } from "../capability/types.js";
import { SyscallGateway } from "../syscall/authorize.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import { asRunId } from "../run/types.js";
import { CommitCoordinator } from "../commit/coordinator.js";
import {
  CommitCoordinatorRequiredError,
  CommitIntentRejectedError,
} from "../commit/errors.js";
import type { CommitIntent, CommitIntentSink, CommitReceipt } from "../commit/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const kernelPrincipal: Principal = {
  id: makePrincipalId("kernel", "commit"),
  kind: "kernel",
};

function makeSink() {
  const persisted: CommitIntent[] = [];
  let persistCalls = 0;
  const sink: CommitIntentSink = {
    async persist(intent: CommitIntent): Promise<CommitReceipt> {
      persistCalls += 1;
      persisted.push(intent);
      return {
        intentId: intent.id,
        idempotencyKey: intent.idempotencyKey,
        acceptedAt: intent.createdAt,
        status: "accepted",
      };
    },
  };
  return { sink, persisted: () => persisted, persistCalls: () => persistCalls };
}

function makeCoordinator() {
  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal);
  const handle = broker.issue({
    subject: kernelPrincipal,
    action: "github.publish",
    resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 42 },
  });
  const { sink, persisted, persistCalls } = makeSink();
  const coordinator = new CommitCoordinator(broker, journal, { sink });
  return { journal, broker, handle, coordinator, persisted, persistCalls };
}

const publishResource = { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 42 } as const;

describe("CommitCoordinator + intent dispatch gate", () => {
  it("AC-COMMIT-1: direct github.publish dispatch is DENIED and handler never called", async () => {
    const { broker } = makeCoordinator();
    const gateway = new SyscallGateway(broker);
    const dummyHandle = asCapabilityHandle(`cap_${"0".repeat(64)}`);
    let handlerCalls = 0;

    await expect(
      gateway.invoke(
        { principal: kernelPrincipal, handle: dummyHandle, action: "github.publish", resource: publishResource },
        () => {
          handlerCalls += 1;
          return { value: "published" };
        },
      ),
    ).rejects.toThrow(CommitCoordinatorRequiredError);
    expect(handlerCalls).toBe(0);
  });

  it("AC-COMMIT-2: direct repo.write dispatch is DENIED and handler never called", async () => {
    const { broker } = makeCoordinator();
    const gateway = new SyscallGateway(broker);
    const dummyHandle = asCapabilityHandle(`cap_${"0".repeat(64)}`);
    let handlerCalls = 0;

    await expect(
      gateway.invoke(
        { principal: kernelPrincipal, handle: dummyHandle, action: "repo.write", resource: { kind: "repository", id: "sk1ua/ConsistenCy" } },
        () => {
          handlerCalls += 1;
          return { value: "written" };
        },
      ),
    ).rejects.toThrow(CommitCoordinatorRequiredError);
    expect(handlerCalls).toBe(0);
  });

  it("AC-COMMIT-3: llm.invoke stays DIRECT — handler runs inline on ALLOW", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const agent: Principal = { id: makePrincipalId("agent", "security", "run_9"), kind: "agent", runId: "run_9" };
    const handle = broker.issue({
      subject: agent,
      action: "llm.invoke",
      resource: { kind: "llm", provider: "openai" },
    });
    const gateway = new SyscallGateway(broker);
    let handlerCalls = 0;

    const value = await gateway.invoke(
      { principal: agent, handle, action: "llm.invoke", resource: { kind: "llm", provider: "openai" } },
      () => {
        handlerCalls += 1;
        return { value: "completion" };
      },
    );

    expect(value).toBe("completion");
    expect(handlerCalls).toBe(1);
  });

  it("AC-COMMIT-4: accept() rejects a non-commit action and never invokes the sink", async () => {
    const { journal, broker, handle, coordinator, persistCalls } = makeCoordinator();
    // llm.invoke is commit/direct — NOT an intent action.
    await expect(
      coordinator.accept({
        principal: kernelPrincipal,
        handle,
        action: "llm.invoke" as never,
        resource: { kind: "llm", provider: "openai" },
        idempotencyKey: "k1",
        payload: { ok: true },
      }),
    ).rejects.toThrow(CommitIntentRejectedError);
    expect(persistCalls()).toBe(0);
    expect(journal.entries().some((e) => e.type === "commit.intent_accepted")).toBe(false);
    expect(broker).toBeDefined();
  });

  it("AC-COMMIT-5: revocation before acceptance → CapabilityError, no sink, deny event", async () => {
    const { journal, broker, handle, coordinator, persistCalls } = makeCoordinator();
    broker.revoke(handle, makePrincipalId("kernel", "admin"));

    await expect(
      coordinator.accept({
        principal: kernelPrincipal,
        handle,
        action: "github.publish",
        resource: publishResource,
        idempotencyKey: "revoked-key",
        payload: { title: "hi" },
      }),
    ).rejects.toThrow(CapabilityError);

    expect(persistCalls()).toBe(0);
    expect(coordinator.listIntents()).toHaveLength(0);
    expect(journal.entries().some((e) => e.type === "commit.intent_denied" && e.reason === "revoked")).toBe(true);
  });

  it("AC-COMMIT-6: successful accept persists exactly one durable intent", async () => {
    const { journal, handle, coordinator, persisted, persistCalls } = makeCoordinator();

    const receipt = await coordinator.accept({
      principal: kernelPrincipal,
      handle,
      action: "github.publish",
      resource: publishResource,
      idempotencyKey: "github_comment:job_1",
      payload: { summary: "review done" },
      runId: asRunId("run_1"),
    });

    expect(receipt.status).toBe("accepted");
    expect(persistCalls()).toBe(1);
    expect(persisted()).toHaveLength(1);
    const intent = persisted()[0]!;
    expect(intent.idempotencyKey).toBe("github_comment:job_1");
    expect(intent.action).toBe("github.publish");
    expect(intent.runId).toBe("run_1");
    expect(intent.subject).toBe(kernelPrincipal.id);
    expect(intent.payloadHash).toMatch(/^[0-9a-f]{64}$/);
    expect(coordinator.listIntents()).toHaveLength(1);
    expect(coordinator.getIntent(intent.id)).toBe(intent);
    expect(journal.entries().some((e) => e.type === "commit.intent_accepted")).toBe(true);
  });

  it("AC-COMMIT-7: repeated idempotencyKey returns duplicate without re-persisting", async () => {
    const { handle, coordinator, persistCalls } = makeCoordinator();

    const first = await coordinator.accept({
      principal: kernelPrincipal,
      handle,
      action: "github.publish",
      resource: publishResource,
      idempotencyKey: "github_comment:job_1",
      payload: { summary: "review done" },
    });
    const second = await coordinator.accept({
      principal: kernelPrincipal,
      handle,
      action: "github.publish",
      resource: publishResource,
      idempotencyKey: "github_comment:job_1",
      payload: { summary: "review done" },
    });

    expect(first.status).toBe("accepted");
    expect(second.status).toBe("duplicate");
    expect(second.intentId).toBe(first.intentId);
    expect(persistCalls()).toBe(1);
    expect(coordinator.listIntents()).toHaveLength(1);
  });

  it("AC-COMMIT-8: intent + audit never contain a raw capability handle", async () => {
    const { journal, handle, coordinator, persisted } = makeCoordinator();

    await coordinator.accept({
      principal: kernelPrincipal,
      handle,
      action: "github.publish",
      resource: publishResource,
      idempotencyKey: "secret-free",
      payload: { note: "no handles here" },
    });

    const intentJson = JSON.stringify(persisted());
    const auditJson = JSON.stringify(journal.entries());
    expect(intentJson).not.toContain(handle);
    expect(intentJson).not.toContain("cap_");
    expect(auditJson).not.toContain(handle);
    expect(auditJson).not.toContain("cap_");
  });

  it("AC-COMMIT-9: payload body never appears in the audit journal (hash only)", async () => {
    const { journal, handle, coordinator } = makeCoordinator();
    const secretPayloadMarker = "UNIQUE_PAYLOAD_BODY_7f3a9c";

    await coordinator.accept({
      principal: kernelPrincipal,
      handle,
      action: "github.publish",
      resource: publishResource,
      idempotencyKey: "payload-hash-only",
      payload: { summary: `report body ${secretPayloadMarker}` },
    });

    const auditJson = JSON.stringify(journal.entries());
    expect(auditJson).not.toContain(secretPayloadMarker);

    const accepted = journal.entries().find((e) => e.type === "commit.intent_accepted");
    expect(accepted).toBeDefined();
    expect((accepted as { payloadHash: string }).payloadHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC-COMMIT-6b: payloadHash is deterministic and payload-sensitive", async () => {
    const { handle, coordinator } = makeCoordinator();

    const r1 = await coordinator.accept({
      principal: kernelPrincipal, handle, action: "github.publish", resource: publishResource,
      idempotencyKey: "h1", payload: { a: 1, b: [true, null, "x"] },
    });
    const r2 = await coordinator.accept({
      principal: kernelPrincipal, handle, action: "github.publish", resource: publishResource,
      idempotencyKey: "h2", payload: { a: 1, b: [true, null, "x"] },
    });
    const r3 = await coordinator.accept({
      principal: kernelPrincipal, handle, action: "github.publish", resource: publishResource,
      idempotencyKey: "h3", payload: { a: 2, b: [true, null, "x"] },
    });

    const hash = (receipt: CommitReceipt) => coordinator.getIntent(receipt.intentId)!.payloadHash;
    expect(hash(r1)).toBe(hash(r2));
    expect(hash(r1)).not.toBe(hash(r3));
  });
});
