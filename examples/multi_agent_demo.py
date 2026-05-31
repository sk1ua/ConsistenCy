"""Run a no-Git ConsistenCy multi-agent collaboration demo."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
if str(BACKEND) not in sys.path:
    sys.path.insert(0, str(BACKEND))

from src.pipeline import analyze_sources  # noqa: E402


def ascii_safe(value: object) -> str:
    """Make demo output readable in Windows terminals and CI logs."""
    text = (
        str(value)
        .replace("\u2192", "->")
        .replace("\u2014", "-")
        .replace("\u2013", "-")
        .replace("\u0394", "Delta")
    )
    return text.encode("ascii", errors="replace").decode("ascii")


def main() -> None:
    base = (ROOT / "examples" / "demo_base.py").read_text(encoding="utf-8")
    new = (ROOT / "examples" / "demo_new.py").read_text(encoding="utf-8")

    result = analyze_sources(new, base, filepath="examples/demo_new.py")
    board = result["agent_collaboration"]

    print("ConsistenCy multi-agent demo")
    print("============================")
    print(f"Risk score: {result['risk_score']:.3f} ({result['risk_level']})")
    print(
        "Agent board: "
        f"{board['decision']} "
        f"(score={board['consensus_score']:.3f}, confidence={board['confidence']:.2f})"
    )
    print(f"Quorum: {board['quorum']}")
    print("\nReview queue:")
    for item in board["review_queue"]:
        print(f"- {item['owner']} -> {item['scope']}: {ascii_safe(item['focus'])}")

    print("\nTop findings:")
    for finding in board["top_findings"][:5]:
        evidence = ascii_safe("; ".join(finding.get("evidence", [])[:2]))
        print(f"- [{finding['severity']}] {finding['agent_name']}: {evidence}")

    print("\nJSON excerpt:")
    print(
        json.dumps(
            {
                "risk_score": result["risk_score"],
                "risk_level": result["risk_level"],
                "agent_collaboration": board,
            },
            indent=2,
        )[:3000]
    )


if __name__ == "__main__":
    main()
