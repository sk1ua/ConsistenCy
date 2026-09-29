/**
 * PR-1.1 security hardening tests — AC-11 through AC-15.
 *
 * These tests cover bugs found during human red-team review of the 41-test
 * PR-1 suite. All five failures would have passed the original test run
 * despite being exploitable.
 *
 * AC-11: A scope-declared SHA cannot be bypassed by omitting sha in the request.
 * AC-12: A scope-declared path constraint cannot be bypassed by omitting path.
 * AC-13: Successful Gateway calls actually consume the maxCalls budget.
 * AC-14: Failed Gateway calls release the reservation (no budget leak).
 * AC-15: A GitHub publish capability pinned to PR #42 cannot target PR #43.
 */

import { describe, it, expect } from "vitest";
import { CapabilityBroker } from "../capability/broker.js";
import { SyscallGateway } from "../syscall/authorize.js";
import { CapabilityError } from "../capability/errors.js";
import { MemoryJournal } from "../audit/memoryJournal.js";
import { makePrincipalId } from "../identity/principal.js";
import type { Principal } from "../identity/principal.js";
import type { RepositoryResource } from "../identity/resource.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function makePair() {
  const journal = new MemoryJournal();
  const broker  = new CapabilityBroker(journal);
  const gateway = new SyscallGateway(broker);
  return { journal, broker, gateway };
}

// ---------------------------------------------------------------------------
// AC-11: Scope SHA cannot be bypassed by omitting sha in the request
// ---------------------------------------------------------------------------

describe("AC-11: SHA scope omission is a scope_violation", () => {
  it("request without sha is denied when capability has scope.sha", () => {
    const { broker } = makePair();
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
        // sha intentionally omitted — must DENY, not ALLOW
      })
    ).toThrow(CapabilityError);
  });

  it("deny reason is scope_violation, not any other reason", () => {
    const { broker, journal } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      scope: { sha: "abc123" },
    });

    try {
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });
    } catch {
      // expected
    }

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toBe("scope_violation");
  });

  it("providing the correct sha is still allowed", () => {
    const { broker } = makePair();
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
});

// ---------------------------------------------------------------------------
// AC-12: Path scope cannot be bypassed by omitting path in the request
// ---------------------------------------------------------------------------

describe("AC-12: path scope omission is a scope_violation", () => {
  it("request without path is denied when capability has scope.paths", () => {
    const { broker } = makePair();
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
        // path intentionally omitted — must DENY, not ALLOW
      })
    ).toThrow(CapabilityError);
  });

  it("deny reason is scope_violation", () => {
    const { broker, journal } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      scope: { paths: ["src/**"] },
    });

    try {
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo });
    } catch {
      // expected
    }

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials[0]!.reason).toBe("scope_violation");
  });

  it("providing a path within scope is still allowed", () => {
    const { broker } = makePair();
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
        path: "src/index.ts",
      })
    ).not.toThrow();
  });

  it("combined sha+path omission: omitting both is denied", () => {
    const { broker } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      scope: { sha: "abc", paths: ["src/**"] },
    });

    // No sha, no path → scope_violation
    expect(() =>
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
    ).toThrow(CapabilityError);
  });
});

// ---------------------------------------------------------------------------
// AC-13: Successful Gateway calls actually consume the maxCalls budget
// ---------------------------------------------------------------------------

describe("AC-13: successful Gateway invocations consume the maxCalls budget", () => {
  it("third call is denied after two successful gateway invocations", async () => {
    const { broker, gateway } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      budget: { maxCalls: 2 },
    });

    const req = { principal: agentA, handle, action: "repo.read" as const, resource: repo };
    const handler = () => ({ value: "ok" });

    // First two calls succeed
    await gateway.invoke(req, handler);
    await gateway.invoke(req, handler);

    // Third call must be denied — budget is truly consumed, not just reserved
    await expect(gateway.invoke(req, handler)).rejects.toThrow(CapabilityError);
  });

  it("deny reason is budget_exhausted on the third call", async () => {
    const { broker, gateway, journal } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      budget: { maxCalls: 1 },
    });

    const req = { principal: agentA, handle, action: "repo.read" as const, resource: repo };
    await gateway.invoke(req, () => ({ value: "ok" }));

    try {
      await gateway.invoke(req, () => ({ value: "ok" }));
    } catch {
      // expected
    }

    const denials = journal.ofType("syscall.authorised").filter(e => e.decision === "deny");
    expect(denials).toHaveLength(1);
    expect(denials[0]!.reason).toBe("budget_exhausted");
  });
});

// ---------------------------------------------------------------------------
// AC-14: Failed Gateway calls release the reservation (no budget leak)
// ---------------------------------------------------------------------------

describe("AC-14: failed Gateway invocations release the reservation", () => {
  it("a handler that throws releases the budget reservation", async () => {
    const { broker, gateway } = makePair();
    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      budget: { maxCalls: 1 },
    });

    const req = { principal: agentA, handle, action: "repo.read" as const, resource: repo };

    // First call: handler throws
    await expect(
      gateway.invoke(req, () => { throw new Error("handler failure"); })
    ).rejects.toThrow("handler failure");

    // Budget reservation must have been released — second call should be allowed
    // (the first call failed, so it should not have consumed the budget)
    await expect(
      gateway.invoke(req, () => ({ value: "ok" }))
    ).resolves.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// AC-15: GitHub publish capability pinned to PR #42 cannot target PR #43
// ---------------------------------------------------------------------------

describe("AC-15: github.publish pullNumber constraint is enforced", () => {
  it("capability with pullNumber=42 denies access to pullNumber=43", () => {
    const { broker } = makePair();
    const handle = broker.issue({
      subject: kernelP,
      action: "github.publish",
      resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 42 },
    });

    expect(() =>
      broker.authorise({
        principal: kernelP,
        handle,
        action: "github.publish",
        resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 43 },
      })
    ).toThrow(CapabilityError);
  });

  it("capability with pullNumber=42 allows access to pullNumber=42", () => {
    const { broker } = makePair();
    const handle = broker.issue({
      subject: kernelP,
      action: "github.publish",
      resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 42 },
    });

    expect(() =>
      broker.authorise({
        principal: kernelP,
        handle,
        action: "github.publish",
        resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 42 },
      })
    ).not.toThrow();
  });

  it("capability without pullNumber allows any PR (no constraint set)", () => {
    const { broker } = makePair();
    const handle = broker.issue({
      subject: kernelP,
      action: "github.publish",
      resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy" },
    });

    // No pullNumber constraint on capability → any PR is allowed
    expect(() =>
      broker.authorise({
        principal: kernelP,
        handle,
        action: "github.publish",
        resource: { kind: "github.publish", repositoryId: "sk1ua/ConsistenCy", pullNumber: 99 },
      })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Additional: expiresAt boundary — exactly at boundary must DENY
// ---------------------------------------------------------------------------

describe("expiry boundary: expiresAt === now must DENY", () => {
  it("capability expiring at exactly now is denied (not off-by-one allowed)", () => {
    let fakeNow = 5_000_000;
    const journal = new MemoryJournal();
    const broker  = new CapabilityBroker(journal, () => fakeNow);

    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      expiresAt: fakeNow + 1_000,
    });

    // Move clock to exactly expiresAt
    fakeNow += 1_000;

    expect(() =>
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
    ).toThrow(CapabilityError);
  });

  it("capability still valid 1ms before expiresAt is allowed", () => {
    let fakeNow = 5_000_000;
    const journal = new MemoryJournal();
    const broker  = new CapabilityBroker(journal, () => fakeNow);

    const handle = broker.issue({
      subject: agentA,
      action: "repo.read",
      resource: repo,
      expiresAt: fakeNow + 1_000,
    });

    // Move clock to 1ms before expiry
    fakeNow += 999;

    expect(() =>
      broker.authorise({ principal: agentA, handle, action: "repo.read", resource: repo })
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Additional: llm.invoke is now issuable to agent principals (Ring model fix)
// ---------------------------------------------------------------------------

describe("Ring model: agent can be issued llm.invoke (mediated syscall)", () => {
  it("issues llm.invoke capability to an agent principal without throwing", () => {
    const { broker } = makePair();
    const serviceAgent: Principal = {
      id: makePrincipalId("agent", "style", "run_001"),
      kind: "agent",
      runId: "run_001",
    };

    expect(() =>
      broker.issue({
        subject: serviceAgent,
        action: "llm.invoke",
        resource: { kind: "llm", provider: "openai" },
        budget: { maxTokens: 10_000 },
      })
    ).not.toThrow();
  });

  it("repo.write is still denied for agent principals (Ring 0 only)", () => {
    const { broker } = makePair();
    expect(() =>
      broker.issue({
        subject: agentA,
        action: "repo.write",
        resource: repo,
      })
    ).toThrow(CapabilityError);
  });
});
