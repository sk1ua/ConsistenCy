# -*- coding: utf-8 -*-
"""
CLI工具
命令行接口
"""
import json
import sys
import click
import numpy as np
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.syntax import Syntax

import config

from src.parser import CodeParser
from src.extractor import KnowledgeExtractor
from src.storage import CodeStorage
from src.checker import ConsistencyChecker
from src.ml_naming_model import NamingStyleModel
from src.human_labeled_evaluator import HumanLabeledEvaluator, DatasetStatistics
from src.ablation_study_v2 import AblationStudyV2
from src.baselines import (
    BaselineComparison,
    RandomBaseline,
    HeuristicBaseline,
    ThresholdBaseline,
)
from src.project_selector import ProjectSelector, ProjectCriteria, CommitSampler
from src.kappa_calculator import KappaCalculator
from src.annotation_tool import AnnotationTool
from src.commit_pipeline import (
    CommitMiner,
    Neo4jGraphStore,
    HybridRetriever,
    CommitRiskScorer,
    WeakEvalRunner,
    RiskWeightTuner,
    RetrievalComparer,
    RuleEngine,
    ExperimentRunner,
    CaseGenerator,
)

console = Console()


@click.group()
@click.version_option(version='0.2.0-alpha')
def cli():
    """
    ConsistenCy - 代码一致性审查工具
    
    帮助团队保持代码风格统一，提高代码质量。
    """
    pass


@cli.command()
@click.argument('path', type=click.Path(exists=True))
@click.option('--clear', is_flag=True, help='清空现有知识库')
def scan(path, clear):
    """
    扫描项目代码，建立知识库
    
    PATH: 项目目录路径
    """
    console.print(Panel.fit(
        "🔍 扫描项目代码",
        style="bold blue"
    ))
    
    # 初始化组件
    parser = CodeParser()
    extractor = KnowledgeExtractor()
    storage = CodeStorage()
    
    # 清空数据库（如果需要）
    if clear:
        console.print("🗑️  清空现有知识库...")
        storage.clear()
    
    # 解析代码
    console.print(f"📂 扫描目录: {path}")
    
    path_obj = Path(path)
    if path_obj.is_file():
        # 单个文件
        parsed_data = parser.parse_file(str(path_obj))
        if parsed_data:
            parsed_list = [parsed_data]
        else:
            console.print("[red]❌ 文件解析失败[/red]")
            return
    else:
        # 整个目录
        parsed_list = parser.parse_directory(str(path_obj))
    
    if not parsed_list:
        console.print("[red]❌ 没有找到可解析的Python文件[/red]")
        return
    
    # 提取知识
    console.print("\n📊 提取代码知识...")
    knowledge = extractor.extract_from_multiple(parsed_list)
    
    # 存储知识
    console.print("\n💾 存储到知识库...")
    storage.add_knowledge(knowledge)
    
    # 显示统计
    console.print("\n" + "="*50)
    console.print("[green]✅ 扫描完成！[/green]\n")
    
    table = Table(title="知识库统计")
    table.add_column("类型", style="cyan")
    table.add_column("数量", style="magenta")
    
    table.add_row("文件", str(len(knowledge['files'])))
    table.add_row("函数", str(len(knowledge['all_functions'])))
    table.add_row("类", str(len(knowledge['all_classes'])))
    table.add_row("变量/常量", str(len(knowledge.get('all_variables', []))))
    
    console.print(table)
    
    # 显示命名规则
    if knowledge['global_naming_patterns']:
        console.print("\n📋 检测到的命名规则:")
        for key, value in knowledge['global_naming_patterns'].items():
            console.print(f"  • {key}: [yellow]{value}[/yellow]")
    
    # 显示设计模式
    if knowledge['design_patterns']:
        console.print("\n🎨 检测到的设计模式:")
        for item in knowledge['design_patterns'][:5]:
            console.print(f"  • {item['pattern']}: [yellow]{item['count']}[/yellow] 次")


@cli.command()
@click.argument('file_path', type=click.Path(exists=True))
@click.option('--verbose', '-v', is_flag=True, help='显示详细信息')
def check(file_path, verbose):
    """
    检查文件是否符合项目规范
    
    FILE_PATH: 要检查的文件路径
    """
    console.print(Panel.fit(
        "🔎 一致性检查",
        style="bold blue"
    ))
    
    # 初始化组件
    storage = CodeStorage()
    checker = ConsistencyChecker(storage)
    
    # 检查文件
    console.print(f"📄 检查文件: {file_path}\n")
    issues = checker.check_file(file_path)
    
    # 生成报告
    if not issues:
        console.print("[green]✅ 未发现一致性问题！[/green]")
        return
    
    # 按类型分类
    naming_issues = [i for i in issues if i['type'] == 'naming']
    duplication_issues = [i for i in issues if i['type'] == 'duplication']
    quality_issues = [i for i in issues if i['type'] == 'quality']
    
    # 显示命名问题
    if naming_issues:
        console.print("[yellow]⚠️  命名不一致:[/yellow]")
        for issue in naming_issues:
            console.print(f"  第{issue['line']}行: {issue['message']}")
            if verbose and 'suggestion' in issue:
                console.print(f"    💡 {issue['suggestion']}")
            if verbose and issue.get('ml_hint'):
                console.print(f"    🤖 {issue['ml_hint']}")
        console.print()
    
    # 显示重复代码
    if duplication_issues:
        console.print("[cyan]ℹ️  代码重复:[/cyan]")
        for issue in duplication_issues:
            console.print(f"  第{issue['line']}行: {issue['message']}")
            if 'detail' in issue:
                console.print(f"    {issue['detail']}")
            if verbose and 'similar_code' in issue:
                console.print(f"    相似代码:")
                syntax = Syntax(issue['similar_code'][:200], "python", line_numbers=False)
                console.print(syntax)
        console.print()
    
    # 显示质量问题
    if quality_issues:
        console.print("[blue]📝 代码质量:[/blue]")
        for issue in quality_issues:
            console.print(f"  第{issue['line']}行: {issue['message']}")
            if verbose and 'suggestion' in issue:
                console.print(f"    💡 {issue['suggestion']}")
        console.print()
    
    # 总结
    console.print(f"\n总计: {len(issues)} 个问题")


@cli.command()
@click.argument('query_text')
@click.option('--type', '-t', type=click.Choice(['function', 'class', 'all']), default='all', help='搜索类型')
@click.option('--limit', '-n', default=5, help='返回结果数量')
def query(query_text, type, limit):
    """
    在知识库中搜索代码
    
    QUERY_TEXT: 搜索关键词或描述
    """
    console.print(Panel.fit(
        "🔍 代码搜索",
        style="bold blue"
    ))
    
    storage = CodeStorage()
    
    console.print(f"搜索: [yellow]{query_text}[/yellow]\n")
    
    # 搜索函数
    if type in ['function', 'all']:
        results = storage.search_similar_functions(query_text, n_results=limit)
        
        if results:
            console.print("[cyan]📦 相关函数:[/cyan]")
            for i, result in enumerate(results, 1):
                console.print(f"\n{i}. {result['metadata']['name']} (相似度: {1-result.get('distance', 0):.2%})")
                syntax = Syntax(result['document'][:300], "python", line_numbers=False)
                console.print(syntax)
    
    # 搜索类
    if type in ['class', 'all']:
        results = storage.search_similar_classes(query_text, n_results=limit)
        
        if results:
            console.print("\n[cyan]🏛️  相关类:[/cyan]")
            for i, result in enumerate(results, 1):
                console.print(f"\n{i}. {result['metadata']['name']} (相似度: {1-result.get('distance', 0):.2%})")
                syntax = Syntax(result['document'][:300], "python", line_numbers=False)
                console.print(syntax)


@cli.command()
def info():
    """显示知识库信息"""
    console.print(Panel.fit(
        "📊 知识库信息",
        style="bold blue"
    ))
    
    storage = CodeStorage()
    
    # 获取命名规则
    naming = storage.get_naming_patterns()
    if naming:
        console.print("\n[cyan]📋 命名规则:[/cyan]")
        for key, value in naming.items():
            console.print(f"  • {key}: [yellow]{value}[/yellow]")
    else:
        console.print("\n[yellow]⚠️  知识库为空，请先运行 scan 命令[/yellow]")
        return
    
    # 获取设计模式
    patterns = storage.get_design_patterns()
    if patterns:
        console.print("\n[cyan]🎨 设计模式:[/cyan]")
        for item in patterns:
            console.print(f"  • {item['pattern']}: [yellow]{item['count']}[/yellow] 次")


@cli.command(name='train-model')
@click.argument('path', type=click.Path(exists=True))
def train_model(path):
    """
    训练轻量命名风格模型（v0.2.0）

    PATH: 训练数据目录或文件路径
    """
    console.print(Panel.fit(
        "🧠 训练命名风格模型",
        style="bold blue"
    ))

    parser = CodeParser()
    extractor = KnowledgeExtractor()
    model = NamingStyleModel()

    path_obj = Path(path)
    if path_obj.is_file():
        parsed = parser.parse_file(str(path_obj))
        parsed_list = [parsed] if parsed else []
    else:
        parsed_list = parser.parse_directory(str(path_obj))

    if not parsed_list:
        console.print("[red]❌ 没有可训练的Python文件[/red]")
        return

    console.print("📊 提取训练特征...")
    knowledge = extractor.extract_from_multiple(parsed_list)
    result = model.train_from_knowledge(knowledge)

    if not result['ok']:
        console.print(f"[yellow]⚠️  {result['message']}[/yellow]")
        return

    console.print("[green]✅ 模型训练完成[/green]")
    console.print(f"  - 样本数: {result['samples']}")
    console.print(f"  - 标签: {', '.join(result['labels'])}")
    console.print(f"  - 模型文件: {result['model_path']}")


@cli.command(name='vector-stats')
def vector_stats():
    """显示向量数据库统计信息"""
    console.print(Panel.fit(
        "🗄️ 向量数据库状态",
        style="bold blue"
    ))

    storage = CodeStorage()
    stats = storage.stats()

    table = Table(title="Vector DB Stats")
    table.add_column("Key", style="cyan")
    table.add_column("Value", style="magenta")

    table.add_row("backend_available", str(stats['chroma_available']))
    table.add_row("db_path", stats['db_path'])
    table.add_row("collection_prefix", stats['collection_prefix'])
    table.add_row("function_count", str(stats['function_count']))
    table.add_row("class_count", str(stats['class_count']))

    console.print(table)


@cli.command()
def clear():
    """清空知识库"""
    if click.confirm('确定要清空知识库吗？'):
        storage = CodeStorage()
        storage.clear()
        console.print("[green]✅ 知识库已清空[/green]")


def _ensure_knowledge_base(repo_path: str, storage: CodeStorage):
    """确保向量库中已有基础代码知识。"""
    stats = storage.stats()
    if stats.get('function_count', 0) > 0:
        return

    console.print("[yellow]⚠️  检测到知识库为空，自动执行 scan...[/yellow]")
    parser = CodeParser()
    extractor = KnowledgeExtractor()
    parsed_list = parser.parse_directory(repo_path)
    if not parsed_list:
        raise RuntimeError("无法建立知识库：目录中无可解析Python文件")
    knowledge = extractor.extract_from_multiple(parsed_list)
    storage.add_knowledge(knowledge)


@cli.command(name='commit-mvp')
@click.argument('repo_path', type=click.Path(exists=True))
@click.argument('commit_sha')
@click.option('--topk', default=3, help='证据返回数量')
@click.option('--neo4j-uri', default='', help='Neo4j URI，例如 bolt://localhost:7687')
@click.option('--neo4j-user', default='', help='Neo4j 用户名')
@click.option('--neo4j-password', default='', help='Neo4j 密码')
def commit_mvp(repo_path, commit_sha, topk, neo4j_uri, neo4j_user, neo4j_password):
    """
    提交级 MVP：输入 commit，输出三层风险分 + 证据
    """
    console.print(Panel.fit(
        "🧪 提交级一致性 MVP",
        style="bold blue"
    ))

    storage = CodeStorage()
    _ensure_knowledge_base(repo_path, storage)

    miner = CommitMiner(repo_path)
    context = miner.get_commit(commit_sha)

    graph = Neo4jGraphStore(
        uri=neo4j_uri or None,
        user=neo4j_user or None,
        password=neo4j_password or None,
    )
    try:
        if graph.enabled:
            graph.ingest_commit(context)

        retriever = HybridRetriever(storage=storage, graph_store=graph if graph.enabled else None)
        scorer = CommitRiskScorer(storage=storage, retriever=retriever)
        result = scorer.score(context, top_k=topk)
    finally:
        graph.close()

    table = Table(title=f"Commit Risk - {result['commit'][:10]}")
    table.add_column("维度", style="cyan")
    table.add_column("分数", style="magenta")
    table.add_row("style_risk", str(result['style_risk']))
    table.add_row("structure_risk", str(result['structure_risk']))
    table.add_row("logic_risk", str(result['logic_risk']))
    table.add_row("overall_risk", str(result['overall_risk']))
    if 'statistical_overall_risk' in result:
        table.add_row("statistical_overall", str(result['statistical_overall_risk']))
    if 'rule_overall_risk' in result:
        table.add_row("rule_overall", str(result['rule_overall_risk']))
    table.add_row("weak_label", str(result['weak_label']))
    console.print(table)

    console.print(f"\n提交作者: [yellow]{result.get('author', 'unknown')}[/yellow]")
    console.print(f"修改文件数: [yellow]{result.get('changed_files', 0)}[/yellow]")
    console.print(f"修改函数数: [yellow]{result.get('changed_functions', 0)}[/yellow]")
    if result.get('decision_mode'):
        console.print(f"决策模式: [yellow]{result.get('decision_mode')}[/yellow]")

    msg_adj = result.get('message_signal_adjustment')
    if msg_adj:
        console.print(
            f"消息信号调整: style={msg_adj.get('style', 0):+.3f}, "
            f"structure={msg_adj.get('structure', 0):+.3f}, logic={msg_adj.get('logic', 0):+.3f}"
        )

    rule_inf = result.get('rule_inference', {})
    if rule_inf.get('rule_triggered'):
        console.print(f"触发规则数: [yellow]{len(rule_inf.get('matched_rules', []))}[/yellow]")

    funcs = result.get('evidence', {}).get('functions', [])
    if funcs:
        console.print("\n[cyan]证据（Top）:[/cyan]")
        for idx, fn in enumerate(funcs, 1):
            console.print(f"\n{idx}. 函数 [yellow]{fn.get('function')}[/yellow] ({fn.get('file')}:{fn.get('line')})")
            style = fn.get('style', {})
            console.print(f"   style: expected={style.get('expected')} actual={style.get('actual')}")
            for h in fn.get('top_hits', []):
                hit_score = h.get('fused_score', h.get('score', 0))
                console.print(
                    f"   - [{h.get('source')}] {h.get('function_name', '')}"
                    f" score={hit_score:.3f} file={h.get('file_path', '')}"
                )


@cli.command(name='eval-weak')
@click.argument('repo_path', type=click.Path(exists=True))
@click.option('--samples', default=80, help='弱监督样本数量（建议50-100）')
@click.option('--max-commits', default=300, help='最多遍历commit数量')
@click.option('--neo4j-uri', default='', help='Neo4j URI（可选）')
@click.option('--neo4j-user', default='', help='Neo4j 用户名（可选）')
@click.option('--neo4j-password', default='', help='Neo4j 密码（可选）')
def eval_weak(repo_path, samples, max_commits, neo4j_uri, neo4j_user, neo4j_password):
    """
    构建弱监督评估集并输出 P/R/F1
    """
    console.print(Panel.fit(
        "📈 弱监督评估",
        style="bold blue"
    ))

    storage = CodeStorage()
    _ensure_knowledge_base(repo_path, storage)

    graph = Neo4jGraphStore(
        uri=neo4j_uri or None,
        user=neo4j_user or None,
        password=neo4j_password or None,
    )
    try:
        retriever = HybridRetriever(storage=storage, graph_store=graph if graph.enabled else None)
        runner = WeakEvalRunner(repo_path=repo_path, storage=storage, retriever=retriever)
        result = runner.run(samples=samples, max_commits=max_commits)
    finally:
        graph.close()

    if not result.get('ok'):
        console.print(f"[red]❌ {result.get('message', '评估失败')}[/red]")
        console.print(f"样本数: {result.get('samples', 0)}")
        return

    table = Table(title="Weak Eval Metrics")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="magenta")
    table.add_row("samples", str(result['samples']))
    table.add_row("weak_label_threshold", str(result.get('weak_label_threshold', 'n/a')))
    table.add_row("precision", str(result['precision']))
    table.add_row("recall", str(result['recall']))
    table.add_row("f1", str(result['f1']))
    if 'accuracy' in result:
        table.add_row("accuracy", str(result['accuracy']))
    console.print(table)

    console.print(f"\n数据集文件: [yellow]{result['dataset_path']}[/yellow]")


@cli.command(name='dataset-stats')
@click.argument('dataset_path', type=click.Path(exists=True))
def dataset_stats(dataset_path):
    """
    V2: 查看人工标注数据集统计信息

    DATASET_PATH: 标注数据集路径（JSONL）
    """
    console.print(Panel.fit(
        "📊 数据集统计 (V2)",
        style="bold blue"
    ))

    try:
        stats = DatasetStatistics.analyze_dataset(dataset_path)
    except Exception as exc:
        console.print(f"[red]❌ 统计失败: {exc}[/red]")
        return

    table = Table(title="Dataset Statistics")
    table.add_column("Key", style="cyan")
    table.add_column("Value", style="magenta")

    table.add_row("total_samples", str(stats.get("total_samples", 0)))
    table.add_row("class_balance", f"{stats.get('class_balance', 0):.4f}")
    table.add_row("label_distribution", str(stats.get("label_distribution", {})))

    for key in ["style_risk_mean", "style_risk_std", "structure_risk_mean", "structure_risk_std", "logic_risk_mean", "logic_risk_std"]:
        if key in stats:
            table.add_row(key, f"{stats[key]:.4f}")

    console.print(table)


@cli.command(name='eval-human')
@click.argument('dataset_path', type=click.Path(exists=True))
@click.option('--train-ratio', default=0.6, show_default=True, help='训练集比例')
@click.option('--valid-ratio', default=0.2, show_default=True, help='验证集比例')
@click.option('--test-ratio', default=0.2, show_default=True, help='测试集比例')
@click.option('--seed', default=42, show_default=True, help='随机种子')
@click.option('--bootstrap', default=300, show_default=True, help='Bootstrap 重采样次数')
@click.option('--save-splits-dir', default='', help='可选：保存 train/valid/test 划分目录')
@click.option('--save-metrics', default='', help='可选：保存评估结果 JSON 路径')
def eval_human(dataset_path, train_ratio, valid_ratio, test_ratio, seed, bootstrap, save_splits_dir, save_metrics):
    """
    V2: 基于人工标注数据集进行严格评估

    DATASET_PATH: 标注数据集路径（JSONL）
    """
    console.print(Panel.fit(
        "🧪 人工标注评估 (V2)",
        style="bold green"
    ))

    try:
        evaluator = HumanLabeledEvaluator(dataset_path)
        split = evaluator.split_data(
            train_ratio=train_ratio,
            valid_ratio=valid_ratio,
            test_ratio=test_ratio,
            seed=seed,
            stratify=True,
        )
        model = evaluator.train_baseline_model(random_state=seed)
        metrics = evaluator.evaluate_on_test(model, bootstrap_iterations=bootstrap)
    except Exception as exc:
        console.print(f"[red]❌ 评估失败: {exc}[/red]")
        return

    table = Table(title="Human-Labeled Eval Metrics")
    table.add_column("Metric", style="cyan")
    table.add_column("Value", style="magenta")
    table.add_row("train_size", str(split.get("train", 0)))
    table.add_row("valid_size", str(split.get("valid", 0)))
    table.add_row("test_size", str(metrics.get("test_size", split.get("test", 0))))
    table.add_row("precision", f"{metrics.get('precision', 0):.4f}")
    table.add_row("recall", f"{metrics.get('recall', 0):.4f}")
    table.add_row("f1", f"{metrics.get('f1', 0):.4f}")
    table.add_row("accuracy", f"{metrics.get('accuracy', 0):.4f}")
    if "auc_roc" in metrics:
        table.add_row("auc_roc", f"{metrics['auc_roc']:.4f}")
    console.print(table)

    ci = metrics.get("confidence_intervals_95", {})
    if ci:
        console.print(
            f"95% CI | F1={ci.get('f1', ('n/a', 'n/a'))}, "
            f"Precision={ci.get('precision', ('n/a', 'n/a'))}, "
            f"Recall={ci.get('recall', ('n/a', 'n/a'))}"
        )

    if save_splits_dir:
        evaluator.save_splits(save_splits_dir)

    output_path = save_metrics or str(config.DATA_DIR / "experiments" / "human_eval_metrics_v2.json")
    output_file = Path(output_path)
    output_file.parent.mkdir(parents=True, exist_ok=True)
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(metrics, f, indent=2, ensure_ascii=False)
    console.print(f"\n[green]💾 评估结果保存至: {output_file}[/green]")


@cli.command(name='ablation-v2')
@click.argument('dataset_path', type=click.Path(exists=True))
@click.option('--components', default='vector,graph,message_signals,rules', show_default=True, help='消融组件列表（逗号分隔）')
@click.option('--seed', default=42, show_default=True, help='随机种子')
@click.option('--output', default='', help='可选：输出 JSON 路径')
def ablation_v2(dataset_path, components, seed, output):
    """
    V2: 真实消融实验（移除组件后重新训练）

    DATASET_PATH: 标注数据集路径（JSONL）
    """
    console.print(Panel.fit(
        "🔬 真实消融实验 (V2)",
        style="bold green"
    ))

    component_list = [c.strip() for c in components.split(',') if c.strip()]

    try:
        evaluator = HumanLabeledEvaluator(dataset_path)
        evaluator.split_data(train_ratio=0.6, valid_ratio=0.2, test_ratio=0.2, seed=seed, stratify=True)

        ablation = AblationStudyV2(evaluator)
        ablation.run_ablation(components=component_list, random_state=seed)
        console.print(ablation.generate_summary_report())

        output_path = output or str(config.DATA_DIR / "experiments" / "ablation_study_v2.json")
        ablation.save_results(output_path)
    except Exception as exc:
        console.print(f"[red]❌ 消融实验失败: {exc}[/red]")


@cli.command(name='compare-baselines-v2')
@click.argument('dataset_path', type=click.Path(exists=True))
@click.option('--seed', default=42, show_default=True, help='随机种子')
@click.option('--output', default='', help='可选：输出 JSON 路径')
def compare_baselines_v2(dataset_path, seed, output):
    """
    V2: 与随机和启发式基线进行对比

    DATASET_PATH: 标注数据集路径（JSONL）
    """
    console.print(Panel.fit(
        "⚖️ 基线对比 (V2)",
        style="bold green"
    ))

    try:
        evaluator = HumanLabeledEvaluator(dataset_path)
        evaluator.split_data(train_ratio=0.6, valid_ratio=0.2, test_ratio=0.2, seed=seed, stratify=True)

        feature_keys = ["style_risk", "structure_risk", "logic_risk"]
        model = evaluator.train_baseline_model(feature_keys=feature_keys, random_state=seed)
        X_test = np.array([
            [row.get(k, 0.0) for k in feature_keys]
            for row in evaluator.test_data
        ])
        y_pred_model = model.predict(X_test)

        comparison = BaselineComparison(evaluator)
        comparison.add_baseline(RandomBaseline(seed=seed))
        comparison.add_baseline(HeuristicBaseline("changed_files"))
        comparison.add_baseline(HeuristicBaseline("commit_message_length"))
        comparison.add_baseline(ThresholdBaseline("overall_risk", threshold=0.5))
        comparison.add_model_results("ConsistenCy (Full Model)", y_pred_model)

        y_pred_random = RandomBaseline(seed=seed).predict(evaluator.test_data)
        significance = comparison.mcnemar_test(
            "ConsistenCy (Full Model)",
            "Random Baseline",
            y_pred_model,
            y_pred_random,
        )

        console.print(comparison.generate_comparison_table())
        if "error" in significance:
            console.print(f"[yellow]⚠️ 显著性检验失败: {significance['error']}[/yellow]")
        else:
            console.print(
                f"显著性检验: {significance.get('conclusion', 'N/A')} "
                f"(p={significance.get('p_value', 1.0):.4f})"
            )

        output_path = output or str(config.DATA_DIR / "experiments" / "baseline_comparison_v2.json")
        comparison.save_results(output_path)
    except Exception as exc:
        console.print(f"[red]❌ 基线对比失败: {exc}[/red]")

@cli.command(name='tune-weights')
@click.argument('dataset_path', type=click.Path(exists=True))
@click.option('--grid-step', default=0.1, help='网格搜索步长')
def tune_weights(dataset_path, grid_step):
    """
    M2: 基于评估数据集自动调优风险权重
    
    DATASET_PATH: 弱监督数据集路径（通常是 data/eval/weak_eval_dataset.jsonl）
    """
    console.print(Panel.fit(
        "⚙️  风险权重自动调优 (M2)",
        style="bold cyan"
    ))

    tuner = RiskWeightTuner(dataset_path=dataset_path)
    result = tuner.tune(grid_step=grid_step)

    if not result.get('ok'):
        console.print(f"[red]❌ {result.get('message', '调优失败')}[/red]")
        return

    console.print(f"\n[green]✅ 调优完成！[/green]")
    
    table = Table(title="最优权重")
    table.add_column("维度", style="cyan")
    table.add_column("权重", style="magenta")
    
    weights = result['best_weights']
    table.add_row("style", f"{weights['style']:.2f}")
    table.add_row("structure", f"{weights['structure']:.2f}")
    table.add_row("logic", f"{weights['logic']:.2f}")
    
    console.print(table)
    console.print(f"\n最优 F1: [yellow]{result['best_f1']:.4f}[/yellow]")
    console.print(f"候选数: {result['candidates_tested']}")
    console.print(f"输出文件: [yellow]{result['output_file']}[/yellow]")


@cli.command(name='compare-retrieval')
@click.argument('repo_path', type=click.Path(exists=True))
@click.argument('commit_sha')
@click.option('--topk', default=3, help='检索结果数量')
@click.option('--neo4j-uri', default='', help='Neo4j URI（可选）')
@click.option('--neo4j-user', default='', help='Neo4j 用户名（可选）')
@click.option('--neo4j-password', default='', help='Neo4j 密码（可选）')
def compare_retrieval(repo_path, commit_sha, topk, neo4j_uri, neo4j_user, neo4j_password):
    """
    M2: 对比向量/图/融合检索效果
    
    REPO_PATH: Git 仓库路径
    COMMIT_SHA: 提交哈希（支持HEAD等）
    """
    console.print(Panel.fit(
        "🔬 检索方法对比 (M2)",
        style="bold cyan"
    ))

    storage = CodeStorage()
    _ensure_knowledge_base(repo_path, storage)

    graph = Neo4jGraphStore(
        uri=neo4j_uri or None,
        user=neo4j_user or None,
        password=neo4j_password or None,
    )
    
    try:
        comparer = RetrievalComparer(
            repo_path=repo_path,
            storage=storage,
            graph_store=graph if graph.enabled else None,
        )
        result = comparer.compare(commit_sha=commit_sha, top_k=topk)
    finally:
        graph.close()

    if not result.get('ok'):
        console.print(f"[red]❌ {result.get('message', '对比失败')}[/red]")
        return

    console.print(f"\n提交: [yellow]{result['commit']}[/yellow]")
    console.print(f"图谱可用: {'✅' if result['graph_available'] else '❌'}")

    for comp in result['comparisons']:
        console.print(f"\n[bold]函数: {comp['function']}[/bold]")
        
        table = Table()
        table.add_column("检索方法", style="cyan")
        table.add_column("结果数", style="magenta")
        table.add_column("最高分", style="green")
        
        table.add_row(
            "向量检索",
            str(comp['vector_only']['count']),
            f"{comp['vector_only']['top_score']:.3f}"
        )
        table.add_row(
            "图检索",
            str(comp['graph_only']['count']),
            f"{comp['graph_only']['top_score']:.3f}"
        )
        table.add_row(
            "融合(加权)",
            str(comp['hybrid_weighted']['count']),
            f"{comp['hybrid_weighted']['top_score']:.3f}"
        )
        table.add_row(
            "融合(RRF)",
            str(comp['hybrid_rrf']['count']),
            f"{comp['hybrid_rrf']['top_score']:.3f}"
        )
        
        console.print(table)


@cli.command(name='graph-stats')
@click.option('--neo4j-uri', required=True, help='Neo4j URI')
@click.option('--neo4j-user', required=True, help='Neo4j 用户名')
@click.option('--neo4j-password', required=True, help='Neo4j 密码')
def graph_stats(neo4j_uri, neo4j_user, neo4j_password):
    """
    M2: 显示Neo4j图谱统计信息
    """
    console.print(Panel.fit(
        "📊 图谱统计 (M2)",
        style="bold cyan"
    ))

    graph = Neo4jGraphStore(uri=neo4j_uri, user=neo4j_user, password=neo4j_password)
    
    try:
        stats = graph.get_stats()
        
        if not stats.get('enabled'):
            console.print("[red]❌ Neo4j 未启用[/red]")
            return

        if 'error' in stats:
            console.print(f"[red]❌ 查询失败: {stats['error']}[/red]")
            return

        table = Table(title="图谱实体统计")
        table.add_column("实体类型", style="cyan")
        table.add_column("数量", style="magenta")
        
        table.add_row("Authors", str(stats.get('authors', 0)))
        table.add_row("Commits", str(stats.get('commits', 0)))
        table.add_row("Files", str(stats.get('files', 0)))
        table.add_row("Functions", str(stats.get('functions', 0)))
        
        console.print(table)
    finally:
        graph.close()


@cli.command(name='run-experiments')
@click.argument('repo-path', type=click.Path(exists=True))
@click.option('--dataset', type=click.Path(exists=True), required=True, help='评估数据集路径 (.jsonl)')
@click.option('--cv-folds', default=5, help='交叉验证折数 (默认5)')
@click.option('--neo4j-uri', envvar='NEO4J_URI', default='', help='Neo4j URI（可选）')
@click.option('--neo4j-user', envvar='NEO4J_USER', default='', help='Neo4j 用户名（可选）')
@click.option('--neo4j-password', envvar='NEO4J_PASSWORD', default='', help='Neo4j 密码（可选）')
def run_experiments(repo_path, dataset, cv_folds, neo4j_uri, neo4j_user, neo4j_password):
    """
    M3: 运行交叉验证实验
    
    REPO_PATH: 仓库路径
    """
    console.print(Panel.fit(
        "🧪 运行交叉验证实验 (M3)",
        style="bold cyan"
    ))

    storage = CodeStorage()
    graph = Neo4jGraphStore(
        uri=neo4j_uri or None,
        user=neo4j_user or None,
        password=neo4j_password or None,
    )
    runner = ExperimentRunner(repo_path, storage, graph if graph.enabled else None)

    try:
        result = runner.run_cross_validation(dataset, n_folds=cv_folds)
        
        if result["ok"]:
            console.print(f"\n[green]✅ 实验完成[/green]")
            console.print(f"输出文件: {result['output_file']}")
            
            summary = result["summary"]
            table = Table(title="交叉验证结果")
            table.add_column("指标", style="cyan")
            table.add_column("值", style="magenta")
            
            table.add_row("平均 Precision", f"{summary.get('mean_precision', 0.0):.4f}")
            table.add_row("平均 Recall", f"{summary.get('mean_recall', 0.0):.4f}")
            table.add_row("平均 F1", f"{summary['mean_f1']:.4f}")
            table.add_row("平均 Accuracy", f"{summary.get('mean_accuracy', 0.0):.4f}")
            table.add_row("标准差", f"{summary['std_f1']:.4f}")
            table.add_row("最小 F1", f"{summary['min_f1']:.4f}")
            table.add_row("最大 F1", f"{summary['max_f1']:.4f}")
            
            console.print(table)
        else:
            console.print(f"[red]❌ {result['message']}[/red]")
    finally:
        graph.close()


@cli.command(name='ablation-study')
@click.argument('repo-path', type=click.Path(exists=True))
@click.option('--dataset', type=click.Path(exists=True), required=True, help='评估数据集路径 (.jsonl)')
@click.option('--components', default='vector,graph,message_signals,rules', help='消融组件列表（逗号分隔）')
@click.option('--neo4j-uri', envvar='NEO4J_URI', default='', help='Neo4j URI（可选）')
@click.option('--neo4j-user', envvar='NEO4J_USER', default='', help='Neo4j 用户名（可选）')
@click.option('--neo4j-password', envvar='NEO4J_PASSWORD', default='', help='Neo4j 密码（可选）')
def ablation_study(repo_path, dataset, components, neo4j_uri, neo4j_user, neo4j_password):
    """
    M3: 运行消融实验分析各组件贡献
    
    REPO_PATH: 仓库路径
    """
    console.print(Panel.fit(
        "🔬 消融实验 (M3)",
        style="bold cyan"
    ))

    storage = CodeStorage()
    graph = Neo4jGraphStore(
        uri=neo4j_uri or None,
        user=neo4j_user or None,
        password=neo4j_password or None,
    )
    runner = ExperimentRunner(repo_path, storage, graph if graph.enabled else None)

    component_list = [c.strip() for c in components.split(',')]

    try:
        result = runner.run_ablation_study(dataset, components=component_list)
        
        if result["ok"]:
            console.print(f"\n[green]✅ 消融实验完成[/green]")
            console.print(f"输出文件: {result['output_file']}")
            console.print(f"\n{result['summary']}")
        else:
            console.print(f"[red]❌ {result['message']}[/red]")
    finally:
        graph.close()


@cli.command(name='generate-cases')
@click.argument('repo-path', type=click.Path(exists=True))
@click.option('--commits', help='提交SHA列表 (逗号分隔)', required=True)
@click.option('--top-n', default=5, help='生成TOP N案例 (默认5)')
def generate_cases(repo_path, commits, top_n):
    """
    M3: 生成高风险提交案例报告
    
    REPO_PATH: 仓库路径
    """
    console.print(Panel.fit(
        "📝 生成案例报告 (M3)",
        style="bold cyan"
    ))

    storage = CodeStorage()
    miner = CommitMiner(repo_path)
    scorer = CommitRiskScorer(
        storage=storage,
        retriever=HybridRetriever(storage, fusion_method='weighted_sum'),
    )
    generator = CaseGenerator(miner, scorer)

    commit_list = [c.strip() for c in commits.split(',')]

    result = generator.generate_top_risk_cases(commit_list, top_n=top_n)

    if result["ok"]:
        console.print(f"\n[green]✅ 案例生成完成[/green]")
        console.print(f"JSON 输出: {result['output_json']}")
        console.print(f"Markdown 输出: {result['output_md']}")
        console.print(f"\n生成了 {len(result['cases'])} 个高风险案例")
    else:
        console.print("[red]❌ 案例生成失败[/red]")


# ===========================================================================
# M4 命令组：标注数据准备流水线
# ===========================================================================

@cli.group(name='m4')
def m4_group():
    """M4 标注数据准备流水线（项目选择 → 提交采样 → 人工标注 → Kappa 验证）"""
    pass


@m4_group.command(name='select-projects')
@click.option('--n', default=10, show_default=True, help='目标项目数量')
@click.option('--min-stars', default=200, show_default=True, help='最低 star 数')
@click.option('--min-contributors', default=3, show_default=True, help='最低贡献者数')
@click.option('--min-age-months', default=12, show_default=True, help='项目最小年龄（月）')
@click.option('--token', envvar='GITHUB_ACCESS_TOKEN', default=None,
              help='GitHub 个人访问令牌（也可通过 GITHUB_ACCESS_TOKEN 环境变量传入）')
@click.option('--output', default=None,
              type=click.Path(), help='输出 JSON 路径（默认 data/projects/selected_projects.json）')
def m4_select_projects(n, min_stars, min_contributors, min_age_months, token, output):
    """
    M4.1: 从 GitHub 自动筛选待标注的 Python 开源项目

    示例：

      \b
      # 搜索 10 个项目（需设置 GITHUB_ACCESS_TOKEN）
      python cli.py m4 select-projects --n 10 --min-stars 500

    需要 GITHUB_ACCESS_TOKEN 以提高 API 限速上限（可选：无 token 限 60 req/h）。
    """
    console.print(Panel.fit("🔍  M4.1 项目选择 (ProjectSelector)", style="bold cyan"))

    criteria = ProjectCriteria(
        min_stars=min_stars,
        min_contributors=min_contributors,
        min_age_months=min_age_months,
    )
    selector = ProjectSelector(criteria=criteria, token=token)
    try:
        projects = selector.select(n=n)
    except RuntimeError as exc:
        console.print(f"[red]❌ GitHub API 错误: {exc}[/red]")
        console.print("[yellow]提示: 请设置环境变量 GITHUB_ACCESS_TOKEN[/yellow]")
        raise SystemExit(1)

    out_path = selector.save(projects, output_path=output)

    table = Table(title=f"已选定 {len(projects)} 个项目")
    table.add_column("项目", style="cyan")
    table.add_column("⭐ Stars", justify="right")
    table.add_column("描述")
    for p in projects:
        table.add_row(p.full_name, str(p.stars), p.description[:60])
    console.print(table)
    console.print(f"\n[green]✅ 已保存 → {out_path}[/green]")


@m4_group.command(name='sample-commits')
@click.argument('repo_path', type=click.Path(exists=True))
@click.argument('project_name')
@click.option('--n', default=50, show_default=True, help='采样提交数量')
@click.option('--max-per-author', default=5, show_default=True, help='每作者最多采样数')
@click.option('--seed', default=42, show_default=True, help='随机种子')
@click.option('--output', default=None, type=click.Path(),
              help='输出 JSONL 路径（默认 data/annotations/batches/<project>_batch.jsonl）')
def m4_sample_commits(repo_path, project_name, n, max_per_author, seed, output):
    """
    M4.2: 从本地 Git 仓库中分层采样提交，生成标注批次

    \b
    REPO_PATH:    已 clone 的本地仓库路径
    PROJECT_NAME: 项目标识名（用于输出文件命名）

    示例：

      \b
      git clone https://github.com/pallets/flask /tmp/flask
      python cli.py m4 sample-commits /tmp/flask flask --n 50
    """
    console.print(Panel.fit(f"📦  M4.2 提交采样: {project_name}", style="bold cyan"))

    sampler = CommitSampler(repo_path=repo_path, project_name=project_name)
    shas = sampler.sample(n=n, max_per_author=max_per_author, seed=seed)

    if not shas:
        console.print("[red]❌ 未采样到任何提交，请检查仓库路径或过滤条件[/red]")
        raise SystemExit(1)

    out_path = sampler.save_batch(shas, output_path=output)
    console.print(f"[green]✅ 采样 {len(shas)} 个提交 → {out_path}[/green]")
    console.print("\n下一步: 将批次文件交给标注员，运行:\n"
                  f"  python cli.py m4 annotate {repo_path} <output_dir> <annotator_id>")


@m4_group.command(name='annotate')
@click.argument('repo_path', type=click.Path(exists=True))
@click.argument('output_dir', type=click.Path())
@click.argument('annotator_id')
@click.option('--batch', default=None, type=click.Path(exists=True),
              help='批次 JSONL 文件路径（由 sample-commits 生成）；留空则手动输入 SHA')
@click.option('--limit', default=0, help='最多标注数量（0 = 全部）')
def m4_annotate(repo_path, output_dir, annotator_id, batch, limit):
    """
    M4.3: 交互式人工标注工具

    \b
    REPO_PATH:    本地仓库路径
    OUTPUT_DIR:   标注结果输出目录
    ANNOTATOR_ID: 标注员 ID（如 annotator_001）

    示例：

      \b
      python cli.py m4 annotate /tmp/flask ./data/annotations/flask annotator_001 \\
          --batch ./data/annotations/batches/flask_batch.jsonl
    """
    console.print(Panel.fit(f"✏️   M4.3 人工标注: {annotator_id}", style="bold cyan"))
    console.print("[yellow]标注参考: data/annotations/ANNOTATION_GUIDELINE.md[/yellow]\n")

    tool = AnnotationTool(
        repo_path=repo_path,
        output_dir=output_dir,
        annotator_id=annotator_id,
    )

    if batch:
        # 从批次文件读取 SHA 列表
        shas = []
        with open(batch, "r", encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    shas.append(rec["commit_sha"])
                except (json.JSONDecodeError, KeyError):
                    continue
        if limit > 0:
            shas = shas[:limit]
        console.print(f"[cyan]批次文件: {len(shas)} 个提交[/cyan]\n")

        already_done = tool.get_annotated_commits()
        pending = [s for s in shas if s not in already_done]
        console.print(f"已标注: {len(already_done)}  待标注: {len(pending)}\n")

        for sha in pending:
            result = tool.annotate_commit(sha)
            if result is None:
                break  # 用户中止
    else:
        console.print("[yellow]未指定批次文件，请手动输入提交 SHA（Ctrl-C 退出）[/yellow]")
        while True:
            try:
                sha = input("输入 commit SHA: ").strip()
                if sha:
                    tool.annotate_commit(sha)
            except KeyboardInterrupt:
                break

    console.print(f"\n[green]✅ 标注完成。共 {len(tool.annotations)} 条记录[/green]")
    console.print(f"输出目录: {tool.output_dir}")


@m4_group.command(name='calc-kappa')
@click.argument('annotations_dir', type=click.Path(exists=True))
@click.option('--output', default=None, type=click.Path(),
              help='报告输出路径（默认 data/annotations/kappa_report.json）')
@click.option('--min-kappa', default=0.70, show_default=True,
              help='通过阈值（M5 验收标准）')
def m4_calc_kappa(annotations_dir, output, min_kappa):
    """
    M5: 计算标注员间一致性（Cohen/Fleiss Kappa），验证 M5 标准（≥ 0.70）

    \b
    ANNOTATIONS_DIR: 包含 annotations_<id>.jsonl 文件的目录

    示例：

      \b
      python cli.py m4 calc-kappa ./data/annotations/flask/
    """
    console.print(Panel.fit("📐  M5 一致性检验 (Kappa)", style="bold cyan"))

    calculator = KappaCalculator(annotations_dir=annotations_dir)
    report = calculator.generate_report()
    calculator.print_summary(report)

    out_path = calculator.save_report(report, output_path=output)

    summary = report.get("summary", {})
    mean_k = summary.get("mean_kappa", 0.0)
    if mean_k >= min_kappa:
        console.print(f"[green]✅ 平均 Kappa {mean_k:.4f} ≥ {min_kappa}，"
                      f"通过 M5 验收标准！[/green]")
        console.print("下一步: 进入 M6 全量标注阶段")
    else:
        console.print(f"[red]❌ 平均 Kappa {mean_k:.4f} < {min_kappa}，"
                      f"未通过 M5 标准[/red]")
        console.print("[yellow]建议: 召开标注校准会议，重点讨论 top_disagreements 中的提交[/yellow]")
        console.print(f"分歧报告: {out_path}")


if __name__ == '__main__':
    cli()
