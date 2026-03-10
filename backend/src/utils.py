# -*- coding: utf-8 -*-
"""
工具函数模块
"""
import re
import ast
from pathlib import Path
from typing import List, Tuple
from difflib import SequenceMatcher


def detect_naming_style(name: str) -> str:
    """
    检测命名风格
    
    Args:
        name: 变量/函数/类名
        
    Returns:
        命名风格：snake_case, camelCase, PascalCase, UPPER_CASE
    """
    if not name:
        return "unknown"
    
    # UPPER_CASE：全大写+下划线
    if re.match(r'^[A-Z][A-Z0-9_]*$', name):
        return "UPPER_CASE"
    
    # PascalCase：首字母大写，无下划线
    if re.match(r'^[A-Z][a-zA-Z0-9]*$', name) and '_' not in name:
        return "PascalCase"
    
    # camelCase：首字母小写，中间有大写
    if re.match(r'^[a-z][a-zA-Z0-9]*$', name) and any(c.isupper() for c in name[1:]):
        return "camelCase"
    
    # snake_case：全小写+下划线
    if re.match(r'^[a-z][a-z0-9_]*$', name):
        return "snake_case"
    
    return "unknown"


def get_python_files(directory: Path) -> List[Path]:
    """
    递归获取目录下所有Python文件
    
    Args:
        directory: 目录路径
        
    Returns:
        Python文件路径列表
    """
    python_files = []
    directory = directory.resolve()
    
    for path in directory.rglob("*.py"):
        # 排除特定目录
        # 忽略隐藏目录，但不要把相对路径里的 . / .. 误判为隐藏目录
        if any(part.startswith('.') and part not in {'.', '..'} for part in path.parts):
            continue
        if 'venv' in path.parts or 'env' in path.parts:
            continue
        if '__pycache__' in path.parts:
            continue
            
        python_files.append(path)
    
    return python_files


def calculate_code_hash(code: str) -> str:
    """
    计算代码的哈希值（用于去重）
    
    Args:
        code: 代码字符串
        
    Returns:
        哈希值
    """
    import hashlib
    # 去除空白字符后计算哈希
    normalized = re.sub(r'\s+', '', code)
    return hashlib.md5(normalized.encode()).hexdigest()


def format_code_snippet(code: str, max_lines: int = 10) -> str:
    """
    格式化代码片段用于显示
    
    Args:
        code: 代码字符串
        max_lines: 最大行数
        
    Returns:
        格式化后的代码
    """
    lines = code.split('\n')
    if len(lines) > max_lines:
        return '\n'.join(lines[:max_lines]) + f'\n... ({len(lines) - max_lines} more lines)'
    return code


def extract_ast_structure(code: str) -> List[str]:
    """
    提取代码的AST结构（节点类型序列）
    
    Args:
        code: 代码字符串
        
    Returns:
        AST节点类型序列
    """
    try:
        tree = ast.parse(code)
        nodes = []
        for node in ast.walk(tree):
            nodes.append(type(node).__name__)
        return nodes
    except:
        return []


def normalize_code(code: str) -> str:
    """
    归一化代码：将所有标识符替换为占位符
    用于检测结构相似但变量名不同的代码
    
    Args:
        code: 代码字符串
        
    Returns:
        归一化后的代码
    """
    try:
        tree = ast.parse(code)
        
        # 遍历AST，替换所有名称为占位符
        class NameNormalizer(ast.NodeTransformer):
            def __init__(self):
                self.name_map = {}
                self.counter = 0
            
            def visit_Name(self, node):
                if node.id not in self.name_map:
                    self.name_map[node.id] = f'VAR_{self.counter}'
                    self.counter += 1
                node.id = self.name_map[node.id]
                return node
            
            def visit_FunctionDef(self, node):
                if node.name not in self.name_map:
                    self.name_map[node.name] = f'FUNC_{self.counter}'
                    self.counter += 1
                node.name = self.name_map[node.name]
                self.generic_visit(node)
                return node
            
            def visit_arg(self, node):
                if node.arg not in self.name_map:
                    self.name_map[node.arg] = f'ARG_{self.counter}'
                    self.counter += 1
                node.arg = self.name_map[node.arg]
                return node
        
        normalizer = NameNormalizer()
        normalized_tree = normalizer.visit(tree)
        return ast.unparse(normalized_tree)
    except:
        # 如果解析失败，返回原代码
        return code


def calculate_structural_similarity(code1: str, code2: str) -> float:
    """
    计算两段代码的结构相似度
    结合AST节点序列和归一化代码进行比较
    
    Args:
        code1: 第一段代码
        code2: 第二段代码
        
    Returns:
        相似度 (0.0-1.0)
    """
    # 1. AST结构相似度（节点类型序列）
    structure1 = extract_ast_structure(code1)
    structure2 = extract_ast_structure(code2)
    
    if not structure1 or not structure2:
        # 如果无法解析，回退到文本相似度
        return SequenceMatcher(None, code1, code2).ratio()
    
    structure_similarity = SequenceMatcher(None, structure1, structure2).ratio()
    
    # 2. 归一化代码相似度（变量名无关）
    normalized1 = normalize_code(code1)
    normalized2 = normalize_code(code2)
    normalized_similarity = SequenceMatcher(None, normalized1, normalized2).ratio()
    
    # 3. 组合两种相似度（结构权重更高）
    combined_similarity = structure_similarity * 0.6 + normalized_similarity * 0.4
    
    return combined_similarity


def detect_code_clone_type(code1: str, code2: str) -> Tuple[str, float]:
    """
    检测代码克隆类型
    
    Type-1: 完全相同（除了空白和注释）
    Type-2: 结构相同但标识符不同
    Type-3: 结构相似但有修改
    
    Args:
        code1: 第一段代码
        code2: 第二段代码
        
    Returns:
        (克隆类型, 相似度)
    """
    # 去除空白和注释后的哈希
    hash1 = calculate_code_hash(code1)
    hash2 = calculate_code_hash(code2)
    
    if hash1 == hash2:
        return ("Type-1: 完全相同", 1.0)
    
    # 归一化后比较
    norm1 = normalize_code(code1)
    norm2 = normalize_code(code2)
    norm_similarity = SequenceMatcher(None, norm1, norm2).ratio()
    
    if norm_similarity > 0.95:
        return ("Type-2: 标识符不同", norm_similarity)
    
    # 结构相似度
    struct_similarity = calculate_structural_similarity(code1, code2)
    
    if struct_similarity > 0.85:
        return ("Type-3: 结构相似", struct_similarity)
    
    return ("不同代码", struct_similarity)
