# -*- coding: utf-8 -*-
"""
跨项目泛化评估框架

评估模型在未见过的项目上的泛化能力。
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from sklearn.metrics import f1_score, precision_score, recall_score, accuracy_score

try:
    from .human_labeled_evaluator import HumanLabeledEvaluator
except ImportError:
    from human_labeled_evaluator import HumanLabeledEvaluator


class CrossProjectEvaluator:
    """跨项目评估器"""

    def __init__(self):
        self.projects: Dict[str, HumanLabeledEvaluator] = {}
        self.results: Dict[str, Any] = {}

    def add_project(self, project_name: str, dataset_path: str):
        """添加一个项目的数据集"""
        evaluator = HumanLabeledEvaluator(dataset_path)
        self.projects[project_name] = evaluator
        print(f"✅ 添加项目: {project_name} ({len(evaluator.data)} 样本)")

    def zero_shot_evaluation(
        self,
        train_project: str,
        test_projects: List[str],
        model_class,
        feature_keys: Optional[List[str]] = None,
        **model_kwargs,
    ) -> Dict[str, Any]:
        """
        Zero-shot 评估：在一个项目上训练，在其他项目上测试。
        
        Args:
            train_project: 训练项目名称
            test_projects: 测试项目名称列表
            model_class: 模型类
            feature_keys: 特征字段名
            **model_kwargs: 模型参数
        
        Returns:
            跨项目评估结果
        """
        if train_project not in self.projects:
            raise ValueError(f"训练项目 {train_project} 不存在")
        
        print(f"\n🚀 Zero-shot 评估: 在 {train_project} 上训练")
        
        # 在训练项目上训练模型
        train_evaluator = self.projects[train_project]
        train_evaluator.split_data(train_ratio=0.8, valid_ratio=0.1, test_ratio=0.1, seed=42)
        
        if feature_keys is None:
            feature_keys = ["style_risk", "structure_risk", "logic_risk"]
        
        model = train_evaluator.train_baseline_model(
            feature_keys=feature_keys,
            model_class=model_class,
            **model_kwargs,
        )
        
        # 在训练项目的测试集上评估（作为基准）
        X_train_test = np.array([
            [row.get(k, 0.0) for k in feature_keys]
            for row in train_evaluator.test_data
        ])
        y_train_test = np.array([row["label"] for row in train_evaluator.test_data])
        y_pred_train_test = model.predict(X_train_test)
        
        train_metrics = {
            "f1": float(f1_score(y_train_test, y_pred_train_test, zero_division=0)),
            "precision": float(precision_score(y_train_test, y_pred_train_test, zero_division=0)),
            "recall": float(recall_score(y_train_test, y_pred_train_test, zero_division=0)),
            "accuracy": float(accuracy_score(y_train_test, y_pred_train_test)),
            "test_size": len(y_train_test),
        }
        
        print(f"   训练项目测试集 F1: {train_metrics['f1']:.4f}")
        
        # 在其他项目上测试（zero-shot）
        test_results = {}
        
        for test_project in test_projects:
            if test_project not in self.projects:
                print(f"   ⚠️  测试项目 {test_project} 不存在，跳过")
                continue
            
            if test_project == train_project:
                print(f"   ⚠️  跳过训练项目 {test_project}")
                continue
            
            print(f"   测试项目: {test_project}")
            
            test_evaluator = self.projects[test_project]
            
            # 使用整个数据集作为测试集
            X_test = np.array([
                [row.get(k, 0.0) for k in feature_keys]
                for row in test_evaluator.data
            ])
            y_test = np.array([row["label"] for row in test_evaluator.data])
            
            y_pred_test = model.predict(X_test)
            
            metrics = {
                "f1": float(f1_score(y_test, y_pred_test, zero_division=0)),
                "precision": float(precision_score(y_test, y_pred_test, zero_division=0)),
                "recall": float(recall_score(y_test, y_pred_test, zero_division=0)),
                "accuracy": float(accuracy_score(y_test, y_pred_test)),
                "test_size": len(y_test),
            }
            
            # 计算性能下降
            f1_drop = train_metrics["f1"] - metrics["f1"]
            metrics["f1_drop_from_train"] = float(f1_drop)
            metrics["f1_drop_percentage"] = float(f1_drop / train_metrics["f1"] * 100) if train_metrics["f1"] > 0 else 0.0
            
            test_results[test_project] = metrics
            
            print(f"      F1: {metrics['f1']:.4f} (下降 {f1_drop:+.4f}, {metrics['f1_drop_percentage']:.1f}%)")
        
        # 汇总结果
        result = {
            "train_project": train_project,
            "train_metrics": train_metrics,
            "test_results": test_results,
            "average_test_f1": float(np.mean([m["f1"] for m in test_results.values()])) if test_results else 0.0,
            "average_f1_drop": float(np.mean([m["f1_drop_from_train"] for m in test_results.values()])) if test_results else 0.0,
        }
        
        self.results[f"zero_shot_{train_project}"] = result
        
        return result

    def few_shot_evaluation(
        self,
        train_project: str,
        test_project: str,
        few_shot_sizes: List[int],
        model_class,
        feature_keys: Optional[List[str]] = None,
        **model_kwargs,
    ) -> Dict[str, Any]:
        """
        Few-shot 评估：在源项目上训练，用目标项目的少量样本 fine-tune。
        
        Args:
            train_project: 源训练项目
            test_project: 目标测试项目
            few_shot_sizes: 目标项目的样本数列表（如 [10, 20, 50]）
            model_class: 模型类
            feature_keys: 特征字段名
            **model_kwargs: 模型参数
        
        Returns:
            Few-shot 评估结果
        """
        if train_project not in self.projects or test_project not in self.projects:
            raise ValueError("训练或测试项目不存在")
        
        print(f"\n🎯 Few-shot 评估: {train_project} → {test_project}")
        
        # 在源项目上训练基础模型
        train_evaluator = self.projects[train_project]
        train_evaluator.split_data(train_ratio=0.8, valid_ratio=0.1, test_ratio=0.1, seed=42)
        
        if feature_keys is None:
            feature_keys = ["style_risk", "structure_risk", "logic_risk"]
        
        base_model = train_evaluator.train_baseline_model(
            feature_keys=feature_keys,
            model_class=model_class,
            **model_kwargs,
        )
        
        # 准备目标项目数据
        test_evaluator = self.projects[test_project]
        test_evaluator.split_data(train_ratio=0.0, valid_ratio=0.0, test_ratio=1.0, seed=42)  # 全部作为测试集
        
        # Zero-shot 性能（基准）
        X_test_full = np.array([
            [row.get(k, 0.0) for k in feature_keys]
            for row in test_evaluator.data
        ])
        y_test_full = np.array([row["label"] for row in test_evaluator.data])
        
        y_pred_zero_shot = base_model.predict(X_test_full)
        zero_shot_f1 = float(f1_score(y_test_full, y_pred_zero_shot, zero_division=0))
        
        print(f"   Zero-shot F1: {zero_shot_f1:.4f}")
        
        # Few-shot 适应
        few_shot_results = []
        
        for n_samples in few_shot_sizes:
            if n_samples >= len(test_evaluator.data):
                print(f"   ⚠️  跳过 {n_samples} 样本（超过数据集大小）")
                continue
            
            print(f"   Few-shot ({n_samples} 样本)...")
            
            # 从目标项目采样 n_samples 用于 fine-tune
            np.random.seed(42)
            finetune_indices = np.random.choice(len(test_evaluator.data), size=n_samples, replace=False)
            test_indices = np.array([i for i in range(len(test_evaluator.data)) if i not in finetune_indices])
            
            X_finetune = X_test_full[finetune_indices]
            y_finetune = y_test_full[finetune_indices]
            
            X_test_remaining = X_test_full[test_indices]
            y_test_remaining = y_test_full[test_indices]
            
            # Fine-tune（重新训练）
            finetuned_model = model_class(**model_kwargs)
            finetuned_model.fit(X_finetune, y_finetune)
            
            # 在剩余测试集上评估
            y_pred_finetuned = finetuned_model.predict(X_test_remaining)
            finetuned_f1 = float(f1_score(y_test_remaining, y_pred_finetuned, zero_division=0))
            
            improvement = finetuned_f1 - zero_shot_f1
            
            few_shot_results.append({
                "n_samples": n_samples,
                "f1": finetuned_f1,
                "improvement_over_zero_shot": float(improvement),
                "test_size": len(y_test_remaining),
            })
            
            print(f"      F1: {finetuned_f1:.4f} (改进 {improvement:+.4f})")
        
        result = {
            "train_project": train_project,
            "test_project": test_project,
            "zero_shot_f1": zero_shot_f1,
            "few_shot_results": few_shot_results,
        }
        
        self.results[f"few_shot_{train_project}_to_{test_project}"] = result
        
        return result

    def generate_cross_project_summary(self) -> str:
        """生成跨项目评估摘要"""
        if not self.results:
            return "⚠️  尚未运行跨项目评估"
        
        summary = """
╔═══════════════════════════════════════════════════════════════╗
║                   跨项目泛化能力评估                           ║
╚═══════════════════════════════════════════════════════════════╝

"""
        
        # Zero-shot 结果
        zero_shot_results = {k: v for k, v in self.results.items() if k.startswith("zero_shot")}
        
        if zero_shot_results:
            summary += "1. Zero-shot 评估（无目标项目样本）\n"
            summary += "─" * 60 + "\n"
            
            for key, result in zero_shot_results.items():
                train_proj = result["train_project"]
                train_f1 = result["train_metrics"]["f1"]
                avg_test_f1 = result["average_test_f1"]
                avg_drop = result["average_f1_drop"]
                
                summary += f"\n训练项目: {train_proj}\n"
                summary += f"   训练集 F1: {train_f1:.4f}\n"
                summary += f"   平均测试 F1: {avg_test_f1:.4f} (下降 {avg_drop:+.4f})\n"
                summary += f"   测试项目详情:\n"
                
                for test_proj, metrics in result["test_results"].items():
                    summary += f"      - {test_proj:20s} F1: {metrics['f1']:.4f} ({metrics['f1_drop_percentage']:+.1f}%)\n"
        
        # Few-shot 结果
        few_shot_results = {k: v for k, v in self.results.items() if k.startswith("few_shot")}
        
        if few_shot_results:
            summary += "\n2. Few-shot 评估（少量目标项目样本）\n"
            summary += "─" * 60 + "\n"
            
            for key, result in few_shot_results.items():
                train_proj = result["train_project"]
                test_proj = result["test_project"]
                zero_shot_f1 = result["zero_shot_f1"]
                
                summary += f"\n{train_proj} → {test_proj}\n"
                summary += f"   Zero-shot F1: {zero_shot_f1:.4f}\n"
                summary += f"   Few-shot 改进:\n"
                
                for fs_result in result["few_shot_results"]:
                    n = fs_result["n_samples"]
                    f1 = fs_result["f1"]
                    improvement = fs_result["improvement_over_zero_shot"]
                    summary += f"      {n:3d} 样本: F1 {f1:.4f} (改进 {improvement:+.4f})\n"
        
        summary += "\n" + "═" * 60 + "\n"
        
        return summary

    def save_results(self, output_path: str):
        """保存跨项目评估结果"""
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(self.results, f, indent=2, ensure_ascii=False)
        
        print(f"💾 跨项目评估结果保存至: {output_file}")


# 示例用法
if __name__ == "__main__":
    import config
    from sklearn.linear_model import LogisticRegression
    
    # 创建跨项目评估器
    evaluator = CrossProjectEvaluator()
    
    # 添加多个项目（假设已有标注数据）
    project_list = [
        ("ConsistenCy", config.DATA_DIR / "annotations" / "consistency_labeled.jsonl"),
        ("PythonPatterns", config.DATA_DIR / "annotations" / "python_patterns_labeled.jsonl"),
        # 更多项目...
    ]
    
    for proj_name, dataset_path in project_list:
        if dataset_path.exists():
            evaluator.add_project(proj_name, str(dataset_path))
        else:
            print(f"⚠️  {proj_name} 数据集不存在: {dataset_path}")
    
    if len(evaluator.projects) >= 2:
        # Zero-shot 评估
        train_proj = list(evaluator.projects.keys())[0]
        test_projs = list(evaluator.projects.keys())[1:]
        
        evaluator.zero_shot_evaluation(
            train_project=train_proj,
            test_projects=test_projs,
            model_class=LogisticRegression,
            max_iter=500,
            random_state=42,
        )
        
        # Few-shot 评估
        if len(test_projs) > 0:
            evaluator.few_shot_evaluation(
                train_project=train_proj,
                test_project=test_projs[0],
                few_shot_sizes=[10, 20, 50],
                model_class=LogisticRegression,
                max_iter=500,
                random_state=42,
            )
        
        # 打印摘要
        print(evaluator.generate_cross_project_summary())
        
        # 保存结果
        evaluator.save_results(str(config.DATA_DIR / "results" / "cross_project_evaluation.json"))
    else:
        print("⚠️  需要至少 2 个项目才能进行跨项目评估")
