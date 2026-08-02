"""Tests for engine protocol and stdio main entrypoint."""
import io
import json
import sys
import unittest
from unittest.mock import patch

from engine.protocol import (
    AnalyzeRequest,
    AnalyzeResponse,
    ComposeReviewFile,
    ComposeReviewRequest,
    ComposeReviewResponse,
    FileInput,
    FileResult,
)
from engine.runner import compose_review, run_analysis
from engine.__main__ import main


class TestEngineProtocol(unittest.TestCase):
    def test_analyze_request_response_dataclasses(self):
        file_inp = FileInput(path="test.py", content="x = 1", baseline="x = 0")
        req = AnalyzeRequest(id="req-100", action="analyze", files=[file_inp])
        req_dict = req.to_dict()

        self.assertEqual(req_dict["id"], "req-100")
        self.assertEqual(req_dict["action"], "analyze")
        self.assertEqual(len(req_dict["files"]), 1)
        self.assertEqual(req_dict["files"][0]["path"], "test.py")

        resp = run_analysis(req)
        self.assertTrue(resp.ok)
        self.assertEqual(resp.id, "req-100")
        self.assertEqual(len(resp.files), 1)

    def test_compose_review_dataclasses(self):
        compose_req = ComposeReviewRequest(
            id="req-200",
            action="compose_review",
            files=[
                ComposeReviewFile(path="file1.py", risk_score=0.8, findings=["High risk issue"])
            ]
        )
        resp = compose_review(compose_req)
        self.assertTrue(resp.ok)
        self.assertEqual(resp.id, "req-200")
        self.assertEqual(resp.overall_score, 20)  # (1.0 - 0.8) * 100
        self.assertEqual(resp.risk_level, "critical")
        self.assertIn("1 file(s)", resp.summary)
        self.assertIn("1 file(s)", resp.recommendations[0])

    def test_main_stdio_valid_analyze_with_stdout_print_redirection(self):
        input_json = json.dumps({
            "id": "req-main-1",
            "action": "analyze",
            "files": [{"path": "a.py", "content": "print('hello')"}]
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        def noisy_run_analysis(req):
            print("NOISY_LOG_PRINT")
            return run_analysis(req)

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf), \
             patch("engine.__main__.run_analysis", noisy_run_analysis):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertEqual(res_data["id"], "req-main-1")
        self.assertTrue(res_data["ok"])
        self.assertEqual(len(res_data["files"]), 1)

        self.assertIn("NOISY_LOG_PRINT", stderr_buf.getvalue())

    def test_main_stdio_missing_id(self):
        input_json = json.dumps({
            "action": "analyze",
            "files": []
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertFalse(res_data["ok"])
        self.assertIsNone(res_data["id"])
        self.assertIn("Missing or invalid", res_data["error"])

    def test_main_stdio_non_string_id(self):
        input_json = json.dumps({
            "id": 123,
            "action": "analyze",
            "files": []
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertFalse(res_data["ok"])
        self.assertIsNone(res_data["id"])

    def test_main_stdio_missing_action(self):
        input_json = json.dumps({
            "id": "req-no-action",
            "files": []
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertFalse(res_data["ok"])
        self.assertEqual(res_data["id"], "req-no-action")
        self.assertIn("Missing explicit 'action'", res_data["error"])

    def test_main_stdio_invalid_json(self):
        input_raw = "THIS IS NOT VALID JSON\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_raw)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertFalse(res_data["ok"])
        self.assertIsNone(res_data["id"])
        self.assertIn("Invalid JSON payload", res_data["error"])

    def test_main_stdio_normalises_lone_surrogates_from_json(self):
        input_json = json.dumps({
            "id": "req-surrogate",
            "action": "analyze",
            "files": [{"path": "a.py", "content": "value = '\udc80'"}]
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        res_data = json.loads(stdout_buf.getvalue().strip())
        self.assertTrue(res_data["ok"])
        self.assertNotIn("surrogates not allowed", stderr_buf.getvalue())

    def test_main_stdio_compose_validation_error_schema(self):
        # Passing invalid files array (risk_score = 2.0 out of range) to compose_review
        input_json = json.dumps({
            "id": "req-comp-err",
            "action": "compose_review",
            "files": [{"path": "a.py", "risk_score": 2.0, "findings": []}]
        }) + "\n"

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        with patch("sys.stdin", io.StringIO(input_json)), \
             patch("sys.stdout", stdout_buf), \
             patch("sys.stderr", stderr_buf):
            main()

        output_lines = stdout_buf.getvalue().strip().split("\n")
        self.assertEqual(len(output_lines), 1)

        res_data = json.loads(output_lines[0])
        self.assertFalse(res_data["ok"])
        self.assertEqual(res_data["id"], "req-comp-err")
        self.assertIn("Protocol validation error", res_data["error"])

        self.assertNotIn("files", res_data)
        self.assertNotIn("overall_score", res_data)
        self.assertNotIn("risk_level", res_data)

    def test_protocol_options_null_rejected(self):
        with self.assertRaises(ValueError):
            AnalyzeRequest.from_dict({
                "id": "req-1",
                "action": "analyze",
                "files": [],
                "options": None
            })

    def test_protocol_blank_strings_rejected(self):
        with self.assertRaises(ValueError):
            AnalyzeRequest.from_dict({
                "id": "   ",
                "action": "analyze",
                "files": []
            })

        with self.assertRaises(ValueError):
            FileInput.from_dict({
                "path": "   ",
                "content": "x = 1"
            })


if __name__ == "__main__":
    unittest.main()
