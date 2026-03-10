# -*- coding: utf-8 -*-
"""
ConsistenCy - 代码一致性审查工具

Core modules:
- parser: AST解析  
- extractor: 知识提取
- storage: 向量存储
- checker: 一致性检查
- commit_pipeline: 提交级分析

Types and interfaces (v2):
- types: 类型定义
- interfaces: 抽象接口

Evaluation modules (v2):
- human_labeled_evaluator: 基于人工标注的评估
- ablation_study_v2: 真实消融分析
- baselines: 基线对比
- cross_project_evaluator: 跨项目评估

Annotation pipeline (M4):
- project_selector: 项目选择 + 提交采样
- kappa_calculator: 标注一致性计算
- annotation_tool: 人工标注 CLI 工具
"""

__version__ = "0.2.0-alpha"
__author__ = "ConsistenCy Team"

# Core modules
from .parser import CodeParser
from .extractor import KnowledgeExtractor
from .storage import CodeStorage
from .checker import ConsistencyChecker

# Types and interfaces
from .types import (
    CommitContext,
    RiskScore,
    Evidence,
    FunctionMetadata,
    ClassMetadata,
    AnnotatedSample,
    EvaluationMetrics,
)
from .interfaces import (
    ICodeParser,
    IStorage,
    IRetriever,
    IRiskScorer,
    IEvaluator,
)

# Commit analysis
from .commit_pipeline import (
    CommitMiner,
    Neo4jGraphStore,
    HybridRetriever,
    CommitRiskScorer,
)

# Evaluation (v2)
try:
    from .human_labeled_evaluator import HumanLabeledEvaluator
    from .ablation_study_v2 import AblationStudyV2
    from .baselines import BaselineComparison
    from .cross_project_evaluator import CrossProjectEvaluator
except ImportError:
    pass

# Annotation pipeline (M4)
try:
    from .project_selector import ProjectSelector, ProjectCriteria, CommitSampler
    from .kappa_calculator import KappaCalculator
    from .annotation_tool import AnnotationTool
except ImportError:
    pass

__all__ = [
    # Version
    "__version__",
    "__author__",
    
    # Core classes
    "CodeParser",
    "KnowledgeExtractor",
    "CodeStorage",
    "ConsistencyChecker",
    
    # Types
    "CommitContext",
    "RiskScore",
    "Evidence",
    "FunctionMetadata",
    "ClassMetadata",
    "AnnotatedSample",
    "EvaluationMetrics",
    
    # Interfaces
    "ICodeParser",
    "IStorage",
    "IRetriever",
    "IRiskScorer",
    "IEvaluator",
    
    # Commit analysis
    "CommitMiner",
    "Neo4jGraphStore",
    "HybridRetriever",
    "CommitRiskScorer",
]
