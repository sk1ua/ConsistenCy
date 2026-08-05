# -*- coding: utf-8 -*-
"""Directed acyclic graph over workflow steps.

Kept free of any knowledge of what a step *does* so the same structure can be
reused for scheduling, visualisation, and validation.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass
from typing import Iterable, Mapping


class WorkflowGraphError(ValueError):
    """Raised when a set of steps does not form a usable DAG."""


@dataclass(frozen=True, slots=True)
class DagNode:
    """One schedulable step and the step ids it waits on."""

    step_id: str
    needs: tuple[str, ...] = ()


class Dag:
    """Immutable dependency graph with level-based scheduling.

    `levels()` groups steps into batches that may run concurrently: every step
    in a batch has all of its dependencies satisfied by earlier batches.
    """

    def __init__(self, nodes: Iterable[DagNode]) -> None:
        ordered = tuple(nodes)
        self._validate_unique(ordered)
        self._nodes: Mapping[str, DagNode] = {node.step_id: node for node in ordered}
        self._validate_references()
        self._levels = self._compute_levels()

    @staticmethod
    def _validate_unique(nodes: tuple[DagNode, ...]) -> None:
        seen: set[str] = set()
        duplicates: set[str] = set()
        for node in nodes:
            if node.step_id in seen:
                duplicates.add(node.step_id)
            seen.add(node.step_id)
        if duplicates:
            raise WorkflowGraphError(f"Duplicate step id(s): {', '.join(sorted(duplicates))}")

    def _validate_references(self) -> None:
        for node in self._nodes.values():
            for need in node.needs:
                if need == node.step_id:
                    raise WorkflowGraphError(f"Step '{node.step_id}' cannot depend on itself")
                if need not in self._nodes:
                    raise WorkflowGraphError(f"Step '{node.step_id}' depends on unknown step '{need}'")

    def _compute_levels(self) -> tuple[tuple[str, ...], ...]:
        indegree = {step_id: len(node.needs) for step_id, node in self._nodes.items()}
        dependents: dict[str, list[str]] = {step_id: [] for step_id in self._nodes}
        for node in self._nodes.values():
            for need in node.needs:
                dependents[need].append(node.step_id)

        ready = deque(sorted(step_id for step_id, degree in indegree.items() if degree == 0))
        levels: list[tuple[str, ...]] = []
        resolved = 0

        while ready:
            level = tuple(ready)
            levels.append(level)
            ready = deque()
            for step_id in level:
                resolved += 1
                for dependent in dependents[step_id]:
                    indegree[dependent] -= 1
                    if indegree[dependent] == 0:
                        ready.append(dependent)
            ready = deque(sorted(ready))

        if resolved != len(self._nodes):
            unresolved = sorted(step_id for step_id, degree in indegree.items() if degree > 0)
            raise WorkflowGraphError(f"Workflow graph contains a cycle involving: {', '.join(unresolved)}")

        return tuple(levels)

    @property
    def step_ids(self) -> tuple[str, ...]:
        return tuple(self._nodes)

    def node(self, step_id: str) -> DagNode:
        try:
            return self._nodes[step_id]
        except KeyError:
            raise WorkflowGraphError(f"Unknown step '{step_id}'") from None

    def levels(self) -> tuple[tuple[str, ...], ...]:
        """Batches of step ids that may execute concurrently, in order."""
        return self._levels

    def dependencies_of(self, step_id: str) -> tuple[str, ...]:
        return self.node(step_id).needs

    def transitive_dependents(self, step_id: str) -> tuple[str, ...]:
        """Every step that cannot run if `step_id` fails."""
        self.node(step_id)
        blocked: set[str] = set()
        queue = deque([step_id])
        while queue:
            current = queue.popleft()
            for candidate in self._nodes.values():
                if current in candidate.needs and candidate.step_id not in blocked:
                    blocked.add(candidate.step_id)
                    queue.append(candidate.step_id)
        return tuple(sorted(blocked))
