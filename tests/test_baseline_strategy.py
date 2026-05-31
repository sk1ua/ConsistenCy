# -*- coding: utf-8 -*-
"""Tests for backend/src/baseline_strategy.py.

Covers file scenario detection, baseline strategy selection, and template
baseline generation for new files.
"""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.baseline_strategy import (  # noqa: E402
    FileScenario,
    detect_file_scenario,
    get_template_baseline,
    select_baseline_strategy,
)


# ---------------------------------------------------------------------------
# detect_file_scenario
# ---------------------------------------------------------------------------

class TestDetectFileScenario:
    def test_new_file_when_no_history(self):
        scenario = detect_file_scenario("src/new_module.py", "def f(): pass", [])
        assert scenario.scenario_type == "NEW_FILE"
        assert scenario.confidence == 1.0
        assert scenario.suggested_window_size == 5

    def test_new_file_when_oldest_source_is_empty(self):
        scenario = detect_file_scenario(
            "src/module.py",
            "def f(): pass",
            [""],  # oldest version is empty
        )
        assert scenario.scenario_type == "NEW_FILE"

    def test_large_refactor_when_loc_grows_3x(self):
        base = "def f():\n    pass\n"
        current = "\n".join(["def f():"] + ["    x = 1"] * 100)  # >3x growth
        scenario = detect_file_scenario("src/module.py", current, [base])
        assert scenario.scenario_type == "LARGE_REFACTOR"

    def test_large_refactor_when_loc_change_ratio_above_50pct(self):
        base = "def a():\n    pass\ndef b():\n    pass\n"
        current = "def a():\n    return 1\ndef b():\n    return 2\ndef c():\n    return 3\ndef d():\n    return 4\n"
        scenario = detect_file_scenario("src/module.py", current, [base])
        # 4 -> 8 lines = +100% change > 50%
        assert scenario.scenario_type == "LARGE_REFACTOR"

    def test_regular_when_stable_history(self):
        source = "def f():\n    return 42\n"
        # Multiple identical historical versions = stable
        historical = [source, source, source]
        scenario = detect_file_scenario("src/module.py", source, historical)
        assert scenario.scenario_type == "REGULAR"
        assert scenario.confidence >= 0.7

    def test_regular_default_for_typical_maintenance(self):
        base = "def f():\n    return 1\n"
        current = "def f():\n    return 2\n"
        scenario = detect_file_scenario("src/module.py", current, [base])
        # Small change, not refactor territory
        assert scenario.scenario_type == "REGULAR"


# ---------------------------------------------------------------------------
# select_baseline_strategy
# ---------------------------------------------------------------------------

class TestSelectBaselineStrategy:
    def test_new_file_strategy_uses_template_fallback(self):
        scenario = FileScenario("NEW_FILE", 1.0, "test", 5)
        strategy = select_baseline_strategy(scenario)
        assert strategy["use_template_fallback"] is True
        assert strategy["window_size"] == 5
        assert strategy["max_versions"] == 3

    def test_large_refactor_strategy_increases_window(self):
        scenario = FileScenario("LARGE_REFACTOR", 0.85, "test", 15)
        strategy = select_baseline_strategy(scenario)
        assert strategy["use_template_fallback"] is False
        assert strategy["window_size"] == 15
        assert strategy["max_versions"] == 12

    def test_regular_strategy_respects_default_window(self):
        scenario = FileScenario("REGULAR", 0.95, "test", 30)
        strategy = select_baseline_strategy(scenario, default_window=50)
        assert strategy["use_template_fallback"] is False
        assert strategy["window_size"] == 50
        assert strategy["max_versions"] == 8


# ---------------------------------------------------------------------------
# get_template_baseline
# ---------------------------------------------------------------------------

class TestGetTemplateBaseline:
    def test_test_file_template(self):
        for name in ("test_module.py", "module_test.py", "tests_api.py"):
            tmpl = get_template_baseline(name)
            assert "pytest" in tmpl or "import pytest" in tmpl, f"failed for {name}"

    def test_cli_entrypoint_template(self):
        for name in ("cli.py", "main.py", "__main__.py", "manage.py"):
            tmpl = get_template_baseline(name)
            assert "click" in tmpl or "__main__" in tmpl, f"failed for {name}"

    def test_flask_template(self):
        for name in ("app.py", "wsgi.py", "views.py", "routes.py"):
            tmpl = get_template_baseline(name)
            assert "Flask" in tmpl or "flask" in tmpl, f"failed for {name}"

    def test_config_template(self):
        for name in ("config.py", "settings.py", "conf.py"):
            tmpl = get_template_baseline(name)
            assert "Path" in tmpl or "DEBUG" in tmpl, f"failed for {name}"

    def test_init_template(self):
        tmpl = get_template_baseline("src/package/__init__.py")
        assert "Package" in tmpl or "init" in tmpl.lower()

    def test_default_module_template(self):
        tmpl = get_template_baseline("src/utils/helpers.py")
        assert "annotations" in tmpl or "def main" in tmpl

    def test_path_with_directory_prefix_works(self):
        """get_template_baseline extracts just the filename portion."""
        tmpl = get_template_baseline("deeply/nested/path/cli.py")
        assert "click" in tmpl or "__main__" in tmpl

    def test_all_templates_return_non_empty_string(self):
        names = [
            "test_x.py", "cli.py", "app.py", "config.py",
            "__init__.py", "misc.py",
        ]
        for name in names:
            tmpl = get_template_baseline(name)
            assert isinstance(tmpl, str), f"failed for {name}"
            assert len(tmpl.strip()) > 0, f"empty template for {name}"
