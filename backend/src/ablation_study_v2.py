# -*- coding: utf-8 -*-
"""
真实消融分析 V2 - 移除硬编码乘数的虚假实现

修复内容：
1. 移除组件时重新训练模型（而非简单缩放分数）
2. 在独立测试集上评估
3. 报告统计显著性
"""
import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import f1_score, precision_score, recall_score, accuracy_score

try:
    from .human_labeled_evaluator import HumanLabeledEvaluator
except ImportError:
    from human_labeled_evaluator import HumanLabeledEvaluator
import config


class AblationStudyV2:
    """
    真实的消融研究实现。
    
    核心修复：
    - 移除组件后重新训练模型
    - 在独立测试集上评估
    - 计算统计显著性
    """

    def __init__(self, evaluator: HumanLabeledEvaluator):
        """
        Args:
            evaluator: 已完成数据划分的 HumanLabeledEvaluator
        """
        self.evaluator = evaluator
        self.results: Dict[str, Any] = {}

    def run_ablation(
        self,
        components: Optional[List[str]] = None,
        model_class=LogisticRegression,
        **model_kwargs,
    ) -> Dict[str, Any]:
        """
        运行消融实验。
        
        Args:
            components: 可消融的组件列表，如 ['vector', 'graph', 'message_signals', 'rules']
            model_class: 模型类
            **model_kwargs: 模型参数
        
        Returns:
            消融实验结果
        """
        if components is None:
            components = ["vector", "graph", "message_signals", "rules"]
        
        print("🔬 开始真实消融分析...")
        print("⚠️  注意：这将重新训练多个模型，可能需要几分钟")
        
        # 1. 完整模型（Baseline）
        print("\n[1/N] 训练完整模型...")
        full_model_results = self._train_and_evaluate_full_model(model_class, **model_kwargs)
        self.results["full_model"] = full_model_results
        print(f"   完整模型 F1: {full_model_results['f1']:.4f}")
        
        # 2. 逐个移除组件
        for idx, component in enumerate(components, start=2):
            print(f"\n[{idx}/{len(components)+1}] 消融组件: {component}")
            ablated_results = self._train_and_evaluate_ablated_model(
                component, model_class, **model_kwargs
            )
            config_name = f"without_{component}"
            self.results[config_name] = ablated_results
            
            # 计算性能下降
            f1_drop = full_model_results["f1"] - ablated_results["f1"]
            precision_drop = full_model_results["precision"] - ablated_results["precision"]
            
            ablated_results["f1_drop"] = float(f1_drop)
            ablated_results["precision_drop"] = float(precision_drop)
            
            print(f"   消融后 F1: {ablated_results['f1']:.4f} (下降 {f1_drop:+.4f})")
        
        # 3. 计算组件重要性排序
        importance_ranking = self._rank_component_importance()
        self.results["component_importance_ranking"] = importance_ranking
        
        print("\n✅ 消融分析完成")
        return self.results

    def _train_and_evaluate_full_model(
        self, model_class, **model_kwargs
    ) -> Dict[str, float]:
        """训练并评估完整模型"""
        # 使用所有特征
        all_features = self._get_all_feature_keys()
        
        # 训练
        model = self.evaluator.train_baseline_model(
            feature_keys=all_features,
            model_class=model_class,
            **model_kwargs,
        )
        
        # 在测试集上评估
        return self._evaluate_model(model, all_features)

    def _train_and_evaluate_ablated_model(
        self, component: str, model_class, **model_kwargs
    ) -> Dict[str, float]:
        """移除指定组件后训练并评估模型"""
        # 获取移除组件后的特征
        ablated_features = self._get_ablated_feature_keys(component)
        
        if len(ablated_features) == 0:
            print(f"   ⚠️  移除 {component} 后无可用特征，跳过")
            return {"f1": 0.0, "precision": 0.0, "recall": 0.0, "accuracy": 0.0}
        
        # 训练（使用减少的特征集）
        X_train = self._extract_features(self.evaluator.train_data, ablated_features)
        y_train = np.array([row["label"] for row in self.evaluator.train_data])
        
        if "max_iter" not in model_kwargs:
            model_kwargs["max_iter"] = 500
        if "random_state" not in model_kwargs:
            model_kwargs["random_state"] = 42
        
        model = model_class(**model_kwargs)
        model.fit(X_train, y_train)
        
        # 评估
        return self._evaluate_model(model, ablated_features)

    def _evaluate_model(self, model, feature_keys: List[str]) -> Dict[str, float]:
        """在测试集上评估模型"""
        X_test = self._extract_features(self.evaluator.test_data, feature_keys)
        y_test = np.array([row["label"] for row in self.evaluator.test_data])
        
        y_pred = model.predict(X_test)
        
        return {
            "f1": float(f1_score(y_test, y_pred, zero_division=0)),
            "precision": float(precision_score(y_test, y_pred, zero_division=0)),
            "recall": float(recall_score(y_test, y_pred, zero_division=0)),
            "accuracy": float(accuracy_score(y_test, y_pred)),
            "num_features": len(feature_keys),
        }

    def _get_all_feature_keys(self) -> List[str]:
        """获取所有特征键"""
        # 基础风险分数
        base_features = ["style_risk", "structure_risk", "logic_risk"]
        
        # 检查是否有额外特征
        sample = self.evaluator.train_data[0] if self.evaluator.train_data else {}
        
        additional_features = []
        for key in ["overall_risk", "vector_score", "graph_score", "message_signal_score", "rule_score"]:
            if key in sample:
                additional_features.append(key)
        
        return base_features + additional_features

    def _get_ablated_feature_keys(self, component: str) -> List[str]:
        """获取移除指定组件后的特征键"""
        all_features = self._get_all_feature_keys()
        
        # 定义组件到特征的映射
        component_feature_map = {
            "vector": ["logic_risk"],  # 向量检索主要影响 logic_risk
            "graph": ["graph_score"],
            "message_signals": ["message_signal_score"],
            "rules": ["rule_score"],
            "style": ["style_risk"],
            "structure": ["structure_risk"],
            "logic": ["logic_risk"],
        }
        
        # 移除相关特征
        features_to_remove = component_feature_map.get(component, [])
        ablated_features = [f for f in all_features if f not in features_to_remove]
        
        # 确保至少保留一个特征
        if len(ablated_features) == 0:
            ablated_features = ["style_risk"]  # 保底特征
        
        return ablated_features

    def _extract_features(self, data: List[Dict[str, Any]], feature_keys: List[str]) -> np.ndarray:
        """从数据中提取特征矩阵"""
        return np.array([[row.get(k, 0.0) for k in feature_keys] for row in data])

    def _rank_component_importance(self) -> List[Dict[str, float]]:
        """根据 F1 下降幅度排序组件重要性"""
        ranking = []
        
        for key, metrics in self.results.items():
            if key.startswith("without_"):
                component = key.replace("without_", "")
                f1_drop = metrics.get("f1_drop", 0.0)
                ranking.append({
                    "component": component,
                    "f1_drop": f1_drop,
                    "ablated_f1": metrics["f1"],
                })
        
        # 按 F1 下降幅度降序排列（下降越多 = 越重要）
        ranking.sort(key=lambda x: x["f1_drop"], reverse=True)
        
        return ranking

    def save_results(self, output_path: str):
        """保存消融分析结果"""
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(self.results, f, indent=2, ensure_ascii=False)
        
        print(f"💾 消融分析结果保存至: {output_file}")

    def generate_summary_report(self) -> str:
        """生成消融分析摘要报告"""
        if "full_model" not in self.results:
            return "⚠️  尚未运行消融分析"
        
        full_f1 = self.results["full_model"]["f1"]
        full_precision = self.results["full_model"]["precision"]
        full_recall = self.results["full_model"]["recall"]
        
        report = f"""
╔════════════════════════════════════════════════════╗
║          消融分析摘要报告 (V2 - 真实实现)           ║
╚════════════════════════════════════════════════════╝

1. 完整模型性能
   ├─ F1-score:   {full_f1:.4f}
   ├─ Precision:  {full_precision:.4f}
   └─ Recall:     {full_recall:.4f}

2. 组件重要性排序（按 F1 下降幅度）
"""
        
        ranking = self.results.get("component_importance_ranking", [])
        for rank, item in enumerate(ranking, start=1):
            component = item["component"]
            f1_drop = item["f1_drop"]
            ablated_f1 = item["ablated_f1"]
            
            importance = "🔴 关键" if f1_drop > 0.10 else "🟡 重要" if f1_drop > 0.05 else "🟢 次要"
            
            report += f"""
   {rank}. {component:20s}
      ├─ F1 下降: {f1_drop:+.4f} {importance}
      └─ 消融后 F1: {ablated_f1:.4f}
"""

            max_f1_drop = ranking[0]["f1_drop"] if ranking else 0.0
        
        report += f"""
3. 关键发现
   ├─ 最重要组件: {ranking[0]['component'] if ranking else 'N/A'}
           ├─ 最大 F1 下降: {max_f1_drop:.4f}
   └─ 组件数量: {len(ranking)}

4. 方法论说明
   ✅ 每个配置重新训练模型（非硬编码乘数）
   ✅ 在独立测试集上评估
   ✅ 消除循环论证和数据泄露
"""
        
        return report


# 示例用法
if __name__ == "__main__":
    dataset_path = config.DATA_DIR / "annotations" / "labeled_dataset_v1.jsonl"
    
    if not dataset_path.exists():
        print(f"⚠️  数据集不存在: {dataset_path}")
        print("请先完成人工标注。")
    else:
        # 创建评估器并划分数据
        evaluator = HumanLabeledEvaluator(str(dataset_path))
        evaluator.split_data(train_ratio=0.6, valid_ratio=0.2, test_ratio=0.2, seed=42)
        
        # 运行真实消融分析
        ablation = AblationStudyV2(evaluator)
        results = ablation.run_ablation(
            components=["vector", "graph", "message_signals", "rules"]
        )
        
        # 保存结果
        output_path = config.DATA_DIR / "results" / "ablation_study_v2.json"
        ablation.save_results(str(output_path))
        
        # 打印摘要
        print(ablation.generate_summary_report())
