# -*- coding: utf-8 -*-
"""Built-in plugin implementations for the allowlisted step kinds.

The ``engine.*`` kinds delegate to the existing deterministic agents in
``engine/agents`` rather than reimplementing their checks, so the workflow
engine inherits their test coverage.
"""
from __future__ import annotations

import json
from typing import Any, Mapping

from ..agents.parser_agent import ParserAgent
from ..agents.registry import AGENT_REGISTRY
from .artifacts import EvidenceItem
from .plugins import (
    AnalysisContext,
    BaseAnalyzerPlugin,
    PluginReport,
    SubprocessPlugin,
    register_plugin,
)

#: Maps an allowlisted analyzer kind onto a deterministic agent id.
_AGENT_BY_KIND = {
    "engine.style": "style",
    "engine.structural": "structural",
    "engine.semantic": "semantic",
    "engine.duplication": "duplication",
    "engine.security": "security",
}

_SEVERITY_FLOOR = (
    (0.75, "high"),
    (0.5, "medium"),
    (0.25, "low"),
)


def _severity_for(score: float) -> str:
    for floor, label in _SEVERITY_FLOOR:
        if score >= floor:
            return label
    return "info"


class EngineAgentPlugin(BaseAnalyzerPlugin):
    """Runs one deterministic agent across every file in the context."""

    def __init__(self, kind: str, agent_id: str, options: Mapping[str, Any] | None = None) -> None:
        super().__init__(options)
        self.kind = kind
        self._agent_id = agent_id

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        manifest = AGENT_REGISTRY[self._agent_id]
        # ParserAgent, not PythonParser: the agents consume the snapshot *dict*
        # that `parse_file` produces, not the ParseSnapshot dataclass.
        parser = ParserAgent()
        evidence: list[EvidenceItem] = []
        scored_files = 0

        for path, content in sorted(context.files.items()):
            if not path.endswith(".py"):
                # The bundled agents parse Python; other languages are handled
                # by the tool.* plugins until tree-sitter snapshots are wired in.
                continue
            agent = manifest.create()
            try:
                snapshot = parser.parse_file(content, filepath=path)
                baseline_source = context.baselines.get(path, "")
                baseline = parser.parse_file(baseline_source, filepath=path) if baseline_source else {}
            except Exception as error:  # noqa: BLE001 - unparsable input is not a defect
                evidence.append(EvidenceItem(
                    file=path,
                    excerpt=f"Could not parse for {manifest.display_name}: {error}",
                    rule=f"{self.kind}.parse_error",
                    severity="info",
                ))
                continue

            result = agent.analyze(snapshot, baseline)
            scored_files += 1
            if result.score <= 0:
                continue
            for line in result.evidence:
                evidence.append(EvidenceItem(
                    file=path,
                    excerpt=line,
                    rule=f"{self.kind}",
                    severity=_severity_for(result.score),
                    metadata={"score": round(result.score, 4), "agent": manifest.display_name},
                ))

        return PluginReport(
            evidence=tuple(evidence),
            summary=f"{manifest.display_name} scored {scored_files} file(s), {len(evidence)} observation(s)",
        )


class DependencyGraphPlugin(BaseAnalyzerPlugin):
    """Finds import cycles among the Python files under review.

    Only edges between modules present in the context are considered — a cycle
    that runs through an unreviewed module cannot be confirmed from this data,
    and reporting it would be a guess.
    """

    kind = "graph.dependency"

    @staticmethod
    def _module_name(path: str) -> str:
        trimmed = path[:-3] if path.endswith(".py") else path
        trimmed = trimmed.replace("\\", "/")
        if trimmed.endswith("/__init__"):
            trimmed = trimmed[: -len("/__init__")]
        return trimmed.strip("/").replace("/", ".")

    def _imports(self, source: str, module: str) -> set[str]:
        import ast as ast_module

        try:
            tree = ast_module.parse(source)
        except SyntaxError:
            return set()

        found: set[str] = set()
        package = module.rsplit(".", 1)[0] if "." in module else ""
        for node in ast_module.walk(tree):
            if isinstance(node, ast_module.Import):
                found.update(alias.name for alias in node.names)
            elif isinstance(node, ast_module.ImportFrom):
                if node.level and package:
                    # Resolve `from .sibling import x` against the current package.
                    base = package.rsplit(".", node.level - 1)[0] if node.level > 1 else package
                    base = f"{base}.{node.module}" if node.module else base
                elif node.module:
                    base = node.module
                else:
                    continue
                found.add(base)
                # `from pkg import beta` binds a name that may itself be a
                # submodule, so record `pkg.beta` as a candidate too. Candidates
                # that are not modules under review are filtered out by the
                # caller, so a plain attribute import adds no spurious edge.
                found.update(f"{base}.{alias.name}" for alias in node.names)
        return found

    def _cycles(self, graph: Mapping[str, set[str]]) -> list[tuple[str, ...]]:
        cycles: list[tuple[str, ...]] = []
        seen_signatures: set[frozenset[str]] = set()
        visiting: list[str] = []
        state: dict[str, int] = {}

        def visit(module: str) -> None:
            state[module] = 1
            visiting.append(module)
            for target in sorted(graph.get(module, ())):
                if state.get(target, 0) == 0:
                    visit(target)
                elif state.get(target) == 1:
                    cycle = tuple(visiting[visiting.index(target):])
                    signature = frozenset(cycle)
                    if signature not in seen_signatures:
                        seen_signatures.add(signature)
                        cycles.append(cycle)
            visiting.pop()
            state[module] = 2

        for module in sorted(graph):
            if state.get(module, 0) == 0:
                visit(module)
        return cycles

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        modules = {
            self._module_name(path): path
            for path in context.files
            if path.endswith(".py")
        }
        graph: dict[str, set[str]] = {}
        for module, path in modules.items():
            imported = self._imports(context.files[path], module)
            graph[module] = {target for target in imported if target in modules}

        evidence = [
            EvidenceItem(
                file=modules[cycle[0]],
                excerpt="Import cycle: " + " -> ".join([*cycle, cycle[0]]),
                rule="graph.dependency.circular_import",
                severity="high",
                metadata={"modules": list(cycle)},
            )
            for cycle in self._cycles(graph)
        ]

        return PluginReport(
            evidence=tuple(evidence),
            summary=f"Inspected {len(modules)} module(s), found {len(evidence)} import cycle(s)",
        )


class SemgrepPlugin(SubprocessPlugin):
    kind = "tool.semgrep"
    executable = "semgrep"
    base_args = ("--json", "--quiet", "--error")

    def extra_args(self) -> tuple[str, ...]:
        config = self.options.get("config", "auto")
        if not isinstance(config, str) or not config.replace("/", "").replace("-", "").replace(".", "").isalnum():
            raise ValueError(f"Unsafe semgrep config value: {config!r}")
        return ("--config", config)

    def parse_output(self, stdout: str, stderr: str, exit_code: int) -> tuple[EvidenceItem, ...]:
        try:
            payload = json.loads(stdout or "{}")
        except json.JSONDecodeError:
            return ()
        items: list[EvidenceItem] = []
        for result in payload.get("results", []):
            path = result.get("path")
            if not isinstance(path, str) or not path:
                continue
            start = (result.get("start") or {}).get("line")
            end = (result.get("end") or {}).get("line", start)
            extra = result.get("extra") or {}
            items.append(EvidenceItem(
                file=path,
                excerpt=str(extra.get("message", ""))[:2_000],
                start_line=start if isinstance(start, int) else None,
                end_line=end if isinstance(end, int) else (start if isinstance(start, int) else None),
                rule=result.get("check_id"),
                severity=str(extra.get("severity", "")).lower() or None,
            ))
        return tuple(items)


class RuffPlugin(SubprocessPlugin):
    kind = "tool.ruff"
    executable = "ruff"
    base_args = ("check", "--output-format", "json", "--no-cache")

    def extra_args(self) -> tuple[str, ...]:
        select = self.options.get("select")
        if select is None:
            return (".",)
        if not isinstance(select, str) or not all(part.strip().isalnum() for part in select.split(",")):
            raise ValueError(f"Unsafe ruff select value: {select!r}")
        return ("--select", select, ".")

    def parse_output(self, stdout: str, stderr: str, exit_code: int) -> tuple[EvidenceItem, ...]:
        try:
            payload = json.loads(stdout or "[]")
        except json.JSONDecodeError:
            return ()
        items: list[EvidenceItem] = []
        for row in payload:
            path = row.get("filename")
            if not isinstance(path, str) or not path:
                continue
            start = (row.get("location") or {}).get("row")
            end = (row.get("end_location") or {}).get("row", start)
            items.append(EvidenceItem(
                file=path,
                excerpt=str(row.get("message", ""))[:2_000],
                start_line=start if isinstance(start, int) else None,
                end_line=end if isinstance(end, int) else (start if isinstance(start, int) else None),
                rule=row.get("code"),
                severity="low",
            ))
        return tuple(items)


class EslintPlugin(SubprocessPlugin):
    kind = "tool.eslint"
    executable = "eslint"
    base_args = ("--format", "json")

    def extra_args(self) -> tuple[str, ...]:
        return (".",)

    def parse_output(self, stdout: str, stderr: str, exit_code: int) -> tuple[EvidenceItem, ...]:
        try:
            payload = json.loads(stdout or "[]")
        except json.JSONDecodeError:
            return ()
        items: list[EvidenceItem] = []
        for file_result in payload:
            path = file_result.get("filePath")
            if not isinstance(path, str) or not path:
                continue
            for message in file_result.get("messages", []):
                line = message.get("line")
                items.append(EvidenceItem(
                    file=path,
                    excerpt=str(message.get("message", ""))[:2_000],
                    start_line=line if isinstance(line, int) else None,
                    end_line=message.get("endLine", line) if isinstance(line, int) else None,
                    rule=message.get("ruleId"),
                    severity="medium" if message.get("severity") == 2 else "low",
                ))
        return tuple(items)


class PytestVerifier(SubprocessPlugin):
    kind = "verify.unit_tests"
    executable = "python"
    base_args = ("-m", "pytest", "-q")

    def acceptable_exit_codes(self) -> frozenset[int]:
        # Only a clean pass counts as verified; a failing suite is a real signal.
        return frozenset({0})


class SyntaxVerifier(BaseAnalyzerPlugin):
    """Compiles every Python file so a workflow can prove the tree still parses."""

    kind = "verify.syntax"

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        failures: list[EvidenceItem] = []
        checked = 0
        for path, content in sorted(context.files.items()):
            if not path.endswith(".py"):
                continue
            checked += 1
            try:
                compile(content, path, "exec")
            except SyntaxError as error:
                failures.append(EvidenceItem(
                    file=path,
                    excerpt=f"{error.msg}",
                    start_line=error.lineno,
                    end_line=error.lineno,
                    rule="verify.syntax",
                    severity="high",
                ))
        return PluginReport(
            evidence=tuple(failures),
            summary=f"Compiled {checked} Python file(s), {len(failures)} syntax error(s)",
        )


def register_builtin_plugins() -> None:
    """Register every shipped plugin. Safe to call more than once."""
    for kind, agent_id in _AGENT_BY_KIND.items():
        register_plugin(
            kind,
            lambda options, _kind=kind, _agent=agent_id: EngineAgentPlugin(_kind, _agent, options),
        )
    register_plugin("graph.dependency", lambda options: DependencyGraphPlugin(options))
    register_plugin("tool.semgrep", lambda options: SemgrepPlugin(options))
    register_plugin("tool.ruff", lambda options: RuffPlugin(options))
    register_plugin("tool.eslint", lambda options: EslintPlugin(options))
    register_plugin("verify.unit_tests", lambda options: PytestVerifier(options))
    register_plugin("verify.syntax", lambda options: SyntaxVerifier(options))
