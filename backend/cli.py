# -*- coding: utf-8 -*-
"""
ConsistenCy CLI
===============
Multi-agent code consistency analysis toolkit.

Commands
--------
scan            Build a baseline snapshot for a repo
analyze-commit  Run full multi-agent analysis on a single commit
analyze-range   Batch analysis over a date/commit range
pr-report       Generate initial PR-level risk report for base..head range
analyze-file    Compare two Python files directly (no Git required)
web-ui          Launch the Flask web dashboard
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import click
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

# Ensure backend src is importable regardless of cwd
_SRC = Path(__file__).parent / "src"
if str(_SRC.parent) not in sys.path:
    sys.path.insert(0, str(_SRC.parent))

from src.models import score_to_risk_colour, score_to_risk_label
from src.pipeline import AnalysisPipeline, analyze_sources
from src.exporter import ResultExporter
from src import __version__

console = Console()

_RISK_COLOUR_RICH = {
    "GREEN":  "green",
    "YELLOW": "yellow",
    "ORANGE": "dark_orange",
    "RED":    "red",
}


# ---------------------------------------------------------------------------
# CLI group
# ---------------------------------------------------------------------------

@click.group()
@click.version_option(version=__version__)
def cli():
    """ConsistenCy - Multi-Agent Code Consistency Analysis."""


# ---------------------------------------------------------------------------
# scan
# ---------------------------------------------------------------------------

@cli.command()
@click.argument("repo_path", type=click.Path(exists=True))
@click.option("--baseline-commits", default=50, show_default=True,
              help="Number of commits to use as baseline.")
def scan(repo_path: str, baseline_commits: int):
    """Scan REPO_PATH and print a baseline risk summary.

    REPO_PATH - absolute or relative path to a Git repository.
    """
    console.print(Panel.fit(
        f"[bold blue]ConsistenCy[/bold blue]  Scanning [cyan]{repo_path}[/cyan]",
        border_style="blue",
    ))
    try:
        pipeline = AnalysisPipeline(repo_path)
        file_summary = pipeline.file_summary()
        hotspots     = pipeline.hotspot_data()[:5]
    except Exception as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc

    tbl = Table(title="File Risk Summary (top 20)", header_style="bold cyan")
    tbl.add_column("File", style="cyan", no_wrap=True)
    tbl.add_column("Risk Score", justify="right")
    tbl.add_column("Level")

    for entry in file_summary[:20]:
        colour = _RISK_COLOUR_RICH.get(entry.get("risk_level", ""), "white")
        tbl.add_row(
            entry["file"],
            f"{entry['risk_score']:.3f}",
            f"[{colour}]{entry.get('risk_level', '')}[/{colour}]",
        )
    console.print(tbl)

    if hotspots:
        h_tbl = Table(title="Top Hotspot Files", header_style="bold red")
        h_tbl.add_column("File", style="cyan")
        h_tbl.add_column("Churn", justify="right")
        h_tbl.add_column("CC avg", justify="right")
        h_tbl.add_column("Hotspot Score", justify="right")
        for h in hotspots:
            h_tbl.add_row(
                h["file"],
                str(h["churn"]),
                f"{h['cyclomatic_avg']:.1f}",
                f"{h['hotspot_score']:.3f}",
            )
        console.print(h_tbl)

    console.print("[green]OK Scan complete.[/green]")


# ---------------------------------------------------------------------------
# analyze-commit
# ---------------------------------------------------------------------------

@cli.command("analyze-commit")
@click.option("--repo", required=True, type=click.Path(exists=True),
              help="Path to the Git repository.")
@click.option("--commit", default=None,
              help="Commit SHA to analyse (default: HEAD).")
@click.option("--baseline-commits", default=50, show_default=True,
              help="Number of previous commits used as baseline.")
@click.option("--json-output", is_flag=True, help="Print full JSON result to stdout.")
def analyze_commit(repo: str, commit: str, baseline_commits: int, json_output: bool):
    """Run multi-agent analysis on a single commit."""
    if not json_output:
        console.print(Panel.fit(
            f"[bold blue]ConsistenCy[/bold blue]  Analysing commit "
            f"[cyan]{commit or 'HEAD'}[/cyan] in [cyan]{repo}[/cyan]",
            border_style="blue",
        ))

    try:
        pipeline = AnalysisPipeline(repo)
        result = pipeline.analyze_commit(commit_sha=commit, baseline_n=baseline_commits)
    except Exception as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc

    if json_output:
        click.echo(json.dumps(result, indent=2, default=str))
        return

    final_score = result.get("final_risk_score", 0.0)
    colour = _risk_colour_str(final_score)
    rich_colour = _RISK_COLOUR_RICH.get(colour, "white")

    console.print(
        f"\n  Final risk score: [{rich_colour}]{final_score:.3f}[/{rich_colour}]"
        f"  ({_risk_level(final_score)})\n"
    )

    for line in result.get("evolution_evidence", []):
        console.print(f"  [dim]-[/dim] {line}")

    file_results = result.get("file_results", {})
    if file_results:
        if isinstance(file_results, dict):
            file_rows = [
                {"file": filepath, **fr}
                for filepath, fr in file_results.items()
            ]
        else:
            file_rows = list(file_results)

        tbl = Table(title="Per-file Breakdown", header_style="bold cyan")
        tbl.add_column("File", style="cyan")
        tbl.add_column("Risk", justify="right")
        tbl.add_column("Style", justify="right")
        tbl.add_column("Struct", justify="right")
        tbl.add_column("Semantic", justify="right")
        tbl.add_column("Dup", justify="right")
        tbl.add_column("Board")
        for fr in sorted(
            file_rows, key=lambda x: x.get("risk_score", 0.0), reverse=True
        ):
            filepath = fr.get("file", "?")
            bd = fr.get("breakdown", {})
            c = _RISK_COLOUR_RICH.get(_risk_colour_str(fr["risk_score"]), "white")
            board = fr.get("agent_collaboration", {}).get("decision", "n/a")
            tbl.add_row(
                filepath,
                f"[{c}]{fr['risk_score']:.3f}[/{c}]",
                f"{bd.get('style', 0):.3f}",
                f"{bd.get('structural', 0):.3f}",
                f"{bd.get('semantic', 0):.3f}",
                f"{bd.get('duplication', 0):.3f}",
                board,
            )
        console.print(tbl)

# ---------------------------------------------------------------------------
# analyze-range
# ---------------------------------------------------------------------------

@cli.command("analyze-range")
@click.option("--repo", required=True, type=click.Path(exists=True),
              help="Path to the Git repository.")
@click.option("--weeks", default=12, show_default=True, help="Number of past weeks.")
@click.option("--baseline-commits", default=50, show_default=True,
              help="Number of commits to build per-commit baseline window.")
@click.option("--max-commits", default=40, show_default=True,
              help="Maximum number of commits to analyze in range.")
@click.option("--json-output", is_flag=True, help="Emit JSON.")
def analyze_range(
    repo: str,
    weeks: int,
    baseline_commits: int,
    max_commits: int,
    json_output: bool,
):
    """Analyse risk score evolution over the past N weeks."""
    if not json_output:
        console.print(Panel.fit(
            f"[bold blue]ConsistenCy[/bold blue]  "
            f"Weekly history [{weeks}w] [cyan]{repo}[/cyan]",
            border_style="blue",
        ))

    try:
        pipeline = AnalysisPipeline(repo)
        report = pipeline.analyze_range(
            weeks=weeks,
            baseline_n=baseline_commits,
            max_commits=max_commits,
        )
        history = report.get("weekly", [])
    except Exception as exc:
        console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc

    if json_output:
        click.echo(json.dumps(report, indent=2))
        return

    tbl = Table(title="Weekly Risk History", header_style="bold cyan")
    tbl.add_column("Week")
    tbl.add_column("Avg Risk", justify="right")
    tbl.add_column("Commits", justify="right")
    tbl.add_column("Real", justify="right")
    tbl.add_column("Trend")

    prev = None
    for entry in history:
        score = entry["avg_risk"]
        c = _RISK_COLOUR_RICH.get(_risk_colour_str(score), "white")
        trend = ""
        if prev is not None:
            delta = score - prev
            trend = (f"[red]up {delta:+.3f}[/red]" if delta > 0.01
                     else f"[green]down {delta:+.3f}[/green]" if delta < -0.01
                     else "flat")
        tbl.add_row(
            entry["week"],
            f"[{c}]{score:.3f}[/{c}]",
            str(entry["commit_count"]),
            str(entry.get("real_sample_count", 0)),
            trend,
        )
        prev = score

    console.print(tbl)
    console.print(
        "\n"
        f"  Range commits: {report.get('commit_count', 0)}"
        f"  | avg={report.get('avg_risk', 0.0):.3f}"
        f"  | max={report.get('max_risk', 0.0):.3f}"
        f"  | high-risk={report.get('high_risk_commits', 0)}"
        f"  | baseline-cache-hit={report.get('cache', {}).get('baseline_hit', 0)}\n"
    )

# ---------------------------------------------------------------------------
# pr-report
# ---------------------------------------------------------------------------

@cli.command("pr-report")
@click.option("--repo", required=True, type=click.Path(exists=True),
              help="Path to the Git repository.")
@click.option("--base", required=True, help="Base ref/commit for PR range.")
@click.option("--head", default="HEAD", show_default=True,
              help="Head ref/commit for PR range.")
@click.option("--baseline-commits", default=50, show_default=True,
              help="Number of commits to build per-commit baseline window.")
@click.option("--max-commits", default=40, show_default=True,
              help="Maximum commits to include from base..head range.")
@click.option("--json-output", is_flag=True, help="Emit JSON.")
@click.option(
    "--llm-review", is_flag=True,
    help="Append AI-generated review via DeepSeek (requires DEEPSEEK_API_KEY).",
)
def pr_report(
    repo: str,
    base: str,
    head: str,
    baseline_commits: int,
    max_commits: int,
    json_output: bool,
    llm_review: bool,
):
    """Generate a PR-level risk report for a commit range.

    When --json-output is set, only JSON is written to stdout (no Rich output),
    making it safe to redirect: pr-report ... --json-output > report.json
    """
    try:
        pipeline = AnalysisPipeline(repo)
        report = pipeline.pr_risk_report(
            base_ref=base,
            head_ref=head,
            baseline_n=baseline_commits,
            max_commits=max_commits,
        )
    except Exception as exc:
        if json_output:
            click.echo(json.dumps({"error": str(exc)}, indent=2))
        else:
            console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc

    if json_output:
        click.echo(json.dumps(report, indent=2, default=str))
        return

    # Rich terminal output (only when not in json-output mode)
    console.print(Panel.fit(
        f"[bold blue]ConsistenCy[/bold blue]  "
        f"PR report [cyan]{base}..{head}[/cyan] in [cyan]{repo}[/cyan]",
        border_style="blue",
    ))

    console.print(
        "\n"
        f"  Commits: {report.get('commit_count', 0)}"
        f"  | avg={report.get('avg_risk', 0.0):.3f}"
        f"  | max={report.get('max_risk', 0.0):.3f}"
        f"  | high-risk={report.get('high_risk_commits', 0)}"
        f"  | baseline-cache-hit={report.get('cache', {}).get('baseline_hit', 0)}\n"
    )

    composition = report.get("risk_composition", {})
    if composition:
        console.print(
            f"  Formula: {composition.get('formula', 'n/a')}\n"
            f"  File formula: {composition.get('file_formula', 'n/a')}\n"
        )

    board = report.get("agent_collaboration", {})
    if board:
        console.print(
            "  Agent board: "
            f"{board.get('decision', 'n/a')} "
            f"(score={float(board.get('consensus_score', 0.0)):.3f}, "
            f"quorum={board.get('quorum', 'n/a')})\n"
        )

    commits = report.get("commits", [])
    if commits:
        tbl = Table(title="PR Commit Risk", header_style="bold cyan")
        tbl.add_column("SHA")
        tbl.add_column("Author", style="cyan")
        tbl.add_column("Risk", justify="right")
        tbl.add_column("Level")
        tbl.add_column("Files", justify="right")
        for entry in sorted(commits, key=lambda x: x["risk_score"], reverse=True):
            score = entry["risk_score"]
            c = _RISK_COLOUR_RICH.get(_risk_colour_str(score), "white")
            tbl.add_row(
                entry["sha"],
                entry["author"],
                f"[{c}]{score:.3f}[/{c}]",
                entry.get("risk_level", _risk_level(score)),
                str(entry.get("files_analyzed", 0)),
            )
        console.print(tbl)

    top_files = report.get("top_risky_files", [])
    if top_files:
        f_tbl = Table(title="Top Risky Files in PR", header_style="bold red")
        f_tbl.add_column("File", style="cyan")
        f_tbl.add_column("Avg Risk", justify="right")
        f_tbl.add_column("Max Risk", justify="right")
        f_tbl.add_column("Churn", justify="right")
        f_tbl.add_column("Complexity", justify="right")
        f_tbl.add_column("Owner", style="cyan")
        f_tbl.add_column("Hits", justify="right")
        for item in top_files[:15]:
            c = _RISK_COLOUR_RICH.get(_risk_colour_str(item["avg_risk"]), "white")
            f_tbl.add_row(
                item["file"],
                f"[{c}]{item['avg_risk']:.3f}[/{c}]",
                f"{item['max_risk']:.3f}",
                str(item.get("churn_lines", 0)),
                f"{float(item.get('complexity', 0.0)):.2f}",
                str(item.get("owner", "unknown")),
                str(item["hits"]),
            )
        console.print(f_tbl)

    # Security summary in terminal output
    sec_findings = report.get("security_findings", [])
    if sec_findings:
        sec_tbl = Table(title="Security Findings", header_style="bold red")
        sec_tbl.add_column("Severity", style="bold")
        sec_tbl.add_column("File", style="cyan")
        sec_tbl.add_column("Finding")
        for item in sec_findings[:10]:
            ev = item.get("evidence", "")
            sev = "CRITICAL" if "[CRITICAL]" in ev else "HIGH" if "[HIGH]" in ev else "MEDIUM"
            colour = "red" if sev == "CRITICAL" else "dark_orange" if sev == "HIGH" else "yellow"
            sec_tbl.add_row(
                f"[{colour}]{sev}[/{colour}]",
                item.get("filepath", "?"),
                ev.split(": ", 1)[-1] if ": " in ev else ev,
            )
        console.print(sec_tbl)

    # Optionally append AI review to terminal output
    if llm_review:
        from src.review_suggestions import generate_review_comment  # noqa: PLC0415
        from src.llm_reviewer import is_llm_available  # noqa: PLC0415
        if is_llm_available():
            console.print("\n[bold cyan]Generating AI review via DeepSeek...[/bold cyan]")
        md_comment = generate_review_comment(report, use_llm=True)
        # Print just the AI review section
        ai_marker = "### AI Code Review"
        if ai_marker in md_comment:
            ai_section = md_comment[md_comment.index(ai_marker):]
            ai_section = ai_section.split("\n---")[0]
            console.print(ai_section)


@cli.command("analyze-file")
@click.argument("file_now", type=click.Path(exists=True))
@click.argument("file_base", type=click.Path(exists=True))
@click.option("--json-output", is_flag=True, help="Emit JSON.")
def analyze_file(file_now: str, file_base: str, json_output: bool):
    """Compare FILE_NOW against FILE_BASE directly (no Git required).

    FILE_NOW  - the new / modified version.\n
    FILE_BASE - the baseline / reference version.
    """
    src_now  = Path(file_now).read_text(encoding="utf-8", errors="replace")
    src_base = Path(file_base).read_text(encoding="utf-8", errors="replace")

    result = analyze_sources(src_now, src_base, filepath=file_now)
    if json_output:
        click.echo(json.dumps(result, indent=2, default=str))
        return

    score  = result["risk_score"]
    c = _RISK_COLOUR_RICH.get(_risk_colour_str(score), "white")

    console.print(Panel.fit(
        f"[bold blue]ConsistenCy[/bold blue]  "
        f"[cyan]{file_now}[/cyan] vs [cyan]{file_base}[/cyan]",
        border_style="blue",
    ))
    console.print(f"\n  Risk score: [{c}]{score:.3f}[/{c}]  ({result['risk_level']})\n")
    board = result.get("agent_collaboration", {})
    if board:
        console.print(
            "  Agent board: "
            f"{board.get('decision', 'n/a')} "
            f"(score={float(board.get('consensus_score', 0.0)):.3f}, "
            f"quorum={board.get('quorum', 'n/a')})\n"
        )

    tbl = Table(header_style="bold cyan")
    tbl.add_column("Agent", style="cyan")
    tbl.add_column("Score", justify="right")
    tbl.add_column("Time (ms)", justify="right")
    for agent_name, ad in result.get("agent_details", {}).items():
        ac = _RISK_COLOUR_RICH.get(_risk_colour_str(ad["score"]), "white")
        tbl.add_row(agent_name, f"[{ac}]{ad['score']:.3f}[/{ac}]",
                    f"{ad.get('elapsed_ms', 0):.1f}")
    console.print(tbl)

    for ev in result.get("evidence", [])[:10]:
        console.print(f"  [dim]-[/dim] {ev}")


# ---------------------------------------------------------------------------
# web-ui
# ---------------------------------------------------------------------------

@cli.command("web-ui")
@click.option("--port", default=8000, show_default=True, help="HTTP port.")
@click.option("--debug", is_flag=True, help="Enable Flask debug mode.")
def web_ui(port: int, debug: bool):
    """Launch the web dashboard in a browser."""
    _frontend = Path(__file__).parent.parent / "frontend"
    sys.path.insert(0, str(_frontend.parent))

    console.print(
        f"[bold blue]ConsistenCy[/bold blue]  "
        f"Dashboard -> [underline]http://localhost:{port}[/underline]"
    )

    try:
        from frontend.app import app
    except ImportError:
        sys.path.insert(0, str(_frontend))
        from app import app  # type: ignore[import]

    app.run(host="0.0.0.0", port=port, debug=debug)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _risk_colour_str(score: float) -> str:
    return score_to_risk_colour(score)


def _risk_level(score: float) -> str:
    return score_to_risk_label(score)


# ---------------------------------------------------------------------------
# Export commands
# ---------------------------------------------------------------------------

@cli.command("export-range")
@click.option("--repo-path", required=True, help="Path to Git repository")
@click.option("--weeks", type=int, default=12, help="Weeks to analyze (default: 12)")
@click.option("--format", type=click.Choice(["json", "csv", "sqlite", "parquet"]), default="json", help="Export format")
@click.option("--output", required=True, help="Output file path")
def export_range_cmd(repo_path: str, weeks: int, format: str, output: str):
    """Export analysis results from recent commits in specified format."""
    console.print(f"[cyan]Exporting {weeks}-week analysis in {format} format...[/]")
    
    try:
        pipeline = AnalysisPipeline(repo_path, enable_persistent_cache=True)
        result = pipeline.analyze_range(weeks=weeks, baseline_n=50, max_commits=100)
        
        success = False
        if format == "json":
            success = ResultExporter.export_json(result, output, pretty=True)
        elif format == "csv":
            commits = result.get("commits", [])
            success = ResultExporter.export_csv(commits, output)
        elif format == "sqlite":
            commits = result.get("commits", [])
            file_results = []
            for commit in commits:
                commit_files = commit.get("file_results", {})
                if isinstance(commit_files, dict):
                    iterable = commit_files.keys()
                else:
                    iterable = [
                        item.get("file", "")
                        for item in commit_files
                        if isinstance(item, dict)
                    ]
                for filepath in iterable:
                    if filepath:
                        file_results.append({
                            "filepath": filepath,
                            "commit_sha": commit["sha"],
                        })
            success = ResultExporter.export_sqlite(commits, file_results, output)
        elif format == "parquet":
            commits = result.get("commits", [])
            success = ResultExporter.export_parquet(commits, output)
        
        if success:
            console.print(f"[green]OK Exported to {output}[/]")
        else:
            console.print(f"[red]Failed to export to {output}[/]")
            sys.exit(1)
    except Exception as e:
        console.print(f"[red]Error: {e}[/]")
        sys.exit(1)


@cli.command("export-by-file")
@click.option("--repo-path", required=True, help="Path to Git repository")
@click.option("--weeks", type=int, default=12, help="Weeks to analyze")
@click.option("--output-dir", required=True, help="Output directory for per-file CSVs")
def export_by_file_cmd(repo_path: str, weeks: int, output_dir: str):
    """Export per-file trending data as separate CSV files."""
    console.print(f"[cyan]Exporting per-file trends from {weeks} weeks...[/]")
    
    try:
        pipeline = AnalysisPipeline(repo_path, enable_persistent_cache=True)
        result = pipeline.analyze_range(weeks=weeks, baseline_n=50, max_commits=100)
        commits = result.get("commits", [])
        
        # Build commit results - re-analyze to get full file-level data
        commit_results = []
        for commit in commits:
            sha = commit["sha"]
            full = pipeline.analyze_commit(commit_sha=sha, baseline_n=50)
            commit_results.append({
                "sha": sha,
                "date": commit["date"],
                "author": commit["author"],
                "message": commit["message"],
                "risk_score": commit["risk_score"],
                "risk_level": commit["risk_level"],
                "files_analyzed": commit["files_analyzed"],
                "file_results": full.get("file_results", {}),
            })
        
        export_status = ResultExporter.export_by_file(commit_results, output_dir)
        success_count = sum(1 for v in export_status.values() if v)
        console.print(f"[green]OK Exported {success_count}/{len(export_status)} files[/]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/]")
        sys.exit(1)


@cli.command("export-by-author")
@click.option("--repo-path", required=True, help="Path to Git repository")
@click.option("--weeks", type=int, default=12, help="Weeks to analyze")
@click.option("--output-dir", required=True, help="Output directory for per-author CSVs")
def export_by_author_cmd(repo_path: str, weeks: int, output_dir: str):
    """Export per-author trending data as separate CSV files."""
    console.print(f"[cyan]Exporting per-author trends from {weeks} weeks...[/]")
    
    try:
        pipeline = AnalysisPipeline(repo_path, enable_persistent_cache=True)
        result = pipeline.analyze_range(weeks=weeks, baseline_n=50, max_commits=100)
        commits = result.get("commits", [])
        
        export_status = ResultExporter.export_by_author(commits, output_dir)
        success_count = sum(1 for v in export_status.values() if v)
        console.print(f"[green]OK Exported {success_count}/{len(export_status)} authors[/]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/]")
        sys.exit(1)


# ---------------------------------------------------------------------------
# Remote analysis commands
# ---------------------------------------------------------------------------

@cli.command("analyze-remote")
@click.argument("repo", required=True)
@click.option("--since", help="Start date (YYYY-MM-DD)")
@click.option("--until", help="End date (YYYY-MM-DD)")
@click.option("--max-commits", default=50, show_default=True, help="Max commits to analyze")
@click.option("--token", envvar="GITHUB_TOKEN", help="GitHub token (or set GITHUB_TOKEN env)")
@click.option("--json-output", is_flag=True, help="Emit JSON instead of Rich output")
def analyze_remote(repo: str, since: str | None, until: str | None, max_commits: int, token: str | None, json_output: bool):
    """Analyze a remote GitHub repository without cloning.
    
    REPO format: owner/repo (e.g., facebook/react)
    
    Examples:
        consistency analyze-remote facebook/react
        consistency analyze-remote facebook/react --since 2024-01-01 --max-commits 100
        consistency analyze-remote facebook/react --json-output > report.json
    """
    try:
        from src.remote import GitHubClient, RemoteAnalysisPipeline
    except ImportError as e:
        console.print(f"[red]Error:[/red] Remote analysis requires 'requests' library: {e}")
        raise SystemExit(1)
    
    # Parse owner/repo
    if "/" not in repo:
        console.print("[red]Error:[/red] REPO must be in format 'owner/repo'")
        raise SystemExit(1)
    
    owner, repo_name = repo.split("/", 1)
    
    # Parse dates
    since_dt = None
    until_dt = None
    if since:
        from datetime import datetime
        since_dt = datetime.fromisoformat(since)
    if until:
        from datetime import datetime
        until_dt = datetime.fromisoformat(until)
    
    console.print(Panel.fit(
        f"[bold blue]ConsistenCy[/bold blue]  "
        f"Remote analysis [cyan]{owner}/{repo_name}[/cyan]",
        border_style="blue",
    ))
    
    try:
        client = GitHubClient(token=token)
        pipeline = RemoteAnalysisPipeline(client)
        
        result = pipeline.analyze_repo(
            owner=owner,
            repo=repo_name,
            since=since_dt,
            until=until_dt,
            max_commits=max_commits,
        )
    except Exception as exc:
        if json_output:
            click.echo(json.dumps({"error": str(exc)}, indent=2))
        else:
            console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc
    
    if json_output:
        # Convert to JSON-serializable format
        output = {
            "metadata": {
                "owner": result.metadata.owner,
                "name": result.metadata.name,
                "full_name": result.metadata.full_name,
                "description": result.metadata.description,
                "language": result.metadata.language,
                "stars": result.metadata.stars,
                "forks": result.metadata.forks,
            },
            "analyzed_at": result.analyzed_at.isoformat(),
            "commits_analyzed": result.commits_analyzed,
            "overall_risk": result.overall_risk,
            "risk_level": result.risk_level,
            "language_breakdown": result.language_breakdown,
            "top_risky_files": [
                {
                    "path": f.path,
                    "language": f.language,
                    "risk_score": f.risk_score,
                    "risk_level": f.risk_level,
                    "baseline_strategy": f.baseline_strategy,
                    "current_ref": f.current_ref,
                    "baseline_ref": f.baseline_ref,
                }
                for f in result.top_risky_files
            ],
        }
        click.echo(json.dumps(output, indent=2, default=str))
        return
    
    # Rich output
    console.print(f"\n[bold]Repository:[/] {result.metadata.full_name}")
    if result.metadata.description:
        console.print(f"[dim]{result.metadata.description}[/]")
    console.print(f"[bold]Stars:[/] {result.metadata.stars:,}  [bold]Forks:[/] {result.metadata.forks:,}")
    console.print(f"[bold]Language:[/] {result.metadata.language or 'Unknown'}")
    
    console.print(f"\n[bold]Analysis Results:[/]")
    console.print(f"  Commits analyzed: {result.commits_analyzed}")
    
    risk_color = _RISK_COLOUR_RICH.get(result.risk_level.replace(" ", "").upper(), "white")
    console.print(f"  Overall risk: [{risk_color}]{result.overall_risk:.3f}[/{risk_color}] ({result.risk_level})")
    
    if result.language_breakdown:
        console.print(f"\n[bold]Language Breakdown:[/]")
        for lang, count in sorted(result.language_breakdown.items(), key=lambda x: -x[1]):
            console.print(f"  {lang}: {count} files")
    
    if result.top_risky_files:
        tbl = Table(title="Top Risky Files", header_style="bold cyan")
        tbl.add_column("File", style="cyan")
        tbl.add_column("Language")
        tbl.add_column("Risk", justify="right")
        tbl.add_column("Level")
        
        for f in result.top_risky_files[:10]:
            colour = _RISK_COLOUR_RICH.get(f.risk_level.replace(" ", "").upper(), "white")
            tbl.add_row(
                f.path,
                f.language,
                f"{f.risk_score:.3f}",
                f"[{colour}]{f.risk_level}[/{colour}]",
            )
        console.print(tbl)


@cli.command("trend")
@click.argument("repo", required=True)
@click.option("--period", type=click.Choice(["weekly", "monthly", "quarterly"]), default="monthly")
@click.option("--months", default=12, show_default=True, help="Number of months to analyze")
@click.option("--token", envvar="GITHUB_TOKEN", help="GitHub token")
@click.option("--json-output", is_flag=True, help="Emit JSON")
def trend(repo: str, period: str, months: int, token: str | None, json_output: bool):
    """Analyze historical trends of a GitHub repository.
    
    REPO format: owner/repo
    
    Examples:
        consistency trend facebook/react --period monthly --months 6
        consistency trend facebook/react --json-output > trends.json
    """
    try:
        from src.remote import GitHubClient, RemoteAnalysisPipeline
    except ImportError as e:
        console.print(f"[red]Error:[/red] Remote analysis requires 'requests' library: {e}")
        raise SystemExit(1)
    
    if "/" not in repo:
        console.print("[red]Error:[/red] REPO must be in format 'owner/repo'")
        raise SystemExit(1)
    
    owner, repo_name = repo.split("/", 1)
    
    console.print(Panel.fit(
        f"[bold blue]ConsistenCy[/bold blue]  "
        f"Trend analysis [cyan]{owner}/{repo_name}[/cyan] ({period})",
        border_style="blue",
    ))
    
    try:
        client = GitHubClient(token=token)
        pipeline = RemoteAnalysisPipeline(client)
        
        report = pipeline.analyze_trends(owner, repo_name, period=period, months=months)
    except Exception as exc:
        if json_output:
            click.echo(json.dumps({"error": str(exc)}, indent=2))
        else:
            console.print(f"[red]Error:[/red] {exc}")
        raise SystemExit(1) from exc
    
    if json_output:
        output = {
            "repo": report.repo_full_name,
            "period": report.period,
            "start_date": report.start_date.isoformat(),
            "end_date": report.end_date.isoformat(),
            "data_points": report.data_points,
            "insights": report.insights,
        }
        click.echo(json.dumps(output, indent=2, default=str))
        return
    
    console.print(f"\n[bold]Repository:[/] {report.repo_full_name}")
    console.print(f"[bold]Period:[/] {report.period}")
    console.print(f"[bold]Range:[/] {report.start_date.date()} to {report.end_date.date()}")
    
    if report.data_points:
        tbl = Table(title=f"Risk Trends ({period})", header_style="bold cyan")
        tbl.add_column("Period")
        tbl.add_column("Commits", justify="right")
        tbl.add_column("Avg Risk", justify="right")
        tbl.add_column("Level")
        
        for point in report.data_points:
            level = point.get("risk_level", "Unknown")
            colour = _RISK_COLOUR_RICH.get(level.replace(" ", "").upper(), "white")
            tbl.add_row(
                point["period"],
                str(point["commits"]),
                f"{point['avg_risk']:.3f}",
                f"[{colour}]{level}[/{colour}]",
            )
        console.print(tbl)
    
    if report.insights:
        console.print(f"\n[bold]Insights:[/]")
        for insight in report.insights:
            console.print(f"  - {insight}")


# ---------------------------------------------------------------------------
# Entry-point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    cli()
