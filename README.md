# ConsistenCy

**一个终端优先的、证据落地的代码审查 harness。**

ConsistenCy 不把原始 diff 直接丢给模型然后期待一段有用的散文。它先用 Python 确定性引擎把可核验的事实（AST 结构、安全模式、重复度、演化信号）抽成证据，再让六个专项审查 agent 在能力门控下带着这些证据研判，最后由 Supervisor 综合成一份可复现、逐条挂证据的审查报告。

入口只有一个：`consistency review`。

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)

---

## 它解决什么问题

直接让 LLM 看 diff，有三种结构性缺陷：

1. **没有证据锚点**：模型给出自由文本，无法回溯到 AST 结构、符号定义或安全不变量，人也无法核对。
2. **agent 执行不受控**：多 agent 审查系统常常让模型随意跑工具和 shell，没有能力授权，也没有执行域隔离。
3. **上下文污染**：把整份 diff 和整个文件塞进一个 prompt，撞爆 token 预算，同时让模型推理变差。

ConsistenCy 的应对是把审查拆成两件事，并让它们各司其职：

- **确定性引擎拿证据** —— `engine/` 是纯 Python，只把源码当数据读，**从不执行仓库代码**；它输出的每条事实都带 provenance（analyzer 名与版本）。
- **模型做判断** —— 六个专项 agent（安全、正确性、结构、风格、测试、演化）在 `@consistency/kernel` 的能力门控下调度，每个 finding 必须挂 `evidenceIds`。

还有一条贯穿全局的渲染纪律：**没能检查到什么，比检查到了什么更显眼**。一次降级运行的「无发现」，绝不能看起来像一次完整运行的「无发现」。

---

## 架构一览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        终端入口  apps/cli (@consistency/cli)                 │
│   consistency review  ·  参数解析  ·  终端渲染  ·  退出码契约（0 / 1 / 2）    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ 复用同一套审查运行时（不重实现）
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                        apps/api (@consistency/api)                          │
│        审查运行时装配 · SQLite 存储 · worker 与队列 · GitHub 集成            │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
     ┌─────────────────────────────────┼─────────────────────────────────┐
     │ Kernel 层 (@consistency/kernel)                                   │
     ▼                                 ▼                                 ▼
┌──────────────┐             ┌──────────────────┐             ┌─────────────────────┐
│ Run 与       │             │ SyscallGateway   │             │ Context VM 与       │
│ Scheduler    │             │ CapabilityBroker │             │ Evidence Store      │
└──────┬───────┘             └────────┬─────────┘             └─────────────────────┘
       │                              │
       ▼                              ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              Harness 层 (@consistency/harness-core)                         │
│              Cordis fiber 生命周期 · CapabilityLifecycleAdapter              │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│            Workload 层 (@consistency/workload-review)                       │
│            ReviewWorkload：Supervisor Planner + 六个专项审查 agent           │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │
                 ┌─────────────────────┴─────────────────────┐
                 ▼                                           ▼
    进程内 built-in（Supervisor / 审查 agent）      子进程沙箱（不可信插件，经 RPC）
                 │
                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│              确定性证据引擎  engine/（Python 3.12，JSON-over-stdio）          │
│     style · structural · semantic · duplication · security · evolution      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 快速开始

### 前置条件

- **Node.js 22.x**（`engines` 要求 `>=22.19.0 <23`；装 Node 24/25 会不满足）
- **Python 3.12**（`npm run verify:runtime` 会校验版本）

### 1. 安装依赖

```bash
npm ci
```

Python 侧需要一个 **3.12.x** 解释器的虚拟环境（`scripts/baseline-runtime.mjs:18` 只接受 `3.12.`，3.11 或 3.13 都会被 `verify:runtime` 拒掉）。用 uv 最快：

```bash
uv venv --python 3.12 .venv
uv sync --frozen --extra dev
```

没有 uv 就用标准虚拟环境 + 锁文件：

```bash
python3.12 -m venv .venv
.venv/Scripts/python.exe -m pip install -r requirements-lock.txt
.venv/Scripts/python.exe -m pip install pytest pytest-cov jsonschema ruff
```

CLI 会优先使用 `<install root>/.venv` 里的解释器；也可以用 `CONSISTENCY_PYTHON_PATH` 显式指定。

### 2. 配置

```bash
npm run setup
```

或者逐项设置（适合脚本化）：

```bash
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseekApiKey
npm run config -- doctor
```

配置和密钥存在仓库的 `.consistency/` 下（`config.json` + 加密的 `secrets.enc.json`），该目录已被 gitignore。

### 3. 跑一次审查

在当前仓库上审查**未提交的工作区改动**：

```bash
npm run consistency -- review
```

审查一个提交区间：

```bash
npm run consistency -- review --repo D:/path/to/checkout --base main --head HEAD
```

审查别的仓库的工作区改动：

```bash
npm run consistency -- review --repo D:/path/to/checkout
```

看全部选项：

```bash
npm run consistency -- review --help
```

---

## 退出码就是契约

`consistency review` 的退出码可以直接当 CI 闸门用：

| 退出码 | 含义 |
|---|---|
| `0` | 跑完，没有任何 finding 达到阈值 |
| `1` | 跑完，且有 finding 达到阈值 |
| `2` | **没跑成，或本次审查覆盖不完整** —— 不可当作闸门信任 |

`2` 是这套设计里最重要的一档：它把「跑通了但没查到东西」和「压根没查全」分开。后者可能来自某个专项 agent 失败、Planner 失败、Synthesizer 失败，或确定性引擎有步骤没跑。这种运行时报告开头会带 `[!]` 标记，并在约束块里逐条列出没覆盖的部分。

阈值默认 `low`（即 `info` 不拦构建），可用 `--threshold` 调整：

```bash
npm run consistency -- review --threshold high
```

放进 CI：

```yaml
- run: npm ci
- run: npm run consistency -- review --threshold high
```

---

## 两个风险度量，永不合并

报告头同时给出两个**互相独立**的量，它们不是同一个东西的两种说法：

- **静态分析评分 / 风险等级** —— 来自确定性静态分析（文件路径、signal 分解、confidence）。这是给 triage 用的信号。
- **结论风险带** —— 来自最终 findings 的严重度分布。

schema 明确要求把它们当作两个有名字的字段分别呈现，所以终端渲染也不发明一个合并后的数字。

---

## 用 JSON 接进你自己的流程

```bash
npm run consistency -- review --json > report.json
```

`--json` 输出完整的 `ReviewReport`，字段结构见 [docs/output_schema.md](docs/output_schema.md)。

---

## 这个版本里有什么，没有什么

**有：** 终端审查入口、确定性证据引擎、能力门控的 agent 调度、不写入被审查仓库的产物目录（`.consistency/cli`）、HTTP daemon 与 SQLite 持久化、GitHub 公开 PR 分析与 webhook 集成、Python 与 TypeScript 的完整测试基线。

**没有：** 图形界面、桌面应用、浏览器端到端测试。本版是终端优先的：`apps/api` 作为无界面的 HTTP 与持久化层保留，所有面向人的交互都走命令行。

详见 [docs/capability-matrix.md](docs/capability-matrix.md) —— 那张表只陈述今天实际存在的行为，不写路线图。

---

## 文档

- **[Getting Started](docs/getting-started.md)** — 从零到第一次审查，含环境排错。
- **[How To Use（终端用法速查）](docs/how-to-use.md)** — 入口、两种审查范围、选项、报告阅读法与退出码。
- **[Project Overview](docs/PROJECT_OVERVIEW.md)** — 产品定位与核心架构分层。
- **[System Architecture](docs/architecture.md)** — Kernel 能力、Cordis harness、Context VM 与不变量。
- **[Security Model](docs/security.md)** — 能力中介、逻辑环与执行域、子进程沙箱的真实边界。
- **[Mode Capability Matrix](docs/capability-matrix.md)** — 今天实际强制执行了什么。
- **[Repository Workspace Model](docs/repository-workspace.md)** — Repository-first 产品模型与权威来源规则。
- **[Review Runtime & Context VM](docs/review-runtime.md)** — 审查执行管线与 Context VM 分页。
- **[Configuration Reference](docs/configuration.md)** — provider、配置优先级与持久化路径。
- **[HTTP API Reference](docs/api.md)** — 端点、鉴权与载荷 schema。
- **[Output Schema](docs/output_schema.md)** — `ReviewReport` 与证据模型的结构。
- **[Risk Scoring Rules](docs/risk-scoring-rules.md)** — 风险分的规则定义与评估口径。
- **[Workflow Runtime](docs/workflow-runtime.md)** — 工作流运行时与节点模型。
- **[GitHub App Setup](docs/GITHUB_APP_SETUP.md)** — webhook 与 App 凭据配置。
- **[Evaluation Guidelines](docs/EVALUATION.md)** — 数据集 schema 与指标复现。
- **[Codex Integration](docs/llm-codex-integration.md)** — 让 Codex 直接调用确定性分析。

---

## 验证

```bash
# 一次跑完全部基线检查
npm run verify
```

它按顺序执行：`verify:runtime`（Node 22 + Python 3.12）→ `verify:docs`（Markdown 规则与链接）→ `audit:deps` → `typecheck`（全部 workspace）→ `test`（TypeScript 测试 + runtime gate）→ `build` → `test:python`（pytest）。

也可以单独跑：

```bash
npm run typecheck
npm test
npm run test:python
```

Windows 上跑 pytest 建议显式指定解释器：

```powershell
.\.venv\Scripts\python.exe -m pytest -q
```
