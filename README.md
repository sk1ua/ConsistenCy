# ConsistenCy

Code consistency analysis toolkit for multi-contributor repositories.

A framework for commit-level consistency analysis that helps teams detect style drift, structural drift, and logic drift in evolving Python projects.

---

## Overview

ConsistenCy focuses on long-term codebase consistency in collaborative development.
It provides a practical pipeline to scan repositories, analyze commits, and generate explainable risk scores with supporting evidence.

The project exists to make consistency issues measurable and actionable, rather than relying only on manual review intuition.

---

## Features

* Commit-level consistency scoring (style / structure / logic)
* Hybrid retrieval (vector + graph evidence)
* Explainable evidence output (Top-K similar code)
* CLI workflow for scan and analysis
* Configurable rules and scoring weights
* Research-ready V2 evaluation modules (human labels, ablation, baselines)

---

## Architecture

The system is built as a modular analysis pipeline:

```text
User / CI
  │
  ▼
CLI
  │
  ├── Scan Pipeline
  │     ├── Parser (AST)
  │     ├── Extractor
  │     └── Storage (Vector DB)
  │
  └── Commit Pipeline
        ├── Commit Miner (Git)
        ├── Retriever (Vector + Graph)
        ├── Risk Scorer
        └── Evidence Report
```

Main components:

| Component | Description |
| --------- | ----------- |
| CLI | Entry point for scan, check, and evaluation commands |
| Parser / Extractor | Parses Python files and extracts structural knowledge |
| Storage | Stores and retrieves semantic code vectors |
| Commit Miner | Builds commit context from Git history and diff |
| Retriever | Combines vector and optional graph retrieval |
| Risk Scorer | Computes style / structure / logic risk scores |

---

## Project Structure

```text
.
├── backend/
│   ├── cli.py                 # command line entry
│   ├── config.py              # global config
│   └── src/
│       ├── parser.py
│       ├── extractor.py
│       ├── storage.py
│       ├── checker.py
│       ├── commit_pipeline.py
│       ├── human_labeled_evaluator.py
│       ├── ablation_study_v2.py
│       ├── baselines.py
│       └── cross_project_evaluator.py
├── data/
│   ├── rules.json
│   ├── annotations/
│   └── eval/
├── tests/
├── ARCHITECTURE.md
├── ROADMAP.md
└── README.md
```

---

## Installation

Clone the repository:

```bash
git clone https://github.com/sk1ua/ConsistenCy.git
cd ConsistenCy
```

Install dependencies:

```bash
cd backend
pip install -r requirements.txt
```

Optional Neo4j setup for graph evidence:

```bash
docker run -d --name consistency-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/test123456 neo4j:5.26
```

---

## Configuration

Edit configuration in:

```text
backend/config.py
```

Example snippet:

```python
CHECK_CONFIG = {
    "naming": {
        "function": "snake_case",
        "class": "PascalCase",
        "variable": "snake_case",
    },
    "max_function_length": 100,
    "max_line_length": 120,
}

RISK_SCORING_CONFIG = {
    "weights": {
        "style": 0.4,
        "structure": 0.3,
        "logic": 0.3,
    }
}
```

---

## Usage

Start with repository scan:

```bash
cd backend
python cli.py scan ../../python-patterns --clear
```

Run commit-level analysis:

```bash
python cli.py commit-mvp ../../python-patterns <commit_sha> --topk 3
```

(Optional) run evaluation command:

```bash
python cli.py eval-weak ../../python-patterns --samples 60 --max-commits 220
```

---

## Example

Minimal flow:

```text
input: repository path + commit SHA
system: mines diff, retrieves evidence, computes risks
output: style_risk / structure_risk / logic_risk / overall_risk + Top-K evidence
```

---

## Roadmap

Planned features:

* [x] Commit-level MVP pipeline
* [x] Hybrid retrieval (vector + graph)
* [ ] Human-labeled benchmark dataset
* [ ] Robust baseline comparison and statistical testing
* [ ] Cross-project generalization evaluation
* [ ] Rich PR report generation

---

## Contributing

Contributions are welcome.

Steps:

1. Fork the repository
2. Create a new branch
3. Add your changes and tests
4. Submit a pull request

---

## License

MIT License
