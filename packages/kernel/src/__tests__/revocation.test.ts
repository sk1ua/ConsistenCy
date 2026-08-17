/**
 * Revocation tests.
 *
 * AC verified:
 *   AC-2: After revoke(), the very next authorise() call MUST fail.
 *   AC-9: All allow/deny decisions produce AuditEvents.
 *   AC-10: The handler is NEVER called on a denied syscall.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { SyscallGateway } from "../syscall/authorize.js";
import { CapabilityError } from "../capability/errors.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

const agentA: Principal = {
  id: makePrincipalId("agent", "style", "run_001"),
  kind: "agent",
  runId: "run_001",
};

const kernelP: Principal = {
  id: makePrincipalId("kernel", "core"),
  kind: "kernel",
};

const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

describe("CapabilityBroker — revocation", () => {
  let broker: CapabilityBroker;
  let journal: MemoryJournal;
  let gateway: SyscallGateway;

  beforeEach(() => {
    journal = new MemoryJournal();
    broker = new CapabilityBroker(journal);
    gateway = new SyscallGateway(broker);
  });

  it("AC-2: authorise succeeds before revoke, fails after", () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    // Should succeed
    expect(() =>
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
    ).not.toThrow();

    // Revoke
    broker.revoke(handle, kernelP.id);

    // Must now fail
    expect(() =>
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
    ).toThrow(CapabilityError);

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toBe("revoked");
  });

  it("revoke is idempotent — revoking twice does not throw", () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);
    expect(() => broker.revoke(handle, kernelP.id)).not.toThrow();
  });

  it("revoke produces a capability.revoked audit event", () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);

    const revocations = journal.ofType("capability.revoked");
    expect(revocations).toHaveLength(1);
    expect(revocations[0]!.revokedBy).toBe(kernelP.id);
    expect(revocations[0]!.handleFingerprint).toHaveLength(12);
  });

  it("AC-10: gateway.invoke does NOT call handler when revoked (deny-before-execute)", async () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);

    let handlerInvoked = false;

    await expect(
      gateway.invoke(
        { principal: agentA, handle, action: "repo.read", resource: repo },
        () => {
          handlerInvoked = true;
          return "should not reach here";
        }
      )
    ).rejects.toThrow(CapabilityError);

    expect(handlerInvoked).toBe(false);
  });

  it("AC-9: every allow and deny produces an audit syscall event", () => {
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    // 1 allow
    broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });
    // 1 deny (revoke + retry)
    broker.revoke(handle, kernelP.id);
    try {
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });
    } catch {
      // expected
    }

    const syscallEvents = journal.ofType("syscall.authorised");
    expect(syscallEvents).toHaveLength(2);
    expect(syscallEvents[0]!.decision).toBe("allow");
    expect(syscallEvents[1]!.decision).toBe("deny");
  });
});
