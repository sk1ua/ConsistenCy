# Output Schema

Machine-readable contracts:

- `schemas/analysis_result.schema.json`
- `schemas/pr_report.schema.json`
- `packages/schema/src/report.ts`
- `packages/schema/src/legacy.ts`

Schemas are additive where possible. Existing required fields should not change meaning.

## PR Report Retrieval Field

New PR reports may include:

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

Each `file_deep_dive` item may also include `evidence_pack`.

Older reports without `retrieval` remain valid.
