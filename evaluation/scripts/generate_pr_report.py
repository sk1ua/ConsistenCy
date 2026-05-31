#!/usr/bin/env python3
"""Generate one PR risk report JSON for an already cloned repository."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND = PROJECT_ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from src.pipeline import AnalysisPipeline  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True, help="Path to the cloned target repository")
    parser.add_argument("--base", required=True, help="Base ref")
    parser.add_argument("--head", required=True, help="Head ref")
    parser.add_argument("--output", required=True, help="Path for report JSON")
    parser.add_argument("--baseline-n", type=int, default=50)
    parser.add_argument("--max-commits", type=int, default=40)
    args = parser.parse_args()

    pipeline = AnalysisPipeline(args.repo)
    report = pipeline.pr_risk_report(
        base_ref=args.base,
        head_ref=args.head,
        baseline_n=args.baseline_n,
        max_commits=args.max_commits,
    )
    output_path = Path(args.output)
    if not output_path.is_absolute():
        output_path = PROJECT_ROOT / output_path
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(f"Wrote {output_path}")


if __name__ == "__main__":
    main()
