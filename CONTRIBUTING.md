# 贡献指南

感谢关注 ConsistenCy。项目采用 TypeScript 与 Python 双栈架构，由 Kernel、Cordis Harness 和 Evidence Engine 构成。

本版是终端优先的：面向人的入口是 `consistency review` 命令行，`apps/api` 作为无界面的 HTTP 与持久化层保留。仓库内不提供图形界面。

---

## 环境准备

使用与 CI 一致的主版本：
- Node.js 22.x（`.nvmrc` 与 `.node-version`）
- Python 3.12.x（`.python-version`）

```bash
python3.12 -m venv .venv
.venv/Scripts/activate      # Windows；Unix 使用 source .venv/bin/activate
pip install -r requirements-lock.txt
npm ci
```

Node 与 Python 的版本下限由 `scripts/baseline-runtime.mjs` 强制：Node 必须 `>=22.19.0 <23`，Python 必须是 `3.12.x`。跑 `npm run verify:runtime` 可以单独确认这两条。

---

## 仓库结构

- `apps/api`：TypeScript API 服务、SQLite 持久化、Workload Runtime、GitHub 适配与 notebook 图
- `apps/cli`：终端入口（`consistency review`）、参数解析、终端渲染与退出码契约
- `packages/kernel`：SyscallGateway、CapabilityBroker、KernelScheduler、ContextVM、AgentControlBlock、AuditJournal
- `packages/harness-core`：Cordis Fiber 运行时、Coeffects 与 Capability 适配器
- `packages/workload-review`：ReviewWorkload、Supervisor 规划 Agent、审查 Agent
- `packages/repository`：RepositorySnapshot 快照管理与 Git 适配
- `packages/vcs-core`：Git 状态、分支与 commit 协议
- `packages/schema`：全栈共享 Zod Schema 与数据传输类型
- `packages/plugins-builtin`：内置确定性分析插件与 Tree-sitter AST 查询
- `engine`：Python 确定性分析引擎与 JSON-over-stdio 协议
- `evaluation` 与 `engine/evaluation`：评分数据集、指标与规则评估代码
- `tests`：Python 测试；TypeScript 测试与被测模块同目录

---

## 提交前验证

```bash
npm run verify
```

它按顺序执行 `verify:runtime` → `verify:docs` → `audit:deps` → `typecheck` → `test` → `build` → `test:python`。改动的范围较小时，也可以只跑相关的子集：

```bash
npm run typecheck
npm test
.venv/Scripts/python.exe -m pytest -q
npm run verify:docs
```

改动文档时至少跑一次 `npm run verify:docs`：它会校验 Markdown 的禁用措辞与相对链接是否指向真实存在的文件。

---

## 配置与运行时

首次配置：

```bash
npm run setup
npm run config -- doctor
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseek-api-key
```

非 secret 配置保存在 `.consistency/config.json`；secret 使用本地密钥加密保存在 `.consistency/secrets.enc.json`。进程环境变量优先级高于已保存配置。详见 [配置指南](docs/configuration.md)。

---

## 开发约定

- 生成物不进 Git：本地数据库、评估输出、clone 仓库、pytest 缓存与构建产物已全部忽略。
- 保证确定性与真实性：核心分析层无 LLM key 时也可复现；审查运行必须配置真实 DeepSeek / OpenAI / Anthropic 模型（产品无运行时 Mock/Demo 模式；CI 与单测可用内部 mock double）。
- 保持报告的诚实口径：没能检查到的部分必须比检查到的部分更显眼，降级运行不得渲染成干净运行。改动渲染层时请一并保留这条规则。
- 文档保持聚焦：优先更新 `README.md`、`docs/getting-started.md`、`docs/architecture.md`、`docs/security.md` 或 `docs/configuration.md`。
- 修改 TypeScript 或 Python 契约时，同步补充或更新对应的单元测试。
