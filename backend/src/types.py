# -*- coding: utf-8 -*-
"""
类型定义

提供整个项目通用的类型别名和 TypedDict 定义，增强类型安全性。
"""
from typing import Dict, List, Any, Union, Optional, TypedDict, Literal
from dataclasses import dataclass
from pathlib import Path


# ==================== 基础类型 ====================

FilePath = Union[str, Path]
CommitSHA = str
RepoPath = Union[str, Path]

NamingStyle = Literal["snake_case", "camelCase", "PascalCase", "SCREAMING_SNAKE_CASE", "kebab-case", "mixed"]
FileLanguage = Literal["python", "javascript", "java"]  # 可扩展


# ==================== 代码元素类型 ====================

class FunctionMetadata(TypedDict, total=False):
    """函数元数据"""
    name: str
    file_path: str
    line: int
    signature: str
    parameters: List[str]
    decorators: List[str]
    docstring: str
    is_async: bool
    naming_style: NamingStyle
    snippet: str
    complexity: int  # 圈复杂度
    length: int  # 行数


class ClassMetadata(TypedDict, total=False):
    """类元数据"""
    name: str
    file_path: str
    line: int
    bases: List[str]
    methods: List[str]
    docstring: str
    naming_style: NamingStyle
    snippet: str


class VariableMetadata(TypedDict, total=False):
    """变量元数据"""
    name: str
    line: int
    scope: Literal["local", "global", "class"]
    naming_style: NamingStyle


# ==================== 提交相关类型 ====================

@dataclass
class CommitContext:
    """提交上下文"""
    commit_id: CommitSHA
    repo_path: RepoPath
    author: str
    message: str
    timestamp: str
    changed_files: List[str]
    deleted_files: List[str]
    added_functions: List[FunctionMetadata]
    modified_functions: List[FunctionMetadata]
    deleted_functions: List[FunctionMetadata]


class RiskScore(TypedDict):
    """风险评分"""
    commit_id: CommitSHA
    author: str
    style_risk: float  # 0.0 - 1.0
    structure_risk: float
    logic_risk: float
    overall_risk: float
    confidence: float  # 置信度
    weights: Dict[str, float]  # 各维度权重


class Evidence(TypedDict, total=False):
    """证据信息"""
    function: str
    file: str
    line: int
    score: float
    source: Literal["vector", "graph", "rule"]
    reason: str  # 为什么被选为证据
    diff: Optional[str]  # 代码差异


# ==================== 检索相关类型 ====================

class RetrievalResult(TypedDict):
    """检索结果"""
    function_name: str
    file_path: str
    line: int
    score: float
    source: Literal["vector", "graph", "hybrid"]
    embedding: Optional[List[float]]


class SearchQuery(TypedDict):
    """搜索查询"""
    text: str
    top_k: int
    filter_metadata: Optional[Dict[str, Any]]
    min_score: float


# ==================== 评估相关类型 ====================

class AnnotatedSample(TypedDict):
    """标注样本"""
    commit_id: CommitSHA
    repo: str
    style_label: int  # 1-5
    structure_label: int  # 1-5
    logic_label: int  # 1-5
    label_source: Literal["human", "model", "heuristic"]  # 🔴 必须是 "human"
    annotator_id: Optional[str]
    confidence: Optional[float]
    notes: Optional[str]


class EvaluationMetrics(TypedDict):
    """评估指标"""
    precision: float
    recall: float
    f1: float
    accuracy: float
    auc: Optional[float]
    confusion_matrix: List[List[int]]
    ci_lower: Optional[float]  # 95% 置信区间下界
    ci_upper: Optional[float]  # 95% 置信区间上界


class AblationConfig(TypedDict):
    """消融配置"""
    enable_vector: bool
    enable_graph: bool
    enable_rules: bool
    enable_message_signals: bool


# ==================== 配置类型 ====================

class VectorDBConfig(TypedDict):
    """向量数据库配置"""
    backend: Literal["chroma", "faiss", "pinecone"]
    collection_name: str
    embedding_dim: int
    distance_metric: Literal["cosine", "euclidean", "dot"]


class GraphDBConfig(TypedDict, total=False):
    """图数据库配置"""
    uri: Optional[str]
    user: Optional[str]
    password: Optional[str]
    database: str


class ModelConfig(TypedDict):
    """模型配置"""
    model_type: Literal["logistic_regression", "random_forest", "xgboost", "neural_network"]
    hyperparameters: Dict[str, Any]
    random_seed: int


# ==================== 知识库类型 ====================

class Knowledge(TypedDict):
    """知识库数据"""
    functions: List[FunctionMetadata]
    classes: List[ClassMetadata]
    variables: List[VariableMetadata]
    file_path: str
    language: FileLanguage
    stats: Dict[str, int]


# ==================== 实用函数 ====================

def validate_label_source(sample: AnnotatedSample) -> bool:
    """
    验证标签来源是否为人工标注
    
    Args:
        sample: 标注样本
        
    Returns:
        是否为人工标注
        
    Raises:
        ValueError: 如果标签来源不是 "human"
    """
    if sample.get("label_source") != "human":
        raise ValueError(
            f"Invalid label source: {sample.get('label_source')}. "
            f"Only 'human' labels are allowed to avoid circular reasoning."
        )
    return True


def validate_risk_score(score: float) -> bool:
    """
    验证风险评分范围
    
    Args:
        score: 风险评分
        
    Returns:
        是否在有效范围内
        
    Raises:
        ValueError: 如果评分不在 [0, 1] 范围
    """
    if not 0.0 <= score <= 1.0:
        raise ValueError(f"Risk score must be in [0, 1], got {score}")
    return True
