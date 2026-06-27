# Remote Analysis

The remote path lets ConsistenCy inspect GitHub PRs without requiring a full local checkout.

Use it for data collection and evaluation. It depends on repository access and base/head refs being available.

Local deterministic analysis remains available through:

```bash
python backend/cli.py pr-report --repo . --base <base> --head <head> --json-output
```
