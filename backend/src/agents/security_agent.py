# -*- coding: utf-8 -*-
"""
Security Agent
==============
Detects security vulnerabilities and anti-patterns in Python source code.

Detection categories
--------------------
CRITICAL  : Hardcoded credentials (API keys, passwords, tokens, private keys)
HIGH      : Dangerous function calls (eval, exec, pickle.loads, os.system,
            subprocess with shell=True), arbitrary code execution risks
MEDIUM    : SQL injection risk (f-string / .format / % SQL queries),
            yaml.load() without SafeLoader, insecure deserialization
LOW       : Debug mode enabled (DEBUG=True), use of assert for security

Score formula
-------------
security_score = clamp(Σ severity_weight_i)

Severity weights (cumulative, capped at 1.0):
    CRITICAL  → +0.60 per finding  (1 finding ≥ RED threshold alone)
    HIGH      → +0.30 per finding  (2 findings → RED)
    MEDIUM    → +0.12 per finding
    LOW       → +0.05 per finding

Risk override (in RiskScoringAgent):
    Any CRITICAL finding forces final commit risk ≥ 0.75 (RED)
    Any HIGH finding forces final commit risk ≥ 0.50 (ORANGE)
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass
from typing import Any

from .base_agent import AgentBase, AgentResult

# ---------------------------------------------------------------------------
# Severity weight table
# ---------------------------------------------------------------------------

SEVERITY_WEIGHTS: dict[str, float] = {
    "CRITICAL": 0.60,
    "HIGH": 0.30,
    "MEDIUM": 0.12,
    "LOW": 0.05,
}

# ---------------------------------------------------------------------------
# Credential patterns (applied line-by-line, skipping pure comment lines)
# ---------------------------------------------------------------------------

# Each entry: (compiled_pattern, severity, category, description)
_CREDENTIAL_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    # Generic credential assignment: key = "value", password: 'value'
    (
        re.compile(
            r'(?i)(?:api[_\-]?key|api[_\-]?secret|secret[_\-]?key|'
            r'access[_\-]?key|private[_\-]?key|auth[_\-]?token|bearer[_\-]?token|'
            r'password|passwd|pwd)\s*[=:]\s*["\'][A-Za-z0-9+/=._\-!@#$%^&*]{8,}["\']'
        ),
        "Hardcoded Credential",
    ),
    # AWS Access Key ID
    (re.compile(r'AKIA[0-9A-Z]{16}'), "AWS Access Key ID"),
    # GitHub Personal Access Token
    (re.compile(r'ghp_[A-Za-z0-9]{36}'), "GitHub Personal Access Token"),
    # GitHub Fine-grained PAT
    (re.compile(r'github_pat_[A-Za-z0-9_]{82}'), "GitHub Fine-grained PAT"),
    # OpenAI API Key
    (re.compile(r'sk-[A-Za-z0-9]{48,}'), "OpenAI API Key"),
    # Slack tokens
    (re.compile(r'xox[baprs]-[0-9A-Za-z\-]{10,}'), "Slack Token"),
    # Private key header
    (
        re.compile(r'-----BEGIN (?:RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----'),
        "Private Key Embedded in Source",
    ),
    # Hardcoded JWT secret
    (
        re.compile(
            r'(?i)jwt[_\-]?secret\s*[=:]\s*["\'][A-Za-z0-9+/=._\-]{16,}["\']'
        ),
        "Hardcoded JWT Secret",
    ),
]

# ---------------------------------------------------------------------------
# Dangerous direct function calls detected via AST Name nodes
# ---------------------------------------------------------------------------

_DANGEROUS_BUILTINS: dict[str, tuple[str, str]] = {
    # func_name → (severity, description)
    "eval":       ("HIGH", "eval() executes arbitrary code from a string"),
    "exec":       ("HIGH", "exec() executes arbitrary code from a string"),
    "__import__": ("HIGH", "Dynamic __import__() call bypasses normal import controls"),
    "compile":    ("MEDIUM", "compile() with untrusted input enables code injection"),
}

# JavaScript/TypeScript dangerous functions (regex-based detection)
_JS_DANGEROUS_PATTERNS: list[tuple[str, str, str]] = [
    # (pattern, severity, description)
    (r'\beval\s*\(', "HIGH", "eval() executes arbitrary JavaScript code"),
    (r'new\s+Function\s*\(', "HIGH", "Function constructor executes code from string"),
    (r'setTimeout\s*\(\s*["\']', "MEDIUM", "setTimeout with string argument is like eval"),
    (r'setInterval\s*\(\s*["\']', "MEDIUM", "setInterval with string argument is like eval"),
    (r'document\.write\s*\(', "MEDIUM", "document.write can lead to XSS vulnerabilities"),
    (r'\.innerHTML\s*=', "MEDIUM", "innerHTML assignment can lead to XSS vulnerabilities"),
    (r'\.outerHTML\s*=', "MEDIUM", "outerHTML assignment can lead to XSS vulnerabilities"),
]

# ---------------------------------------------------------------------------
# Dangerous module.attr calls detected via AST Attribute nodes
# ---------------------------------------------------------------------------

_DANGEROUS_MODULE_ATTRS: dict[str, dict[str, tuple[str, str]]] = {
    "os": {
        "system": ("HIGH", "os.system() passes a string to the shell — injection risk"),
        "popen":  ("HIGH", "os.popen() passes a string to the shell — injection risk"),
    },
    "pickle": {
        "loads":     ("HIGH", "pickle.loads() can execute arbitrary code on untrusted data"),
        "load":      ("HIGH", "pickle.load() can execute arbitrary code on untrusted data"),
        "Unpickler": ("HIGH", "pickle.Unpickler deserializes untrusted data"),
    },
    "marshal": {
        "loads": ("HIGH", "marshal.loads() deserializes untrusted data"),
    },
}

# subprocess calls that become dangerous when shell=True
_SUBPROCESS_FUNCS = {"run", "Popen", "call", "check_call", "check_output"}


# ---------------------------------------------------------------------------
# Finding dataclass
# ---------------------------------------------------------------------------

@dataclass
class SecurityFinding:
    severity: str       # CRITICAL | HIGH | MEDIUM | LOW
    category: str
    description: str
    line: int = 0


# ---------------------------------------------------------------------------
# Security Agent
# ---------------------------------------------------------------------------

class SecurityAgent(AgentBase):
    """Detect security vulnerabilities in Python source snapshots.

    The agent scores the *current state* of the code, not just the drift.
    A single CRITICAL finding is enough to mark a file as HIGH RISK.

    The score is intentionally additive without normalization so that
    multiple independent vulnerabilities compound appropriately.
    """

    @property
    def name(self) -> str:
        return "SecurityAgent"

    def analyze(self, snapshot: dict[str, Any], baseline: dict[str, Any]) -> AgentResult:
        source = snapshot.get("source", "")
        if not source.strip():
            return AgentResult(
                agent_name=self.name,
                score=0.0,
                details={"findings": [], "finding_count": 0,
                         "critical_count": 0, "high_count": 0,
                         "medium_count": 0, "low_count": 0},
                evidence=["No source to scan."],
            )

        # Detect language from snapshot
        language = snapshot.get("language", "python")
        findings = self._scan(source, language)
        score = self._score(findings)

        criticals = [f for f in findings if f.severity == "CRITICAL"]
        highs     = [f for f in findings if f.severity == "HIGH"]
        mediums   = [f for f in findings if f.severity == "MEDIUM"]
        lows      = [f for f in findings if f.severity == "LOW"]

        evidence: list[str] = []
        for f in criticals[:3]:
            loc = f" (line {f.line})" if f.line else ""
            evidence.append(f"[CRITICAL] {f.category}: {f.description}{loc}")
        for f in highs[:3]:
            loc = f" (line {f.line})" if f.line else ""
            evidence.append(f"[HIGH] {f.category}: {f.description}{loc}")
        for f in mediums[:2]:
            loc = f" (line {f.line})" if f.line else ""
            evidence.append(f"[MEDIUM] {f.category}: {f.description}{loc}")
        for f in lows[:1]:
            loc = f" (line {f.line})" if f.line else ""
            evidence.append(f"[LOW] {f.category}: {f.description}{loc}")
        if not evidence:
            evidence.append("No security issues detected.")

        return AgentResult(
            agent_name=self.name,
            score=score,
            details={
                "findings": [
                    {"severity": f.severity, "category": f.category,
                     "description": f.description, "line": f.line}
                    for f in findings
                ],
                "finding_count": len(findings),
                "critical_count": len(criticals),
                "high_count":     len(highs),
                "medium_count":   len(mediums),
                "low_count":      len(lows),
            },
            evidence=evidence,
        )

    # ------------------------------------------------------------------
    # Scanning helpers
    # ------------------------------------------------------------------

    def _scan(self, source: str, language: str = "python") -> list[SecurityFinding]:
        findings: list[SecurityFinding] = []
        findings.extend(self._scan_credentials(source))
        
        # Language-specific scanning
        if language in ("javascript", "typescript"):
            findings.extend(self._scan_js_patterns(source))
        else:
            findings.extend(self._scan_ast(source))
        
        return self._deduplicate(findings)

    # --- Credential scanning (regex, line-by-line) ---

    @staticmethod
    def _scan_credentials(source: str) -> list[SecurityFinding]:
        findings: list[SecurityFinding] = []
        for lineno, line in enumerate(source.splitlines(), 1):
            stripped = line.strip()
            # Skip comments (Python #, JS //)
            if stripped.startswith("#") or stripped.startswith("//"):
                continue
            for pattern, description in _CREDENTIAL_PATTERNS:
                if pattern.search(line):
                    findings.append(SecurityFinding(
                        severity="CRITICAL",
                        category="Hardcoded Credential",
                        description=description,
                        line=lineno,
                    ))
        return findings

    # --- JavaScript/TypeScript pattern scanning ---

    @staticmethod
    def _scan_js_patterns(source: str) -> list[SecurityFinding]:
        """Scan JavaScript/TypeScript for dangerous patterns."""
        findings: list[SecurityFinding] = []
        for lineno, line in enumerate(source.splitlines(), 1):
            stripped = line.strip()
            # Skip comments
            if stripped.startswith("//") or stripped.startswith("/*") or stripped.startswith("*"):
                continue
            
            for pattern, severity, description in _JS_DANGEROUS_PATTERNS:
                if re.search(pattern, line):
                    findings.append(SecurityFinding(
                        severity=severity,
                        category="Dangerous JS/TS Pattern",
                        description=description,
                        line=lineno,
                    ))
        return findings

    # --- AST-based scanning ---

    @staticmethod
    def _scan_ast(source: str) -> list[SecurityFinding]:  # noqa: C901
        findings: list[SecurityFinding] = []
        try:
            tree = ast.parse(source)
        except SyntaxError:
            return findings

        sql_keywords = ("SELECT", "INSERT", "UPDATE", "DELETE", "DROP", "WHERE", "EXECUTE")

        def _looks_like_sql(text: str) -> bool:
            return any(kw in text.upper() for kw in sql_keywords)

        for node in ast.walk(tree):
            lineno = getattr(node, "lineno", 0)

            # ── Call nodes ─────────────────────────────────────────────
            if isinstance(node, ast.Call):
                func = node.func

                # Direct built-in calls: eval(...), exec(...), etc.
                if isinstance(func, ast.Name) and func.id in _DANGEROUS_BUILTINS:
                    sev, desc = _DANGEROUS_BUILTINS[func.id]
                    findings.append(SecurityFinding(sev, "Dangerous Function Call", desc, lineno))

                # Module.attr calls: os.system(), pickle.loads(), etc.
                elif isinstance(func, ast.Attribute):
                    attr = func.attr
                    if isinstance(func.value, ast.Name):
                        module = func.value.id

                        mod_table = _DANGEROUS_MODULE_ATTRS.get(module, {})
                        if attr in mod_table:
                            sev, desc = mod_table[attr]
                            findings.append(SecurityFinding(sev, "Dangerous Module Call", desc, lineno))

                        # subprocess.*(shell=True)
                        if module == "subprocess" and attr in _SUBPROCESS_FUNCS:
                            for kw in node.keywords:
                                if (kw.arg == "shell"
                                        and isinstance(kw.value, ast.Constant)
                                        and kw.value.value is True):
                                    findings.append(SecurityFinding(
                                        "HIGH", "Shell Injection Risk",
                                        f"subprocess.{attr}(shell=True) is vulnerable to shell injection",
                                        lineno,
                                    ))

                        # yaml.load() without SafeLoader
                        if module == "yaml" and attr == "load":
                            has_safe = any(
                                kw.arg == "Loader"
                                and isinstance(kw.value, ast.Attribute)
                                and kw.value.attr in ("SafeLoader", "CSafeLoader", "BaseLoader")
                                for kw in node.keywords
                            )
                            if not has_safe:
                                findings.append(SecurityFinding(
                                    "MEDIUM", "Insecure Deserialization",
                                    "yaml.load() without SafeLoader allows arbitrary code execution via YAML",
                                    lineno,
                                ))

                # SQL query built via "...".format(...)
                if (
                    isinstance(func, ast.Attribute)
                    and func.attr == "format"
                    and isinstance(func.value, ast.Constant)
                    and isinstance(func.value.value, str)
                    and _looks_like_sql(func.value.value)
                ):
                    findings.append(SecurityFinding(
                        "MEDIUM", "SQL Injection Risk",
                        "String .format() used to construct SQL query — vulnerable to injection",
                        lineno,
                    ))

            # ── F-string SQL injection ──────────────────────────────────
            if isinstance(node, ast.JoinedStr):
                try:
                    src_fragment = ast.unparse(node)
                except AttributeError:
                    src_fragment = ""
                if _looks_like_sql(src_fragment):
                    findings.append(SecurityFinding(
                        "MEDIUM", "SQL Injection Risk",
                        "F-string used to construct SQL query — vulnerable to injection",
                        lineno,
                    ))

            # SQL query built via "%" formatting, e.g. "... %s" % user_input
            if (
                isinstance(node, ast.BinOp)
                and isinstance(node.op, ast.Mod)
                and isinstance(node.left, ast.Constant)
                and isinstance(node.left.value, str)
                and _looks_like_sql(node.left.value)
            ):
                findings.append(SecurityFinding(
                    "MEDIUM", "SQL Injection Risk",
                    "Percent-format string used to construct SQL query — vulnerable to injection",
                    lineno,
                ))

            # ── DEBUG = True assignment ─────────────────────────────────
            if isinstance(node, ast.Assign) and node.value:
                if (isinstance(node.value, ast.Constant)
                        and node.value.value is True):
                    for target in node.targets:
                        if isinstance(target, ast.Name) and target.id.upper() == "DEBUG":
                            findings.append(SecurityFinding(
                                "LOW", "Debug Mode",
                                "DEBUG=True may expose sensitive information in production",
                                lineno,
                            ))

        return findings

    # ------------------------------------------------------------------
    # Utilities
    # ------------------------------------------------------------------

    @staticmethod
    def _deduplicate(findings: list[SecurityFinding]) -> list[SecurityFinding]:
        seen: set[tuple[int, str, str]] = set()
        out: list[SecurityFinding] = []
        for f in findings:
            key = (f.line, f.category, f.description[:40])
            if key not in seen:
                seen.add(key)
                out.append(f)
        return out

    @staticmethod
    def _score(findings: list[SecurityFinding]) -> float:
        """Cumulative severity score, capped at 1.0."""
        if not findings:
            return 0.0
        total = sum(SEVERITY_WEIGHTS.get(f.severity, 0.05) for f in findings)
        return min(total, 1.0)

    # ------------------------------------------------------------------
    # Standalone helper for external use (e.g., CLI, tests)
    # ------------------------------------------------------------------

    def scan_file(self, source: str) -> dict[str, Any]:
        """Public interface: scan source and return structured findings dict."""
        findings = self._scan(source)
        score = self._score(findings)
        return {
            "score": score,
            "findings": [
                {"severity": f.severity, "category": f.category,
                 "description": f.description, "line": f.line}
                for f in findings
            ],
            "critical_count": sum(1 for f in findings if f.severity == "CRITICAL"),
            "high_count":     sum(1 for f in findings if f.severity == "HIGH"),
            "medium_count":   sum(1 for f in findings if f.severity == "MEDIUM"),
            "low_count":      sum(1 for f in findings if f.severity == "LOW"),
        }
