"""Tests for WorkflowSpec v2 parsing, including cross-language contract drift."""
import re
import unittest
from pathlib import Path

from engine.workflow.spec import (
    ANALYZER_KINDS,
    DEFAULT_NODE_TIMEOUT_MS,
    DEFAULT_SYNTHESIZER_TIMEOUT_MS,
    MAX_TIMEOUT_MS,
    STEP_ID_PATTERN,
    VERIFIER_KINDS,
    WorkflowSpecError,
    builtin_workflow_directory,
    load_builtin_workflow,
    load_workflow_spec,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
TS_WORKFLOW_SCHEMA = REPO_ROOT / "packages" / "schema" / "src" / "workflow.ts"

MINIMAL = {
    "version": 2,
    "name": "minimal",
    "nodes": [{"id": "scan", "uses": "engine.security"}],
    "synthesizer": {"needs": ["scan"]},
}


def _ts_enum_members(source: str, name: str) -> set[str]:
    match = re.search(rf"{name}\s*=\s*z\.enum\(\[(.*?)\]\)", source, re.DOTALL)
    if match is None:
        raise AssertionError(f"Could not find {name} in {TS_WORKFLOW_SCHEMA}")
    return set(re.findall(r'"([^"]+)"', match.group(1)))


class ContractDriftTest(unittest.TestCase):
    """The Python and TypeScript allowlists describe the same contract.

    A spec is authored once and validated on both sides, so a value permitted by
    one and rejected by the other is a latent bug. This test fails the moment
    they diverge.
    """

    def setUp(self):
        self.source = TS_WORKFLOW_SCHEMA.read_text(encoding="utf-8")

    def test_analyzer_kinds_match_typescript(self):
        self.assertEqual(_ts_enum_members(self.source, "analyzerKindSchema"), set(ANALYZER_KINDS))

    def test_verifier_kinds_match_typescript(self):
        self.assertEqual(_ts_enum_members(self.source, "verifierKindSchema"), set(VERIFIER_KINDS))

    # ─── Field-level contract ──────────────────────────────────────────────

    def _ts_object_fields(self, pattern: str, block_name: str) -> set[str]:
        match = re.search(pattern, self.source, re.DOTALL)
        if match is None:
            raise AssertionError(f"{block_name} block not found in workflow.ts")
        return set(re.findall(r"\b(\w+)\s*:", match.group(1)))

    def test_step_field_names_match_typescript(self):
        ts_fields = self._ts_object_fields(r"const stepBase = \{(.*?)\n\};", "stepBase")
        py_fields = {"id", "uses", "needs", "timeoutMs", "continueOnError", "with"}
        # 'uses' is selected per role in TypeScript, so it lives outside stepBase.
        self.assertEqual(ts_fields | {"uses"}, py_fields)

    def test_spec_level_fields_match_typescript(self):
        ts_fields = self._ts_object_fields(
            r"workflowSpecObjectSchema\s*=\s*z\.object\(\{(.*?)\n\}\)",
            "workflowSpecObjectSchema",
        )
        py_fields = {"version", "name", "description", "nodes", "verifiers", "synthesizer"}
        self.assertEqual(ts_fields, py_fields)

    def test_synthesizer_fields_match_typescript(self):
        ts_fields = self._ts_object_fields(
            r"workflowSynthesizerSchema\s*=\s*z\.object\(\{(.*?)\n\}\)",
            "workflowSynthesizerSchema",
        )
        py_fields = {"id", "uses", "needs", "timeoutMs", "with"}
        self.assertEqual(ts_fields, py_fields)

    def test_timeout_defaults_and_bounds_match_typescript(self):
        node_bounds = re.search(r"max\(([\d_]+)\)\.default\(([\d_]+)\)", self.source)
        self.assertIsNotNone(node_bounds, "node timeoutMs bounds not found in workflow.ts")
        self.assertEqual(int(node_bounds.group(1).replace("_", "")), MAX_TIMEOUT_MS)
        self.assertEqual(int(node_bounds.group(2).replace("_", "")), DEFAULT_NODE_TIMEOUT_MS)

        synth_match = re.search(
            r"workflowSynthesizerSchema\s*=\s*z\.object\(\{.*?\n\}\)", self.source, re.DOTALL
        )
        self.assertIsNotNone(synth_match, "workflowSynthesizerSchema block not found")
        synth_default = re.search(r"\.default\(([\d_]+)\)", synth_match.group(0))
        self.assertIsNotNone(synth_default, "synthesizer timeoutMs default not found")
        self.assertEqual(int(synth_default.group(1).replace("_", "")), DEFAULT_SYNTHESIZER_TIMEOUT_MS)

    def test_step_id_pattern_matches_typescript(self):
        ts_pattern = re.search(r"\.regex\(/\^([^/]+)\$/", self.source)
        self.assertIsNotNone(ts_pattern, "step id regex not found in workflow.ts")
        self.assertEqual(f"^{ts_pattern.group(1)}$", STEP_ID_PATTERN.pattern)


class LoadWorkflowSpecTest(unittest.TestCase):
    def test_parses_a_minimal_spec_and_applies_defaults(self):
        spec = load_workflow_spec(MINIMAL)
        self.assertEqual(spec.name, "minimal")
        self.assertEqual(len(spec.nodes), 1)
        self.assertEqual(spec.nodes[0].timeout_ms, 60_000)
        self.assertFalse(spec.nodes[0].continue_on_error)
        self.assertEqual(spec.nodes[0].needs, ())
        self.assertEqual(spec.synthesizer.step_id, "synthesizer")
        self.assertEqual(spec.synthesizer.uses, "synthesize.review_report")
        self.assertEqual(spec.synthesizer.timeout_ms, 120_000)

    def test_rejects_a_non_v2_document(self):
        with self.assertRaisesRegex(WorkflowSpecError, "Unsupported workflow version"):
            load_workflow_spec({**MINIMAL, "version": 1})

    def test_rejects_an_analyzer_outside_the_allowlist(self):
        with self.assertRaisesRegex(WorkflowSpecError, "is not allowed"):
            load_workflow_spec({**MINIMAL, "nodes": [{"id": "x", "uses": "sh -c 'curl evil'"}]})

    def test_rejects_a_verifier_kind_used_as_a_node(self):
        with self.assertRaisesRegex(WorkflowSpecError, "is not allowed"):
            load_workflow_spec({**MINIMAL, "nodes": [{"id": "x", "uses": "verify.unit_tests"}]})

    def test_rejects_unsafe_step_ids(self):
        for bad in ("../escape", "1leading", "Upper", "has space", ""):
            with self.subTest(step_id=bad):
                with self.assertRaises(WorkflowSpecError):
                    load_workflow_spec({**MINIMAL, "nodes": [{"id": bad, "uses": "engine.security"}]})

    def test_rejects_continue_on_error_on_the_synthesizer(self):
        with self.assertRaisesRegex(WorkflowSpecError, "unknown field"):
            load_workflow_spec({**MINIMAL, "synthesizer": {"continueOnError": True}})

    def test_rejects_unknown_fields(self):
        with self.assertRaisesRegex(WorkflowSpecError, "unknown field"):
            load_workflow_spec({**MINIMAL, "runAs": "root"})
        with self.assertRaisesRegex(WorkflowSpecError, "unknown field"):
            load_workflow_spec({
                **MINIMAL,
                "nodes": [{"id": "scan", "uses": "engine.security", "command": "rm -rf /"}],
            })

    def test_rejects_an_empty_node_list(self):
        with self.assertRaisesRegex(WorkflowSpecError, "non-empty list"):
            load_workflow_spec({**MINIMAL, "nodes": []})

    def test_rejects_a_missing_synthesizer(self):
        document = {key: value for key, value in MINIMAL.items() if key != "synthesizer"}
        with self.assertRaisesRegex(WorkflowSpecError, "synthesizer is required"):
            load_workflow_spec(document)

    def test_rejects_out_of_range_timeouts(self):
        for timeout in (0, -1, 600_001):
            with self.subTest(timeout=timeout):
                with self.assertRaisesRegex(WorkflowSpecError, "timeoutMs"):
                    load_workflow_spec({
                        **MINIMAL,
                        "nodes": [{"id": "scan", "uses": "engine.security", "timeoutMs": timeout}],
                    })

    def test_rejects_a_cycle_via_the_graph(self):
        with self.assertRaisesRegex(WorkflowSpecError, "cycle"):
            load_workflow_spec({
                **MINIMAL,
                "nodes": [
                    {"id": "a", "uses": "engine.security", "needs": ["b"]},
                    {"id": "b", "uses": "engine.style", "needs": ["a"]},
                ],
                "synthesizer": {"needs": ["a"]},
            })

    def test_rejects_a_dangling_dependency(self):
        with self.assertRaisesRegex(WorkflowSpecError, "unknown step 'ghost'"):
            load_workflow_spec({**MINIMAL, "synthesizer": {"needs": ["ghost"]}})

    def test_rejects_duplicate_step_ids_across_roles(self):
        with self.assertRaisesRegex(WorkflowSpecError, "Duplicate step id"):
            load_workflow_spec({
                **MINIMAL,
                "verifiers": [{"id": "scan", "uses": "verify.syntax"}],
            })


class BuiltinWorkflowTest(unittest.TestCase):
    EXPECTED = ("security-hardening", "architectural-drift", "pr-sanity-verification", "pr-review")

    def test_pr_review_never_executes_repository_code(self):
        """The live review path runs against an untrusted clone.

        Linters and test runners execute or deeply parse code the repository
        author controls, so the workflow backing reviews must contain none of
        them.
        """
        spec = load_builtin_workflow("pr-review")
        for step in spec.steps:
            self.assertFalse(
                step.uses.startswith("tool."),
                f"{step.step_id} shells out to an external tool",
            )
            self.assertNotEqual(step.uses, "verify.unit_tests")
            self.assertNotEqual(step.uses, "verify.build")

    def test_every_shipped_workflow_is_present_and_valid(self):
        for name in self.EXPECTED:
            with self.subTest(workflow=name):
                spec = load_builtin_workflow(name)
                self.assertEqual(spec.name, name)
                self.assertTrue(spec.nodes)
                self.assertTrue(spec.dag().levels())

    def test_directory_contains_no_unlisted_workflows(self):
        on_disk = {path.stem for path in builtin_workflow_directory().glob("*.yml")}
        self.assertEqual(on_disk, set(self.EXPECTED))

    def test_shipped_workflows_only_use_registered_kinds(self):
        allowed = ANALYZER_KINDS | VERIFIER_KINDS | {"synthesize.review_report"}
        for name in self.EXPECTED:
            with self.subTest(workflow=name):
                for step in load_builtin_workflow(name).steps:
                    self.assertIn(step.uses, allowed)

    def test_pr_sanity_blocks_on_a_failing_test_suite(self):
        spec = load_builtin_workflow("pr-sanity-verification")
        unit_tests = spec.step("unit-tests")
        self.assertFalse(
            unit_tests.continue_on_error,
            "A failing test suite must block the workflow, not be tolerated",
        )

    def test_rejects_a_traversal_style_workflow_name(self):
        with self.assertRaises(WorkflowSpecError):
            load_builtin_workflow("../../etc/passwd")


if __name__ == "__main__":
    unittest.main()
