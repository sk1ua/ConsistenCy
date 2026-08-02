"""JSON-over-stdio protocol definitions."""
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set


def normalise_protocol_strings(value: Any) -> Any:
    """Replace lone UTF-16 surrogate code points at the stdio boundary.

    GitHub snapshots can contain malformed or escaped Unicode. Python's UTF-8
    encoder cannot represent lone surrogates, so normalising them once at the
    untrusted JSON boundary keeps the deterministic engine total without
    allowing invalid text to poison stdout or parser inputs.
    """
    if isinstance(value, str):
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
