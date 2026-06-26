# -*- coding: utf-8 -*-
"""
ConsistenCy — Multi-Agent Code Consistency Analysis

Package layout
--------------
agents/            : 7 specialist analysis agents + base class
collaboration/     : vote and consensus coordinator
evaluation/        : metric, dataset, and ablation helpers
models/            : typed report contracts (schemas, enums)
parsers/            : Python / JS / TS parsing helpers
remote/            : GitHub API client and remote analysis pipeline
scoring/            : risk composition and explainability
baseline_storage.py : persistent baseline snapshot storage
baseline_strategy.py: intelligent baseline selection engine
exporter.py         : JSON / CSV / SQLite / Parquet result export
llm_ready_snippets.py: code snippet extraction for LLM prompts
llm_reviewer.py     : DeepSeek-powered AI code review
pipeline.py         : AnalysisPipeline orchestrator
pr_report_builder.py: explainable PR risk report construction
review_suggestions.py: Markdown review comment renderer
"""

__version__ = "2.5.0"
__author__ = "ConsistenCy Team"
