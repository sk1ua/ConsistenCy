# -*- coding: utf-8 -*-
"""
代码解析模块
使用tree-sitter解析代码，提取AST
"""
import ast
from pathlib import Path
from typing import Dict, List, Any, Optional


class CodeParser:
    """代码解析器（基于Python AST）"""
    
    def __init__(self):
        """初始化解析器"""
        pass
    
    def parse_file(self, file_path: str) -> Optional[Dict[str, Any]]:
        """
        解析单个Python文件
        
        Args:
            file_path: 文件路径
            
        Returns:
            解析结果字典，包含：
            - ast: AST树
            - source: 源代码
            - functions: 函数列表
            - classes: 类列表
            - imports: 导入列表
        """
        try:
            path = Path(file_path)
            if not path.exists():
                print(f"❌ 文件不存在: {file_path}")
                return None
            
            # 读取源代码
            with open(path, 'r', encoding='utf-8') as f:
                source = f.read()

            return self.parse_source(source=source, file_path=str(path))
            
        except SyntaxError as e:
            print(f"❌ 语法错误: {file_path} - {e}")
            return None
        except Exception as e:
            print(f"❌ 解析失败: {file_path} - {e}")
            return None

    def parse_source(self, source: str, file_path: str = "<memory>") -> Optional[Dict[str, Any]]:
        """
        解析源码字符串

        Args:
            source: Python源码
            file_path: 虚拟文件路径

        Returns:
            解析结果字典
        """
        try:
            tree = ast.parse(source, filename=file_path)

            return {
                'file_path': file_path,
                'source': source,
                'ast': tree,
                'functions': self._extract_functions(tree),
                'classes': self._extract_classes(tree),
                'imports': self._extract_imports(tree),
                'variables': self._extract_variables(tree),
            }
        except SyntaxError as e:
            print(f"❌ 语法错误: {file_path} - {e}")
            return None
        except Exception as e:
            print(f"❌ 解析失败: {file_path} - {e}")
            return None
    
    def _extract_functions(self, tree: ast.AST) -> List[Dict[str, Any]]:
        """提取所有函数定义"""
        functions = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef):
                functions.append({
                    'name': node.name,
                    'lineno': node.lineno,
                    'end_lineno': getattr(node, 'end_lineno', node.lineno),
                    'args': [arg.arg for arg in node.args.args],
                    'decorators': [self._get_decorator_name(d) for d in node.decorator_list],
                    'docstring': ast.get_docstring(node),
                    'is_async': False,
                })
            elif isinstance(node, ast.AsyncFunctionDef):
                functions.append({
                    'name': node.name,
                    'lineno': node.lineno,
                    'end_lineno': getattr(node, 'end_lineno', node.lineno),
                    'args': [arg.arg for arg in node.args.args],
                    'decorators': [self._get_decorator_name(d) for d in node.decorator_list],
                    'docstring': ast.get_docstring(node),
                    'is_async': True,
                })
        
        return functions
    
    def _extract_classes(self, tree: ast.AST) -> List[Dict[str, Any]]:
        """提取所有类定义"""
        classes = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.ClassDef):
                # 提取基类
                bases = []
                for base in node.bases:
                    if isinstance(base, ast.Name):
                        bases.append(base.id)
                    elif isinstance(base, ast.Attribute):
                        bases.append(f"{base.value.id}.{base.attr}")
                
                # 提取方法
                methods = []
                for item in node.body:
                    if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                        methods.append(item.name)
                
                classes.append({
                    'name': node.name,
                    'lineno': node.lineno,
                    'bases': bases,
                    'methods': methods,
                    'decorators': [self._get_decorator_name(d) for d in node.decorator_list],
                    'docstring': ast.get_docstring(node),
                })
        
        return classes
    
    def _extract_imports(self, tree: ast.AST) -> List[Dict[str, Any]]:
        """提取所有导入语句"""
        imports = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.append({
                        'type': 'import',
                        'module': alias.name,
                        'alias': alias.asname,
                        'lineno': node.lineno,
                    })
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ''
                for alias in node.names:
                    imports.append({
                        'type': 'from_import',
                        'module': module,
                        'name': alias.name,
                        'alias': alias.asname,
                        'lineno': node.lineno,
                    })
        
        return imports
    
    def _get_decorator_name(self, decorator: ast.expr) -> str:
        """获取装饰器名称"""
        if isinstance(decorator, ast.Name):
            return decorator.id
        elif isinstance(decorator, ast.Call):
            if isinstance(decorator.func, ast.Name):
                return decorator.func.id
        return str(decorator)
    
    def _extract_variables(self, tree: ast.AST) -> List[Dict[str, Any]]:
        """提取模块级变量和常量"""
        variables = []
        
        # 只提取模块级别的赋值语句（不在类或函数内部）
        if not isinstance(tree, ast.Module):
            return variables
        
        for node in tree.body:
            # 简单赋值：x = 1
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name):
                        var_name = target.id
                        # 判断是否为常量（全大写+下划线）
                        is_constant = var_name.isupper() or (
                            '_' in var_name and var_name.replace('_', '').isupper()
                        )
                        
                        variables.append({
                            'name': var_name,
                            'lineno': node.lineno,
                            'is_constant': is_constant,
                            'type': 'constant' if is_constant else 'variable',
                        })
            
            # 注释赋值：x: int = 1
            elif isinstance(node, ast.AnnAssign):
                if isinstance(node.target, ast.Name):
                    var_name = node.target.id
                    is_constant = var_name.isupper() or (
                        '_' in var_name and var_name.replace('_', '').isupper()
                    )
                    
                    variables.append({
                        'name': var_name,
                        'lineno': node.lineno,
                        'is_constant': is_constant,
                        'type': 'constant' if is_constant else 'variable',
                    })
        
        return variables
    
    def parse_directory(self, directory: str) -> List[Dict[str, Any]]:
        """
        解析整个目录
        
        Args:
            directory: 目录路径
            
        Returns:
            解析结果列表
        """
        from .utils import get_python_files
        
        dir_path = Path(directory)
        if not dir_path.exists():
            print(f"❌ 目录不存在: {directory}")
            return []
        
        python_files = get_python_files(dir_path)
        results = []
        
        print(f"📂 找到 {len(python_files)} 个Python文件")
        
        for file_path in python_files:
            result = self.parse_file(str(file_path))
            if result:
                results.append(result)
        
        print(f"✅ 成功解析 {len(results)} 个文件")
        return results
