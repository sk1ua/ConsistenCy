/**
 * AuditJournal tests.
 *
 * AC verified:
 *   AC-9: Every allow AND deny produces an AuditEvent.
 *
 * Also verifies:
 *   - Raw capability handles do NOT appear in audit events (credential-leak prevention).
 *   - MemoryJournal helpers (ofType, clear) work correctly.
 */

import { describe, it, expect } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

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

const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

describe("AuditJournal — completeness and credential hygiene", () => {
  it("AC-9: records an event for every allow decision", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });

    const events = journal.ofType("syscall.authorised");
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe("allow");
  });

  it("AC-9: records an event for every deny decision", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    try {
      broker.authorise({
        principal: agentB,   // wrong principal → deny
        handle,
        action: "repo.read",
        resource: repo,
      });
    } catch {
      // expected
    }

    const events = journal.ofType("syscall.authorised");
    expect(events).toHaveLength(1);
    expect(events[0]!.decision).toBe("deny");
    expect(events[0]!.reason).toBe("subject_mismatch");
  });

  it("no audit event contains the full raw capability handle", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });

    // Serialise every event and scan for the raw handle string
    const allJson = JSON.stringify(journal.entries());
    expect(allJson).not.toContain(handle);

    // Fingerprints are present and are exactly 12 chars
    for (const event of journal.entries()) {
      if ("handleFingerprint" in event) {
        const e = event as { handleFingerprint: string };
        expect(e.handleFingerprint).toHaveLength(12);
      }
    }
  });

  it("capability.issued event does not contain the raw handle", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    const issued = journal.ofType("capability.issued");
    expect(issued).toHaveLength(1);
    expect(JSON.stringify(issued[0]!)).not.toContain(handle);
  });

  it("capability.revoked event is recorded with correct fields", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const kernelPrincipal: Principal = {
      id: makePrincipalId("kernel", "core"),
      kind: "kernel",
    };

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelPrincipal.id);

    const revoked = journal.ofType("capability.revoked");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]!.subject).toBe(agentA.id);
    expect(revoked[0]!.revokedBy).toBe(kernelPrincipal.id);
  });

  it("MemoryJournal.clear() resets the event list", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    expect(journal.entries()).toHaveLength(1);

    journal.clear();
    expect(journal.entries()).toHaveLength(0);
  });
});
