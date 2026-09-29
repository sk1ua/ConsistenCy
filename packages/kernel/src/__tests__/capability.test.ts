/**
 * Capability issuance and basic isolation tests.
 *
 * AC verified:
 *   AC-1: Agent A's capability cannot be used by Agent B.
 *   AC-4: repo.read capability cannot authorise a repo.write action.
 *   AC-5: capability for repo A cannot access repo B.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityError } from "../capability/errors.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

function makeJournaledBroker() {
  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal);
  return { broker, journal };
}

const agentA: Principal = {
  id: makePrincipalId("agent", "style", "run_001"),
  kind: "agent",
  runId: "run_001",
};

const agentB: Principal = {
  id: makePrincipalId("agent", "security", "run_001"),
  kind: "agent",
  runId: "run_001",
};

const repo: RepositoryResource = {
  kind: "repository",
  id: "sk1ua/ConsistenCy",
};

describe("CapabilityBroker — issuance and isolation", () => {
  let broker: CapabilityBroker;
  let journal: MemoryJournal;

  beforeEach(() => {
    ({ broker, journal } = makeJournaledBroker());
  });

  it("issues a handle that resolves internally", () => {
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
    });

    expect(handle).toMatch(/^cap_[0-9a-f]{64}$/i);
    const record = broker._getRecord(handle);
    expect(record).toBeDefined();
    expect(record!.subject).toBe(agentA.id);
    expect(record!.action).toBe("repo.read");
  });

  it("AC-1: Agent B cannot use Agent A's capability handle", () => {
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
    });

    expect(() =>
      broker.authorise({
        principal: agentB,       // ← wrong principal
        handle,
        action: "repo.read",
        resource: repo,
      })
    ).toThrow(CapabilityError);

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toBe("subject_mismatch");
  });

  it("AC-4: repo.read capability denies repo.write", () => {
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
    });

    // repo.write is Ring 0 — agentA (kind: agent) cannot even receive one,
    // but authorise also rejects the action mismatch on an existing handle.
    expect(() =>
      broker.authorise({
        principal: agentA,
        handle,
        action: "repo.write",   // ← wrong action
        resource: repo,
      })
    ).toThrow(CapabilityError);

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials[0]!.reason).toBe("action_mismatch");
  });

  it("AC-5: capability for repository A denies access to repository B", () => {
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: { kind: "repository", id: "owner/repo-A" },
    });

    expect(() =>
      broker.authorise({
        principal: agentA,
        handle,
        action: "repo.read",
        resource: { kind: "repository", id: "owner/repo-B" },
      })
    ).toThrow(CapabilityError);

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials[0]!.reason).toBe("resource_mismatch");
  });

  it("Ring policy rejects issuing a Ring-0 action to an agent principal", () => {
    expect(() =>
      broker.issue({
        subject: agentA,        // agent cannot hold Ring 0 capability
        action: "repo.write",
        resource: repo,
      })
    ).toThrow();
  });

  it("audit log records a capability.issued event on successful issue", () => {
    broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    const issued = journal.ofType("capability.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]!.subject).toBe(agentA.id);
    expect(issued[0]!.action).toBe("repo.read");
    // Handle fingerprint must NOT be the full handle
    expect(issued[0]!.handleFingerprint).toHaveLength(12);
  });

  it("authorise produces an audit allow event on success", () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });

    const allows = journal.ofType("syscall.authorised").filter(e => e.decision === "allow");
    expect(allows).toHaveLength(1);
    expect(allows[0]!.reason).toBe("granted");
  });
});
