# ConsistenCy Evaluation Workspace

This folder contains the optional reproducibility scaffold for human-aligned PR risk ranking studies. Generated reports, sampled manifests, and local repository clones are ignored so the GitHub repository stays small.

**Important:** The scaffold is ready but no real annotated PR data is included.  You must supply your own `sampled_prs.json` manifest and labels before the metrics scripts produce meaningful numbers.  See `sampled_prs.example.json` for the schema.

## Workflow

1. Add sampled PR metadata to `sampled_prs.json`.
2. Generate one model report JSON per PR into `evaluation/results/`.
3. Collect reviewer labels using `annotations/annotation_template.json`.
4. Run ranking metrics:

```bash
python evaluation/scripts/run_metrics.py --manifest evaluation/sampled_prs.json --output evaluation/results/metrics_summary.json
```

5. Run report-level signal ablations:

```bash
python evaluation/scripts/run_ablation.py --manifest evaluation/sampled_prs.json --output evaluation/results/ablation_summary.json
```

## Notes

The `generic_baseline` ablation is approximate unless reports are regenerated with a true generic baseline. Signal-removal ablations can be computed from existing reports because extracted signal scores are already stored in the report schema.
