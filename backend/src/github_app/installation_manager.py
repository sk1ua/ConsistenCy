# -*- coding: utf-8 -*-
"""
Installation Manager
====================
Manage GitHub App installations and repository access.

Features:
- Track installations by organization/user
- Store installation tokens securely
- Repository access management
- Zero-config onboarding
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import threading
import time
from base64 import urlsafe_b64encode
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Token encryption using Fernet
try:
    from cryptography.fernet import Fernet
    from cryptography.hazmat.primitives import hashes
    from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False


class TokenEncryption:
    """Encrypt/decrypt installation tokens using Fernet.
    
    Uses environment variable GITHUB_APP_ENCRYPTION_KEY for key derivation.
    Production REQUIREMENT: cryptography must be installed and 
    GITHUB_APP_ENCRYPTION_KEY must be set.
    """
    
    def __init__(self) -> None:
        self._fernet: Fernet | None = None
        self._has_crypto = HAS_CRYPTO
        _is_production = os.environ.get("GITHUB_APP_ENV", "development") == "production"
        if not HAS_CRYPTO and _is_production:
            raise RuntimeError(
                "cryptography package is required in production! "
                "Install with: pip install cryptography"
            )
        if HAS_CRYPTO:
            self._init_fernet()
    
    def _init_fernet(self) -> None:
        """Initialize Fernet cipher from environment key."""
        # Get encryption key from environment
        key_material = os.environ.get("GITHUB_APP_ENCRYPTION_KEY", "")
        
        if not key_material:
            # In production, this is a critical error
            if os.environ.get("GITHUB_APP_ENV", "development") == "production":
                raise RuntimeError(
                    "GITHUB_APP_ENCRYPTION_KEY must be set in production!"
                )
            # Development fallback with strong warning
            import warnings
            warnings.warn(
                "GITHUB_APP_ENCRYPTION_KEY not set. Using INSECURE fallback. "
                "Install cryptography and set GITHUB_APP_ENCRYPTION_KEY for security.",
                RuntimeWarning,
                stacklevel=3,
            )
            # Derive from app ID as fallback (NOT secure)
            key_material = os.environ.get("GITHUB_APP_ID", "dev-only-key")
        
        # Use PBKDF2 to derive key
        kdf = PBKDF2HMAC(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"consistency-github-app-salt-v1",
            iterations=480000,
        )
        key = urlsafe_b64encode(kdf.derive(key_material.encode()))
        self._fernet = Fernet(key)
    
    def encrypt(self, token: str) -> str:
        """Encrypt a token.
        
        In production with crypto available: returns encrypted string.
        In development without crypto: returns obfuscated token (NOT secure).
        """
        if not self._has_crypto or self._fernet is None:
            # Obfuscation for dev without cryptography - NOT secure, but better than plaintext
            return self._obfuscate(token)
        return self._fernet.encrypt(token.encode()).decode()
    
    def decrypt(self, encrypted_token: str) -> str:
        """Decrypt a token."""
        if not self._has_crypto or self._fernet is None:
            # Deobfuscate for dev without cryptography
            return self._deobfuscate(encrypted_token)
        try:
            return self._fernet.decrypt(encrypted_token.encode()).decode()
        except Exception:
            # If decryption fails, might be unencrypted legacy token or obfuscated
            return self._deobfuscate(encrypted_token)
    
    @staticmethod
    def _obfuscate(token: str) -> str:
        """Simple obfuscation for dev environments without cryptography.
        
        WARNING: This is NOT encryption. It only prevents casual viewing.
        """
        if not token:
            return token
        # XOR with fixed pattern - easily reversible
        key = b"consistency-obfuscation-key"
        result = bytearray()
        for i, b in enumerate(token.encode()):
            result.append(b ^ key[i % len(key)])
        from base64 import b64encode
        return "obf:" + b64encode(result).decode()
    
    @staticmethod
    def _deobfuscate(obfuscated: str) -> str:
        """Reverse simple obfuscation."""
        if not obfuscated or not obfuscated.startswith("obf:"):
            # Not obfuscated, return as-is
            return obfuscated
        from base64 import b64decode
        data = b64decode(obfuscated[4:])
        key = b"consistency-obfuscation-key"
        result = bytearray()
        for i, b in enumerate(data):
            result.append(b ^ key[i % len(key)])
        return result.decode()


@dataclass
class Installation:
    """GitHub App installation record."""
    id: int
    account_login: str  # org or user name
    account_type: str   # "Organization" or "User"
    repositories: list[str]  # list of "owner/repo"
    created_at: str
    updated_at: str
    access_token: str | None = None
    token_expires_at: str | None = None
    suspended: bool = False


class InstallationManager:
    """Manage GitHub App installations.
    
    Uses SQLite for persistence with thread-safe access.
    """
    
    def __init__(self, db_path: str | Path = ".github_app.db") -> None:
        """Initialize installation manager.
        
        Parameters
        ----------
        db_path : str | Path
            Path to SQLite database
        """
        self.db_path = Path(db_path)
        self._lock = threading.RLock()
        self._crypto = TokenEncryption()
        self._init_db()
    
    def _init_db(self) -> None:
        """Initialize database schema."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            # Installations table
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS installations (
                    id INTEGER PRIMARY KEY,
                    account_login TEXT NOT NULL,
                    account_type TEXT NOT NULL,
                    repositories TEXT,  -- JSON array
                    created_at TEXT,
                    updated_at TEXT,
                    access_token TEXT,
                    token_expires_at TEXT,
                    suspended INTEGER DEFAULT 0
                )
            """)
            
            # Repository settings table (for per-repo config)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS repo_settings (
                    full_name TEXT PRIMARY KEY,
                    installation_id INTEGER,
                    enabled INTEGER DEFAULT 1,
                    config TEXT,  -- JSON object
                    FOREIGN KEY(installation_id) REFERENCES installations(id)
                )
            """)
            
            # Analysis runs table (for tracking)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS analysis_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    repo_full_name TEXT,
                    commit_sha TEXT,
                    event_type TEXT,
                    status TEXT,
                    result_summary TEXT,
                    created_at TEXT,
                    completed_at TEXT
                )
            """)
            
            conn.commit()
            conn.close()
    
    def create_or_update_installation(
        self,
        installation_id: int,
        account_login: str,
        account_type: str,
        repositories: list[str],
    ) -> Installation:
        """Create or update installation record.
        
        Parameters
        ----------
        installation_id : int
            GitHub installation ID
        account_login : str
            Organization or user login
        account_type : str
            "Organization" or "User"
        repositories : list[str]
            List of repository full names
            
        Returns
        -------
        Installation
            Updated installation record
        """
        now = datetime.now(timezone.utc).isoformat()
        
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            # Check if exists
            cursor.execute(
                "SELECT created_at FROM installations WHERE id = ?",
                (installation_id,)
            )
            row = cursor.fetchone()
            
            if row:
                # Update
                cursor.execute("""
                    UPDATE installations
                    SET account_login = ?, account_type = ?,
                        repositories = ?, updated_at = ?
                    WHERE id = ?
                """, (
                    account_login, account_type,
                    json.dumps(repositories), now, installation_id
                ))
            else:
                # Create
                cursor.execute("""
                    INSERT INTO installations
                    (id, account_login, account_type, repositories, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    installation_id, account_login, account_type,
                    json.dumps(repositories), now, now
                ))
            
            # Update repo settings for new repos
            existing_repos = self._get_repos_for_installation(cursor, installation_id)
            for repo in repositories:
                if repo not in existing_repos:
                    cursor.execute("""
                        INSERT OR REPLACE INTO repo_settings
                        (full_name, installation_id, enabled, config)
                        VALUES (?, ?, 1, '{}')
                    """, (repo, installation_id))
            
            conn.commit()
            conn.close()
        
        return self.get_installation(installation_id)
    
    def _get_repos_for_installation(
        self,
        cursor: sqlite3.Cursor,
        installation_id: int
    ) -> list[str]:
        """Get existing repos for installation."""
        cursor.execute(
            "SELECT full_name FROM repo_settings WHERE installation_id = ?",
            (installation_id,)
        )
        return [row[0] for row in cursor.fetchall()]
    
    def get_installation(self, installation_id: int) -> Installation | None:
        """Get installation by ID."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            cursor.execute(
                "SELECT * FROM installations WHERE id = ?",
                (installation_id,)
            )
            row = cursor.fetchone()
            conn.close()
            
            if not row:
                return None
            
            return self._row_to_installation(row)
    
    def get_installation_for_repo(self, repo_full_name: str) -> Installation | None:
        """Get installation that has access to a repository."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            cursor.execute("""
                SELECT i.* FROM installations i
                JOIN repo_settings r ON i.id = r.installation_id
                WHERE r.full_name = ?
            """, (repo_full_name,))
            row = cursor.fetchone()
            conn.close()
            
            if not row:
                return None
            
            return self._row_to_installation(row)
    
    def _row_to_installation(self, row: tuple) -> Installation:
        """Convert database row to Installation.
        
        Decrypts access token if it was encrypted.
        """
        # Decrypt token if present
        encrypted_token = row[6]
        access_token = self._crypto.decrypt(encrypted_token) if encrypted_token else None
        
        return Installation(
            id=row[0],
            account_login=row[1],
            account_type=row[2],
            repositories=json.loads(row[3]) if row[3] else [],
            created_at=row[4],
            updated_at=row[5],
            access_token=access_token,
            token_expires_at=row[7],
            suspended=bool(row[8]),
        )
    
    def delete_installation(self, installation_id: int) -> bool:
        """Delete installation (when app is uninstalled)."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            cursor.execute("DELETE FROM repo_settings WHERE installation_id = ?", (installation_id,))
            cursor.execute("DELETE FROM installations WHERE id = ?", (installation_id,))
            
            conn.commit()
            deleted = cursor.rowcount > 0
            conn.close()
            
            return deleted
    
    def list_installations(self) -> list[Installation]:
        """List all installations."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            cursor.execute("SELECT * FROM installations WHERE suspended = 0")
            rows = cursor.fetchall()
            conn.close()
            
            return [self._row_to_installation(row) for row in rows]
    
    def update_access_token(
        self,
        installation_id: int,
        token: str,
        expires_at: str,
    ) -> bool:
        """Update access token for installation.
        
        Token is encrypted before storage using Fernet encryption.
        """
        # Encrypt token before storage
        encrypted_token = self._crypto.encrypt(token)
        
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            cursor.execute("""
                UPDATE installations
                SET access_token = ?, token_expires_at = ?, updated_at = ?
                WHERE id = ?
            """, (encrypted_token, expires_at, datetime.now(timezone.utc).isoformat(), installation_id))
            
            conn.commit()
            updated = cursor.rowcount > 0
            conn.close()
            
            return updated
    
    def is_token_valid(self, installation_id: int) -> bool:
        """Check if access token is still valid."""
        inst = self.get_installation(installation_id)
        if not inst or not inst.token_expires_at:
            return False
        
        try:
            expires = datetime.fromisoformat(inst.token_expires_at.replace("Z", "+00:00"))
            # Consider token expired 5 minutes before actual expiry
            return expires.timestamp() > (time.time() + 300)
        except ValueError:
            return False
    
    def get_org_stats(self, account_login: str) -> dict[str, Any]:
        """Get aggregate stats for an organization."""
        with self._lock:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.cursor()
            
            # Get installation
            cursor.execute(
                "SELECT id FROM installations WHERE account_login = ?",
                (account_login,)
            )
            row = cursor.fetchone()
            if not row:
                conn.close()
                return {}
            
            inst_id = row[0]
            
            # Count repos
            cursor.execute(
                "SELECT COUNT(*) FROM repo_settings WHERE installation_id = ?",
                (inst_id,)
            )
            repo_count = cursor.fetchone()[0]
            
            # Count analysis runs
            cursor.execute("""
                SELECT COUNT(*), COUNT(DISTINCT repo_full_name)
                FROM analysis_runs
                WHERE repo_full_name LIKE ?
            """, (f"{account_login}/%",))
            runs_row = cursor.fetchone()
            
            conn.close()
            
            return {
                "account_login": account_login,
                "installation_id": inst_id,
                "repository_count": repo_count,
                "total_analysis_runs": runs_row[0] if runs_row else 0,
                "repos_analyzed": runs_row[1] if runs_row else 0,
            }
    
    def record_analysis_run(
        self,
        repo_full_name: str,
        commit_sha: str,
        event_type: str,
        result: Any,
    ) -> bool:
        """Record an analysis run for tracking.
        
        Parameters
        ----------
        repo_full_name : str
            Full repository name
        commit_sha : str
            Commit SHA that was analyzed
        event_type : str
            Type of event (pr, push, etc.)
        result : Any
            Scan result object
            
        Returns
        -------
        bool
            True if recorded successfully
        """
        with self._lock:
            try:
                conn = sqlite3.connect(str(self.db_path))
                cursor = conn.cursor()
                
                # Get installation ID for this repo
                cursor.execute("""
                    SELECT installation_id FROM repo_settings
                    WHERE full_name = ?
                """, (repo_full_name,))
                row = cursor.fetchone()
                
                # Prepare result summary
                summary = {
                    "risk_score": getattr(result, "risk_score", 0.0),
                    "risk_level": getattr(result, "risk_level", "unknown"),
                    "files_analyzed": getattr(result, "findings_count", 0),
                    "success": getattr(result, "success", False),
                }
                
                cursor.execute("""
                    INSERT INTO analysis_runs
                    (repo_full_name, commit_sha, event_type, status, result_summary, created_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    repo_full_name,
                    commit_sha,
                    event_type,
                    "completed" if result.success else "failed",
                    json.dumps(summary),
                    datetime.now(timezone.utc).isoformat(),
                ))
                
                conn.commit()
                conn.close()
                return True
                
            except Exception as e:
                import logging
                logging.error(f"Failed to record analysis run: {e}")
                return False