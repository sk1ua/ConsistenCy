# -*- coding: utf-8 -*-
"""
人工标注工具 - CLI 版本

用于标注代码提交的不一致性风险。
"""
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from git import Repo

sys.path.insert(0, str(Path(__file__).parent.parent))
import config


class AnnotationTool:
    """人工标注工具"""

    def __init__(self, repo_path: str, output_dir: str, annotator_id: str):
        """
        Args:
            repo_path: Git 仓库路径
            output_dir: 标注结果输出目录
            annotator_id: 标注员 ID（如 annotator_001）
        """
        self.repo_path = Path(repo_path)
        self.repo = Repo(str(self.repo_path))
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.annotator_id = annotator_id
        
        # 标注记录
        self.annotations: List[Dict[str, Any]] = []
        self.output_file = self.output_dir / f"annotations_{annotator_id}.jsonl"
        
        # 加载已有标注（如果存在）
        self._load_existing_annotations()

    def _load_existing_annotations(self):
        """加载已有的标注记录"""
        if self.output_file.exists():
            with open(self.output_file, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        self.annotations.append(json.loads(line))
                    except json.JSONDecodeError:
                        pass
            print(f"✅ 加载已有标注: {len(self.annotations)} 条")

    def get_annotated_commits(self) -> set:
        """获取已标注的提交 SHA"""
        return {ann["commit_sha"] for ann in self.annotations}

    def annotate_commit(self, commit_sha: str) -> Optional[Dict[str, Any]]:
        """标注单个提交"""
        # 检查是否已标注
        if commit_sha in self.get_annotated_commits():
            print(f"⚠️  提交 {commit_sha[:8]} 已标注，跳过")
            return None
        
        # 获取提交信息
        try:
            commit = self.repo.commit(commit_sha)
        except Exception as e:
            print(f"❌ 无法获取提交: {e}")
            return None
        
        # 显示提交信息
        print("\n" + "=" * 80)
        print(f"📝 标注提交: {commit_sha[:8]}")
        print("=" * 80)
        print(f"作者: {commit.author.name} <{commit.author.email}>")
        print(f"日期: {datetime.fromtimestamp(commit.committed_date)}")
        print(f"消息: {commit.message.strip()}")
        print("-" * 80)
        
        # 显示 diff 摘要
        if commit.parents:
            parent = commit.parents[0]
            diff_summary = parent.diff(commit)
            
            print(f"变更文件数: {len(diff_summary)}")
            for diff_item in diff_summary[:5]:  # 只显示前 5 个文件
                change_type = diff_item.change_type
                file_path = diff_item.b_path or diff_item.a_path
                print(f"  [{change_type}] {file_path}")
            
            if len(diff_summary) > 5:
                print(f"  ... 和其他 {len(diff_summary) - 5} 个文件")
        
        print("-" * 80)
        
        # 开始标注
        print("\n📊 请对以下三个维度进行评分 (1-5):")
        print("   1 = 完全一致，5 = 完全不一致")
        print("   参考: data/annotations/ANNOTATION_GUIDELINE.md\n")
        
        scores = {}
        
        # Style 评分
        while True:
            try:
                style = int(input("风格不一致 (Style): "))
                if 1 <= style <= 5:
                    scores["style"] = style
                    break
                else:
                    print("⚠️  请输入 1-5 之间的整数")
            except ValueError:
                print("⚠️  请输入有效的整数")
            except KeyboardInterrupt:
                print("\n\n⚠️  标注中止")
                return None
        
        # Structure 评分
        while True:
            try:
                structure = int(input("结构不一致 (Structure): "))
                if 1 <= structure <= 5:
                    scores["structure"] = structure
                    break
                else:
                    print("⚠️  请输入 1-5 之间的整数")
            except ValueError:
                print("⚠️  请输入有效的整数")
            except KeyboardInterrupt:
                print("\n\n⚠️  标注中止")
                return None
        
        # Logic 评分
        while True:
            try:
                logic = int(input("逻辑不一致 (Logic): "))
                if 1 <= logic <= 5:
                    scores["logic"] = logic
                    break
                else:
                    print("⚠️  请输入 1-5 之间的整数")
            except ValueError:
                print("⚠️  请输入有效的整数")
            except KeyboardInterrupt:
                print("\n\n⚠️  标注中止")
                return None
        
        # 整体风险标签
        print("\n整体风险等级:")
        print("  0 = 低风险（所有维度 ≤ 2）")
        print("  1 = 高风险（至少一个维度 ≥ 4 或两个维度 ≥ 3）")
        
        while True:
            try:
                label = int(input("整体标签 (0/1): "))
                if label in [0, 1]:
                    break
                else:
                    print("⚠️  请输入 0 或 1")
            except ValueError:
                print("⚠️  请输入有效的整数")
            except KeyboardInterrupt:
                print("\n\n⚠️  标注中止")
                return None
        
        # 置信度
        print("\n标注置信度:")
        print("  high = 很确定，medium = 一般，low = 不太确定")
        
        while True:
            confidence = input("置信度 (high/medium/low): ").strip().lower()
            if confidence in ["high", "medium", "low", ""]:
                if not confidence:
                    confidence = "medium"
                break
            else:
                print("⚠️  请输入 high, medium 或 low")
        
        # 备注（可选）
        comments = input("\n备注（可选，回车跳过）: ").strip()
        
        # 构造标注记录
        annotation = {
            "commit_sha": commit_sha,
            "project": str(self.repo_path.name),
            "annotator_id": self.annotator_id,
            "timestamp": datetime.now().isoformat(),
            "scores": scores,
            "overall_label": label,
            "label_source": "human_annotation",  # 重要：标记来源
            "confidence": confidence,
            "comments": comments if comments else "",
            "discussion_needed": False,
        }
        
        # 保存
        self._save_annotation(annotation)
        
        print("\n✅ 标注已保存")
        return annotation

    def _save_annotation(self, annotation: Dict[str, Any]):
        """保存标注记录"""
        self.annotations.append(annotation)
        
        # 追加到文件
        with open(self.output_file, "a", encoding="utf-8") as f:
            f.write(json.dumps(annotation, ensure_ascii=False) + "\n")

    def batch_annotate(self, commit_shas: List[str]):
        """批量标注"""
        print(f"🚀 开始批量标注 {len(commit_shas)} 个提交\n")
        
        for idx, sha in enumerate(commit_shas, start=1):
            print(f"\n进度: [{idx}/{len(commit_shas)}]")
            
            result = self.annotate_commit(sha)
            
            if result is None:
                # 跳过或中止
                continue
            
            # 询问是否继续
            if idx < len(commit_shas):
                cont = input("\n继续下一个? (Enter=是, q=退出): ").strip().lower()
                if cont == 'q':
                    print("⚠️  标注中止")
                    break
        
        print(f"\n✅ 批量标注完成，共标注 {len(self.annotations)} 条")

    def export_to_labeled_dataset(self, output_path: str):
        """导出为标准的标注数据集格式"""
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        # 转换格式
        with open(output_file, "w", encoding="utf-8") as f:
            for ann in self.annotations:
                # 简化格式，只保留训练需要的字段
                simplified = {
                    "commit": ann["commit_sha"],
                    "label": ann["overall_label"],
                    "label_source": ann["label_source"],
                    "style_score": ann["scores"]["style"],
                    "structure_score": ann["scores"]["structure"],
                    "logic_score": ann["scores"]["logic"],
                    "annotator": ann["annotator_id"],
                    "confidence": ann["confidence"],
                }
                f.write(json.dumps(simplified, ensure_ascii=False) + "\n")
        
        print(f"💾 标注数据集已导出: {output_file}")


def sample_commits_for_annotation(
    repo_path: str,
    num_samples: int = 100,
    seed: int = 42,
) -> List[str]:
    """从仓库采样提交用于标注"""
    import random
    
    repo = Repo(repo_path)
    
    # 获取所有提交
    commits = list(repo.iter_commits('HEAD', max_count=1000))
    
    # 采样
    random.seed(seed)
    sampled = random.sample(commits, min(num_samples, len(commits)))
    
    return [commit.hexsha for commit in sampled]


# CLI 入口
if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="ConsistenCy 人工标注工具")
    parser.add_argument("repo_path", help="Git 仓库路径")
    parser.add_argument("--annotator", required=True, help="标注员 ID（如 annotator_001）")
    parser.add_argument("--output-dir", default="data/annotations/raw", help="输出目录")
    parser.add_argument("--sample-size", type=int, default=100, help="采样数量")
    parser.add_argument("--seed", type=int, default=42, help="随机种子")
    
    args = parser.parse_args()
    
    # 创建标注工具
    tool = AnnotationTool(
        repo_path=args.repo_path,
        output_dir=args.output_dir,
        annotator_id=args.annotator,
    )
    
    # 采样提交
    print(f"📊 从 {args.repo_path} 采样 {args.sample_size} 个提交...")
    commit_shas = sample_commits_for_annotation(
        args.repo_path,
        num_samples=args.sample_size,
        seed=args.seed,
    )
    
    # 过滤已标注的提交
    annotated = tool.get_annotated_commits()
    unannotated = [sha for sha in commit_shas if sha not in annotated]
    
    print(f"✅ 采样完成，需标注 {len(unannotated)} 个提交（已标注 {len(annotated)} 个）\n")
    
    if not unannotated:
        print("所有采样提交已标注完成")
    else:
        # 开始批量标注
        tool.batch_annotate(unannotated)
        
        # 导出
        export_path = Path(args.output_dir) / "labeled_dataset_partial.jsonl"
        tool.export_to_labeled_dataset(str(export_path))
