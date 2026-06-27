"""Evidence-based multi-agent review coordination.

The existing analysis agents already act as specialist reviewers. This module
turns their individual scores into a reviewer-facing collaboration artifact:
votes, consensus, disagreements, and a practical handoff plan.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass, field
from statistics import mean
from typing import Any


AGENT_PROFILES: dict[str, dict[str, Any]] = {
    "style": {
        "agent_name": "StyleAgent",
        "focus": "naming, documentation, and project convention drift",
        "priority": 0.80,
    },
    "structural": {
        "agent_name": "StructuralAgent",
        "focus": "module boundaries, dependency surface, and architectural shape",
        "priority": 1.10,
    },
    "semantic": {
        "agent_name": "SemanticAgent",
        "focus": "control flow, API usage, and behavior-level divergence",
        "priority": 1.15,
    },
    "duplication": {
        "agent_name": "DuplicationAgent",
        "focus": "copy-paste risk and repeated implementation patterns",
        "priority": 0.95,
    },
    "security": {
        "agent_name": "SecurityAgent",
        "focus": "secrets, unsafe calls, injection surfaces, and override evidence",
        "priority": 1.35,
    },
}

EXPECTED_REVIEW_SIGNALS = tuple(AGENT_PROFILES)

DECISION_SEVERITY = {
    "approve": 0,
    "approve_with_watchlist": 1,
    "review_required": 2,
    "request_changes": 3,
    "block_merge": 4,
}

SEVERITY_SORT_ORDER: dict[str, int] = {
    "low": 1,
    "medium": 2,
    "high": 3,
    "critical": 4,
}


@dataclass(slots=True)
class AgentVote:
    """One specialist agent's vote in the review board."""

    agent_name: str
    signal_name: str
    focus: str
    score: float
    confidence: float
    stance: str
    priority: float
    rationale: str
    evidence: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ConsensusFinding:
    """A reviewer-facing finding produced by the agent board."""

    signal_name: str
    agent_name: str
    severity: str
    title: str
    evidence: list[str] = field(default_factory=list)
    recommendation: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(slots=True)
class ReviewConsensus:
    """Consensus summary emitted at file or PR level."""

    scope: str
    decision: str
    consensus_score: float
    confidence: float
    quorum: str
    participants: list[str]
    votes: list[AgentVote] = field(default_factory=list)
    top_findings: list[ConsensusFinding] = field(default_factory=list)
    disagreements: list[str] = field(default_factory=list)
    next_actions: list[str] = field(default_factory=list)
    review_queue: list[dict[str, Any]] = field(default_factory=list)
    protocol: str = (
        "parallel_agents -> evidence_normalization -> weighted_consensus "
        "-> reviewer_handoff"
    )

    def to_dict(self) -> dict[str, Any]:
        return {
            "scope": self.scope,
            "decision": self.decision,
            "consensus_score": self.consensus_score,
            "confidence": self.confidence,
            "quorum": self.quorum,
            "participants": self.participants,
            "votes": [vote.to_dict() for vote in self.votes],
            "top_findings": [finding.to_dict() for finding in self.top_findings],
            "disagreements": self.disagreements,
            "next_actions": self.next_actions,
            "review_queue": self.review_queue,
            "protocol": self.protocol,
        }


def _clamp(value: float) -> float:
    return max(0.0, min(1.0, value))


def _signal_from_agent(agent_name: str) -> str | None:
    lowered = agent_name.lower()
    for signal_name in AGENT_PROFILES:
        if lowered.startswith(signal_name):
            return signal_name
    return None


def _clean_evidence(items: list[Any]) -> list[str]:
    cleaned: list[str] = []
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        if "no security issues detected" in text.lower():
            continue
        if text not in cleaned:
            cleaned.append(text)
    return cleaned


def _stance_for(signal_name: str, score: float) -> str:
    if signal_name == "security" and score >= 0.60:
        return "block_merge"
    if signal_name == "security" and score >= 0.30:
        return "request_changes"
    if score >= 0.60:
        return "request_changes"
    if score >= 0.30:
        return "needs_attention"
    if score >= 0.12:
        return "monitor"
    return "approve"


def _vote_confidence(score: float, evidence: list[str], base_confidence: float) -> float:
    evidence_term = 0.95 if evidence else (0.55 if score > 0.05 else 0.75)
    score_term = _clamp(0.45 + score)
    return round(
        _clamp(0.45 * evidence_term + 0.35 * base_confidence + 0.20 * score_term),
        4,
    )


def _rationale(signal_name: str, score: float, stance: str, evidence: list[str]) -> str:
    if stance == "approve":
        return f"{signal_name} is close to the repository baseline."
    if evidence:
        return evidence[0]
    if stance == "monitor":
        return f"{signal_name} drift is present but below the review threshold."
    if stance == "needs_attention":
        return f"{signal_name} drift should be inspected by a reviewer."
    if stance == "request_changes":
        return f"{signal_name} drift is high enough to request changes or justification."
    return f"{signal_name} produced merge-blocking evidence."


def _recommendation(signal_name: str, stance: str) -> str:
    if signal_name == "security":
        return "Resolve security override evidence before considering lower-priority drift."
    if signal_name == "semantic":
        return "Trace changed behavior and API usage against the intended PR design."
    if signal_name == "structural":
        return "Review dependency growth, ownership boundaries, and architecture impact."
    if signal_name == "duplication":
        return "Check whether repeated logic should be extracted or explicitly justified."
    if signal_name == "style":
        return "Align naming, documentation, and conventions with the local baseline."
    if stance == "approve":
        return "No special action needed beyond normal code review."
    return "Ask the author for evidence that this drift is intentional."


def _finding_from_vote(vote: AgentVote) -> ConsensusFinding | None:
    if vote.stance == "approve":
        return None
    severity = {
        "block_merge": "critical",
        "request_changes": "high",
        "needs_attention": "medium",
        "monitor": "low",
    }.get(vote.stance, "medium")
    return ConsensusFinding(
        signal_name=vote.signal_name,
        agent_name=vote.agent_name,
        severity=severity,
        title=f"{vote.agent_name} voted {vote.stance}",
        evidence=vote.evidence[:3] or [vote.rationale],
        recommendation=_recommendation(vote.signal_name, vote.stance),
    )


def _decision_from_votes(votes: list[AgentVote], consensus_score: float) -> str:
    if any(v.stance == "block_merge" for v in votes):
        return "block_merge"
    if any(v.signal_name == "security" and v.stance == "request_changes" for v in votes):
        return "request_changes"
    request_count = sum(1 for v in votes if v.stance == "request_changes")
    attention_count = sum(
        1 for v in votes if v.stance in {"request_changes", "needs_attention"}
    )
    if request_count >= 2 or consensus_score >= 0.65:
        return "request_changes"
    if request_count == 1 or attention_count >= 2 or consensus_score >= 0.35:
        return "review_required"
    if any(v.stance == "monitor" for v in votes) or consensus_score >= 0.15:
        return "approve_with_watchlist"
    return "approve"


def _disagreements(votes: list[AgentVote]) -> list[str]:
    if len(votes) < 2:
        return []
    scores = [vote.score for vote in votes]
    notes: list[str] = []
    if max(scores) - min(scores) >= 0.55:
        high = [v.agent_name for v in votes if v.score >= 0.55]
        low = [v.agent_name for v in votes if v.score <= 0.10]
        if high and low:
            notes.append(
                "Specialist disagreement: "
                + ", ".join(high[:3])
                + " flagged high drift while "
                + ", ".join(low[:3])
                + " saw little evidence."
            )
    weak = [v.agent_name for v in votes if v.score >= 0.40 and v.confidence < 0.55]
    if weak:
        notes.append(
            "Evidence weakness: "
            + ", ".join(weak[:3])
            + " raised risk with limited supporting evidence."
        )
    return notes


def _next_actions(decision: str, votes: list[AgentVote]) -> list[str]:
    actions: list[str] = []
    if decision == "block_merge":
        actions.append("Block merge until critical security or safety evidence is resolved.")
    elif decision == "request_changes":
        actions.append("Request author changes or a written design justification before merge.")
    elif decision == "review_required":
        actions.append("Route the PR through focused human review on the highest-voted signals.")
    elif decision == "approve_with_watchlist":
        actions.append("Approve only after a quick watchlist pass on the monitored signals.")
    else:
        actions.append("Proceed with normal review; agents found no material drift.")

    for vote in sorted(votes, key=lambda v: (v.score * v.priority), reverse=True):
        if vote.stance == "approve":
            continue
        recommendation = _recommendation(vote.signal_name, vote.stance)
        if recommendation not in actions:
            actions.append(recommendation)
        if len(actions) >= 5:
            break
    return actions


def _review_queue(scope: str, votes: list[AgentVote]) -> list[dict[str, Any]]:
    queue: list[dict[str, Any]] = []
    for vote in sorted(votes, key=lambda v: (v.score * v.priority), reverse=True):
        if vote.stance == "approve":
            continue
        queue.append(
            {
                "owner": vote.agent_name,
                "scope": scope,
                "focus": vote.focus,
                "stance": vote.stance,
                "why": vote.rationale,
            }
        )
        if len(queue) >= 4:
            break
    return queue


def build_file_consensus(
    agent_details: dict[str, Any],
    breakdown: dict[str, Any],
    *,
    confidence: float = 0.75,
    filepath: str | None = None,
) -> dict[str, Any]:
    """Build a file-level multi-agent consensus artifact."""

    base_confidence = _clamp(float(confidence))
    votes: list[AgentVote] = []

    for agent_name, details in agent_details.items():
        signal_name = _signal_from_agent(agent_name)
        if signal_name is None:
            continue
        profile = AGENT_PROFILES[signal_name]
        score = _clamp(float(details.get("score", breakdown.get(signal_name, 0.0))))
        evidence = _clean_evidence(list(details.get("evidence", [])))
        stance = _stance_for(signal_name, score)
        vote_confidence = _vote_confidence(score, evidence, base_confidence)
        votes.append(
            AgentVote(
                agent_name=profile["agent_name"],
                signal_name=signal_name,
                focus=profile["focus"],
                score=round(score, 4),
                confidence=vote_confidence,
                stance=stance,
                priority=float(profile["priority"]),
                rationale=_rationale(signal_name, score, stance, evidence),
                evidence=evidence[:5],
            )
        )

    present_signals = {vote.signal_name for vote in votes}
    for signal_name in EXPECTED_REVIEW_SIGNALS:
        if signal_name in present_signals:
            continue
        profile = AGENT_PROFILES[signal_name]
        score = _clamp(float(breakdown.get(signal_name, 0.0)))
        stance = _stance_for(signal_name, score)
        votes.append(
            AgentVote(
                agent_name=profile["agent_name"],
                signal_name=signal_name,
                focus=profile["focus"],
                score=round(score, 4),
                confidence=round(0.50 + 0.30 * base_confidence, 4),
                stance=stance,
                priority=float(profile["priority"]),
                rationale=_rationale(signal_name, score, stance, []),
                evidence=[],
            )
        )

    weight_total = sum(vote.priority for vote in votes) or 1.0
    consensus_score = round(
        _clamp(sum(vote.score * vote.priority for vote in votes) / weight_total),
        4,
    )
    confidence_score = round(
        _clamp(mean([vote.confidence for vote in votes] or [base_confidence])),
        4,
    )
    decision = _decision_from_votes(votes, consensus_score)
    findings = [
        finding
        for finding in (_finding_from_vote(vote) for vote in votes)
        if finding is not None
    ]
    findings.sort(
        key=lambda item: (
            SEVERITY_SORT_ORDER.get(item.severity, 0),
            next((v.score for v in votes if v.agent_name == item.agent_name), 0.0),
        ),
        reverse=True,
    )

    scope = filepath or "file"
    consensus = ReviewConsensus(
        scope=scope,
        decision=decision,
        consensus_score=consensus_score,
        confidence=confidence_score,
        quorum=f"{len(votes)}/{len(EXPECTED_REVIEW_SIGNALS)}",
        participants=[vote.agent_name for vote in votes],
        votes=sorted(votes, key=lambda v: (v.score * v.priority), reverse=True),
        top_findings=findings[:6],
        disagreements=_disagreements(votes),
        next_actions=_next_actions(decision, votes),
        review_queue=_review_queue(scope, votes),
    )
    return consensus.to_dict()


def aggregate_file_consensus(
    collaborations: list[dict[str, Any]],
    *,
    filepath: str,
) -> dict[str, Any]:
    """Aggregate repeated file-level consensus objects across a PR."""

    valid = [item for item in collaborations if item]
    if not valid:
        return {}

    decision = max(
        (item.get("decision", "approve") for item in valid),
        key=lambda value: DECISION_SEVERITY.get(value, 0),
    )
    participants = sorted(
        {
            participant
            for item in valid
            for participant in item.get("participants", [])
        }
    )
    findings: list[ConsensusFinding] = []
    for item in valid:
        for finding in item.get("top_findings", []):
            findings.append(
                ConsensusFinding(
                    signal_name=str(finding.get("signal_name", "")),
                    agent_name=str(finding.get("agent_name", "")),
                    severity=str(finding.get("severity", "medium")),
                    title=str(finding.get("title", "")),
                    evidence=list(finding.get("evidence", [])),
                    recommendation=str(finding.get("recommendation", "")),
                )
            )

    consensus_score = round(mean(float(item.get("consensus_score", 0.0)) for item in valid), 4)
    confidence = round(mean(float(item.get("confidence", 0.0)) for item in valid), 4)
    return ReviewConsensus(
        scope=filepath,
        decision=decision,
        consensus_score=consensus_score,
        confidence=confidence,
        quorum=f"{len(participants)}/{len(EXPECTED_REVIEW_SIGNALS)}",
        participants=participants,
        votes=[],
        top_findings=findings[:6],
        disagreements=[
            note
            for item in valid
            for note in item.get("disagreements", [])
        ][:4],
        next_actions=[
            action
            for item in valid
            for action in item.get("next_actions", [])
        ][:5],
        review_queue=[
            queue_item
            for item in valid
            for queue_item in item.get("review_queue", [])
        ][:4],
    ).to_dict()


def build_pr_consensus(
    top_files: list[dict[str, Any]],
    *,
    commit_entries: list[dict[str, Any]] | None = None,
    security_findings: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Build a PR-level board summary from file consensus artifacts."""

    commit_entries = commit_entries or []
    security_findings = security_findings or []
    file_consensuses = [
        item.get("agent_collaboration", {})
        for item in top_files
        if item.get("agent_collaboration")
    ]

    participants = sorted(
        {
            participant
            for collab in file_consensuses
            for participant in collab.get("participants", [])
        }
    ) or [profile["agent_name"] for profile in AGENT_PROFILES.values()]

    if file_consensuses:
        consensus_score = round(
            mean(float(item.get("consensus_score", 0.0)) for item in file_consensuses),
            4,
        )
        confidence = round(
            mean(float(item.get("confidence", 0.0)) for item in file_consensuses),
            4,
        )
        file_decision = max(
            (item.get("decision", "approve") for item in file_consensuses),
            key=lambda value: DECISION_SEVERITY.get(value, 0),
        )
    else:
        avg_file_risk = mean([float(item.get("avg_risk", 0.0)) for item in top_files] or [0.0])
        consensus_score = round(_clamp(avg_file_risk), 4)
        confidence = 0.50 if top_files else 0.0
        file_decision = "review_required" if avg_file_risk >= 0.35 else "approve"

    if any("[CRITICAL]" in str(item.get("evidence", "")) for item in security_findings):
        decision = "block_merge"
    elif security_findings:
        decision = "request_changes"
    else:
        decision = max(
            file_decision,
            _decision_from_votes([], consensus_score),
            key=lambda value: DECISION_SEVERITY.get(value, 0),
        )

    findings: list[ConsensusFinding] = []
    for item in security_findings[:3]:
        findings.append(
            ConsensusFinding(
                signal_name="security",
                agent_name="SecurityAgent",
                severity="critical" if "[CRITICAL]" in str(item.get("evidence", "")) else "high",
                title="Security override surfaced in PR",
                evidence=[str(item.get("evidence", ""))],
                recommendation=_recommendation("security", "request_changes"),
            )
        )
    for file_row in top_files[:5]:
        collab = file_row.get("agent_collaboration", {})
        for finding in collab.get("top_findings", [])[:2]:
            evidence = list(finding.get("evidence", []))
            evidence_prefix = f"{file_row.get('file', '?')}: "
            findings.append(
                ConsensusFinding(
                    signal_name=str(finding.get("signal_name", "")),
                    agent_name=str(finding.get("agent_name", "")),
                    severity=str(finding.get("severity", "medium")),
                    title=str(finding.get("title", "")),
                    evidence=[evidence_prefix + ev for ev in evidence[:2]],
                    recommendation=str(finding.get("recommendation", "")),
                )
            )

    review_queue: list[dict[str, Any]] = []
    for file_row in top_files[:8]:
        dominant = file_row.get("dominant_signals", [])
        owner_signal = dominant[0] if dominant else "semantic"
        profile = AGENT_PROFILES.get(owner_signal, AGENT_PROFILES["semantic"])
        evidence_pack = file_row.get("evidence_pack", {})
        compression = evidence_pack.get("compression", {}) if isinstance(evidence_pack, dict) else {}
        selected_count = int(compression.get("selected_count", 0) or 0)
        compression_ratio = float(compression.get("compression_ratio", 0.0) or 0.0)
        why = (
            f"rank #{file_row.get('rank_in_pr', '?')} with avg risk "
            f"{float(file_row.get('avg_risk', 0.0)):.3f}"
        )
        if selected_count:
            why += (
                f"; grounded by {selected_count} selected evidence item(s) "
                f"after {compression_ratio:.0%} context compression"
            )
        review_queue.append(
            {
                "owner": profile["agent_name"],
                "scope": file_row.get("file", "?"),
                "focus": profile["focus"],
                "stance": file_row.get("agent_collaboration", {}).get("decision", "review_required"),
                "why": why,
            }
        )

    actions = [
        "Use the review queue to split human review by specialist signal.",
        "Require author justification for any high-confidence agent disagreement.",
    ]
    if decision in {"block_merge", "request_changes"}:
        actions.insert(0, "Resolve blocking or request-change findings before merge.")
    elif decision == "review_required":
        actions.insert(0, "Run focused review on the top-ranked files before approval.")

    consensus = ReviewConsensus(
        scope="pull_request",
        decision=decision,
        consensus_score=consensus_score,
        confidence=confidence,
        quorum=f"{len(participants)}/{len(EXPECTED_REVIEW_SIGNALS)}",
        participants=participants,
        votes=[],
        top_findings=findings[:8],
        disagreements=[
            note
            for collab in file_consensuses
            for note in collab.get("disagreements", [])
        ][:5],
        next_actions=actions,
        review_queue=review_queue,
    )
    data = consensus.to_dict()
    data["commit_count"] = len(commit_entries)
    data["collaboration_value"] = (
        "Specialist agents review in parallel, then a deterministic consensus "
        "layer routes evidence packs to the right human reviewer."
    )
    return data
