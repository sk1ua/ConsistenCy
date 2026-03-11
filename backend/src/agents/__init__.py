# -*- coding: utf-8 -*-
"""
ConsistenCy Multi-Agent Analysis System

Agents:
    ParserAgent       - AST / CFG / dependency extraction + Halstead metrics
    StyleAgent        - Naming, formatting, documentation drift
    StructuralAgent   - Coupling, complexity, architecture drift
    SemanticAgent     - AST edit distance, API usage, control flow
    EvolutionAgent    - Code churn, commit entropy, hotspots, bus factor
    DuplicationAgent  - CPD-style structural clone detection
    SecurityAgent     - Hardcoded credentials, dangerous calls, injection risks
    RiskScoringAgent  - Weighted aggregation + evidence chain
"""
from .parser_agent import ParserAgent
from .style_agent import StyleAgent
from .structural_agent import StructuralAgent
from .semantic_agent import SemanticAgent
from .evolution_agent import EvolutionAgent
from .duplication_agent import DuplicationAgent
from .security_agent import SecurityAgent
from .risk_scoring_agent import RiskScoringAgent

__all__ = [
    "ParserAgent",
    "StyleAgent",
    "StructuralAgent",
    "SemanticAgent",
    "EvolutionAgent",
    "DuplicationAgent",
    "SecurityAgent",
    "RiskScoringAgent",
]
