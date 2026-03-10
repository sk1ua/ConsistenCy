# -*- coding: utf-8 -*-
"""
轻量命名风格模型（v0.2.0）
使用字符级 n-gram + 逻辑回归做小模型训练与预测
"""
from typing import Dict, List, Any, Optional
from pathlib import Path

import joblib
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline

import config


class NamingStyleModel:
    """命名风格小模型"""

    def __init__(self, model_path: Optional[str] = None):
        self.model_path = Path(model_path) if model_path else config.ML_CONFIG["naming_model_file"]
        self.pipeline: Optional[Pipeline] = None

    def is_ready(self) -> bool:
        return self.pipeline is not None

    def load(self) -> bool:
        """加载已训练模型"""
        if not self.model_path.exists():
            return False

        try:
            self.pipeline = joblib.load(self.model_path)
            return True
        except Exception as e:
            print(f"⚠️  模型加载失败: {e}")
            return False

    def train_from_knowledge(self, knowledge: Dict[str, Any]) -> Dict[str, Any]:
        """
        从提取后的知识中训练模型

        训练目标：
        - 输入：name + type（function/class）
        - 输出：命名风格（snake_case, PascalCase, ...）
        """
        samples: List[str] = []
        labels: List[str] = []

        for func in knowledge.get("all_functions", []):
            style = func.get("naming_style", "unknown")
            if style == "unknown":
                continue
            name = func.get("name", "")
            samples.append(f"function::{name}")
            labels.append(style)

        for cls in knowledge.get("all_classes", []):
            style = cls.get("naming_style", "unknown")
            if style == "unknown":
                continue
            name = cls.get("name", "")
            samples.append(f"class::{name}")
            labels.append(style)

        if len(samples) < config.ML_CONFIG["min_train_samples"]:
            return {
                "ok": False,
                "message": f"样本不足，至少需要 {config.ML_CONFIG['min_train_samples']} 条，当前 {len(samples)} 条",
                "samples": len(samples),
            }

        self.pipeline = Pipeline(
            steps=[
                (
                    "tfidf",
                    TfidfVectorizer(
                        analyzer="char_wb",
                        ngram_range=(2, 5),
                        max_features=config.ML_CONFIG["max_features"],
                    ),
                ),
                ("clf", LogisticRegression(max_iter=500, class_weight="balanced")),
            ]
        )

        self.pipeline.fit(samples, labels)
        self.model_path.parent.mkdir(parents=True, exist_ok=True)
        joblib.dump(self.pipeline, self.model_path)

        label_set = sorted(set(labels))
        return {
            "ok": True,
            "message": "模型训练完成",
            "samples": len(samples),
            "labels": label_set,
            "model_path": str(self.model_path),
        }

    def predict_style(self, name: str, symbol_type: str) -> Optional[Dict[str, Any]]:
        """预测命名风格和置信度"""
        if not self.pipeline:
            if not self.load():
                return None

        text = f"{symbol_type}::{name}"

        try:
            pred = self.pipeline.predict([text])[0]
            proba = 0.0

            if hasattr(self.pipeline, "predict_proba"):
                probs = self.pipeline.predict_proba([text])[0]
                proba = float(max(probs))

            return {
                "predicted_style": pred,
                "confidence": proba,
            }
        except Exception as e:
            print(f"⚠️  预测失败: {e}")
            return None
