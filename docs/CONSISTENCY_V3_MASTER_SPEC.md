# ConsistenCy v3 — 统一架构、规约与路线图

> **Document Type:** Canonical Project Memory / Architecture Constitution / Roadmap  
> **Version:** 1.0  
> **Date:** 2026-08-23  
> **Project:** ConsistenCy v3  
> **Paradigm:** Repository-Native Agent Harness OS  
> **Primary Workload:** Repository / PR Review  
> **Status:** Core architecture locked; Repository Workspace substantially complete; next major milestone is Cordis-native Workflow Runtime & Studio.

---

## 0. 这份文档是什么

这份文档把 ConsistenCy v3 长期对话、架构重构、迁移记录、Checkpoint 计划、Desktop/Web 重构、验证规约和后续路线统一成一份可长期保存的项目级 Markdown。

它的目的不是记录某一次 Agent 的回复，而是建立一个稳定的 **Project Constitution**：

- 项目到底是什么；
- 为什么存在；
- Kernel、Cordis、Evidence、Context VM、Scheduler 的职责分别是什么；
- 哪些边界不可重新解释；
- Workflow、Repository Workspace、Desktop UI 应该如何建立在底层真实语义之上；
- 后续 Coding Agent / OmO / ZCode / Codex 必须遵守什么；
- 什么叫“完成”，什么只是“代码写出来了”；
- 当前已经完成到哪里；
- 下一阶段应该做什么；
- 哪些行为严格禁止。

> **重要：Completion is an evidence claim, not a language-model claim.**

如果本文件、旧 Agent 日志、Checkpoint ledger、源码之间发生冲突，使用以下真相优先级：

```text
Current Git / Current Source / Current Runtime Evidence
        >
Canonical in-repo architecture & security docs
        >
Current Checkpoint plan / ledger / evidence
        >
Historical architecture drafts
        >
Historical Agent summaries / chat logs
```

旧文档中的“尚未实现”“当前分支”等状态字段可能已经被后续开发 supersede；但已被后续实现持续保留的架构公理仍然有效。

---

# 1. 项目使命

## 1.1 一句话定义

**ConsistenCy v3 是一个 Repository-Native Agent Harness OS。**

它不是一个“LLM 帮你 Review PR”的网页，也不是一个 Git GUI，更不是普通 Agent Chat Desktop。

它的目标是：

> 在多 Agent、高频 PR、自动化代码生成和长期仓库演进下，为 Repository 提供安全、可组合、可验证、可审计、可持续运行的 Agent Harness。

核心问题不是：

> “AI 能不能给我指出 bug？”

而是：

> “当越来越多 Agent 持续修改同一个仓库时，谁控制 Agent 的权限、上下文、调度、证据、运行生命周期、外部副作用与长期一致性？”

PR Review 是第一个 Workload，不是产品本体。

## 1.2 产品核心价值

ConsistenCy v3 应最终回答五个问题：

1. **Who may do what?** — Kernel Capability / authorization。
2. **Which components should currently be alive?** — Cordis Fiber / service / coeffect lifecycle。
3. **Who runs now?** — Kernel Scheduler / admission / budget / concurrency。
4. **What does the Agent see?** — Context VM / ContextImage / WorkingSet。
5. **What facts prove the result?** — Evidence Engine / RepositorySnapshot / provenance。

最终产品链路：

```text
Repository
   ↓
Git / GitHub / PR Context
   ↓
Workflow
   ↓
Run
   ↓
Agent Processes / Cordis Fibers
   ↓
Evidence / Findings
   ↓
Human Decision
   ↓
Optional Commit Intent
```

---

# 2. 系统总公式

## 2.1 物理架构公式

ConsistenCy v3 的物理核心：

\[
\text{ConsistenCy v3}
=
\text{Kernel}
+
\text{Cordis Harness}
+
\text{Evidence Engine}
\]

Scheduler 和 Context VM 属于 Kernel 子系统，不是平级独立核心。

概念上的 5 层图可以用于解释：

```text
┌───────────────────────────────────────────────┐
│ Applications                                  │
│ Desktop / Web / API / CLI                     │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│ Workloads / Product Runtime                   │
│ Review / Notebook / Audit / Workflow          │
└───────────────────────┬───────────────────────┘
                        │
┌───────────────────────▼───────────────────────┐
│ Cordis Harness                                │
│ Fiber / Effect / Coeffect / Dynamic Services  │
└───────────────────────┬───────────────────────┘
                        │ syscall
════════════════════════╪════════════════════════
                        │
┌───────────────────────▼───────────────────────┐
│ Kernel                                        │
│ Capability / Scheduler / Context VM / Audit   │
│ Snapshot / Sandbox / Persistence / Resource   │
└─────────┬─────────────┬─────────────┬─────────┘
          │             │             │
          ▼             ▼             ▼
        Git/FS          LLM         GitHub/Network

               Evidence Engine
       deterministic protected subsystem
```

真正的安全边界是：

```text
Cordis Harness
      ↓
CapabilityBoundFacade / SyscallGateway
      ↓
Kernel authorization
```

而不是某个 React 页面，也不是 Cordis Context。

---

# 3. 架构公理（不可重新解释）

这些规则属于 **Architecture Axiom**，不是 Design Preference。

除非项目 owner 明确修改架构，否则任何 Coding Agent 都不得自行重新定义。

## Axiom 1 — Cordis Coeffect ≠ Kernel Authorization

```text
Capability = 权限
Coeffect   = 环境 / 服务可用性
```

Cordis 可以回答：

> 当前 Agent 是否具备进入 ACTIVE 状态所需的服务？

Kernel 必须回答：

> 当前 Principal 是否被允许在此时、对此 Resource、执行此 Operation？

两次检查独立存在：

```text
Kernel Capability
       ↓
Cordis Coeffect
       ↓
Fiber Lifecycle
```

但：

```text
Coeffect != Authorization
```

即使 Fiber 因传播延迟仍然 ACTIVE，只要 Capability 已 revoke：

```text
next protected syscall
        ↓
Kernel authorize
        ↓
DENY
        ↓
handler MUST NOT run
```

**安全不能依赖 Cordis lifecycle 的及时性。**

## Axiom 2 — Effect ≠ Rollback

Cordis Effect 描述：

- 组件做了什么；
- 生命周期期间产生了什么 effect；
- unload 时哪些 effect 可以 dispose。

它不自动意味着外部世界可回滚。

```text
Effect
  !=
Transaction
  !=
Rollback
  !=
Compensation
```

GitHub publish、repo write、远程 LLM 请求等不可被“dispose”当作不存在。

## Axiom 3 — Ring ≠ Execution Domain

逻辑权限 Ring 与代码运行在哪里，是两条独立轴。

```text
Ring
!=
Process
!=
Execution Domain
!=
Cordis Context
```

典型组合：

| Component | Logical Ring | Execution Domain |
|---|---:|---|
| Credential Vault | Ring 0 | Kernel internal |
| LLM Gateway | Ring 1 | in-process protected service |
| RepositorySnapshot | Ring 1 | in-process protected service |
| Built-in analyzer | Ring 3 | in-process Fiber |
| Untrusted plugin | Ring 3 | child-process / container |

**Ring 3 不等于已 sandbox。**

## Axiom 4 — Cordis Context Isolation ≠ Process Security Isolation

`ctx.isolate(...)` 是：

- context-scoped dependency isolation；
- service visibility isolation；
- lifecycle isolation。

它不是：

- filesystem sandbox；
- network sandbox；
- process boundary；
- OS privilege system。

不得在 UI、README、security docs 中把 Cordis Context 描述成 hostile-code sandbox。

## Axiom 5 — Context VM ≠ Permission System

Context VM 控制：

> Agent 当前“看见什么”。

Capability 控制：

> Agent 当前“能做什么”。

即使 Agent 没有看到某个 secret，也不能因此声称安全；反之，即使某个数据在 Context 中，受保护 syscall 仍必须通过 Kernel authorization。

## Axiom 6 — Scheduler 属于 Kernel

Scheduler 不是 Cordis plugin。

它拥有：

- admission authority；
- concurrency authority；
- priority/fairness；
- token/cost/wall-time budgets；
- cancellation propagation；
- deadline enforcement；
- provider rate-limit accounting。

远程 LLM inference 不可像 CPU instruction 一样物理抢占。

因此 Scheduler 的真实模型：

```text
admission control
+
cooperative scheduling
+
budget / concurrency control
```

不是虚假的 preemptive CPU scheduler。

## Axiom 7 — Evidence 是 correctness，不是日志

Evidence 必须用于证明：

- snapshot identity；
- analyzer output；
- syscall decision；
- capability decision；
- execution result；
- review finding；
- reproducibility。

Agent 不允许仅凭自然语言：

> “任务已经完成。”

Finding 必须能够追溯到 evidence。

## Axiom 8 — Repository / GitHub Authority 不得伪造

```text
Local Git
→ working tree / status / commits / branches / remotes

GitHub Provider API
→ Pull Request identity / lifecycle
```

禁止从以下数据推断并伪装成 authoritative PR：

- commit message；
- merge commit；
- branch name；
- ReviewJob；
- report；
- local history。

ReviewJob 只能作为 PR 的 optional association metadata，例如 `latestReview`。

---

# 4. Kernel

## 4.1 Kernel 定位

`@consistency/kernel` 是 Trusted Core / authority root。

Kernel 必须独立于：

- Cordis；
- LangGraph；
- LangChain；
- Octokit；
- OpenAI / DeepSeek SDK；
- ReviewFinding domain；
- Web UI。

Kernel 只理解平台级概念：

```text
Principal
Capability
Resource
Operation
Scope
Lease
Quota
Budget
Syscall
Run
AgentControlBlock
ContextImage
RepositorySnapshot
AuditEvent
Evidence boundary
Execution Domain
```

## 4.2 Capability 模型

Capability 应是 Kernel-issued opaque handle。

典型概念：

```text
Principal
Resource
Action
Scope
Lease
Quota
Expiry
Budget
```

每一个受保护操作必须收敛到：

```text
Agent
  ↓
CapabilityBoundFacade
  ↓
SyscallGateway
  ↓
CapabilityBroker.authorize
  ↓
Audit
  ↓
Handler
```

基本不变量：

```text
Default = DENY

DENY must happen before handler invocation.

Raw service / credential / secret
MUST NOT be exposed to Ring 3 Agent.
```

## 4.3 Revocation

Revocation 语义：

```text
revoked capability
→ all future syscalls denied immediately
```

但：

- 不保证已发出的远程 LLM inference 被物理撤销；
- 不保证外部系统已经发生的 mutation 回滚；
- cancellation 是另一套机制。

---

# 5. Agent OS 模型

ConsistenCy 使用 OS 类比，但不能滥用这个类比。

```text
Process address space ≈ LLM context
Resources             ≈ tools / MCP / repository / network
Child process         ≈ subagent
Syscall               ≈ tool / model call
PCB                   ≈ ACB
```

Agent OS：

```text
Process Management
+
Virtual Context Memory
+
Capability Security
+
LLM Scheduling
```

## 5.1 四级执行层次

不要混淆：

```text
Job
  ↓
Run
  ↓
Agent / ACB
  ↓
Cordis Fiber
```

含义：

- **Job**：用户希望完成什么；
- **Run**：该 Job 的一次具体执行；
- **Agent / ACB**：一个逻辑 Agent Process；
- **Fiber**：Cordis Runtime 中承载该 Agent lifecycle 的实例。

已有 `ReviewJob` 属于 Job tier。

## 5.2 Agent State

标准状态：

```text
NEW
READY
RUNNING
WAIT_LLM
WAIT_TOOL
WAIT_IO
WAIT_AGENT
WAIT_HUMAN
SUSPENDED
SUCCEEDED
FAILED
CANCELLED
```

解释：

- `RUNNING`：本地 runtime 正在执行逻辑；
- `WAIT_LLM`：已经提交异步 inference；
- `WAIT_TOOL`：等待 tool/syscall；
- `WAIT_AGENT`：等待子 Agent；
- `WAIT_HUMAN`：需要用户批准或人工输入。

## 5.3 ACB

AgentControlBlock 至少应承载：

```text
id
runId
state
priority
parent
children
contextImage
capability refs / fingerprints
logicalRing
executionDomain
modelPolicy
tokenBudget
costBudget
wallTimeBudget
pendingOperation
createdAt
deadline
```

ACB 不应该持有 raw secret。

---

# 6. Cordis Harness

## 6.1 Cordis 的准确定义

Cordis 在 ConsistenCy 中应理解为：

> **Reactive DI + RAII + Plugin Runtime + Dynamic Service/Coeffect Fabric**

它负责：

- service discovery；
- dependency availability；
- context-scoped service exposure；
- Fiber lifecycle；
- event/reflection；
- dynamic composition；
- effect cleanup；
- dependency epoch change。

它不负责：

- final authorization；
- capability issuance；
- secret ownership；
- Kernel syscall permission。

## 6.2 Fiber 生命周期

一个组件可以声明依赖：

```text
repository.read
evidence.write
ast.query
llm.invoke
```

Cordis 观察服务可用性。

全部满足：

```text
PENDING → ACTIVE
```

依赖消失：

```text
dependency epoch changed
→ UNLOADING
→ reverse cleanup effects
→ PENDING
```

重新满足：

```text
PENDING → ACTIVE
```

这就是 temporal composability。

## 6.3 Spatial / Temporal Composability

### Spatial composability

组件的结构由 dependency graph 组织。

### Temporal composability

组件被卸载时，它负责的可释放 effect 必须被完整清理。

Fiber effects 应收集 disposer，并 reverse-order cleanup。

## 6.4 Capability → Coeffect Bridge

正确桥接：

```text
Kernel Capability
      ↓
Capability Lifecycle Adapter
      ↓
Agent-scoped Cordis Context
      ↓
CapabilityBoundFacade
      ↓
Fiber can become ACTIVE
```

但是每次真实调用仍是：

```text
Fiber
  ↓
Facade
  ↓
Kernel authorization
```

不得在 Cordis Context 中缓存一个“永远允许”的授权状态。

---

# 7. Context VM

## 7.1 ContextPage 是语义对象

不是任意 token chunk。

标准 `kind`：

```text
policy
task
diff
source
ast
symbol
evidence
tool-result
memory
summary
```

Residency：

```text
PINNED
HOT
COLD
EVICTED
```

## 7.2 ContextImage / WorkingSet

```text
ContextImage
    ↓
WorkingSet selection
    ↓
page-in required pages
    ↓
render
    ↓
provider-neutral messages/prompt
    ↓
ModelDriver.invoke
```

Context Manager 不应该直接绑定 OpenAI-specific message semantics。

## 7.3 Copy-on-Write

Subagent fork：

```text
Base ContextImage
   ├─ Security overlay
   ├─ Style overlay
   └─ Logic overlay
```

COW 的含义是：

> host-side shared context state + private overlays。

不是：

> 自动减少 LLM tokens。

真正 token savings 取决于：

- WorkingSet projection；
- summary；
- provider prefix caching；
- render strategy。

## 7.4 Context VM 初始 primitive 原则

底层 primitive 不应假装自动拥有：

- retrieval；
- summarization；
- eviction policy；
- semantic ranking。

这些应作为更高层 policy 逐步加入。

---

# 8. RepositorySnapshot 与 Evidence Engine

## 8.1 RepositorySnapshot

Snapshot 是 SHA-fixed immutable repository world。

目的：

```text
same snapshot identity
→ same code world
→ reproducible analyzer/evidence behavior
```

不能让一个 Review Run 在分析过程中悄悄漂移到新的 HEAD。

## 8.2 Evidence

Evidence 典型结构：

```ts
interface Evidence {
  id: EvidenceId;
  source: "ast" | "sast" | "git" | "lint" | "symbol" | "test" | "agent";
  ruleId?: string;
  location: {
    path: string;
    startLine?: number;
    endLine?: number;
  };
  confidence: number;
  fingerprint: string;
  payload: unknown;
  provenance: {
    repository: string;
    sha: string;
    analyzer: string;
    analyzerVersion: string;
  };
}
```

Finding：

```text
Finding
  └─ evidenceIds[]
```

LLM reasoning 不能替代 Evidence。

## 8.3 Tree-sitter

`TreeSitterService` 是基础设施。

```text
TreeSitterService
    ├─ AST analyzer
    ├─ SAST analyzer
    ├─ Symbol analyzer
    ├─ Style analyzer
    └─ Secret analyzer
```

它本身不是 analyzer。

---

# 9. Effect、Dispatch 与 CommitCoordinator

## 9.1 EffectClass

当前语义：

```ts
type EffectClass =
  | "pure"
  | "read"
  | "revertible"
  | "commit";
```

典型：

```text
ast.query      → pure
repo.read      → read
tempfile       → revertible
llm.invoke     → commit
github.publish → commit
repo.write     → commit
```

注意：`commit` 表示外部不可简单回滚的 effect，不代表一定通过 Outbox。

## 9.2 DispatchPolicy

独立于 EffectClass：

```ts
type DispatchPolicy =
  | "direct"
  | "intent";
```

已确认：

```text
llm.invoke      = commit / direct
github.publish  = commit / intent
repo.write      = commit / intent
```

## 9.3 Intent Flow

外部 mutation：

```text
ReviewReport
    ↓
CommitCoordinator
    ↓
Durable Intent
    ↓
Existing SQLite Outbox
    ↓
Publish / Commit Worker
    ↓
GitHub / Repository
```

必须保留已有：

- SQLite WAL；
- lease；
- fencing；
- retry；
- idempotency。

Intent 中不应包含 raw capability handle / credential。

---

# 10. Sandbox 与 Execution Domain

## 10.1 当前已实现安全真相

Child-process execution domain 可以真实声称：

```text
process memory isolation = enforced
parent environment secret isolation = enforced
Kernel RPC authorization = enforced
```

不能声称：

```text
filesystem OS containment
network OS containment
subprocess OS containment
```

除非后续真的引入 OS/container policy。

## 10.2 Untrusted Plugin

Untrusted Ring 3 code：

```text
child process / container
   ↓
restricted RPC
   ↓
server-side identity binding
   ↓
Kernel authorization
```

Sandbox child 不持有 raw Kernel capability record。

Node `vm` 不用于 hostile-code security isolation。

---

# 11. Workload Review

Review 是第一个正式 Workload。

权威 runtime：

```text
@consistency/workload-review
```

历史 legacy LangGraph / LangChain review runtime 已从权威运行路径移除。

典型 Review 流程：

```text
ReviewJob
  ↓
Kernel Run
  ↓
multiple ACBs
  ↓
Scheduler admission
  ↓
Cordis Fibers
  ↓
RepositorySnapshot / Context VM / Evidence
  ↓
Findings
  ↓
ReviewReport
```

Review Agent 可以包括：

- Supervisor；
- Security；
- Logic / Contract；
- Style；
- Tests；
- Synthesizer；
- 其他可验证 analyzer/agent。

---

# 12. LLM Runtime 规约

## 12.1 Real-only Runtime

用户已经明确废弃：

```text
Demo Mode
Mock LLM runtime
/demo/seed
mock-fixture product runtime
synthetic demo repositories pretending to be real
```

测试可以有 test-scoped fixture/driver。

但 production runtime 不得重新引入 Mock Provider。

## 12.2 无 LLM 时

允许：

- Repository browsing；
- Git status；
- changes；
- commits；
- GitHub PR read。

禁止执行：

- review；
- Notebook LLM reasoning；
- 需要 provider 的 workflow node。

## 12.3 Settings ≠ Active Runtime

这是一个强不变量：

```text
/settings
=
persisted desired configuration

/health
=
active runtime configuration
```

保存 Provider 后：

```text
saved config != active runtime
```

直到 Runtime restart。

UI 必须真实表达：

```text
已保存
Runtime 尚未应用
[重启 Runtime]
```

不能在保存后假装 provider 已立刻 active。

## 12.4 Per-review Model Override

Review 可以：

```text
Global default
or
Per-review override { provider, model }
```

要求：

- 只允许 server 声明可用的 provider；
- 未配置 credential 的 provider 不可执行；
- global default 模式不发送冗余 override；
- custom 模式只发送 provider + model；
- 空 model 禁止提交；
- override 不写 SettingsStore；
- ReviewJob / AgentRun / ReviewReport 持久化实际 `llmProvider` / `llmModel`；
- 历史 review provenance 不随 Settings 改变；
- Review-bound Notebook 应尽可能继承该 review 的模型 provenance。

---

# 13. Repository Authority Model

## 13.1 Repository 是第一产品对象

Repository Workspace 的心智模型：

```text
Repository
  → Git / PR Context
  → Review / Workflow
  → Runtime
  → Evidence / Findings
```

不是 Dashboard-first。

## 13.2 Local + GitHub unified identity

一个 Repository 可同时拥有：

```text
Local checkout
+
GitHub remote identity
```

不能因为同一 repo 有 local + GitHub 就在 sidebar 重复创建两个产品对象。

## 13.3 Local Git authority

Local Git 管：

- branch；
- HEAD；
- working tree；
- changes；
- commits；
- remotes；
- repo-local history。

## 13.4 GitHub authority

Pull Request lifecycle 必须来自 GitHub/provider：

```text
provider
number
title
state
author
baseRef
headRef
baseSha
headSha
createdAt
updatedAt
mergedAt
htmlUrl
```

Review association：

```text
latestReview?: {
  jobId
  status
  score?
  riskLevel?
  createdAt
}
```

ReviewJob 不填充 PR identity/lifecycle。

## 13.5 Git History：EMPTY != UNAVAILABLE

必须保持：

```text
available=true
commits=[]
```

= 仓库读取成功，但确实没有 commit / unborn HEAD。

```text
available=false
reason=...
commits=[]
```

= Git history 无法读取。

UI 不得把 operational failure 显示成“暂无提交”。

## 13.6 Repository ID 安全

Renderer/API 产品路径应使用 opaque repository ID。

禁止重新引入：

- raw path 作为 public selector；
- displayName fuzzy resolution；
- `local:` 自造 alias；
- 通过 basename 猜 repo。

Public DTO 不泄漏绝对本地路径。

---

# 14. Desktop / Electron

## 14.1 Desktop 定位

Electron Desktop 不是一个简单 BrowserWindow wrapper。

它是：

> Trusted Desktop Harness Host。

## 14.2 Desktop 安全结构

基本原则：

```text
contextIsolation = true
nodeIntegration  = false
sandbox          = true
```

Renderer 不持有：

- API child token；
- dynamic port secret；
- raw local path；
- stored credential。

## 14.3 Native Repository Picker

正确流程：

```text
Renderer
  ↓ IPC
Electron Main
  ↓ native dialog
local folder path
  ↓ internal API
Repository registration
  ↓
sanitized Repository DTO
  ↓
Renderer
```

raw filesystem path 留在 trusted host。

## 14.4 API Helper

Packaged Desktop：

```text
Electron Main
  ↓
spawn external Node 22 API helper
  ↓
127.0.0.1:<ephemeral-port>
```

要求：

- strict loopback；
- readiness handshake `/health`；
- one active helper；
- restart waits old child exit；
- intentional restart/quit 不弹 crash dialog；
- unexpected active child failure 才报告；
- app exit 后无 orphan helper。

## 14.5 Credential

Desktop credential 使用 OS encryption / Electron `safeStorage`。

Renderer 永远不读取 stored plaintext secret。

## 14.6 Build Provenance

Package 必须满足：

```text
clean source HEAD
=
packaged build SHA
```

Desktop build 应显示版本和 build SHA。

不允许把一个旧安装包误当作当前源码。

---

# 15. Web / Desktop Product UX Constitution

## 15.1 产品风格

参考现代 developer-agent desktop：

- Codex；
- DeepSeek Harness / desktop；
- OpenCode-like compact tooling；
- IDE agent workbench。

但不机械复制任何产品。

设计重点：

```text
density
hierarchy
repository context
task context
evidence
runtime truth
```

## 15.2 明确拒绝的模式

禁止回归：

- Activity Rail + Context Explorer 双 rail；
- 多层 persistent nav；
- Browser-style underlined internal actions；
- giant marketing hero；
- card soup；
- permanent empty right panel；
- global Inspector + Runtime Inspector 两套 Inspector；
- Bottom Run Ledger；
- Workbench `Inbox | Current` tab strip；
- Chat-first canvas；
- Workflow / Automation 重复产品；
- Demo data；
- UI 自行推断 backend trust/readiness。

## 15.3 Shell

目标：

```text
[ Repository-first Sidebar ]
[ Main Workspace + slim breadcrumb/location ]
[ Optional selection-driven Inspector ]
[ Minimal Status Bar ]
```

要求：

- 一个 persistent sidebar；
- Inspector 无 selection 时 width=0；
- command palette Ctrl+K/Cmd+K；
- bottom status bar compact；
- internal navigation 不能使用浏览器原生下划线链接。

## 15.4 Theme

支持：

```text
system
light
dark
```

`system` 必须真实跟随 OS。

Primary action 使用 semantic token。

禁止：

```css
color: white;
```

这种单主题 hack 导致 light/dark 反色。

## 15.5 Localization

zh-CN 是主要人工验收语言。

保留标准专名：

```text
Git
GitHub
PR
HEAD
API
DeepSeek
OpenAI
LLM
Runtime
Kernel
Cordis
Evidence
```

中文页面不应泄漏 generic backend English reason。

---

# 16. 当前产品 Surface

## 16.1 全局

目标全局导航：

```text
收件箱
代码仓库
审查运行
审查发现
工作流

[底部/上方小齿轮 Settings]
```

Settings 不应继续作为主要工作对象。

## 16.2 Repository Workspace

完成/目标：

```text
Overview
Changes
Git History
Pull Requests
Reviews
Workflows
```

其中 Checkpoint 2 已重点完成：

- Changes；
- Git History；
- Authoritative GitHub Pull Requests；
- Review Composer。

`Reviews` 和 repository-local `Workflows` 仍需要后续正式产品化。

## 16.3 Review Run

```text
Overview
Diff
Evidence
Notebook
Runtime
```

Runtime 应呈现：

- Run / Agent process tree；
- Agent state；
- execution domain；
- logical ring；
- Context VM WorkingSet；
- capability descriptors；
- truthful sandbox guarantees。

---

# 17. Workflow / Automation 统一原则

Automation 和 Workflow 不应作为两个重复顶层产品对象。

Primary Product Object：

```text
Workflow
```

Workflow 至少包含：

```text
Definitions
Triggers / Policies
```

旧 `/automations` 可以作为 backend domain / compatibility route，但 UI 应整合进 Workflow。

---

# 18. Checkpoint 3 — Cordis-native Workflow Runtime & Studio

这是当前下一阶段最关键的产品/架构里程碑。

它不能只重做 React Flow UI。

必须把 Workflow 真正接到：

```text
Workflow Definition
        ↓
Workflow Validation / Compilation
        ↓
Cordis Fiber Graph
        ↓
Coeffect resolution
        ↓
Kernel Capability Validation
        ↓
Scheduler / Run / ACB
        ↓
Evidence
```

## 18.1 CKPT3 目标

让用户可以通过：

1. 可视化 DAG；
2. 右侧 Workflow Agent Copilot；
3. Verified built-in workflow library；

构建一个 **真实可执行、可验证的 Agent Workflow**。

## 18.2 Workflow Studio 建议布局

```text
┌──────────────────────────────────────────────────────────────┐
│ Workflow: PR Security Review        Validate  Dry Run  Save   │
├──────────────┬─────────────────────────────┬─────────────────┤
│ Workflow     │                             │ Agent Copilot   │
│ Library      │        Graph Canvas         │                 │
│              │                             │ 自然语言编辑     │
│ Verified     │   [Analyzer]                │                 │
│ Built-ins    │       ↓                     │ Proposed Patch  │
│ Drafts       │   [Security Agent]          │                 │
│              │       ↓                     │ Apply / Reject  │
│              │   [Evidence Gate]           │                 │
│              │       ↓                     │                 │
│              │   [Synthesizer]             │                 │
└──────────────┴─────────────────────────────┴─────────────────┘
```

右侧不是普通 chat。

它必须产出结构化 `WorkflowPatch`。

## 18.3 WorkflowPatch

用户：

> 给这个 workflow 加一个 secret scan；high severity 时必须经过 verifier 再进入 synthesizer。

Agent 应产生结构化 proposal，例如：

```text
ADD_NODE secret-scan
TYPE analyzer.secret

ADD_NODE secret-verifier
TYPE verifier.security

ADD_EDGE changed-files -> secret-scan

ADD_EDGE secret-scan -> secret-verifier
CONDITION severity >= high

ADD_EDGE secret-verifier -> synthesizer
```

执行链：

```text
Natural language
   ↓
WorkflowPatch
   ↓
Schema validation
   ↓
Graph validation
   ↓
Coeffect / service resolution
   ↓
Capability validation
   ↓
Dry-load / Dry-run
   ↓
Human Apply
```

不得让 LLM 直接无约束改 runtime JSON。

## 18.4 Node Registry

UI 中可用积木必须来自真实 registry。

推荐类别：

```text
Agent
Analyzer
Verifier
Synthesizer
Evidence Gate
Condition
Parallel
Join
Review Output
```

节点参数可包含：

```text
model policy
timeout
context budget
dependencies
failure policy
required evidence
parameters
execution profile
```

不能展示 Runtime 不支持的假节点。

## 18.5 Cordis Dry-load

Workflow 保存前应能够展示：

```text
SecurityAgent
✓ repository.read
✓ evidence.write
✗ ast.query unavailable

Synthesizer
✓ evidence.read
✓ llm.invoke

Publish
✗ github.publish capability unavailable
```

这将是 ConsistenCy 与普通 n8n / LangGraph 可视化编辑器的核心区别：

> 不是“线连上了所以合法”，而是“服务、Capability、Context、Evidence path、execution profile 都满足，所以当前 Harness 可执行”。

## 18.6 Workflow → Run

正确执行链：

```text
Workflow Definition
   ↓
Compilation / Resolution
   ↓
Run
   ↓
ACB creation
   ↓
Scheduler admission
   ↓
Fiber activation
   ↓
ContextImage fork
   ↓
Tool/LLM syscalls
   ↓
Evidence
   ↓
Findings / Report
```

---

# 19. Verified Built-in Workflows

内置 workflow 不能只是 example YAML。

每个必须有 deterministic verification。

## 19.1 `pr-review`

```text
Changed Files / Branch Diff
      ↓
Structural
Semantic
Duplication
      ↓
Evidence Validation
      ↓
Synthesizer
      ↓
Review Report
```

## 19.2 `pr-sanity-verification`

```text
Diff
 ↓
Impact Analysis
 ↓
Syntax / Build / Test Verification
 ↓
Evidence Gate
 ↓
Merge Readiness
```

## 19.3 `security-hardening`

```text
Changed Files
 ├─ Secret Scan
 ├─ Injection Analysis
 ├─ Dependency Risk
 └─ Auth Boundary Analysis
          ↓
      Security Agent
          ↓
      Evidence Gate
          ↓
       Synthesizer
```

## 19.4 `architectural-drift`

```text
RepositorySnapshot
       ↓
Dependency Graph
Schema/API Diff
Module Coupling
Historical Evidence
       ↓
Architecture Agent
       ↓
Drift Findings
```

## 19.5 `vibe-safety`

面向 Agent-generated code 的旗舰验证 workflow：

```text
Agent-generated Changes
          ↓
Security
Dependency
Architecture
Schema
Syntax
Build
Tests
          ↓
Evidence-backed Verification
          ↓
Risk / Confidence Report
```

## 19.6 Built-in Workflow 验证要求

每个 built-in 至少证明：

```text
Definition parses
Capabilities resolve
Graph is valid
No circular dependency
Required Evidence path exists
Expected agents are admitted
Expected verifier executes
Failure path is deterministic
Report can be synthesized
```

---

# 20. Repository-local Reviews / Workflows

Checkpoint 3 应删除 repository 中仍存在的 prototype placeholder。

## 20.1 Repository Reviews

应展示该 Repository 的：

```text
Recent Reviews
Running Reviews
Failed Reviews
Findings Summary
Model
Workflow
Source
Commit / PR
Risk
```

点击进入真实 Review Run：

```text
Overview
Diff
Evidence
Notebook
Runtime
```

## 20.2 Repository Workflows

不是第二套 Builder。

应该是绑定关系：

```text
此仓库启用的工作流

PR Review              Enabled
Security Hardening     Enabled
Architecture Drift     Manual
Vibe Safety            Enabled

[管理工作流]
```

“管理工作流”进入全局 Workflow Studio。

---

# 21. Checkpoint 4 — Desktop Settings & Shell Productization

Settings 应从“大型后台表单页面”重构成 Desktop-grade configuration surface。

## 21.1 Settings Entry

从左侧主导航移除“系统设置”作为主产品对象。

建议：

```text
收件箱
代码仓库
审查运行
审查发现
工作流

────────
⚙
```

点击齿轮打开 modal/dialog。

## 21.2 Settings Dialog

建议：

- 居中；
- 820–960px；
- rounded；
- backdrop；
- 内部左侧二级导航；
- 不整页跳转；
- 不一页拉到底。

```text
┌─────────────────────────────────────┐
│ 设置                            ×    │
├────────────┬────────────────────────┤
│ 模型       │                        │
│ GitHub     │   Current Section      │
│ 审查       │                        │
│ Runtime    │                        │
│ 外观       │                        │
│ Desktop    │                        │
│ 关于       │                        │
└────────────┴────────────────────────┘
```

## 21.3 Settings Sections

### 模型

```text
Default Provider
Default Model
Base URL
Credential
Test Connection
```

### GitHub

```text
Anonymous public read
PAT
GitHub App
Webhook
Connection status
```

### 审查

```text
Default workflow
Default model
Context budget
Concurrency
Review defaults
```

### Runtime

```text
API state
Runtime state
Restart Runtime
Storage
Worker concurrency
```

### 外观

```text
System / Light / Dark
Language
Density
```

### Desktop

```text
Start on login
Minimize to tray
Close behavior
Notifications
```

### 关于

```text
ConsistenCy version
Build SHA
Runtime versions
Open logs
```

---

# 22. Checkpoint 5 — End-to-End Productization

目标：

把各层能力收敛成稳定 release candidate。

范围：

```text
real review execution
workflow execution observability
failure recovery
onboarding
workflow templates
repository onboarding
desktop packaging
upgrade / migration
runtime recovery
release acceptance
```

需要最终证明：

```text
Repository
→ Workflow
→ Run
→ ACB/Fiber
→ Evidence
→ Finding
→ Human decision
```

不是仅存在组件。

---

# 23. Roadmap 总览

```text
Architecture Migration
├─ PR-1 Kernel Foundation
├─ PR-2 Cordis Vertical Slice
├─ PR-2.1 Agent Process / Scheduler
├─ PR-3 Context VM
├─ PR-4 RepositorySnapshot + Evidence
├─ PR-5A Review Workload Migration
├─ PR-5B CommitCoordinator
├─ PR-6A Execution Domain
└─ PR-6B Runtime Observability
        ↓
Checkpoint 1
Desktop Shell / Design System / Repository Overview
        ↓
Checkpoint 2
Repository Workspace
├─ Changes
├─ History
├─ Authoritative GitHub PR
└─ Review Composer
        ↓
Checkpoint 3
Cordis-native Workflow Runtime & Studio
        ↓
Checkpoint 4
Desktop Settings & Shell Productization
        ↓
Checkpoint 5
End-to-End Productization / Release
```

---

# 24. 历史实现里程碑（用于代码考古，不作为当前 HEAD 声明）

以下是此前对话中已经完成过的主要实现节点。它们用于理解代码为什么变成现在这样；当前精确 SHA/branch 必须以 `git` 为准。

| Milestone | Historical commit / note |
|---|---|
| PR-1 Kernel foundation | capability foundation + hardening |
| PR-2 Cordis Harness vertical slice | `64276427836feb4ac43012b71c32d9bb2ba93ccd` |
| PR-2.1 Agent Process foundations | `9089aaf2563ae0ea3afd0f44c3cd493e67f97ad` |
| PR-3 Context VM | `bcd2db8b9f6f856a2418dffa2a5173c0737bb663` |
| PR-4 Snapshot + Evidence | `d0fdaf9acb5bae3a529dfc90f8d6a1ab877d677b` |
| PR-5A Review Workload | `3654d80479aa66e2600f92989c3b8267bfcee3ec` |
| PR-5B CommitCoordinator | `cf29eee` |
| PR-6A Child-process execution domain | `e44b1e98a354ccc372d9e686a5dac6bdc0f89b19` |
| PR-6B Runtime Task Manager | `e1453769c52c2197fbfb81a1cd33e9e8bb3047b5` |
| RC architecture audit | `04a41f300e24f6394966552742140addc76a9668` |
| later v3 preview baseline | `c4de53c659334ba29bd392f11aa69d61500c29e6` |

之后还有多轮 Desktop、frontend、real-only runtime、repository workspace、review model、workflow UI 等工作。不要仅凭这张表推断当前 HEAD。

---

# 25. Checkpoint 1 状态与冻结规则

Checkpoint 1 的核心结果是建立：

- modern Desktop developer-tool shell；
- design-system primitives；
- repository-first navigation；
- theme；
- modal；
- command palette；
- selection-driven Inspector；
- Repository Overview。

Checkpoint 2 明确要求冻结它。

后续如果没有明确产品决定，不应轻易重做：

- Shell；
- Sidebar；
- top location bar；
- theme model；
- core button/link primitives；
- localization architecture；
- Inspector single-instance principle。

---

# 26. Checkpoint 2 范围与结果

Checkpoint 2 的正式 scope：

```text
Repository Changes
Git History
Authoritative GitHub Pull Requests
Review Composer
```

强 guardrail：

Checkpoint 2 不做：

- Workflow；
- Repository Reviews；
- Evidence；
- Runtime；
- Notebook；
- Kernel；
- Harness；
- Scheduler；
- Context VM；
- Capability；
- Sandbox。

因此 Workflow / Reviews placeholder 没被 CKPT2 填完，是 scope 设计结果，不是 CKPT2 漏做。

## 26.1 CKPT2 关键语义

### Changes

- tracked / untracked / binary / rename；
- deterministic master/detail；
- 不写 Git。

### History

- empty != unavailable；
- bounded history；
- locale-aware。

### Pull Requests

- provider-authoritative；
- All/Open/Merged/Closed；
- `merged = closed && mergedAt != null`；
- safe HTTPS external link；
- optional `latestReview`。

### Composer

- server-owned readiness；
- working tree / branch；
- global model / per-review model；
- saved-but-inactive pending restart；
- duplicate-safe submit；
- sanitized errors；
- Settings recovery。

## 26.2 CKPT2 最终验证

历史 final verification 曾完成：

- 17 plan todos；
- F1 Goal/constraint/plan compliance；
- F2 hands-on QA；
- F3 code quality；
- F4 security；
- F5 context/scope fidelity。

最终浏览器验收还确认：

- Changes 点击真实文件；
- History 真实提交；
- PR filters；
- Composer source/model；
- modal close；
- light/dark/system；
- route sanity；
- 无真实 LLM 调用。

后续任何新改动如果触及这些文件，必须重新判断哪些 evidence 被 invalidate。

---

# 27. 当前已知技术债 / 非阻塞风险

这些不是自动阻塞项，但应进入后续 backlog。

1. **Local Review model override historical dual spelling / compatibility debt** — 应逐步统一共享 contract，避免双字段长期存在。
2. **Pull Request reader credential fallback error aggregation** — 最终 public error 不应只反映最后一个 credential candidate 的 failure。
3. **Unknown repositoryId route consistency** — `/pull-requests` 与 `/review-preparation` 对 unknown ID 的 HTTP semantics 应最终统一。
4. **Composer generic failure feedback** — 能够安全映射 sanitized server message 时，UI 不必永远只显示 generic error。
5. **Changes dead error branch** — dead/unreachable UI 状态需要清理或测试。
6. **Reviews association identity** — display name / remote name / realpath basename 不得用于 authoritative join；应依赖 canonical repository ID。
7. **Git depth invalid query semantics** — 非数字 depth 最终应考虑 400，而不是 degradation 到 unavailable。
8. **Malformed provider PR row** — 当前 fail-closed；未来可决定 row-level isolation，但不能静默伪造。
9. **Child-process sandbox 不是 OS sandbox** — 仍缺 filesystem/network/subprocess containment。
10. **Workflow 当前 UI 与真实 Cordis Runtime 仍未完全闭环** — 这是 CKPT3 的首要工作。
11. **Settings 当前仍偏 Web Admin** — 是 CKPT4 的产品工作，不应在 CKPT3 顺手大改。

---

# 28. Git / Branch 规约

## 28.1 一般开发期

除非用户明确授权，Agent 不得：

```text
git reset
git restore
git clean
git rebase
git merge
git push
force push
create PR
modify main
```

尤其 dirty worktree 下：

```text
DO NOT git add -A blindly
```

必须先做 scope audit。

## 28.2 用户历史偏好的 v3 收口方式

用户曾明确希望：

```text
local v3-pr2
   ↓
local v3
   ↓
remote v3
```

便于理解。

如果再次执行，应先验证：

```text
origin/v3 is ancestor of v3-pr2
worktree status understood
no unintended main mutation
no force push required
```

本地 `v3` 可以通过安全 ref move 指向已验证 `v3-pr2`，然后 fast-forward push `v3`。

`main` 必须保持不动，除非用户后续明确要求 release merge。

---

# 29. Test / Verification Constitution

## 29.1 Evidence-first Completion

```text
implementation exists
      !=
task complete
```

完成至少需要：

```text
implementation
+
typecheck
+
focused tests
+
integration/runtime evidence
+
invariant review
```

UI 还需要：

```text
real browser interaction
+
visual evidence where relevant
```

## 29.2 Verification Budget

为了避免“验证验证器”的无限循环：

- changed module → focused tests；
- remediation batch 完成 → typecheck once；
- build once；
- broad suite → milestone acceptance 前一次；
- visual-only 变化不自动触发全仓重跑；
- 已 PASS 且相关源码未变的 gate 不重复；
- browser/screenshot 单状态最多 primary + one retry；
- 单 delegated verification 目标 ≤ 10min；
- 超时且无新 evidence → 停止、读取 partial result、简化策略。

目的：

> sufficient reproducible evidence，而不是 maximum verification activity。

## 29.3 Browser QA

不能只相信：

- screenshot；
- unit test；
- DOM fixture；
- static source。

重要 product milestone 必须打开真实 Web/Desktop 点击。

典型：

```text
Repository
→ Changes
→ History
→ Pull Requests
→ Composer
→ Theme
→ Navigation
```

检查：

- browser console；
- network；
- schema parse；
- runtime log；
- blank screen；
- stale state。

---

# 30. Coding Agent 执行规约

所有大型工程任务应遵循：

```text
Inspect
  ↓
Plan
  ↓
Implement
  ↓
Verify
  ↓
Review
  ↓
Human Checkpoint
```

## 30.1 Specification Before Implementation

先写：

- current facts；
- architecture ground truth；
- scope；
- invariants；
- failure semantics；
- verification。

再写代码。

## 30.2 Boundary Before Component

Prompt 不应该只告诉 Agent：

> 做一个 Scheduler。

必须告诉它：

- Scheduler authority 在哪里；
- Cordis 不能代替它；
- failure 时怎么表现；
- 如何证明没有 duplicated authority。

## 30.3 Behavior Before Class Name

优先：

> capability revoke 后 next syscall MUST DENY。

不要：

> 新建 CapabilityRevocationManager.ts。

Agent 对实现命名可以自由，对行为不变量没有自由。

## 30.4 Vertical Slice Before Horizontal Scaffold

优先：

```text
Kernel Capability
  ↓
Cordis Context
  ↓
Facade
  ↓
Fiber
  ↓
Kernel Syscall
  ↓
Evidence
```

不要一次造十个空目录、二十个 interface。

## 30.5 禁止 silent architecture rewrite

如果当前 repo 与规格冲突：

Agent 必须：

1. 停止冲突部分；
2. 指明 current code path；
3. 指明冲突的 invariant；
4. 提出最小 architecture decision；
5. 继续不受影响的工作。

不能为了“完成任务”偷偷修改架构。

---

# 31. Prompt 质量规约

ConsistenCy 的工程 Prompt 应接近：

> **RFC-style Architecture Spec + Executable Engineering Brief + Verification Contract**

推荐固定结构：

```text
0. Mission
1. Current System State
2. Architectural Ground Truth
3. Target Architecture
4. Scope
5. Core Requirements
6. Type-Level Contract
7. Execution Plan
8. Failure Semantics
9. Verification Contract
10. Final Report Format
```

## 31.1 禁止低质量 Prompt

禁止：

### TODO-only

```text
1. 做 scheduler
2. 做 context
3. 加测试
```

### 空洞“高级感”

```text
请以生产级、工业级、高性能方式优化。
```

### File-first

```text
创建 kernel.ts
创建 agent.ts
```

### Architecture rewrite permission

```text
如果你觉得架构不合理可以重新设计。
```

### Fake verification

```text
确保测试通过。
```

必须写：

```text
Run exact test.
Report exact result.
Do not claim PASS if command was not executed.
```

---

# 32. Agent 最终报告标准

最终至少包含机器可读字段：

```text
TYPECHECK=
TESTS=
INTEGRATION_TESTS=
RUNTIME_EVIDENCE=
REGRESSIONS=
ARCHITECTURE_GAPS=
AMBIGUITIES=
UNRESOLVED_FAILURES=
WORKTREE_STATE=
COMMIT_CREATED=
PUSHED=
PR_CREATED=
READY_FOR_HUMAN_REVIEW=
```

不能输出：

> Done.

---

# 33. Failure Semantics 通用模板

如果一个 invariant 无法在不破坏现有 architecture contract 的情况下完成：

```text
DO NOT silently weaken the invariant.

1. Stop the affected implementation.
2. Identify conflicting contract.
3. Cite the code path.
4. Explain the smallest required decision.
5. Continue unaffected work only.
```

---

# 34. Security Truthfulness 规约

所有 UI / docs / Agent 报告必须区分：

```text
ENFORCED
BEST-EFFORT
NOT ENFORCED
UNKNOWN
```

尤其：

```text
child process
!=
full sandbox
```

以及：

```text
readonly UI
!=
filesystem containment
```

禁止为了“产品看起来完整”而夸大安全保证。

---

# 35. 数据与错误展示规约

Public renderer/API：

- 不泄漏 raw path；
- 不泄漏 secret；
- 不泄漏 raw token；
- 不回传 capability handle；
- provider failure 要 sanitized；
- unavailable 与 empty 分开；
- UI 不自行捏造 server truth；
- backend reason 在 zh-CN 应有稳定映射；
- 未知/危险 reason 使用通用安全文案。

---

# 36. 未来 Workflow Agent 的安全规约

右侧 Workflow Copilot 未来必须：

- 只生成 proposal；
- 不直接修改 live runtime；
- 不直接执行 repo write；
- WorkflowPatch schema validation；
- graph validation；
- capability/coeffect validation；
- human Apply；
- commit/publish 仍走 Kernel/Intent。

Agent Chat 不能成为绕过 Workflow compiler 的后门。

---

# 37. CKPT3 建议的详细执行顺序

## Phase A — Runtime Contract

1. Characterize current Workflow backend/contracts；
2. 定义 WorkflowDefinition canonical schema；
3. 定义 NodeRegistry；
4. 定义 WorkflowPatch；
5. 定义 WorkflowValidationResult；
6. 定义 compiled Fiber graph representation。

## Phase B — Cordis Integration

7. Workflow node → Fiber mapping；
8. Coeffect dependency resolution；
9. capability preflight；
10. dry-load；
11. scheduler admission integration；
12. evidence path validation。

## Phase C — Verified Built-ins

13. `pr-review`；
14. `pr-sanity-verification`；
15. `security-hardening`；
16. `architectural-drift`；
17. `vibe-safety`。

每个必须 fixture + deterministic tests。

## Phase D — Workflow Studio

18. Workflow Library；
19. graph canvas；
20. node configuration；
21. validation panel；
22. dry-run；
23. save draft。

## Phase E — Workflow Copilot

24. right-side Copilot；
25. natural language → WorkflowPatch；
26. diff preview；
27. Apply / Reject；
28. undo / history；
29. no direct runtime mutation。

## Phase F — Repository Binding

30. Repository-local Workflows；
31. default workflow；
32. manual trigger；
33. PR / webhook trigger binding；
34. link to Run。

## Phase G — Review Surface

35. Remove repository Reviews placeholder；
36. show runs/history/risk/workflow/model/source；
37. navigate to Review Run。

## Phase H — Human Acceptance

38. focused tests；
39. typecheck；
40. runtime dry-run；
41. actual workflow execution with test-scoped LLM driver；
42. browser click QA；
43. security review；
44. evidence review；
45. human checkpoint。

---

# 38. CKPT3 明确不做

除非发现直接 blocker：

- 不重做 Kernel；
- 不重新设计 Context VM；
- 不重写 CapabilityBroker；
- 不重新设计 Repository Workspace；
- 不重做 Settings；
- 不顺手修改 Electron process architecture；
- 不上 distributed execution；
- 不做 plugin marketplace；
- 不重新引入 Mock runtime；
- 不把 chat 变成产品首页。

---

# 39. CKPT4 建议执行顺序

1. 将 Settings 从主导航产品对象降级为齿轮入口；
2. 保留 `/settings` compatibility route，但主 UX 使用 Dialog；
3. 构建 Settings section navigation；
4. Models；
5. GitHub；
6. Review defaults；
7. Runtime；
8. Appearance；
9. Desktop；
10. About；
11. restart-required truth；
12. safeStorage integration；
13. native logs/open-folder actions；
14. desktop/browser QA。

---

# 40. CKPT5 Definition of Done

ConsistenCy v3 可以进入正式 release review 时，应能证明：

```text
A real repository can be connected.

Local Git facts are truthful.

GitHub PR facts are provider-authoritative.

A verified Workflow can be selected or built.

Workflow validation proves dependencies/capabilities.

A Run is created.

Agents are represented by ACBs.

Cordis Fibers reflect service lifecycle.

Kernel mediates protected syscalls.

Context VM controls visible context.

Evidence grounds findings.

Runtime UI exposes truthful state.

Human can inspect findings/evidence/runtime.

Commit actions use durable intent.

Desktop can package from reproducible HEAD.

No Demo/Mock production runtime exists.
```

---

# 41. Definition of “ConsistenCy 成型”

ConsistenCy v3 真正成型，不是因为它有一个漂亮 WebUI。

而是因为一个熟悉 Agent / software engineering 的人可以在十分钟内理解：

```text
1. Repository 是什么；
2. Workflow 为什么可执行；
3. Agent 为什么被允许执行某个动作；
4. Agent 当前看到了哪些 Context；
5. Scheduler 为什么让它运行；
6. Evidence 从哪里来；
7. Finding 为什么可信；
8. 外部副作用为什么不会绕过 durable intent；
9. Runtime 为什么可以复现；
10. 人如何对整个过程提出质疑。
```

这也是项目区别于普通 AI Code Review 工具的核心。

---

# 42. 最终项目原则速查

```text
Repository-first
Evidence-first
Real-only runtime
Kernel-authoritative
Cordis-composable
Context-virtualized
Scheduler-controlled
Provider-truthful
Desktop-native
Human-auditable
```

对应禁止项：

```text
NO fake PR data
NO Demo Mode
NO Mock production runtime
NO Cordis-as-security
NO Context-as-permission
NO Ring-as-process
NO Effect-as-rollback
NO silent architecture rewrite
NO fake test PASS
NO permanent empty Inspector
NO duplicate Workflow/Automation product
NO unsafe internal raw links
NO commit/push without explicit authorization
```

---

# 43. 推荐仓库内 canonical 文档结构

后续建议将本文件拆分/映射为 repo canonical docs：

```text
docs/
  architecture.md
  security.md
  repository-workspace.md
  review-runtime.md
  workflow-runtime.md        # CKPT3
  configuration.md
  desktop.md
  testing-and-evidence.md
  roadmap.md
  agent-engineering-protocol.md
```

本文件可以保留为：

```text
docs/CONSISTENCY_V3_MASTER_SPEC.md
```

作为人类与 Coding Agent 的总入口。

---

# 44. Source / Memory Basis

本文件综合自项目长期上下文中的以下已确认材料与实现记录：

- ConsistenCy v3 Architecture Specification；
- Repository-Native Agent Harness OS architecture draft；
- ConsistenCy v3 高质量工程提示词生成规范；
- PR-1 ～ PR-6 migration plan 与后续实际迁移结果；
- Kernel / Cordis / Context VM / Evidence / CommitCoordinator / Sandbox 纵向实现记录；
- RC architecture audit；
- Real-only Runtime / Mock removal；
- Electron Desktop packaging / safeStorage / API helper lifecycle；
- Repository-first frontend reengineering；
- Checkpoint 1 frozen shell；
- Checkpoint 2 Repository Workspace plan、17 todos、F1-F5 final verification；
- 后续真实浏览器人工式 QA；
- 当前对 Checkpoint 3 / 4 / 5 的路线决策。

历史状态字段仅用于代码考古；当前实现状态必须由 Git、源码、运行时和最新 evidence 最终确认。

---

# 45. 给下一位 Agent 的一句话

> **不要把 ConsistenCy 当作一个需要“继续加功能”的 Review App。先确认 Kernel authority、Cordis lifecycle、Context visibility、Scheduler admission、Evidence provenance 和 Repository truth 没有被破坏，再实现下一条完整的纵向能力。**

---

# Appendix — CKPT3 Execution Record (2026-08-23 … 2026-08-24)

> Append-only execution record, appended AFTER the frozen constitution body
> above (owner decision D2, Phase 5). The constitution text above this
> separator is verbatim Master Spec v1.0 and is never modified here.

## A. Delivered surface (Phase 1–4, all per-phase light review passed)

| Phase | Scope | Key files | Test index |
|---|---|---|---|
| 1 | Verified Workflow vertical slice (Definition → Validation → Compile(feasibility) → Run → ACB → Scheduler admission → Cordis Fiber → ContextImage → per-syscall authorize → Evidence → Findings/MiniReport; no LLM) | `packages/schema/src/workflow-runtime.ts`, `apps/api/src/workflow-runtime/{registry,definition,validate,compile,executor,host}.ts`, web WorkflowPage runtime tab | TEST A–G |
| 1.1 | Snapshot convergence remediation (trigger binds opaque repositoryId; true `RepositorySnapshot.create` at HEAD; inline file-set input removed from the public API) | `host.ts` canonical wiring, resolver in `server.ts` | TEST H–I |
| 2 | Persisted definitions (append-only revisions, immutable builtin seed), persisted run history with restart honesty, dry-load feasibility panel (compile-sourced, explicitly not an authorization) | migration `0017`, `store.ts`, dry-load in `host.ts`, 7 routes, runtime tab extension | TEST J–N |
| 3 | Repository workflow bindings (enable/disable, idempotent; manual trigger resolving latest validated revision; per-repo run history via canonical repositoryId) | migration `0018`, bindings CRUD in `store.ts`/`host.ts`, `RepositoryWorkflowsView.tsx` | TEST O–R |
| 4 | Repository review history (canonical job↔repository association persisted at creation; per-repo list; reuse of the existing run detail route) | migration `0019`, `jobs.repository_id`, `/repositories/:id/reviews`, `RepositoryReviewsView.tsx` | TEST S–V |

All execution-chain semantics unchanged across phases: capability set
`repo.read / evidence.read / evidence.write`; per-syscall Kernel
authorization; SHA-pinned canonical snapshots; append-only revisions.

## B. Mid-checkpoint review verdict

ACCEPT — 10/10 invariants green, 16/16 forbidden-error checks green, all
gates reproduced (focused suites, root typecheck/build, verify:docs,
verify:runtime, live HTTP + browser evidence). Recorded 2026-08-24.

## C. Boundary decisions (owner decision D1, Phase 5)

Moved OUT of CKPT3, to be planned in the next checkpoint:
- Workflow Studio (visual canvas / graph editor);
- Agent Copilot / WorkflowPatch;
- verified built-in workflow library (pr-review and the other four);
- PR / webhook automatic triggers;
- workflow trigger rate limiting;
- default-workflow flag.

The CKPT3 delivery surface is frozen at the Phase 1–4 content above.

## D. Known-debt pointers (recorded, not remediated here)

- Dual schema: legacy `WorkflowSpec` = engine-legacy, FROZEN; migration
  decision deferred to the next checkpoint (see
  `docs/workflow-runtime.md` → "Dual-schema decision record").
- Legacy name-matching Reviews UI (§27.6 existing instance in
  `RepositoryDetailPage`) — untouched; new surfaces are canonical-id only.
- No automatic triggers, no rate limiting, no default-workflow flag (dev
  auth-gated surface stands).
- Unassociated legacy review jobs remain readable only in the global runs
  view (honest missing-association, D1 of Phase 4).

## E. Evidence chain (porcelain growth per phase, all uncommitted)

- Phase 1 + 1.1: 122 entries (baseline dirty worktree preserved).
- Phase 2: 122 → 126 (+3 expected modified: migrations + two migration-list
  tests; +1 tool artifact `apps/web/.mimosa/`).
- Phase 3: 126 → 127 (+`RepositoryWorkflowsView.tsx`).
- Phase 4: 127 → 133 (+5 expected modified: jobView/jobQueue/
  sqliteJobStore/trigger-local/schema-job; +`RepositoryReviewsView.tsx`).
- No git writes at any point (COMMIT/PUSH/PR = false throughout); `.omo`
  untouched.

