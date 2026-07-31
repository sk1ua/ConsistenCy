"""Run a no-Git ConsistenCy analysis demo using the V2 Python Engine protocol."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from engine.protocol import AnalyzeRequest, FileInput  # noqa: E402
from engine.runner import run_analysis  # noqa: E402


def main() -> None:
    base = (ROOT / "examples" / "demo_base.py").read_text(encoding="utf-8")
    new = (ROOT / "examples" / "demo_new.py").read_text(encoding="utf-8")

    response = run_analysis(
        AnalyzeRequest(
            id="example_multi_agent",
            action="analyze",
            files=[
                FileInput(
                    path="examples/demo_new.py",
                    content=new,
                    baseline=base,
                    language="python",
                )
            ],
        )
    )

    if not response.ok:
        raise RuntimeError(response.error or "Analysis failed")

    data = response.to_dict()
    files = data.get("files", [])
    highest_risk = max(files, key=lambda item: item.get("risk_score", 0), default=None)
    finding_count = sum(len(item.get("findings", [])) for item in files)

    print("ConsistenCy V2 engine analysis demo")
    print("===================================")
    print(f"Status: {'ok' if data.get('ok') else 'error'}")
    print(f"Files Analyzed: {len(files)}")
    print(
        "Highest Risk: "
        f"{highest_risk['risk_score']:.3f} ({highest_risk['risk_label']})"
        if highest_risk
        else "Highest Risk: n/a"
    )
    print(f"Findings Count: {finding_count}")

    print("\nJSON Output:")
    print(json.dumps(data, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
