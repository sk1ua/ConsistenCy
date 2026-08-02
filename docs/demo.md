# Demo 与截图

Demo 使用固定 seed 和 MockLLM。它展示完整的 Dashboard → Jobs → Report → Settings 流程，API 在开发模式下使用 `8787`；Playwright E2E 使用隔离的临时 `3001`，并关闭 ReviewWorker/PublishWorker，因此不会访问外部 GitHub。

## 运行 Demo

```powershell
npm ci
python -m pip install -r requirements-lock.txt
Copy-Item .env.example .env
npm run dev:api
npm run dev:web
```

```powershell
$headers = if ($env:CONSISTENCY_API_TOKEN) { @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" } } else { @{} }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

打开 <http://127.0.0.1:5173>，进入 Jobs 查看 `queued`、`running`、`succeeded` 和 `publish_failed` 等固定状态，再打开成功 Job 的报告。

## 公开 PR 分析

公开 PR 入口不是 Demo seed 的别名。它不需要 GitHub App 安装：默认使用匿名 GitHub API/clone，也可以通过 `GITHUB_PUBLIC_READ_TOKEN` 使用服务端只读 PAT。它只创建 `accessMode=public_read`、`publicationPolicy=disabled` 的 analysis-only Job：报告会持久化，但不会进入 GitHub 评论 Outbox。分析完成后，Report 右侧的 Repository Notebook 使用该 PR 的 head SHA 建立懒加载索引。

Notebook 可以生成 Change Map、Architecture Impact、Risk Brief 和 Fix Plan，也可以流式回答“为什么修改这些模块”等问题。每条代码结论都显示文件和行号；Fix Plan 只展示建议 unified diff，不会改动本地工作区。

## 生成项目截图

截图全部来自当前运行的真实页面，可随时复现：

```powershell
npm run capture:screenshots
```

该命令会写入 `docs/screenshots/`。若本地已经导入公开 PR 快照，还会生成 `espnet/espnet #6327` 的公开数据页截图；没有快照时只生成 Demo 截图，并打印跳过提示。

所有截图都必须脱敏：不出现绝对路径、API token、私钥或真实 App ID；Settings 页只展示脱敏后的配置摘要。

截图清单与来源边界见 [screenshots/README.md](screenshots/README.md)。
