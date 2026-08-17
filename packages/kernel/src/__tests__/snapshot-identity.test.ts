/**
 * Snapshot identity policy tests — URI scheme + AC-SNAP-7 (snapshot
 * possession is NOT authorization).
 */

import { describe, it, expect } from "vitest";
import {
  CapabilityBroker,
  CapabilityError,
  MemoryJournal,
  SnapshotUriError,
  SyscallGateway,
  asRepositorySnapshotId,
  formatSnapshotUri,
  makePrincipalId,
  parseSnapshotUri,
  type ASTResource,
  type Principal,
  type RepositoryResource,
} from "../index.js";

describe("RepositorySnapshot identity policy", () => {
  it("formats and parses snapshot URIs round-trip", () => {
    const id = asRepositorySnapshotId("snap_123");
    const uri = formatSnapshotUri("sk1ua/ConsistenCy", id);
    expect(uri).toBe("snapshot://sk1ua/ConsistenCy/snap_123");
    expect(parseSnapshotUri(uri)).toEqual({ repository: "sk1ua/ConsistenCy", snapshotId: id });
  });

  it("fails closed on malformed URIs", () => {
    for (const bad of [
      "repo://sk1ua/ConsistenCy/snap_1",
      "snapshot://",
      "snapshot://sk1ua/ConsistenCy",
      "snapshot://sk1ua/ConsistenCy/",
      "snapshot://onlyrepo/snap_1",
      "snapshot://a/b/c/d",
      "snapshot://sk1ua/ConsistenCy/sna p",
      "",
    ]) {
      expect(() => parseSnapshotUri(bad)).toThrow(SnapshotUriError);
    }
    expect(() => formatSnapshotUri("not-a-repo-format", id("snap_1"))).toThrow(SnapshotUriError);
    expect(() => formatSnapshotUri("sk1ua/ConsistenCy", id("with/slash"))).toThrow(SnapshotUriError);
  });

  it("AC-SNAP-7: knowing a snapshotId does NOT authorize repo.read syscalls", async () => {
    const journal = new MemoryJournal();
    const broker = new CapabilityBroker(journal);
    const gateway = new SyscallGateway(broker);
    const agent: Principal = { id: makePrincipalId("agent", "snap", "run-1"), kind: "agent", runId: "run-1" };

    // The agent "possesses" a snapshot reference (id + URI).
    const snapshotId = asRepositorySnapshotId("snap_known");
    const uri = formatSnapshotUri("sk1ua/ConsistenCy", snapshotId);
    expect(parseSnapshotUri(uri).snapshotId).toBe(snapshotId);

    // It holds only an ast.query capability — nothing repository-scoped.
    const astResource: ASTResource = { kind: "ast", snapshotId: "snap-1" };
    const handle = broker.issue({ subject: agent, action: "ast.query", resource: astResource });
    const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

    // Possessing the snapshot reference does not authorize repo.read.
    let handlerInvoked = false;
    await expect(
      gateway.invoke(
        { principal: agent, handle, action: "repo.read", resource: repo },
        () => {
          handlerInvoked = true;
          return { value: "never" };
        },
      ),
    ).rejects.toMatchObject({ name: "CapabilityError", reason: "action_mismatch" } satisfies Partial<CapabilityError>);
    expect(handlerInvoked).toBe(false);
  });
});

function id(raw: string) {
  return asRepositorySnapshotId(raw);
}
