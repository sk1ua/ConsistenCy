"""Build the H27 fixed scoring dataset manifest (``scoring_cases.json``).

Every sample in the manifest is either

* ``real_file``       — the exact content of a repository file at the pinned
  commit (``source_path``; baseline = the same content, i.e. "unchanged"),
* ``real_fragment``   — a byte-exact line slice of a repository file
  (``source_path`` + ``source_lines``), or
* ``derived_real``    — a ``real_file`` put through one documented, purely
  mechanical whitespace transform (never hand-written content).

No sample content is invented. Each sample records ``slice_sha256`` (hash of
the exact analyzed content) plus the whole-file hash at pin time, so the
evaluation harness can both tamper-check the manifest and report whether the
upstream file still matches the pin.

``base_commit`` says which commit the sampling *started* from, but a pin is a
statement about the WORKTREE at rebuild time (that commit plus whatever
uncommitted edits existed then). A pinned hash is therefore NOT a claim of
byte-identity with the commit: this dataset has been rebuilt at least once
after ``0b20fa2`` and some pinned files legitimately differ from it (see the
``pin_basis`` field the builder writes into the manifest).

Run:  .\\.venv\\Scripts\\python.exe -m engine.evaluation.build_scoring_cases
"""

from __future__ import annotations

import hashlib
import json
import sys
import textwrap
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[2]
MANIFEST_PATH = Path(__file__).with_name("scoring_cases.json")

BASE_COMMIT = "0b20fa2"
DATASET_VERSION = "scoring-set/v1"
CREATED_AT = "2026-09-27"

#: Truthful pin basis, written into the manifest. The pins are hashes of the
#: worktree at rebuild time, not of the ``BASE_COMMIT`` tree: any sample whose
#: source file carries an uncommitted edit is pinned to the content the analyzer
#: actually runs on. Never read ``base_commit`` as byte-identity.
PIN_BASIS = (
    "样本正文与 file_sha256_at_pin/slice_sha256 记录的是 2026-09-27 重建时刻的"
    "工作树内容（基线提交 0b20fa2 + 当日未提交改动）；因此部分样本与 0b20fa2 的"
    "提交内容逐字节不同，校验一律以本文件记录的哈希与 pin_basis 为准，"
    "不要假定样本等同于 base_commit。"
)

#: Files reserved for named samples, so the clean pool stays disjoint from them.
NAMED_REAL_FILES = (
    "engine/knowledge/indexer.py",
    "engine/workflow/builtins.py",
    "engine/models/enums.py",
    "engine/protocol.py",
)

#: Base file for the whitespace-only derivations (measured risk 0.0 at pin).
NOISE_BASE = "engine/retrieval/hybrid_retriever.py"

CLEAN_POOL_LIMIT = 36

#: (sample id, source path, first line, last line, analyzed-as path, marker, transform)
#: ``transform`` is ``verbatim`` (byte-exact slice) or ``dedent`` (byte-exact
#: slice with its common leading indentation removed so the fragment parses as a
#: module; no other edit).
FRAGMENT_SPECS: tuple[tuple[str, str, int, int, str, str, str], ...] = (
    (
        "frag_pip_shell_true",
        "apps/api/src/config/settings.py",
        234,
        252,
        "pip_configuration_slice.py",
        "shell=True",
        "dedent",
    ),
    (
        "frag_js_eval_fixture",
        "tests/test_multilang.py",
        247,
        249,
        "fixture_eval.js",
        "eval(userInput)",
        "verbatim",
    ),
    (
        "frag_github_token_fixture",
        "apps/api/src/workflow-runtime/triggers.test.ts",
        321,
        328,
        "fixture_token.ts",
        "ghp_",
        "verbatim",
    ),
    (
        "frag_private_key_fixture",
        "apps/api/src/config/doctor.test.ts",
        4,
        4,
        "fixture_private_key.ts",
        "BEGIN PRIVATE KEY",
        "verbatim",
    ),
    (
        "frag_sql_fstring_fixture",
        "tests/test_security_evolution.py",
        77,
        79,
        "fixture_sql.py",
        "SELECT * FROM t",
        "verbatim",
    ),
)

DERIVED_SPECS: tuple[tuple[str, str, str], ...] = (
    ("derived_crlf_noise", "crlf", "LF replaced by CRLF line endings"),
    ("derived_trailing_ws_noise", "trailing_whitespace", "three spaces appended to every line"),
    ("derived_blank_padding_noise", "blank_line_padding", "one blank line inserted after every line"),
)


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def read_source(rel_path: str) -> str:
    """Read a repository text file with universal newlines."""
    return (REPO_ROOT / rel_path).read_text(encoding="utf-8")


def line_slice(source: str, first: int, last: int) -> str:
    """Return lines ``first..last`` (1-based, inclusive) joined with LF."""
    lines = source.splitlines()
    return "\n".join(lines[first - 1:last]) + "\n"


def apply_slice_transform(content: str, transform_kind: str) -> str:
    """Apply the documented slice transform (verbatim / dedent)."""
    if transform_kind == "verbatim":
        return content
    if transform_kind == "dedent":
        return textwrap.dedent(content)
    raise ValueError(f"unknown slice transform: {transform_kind}")


def apply_transform(source: str, transform: str) -> str:
    if transform == "crlf":
        return source.replace("\n", "\r\n")
    if transform == "trailing_whitespace":
        return "\n".join(line + "   " for line in source.split("\n"))
    if transform == "blank_line_padding":
        return source.replace("\n", "\n\n")
    raise ValueError(f"unknown transform: {transform}")


def _measure_risk(path: str, content: str, baseline: str) -> dict[str, Any]:
    """Run the real deterministic engine on one file (import kept local)."""
    from engine.protocol import AnalyzeRequest, FileInput
    from engine.runner import run_analysis

    response = run_analysis(
        AnalyzeRequest(
            id="build",
            action="analyze",
            files=[FileInput(path=path, content=content, baseline=baseline)],
        )
    )
    if not response.ok or not response.files:
        raise RuntimeError(f"engine refused to analyze {path}: {response.error}")
    file_result = response.files[0]
    return {
        "risk_score": file_result.risk_score,
        "risk_label": file_result.risk_label,
        "findings": list(file_result.findings),
    }


def clean_pool_paths() -> list[str]:
    """Return explicit unchanged-file paths whose measured risk is exactly 0.0."""
    pool: list[str] = []
    for path in sorted(REPO_ROOT.glob("engine/**/*.py")):
        rel = path.relative_to(REPO_ROOT).as_posix()
        if rel.startswith("engine/evaluation/") or rel in NAMED_REAL_FILES:
            continue
        source = read_source(rel)
        measured = _measure_risk(rel, source, source)
        if measured["risk_score"] == 0.0:
            pool.append(rel)
        if len(pool) >= CLEAN_POOL_LIMIT:
            break
    return pool


def build_manifest() -> dict[str, Any]:
    samples: list[dict[str, Any]] = []

    for rel in clean_pool_paths():
        source = read_source(rel)
        samples.append({
            "id": "clean_" + rel.removesuffix(".py").replace("/", "_"),
            "path": rel,
            "kind": "real_file",
            "language": "python",
            "baseline": "self",
            "pool": "clean",
            "expected_rule_band": "low",
            "human_risk_label": "low",
            "rationale": "仓库内真实未改动文件（baseline = 自身内容）：漂移信号应为 0，人工判定为低风险。",
            "provenance": {
                "source_path": rel,
                "source_lines": None,
                "transform": None,
                "file_sha256_at_pin": sha256_text(source),
            },
        })

    for sample_id, rel, first, last, analyzed_as, marker, transform_kind in FRAGMENT_SPECS:
        source = read_source(rel)
        raw_slice = line_slice(source, first, last)
        content = apply_slice_transform(raw_slice, transform_kind)
        if marker not in content:
            raise RuntimeError(f"{sample_id}: marker {marker!r} not found in {rel}:{first}-{last}")
        sample = {
            "id": sample_id,
            "path": analyzed_as,
            "kind": "real_fragment",
            "language": "typescript" if analyzed_as.endswith(".ts") else (
                "javascript" if analyzed_as.endswith(".js") else "python"
            ),
            "baseline": "empty",
            "content": content,
            "provenance": {
                "source_path": rel,
                "source_lines": [first, last],
                "slice_transform": transform_kind,
                "transform": (
                    "verbatim line slice (no edits)"
                    if transform_kind == "verbatim"
                    else "verbatim line slice, common leading indentation removed so it parses as a module (no other edits)"
                ),
                "file_sha256_at_pin": sha256_text(source),
                "slice_sha256": sha256_text(content),
            },
        }
        samples.append(sample)

    base_rel = NOISE_BASE
    base_source = read_source(base_rel)
    for sample_id, transform, description in DERIVED_SPECS:
        content = apply_transform(base_source, transform)
        samples.append({
            "id": sample_id,
            "path": base_rel,
            "kind": "derived_real",
            "language": "python",
            "baseline": "self",
            "content": content,
            "provenance": {
                "source_path": base_rel,
                "source_lines": None,
                "transform": description,
                "base_sha256_at_pin": sha256_text(base_source),
                "slice_sha256": sha256_text(content),
            },
        })

    # Human-annotated expectations for the samples that carry real risk signals.
    annotations = {
        "frag_pip_shell_true": {
            "expected_rule_band": "high",
            "human_risk_label": "high",
            "rationale": (
                "上游 pip 真实代码 configuration.py:234-252 的逐字切片（去除公共缩进以便作为模块解析，无其他改动）："
                "subprocess.check_call(f'{editor} \"{fname}\"', shell=True)。插值的 editor 来自配置/环境，"
                "shell=True 使该调用成为真实命令注入面；人工判定 high。切片外的第 5 行 import subprocess 不在样本内。"
            ),
        },
        "frag_js_eval_fixture": {
            "expected_rule_band": "high",
            "human_risk_label": "high",
            "rationale": (
                "仓库真实 fixture 的 JS 源码片段：function dangerous(userInput) { eval(userInput); }。"
                "eval 作用于入参即任意代码执行面；人工判定 high（该片段本身就是被扫描对象，不是字符串里的说明文字）。"
            ),
        },
        "frag_github_token_fixture": {
            "expected_rule_band": "critical",
            "human_risk_label": "low",
            "rationale": (
                "apps/api/src/workflow-runtime/triggers.test.ts:321-328 的真实脱敏测试向量，"
                "ghp_ 形状是构造出来的假 token（同文件断言它不得出现在日志中）。规则必然判 critical；"
                "人工判定 low：不是活凭据。该样本用于量化凭据正则对测试 fixture 的误报。"
            ),
        },
        "frag_private_key_fixture": {
            "expected_rule_band": "critical",
            "human_risk_label": "low",
            "rationale": (
                "apps/api/src/config/doctor.test.ts:4 的真实测试常量 '-----BEGIN PRIVATE KEY-----\\nconfigured\\n'，"
                "内容为占位串。规则必然判 critical；人工判定 low：不是真私钥。计入误报成本。"
            ),
        },
        "frag_sql_fstring_fixture": {
            "expected_rule_band": "medium",
            "human_risk_label": "low",
            "rationale": (
                "tests/test_security_evolution.py:77-79 的真实 fixture："
                "f\"... IN ({placeholders})\" 只插值自生成的 '?' 占位符，SQL 文本是常量，不可注入。"
                "规则按设计仍报 MEDIUM review lead（同文件测试要求保留该告警）；人工判定 low：发现级误报，档位未越级。"
            ),
        },
        "derived_crlf_noise": {
            "expected_rule_band": "low",
            "human_risk_label": "low",
            "rationale": "真实文件仅换行符改为 CRLF，无代码改动；人工判定 low。",
        },
        "derived_trailing_ws_noise": {
            "expected_rule_band": "low",
            "human_risk_label": "low",
            "rationale": "真实文件仅每行行尾加三个空格，AST 不变；人工判定 low。",
        },
        "derived_blank_padding_noise": {
            "expected_rule_band": "low",
            "human_risk_label": "low",
            "rationale": "真实文件仅插入空行，AST 不变；人工判定 low。",
        },
    }
    for sample in samples:
        annotation = annotations.get(sample["id"])
        if annotation:
            sample["expected_rule_band"] = annotation["expected_rule_band"]
            sample["human_risk_label"] = annotation["human_risk_label"]
            sample["rationale"] = annotation["rationale"]

    # Real repository files that carry in-repo heuristic findings. They are
    # deliberately *not* in the clean pool; each one documents a measured
    # finding-level false positive that stays inside the low band.
    for sample_id, rel, rationale in (
        (
            "flagged_indexer",
            "engine/knowledge/indexer.py",
            "engine/knowledge/indexer.py:419 的真实参数化查询（占位符由 '?' 生成）被 SQL 启发式判 MEDIUM；"
            "该文件是未改动的真实源码，人工判定 low：发现级误报，档位仍为 Consistent。",
        ),
        (
            "flagged_builtins",
            "engine/workflow/builtins.py",
            "engine/workflow/builtins.py 两条真实 MEDIUM：:468 的英文报错文案含单词 'select' 被判 SQL 注入、"
            ":595 的语法检查 compile(content, path, 'exec') 被判代码注入。人工判定 low：发现级误报。",
        ),
        (
            "flagged_enums",
            "engine/models/enums.py",
            "engine/models/enums.py 的规则表被重复结构启发式判 dup_fraction≈0.39；人工判定 low："
            "结构化相似（同构 RiskBand 构造）不等于复制粘贴，档位仍为 Consistent。",
        ),
        (
            "flagged_protocol",
            "engine/protocol.py",
            "engine/protocol.py 被重复结构启发式判 dup_fraction≈1.0；人工判定 low：dataclass 样板结构相似，"
            "非复制粘贴缺陷，档位仍为 Consistent。",
        ),
    ):
        source = read_source(rel)
        samples.append({
            "id": sample_id,
            "path": rel,
            "kind": "real_file",
            "language": "python",
            "baseline": "self",
            "pool": None,
            "expected_rule_band": "low",
            "human_risk_label": "low",
            "rationale": rationale,
            "provenance": {
                "source_path": rel,
                "source_lines": None,
                "transform": None,
                "file_sha256_at_pin": sha256_text(source),
            },
        })

    clean_pool = [sample["id"] for sample in samples if sample.get("pool") == "clean"]

    changesets = [
        {
            "id": "cs_clean_only",
            "kind": "real",
            "human_risk_label": "low",
            "rationale": "整包未改动真实文件：无任何新增风险，人工判定 low。",
            "members": [],
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_real_orange_peak_diluted",
            "kind": "real",
            "human_risk_label": "high",
            "rationale": (
                "36 个未改动真实 engine 文件 + 1 个真实 shell=True 片段（单文件档 ORANGE）。"
                "真实命令注入面不因同变更集里的清洁文件而消失；人工判定 high。"
            ),
            "members": ["frag_pip_shell_true"],
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_real_eval_peak_diluted",
            "kind": "real",
            "human_risk_label": "high",
            "rationale": (
                "36 个未改动真实文件 + 1 个真实 eval() 片段（单文件档 ORANGE，风险 0.500）。"
                "eval 作用于入参，人工判定 high。"
            ),
            "members": ["frag_js_eval_fixture"],
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_credential_fixture_diluted",
            "kind": "real",
            "human_risk_label": "low",
            "rationale": (
                "36 个未改动真实文件 + 1 个真实凭据形状 fixture（单文件档 RED）。"
                "人工判定 low：fixture 不是活凭据；该变更集量化硬闸对齐后的误报严重度。"
            ),
            "members": ["frag_github_token_fixture"],
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_private_key_fixture_diluted",
            "kind": "real",
            "human_risk_label": "low",
            "rationale": "同上，替换为真实私钥头 fixture；人工判定 low。",
            "members": ["frag_private_key_fixture"],
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_private_key_fixture_small",
            "kind": "real",
            "human_risk_label": "low",
            "rationale": "5 个未改动真实文件 + 私钥头 fixture：验证小样本下闸门行为一致。",
            "members": ["frag_private_key_fixture"],
            "clean_filler": {"count": 5},
        },
        {
            "id": "cs_format_noise_only",
            "kind": "real",
            "human_risk_label": "low",
            "rationale": (
                "3 个真实文件的纯空白噪声派生（CRLF / 行尾空格 / 空行填充），baseline = 原始真实文件。"
                "无代码改动，人工判定 low；用于验证格式噪声不会把项目整体判 critical。"
            ),
            "members": ["derived_crlf_noise", "derived_trailing_ws_noise", "derived_blank_padding_noise"],
            "clean_filler": {"count": 0},
        },
        {
            "id": "cs_two_real_risky_files",
            "kind": "real",
            "human_risk_label": "high",
            "rationale": "2 个真实高危片段组成的小变更集（shell=True + eval），人工判定 high。",
            "members": ["frag_pip_shell_true", "frag_js_eval_fixture"],
            "clean_filler": {"count": 0},
        },
        {
            "id": "boundary_peak_7499",
            "kind": "synthetic_boundary",
            "human_risk_label": "high",
            "rationale": (
                "边界探针（不是真实文件）：峰值风险 0.7499 落在 canonical ORANGE 档 [0.50, 0.75)，"
                "人工判定 high。36 个真实清洁文件提供稀释压力。"
            ),
            "synthetic_peak": 0.7499,
            "clean_filler": {"count": 36},
        },
        {
            "id": "boundary_peak_7500",
            "kind": "synthetic_boundary",
            "human_risk_label": "critical",
            "rationale": (
                "边界探针：峰值风险 0.7500 恰好等于 canonical RED 下界，人工判定 critical。"
            ),
            "synthetic_peak": 0.7500,
            "clean_filler": {"count": 36},
        },
        {
            "id": "boundary_peak_7501",
            "kind": "synthetic_boundary",
            "human_risk_label": "critical",
            "rationale": "边界探针：峰值风险 0.7501 刚过 canonical RED 下界，人工判定 critical。",
            "synthetic_peak": 0.7501,
            "clean_filler": {"count": 36},
        },
        {
            "id": "cs_deep_critical_peak",
            "kind": "synthetic_boundary",
            "human_risk_label": "critical",
            "rationale": (
                "回归钉住：峰值 0.95（明显高于旧闸 0.80）+ 36 个真实清洁文件，人工判定 critical；"
                "用于确认硬闸行为不退化。"
            ),
            "synthetic_peak": 0.95,
            "clean_filler": {"count": 36},
        },
    ]

    return {
        "dataset_version": DATASET_VERSION,
        "created_at": CREATED_AT,
        "base_commit": BASE_COMMIT,
        "pin_basis": PIN_BASIS,
        "rule_version_under_test": "risk-rules/v3.1",
        "frozen_reference_version": "risk-rules/v3.0",
        "clean_pool_size": len(clean_pool),
        "annotation_rule": (
            "human_risk_label 是人工判定：以该单元自身证据的真实可利用性为准，"
            "并显式说明理由；canonical 档位只作为 expected_rule_band 记录，不作为人工真值。"
            "synthetic_boundary 变更集的人工真值 = 其峰值分数所属 canonical 档（预先声明的标注规则）。"
        ),
        "evidence_boundary": (
            "小样本人工标注集：只证明规则在固定样本上的单调性与阈值行为，"
            "不证明真实项目上的模型质量或误报率。"
        ),
        "samples": samples,
        "changesets": changesets,
    }


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    manifest = build_manifest()
    text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
    MANIFEST_PATH.write_text(text, encoding="utf-8")
    clean = sum(1 for s in manifest["samples"] if s.get("pool") == "clean")
    print(
        f"wrote {MANIFEST_PATH.name}: {len(manifest['samples'])} samples "
        f"({clean} clean pool), {len(manifest['changesets'])} changesets, "
        f"version={manifest['dataset_version']}, base={manifest['base_commit']}"
    )
    print("samples:", ", ".join(s["id"] for s in manifest["samples"] if s.get("pool") != "clean"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
