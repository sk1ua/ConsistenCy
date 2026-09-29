# -*- coding: utf-8 -*-
"""
Deterministic analyzer interface.

All deterministic analyzers inherit from AnalyzerBase and return a structured
AnalyzerResult.  This module contains no LLM calls, planning, or tool access.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass(init=False)
class AnalyzerResult:
    """Canonical result returned by every deterministic analyzer.

    ``agent_name`` remains an accepted keyword and read-only property for
    compatibility with legacy embedders and stored result adapters. New code
    should use ``analyzer_name``.
    """

    analyzer_name: str
    score: float
    details: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    elapsed_ms: float = 0.0

    def __init__(
        self,
        analyzer_name: str | None = None,
        score: float = 0.0,
        details: dict[str, Any] | None = None,
        evidence: list[str] | None = None,
        elapsed_ms: float = 0.0,
        *,
        agent_name: str | None = None,
    ) -> None:
        if analyzer_name is None:
            analyzer_name = agent_name
        elif agent_name is not None and analyzer_name != agent_name:
            raise ValueError("analyzer_name and legacy agent_name must match")
        if not analyzer_name:
            raise TypeError("AnalyzerResult requires analyzer_name")
        self.analyzer_name = analyzer_name
        self.score = score
        self.details = dict(details or {})
        self.evidence = list(evidence or [])
        self.elapsed_ms = elapsed_ms

    @property
    def agent_name(self) -> str:
        """Legacy read-only alias for ``analyzer_name``."""
        return self.analyzer_name

    def summary(self) -> str:
        lines = [f"[{self.analyzer_name}] score={self.score:.3f}  ({self.elapsed_ms:.1f}ms)"]
        for ev in self.evidence[:5]:
            lines.append(f"  · {ev}")
        return "\n".join(lines)


class AnalyzerBase(ABC):
    """Abstract base class for deterministic rule and metric analyzers."""

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config: dict[str, Any] = config or {}

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the analyzer's unique identifier string."""

    @abstractmethod
    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AnalyzerResult:
        """Compute a deterministic drift score from two parsed snapshots."""

    def run(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AnalyzerResult:
        """Public entry point that wraps ``analyze`` with timing."""
        t0 = time.perf_counter()
        result = self.analyze(snapshot, baseline)
        result.elapsed_ms = (time.perf_counter() - t0) * 1000
        return result

    @staticmethod
    def clamp(value: float) -> float:
        """Clamp *value* to [0, 1]."""
        return max(0.0, min(1.0, value))

    @staticmethod
    def safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
        """Division that returns *default* when denominator is zero."""
        return numerator / denominator if denominator else default
