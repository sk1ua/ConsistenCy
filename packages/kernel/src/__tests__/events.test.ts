/**
 * CapabilityChangeBus tests — the minimal Kernel lifecycle-notification API.
 *
 * These tests prove two properties:
 *  1. The bus delivers `issued` / `revoked` events synchronously with enough
 *     information for a harness to keep service availability in sync.
 *  2. Events NEVER leak the raw capability handle or the mutable
 *     CapabilityRecord — only the 12-hex-char fingerprint is exposed.
 *     (A notification is lifecycle metadata, not authorization.)
 */

import { describe, it, expect } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityChangeBus, type CapabilityChangeEvent } from "../capability/events.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

const agentA: Principal = { id: makePrincipalId("agent", "style", "run_001"), kind: "agent", runId: "run_001" };
const kernelP: Principal = { id: makePrincipalId("kernel", "core"), kind: "kernel" };
const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

function makeBusPair() {
  const journal = new MemoryJournal();
  const bus = new CapabilityChangeBus();
  const broker = new CapabilityBroker(journal, Date.now, bus);
  return { journal, bus, broker };
}

describe("CapabilityChangeBus — lifecycle notifications", () => {
  it("emits capability.issued when a capability is issued", () => {
    const { bus, broker } = makeBusPair();
    const events: CapabilityChangeEvent[] = [];
    bus.subscribe((e) => events.push(e));

    broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("capability.issued");
    expect(events[0]!.subject).toBe(agentA.id);
    expect(events[0]!.action).toBe("repo.read");
    expect(events[0]!.resourceKind).toBe("repository");
  });

  it("emits capability.revoked when a capability is revoked", () => {
    const { bus, broker } = makeBusPair();
    const events: CapabilityChangeEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);

    expect(events).toHaveLength(2);
    const revoked = events[1]!;
    expect(revoked.type).toBe("capability.revoked");
    expect(revoked.subject).toBe(agentA.id);
    expect(revoked.action).toBe("repo.read");
    expect(revoked.resourceKind).toBe("repository");
  });

  it("never exposes the raw capability handle in any event payload", () => {
    const { bus, broker } = makeBusPair();
    const events: CapabilityChangeEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);

    for (const event of events) {
      expect(JSON.stringify(event)).not.toContain(handle);
      expect(JSON.stringify(event)).not.toContain("cap_");
      expect(event.handleFingerprint).toMatch(/^[0-9a-f]{12}$/);
    }
  });

  it("exposes only metadata, never the CapabilityRecord", () => {
    const { bus, broker } = makeBusPair();
    const received: unknown[] = [];
    bus.subscribe((e) => received.push(e));

    broker.issue({ subject: agentA, action: "repo.read", resource: repo });

    const event = received[0] as Record<string, unknown>;
    expect(Object.keys(event).sort()).toEqual([
      "action",
      "handleFingerprint",
      "resourceKind",
      "subject",
      "timestamp",
      "type",
    ]);
  });

  it("delivers to all subscribers and stops after unsubscribe", () => {
    const { bus, broker } = makeBusPair();
    const seenA: CapabilityChangeEvent[] = [];
    const seenB: CapabilityChangeEvent[] = [];
    const unsubA = bus.subscribe((e) => seenA.push(e));
    bus.subscribe((e) => seenB.push(e));

    broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(1);

    unsubA();
    broker.issue({ subject: agentA, action: "repo.search", resource: repo });
    expect(seenA).toHaveLength(1);
    expect(seenB).toHaveLength(2);
  });

  it("unsubscribe is idempotent", () => {
    const { bus, broker } = makeBusPair();
    const seen: CapabilityChangeEvent[] = [];
    const unsub = bus.subscribe((e) => seen.push(e));
    unsub();
    unsub();
    broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    expect(seen).toHaveLength(0);
  });

  it("bus is optional — broker works unchanged without one", () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const handle = broker.issue({ subject: agentA, action: "repo.read", resource: repo });
    broker.revoke(handle, kernelP.id);
    expect(journal.entries().filter((e) => e.type === "capability.revoked")).toHaveLength(1);
  });
});
