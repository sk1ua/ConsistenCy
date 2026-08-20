# 贡献指南

感谢关注 ConsistenCy。项目采用 TypeScript 与 Python 双栈架构，由 Kernel、Cordis Harness 和 Evidence Engine 构成。

---

## 环境准备

使用与 CI 一致的主版本：
- Node.js 22.x（`.nvmrc` 与 `.node-version`）
- Python 3.12.x（`.python-version`）

```bash
python -m venv .venv
source .venv/bin/activate   # Windows 使用 .\.venv\Scripts\activate
pip install -r requirements-lock.txt
npm ci
```

---

## 仓库结构

- `apps/api`：TypeScript API 服务、SQLite 持久化、Workload Runtime 与 GitHub 适配
- `apps/web`：React/Vite 前端（Repository Workspace、Overview、Diff、Evidence、Notebook、Runtime、Settings）
- `apps/desktop`：Electron Windows 桌面外壳与安全边界
- `packages/kernel`：SyscallGateway、CapabilityBroker、KernelScheduler、ContextVM、AgentControlBlock、AuditJournal
- `packages/harness-core`：Cordis Fiber 运行时、Coeffects 与 Capability 适配器
- `packages/workload-review`：ReviewWorkload、Supervisor 规划 Agent、审查 Agent
- `packages/repository`：RepositorySnapshot 快照管理与 Git/GitHub 适配
- `packages/vcs-core`：Git 状态、分支与 commit 协议
- `packages/schema`：全栈共享 Zod Schema 与数据传输类型
- `packages/plugins-builtin`：内置确定性分析插件与 Tree-sitter AST 查询
- `engine`：Python 确定性分析引擎与 JSON-over-stdio 协议
- `evaluation`：公开 PR 弱标签评估脚手架
- `tests`：TypeScript、Python 与 Electron 全栈端到端测试

---

## 提交前验证

```bash
npm run typecheck
npm test
python -m pytest -q
npm run test:desktop
npm run verify
```

---

## 配置与运行时

首次配置可通过 CLI 或 WebUI 设置：

```bash
npm run setup
npm run config -- doctor
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseek-api-key
```

非 secret 配置保存在 `.consistency/config.json`；secret 使用本地密钥加密保存在 `.consistency/secrets.enc.json`（或桌面端 `safeStorage`）。进程环境变量优先级高于已保存配置。详见 [配置指南](docs/configuration.md)。

---

## 开发约定

- 生成物不进 Git：本地数据库、评估输出、clone 仓库、pytest 缓存及打包产物已全部忽略。
- 保证确定性与真实性：核心分析层无 LLM key 时也可复现；审查运行必须配置真实 DeepSeek/OpenAI 模型（无运行时 Mock/Demo 模式）。
- 文档保持聚焦：优先更新 `README.md`、`docs/architecture.md`、`docs/security.md` 或 `docs/configuration.md`。
- 修改 TypeScript 或 Python 契约时，同步补充或更新对应的单元测试。
