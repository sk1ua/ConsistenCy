"""Cross-language parity: TypeScript risk bands vs the canonical Python table.

``riskLevelForScore`` in ``packages/schema/src/report.ts`` maps the engine's
``overall_score`` (0..100) onto the shared risk vocabulary. The tier boundaries
must be the canonical ones from ``engine/models/enums.py`` (spec:
``docs/risk-scoring-rules.md`` §5, rule version ``risk-rules/v3.1``).

These tests *parse* the TypeScript source instead of importing it, so a drift on
either side turns them red. Any parse failure is a hard failure — never a skip —
because a silent pass would defeat the whole purpose of the check.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from engine.models.enums import (
    RULE_VERSION,
    critical_threshold,
    high_threshold,
    medium_threshold,
    score_to_machine_level,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
REPORT_TS = REPO_ROOT / "packages" / "schema" / "src" / "report.ts"

#: Boundary list shared by both sides; mirror of the table in
#: packages/schema/src/index.test.ts ("maps quality scores to risk levels ...").
BOUNDARY_SCORES = (0, 25, 26, 39, 40, 50, 51, 59, 60, 75, 76, 79, 80, 100)

_THRESHOLD_BLOCK = re.compile(
    r"CANONICAL_RISK_BAND_THRESHOLDS\s*=\s*\{(?P<body>[^}]*)\}", re.S
)
_BOUNDS_BLOCK = re.compile(r"CANONICAL_OVERALL_SCORE_BOUNDS\s*=\s*\{(?P<body>[^}]*)\}", re.S)
_NUMBER_FIELD = re.compile(r"(?P<key>critical|high|medium)\s*:\s*(?P<value>\d+(?:\.\d+)?)")
_BOUNDS_ENTRY = re.compile(
    r"(?P<key>critical|high|medium)\s*:\s*100\s*\*\s*\(\s*1\s*-\s*"
    r"CANONICAL_RISK_BAND_THRESHOLDS\.(?P<ref>critical|high|medium)\s*\)"
)
_FUNCTION = re.compile(
    r"export function riskLevelForScore\(score: number\): RiskLevel \{(?P<body>.*?)\n\}",
    re.S,
)
_BRANCH = re.compile(
    r"if \(score <= CANONICAL_OVERALL_SCORE_BOUNDS\.(?P<key>critical|high|medium)\) "
    r"return \"(?P<level>[a-z]+)\";"
)
_FALLBACK = re.compile(r"return \"(?P<level>[a-z]+)\";\s*$")


def _ts_source() -> str:
    if not REPORT_TS.is_file():
        pytest.fail(f"missing TypeScript risk-band source: {REPORT_TS}")
    return REPORT_TS.read_text(encoding="utf-8")


def _parse_thresholds(source: str) -> dict[str, float]:
    match = _THRESHOLD_BLOCK.search(source)
    if not match:
        pytest.fail("could not parse CANONICAL_RISK_BAND_THRESHOLDS from report.ts")
    parsed = {item.group("key"): float(item.group("value")) for item in _NUMBER_FIELD.finditer(match.group("body"))}
    if set(parsed) != {"critical", "high", "medium"}:
        pytest.fail(f"CANONICAL_RISK_BAND_THRESHOLDS parsed incompletely: {parsed}")
    return parsed


def _parse_bounds(source: str, thresholds: dict[str, float] | None = None) -> dict[str, int]:
    thresholds = thresholds if thresholds is not None else _parse_thresholds(source)
    match = _BOUNDS_BLOCK.search(source)
    if not match:
        pytest.fail("could not parse CANONICAL_OVERALL_SCORE_BOUNDS from report.ts")
    parsed: dict[str, int] = {}
    for item in _BOUNDS_ENTRY.finditer(match.group("body")):
        key, ref = item.group("key"), item.group("ref")
        if key != ref:
            pytest.fail(f"CANONICAL_OVERALL_SCORE_BOUNDS.{key} must derive from threshold {key}, not {ref}")
        parsed[key] = int(round(100 * (1 - thresholds[ref])))
    if set(parsed) != {"critical", "high", "medium"}:
        pytest.fail(
            "CANONICAL_OVERALL_SCORE_BOUNDS must be written as "
            "`100 * (1 - CANONICAL_RISK_BAND_THRESHOLDS.<level>)` for all three levels "
            f"(parsed: {parsed})"
        )
    return parsed


def _parse_branches(source: str) -> tuple[list[tuple[str, str]], str]:
    match = _FUNCTION.search(source)
    if not match:
        pytest.fail("could not parse riskLevelForScore from report.ts")
    body = match.group("body")
    branches = [(item.group("key"), item.group("level")) for item in _BRANCH.finditer(body)]
    if len(branches) != 3:
        pytest.fail(f"riskLevelForScore must contain three bound comparisons, found {branches}")
    fallback = _FALLBACK.search(_BRANCH.sub("", body).strip())
    if not fallback:
        pytest.fail("riskLevelForScore must end with a fallback return")
    return branches, fallback.group("level")


def _ts_level(score: int, bounds: dict[str, int], branches: list[tuple[str, str]], fallback: str) -> str:
    """Simulate the parsed TypeScript function (order and operator included)."""

    for key, level in branches:
        if score <= bounds[key]:
            return level
    return fallback


def test_ts_thresholds_match_python_canonical_rule_table():
    parsed = _parse_thresholds(_ts_source())
    assert parsed["critical"] == critical_threshold()
    assert parsed["high"] == high_threshold()
    assert parsed["medium"] == medium_threshold()
    assert RULE_VERSION  # the canonical table is versioned; the TS mirror must follow it


def test_ts_overall_bounds_are_derived_from_the_thresholds():
    bounds = _parse_bounds(_ts_source())
    assert bounds == {"critical": 25, "high": 50, "medium": 75}


def test_ts_boundary_table_matches_python_projection_for_every_shared_case():
    source = _ts_source()
    bounds = _parse_bounds(source)
    branches, fallback = _parse_branches(source)
    assert [key for key, _ in branches] == ["critical", "high", "medium"], branches
    for score in BOUNDARY_SCORES:
        # Python side: overall_score = round(100 * (1 - r)) -> r = (100 - score) / 100
        expected = score_to_machine_level((100 - score) / 100)
        assert _ts_level(score, bounds, branches, fallback) == expected, (
            f"overall_score={score}: TS says {_ts_level(score, bounds, branches, fallback)}, "
            f"canonical Python band says {expected}"
        )


def test_ts_source_has_no_leftover_legacy_literals():
    """The old drifted boundaries (39/59/79) must not come back."""

    source = _ts_source()
    function_body = _FUNCTION.search(source)
    assert function_body is not None
    body = function_body.group("body")
    for literal in ("39", "59", "79"):
        assert literal not in body, f"legacy boundary {literal} must not reappear in riskLevelForScore"
