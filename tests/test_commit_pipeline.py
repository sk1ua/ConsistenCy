# -*- coding: utf-8 -*-
"""
提交管线单元测试
"""
import sys
from pathlib import Path

# 添加backend到路径
backend_path = Path(__file__).parent.parent / "backend"
sys.path.insert(0, str(backend_path))

from unittest.mock import Mock, patch, MagicMock
from src.commit_pipeline import (
    CommitMiner,
    CommitContext,
    HybridRetriever,
    CommitRiskScorer,
    WeakEvalRunner,
    NULL_TREE,
)
from src.storage import CodeStorage


def test_null_tree_constant():
    """验证NULL_TREE常量定义"""
    assert NULL_TREE == "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
    assert len(NULL_TREE) == 40  # Git SHA-1 hash长度


def test_commit_context_dataclass():
    """验证CommitContext数据类"""
    ctx = CommitContext(
        commit_id="abc123",
        author="test_user",
        message="test commit",
        changed_files=["file1.py"],
        changed_functions=[],
        deleted_files=[],
    )
    assert ctx.commit_id == "abc123"
    assert ctx.author == "test_user"
    assert len(ctx.changed_files) == 1
    assert len(ctx.deleted_files) == 0


def test_commit_risk_scorer_no_functions():
    """测试无函数改动时的风险评分"""
    storage = Mock(spec=CodeStorage)
    retriever = Mock(spec=HybridRetriever)
    scorer = CommitRiskScorer(storage=storage, retriever=retriever)

    # 场景1：只删除文件
    ctx = CommitContext(
        commit_id="test123",
        author="dev1",
        message="remove old code",
        changed_files=["old.py"],
        changed_functions=[],
        deleted_files=["old.py", "legacy.py"],
    )

    result = scorer.score(ctx, top_k=3)
    assert result["commit"] == "test123"
    assert result["changed_functions"] == 0
    assert result["deleted_files"] == 2
    assert result["structure_risk"] > 0  # 删除文件应产生结构风险
    assert result["style_risk"] == 0.0
    assert result["logic_risk"] == 0.0
    assert "evidence" in result
    assert result["evidence"]["deleted_files"] == ["old.py", "legacy.py"]


def test_commit_risk_scorer_with_functions():
    """测试包含函数改动的风险评分"""
    storage = Mock(spec=CodeStorage)
    storage.get_naming_patterns.return_value = {"function": "snake_case"}

    retriever = Mock(spec=HybridRetriever)
    retriever.retrieve.return_value = [
        {"source": "vector", "score": 0.8, "function_name": "similar_func"}
    ]

    scorer = CommitRiskScorer(storage=storage, retriever=retriever)

    ctx = CommitContext(
        commit_id="test456",
        author="dev2",
        message="add feature",
        changed_files=["new_feature.py"],
        changed_functions=[
            {
                "name": "myNewFunction",  # camelCase，不符合snake_case规范
                "file_path": "new_feature.py",
                "lineno": 10,
                "end_lineno": 25,
                "args": ["arg1", "arg2"],
            }
        ],
        deleted_files=[],
    )

    result = scorer.score(ctx, top_k=3)
    assert result["commit"] == "test456"
    assert result["changed_functions"] == 1
    assert result["style_risk"] > 0  # 命名风格不匹配
    assert result["overall_risk"] > 0
    assert len(result["evidence"]["functions"]) == 1
    evidence = result["evidence"]["functions"][0]
    assert evidence["function"] == "myNewFunction"
    assert evidence["style"]["expected"] == "snake_case"
    assert evidence["style"]["actual"] in ["camelCase", "PascalCase"]


def test_commit_miner_integration():
    """集成测试：CommitMiner从实际仓库读取"""
    repo_path = "/workspaces/codespaces-blank/ConsistenCy"
    if not Path(repo_path + "/.git").exists():
        print("⏭️  跳过集成测试（需要在ConsistenCy仓库中运行）")
        return

    miner = CommitMiner(repo_path)
    commits = miner.list_recent_commits(max_count=5)
    assert len(commits) > 0
    assert all(len(sha) == 40 for sha in commits)  # 验证SHA格式


def run_all_tests():
    """运行所有测试"""
    tests = [
        ("NULL_TREE常量", test_null_tree_constant),
        ("CommitContext数据类", test_commit_context_dataclass),
        ("风险评分-无函数", test_commit_risk_scorer_no_functions),
        ("风险评分-有函数", test_commit_risk_scorer_with_functions),
        ("CommitMiner集成", test_commit_miner_integration),
    ]

    passed = 0
    failed = 0

    print("=" * 60)
    print("运行提交管线测试")
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
