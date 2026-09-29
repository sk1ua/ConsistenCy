"""H27 scoring-rule evaluation harness (old vs new rules, one fixed dataset).

The harness answers a narrow, reproducible question: *on the fixed, human
annotated dataset in* ``scoring_cases.json``, *how do the rule versions
``risk-rules/v3.0`` (frozen) and* ``risk-rules/v3.1`` (active) *behave?*

Design constraints:

* per-file risk always comes from the **real** deterministic engine
  (``engine.runner.run_analysis``), never from hand-written numbers;
* the ``v3.1`` changeset decision is the **production** code path
  (``engine.runner.compose_review``), not a copy;
* the ``v3.0`` decision is a frozen transcription of HEAD ``0b20fa2``
  ``engine/runner.py:227-267`` (in :func:`compose_changeset_legacy_v3_0`) with
  the exact literal thresholds that version shipped (critical gate ``0.80``,
  high gate ``0.60``);
* every table prints the rule version, the unit count and the denominators so
  the numbers can be audited.

Evidence boundary: the dataset is a small hand-annotated set derived from real
repository files/fragments. It demonstrates monotonicity and threshold
behaviour of the rules on fixed samples; it does **not** establish false
positive/negative rates on real projects or any model-quality claim.

Run:  .\\.venv\\Scripts\\python.exe -m engine.evaluation.scoring_eval
"""

from __future__ import annotations

import functools
import hashlib
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

from engine.models.enums import (
    RISK_BANDS,
    RULE_VERSION,
    band_for_score,
    critical_threshold,
    high_threshold,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("scoring_cases.json")

#: Score at or above which a unit counts as "needs attention" for the binary
#: metrics (canonical ORANGE floor).
POSITIVE_THRESHOLD = high_threshold()


# ---------------------------------------------------------------------------
# Frozen v3.0 rule transcription (comparison baseline only)
# ---------------------------------------------------------------------------


def compose_file_risk_legacy_v3_0(breakdown: dict[str, float]) -> float:
    """Frozen transcription of the v3.0 file-level calculus (HEAD 0b20fa2).

    Mirrors ``engine/scoring/composer.py`` at HEAD before the rule table was
    introduced: weights 0.28/0.39/0.33, duplication bonus ``0.05 * min(dup/0.30)``
    above 0.05, security bonus ``0.50 * security``, security gates
    ``security >= 0.60 -> 0.75`` and ``security >= 0.30 -> 0.50``, rounded to
    4 decimals.
    """

    base = (
        0.28 * float(breakdown.get("style", 0.0))
        + 0.39 * float(breakdown.get("structural", 0.0))
        + 0.33 * float(breakdown.get("semantic", 0.0))
    )
    duplication = float(breakdown.get("duplication", 0.0))
    dup_boost = 0.05 * min(duplication / 0.30, 1.0) if duplication > 0.05 else 0.0
    security = float(breakdown.get("security", 0.0))
    security_boost = security * 0.50
    risk = max(0.0, min(1.0, base + dup_boost + security_boost))
    if security >= 0.60:
        risk = max(risk, 0.75)
    elif security >= 0.30:
        risk = max(risk, 0.50)
    return round(risk, 4)


def compose_changeset_legacy_v3_0(scores: Sequence[float], findings: Sequence[str]) -> dict[str, Any]:
    """Frozen transcription of the v3.0 changeset aggregation (HEAD 0b20fa2).

    Literal thresholds as shipped: critical gate ``max_risk >= 0.80`` (or a
    ``[critical]`` / ``critical security`` substring), high gate
    ``max_risk >= 0.60`` (or ``[high]``), floors 0.75/0.50, model overlay
    ``[critical/ [high/ [medium/ [low/`` -> 0.75/0.50/0.25/0.10, band edges
    0.75/0.50/0.25, ``overall_score = round((1 - r) * 100)``.
    """

    if not scores:
        return {"risk": 0.0, "r_det": 0.0, "overall_score": 100, "risk_level": "low", "gate": "none"}
    mean_risk = sum(scores) / len(scores)
    max_risk = max(scores)
    r_det = 0.70 * mean_risk + 0.30 * max_risk if len(scores) > 1 else max_risk

    findings_lower = [f.lower() for f in findings]
    has_det_critical = max_risk >= 0.80 or any(
        "[critical]" in f or "critical security" in f for f in findings_lower
    )
    has_det_high = max_risk >= 0.60 or any("[high]" in f for f in findings_lower)

    gate = "none"
    if has_det_critical:
        r_det = max(r_det, 0.75)
        gate = "critical"
    elif has_det_high:
        r_det = max(r_det, 0.50)
        gate = "high"

    r_final = r_det
    if any("[critical/" in f for f in findings_lower):
        r_final = max(r_final, 0.75)
    elif any("[high/" in f for f in findings_lower):
        r_final = max(r_final, 0.50)
    elif any("[medium/" in f for f in findings_lower):
        r_final = max(r_final, 0.25)
    elif any("[low/" in f for f in findings_lower):
        r_final = max(r_final, 0.10)

    r_final = max(0.0, min(1.0, r_final))
    overall_score = round((1.0 - r_final) * 100)
    if r_final >= 0.75:
        risk_level = "critical"
    elif r_final >= 0.50:
        risk_level = "high"
    elif r_final >= 0.25:
        risk_level = "medium"
    else:
        risk_level = "low"
    return {
        "risk": r_final,
        "r_det": r_det,
        "overall_score": overall_score,
        "risk_level": risk_level,
        "gate": gate,
    }


def compose_changeset_active_v3_1(scores: Sequence[float], findings: Sequence[str]) -> dict[str, Any]:
    """Recompute the active rule decision from the rule table (audit cross-check).

    ``compose_review`` does not expose the raw ``r_final`` on the wire, so the
    harness recomputes it from :mod:`engine.models.enums` and asserts that the
    recomputed band/score match the production path (see :func:`evaluate_changeset`).
    """

    from engine.models.enums import (
        CHANGESET_MEAN_WEIGHT,
        CHANGESET_PEAK_WEIGHT,
        deterministic_evidence_floor,
        deterministic_gate_floor,
        model_overlay_floor,
        overall_score_for_risk,
        score_to_machine_level,
    )

    if not scores:
        return {"risk": 0.0, "r_det": 0.0, "overall_score": 100, "risk_level": "low", "gate": "none"}
    mean_risk = sum(scores) / len(scores)
    max_risk = max(scores)
    r_det = (
        CHANGESET_MEAN_WEIGHT * mean_risk + CHANGESET_PEAK_WEIGHT * max_risk
        if len(scores) > 1
        else max_risk
    )
    findings_lower = [f.lower() for f in findings]
    peak_floor = deterministic_gate_floor(max_risk)
    text_floor = deterministic_evidence_floor(findings_lower)
    floor = max(peak_floor, text_floor)
    if floor > r_det:
        r_det = floor
    gate = "critical" if floor >= critical_threshold() else ("high" if floor >= high_threshold() else "none")
    r_final = max(0.0, min(1.0, max(r_det, model_overlay_floor(findings_lower))))
    return {
        "risk": r_final,
        "r_det": r_det,
        "overall_score": overall_score_for_risk(r_final),
        "risk_level": score_to_machine_level(r_final),
        "gate": gate,
    }


# ---------------------------------------------------------------------------
# Dataset resolution
# ---------------------------------------------------------------------------


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class ResolvedSample:
    """One dataset sample resolved to concrete analyzer inputs."""

    id: str
    path: str
    language: str | None
    content: str
    baseline: str
    kind: str
    pool: str | None
    human_risk_label: str
    expected_rule_band: str | None
    rationale: str
    provenance: dict[str, Any]
    provenance_status: str = "unknown"
    content_sha256_ok: bool = True
    error: str | None = None


def load_manifest(path: Path | None = None) -> dict[str, Any]:
    manifest_path = Path(path) if path else MANIFEST_PATH
    return json.loads(manifest_path.read_text(encoding="utf-8"))


def _provenance_status(sample: dict[str, Any], repo_root: Path) -> str:
    """Best-effort check that the pinned sample still matches the repository."""

    import textwrap

    provenance = sample.get("provenance", {})
    source_path = provenance.get("source_path")
    if not source_path:
        return "unpinned"
    source_file = repo_root / source_path
    if not source_file.exists():
        return "missing"
    live = source_file.read_text(encoding="utf-8")
    if provenance.get("source_lines"):
        first, last = provenance["source_lines"]
        candidate = "\n".join(live.splitlines()[first - 1:last]) + "\n"
        if provenance.get("slice_transform") == "dedent":
            candidate = textwrap.dedent(candidate)
        return "verified" if sha256_text(candidate) == provenance.get("slice_sha256") else "drifted"
    if sample.get("kind") == "derived_real":
        pinned = provenance.get("base_sha256_at_pin")
        return "derived-from:" + ("verified" if sha256_text(live) == pinned else "drifted")
    return "verified" if sha256_text(live) == provenance.get("file_sha256_at_pin") else "drifted"


def resolve_sample(sample: dict[str, Any], repo_root: Path = REPO_ROOT) -> ResolvedSample:
    """Resolve one manifest sample into analyzer inputs (pinned content wins)."""

    kind = sample["kind"]
    provenance = dict(sample.get("provenance", {}))
    source_path = provenance.get("source_path")
    content = sample.get("content")
    baseline = ""

    if kind == "real_file":
        if not source_path:
            raise ValueError(f"sample {sample['id']} has no source_path")
        content = (repo_root / source_path).read_text(encoding="utf-8")
        baseline = content if sample.get("baseline") == "self" else ""
    elif kind == "derived_real":
        if content is None:
            raise ValueError(f"sample {sample['id']} has no pinned content")
        base = (repo_root / source_path).read_text(encoding="utf-8") if source_path else ""
        baseline = base
    if content is None:
        raise ValueError(f"sample {sample['id']} has no content")

    expected = provenance.get("slice_sha256")
    resolved = ResolvedSample(
        id=sample["id"],
        path=sample["path"],
        language=sample.get("language"),
        content=content,
        baseline=baseline,
        kind=kind,
        pool=sample.get("pool"),
        human_risk_label=sample["human_risk_label"],
        expected_rule_band=sample.get("expected_rule_band"),
        rationale=sample.get("rationale", ""),
        provenance=provenance,
        provenance_status=_provenance_status(sample, repo_root),
        content_sha256_ok=expected is None or sha256_text(content) == expected,
    )
    return resolved


# ---------------------------------------------------------------------------
# Real engine invocation
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=None)
def _analyze_cached(path: str, content: str, baseline: str, language: str | None) -> dict[str, Any]:
    from engine.protocol import AnalyzeRequest, FileInput
    from engine.runner import run_analysis

    response = run_analysis(
        AnalyzeRequest(
            id="eval",
            action="analyze",
            files=[FileInput(path=path, content=content, baseline=baseline, language=language)],
        )
    )
    if not response.ok or not response.files:
        return {"ok": False, "error": response.error, "path": path}
    file_result = response.files[0]
    return {
        "ok": True,
        "path": path,
        "risk_score": file_result.risk_score,
        "risk_label": file_result.risk_label,
        "risk_colour": file_result.risk_color,
        "breakdown": {k: float(v) for k, v in (file_result.breakdown or {}).items()},
        "findings": list(file_result.findings),
        "signals": file_result.signals,
    }


def analyze_resolved(sample: ResolvedSample) -> dict[str, Any]:
    return _analyze_cached(sample.path, sample.content, sample.baseline, sample.language)


# ---------------------------------------------------------------------------
# Changeset evaluation
# ---------------------------------------------------------------------------


@dataclass
class ChangesetRow:
    id: str
    kind: str
    human_label: str
    files: int
    mean_risk: float
    max_risk: float
    v30: dict[str, Any]
    v31: dict[str, Any]
    peak_sample: str | None
    invalid_members: list[str] = field(default_factory=list)


def build_changeset_files(
    changeset: dict[str, Any],
    samples: dict[str, ResolvedSample],
    analyses: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], str | None, list[str]]:
    """Return ``(file results, peak sample id, invalid member ids)``."""

    files: list[dict[str, Any]] = []
    invalid: list[str] = []

    for sample_id in changeset.get("members", []):
        sample = samples[sample_id]
        analysis = analyses[sample_id]
        if not analysis["ok"]:
            invalid.append(sample_id)
            continue
        files.append({
            "path": sample.path,
            "risk_score": analysis["risk_score"],
            "findings": analysis["findings"],
            "_sample": sample_id,
        })

    filler = int(changeset.get("clean_filler", {}).get("count", 0) or 0)
    if filler:
        pool = [s for s in samples.values() if s.pool == "clean"]
        if len(pool) < filler:
            raise ValueError(f"changeset {changeset['id']} needs {filler} clean files, pool has {len(pool)}")
        for sample in pool[:filler]:
            analysis = analyses[sample.id]
            if not analysis["ok"]:
                invalid.append(sample.id)
                continue
            if analysis["risk_score"] >= POSITIVE_THRESHOLD:
                # Dataset hygiene: the dilution pool must never carry real risk,
                # otherwise the "adding clean files" premise is false.
                raise AssertionError(
                    f"clean pool member {sample.id} scored {analysis['risk_score']} "
                    f"(>= {POSITIVE_THRESHOLD}); dataset hygiene violated"
                )
            files.append({
                "path": sample.path,
                "risk_score": analysis["risk_score"],
                "findings": analysis["findings"],
                "_sample": sample.id,
            })

    if "synthetic_peak" in changeset:
        files.append({
            "path": "synthetic_boundary_peak.py",
            "risk_score": float(changeset["synthetic_peak"]),
            "findings": [],
            "_sample": None,
        })

    peak_sample = None
    if files:
        peak = max(files, key=lambda item: item["risk_score"])
        peak_sample = peak.get("_sample")
    return files, peak_sample, invalid


def evaluate_changeset(changeset: dict[str, Any], files: list[dict[str, Any]]) -> dict[str, Any]:
    """Run the active (v3.1) production path; then the frozen v3.0 transcription."""

    from engine.protocol import ComposeReviewFile, ComposeReviewRequest
    from engine.runner import compose_review

    scores = [float(item["risk_score"]) for item in files]
    findings = [finding for item in files for finding in item["findings"]]

    request = ComposeReviewRequest(
        id=changeset["id"],
        action="compose_review",
        files=[
            ComposeReviewFile(path=item["path"], risk_score=float(item["risk_score"]), findings=list(item["findings"]))
            for item in files
        ],
    )
    active = compose_review(request)
    recomputed = compose_changeset_active_v3_1(scores, findings)
    if not active.ok:
        raise RuntimeError(f"compose_review failed for {changeset['id']}: {active.error}")
    if (active.risk_level, active.overall_score) != (recomputed["risk_level"], recomputed["overall_score"]):
        raise AssertionError(
            f"{changeset['id']}: production path ({active.risk_level}, {active.overall_score}) "
            f"!= rule table recomputation ({recomputed['risk_level']}, {recomputed['overall_score']})"
        )
    legacy = compose_changeset_legacy_v3_0(scores, findings)
    return {"v31": recomputed, "v30": legacy}


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _is_positive(level: str, threshold_level: str = "high") -> bool:
    order = ["low", "medium", "high", "critical"]
    return order.index(level) >= order.index(threshold_level)


def binary_metrics(rows: Iterable[tuple[str, str]]) -> dict[str, float]:
    """Precision/recall/F1/coverage over ``(human_label, predicted_level)``."""

    tp = fp = fn = tn = 0
    total = 0
    for human, predicted in rows:
        total += 1
        h = _is_positive(human)
        p = _is_positive(predicted)
        if h and p:
            tp += 1
        elif h and not p:
            fn += 1
        elif not h and p:
            fp += 1
        else:
            tn += 1
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "tn": tn,
        "precision": precision,
        "recall": recall,
        "f1": f1,
        "coverage": 1.0 if total else 0.0,
        "units": total,
    }


def critical_counts(rows: Iterable[tuple[str, str]]) -> dict[str, int]:
    """Counts at the strict ``critical`` operating point."""

    human_critical = predicted_critical = 0
    tp = fp = fn = 0
    for human, predicted in rows:
        h = human == "critical"
        p = predicted == "critical"
        human_critical += int(h)
        predicted_critical += int(p)
        if h and p:
            tp += 1
        elif h and not p:
            fn += 1
        elif p and not h:
            fp += 1
    return {
        "human_critical": human_critical,
        "predicted_critical": predicted_critical,
        "tp": tp,
        "fp": fp,
        "fn": fn,
    }


# ---------------------------------------------------------------------------
# Top level evaluation
# ---------------------------------------------------------------------------


@dataclass
class EvaluationResult:
    manifest: dict[str, Any]
    samples: list[ResolvedSample]
    sample_analyses: dict[str, dict[str, Any]]
    changesets: list[ChangesetRow]
    file_risk_max_delta: float
    file_risk_mismatches: list[str]
    provenance_issues: list[str]
    metrics_v30: dict[str, float]
    metrics_v31: dict[str, float]
    critical_v30: dict[str, int]
    critical_v31: dict[str, int]
    sample_metrics_v31: dict[str, float]


def evaluate(manifest: dict[str, Any] | None = None, repo_root: Path = REPO_ROOT) -> EvaluationResult:
    manifest = manifest or load_manifest()
    samples = [resolve_sample(sample, repo_root) for sample in manifest["samples"]]
    by_id = {sample.id: sample for sample in samples}
    analyses = {sample.id: analyze_resolved(sample) for sample in samples}

    provenance_issues = [
        f"{sample.id}:{sample.provenance_status}"
        for sample in samples
        if sample.provenance_status not in ("verified", "derived-from:verified", "unpinned")
        or not sample.content_sha256_ok
    ]

    # File-level version invariance: frozen v3.0 file calculus vs active v3.1.
    file_risk_max_delta = 0.0
    file_risk_mismatches: list[str] = []
    from engine.scoring.composer import compose_file_risk

    for sample in samples:
        analysis = analyses[sample.id]
        if not analysis["ok"]:
            continue
        legacy = compose_file_risk_legacy_v3_0(analysis["breakdown"])
        delta = abs(legacy - float(analysis["risk_score"]))
        file_risk_max_delta = max(file_risk_max_delta, delta)
        if delta > 1e-9:
            file_risk_mismatches.append(f"{sample.id}: legacy={legacy} active={analysis['risk_score']}")
        # also compare the live composer against the frozen transcription
        active_direct = compose_file_risk(analysis["breakdown"])
        if abs(active_direct - legacy) > 1e-9:
            file_risk_mismatches.append(
                f"{sample.id}: composer(active)={active_direct} composer(legacy)={legacy}"
            )

    rows: list[ChangesetRow] = []
    for changeset in manifest["changesets"]:
        files, peak, invalid = build_changeset_files(changeset, by_id, analyses)
        scores = [float(item["risk_score"]) for item in files]
        outcome = evaluate_changeset(changeset, files)
        rows.append(ChangesetRow(
            id=changeset["id"],
            kind=changeset["kind"],
            human_label=changeset["human_risk_label"],
            files=len(files),
            mean_risk=sum(scores) / len(scores) if scores else 0.0,
            max_risk=max(scores) if scores else 0.0,
            v30=outcome["v30"],
            v31=outcome["v31"],
            peak_sample=peak,
            invalid_members=invalid,
        ))

    pairs30 = [(row.human_label, row.v30["risk_level"]) for row in rows]
    pairs31 = [(row.human_label, row.v31["risk_level"]) for row in rows]
    sample_pairs = [
        (sample.human_risk_label, band_for_score(float(analyses[sample.id]["risk_score"])).machine_level)
        for sample in samples
        if analyses[sample.id]["ok"]
    ]
    return EvaluationResult(
        manifest=manifest,
        samples=samples,
        sample_analyses=analyses,
        changesets=rows,
        file_risk_max_delta=file_risk_max_delta,
        file_risk_mismatches=file_risk_mismatches,
        provenance_issues=provenance_issues,
        metrics_v30=binary_metrics(pairs30),
        metrics_v31=binary_metrics(pairs31),
        critical_v30=critical_counts(pairs30),
        critical_v31=critical_counts(pairs31),
        sample_metrics_v31=binary_metrics(sample_pairs),
    )


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def _fmt(value: Any, width: int = 0) -> str:
    text = f"{value:.4f}" if isinstance(value, float) else str(value)
    return text.rjust(width) if width else text


def format_report(result: EvaluationResult) -> str:
    lines: list[str] = []
    manifest = result.manifest
    lines.append("=" * 118)
    lines.append("H27 scoring rule evaluation - old vs new rules on one fixed dataset")
    lines.append("=" * 118)
    lines.append(
        f"rule version (active): {RULE_VERSION}   frozen reference: {manifest['frozen_reference_version']}   "
        f"dataset: {manifest['dataset_version']} @ {manifest['base_commit']} ({manifest['created_at']})"
    )
    lines.append(
        f"dataset denominators: samples={len(result.samples)} "
        f"(real_file={sum(1 for s in result.samples if s.kind == 'real_file')}, "
        f"real_fragment={sum(1 for s in result.samples if s.kind == 'real_fragment')}, "
        f"derived_real={sum(1 for s in result.samples if s.kind == 'derived_real')}), "
        f"clean_pool={sum(1 for s in result.samples if s.pool == 'clean')}, "
        f"changesets={len(result.changesets)}"
    )
    lines.append(
        f"risk bands: RED>={RISK_BANDS[0].min_score} ORANGE>={RISK_BANDS[1].min_score} "
        f"YELLOW>={RISK_BANDS[2].min_score}   positive threshold (needs attention): >={POSITIVE_THRESHOLD}"
    )
    lines.append(
        f"denominators in use: file risk = weighted sum / 1.0 (bounded absolute scale); "
        f"security score = sum(severity weights) / 1.0 (saturation); "
        f"changeset risk = 0.70*mean + 0.30*peak, then max(., canonical band floor)"
    )
    lines.append("")

    lines.append("Table 1 - samples (per-file risk from the real engine; band = canonical band of that risk)")
    lines.append(
        f"{'sample':<40}{'kind':<14}{'human':<9}{'band':<9}{'risk':>8}  {'sec':>7}{'dup':>7}  provenance"
    )
    lines.append("-" * 118)
    for sample in result.samples:
        analysis = result.sample_analyses[sample.id]
        label = sample.id if len(sample.id) <= 38 else sample.id[:37] + "~"
        if not analysis["ok"]:
            lines.append(
                f"{label:<40}{sample.kind:<14}{sample.human_risk_label:<9}{'ERROR':<9}{'':>8}  {analysis.get('error')}"
            )
            continue
        band = band_for_score(float(analysis["risk_score"])).machine_level
        breakdown = analysis["breakdown"]
        lines.append(
            f"{label:<40}{sample.kind:<14}{sample.human_risk_label:<9}{band:<9}"
            f"{_fmt(float(analysis['risk_score']), 8)}  {_fmt(breakdown.get('security', 0.0), 7)}"
            f"{_fmt(breakdown.get('duplication', 0.0), 7)}  {sample.provenance_status}"
        )
    lines.append("")
    lines.append(
        f"file-level version invariance: max |R_f(v3.0 frozen) - R_f(v3.1 active)| = "
        f"{result.file_risk_max_delta:.6f}  (mismatches: {len(result.file_risk_mismatches)})"
    )
    if result.file_risk_mismatches:
        for mismatch in result.file_risk_mismatches[:10]:
            lines.append(f"  ! {mismatch}")
    if result.provenance_issues:
        lines.append(f"provenance issues: {', '.join(result.provenance_issues)}")
    lines.append("")

    lines.append("Table 2 - changesets: v3.0 (frozen) vs v3.1 (active)")
    lines.append(
        f"{'changeset':<34}{'files':>6}{'mean':>8}{'max':>8}  {'v3.0 r':>8}{'v3.0 lvl':>11}{'v3.0 score':>11}  "
        f"{'v3.1 r':>8}{'v3.1 lvl':>11}{'v3.1 score':>11}  human"
    )
    lines.append("-" * 118)
    for row in result.changesets:
        lines.append(
            f"{row.id:<34}{row.files:>6}{_fmt(row.mean_risk, 8)}{_fmt(row.max_risk, 8)}  "
            f"{_fmt(row.v30['risk'], 8)}{row.v30['risk_level']:>11}{row.v30['overall_score']:>11}  "
            f"{_fmt(row.v31['risk'], 8)}{row.v31['risk_level']:>11}"
            f"{row.v31['overall_score']:>11}  {row.human_label}"
        )
    lines.append("")

    lines.append("Table 3 - metrics at the 'needs attention' operating point (human >= high is positive)")
    lines.append(f"{'metric':<22}{'v3.0':>10}{'v3.1':>10}{'delta':>10}")
    lines.append("-" * 118)
    for key in ("tp", "fp", "fn", "tn", "precision", "recall", "f1", "coverage"):
        a = result.metrics_v30[key]
        b = result.metrics_v31[key]
        lines.append(f"{key:<22}{_fmt(a, 10)}{_fmt(b, 10)}{_fmt(b - a, 10)}")
    lines.append(
        f"{'units':<22}{result.metrics_v30['units']:>10}{result.metrics_v31['units']:>10}{'':>10}"
    )
    lines.append("")
    lines.append("Table 4 - strict critical operating point")
    lines.append(f"{'metric':<22}{'v3.0':>10}{'v3.1':>10}{'delta':>10}")
    lines.append("-" * 118)
    for key in ("human_critical", "predicted_critical", "tp", "fp", "fn"):
        a = result.critical_v30[key]
        b = result.critical_v31[key]
        lines.append(f"{key:<22}{a:>10}{b:>10}{b - a:>10}")
    lines.append("")
    lines.append("Table 5 - per-sample file-level metrics (version invariant; v3.1 bands vs human labels)")
    for key in ("tp", "fp", "fn", "tn", "precision", "recall", "coverage", "units"):
        lines.append(f"  {key:<12}{_fmt(result.sample_metrics_v31[key], 10)}")
    lines.append("")
    lines.append(
        "Evidence boundary: this fixed, small hand-annotated set demonstrates rule monotonicity and "
        "threshold behaviour only; it does not establish project-level false-positive rates or any "
        "model-quality claim."
    )
    lines.append("=" * 118)
    return "\n".join(lines)


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    result = evaluate()
    report = format_report(result)
    print(report)
    if "--json" in argv:
        payload = {
            "rule_version": RULE_VERSION,
            "dataset_version": result.manifest["dataset_version"],
            "metrics": {"v3_0": result.metrics_v30, "v3_1": result.metrics_v31},
            "critical": {"v3_0": result.critical_v30, "v3_1": result.critical_v31},
            "changesets": [
                {
                    "id": row.id,
                    "files": row.files,
                    "human": row.human_label,
                    "v3_0": row.v30["risk_level"],
                    "v3_1": row.v31["risk_level"],
                }
                for row in result.changesets
            ],
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

