#!/usr/bin/env python3
"""Run report-level signal ablations for sampled PR reports."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from engine.evaluation.ablation import DEFAULT_ABLATIONS, ablate_report  # noqa: E402


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _resolve(path: str | None) -> Path | None:
    if not path:
        return None
    candidate = Path(path)
    return candidate if candidate.is_absolute() else PROJECT_ROOT / candidate


def run_ablation_manifest(manifest_path: Path) -> dict[str, Any]:
    samples = _load_json(manifest_path)
    if not isinstance(samples, list):
        raise ValueError("Manifest must be a JSON list")

    rows: list[dict[str, Any]] = []
    for sample in samples:
        report_path = _resolve(sample.get("model_report_path"))
        if not report_path or not report_path.exists():
            continue
        report = _load_json(report_path)
        variants = []
        for config in DEFAULT_ABLATIONS:
            ablated = ablate_report(report, config)
            variants.append(
                {
                    "ablation": config.name,
                    "avg_risk": ablated["avg_risk"],
                    "top_files": [
                        {
                            "file": item.get("file"),
                            "ablated_score": item.get("ablated_score"),
                            "dominant_signals": item.get("dominant_signals", []),
                        }
                        for item in ablated["top_risky_files"][:5]
                    ],
                    "note": ablated["note"],
                }
            )
        rows.append(
            {
                "repo": sample.get("repo"),
                "pr_number": sample.get("pr_number"),
                "model_report_path": str(report_path.relative_to(PROJECT_ROOT)),
                "variants": variants,
            }
        )

    return {
        "sample_count": len(samples),
        "evaluated_count": len(rows),
        "ablation_count": len(DEFAULT_ABLATIONS),
        "samples": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest", default="evaluation/sampled_prs.json")
    parser.add_argument("--output", default="evaluation/results/ablation_summary.json")
    args = parser.parse_args()

    summary = run_ablation_manifest(_resolve(args.manifest) or Path(args.manifest))
    output_path = _resolve(args.output) or Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
