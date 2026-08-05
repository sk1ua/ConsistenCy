#!/usr/bin/env python3
"""Run ConsistenCy deterministic analysis on bounded repository-local source files."""

from __future__ import annotations

import argparse
from contextlib import redirect_stdout
import json
import os
from pathlib import Path
import sys
from typing import Iterable


ALLOWED_SUFFIXES = {".py", ".js", ".jsx", ".ts", ".tsx"}
EXCLUDED_DIRECTORIES = {
    ".consistency",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    ".venv",
    "__pycache__",
    "build",
    "dist",
    "node_modules",
    "output",
    "playwright-report",
    "test-results",
}
SECRET_BASENAMES = {
    ".env",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "config.key",
    "id_ed25519",
    "id_rsa",
    "secrets.enc.json",
}
MAX_FILES = 64
MAX_FILE_BYTES = 1_000_000
MAX_TOTAL_BYTES = 4_000_000


class InputError(ValueError):
    """A safe, user-actionable input validation error."""


def repository_root() -> Path:
    for candidate in Path(__file__).resolve().parents:
        if (candidate / "pyproject.toml").is_file() and (candidate / "engine").is_dir():
            return candidate
    raise RuntimeError("Could not locate the ConsistenCy repository root")


def is_secret_path(relative: Path) -> bool:
    lowered_parts = [part.lower() for part in relative.parts]
    if any(part in EXCLUDED_DIRECTORIES for part in lowered_parts):
        return True
    if any(
        lowered_parts[index : index + 2] == ["evaluation", "repos"]
        for index in range(max(0, len(lowered_parts) - 1))
    ):
        return True
    name = relative.name.lower()
    return (
        name in SECRET_BASENAMES
        or name.startswith(".env.")
        or name.endswith((".pem", ".p12", ".pfx"))
        or name.startswith("secret.")
        or name.startswith("secrets.")
    )


def resolve_input(root: Path, raw_path: str) -> Path:
    if "\x00" in raw_path:
        raise InputError("Input paths may not contain NUL bytes")
    candidate = Path(raw_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    try:
        resolved = candidate.resolve(strict=True)
    except OSError as error:
        raise InputError(f"Input does not exist or cannot be resolved: {raw_path}") from error
    if not resolved.is_relative_to(root):
        raise InputError(f"Input escapes the repository: {raw_path}")
    relative = resolved.relative_to(root)
    if is_secret_path(relative):
        raise InputError(f"Input is an excluded secret or generated path: {relative.as_posix()}")
    return resolved


def validate_source_file(root: Path, path: Path, *, explicit: bool) -> Path | None:
    try:
        resolved = path.resolve(strict=True)
    except OSError as error:
        if explicit:
            raise InputError(f"Source file cannot be resolved: {path}") from error
        return None
    if not resolved.is_file() or not resolved.is_relative_to(root):
        if explicit:
            raise InputError(f"Source file is not a regular repository-local file: {path}")
        return None
    relative = resolved.relative_to(root)
    if is_secret_path(relative):
        if explicit:
            raise InputError(f"Source file is excluded: {relative.as_posix()}")
        return None
    if resolved.suffix.lower() not in ALLOWED_SUFFIXES:
        if explicit:
            allowed = ", ".join(sorted(ALLOWED_SUFFIXES))
            raise InputError(f"Unsupported source type for {relative.as_posix()}; allowed: {allowed}")
        return None
    if resolved.stat().st_size > MAX_FILE_BYTES:
        if explicit:
            raise InputError(f"Source file exceeds the {MAX_FILE_BYTES}-byte limit: {relative.as_posix()}")
        return None
    return resolved


def walk_sources(root: Path, directory: Path) -> Iterable[Path]:
    for current, directory_names, file_names in os.walk(directory, topdown=True, followlinks=False):
        current_path = Path(current).resolve()
        if not current_path.is_relative_to(root):
            directory_names[:] = []
            continue
        kept_directories: list[str] = []
        for name in directory_names:
            child = current_path / name
            try:
                relative = child.resolve(strict=True).relative_to(root)
            except (OSError, ValueError):
                continue
            if not is_secret_path(relative):
                kept_directories.append(name)
        directory_names[:] = kept_directories
        for name in file_names:
            selected = validate_source_file(root, current_path / name, explicit=False)
            if selected is not None:
                yield selected


def collect_sources(root: Path, raw_paths: list[str]) -> list[Path]:
    selected: dict[str, Path] = {}
    for raw_path in raw_paths:
        resolved = resolve_input(root, raw_path)
        candidates = (
            [validate_source_file(root, resolved, explicit=True)]
            if resolved.is_file()
            else walk_sources(root, resolved)
        )
        for candidate in candidates:
            if candidate is None:
                continue
            relative = candidate.relative_to(root).as_posix()
            selected[relative] = candidate
            if len(selected) > MAX_FILES:
                raise InputError(f"Selection exceeds the {MAX_FILES}-file limit; choose narrower paths")

    if not selected:
        raise InputError("No supported source files were selected")

    total_bytes = sum(path.stat().st_size for path in selected.values())
    if total_bytes > MAX_TOTAL_BYTES:
        raise InputError(f"Selection exceeds the {MAX_TOTAL_BYTES}-byte total limit; choose narrower paths")
    return [selected[key] for key in sorted(selected)]


def load_files(root: Path, paths: list[Path]):
    from engine.protocol import FileInput

    inputs = []
    for path in paths:
        relative = path.relative_to(root).as_posix()
        try:
            content = path.read_text(encoding="utf-8")
        except UnicodeDecodeError as error:
            raise InputError(f"Source file is not valid UTF-8: {relative}") from error
        except OSError as error:
            raise InputError(f"Source file could not be read: {relative}") from error
        inputs.append(FileInput(path=relative, content=content))
    return inputs


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Analyze bounded repository-local source files without executing them."
    )
    parser.add_argument("paths", nargs="+", help="Repository-local source files or directories")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = repository_root()
    sys.path.insert(0, str(root))

    try:
        paths = collect_sources(root, args.paths)
        from engine.protocol import AnalyzeRequest
        from engine.runner import run_analysis

        request = AnalyzeRequest(
            id="codex-direct-analysis",
            action="analyze",
            files=load_files(root, paths),
            options={
                "agents": ["style", "structural", "semantic", "duplication", "security"],
                "include_evidence_pack": False,
            },
        )
        with redirect_stdout(sys.stderr):
            response = run_analysis(request)
        payload = response.to_dict()
        payload["selection"] = {
            "files": [path.relative_to(root).as_posix() for path in paths],
            "file_count": len(paths),
            "total_bytes": sum(path.stat().st_size for path in paths),
        }
        json.dump(payload, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
        sys.stdout.write("\n")
        return 0 if response.ok else 1
    except InputError as error:
        print(f"Input rejected: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
