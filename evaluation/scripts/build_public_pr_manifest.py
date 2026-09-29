#!/usr/bin/env python3
"""Build evaluation/sampled_prs.json from a public PR data source.

Primary target: ``foundry-ai/swe-prbench`` on HuggingFace - a public AI
code-review benchmark with real GitHub PRs, human review comments and
base/head commits. The same script also accepts a local JSON / JSONL file
so reviewers can curate their own data without an HF dependency.

This is intentionally narrow: it does NOT try to ingest the 13M-row Kaggle
PR-comments dump or Review4Repair (which targets review-comment-aided
repair, not PR risky-file ranking). Both are strictly worse first targets
than SWE-PRBench for our metric set (Precision@k, Recall@k, Spearman).

Examples
--------

    # SWE-PRBench (primary)
    python evaluation/scripts/build_public_pr_manifest.py \\
        --hf-dataset foundry-ai/swe-prbench \\
        --output evaluation/sampled_prs.json \\
        --limit 50 --languages py,js,jsx,ts,tsx

    # Local JSONL/JSON (secondary, for hand-curated data)
    python evaluation/scripts/build_public_pr_manifest.py \\
        --input evaluation/data/public_prs.jsonl \\
        --output evaluation/sampled_prs.json \\
        --limit 50 --languages py,js,jsx,ts,tsx
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable

PROJECT_ROOT = Path(__file__).resolve().parents[2]


# ---------------------------------------------------------------------------
# Field-name normalization helpers
# ---------------------------------------------------------------------------

# Every normalized field maps to a list of accepted aliases. Aliases may use
# a dotted path to dive into nested objects (e.g. ``base.sha``); see
# ``get_first`` below.
_ALIASES: dict[str, list[str]] = {
    "repo": [
        "repo",
        "repository",
        "repo_name",
        "repository_name",
        "repo_full_name",
        "repository.full_name",
        "repo.full_name",
    ],
    "pr_number": [
        "pr_number",
        "pull_number",
        "number",
        "pull_request_number",
        "pull_request.number",
    ],
    "base_ref": [
        "base_commit",
        "base_sha",
        "base_ref",
        "base",
        "base.sha",
        "base_commit_sha",
    ],
    "head_ref": [
        "head_commit",
        "head_sha",
        "head_ref",
        "head",
        "head.sha",
        "head_commit_sha",
    ],
    "changed_files": [
        "changed_files",
        "files",
        "file_paths",
        "files_changed",
    ],
    "review_comments": [
        "human_review_comments",
        "review_comments",
        "comments",
        "reviews",
    ],
    "has_requested_changes": [
        "has_requested_changes",
        "requested_changes",
        "changes_requested",
    ],
}


def get_first(record: dict[str, Any], aliases: Iterable[str], default: Any = None) -> Any:
    """Return the first present alias value, supporting dotted nested paths.

    ``aliases`` is checked in order. ``"a.b"`` looks up ``record["a"]["b"]``.
    Lookups are case-insensitive at every step. A scalar fall-through is
    intentional: ``base = "deadbeef"`` returns the SHA string when the alias
    is just ``"base"``, even though ``"base.sha"`` is also a valid alias.

    A leaf that resolves to a dict or a list is treated as **not a hit** and
    we continue to the next alias. This is what makes the SWE-PRBench shape
    work: ``record["repository"]`` is the dict ``{"full_name": "..."}``, but
    we want ``record["repository"]["full_name"]`` to be returned by the
    ``"repository.full_name"`` alias, not the parent dict by ``"repository"``.
    """
    if not isinstance(record, dict):
        return default
    for alias in aliases:
        parts = alias.split(".")
        cur: Any = record
        for i, part in enumerate(parts):
            if cur is None:
                cur = None
                break
            if isinstance(cur, dict):
                lower = {k.lower(): v for k, v in cur.items()}
                if part.lower() in lower:
                    cur = lower[part.lower()]
                else:
                    cur = None
                    break
            else:
                if i == len(parts) - 1:
                    return cur
                cur = None
                break
        # Reject container hits and empty strings - they are almost certainly
        # the wrong leaf (e.g. an alias matched a parent container).
        if cur is None or cur == "":
            continue
        if isinstance(cur, dict):
            continue
        if isinstance(cur, list) and not cur:
            continue
        return cur
    return default


def _normalize_languages(raw: str) -> tuple[str, ...]:
    """Parse the ``--languages`` flag value into a normalized suffix tuple.

    ``py,JS,.ts,,tsx`` becomes ``(".py", ".js", ".ts", ".tsx")``.
    """
    out: list[str] = []
    for part in (raw or "").split(","):
        ext = part.strip().lower().lstrip(".")
        if ext:
            out.append("." + ext)
    return tuple(out)


def _file_matches_language(path: str, allowed: tuple[str, ...]) -> bool:
    if not allowed:
        return True
    p = path.lower()
    return any(p.endswith(ext) for ext in allowed)


# ---------------------------------------------------------------------------
# Weak-label inference
# ---------------------------------------------------------------------------

def _comment_paths(comments: Any) -> list[str]:
    """Extract file paths mentioned in review comments.

    Handles both list-of-dict and list-of-string shapes; the dict shape may
    use any of ``path`` / ``file`` / ``filename`` / ``file_path`` for the
    path.
    """
    if not isinstance(comments, list):
        return []
    out: list[str] = []
    for c in comments:
        if isinstance(c, dict):
            for key in ("path", "file", "filename", "file_path"):
                value = c.get(key)
                if isinstance(value, str) and value:
                    out.append(value)
                    break
    return out


def _changed_file_paths(files: Any) -> list[str]:
    """Extract file paths from a ``changed_files`` payload.

    Accepts ``[{"filename": "x.py"}, ...]``, ``["x.py", ...]``, or dicts
    with ``path``/``file``/``file_path`` keys.
    """
    if not isinstance(files, list):
        return []
    out: list[str] = []
    for entry in files:
        if isinstance(entry, str):
            out.append(entry)
        elif isinstance(entry, dict):
            for key in ("filename", "path", "file", "file_path"):
                value = entry.get(key)
                if isinstance(value, str) and value:
                    out.append(value)
                    break
    return out


def _dedupe_keep_order(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in items:
        if item not in seen:
            seen.add(item)
            out.append(item)
    return out


def _infer_top_risky_files(
    comments: Any,
    changed_files: Any,
    allowed_exts: tuple[str, ...],
) -> list[str]:
    """Pick reviewer-flagged paths first, falling back to all changed files."""
    paths = _comment_paths(comments)
    if not paths:
        paths = _changed_file_paths(changed_files)
    paths = _dedupe_keep_order(paths)
    return [p for p in paths if _file_matches_language(p, allowed_exts)]


def _infer_overall_risk(comments: Any, has_requested_changes: Any) -> str | None:
    """Map review-comment volume / requested-changes flag to a weak risk label.

    Returns ``None`` when there is nothing to label - the caller treats that
    as "skip this sample" rather than emitting a noisy entry.
    """
    if has_requested_changes is True:
        return "high"
    n = len(comments) if isinstance(comments, list) else 0
    if n >= 5:
        return "high"
    if n >= 2:
        return "medium"
    if n == 1:
        return "low"
    return None


# Keyword heuristics for ``reason_categories``. These are deliberately
# coarse: the goal is to give downstream consumers a coarse grouping so they
# can sort by likely risk type, not to claim category precision.
_REASON_KEYWORDS: list[tuple[str, tuple[str, ...]]] = [
    ("security",  ("token", "password", "secret", "injection", "xss", "csrf",
                   "auth", "permission")),
    ("semantic",  ("bug", "logic", "behavior", "incorrect", "wrong",
                   "edge case", "null", "none")),
    ("structure", ("coupling", "dependency", "import", "interface",
                   "abstraction", "class")),
    ("style",     ("naming", "format", "style", "comment", "docstring")),
    ("test",      ("test", "coverage", "fixture", "mock")),
]


def _comment_body(comment: Any) -> str:
    """Return a comment's text body across the common shapes."""
    if isinstance(comment, str):
        return comment
    if isinstance(comment, dict):
        for key in ("body", "text", "comment", "message", "content"):
            value = comment.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


def _infer_reason_categories(comments: Any) -> list[str]:
    """Assign coarse categories based on keywords in the review-comment text.

    Categories are deduplicated and returned in the order of the rule list
    so the output is stable across runs. Falls back to
    ``["review_comment"]`` when nothing matches - that is still useful
    information ("there are comments, but they were not parseable into a
    category we recognise").
    """
    if not isinstance(comments, list) or not comments:
        return ["review_comment"]
    haystack_parts: list[str] = []
    for c in comments:
        body = _comment_body(c).lower()
        if body:
            haystack_parts.append(body)
    haystack = "\n".join(haystack_parts)
    matches: list[str] = []
    for category, keywords in _REASON_KEYWORDS:
        for kw in keywords:
            if kw in haystack:
                matches.append(category)
                break
    return matches or ["review_comment"]


# ---------------------------------------------------------------------------
# Skip-reason counters
# ---------------------------------------------------------------------------

# Pre-defined keys so the summary always shows the full picture, including
# zeros - reviewers can spot "all my samples skipped because of X" instantly.
_SKIP_REASONS = (
    "missing_repo",
    "missing_pr_number",
    "missing_base_or_head",
    "missing_review_comments",
    "no_supported_files",
    "invalid_record",
)


def _new_skip_counter() -> dict[str, int]:
    return {reason: 0 for reason in _SKIP_REASONS}


# ---------------------------------------------------------------------------
# Manifest building core
# ---------------------------------------------------------------------------

def _normalize_record(
    raw: Any,
    allowed_exts: tuple[str, ...],
    *,
    source_dataset: str | None = None,
) -> tuple[dict[str, Any] | None, str | None]:
    """Convert a raw record to a manifest entry.

    Returns a ``(entry, skip_reason)`` tuple. Exactly one of the two is
    None: a successful normalization yields ``(entry, None)``, while a
    skip yields ``(None, "missing_repo" | ...)`` so callers can roll up
    counters in the run summary.
    """
    if not isinstance(raw, dict):
        return None, "invalid_record"

    repo = get_first(raw, _ALIASES["repo"])
    if not repo:
        return None, "missing_repo"

    pr_number = get_first(raw, _ALIASES["pr_number"])
    if pr_number is None:
        return None, "missing_pr_number"

    base_ref = get_first(raw, _ALIASES["base_ref"])
    head_ref = get_first(raw, _ALIASES["head_ref"])
    if not base_ref or not head_ref:
        return None, "missing_base_or_head"

    comments = get_first(raw, _ALIASES["review_comments"], default=[]) or []
    has_requested = get_first(raw, _ALIASES["has_requested_changes"])
    overall_risk = _infer_overall_risk(comments, has_requested)
    if overall_risk is None:
        return None, "missing_review_comments"

    changed_files = get_first(raw, _ALIASES["changed_files"], default=[]) or []
    top_risky = _infer_top_risky_files(comments, changed_files, allowed_exts)
    if not top_risky:
        return None, "no_supported_files"

    reason_categories = _infer_reason_categories(comments)
    safe_repo = str(repo).replace("/", "__")
    model_report_path = (
        f"evaluation/results/{safe_repo}_pr{pr_number}_report.json"
    )

    entry: dict[str, Any] = {
        "repo": str(repo),
        "pr_number": int(pr_number),
        "base_ref": str(base_ref),
        "head_ref": str(head_ref),
        "model_report_path": model_report_path,
        "annotations": [
            {
                "annotator": "public_review_weak_label",
                "overall_risk": overall_risk,
                "top_risky_files": top_risky,
                "reason_categories": reason_categories,
                "notes": (
                    "Weak label derived from public human review comments; "
                    "manual audit is only required for stronger research claims."
                ),
            }
        ],
        "label_source": "public_review_comments",
        "needs_manual_audit": True,
    }
    if source_dataset:
        entry["source_dataset"] = source_dataset
    return entry, None


def _iter_jsonl(path: Path) -> Iterable[dict[str, Any]]:
    """Yield one dict per line for JSONL, or every element for JSON arrays.

    The script accepts either format under ``--input`` so users can drop
    in whatever the upstream dataset provides without preprocessing.
    """
    text = path.read_text(encoding="utf-8")
    text_stripped = text.lstrip()
    if text_stripped.startswith("["):
        data = json.loads(text)
        if not isinstance(data, list):
            raise ValueError(f"Top-level JSON in {path} must be a list of records")
        for item in data:
            if isinstance(item, dict):
                yield item
        return
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL line in {path}: {exc}") from exc
        if isinstance(obj, dict):
            yield obj


def _iter_hf(dataset: str, split: str, config: str | None = None) -> Iterable[dict[str, Any]]:
    """Stream a HuggingFace dataset record-by-record.

    Parameters
    ----------
    dataset : str
        HF dataset name (e.g. ``foundry-ai/swe-prbench``).
    split : str
        Split name (e.g. ``train``). When the dataset requires a config
        (sub-dataset), ``split`` is passed as the config name instead.
    config : str | None
        Explicit config name override. When set, ``load_dataset(name=config,
        split=split)`` is used. When None (default), the legacy signature
        ``load_dataset(name, split=split)`` is used where the dataset name
        acts as both dataset and config.

    Imports lazily so the script works without ``datasets`` installed; the
    failure path emits the exact short message in the task spec, not a long
    Python traceback.
    """
    try:
        from datasets import load_dataset  # type: ignore
    except ImportError:
        message = (
            "Missing optional dependency: datasets\n"
            "Install with:\n"
            "python -m pip install datasets"
        )
        print(message, file=sys.stderr)
        raise SystemExit(2)

    if config:
        # Load a specific config (sub-dataset) within the dataset, e.g.
        # load_dataset('foundry-ai/swe-prbench', 'prs', split='train')
        ds = load_dataset(dataset, config, split=split, streaming=True)
    else:
        ds = load_dataset(dataset, split=split, streaming=True)

    for row in ds:
        if isinstance(row, dict):
            yield row


def build_manifest(
    records: Iterable[Any],
    *,
    limit: int | None,
    allowed_exts: tuple[str, ...],
    source_dataset: str | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Run records through normalization and return the manifest plus stats."""
    written: list[dict[str, Any]] = []
    skipped = _new_skip_counter()
    read_count = 0

    for raw in records:
        read_count += 1
        if limit is not None and len(written) >= limit:
            break
        entry, reason = _normalize_record(
            raw, allowed_exts, source_dataset=source_dataset,
        )
        if entry is None:
            assert reason in skipped, f"unknown skip reason: {reason!r}"
            skipped[reason] += 1
            continue
        written.append(entry)

    return written, {
        "read_count": read_count,
        "written_count": len(written),
        "skipped_count": sum(skipped.values()),
        "skipped_by_reason": skipped,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _resolve(path: str) -> Path:
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Build evaluation/sampled_prs.json from a local PR data file or a "
            "HuggingFace dataset (primary target: foundry-ai/swe-prbench)."
        )
    )
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument(
        "--input",
        help="Path to a local JSON or JSONL file with PR records.",
    )
    src.add_argument(
        "--hf-dataset",
        help=(
            "HuggingFace dataset name (requires `pip install datasets`). "
            "Recommended: foundry-ai/swe-prbench"
        ),
    )
    parser.add_argument(
        "--hf-split", default="train",
        help="HuggingFace dataset split (default: train).",
    )
    parser.add_argument(
        "--hf-config", default=None,
        help=(
            "HuggingFace dataset config / sub-dataset name. "
            "Required for datasets like foundry-ai/swe-prbench that have "
            "multiple configs (e.g. prs, eval_split)."
        ),
    )
    parser.add_argument(
        "--output", default="evaluation/sampled_prs.json",
        help="Output manifest path (default: evaluation/sampled_prs.json).",
    )
    parser.add_argument(
        "--limit", type=int, default=50,
        help="Maximum number of samples to write (default: 50).",
    )
    parser.add_argument(
        "--languages", default="py,js,jsx,ts,tsx",
        help="Comma-separated file extensions to keep "
             "(default: py,js,jsx,ts,tsx).",
    )
    parser.add_argument(
        "--source-dataset", default=None,
        help="Override the source_dataset field stamped onto each entry. "
             "Defaults to the --hf-dataset value when --hf-dataset is used.",
    )
    args = parser.parse_args(argv)

    allowed_exts = _normalize_languages(args.languages)
    source_dataset = args.source_dataset

    if args.input:
        input_path = _resolve(args.input)
        if not input_path.exists():
            print(f"ERROR: input file not found: {input_path}", file=sys.stderr)
            return 2
        records = _iter_jsonl(input_path)
        source_label = str(input_path)
    else:
        if source_dataset is None:
            source_dataset = args.hf_dataset
        records = _iter_hf(args.hf_dataset, args.hf_split, config=args.hf_config)
        source_label = f"hf:{args.hf_dataset}#{args.hf_config or args.hf_split}"

    manifest, stats = build_manifest(
        records,
        limit=args.limit,
        allowed_exts=allowed_exts,
        source_dataset=source_dataset,
    )

    output_path = _resolve(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    summary = {
        "source": source_label,
        "read_count": stats["read_count"],
        "skipped_count": stats["skipped_count"],
        "written_count": stats["written_count"],
        "language_filter": list(allowed_exts),
        "output_path": str(output_path),
        "skipped_by_reason": stats["skipped_by_reason"],
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
