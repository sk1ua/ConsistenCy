"""Tests for the async DAG workflow executor."""
import asyncio
import unittest

from engine.workflow.artifacts import (
    STATUS_FAILED,
    STATUS_SKIPPED,
    STATUS_SUCCEEDED,
    STATUS_TIMED_OUT,
    EvidenceItem,
    digest_files,
)
from engine.workflow.plugins import (
    AnalysisContext,
    BaseAnalyzerPlugin,
    MissingPluginError,
    PluginReport,
)
from engine.workflow.runner import WorkflowRunner, run_workflow
from engine.workflow.spec import load_workflow_spec

CONTEXT = AnalysisContext(files={"a.py": "x = 1\n", "b.py": "y = 2\n"})


def spec_from(nodes, synthesizer_needs, verifiers=None):
    return load_workflow_spec({
        "version": 2,
        "name": "test-workflow",
        "nodes": nodes,
        "verifiers": verifiers or [],
        "synthesizer": {"needs": synthesizer_needs},
    })


class RecordingPlugin(BaseAnalyzerPlugin):
    def __init__(self, log, step_id, delay=0.0, fail=False, hang=False, evidence=()):
        super().__init__({})
        self._log = log
        self._step_id = step_id
        self._delay = delay
        self._fail = fail
        self._hang = hang
        self._evidence = evidence

    async def analyze(self, context):
        self._log.append(("start", self._step_id))
        if self._hang:
            await asyncio.sleep(60)
        if self._delay:
            await asyncio.sleep(self._delay)
        if self._fail:
            raise RuntimeError(f"{self._step_id} exploded")
        self._log.append(("end", self._step_id))
        return PluginReport(
            evidence=self._evidence,
            summary=f"{self._step_id} ok",
            command=("fake", self._step_id),
            exit_code=0,
            raw_output=f"output from {self._step_id}",
        )


def resolver_for(plugins):
    def resolve(step):
        if step.step_id not in plugins:
            raise MissingPluginError(f"No plugin registered for '{step.uses}'")
        return plugins[step.step_id]
    return resolve


class WorkflowRunnerTest(unittest.IsolatedAsyncioTestCase):
    async def test_step_options_cannot_grant_themselves_trusted_execution(self):
        observed = []

        class CaptureOptionsPlugin(BaseAnalyzerPlugin):
            async def analyze(self, context):
                observed.append(dict(context.options))
                return PluginReport(summary="captured")

        spec = spec_from(
            [{
                "id": "untrusted-step",
                "uses": "engine.style",
                "with": {"execution_profile": "trusted_sandbox"},
            }],
            ["untrusted-step"],
        )
        plugins = {
            "untrusted-step": CaptureOptionsPlugin(),
            "synthesizer": CaptureOptionsPlugin(),
        }

        await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(observed[0]["execution_profile"], "static_readonly")

    async def test_runs_independent_steps_concurrently(self):
        log = []
        spec = spec_from(
            [
                {"id": "alpha", "uses": "engine.style"},
                {"id": "beta", "uses": "engine.semantic"},
            ],
            ["alpha", "beta"],
        )
        plugins = {
            "alpha": RecordingPlugin(log, "alpha", delay=0.05),
            "beta": RecordingPlugin(log, "beta", delay=0.05),
            "synthesizer": RecordingPlugin(log, "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(result.status, STATUS_SUCCEEDED)
        # Both start before either finishes: they shared a level.
        self.assertEqual(log[:2], [("start", "alpha"), ("start", "beta")])

    async def test_respects_max_parallelism(self):
        active = {"current": 0, "peak": 0}

        class CountingPlugin(BaseAnalyzerPlugin):
            async def analyze(self, context):
                active["current"] += 1
                active["peak"] = max(active["peak"], active["current"])
                await asyncio.sleep(0.02)
                active["current"] -= 1
                return PluginReport(summary="ok")

        spec = spec_from(
            [{"id": f"n{index}", "uses": "engine.style"} for index in range(6)],
            [f"n{index}" for index in range(6)],
        )
        runner = WorkflowRunner(resolver=lambda step: CountingPlugin(), max_parallelism=2)
        await runner.run(spec, CONTEXT)

        self.assertLessEqual(active["peak"], 2)

    async def test_orders_dependent_steps(self):
        log = []
        spec = spec_from(
            [
                {"id": "first", "uses": "engine.style"},
                {"id": "second", "uses": "engine.semantic", "needs": ["first"]},
            ],
            ["second"],
        )
        plugins = {
            "first": RecordingPlugin(log, "first"),
            "second": RecordingPlugin(log, "second"),
            "synthesizer": RecordingPlugin(log, "synthesizer"),
        }
        await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(log.index(("end", "first")), log.index(("start", "second")) - 1)

    async def test_a_failure_blocks_only_its_dependents(self):
        log = []
        spec = spec_from(
            [
                {"id": "broken", "uses": "engine.style"},
                {"id": "downstream", "uses": "engine.semantic", "needs": ["broken"]},
                {"id": "independent", "uses": "engine.duplication"},
            ],
            ["downstream", "independent"],
        )
        plugins = {
            "broken": RecordingPlugin(log, "broken", fail=True),
            "downstream": RecordingPlugin(log, "downstream"),
            "independent": RecordingPlugin(log, "independent"),
            "synthesizer": RecordingPlugin(log, "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(result.artifact("broken").status, STATUS_FAILED)
        self.assertIn("exploded", result.artifact("broken").error)
        self.assertEqual(result.artifact("downstream").status, STATUS_SKIPPED)
        # The unrelated branch still produced a result.
        self.assertEqual(result.artifact("independent").status, STATUS_SUCCEEDED)
        self.assertEqual(result.status, STATUS_FAILED)
        self.assertNotIn(("start", "downstream"), log)

    async def test_continue_on_error_lets_the_run_succeed(self):
        log = []
        spec = spec_from(
            [
                {"id": "flaky", "uses": "engine.style", "continueOnError": True},
                {"id": "downstream", "uses": "engine.semantic", "needs": ["flaky"]},
            ],
            ["downstream"],
        )
        plugins = {
            "flaky": RecordingPlugin(log, "flaky", fail=True),
            "downstream": RecordingPlugin(log, "downstream"),
            "synthesizer": RecordingPlugin(log, "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(result.artifact("flaky").status, STATUS_FAILED)
        self.assertEqual(result.artifact("downstream").status, STATUS_SUCCEEDED)
        self.assertEqual(result.status, STATUS_SUCCEEDED)

    async def test_a_step_is_bounded_by_its_own_timeout(self):
        log = []
        spec = spec_from(
            [{"id": "hangs", "uses": "engine.style", "timeoutMs": 50}],
            ["hangs"],
        )
        plugins = {
            "hangs": RecordingPlugin(log, "hangs", hang=True),
            "synthesizer": RecordingPlugin(log, "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(result.artifact("hangs").status, STATUS_TIMED_OUT)
        self.assertIn("50ms", result.artifact("hangs").error)
        self.assertEqual(result.status, STATUS_FAILED)

    async def test_a_missing_plugin_fails_the_step_not_the_run(self):
        spec = spec_from([{"id": "orphan", "uses": "graph.schema_drift"}], ["orphan"])
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for({}))

        self.assertEqual(result.artifact("orphan").status, STATUS_FAILED)
        self.assertIn("No plugin registered", result.artifact("orphan").error)

    async def test_evidence_flows_to_downstream_steps(self):
        seen = {}

        upstream_item = EvidenceItem(file="a.py", excerpt="hardcoded secret", start_line=1, end_line=1)

        class CapturingPlugin(BaseAnalyzerPlugin):
            async def analyze(self, context):
                seen["upstream"] = context.upstream_evidence
                return PluginReport(summary="captured")

        spec = spec_from(
            [
                {"id": "producer", "uses": "engine.security"},
                {"id": "consumer", "uses": "engine.semantic", "needs": ["producer"]},
            ],
            ["consumer"],
        )
        plugins = {
            "producer": RecordingPlugin([], "producer", evidence=(upstream_item,)),
            "consumer": CapturingPlugin(),
            "synthesizer": RecordingPlugin([], "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))

        self.assertEqual(seen["upstream"], (upstream_item,))
        self.assertIn(upstream_item, result.evidence)

    async def test_artifacts_record_command_exit_code_and_digest(self):
        spec = spec_from([{"id": "step", "uses": "engine.style"}], ["step"])
        plugins = {
            "step": RecordingPlugin([], "step"),
            "synthesizer": RecordingPlugin([], "synthesizer"),
        }
        result = await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))
        artifact = result.artifact("step")

        self.assertEqual(artifact.command, ("fake", "step"))
        self.assertEqual(artifact.exit_code, 0)
        self.assertEqual(artifact.raw_output, "output from step")
        self.assertEqual(artifact.input_digest, digest_files(CONTEXT.files))
        self.assertIsNotNone(artifact.duration_ms)

    async def test_serialised_run_uses_the_shared_camel_case_shape(self):
        spec = spec_from([{"id": "step", "uses": "engine.style"}], ["step"])
        plugins = {
            "step": RecordingPlugin([], "step"),
            "synthesizer": RecordingPlugin([], "synthesizer"),
        }
        payload = (await run_workflow(spec, CONTEXT, resolver=resolver_for(plugins))).to_dict()

        self.assertEqual(
            set(payload) - {"error"},
            {"runId", "specName", "status", "startedAt", "finishedAt", "artifacts"},
        )
        artifact = payload["artifacts"][0]
        for key in ("stepId", "uses", "status", "command", "exitCode", "startedAt", "inputDigest"):
            self.assertIn(key, artifact)
        self.assertEqual(len(artifact["inputDigest"]), 64)

    async def test_progress_events_are_emitted_in_order(self):
        events = []
        spec = spec_from([{"id": "step", "uses": "engine.style"}], ["step"])
        plugins = {
            "step": RecordingPlugin([], "step"),
            "synthesizer": RecordingPlugin([], "synthesizer"),
        }
        await run_workflow(
            spec, CONTEXT,
            resolver=resolver_for(plugins),
            on_progress=events.append,
        )
        names = [event["event"] for event in events]

        self.assertEqual(names[0], "run_started")
        self.assertEqual(names[-1], "run_finished")
        self.assertIn("step_started", names)
        self.assertIn("step_finished", names)

    async def test_a_broken_progress_consumer_does_not_abort_the_run(self):
        def explode(_event):
            raise RuntimeError("consumer is broken")

        spec = spec_from([{"id": "step", "uses": "engine.style"}], ["step"])
        plugins = {
            "step": RecordingPlugin([], "step"),
            "synthesizer": RecordingPlugin([], "synthesizer"),
        }
        result = await run_workflow(
            spec, CONTEXT,
            resolver=resolver_for(plugins),
            on_progress=explode,
        )
        self.assertEqual(result.status, STATUS_SUCCEEDED)


class DigestTest(unittest.TestCase):
    def test_digest_is_stable_and_order_independent(self):
        self.assertEqual(
            digest_files({"a.py": "1", "b.py": "2"}),
            digest_files({"b.py": "2", "a.py": "1"}),
        )

    def test_digest_changes_with_content(self):
        self.assertNotEqual(digest_files({"a.py": "1"}), digest_files({"a.py": "2"}))

    def test_length_prefixing_prevents_boundary_collisions(self):
        # Without length prefixes these two file sets would hash identically.
        self.assertNotEqual(
            digest_files({"ab": "c", "d": "e"}),
            digest_files({"a": "bc", "d": "e"}),
        )


class EvidenceItemTest(unittest.TestCase):
    def test_requires_a_file_anchor(self):
        with self.assertRaises(ValueError):
            EvidenceItem(file="", excerpt="x")

    def test_requires_paired_line_bounds(self):
        with self.assertRaises(ValueError):
            EvidenceItem(file="a.py", excerpt="x", start_line=5)

    def test_rejects_inverted_line_bounds(self):
        with self.assertRaises(ValueError):
            EvidenceItem(file="a.py", excerpt="x", start_line=9, end_line=2)


if __name__ == "__main__":
    unittest.main()
