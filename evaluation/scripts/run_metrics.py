#!/usr/bin/env python3
"""Compute human-alignment metrics for sampled PR reports."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from engine.evaluation.metrics import (  # noqa: E402
    cohens_kappa,
    mean,
    precision_at_k,
    recall_at_k,
    spearman_rank_correlation,
)

RISK_TO_SCORE = {"low": 0.0, "medium": 0.5, "high": 1.0}


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _resolve(path: str | None) -> Path | None:
    if not path:
        return None
    candidate = Path(path)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def _gold_files(annotations: list[dict[str, Any]]) -> list[str]:
    files: list[str] = []
    for annotation in annotations:
        for filepath in annotation.get("top_risky_files", []):
            if filepath not in files:
                files.append(filepath)
    return files


def _reviewer_touched_files(sample: dict[str, Any], annotations: list[dict[str, Any]]) -> list[str]:
    """Return weak reviewer-attention labels, not gold-standard defects."""
    files = _gold_files(annotations)
    for key in ("reviewer_touched_files", "review_comment_files", "comment_paths"):
        for filepath in sample.get(key, []) or []:
            if filepath and filepath not in files:
                files.append(filepath)
    return files


def _retrieved_evidence_files(report: dict[str, Any], *, k: int) -> list[str]:
    files: list[str] = []
    packs = report.get("retrieval", {}).get("packs", [])
    for pack in packs[:k]:
        pack_file = pack.get("file")
        if pack_file and pack_file not in files:
            files.append(pack_file)
        for item in pack.get("selected_evidence", []):
            candidate = item.get("candidate", {}) if isinstance(item, dict) else {}
            filepath = candidate.get("file")
            if filepath and filepath not in files:
                files.append(filepath)
    return files


def _retrieval_metrics_for_report(
    report: dict[str, Any],
    reviewer_touched_files: list[str],
    *,
    k: int,
) -> dict[str, Any]:
    retrieval = report.get("retrieval") or {}
    summary = retrieval.get("summary") or {}
    packs = retrieval.get("packs") or []
    selected_counts = [
        int((pack.get("compression") or {}).get("selected_count", len(pack.get("selected_evidence", []))))
        for pack in packs
        if isinstance(pack, dict)
    ]
    compression_ratios = [
        float((pack.get("compression") or {}).get("compression_ratio", 0.0))
        for pack in packs
        if isinstance(pack, dict)
    ]
    retrieved_files = _retrieved_evidence_files(report, k=k)
    return {
        "files_with_evidence": int(summary.get("files_with_evidence", sum(1 for count in selected_counts if count > 0))),
        "average_selected_evidence_count": mean(selected_counts),
        "average_compression_ratio": mean(compression_ratios),
        "evidence_recall_at_k": recall_at_k(retrieved_files, reviewer_touched_files, k=k)
        if reviewer_touched_files else None,
        "retrieved_evidence_files": retrieved_files[:k],
    }


def _gold_overall_score(annotations: list[dict[str, Any]]) -> float | None:
    scores = [
        RISK_TO_SCORE[str(annotation.get("overall_risk", "")).lower()]
        for annotation in annotations
        if str(annotation.get("overall_risk", "")).lower() in RISK_TO_SCORE
    ]
    return mean(scores) if scores else None


def _pairwise_kappa(samples: list[dict[str, Any]]) -> float:
    values: list[float] = []
    for sample in samples:
        annotations = sample.get("annotations", [])
        if len(annotations) < 2:
            continue
        first = str(annotations[0].get("overall_risk", ""))
        second = str(annotations[1].get("overall_risk", ""))
        if first and second:
            values.append(cohens_kappa([first], [second]))
    return mean(values)


def evaluate_manifest(manifest_path: Path, *, k: int = 3) -> dict[str, Any]:
    samples = _load_json(manifest_path)
    if not isinstance(samples, list):
        raise ValueError("Manifest must be a JSON list")

    evaluated: list[dict[str, Any]] = []
    predicted_overall: list[float] = []
    gold_overall: list[float] = []
    precision_values: list[float] = []
    recall_values: list[float] = []
    retrieval_recall_values: list[float] = []
    retrieval_compression_values: list[float] = []
    retrieval_selected_values: list[float] = []
    retrieval_files_with_evidence: list[float] = []

    for sample in samples:
        report_path = _resolve(sample.get("model_report_path"))
        annotations = sample.get("annotations", [])
        if not report_path or not report_path.exists() or not annotations:
            continue

        report = _load_json(report_path)
        predicted_files = [
            row.get("file", "")
            for row in report.get("top_risky_files", [])
            if row.get("file")
        ]
        gold_files = _gold_files(annotations)
        reviewer_touched_files = _reviewer_touched_files(sample, annotations)
        gold_score = _gold_overall_score(annotations)
        if gold_score is None:
            continue

        pred_score = float(report.get("avg_risk", 0.0))
        predicted_overall.append(pred_score)
        gold_overall.append(gold_score)
        precision = precision_at_k(predicted_files, gold_files, k=k)
        recall = recall_at_k(predicted_files, gold_files, k=k)
        precision_values.append(precision)
        recall_values.append(recall)
        retrieval_metrics = _retrieval_metrics_for_report(
            report,
            reviewer_touched_files,
            k=k,
        )
        if retrieval_metrics["evidence_recall_at_k"] is not None:
            retrieval_recall_values.append(float(retrieval_metrics["evidence_recall_at_k"]))
        retrieval_compression_values.append(float(retrieval_metrics["average_compression_ratio"]))
        retrieval_selected_values.append(float(retrieval_metrics["average_selected_evidence_count"]))
        retrieval_files_with_evidence.append(float(retrieval_metrics["files_with_evidence"]))
        evaluated.append(
            {
                "repo": sample.get("repo"),
                "pr_number": sample.get("pr_number"),
                "model_report_path": str(report_path.relative_to(PROJECT_ROOT)),
                "predicted_avg_risk": pred_score,
                "gold_overall_risk_score": gold_score,
                "precision_at_k": precision,
                "recall_at_k": recall,
                "retrieval": retrieval_metrics,
                "predicted_top_files": predicted_files[:k],
                "gold_top_files": gold_files,
                "reviewer_touched_files": reviewer_touched_files,
            }
        )

    return {
        "sample_count": len(samples),
        "evaluated_count": len(evaluated),
        "k": k,
        "overall_spearman": spearman_rank_correlation(predicted_overall, gold_overall),
        "mean_precision_at_k": mean(precision_values),
        "mean_recall_at_k": mean(recall_values),
        "retrieval": {
            "average_compression_ratio": mean(retrieval_compression_values),
            "average_selected_evidence_count": mean(retrieval_selected_values),
            "files_with_evidence": int(sum(retrieval_files_with_evidence)),
            "evidence_recall_at_k": mean(retrieval_recall_values) if retrieval_recall_values else None,
            "false_evidence_rate": None,
            "evidence_usefulness_score": None,
        },
        "pairwise_cohens_kappa": _pairwise_kappa(samples),
        "samples": evaluated,
    }


def _format_metric(value: Any, fmt: str = "{:.3f}") -> str:
    """Render a numeric metric, returning ``n/a`` for missing/uncomputable values.

    Spearman / kappa return 0.0 when there are not enough samples - that
    technically renders fine, but the README needs to make absent measurements
    obviously absent rather than implausibly precise zeros. Callers pass
    ``None`` (or NaN) to flag genuine absence.
    """
    if value is None:
        return "n/a"
    try:
        f = float(value)
    except (TypeError, ValueError):
        return "n/a"
    if f != f:  # NaN
        return "n/a"
    return fmt.format(f)


def render_markdown(summary: dict[str, Any]) -> str:
    """Build the README-ready Markdown table for a metrics summary.

    Metrics that could not be computed because the sample set is too thin
    (e.g. fewer than two evaluated samples for Spearman) are rendered as
    ``n/a`` rather than misleadingly small numbers.
    """
    k = summary.get("k", 3)
    sample_count = summary.get("sample_count", 0)
    evaluated = summary.get("evaluated_count", 0)

    if evaluated < 2:
        spearman_value: Any = None
        kappa_value: Any = None
    else:
        spearman_value = summary.get("overall_spearman")
        kappa_value = summary.get("pairwise_cohens_kappa")

    precision = (
        summary.get("mean_precision_at_k") if evaluated > 0 else None
    )
    recall = summary.get("mean_recall_at_k") if evaluated > 0 else None
    retrieval = summary.get("retrieval", {})
    evidence_recall = retrieval.get("evidence_recall_at_k") if evaluated > 0 else None
    avg_compression = retrieval.get("average_compression_ratio") if evaluated > 0 else None
    avg_selected = retrieval.get("average_selected_evidence_count") if evaluated > 0 else None
    files_with_evidence = retrieval.get("files_with_evidence") if evaluated > 0 else None

    lines = [
        "# ConsistenCy Public PR Evaluation",
        "",
        "| Metric | Value |",
        "|---|---:|",
        f"| Samples | {sample_count} |",
        f"| Evaluated | {evaluated} |",
        f"| Precision@{k} | {_format_metric(precision)} |",
        f"| Recall@{k} | {_format_metric(recall)} |",
        f"| Evidence Recall@{k} | {_format_metric(evidence_recall)} |",
        f"| Average Compression Ratio | {_format_metric(avg_compression)} |",
        f"| Average Selected Evidence Count | {_format_metric(avg_selected)} |",
        f"| Files With Evidence | {_format_metric(files_with_evidence, '{:.0f}')} |",
        "| False Evidence Rate | n/a |",
        "| Evidence Usefulness Score | n/a |",
        f"| Spearman | {_format_metric(spearman_value)} |",
        f"| Cohen's Kappa | {_format_metric(kappa_value)} |",
        "",
        "## Notes",
        "",
        "- Labels are weak labels derived from public human review comments.",
        "- Public review comments are weak supervision for reviewer-attention "
        "alignment, not gold-standard defect labels.",
        "- False Evidence Rate and Evidence Usefulness Score stay n/a without "
        "a separate manual audit.",
        "- Samples marked needs_manual_audit can still be used for the "
        "automatic weak-label benchmark; manual audit is only required for "
        "stronger gold-standard research claims.",
        "- SemanticAgent uses AST/API/control-flow proxy signals, not formal "
        "semantic equivalence.",
        "- Multi-agent means deterministic specialist analyzers plus consensus "
        "coordination.",
        "",
    ]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="evaluation/sampled_prs.json")
    parser.add_argument("--output", default="evaluation/results/metrics_summary.json")
    parser.add_argument(
        "--markdown-output", default=None,
        help="Optional path to write a README-ready Markdown summary table.",
    )
    parser.add_argument("--k", type=int, default=3)
    args = parser.parse_args()

    summary = evaluate_manifest(_resolve(args.manifest) or Path(args.manifest), k=args.k)
    output_path = _resolve(args.output) or Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")

    if args.markdown_output:
        md_path = _resolve(args.markdown_output) or Path(args.markdown_output)
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(render_markdown(summary), encoding="utf-8")

    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
