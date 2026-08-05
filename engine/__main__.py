from contextlib import redirect_stdout
import json
import sys
import traceback
from typing import Optional
from engine.protocol import (
    AnalyzeRequest,
    ComposeReviewRequest,
    AnalyzeResponse,
    ComposeReviewResponse,
    RecordReviewRequest,
    RecordReviewResponse,
    RelevantContextRequest,
    RelevantContextResponse,
    RunWorkflowRequest,
    RunWorkflowResponse,
    normalise_protocol_strings,
)
from engine.runner import run_analysis, compose_review

def write_stdout(data: dict) -> None:
    line = json.dumps(data)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

def log_stderr(msg: str) -> None:
    sys.stderr.write(msg + "\n")
    sys.stderr.flush()

def make_error_response(action: Optional[str], req_id: Optional[str], message: str) -> dict:
    if action == "compose_review":
        return ComposeReviewResponse(
            id=req_id if req_id is not None else "req_error",
            ok=False,
            error=message
        ).to_dict()

    if action == "run_workflow":
        return RunWorkflowResponse(
            id=req_id if req_id is not None else "req_error",
            ok=False,
            error=message
        ).to_dict()

    if action == "record_review":
        return RecordReviewResponse(
            id=req_id if req_id is not None else "req_error",
            ok=False,
            error=message
        ).to_dict()

    if action == "relevant_context":
        return RelevantContextResponse(
            id=req_id if req_id is not None else "req_error",
            ok=False,
            error=message
        ).to_dict()

    return AnalyzeResponse(
        id=req_id if req_id is not None else "req_error",
        ok=False,
        files=[],
        error=message
    ).to_dict()

def main():
    while True:
        line = sys.stdin.readline()
        if not line:
            break
        line_str = line.strip()
        if not line_str:
            continue

        raw_data = None
        req_id = None
        action = None
        try:
            raw_data = normalise_protocol_strings(json.loads(line_str))
            if isinstance(raw_data, dict):
                raw_id = raw_data.get("id")
                if isinstance(raw_id, str) and raw_id.strip():
                    req_id = raw_id
                raw_action = raw_data.get("action")
                if isinstance(raw_action, str) and raw_action.strip():
                    action = raw_action
        except Exception as parse_err:
            log_stderr(f"[Engine Protocol Error] Failed to parse JSON input: {parse_err}")
            write_stdout({
                "id": None,
                "ok": False,
                "error": f"Invalid JSON payload: {str(parse_err)}"
            })
            continue

        if not isinstance(raw_data, dict):
            log_stderr("[Engine Protocol Error] Request payload must be a JSON object.")
            write_stdout({
                "id": None,
                "ok": False,
                "error": "Request payload must be a JSON object."
            })
            continue

        if req_id is None:
            log_stderr(f"[Engine Protocol Error] Missing or invalid string 'id' field in request: {raw_data.get('id')}")
            write_stdout({
                "id": None,
                "ok": False,
                "error": "Missing or invalid request 'id' string."
            })
            continue

        if action is None:
            log_stderr(f"[Engine Protocol Error] Missing explicit 'action' field in request {req_id}")
            write_stdout(make_error_response(action, req_id, "Missing explicit 'action' field."))
            continue

        try:
            if action == "analyze":
                request = AnalyzeRequest.from_dict(raw_data)
                with redirect_stdout(sys.stderr):
                    response = run_analysis(request)
                response.id = req_id
                write_stdout(response.to_dict())
            elif action == "compose_review":
                request = ComposeReviewRequest.from_dict(raw_data)
                with redirect_stdout(sys.stderr):
                    response = compose_review(request)
                response.id = req_id
                write_stdout(response.to_dict())
            elif action == "record_review":
                from engine.knowledge.bridge import run_record_review_request

                record_request = RecordReviewRequest.from_dict(raw_data)
                with redirect_stdout(sys.stderr):
                    response = run_record_review_request(record_request)
                response.id = req_id
                write_stdout(response.to_dict())
            elif action == "relevant_context":
                from engine.knowledge.bridge import run_relevant_context_request

                context_request = RelevantContextRequest.from_dict(raw_data)
                with redirect_stdout(sys.stderr):
                    response = run_relevant_context_request(context_request)
                response.id = req_id
                write_stdout(response.to_dict())
            elif action == "run_workflow":
                # Imported lazily so the existing actions do not pay for the
                # workflow engine's imports on every engine start.
                from engine.workflow.bridge import run_workflow_request

                workflow_request = RunWorkflowRequest.from_dict(raw_data)
                with redirect_stdout(sys.stderr):
                    response = run_workflow_request(workflow_request)
                response.id = req_id
                write_stdout(response.to_dict())
            else:
                log_stderr(f"[Engine Protocol Error] Unsupported action '{action}' for request {req_id}")
                write_stdout(make_error_response(action, req_id, f"Unsupported action '{action}'"))
        except ValueError as val_err:
            log_stderr(f"[Engine Protocol Validation Error] Request {req_id}: {val_err}")
            write_stdout(make_error_response(action, req_id, f"Protocol validation error: {str(val_err)}"))
        except Exception as exc:
            log_stderr(f"[Engine Execution Error] Exception for request {req_id}: {traceback.format_exc()}")
            write_stdout(make_error_response(action, req_id, f"Execution error: {str(exc)}"))

if __name__ == "__main__":
    main()
