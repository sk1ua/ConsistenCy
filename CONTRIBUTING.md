# 贡献指南

感谢关注 ConsistenCy。项目刻意保持可以在本地完整运行的规模，任何改动都应该让 Demo、测试和 Dashboard 保持易于验证。

## 环境准备

使用与 CI 一致的主版本：

- Node.js 22（`.nvmrc` 与 `.node-version`）
- Python 3.12（`.python-version`）

仓库级 `.npmrc` 会拒绝不受支持的 Node.js 版本。

```bash
python -m venv .venv
source .venv/bin/activate   # Windows 使用 .venv\Scripts\activate
pip install -r requirements-lock.txt
npm ci
```

## 仓库结构

- `apps/api`：TypeScript API、ReviewWorker、PublishWorker、SQLite 持久化与 GitHub 适配
- `apps/web`：React/Vite 仪表盘（Dashboard、Jobs、Report、Real Data、Settings）
- `packages/schema`：HTTP、报告、Job 与 stdio wire contract 的共享 Zod Schema
- `engine`：Python 确定性分析引擎与 JSON-over-stdio runner
- `evaluation`：公开 PR 弱标签评估脚手架
- `tests/e2e`：不访问外部 GitHub 的隔离全栈流程与截图生成

## 提交前检查

```bash
python examples/multi_agent_demo.py
python -m pytest -q
npm run verify
```

Web 前端的本地启动与 Demo 数据写入见 [docs/demo.md](docs/demo.md)。

## 配置

引导式 CLI 是最快的首次配置路径：

```bash
npm run setup
npm run config -- doctor
```

不打开 `.env` 也可以查看或修改单个配置项：

```bash
npm run config -- show
npm run config -- set llm.provider deepseek
npm run config -- set llm.deepseek-api-key
```

非 secret 配置保存在 `.consistency/config.json`；secret 使用本地密钥加密保存在 `.consistency/secrets.enc.json`，API 永远不会回显。进程环境变量的优先级高于已保存的配置。

API 与 Web 启动后，可以在 Settings 页面编辑同样的配置（仅开发模式），保存后重启 API 生效。`NODE_ENV=production` 时 Settings 写入被禁用，生产配置通过环境变量或 CLI 管理。可选的 API bearer token 通过 CLI 配置，并保持 Web 端 `VITE_API_TOKEN` 同步。

## 开发约定

- 生成物不进 Git：本地数据库、评估输出、clone 的仓库、pytest 缓存、实验缓存均已忽略。
- `npm run build` 刷新的 `apps/web/dist` 被忽略，不要提交。
- 修改 Python 依赖时同步更新 `requirements-lock.txt`，保持锁定安装可复现。
- 优先保持确定性：核心评分层在没有 LLM key 时也必须可复现。
- 改动 agent 评分、报告 Schema、CLI 输出或 Dashboard API 载荷时，同步补充或更新测试。
- 文档保持聚焦：优先更新 `README.md`、`docs/PROJECT_OVERVIEW.md` 或 `docs/output_schema.md`，不要新增一次性笔记。
- 前端改动需要同时检查桌面与移动端宽度，避免卡片、按钮、图表和侧边栏文字裁切。
- 架构图以 `docs/diagrams/*.mmd` 为唯一源文件；改动后用 mermaid-cli 重新导出 SVG，例如 `npx -p @mermaid-js/mermaid-cli mmdc -i docs/diagrams/system-architecture.mmd -o docs/diagrams/system-architecture.svg`。只提交 `.mmd` 与 `.svg`，不提交 PNG 导出物。
- 截图资产规范见 [docs/screenshots/README.md](docs/screenshots/README.md)：不出现绝对路径、token、私钥或真实 App ID。

## Pull Request 检查单

- 改动有清晰的、面向用户的理由。
- 测试覆盖被改变的行为。
- `python -m pytest -q` 通过。
- 改动 TypeScript 或 Web 文件时 `npm run verify` 通过。
- 命令、Schema、路由或安装步骤变化时，README 或 docs 已同步更新。
