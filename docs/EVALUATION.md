# Evaluation Workflow

ConsistenCy includes an evaluation workspace for ranking quality,
ablation studies, and failure analysis. The checked-in files are
intentionally small; generated reports, local repository checkouts, and
the working manifest are all gitignored.

## Current Maturity

The evaluation framework is in place: metrics scripts, ablation runner,
annotation templates, manifest builder, and batch report runner. Real PR
labels are supplied automatically by importing public review-comment
datasets as weak labels. The default target is SWE-PRBench, which
provides real PR metadata, base/head commits, changed files, and human
review comments.

Manual audit is optional for the automatic benchmark. It is only needed
before making stronger research claims that require gold-standard labels.
Without generated model reports, the metrics scripts skip samples and
report `n/a` for uncomputable rank-based metrics.

## Public PR Evaluation Workflow

The end-to-end loop has four steps. Each script can be run from the
project root.

### Recommended Data Sources

| Tier | Source | Why |
| --- | --- | --- |
| Primary | [`foundry-ai/swe-prbench`](https://huggingface.co/datasets/foundry-ai/swe-prbench) | Public AI-code-review benchmark with real PRs, base/head SHAs, changed files, and human review comments. |
| Secondary | Local JSONL converted from other public PR-comment datasets | For one-off audits or domain-specific samples. |

Not recommended for the first version:

- The 13M-row Kaggle PR-comments dump is too noisy, too large, and does
  not include the base/head SHAs ConsistenCy needs.
- Review4Repair is useful for review-comment-aided repair, not for PR
  risky-file ranking, which is what these metrics measure.

### Optional Dependency

Hugging Face mode requires the optional `datasets` package. It is not
pinned in `requirements.txt` so the project itself stays minimal:

```bash
python -m pip install datasets
```

Skipping this only blocks `--hf-dataset`; the local-input path works
without it.

### 1. Build The Manifest

```bash
# SWE-PRBench (primary)
python evaluation/scripts/build_public_pr_manifest.py \
  --hf-dataset foundry-ai/swe-prbench \
  --output evaluation/sampled_prs.json \
  --limit 50 \
  --languages py,js,jsx,ts,tsx
```

```bash
# Local JSONL/JSON (secondary)
python evaluation/scripts/build_public_pr_manifest.py \
  --input evaluation/data/public_prs.jsonl \
  --output evaluation/sampled_prs.json \
  --limit 50 \
  --languages py,js,jsx,ts,tsx
```

The script tolerates common field-name variants, both flat and nested
forms such as `repository.full_name`, `base.sha`, and
`pull_request.number`, so SWE-PRBench-style records load without glue.

Weak label rules:

- `has_requested_changes == true` -> `high`
- `len(review_comments) >= 5` -> `high`
- `2..4` review comments -> `medium`
- exactly `1` review comment -> `low`
- no signal -> sample is skipped

Reason categories are inferred from review-comment text via simple
keyword heuristics: `security`, `semantic`, `structure`, `style`, and
`test`. When no category matches, the script falls back to
`["review_comment"]`.

The summary printed at the end records `read_count`, `skipped_count`,
`written_count`, `language_filter`, `output_path`, `source`, and skip
reasons such as `missing_repo`, `missing_pr_number`,
`missing_base_or_head`, `missing_review_comments`, `no_supported_files`,
and `invalid_record`.

### 2. Run ConsistenCy Reports

```bash
python evaluation/scripts/run_public_pr_reports.py \
  --manifest evaluation/sampled_prs.json \
  --repos-dir evaluation/repos \
  --results-dir evaluation/results \
  --limit 50
```

Use `--dry-run` to print the planned `git clone`, `git fetch --all
--tags`, and `pr-report` commands without executing them. A summary
(`evaluation/results/run_public_pr_reports_summary.json`) records
per-entry status (`success`, `failed`, `skipped`, or `dry_run`) so a
single failure does not hide the rest. Captured stderr is scrubbed of
token-shaped substrings before being written.

### 3. Compute Metrics

```bash
python evaluation/scripts/run_metrics.py \
  --manifest evaluation/sampled_prs.json \
  --output evaluation/results/metrics_summary.json \
  --markdown-output evaluation/results/metrics_summary.md \
  --k 3
```

The README table should be filled from this output:

- `Samples`
- `Evaluated`
- `Precision@3`
- `Recall@3`
- `Spearman`

Metrics that cannot be computed, such as Spearman with fewer than two
evaluated samples, render as `n/a` in the Markdown output rather than a
misleading `0.000`.

### 4. Interpret Weak Labels

Public review comments are weak labels. A `high` rating only means the
human reviewer requested changes or left several comments, not that
ConsistenCy and the reviewer agree on which file is risky. The automatic
benchmark is still useful for ranking alignment because it asks whether
ConsistenCy surfaces files that public reviewers attended to.

Samples produced by `build_public_pr_manifest.py` are marked with
`label_source: public_review_comments` and `needs_manual_audit: true`.
That flag does not block the automatic weak-label benchmark; it is a
reminder that manual audit is required only before treating the labels as
gold-standard annotations or making stronger research claims.

### 5. Weak Label Semantics

| Source signal | What it does not mean |
| --- | --- |
| `has_requested_changes` | Reviewer disagreed on risk, not necessarily on the same files. |
| Comment volume | High counts often correlate with style nits, not semantic risk. |
| `top_risky_files` from comment paths | Reviewer-touched paths skew toward what the reviewer noticed first. |

Weak labels are useful for ranking alignment and regression signals.
They are not sufficient for absolute gold-standard precision/recall
claims.

## Existing Per-Sample Annotation Track

Manual gold annotations remain supported via
`evaluation/annotations/annotation_template.json`. They are optional for
the automatic weak-label benchmark. The minimum useful label set is:

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
- `evaluation/data/`
- `evaluation/annotations/pilot_tasks.json`
- `*.db` / `*.sqlite` / `*.sqlite3`

## Limitations

- `SemanticAgent` uses AST / API / control-flow proxy signals, not formal
  semantic equivalence.
- Public review comments are weak labels. Manual audit is optional for
  the automatic benchmark, but required before using the labels as
  gold-standard research annotations.
- Remote analysis quality depends on the parent commit being available
  via the GitHub API; new files fall back to either an empty or a
  language-specific template baseline (recorded as `baseline_strategy`).
- Multi-agent here means deterministic specialist analyzers plus
  consensus coordination, not autonomous LLM agents.
