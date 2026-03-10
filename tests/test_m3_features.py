# -*- coding: utf-8 -*-
"""
M3 功能测试：多模态信号、规则推理、实验框架、案例生成。
"""
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.commit_pipeline import (  # type: ignore[import-not-found]
    CaseGenerator,
    CommitContext,
    ExperimentRunner,
    RuleEngine,
)


def _build_context(message: str, message_signals: dict) -> CommitContext:
    return CommitContext(
        commit_id="abc123",
        author="test_user",
        message=message,
        changed_files=["app.py"],
        changed_functions=[],
        deleted_files=[],
        message_signals=message_signals,
        timestamp="2026-03-10T00:00:00",
        parent_commits=["def456"],
    )


def test_commit_context_multimodal_fields():
    """测试提交上下文多模态字段。"""
    ctx = _build_context(
        "quick fix: temporary workaround",
        {
            "length": 30,
            "has_high_risk_keywords": True,
            "has_refactor_keywords": False,
            "has_breaking_keywords": False,
            "high_risk_keywords_found": ["quick fix", "temporary", "workaround"],
            "is_too_short": False,
            "is_too_long": False,
        },
    )

    assert ctx.commit_id == "abc123"
    assert ctx.message_signals is not None
    assert ctx.message_signals["has_high_risk_keywords"] is True
    assert len(ctx.parent_commits or []) == 1
    print("✅ 提交上下文多模态字段测试通过")


def test_rule_engine_matching():
    """测试规则加载与匹配。"""
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
        rules_data = {
            "consistency_rules": [
                {
                    "id": "R001",
                    "description": "高风险关键词命中",
                    "conditions": {
                        "message_keywords": ["hack", "workaround"],
                        "require_high_risk_keywords": True,
                    },
                    "severity": "high",
                    "risk_impact": {"style": 0.1, "structure": 0.1, "logic": 0.2},
                }
            ]
        }
        json.dump(rules_data, f, ensure_ascii=False)
        rules_file = Path(f.name)

    try:
        engine = RuleEngine(rules_file=rules_file)
        assert engine.enabled is True
        assert len(engine.rules) == 1

        matched_ctx = _build_context(
            "hack: workaround for prod issue",
            {"has_high_risk_keywords": True, "has_breaking_keywords": False},
        )
        hit = engine.infer(matched_ctx)
        assert hit["rule_triggered"] is True
        assert len(hit["matched_rules"]) == 1
        assert hit["matched_rules"][0]["rule_id"] == "R001"

        clean_ctx = _build_context(
            "feat: add endpoint",
            {"has_high_risk_keywords": False, "has_breaking_keywords": False},
        )
        miss = engine.infer(clean_ctx)
        assert miss["rule_triggered"] is False
        print("✅ 规则匹配测试通过")
    finally:
        rules_file.unlink(missing_ok=True)


def test_experiment_runner_with_mock_dataset():
    """测试交叉验证和消融实验输出结构。"""
    with tempfile.TemporaryDirectory() as tmpdir:
        dataset_file = Path(tmpdir) / "mock_dataset.jsonl"
        with open(dataset_file, "w", encoding="utf-8") as f:
            for i in range(24):
                row = {
                    "commit": f"sha_{i:03d}",
                    "style_risk": 0.2 + (i % 5) * 0.1,
                    "structure_risk": 0.25 + (i % 4) * 0.1,
                    "logic_risk": 0.3 + (i % 3) * 0.1,
                    "overall_risk": 0.25 + (i % 6) * 0.1,
                    "label": 1 if i % 2 == 0 else 0,
                }
                f.write(json.dumps(row, ensure_ascii=False) + "\n")

        runner = ExperimentRunner(tmpdir, storage=Mock(), graph_store=None)
        ablation = runner.run_ablation_study(str(dataset_file), components=["vector", "graph"])
        cv = runner.run_cross_validation(str(dataset_file), n_folds=4)

        assert ablation["ok"] is True
        assert "full_model" in ablation["results"]
        assert "without_vector" in ablation["results"]
        assert "without_graph" in ablation["results"]

        assert cv["ok"] is True
        assert len(cv["fold_results"]) == 4
        assert "mean_f1" in cv["summary"]
        assert "mean_accuracy" in cv["summary"]
        print("✅ 实验框架测试通过")


def test_case_generator_output_files():
    """测试案例生成JSON/Markdown输出。"""
    miner_mock = Mock()
    scorer_mock = Mock()

    miner_mock.get_commit.return_value = _build_context(
        "quick fix: temporary workaround",
        {
            "has_high_risk_keywords": True,
            "has_breaking_keywords": False,
            "is_too_short": False,
            "high_risk_keywords_found": ["quick fix", "temporary"],
        },
    )
    scorer_mock.score.return_value = {
        "commit": "abc123",
        "author": "test_user",
        "overall_risk": 0.78,
        "style_risk": 0.45,
        "structure_risk": 0.75,
        "logic_risk": 0.82,
        "changed_files": 3,
        "changed_functions": 2,
        "evidence": {"functions": []},
    }

    with tempfile.TemporaryDirectory() as tmpdir:
        generator = CaseGenerator(miner_mock, scorer_mock)
        generator.output_dir = Path(tmpdir) / "cases"
        generator.output_dir.mkdir(parents=True, exist_ok=True)

        result = generator.generate_top_risk_cases(["abc123"], top_n=1)
        assert result["ok"] is True
        assert len(result["cases"]) == 1
        assert Path(result["output_json"]).exists()
        assert Path(result["output_md"]).exists()
        print("✅ 案例生成测试通过")


def run_all_tests() -> bool:
    tests = [
        test_commit_context_multimodal_fields,
        test_rule_engine_matching,
        test_experiment_runner_with_mock_dataset,
        test_case_generator_output_files,
    ]

    passed = 0
    failed = 0
    print("\n" + "=" * 60)
    print("开始运行 M3 功能测试")
    print("=" * 60)

    for test_func in tests:
        try:
            test_func()
            passed += 1
        except AssertionError as exc:
            failed += 1
            print(f"❌ {test_func.__name__} 断言失败: {exc}")
        except Exception as exc:
            failed += 1
            print(f"❌ {test_func.__name__} 执行异常: {exc}")

    print("=" * 60)
    print(f"测试结果: {passed} 通过, {failed} 失败")
    print("=" * 60)
    return failed == 0


if __name__ == "__main__":
    ok = run_all_tests()
    sys.exit(0 if ok else 1)
