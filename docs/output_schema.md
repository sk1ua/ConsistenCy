# 输出 Schema

机器可读契约：

- `schemas/analysis_result.schema.json`
- `schemas/pr_report.schema.json`
- `packages/schema/src/report.ts`
- `packages/schema/src/legacy.ts`

Schema 应尽量保持增量兼容。已有必填字段不应改变语义。

## PR Report Retrieval 字段

新的 PR report 可以包含：

```json
{
  "retrieval": {
    "strategy": "hybrid_path_symbol_signal_callsite_ownership_local_similarity",
    "context_budget_tokens": 2000,
    "packs": [],
    "summary": {
      "files_with_evidence": 0,
      "total_selected_evidence": 0,
      "average_selected_evidence_count": 0.0,
      "average_compression_ratio": 0.0
    }
  }
}
```

每个 `file_deep_dive` 项也可以包含 `evidence_pack`。

不带 `retrieval` 的旧报告仍然有效。
