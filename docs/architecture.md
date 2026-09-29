# ConsistenCy v3 Architecture

ConsistenCy v3 is a **Repository-Native Agent Harness OS** for evidence-grounded code review. It organizes review execution into three distinct, cooperating tiers:

$$\text{ConsistenCy v3} = \text{Kernel} + \text{Cordis Harness} + \text{Evidence Engine}$$

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            React / Vite Web UI                              │
│         (Repository Workspace, Overview, Diff, Evidence, Runtime)          │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTP / SSE / Same-Origin /api
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                           apps/api (Host Process)                           │
│        (HTTP Router, SQLite Store, Workload Runtime, Electron Host)         │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
     ┌─────────────────────────────────┼─────────────────────────────────┐
     │ Kernel Tier (@consistency/kernel)                                 │
     ▼                                 ▼                                 ▼
┌──────────────┐             ┌──────────────────┐             ┌─────────────────────┐
│ Run &        │             │ SyscallGateway & │             │ Context VM &        │
│ Scheduler    │             │ CapabilityBroker │             │ Evidence Store      │
└──────┬───────┘             └────────┬─────────┘             └─────────────────────┘
       │                              │
       ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                 Harness Tier (@consistency/harness-core)                     │
│         (Cordis Fiber Lifecycle, CapabilityLifecycleAdapter, Bridges)       │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Workload Tier (@consistency/workload-review)                   │
│        (ReviewWorkload: Supervisor Planner + Specialized Review Agents)     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
      In-Process Built-ins                         Child-Process Sandbox
  (Supervisor / Review Agents)                  (Untrusted Plugins via RPC)
```

---

## 1. Core Architectural Equation

### 1.1 Kernel (`@consistency/kernel`)
The Kernel is the authoritative security, scheduling, memory, and audit boundary:
- **CapabilityBroker**: Default-deny capability authority. Issues opaque 256-bit handles (`cap_<64hex>`) with 12-hex audit fingerprints. Enforces strict 8-step authorization checks on every operation.
- **SyscallGateway**: Intercepts all cross-boundary syscalls. Categorizes operations by `EffectClass` (`pure | read | revertible | commit`) and `DispatchPolicy` (`direct | intent`). Directly executes permitted read/pure operations and mediates `llm.invoke`; routes external mutations (`github.publish`, `repo.write`) through the `CommitCoordinator` intent gate.
- **KernelScheduler**: Cooperative admission control with `maxRunningAgents` concurrency limits, deadline cancellation, and deterministic priority FIFO ordering. Manages state transitions across `NEW`, `READY`, `RUNNING`, `WAIT_LLM`, `WAIT_TOOL`, `WAIT_IO`, `WAIT_AGENT`, `WAIT_HUMAN`, `SUSPENDED`, `SUCCEEDED`, `FAILED`, `CANCELLED`.
- **AgentControlBlock (ACB)**: Immutable metadata records tracking agent lineage, execution domain, logical ring, token budgets, deadline, and capability fingerprints (never raw handles).
- **Context VM**: Text-first immutable `ContextPage`s addressed by SHA-256 `contentHash`. Manages `ContextImage` overlays with page residency (`PINNED`, `HOT`, `COLD`, `EVICTED`), Copy-On-Write (COW) forks for child agents, and `WorkingSet` token estimation.
- **AuditJournal**: Append-only security audit log recording capability issuance, revocations, syscall authorization results, and commit intents using 12-hex fingerprints only.

### 1.2 Cordis Harness (`@consistency/harness-core`)
The Harness provides reactive dependency injection, component lifecycles, and temporal composition:
- **Fiber Lifecycle**: Manages execution lifecycles of reactive agents.
- **Coeffects**: Declarative dependency and effect requirements requested by components.
- **Axiom 1: Coeffect $\neq$ Authorization**: Coeffects declare intent and reactive context requirements. The Kernel's `CapabilityBroker` and `SyscallGateway` remain the sole and authoritative per-call authorization mechanisms.
- **Capability Bridge (`CapabilityLifecycleAdapter`)**: Bridges Kernel capabilities into Cordis coeffects and fiber lifecycles while ensuring per-call Kernel authorization cannot be bypassed.

### 1.3 Evidence Engine
The Evidence Engine grounds review findings in deterministic, reproducible facts:
- **Deterministic Analyzers**: Tree-sitter AST queries (`@consistency/plugins-builtin`), structural pattern rules, secret detectors, and Python stdio analyzers (`engine/`).
- **Evidence Record**: Strongly typed factual records with exact file path, line intervals, analyzer identity, rule ID, confidence, and payload.
- **EvidenceProvenance**: Every evidence item pins `repository`, `sha`, `analyzer`, and `analyzerVersion`.
- **Canonical Fingerprinting**: Cryptographic SHA-256 fingerprints computed over normalized JSON tuples. A change in snapshot revision guarantees a distinct evidence identity.
- **RepositorySnapshot (`@consistency/repository`)**: Immutable tree snapshot pinned to an exact Git `headSha`.

---

## 2. Process & Execution Model

The execution hierarchy flows from external triggers down to fine-grained reactive fibers:

$$\text{ReviewJob} \longrightarrow \text{Run} \longrightarrow \text{Agent / ACB} \longrightarrow \text{Cordis Fiber}$$

```
ReviewJob (Persistent Database Object / Webhook / Local Trigger)
   │
   └── Run (Kernel Run Instance, ID: run_...)
         │
         ├── Supervisor Agent (Planner ACB, Ring 1, in-process)
         │     └── Cordis Fiber (active during planning & coordination)
         │
         ├── Style / Structural Review Agent (ACB, Ring 3, in-process)
         │     └── Cordis Fiber (active during deterministic analysis)
         │
         └── 3rd-Party Plugin Agent (ACB, Ring 3, child-process domain)
               └── Isolated Node Child Process (RPC v1 protocol over IPC)
```

### 2.1 Logical Rings vs. Physical Execution Domains

| Concept | Definition | Values |
|---|---|---|
| **Logical Ring** | Privilege and trust domain for capability issuance | `0` (Kernel), `1` (Mediated Service / Supervisor), `3` (Review Agent / Plugin) |
| **Execution Domain** | Physical process and OS isolation mechanism | `in-process` (trusted built-in), `child-process` (Node IPC sandbox), `worker-thread` (future) |

> **Security Rule**: A Logical Ring is not a physical process boundary. Untrusted Ring 3 plugins run in a dedicated `child-process` execution domain with stripped parent environment secrets and RPC mediation.

---

## 3. Review Lifecycle Flow

```text
[Repository Workspace]
         │
         ▼
[Trigger: Local / Webhook] ──▶ [ReviewJob Created]
                                     │
                                     ▼
                      [RepositorySnapshot Pinned to headSha]
                                     │
                                     ▼
                            [Kernel Run Activated]
                                     │
                 ┌───────────────────┴───────────────────┐
                 ▼                                       ▼
    [Evidence Engine: Analyzers]             [KernelScheduler Admits Supervisor]
                 │                                       │
                 ▼                                       ▼
       [EvidenceStore Grounding]              [Context VM: COW Base Image]
                 │                                       │
                 └───────────────────┬───────────────────┘
                                     │
                                     ▼
                       [Specialized Review Agents Run]
                                     │
                                     ▼
                        [SyscallGateway Mediates LLM]
                                     │
                                     ▼
                     [Findings Grounded with Evidence]
                                     │
                                     ▼
                      [CommitCoordinator Intent Gate]
                                     │
                                     ▼
                    [ReviewReport Persisted in SQLite]
                                     │
                                     ▼
                     [Outbox Lease & GitHub Publish]
```

---

## 4. Invariant Matrix

| Concept A | $\neq$ | Concept B | Architectural Truth |
|---|---|---|---|
| **Coeffect** | $\neq$ | **Authorization** | Coeffect declares reactive intent; `CapabilityBroker` authorizes syscalls. |
| **Logical Ring** | $\neq$ | **Execution Domain** | Ring 3 agents may run in-process (built-in) or in a child-process sandbox. |
| **Context Possession** | $\neq$ | **Syscall Permission** | Possessing a `ContextPage` grants zero syscall or mutation privileges. |
| **ACB Capability Ref** | $\neq$ | **Raw Handle** | ACB stores only 12-hex fingerprints; 256-bit handles are verified per call. |
| **Fiber ACTIVE** | $\neq$ | **Scheduler RUNNING** | Fiber lifecycle reflects harness execution; scheduler tracks cooperative waiting (`WAIT_LLM`, etc.). |
| **EffectClass** | $\neq$ | **DispatchPolicy** | `llm.invoke` is `commit`/`direct`; `github.publish` is `commit`/`intent`. |
| **Child Process** | $\neq$ | **Full OS Containment** | Memory & env secrets are isolated; OS-level filesystem and network containment are not enforced. |

---

## 5. Navigation & References

- [Security Model & Isolation Boundaries](security.md)
- [Repository Workspace Model](repository-workspace.md)
- [Review Runtime & Context VM](review-runtime.md)
- [Runtime Configuration & Precedence](configuration.md)
- [Electron Desktop Host](desktop.md)
- [HTTP API Reference](api.md)
