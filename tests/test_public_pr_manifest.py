# -*- coding: utf-8 -*-
"""Tests for evaluation/scripts/build_public_pr_manifest.py.

Covers what the user-visible spec requires: SWE-PRBench-shaped records with
nested fields normalize cleanly, weak risk labels follow the documented
rules, language filtering and skip-reason counters work, and the optional
``datasets`` dependency surfaces a readable error rather than a long stack
trace.
"""
from __future__ import annotations

import json
import sys
from importlib import util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
SCRIPT_PATH = PROJECT_ROOT / "evaluation" / "scripts" / "build_public_pr_manifest.py"

spec = util.spec_from_file_location("build_public_pr_manifest", SCRIPT_PATH)
assert spec and spec.loader
module = util.module_from_spec(spec)
sys.modules["build_public_pr_manifest"] = module
spec.loader.exec_module(module)

normalize_languages = module._normalize_languages
infer_top_risky_files = module._infer_top_risky_files
infer_overall_risk = module._infer_overall_risk
infer_reason_categories = module._infer_reason_categories
normalize_record = module._normalize_record
build_manifest = module.build_manifest
get_first = module.get_first
main = module.main


# ---------------------------------------------------------------------------
# get_first nested + flat aliasing
# ---------------------------------------------------------------------------

def test_get_first_flat_aliases():
    record = {"repository_name": "owner/repo"}
    assert get_first(record, ["repo", "repository", "repository_name"]) == "owner/repo"


def test_get_first_nested_path_swe_prbench_shape():
    record = {
        "repository": {"full_name": "owner/repo"},
        "base": {"sha": "deadbeef"},
        "head": {"sha": "cafef00d"},
        "pull_request": {"number": 42},
    }
    assert get_first(record, ["repository.full_name", "repo"]) == "owner/repo"
    assert get_first(record, ["base_sha", "base.sha"]) == "deadbeef"
    assert get_first(record, ["head_sha", "head.sha"]) == "cafef00d"
    assert get_first(record, ["pull_request.number", "number"]) == 42


def test_get_first_returns_default_when_missing():
    assert get_first({"x": 1}, ["y", "z"], default="fallback") == "fallback"


# ---------------------------------------------------------------------------
# Field aliasing into manifest entries
# ---------------------------------------------------------------------------

def test_swe_prbench_shape_record_normalizes():
    raw = {
        "repository": {"full_name": "owner/repo"},
        "pull_request": {"number": 7},
        "base": {"sha": "deadbeef"},
        "head": {"sha": "cafef00d"},
        "files": [{"filename": "src/foo.py"}],
        "review_comments": [
            {"path": "src/foo.py", "body": "Possible null pointer here."},
            {"path": "src/foo.py", "body": "auth check missing"},
        ],
    }
    entry, reason = normalize_record(raw, allowed_exts=(".py",))
    assert reason is None
    assert entry is not None
    assert entry["repo"] == "owner/repo"
    assert entry["pr_number"] == 7
    assert entry["base_ref"] == "deadbeef"
    assert entry["head_ref"] == "cafef00d"


def test_field_aliases_alternate_names():
    raw = {
        "repo_name": "x/y", "number": 1,
        "base_commit": "a", "head_commit": "b",
        "files_changed": ["src/a.py"],
        "comments": [{"path": "src/a.py"}],
    }
    entry, reason = normalize_record(raw, allowed_exts=(".py",))
    assert reason is None
    assert entry is not None
    assert entry["repo"] == "x/y"
    assert entry["pr_number"] == 1


def test_normalize_record_records_skip_reasons():
    # missing repo -> missing_repo
    _, reason = normalize_record({"pr_number": 1}, allowed_exts=(".py",))
    assert reason == "missing_repo"

    # missing base/head -> missing_base_or_head
    _, reason = normalize_record(
        {"repo": "x/y", "pr_number": 1, "review_comments": [{"path": "a.py"}]},
        allowed_exts=(".py",),
    )
    assert reason == "missing_base_or_head"

    # invalid record (not a dict)
    _, reason = normalize_record("not-a-dict", allowed_exts=(".py",))
    assert reason == "invalid_record"


def test_normalize_record_writes_source_dataset_when_provided():
    raw = {
        "repo": "x/y", "pr_number": 1,
        "base_sha": "a", "head_sha": "b",
        "files": [{"filename": "x.py"}],
        "review_comments": [{"path": "x.py"}],
    }
    entry, _ = normalize_record(
        raw, allowed_exts=(".py",), source_dataset="foundry-ai/swe-prbench",
    )
    assert entry["source_dataset"] == "foundry-ai/swe-prbench"


# ---------------------------------------------------------------------------
# Language filter
# ---------------------------------------------------------------------------

def test_normalize_languages_strips_and_lowercases():
    assert normalize_languages("py, JS, .ts, , tsx") == (".py", ".js", ".ts", ".tsx")


def test_language_filter_keeps_matching_files():
    raw = {
        "repo": "x/y", "pr_number": 2,
        "base_sha": "a", "head_sha": "b",
        "files": [{"filename": "a.py"}, {"filename": "b.go"}, {"filename": "c.ts"}],
        "review_comments": [{"path": "a.py"}, {"path": "c.ts"}, {"path": "b.go"}],
    }
    entry, _ = normalize_record(raw, allowed_exts=(".py", ".ts"))
    assert entry is not None
    files = entry["annotations"][0]["top_risky_files"]
    assert "a.py" in files
    assert "c.ts" in files
    assert "b.go" not in files


def test_language_filter_skips_when_no_eligible_files():
    raw = {
        "repo": "x/y", "pr_number": 3,
        "base_sha": "a", "head_sha": "b",
        "files": [{"filename": "b.go"}],
        "review_comments": [{"path": "b.go"}],
    }
    entry, reason = normalize_record(raw, allowed_exts=(".py",))
    assert entry is None
    assert reason == "no_supported_files"


# ---------------------------------------------------------------------------
# Risk-label inference
# ---------------------------------------------------------------------------

def test_risk_label_high_when_changes_requested():
    assert infer_overall_risk([{"path": "x"}], has_requested_changes=True) == "high"


def test_risk_label_high_when_many_comments():
    assert infer_overall_risk([{"path": "a"}] * 6, False) == "high"


def test_risk_label_medium_two_to_four_comments():
    assert infer_overall_risk([{"path": "a"}, {"path": "b"}], False) == "medium"
    assert infer_overall_risk([{"path": "a"}] * 4, False) == "medium"


def test_risk_label_low_single_comment():
    assert infer_overall_risk([{"path": "a"}], False) == "low"


def test_risk_label_skip_when_silent():
    assert infer_overall_risk([], False) is None


# ---------------------------------------------------------------------------
# Comments → top_risky_files preference
# ---------------------------------------------------------------------------

def test_comments_take_precedence_over_changed_files():
    paths = infer_top_risky_files(
        comments=[{"path": "src/auth.py"}],
        changed_files=[{"filename": "src/other.py"}],
        allowed_exts=(".py",),
    )
    assert paths == ["src/auth.py"]


def test_falls_back_to_changed_files_when_no_comments():
    paths = infer_top_risky_files(
        comments=[],
        changed_files=[{"filename": "src/a.py"}, "src/b.py"],
        allowed_exts=(".py",),
    )
    assert paths == ["src/a.py", "src/b.py"]


def test_dedupe_preserves_order():
    paths = infer_top_risky_files(
        comments=[{"path": "a.py"}, {"path": "b.py"}, {"path": "a.py"}],
        changed_files=[],
        allowed_exts=(".py",),
    )
    assert paths == ["a.py", "b.py"]


def test_comment_path_uses_file_path_alias():
    paths = infer_top_risky_files(
        comments=[{"file_path": "src/x.py"}],
        changed_files=[],
        allowed_exts=(".py",),
    )
    assert paths == ["src/x.py"]


# ---------------------------------------------------------------------------
# reason_categories keyword heuristic
# ---------------------------------------------------------------------------

def test_reason_categories_security_keyword():
    cats = infer_reason_categories([
        {"body": "this exposes a secret token via the response header"},
    ])
    assert "security" in cats


def test_reason_categories_multiple_categories_in_stable_order():
    cats = infer_reason_categories([
        {"body": "Likely bug here when the cache returns null"},
        {"body": "missing test coverage for the new branch"},
    ])
    # security < semantic < structure < style < test in the rule list,
    # so semantic must come before test in the output
    assert cats.index("semantic") < cats.index("test")


def test_reason_categories_falls_back_to_review_comment_label():
    assert infer_reason_categories([{"body": "lgtm"}]) == ["review_comment"]
    assert infer_reason_categories([]) == ["review_comment"]


def test_reason_categories_handles_string_comments():
    cats = infer_reason_categories(["This may have an injection issue."])
    assert "security" in cats


# ---------------------------------------------------------------------------
# build_manifest: skip-reason counters and limit
# ---------------------------------------------------------------------------

def test_build_manifest_skip_reason_counters():
    records = [
        # ok
        {
            "repo": "x/y", "pr_number": 1,
            "base_sha": "a", "head_sha": "b",
            "files": [{"filename": "a.py"}],
            "review_comments": [{"path": "a.py"}, {"path": "b.py"}],
        },
        # missing review comments
        {
            "repo": "x/y", "pr_number": 2,
            "base_sha": "a", "head_sha": "b",
            "review_comments": [],
        },
        # missing repo
        {"pr_number": 3, "base_sha": "a", "head_sha": "b",
         "review_comments": [{"path": "a.py"}]},
        # missing base/head
        {"repo": "x/y", "pr_number": 4,
         "review_comments": [{"path": "a.py"}]},
        # no supported files (only .go)
        {"repo": "x/y", "pr_number": 5,
         "base_sha": "a", "head_sha": "b",
         "files": [{"filename": "b.go"}],
         "review_comments": [{"path": "b.go"}]},
        # invalid (string, not dict)
        "not-a-record",
    ]
    manifest, stats = build_manifest(records, limit=10, allowed_exts=(".py",))
    assert stats["read_count"] == 6
    assert stats["written_count"] == 1
    counters = stats["skipped_by_reason"]
    assert counters["missing_review_comments"] == 1
    assert counters["missing_repo"] == 1
    assert counters["missing_base_or_head"] == 1
    assert counters["no_supported_files"] == 1
    assert counters["invalid_record"] == 1
    assert sum(counters.values()) == stats["skipped_count"] == 5
    assert manifest[0]["annotations"][0]["overall_risk"] == "medium"


def test_build_manifest_propagates_source_dataset():
    records = [{
        "repo": "x/y", "pr_number": 1,
        "base_sha": "a", "head_sha": "b",
        "files": [{"filename": "a.py"}],
        "review_comments": [{"path": "a.py"}],
    }]
    manifest, _ = build_manifest(
        records, limit=10, allowed_exts=(".py",),
        source_dataset="foundry-ai/swe-prbench",
    )
    assert manifest[0]["source_dataset"] == "foundry-ai/swe-prbench"


# ---------------------------------------------------------------------------
# main(): CLI integration
# ---------------------------------------------------------------------------

def test_main_with_jsonl_fixture(tmp_path, capsys):
    fixture = tmp_path / "public_prs.jsonl"
    rows = [
        {
            "repo": "owner/proj", "pr_number": 11,
            "base_sha": "aaa", "head_sha": "bbb",
            "files": [{"filename": "src/foo.py"}],
            "review_comments": [{"path": "src/foo.py"}, {"path": "src/foo.py"}],
        },
        {
            "repo": "owner/proj", "pr_number": 12,
            "base_sha": "x", "head_sha": "y",
            "review_comments": [{"path": "src/skip.go"}],
        },
    ]
    fixture.write_text("\n".join(json.dumps(r) for r in rows), encoding="utf-8")
    out = tmp_path / "sampled_prs.json"

    rc = main([
        "--input", str(fixture),
        "--output", str(out),
        "--limit", "50",
        "--languages", "py",
    ])
    assert rc == 0
    summary = json.loads(capsys.readouterr().out)
    assert summary["written_count"] == 1
    assert summary["skipped_count"] == 1
    assert summary["language_filter"] == [".py"]

    written = json.loads(out.read_text(encoding="utf-8"))
    assert len(written) == 1
    assert written[0]["repo"] == "owner/proj"
    assert written[0]["pr_number"] == 11
    assert written[0]["annotations"][0]["overall_risk"] == "medium"
    assert written[0]["model_report_path"].startswith("evaluation/results/owner__proj_pr11")


def test_main_with_json_array_fixture(tmp_path, capsys):
    fixture = tmp_path / "public_prs.json"
    fixture.write_text(json.dumps([
        {
            "repo": "a/b", "pr_number": 1,
            "base_sha": "x", "head_sha": "y",
            "files": [{"filename": "x.py"}],
            "review_comments": [{"path": "x.py"}] * 6,
        },
    ]), encoding="utf-8")
    out = tmp_path / "sampled_prs.json"
    rc = main([
        "--input", str(fixture),
        "--output", str(out),
        "--languages", "py",
    ])
    assert rc == 0
    written = json.loads(out.read_text(encoding="utf-8"))
    assert written[0]["annotations"][0]["overall_risk"] == "high"


# ---------------------------------------------------------------------------
# Optional `datasets` package missing - readable error path
# ---------------------------------------------------------------------------

def test_iter_hf_emits_readable_error_when_datasets_missing(monkeypatch, capsys):
    """If `datasets` is not installed, --hf-dataset must surface the spec'd
    short message and exit 2 rather than producing a long Python traceback."""
    import builtins
    real_import = builtins.__import__

    def fake_import(name, *args, **kwargs):
        if name == "datasets" or name.startswith("datasets."):
            raise ImportError("No module named 'datasets'")
        return real_import(name, *args, **kwargs)

    # The module caches no `datasets` symbol, so patching __import__ works.
    monkeypatch.setattr(builtins, "__import__", fake_import)
    try:
        list(module._iter_hf("foundry-ai/swe-prbench", "train"))
    except SystemExit as exc:
        assert exc.code == 2
    err = capsys.readouterr().err
    assert "Missing optional dependency: datasets" in err
    assert "python -m pip install datasets" in err
