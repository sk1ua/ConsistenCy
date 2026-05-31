# -*- coding: utf-8 -*-
"""Tests for GitHub App webhook handler and installation manager.

Coverage goals:
- Webhook signature verification (valid / invalid / missing)
- Header case-insensitivity (the fix for ngrok compatibility)
- Webhook event parsing and dispatching
- Installation manager CRUD via SQLite
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import sqlite3
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from src.github_app.webhook_handler import (  # noqa: E402
    GitHubWebhookHandler,
    WebhookEvent,
    verify_webhook_signature,
)
from src.github_app.installation_manager import (  # noqa: E402
    InstallationManager,
)


# ---------------------------------------------------------------------------
# verify_webhook_signature
# ---------------------------------------------------------------------------

class TestVerifyWebhookSignature:
    SECRET = "test-secret-123"

    def _sign(self, body: bytes) -> str:
        digest = hmac.new(
            self.SECRET.encode(), body, hashlib.sha256
        ).hexdigest()
        return f"sha256={digest}"

    def test_valid_signature(self):
        body = b'{"action":"opened"}'
        sig = self._sign(body)
        assert verify_webhook_signature(body, sig, self.SECRET) is True

    def test_invalid_signature(self):
        body = b'{"action":"opened"}'
        assert verify_webhook_signature(body, "sha256=deadbeef", self.SECRET) is False

    def test_missing_sha256_prefix(self):
        body = b'{"action":"opened"}'
        assert verify_webhook_signature(body, "not-a-sig", self.SECRET) is False

    def test_different_body_produces_different_signature(self):
        sig1 = self._sign(b'{"a":1}')
        sig2 = self._sign(b'{"a":2}')
        assert sig1 != sig2


# ---------------------------------------------------------------------------
# GitHubWebhookHandler
# ---------------------------------------------------------------------------

class TestWebhookHandler:
    def test_without_secret_accepts_all(self):
        handler = GitHubWebhookHandler(webhook_secret=None)
        event = handler.process_event(
            headers={
                "X-GitHub-Event": "push",
                "X-GitHub-Delivery": "abc-123",
            },
            body=b'{"ref":"refs/heads/main"}',
        )
        assert event.event_type == "push"
        assert event.delivery_id == "abc-123"
        assert event.signature_valid is False  # no secret → not validated

    def test_with_secret_validates_signature(self):
        secret = "mysecret"
        handler = GitHubWebhookHandler(webhook_secret=secret)
        body = b'{"ref":"refs/heads/main"}'
        sig = "sha256=" + hmac.new(
            secret.encode(), body, hashlib.sha256
        ).hexdigest()
        event = handler.process_event(
            headers={
                "X-GitHub-Event": "push",
                "X-GitHub-Delivery": "xyz-789",
                "X-Hub-Signature-256": sig,
            },
            body=body,
        )
        assert event.event_type == "push"
        assert event.signature_valid is True

    def test_with_secret_rejects_bad_signature(self):
        handler = GitHubWebhookHandler(webhook_secret="mysecret")
        event = handler.process_event(
            headers={
                "X-GitHub-Event": "push",
                "X-GitHub-Delivery": "bad-001",
                "X-Hub-Signature-256": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
            },
            body=b'{"ref":"refs/heads/main"}',
        )
        assert event.signature_valid is False
        # The event is still returned so the caller can decide the
        # HTTP status code (401).
        assert event.event_type == "push"

    def test_unknown_event_type_default(self):
        handler = GitHubWebhookHandler()
        event = handler.process_event({}, b"{}")
        assert event.event_type == "unknown"
        assert event.delivery_id == "unknown"

    def test_str_body_is_converted(self):
        handler = GitHubWebhookHandler()
        event = handler.process_event(
            headers={"X-GitHub-Event": "issues"},
            body='{"action":"labeled"}',
        )
        assert event.event_type == "issues"


# ---------------------------------------------------------------------------
# Header case-insensitivity (ngrok compatibility fix)
# ---------------------------------------------------------------------------

class TestHeaderCaseInsensitivity:
    def test_lowercase_headers(self):
        handler = GitHubWebhookHandler()
        event = handler.process_event(
            headers={
                "x-github-event": "push",
                "x-github-delivery": "lower-123",
            },
            body=b"{}",
        )
        assert event.event_type == "push"
        assert event.delivery_id == "lower-123"

    def test_mixed_case_headers(self):
        handler = GitHubWebhookHandler()
        event = handler.process_event(
            headers={
                "X-Github-Event": "pull_request",
                "X-GITHUB-DELIVERY": "MIXED-456",
            },
            body=b"{}",
        )
        assert event.event_type == "pull_request"
        assert event.delivery_id == "MIXED-456"

    def test_standard_case_still_works(self):
        handler = GitHubWebhookHandler()
        event = handler.process_event(
            headers={
                "X-GitHub-Event": "installation",
                "X-GitHub-Delivery": "std-789",
            },
            body=b"{}",
        )
        assert event.event_type == "installation"


# ---------------------------------------------------------------------------
# Event dispatching
# ---------------------------------------------------------------------------

class TestEventDispatching:
    def test_handler_registered_for_event_is_called(self):
        handler = GitHubWebhookHandler()
        calls: list[WebhookEvent] = []

        @handler.on("push")
        def _on_push(event):
            calls.append(event)

        event = handler.process_event(
            headers={"X-GitHub-Event": "push"},
            body=b'{"ref":"refs/heads/main"}',
        )
        assert len(calls) == 1
        assert calls[0].event_type == "push"

    def test_handler_not_called_for_different_event(self):
        handler = GitHubWebhookHandler()
        calls: list[WebhookEvent] = []

        @handler.on("pull_request")
        def _on_pr(event):
            calls.append(event)

        handler.process_event(
            headers={"X-GitHub-Event": "push"},
            body=b"{}",
        )
        assert len(calls) == 0

    def test_multiple_handlers_same_event(self):
        handler = GitHubWebhookHandler()
        results: list[str] = []

        @handler.on("push")
        def _h1(event):
            results.append("h1")

        @handler.on("push")
        def _h2(event):
            results.append("h2")

        handler.process_event(
            headers={"X-GitHub-Event": "push"},
            body=b"{}",
        )
        assert results == ["h1", "h2"]


# ---------------------------------------------------------------------------
# InstallationManager
# ---------------------------------------------------------------------------

class TestInstallationManager:
    @pytest.fixture
    def mgr(self, tmp_path: Path):
        db = tmp_path / "test.db"
        return InstallationManager(db_path=str(db))

    def test_create_installation(self, mgr):
        mgr.create_or_update_installation(
            installation_id=42,
            account_login="test-org",
            account_type="Organization",
            repositories=["test-org/repo-a", "test-org/repo-b"],
        )
        inst = mgr.get_installation(42)
        assert inst is not None
        assert inst.account_login == "test-org"
        assert inst.account_type == "Organization"
        assert "test-org/repo-a" in inst.repositories

    def test_update_installation_adds_repos(self, mgr):
        mgr.create_or_update_installation(1, "u", "User", ["u/r1"])
        mgr.create_or_update_installation(1, "u", "User", ["u/r1", "u/r2"])
        inst = mgr.get_installation(1)
        assert len(inst.repositories) == 2

    def test_delete_installation(self, mgr):
        mgr.create_or_update_installation(99, "x", "User", ["x/r"])
        mgr.delete_installation(99)
        assert mgr.get_installation(99) is None

    def test_list_installations(self, mgr):
        mgr.create_or_update_installation(1, "a", "User", ["a/r"])
        mgr.create_or_update_installation(2, "b", "Org", ["b/r"])
        all_inst = mgr.list_installations()
        assert len(all_inst) == 2

    def test_get_nonexistent_returns_none(self, mgr):
        assert mgr.get_installation(99999) is None

    def test_record_analysis_run(self, mgr):
        mgr.create_or_update_installation(1, "a", "User", ["a/r"])
        mgr.record_analysis_run(
            repo_full_name="a/r",
            commit_sha="abc123",
            event_type="push",
            result={"risk_score": 0.42},
        )
        # No crash = success; analysis runs are stored for dashboard queries
