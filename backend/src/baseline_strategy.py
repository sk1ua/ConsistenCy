# -*- coding: utf-8 -*-
"""
Baseline Strategy Engine
========================
Provides intelligent baseline selection based on file history and change patterns.

Scenarios:
- NEW_FILE: No history available, use template baseline
- REGULAR: Standard multi-commit aggregation
- LARGE_REFACTOR: Detected significant code change, use earlier baseline
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


@dataclass
class FileScenario:
    """Description of file history pattern."""
    scenario_type: Literal["NEW_FILE", "REGULAR", "LARGE_REFACTOR"]
    confidence: float  # 0.0 to 1.0
    reason: str
    suggested_window_size: int  # recommended baseline commits to analyze


def detect_file_scenario(
    filepath: str,
    current_source: str,
    historical_versions: list[str],
) -> FileScenario:
    """
    Detect which scenario a file belongs to based on its history.

    Parameters
    ----------
    filepath : str
        The file path (for heuristics like ".py" naming)
    current_source : str
        Current version of file source code
    historical_versions : list[str]
        List of source code from recent commits (oldest first)

    Returns
    -------
    FileScenario
        Scenario type with confidence and suggested handling strategy
    """
    if not historical_versions:
        return FileScenario(
            scenario_type="NEW_FILE",
            confidence=1.0,
            reason="No historical versions found",
            suggested_window_size=5,  # use conservative window
        )

    current_loc = len(current_source.splitlines())
    
    # Check if this is a large refactor by examining code change ratio
    oldest_source = historical_versions[0]
    oldest_loc = len(oldest_source.splitlines())
    
    if oldest_loc == 0:
        return FileScenario(
            scenario_type="NEW_FILE",
            confidence=0.9,
            reason="No valid baseline source in history",
            suggested_window_size=5,
        )
    
    # Detect large refactor: >50% code change or code > 3x growth
    loc_change_ratio = abs(current_loc - oldest_loc) / oldest_loc
    is_large_growth = current_loc > oldest_loc * 3
    is_large_shrink = oldest_loc > current_loc * 2
    
    if loc_change_ratio > 0.5 or is_large_growth or is_large_shrink:
        return FileScenario(
            scenario_type="LARGE_REFACTOR",
            confidence=0.85,
            reason=f"Significant code change detected (LOC: {oldest_loc} → {current_loc})",
            suggested_window_size=15,  # use earlier commits for baseline
        )
    
    # Check if file has been consistently maintained
    recent_versions = historical_versions[-3:] if len(historical_versions) >= 3 else historical_versions
    recent_locs = [len(src.splitlines()) for src in recent_versions]
    recent_variance = max(recent_locs) - min(recent_locs)
    
    if recent_variance < oldest_loc * 0.1:  # stable file
        return FileScenario(
            scenario_type="REGULAR",
            confidence=0.95,
            reason="File has stable history",
            suggested_window_size=30,  # can use larger window
        )
    
    # Default to regular with moderate confidence
    return FileScenario(
        scenario_type="REGULAR",
        confidence=0.7,
        reason="File shows typical maintenance pattern",
        suggested_window_size=20,
    )


def select_baseline_strategy(
    scenario: FileScenario,
    default_window: int = 50,
) -> dict:
    """
    Convert file scenario into concrete baseline selection strategy.

    Parameters
    ----------
    scenario : FileScenario
        The detected file scenario
    default_window : int
        Default baseline window size if no scenario-specific override

    Returns
    -------
    dict
        Strategy dict with keys:
        - max_versions: max number of historical versions to examine
        - window_size: preferred number of commits to look back
        - use_template_fallback: whether to use template baseline if history missing
        - description: human-readable strategy description
    """
    if scenario.scenario_type == "NEW_FILE":
        return {
            "max_versions": 3,
            "window_size": 5,
            "use_template_fallback": True,
            "description": "New file strategy: minimal history, may use template",
        }
    
    if scenario.scenario_type == "LARGE_REFACTOR":
        return {
            "max_versions": 12,  # need more history to find stable point
            "window_size": 15,
            "use_template_fallback": False,
            "description": "Large refactor: reaching further back for pre-refactor baseline",
        }
    
    # REGULAR
    return {
        "max_versions": 8,
        "window_size": default_window,
        "use_template_fallback": False,
        "description": "Regular file: standard multi-commit aggregation",
    }


def get_template_baseline(filepath: str) -> str:
    """
    Get a template baseline for new files based on file type.
    
    This is used as fallback when a file has no history.
    In real usage, this could come from project templates or similar files.
    
    Parameters
    ----------
    filepath : str
        The file path
    
    Returns
    -------
    str
        Template source code (empty by default)
    """
    # TODO: In a real system, this could load from project templates
    # or from similar existing files. For now, return empty string.
    return ""
