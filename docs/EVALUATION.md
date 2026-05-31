# Evaluation Workflow

ConsistenCy includes an evaluation workspace for ranking quality, ablation
studies, and failure analysis. The checked-in files are intentionally small;
generated reports, local repository checkouts, and the working manifest are
all gitignored.

## Current Maturity

The evaluation **framework** (metrics scripts, ablation runner, annotation
templates, manifest builder, batch report runner) is in place. **Real PR
labels still need to be supplied** by the user — either by manually
auditing samples or by importing public review-comment datasets as weak
labels. Without labeled data, the metrics scripts will report `n/a` for
the rank-based metrics.

## End-to-End Public PR Evaluation

The four scripts below form a closed loop. Each one is a regular Python
file you can run from the project root.

### 1. Build the manifest

`build_public_pr_manifest.py` converts a public PR data source into the
manifest schema consumed by the rest of the pipeline. Two input modes:

```bash
# Local JSONL or JSON file (most common)
python evaluation/scripts/build_public_pr_manifest.py \
  --input evaluation/data/public_prs.jsonl \
  --output evaluation/sampled_prs.json \
  --limit 50 \
  --languages py,js,ts,tsx
```

```bash
# HuggingFace dataset (optional - requires `pip install datasets`)
python evaluation/scripts/build_public_pr_manifest.py \
  --hf-dataset foundry-ai/swe-prbench \
  --output evaluation/sampled_prs.json \
  --limit 50 \
  --languages py,js,ts,tsx
```

The script tolerates the common field-name variants (`repo`/`repository`,
`pr_number`/`pull_number`/`number`, `base_sha`/`base_commit`, etc.). The
weak label rules are:

- `has_requested_changes == true` → `high`
- `len(review_comments) >= 5` → `high`
- `2..4` review comments → `medium`
- exactly `1` review comment → `low`
- no signal → sample is **skipped** (no entry written)

The summary printed at the end records `read_count`, `skipped_count`,
`written_count`, `language_filter` and `output_path`.

### 2. Run ConsistenCy reports

`run_public_pr_reports.py` clones (or fetches) each repo into
`evaluation/repos/` and invokes `pr-report --json-output` for the
`base_ref..head_ref` range, writing the output to the per-entry
`model_report_path`.

```bash
python evaluation/scripts/run_public_pr_reports.py \
  --manifest evaluation/sampled_prs.json \
  --repos-dir evaluation/repos \
  --results-dir evaluation/results \
  --limit 50
```

Use `--dry-run` to print the planned `git clone` / `git fetch` /
`pr-report` commands without executing them. A summary file
(`evaluation/results/run_public_pr_reports_summary.json`) records per-entry
status (`success` / `failed` / `skipped` / `dry_run`) so a single failure
does not hide the rest.

### 3. Compute metrics

`run_metrics.py` joins the model reports back to the manifest and computes
ranking-quality metrics. Pass `--markdown-output` to generate a
README-ready table:

```bash
python evaluation/scripts/run_metrics.py \
  --manifest evaluation/sampled_prs.json \
  --output evaluation/results/metrics_summary.json \
  --markdown-output evaluation/results/metrics_summary.md \
  --k 3
```

Metrics that can not be computed (e.g. Spearman with fewer than two
evaluated samples) render as `n/a` in the Markdown output rather than a
misleading `0.000`.

### 4. Manual audit notes

Public review comments are weak labels: a "high" rating only means the
human reviewer requested changes or left several comments, not that
ConsistenCy and the reviewer agree on which file is risky. Before
publishing numbers anywhere user-visible:

- Spot-check 30–50 manifest entries against the linked PRs and either
  upgrade them with second-annotator labels or drop them.
- Treat any sample with `needs_manual_audit: true` (which is the default
  for every record produced by `build_public_pr_manifest.py`) as
  unconfirmed.
- Record the audit decisions alongside the manifest so re-running the
  metrics is reproducible.

### 5. How to interpret weak labels

| Source signal | What it does NOT mean |
| --- | --- |
| `has_requested_changes` | Reviewer disagreed on **risk**, not necessarily on the same files. |
| Comment volume | High comment counts often correlate with style nits, not semantic risk. |
| `top_risky_files` from comment paths | Reviewer-touched paths skew toward what the reviewer noticed first. |

Weak labels are useful for **ranking** alignment (does ConsistenCy surface
the same files the reviewer attended to?) and for **regression** signals
(did a refactor make our top-3 worse?). They are **not** sufficient for
absolute precision/recall claims.

## Existing Per-Sample Annotation Track

Manual gold annotations remain supported via
`evaluation/annotations/annotation_template.json`. The minimum useful
label set is:

- risky files that deserved reviewer attention
- severity per file: `low`, `medium`, `high`
- reason category: style, structure, semantic behavior, duplication,
  security, evolution
- optional notes for false positives or missed risks

## Repository Hygiene

The following paths are generated and stay out of Git:

- `evaluation/repos/`
- `evaluation/results/`
- `evaluation/sampled_prs.json`
- `evaluation/annotations/pilot_tasks.json`

## Limitations

- `SemanticAgent` uses AST / API / control-flow proxy signals, not formal
  semantic equivalence.
- Public review comments are weak labels and require manual audit before
  use as benchmark gold.
- Remote analysis quality depends on the parent commit being available
  via the GitHub API; new files fall back to either an empty or a
  language-specific template baseline (recorded as `baseline_strategy`).
