"""Tests for the run_workflow stdio action."""
import io
import json
import unittest
from unittest.mock import patch

from engine.__main__ import main
from engine.protocol import RunWorkflowRequest
from engine.workflow.bridge import run_workflow_request


def _request(**overrides):
    payload = {
        "id": "req_1",
        "action": "run_workflow",
        "workflow": "architectural-drift",
        "files": [
            {"path": "pkg/__init__.py", "content": ""},
            {"path": "pkg/alpha.py", "content": "from pkg import beta\n"},
            {"path": "pkg/beta.py", "content": "from pkg import alpha\n"},
        ],
    }
    payload.update(overrides)
    return payload


class RunWorkflowRequestParsingTest(unittest.TestCase):
    def test_parses_a_valid_request(self):
        request = RunWorkflowRequest.from_dict(_request())
        self.assertEqual(request.workflow, "architectural-drift")
        self.assertEqual(len(request.files), 3)
        self.assertIsNone(request.workspace_path)

    def test_rejects_a_mismatched_action(self):
        with self.assertRaisesRegex(ValueError, "requires action='run_workflow'"):
            RunWorkflowRequest.from_dict(_request(action="analyze"))

    def test_rejects_a_blank_workflow_name(self):
        with self.assertRaisesRegex(ValueError, "non-empty string 'workflow'"):
            RunWorkflowRequest.from_dict(_request(workflow="  "))

    def test_rejects_unknown_fields(self):
        with self.assertRaisesRegex(ValueError, "Unexpected field"):
            RunWorkflowRequest.from_dict(_request(command="rm -rf /"))


class RunWorkflowBridgeTest(unittest.TestCase):
    def test_executes_a_builtin_workflow_and_reports_evidence(self):
        response = run_workflow_request(RunWorkflowRequest.from_dict(_request()))

        self.assertTrue(response.ok, response.error)
        self.assertEqual(response.run["specName"], "architectural-drift")
        self.assertEqual(response.run["status"], "succeeded")

        cycles = [
            item
            for artifact in response.run["artifacts"]
            for item in (artifact.get("evidence") or {}).get("items", [])
            if item.get("rule") == "graph.dependency.circular_import"
        ]
        self.assertEqual(len(cycles), 1)

    def test_reports_an_unknown_workflow_without_raising(self):
        response = run_workflow_request(
            RunWorkflowRequest.from_dict(_request(workflow="does-not-exist"))
        )
        self.assertFalse(response.ok)
        self.assertIn("Unknown or invalid workflow", response.error)

    def test_rejects_a_traversal_workflow_name(self):
        response = run_workflow_request(
            RunWorkflowRequest.from_dict(_request(workflow="../../../etc/passwd"))
        )
        self.assertFalse(response.ok)

    def test_rejects_a_nonsense_parallelism_option(self):
        response = run_workflow_request(
            RunWorkflowRequest.from_dict(_request(options={"max_parallelism": 0}))
        )
        self.assertFalse(response.ok)
        self.assertIn("max_parallelism", response.error)

    def test_every_artifact_carries_the_same_input_digest(self):
        response = run_workflow_request(RunWorkflowRequest.from_dict(_request()))
        digests = {artifact["inputDigest"] for artifact in response.run["artifacts"]}
        self.assertEqual(len(digests), 1)
        self.assertEqual(len(digests.pop()), 64)


class RunWorkflowStdioTest(unittest.TestCase):
    """Drives the real stdio loop the TypeScript bridge speaks to."""

    def _run(self, payload):
        stdin = io.StringIO(json.dumps(payload) + "\n")
        stdout = io.StringIO()
        with patch("sys.stdin", stdin), patch("sys.stdout", stdout), patch("sys.stderr", io.StringIO()):
            main()
        lines = [line for line in stdout.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1, stdout.getvalue())
        return json.loads(lines[0])

    def test_round_trips_a_workflow_run_over_stdio(self):
        response = self._run(_request())

        self.assertEqual(response["id"], "req_1")
        self.assertTrue(response["ok"], response.get("error"))
        self.assertEqual(response["run"]["specName"], "architectural-drift")
        self.assertIn("artifacts", response["run"])

    def test_stdout_stays_clean_json_when_a_workflow_fails(self):
        response = self._run(_request(workflow="nope"))

        self.assertEqual(response["id"], "req_1")
        self.assertFalse(response["ok"])
        self.assertIn("error", response)

    def test_a_malformed_request_returns_the_workflow_error_shape(self):
        response = self._run(_request(files="not-a-list"))

        self.assertFalse(response["ok"])
        self.assertIn("error", response)
        # Not the analyze shape: a failed run_workflow must not claim files.
        self.assertNotIn("files", response)

    def test_existing_actions_are_unaffected(self):
        response = self._run({
            "id": "req_2",
            "action": "analyze",
            "files": [{"path": "a.py", "content": "x = 1\n"}],
        })
        self.assertTrue(response["ok"], response.get("error"))
        self.assertIn("files", response)


if __name__ == "__main__":
    unittest.main()
