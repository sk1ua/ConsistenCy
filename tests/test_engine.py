# -*- coding: utf-8 -*-
"""Tests for the ConsistenCy V2 engine package."""

import json
from engine.protocol import AnalyzeRequest, FileInput, AnalyzeResponse
from engine.runner import run_analysis


def test_engine_run_analysis_basic():
    request = AnalyzeRequest(
        action="analyze",
        files=[
            FileInput(
                path="test_sample.py",
                content="def foo():\n    print('hello world')\n",
                baseline="def foo():\n    pass\n",
                language="python"
            )
        ],
        options={"agents": ["style", "security"], "include_evidence_pack": False}
    )

    response = run_analysis(request)
    assert response.ok is True
    assert len(response.files) == 1
    res = response.files[0]
    assert res.path == "test_sample.py"
    assert isinstance(res.risk_score, float)
    assert res.risk_label in ["Consistent", "Minor Drift", "Significant Drift", "High Risk"]
    assert "style" in res.signals
    assert "security" in res.signals


def test_engine_protocol_serialization():
    req_dict = {
        "id": "req-legacy",
        "action": "analyze",
        "files": [
            {
                "path": "app.py",
                "content": "import os",
                "baseline": "",
                "language": "python",
                "diff_hunks": []
            }
        ],
        "options": {"token_budget": 1500}
    }
    request = AnalyzeRequest.from_dict(req_dict)
    assert request.action == "analyze"
    assert len(request.files) == 1
    assert request.files[0].path == "app.py"

    response = run_analysis(request)
    res_dict = response.to_dict()
    assert res_dict["ok"] is True
    assert "files" in res_dict
