# -*- coding: utf-8 -*-
"""
SecurityAnalyzer / EvolutionAnalyzer 回归测试
==========================================
覆盖 SQL 注入规则扩展（f-string / .format / %）与演化熵计算逻辑。
"""
from engine.analyzers.security_analyzer import SecurityAnalyzer
from engine.analyzers.evolution_analyzer import EvolutionAnalyzer


def test_security_detects_sql_fstring():
    analyzer = SecurityAnalyzer()
    src = """
def q(user_id):
    sql = f\"SELECT * FROM users WHERE id = {user_id}\"
    return sql
"""
    result = analyzer.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_detects_sql_dot_format():
    analyzer = SecurityAnalyzer()
    src = """
def q(username):
    sql = "SELECT * FROM users WHERE name = '{}'".format(username)
    return sql
"""
    result = analyzer.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_detects_sql_percent_format():
    analyzer = SecurityAnalyzer()
    src = """
def q(username):
    sql = "SELECT * FROM users WHERE name = '%s'" % username
    return sql
"""
    result = analyzer.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] >= 1
    assert any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_sql_fstring_ignores_interpolated_variable_names():
    """{where} / {select!r} are variable names, not SQL keywords.

    Regression: the raw f-string source used to be matched wholesale, so
    interpolated identifiers such as {where} matched the WHERE keyword and
    {select!r} matched SELECT.
    """
    analyzer = SecurityAnalyzer()
    src = """
def validate(where, select):
    raise ValueError(f"{where} must be a mapping")
    raise ValueError(f"Unsafe ruff option value: {select!r}")
"""
    result = analyzer.run({"source": src}, {"source": ""})
    assert result.details["medium_count"] == 0
    assert not any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_sql_fstring_without_interpolation_is_not_flagged():
    """A constant f-string is not injectable, whatever keywords it holds."""
    analyzer = SecurityAnalyzer()
    result = analyzer.run({"source": 'LABEL = f"SELECT count(*) FROM t"\n'}, {"source": ""})
    assert result.details["medium_count"] == 0
    assert not any("SQL Injection Risk" in ev for ev in result.evidence)


def test_security_sql_fstring_placeholder_list_stays_flagged():
    """Literal SQL plus generated placeholders must remain a review lead."""
    analyzer = SecurityAnalyzer()
    src = '''
def q(paths):
    placeholders = ",".join("?" for _ in paths)
    return cursor.execute(f"SELECT * FROM t WHERE id IN ({placeholders})", paths)
'''
    result = analyzer.run({"source": src}, {"source": ""})
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

    focused_entropy = EvolutionAnalyzer._avg_entropy([focused_commit])
    spread_entropy = EvolutionAnalyzer._avg_entropy([spread_commit])

    assert spread_entropy > focused_entropy


def test_evolution_entropy_score_changes_with_distribution():
    analyzer = EvolutionAnalyzer()
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

    result = analyzer.run(snapshot, baseline)
    assert result.details["entropy_score"] > 0.0
    assert result.details["avg_entropy_now"] < result.details["avg_entropy_base"]


# ─── scan_file public API ──────────────────────────────────────────────────────


def test_scan_file_python_detects_credentials():
    analyzer = SecurityAnalyzer()
    result = analyzer.scan_file('API_KEY = "sk-abc123def456ghi789jkl012mno345pqr678stu901vwx"')
    assert result["score"] > 0
    assert result["critical_count"] >= 1


def test_scan_file_javascript_detects_eval():
    analyzer = SecurityAnalyzer()
    result = analyzer.scan_file(
        'function run(x) { eval(x); }',
        language="javascript",
    )
    assert result["score"] > 0
    assert result["high_count"] >= 1


def test_scan_file_typescript_detects_xss():
    analyzer = SecurityAnalyzer()
    result = analyzer.scan_file(
        'function render(user) { document.getElementById("app").innerHTML = user; }',
        language="typescript",
    )
    assert result["score"] > 0
    descriptions = " ".join(str(f.get("description", "")) for f in result["findings"]).lower()
    categories = " ".join(str(f.get("category", "")) for f in result["findings"]).lower()
    assert "innerhtml" in descriptions or "xss" in categories


def test_scan_file_clean_code_returns_zero():
    analyzer = SecurityAnalyzer()
    result = analyzer.scan_file("def add(x, y):\n    return x + y\n")
    assert result["score"] == 0.0
    assert result["critical_count"] == 0
    assert result["high_count"] == 0
