# Evaluation Workflow

ConsistenCy includes a lightweight evaluation workspace for ranking quality, ablation studies, and failure analysis. The checked-in files are intentionally small; generated reports and local repository checkouts are ignored.

## What To Measure

| Track | Metric |
| --- | --- |
| Risk ranking | Spearman correlation, top-k hit rate, precision@k, recall@k |
| Ablation | Full model vs. removed signal families |
| Reviewer usefulness | Time to identify risky file, evidence clarity, handoff usefulness |
| Failure analysis | Sparse history, large renames, generated code, template-heavy code |

## Workflow

1. Add sampled PR metadata to `evaluation/sampled_prs.json`.
2. Generate one report per PR into `evaluation/results/`.
3. Collect labels with `evaluation/annotations/annotation_template.json`.
4. Run metric and ablation scripts.

```bash
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --output evaluation/results/metrics_summary.json
python evaluation/scripts/run_ablation.py --manifest evaluation/sampled_prs.json --output evaluation/results/ablation_summary.json
```

## Annotation Labels

The minimum useful label set is:

- risky files that deserved reviewer attention
- severity per file: `low`, `medium`, `high`
- reason category: style, structure, semantic behavior, duplication, security, evolution
- optional notes for false positives or missed risks

## Repository Hygiene

The following paths are generated and should stay out of Git:

- `evaluation/repos/`
- `evaluation/results/`
- `evaluation/sampled_prs.json`
- `evaluation/annotations/pilot_tasks.json`
