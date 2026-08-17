# -*- coding: utf-8 -*-
"""Process-local safety checks used by the evidence-first review workflows.

The checks in this module inspect the immutable file snapshot only.  They do
not import repository code, resolve dependencies, access the network, or
start a subprocess.  Each observation is anchored to a path and, where the
source format permits it, a line number.
"""
from __future__ import annotations

import json
import re
from pathlib import PurePosixPath
from typing import Any, Iterable, Mapping

from ..agents.security_agent import SecurityAgent
from .artifacts import EvidenceItem
from .plugins import AnalysisContext, BaseAnalyzerPlugin, PluginReport


_LANGUAGE_BY_SUFFIX = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
}

_SEVERITY = {
    "CRITICAL": "critical",
    "HIGH": "high",
    "MEDIUM": "medium",
    "LOW": "low",
}

_ACTION_USE = re.compile(r"^\s*-?\s*uses\s*:\s*([^\s#]+)", re.IGNORECASE)
_RUN_EXPRESSION = re.compile(
    r"\$\{\{\s*github\.event\.(?:pull_request\.(?:title|body|head\.ref)|"
    r"issue\.(?:title|body)|comment\.body|head_commit\.message)",
    re.IGNORECASE,
)
_SHELL_PIPE = re.compile(
    r"(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash|zsh|powershell|pwsh)\b|"
    r"(?:powershell|pwsh)\b[^\n]*(?:iex|invoke-expression)",
    re.IGNORECASE,
)
_CHILD_PROCESS_IMPORT = re.compile(
    r"(?:from\s+['\"](?:node:)?child_process['\"]|"
    r"require\(\s*['\"](?:node:)?child_process['\"]\s*\))"
)
_CHILD_PROCESS_EXEC = re.compile(r"\b(?:exec|execSync)\s*\(")
_SPAWN_SHELL = re.compile(
    r"\bspawn(?:Sync)?\s*\([^\n]*(?:shell\s*:\s*true|shell\s*,)",
    re.IGNORECASE,
)
_DANGEROUS_WORKFLOW_PERMISSIONS = re.compile(
    r"^\s*(actions|checks|contents|deployments|id-token|packages|pages|"
    r"pull-requests|repository-projects|security-events|statuses)\s*:\s*write\s*$",
    re.IGNORECASE,
)
_WORLD_WRITABLE_MODE = re.compile(
    r"(?:\bchmod(?:Sync)?\s*\([^\n,]+,\s*0o?(?:666|777)\b|"
    r"\bmode\s*[:=]\s*0o?(?:666|777)\b)",
    re.IGNORECASE,
)
_WEAK_ELECTRON_SECURITY = (
    (re.compile(r"\bnodeIntegration\s*:\s*true\b"), "nodeIntegration is enabled in a renderer"),
    (re.compile(r"\bcontextIsolation\s*:\s*false\b"), "Renderer context isolation is disabled"),
    (re.compile(r"\bwebSecurity\s*:\s*false\b"), "Renderer web security is disabled"),
)

_PACKAGE_DEPENDENCY_KEYS = (
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
)
_PACKAGE_LOCKS = frozenset({"package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"})


def _line_item(
    *,
    file: str,
    line: int,
    excerpt: str,
    rule: str,
    severity: str,
    metadata: Mapping[str, Any] | None = None,
) -> EvidenceItem:
    return EvidenceItem(
        file=file,
        excerpt=excerpt,
        start_line=line,
        end_line=line,
        rule=rule,
        severity=severity,
        metadata=dict(metadata or {}),
    )


def _first_matching_line(source: str, predicate: Any) -> int:
    for line_number, line in enumerate(source.splitlines(), 1):
        if predicate(line):
            return line_number
    return 1


class StaticSafetyPlugin(BaseAnalyzerPlugin):
    """Deterministic secrets, injection, dependency, CI and permission checks."""

    kind = "engine.security"

    async def analyze(self, context: AnalysisContext) -> PluginReport:
        evidence: list[EvidenceItem] = []
        agent = SecurityAgent()

        for file, source in sorted(context.files.items()):
            suffix = PurePosixPath(file.replace("\\", "/")).suffix.lower()
            language = _LANGUAGE_BY_SUFFIX.get(suffix, "text")
            result = agent.scan_file(source, language=language)
            for finding in result["findings"]:
                line = finding.get("line")
                line_number = line if isinstance(line, int) and line > 0 else 1
                evidence.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt=str(finding["description"]),
                    rule="engine.security.source_pattern",
                    severity=_SEVERITY.get(str(finding["severity"]), "info"),
                    metadata={"category": finding["category"]},
                ))

            normalized = file.lower().replace("\\", "/")
            evidence.extend(self._scan_dangerous_execution(file, source, language))
            evidence.extend(self._scan_permission_boundaries(file, source))
            if normalized.startswith(".github/workflows/") and suffix in {".yml", ".yaml"}:
                evidence.extend(self._scan_github_workflow(file, source))
            if PurePosixPath(normalized).name in {"dockerfile", "compose.yml", "compose.yaml", "docker-compose.yml", "docker-compose.yaml"}:
                evidence.extend(self._scan_container_permissions(file, source))
            if self._is_python_lockfile(normalized):
                evidence.extend(self._scan_python_lockfile(file, source))
            if PurePosixPath(normalized).name == "package.json":
                evidence.extend(self._scan_package_dependency_sources(file, source))

        evidence.extend(self._scan_package_lock_consistency(context))
        evidence = self._deduplicate(evidence)
        return PluginReport(
            evidence=tuple(evidence),
            summary=(
                f"Inspected {len(context.files)} file(s) in process; "
                f"reported {len(evidence)} anchored safety observation(s)"
            ),
        )

    @staticmethod
    def _scan_dangerous_execution(file: str, source: str, language: str) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        for line_number, line in enumerate(source.splitlines(), 1):
            if _SHELL_PIPE.search(line):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Downloaded content is piped directly into a command interpreter",
                    rule="engine.security.download_pipe_execution",
                    severity="high",
                ))

        if language in {"javascript", "typescript"} and _CHILD_PROCESS_IMPORT.search(source):
            for line_number, line in enumerate(source.splitlines(), 1):
                if _CHILD_PROCESS_EXEC.search(line):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt="child_process string execution crosses a command-injection boundary",
                        rule="engine.security.child_process_exec",
                        severity="high",
                    ))
                if _SPAWN_SHELL.search(line):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt="child_process spawn enables a shell interpreter",
                        rule="engine.security.child_process_shell",
                        severity="high",
                    ))
        return items

    @staticmethod
    def _scan_permission_boundaries(file: str, source: str) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        for line_number, line in enumerate(source.splitlines(), 1):
            if _WORLD_WRITABLE_MODE.search(line):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="File or directory permissions are configured as world-writable",
                    rule="engine.security.world_writable_permission",
                    severity="high",
                ))
            for pattern, description in _WEAK_ELECTRON_SECURITY:
                if pattern.search(line):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt=description,
                        rule="engine.security.electron_permission_boundary",
                        severity="high",
                    ))
        return items

    @staticmethod
    def _scan_github_workflow(file: str, source: str) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        lines = source.splitlines()
        privileged_trigger = bool(re.search(r"^\s*pull_request_target\s*:", source, re.MULTILINE))
        checks_out_pr_head = privileged_trigger and bool(re.search(
            r"github\.event\.pull_request\.(?:head\.(?:ref|sha)|head)", source, re.IGNORECASE
        ))

        run_block_indent: int | None = None
        for line_number, line in enumerate(lines, 1):
            stripped = line.strip()
            indentation = len(line) - len(line.lstrip())
            if run_block_indent is not None:
                if stripped and indentation <= run_block_indent:
                    run_block_indent = None
                elif _RUN_EXPRESSION.search(line):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt="Attacker-controlled event text is interpolated directly into a shell step",
                        rule="engine.security.workflow_expression_injection",
                        severity="high",
                    ))
            if re.match(r"^-?\s*run\s*:\s*[>|]", stripped, re.IGNORECASE):
                run_block_indent = indentation
            if re.match(r"^permissions\s*:\s*write-all\s*$", stripped, re.IGNORECASE):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Workflow grants write-all permissions instead of a least-privilege set",
                    rule="engine.security.workflow_write_all",
                    severity="high",
                ))

            permission = _DANGEROUS_WORKFLOW_PERMISSIONS.match(line)
            if permission:
                capability = permission.group(1).lower()
                severity = "medium" if capability in {"actions", "contents", "id-token", "packages", "pull-requests"} else "low"
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt=f"Workflow requests write access for {capability}; verify least privilege",
                    rule="engine.security.workflow_write_permission",
                    severity=severity,
                    metadata={"permission": capability},
                ))

            action_match = _ACTION_USE.match(line)
            if action_match:
                reference = action_match.group(1)
                if reference.startswith("./") or reference.startswith("docker://") or "@" not in reference:
                    continue
                revision = reference.rsplit("@", 1)[1]
                if not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt="Third-party action is not pinned to an immutable commit SHA",
                        rule="engine.security.unpinned_action",
                        severity="medium",
                        metadata={"action": reference.rsplit("@", 1)[0]},
                    ))

            if "run:" in stripped and _RUN_EXPRESSION.search(line):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Attacker-controlled event text is interpolated directly into a shell step",
                    rule="engine.security.workflow_expression_injection",
                    severity="high",
                ))

        if checks_out_pr_head:
            line_number = _first_matching_line(source, lambda line: "pull_request_target" in line)
            items.append(_line_item(
                file=file,
                line=line_number,
                excerpt="pull_request_target workflow appears to check out untrusted pull-request head code",
                rule="engine.security.pull_request_target_checkout",
                severity="critical",
            ))
        return items

    @staticmethod
    def _scan_container_permissions(file: str, source: str) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        for line_number, line in enumerate(source.splitlines(), 1):
            if re.search(r"^\s*privileged\s*:\s*true\s*$", line, re.IGNORECASE):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Container is granted privileged host capabilities",
                    rule="engine.security.container_privileged",
                    severity="high",
                ))
            if re.search(r"(?:/var/run/docker\.sock|//\./pipe/docker_engine)", line, re.IGNORECASE):
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Container receives access to the host Docker control socket",
                    rule="engine.security.docker_socket_mount",
                    severity="high",
                ))
        return items

    @staticmethod
    def _is_python_lockfile(normalized: str) -> bool:
        name = PurePosixPath(normalized).name
        return name in {"requirements-lock.txt", "requirements.lock", "constraints.txt"}

    @staticmethod
    def _scan_python_lockfile(file: str, source: str) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        for line_number, line in enumerate(source.splitlines(), 1):
            requirement = line.strip()
            if not requirement or requirement.startswith(("#", "--hash=", "-r ", "--requirement ")):
                continue
            if requirement.startswith(("git+", "http://", "https://")):
                if "@" not in requirement.split("#", 1)[0].removeprefix("https://").removeprefix("http://"):
                    items.append(_line_item(
                        file=file,
                        line=line_number,
                        excerpt="Lockfile dependency URL is not pinned to a revision",
                        rule="engine.security.unpinned_dependency_url",
                        severity="medium",
                    ))
                continue
            requirement_without_marker = requirement.split(";", 1)[0].strip()
            if "==" not in requirement_without_marker:
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Python lockfile entry is not pinned with an exact version",
                    rule="engine.security.unpinned_python_dependency",
                    severity="medium",
                ))
        return items

    @staticmethod
    def _package_dependencies(source: str) -> Mapping[str, Any] | None:
        try:
            payload = json.loads(source)
        except (json.JSONDecodeError, TypeError):
            return None
        if not isinstance(payload, dict):
            return None
        return {
            key: payload.get(key, {})
            for key in _PACKAGE_DEPENDENCY_KEYS
            if isinstance(payload.get(key, {}), dict)
        }

    def _scan_package_dependency_sources(self, file: str, source: str) -> list[EvidenceItem]:
        dependencies = self._package_dependencies(source)
        if dependencies is None:
            return []
        items: list[EvidenceItem] = []
        for section, entries in dependencies.items():
            for package, version in entries.items():
                if not isinstance(version, str) or not version.startswith(
                    ("git+", "git://", "http://", "https://", "github:", "gitlab:")
                ):
                    continue
                revision = version.rsplit("#", 1)[1] if "#" in version else ""
                if re.fullmatch(r"[0-9a-fA-F]{7,40}", revision):
                    continue
                line_number = _first_matching_line(
                    source,
                    lambda line, name=package: f'"{name}"' in line,
                )
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Dependency source URL is not pinned to an immutable commit",
                    rule="engine.security.unpinned_package_source",
                    severity="medium",
                    metadata={"package": package, "section": section},
                ))
        return items

    def _scan_package_lock_consistency(self, context: AnalysisContext) -> list[EvidenceItem]:
        items: list[EvidenceItem] = []
        normalized_files = {path.lower().replace("\\", "/"): path for path in context.files}
        for normalized, file in normalized_files.items():
            if PurePosixPath(normalized).name != "package.json":
                continue
            baseline_source = context.baselines.get(file)
            if baseline_source is None:
                continue
            current_deps = self._package_dependencies(context.files[file])
            baseline_deps = self._package_dependencies(baseline_source)
            if current_deps is None or baseline_deps is None or current_deps == baseline_deps:
                continue

            directory = str(PurePosixPath(normalized).parent)
            lock_paths = [
                original
                for candidate, original in normalized_files.items()
                if str(PurePosixPath(candidate).parent) == directory
                and PurePosixPath(candidate).name in _PACKAGE_LOCKS
            ]
            changed_locks = [
                path for path in lock_paths
                if path not in context.baselines or context.files[path] != context.baselines[path]
            ]
            line_number = _first_matching_line(
                context.files[file],
                lambda line: any(f'"{key}"' in line for key in _PACKAGE_DEPENDENCY_KEYS),
            )
            if lock_paths and not changed_locks:
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Package dependencies changed while the supplied lockfile snapshot did not",
                    rule="engine.security.stale_package_lock",
                    severity="high",
                    metadata={"lockfiles": sorted(PurePosixPath(path).name for path in lock_paths)},
                ))
            elif not lock_paths:
                items.append(_line_item(
                    file=file,
                    line=line_number,
                    excerpt="Package dependencies changed but no lockfile was supplied; dependency integrity coverage is incomplete",
                    rule="engine.security.lockfile_coverage_incomplete",
                    severity="info",
                ))
        return items

    @staticmethod
    def _deduplicate(items: Iterable[EvidenceItem]) -> list[EvidenceItem]:
        result: list[EvidenceItem] = []
        seen: set[tuple[str, int | None, str]] = set()
        for item in items:
            key = (item.file, item.start_line, item.rule or "")
            if key not in seen:
                seen.add(key)
                result.append(item)
        return result


__all__ = ["StaticSafetyPlugin"]
