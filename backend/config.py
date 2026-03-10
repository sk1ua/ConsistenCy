# -*- coding: utf-8 -*-
"""
配置文件
"""
import os
from pathlib import Path

# 项目根目录
ROOT_DIR = Path(__file__).parent.parent

# 数据存储路径
DATA_DIR = ROOT_DIR / "data"
CHROMA_DIR = DATA_DIR / "chroma_db"
RULES_FILE = DATA_DIR / "rules.json"

# 确保目录存在
DATA_DIR.mkdir(exist_ok=True)
CHROMA_DIR.mkdir(exist_ok=True)

# OpenAI配置（可选）
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
OPENAI_BASE_URL = os.getenv("OPENAI_BASE_URL", "https://api.openai.com/v1")

# 一致性检查配置
CHECK_CONFIG = {
    "naming": {
        "function": "snake_case",  # 函数命名：snake_case
        "class": "PascalCase",     # 类命名：PascalCase
        "constant": "UPPER_CASE",  # 常量命名：UPPER_CASE
        "variable": "snake_case"   # 变量命名：snake_case
    },
    "similarity_threshold": 0.85,  # 代码相似度阈值（超过此值认为重复）
    "max_function_length": 50,     # 最大函数行数
    "max_line_length": 120         # 最大行长度
}

# 轻量模型配置（v0.2.0）
ML_CONFIG = {
    "model_dir": DATA_DIR / "models",
    "naming_model_file": DATA_DIR / "models" / "naming_style_model.joblib",
    "min_train_samples": 20,
    "confidence_threshold": 0.60,
    "max_features": 3000,
}

# 向量数据库配置（v0.2.0）
VECTOR_DB_CONFIG = {
    "backend": "chroma",
    "collection_prefix": "consistency",
    "default_n_results": 5,
}

# 提交级管线配置（v0.2.1-dev）
COMMIT_PIPELINE_CONFIG = {
    "default_eval_seed": 42,
    "default_eval_rev": "HEAD",
    "min_eval_samples": 20,
    "neutral_logic_penalty_when_no_evidence": 0.5,
}

# M2: 图谱与融合检索配置（v0.3.0-dev）
GRAPH_CONFIG = {
    "neo4j_batch_size": 50,
    "neo4j_retry_attempts": 3,
    "neo4j_timeout_seconds": 30,
    "enable_function_call_edges": False,  # 未来扩展
}

HYBRID_RETRIEVAL_CONFIG = {
    "vector_weight": 0.6,
    "graph_weight": 0.4,
    "fusion_method": "weighted_sum",  # weighted_sum | rrf | linear_combination
    "rrf_k": 60,  # Reciprocal Rank Fusion 参数
    "min_confidence_threshold": 0.3,
}

RISK_SCORING_CONFIG = {
    "default_weights": {
        "style": 0.4,
        "structure": 0.3,
        "logic": 0.3,
    },
    "auto_tune_enabled": False,
    "tuned_weights_file": DATA_DIR / "models" / "tuned_risk_weights.json",
}

# M3: 多模态信号配置（v0.4.0-dev）
MULTIMODAL_CONFIG = {
    "enable_commit_message_analysis": True,
    "enable_pr_context": False,  # 需要 GitHub API
    "enable_review_comments": False,  # 需要 GitHub API
    "message_keywords": {
        "high_risk": ["hack", "workaround", "temporary", "quick fix", "todo", "fixme"],
        "refactor": ["refactor", "cleanup", "reorganize", "restructure"],
        "breaking": ["breaking", "backward incompatible", "api change"],
    },
    "message_max_length": 500,
    "risk_adjustments": {
        "high_risk_keywords": {"style": 0.0, "structure": 0.05, "logic": 0.12},
        "breaking_keywords": {"style": 0.0, "structure": 0.12, "logic": 0.08},
        "too_short": {"style": 0.08, "structure": 0.0, "logic": 0.05},
        "too_long": {"style": 0.0, "structure": 0.04, "logic": 0.02},
        "refactor_hint": {"style": -0.05, "structure": -0.05, "logic": -0.03},
    },
}

# M3: 规则推理配置
RULE_ENGINE_CONFIG = {
    "enable_rule_inference": True,
    "rules_file": DATA_DIR / "rules.json",
    "rule_confidence_threshold": 0.7,
    "combine_with_ml": True,  # 规则 + ML 融合
    "ml_weight": 0.6,
    "rule_weight": 0.4,
}

# M3: 实验框架配置
EXPERIMENT_CONFIG = {
    "output_dir": DATA_DIR / "experiments",
    "enable_ablation_study": True,
    "baseline_methods": ["vector_only", "graph_only", "hybrid_weighted", "hybrid_rrf"],
    "metrics": ["precision", "recall", "f1", "accuracy"],
    "cross_validation_folds": 5,
    "random_seeds": [42, 123, 456],
    "case_top_n_default": 5,
}

ML_CONFIG["model_dir"].mkdir(exist_ok=True)
RISK_SCORING_CONFIG["tuned_weights_file"].parent.mkdir(exist_ok=True)
EXPERIMENT_CONFIG["output_dir"].mkdir(exist_ok=True)

# 支持的文件类型
SUPPORTED_EXTENSIONS = {
    ".py": "python",
    # 未来可扩展
    # ".js": "javascript",
    # ".java": "java",
}
