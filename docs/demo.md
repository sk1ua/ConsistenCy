# 演示

启动服务：

```powershell
npm run dev:api
npm run dev:web
```

写入演示数据：

```powershell
$headers = @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

打开 `http://127.0.0.1:5173`。

演示顺序：

1. 仪表盘指标。
2. Evidence Retrieval 面板。
3. Jobs 表格。
4. Report 详情。
5. Agent runs 和 findings。
6. Settings 状态。
