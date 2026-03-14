# Remote Repository Analysis

Analyze any GitHub repository without cloning it locally.

## Features

- **No local clone required** — Analyze repos directly via GitHub API
- **Historical trends** — Track code quality evolution over time
- **Shareable reports** — Export JSON or PDF for sharing
- **Language breakdown** — See which languages are used
- **Risk trends** — Visualize risk changes over weeks/months

## Quick Start

### 1. Install dependencies

```bash
pip install requests
```

### 2. Set GitHub token (optional but recommended)

For public repos, no token needed. For private repos or higher rate limits:

```bash
export GITHUB_TOKEN=ghp_your_token_here
```

Create a token at: https://github.com/settings/tokens

### 3. Analyze a remote repo

```bash
# Basic analysis
consistency analyze-remote facebook/react

# Analyze with date range
consistency analyze-remote facebook/react --since 2024-01-01 --until 2024-12-31

# More commits
consistency analyze-remote facebook/react --max-commits 100

# JSON output for automation
consistency analyze-remote facebook/react --json-output > react-analysis.json
```

### 4. Historical trend analysis

```bash
# Monthly trends for the past year
consistency trend facebook/react --period monthly --months 12

# Weekly trends
consistency trend facebook/react --period weekly --months 3

# Quarterly trends
consistency trend facebook/react --period quarterly --months 24

# Export to JSON
consistency trend facebook/react --json-output > react-trends.json
```

## CLI Commands

### `analyze-remote`

Analyze a GitHub repository's recent commits.

```bash
consistency analyze-remote OWNER/REPO [OPTIONS]
```

**Options:**
- `--since YYYY-MM-DD` — Start date
- `--until YYYY-MM-DD` — End date
- `--max-commits N` — Maximum commits to analyze (default: 50)
- `--token TOKEN` — GitHub token (or use GITHUB_TOKEN env)
- `--json-output` — Output JSON instead of formatted text

**Example:**
```bash
consistency analyze-remote microsoft/vscode --since 2024-06-01 --max-commits 100
```

### `trend`

Analyze historical risk trends over time.

```bash
consistency trend OWNER/REPO [OPTIONS]
```

**Options:**
- `--period weekly|monthly|quarterly` — Trend granularity (default: monthly)
- `--months N` — Number of months to analyze (default: 12)
- `--token TOKEN` — GitHub token
- `--json-output` — Output JSON

**Example:**
```bash
consistency trend kubernetes/kubernetes --period monthly --months 6
```

## Output Format

### Text Output (default)

```
⬡ ConsistenCy  Remote analysis facebook/react

Repository: facebook/react
A declarative, efficient, and flexible JavaScript library for building user interfaces.
Stars: 228,123  Forks: 46,789
Language: JavaScript

Analysis Results:
  Commits analyzed: 50
  Overall risk: 0.234 (Minor Drift)

Language Breakdown:
  javascript: 45 files
  typescript: 12 files

Top Risky Files
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━┳━━━━━━━┳━━━━━━━━━━━━━━┓
┃ File                        ┃ Language   ┃ Risk  ┃ Level        ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━╇━━━━━━━╇━━━━━━━━━━━━━━┩
│ src/react-dom/client.js     │ javascript │ 0.654 │ Significant  │
│ packages/react-reconciler/… │ javascript │ 0.612 │ Significant  │
│ ...                         │ ...        │ ...   │ ...          │
└─────────────────────────────┴────────────┴───────┴──────────────┘
```

### JSON Output

```json
{
  "metadata": {
    "owner": "facebook",
    "name": "react",
    "full_name": "facebook/react",
    "description": "A declarative, efficient...",
    "language": "JavaScript",
    "stars": 228123,
    "forks": 46789
  },
  "analyzed_at": "2024-12-15T10:30:00+00:00",
  "commits_analyzed": 50,
  "overall_risk": 0.234,
  "risk_level": "Minor Drift",
  "language_breakdown": {
    "javascript": 45,
    "typescript": 12
  },
  "top_risky_files": [
    {
      "path": "src/react-dom/client.js",
      "language": "javascript",
      "risk_score": 0.654,
      "risk_level": "Significant Drift"
    }
  ]
}
```

## How It Works

1. **Fetch metadata** — Get repo info from GitHub API
2. **List commits** — Fetch recent commits within date range
3. **Download files** — Fetch changed files for each commit
4. **Run analysis** — Apply 8-agent analysis pipeline
5. **Cache results** — Store in SQLite cache for faster re-analysis
6. **Generate report** — Aggregate and format results

## Rate Limiting

GitHub API has rate limits:
- **Unauthenticated**: 60 requests/hour
- **Authenticated**: 5,000 requests/hour

The tool automatically:
- Adds delays between requests (0.5s default)
- Respects rate limit reset times
- Caches downloaded files

## Caching

Downloaded files and analysis results are cached in:
```
/tmp/consistency_remote_cache/
├── remote_cache.db  # SQLite cache
└── ...
```

Cache is keyed by `(owner, repo, file_path, commit_sha)`.

## Limitations

| Limitation | Detail |
|------------|--------|
| File size | Max 1MB per file (GitHub API limit) |
| Binary files | Skipped (cannot analyze) |
| Large repos | May hit rate limits; use `--max-commits` |
| Private repos | Requires GitHub token with `repo` scope |

## Web Dashboard

Remote analysis is also available in the web dashboard:

```bash
consistency web-ui
```

Then enter a GitHub URL like `https://github.com/facebook/react` instead of a local path.

## Examples

### Compare two projects

```bash
# Analyze React
consistency analyze-remote facebook/react --json-output > react.json

# Analyze Vue
consistency analyze-remote vuejs/vue --json-output > vue.json

# Compare
jq '.overall_risk' react.json vue.json
```

### Track a project's health over time

```bash
# Monthly report
consistency trend owner/repo --period monthly --months 6

# Save for later comparison
consistency trend owner/repo --json-output > trend-$(date +%Y%m).json
```

### CI/CD integration

```yaml
# .github/workflows/health-check.yml
- name: Analyze project health
  run: |
    consistency analyze-remote ${{ github.repository }} \
      --since $(date -d '30 days ago' +%Y-%m-%d) \
      --json-output > health-report.json
    
    # Fail if risk is too high
    risk=$(jq '.overall_risk' health-report.json)
    if (( $(echo "$risk > 0.5" | bc -l) )); then
      echo "Risk is too high: $risk"
      exit 1
    fi
```

## Troubleshooting

### "Rate limited" error

Wait for rate limit reset or use a GitHub token:
```bash
export GITHUB_TOKEN=ghp_xxx
```

### "Repository not found"

- Check the repo exists and is accessible
- For private repos, ensure token has `repo` scope

### "requests library required"

Install requests:
```bash
pip install requests
```

### Analysis is slow

- Reduce `--max-commits`
- Use a smaller date range
- Results are cached; re-analysis is faster
