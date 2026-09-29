"""Dataset loading helpers for reviewer-alignment experiments."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


def load_sampled_prs(path: str | Path) -> list[dict[str, Any]]:
    """Load a sampled PR manifest from JSON."""

    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError("sampled PR dataset must be a JSON list")
    return data
