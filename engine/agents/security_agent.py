"""Deprecated compatibility import for the deterministic security analyzer."""
from ..analyzers.security_analyzer import SecurityAnalyzer

SecurityAgent = SecurityAnalyzer

__all__ = ["SecurityAnalyzer", "SecurityAgent"]
