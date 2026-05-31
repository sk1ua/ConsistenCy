# -*- coding: utf-8 -*-
"""
GitHub App Server
=================
Standalone Flask server for GitHub App mode.

Environment variables:
    GITHUB_APP_ID: GitHub App ID
    GITHUB_WEBHOOK_SECRET: Webhook secret for signature verification
    GITHUB_PRIVATE_KEY: Path to private key file
    DATABASE_PATH: Path to SQLite database (default: .github_app.db)

Usage:
    python github_app_server.py --port 5000
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

# Add src to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from flask import Flask, jsonify, request
from dotenv import load_dotenv

from src.github_app import (
    GitHubWebhookHandler,
    InstallationManager,
    RepositoryScanner,
)

load_dotenv()


def create_app() -> Flask:
    """Create and configure Flask app."""
    app = Flask(__name__)
    
    # Configuration
    app.config["GITHUB_APP_ID"] = os.environ.get("GITHUB_APP_ID")
    app.config["WEBHOOK_SECRET"] = os.environ.get("GITHUB_WEBHOOK_SECRET")
    app.config["PRIVATE_KEY_PATH"] = os.environ.get("GITHUB_PRIVATE_KEY")
    app.config["DATABASE_PATH"] = os.environ.get("DATABASE_PATH", ".github_app.db")
    
    # Validate required secrets
    _webhook_secret = app.config["WEBHOOK_SECRET"]
    _is_production = os.environ.get("GITHUB_APP_ENV", "development") == "production"
    if _is_production and not _webhook_secret:
        raise RuntimeError(
            "GITHUB_WEBHOOK_SECRET must be set in production!"
        )

    # Initialize components
    webhook_handler = GitHubWebhookHandler(
        webhook_secret=_webhook_secret
    )
    
    installation_manager = InstallationManager(
        db_path=app.config["DATABASE_PATH"]
    )
    
    repo_scanner = RepositoryScanner()
    
    # Register webhook handlers
    @webhook_handler.on("installation")
    def handle_installation(event):
        """Handle app installation/uninstallation."""
        action = event.payload.get("action")
        installation = event.payload.get("installation", {})
        
        if action == "created":
            # New installation
            repos = event.payload.get("repositories", [])
            repo_names = [r["full_name"] for r in repos]
            
            installation_manager.create_or_update_installation(
                installation_id=installation["id"],
                account_login=installation["account"]["login"],
                account_type=installation["account"]["type"],
                repositories=repo_names,
            )
            print(f"Installed on {installation['account']['login']}: {repo_names}")
            
        elif action == "deleted":
            # Uninstalled
            installation_manager.delete_installation(installation["id"])
            print(f"Uninstalled from {installation['account']['login']}")
    
    @webhook_handler.on("pull_request")
    def handle_pull_request(event):
        """Handle PR events (opened, synchronize) - trigger actual scan."""
        action = event.payload.get("action")
        if action not in ("opened", "synchronize", "reopened"):
            return
        
        pr = event.payload.get("pull_request", {})
        repo = event.payload.get("repository", {})
        installation = event.payload.get("installation", {})
        
        repo_full_name = repo.get("full_name")
        base_sha = pr.get("base", {}).get("sha")
        head_sha = pr.get("head", {}).get("sha")
        pr_number = pr.get("number")
        
        print(f"Processing PR #{pr_number}: {repo_full_name} {base_sha[:8]}..{head_sha[:8]}")
        
        # Get installation token
        inst_id = installation.get("id")
        inst = installation_manager.get_installation(inst_id)
        
        if not inst or not inst.access_token:
            print(f"No valid token for installation {inst_id}")
            return
        
        # Run actual scan
        try:
            result = repo_scanner.scan_pr(
                repo_full_name=repo_full_name,
                base_sha=base_sha,
                head_sha=head_sha,
                pr_number=pr_number,
                installation_id=inst_id,
                access_token=inst.access_token,
            )
            print(f"PR scan complete: risk={result.risk_score:.2f}")
            
            # Post PR comment with results
            repo_scanner.post_pr_comment(
                repo_full_name=repo_full_name,
                pr_number=pr_number,
                result=result,
                access_token=inst.access_token,
            )
        except Exception as e:
            print(f"PR scan failed: {e}")
            import logging
            logging.error(f"PR scan error: {e}", exc_info=True)
    
    @webhook_handler.on("push")
    def handle_push(event):
        """Handle push events - trigger actual scan."""
        ref = event.payload.get("ref", "")
        # Only analyze main/master branch pushes
        if not (ref.endswith("/main") or ref.endswith("/master")):
            return
        
        repo = event.payload.get("repository", {})
        commits = event.payload.get("commits", [])
        installation = event.payload.get("installation", {})
        
        if not commits:
            return
        
        repo_full_name = repo.get("full_name")
        head_commit = commits[-1]["id"]
        inst_id = installation.get("id")
        
        print(f"Processing push to {repo_full_name}: {head_commit}")
        
        # Get installation token
        inst = installation_manager.get_installation(inst_id)
        if not inst or not inst.access_token:
            print(f"No valid token for installation {inst_id}")
            return
        
        # Run actual scan
        try:
            result = repo_scanner.scan_commit(
                repo_full_name=repo_full_name,
                commit_sha=head_commit,
                installation_id=inst_id,
                access_token=inst.access_token,
            )
            print(f"Push scan complete: risk={result.risk_score:.2f}")
            
            # Store result for dashboard
            installation_manager.record_analysis_run(
                repo_full_name=repo_full_name,
                commit_sha=head_commit,
                event_type="push",
                result=result,
            )
        except Exception as e:
            print(f"Push scan failed: {e}")
            import logging
            logging.error(f"Push scan error: {e}", exc_info=True)
    
    # Flask routes
    @app.route("/health", methods=["GET"])
    def health():
        """Health check."""
        return jsonify({
            "status": "healthy",
            "mode": "github_app",
            "app_id": app.config["GITHUB_APP_ID"],
        })
    
    @app.route("/github/webhook", methods=["POST"])
    def webhook():
        """Receive GitHub webhooks.

        Signature verification happens BEFORE any event processing.
        Invalid signatures return 401 with zero side effects.
        """
        headers = dict(request.headers)
        body = request.get_data()

        try:
            # Signature verification happens inside process_event
            # If signature is invalid, event is returned without dispatching
            event = webhook_handler.process_event(headers, body)
            
            # Double-check signature result for explicit 401 response
            if app.config["WEBHOOK_SECRET"] and not event.signature_valid:
                return jsonify({"error": "Invalid signature", "code": "INVALID_SIGNATURE"}), 401
            
            return jsonify({
                "status": "processed",
                "event": event.event_type,
                "delivery": event.delivery_id,
            })
            
        except Exception as e:
            # Sanitized error - don't expose internal details
            import logging
            logging.error(f"Webhook processing error: {e}")
            return jsonify({"error": "Processing failed", "code": "INTERNAL_ERROR"}), 500
    
    @app.route("/api/installations", methods=["GET"])
    def list_installations():
        """List all installations."""
        installations = installation_manager.list_installations()
        return jsonify({
            "installations": [
                {
                    "id": i.id,
                    "account": i.account_login,
                    "type": i.account_type,
                    "repos": len(i.repositories),
                }
                for i in installations
            ]
        })
    
    @app.route("/api/org/<account_login>/dashboard", methods=["GET"])
    def org_dashboard(account_login: str):
        """Get organization dashboard data."""
        try:
            data = repo_scanner.get_org_dashboard_data(
                account_login,
                installation_manager,
            )
            return jsonify(data)
        except Exception as e:
            import logging
            logging.error(f"Org dashboard error for {account_login!r}: {e}")
            return jsonify({"error": "Dashboard data unavailable", "code": "ORG_DASHBOARD_FAILED"}), 500
    
    return app


if __name__ == "__main__":
    import argparse
    
    parser = argparse.ArgumentParser(description="GitHub App Server for ConsistenCy")
    parser.add_argument("--port", type=int, default=5000, help="Port to listen on")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")
    parser.add_argument("--debug", action="store_true", help="Enable debug mode")
    
    args = parser.parse_args()
    
    app = create_app()
    app.run(host=args.host, port=args.port, debug=args.debug)