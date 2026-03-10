# -*- coding: utf-8 -*-
"""
真实基线对比框架

包含：
1. Pylint/Flake8 基线
2. 简单 heuristics 基线
3. 随机基线
4. 统计显著性检验
"""
import json
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
from sklearn.metrics import f1_score, precision_score, recall_score, accuracy_score

try:
    from .human_labeled_evaluator import HumanLabeledEvaluator
except ImportError:
    from human_labeled_evaluator import HumanLabeledEvaluator


class BaselineMethod:
    """基线方法基类"""

    def __init__(self, name: str):
        self.name = name

    def predict(self, test_data: List[Dict[str, Any]]) -> np.ndarray:
        """预测测试集标签（子类实现）"""
        raise NotImplementedError


class RandomBaseline(BaselineMethod):
    """随机基线"""

    def __init__(self, seed: int = 42):
        super().__init__("Random Baseline")
        self.seed = seed

    def predict(self, test_data: List[Dict[str, Any]]) -> np.ndarray:
        np.random.seed(self.seed)
        return np.random.randint(0, 2, size=len(test_data))


class HeuristicBaseline(BaselineMethod):
    """基于简单启发式的基线"""

    def __init__(self, heuristic_type: str = "changed_files"):
        """
        Args:
            heuristic_type: 启发式类型
                - 'changed_files': 修改文件数 > 阈值 → 高风险
                - 'commit_message_length': commit message 太短/太长 → 高风险
                - 'code_churn': 代码改动行数 > 阈值 → 高风险
        """
        super().__init__(f"Heuristic ({heuristic_type})")
        self.heuristic_type = heuristic_type

    def predict(self, test_data: List[Dict[str, Any]]) -> np.ndarray:
        predictions = []
        
        for row in test_data:
            if self.heuristic_type == "changed_files":
                # 简单规则：修改超过 5 个文件 → 高风险
                changed_files = row.get("changed_files_count", 0)
                pred = 1 if changed_files > 5 else 0
            
            elif self.heuristic_type == "commit_message_length":
                # 简单规则：commit message 太短 (< 10 字符) 或太长 (> 200 字符) → 高风险
                message = row.get("commit_message", "")
                length = len(message)
                pred = 1 if (length < 10 or length > 200) else 0
            
            elif self.heuristic_type == "code_churn":
                # 简单规则：代码改动超过 500 行 → 高风险
                churn = row.get("lines_changed", 0)
                pred = 1 if churn > 500 else 0
            
            else:
                pred = 0
            
            predictions.append(pred)
        
        return np.array(predictions)


class PylintBaseline(BaselineMethod):
    """基于 Pylint 的基线"""

    def __init__(self, threshold: float = 7.0):
        """
        Args:
            threshold: Pylint 分数阈值（低于此值 → 高风险）
        """
        super().__init__("Pylint Baseline")
        self.threshold = threshold

    def predict(self, test_data: List[Dict[str, Any]]) -> np.ndarray:
        """
        根据 Pylint 分数预测。
        
        注意：需要事先运行 Pylint 并将分数存入 test_data
        """
        predictions = []
        
        for row in test_data:
            pylint_score = row.get("pylint_score", 10.0)  # 默认满分（无风险）
            pred = 1 if pylint_score < self.threshold else 0
            predictions.append(pred)
        
        return np.array(predictions)


class ThresholdBaseline(BaselineMethod):
    """基于阈值的基线（用于对比简单的阈值规则）"""

    def __init__(self, feature_key: str = "overall_risk", threshold: float = 0.5):
        """
        Args:
            feature_key: 特征字段名
            threshold: 阈值（超过此值 → 高风险）
        """
        super().__init__(f"Threshold ({feature_key} > {threshold})")
        self.feature_key = feature_key
        self.threshold = threshold

    def predict(self, test_data: List[Dict[str, Any]]) -> np.ndarray:
        predictions = []
        
        for row in test_data:
            value = row.get(self.feature_key, 0.0)
            pred = 1 if value > self.threshold else 0
            predictions.append(pred)
        
        return np.array(predictions)


class BaselineComparison:
    """基线对比框架"""

    def __init__(self, evaluator: HumanLabeledEvaluator):
        self.evaluator = evaluator
        self.results: Dict[str, Dict[str, float]] = {}

    def add_baseline(self, baseline: BaselineMethod) -> Dict[str, float]:
        """添加并评估一个基线方法"""
        print(f"🔍 评估基线: {baseline.name}")
        
        # 获取测试集
        y_true = np.array([row["label"] for row in self.evaluator.test_data])
        
        # 预测
        y_pred = baseline.predict(self.evaluator.test_data)
        
        # 计算指标
        metrics = {
            "precision": float(precision_score(y_true, y_pred, zero_division=0)),
            "recall": float(recall_score(y_true, y_pred, zero_division=0)),
            "f1": float(f1_score(y_true, y_pred, zero_division=0)),
            "accuracy": float(accuracy_score(y_true, y_pred)),
        }
        
        self.results[baseline.name] = metrics
        
        print(f"   F1: {metrics['f1']:.4f}, Precision: {metrics['precision']:.4f}, Recall: {metrics['recall']:.4f}")
        
        return metrics

    def add_model_results(self, model_name: str, y_pred: np.ndarray):
        """添加模型的预测结果用于对比"""
        y_true = np.array([row["label"] for row in self.evaluator.test_data])
        
        metrics = {
            "precision": float(precision_score(y_true, y_pred, zero_division=0)),
            "recall": float(recall_score(y_true, y_pred, zero_division=0)),
            "f1": float(f1_score(y_true, y_pred, zero_division=0)),
            "accuracy": float(accuracy_score(y_true, y_pred)),
        }
        
        self.results[model_name] = metrics
        
        return metrics

    def mcnemar_test(
        self,
        method1_name: str,
        method2_name: str,
        y_pred1: np.ndarray,
        y_pred2: np.ndarray,
    ) -> Dict[str, Any]:
        """
        McNemar's test 检验两个方法的显著性差异。
        
        Returns:
            {"statistic": float, "p_value": float, "significant": bool}
        """
        y_true = np.array([row["label"] for row in self.evaluator.test_data])
        
        # 构建 2x2 列联表
        # [method1正确 & method2错误, method1错误 & method2正确]
        correct1 = (y_pred1 == y_true)
        correct2 = (y_pred2 == y_true)
        
        b = np.sum(correct1 & ~correct2)  # method1对, method2错
        c = np.sum(~correct1 & correct2)  # method1错, method2对
        
        # McNemar's test
        try:
            # continuity correction for small samples
            statistic = (abs(b - c) - 1) ** 2 / (b + c) if (b + c) > 0 else 0.0
            
            # p-value (chi-square with df=1)
            from scipy.stats import chi2
            p_value = 1 - chi2.cdf(statistic, df=1)
            
            significant = p_value < 0.05
            
            return {
                "method1": method1_name,
                "method2": method2_name,
                "b": int(b),  # method1对, method2错
                "c": int(c),  # method1错, method2对
                "statistic": float(statistic),
                "p_value": float(p_value),
                "significant": significant,
                "conclusion": f"{method1_name} {'显著优于' if (b > c and significant) else '不显著优于'} {method2_name}",
            }
        except Exception as e:
            return {"error": str(e)}

    def generate_comparison_table(self) -> str:
        """生成对比表格"""
        if not self.results:
            return "⚠️  尚未添加任何基线方法"
        
        # 找出最佳方法
        sorted_methods = sorted(
            self.results.items(),
            key=lambda x: x[1]["f1"],
            reverse=True,
        )
        
        table = """
╔═══════════════════════════════════════════════════════════════╗
║                      基线对比结果                              ║
╚═══════════════════════════════════════════════════════════════╝

方法名                          F1      Precision  Recall   Accuracy
────────────────────────────────────────────────────────────────────
"""
        
        for method_name, metrics in sorted_methods:
            f1 = metrics["f1"]
            precision = metrics["precision"]
            recall = metrics["recall"]
            accuracy = metrics["accuracy"]
            
            # 标记最佳方法
            marker = "🥇" if method_name == sorted_methods[0][0] else "  "
            
            table += f"{marker} {method_name:30s} {f1:.4f}  {precision:.4f}   {recall:.4f}  {accuracy:.4f}\n"
        
        table += "────────────────────────────────────────────────────────────────────\n"
        
        return table

    def save_results(self, output_path: str):
        """保存对比结果"""
        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)
        
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(self.results, f, indent=2, ensure_ascii=False)
        
        print(f"💾 基线对比结果保存至: {output_file}")


# 示例用法
if __name__ == "__main__":
    import config
    from human_labeled_evaluator import HumanLabeledEvaluator
    
    dataset_path = config.DATA_DIR / "annotations" / "labeled_dataset_v1.jsonl"
    
    if not dataset_path.exists():
        print(f"⚠️  数据集不存在: {dataset_path}")
        print("请先完成人工标注。")
    else:
        # 创建评估器
        evaluator = HumanLabeledEvaluator(str(dataset_path))
        evaluator.split_data(train_ratio=0.6, valid_ratio=0.2, test_ratio=0.2, seed=42)
        
        # 创建基线对比
        comparison = BaselineComparison(evaluator)
        
        # 添加各种基线
        comparison.add_baseline(RandomBaseline(seed=42))
        comparison.add_baseline(HeuristicBaseline("changed_files"))
        comparison.add_baseline(HeuristicBaseline("commit_message_length"))
        comparison.add_baseline(ThresholdBaseline("overall_risk", threshold=0.5))
        
        # 训练模型并添加结果（示例）
        model = evaluator.train_baseline_model()
        y_true = np.array([row["label"] for row in evaluator.test_data])
        X_test = np.array([[row.get(k, 0.0) for k in ["style_risk", "structure_risk", "logic_risk"]] 
                           for row in evaluator.test_data])
        y_pred_model = model.predict(X_test)
        comparison.add_model_results("ConsistenCy (Full Model)", y_pred_model)
        
        # 显著性检验
        y_pred_random = RandomBaseline(seed=42).predict(evaluator.test_data)
        significance = comparison.mcnemar_test(
            "ConsistenCy (Full Model)",
            "Random Baseline",
            y_pred_model,
            y_pred_random,
        )
        
        print("\n" + comparison.generate_comparison_table())
        print(f"\n显著性检验: {significance['conclusion']} (p={significance['p_value']:.4f})")
        
        # 保存结果
        comparison.save_results(str(config.DATA_DIR / "results" / "baseline_comparison.json"))
