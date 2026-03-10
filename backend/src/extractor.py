# -*- coding: utf-8 -*-
"""
知识提取模块
从AST中提取结构化知识
"""
import ast
from collections import Counter
from typing import Dict, List, Any
from .utils import detect_naming_style


class KnowledgeExtractor:
    """知识提取器"""
    
    def __init__(self):
        """初始化提取器"""
        self.naming_styles = {
            'function': [],
            'class': [],
            'variable': [],
            'constant': []
        }
    
    def extract_from_parsed(self, parsed_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        从解析结果中提取知识
        
        Args:
            parsed_data: 解析器返回的数据
            
        Returns:
            知识字典
        """
        knowledge = {
            'file_path': parsed_data['file_path'],
            'functions': [],
            'classes': [],
            'variables': [],
            'imports': parsed_data['imports'],
            'naming_patterns': {},
            'code_snippets': []
        }
        
        # 处理函数
        for func in parsed_data['functions']:
            func_info = self._extract_function_knowledge(
                func,
                parsed_data['source'],
                parsed_data['file_path']
            )
            knowledge['functions'].append(func_info)
            
            # 收集命名风格
            style = detect_naming_style(func['name'])
            self.naming_styles['function'].append(style)
        
        # 处理类
        for cls in parsed_data['classes']:
            cls_info = self._extract_class_knowledge(
                cls,
                parsed_data['source'],
                parsed_data['file_path']
            )
            knowledge['classes'].append(cls_info)
            
            # 收集命名风格
            style = detect_naming_style(cls['name'])
            self.naming_styles['class'].append(style)
        
        # 处理变量和常量
        for var in parsed_data.get('variables', []):
            var_info = self._extract_variable_knowledge(var, parsed_data['file_path'])
            knowledge['variables'].append(var_info)
            
            # 收集命名风格
            style = detect_naming_style(var['name'])
            var_type = 'constant' if var['is_constant'] else 'variable'
            self.naming_styles[var_type].append(style)
        
        # 提取命名模式
        knowledge['naming_patterns'] = self._analyze_naming_patterns()
        
        return knowledge
    
    def _extract_function_knowledge(self, func: Dict[str, Any], source: str, file_path: str) -> Dict[str, Any]:
        """提取函数知识"""
        return {
            'name': func['name'],
            'file_path': file_path,
            'line': func['lineno'],
            'signature': self._build_signature(func),
            'parameters': func['args'],
            'decorators': func['decorators'],
            'docstring': func['docstring'] or '',
            'is_async': func['is_async'],
            'naming_style': detect_naming_style(func['name']),
            'snippet': self._extract_snippet(source, func['lineno']),
        }
    
    def _extract_class_knowledge(self, cls: Dict[str, Any], source: str, file_path: str) -> Dict[str, Any]:
        """提取类知识"""
        # 识别设计模式线索
        patterns = self._detect_design_patterns(cls)
        
        return {
            'name': cls['name'],
            'file_path': file_path,
            'line': cls['lineno'],
            'bases': cls['bases'],
            'methods': cls['methods'],
            'decorators': cls['decorators'],
            'docstring': cls['docstring'] or '',
            'naming_style': detect_naming_style(cls['name']),
            'design_patterns': patterns,
            'snippet': self._extract_snippet(source, cls['lineno']),
        }
    
    def _extract_variable_knowledge(self, var: Dict[str, Any], file_path: str) -> Dict[str, Any]:
        """提取变量知识"""
        return {
            'name': var['name'],
            'file_path': file_path,
            'line': var['lineno'],
            'is_constant': var['is_constant'],
            'type': var['type'],
            'naming_style': detect_naming_style(var['name']),
        }
    
    def _detect_design_patterns(self, cls: Dict[str, Any]) -> List[str]:
        """
        检测设计模式（扩展版，支持更多模式）
        基于启发式规则检测常见设计模式的线索
        """
        patterns = []
        
        class_name = cls['name'].lower()
        methods = [m.lower() for m in cls['methods']]
        bases = [b.lower() for b in cls['bases']]
        
        # === 创建型模式 ===
        
        # 单例模式：有 __new__ 或 instance 相关方法
        if '__new__' in methods or 'get_instance' in methods or 'instance' in class_name:
            patterns.append('Singleton')
        
        # 工厂模式：类名包含 Factory 或有 create 方法
        if 'factory' in class_name or any('create' in m for m in methods):
            patterns.append('Factory')
        
        # 抽象工厂模式：类名包含 AbstractFactory
        if 'abstractfactory' in class_name.replace('_', ''):
            patterns.append('AbstractFactory')
        
        # 构建器模式：类名包含 Builder 或有 build 方法
        if 'builder' in class_name or 'build' in methods:
            patterns.append('Builder')
        
        # 原型模式：有 clone 或 copy 方法
        if 'clone' in methods or 'copy' in methods or '__copy__' in methods:
            patterns.append('Prototype')
        
        # 对象池模式：类名包含 Pool 或有 acquire/release 方法
        if 'pool' in class_name or ('acquire' in methods and 'release' in methods):
            patterns.append('Pool')
        
        # Borg/Monostate模式：类名包含 Borg
        if 'borg' in class_name:
            patterns.append('Borg')
        
        # === 结构型模式 ===
        
        # 适配器模式：类名包含 Adapter 或 Wrapper
        if 'adapter' in class_name or 'wrapper' in class_name:
            patterns.append('Adapter')
        
        # 桥接模式：类名包含 Bridge
        if 'bridge' in class_name:
            patterns.append('Bridge')
        
        # 组合模式：类名包含 Composite 或有 add/remove 子元素的方法
        if 'composite' in class_name or ('add' in methods and 'remove' in methods):
            patterns.append('Composite')
        
        # 装饰器模式：类名包含 Decorator
        if 'decorator' in class_name:
            patterns.append('Decorator')
        
        # 外观模式：类名包含 Facade
        if 'facade' in class_name:
            patterns.append('Facade')
        
        # 享元模式：类名包含 Flyweight
        if 'flyweight' in class_name:
            patterns.append('Flyweight')
        
        # 代理模式：类名包含 Proxy
        if 'proxy' in class_name:
            patterns.append('Proxy')
        
        # === 行为型模式 ===
        
        # 观察者模式：有 notify, subscribe, unsubscribe, attach, detach 等方法
        observer_keywords = {'notify', 'subscribe', 'unsubscribe', 'attach', 'detach', 'update'}
        if any(kw in methods for kw in observer_keywords):
            patterns.append('Observer')
        
        # 策略模式：类名包含 Strategy 或继承自 ABC
        if 'strategy' in class_name or 'abc' in bases:
            patterns.append('Strategy')
        
        # 命令模式：类名包含 Command 或有 execute/undo 方法
        if 'command' in class_name or 'execute' in methods or 'undo' in methods:
            patterns.append('Command')

        # 迭代器模式：有 __iter__ 和 __next__ 方法
        if '__iter__' in methods and '__next__' in methods:
            patterns.append('Iterator')

        # 中介者模式：类名包含 Mediator
        if 'mediator' in class_name:
            patterns.append('Mediator')

        # 备忘录模式：类名包含 Memento 或 Snapshot
        if 'memento' in class_name or 'snapshot' in class_name:
            patterns.append('Memento')

        # 状态模式：类名包含 State 或有 change_state 相关方法
        if 'state' in class_name or 'change_state' in methods:
            patterns.append('State')

        # 模板方法模式：有抽象方法或以 _ 开头的保护方法
        if any(m.startswith('_') and not m.startswith('__') for m in methods):
            if 'template' in class_name or 'abc' in bases:
                patterns.append('Template')

        # 访问者模式：类名包含 Visitor 或有 visit 方法
        if 'visitor' in class_name or any('visit' in m for m in methods):
            patterns.append('Visitor')

        # 责任链模式：类名包含 Handler 或有 handle/set_next 方法
        if 'handler' in class_name or ('handle' in methods and 'set_next' in methods):
            patterns.append('ChainOfResponsibility')

        # 解释器模式：类名包含 Interpreter 或 Expression
        if 'interpreter' in class_name or 'expression' in class_name:
            patterns.append('Interpreter')

        # === 其他模式 ===

        # MVC模式相关
        if 'controller' in class_name:
            patterns.append('MVC-Controller')
        elif 'view' in class_name:
            patterns.append('MVC-View')
        elif 'model' in class_name:
            patterns.append('MVC-Model')

        # 仓储模式
        if 'repository' in class_name:
            patterns.append('Repository')

        # 服务定位器
        if 'locator' in class_name or 'registry' in class_name:
            patterns.append('ServiceLocator')
        
        return patterns
    
    def _build_signature(self, func: Dict[str, Any]) -> str:
        """构建函数签名"""
        params = ', '.join(func['args'])
        prefix = 'async ' if func['is_async'] else ''
        return f"{prefix}def {func['name']}({params})"
    
    def _extract_snippet(self, source: str, lineno: int, context_lines: int = 5) -> str:
        """提取代码片段"""
        lines = source.split('\n')
        start = max(0, lineno - 1)
        end = min(len(lines), start + context_lines)
        return '\n'.join(lines[start:end])
    
    def _analyze_naming_patterns(self) -> Dict[str, str]:
        """
        分析命名模式，找出项目的主流风格
        
        Returns:
            每种类型的推荐命名风格
        """
        patterns = {}
        
        for category, styles in self.naming_styles.items():
            if not styles:
                continue
            
            # 统计最常用的风格
            counter = Counter(styles)
            most_common = counter.most_common(1)
            
            if most_common:
                patterns[category] = most_common[0][0]
        
        return patterns
    
    def extract_from_multiple(self, parsed_data_list: List[Dict[str, Any]]) -> Dict[str, Any]:
        """
        从多个文件中提取知识
        
        Args:
            parsed_data_list: 解析结果列表
            
        Returns:
            整合的知识库
        """
        all_knowledge = {
            'files': [],
            'global_naming_patterns': {},
            'all_functions': [],
            'all_classes': [],
            'all_variables': [],
            'design_patterns': [],
        }
        
        # 重置命名风格统计
        self.naming_styles = {
            'function': [],
            'class': [],
            'variable': [],
            'constant': []
        }
        
        # 处理每个文件
        for parsed_data in parsed_data_list:
            knowledge = self.extract_from_parsed(parsed_data)
            all_knowledge['files'].append(knowledge)
            
            # 收集所有函数、类和变量
            all_knowledge['all_functions'].extend(knowledge['functions'])
            all_knowledge['all_classes'].extend(knowledge['classes'])
            all_knowledge['all_variables'].extend(knowledge['variables'])
            
            # 收集设计模式
            for cls in knowledge['classes']:
                if cls['design_patterns']:
                    all_knowledge['design_patterns'].extend(cls['design_patterns'])
        
        # 分析全局命名模式
        all_knowledge['global_naming_patterns'] = self._analyze_naming_patterns()
        
        # 统计设计模式
        pattern_counter = Counter(all_knowledge['design_patterns'])
        all_knowledge['design_patterns'] = [
            {'pattern': pattern, 'count': count}
            for pattern, count in pattern_counter.most_common()
        ]
        
        print(f"\n📊 知识提取统计:")
        print(f"  - 函数: {len(all_knowledge['all_functions'])}")
        print(f"  - 类: {len(all_knowledge['all_classes'])}")
        print(f"  - 变量/常量: {len(all_knowledge['all_variables'])}")
        print(f"  - 命名模式: {all_knowledge['global_naming_patterns']}")
        print(f"  - 设计模式: {dict(pattern_counter)}")
        
        return all_knowledge
