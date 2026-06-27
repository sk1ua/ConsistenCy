# Demo

Start services:

```powershell
npm run dev:api
npm run dev:web
```

Seed demo data:

```powershell
$headers = @{ Authorization = "Bearer $env:CONSISTENCY_API_TOKEN" }
Invoke-RestMethod -Method Post http://127.0.0.1:8787/demo/seed -Headers $headers
```

Open `http://127.0.0.1:5173`.

Demo flow:

1. Dashboard metrics.
2. Evidence retrieval panel.
3. Jobs table.
4. Report detail.
5. Agent runs and findings.
6. Settings status.
