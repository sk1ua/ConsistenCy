# -*- coding: utf-8 -*-
"""
配置模块测试
"""
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_path))

import config


def test_commit_pipeline_config_exists():
    """验证提交管线配置存在"""
    assert hasattr(config, "COMMIT_PIPELINE_CONFIG")
    cfg = config.COMMIT_PIPELINE_CONFIG
    assert "default_eval_seed" in cfg
    assert "default_eval_rev" in cfg
    assert "min_eval_samples" in cfg
    assert "neutral_logic_penalty_when_no_evidence" in cfg


def test_commit_pipeline_config_values():
    """验证提交管线配置值合理"""
    cfg = config.COMMIT_PIPELINE_CONFIG
    assert isinstance(cfg["default_eval_seed"], int)
    assert cfg["default_eval_seed"] == 42  # 固定随机种子
    assert cfg["default_eval_rev"] == "HEAD"
    assert cfg["min_eval_samples"] >= 10
    assert 0 <= cfg["neutral_logic_penalty_when_no_evidence"] <= 1


def test_ml_config_exists():
    """验证ML配置存在"""
    assert hasattr(config, "ML_CONFIG")
    ml_cfg = config.ML_CONFIG
    assert "model_dir" in ml_cfg
    assert "naming_model_file" in ml_cfg
    assert "min_train_samples" in ml_cfg
    assert "confidence_threshold" in ml_cfg


def test_check_config_exists():
    """验证一致性检查配置"""
    assert hasattr(config, "CHECK_CONFIG")
    check_cfg = config.CHECK_CONFIG
    assert "naming" in check_cfg
    assert "function" in check_cfg["naming"]
    assert "class" in check_cfg["naming"]
    assert check_cfg["naming"]["function"] == "snake_case"
    assert check_cfg["naming"]["class"] == "PascalCase"


def run_all_tests():
    """运行所有测试"""
    tests = [
        ("提交管线配置存在性", test_commit_pipeline_config_exists),
        ("提交管线配置值", test_commit_pipeline_config_values),
        ("ML配置存在性", test_ml_config_exists),
        ("一致性检查配置", test_check_config_exists),
    ]

    passed = 0
    failed = 0

    print("=" * 60)
    print("运行配置模块测试")
    print("=" * 60)

    for name, test_func in tests:
        try:
            test_func()
            print(f"✅ {name} - 通过")
            passed += 1
        except AssertionError as e:
            print(f"❌ {name} - 失败: {e}")
            failed += 1
        except Exception as e:
            print(f"❌ {name} - 错误: {e}")
            failed += 1

    print("=" * 60)
    print(f"测试结果: {passed} 通过, {failed} 失败")
    print("=" * 60)
    return failed == 0


if __name__ == "__main__":
    success = run_all_tests()
    sys.exit(0 if success else 1)
