# 评估数据集 Schema

本文件定义 `evaluation/sampled_prs.json` 中每条 sampled PR 记录的结构。字段名保持英文 snake_case，与生成脚本和 `ReviewReport` 契约一致；`annotations` 来自公开 Review 弱标签或人工标注，用于排序指标计算，不代表缺陷金标准。

每条 sampled PR 记录应遵循以下结构：

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
      "annotator_id": "public-review-weak-label",
      "overall_risk": "medium",
      "top_risky_files": ["src/example.py"],
      "reasons": ["semantic", "evolution"],
      "rationale": "Touches a historically stable control-flow path."
    }
  ]
}
```

`model_report_path` 必须指向由 TypeScript 编排流程产生的 `ReviewReport` JSON，或结构兼容的固定 benchmark 报告。

允许的 `overall_risk`：`low`、`medium`、`high`。

允许的 reason label：`structural`、`semantic`、`security`、`evolution/churn`、`duplication`、`unclear`。
