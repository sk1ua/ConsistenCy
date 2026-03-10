# -*- coding: utf-8 -*-
"""
人工标注评估器 - 替代有循环论证问题的 WeakEvalRunner

修复内容：
1. 使用真实的人工标注标签，而非模型自生成标签
2. 严格的 train/valid/test 划分
3. 独立测试集评估
4. 报告置信区间
"""
import json
import random
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import (
    accuracy_score,
    precision_score,
    recall_score,
    f1_score,
    roc_auc_score,
    confusion_matrix,
)
from sklearn.model_selection import train_test_split

import config


class HumanLabeledEvaluator:
    """
    基于人工标注数据集的评估器。
    
    核心修复：
    - 不再从模型输出生成标签（消除循环论证）
    - 使用外部人工标注的真实标签
    - 严格独立的测试集（不参与训练/调参）
    """

    def __init__(self, labeled_dataset_path: str):
        """
        Args:
            labeled_dataset_path: 人工标注数据集路径（JSONL 格式）
                每行格式：{"commit": "sha", "label": 0/1, "scores": {...}, ...}
        """
        self.dataset_path = Path(labeled_dataset_path)
        self.data: List[Dict[str, Any]] = []
        self.train_data: List[Dict[str, Any]] = []
        self.valid_data: List[Dict[str, Any]] = []
        self.test_data: List[Dict[str, Any]] = []
        
        if not self.dataset_path.exists():
            raise FileNotFoundError(f"标注数据集不存在: {self.dataset_path}")
        
        self._load_data()
        self._validate_labels()

    def _load_data(self):
        """加载标注数据"""
        with open(self.dataset_path, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    row = json.loads(line)
                    self.data.append(row)
                except json.JSONDecodeError as e:
                    print(f"⚠️  跳过无效行: {e}")
                    continue
        
        print(f"✅ 加载 {len(self.data)} 条标注样本")

    def _validate_labels(self):
        """验证标签来源，确保不是模型自生成"""
        for idx, row in enumerate(self.data):
            # 检查必需字段
            if "label" not in row:
                raise ValueError(f"样本 {idx} 缺少 'label' 字段")
            
            # 检查标签来源（防止循环论证）
            if "label_source" in row:
                if row["label_source"] in ["model_generated", "percentile", "weak_supervision"]:
                    raise ValueError(
                        f"样本 {idx} 的标签来源为 '{row['label_source']}'，这是模型自生成标签！"
                        "请使用人工标注 (human_annotation) 或外部真实信号 (code_review_rejection)。"
                    )
            else:
                print(f"⚠️  样本 {idx} 没有 'label_source' 字段，假设为人工标注")
        
        print("✅ 标签来源验证通过")

    def split_data(
        self,
        train_ratio: float = 0.6,
        valid_ratio: float = 0.2,
        test_ratio: float = 0.2,
        seed: int = 42,
        stratify: bool = True,
    ) -> Dict[str, int]:
        """
        划分训练集、验证集、测试集。
        
        重要：测试集严格保留，不参与任何训练或调参。
        
        Args:
            train_ratio: 训练集比例（用于模型训练）
            valid_ratio: 验证集比例（用于超参数调优）
            test_ratio: 测试集比例（只在最终评估时使用一次）
            seed: 随机种子
            stratify: 是否按标签分层采样
        
        Returns:
            {"train": n, "valid": m, "test": k}
        """
        if abs(train_ratio + valid_ratio + test_ratio - 1.0) > 1e-6:
            raise ValueError("train_ratio + valid_ratio + test_ratio 必须等于 1.0")
        
        random.seed(seed)
        np.random.seed(seed)
        
        # 获取标签用于分层
        labels = np.array([row["label"] for row in self.data])
        
        # 检查标签分布
        unique, counts = np.unique(labels, return_counts=True)
        print(f"📊 标签分布: {dict(zip(unique, counts))}")
        
        if stratify and len(unique) < 2:
            print("⚠️  标签单一，无法分层采样")
            stratify = False
        
        # 第一次划分：分离出测试集
        train_valid_data, test_data = train_test_split(
            self.data,
            test_size=test_ratio,
            random_state=seed,
            stratify=labels if stratify else None,
        )
        
        # 第二次划分：从 train+valid 中分离出验证集
        train_valid_labels = np.array([row["label"] for row in train_valid_data])
        relative_valid_ratio = valid_ratio / (train_ratio + valid_ratio)
        
        train_data, valid_data = train_test_split(
            train_valid_data,
            test_size=relative_valid_ratio,
            random_state=seed,
            stratify=train_valid_labels if stratify else None,
        )
        
        self.train_data = train_data
        self.valid_data = valid_data
        self.test_data = test_data
        
        print(f"✅ 数据集划分完成:")
        print(f"   训练集: {len(train_data)} 样本")
        print(f"   验证集: {len(valid_data)} 样本")
        print(f"   测试集: {len(test_data)} 样本 （严格保留）")
        
        return {
            "train": len(train_data),
            "valid": len(valid_data),
            "test": len(test_data),
        }

    def save_splits(self, output_dir: str):
        """保存数据集划分到文件"""
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        
        splits = {
            "train.jsonl": self.train_data,
            "valid.jsonl": self.valid_data,
            "test.jsonl": self.test_data,
        }
        
        for filename, data in splits.items():
            filepath = output_path / filename
            with open(filepath, "w", encoding="utf-8") as f:
                for row in data:
                    f.write(json.dumps(row, ensure_ascii=False) + "\n")
            print(f"💾 保存: {filepath}")

    def evaluate_on_test(
        self,
        model: Any,
        feature_keys: Optional[List[str]] = None,
        bootstrap_iterations: int = 1000,
    ) -> Dict[str, Any]:
        """
        在独立测试集上评估模型（只调用一次）。
        
        Args:
            model: 训练好的模型（需要有 predict/predict_proba 方法）
            feature_keys: 特征字段名列表
            bootstrap_iterations: Bootstrap 重采样次数（用于计算置信区间）
        
        Returns:
            包含指标和 95% 置信区间的结果
        """
        if len(self.test_data) == 0:
            raise ValueError("测试集为空，请先调用 split_data()")
        
        if feature_keys is None:
            feature_keys = ["style_risk", "structure_risk", "logic_risk"]
        
        # 提取特征和标签
        X_test = np.array([[row.get(k, 0.0) for k in feature_keys] for row in self.test_data])
        y_test = np.array([row["label"] for row in self.test_data])
        
        # 预测
        y_pred = model.predict(X_test)
        
        # 计算基础指标
        metrics = {
            "test_size": len(y_test),
            "precision": float(precision_score(y_test, y_pred, zero_division=0)),
            "recall": float(recall_score(y_test, y_pred, zero_division=0)),
            "f1": float(f1_score(y_test, y_pred, zero_division=0)),
            "accuracy": float(accuracy_score(y_test, y_pred)),
        }
        
        # 如果模型支持概率预测，计算 AUC
        if hasattr(model, "predict_proba"):
            try:
                y_proba = model.predict_proba(X_test)[:, 1]
                metrics["auc_roc"] = float(roc_auc_score(y_test, y_proba))
            except Exception as e:
                print(f"⚠️  无法计算 AUC: {e}")
        
        # 混淆矩阵
        cm = confusion_matrix(y_test, y_pred)
        metrics["confusion_matrix"] = cm.tolist()
        
        # Bootstrap 置信区间
        print(f"🔄 计算 95% 置信区间 (Bootstrap, n={bootstrap_iterations})...")
        ci = self._bootstrap_confidence_interval(
            y_test, y_pred, iterations=bootstrap_iterations
        )
        metrics["confidence_intervals_95"] = ci
        
        return metrics

    def _bootstrap_confidence_interval(
        self,
        y_true: np.ndarray,
        y_pred: np.ndarray,
        iterations: int = 1000,
        alpha: float = 0.05,
    ) -> Dict[str, Tuple[float, float]]:
        """
        Bootstrap 重采样计算置信区间。
        
        Returns:
            {"f1": (lower, upper), "precision": (lower, upper), ...}
        """
        n = len(y_true)
        f1_scores = []
        precision_scores = []
        recall_scores = []
        
        for _ in range(iterations):
            # 有放回抽样
            indices = np.random.choice(n, size=n, replace=True)
            y_true_sample = y_true[indices]
            y_pred_sample = y_pred[indices]
            
            # 计算指标
            f1_scores.append(f1_score(y_true_sample, y_pred_sample, zero_division=0))
            precision_scores.append(precision_score(y_true_sample, y_pred_sample, zero_division=0))
            recall_scores.append(recall_score(y_true_sample, y_pred_sample, zero_division=0))
        
        # 计算置信区间
        def percentile_ci(scores):
            lower = np.percentile(scores, alpha / 2 * 100)
            upper = np.percentile(scores, (1 - alpha / 2) * 100)
            return (float(lower), float(upper))
        
        return {
            "f1": percentile_ci(f1_scores),
            "precision": percentile_ci(precision_scores),
            "recall": percentile_ci(recall_scores),
        }

    def train_baseline_model(
        self,
        feature_keys: Optional[List[str]] = None,
        model_class=LogisticRegression,
        **model_kwargs,
    ) -> Any:
        """
        在训练集上训练基线模型。
        
        Args:
            feature_keys: 特征字段名
            model_class: 模型类（默认 LogisticRegression）
            **model_kwargs: 模型参数
        
        Returns:
            训练好的模型
        """
        if len(self.train_data) == 0:
            raise ValueError("训练集为空，请先调用 split_data()")
        
        if feature_keys is None:
            feature_keys = ["style_risk", "structure_risk", "logic_risk"]
        
        X_train = np.array([[row.get(k, 0.0) for k in feature_keys] for row in self.train_data])
        y_train = np.array([row["label"] for row in self.train_data])
        
        # 默认参数
        if "max_iter" not in model_kwargs:
            model_kwargs["max_iter"] = 500
        if "random_state" not in model_kwargs:
            model_kwargs["random_state"] = 42
        
        model = model_class(**model_kwargs)
        model.fit(X_train, y_train)
        
        print(f"✅ 模型训练完成: {model_class.__name__}")
        return model


class DatasetStatistics:
    """数据集统计分析工具"""
    
    @staticmethod
    def analyze_dataset(dataset_path: str) -> Dict[str, Any]:
        """分析数据集的统计特征"""
        evaluator = HumanLabeledEvaluator(dataset_path)
        
        labels = [row["label"] for row in evaluator.data]
        unique, counts = np.unique(labels, return_counts=True)
        
        stats = {
            "total_samples": len(evaluator.data),
            "label_distribution": dict(zip([int(u) for u in unique], [int(c) for c in counts])),
            "class_balance": float(min(counts) / max(counts)) if len(counts) > 1 else 1.0,
        }
        
        # 如果有风险分数，计算统计量
        if evaluator.data and "style_risk" in evaluator.data[0]:
            for risk_type in ["style_risk", "structure_risk", "logic_risk"]:
                scores = [row.get(risk_type, 0.0) for row in evaluator.data]
                stats[f"{risk_type}_mean"] = float(np.mean(scores))
                stats[f"{risk_type}_std"] = float(np.std(scores))
        
        return stats


# 示例用法
if __name__ == "__main__":
    # 假设有人工标注数据集
    dataset_path = config.DATA_DIR / "annotations" / "labeled_dataset_v1.jsonl"
    
    if not dataset_path.exists():
        print(f"⚠️  数据集不存在: {dataset_path}")
        print("请先完成人工标注，创建标注数据集。")
        print("参考: data/annotations/ANNOTATION_GUIDELINE.md")
    else:
        # 创建评估器
        evaluator = HumanLabeledEvaluator(str(dataset_path))
        
        # 划分数据集
        evaluator.split_data(train_ratio=0.6, valid_ratio=0.2, test_ratio=0.2, seed=42)
        
        # 保存划分结果
        evaluator.save_splits(str(config.DATA_DIR / "split"))
        
        # 训练基线模型
        model = evaluator.train_baseline_model()
        
        # 在测试集上评估（只调用一次！）
        results = evaluator.evaluate_on_test(model, bootstrap_iterations=1000)
        
        print("\n📊 测试集评估结果:")
        print(f"   F1-score: {results['f1']:.4f} (95% CI: {results['confidence_intervals_95']['f1']})")
        print(f"   Precision: {results['precision']:.4f} (95% CI: {results['confidence_intervals_95']['precision']})")
        print(f"   Recall: {results['recall']:.4f} (95% CI: {results['confidence_intervals_95']['recall']})")
        
        if "auc_roc" in results:
            print(f"   AUC-ROC: {results['auc_roc']:.4f}")
