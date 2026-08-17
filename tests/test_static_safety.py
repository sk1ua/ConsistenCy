"""Deterministic, process-local coverage for the vibe-safety harness."""
from __future__ import annotations

import asyncio

from engine.workflow.plugins import AnalysisContext
from engine.workflow.static_safety import StaticSafetyPlugin


def _scan(
    files: dict[str, str], baselines: dict[str, str] | None = None
):
    return asyncio.run(
        StaticSafetyPlugin().analyze(
            AnalysisContext(files=files, baselines=baselines or {})
        )
    )


def _rules(report) -> set[str]:
    return {item.rule or "" for item in report.evidence}


def test_scans_typescript_secrets_and_dangerous_execution_with_line_anchors():
    report = _scan({
        "src/run.ts": (
            'import { exec } from "node:child_process";\n'
            'const npmToken = "npm_0123456789abcdefghijklmnopqrstuvwxyz";\n'
            "exec(commandFromRequest);\n"
        ),
    })

    assert "engine.security.source_pattern" in _rules(report)
    assert "engine.security.child_process_exec" in _rules(report)
    assert all(item.file == "src/run.ts" for item in report.evidence)
    assert all(item.start_line and item.end_line for item in report.evidence)
    assert not any("npm_012345" in item.excerpt for item in report.evidence)


def test_flags_changed_dependencies_when_supplied_lockfile_is_stale():
    report = _scan(
        files={
            "package.json": '{"dependencies":{"left-pad":"2.0.0"}}',
            "package-lock.json": '{"lockfileVersion":3}',
        },
        baselines={
            "package.json": '{"dependencies":{"left-pad":"1.0.0"}}',
            "package-lock.json": '{"lockfileVersion":3}',
        },
    )

    assert "engine.security.stale_package_lock" in _rules(report)


def test_marks_missing_lockfile_as_incomplete_coverage_not_a_pass():
    report = _scan(
        files={"package.json": '{"dependencies":{"left-pad":"2.0.0"}}'},
        baselines={"package.json": '{"dependencies":{"left-pad":"1.0.0"}}'},
    )

    item = next(item for item in report.evidence if item.rule == "engine.security.lockfile_coverage_incomplete")
    assert item.severity == "info"
    assert "incomplete" in item.excerpt


def test_flags_unpinned_python_lock_entries():
    report = _scan({
        "requirements-lock.txt": "safe-package==1.2.3\nranged-package>=2\n",
    })

    matches = [
        item for item in report.evidence
        if item.rule == "engine.security.unpinned_python_dependency"
    ]
    assert len(matches) == 1
    assert matches[0].start_line == 2


def test_flags_unpinned_package_source_dependency():
    report = _scan({
        "package.json": (
            '{"dependencies":{"custom-lib":"git+https://example.test/custom-lib.git#main"}}'
        ),
    })

    assert "engine.security.unpinned_package_source" in _rules(report)


def test_flags_ci_permissions_unpinned_actions_and_expression_injection():
    report = _scan({
        ".github/workflows/review.yml": """
on: pull_request
permissions: write-all
jobs:
  inspect:
    steps:
      - uses: actions/checkout@v4
      - run: |
          echo "${{ github.event.pull_request.title }}"
""",
    })

    rules = _rules(report)
    assert "engine.security.workflow_write_all" in rules
    assert "engine.security.unpinned_action" in rules
    assert "engine.security.workflow_expression_injection" in rules


def test_flags_pull_request_target_checkout_of_untrusted_head():
    report = _scan({
        ".github/workflows/target.yml": """
on:
  pull_request_target:
jobs:
  inspect:
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
""",
    })

    item = next(
        item for item in report.evidence
        if item.rule == "engine.security.pull_request_target_checkout"
    )
    assert item.severity == "critical"


def test_flags_privileged_container_and_docker_socket_mount():
    report = _scan({
        "compose.yaml": """
services:
  worker:
    privileged: true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
""",
    })

    assert {
        "engine.security.container_privileged",
        "engine.security.docker_socket_mount",
    }.issubset(_rules(report))


def test_flags_world_writable_modes_and_weakened_electron_boundary():
    report = _scan({
        "src/permissions.ts": (
            "fs.chmodSync(target, 0o777);\n"
            "const webPreferences = { contextIsolation: false };\n"
        ),
    })

    assert {
        "engine.security.world_writable_permission",
        "engine.security.electron_permission_boundary",
    }.issubset(_rules(report))


def test_clean_snapshot_has_no_magic_aggregate_score_or_findings():
    report = _scan({
        "src/clean.py": "def add(left, right):\n    return left + right\n",
        ".github/workflows/check.yml": "permissions: read-all\n",
    })

    assert report.evidence == ()
    assert "score" not in report.summary.lower()
