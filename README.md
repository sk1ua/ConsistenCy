# ConsistenCy

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)

ConsistenCy 是一个基于证据的多信号 PR 审查助手。它结合确定性专家分析器、本地证据检索、压缩后的 Evidence Pack 和加权共识，帮助审查者判断哪些文件最值得优先关注，以及原因是什么。

这里的“多 Agent”指确定性专家分析器和证据协调，不是自主 LLM 工作流。LLM 审查是可选增强，测试不依赖外部模型密钥。

![ConsistenCy dashboard](docs/design/dashboard-implementation.png)

## 本地启动

```powershell
npm install
python -m pip install -r requirements-dev.txt
Copy-Item .env.example .env
npm run dev:api
npm run dev:web
```

打开 `http://127.0.0.1:5173`。

写入演示数据：

```powershell
$headers = @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

## 检查命令

```powershell
npm run typecheck
npm test
npm run build
python -m ruff check .
python -m pytest -q
```

## 关键路径

- `apps/api`：TypeScript API、GitHub App webhook、worker、持久化。
- `apps/web`：React/Vite 仪表盘。
- `packages/schema`：共享 zod 契约。
- `engine/retrieval`：确定性证据检索和 Evidence Pack。
- `engine`：Python 多信号分析引擎。
- `evaluation/scripts/run_metrics.py`：排序和检索评估指标。

## 文档

- [项目概览](docs/PROJECT_OVERVIEW.md)
- [架构](docs/architecture.md)
- [接口](docs/api.md)
- [输出 Schema](docs/output_schema.md)
- [评估](docs/EVALUATION.md)
- [GitHub App 设置](docs/GITHUB_APP_SETUP.md)
- [演示](docs/demo.md)
- [安全](docs/security.md)
- [远程分析](docs/REMOTE_ANALYSIS.md)
- [TypeScript 外壳](docs/TYPESCRIPT_SHELL.md)
