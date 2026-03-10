# -*- coding: utf-8 -*-
"""
知识存储模块
使用ChromaDB存储代码知识，支持语义搜索
"""
import json
from typing import Dict, List, Any, Optional
from pathlib import Path
import hashlib

try:
    import chromadb
    from chromadb.config import Settings
    CHROMA_AVAILABLE = True
except ImportError:
    CHROMA_AVAILABLE = False
    print("⚠️  ChromaDB未安装，将使用简化存储模式")

import config


class CodeStorage:
    """代码知识存储"""
    
    def __init__(self, db_path: Optional[str] = None):
        """
        初始化存储
        
        Args:
            db_path: 数据库路径，默认使用config中的路径
        """
        self.db_path = Path(db_path) if db_path else config.CHROMA_DIR
        self.db_path.mkdir(parents=True, exist_ok=True)
        self.collection_prefix = config.VECTOR_DB_CONFIG.get("collection_prefix", "consistency")
        
        # 初始化向量数据库
        if CHROMA_AVAILABLE:
            self.client = chromadb.PersistentClient(
                path=str(self.db_path),
                settings=Settings(anonymized_telemetry=False)
            )
            
            # 创建集合
            self.function_collection = self.client.get_or_create_collection(
                name=f"{self.collection_prefix}_functions",
                metadata={"description": "函数代码片段"}
            )
            
            self.class_collection = self.client.get_or_create_collection(
                name=f"{self.collection_prefix}_classes",
                metadata={"description": "类定义"}
            )
        else:
            self.client = None
            self.function_collection = None
            self.class_collection = None
        
        # 本地规则存储
        self.rules_file = config.RULES_FILE
        self.rules = self._load_rules()
    
    def add_knowledge(self, knowledge: Dict[str, Any]):
        """
        添加知识到存储
        
        Args:
            knowledge: 提取的知识数据
        """
        # 存储命名规则
        if 'global_naming_patterns' in knowledge:
            self.rules['naming_patterns'] = knowledge['global_naming_patterns']
        
        # 存储设计模式
        if 'design_patterns' in knowledge:
            self.rules['design_patterns'] = knowledge['design_patterns']
        
        # 保存规则
        self._save_rules()
        
        if not CHROMA_AVAILABLE:
            print("⚠️  向量数据库不可用，仅保存规则")
            return
        
        # 存储函数到向量数据库
        if 'all_functions' in knowledge:
            self._add_functions(knowledge['all_functions'])
        
        # 存储类到向量数据库
        if 'all_classes' in knowledge:
            self._add_classes(knowledge['all_classes'])
        
        print(f"✅ 知识已存储到数据库")
    
    def _add_functions(self, functions: List[Dict[str, Any]]):
        """添加函数到向量数据库"""
        if not functions:
            return
        
        ids = []
        documents = []
        metadatas = []
        
        for func in functions:
            # 生成稳定唯一ID，避免不同文件同名冲突
            raw_id = f"{func.get('file_path', 'unknown')}::{func['name']}::{func['line']}"
            func_id = f"func_{hashlib.md5(raw_id.encode('utf-8')).hexdigest()}"
            ids.append(func_id)
            
            # 文档：函数签名 + 文档字符串 + 代码片段
            doc = f"{func['signature']}\n{func['docstring']}\n{func['snippet']}"
            documents.append(doc)
            
            # 元数据
            metadatas.append({
                'name': func['name'],
                'line': func['line'],
                'file_path': func.get('file_path', ''),
                'naming_style': func['naming_style'],
                'parameters': ','.join(func['parameters']),
                'is_async': str(func['is_async']),
            })
        
        # 批量添加
        try:
            self.function_collection.upsert(
                ids=ids,
                documents=documents,
                metadatas=metadatas
            )
            print(f"  ✓ 存储了 {len(functions)} 个函数")
        except Exception as e:
            print(f"  ✗ 存储函数失败: {e}")
    
    def _add_classes(self, classes: List[Dict[str, Any]]):
        """添加类到向量数据库"""
        if not classes:
            return
        
        ids = []
        documents = []
        metadatas = []
        
        for cls in classes:
            # 生成稳定唯一ID，避免不同文件同名冲突
            raw_id = f"{cls.get('file_path', 'unknown')}::{cls['name']}::{cls['line']}"
            cls_id = f"class_{hashlib.md5(raw_id.encode('utf-8')).hexdigest()}"
            ids.append(cls_id)
            
            # 文档：类名 + 基类 + 方法 + 文档字符串 + 代码片段
            doc = f"class {cls['name']}({','.join(cls['bases'])})\n"
            doc += f"Methods: {','.join(cls['methods'])}\n"
            doc += f"{cls['docstring']}\n{cls['snippet']}"
            documents.append(doc)
            
            # 元数据
            metadatas.append({
                'name': cls['name'],
                'line': cls['line'],
                'file_path': cls.get('file_path', ''),
                'naming_style': cls['naming_style'],
                'bases': ','.join(cls['bases']),
                'design_patterns': ','.join(cls['design_patterns']),
            })
        
        # 批量添加
        try:
            self.class_collection.upsert(
                ids=ids,
                documents=documents,
                metadatas=metadatas
            )
            print(f"  ✓ 存储了 {len(classes)} 个类")
        except Exception as e:
            print(f"  ✗ 存储类失败: {e}")
    
    def search_similar_functions(self, query: str, n_results: int = 5) -> List[Dict[str, Any]]:
        """
        搜索相似的函数
        
        Args:
            query: 查询字符串
            n_results: 返回结果数量
            
        Returns:
            相似函数列表
        """
        if not CHROMA_AVAILABLE or not self.function_collection:
            return []
        
        try:
            results = self.function_collection.query(
                query_texts=[query],
                n_results=n_results
            )
            
            # 格式化结果
            similar_funcs = []
            if results['ids'] and results['ids'][0]:
                for i in range(len(results['ids'][0])):
                    similar_funcs.append({
                        'id': results['ids'][0][i],
                        'metadata': results['metadatas'][0][i],
                        'document': results['documents'][0][i],
                        'distance': results['distances'][0][i] if 'distances' in results else None
                    })
            
            return similar_funcs
        except Exception as e:
            print(f"❌ 搜索失败: {e}")
            return []
    
    def search_similar_classes(self, query: str, n_results: int = 5) -> List[Dict[str, Any]]:
        """
        搜索相似的类
        
        Args:
            query: 查询字符串
            n_results: 返回结果数量
            
        Returns:
            相似类列表
        """
        if not CHROMA_AVAILABLE or not self.class_collection:
            return []
        
        try:
            results = self.class_collection.query(
                query_texts=[query],
                n_results=n_results
            )
            
            # 格式化结果
            similar_classes = []
            if results['ids'] and results['ids'][0]:
                for i in range(len(results['ids'][0])):
                    similar_classes.append({
                        'id': results['ids'][0][i],
                        'metadata': results['metadatas'][0][i],
                        'document': results['documents'][0][i],
                        'distance': results['distances'][0][i] if 'distances' in results else None
                    })
            
            return similar_classes
        except Exception as e:
            print(f"❌ 搜索失败: {e}")
            return []
    
    def get_naming_patterns(self) -> Dict[str, str]:
        """获取命名规则"""
        return self.rules.get('naming_patterns', {})
    
    def get_design_patterns(self) -> List[Dict[str, int]]:
        """获取设计模式统计"""
        return self.rules.get('design_patterns', [])
    
    def _load_rules(self) -> Dict[str, Any]:
        """加载规则文件"""
        if self.rules_file.exists():
            try:
                with open(self.rules_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                print(f"⚠️  加载规则文件失败: {e}")
        
        return {
            'naming_patterns': {},
            'design_patterns': []
        }
    
    def _save_rules(self):
        """保存规则文件"""
        try:
            with open(self.rules_file, 'w', encoding='utf-8') as f:
                json.dump(self.rules, f, indent=2, ensure_ascii=False)
        except Exception as e:
            print(f"⚠️  保存规则文件失败: {e}")
    
    def clear(self):
        """清空数据库"""
        if CHROMA_AVAILABLE and self.client:
            try:
                functions_name = f"{self.collection_prefix}_functions"
                classes_name = f"{self.collection_prefix}_classes"

                self.client.delete_collection(functions_name)
                self.client.delete_collection(classes_name)
                self.function_collection = self.client.create_collection(functions_name)
                self.class_collection = self.client.create_collection(classes_name)
                print("✅ 数据库已清空")
            except Exception as e:
                print(f"❌ 清空失败: {e}")
        
        # 清空规则
        self.rules = {'naming_patterns': {}, 'design_patterns': []}
        self._save_rules()

    def stats(self) -> Dict[str, Any]:
        """返回向量库基础统计信息"""
        info = {
            "chroma_available": CHROMA_AVAILABLE,
            "db_path": str(self.db_path),
            "collection_prefix": self.collection_prefix,
            "function_count": 0,
            "class_count": 0,
        }

        if not CHROMA_AVAILABLE:
            return info

        try:
            info["function_count"] = self.function_collection.count() if self.function_collection else 0
            info["class_count"] = self.class_collection.count() if self.class_collection else 0
        except Exception:
            pass

        return info
