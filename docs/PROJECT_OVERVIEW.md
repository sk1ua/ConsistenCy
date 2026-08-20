# ConsistenCy Project Overview

ConsistenCy is an evidence-grounded code review harness for Git repositories and GitHub pull requests. Instead of substituting human judgment with unverified LLM prose, ConsistenCy organizes code changes, historical context, deterministic AST signals, and agent reasoning into verifiable, evidence-grounded Review Reports.

---

## 1. The Core Architectural Division

$$\text{ConsistenCy v3} = \text{Kernel} + \text{Cordis Harness} + \text{Evidence Engine}$$

1. **Kernel Tier (`@consistency/kernel`)**: Manages the authoritative capability broker, syscall gateway, scheduler, Agent Control Blocks (ACBs), Context VM, and audit journal.
2. **Harness Tier (`@consistency/harness-core`)**: Provides reactive dependency injection, fiber lifecycle management, and coeffect declaration.
3. **Evidence Engine**: Combines Tree-sitter AST queries, secret detectors, style rules, and Python deterministic analyzers to generate cryptographic, reproducible evidence records.

---

## 2. Review Execution Flow

1. A review job is created via local repository trigger or GitHub pull request webhook.
2. `RepositorySnapshot` pins the immutable Git `headSha` and `baseSha`.
3. Deterministic analyzers extract verifiable facts into `EvidenceStore`.
4. `KernelScheduler` admits the Supervisor (Planner) agent and specialized review agents under strict priority and concurrency limits.
5. `SyscallGateway` mediates cross-boundary calls and authorizes LLM queries via `CapabilityBroker`.
6. `ContextVM` manages immutable `ContextPage`s and Copy-On-Write (COW) working sets.
7. Findings are synthesized and linked to concrete `evidenceIds`.
8. Irreversible mutations (such as posting GitHub comments) are safely routed through the `CommitCoordinator` durable outbox.

---

## 3. Product Boundaries & Invariants

- **Real-Data Runtime**: No synthetic demo modes or runtime mock LLMs. Review execution requires a configured real LLM provider (DeepSeek or OpenAI).
- **Repository-First Workspace**: The repository is the root entity, uniting local Git state with remote GitHub PR context.
- **Evidence-Grounded**: Risk scores and findings serve as triage signals grounded in file paths and line numbers; they do not replace human review decisions.

---

## 4. Further Reading

- [System Architecture](architecture.md)
- [Security Model & Isolation](security.md)
- [Repository Workspace Model](repository-workspace.md)
- [Review Runtime & Context VM](review-runtime.md)
- [Configuration Reference](configuration.md)
- [Desktop Host](desktop.md)
- [HTTP API](api.md)
- [Output Schema](output_schema.md)
- [Evaluation Bounds](EVALUATION.md)
