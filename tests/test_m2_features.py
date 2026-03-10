# -*- coding: utf-8 -*-
"""
M2 功能测试
"""
import sys
from pathlib import Path

backend_path = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_path))

import config


def test_m2_configs_exist():
    """验证M2配置存在"""
    assert hasattr(config, "GRAPH_CONFIG")
    assert hasattr(config, "HYBRID_RETRIEVAL_CONFIG")
    assert hasattr(config, "RISK_SCORING_CONFIG")


def test_graph_config_values():
    """验证图谱配置"""
    cfg = config.GRAPH_CONFIG
    assert "neo4j_batch_size" in cfg
    assert "neo4j_retry_attempts" in cfg
    assert cfg["neo4j_batch_size"] > 0
    assert cfg["neo4j_retry_attempts"] >= 1


def test_hybrid_retrieval_config():
    """验证融合检索配置"""
    cfg = config.HYBRID_RETRIEVAL_CONFIG
    assert "vector_weight" in cfg
    assert "graph_weight" in cfg
    assert "fusion_method" in cfg
    assert cfg["fusion_method"] in ["weighted_sum", "rrf", "linear_combination"]
    assert 0 <= cfg["vector_weight"] <= 1
    assert 0 <= cfg["graph_weight"] <= 1


def test_risk_scoring_config():
    """验证风险评分配置"""
    cfg = config.RISK_SCORING_CONFIG
    assert "default_weights" in cfg
    assert "auto_tune_enabled" in cfg
    assert "tuned_weights_file" in cfg
    
    weights = cfg["default_weights"]
    assert "style" in weights
    assert "structure" in weights
    assert "logic" in weights
    
    # 权重总和应该接近1.0
    total = weights["style"] + weights["structure"] + weights["logic"]
    assert 0.99 <= total <= 1.01


def test_fusion_method_enum():
    """验证融合方法枚举"""
    valid_methods = ["weighted_sum", "rrf", "linear_combination"]
    cfg_method = config.HYBRID_RETRIEVAL_CONFIG["fusion_method"]
    assert cfg_method in valid_methods


def run_all_tests():
    """运行所有测试"""
    tests = [
        ("M2配置存在性", test_m2_configs_exist),
        ("图谱配置", test_graph_config_values),
        ("融合检索配置", test_hybrid_retrieval_config),
        ("风险评分配置", test_risk_scoring_config),
        ("融合方法枚举", test_fusion_method_enum),
    ]

    passed = 0
    failed = 0

    print("=" * 60)
    print("运行 M2 功能测试")
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
