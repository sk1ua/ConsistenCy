"""Multi-agent collaboration primitives for ConsistenCy."""

from .coordinator import (
    AgentVote,
    ConsensusFinding,
    ReviewConsensus,
    aggregate_file_consensus,
    build_file_consensus,
    build_pr_consensus,
)

__all__ = [
    "AgentVote",
    "ConsensusFinding",
    "ReviewConsensus",
    "aggregate_file_consensus",
    "build_file_consensus",
    "build_pr_consensus",
]
