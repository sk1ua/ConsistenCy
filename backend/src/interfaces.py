# -*- coding: utf-8 -*-
"""
接口抽象

定义核心组件的抽象接口，支持插件式扩展和依赖注入。
"""
from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
from .types import (
    CommitContext, RiskScore, Evidence, RetrievalResult,
    SearchQuery, Knowledge, FilePath, CommitSHA
)


# ==================== 解析器接口 ====================

class ICodeParser(ABC):
    """代码解析器接口"""
    
    @abstractmethod
    def parse_file(self, file_path: FilePath) -> Optional[Dict[str, Any]]:
        """
        解析单个文件
        
        Args:
            file_path: 文件路径
            
        Returns:
            解析结果，解析失败返回 None
        """
        pass
    
    @abstractmethod
    def parse_directory(self, directory: FilePath) -> List[Dict[str, Any]]:
        """
        解析目录下所有文件
        
        Args:
            directory: 目录路径
            
        Returns:
            解析结果列表
        """
        pass


# ==================== 存储接口 ====================

class IStorage(ABC):
    """知识存储接口"""
    
    @abstractmethod
    def add_knowledge(self, knowledge: Knowledge) -> bool:
        """
        添加知识到存储
        
        Args:
            knowledge: 知识数据
            
        Returns:
            是否添加成功
        """
        pass
    
    @abstractmethod
    def search_similar_functions(
        self, 
        query: SearchQuery
    ) -> List[RetrievalResult]:
        """
        检索相似函数
        
        Args:
            query: 搜索查询
            
        Returns:
            检索结果列表
        """
        pass
    
    @abstractmethod
    def stats(self) -> Dict[str, int]:
        """
        获取存储统计信息
        
        Returns:
            统计信息字典
        """
        pass
    
    @abstractmethod
    def clear(self) -> bool:
        """
        清空存储
        
        Returns:
            是否清空成功
        """
        pass


# ==================== 检索器接口 ====================

class IRetriever(ABC):
    """检索器接口"""
    
    @abstractmethod
    def retrieve(
        self, 
        context: CommitContext, 
        top_k: int = 5
    ) -> List[Evidence]:
        """
        检索相关证据
        
        Args:
            context: 提交上下文
            top_k: 返回 Top-K 结果
            
        Returns:
            证据列表
        """
        pass


class IVectorRetriever(IRetriever):
    """向量检索器接口"""
    pass


class IGraphRetriever(IRetriever):
    """图检索器接口"""
    
    @abstractmethod
    def ingest_commit(self, context: CommitContext) -> bool:
        """
        将提交信息导入图数据库
        
        Args:
            context: 提交上下文
            
        Returns:
            是否导入成功
        """
        pass


# ==================== 评分器接口 ====================

class IRiskScorer(ABC):
    """风险评分器接口"""
    
    @abstractmethod
    def score(
        self, 
        context: CommitContext, 
        evidence: Optional[List[Evidence]] = None
    ) -> RiskScore:
        """
        计算提交风险评分
        
        Args:
            context: 提交上下文
            evidence: 可选的证据列表
            
        Returns:
            风险评分
        """
        pass


class IStyleScorer(ABC):
    """风格评分器接口"""
    
    @abstractmethod
    def score_style(self, context: CommitContext) -> float:
        """
        计算风格风险
        
        Args:
            context: 提交上下文
            
        Returns:
            风格风险评分 [0, 1]
        """
        pass


class IStructureScorer(ABC):
    """结构评分器接口"""
    
    @abstractmethod
    def score_structure(self, context: CommitContext) -> float:
        """
        计算结构风险
        
        Args:
            context: 提交上下文
            
        Returns:
            结构风险评分 [0, 1]
        """
        pass


class ILogicScorer(ABC):
    """逻辑评分器接口"""
    
    @abstractmethod
    def score_logic(
        self, 
        context: CommitContext, 
        evidence: List[Evidence]
    ) -> float:
        """
        计算逻辑风险
        
        Args:
            context: 提交上下文
            evidence: 检索证据
            
        Returns:
            逻辑风险评分 [0, 1]
        """
        pass


# ==================== 评估器接口 ==================== 

class IEvaluator(ABC):
    """评估器接口"""
    
    @abstractmethod
    def split_data(
        self, 
        train_ratio: float = 0.6,
        valid_ratio: float = 0.2,
        test_ratio: float = 0.2
    ) -> None:
        """
        划分数据集
        
        Args:
            train_ratio: 训练集比例
            valid_ratio: 验证集比例
            test_ratio: 测试集比例
        """
        pass
    
    @abstractmethod
    def train(self, model_config: Optional[Dict[str, Any]] = None) -> Any:
        """
        训练模型
        
        Args:
            model_config: 模型配置
            
        Returns:
            训练好的模型
        """
        pass
    
    @abstractmethod
    def evaluate(self, model: Any, dataset: str = "test") -> Dict[str, float]:
        """
        评估模型
        
        Args:
            model: 模型实例
            dataset: 数据集名称 ("train", "valid", "test")
            
        Returns:
            评估指标
        """
        pass


# ==================== 提交挖掘接口 ====================

class ICommitMiner(ABC):
    """提交挖掘器接口"""
    
    @abstractmethod
    def get_commit(self, commit_sha: CommitSHA) -> CommitContext:
        """
        获取提交信息
        
        Args:
            commit_sha: 提交 SHA
            
        Returns:
            提交上下文
        """
        pass
    
    @abstractmethod
    def sample_commits(
        self, 
        n: int, 
        strategy: str = "random"
    ) -> List[CommitSHA]:
        """
        采样提交
        
        Args:
            n: 采样数量
            strategy: 采样策略 ("random", "recent", "diverse")
            
        Returns:
            提交 SHA 列表
        """
        pass


# ==================== 工厂模式 ====================

class RetrieverFactory:
    """检索器工厂"""
    
    _retrievers: Dict[str, type] = {}
    
    @classmethod
    def register(cls, name: str, retriever_class: type):
        """注册检索器实现"""
        cls._retrievers[name] = retriever_class
    
    @classmethod
    def create(cls, name: str, **kwargs) -> IRetriever:
        """创建检索器实例"""
        if name not in cls._retrievers:
            raise ValueError(f"Unknown retriever: {name}")
        return cls._retrievers[name](**kwargs)


class ScorerFactory:
    """评分器工厂"""
    
    _scorers: Dict[str, type] = {}
    
    @classmethod
    def register(cls, name: str, scorer_class: type):
        """注册评分器实现"""
        cls._scorers[name] = scorer_class
    
    @classmethod
    def create(cls, name: str, **kwargs) -> IRiskScorer:
        """创建评分器实例"""
        if name not in cls._scorers:
            raise ValueError(f"Unknown scorer: {name}")
        return cls._scorers[name](**kwargs)
