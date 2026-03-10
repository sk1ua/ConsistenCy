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

ML_CONFIG["model_dir"].mkdir(exist_ok=True)

# 支持的文件类型
SUPPORTED_EXTENSIONS = {
    ".py": "python",
    # 未来可扩展
    # ".js": "javascript",
    # ".java": "java",
}
