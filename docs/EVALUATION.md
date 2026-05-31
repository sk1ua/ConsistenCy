# Evaluation Workflow

ConsistenCy includes an evaluation workspace for ranking quality, ablation
studies, and failure analysis. The checked-in files are intentionally small;
generated reports, local repository checkouts, and the working manifest are
all gitignored.

## Current Maturity

The evaluation **framework** (metrics scripts, ablation runner, annotation
templates, manifest builder, batch report runner) is in place. **Real PR
labels still need to be supplied** by the user — typically by importing
public review-comment datasets as weak labels and then auditing 30–50
samples. Without labeled data, the metrics scripts will report `n/a` for
the rank-based metrics.

## Public PR Evaluation Workflow

The end-to-end loop has four steps. Each script can be run from the
project root.

### Recommended data sources

| Tier | Source | Why |
| --- | --- | --- |
| Primary | [`foundry-ai/swe-prbench`](https://huggingface.co/datasets/foundry-ai/swe-prbench) | Public AI-code-review benchmark with real PRs, base/head SHAs, changed files, and human review comments. |
| Secondary | Local JSONL converted from other public PR-comment datasets | For one-off audits or domain-specific samples. |

**Not recommended for the first version:**

- The 13M-row Kaggle PR-comments dump — too noisy, too large, and the
  schema does not include the base/head SHAs ConsistenCy needs.
- Review4Repair — useful for review-comment-aided **repair**, not for PR
  **risky-file ranking**, which is what these metrics measure.

### Optional dependency

HuggingFace mode requires the optional `datasets` package (deliberately
not pinned in `requirements.txt` so the project itself stays minimal):

```bash
python -m pip install datasets
```

Skipping this only blocks `--hf-dataset`; the local-input path works
without it.

### 1. Build the manifest

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

The script tolerates the common field-name variants — both flat and
nested forms (e.g. `repository.full_name`, `base.sha`,
`pull_request.number`) — so SWE-PRBench-style records load without glue.

Weak label rules:

- `has_requested_changes == true` → `high`
- `len(review_comments) >= 5` → `high`
- `2..4` review comments → `medium`
- exactly `1` review comment → `low`
- no signal → sample is **skipped** (no entry written)

Reason categories are inferred from review-comment text via simple
keyword heuristics (`security`, `semantic`, `structure`, `style`,
`test`); falls back to `["review_comment"]` when no keywords match.

The summary printed at the end records `read_count`, `skipped_count`
(broken down by reason: `missing_repo` / `missing_pr_number` /
`missing_base_or_head` / `missing_review_comments` /
`no_supported_files` / `invalid_record`), `written_count`,
`language_filter`, `output_path`, and `source`.

### 2. Run ConsistenCy reports

```bash
python evaluation/scripts/run_public_pr_reports.py \
  --manifest evaluation/sampled_prs.json \
  --repos-dir evaluation/repos \
  --results-dir evaluation/results \
  --limit 50
```

Use `--dry-run` to print the planned `git clone` / `git fetch --all
--tags` / `pr-report` commands without executing them. A summary
(`evaluation/results/run_public_pr_reports_summary.json`) records
per-entry status (`success` / `failed` / `skipped` / `dry_run`) so a
single failure does not hide the rest. Captured stderr is scrubbed of
token-shaped substrings before being written.

### 3. Compute metrics

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

Public review comments are weak labels. A "high" rating only means the
human reviewer requested changes or left several comments, not that
ConsistenCy and the reviewer agree on which file is risky. **Before
publishing numbers anywhere user-visible:**

- Spot-check 30–50 manifest entries against the linked PRs and either
  upgrade them with second-annotator labels or drop them.
- Treat any sample with `needs_manual_audit: true` (the default for
  every record produced by `build_public_pr_manifest.py`) as
  unconfirmed.
- Record the audit decisions alongside the manifest so re-running the
  metrics is reproducible.

### 5. How to interpret weak labels

| Source signal | What it does NOT mean |
| --- | --- |
| `has_requested_changes` | Reviewer disagreed on **risk**, not necessarily on the same files. |
| Comment volume | High counts often correlate with style nits, not semantic risk. |
| `top_risky_files` from comment paths | Reviewer-touched paths skew toward what the reviewer noticed first. |

Weak labels are useful for **ranking** alignment (does ConsistenCy
surface the same files the reviewer attended to?) and for **regression**
signals (did a refactor make our top-3 worse?). They are **not**
sufficient for absolute precision/recall claims.

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
- `evaluation/data/`
- `evaluation/annotations/pilot_tasks.json`
- `*.db` / `*.sqlite` / `*.sqlite3`

## Limitations

- `SemanticAgent` uses AST / API / control-flow proxy signals, not formal
  semantic equivalence.
- Public review comments are weak labels and require manual audit before
  use as benchmark gold.
- Remote analysis quality depends on the parent commit being available
  via the GitHub API; new files fall back to either an empty or a
  language-specific template baseline (recorded as `baseline_strategy`).
- Multi-agent here means deterministic specialist analyzers plus
  consensus coordination, not autonomous LLM agents.
