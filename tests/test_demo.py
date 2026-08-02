# -*- coding: utf-8 -*-
"""Tests for the multi_agent_demo example script."""

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_multi_agent_demo_output():
    demo_script = ROOT / "examples" / "multi_agent_demo.py"
    proc = subprocess.run(
        [sys.executable, str(demo_script)],
        capture_output=True,
        text=True,
        cwd=str(ROOT),
        check=True
    )
    stdout = proc.stdout

    assert "Status: ok" in stdout
    assert "Files Analyzed: 1" in stdout
    assert "Highest Risk: 0.615 (Significant Drift)" in stdout
    assert "Findings Count: 6" in stdout
    assert "Status: None" not in stdout
    assert "Score: None" not in stdout
    assert "Risk Level: None" not in stdout
