# -*- coding: utf-8 -*-
"""
Result Exporter
===============
Exports analysis results in multiple formats for long-term trending and analysis.

Supported formats:
- JSON: Human-readable, easily shareable
- CSV: Spreadsheet-compatible, good for Excel/Google Sheets
- SQLite: Queryable, supports aggregation and trending
- Parquet: Columnar, efficient for big data tools
"""
from __future__ import annotations

import csv
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal, Optional


class ResultExporter:
    """Export analysis results in various formats."""

    @staticmethod
    def export_json(
        result: dict[str, Any],
        output_path: str | Path,
        pretty: bool = True,
    ) -> bool:
        """Export result to JSON file.
        
        Parameters
        ----------
        result : dict
            Analysis result dictionary
        output_path : str | Path
            Path to output JSON file
        pretty : bool
            Pretty-print with indentation
        
        Returns
        -------
        bool
            True if successful
        """
        try:
            with open(output_path, 'w') as f:
                if pretty:
                    json.dump(result, f, indent=2, default=str)
                else:
                    json.dump(result, f, default=str)
            return True
        except Exception:
            return False

    @staticmethod
    def export_csv(
        results: list[dict[str, Any]],
        output_path: str | Path,
        fieldnames: Optional[list[str]] = None,
    ) -> bool:
        """Export results to CSV file.
        
        Parameters
        ----------
        results : list[dict]
            List of result dictionaries
        output_path : str | Path
            Path to output CSV file
        fieldnames : list[str], optional
            CSV column names. If None, inferred from first result.
        
        Returns
        -------
        bool
            True if successful
        """
        if not results:
            return False
        
        try:
            if fieldnames is None:
                fieldnames = list(results[0].keys())
            
            with open(output_path, 'w', newline='') as f:
                writer = csv.DictWriter(f, fieldnames=fieldnames)
                writer.writeheader()
                writer.writerows(results)
            return True
        except Exception:
            return False

    @staticmethod
    def export_sqlite(
        commit_results: list[dict[str, Any]],
        file_results: list[dict[str, Any]],
        output_path: str | Path,
    ) -> bool:
        """Export results to SQLite database for querying and trending.
        
        Parameters
        ----------
        commit_results : list[dict]
            Per-commit analysis results
        file_results : list[dict]
            Per-file analysis results
        output_path : str | Path
            Path to output database file
        
        Returns
        -------
        bool
            True if successful
        """
        try:
            conn = sqlite3.connect(str(output_path))
            cursor = conn.cursor()
            
            # Create tables
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS commits (
                    id INTEGER PRIMARY KEY,
                    commit_sha TEXT UNIQUE,
                    author TEXT,
                    date TEXT,
                    message TEXT,
                    risk_score REAL,
                    risk_level TEXT,
                    files_analyzed INTEGER,
                    recorded_at TEXT
                )
            """)
            
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS files (
                    id INTEGER PRIMARY KEY,
                    filepath TEXT,
                    commit_sha TEXT,
                    risk_score REAL,
                    risk_level TEXT,
                    recorded_at TEXT,
                    FOREIGN KEY(commit_sha) REFERENCES commits(commit_sha)
                )
            """)
            
            # Insert commit data
            now = datetime.now(timezone.utc).isoformat()
            for result in commit_results:
                cursor.execute("""
                    INSERT OR IGNORE INTO commits
                    (commit_sha, author, date, message, risk_score, risk_level, files_analyzed, recorded_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    result.get("sha", "unknown"),
                    result.get("author", "unknown"),
                    result.get("date", now),
                    result.get("message", ""),
                    float(result.get("risk_score", 0.0)),
                    result.get("risk_level", ""),
                    int(result.get("files_analyzed", 0)),
                    now,
                ))
            
            # Insert file data
            for result in file_results:
                cursor.execute("""
                    INSERT INTO files
                    (filepath, commit_sha, risk_score, risk_level, recorded_at)
                    VALUES (?, ?, ?, ?, ?)
                """, (
                    result.get("filepath", "unknown"),
                    result.get("commit_sha", "unknown"),
                    float(result.get("risk_score", 0.0)),
                    result.get("risk_level", ""),
                    now,
                ))
            
            conn.commit()
            conn.close()
            return True
        except Exception:
            return False

    @staticmethod
    def export_parquet(
        results: list[dict[str, Any]],
        output_path: str | Path,
    ) -> bool:
        """Export results to Parquet format.
        
        Requires: pyarrow and pandas
        
        Parameters
        ----------
        results : list[dict]
            Results to export
        output_path : str | Path
            Path to output Parquet file
        
        Returns
        -------
        bool
            True if successful
        """
        try:
            import pandas as pd
            
            df = pd.DataFrame(results)
            df.to_parquet(output_path, index=False)
            return True
        except Exception:
            return False

    @staticmethod
    def export_by_file(
        commit_results: list[dict[str, Any]],
        output_dir: str | Path,
    ) -> dict[str, bool]:
        """Export results grouped by file for per-file trending.
        
        Parameters
        ----------
        commit_results : list[dict]
            Commit analysis results
        output_dir : str | Path
            Directory to store per-file files
        
        Returns
        -------
        dict
            Mapping of filepath to export success
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        results_by_file: dict[str, list[dict]] = {}
        
        # Group data by file
        for commit_result in commit_results:
            for filepath, file_result in commit_result.get("file_results", {}).items():
                if filepath not in results_by_file:
                    results_by_file[filepath] = []
                
                results_by_file[filepath].append({
                    "commit_sha": commit_result.get("sha", "unknown"),
                    "date": commit_result.get("date", ""),
                    "author": commit_result.get("author", "unknown"),
                    **file_result,
                })
        
        # Export each file
        export_status: dict[str, bool] = {}
        for filepath, results in results_by_file.items():
            safe_name = filepath.replace("/", "_").replace("\\", "_")
            csv_path = output_dir / f"{safe_name}.csv"
            export_status[filepath] = ResultExporter.export_csv(results, csv_path)
        
        return export_status

    @staticmethod
    def export_by_author(
        commit_results: list[dict[str, Any]],
        output_dir: str | Path,
    ) -> dict[str, bool]:
        """Export results grouped by author for per-author trending.
        
        Parameters
        ----------
        commit_results : list[dict]
            Commit analysis results
        output_dir : str | Path
            Directory to store per-author files
        
        Returns
        -------
        dict
            Mapping of author to export success
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        
        results_by_author: dict[str, list[dict]] = {}
        
        # Group data by author
        for result in commit_results:
            author = result.get("author", "unknown")
            if author not in results_by_author:
                results_by_author[author] = []
            
            results_by_author[author].append({
                "commit_sha": result.get("sha", "unknown"),
                "date": result.get("date", ""),
                "risk_score": result.get("risk_score", 0.0),
                "risk_level": result.get("risk_level", ""),
                "files_analyzed": result.get("files_analyzed", 0),
            })
        
        # Export each author
        export_status: dict[str, bool] = {}
        for author, results in results_by_author.items():
            safe_name = author.replace("/", "_").replace(" ", "_")
            csv_path = output_dir / f"{safe_name}.csv"
            export_status[author] = ResultExporter.export_csv(results, csv_path)
        
        return export_status

    @staticmethod
    def export_summary(
        pipeline_result: dict[str, Any],
        output_path: str | Path,
    ) -> bool:
        """Export a concise summary suitable for dashboards.
        
        Parameters
        ----------
        pipeline_result : dict
            Pipeline analysis result
        output_path : str | Path
            Path to output JSON file
        
        Returns
        -------
        bool
            True if successful
        """
        summary = {
            "export_time": datetime.now(timezone.utc).isoformat(),
            "repository": pipeline_result.get("repo_path", "unknown"),
            "analysis_type": pipeline_result.get("analysis_type", "unknown"),
            "key_metrics": {
                "commit_count": pipeline_result.get("commit_count", 0),
                "avg_risk": pipeline_result.get("avg_risk", 0.0),
                "max_risk": pipeline_result.get("max_risk", 0.0),
                "high_risk_commits": pipeline_result.get("high_risk_commits", 0),
            },
            "top_risky_files": pipeline_result.get("top_risky_files", [])[:10],
            "cache_stats": pipeline_result.get("cache", {}),
        }
        
        return ResultExporter.export_json(summary, output_path)
