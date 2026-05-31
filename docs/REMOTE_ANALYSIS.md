# Remote Repository Analysis

ConsistenCy can analyze public or private GitHub repositories through the GitHub API. This is useful when you want a quick risk scan without manually cloning a repository first.

## Requirements

```bash
pip install -r requirements-dev.txt
```

For private repositories or higher rate limits, set a token:

```bash
set GITHUB_TOKEN=ghp_your_token_here
```

## Commands

Analyze recent commits:

```bash
python backend/cli.py analyze-remote pallets/flask --max-commits 50
```

Analyze a date range:

```bash
python backend/cli.py analyze-remote pallets/flask --since 2025-01-01 --until 2025-12-31
```

Export JSON:

```bash
python backend/cli.py analyze-remote pallets/flask --json-output > remote-report.json
```

Generate historical trends:

```bash
python backend/cli.py trend pallets/flask --period monthly --months 12
```

## Output

Remote reports include:

- repository metadata
- commits analyzed
- overall risk and risk level
- language breakdown
- top risky files (with per-file `baseline_strategy`, `current_ref`, `baseline_ref`)
- signal composition

### Baseline strategy

Each analyzed file in a remote report records how its comparison baseline
was chosen, so consumers can tell a real diff from a degenerate fallback:

| `baseline_strategy` | Meaning |
| --- | --- |
| `parent_commit` | File content was fetched at the commit's parent SHA. True diff. |
| `new_file_template_baseline` | File is new in this commit; a language template was used as baseline. |
| `new_file_empty_baseline` | File is new in this commit; no template available; baseline is empty. |
| `empty_no_parent` | Commit has no parent (initial commit); baseline is empty. |
| `unknown_legacy_cache` | Result was loaded from a cache written before this field existed. |

`current_ref` is the analyzed commit SHA. `baseline_ref` is the parent SHA
when one was used, otherwise `null`.

## Notes

- Unauthenticated GitHub API requests are limited to 60 requests per hour.
- Authenticated requests usually allow 5,000 requests per hour.
- Large binary files are skipped.
- Downloaded data is cached locally and should not be committed.

## Limitations

- Remote analysis depends on parent commit content being retrievable via
  the GitHub API; merge commits or commits whose parent has been
  garbage-collected fall back to an empty or template baseline.
- Rate limiting on unauthenticated requests caps the practical sample
  size; set `GITHUB_TOKEN` for serious benchmarking.
- The cache layer falls back to `baseline_strategy = "unknown_legacy_cache"`
  for entries written before the strategy field existed; rerun with a
  cleared cache directory to get exact strategies for older work.
