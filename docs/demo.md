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

## 生成项目截图

截图全部来自当前运行的真实页面，可随时复现：

```powershell
npm run capture:screenshots
```

该命令会写入 `docs/screenshots/`。若本地已经导入公开 PR 快照，还会生成 `espnet/espnet #6327` 的公开数据页截图；没有快照时只生成 Demo 截图，并打印跳过提示。

所有截图都必须脱敏：不出现绝对路径、API token、私钥或真实 App ID；Settings 页只展示脱敏后的配置摘要。

截图清单与来源边界见 [screenshots/README.md](screenshots/README.md)。
