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
- top risky files
- signal composition

## Notes

- Unauthenticated GitHub API requests are limited to 60 requests per hour.
- Authenticated requests usually allow 5,000 requests per hour.
- Large binary files are skipped.
- Downloaded data is cached locally and should not be committed.
