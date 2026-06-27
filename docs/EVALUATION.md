# Evaluation

ConsistenCy evaluates reviewer-attention alignment, not perfect defect detection.

## Workflow

```bash
python evaluation/scripts/build_public_pr_manifest.py --output evaluation/sampled_prs.json
python evaluation/scripts/run_public_pr_reports.py --manifest evaluation/sampled_prs.json
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --markdown-output evaluation/results/metrics_summary.md
```

## Metrics

- `Precision@K`
- `Recall@K`
- `Evidence Recall@K`
- `Average Compression Ratio`
- `Average Selected Evidence Count`
- `Files With Evidence`

`false_evidence_rate` and `evidence_usefulness_score` remain `n/a` unless a manual audit provides labels.

## Weak Labels

Public review comments are weak supervision for reviewer-attention alignment, not gold-standard defect labels. Manual audit is required before making stronger research claims.
