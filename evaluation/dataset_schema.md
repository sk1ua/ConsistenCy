# Evaluation Dataset Schema

Each sampled PR entry should follow this shape:

```json
{
  "repo": "owner/name",
  "pr_number": 123,
  "language": "python",
  "base_ref": "main",
  "head_ref": "feature",
  "changed_files": ["src/example.py"],
  "model_report_path": "evaluation/results/owner_name_pr123.json",
  "annotations": [
    {
      "annotator_id": "a1",
      "overall_risk": "medium",
      "top_risky_files": ["src/example.py"],
      "reasons": ["semantic", "evolution"],
      "rationale": "Touches a historically stable control-flow path."
    }
  ]
}
```

Allowed `overall_risk` values: `low`, `medium`, `high`.

Allowed reason labels: `structural`, `semantic`, `security`, `evolution/churn`, `duplication`, `unclear`.

`model_report_path` should point to a JSON file produced by `AnalysisPipeline.pr_risk_report()`.
