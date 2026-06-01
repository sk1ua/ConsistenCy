# ConsistenCy Evaluation Workspace

This folder contains the optional reproducibility scaffold for public PR weak-label risk ranking studies. Generated reports, sampled manifests, and local repository clones are ignored so the GitHub repository stays small.

**Important:** The scaffold is ready for automatic weak-label evaluation. Build `sampled_prs.json` from SWE-PRBench or a compatible public PR dataset, generate model reports, and then run metrics. Manual labels are optional and only needed for stronger gold-standard research claims.

## Workflow

1. Build sampled PR metadata and weak labels into `sampled_prs.json`.
2. Generate one model report JSON per PR into `evaluation/results/`.
3. Run ranking metrics:

```bash
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --output evaluation/results/metrics_summary.json
```

4. Run report-level signal ablations:

```bash
python evaluation/scripts/run_ablation.py --manifest evaluation/sampled_prs.json --output evaluation/results/ablation_summary.json
```

## Notes

The `generic_baseline` ablation is approximate unless reports are regenerated with a true generic baseline. Signal-removal ablations can be computed from existing reports because extracted signal scores are already stored in the report schema.
