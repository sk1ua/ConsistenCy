# ConsistenCy Evaluation Workspace

This folder contains the optional reproducibility scaffold for public PR weak-label risk ranking studies. Generated reports, sampled manifests, and local repository clones are ignored so the GitHub repository stays small.

**Important:** The evaluation scaffold consumes pre-generated V2 `ReviewReport` JSON artifacts (produced by TypeScript `apps/api` orchestration or saved evaluation benchmarks). Legacy Python Git pipeline generators have been removed in V2.

## Workflow

1. Build sampled PR metadata and weak labels into `sampled_prs.json`.
2. Export or place V2 model report JSON files into `evaluation/results/`.
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
