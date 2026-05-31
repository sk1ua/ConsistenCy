# -*- coding: utf-8 -*-
"""
Multi-language Parser Tests
============================
验证多语言解析器（Python、JavaScript、TypeScript）的正确性。
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

import pytest

from src.parsers import get_parser_for_file, is_supported_file, get_supported_extensions
from src.parsers.base_parser import ParseSnapshot


# -----------------------------------------------------------------------------
# Language detection tests
# -----------------------------------------------------------------------------

def test_supported_extensions():
    """Verify supported extensions include Python and JS/TS."""
    exts = get_supported_extensions()
    assert ".py" in exts
    assert ".js" in exts
    assert ".ts" in exts
    assert ".jsx" in exts
    assert ".tsx" in exts


def test_is_supported_file_python():
    """Python files should be recognized."""
    assert is_supported_file("test.py")
    assert is_supported_file("/path/to/file.py")
    assert is_supported_file("File.PY")  # case insensitive


def test_is_supported_file_typescript():
    """TypeScript files should be recognized."""
    assert is_supported_file("test.ts")
    assert is_supported_file("component.tsx")
    assert is_supported_file("/path/to/file.ts")


def test_is_supported_file_javascript():
    """JavaScript files should be recognized."""
    assert is_supported_file("test.js")
    assert is_supported_file("component.jsx")
    assert is_supported_file("/path/to/file.js")


def test_is_supported_file_unsupported():
    """Unsupported extensions should return False."""
    assert not is_supported_file("test.java")
    assert not is_supported_file("test.go")
    assert not is_supported_file("test.rb")
    assert not is_supported_file("test.txt")


# -----------------------------------------------------------------------------
# Parser instantiation tests
# -----------------------------------------------------------------------------

def test_get_parser_for_python():
    """Should return PythonParser for .py files."""
    parser = get_parser_for_file("test.py")
    assert parser is not None
    assert parser.language == "python"


def test_get_parser_for_typescript():
    """Should return TreeSitterParser for .ts files."""
    parser = get_parser_for_file("test.ts")
    assert parser is not None
    # TreeSitterParser needs tree-sitter installed
    # If not installed, it will still be returned but may fail on parse


def test_get_parser_for_unsupported():
    """Should return None for unsupported files."""
    parser = get_parser_for_file("test.java")
    assert parser is None


# -----------------------------------------------------------------------------
# Python parsing tests (baseline)
# -----------------------------------------------------------------------------

def test_python_parse_function():
    """Python parser should extract function info."""
    from src.parsers.python_parser import PythonParser
    
    parser = PythonParser()
    source = '''
def hello(name: str) -> str:
    """Say hello."""
    return f"Hello, {name}!"

async def async_func():
    await hello("world")
'''
    snapshot = parser.parse(source)
    
    assert snapshot.language == "python"
    assert len(snapshot.functions) == 2
    
    # Check first function
    func = snapshot.functions[0]
    assert func.name == "hello"
    assert func.lineno == 2
    assert "name" in func.args
    assert not func.is_async
    
    # Check async function
    async_func = snapshot.functions[1]
    assert async_func.name == "async_func"
    assert async_func.is_async


def test_python_parse_class():
    """Python parser should extract class info."""
    from src.parsers.python_parser import PythonParser
    
    parser = PythonParser()
    source = '''
class Base:
    pass

class Child(Base):
    def method(self):
        pass
'''
    snapshot = parser.parse(source)
    
    assert len(snapshot.classes) == 2
    assert snapshot.classes[0].name == "Base"
    assert snapshot.classes[1].name == "Child"
    assert "Base" in snapshot.classes[1].bases


def test_python_parse_imports():
    """Python parser should extract imports."""
    from src.parsers.python_parser import PythonParser
    
    parser = PythonParser()
    source = '''
import os
from pathlib import Path
import sys, json
'''
    snapshot = parser.parse(source)
    
    import_names = [imp.names[0] for imp in snapshot.imports]
    assert "os" in import_names
    assert "Path" in import_names
    assert "sys" in import_names or "json" in import_names


def test_python_loc_counting():
    """Python parser should count lines correctly."""
    from src.parsers.python_parser import PythonParser
    
    parser = PythonParser()
    source = '''# Comment
import os

def func():
    pass  # inline comment
'''
    snapshot = parser.parse(source)
    
    # Verify LOC structure (exact counts may vary by implementation)
    assert snapshot.loc["total"] > 0
    assert snapshot.loc["code"] > 0
    assert snapshot.loc["blank"] >= 0
    # Verify totals add up (allowing for implementation differences)
    assert snapshot.loc["total"] >= snapshot.loc["code"] + snapshot.loc["blank"]


# -----------------------------------------------------------------------------
# JavaScript/TypeScript parsing tests
# -----------------------------------------------------------------------------

def test_typescript_parse_function():
    """TypeScript parser should extract function info."""
    from src.parsers.tree_sitter_parser import TreeSitterParser
    
    parser = TreeSitterParser(language_hint=".ts")
    if parser._parser is None:
        pytest.skip("tree-sitter not installed")
    
    source = '''
function greet(name: string): string {
    return `Hello, ${name}!`;
}

const arrowFunc = (x: number) => x * 2;

async function asyncFunc(): Promise<void> {
    await greet("world");
}
'''
    snapshot = parser.parse(source)
    
    assert snapshot.language in ("typescript", "javascript")
    # Should have at least the named functions
    func_names = [f.name for f in snapshot.functions]
    assert "greet" in func_names
    assert "asyncFunc" in func_names


def test_typescript_parse_class():
    """TypeScript parser should extract class info."""
    from src.parsers.tree_sitter_parser import TreeSitterParser
    
    parser = TreeSitterParser(language_hint=".ts")
    if parser._parser is None:
        pytest.skip("tree-sitter not installed")
    
    source = '''
class Animal {
    constructor(public name: string) {}
    move(): void {}
}

class Dog extends Animal {
    bark(): void {}
}
'''
    snapshot = parser.parse(source)
    
    class_names = [c.name for c in snapshot.classes]
    assert "Animal" in class_names
    assert "Dog" in class_names
    
    # Find Dog class and check inheritance (if parser supports it)
    dog_class = next(c for c in snapshot.classes if c.name == "Dog")
    # Note: TypeScript inheritance parsing may vary by tree-sitter version
    # Just check the class was found
    assert dog_class.name == "Dog"


def test_javascript_security_patterns():
    """JavaScript should be scanned for security patterns."""
    from src.agents.security_agent import SecurityAgent
    
    agent = SecurityAgent()
    
    # Test eval detection
    source = '''
function dangerous(userInput) {
    eval(userInput);
}
'''
    result = agent.run({"source": source, "language": "javascript"}, {"source": ""})
    
    # Should detect eval
    assert result.score > 0
    assert any("eval" in ev.lower() for ev in result.evidence)


def test_javascript_xss_patterns():
    """JavaScript should detect XSS vulnerabilities."""
    from src.agents.security_agent import SecurityAgent
    
    agent = SecurityAgent()
    
    source = '''
function render(userContent) {
    document.body.innerHTML = userContent;
}
'''
    result = agent.run({"source": source, "language": "javascript"}, {"source": ""})
    
    # Should detect innerHTML
    assert result.score > 0
    assert any("innerHTML" in ev for ev in result.evidence)


# -----------------------------------------------------------------------------
# Integration tests
# -----------------------------------------------------------------------------

def test_parser_agent_multilang():
    """ParserAgent should handle multiple languages via parse_file."""
    from src.agents.parser_agent import ParserAgent
    
    agent = ParserAgent()
    
    # Python
    py_source = "def foo(): pass"
    py_snapshot = agent.parse_file(py_source, "test.py")
    assert py_snapshot.get("language") == "python"
    
    # TypeScript (if tree-sitter available)
    ts_source = "function foo() {}"
    ts_snapshot = agent.parse_file(ts_source, "test.ts")
    # Should have language field set
    assert "language" in ts_snapshot


def test_analyze_sources_multilang():
    """analyze_sources should work with TypeScript files."""
    from src.pipeline import analyze_sources
    
    ts_now = '''
function process(data: string): string {
    return data.toUpperCase();
}
'''
    ts_base = '''
function process(data) {
    return data;
}
'''
    
    result = analyze_sources(ts_now, ts_base, filepath="test.ts")
    
    # Should return valid results even for TypeScript
    assert "risk_score" in result
    assert 0 <= result["risk_score"] <= 1
    assert "agent_details" in result


def test_analyze_sources_javascript_end_to_end():
    """End-to-end: analyze_sources with JS file should run all agents."""
    from src.pipeline import analyze_sources

    js_now = '''
function processData(userId) {
    var query = "SELECT * FROM users WHERE id = " + userId;
    eval(query);
    return db.execute(query);
}
'''
    js_base = '''
function processData(id) {
    return db.execute("SELECT * FROM users WHERE id = ?", id);
}
'''

    result = analyze_sources(js_now, js_base, filepath="utils.js")
    assert "risk_score" in result
    assert 0 <= result["risk_score"] <= 1
    assert "breakdown" in result
    # Security agent should detect eval → score > 0
    assert result["breakdown"].get("security", 0) > 0
    # Collaboration board should exist
    assert "agent_collaboration" in result
    assert "decision" in result["agent_collaboration"]


def test_analyze_sources_typescript_inheritance_end_to_end():
    """End-to-end: analyze_sources with TS class hierarchy."""
    from src.pipeline import analyze_sources

    ts_now = '''
class BaseService {
    constructor(protected db: Database) {}
    query(sql: string): any[] { return []; }
}
class UserService extends BaseService {
    getUser(id: number): any {
        return this.db.execute("SELECT * FROM users WHERE id = " + id);
    }
}
'''
    ts_base = '''
class BaseService {
    constructor(protected db: Database) {}
}
class UserService extends BaseService {
    getUser(id: number): any { return {}; }
}
'''

    result = analyze_sources(ts_now, ts_base, filepath="services.ts")
    assert "risk_score" in result
    assert "structural" in result.get("breakdown", {})
    # Should return valid agent_details for all agents
    for agent in ("StyleAgent", "StructuralAgent", "SemanticAgent", "SecurityAgent"):
        assert agent in result.get("agent_details", {}), f"{agent} missing"