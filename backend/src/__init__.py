# -*- coding: utf-8 -*-
"""
ConsistenCy — Multi-Agent Code Consistency Analysis

Package layout
--------------
agents/            : 7 specialised analysis agents + base class
pipeline.py        : AnalysisPipeline orchestrator (requires gitpython)
parser.py          : Legacy AST parser (kept for compatibility)
extractor.py       : Knowledge extractor
storage.py         : Vector store wrapper
checker.py         : Consistency checker
commit_pipeline.py : Commit-level pipeline utilities
ml_naming_model.py : ML naming style model
utils.py           : Shared utilities
"""

__version__ = "2.3.0"
__author__ = "ConsistenCy Team"
