# 接口

默认 API 地址：`http://127.0.0.1:8787`。

受保护路由需要：

```http
Authorization: Bearer <CONSISTENCY_API_TOKEN>
```

## 路由

- `GET /health`
- `GET /jobs`
- `GET /jobs/:id`
- `GET /jobs/:id/report`
- `GET /reports/recent?limit=10`
- `GET /stats`
- `POST /github/webhook`
- `POST /demo/seed`
- `POST /analyze-file`
- `POST /jobs/run-next`
- `POST /jobs/:id/run`

共享 API schema 位于 `packages/schema/src/api.ts`。
