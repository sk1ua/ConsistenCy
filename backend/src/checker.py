# -*- coding: utf-8 -*-
"""
一致性检查模块
检查新代码是否符合项目规范
"""
from typing import Dict, List, Any
from .parser import CodeParser
from .extractor import KnowledgeExtractor
from .storage import CodeStorage
from .utils import detect_naming_style, calculate_structural_similarity, detect_code_clone_type
from .ml_naming_model import NamingStyleModel
import config


class ConsistencyChecker:
    """一致性检查器"""
    
    def __init__(self, storage: CodeStorage):
        """
        初始化检查器
        
        Args:
            storage: 知识存储实例
        """
        self.storage = storage
        self.parser = CodeParser()
        self.extractor = KnowledgeExtractor()
        self.naming_model = NamingStyleModel()
        self.naming_model.load()
    
    def check_file(self, file_path: str) -> List[Dict[str, Any]]:
        """
        检查文件一致性
        
        Args:
            file_path: 文件路径
            
        Returns:
            问题列表
        """
        issues = []
        
        # 解析文件
        parsed = self.parser.parse_file(file_path)
        if not parsed:
            return [{'level': 'error', 'message': '文件解析失败'}]
        
        # 提取知识
        knowledge = self.extractor.extract_from_parsed(parsed)
        
        # 1. 检查命名一致性（包括函数、类、变量、常量）
        issues.extend(self._check_naming_consistency(knowledge))
        
        # 2. 检查代码重复
        issues.extend(self._check_code_duplication(knowledge))
        
        # 3. 检查代码质量
        issues.extend(self._check_code_quality(knowledge, parsed))
        
        return issues
    
    def _check_naming_consistency(self, knowledge: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        检查命名一致性
        
        Args:
            knowledge: 提取的知识
            
        Returns:
            问题列表
        """
        issues = []
        
        # 获取项目的命名规则
        naming_patterns = self.storage.get_naming_patterns()
        
        if not naming_patterns:
            # 如果没有规则，使用配置中的默认规则
            naming_patterns = config.CHECK_CONFIG['naming']
        
        # 检查函数命名
        for func in knowledge['functions']:
            expected_style = naming_patterns.get('function', 'snake_case')
            actual_style = func['naming_style']
            
            if actual_style != expected_style:
                ml_hint = self._build_ml_hint(func['name'], 'function', expected_style)
                issues.append({
                    'type': 'naming',
                    'level': 'warning',
                    'message': f"函数 '{func['name']}' 命名风格不一致",
                    'detail': f"期望: {expected_style}, 实际: {actual_style}",
                    'line': func['line'],
                    'suggestion': f"建议使用 {expected_style} 风格命名函数",
                    'ml_hint': ml_hint,
                })
        
        # 检查类命名
        for cls in knowledge['classes']:
            expected_style = naming_patterns.get('class', 'PascalCase')
            actual_style = cls['naming_style']
            
            if actual_style != expected_style:
                ml_hint = self._build_ml_hint(cls['name'], 'class', expected_style)
                issues.append({
                    'type': 'naming',
                    'level': 'warning',
                    'message': f"类 '{cls['name']}' 命名风格不一致",
                    'detail': f"期望: {expected_style}, 实际: {actual_style}",
                    'line': cls['line'],
                    'suggestion': f"建议使用 {expected_style} 风格命名类",
                    'ml_hint': ml_hint,
                })
        
        # 检查变量命名
        for var in knowledge.get('variables', []):
            if var['is_constant']:
                # 常量应该使用 UPPER_CASE
                expected_style = naming_patterns.get('constant', 'UPPER_CASE')
            else:
                # 变量应该使用 snake_case
                expected_style = naming_patterns.get('variable', 'snake_case')
            
            actual_style = var['naming_style']
            
            if actual_style != expected_style:
                var_type = '常量' if var['is_constant'] else '变量'
                ml_hint = self._build_ml_hint(var['name'], var['type'], expected_style)
                issues.append({
                    'type': 'naming',
                    'level': 'warning',
                    'message': f"{var_type} '{var['name']}' 命名风格不一致",
                    'detail': f"期望: {expected_style}, 实际: {actual_style}",
                    'line': var['line'],
                    'suggestion': f"建议使用 {expected_style} 风格命名{var_type}",
                    'ml_hint': ml_hint,
                })
        
        return issues

    def _build_ml_hint(self, name: str, symbol_type: str, expected_style: str) -> str:
        """基于小模型提供补充建议"""
        prediction = self.naming_model.predict_style(name=name, symbol_type=symbol_type)
        if not prediction:
            return "未启用模型建议（可先运行 train-model）"

        predicted = prediction['predicted_style']
        confidence = prediction['confidence']
        conf_threshold = config.ML_CONFIG['confidence_threshold']

        if confidence < conf_threshold:
            return (
                f"模型置信度较低({confidence:.0%})，建议以项目规则 {expected_style} 为准"
            )

        return f"模型预测: {predicted} (置信度: {confidence:.0%})"
    
    def _check_code_duplication(self, knowledge: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        检查代码重复（使用结构相似度和克隆类型检测）
        
        Args:
            knowledge: 提取的知识
            
        Returns:
            问题列表
        """
        issues = []
        threshold = config.CHECK_CONFIG['similarity_threshold']
        
        # 检查函数是否与已有函数相似
        for func in knowledge['functions']:
            query = f"{func['signature']}\n{func['docstring']}"
            similar_funcs = self.storage.search_similar_functions(query, n_results=3)
            
            for similar in similar_funcs:
                # 使用向量数据库的语义相似度作为初筛
                if similar.get('distance') is not None:
                    semantic_similarity = 1 - similar['distance']
                    
                    # 如果语义相似度高于阈值，再进行详细的结构分析
                    if semantic_similarity > threshold:
                        # 计算结构相似度
                        current_code = func['snippet']
                        similar_code = similar['document']
                        
                        struct_similarity = calculate_structural_similarity(current_code, similar_code)
                        clone_type, clone_similarity = detect_code_clone_type(current_code, similar_code)
                        
                        # 使用结构相似度和克隆类型判断
                        if struct_similarity > threshold:
                            level = 'warning' if clone_type.startswith('Type-1') else 'info'
                            
                            issues.append({
                                'type': 'duplication',
                                'level': level,
                                'message': f"函数 '{func['name']}' 与已有函数相似",
                                'detail': (
                                    f"语义相似度: {semantic_similarity:.2%}, "
                                    f"结构相似度: {struct_similarity:.2%}, "
                                    f"克隆类型: {clone_type}"
                                ),
                                'line': func['line'],
                                'suggestion': f"考虑复用已有函数: {similar['metadata']['name']}",
                                'similar_code': similar_code
                            })
                            break  # 只报告最相似的一个
        
        return issues
    
    def _check_code_quality(self, knowledge: Dict[str, Any], parsed: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        检查代码质量
        
        Args:
            knowledge: 提取的知识
            parsed: 解析结果
            
        Returns:
            问题列表
        """
        issues = []
        
        # 检查函数长度
        max_length = config.CHECK_CONFIG['max_function_length']
        lines = parsed['source'].split('\n')
        
        for func in knowledge['functions']:
            # 简单估算函数长度（从函数定义到下一个函数或类）
            # 这是一个简化版本，实际应该更精确地解析
            func_start = func['line'] - 1
            
            # 查找函数结束位置（简化版）
            func_end = func_start + 1
            indent_level = len(lines[func_start]) - len(lines[func_start].lstrip())
            
            for i in range(func_start + 1, len(lines)):
                line = lines[i]
                if line.strip() and not line.startswith(' ' * (indent_level + 1)):
                    func_end = i
                    break
            else:
                func_end = len(lines)
            
            func_length = func_end - func_start
            
            if func_length > max_length:
                issues.append({
                    'type': 'quality',
                    'level': 'warning',
                    'message': f"函数 '{func['name']}' 过长",
                    'detail': f"长度: {func_length} 行, 建议最大: {max_length} 行",
                    'line': func['line'],
                    'suggestion': "考虑将函数拆分为更小的函数"
                })
        
        # 检查缺少文档字符串
        for func in knowledge['functions']:
            if not func['docstring']:
                issues.append({
                    'type': 'quality',
                    'level': 'info',
                    'message': f"函数 '{func['name']}' 缺少文档字符串",
                    'line': func['line'],
                    'suggestion': "建议添加函数说明文档"
                })
        
        for cls in knowledge['classes']:
            if not cls['docstring']:
                issues.append({
                    'type': 'quality',
                    'level': 'info',
                    'message': f"类 '{cls['name']}' 缺少文档字符串",
                    'line': cls['line'],
                    'suggestion': "建议添加类说明文档"
                })
        
        return issues
    
    def check_code_snippet(self, code: str) -> List[Dict[str, Any]]:
        """
        检查代码片段
        
        Args:
            code: 代码字符串
            
        Returns:
            问题列表
        """
        import tempfile
        import os
        
        # 创建临时文件
        with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8') as f:
            f.write(code)
            temp_path = f.name
        
        try:
            # 检查文件
            issues = self.check_file(temp_path)
            return issues
        finally:
            # 删除临时文件
            os.unlink(temp_path)
    
    def generate_report(self, issues: List[Dict[str, Any]]) -> str:
        """
        生成检查报告
        
        Args:
            issues: 问题列表
            
        Returns:
            格式化的报告
        """
        if not issues:
            return "✅ 未发现一致性问题"
        
        # 按严重程度分类
        errors = [i for i in issues if i['level'] == 'error']
        warnings = [i for i in issues if i['level'] == 'warning']
        infos = [i for i in issues if i['level'] == 'info']
        
        report = []
        report.append(f"\n📋 一致性检查报告")
        report.append(f"总计: {len(issues)} 个问题")
        
        if errors:
            report.append(f"\n❌ 错误 ({len(errors)}):")
            for issue in errors:
                report.append(f"  - 第{issue.get('line', '?')}行: {issue['message']}")
                if 'detail' in issue:
                    report.append(f"    {issue['detail']}")
        
        if warnings:
            report.append(f"\n⚠️  警告 ({len(warnings)}):")
            for issue in warnings:
                report.append(f"  - 第{issue.get('line', '?')}行: {issue['message']}")
                if 'suggestion' in issue:
                    report.append(f"    💡 {issue['suggestion']}")
        
        if infos:
            report.append(f"\nℹ️  信息 ({len(infos)}):")
            for issue in infos:
                report.append(f"  - 第{issue.get('line', '?')}行: {issue['message']}")
                if 'suggestion' in issue:
                    report.append(f"    💡 {issue['suggestion']}")
        
        return '\n'.join(report)
