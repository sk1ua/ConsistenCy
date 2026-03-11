# -*- coding: utf-8 -*-
"""
ConsistenCy 配置文件

提供多 Agent 分析框架所需的运行时配置。
"""
from pathlib import Path

# ─── 路径 ────────────────────────────────────────────────────────────────────
ROOT_DIR = Path(__file__).parent.parent
DATA_DIR  = ROOT_DIR / "data"

DATA_DIR.mkdir(exist_ok=True)
(DATA_DIR / "models").mkdir(exist_ok=True)

# ─── 分析器权重（与 RiskScoringAgent 默认值保持一致）─────────────────────────
RISK_WEIGHTS = {
    "style":      0.25,
    "structural": 0.35,
    "semantic":   0.30,
    "evolution":  0.10,
}

# ─── Pipeline 参数 ───────────────────────────────────────────────────────────
PIPELINE_CONFIG = {
    # 分析单个 commit 时用最近多少个 commit 作为 baseline
    "default_baseline_commits": 50,
    # file_summary / hotspot_data 时每次最多分析多少个文件
    "max_files_per_commit": 20,
    # weekly_history 最多回溯多少个 commit
    "weekly_history_max_commits": 200,
    # hotspot_data 最多回溯多少个 commit
    "hotspot_max_commits": 100,
    # 返回热点文件的上限
    "hotspot_top_n": 30,
}

# ─── 支持的文件类型 ───────────────────────────────────────────────────────────
SUPPORTED_EXTENSIONS = {
    ".py": "python",
    # 未来可扩展：".js": "javascript", ".java": "java"
}

# ─── Flask Dashboard ──────────────────────────────────────────────────────────
DASHBOARD_CONFIG = {
    "host": "0.0.0.0",
    "port": 8000,
    "debug": False,
}
