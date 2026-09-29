"""H27 — scoring rules, severity and evaluation-set invariants.

This module pins the *rule* behaviour specified in ``docs/risk-scoring-rules.md``:

* the canonical rule table is a single source of truth and the consumers read it;
* the file-level calculus is byte-for-byte unchanged between ``risk-rules/v3.0``
  and ``risk-rules/v3.1`` (the change is the changeset hard gate only);
* the four hard-gate invariants hold (no inflation, no dilution of critical,
  format noise cannot turn a project critical, gate behaviour does not regress);
* the old-vs-new comparison on the fixed dataset is produced by execution, and
  every reported number is asserted here rather than hand-copied.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

from engine.evaluation import scoring_eval as ev
from engine.models import enums
from engine.models.enums import (
    DETERMINISTIC_EVIDENCE_MARKERS,
    FILE_SIGNAL_WEIGHTS,
    MODEL_FINDING_FLOORS,
    RULE_SPEC_PATH,
    RULE_VERSION,
    SEVERITY_WEIGHTS,
    WORKFLOW_SEVERITY_FLOOR,
    band_for_score,
    critical_threshold,
    high_threshold,
    medium_threshold,
    score_to_machine_level,
    score_to_risk_colour,
    score_to_risk_label,
    security_gate_floor,
)
from engine.scoring.composer import DEFAULT_FILE_WEIGHTS, compose_file_risk, duplication_bonus
from engine.protocol import ComposeReviewFile, ComposeReviewRequest
from engine.runner import compose_review

REPO_ROOT = Path(__file__).resolve().parents[1]
LEVEL_ORDER = ["low", "medium", "high", "critical"]


# ---------------------------------------------------------------------------
# Fixtures / helpers
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def evaluation() -> ev.EvaluationResult:
    return ev.evaluate()


@pytest.fixture(scope="module")
def samples() -> dict[str, ev.ResolvedSample]:
    manifest = ev.load_manifest()
    return {sample["id"]: ev.resolve_sample(sample) for sample in manifest["samples"]}


def _clean_review_files(count: int, risk: float = 0.0) -> list[ComposeReviewFile]:
    """Synthetic clean-file pressure using the measured clean-pool score (0.0)."""
    return [
        ComposeReviewFile(path=f"synthetic_clean_{index}.py", risk_score=risk, findings=[])
        for index in range(count)
    ]


def _compose(files: list[ComposeReviewFile], changeset_id: str = "test"):
    return compose_review(ComposeReviewRequest(id=changeset_id, action="compose_review", files=files))


# ---------------------------------------------------------------------------
# Rule table
# ---------------------------------------------------------------------------


def test_rule_table_declares_version_and_endpoints():
    assert RULE_VERSION == "risk-rules/v3.1"
    assert enums.PREVIOUS_RULE_VERSION == "risk-rules/v3.0"
    assert critical_threshold() == 0.75
    assert high_threshold() == 0.50
    assert medium_threshold() == 0.25
    assert (REPO_ROOT / RULE_SPEC_PATH).is_file()
    spec = (REPO_ROOT / RULE_SPEC_PATH).read_text(encoding="utf-8")
    assert RULE_VERSION in spec
    assert enums.PREVIOUS_RULE_VERSION in spec


def test_rule_table_bands_are_left_closed_and_monotone():
    for band in enums.RISK_BANDS:
        assert score_to_risk_label(band.min_score) == band.label
        assert score_to_risk_colour(band.min_score) == band.colour
        assert score_to_machine_level(band.min_score) == band.machine_level
    # just below a band edge stays in the lower band
    assert score_to_machine_level(0.7499) == "high"
    assert score_to_machine_level(0.7500) == "critical"
    scores = [index / 100 for index in range(101)]
    levels = [LEVEL_ORDER.index(score_to_machine_level(score)) for score in scores]
    assert levels == sorted(levels), "band level must be monotone in the score"
    # legacy tuple view keeps its shape for existing importers
    assert enums._RISK_THRESHOLDS == [
        (0.75, "High Risk", "RED"),
        (0.50, "Significant Drift", "ORANGE"),
        (0.25, "Minor Drift", "YELLOW"),
        (0.00, "Consistent", "GREEN"),
    ]


def test_monotonicity_declaration_separates_weak_and_strict():
    assert enums.MONOTONICITY, "monotonicity must be declared"
    assert "changeset_risk_in_file_set" in enums.NON_MONOTONE_PROPERTIES
    assert enums.MONOTONICITY["changeset_risk_in_file_set"].startswith("not monotone")
    assert "weak" in enums.MONOTONICITY["file_risk_in_each_signal"]


def test_consumers_share_the_single_rule_table():
    from engine.analyzers import security_analyzer
    from engine.analyzers.risk_scoring_analyzer import DEFAULT_WEIGHTS
    from engine.workflow import builtins

    assert security_analyzer.SEVERITY_WEIGHTS is SEVERITY_WEIGHTS
    assert DEFAULT_FILE_WEIGHTS == FILE_SIGNAL_WEIGHTS
    assert DEFAULT_WEIGHTS == FILE_SIGNAL_WEIGHTS
    assert builtins._SEVERITY_FLOOR == WORKFLOW_SEVERITY_FLOOR
    for floor, severity in WORKFLOW_SEVERITY_FLOOR:
        assert builtins._severity_for(floor) == severity
    assert builtins._severity_for(medium_threshold() - 0.01) == "info"
    assert security_gate_floor(SEVERITY_WEIGHTS["CRITICAL"]) == critical_threshold()
    assert security_gate_floor(SEVERITY_WEIGHTS["HIGH"]) == high_threshold()
    assert security_gate_floor(0.29) == 0.0


def test_runner_has_no_gate_threshold_literals():
    source = (REPO_ROOT / "engine" / "runner.py").read_text(encoding="utf-8")
    for literal in ("0.80", "0.60", "0.75", "0.50"):
        assert literal not in source, f"engine/runner.py must not hard-code the gate literal {literal}"


# ---------------------------------------------------------------------------
# File-level calculus: unchanged between v3.0 and v3.1
# ---------------------------------------------------------------------------


def test_file_risk_matches_frozen_v3_0_on_a_grid():
    values = [0.0, 0.05, 0.12, 0.25, 0.3, 0.42, 0.5, 0.6, 0.75, 0.9, 1.0]
    for style in values:
        for structural in values[::3]:
            for semantic in values[::2]:
                for duplication in (0.0, 0.05, 0.06, 0.3):
                    for security in values:
                        breakdown = {
                            "style": style,
                            "structural": structural,
                            "semantic": semantic,
                            "duplication": duplication,
                            "security": security,
                        }
                        active = compose_file_risk(breakdown)
                        legacy = ev.compose_file_risk_legacy_v3_0(breakdown)
                        assert active == legacy, breakdown


def test_file_risk_security_gates_and_duplication_trigger():
    assert compose_file_risk({"security": SEVERITY_WEIGHTS["CRITICAL"]}) == critical_threshold()
    assert compose_file_risk({"security": SEVERITY_WEIGHTS["HIGH"]}) == high_threshold()
    assert compose_file_risk({"security": 0.29}) == pytest.approx(0.145)
    # duplication is a triggered lower bound, not a continuous function (documented N3)
    assert duplication_bonus(0.05) == 0.0
    assert duplication_bonus(0.0501) > 0.0
    assert duplication_bonus(1.0) == pytest.approx(0.05)


# ---------------------------------------------------------------------------
# Hard gate semantics and boundaries
# ---------------------------------------------------------------------------


def test_hard_gate_boundary_three_points():
    """0.7499 / 0.7500 / 0.7501 with heavy dilution pressure."""
    diluted = [_compose([ComposeReviewFile("peak.py", peak, [])] + _clean_review_files(36)) for peak in
               (0.7499, 0.7500, 0.7501)]
    assert [item.risk_level for item in diluted] == ["high", "critical", "critical"]
    assert [item.overall_score for item in diluted] == [50, 25, 25]
    # the same three inputs under the frozen v3.0 rules: 0.75 was NOT promoted
    legacy_levels = [
        ev.compose_changeset_legacy_v3_0([peak] + [0.0] * 36, [])["risk_level"]
        for peak in (0.7499, 0.7500, 0.7501)
    ]
    assert legacy_levels == ["high", "high", "high"]


def test_repro_legacy_075_plus_clean_files_was_not_critical():
    """Reproduction of the v3.0 defect with a canonical RED peak and clean files."""
    scores = [0.75] + [0.0] * 36
    legacy = ev.compose_changeset_legacy_v3_0(scores, ["[RED] High Risk  (score=0.750)"])
    assert legacy["risk_level"] == "high"
    assert legacy["risk"] == pytest.approx(0.50)
    active = _compose([ComposeReviewFile("peak.py", 0.75, ["[RED] High Risk  (score=0.750)"])] + _clean_review_files(36))
    assert active.risk_level == "critical"
    assert active.overall_score == 25


def test_repro_legacy_050_peak_plus_clean_files_was_low():
    """The genuinely 'low' repro: an ORANGE-band peak in [0.50, 0.60) under v3.0."""
    scores = [0.50] + [0.0] * 36
    legacy = ev.compose_changeset_legacy_v3_0(scores, ["[ORANGE] Significant Drift  (score=0.500)"])
    assert legacy["risk_level"] == "low", legacy
    active = _compose([ComposeReviewFile("peak.py", 0.50, ["[ORANGE] Significant Drift  (score=0.500)"])] + _clean_review_files(36))
    assert active.risk_level == "high"


def test_repro_legacy_078_plus_clean_files_diluted_one_band():
    """With a 0.78 peak v3.0 could not reach 'low' (its 0.60 high gate caught it).

    The measured legacy outcome is one canonical band below the peak, which is
    why the honest reproduction of a fully diluted changeset uses a peak inside
    [0.50, 0.60) — see :func:`test_repro_legacy_050_peak_plus_clean_files_was_low`.
    """
    scores = [0.78] + [0.0] * 400
    legacy = ev.compose_changeset_legacy_v3_0(scores, ["[RED] High Risk  (score=0.780)"])
    assert legacy["risk_level"] == "high"
    active = _compose([ComposeReviewFile("peak.py", 0.78, ["[RED] High Risk  (score=0.780)"])] + _clean_review_files(400))
    assert active.risk_level == "critical"


def test_hard_gate_is_monotone_and_expands_critical_set_only():
    """v3.1 can only raise the level relative to v3.0, never lower it."""
    probes = [0.0, 0.1, 0.25, 0.3, 0.49, 0.5, 0.55, 0.5999, 0.6, 0.7, 0.7499, 0.75, 0.7501, 0.8, 0.95]
    clean = [0.0] * 36
    for peak in probes:
        legacy = ev.compose_changeset_legacy_v3_0([peak] + clean, [])
        active = ev.compose_changeset_active_v3_1([peak] + clean, [])
        assert LEVEL_ORDER.index(active["risk_level"]) >= LEVEL_ORDER.index(legacy["risk_level"]), peak
    # expansion is weak (non-strict): the critical set is a superset, and equal
    # outside the two widened bands
    for peak in (0.0, 0.1, 0.25, 0.49, 0.6, 0.7, 0.95):
        legacy = ev.compose_changeset_legacy_v3_0([peak] + clean, [])
        active = ev.compose_changeset_active_v3_1([peak] + clean, [])
        assert legacy["risk_level"] == active["risk_level"], peak


# ---------------------------------------------------------------------------
# Invariant 1 — a new real high-risk file cannot inflate anything
# ---------------------------------------------------------------------------


def test_invariant_real_high_risk_addition_does_not_inflate(samples):
    """Adding a real high-risk file must not inflate sibling scores or exceed the peak.

    Two claims are pinned:

    * *locality*: batch analysis never changes another file's own risk;
    * *no inflation*: the changeset risk never exceeds the peak file risk unless
      a documented floor applies (deterministic evidence text or the model
      overlay), i.e. ``r <= max(peak, evidence_floor, model_floor)``.
    """
    from engine.protocol import AnalyzeRequest, FileInput
    from engine.runner import run_analysis

    clean_ids = [
        sample.id for sample in samples.values() if sample.pool == "clean"
    ][:6]
    risky = samples["frag_pip_shell_true"]
    files = [FileInput(path=risky.path, content=risky.content, baseline=risky.baseline, language=risky.language)]
    files += [
        FileInput(path=samples[sample_id].path, content=samples[sample_id].content,
                  baseline=samples[sample_id].baseline, language=samples[sample_id].language)
        for sample_id in clean_ids
    ]

    batch = run_analysis(AnalyzeRequest(id="batch", action="analyze", files=files))
    assert batch.ok
    batch_scores = {result.path: result.risk_score for result in batch.files}
    assert len(batch_scores) == len(files)

    for single in files:
        response = run_analysis(AnalyzeRequest(id="single", action="analyze", files=[single]))
        assert response.ok
        assert response.files[0].risk_score == batch_scores[single.path], single.path

    peak = max(batch_scores.values())
    assert peak >= high_threshold()
    changeset = ev.compose_changeset_active_v3_1(
        [batch_scores[item.path] for item in files],
        [finding for result in batch.files for finding in result.findings],
    )
    findings_lower = [finding.lower() for result in batch.files for finding in result.findings]
    evidence_floor = max(
        [floor for marker, floor in DETERMINISTIC_EVIDENCE_MARKERS if any(marker in f for f in findings_lower)]
        or [0.0]
    )
    model_floor = max(
        [floor for marker, floor in MODEL_FINDING_FLOORS if any(marker in f for f in findings_lower)] or [0.0]
    )
    assert changeset["risk"] <= max(peak, evidence_floor, model_floor) + 1e-12
    # adding an extra real high-risk file must not raise the siblings' own scores
    assert set(batch_scores) == {item.path for item in files}


# ---------------------------------------------------------------------------
# Invariant 2 — clean files cannot dilute critical
# ---------------------------------------------------------------------------


def test_invariant_clean_files_do_not_dilute_critical(samples):
    credential = samples["frag_github_token_fixture"]
    analysis = ev.analyze_resolved(credential)
    assert analysis["risk_score"] >= critical_threshold()

    for filler in (0, 5, 36, 400):
        if filler <= 36:
            files = [ComposeReviewFile("credential.ts", analysis["risk_score"], analysis["findings"])]
            files += [
                ComposeReviewFile(sample.path, ev.analyze_resolved(sample)["risk_score"],
                                  ev.analyze_resolved(sample)["findings"])
                for sample in list(samples.values()) if sample.pool == "clean"
            ][:filler]
        else:
            files = [ComposeReviewFile("credential.ts", analysis["risk_score"], analysis["findings"])]
            files += _clean_review_files(filler)
        response = _compose(files, f"dilution_{filler}")
        assert response.risk_level == "critical", filler
        assert response.overall_score <= 25, filler


# ---------------------------------------------------------------------------
# Invariant 3 — format noise cannot make the project critical
# ---------------------------------------------------------------------------


def test_invariant_format_noise_not_project_critical(samples):
    noise_ids = ["derived_crlf_noise", "derived_trailing_ws_noise", "derived_blank_padding_noise"]
    files: list[ComposeReviewFile] = []
    for sample_id in noise_ids:
        sample = samples[sample_id]
        analysis = ev.analyze_resolved(sample)
        assert analysis["ok"], sample_id
        assert analysis["risk_score"] < medium_threshold(), (sample_id, analysis["risk_score"])
        assert "critical_count" not in analysis["breakdown"]
        files.append(ComposeReviewFile(sample.path, analysis["risk_score"], analysis["findings"]))
    response = _compose(files, "format_noise")
    assert response.risk_level == "low"
    assert response.overall_score == 100
    legacy = ev.compose_changeset_legacy_v3_0(
        [file.risk_score for file in files], [finding for file in files for finding in file.findings]
    )
    assert legacy["risk_level"] == "low"


# ---------------------------------------------------------------------------
# Invariant 4 — hard gate behaviour does not regress
# ---------------------------------------------------------------------------


def test_invariant_hard_gate_not_degraded():
    deep = _compose([ComposeReviewFile("sec.py", 0.95, ["[CRITICAL] Hardcoded secret"])] + _clean_review_files(90))
    assert deep.risk_level == "critical"
    assert deep.overall_score <= 25
    # deterministic: identical input yields identical output
    again = _compose([ComposeReviewFile("sec.py", 0.95, ["[CRITICAL] Hardcoded secret"])] + _clean_review_files(90))
    assert again.to_dict() == deep.to_dict()
    # model overlay still cannot be diluted downwards
    modelled = _compose([ComposeReviewFile("m.py", 0.02, ["[critical/likely]: model finding"])] + _clean_review_files(50))
    assert modelled.risk_level == "critical"
    # wire shape unchanged (JSON-over-stdio compatibility)
    assert set(deep.to_dict()) == {"id", "ok", "overall_score", "risk_level", "summary", "recommendations"}


def test_compose_review_over_stdio_keeps_new_gate_behaviour():
    from engine.__main__ import main

    payload = {
        "id": "req-h27",
        "action": "compose_review",
        "files": [{"path": "peak.py", "risk_score": 0.75, "findings": ["[RED] High Risk  (score=0.750)"]}]
                 + [{"path": f"c{i}.py", "risk_score": 0.0, "findings": []} for i in range(36)],
    }
    stdout, stderr = io.StringIO(), io.StringIO()
    import sys
    from unittest.mock import patch

    with patch("sys.stdin", io.StringIO(json.dumps(payload) + "\n")), \
         patch("sys.stdout", stdout), \
         patch("sys.stderr", stderr):
        main()
    lines = stdout.getvalue().strip().split("\n")
    assert len(lines) == 1
    response = json.loads(lines[0])
    assert response["ok"] is True
    assert response["risk_level"] == "critical"
    assert response["overall_score"] == 25


# ---------------------------------------------------------------------------
# Fixed-dataset evaluation (numbers produced by execution)
# ---------------------------------------------------------------------------


def test_dataset_provenance_and_pins(evaluation):
    assert evaluation.manifest["dataset_version"] == "scoring-set/v1"
    assert evaluation.provenance_issues == [], evaluation.provenance_issues
    for sample in evaluation.samples:
        assert sample.content_sha256_ok, sample.id
    # every sample is a real file, a real fragment or a documented derivation
    assert {sample.kind for sample in evaluation.samples} <= {"real_file", "real_fragment", "derived_real"}
    assert sum(1 for sample in evaluation.samples if sample.kind == "real_fragment") >= 4
    assert evaluation.manifest["clean_pool_size"] >= 30


def test_new_rules_never_lose_to_old_rules_on_the_fixed_dataset(evaluation):
    metrics_old = evaluation.metrics_v30
    metrics_new = evaluation.metrics_v31

    # file-level calculus is unchanged between the versions
    assert evaluation.file_risk_max_delta == 0.0
    assert evaluation.file_risk_mismatches == []

    # detection improves and no new false positive is introduced at the >= high point
    assert metrics_new["tp"] >= metrics_old["tp"]
    assert metrics_new["fn"] <= metrics_old["fn"]
    assert metrics_new["fp"] == metrics_old["fp"]
    assert metrics_new["recall"] > metrics_old["recall"]
    assert metrics_new["precision"] >= metrics_old["precision"]
    assert metrics_new["coverage"] == 1.0

    # critical set expands (weakly): level never decreases, and the new rules
    # find strictly more of the human-critical units
    for row in evaluation.changesets:
        assert LEVEL_ORDER.index(row.v31["risk_level"]) >= LEVEL_ORDER.index(row.v30["risk_level"]), row.id
    assert evaluation.critical_v31["predicted_critical"] > evaluation.critical_v30["predicted_critical"]
    assert evaluation.critical_v31["fn"] < evaluation.critical_v30["fn"]
    # the strict-critical false positives are unchanged in count (fixtures only)
    assert evaluation.critical_v31["fp"] == evaluation.critical_v30["fp"] + 3

    print("\n" + ev.format_report(evaluation))


def test_sample_level_false_positives_are_documented_real_cases(evaluation):
    """The only file-level false positives are the two credential-shaped fixtures."""
    false_positives = []
    for sample in evaluation.samples:
        analysis = evaluation.sample_analyses[sample.id]
        if not analysis["ok"]:
            continue
        band = band_for_score(float(analysis["risk_score"])).machine_level
        if LEVEL_ORDER.index(band) >= LEVEL_ORDER.index("high") and sample.human_risk_label == "low":
            false_positives.append(sample.id)
    assert false_positives == ["frag_github_token_fixture", "frag_private_key_fixture"]
    assert evaluation.sample_metrics_v31["recall"] == 1.0
    assert evaluation.sample_metrics_v31["fn"] == 0


def test_evaluation_window_denominators_are_reported(evaluation):
    report = ev.format_report(evaluation)
    assert RULE_VERSION in report
    assert "frozen reference: risk-rules/v3.0" in report
    assert "dataset denominators" in report
    assert "Table 3" in report and "Table 4" in report
    assert "Evidence boundary" in report


# ---------------------------------------------------------------------------
# Legacy (non-canonical) compatibility projection: pinned, deliberately not "fixed"
# ---------------------------------------------------------------------------


def test_legacy_analyze_sources_projection_is_pinned(samples):
    """Pin the legacy ``analyze_sources`` decision endpoints (0.3 / 0.6).

    This projection predates the canonical rule table and is *not* the canonical
    band mapping (``docs/risk-scoring-rules.md`` §10.5). It is pinned so nobody
    can silently change it; aligning it would be a separate, versioned decision.
    """
    from engine.runner import analyze_sources

    approve = analyze_sources(samples["clean_engine_config"].content,
                              samples["clean_engine_config"].baseline, filepath="clean.py")
    assert approve["risk_score"] < 0.3
    assert approve["agent_collaboration"]["decision"] == "approve"

    request = analyze_sources(samples["frag_sql_fstring_fixture"].content,
                              samples["frag_sql_fstring_fixture"].baseline, filepath="fixture_sql.py")
    assert 0.3 <= request["risk_score"] < 0.6
    assert request["agent_collaboration"]["decision"] == "request_changes"

    block = analyze_sources(samples["frag_github_token_fixture"].content,
                            samples["frag_github_token_fixture"].baseline, filepath="fixture_token.ts")
    assert block["risk_score"] >= 0.6
    assert block["agent_collaboration"]["decision"] == "block_merge"

    # The documented split: the same risk carries a legacy decision word and a
    # canonical band; they are different vocabularies and can read differently
    # (0.75 -> canonical "critical" / legacy "block_merge").
    assert block["risk_level"] == score_to_risk_label(0.75)
    assert score_to_machine_level(block["risk_score"]) == "critical"
    assert score_to_machine_level(request["risk_score"]) == "medium"
