# -*- coding: utf-8 -*-
"""
Base Agent Interface
All agents inherit from AgentBase and return a structured AgentResult.
"""
from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any


@dataclass
class AgentResult:
    """Canonical result returned by every agent.

    Attributes
    ----------
    agent_name  : Human-readable agent identifier.
    score       : Float in [0, 1] — 0 = no drift, 1 = maximum drift.
    details     : Dict of sub-scores and raw measurements.
    evidence    : List of human-readable strings explaining the score.
    elapsed_ms  : Wall-clock time spent inside analyze().
    """
    agent_name: str
    score: float
    details: dict[str, Any] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)
    elapsed_ms: float = 0.0

    def summary(self) -> str:
        lines = [f"[{self.agent_name}] score={self.score:.3f}  ({self.elapsed_ms:.1f}ms)"]
        for ev in self.evidence[:5]:
            lines.append(f"  · {ev}")
        return "\n".join(lines)


class AgentBase(ABC):
    """Abstract base class for all ConsistenCy agents.

    Parameters
    ----------
    config : Optional dict of agent-specific configuration values.
    """

    def __init__(self, config: dict[str, Any] | None = None) -> None:
        self.config: dict[str, Any] = config or {}

    @property
    @abstractmethod
    def name(self) -> str:
        """Return the agent's unique identifier string."""

    @abstractmethod
    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        """Compute a drift score by comparing *snapshot* against *baseline*.

        Parameters
        ----------
        snapshot : Data extracted from the commit / code-revision under analysis.
        baseline : Aggregate statistics computed from the project's history window.

        Returns
        -------
        AgentResult with score in [0, 1].
        """

    def run(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        """Public entry-point: wraps analyze() with timing."""
        t0 = time.perf_counter()
        result = self.analyze(snapshot, baseline)
        result.elapsed_ms = (time.perf_counter() - t0) * 1000
        return result

    # ------------------------------------------------------------------
    # Shared utility helpers
    # ------------------------------------------------------------------

    @staticmethod
    def clamp(value: float) -> float:
        """Clamp *value* to [0, 1]."""
        return max(0.0, min(1.0, value))

    @staticmethod
    def safe_div(numerator: float, denominator: float, default: float = 0.0) -> float:
        """Division that returns *default* when denominator is zero."""
        return numerator / denominator if denominator else default
