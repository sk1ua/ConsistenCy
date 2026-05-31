#!/usr/bin/env python3
"""Run ConsistenCy ``pr-report`` against every entry in a sampled-PRs manifest.

Workflow:

1. Load ``evaluation/sampled_prs.json`` (or the path passed via ``--manifest``).
2. For each entry, ensure a local clone of ``owner/repo`` exists under
   ``--repos-dir`` (clone if missing, ``git fetch --all`` if present).
3. Best-effort fetch of ``base_ref`` and ``head_ref`` so they resolve.
4. Invoke ``backend/cli.py pr-report --json-output`` and write the result to
   the entry's ``model_report_path`` (auto-derived if absent).
5. Write a ``run_public_pr_reports_summary.json`` describing per-entry status
   so a single failure does not hide successes.

Use ``--dry-run`` to print the planned ``git`` and ``pr-report`` commands
without executing anything; useful for previewing what an unattended run
would do.

Examples
--------
    python evaluation/scripts/run_public_pr_reports.py \\
        --manifest evaluation/sampled_prs.json \\
        --repos-dir evaluation/repos \\
        --results-dir evaluation/results \\
        --limit 50 --dry-run
"""
from __future__ import annotations

import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_CLI = PROJECT_ROOT / "backend" / "cli.py"


# Patterns that look like an API token. Any matching substring is redacted
# before the captured stderr is written to disk, so a misconfigured user
# environment cannot leak credentials into evaluation/results.
_TOKEN_PATTERNS = (
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),                # GitHub PATs
    re.compile(r"github_pat_[A-Za-z0-9_]{20,}"),
    re.compile(r"x-access-token:[A-Za-z0-9_\-]+"),
    re.compile(r"[A-Za-z0-9_\-]{20,}@github\.com"),
)


def _redact(message: str) -> str:
    """Strip token-shaped substrings from captured command output."""
    if not message:
        return message
    redacted = message
    for pattern in _TOKEN_PATTERNS:
        redacted = pattern.sub("***", redacted)
    return redacted


# ---------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------

def _resolve(path: str | Path) -> Path:
    p = Path(path)
    return p if p.is_absolute() else PROJECT_ROOT / p


def _repo_dir_name(repo: str) -> str:
    """Return a filesystem-safe directory name for ``owner/repo``.

    Slashes are replaced with double underscores so a single ``ls`` of
    ``--repos-dir`` shows the original org/repo grouping at a glance.
    """
    return repo.replace("/", "__")


def _autoderived_report_path(entry: dict[str, Any], results_dir: Path) -> Path:
    repo = entry["repo"]
    pr = entry["pr_number"]
    owner, name = repo.split("/", 1) if "/" in repo else (repo, repo)
    return results_dir / f"{owner}__{name}_pr{pr}.json"


def _print_cmd(prefix: str, cmd: list[str]) -> None:
    print(f"{prefix}: {' '.join(shlex.quote(c) for c in cmd)}")


def _run(cmd: list[str], cwd: Path | None, *, dry_run: bool) -> subprocess.CompletedProcess[str]:
    if dry_run:
        _print_cmd("DRY-RUN", cmd)
        return subprocess.CompletedProcess(cmd, 0, "", "")
    return subprocess.run(
        cmd, cwd=str(cwd) if cwd else None,
        capture_output=True, text=True, check=False,
    )


# ---------------------------------------------------------------------------
# Repository management
# ---------------------------------------------------------------------------

def _ensure_repo(repo: str, repos_dir: Path, *, dry_run: bool) -> tuple[Path, str | None]:
    """Clone ``owner/repo`` under ``repos_dir`` or fetch if it already exists.

    Returns ``(path, error)``. ``error`` is None on success.
    """
    target = repos_dir / _repo_dir_name(repo)
    git = shutil.which("git")
    # Dry-run only needs to print the planned commands - it does not actually
    # require the git binary to be on PATH.
    git_label = git or "git"
    if git is None and not dry_run:
        return target, "git executable not found on PATH"

    if not target.exists():
        url = f"https://github.com/{repo}.git"
        cmd = [git_label, "clone", "--quiet", url, str(target)]
        if dry_run:
            _print_cmd("DRY-RUN", cmd)
            return target, None
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            return target, f"git clone failed: {_redact(proc.stderr.strip())}"
        return target, None

    cmd = [git_label, "fetch", "--all", "--tags", "--quiet"]
    if dry_run:
        _print_cmd("DRY-RUN", cmd)
        return target, None
    proc = subprocess.run(cmd, cwd=str(target), capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        return target, f"git fetch failed: {_redact(proc.stderr.strip())}"
    return target, None


def _ensure_ref(repo_path: Path, ref: str, *, dry_run: bool) -> None:
    """Best-effort ``git fetch origin <ref>`` so PR-only refs become available.

    PR head SHAs from public datasets can live on a fork; this fetch will
    silently no-op when the ref is already present and that is fine.
    """
    if not ref:
        return
    git = shutil.which("git")
    if git is None:
        return
    cmd = [git, "fetch", "origin", ref, "--quiet"]
    if dry_run:
        _print_cmd("DRY-RUN", cmd)
        return
    subprocess.run(
        cmd, cwd=str(repo_path),
        capture_output=True, text=True, check=False,
    )


# ---------------------------------------------------------------------------
# Report invocation
# ---------------------------------------------------------------------------

def _generate_report(
    repo_path: Path,
    base_ref: str,
    head_ref: str,
    output_path: Path,
    *,
    dry_run: bool,
) -> str | None:
    """Run ``pr-report --json-output`` and write JSON. Returns error or None."""
    cmd = [
        sys.executable, str(BACKEND_CLI), "pr-report",
        "--repo", str(repo_path),
        "--base", base_ref,
        "--head", head_ref,
        "--json-output",
    ]
    if dry_run:
        _print_cmd("DRY-RUN", cmd)
        _print_cmd("DRY-RUN write", ["<json>", "->", str(output_path)])
        return None
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        details = proc.stderr.strip() or proc.stdout.strip()
        return f"pr-report failed: {_redact(details)}"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(proc.stdout, encoding="utf-8")
    return None


# ---------------------------------------------------------------------------
# Per-entry processing
# ---------------------------------------------------------------------------

def _process_entry(
    entry: dict[str, Any],
    repos_dir: Path,
    results_dir: Path,
    *,
    dry_run: bool,
) -> dict[str, Any]:
    repo = entry.get("repo")
    pr_number = entry.get("pr_number")
    base_ref = entry.get("base_ref")
    head_ref = entry.get("head_ref")

    record: dict[str, Any] = {
        "repo": repo,
        "pr_number": pr_number,
        "status": "skipped",
        "error": None,
        "report_path": None,
    }

    if not repo or pr_number is None or not base_ref or not head_ref:
        record["error"] = (
            "manifest entry missing repo/pr_number/base_ref/head_ref - cannot run pr-report"
        )
        return record

    repo_path, err = _ensure_repo(repo, repos_dir, dry_run=dry_run)
    if err:
        record["status"] = "failed"
        record["error"] = err
        return record

    _ensure_ref(repo_path, base_ref, dry_run=dry_run)
    _ensure_ref(repo_path, head_ref, dry_run=dry_run)

    if entry.get("model_report_path"):
        report_path = _resolve(entry["model_report_path"])
    else:
        report_path = _autoderived_report_path(entry, results_dir)
    record["report_path"] = str(report_path)

    err = _generate_report(
        repo_path, base_ref, head_ref, report_path, dry_run=dry_run,
    )
    if err:
        record["status"] = "failed"
        record["error"] = err
        return record

    record["status"] = "success" if not dry_run else "dry_run"
    return record


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Run ConsistenCy pr-report on every entry in a sampled-PRs "
            "manifest. Failures are recorded but do not abort the batch."
        )
    )
    parser.add_argument(
        "--manifest", default="evaluation/sampled_prs.json",
        help="Manifest path (default: evaluation/sampled_prs.json).",
    )
    parser.add_argument(
        "--repos-dir", default="evaluation/repos",
        help="Where local clones live (default: evaluation/repos).",
    )
    parser.add_argument(
        "--results-dir", default="evaluation/results",
        help="Where reports are written (default: evaluation/results).",
    )
    parser.add_argument(
        "--limit", type=int, default=None,
        help="Process at most this many entries.",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print the clone/fetch/report commands without executing.",
    )
    parser.add_argument(
        "--summary", default="evaluation/results/run_public_pr_reports_summary.json",
        help="Where to write the per-entry status summary.",
    )
    args = parser.parse_args(argv)

    manifest_path = _resolve(args.manifest)
    if not manifest_path.exists():
        print(f"ERROR: manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        print(f"ERROR: invalid JSON in manifest: {exc}", file=sys.stderr)
        return 2
    if not isinstance(manifest, list):
        print("ERROR: manifest must be a JSON list", file=sys.stderr)
        return 2

    repos_dir = _resolve(args.repos_dir)
    results_dir = _resolve(args.results_dir)
    if not args.dry_run:
        repos_dir.mkdir(parents=True, exist_ok=True)
        results_dir.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    success = failed = skipped = dry_run_count = 0
    entries = manifest if args.limit is None else manifest[: args.limit]
    for entry in entries:
        record = _process_entry(
            entry, repos_dir, results_dir, dry_run=args.dry_run,
        )
        rows.append(record)
        if record["status"] == "success":
            success += 1
        elif record["status"] == "failed":
            failed += 1
        elif record["status"] == "dry_run":
            dry_run_count += 1
        else:
            skipped += 1

    summary = {
        "manifest": str(manifest_path),
        "total": len(rows),
        "success": success,
        "failed": failed,
        "skipped": skipped,
        "dry_run": dry_run_count,
        "rows": rows,
    }

    # Always persist the summary - useful for diagnosing dry-run plans too,
    # so reviewers can see exactly what would have run without re-executing.
    summary_path = _resolve(args.summary)
    summary_path.parent.mkdir(parents=True, exist_ok=True)
    summary_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps({k: v for k, v in summary.items() if k != "rows"}, indent=2))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
