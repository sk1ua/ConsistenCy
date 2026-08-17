/**
 * Scope matching tests.
 *
 * AC verified:
 *   AC-3: Expired capability is denied.
 *   AC-6: SHA 'abc' capability denies access to SHA 'def'.
 *   AC-7: src/** capability denies access to tests/**.
 *
 * Also verifies path-traversal defence in normaliseResourcePath.
 */

import { describe, it, expect } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { CapabilityError } from "../capability/errors.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import { normaliseResourcePath } from "../identity/resource.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

const agentA: Principal = {
  id: makePrincipalId("agent", "style", "run_001"),
  kind: "agent",
  runId: "run_001",
};

const repo: RepositoryResource = { kind: "repository", id: "sk1ua/ConsistenCy" };

function makeBroker(overrideClock?: () => number) {
  const journal = new MemoryJournal();
  const broker = new CapabilityBroker(journal, overrideClock);
  return { broker, journal };
}

describe("CapabilityBroker — scope and expiry", () => {
  describe("AC-3: expiry", () => {
    it("authorise succeeds before expiresAt", () => {
      const now = Date.now();
      const { broker } = makeBroker(() => now);
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        expiresAt: now + 10_000,
      });

      expect(() =>
        broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
      ).not.toThrow();
    });

    it("AC-3: authorise fails after expiresAt", () => {
      let fakeNow = 1_000_000;
      const { broker } = makeBroker(() => fakeNow);

      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        expiresAt: fakeNow + 5_000,
      });

      // Advance clock past expiry
      fakeNow += 10_000;

      expect(() =>
        broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
      ).toThrow(CapabilityError);
    });

    it("cannot issue a capability with a past expiresAt", () => {
      const fakeNow = 1_000_000;
      const { broker: b2 } = makeBroker(() => fakeNow);
      expect(() =>
        b2.issue({
          subject: agentA,
          action: "repo.read",
          resource: repo,
          expiresAt: fakeNow - 1,
        })
      ).toThrow(RangeError);
    });
  });

  describe("AC-6: SHA pin", () => {
    it("SHA-pinned capability allows correct SHA", () => {
      const { broker } = makeBroker();
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        scope: { sha: "abc123" },
      });

      expect(() =>
        broker.authorise({
          principal: agentA,
          handle,
          action: "repo.read",
          resource: repo,
          sha: "abc123",
        })
      ).not.toThrow();
    });

    it("AC-6: SHA-pinned capability denies different SHA", () => {
      const { broker } = makeBroker();
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        scope: { sha: "abc123" },
      });

      expect(() =>
        broker.authorise({
          principal: agentA,
          handle,
          action: "repo.read",
          resource: repo,
          sha: "def456",
        })
      ).toThrow(CapabilityError);
    });
  });

  describe("AC-7: path scope", () => {
    it("src/** grants src/index.ts and src/api/foo.ts", () => {
      const { broker } = makeBroker();
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        scope: { paths: ["src/**"] },
      });

      const base = {
        principal: agentA,
        handle,
        action: "repo.read" as const,
        resource: repo,
      };

      expect(() => broker.authorise({ ...base, path: "src/index.ts" })).not.toThrow();
      expect(() => broker.authorise({ ...base, path: "src/api/foo.ts" })).not.toThrow();
    });

    it("AC-7: src/** denies tests/foo.ts", () => {
      const { broker } = makeBroker();
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        scope: { paths: ["src/**"] },
      });

      expect(() =>
        broker.authorise({
          principal: agentA,
          handle,
          action: "repo.read",
          resource: repo,
          path: "tests/foo.ts",
        })
      ).toThrow(CapabilityError);
    });

    it("combined SHA + path scope: must satisfy both", () => {
      const { broker } = makeBroker();
      const handle = broker.issue({
        subject: agentA,
        action: "repo.read",
        resource: repo,
        scope: { sha: "abc", paths: ["src/**"] },
      });

      const base = {
        principal: agentA,
        handle,
        action: "repo.read" as const,
        resource: repo,
      };

      // Right SHA, right path → OK
      expect(() => broker.authorise({ ...base, sha: "abc", path: "src/x.ts" })).not.toThrow();
      // Right SHA, wrong path → DENY
      expect(() => broker.authorise({ ...base, sha: "abc", path: "tests/x.ts" })).toThrow(CapabilityError);
      // Wrong SHA, right path → DENY
      expect(() => broker.authorise({ ...base, sha: "xyz", path: "src/x.ts" })).toThrow(CapabilityError);
    });
  });
});

describe("normaliseResourcePath — traversal defence", () => {
  it("accepts normal relative paths", () => {
    expect(normaliseResourcePath("src/index.ts")).toBe("src/index.ts");
    expect(normaliseResourcePath("./src/index.ts")).toBe("src/index.ts");
    expect(normaliseResourcePath("a/b/c.ts")).toBe("a/b/c.ts");
  });

  it("normalises Windows backslashes", () => {
    expect(normaliseResourcePath("src\\api\\foo.ts")).toBe("src/api/foo.ts");
  });

  it("rejects .. segments", () => {
    expect(() => normaliseResourcePath("../secret")).toThrow(TypeError);
    expect(() => normaliseResourcePath("src/../../etc/passwd")).toThrow(TypeError);
  });

  it("rejects absolute Unix paths", () => {
    expect(() => normaliseResourcePath("/etc/passwd")).toThrow(TypeError);
  });

  it("rejects absolute Windows paths", () => {
    expect(() => normaliseResourcePath("C:/Windows/system32")).toThrow(TypeError);
  });

  it("rejects paths with NUL bytes", () => {
    expect(() => normaliseResourcePath("src/foo\0bar.ts")).toThrow(TypeError);
  });

  it("rejects empty strings", () => {
    expect(() => normaliseResourcePath("")).toThrow(TypeError);
  });
});
