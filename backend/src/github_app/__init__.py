# -*- coding: utf-8 -*-
"""
GitHub App Mode
===============
Native GitHub App integration for ConsistenCy.

Provides:
- Webhook handling for push/pull_request events
- Zero-config repository onboarding
- Organization-level multi-repo dashboard

Usage:
    from src.github_app import GitHubAppHandler
    app = GitHubAppHandler(app_id, private_key)
"""
from __future__ import annotations

from .webhook_handler import GitHubWebhookHandler, verify_webhook_signature
from .installation_manager import InstallationManager
from .repository_scanner import RepositoryScanner

__all__ = [
    "GitHubWebhookHandler",
    "verify_webhook_signature", 
    "InstallationManager",
    "RepositoryScanner",
]