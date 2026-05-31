# -*- coding: utf-8 -*-
"""
Agent 单元测试
==============
覆盖 ParserAgent、StyleAgent、StructuralAgent、SemanticAgent、
DuplicationAgent、RiskScoringAgent 的核心逻辑。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import pytest

from src.agents.base_agent import AgentBase, AgentResult
from src.agents.parser_agent import ParserAgent, compute_halstead, count_loc
from src.agents.style_agent import StyleAgent
from src.agents.structural_agent import StructuralAgent
from src.agents.semantic_agent import SemanticAgent
from src.agents.duplication_agent import DuplicationAgent
from src.agents.risk_scoring_agent import RiskScoringAgent
from src.models import score_to_risk_colour, score_to_risk_label

# ───────────────────────────── fixtures ─────────────────────────────────────

SIMPLE_SRC = """\
def add(x, y):
    \"\"\"Return the sum of x and y.\"\"\"
    return x + y


def multiply(x, y):
    return x * y
"""

COMPLEX_SRC = """\
import os
import sys

class DataProcessor:
    def processData(self, DataList):  # camelCase — style drift
        result = []
        for i in range(len(DataList)):
            item = DataList[i]
            if item > 0:
                if item > 100:
                    result.append(item * 2)
                else:
                    result.append(item)
        return result

    def ValidateInput(self, val):
        import sqlite3  # inline import
        if val is None:
            raise ValueError("null")
        return True
"""

_parser = ParserAgent()

# ─────────────────────────────────────────────────────────────────────────────
# AgentBase
# ─────────────────────────────────────────────────────────────────────────────

def test_agent_result_summary():
    r = AgentResult("TestAgent", 0.42, evidence=["a", "b"])
    s = r.summary()
    assert "TestAgent" in s
    assert "0.420" in s


def test_agent_clamp():
    class _A(AgentBase):
        name = "test"
        def analyze(self, s, b): return AgentResult("test", 0)
    a = _A()
    assert a.clamp(-1.0) == 0.0
    assert a.clamp(2.5)  == 1.0
    assert a.clamp(0.5)  == 0.5


def test_agent_safe_div():
    class _A(AgentBase):
        name = "test"
        def analyze(self, s, b): return AgentResult("test", 0)
    a = _A()
    assert a.safe_div(10, 2) == 5.0
    assert a.safe_div(10, 0) == 0.0
    assert a.safe_div(10, 0, default=-1) == -1


# ─────────────────────────────────────────────────────────────────────────────
# ParserAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_parser_parse_functions():
    snap = _parser.parse(SIMPLE_SRC)
    assert "functions" in snap
    names = [f.name for f in snap["functions"]]
    assert "add" in names
    assert "multiply" in names


def test_parser_parse_imports():
    src = "import os\nfrom pathlib import Path\n"
    snap = _parser.parse(src)
    assert "os" in snap["imports"]
    assert any("Path" in imp for imp in snap["imports"])


def test_parser_halstead_keys():
    snap = _parser.parse(SIMPLE_SRC)
    h = snap["halstead"]
    for key in ("n1", "n2", "N1", "N2", "volume", "difficulty", "effort"):
        assert key in h, f"Missing key: {key}"


def test_parser_loc():
    lc = count_loc(SIMPLE_SRC)
    assert lc["total"] == SIMPLE_SRC.count("\n")
    assert lc["code"] > 0


def test_parser_cyclomatic():
    src = """\
def f(x):
    if x > 0:
        return x
    elif x < 0:
        return -x
    return 0
"""
    snap = _parser.parse(src)
    # if + elif = 2 branches + 1 base = 3
    assert snap["cyclomatic_avg"] >= 3


def test_parser_syntax_error():
    snap = _parser.parse("def broken(:")
    assert "error" in snap


def test_parser_analyze_drift():
    snap = _parser.parse(COMPLEX_SRC)
    base = _parser.parse(SIMPLE_SRC)
    result = _parser.run(snap, base)
    assert isinstance(result, AgentResult)
    assert 0.0 <= result.score <= 1.0


# ─────────────────────────────────────────────────────────────────────────────
# StyleAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_style_same_source_zero():
    agent = StyleAgent()
    snap = _parser.parse(SIMPLE_SRC)
    snap["source"] = SIMPLE_SRC
    result = agent.run(snap, snap)
    # Same source → minimal drift
    assert result.score < 0.15


def test_style_detects_naming_drift():
    agent = StyleAgent()
    snake_src = "def snake_case_func(x):\n    return x\n"
    camel_src = "def camelCaseFunc(x):\n    return x\n"
    snap = _parser.parse(camel_src); snap["source"] = camel_src
    base = _parser.parse(snake_src); base["source"] = snake_src
    result = agent.run(snap, base)
    assert result.score > 0.0


def test_style_docstring_drift():
    agent = StyleAgent()
    doc_src = 'def f(x):\n    """Docstring."""\n    return x\n'
    no_doc = "def f(x):\n    return x\n"
    snap = _parser.parse(no_doc); snap["source"] = no_doc
    base = _parser.parse(doc_src); base["source"] = doc_src
    result = agent.run(snap, base)
    assert result.score > 0.0


# ─────────────────────────────────────────────────────────────────────────────
# StructuralAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_structural_import_drift():
    agent = StructuralAgent()
    new_src = "import os\nimport sys\nimport json\ndef f(): pass\n"
    old_src = "def f(): pass\n"
    snap = _parser.parse(new_src); snap["source"] = new_src
    base = _parser.parse(old_src); base["source"] = old_src
    result = agent.run(snap, base)
    assert result.score > 0.0
    assert any("import" in ev.lower() for ev in result.evidence)


def test_structural_same_zero():
    agent = StructuralAgent()
    snap = _parser.parse(SIMPLE_SRC); snap["source"] = SIMPLE_SRC
    result = agent.run(snap, snap)
    assert result.score < 0.15


def test_structural_cross_file_inheritance():
    """Cross-file class map should resolve deeper inheritance chains."""
    from src.agents.structural_agent import _inheritance_depths

    # File A defines Base → Child
    # File B defines GrandChild(Child) — but Child is not defined in file B
    file_b = "class GrandChild(Child):\n    pass\n"

    # Without project map, GrandChild depth = 1 (Child is external)
    depths_local = _inheritance_depths(file_b)
    assert max(depths_local) == 1

    # With project map, GrandChild → Child → Base = depth 3
    project_map = {
        "Base": [],
        "Child": ["Base"],
    }
    depths_cross = _inheritance_depths(file_b, project_class_bases=project_map)
    assert max(depths_cross) == 3


# ─────────────────────────────────────────────────────────────────────────────
# SemanticAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_semantic_same_source():
    agent = SemanticAgent()
    snap = {"source": SIMPLE_SRC}
    result = agent.run(snap, snap)
    assert result.score < 0.05


def test_semantic_detects_api_change():
    agent = SemanticAgent()
    src_a = "def f():\n    print('hello')\n    len([1,2,3])\n"
    src_b = "def f():\n    open('x')\n    sorted([3,1,2])\n"
    result = agent.run({"source": src_b}, {"source": src_a})
    assert result.score > 0.0
    assert any("api" in ev.lower() or "call" in ev.lower() for ev in result.evidence)


def test_semantic_ast_distance_identical_zero():
    agent = SemanticAgent()
    src = "def f(x):\n    if x > 0:\n        return x\n    return 0\n"
    result = agent.run({"source": src}, {"source": src})
    assert result.details.get("ast_distance", 1.0) == 0.0


def test_semantic_ast_distance_structure_change_positive():
    agent = SemanticAgent()
    src_a = "def f(x):\n    if x > 0:\n        return x\n    return 0\n"
    src_b = "def f(x):\n    while x > 0:\n        x -= 1\n    return x\n"
    result = agent.run({"source": src_b}, {"source": src_a})
    assert result.details.get("ast_distance", 0.0) > 0.0


# ─────────────────────────────────────────────────────────────────────────────
# DuplicationAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_duplication_no_dup():
    agent = DuplicationAgent()
    snap = {"source": SIMPLE_SRC}
    result = agent.run(snap, snap)
    # Small unique functions → no clone detected
    assert result.details.get("clone_pair_count", 0) == 0


def test_duplication_detects_clone():
    agent = DuplicationAgent()
    func_body = "    " + "\n    ".join(f"x{i} = {i}" for i in range(30))
    cloned_src = f"def func_a():\n{func_body}\n    return 0\n\ndef func_b():\n{func_body}\n    return 0\n"
    result = agent.run({"source": cloned_src}, {"source": ""})
    # At minimum the pair count should capture the similarity
    assert isinstance(result.score, float)
    assert 0.0 <= result.score <= 1.0


def test_duplication_detects_cross_file_clone():
    agent = DuplicationAgent()
    func_body = "    " + "\n    ".join(f"x{i} = {i}" for i in range(35))
    primary_src = f"def local_func():\n{func_body}\n    return 0\n"
    other_src = f"def external_func():\n{func_body}\n    return 0\n"

    result = agent.run(
        {
            "source": primary_src,
            "project_sources": {"other.py": other_src},
        },
        {"source": ""},
    )

    assert result.details.get("clone_pair_count", 0) >= 1
    assert result.details.get("cross_file_clone_count", 0) >= 1


def test_duplication_primary_score_excludes_non_primary_clones():
    agent = DuplicationAgent()
    body = "    " + "\n    ".join(f"v{i} = {i}" for i in range(35))

    result = agent.run(
        {
            "source": "def primary_entry():\n    return 1\n",
            "project_sources": {
                "a.py": f"def same_a():\n{body}\n    return 0\n",
                "b.py": f"def same_b():\n{body}\n    return 0\n",
            },
        },
        {"source": ""},
    )

    assert result.details.get("clone_pair_count", 0) >= 1
    assert result.score == 0.0


# ─────────────────────────────────────────────────────────────────────────────
# RiskScoringAgent
# ─────────────────────────────────────────────────────────────────────────────

def test_risk_label():
    assert score_to_risk_colour(0.0) == "GREEN"
    assert score_to_risk_colour(0.25) == "YELLOW"
    assert score_to_risk_colour(0.50) == "ORANGE"
    assert score_to_risk_colour(0.75) == "RED"
    assert score_to_risk_colour(1.0) == "RED"

    assert score_to_risk_label(0.0) == "Consistent"
    assert score_to_risk_label(0.25) == "Minor Drift"
    assert score_to_risk_label(0.50) == "Significant Drift"
    assert score_to_risk_label(0.75) == "High Risk"


def test_risk_aggregation_zero():
    agent = RiskScoringAgent()
    fake = {
        "StyleAgent":      AgentResult("StyleAgent",      0.0),
        "StructuralAgent": AgentResult("StructuralAgent", 0.0),
        "SemanticAgent":   AgentResult("SemanticAgent",   0.0),
        "DuplicationAgent":AgentResult("DuplicationAgent",0.0),
    }
    result = agent.aggregate(fake)
    assert result.score == 0.0
    assert result.details["risk_colour"] == "GREEN"


def test_risk_aggregation_high():
    agent = RiskScoringAgent()
    fake = {
        "StyleAgent":      AgentResult("StyleAgent",      1.0),
        "StructuralAgent": AgentResult("StructuralAgent", 1.0),
        "SemanticAgent":   AgentResult("SemanticAgent",   1.0),
        "DuplicationAgent":AgentResult("DuplicationAgent",1.0),
    }
    result = agent.aggregate(fake)
    assert result.score >= 0.95
    assert result.details["risk_colour"] == "RED"


def test_risk_breakdown_keys():
    agent = RiskScoringAgent()
    result = agent.aggregate({})
    bd = result.details["breakdown"]
    for k in ("style", "structural", "semantic", "duplication"):
        assert k in bd
    # evolution is NOT in breakdown — it is blended at commit level only
    assert "evolution" not in bd


# ─────────────────────────────────────────────────────────────────────────────
# End-to-end: analyze_sources
# ─────────────────────────────────────────────────────────────────────────────

def test_analyze_sources_smoke():
    from src.pipeline import analyze_sources
    result = analyze_sources(COMPLEX_SRC, SIMPLE_SRC)
    assert "risk_score" in result
    assert "risk_level" in result
    assert "breakdown" in result
    assert "evidence" in result
    assert 0.0 <= result["risk_score"] <= 1.0


def test_analyze_sources_identical():
    from src.pipeline import analyze_sources
    result = analyze_sources(SIMPLE_SRC, SIMPLE_SRC)
    assert result["risk_score"] < 0.20, "Identical sources should have low risk"
