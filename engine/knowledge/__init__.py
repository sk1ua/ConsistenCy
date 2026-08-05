# -*- coding: utf-8 -*-
"""Incremental code knowledge graph and context augmentation."""
from __future__ import annotations

from .context import ContextQuery, get_relevant_context
from .indexer import (
    IndexStats,
    KnowledgeIndex,
    content_sha,
    index_paths,
    language_for,
    module_name_for,
)

__all__ = [
    "ContextQuery",
    "IndexStats",
    "KnowledgeIndex",
    "content_sha",
    "get_relevant_context",
    "index_paths",
    "language_for",
    "module_name_for",
]
