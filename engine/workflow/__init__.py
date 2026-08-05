# -*- coding: utf-8 -*-
"""Declarative, verifiable DAG workflow engine.

Replaces the fixed analyzer loop in ``engine/runner.py`` with workflows that are
declared in YAML, validated against the same contract the TypeScript side uses,
and executed as a dependency graph with per-step timeouts and audit artifacts.
"""
from __future__ import annotations

from .artifacts import (
    EvidenceItem,
    StepExecutionArtifact,
    WorkflowEvidence,
    digest_files,
)
from .dag import Dag, DagNode, WorkflowGraphError
from .plugins import (
    AnalysisContext,
    BaseAnalyzerPlugin,
    MissingPluginError,
    PluginReport,
    SubprocessPlugin,
    register_plugin,
    registered_kinds,
    resolve_plugin,
)
from .runner import WorkflowRunner, WorkflowRunResult, run_workflow, run_workflow_sync
from .spec import (
    ANALYZER_KINDS,
    VERIFIER_KINDS,
    WorkflowSpec,
    WorkflowSpecError,
    WorkflowStep,
    load_builtin_workflow,
    load_workflow_file,
    load_workflow_spec,
)

__all__ = [
    "ANALYZER_KINDS",
    "VERIFIER_KINDS",
    "AnalysisContext",
    "BaseAnalyzerPlugin",
    "Dag",
    "DagNode",
    "EvidenceItem",
    "MissingPluginError",
    "PluginReport",
    "StepExecutionArtifact",
    "SubprocessPlugin",
    "WorkflowEvidence",
    "WorkflowGraphError",
    "WorkflowRunResult",
    "WorkflowRunner",
    "WorkflowSpec",
    "WorkflowSpecError",
    "WorkflowStep",
    "digest_files",
    "load_builtin_workflow",
    "load_workflow_file",
    "load_workflow_spec",
    "register_plugin",
    "registered_kinds",
    "resolve_plugin",
    "run_workflow",
    "run_workflow_sync",
]
