"""JSON-over-stdio protocol definitions."""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set


def normalise_protocol_strings(value: Any) -> Any:
    """Replace lone UTF-16 surrogate code points at the stdio boundary.

    GitHub snapshots can contain malformed or escaped Unicode. Python's UTF-8
    encoder cannot represent lone surrogates, so normalising them once at the
    untrusted JSON boundary keeps the deterministic engine total without
    allowing invalid text to poison stdout or parser inputs.

    The common case is a string that contains no surrogates at all, so the
    check first runs at C speed (`str.isascii`, then a strict UTF-8 encode)
    and only falls back to the per-character rewrite when encoding fails.
    """
    if isinstance(value, str):
        if value.isascii():
            return value
        try:
            value.encode("utf-8")
            return value
        except UnicodeEncodeError:
            return "".join("\ufffd" if 0xD800 <= ord(char) <= 0xDFFF else char for char in value)
    if isinstance(value, list):
        return [normalise_protocol_strings(item) for item in value]
    if isinstance(value, dict):
        return {
            normalise_protocol_strings(key): normalise_protocol_strings(item)
            for key, item in value.items()
        }
    return value


def _check_keys(data: Dict[str, Any], allowed_keys: Set[str], context: str) -> None:
    extra = set(data.keys()) - allowed_keys
    if extra:
        raise ValueError(f"Unexpected field(s) {sorted(list(extra))} in {context}")


@dataclass
class FileInput:
    path: str
    content: str
    baseline: Optional[str] = None
    language: Optional[str] = None
    diff_hunks: Optional[List[str]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FileInput":
        if not isinstance(data, dict):
            raise ValueError("FileInput data must be a dictionary")
        _check_keys(data, {"path", "content", "baseline", "language", "diff_hunks"}, "FileInput")

        path = data.get("path")
        content = data.get("content")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("FileInput requires a non-empty string 'path'")
        if not isinstance(content, str):
            raise ValueError("FileInput requires a string 'content'")

        baseline = data.get("baseline")
        if baseline is not None and not isinstance(baseline, str):
            raise ValueError("FileInput 'baseline' must be string or null")

        language = data.get("language")
        if language is not None and not isinstance(language, str):
            raise ValueError("FileInput 'language' must be string or null")

        diff_hunks = data.get("diff_hunks")
        if diff_hunks is not None:
            if not isinstance(diff_hunks, list) or not all(isinstance(h, str) for h in diff_hunks):
                raise ValueError("FileInput 'diff_hunks' must be list of strings or null")

        return cls(
            path=path,
            content=content,
            baseline=baseline,
            language=language,
            diff_hunks=diff_hunks,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "content": self.content,
            "baseline": self.baseline,
            "language": self.language,
            "diff_hunks": self.diff_hunks,
        }


@dataclass
class AnalyzeRequest:
    id: str = "req_default"
    action: str = "analyze"
    files: List[FileInput] = field(default_factory=list)
    options: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AnalyzeRequest":
        if not isinstance(data, dict):
            raise ValueError("AnalyzeRequest data must be a dictionary")
        _check_keys(data, {"id", "action", "files", "options"}, "AnalyzeRequest")

        if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
            raise ValueError("AnalyzeRequest requires a non-empty string 'id'")
        req_id = data["id"]

        if "action" not in data or data["action"] != "analyze":
            raise ValueError(f"AnalyzeRequest requires action='analyze', got '{data.get('action')}'")

        if "files" not in data or not isinstance(data["files"], list):
            raise ValueError("AnalyzeRequest requires a list for 'files'")
        files = [FileInput.from_dict(f) for f in data["files"]]

        options = data.get("options", {})
        if not isinstance(options, dict):
            raise ValueError("AnalyzeRequest 'options' must be a dictionary")

        return cls(
            id=req_id,
            action="analyze",
            files=files,
            options=options,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "files": [f.to_dict() for f in self.files],
            "options": self.options,
        }


@dataclass
class RunWorkflowRequest:
    """Runs a named workflow over the supplied files.

    Additive alongside `analyze`: the existing action keeps its response shape,
    so a caller opts into the DAG engine by choosing this action.

    `spec` is optional. When present it carries a complete WorkflowSpec v2 and
    takes precedence over `workflow`, which then only names the spec for logs.
    """

    id: str = "req_default"
    action: str = "run_workflow"
    workflow: str = ""
    spec: Optional[Dict[str, Any]] = None
    files: List[FileInput] = field(default_factory=list)
    workspace_path: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RunWorkflowRequest":
        if not isinstance(data, dict):
            raise ValueError("RunWorkflowRequest data must be a dictionary")
        _check_keys(
            data,
            {"id", "action", "workflow", "spec", "files", "workspace_path", "options"},
            "RunWorkflowRequest",
        )

        if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
            raise ValueError("RunWorkflowRequest requires a non-empty string 'id'")

        if data.get("action") != "run_workflow":
            raise ValueError(
                f"RunWorkflowRequest requires action='run_workflow', got '{data.get('action')}'"
            )

        workflow = data.get("workflow")
        if not isinstance(workflow, str) or not workflow.strip():
            raise ValueError("RunWorkflowRequest requires a non-empty string 'workflow'")

        spec = data.get("spec")
        if spec is not None and not isinstance(spec, dict):
            raise ValueError("RunWorkflowRequest 'spec' must be a dictionary or null")

        if "files" not in data or not isinstance(data["files"], list):
            raise ValueError("RunWorkflowRequest requires a list for 'files'")

        workspace_path = data.get("workspace_path")
        if workspace_path is not None and not isinstance(workspace_path, str):
            raise ValueError("RunWorkflowRequest 'workspace_path' must be string or null")

        options = data.get("options", {})
        if not isinstance(options, dict):
            raise ValueError("RunWorkflowRequest 'options' must be a dictionary")

        return cls(
            id=data["id"],
            action="run_workflow",
            workflow=workflow.strip(),
            spec=spec,
            files=[FileInput.from_dict(f) for f in data["files"]],
            workspace_path=workspace_path,
            options=options,
        )

    def to_dict(self) -> Dict[str, Any]:
        payload = {
            "id": self.id,
            "action": self.action,
            "workflow": self.workflow,
            "files": [f.to_dict() for f in self.files],
            "workspace_path": self.workspace_path,
            "options": self.options,
        }
        if self.spec is not None:
            payload["spec"] = self.spec
        return payload


@dataclass
class RunWorkflowResponse:
    id: str = "req_default"
    ok: bool = True
    run: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if not self.ok:
            return {
                "id": self.id,
                "ok": False,
                "error": self.error or "Unknown workflow error",
            }
        return {
            "id": self.id,
            "ok": True,
            "run": self.run or {},
        }


@dataclass
class RelevantContextRequest:
    """Indexes the supplied files and returns augmentation context per target."""

    id: str = "req_default"
    action: str = "relevant_context"
    files: List[FileInput] = field(default_factory=list)
    targets: List[str] = field(default_factory=list)
    index_path: Optional[str] = None
    options: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RelevantContextRequest":
        if not isinstance(data, dict):
            raise ValueError("RelevantContextRequest data must be a dictionary")
        _check_keys(
            data,
            {"id", "action", "files", "targets", "index_path", "options"},
            "RelevantContextRequest",
        )

        if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
            raise ValueError("RelevantContextRequest requires a non-empty string 'id'")

        if data.get("action") != "relevant_context":
            raise ValueError(
                f"RelevantContextRequest requires action='relevant_context', got '{data.get('action')}'"
            )

        if "files" not in data or not isinstance(data["files"], list):
            raise ValueError("RelevantContextRequest requires a list for 'files'")

        targets = data.get("targets", [])
        if not isinstance(targets, list) or any(not isinstance(t, str) or not t.strip() for t in targets):
            raise ValueError("RelevantContextRequest 'targets' must be a list of non-blank strings")

        index_path = data.get("index_path")
        if index_path is not None and not isinstance(index_path, str):
            raise ValueError("RelevantContextRequest 'index_path' must be string or null")

        options = data.get("options", {})
        if not isinstance(options, dict):
            raise ValueError("RelevantContextRequest 'options' must be a dictionary")

        return cls(
            id=data["id"],
            action="relevant_context",
            files=[FileInput.from_dict(f) for f in data["files"]],
            targets=list(targets),
            index_path=index_path,
            options=options,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "files": [f.to_dict() for f in self.files],
            "targets": self.targets,
            "index_path": self.index_path,
            "options": self.options,
        }


@dataclass
class RelevantContextResponse:
    id: str = "req_default"
    ok: bool = True
    contexts: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if not self.ok:
            return {
                "id": self.id,
                "ok": False,
                "error": self.error or "Unknown context error",
            }
        return {
            "id": self.id,
            "ok": True,
            "contexts": self.contexts or {},
        }


@dataclass
class RecordReviewRequest:
    """Folds a completed review's findings into persistent project memory."""

    id: str = "req_default"
    action: str = "record_review"
    index_path: str = ""
    job_id: str = ""
    reference: str = ""
    reported_at: str = ""
    covered_files: List[str] = field(default_factory=list)
    findings: List[Dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "RecordReviewRequest":
        if not isinstance(data, dict):
            raise ValueError("RecordReviewRequest data must be a dictionary")
        _check_keys(
            data,
            {"id", "action", "index_path", "job_id", "reference", "reported_at",
             "covered_files", "findings"},
            "RecordReviewRequest",
        )

        if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
            raise ValueError("RecordReviewRequest requires a non-empty string 'id'")
        if data.get("action") != "record_review":
            raise ValueError(
                f"RecordReviewRequest requires action='record_review', got '{data.get('action')}'"
            )

        for key in ("index_path", "job_id", "reference", "reported_at"):
            value = data.get(key)
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"RecordReviewRequest requires a non-empty string '{key}'")

        covered = data.get("covered_files", [])
        if not isinstance(covered, list) or any(not isinstance(p, str) or not p.strip() for p in covered):
            raise ValueError("RecordReviewRequest 'covered_files' must be non-blank strings")

        findings = data.get("findings", [])
        if not isinstance(findings, list) or any(not isinstance(f, dict) for f in findings):
            raise ValueError("RecordReviewRequest 'findings' must be a list of objects")

        return cls(
            id=data["id"],
            action="record_review",
            index_path=data["index_path"],
            job_id=data["job_id"],
            reference=data["reference"],
            reported_at=data["reported_at"],
            covered_files=list(covered),
            findings=list(findings),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "index_path": self.index_path,
            "job_id": self.job_id,
            "reference": self.reference,
            "reported_at": self.reported_at,
            "covered_files": self.covered_files,
            "findings": self.findings,
        }


@dataclass
class RecordReviewResponse:
    id: str = "req_default"
    ok: bool = True
    recorded: int = 0
    resolved: int = 0
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        if not self.ok:
            return {
                "id": self.id,
                "ok": False,
                "error": self.error or "Unknown record error",
            }
        return {
            "id": self.id,
            "ok": True,
            "recorded": self.recorded,
            "resolved": self.resolved,
        }


@dataclass
class ComposeReviewFile:
    path: str
    risk_score: float
    findings: List[str]

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ComposeReviewFile":
        if not isinstance(data, dict):
            raise ValueError("ComposeReviewFile data must be a dictionary")
        _check_keys(data, {"path", "risk_score", "findings"}, "ComposeReviewFile")

        path = data.get("path")
        if not isinstance(path, str) or not path.strip():
            raise ValueError("ComposeReviewFile requires a non-empty string 'path'")

        risk_score = data.get("risk_score")
        if type(risk_score) is bool or not isinstance(risk_score, (int, float)) or not (0.0 <= float(risk_score) <= 1.0):
            raise ValueError("ComposeReviewFile requires a numeric 'risk_score' between 0.0 and 1.0")

        findings = data.get("findings")
        if not isinstance(findings, list) or not all(isinstance(f, str) for f in findings):
            raise ValueError("ComposeReviewFile requires a list of strings for 'findings'")

        return cls(
            path=path,
            risk_score=float(risk_score),
            findings=findings
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "path": self.path,
            "risk_score": self.risk_score,
            "findings": self.findings
        }


@dataclass
class ComposeReviewRequest:
    id: str = "req_default"
    action: str = "compose_review"
    files: List[ComposeReviewFile] = field(default_factory=list)
    options: Dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ComposeReviewRequest":
        if not isinstance(data, dict):
            raise ValueError("ComposeReviewRequest data must be a dictionary")
        _check_keys(data, {"id", "action", "files", "options"}, "ComposeReviewRequest")

        if "id" not in data or not isinstance(data["id"], str) or not data["id"].strip():
            raise ValueError("ComposeReviewRequest requires a non-empty string 'id'")
        req_id = data["id"]

        if "action" not in data or data["action"] != "compose_review":
            raise ValueError(f"ComposeReviewRequest requires action='compose_review', got '{data.get('action')}'")

        if "files" not in data or not isinstance(data["files"], list):
            raise ValueError("ComposeReviewRequest requires a list for 'files'")
        files = [ComposeReviewFile.from_dict(f) for f in data["files"]]

        options = data.get("options", {})
        if not isinstance(options, dict):
            raise ValueError("ComposeReviewRequest 'options' must be a dictionary")

        return cls(
            id=req_id,
            action="compose_review",
            files=files,
            options=options,
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "action": self.action,
            "files": [f.to_dict() for f in self.files],
            "options": self.options,
        }


@dataclass
class FileResult:
    path: str
    risk_score: float
    risk_label: str
    risk_color: str
    signals: Dict[str, Any]
    findings: List[str]
    confidence: float
    breakdown: Optional[Dict[str, float]] = None
    agent_collaboration: Optional[Dict[str, Any]] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "FileResult":
        return cls(
            path=data.get("path", ""),
            risk_score=float(data.get("risk_score", 0.0)),
            risk_label=data.get("risk_label", ""),
            risk_color=data.get("risk_color", ""),
            signals=data.get("signals", {}),
            findings=data.get("findings", []),
            confidence=float(data.get("confidence", 0.0)),
            breakdown=data.get("breakdown"),
            agent_collaboration=data.get("agent_collaboration"),
        )

    def to_dict(self) -> Dict[str, Any]:
        res = {
            "path": self.path,
            "risk_score": max(0.0, min(1.0, self.risk_score)),
            "risk_label": self.risk_label,
            "risk_color": self.risk_color,
            "signals": self.signals,
            "findings": self.findings,
            "confidence": self.confidence,
        }
        if self.breakdown is not None:
            res["breakdown"] = self.breakdown
        if self.agent_collaboration is not None:
            res["agent_collaboration"] = self.agent_collaboration
        return res


@dataclass
class AnalyzeResponse:
    id: str = "req_default"
    ok: bool = True
    files: List[FileResult] = field(default_factory=list)
    consensus: Optional[Dict[str, Any]] = None
    evidence_pack: Optional[Dict[str, Any]] = None
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "AnalyzeResponse":
        files = [FileResult.from_dict(f) for f in data.get("files", [])]
        return cls(
            id=str(data.get("id", "req_default")),
            ok=data.get("ok", True),
            files=files,
            consensus=data.get("consensus"),
            evidence_pack=data.get("evidence_pack"),
            error=data.get("error"),
        )

    def to_dict(self) -> Dict[str, Any]:
        if not self.ok:
            return {
                "id": self.id,
                "ok": False,
                "error": self.error or "Unknown engine error",
            }
        return {
            "id": self.id,
            "ok": True,
            "files": [f.to_dict() for f in self.files],
            "consensus": self.consensus,
            "evidence_pack": self.evidence_pack,
        }


@dataclass
class ComposeReviewResponse:
    id: str = "req_default"
    ok: bool = True
    overall_score: int = 100
    risk_level: str = "low"
    summary: str = ""
    recommendations: List[str] = field(default_factory=list)
    error: Optional[str] = None

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ComposeReviewResponse":
        return cls(
            id=str(data.get("id", "req_default")),
            ok=data.get("ok", True),
            overall_score=int(data.get("overall_score", 100)),
            risk_level=data.get("risk_level", "low"),
            summary=data.get("summary", ""),
            recommendations=data.get("recommendations", []),
            error=data.get("error"),
        )

    def to_dict(self) -> Dict[str, Any]:
        if not self.ok:
            return {
                "id": self.id,
                "ok": False,
                "error": self.error or "Unknown compose error",
            }
        return {
            "id": self.id,
            "ok": True,
            "overall_score": self.overall_score,
            "risk_level": self.risk_level,
            "summary": self.summary,
            "recommendations": self.recommendations,
        }
