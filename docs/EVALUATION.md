# 评估

ConsistenCy 评估的是“审查者注意力排序是否合理”，不是完美缺陷检测。

## 工作流

```bash
python evaluation/scripts/build_public_pr_manifest.py --output evaluation/sampled_prs.json
python evaluation/scripts/run_public_pr_reports.py --manifest evaluation/sampled_prs.json
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --markdown-output evaluation/results/metrics_summary.md
```

## 指标

- `Precision@K`
- `Recall@K`
- `Evidence Recall@K`
- `Average Compression Ratio`
- `Average Selected Evidence Count`
- `Files With Evidence`

`false_evidence_rate` 和 `evidence_usefulness_score` 需要人工审计标签；没有标签时保持 `n/a`。

## 弱标签

公开 PR 评论只能作为审查者注意力的弱监督信号，不是缺陷金标准。更强的研究结论需要人工审计。
