"""Deprecated compatibility import for the deterministic parser analyzer."""
from ..analyzers.parser_analyzer import (
    ParserAnalyzer,
    compute_halstead,
    count_loc,
)

ParserAgent = ParserAnalyzer

__all__ = ["ParserAnalyzer", "ParserAgent", "compute_halstead", "count_loc"]
