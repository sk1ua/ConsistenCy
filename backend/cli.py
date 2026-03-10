# -*- coding: utf-8 -*-
"""
CLI工具
命令行接口
"""
import sys
import click
from pathlib import Path
from rich.console import Console
from rich.table import Table
from rich.panel import Panel
from rich.syntax import Syntax

from src.parser import CodeParser
from src.extractor import KnowledgeExtractor
from src.storage import CodeStorage
from src.checker import ConsistencyChecker
from src.ml_naming_model import NamingStyleModel
from src.commit_pipeline import (
    CommitMiner,
    Neo4jGraphStore,
    HybridRetriever,
    CommitRiskScorer,
    WeakEvalRunner,
    RiskWeightTuner,
    RetrievalComparer,
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
    table.add_row("weak_label", str(result['weak_label']))
    console.print(table)

    console.print(f"\n提交作者: [yellow]{result.get('author', 'unknown')}[/yellow]")
    console.print(f"修改文件数: [yellow]{result.get('changed_files', 0)}[/yellow]")
    console.print(f"修改函数数: [yellow]{result.get('changed_functions', 0)}[/yellow]")

    funcs = result.get('evidence', {}).get('functions', [])
    if funcs:
        console.print("\n[cyan]证据（Top）:[/cyan]")
        for idx, fn in enumerate(funcs, 1):
            console.print(f"\n{idx}. 函数 [yellow]{fn.get('function')}[/yellow] ({fn.get('file')}:{fn.get('line')})")
            style = fn.get('style', {})
            console.print(f"   style: expected={style.get('expected')} actual={style.get('actual')}")
            for h in fn.get('top_hits', []):
                console.print(
                    f"   - [{h.get('source')}] {h.get('function_name', '')}"
                    f" score={h.get('score', 0):.3f} file={h.get('file_path', '')}"
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
    console.print(table)

    console.print(f"\n数据集文件: [yellow]{result['dataset_path']}[/yellow]")
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


if __name__ == '__main__':
    cli()

if __name__ == '__main__':
    cli()
