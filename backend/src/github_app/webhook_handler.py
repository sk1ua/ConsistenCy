# -*- coding: utf-8 -*-
"""
GitHub Webhook Handler
======================
Receives and processes GitHub App webhook events.

Events handled:
- push: Trigger analysis on new commits
- pull_request: Analyze PR and post comments
- installation: Track app installations
- installation_repositories: Handle repo access changes

Security:
- Webhook signature verification (HMAC-SHA256)
- Event type validation
- Replay attack prevention (optional)
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from dataclasses import dataclass
from typing import Any, Callable

# Optional Flask integration
try:
    from flask import Blueprint, request, jsonify, current_app
    HAS_FLASK = True
except ImportError:
    HAS_FLASK = False
    Blueprint = object  # type: ignore


@dataclass
class WebhookEvent:
    """Normalized GitHub webhook event."""
    event_type: str
    delivery_id: str
    payload: dict[str, Any]
    signature_valid: bool = False


class GitHubWebhookHandler:
    """Handle GitHub App webhook events.
    
    Example:
        handler = GitHubWebhookHandler(webhook_secret="secret")
        
        @handler.on("push")
        def handle_push(event):
            repo = event.payload["repository"]["full_name"]
            print(f"Push to {repo}")
    """
    
    def __init__(self, webhook_secret: str | None = None) -> None:
        """Initialize handler.
        
        Parameters
        ----------
        webhook_secret : str | None
            GitHub App webhook secret for signature verification.
            If None, signatures are not verified (not recommended for production).
        """
        self.webhook_secret = webhook_secret
        self._handlers: dict[str, list[Callable[[WebhookEvent], None]]] = {}
    
    def on(self, event_type: str) -> Callable:
        """Decorator to register event handler.
        
        Parameters
        ----------
        event_type : str
            GitHub event type (push, pull_request, etc.)
            
        Returns
        -------
        Callable
            Decorator function
        """
        def decorator(func: Callable[[WebhookEvent], None]) -> Callable:
            if event_type not in self._handlers:
                self._handlers[event_type] = []
            self._handlers[event_type].append(func)
            return func
        return decorator
    
    def process_event(self, headers: dict[str, str], body: bytes | str) -> WebhookEvent:
        """Process incoming webhook event.
        
        Parameters
        ----------
        headers : dict[str, str]
            HTTP headers including X-GitHub-Event, X-GitHub-Delivery, X-Hub-Signature-256
        body : bytes | str
            Raw request body
            
        Returns
        -------
        WebhookEvent
            Normalized event object
        """
        # Extract headers
        event_type = headers.get("X-GitHub-Event", "unknown")
        delivery_id = headers.get("X-GitHub-Delivery", "unknown")
        signature = headers.get("X-Hub-Signature-256", "")
        
        # Parse payload
        if isinstance(body, bytes):
            body_str = body.decode("utf-8")
        else:
            body_str = body
            body = body.encode("utf-8")
        
        payload = json.loads(body_str) if body_str else {}
        
        # Verify signature BEFORE any processing
        signature_valid = False
        if self.webhook_secret:
            signature_valid = verify_webhook_signature(body, signature, self.webhook_secret)
            if not signature_valid:
                # Return early without dispatching if signature invalid
                return WebhookEvent(
                    event_type=event_type,
                    delivery_id=delivery_id,
                    payload=payload,
                    signature_valid=False,
                )
        
        event = WebhookEvent(
            event_type=event_type,
            delivery_id=delivery_id,
            payload=payload,
            signature_valid=signature_valid,
        )
        
        # Dispatch to handlers only after signature verified
        self._dispatch(event)
        
        return event
    
    def _dispatch(self, event: WebhookEvent) -> None:
        """Dispatch event to registered handlers."""
        handlers = self._handlers.get(event.event_type, [])
        for handler in handlers:
            try:
                handler(event)
            except Exception as e:
                # Log error but continue processing other handlers
                print(f"Error in handler for {event.event_type}: {e}")


def verify_webhook_signature(body: bytes, signature: str, secret: str) -> bool:
    """Verify GitHub webhook signature.
    
    Parameters
    ----------
    body : bytes
        Raw request body
    signature : str
        X-Hub-Signature-256 header value (sha256=...)
    secret : str
        Webhook secret
        
    Returns
    -------
    bool
        True if signature is valid
    """
    if not signature.startswith("sha256="):
        return False
    
    expected_mac = hmac.new(
        secret.encode("utf-8"),
        body,
        hashlib.sha256
    ).hexdigest()
    
    return hmac.compare_digest(f"sha256={expected_mac}", signature)


# Flask Blueprint factory (if Flask is available)
if HAS_FLASK:
    def create_webhook_blueprint(handler: GitHubWebhookHandler) -> Blueprint:
        """Create Flask Blueprint for webhook endpoint.
        
        Parameters
        ----------
        handler : GitHubWebhookHandler
            Configured webhook handler
            
        Returns
        -------
        Blueprint
            Flask blueprint with /webhook endpoint
        """
        bp = Blueprint("github_webhook", __name__, url_prefix="/github")
        
        @bp.route("/webhook", methods=["POST"])
        def webhook():
            """Receive GitHub webhook events."""
            # Collect headers
            headers = {
                k: v for k, v in request.headers.items()
                if k.lower().startswith("x-github") or k.lower() == "x-hub-signature-256"
            }
            
            # Process event
            try:
                event = handler.process_event(headers, request.get_data())
                
                if handler.webhook_secret and not event.signature_valid:
                    return jsonify({"error": "Invalid signature"}), 401
                
                return jsonify({
                    "status": "ok",
                    "event": event.event_type,
                    "delivery": event.delivery_id,
                }), 200
                
            except json.JSONDecodeError as e:
                return jsonify({"error": f"Invalid JSON: {e}"}), 400
            except Exception as e:
                return jsonify({"error": str(e)}), 500
        
        @bp.route("/health", methods=["GET"])
        def health():
            """Health check endpoint."""
            return jsonify({"status": "healthy"}), 200
        
        return bp