# -*- coding: utf-8 -*-
"""
SecurityAgent / EvolutionAgent 回归测试
====================================
覆盖 SQL 注入规则扩展（f-string / .format / %）与演化熵计算逻辑。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.agents.security_agent import SecurityAgent
from src.agents.evolution_agent import EvolutionAgent


def test_security_detects_sql_fstring():
    agent = SecurityAgent()
    src = """
def q(user_id):
    sql = f\"SELECT * FROM users WHERE id = {user_id}\"
    return sql
"""
    result = agent.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_detects_sql_dot_format():
    agent = SecurityAgent()
    src = """
def q(username):
    sql = "SELECT * FROM users WHERE name = '{}'".format(username)
    return sql
"""
    result = agent.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_detects_sql_percent_format():
    agent = SecurityAgent()
    src = """
def q(username):
    sql = "SELECT * FROM users WHERE name = '%s'" % username
    return sql
"""
    result = agent.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_evolution_entropy_uses_file_churn_distribution():
    focused_commit = {
        "author": "alice",
        "files": ["a.py", "b.py"],
        "additions": 100,
        "deletions": 0,
        "file_churn_map": {"a.py": 100, "b.py": 0},
    }
    spread_commit = {
        "author": "alice",
        "files": ["a.py", "b.py"],
        "additions": 100,
        "deletions": 0,
        "file_churn_map": {"a.py": 50, "b.py": 50},
    }

    focused_entropy = EvolutionAgent._avg_entropy([focused_commit])
    spread_entropy = EvolutionAgent._avg_entropy([spread_commit])

    assert spread_entropy > focused_entropy


def test_evolution_entropy_score_changes_with_distribution():
    agent = EvolutionAgent()
    snapshot = {
        "commits": [{
            "author": "alice",
            "files": ["a.py", "b.py"],
            "additions": 100,
            "deletions": 0,
            "file_churn_map": {"a.py": 100, "b.py": 0},
        }]
    }
    baseline = {
        "commits": [{
            "author": "alice",
            "files": ["a.py", "b.py"],
            "additions": 100,
            "deletions": 0,
            "file_churn_map": {"a.py": 50, "b.py": 50},
        }]
    }

    result = agent.run(snapshot, baseline)
    assert result.details["entropy_score"] > 0.0
    assert result.details["avg_entropy_now"] < result.details["avg_entropy_base"]
