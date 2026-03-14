<div align="center">

# ⬡ ConsistenCy

**Multi-agent code consistency & security analysis for Python repos**

Catch style drift · Find security flaws · Spot tech debt hotspots · Auto-review PRs

[![CI](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml/badge.svg)](https://github.com/sk1ua/ConsistenCy/actions/workflows/ci.yml)
[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue.svg)](https://www.python.org/downloads/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

</div>

---

## Why ConsistenCy?

In projects with many contributors (especially AI-assisted "vibe coding"), code consistency silently degrades: naming conventions drift, dangerous functions creep in, and PRs get rubber-stamped. **ConsistenCy** automatically detects these problems by comparing every commit against the project's own historical patterns.

**Core capabilities:**

- 🔍 **Consistency drift detection** — quantify how far new code deviates from existing style, structure, and semantics
- 🛡️ **Security scanning** — hardcoded credentials, `eval()`/`exec()`, SQL injection, unsafe YAML
- 📊 **Tech debt hotspots** — high-churn × high-complexity files visualized in a dashboard
- 🤖 **AI code review** — DeepSeek LLM reads actual source code and generates natural-language feedback
- 💬 **GitHub PR automation** — CI posts Markdown risk reports as PR comments

---

## Quick Start

### 1. Install

```bash
git clone https://github.com/sk1ua/ConsistenCy.git
cd ConsistenCy
pip install -r backend/requirements.txt
```

### 2. Scan a repo

```bash
cd backend
python cli.py scan /path/to/your/repo
```

### 3. Analyze a single commit

```bash
python cli.py analyze-commit --repo /path/to/repo --commit abc1234
```

That's it — you'll see a color-coded risk report in your terminal.

---

## All Commands

| Command | Description |
|---------|-------------|
| `scan <path>` | Build a baseline snapshot for the repo |
| `analyze-commit --repo <path> --commit <sha>` | Full multi-agent analysis on one commit |
| `analyze-range --repo <path> --weeks 8` | Batch analysis over a time range |
| `pr-report --repo <path> --base main --head feature` | PR-level risk report |
| `analyze-file new.py old.py` | Compare two files directly (no Git needed) |
| `web-ui --port 8000` | Launch the web dashboard |
| `export-by-file --repo <path>` | Export file-level data to JSON/CSV |

### PR Report with AI Review

```bash
# Basic report
python cli.py pr-report --repo . --base main --head feature-branch

# With AI review (requires API key)
python cli.py pr-report --repo . --base main --head feature-branch --llm-review

# JSON output for CI pipelines
python cli.py pr-report --repo . --base main --head feature-branch --json-output
```

### Web Dashboard

```bash
python cli.py web-ui --port 8000
```

Open `http://localhost:8000`, enter a local repo path, click **Analyze**.

The dashboard shows: risk timeline, agent radar, file risk bars, author profiles, tech debt scatter plot, and a full evidence chain.

---

## AI Review Setup (Optional)

ConsistenCy can call [DeepSeek](https://platform.deepseek.com) to generate natural-language code review comments. Without a key, everything else works normally — only the AI section is skipped.

```bash
cp .env.example .env
# Edit .env:
# DEEPSEEK_API_KEY=sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## GitHub PR Automation

Add the included CI workflow to get automatic risk reports on every pull request:

1. Copy `.github/workflows/ci.yml` to your project
2. (Optional) Add `DEEPSEEK_API_KEY` as a repository secret for AI comments
3. Every PR will receive:
   - Full multi-agent analysis
   - Security vulnerability report (CRITICAL findings suggest blocking merge)
   - Markdown risk summary posted as a PR comment
   - AI review paragraph (if API key is set)

---

## How It Works

ConsistenCy runs **8 specialized agents** on every commit:

| Agent | What it analyzes |
|-------|-----------------|
| **ParserAgent** | AST parsing, Halstead metrics, cyclomatic complexity |
| **StyleAgent** | Naming conventions, docstrings, formatting drift |
| **StructuralAgent** | Import dependencies, coupling, inheritance depth |
| **SemanticAgent** | Subtree-structure similarity, API usage, control flow |
| **EvolutionAgent** | Code churn, Shannon entropy, hotspots, bus factor |
| **DuplicationAgent** | Clone detection, duplication ratio |
| **SecurityAgent** | Hardcoded secrets, dangerous calls, injection risks (f-string / `.format()` / `%`) |
| **RiskScoringAgent** | Weighted aggregation with security overrides |

Each file gets a risk score from 0 to 1:

| Score | Level | Meaning |
|-------|-------|---------|
| 0.00 – 0.24 | 🟢 GREEN | Consistent |
| 0.25 – 0.49 | 🟡 YELLOW | Minor Drift |
| 0.50 – 0.74 | 🟠 ORANGE | Significant Drift |
| 0.75 – 1.00 | 🔴 RED | High Risk |

Security findings override scores: a CRITICAL finding forces RED (≥ 0.75), HIGH forces ORANGE (≥ 0.50).

---

## Project Structure

```
ConsistenCy/
├── backend/
│   ├── cli.py                     # CLI entry point
│   ├── requirements.txt
│   └── src/
│       ├── agents/                # 8 analysis agents
│       ├── pipeline.py            # Core analysis pipeline
│       ├── review_suggestions.py  # PR comment formatter
│       ├── llm_reviewer.py        # DeepSeek AI review
│       ├── llm_ready_snippets.py  # Code snippet extraction for LLM
│       ├── exporter.py            # JSON / CSV / SQLite export
│       ├── baseline_strategy.py   # File scenario classification
│       └── baseline_storage.py    # SQLite baseline cache
├── frontend/
│   ├── app.py                     # Flask server
│   ├── templates/index.html       # Dashboard HTML
│   └── static/                    # CSS + JS
├── .github/workflows/ci.yml       # CI + PR automation
├── .env.example                   # Environment variable template
└── tests/                         # 55+ tests
```

---

## Running Tests

```bash
PYTHONPATH=backend pytest tests -q
```

---

## Limitations

- **Python only** — all analysis uses `ast.parse()` (other languages are on the roadmap)
- **Local repos** — requires a cloned Git repository path
- **Author view uses proxy risk** — `author_breakdown()` currently reports churn-based `avg_risk_proxy`

---

## License

[MIT](LICENSE)
