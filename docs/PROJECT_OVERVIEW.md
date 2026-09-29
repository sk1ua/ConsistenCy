# ConsistenCy Project Overview

ConsistenCy is a terminal-first, evidence-grounded code review harness for Git repositories and GitHub pull requests. Instead of substituting human judgment with unverified LLM prose, ConsistenCy organizes code changes, historical context, deterministic AST signals, and agent reasoning into verifiable, evidence-grounded Review Reports. Its product surface is the command line: `consistency review` (`npm run review`) renders a Review Report to the terminal, or emits it as JSON with `--json`.

> **版本口径**：本文描述当前检出 **v4（terminal-only）**。产品谱系名仍是 v3（冻结的 [CONSISTENCY_V3_MASTER_SPEC.md](CONSISTENCY_V3_MASTER_SPEC.md)）；v4 删除了 Web UI 与 Electron 桌面宿主，只保留 CLI 与无界面 HTTP daemon，差异见 [delivery-readiness.md](delivery-readiness.md)。

---

## 1. The Core Architectural Division

$$\text{ConsistenCy v4} = \text{Kernel} + \text{Cordis Harness} + \text{Evidence Engine}$$

1. **Kernel Tier (`@consistency/kernel`)**: Manages the authoritative capability broker, syscall gateway, scheduler, Agent Control Blocks (ACBs), Context VM, and audit journal.
2. **Harness Tier (`@consistency/harness-core`)**: Provides reactive dependency injection, fiber lifecycle management, and coeffect declaration.
3. **Evidence Engine**: Combines Tree-sitter AST queries, secret detectors, style rules, and Python deterministic analyzers to generate cryptographic, reproducible evidence records.

---

## 2. Review Execution Flow

1. A review is started from the terminal entry (`consistency review`) over a local repository or commit range, or from a GitHub pull request webhook when a GitHub App is configured.
2. `RepositorySnapshot` pins the immutable Git `headSha` and `baseSha`.
3. Deterministic analyzers extract verifiable facts into `EvidenceStore`.
4. `KernelScheduler` admits the Supervisor (Planner) agent and specialized review agents under strict priority and concurrency limits.
5. `SyscallGateway` mediates cross-boundary calls and authorizes LLM queries via `CapabilityBroker`.
6. `ContextVM` manages immutable `ContextPage`s and Copy-On-Write (COW) working sets.
7. Findings are synthesized and linked to concrete `evidenceIds`.
8. Irreversible mutations (such as posting GitHub comments) are safely routed through the `CommitCoordinator` durable outbox.

---

## 3. Product Boundaries & Invariants

- **Terminal-First Surface**: The product surface is the command line — `consistency review` over a repository or commit range. ConsistenCy ships no bundled GUI; the HTTP API is a headless HTTP, queue, and persistence layer.
- **Real-Data Runtime**: No synthetic demo modes or runtime mock LLMs. Review execution requires a configured real LLM provider (DeepSeek, OpenAI, or Anthropic).
- **Repository-First Workspace**: The repository is the root entity, uniting local Git state with remote GitHub PR context.
- **Evidence-Grounded**: Risk scores and findings serve as triage signals grounded in file paths and line numbers; they do not replace human review decisions.

---

## 4. Further Reading

- [System Architecture](architecture.md)
- [Security Model & Isolation](security.md)
- [Repository Workspace Model](repository-workspace.md)
- [Review Runtime & Context VM](review-runtime.md)
- [Configuration Reference](configuration.md)
- [GitHub App Setup](GITHUB_APP_SETUP.md)
- [HTTP API](api.md)
- [Output Schema](output_schema.md)
- [Evaluation Bounds](EVALUATION.md)
