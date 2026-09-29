#!/usr/bin/env python3
"""Expand sampled_prs.json with curated merged PRs from selected repos."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import urllib.parse
import urllib.request

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _request_json(url: str) -> dict[str, Any]:
    headers = {"User-Agent": "ConsistenCy-eval"}
    token = os.environ.get("GITHUB_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _search_issues(query: str, page: int, per_page: int) -> list[dict[str, Any]]:
    params = {"q": query, "page": page, "per_page": per_page}
    url = "https://api.github.com/search/issues?" + urllib.parse.urlencode(params)
    data = _request_json(url)
    return data.get("items", [])


def _fetch_pr(repo: str, number: int) -> dict[str, Any]:
    url = f"https://api.github.com/repos/{repo}/pulls/{number}"
    return _request_json(url)


def _load_manifest(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return data if isinstance(data, list) else []


def _save_manifest(path: Path, data: list[dict[str, Any]]) -> None:
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def _existing_keys(items: list[dict[str, Any]]) -> set[tuple[str, int]]:
    return {(item.get("repo", ""), int(item.get("pr_number", 0))) for item in items}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--target", type=int, default=30)
    parser.add_argument("--output", default="evaluation/sampled_prs.json")
    parser.add_argument("--max-pages", type=int, default=4)
    parser.add_argument(
        "--repos",
        default="pallets/flask,pallets/werkzeug,fastapi/fastapi-cli,tiangolo/typer,Textualize/rich",
        help="Comma-separated repo list",
    )
    parser.add_argument(
        "--prune-noncurated",
        action="store_true",
        default=True,
        help="Drop manifest entries not in the curated repo list",
    )
    args = parser.parse_args()

    output_path = PROJECT_ROOT / args.output
    manifest = _load_manifest(output_path)
    curated_repos = {repo.strip() for repo in args.repos.split(",") if repo.strip()}
    if args.prune_noncurated:
        manifest = [item for item in manifest if item.get("repo") in curated_repos]
    seen = _existing_keys(manifest)
    target_total = max(args.target, len(manifest))

    repo_clause = " ".join(f"repo:{repo.strip()}" for repo in args.repos.split(",") if repo.strip())
    query = f"is:pr is:merged language:python {repo_clause}"
    page = 1
    while len(manifest) < target_total and page <= args.max_pages:
        items = _search_issues(query, page, 30)
        for item in items:
            repo = item.get("repository_url", "").replace("https://api.github.com/repos/", "")
            number = int(item.get("number", 0))
            if not repo or not number or (repo, number) in seen:
                continue
            pr = _fetch_pr(repo, number)
            if pr.get("merged_at") is None:
                continue
            base = pr.get("base", {})
            head = pr.get("head", {})
            manifest.append(
                {
                    "repo": repo,
                    "pr_number": number,
                    "title": pr.get("title", ""),
                    "url": pr.get("html_url", ""),
                    "language": "python",
                    "base_ref": base.get("sha", ""),
                    "head_ref": head.get("ref", ""),
                    "head_sha": head.get("sha", ""),
                    "changed_files": [],
                    "model_report_path": "",
                    "annotations": [],
                }
            )
            seen.add((repo, number))
            if len(manifest) >= target_total:
                break
        page += 1

    _save_manifest(output_path, manifest)
    print(f"Manifest entries: {len(manifest)}")


if __name__ == "__main__":
    main()
