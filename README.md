# ConsistenCy

Code consistency analysis toolkit for multi-contributor repositories.

It provides repository scan, commit-level risk scoring, hybrid retrieval (vector + graph), and weak-supervision evaluation.

---

## Overview

ConsistenCy is designed to detect context inconsistency caused by long-term multi-commit collaboration.
It helps teams identify style drift, structural drift, and logic drift at commit level.

---

## Features

* Repository scan and consistency checks
* Commit-level scoring (style / structure / logic)
* Vector retrieval with Chroma
* Graph retrieval with Neo4j PoC
* Weak-supervision evaluation (P/R/F1)
* CLI for end-to-end workflow

---

## Architecture

```text
Developer / CI
   |
   v
CLI
   |
   +-- Scan Pipeline
   |     +-- Parser (AST)
   |     +-- Extractor
   |     `-- Storage (Vector DB)
   |
   `-- Commit MVP Pipeline
         +-- Commit Miner (Git)
         +-- Graph Store (Neo4j)
         +-- Hybrid Retriever
         `-- Risk Scorer + Evidence
```

| Component | Description |
| --- | --- |
| CLI | Entry point for scanning, checking, scoring, evaluation |
| Parser/Extractor | Parses Python code and extracts structured features |
| Storage | Stores and retrieves semantic code vectors |
| Commit Pipeline | Mines changed functions and computes risk scores |
| Graph Store | Stores author/commit/file/function graph for path evidence |

Summary: the scan stage builds knowledge; the commit stage fuses vector and graph evidence for risk scoring.

---

## Project Structure

```text
.
├── backend/
│   ├── cli.py
│   ├── config.py
│   ├── requirements.txt
│   └── src/
│       ├── parser.py
│       ├── extractor.py
│       ├── storage.py
│       ├── checker.py
│       ├── ml_naming_model.py
│       └── commit_pipeline.py
├── data/
├── tests/
└── README.md
```

---

## Installation

Clone and install:

```bash
git clone https://github.com/sk1ua/ConsistenCy.git
cd ConsistenCy/backend
pip install -r requirements.txt
```

Optional: start Neo4j for graph evidence:

```bash
docker run -d --name consistency-neo4j -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/test123456 neo4j:5.26
```

---

## Configuration

Configuration file:

```text
backend/config.py
```

Main configurable items:

* Naming rules and thresholds
* Vector DB settings
* Lightweight model settings

---

## Usage

Three-command quick reproduction (scan -> commit-mvp -> eval-weak):

```bash
cd backend
python cli.py scan ../../python-patterns --clear
python cli.py commit-mvp ../../python-patterns 39708b9d59b49e371c508b2cd5fc42bb2b692221 --topk 3 --neo4j-uri bolt://localhost:7687 --neo4j-user neo4j --neo4j-password test123456
python cli.py eval-weak ../../python-patterns --samples 60 --max-commits 220
```

---

## Example

Input: repository path + commit SHA

System: returns style/structure/logic risk scores and evidence list

Output: overall_risk + Top-K evidence

---

## Roadmap

* [x] Commit-level MVP
* [x] Neo4j PoC integration
* [x] Hybrid retrieval
* [ ] Strongly-labeled benchmark set
* [ ] Rich PR report generation

---

## Contributing

Contributions are welcome.

1. Fork the repository
2. Create a feature branch
3. Open a pull request

---

## License

MIT License
