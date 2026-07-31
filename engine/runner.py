"""Core analysis orchestrator for ConsistenCy engine."""
from typing import Dict, Any, List

from engine.agents import (
    ParserAgent,
    StyleAgent,
    StructuralAgent,
    SemanticAgent,
    DuplicationAgent,
    SecurityAgent,
    RiskScoringAgent,
)
from engine.agents.base_agent import AgentResult
from engine.scoring import (
    normalize_signal_results,
    file_contributions,
    dominant_signals,
    build_confidence,
    build_explainability_block,
)
from engine.models import score_to_risk_label, score_to_risk_colour
from engine.protocol import (
    AnalyzeRequest,
    AnalyzeResponse,
    ComposeReviewRequest,
    ComposeReviewResponse,
    FileResult,
    FileInput,
)

try:
    from engine.retrieval import build_retrieval_section
    HAS_RETRIEVAL = True
except ImportError:
    HAS_RETRIEVAL = False

from engine.config import RISK_WEIGHTS, DEFAULT_TOKEN_BUDGET

def get_language(path: str) -> str:
    ext = path.split('.')[-1].lower() if '.' in path else ''
    if ext == 'py': return 'python'
    if ext in ('js', 'jsx', 'ts', 'tsx'): return 'javascript'
    if ext == 'go': return 'go'
    if ext == 'java': return 'java'
    if ext == 'cs': return 'csharp'
    return 'unknown'

def run_analysis(request: AnalyzeRequest) -> AnalyzeResponse:
    file_results: List[FileResult] = []

    try:
        # Configuration options
        requested_agents = request.options.get(
            "agents",
            ["style", "structural", "semantic", "duplication", "security"]
        )
        include_evidence_pack = request.options.get("include_evidence_pack", False)
        token_budget = request.options.get("token_budget", DEFAULT_TOKEN_BUDGET)

        for file_input in request.files:
            # 1a. Determine language from filepath or language field
            lang = file_input.language or get_language(file_input.path)

            # 1b. Instantiate agents (No global singletons)
            parser = ParserAgent()
            agents = {}
            if "style" in requested_agents:
                agents["style"] = StyleAgent()
            if "structural" in requested_agents:
                agents["structural"] = StructuralAgent()
            if "semantic" in requested_agents:
                agents["semantic"] = SemanticAgent()
            if "duplication" in requested_agents:
                agents["duplication"] = DuplicationAgent()
            if "security" in requested_agents:
                agents["security"] = SecurityAgent()

            risk_scorer = RiskScoringAgent(weights=RISK_WEIGHTS)

            # 1c. Parse source_now and source_base using ParserAgent
            if file_input.path:
                snapshot_now = parser.parse_file(file_input.content, filepath=file_input.path)
                snapshot_base = parser.parse_file(file_input.baseline, filepath=file_input.path) if file_input.baseline else {}
            else:
                snapshot_now = parser.parse(file_input.content)
                snapshot_base = parser.parse(file_input.baseline) if file_input.baseline else {}

            snapshot_now["language"] = lang
            if snapshot_base:
                snapshot_base["language"] = lang

            # 1d. Run each requested agent
            agent_results: Dict[str, AgentResult] = {}
            for agent_name, agent in agents.items():
                try:
                    res = agent.run(snapshot_now, snapshot_base)
                    agent_results[agent_name] = res
                except Exception as e:
                    agent_results[agent_name] = AgentResult(
                        agent_name=agent_name,
                        score=0.0,
                        evidence=[f"Error running {agent_name}: {str(e)}"]
                    )

            # 1e. Aggregate with RiskScoringAgent
            aggregated = risk_scorer.aggregate(agent_results)

            # 1f. Compute signal_results via normalize_signal_results
            details_map = {k: v.details for k, v in agent_results.items()}
            normalized_signals = normalize_signal_results(details_map)

            # 1g & 1h. Compute file_contributions, dominant_signals, build_confidence, build_explainability_block
            breakdown = {k: float(v.score) for k, v in agent_results.items()}
            contribs = file_contributions(breakdown, weights=RISK_WEIGHTS)
            dom_signals = dominant_signals(contribs)

            signal_evidence = {k: v.evidence for k, v in agent_results.items() if v.evidence}

            confidence = build_confidence() # Can be enhanced with history depth etc.
            explainability = build_explainability_block(breakdown, signal_evidence, confidence=confidence)

            signal_details = {
                k: {
                    "score": res.score,
                    "evidence": res.evidence,
                    "details": res.details
                } for k, res in agent_results.items()
            }

            # Attach explainability to signal details so it's accessible
            signal_details["explainability"] = explainability

            file_results.append(FileResult(
                path=file_input.path,
                risk_score=aggregated.score,
                risk_label=aggregated.details.get("risk_level", score_to_risk_label(aggregated.score)),
                risk_color=aggregated.details.get("risk_colour", score_to_risk_colour(aggregated.score)),
                signals=signal_details,
                findings=aggregated.evidence,
                confidence=confidence,
                breakdown=breakdown,
            ))

        # Optional evidence pack
        evidence_pack_data = None
        if include_evidence_pack and HAS_RETRIEVAL:
            file_deep_dive = []
            for fr in file_results:
                file_deep_dive.append({
                    "file": fr.path,
                    "risk_score": fr.risk_score,
                    "structural_signals": fr.signals.get("structural", {}).get("details", {}),
                    "semantic_signals": fr.signals.get("semantic", {}).get("details", {}),
                })
            evidence_pack_data = build_retrieval_section(file_deep_dive, context_budget_tokens=token_budget)

        return AnalyzeResponse(
            id=request.id,
            ok=True,
            files=file_results,
            consensus={},
            evidence_pack=evidence_pack_data,
        )
    except Exception as e:
        return AnalyzeResponse(
            id=request.id,
            ok=False,
            files=file_results,
            error=str(e),
        )


def compose_review(request: ComposeReviewRequest) -> ComposeReviewResponse:
    """Compose overall PR review scoring and recommendations from analyzed files."""
    try:
        files = request.files
        if not files:
            return ComposeReviewResponse(
                id=request.id,
                ok=True,
                overall_score=100,
                risk_level="low",
                summary="No files analyzed.",
                recommendations=[]
            )

        scores = [f.risk_score for f in files]
        max_risk = max(0.0, min(1.0, max(scores))) if scores else 0.0
        overall_score = round((1.0 - max_risk) * 100)

        if overall_score <= 39:
            risk_level = "critical"
        elif overall_score <= 59:
            risk_level = "high"
        elif overall_score <= 79:
            risk_level = "medium"
        else:
            risk_level = "low"

        findings = []
        for f in files:
            for finding in f.findings:
                findings.append(f"{f.path}: {finding}")

        recommendations = [f"Address findings in {len(files)} file(s)."] if findings else ["No major issues identified."]

        return ComposeReviewResponse(
            id=request.id,
            ok=True,
            overall_score=overall_score,
            risk_level=risk_level,
            summary=f"Analysis completed across {len(files)} file(s). Risk level: {risk_level}.",
            recommendations=recommendations
        )
    except Exception as e:
        return ComposeReviewResponse(
            id=request.id,
            ok=False,
            error=str(e)
        )


def analyze_sources(
    source_now: str,
    source_base: str,
    filepath: str | None = None,
    **kwargs: Any
) -> Dict[str, Any]:
    """Source-level analysis compatibility helper."""
    file_input = FileInput(
        path=filepath or "sample.py",
        content=source_now,
        baseline=source_base,
    )
    req = AnalyzeRequest(id="req_legacy", action="analyze", files=[file_input])
    resp = run_analysis(req)
    if not resp.ok or not resp.files:
        return {"risk_score": 0.0, "risk_level": "Consistent", "risk_colour": "GREEN", "error": resp.error}

    f = resp.files[0]
    agent_details = {}
    for sig_name, sig_val in f.signals.items():
        if sig_name == "explainability": continue
        class_name = sig_name.capitalize() + "Agent" if not sig_name.endswith("Agent") else sig_name
        agent_details[class_name] = sig_val
        agent_details[sig_name] = sig_val

    collab = f.agent_collaboration or {
        "decision": "approve" if f.risk_score < 0.3 else ("request_changes" if f.risk_score < 0.6 else "block_merge"),
        "consensus_score": f.risk_score,
        "confidence": f.confidence,
    }
    return {
        "risk_score": f.risk_score,
        "risk_level": f.risk_label,
        "risk_colour": f.risk_color,
        "breakdown": f.breakdown or {},
        "signals": f.signals,
        "confidence": f.confidence,
        "agent_details": agent_details,
        "evidence": f.findings,
        "agent_collaboration": collab,
    }
