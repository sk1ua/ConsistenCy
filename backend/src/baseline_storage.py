# -*- coding: utf-8 -*-
"""
Baseline Storage Engine
=======================
Provides persistent baseline caching using SQLite.

Enables:
- Baseline persistence across pipeline instances
- Cross-process cache sharing
- Long-term baseline history tracking
"""
from __future__ import annotations

import hashlib
import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional


class BaselineStorage:
    """SQLite-backed persistent baseline storage."""

    def __init__(self, db_path: str | Path = ".consistency_baseline.db"):
        """Initialize storage with SQLite database.
        
        Parameters
        ----------
        db_path : str | Path
            Path to SQLite database file. Created if doesn't exist.
        """
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self._init_db()

    def _init_db(self) -> None:
        """Initialize database schema."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            # Baselines table: stores aggregated baseline sources
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS baselines (
                    id INTEGER PRIMARY KEY,
                    filepath TEXT NOT NULL,
                    window_fingerprint TEXT NOT NULL,
                    scenario_type TEXT,
                    source_content TEXT,
                    source_hash TEXT UNIQUE,
                    created_at TEXT,
                    accessed_at TEXT,
                    hit_count INTEGER DEFAULT 0,
                    UNIQUE(filepath, window_fingerprint)
                )
            """)
            
            # Scenarios table: tracks file scenario decisions over time
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS scenarios (
                    id INTEGER PRIMARY KEY,
                    filepath TEXT NOT NULL,
                    commit_sha TEXT,
                    scenario_type TEXT NOT NULL,
                    confidence REAL,
                    reason TEXT,
                    recorded_at TEXT
                )
            """)
            
            # Stats table: aggregate storage statistics
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS storage_stats (
                    key TEXT PRIMARY KEY,
                    value TEXT,
                    updated_at TEXT
                )
            """)
            
            conn.commit()
            conn.close()

    def store_baseline(
        self,
        filepath: str,
        window_fingerprint: str,
        source_content: str,
        scenario_type: str = "REGULAR",
    ) -> bool:
        """Store a baseline source in persistent cache.
        
        Parameters
        ----------
        filepath : str
            File path
        window_fingerprint : str
            Hash of commit window (for cache key uniqueness)
        source_content : str
            The baseline source code
        scenario_type : str
            Scenario type (NEW_FILE, REGULAR, LARGE_REFACTOR)
        
        Returns
        -------
        bool
            True if stored successfully
        """
        with self._lock:
            try:
                source_hash = hashlib.sha256(
                    source_content.encode("utf-8")
                ).hexdigest()
                now = datetime.now(timezone.utc).isoformat()
                
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                cursor.execute("""
                    INSERT OR REPLACE INTO baselines
                    (filepath, window_fingerprint, scenario_type, source_content, source_hash, created_at, accessed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (filepath, window_fingerprint, scenario_type, source_content, source_hash, now, now))
                
                conn.commit()
                conn.close()
                return True
            except Exception as e:
                # Fail gracefully - storage is optional
                return False

    def get_baseline(
        self,
        filepath: str,
        window_fingerprint: str,
    ) -> Optional[str]:
        """Retrieve baseline from persistent cache.
        
        Parameters
        ----------
        filepath : str
            File path
        window_fingerprint : str
            Hash of commit window
        
        Returns
        -------
        str or None
            Baseline source if found, None otherwise
        """
        with self._lock:
            try:
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                cursor.execute("""
                    SELECT source_content FROM baselines
                    WHERE filepath = ? AND window_fingerprint = ?
                """, (filepath, window_fingerprint))
                
                row = cursor.fetchone()
                
                # Update access time
                if row:
                    now = datetime.now(timezone.utc).isoformat()
                    cursor.execute("""
                        UPDATE baselines
                        SET accessed_at = ?, hit_count = hit_count + 1
                        WHERE filepath = ? AND window_fingerprint = ?
                    """, (now, filepath, window_fingerprint))
                    conn.commit()
                
                conn.close()
                return row[0] if row else None
            except Exception:
                return None

    def store_scenario(
        self,
        filepath: str,
        scenario_type: str,
        confidence: float,
        reason: str,
        commit_sha: Optional[str] = None,
    ) -> bool:
        """Record file scenario decision for analysis/optimization.
        
        Parameters
        ----------
        filepath : str
            File path
        scenario_type : str
            Type of scenario (NEW_FILE, REGULAR, LARGE_REFACTOR)
        confidence : float
            Confidence score (0.0-1.0)
        reason : str
            Human-readable reason for classification
        commit_sha : str, optional
            Git commit SHA if applicable
        
        Returns
        -------
        bool
            True if recorded successfully
        """
        with self._lock:
            try:
                now = datetime.now(timezone.utc).isoformat()
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                cursor.execute("""
                    INSERT INTO scenarios
                    (filepath, commit_sha, scenario_type, confidence, reason, recorded_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (filepath, commit_sha, scenario_type, confidence, reason, now))
                
                conn.commit()
                conn.close()
                return True
            except Exception:
                return False

    def get_storage_stats(self) -> dict[str, Any]:
        """Get aggregate storage statistics.
        
        Returns
        -------
        dict
            Statistics including baseline count, scenarios, hit rates
        """
        with self._lock:
            try:
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                # Baseline stats
                cursor.execute("SELECT COUNT(*), SUM(hit_count) FROM baselines")
                baseline_count, total_hits = cursor.fetchone()
                
                cursor.execute("""
                    SELECT scenario_type, COUNT(*) FROM scenarios
                    GROUP BY scenario_type
                """)
                scenario_counts = dict(cursor.fetchall())
                
                # Database size
                db_size = self.db_path.stat().st_size if self.db_path.exists() else 0
                
                conn.close()
                
                return {
                    "baseline_entries": baseline_count or 0,
                    "total_baseline_hits": total_hits or 0,
                    "scenario_records": sum(scenario_counts.values()),
                    "scenario_breakdown": scenario_counts,
                    "db_size_bytes": db_size,
                }
            except Exception:
                return {}

    def cleanup_old_entries(self, days_threshold: int = 30) -> int:
        """Remove baselines not accessed in N days.
        
        Parameters
        ----------
        days_threshold : int
            Remove entries not accessed in this many days
        
        Returns
        -------
        int
            Number of entries removed
        """
        with self._lock:
            try:
                from datetime import timedelta
                threshold = (datetime.now(timezone.utc) - timedelta(days=days_threshold)).isoformat()
                
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                cursor.execute(
                    "DELETE FROM baselines WHERE accessed_at < ?",
                    (threshold,)
                )
                
                deleted = cursor.rowcount
                conn.commit()
                conn.close()
                return deleted
            except Exception:
                return 0

    def export_baselines_json(self, output_path: str | Path) -> bool:
        """Export all baselines to JSON for distribution/backup.
        
        Parameters
        ----------
        output_path : str | Path
            Path to output JSON file
        
        Returns
        -------
        bool
            True if export successful
        """
        with self._lock:
            try:
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                cursor.execute("""
                    SELECT filepath, window_fingerprint, scenario_type, source_content, hit_count
                    FROM baselines ORDER BY filepath
                """)
                
                data = {
                    "export_time": datetime.now(timezone.utc).isoformat(),
                    "baselines": [
                        {
                            "filepath": row[0],
                            "window_fingerprint": row[1],
                            "scenario_type": row[2],
                            "source": row[3],
                            "hit_count": row[4],
                        }
                        for row in cursor.fetchall()
                    ]
                }
                
                Path(output_path).write_text(json.dumps(data, indent=2))
                conn.close()
                return True
            except Exception:
                return False
