"""Tests for persistent project memory across successive reviews."""
import tempfile
import unittest
from pathlib import Path

from engine.knowledge.context import ContextQuery, get_relevant_context
from engine.knowledge.indexer import KnowledgeIndex
from engine.knowledge.bridge import run_record_review_request
from engine.protocol import RecordReviewRequest

SOURCE = {"pkg/beta.py": "def helper():\n    return 1\n", "pkg/alpha.py": "x = 1\n"}

FINDING = {"file": "pkg/beta.py", "title": "Unvalidated input", "severity": "critical"}
OTHER = {"file": "pkg/beta.py", "title": "Weak hash", "severity": "high"}


class RecordReviewTest(unittest.TestCase):
    def setUp(self):
        self.index = KnowledgeIndex(":memory:")
        self.addCleanup(self.index.close)
        self.index.index_files(SOURCE)

    def _record(self, job_id, findings, reference="sha1", when="2026-08-01T00:00:00.000Z"):
        return self.index.record_review(
            job_id=job_id,
            reference=reference,
            reported_at=when,
            covered_files=list(SOURCE),
            findings=findings,
        )

    def test_records_findings_as_unresolved(self):
        counts = self._record("job-1", [FINDING])
        self.assertEqual(counts, {"recorded": 1, "resolved": 0})

        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(len(context["pastSecurityReports"]), 1)
        self.assertFalse(context["pastSecurityReports"][0]["resolved"])

    def test_a_finding_that_disappears_becomes_a_historical_fix(self):
        self._record("job-1", [FINDING])
        counts = self._record("job-2", [], reference="sha2", when="2026-08-02T00:00:00.000Z")

        self.assertEqual(counts["resolved"], 1)
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertTrue(context["pastSecurityReports"][0]["resolved"])
        self.assertEqual(len(context["historicalFixes"]), 1)
        self.assertIn("Unvalidated input", context["historicalFixes"][0]["summary"])
        self.assertEqual(context["historicalFixes"][0]["reference"], "sha2")
        self.assertEqual(context["historicalFixes"][0]["severity"], "critical")

    def test_a_finding_that_persists_is_not_marked_fixed(self):
        self._record("job-1", [FINDING])
        counts = self._record("job-2", [FINDING], reference="sha2")

        self.assertEqual(counts["resolved"], 0)
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(context["historicalFixes"], [])

    def test_resolves_only_the_finding_that_went_away(self):
        self._record("job-1", [FINDING, OTHER])
        counts = self._record("job-2", [OTHER], reference="sha2")

        self.assertEqual(counts["resolved"], 1)
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        open_titles = {
            report["title"] for report in context["pastSecurityReports"] if not report["resolved"]
        }
        self.assertEqual(open_titles, {"Weak hash"})

    def test_files_the_review_did_not_cover_are_untouched(self):
        # A review that never looked at a file cannot have fixed anything in it.
        self.index.record_review(
            job_id="job-1",
            reference="sha1",
            reported_at="2026-08-01T00:00:00.000Z",
            covered_files=["pkg/beta.py"],
            findings=[FINDING],
        )
        counts = self.index.record_review(
            job_id="job-2",
            reference="sha2",
            reported_at="2026-08-02T00:00:00.000Z",
            covered_files=["pkg/alpha.py"],
            findings=[],
        )

        self.assertEqual(counts["resolved"], 0)
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertFalse(context["pastSecurityReports"][0]["resolved"])

    def test_ignores_findings_without_an_anchor(self):
        counts = self._record("job-1", [{"severity": "high"}, {"file": "pkg/beta.py"}])
        self.assertEqual(counts["recorded"], 0)

    def test_recording_the_same_review_twice_is_idempotent(self):
        self._record("job-1", [FINDING])
        self._record("job-1", [FINDING])

        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(len(context["pastSecurityReports"]), 1)


class PersistenceTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="consistency-memory-"))
        self.addCleanup(self._cleanup)
        self.path = self.root / "knowledge" / "repo.sqlite"

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def test_memory_survives_across_processes(self):
        first = KnowledgeIndex(self.path)
        first.index_files(SOURCE)
        first.record_review(
            job_id="job-1",
            reference="sha1",
            reported_at="2026-08-01T00:00:00.000Z",
            covered_files=list(SOURCE),
            findings=[FINDING],
        )
        first.close()

        # A later review opens the same database and still sees the history.
        second = KnowledgeIndex(self.path)
        self.addCleanup(second.close)
        second.index_files(SOURCE)
        context = get_relevant_context(second, ContextQuery(file="pkg/beta.py"))

        self.assertEqual(len(context["pastSecurityReports"]), 1)
        self.assertEqual(context["pastSecurityReports"][0]["title"], "Unvalidated input")

    def test_reindexing_does_not_erase_memory(self):
        index = KnowledgeIndex(self.path)
        self.addCleanup(index.close)
        index.index_files(SOURCE)
        index.record_review(
            job_id="job-1",
            reference="sha1",
            reported_at="2026-08-01T00:00:00.000Z",
            covered_files=list(SOURCE),
            findings=[FINDING],
        )

        # Memory tables have no foreign key to files, so pruning must not cascade.
        index.index_files({"pkg/beta.py": "def helper():\n    return 2\n"}, prune_missing=True)
        context = get_relevant_context(index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(len(context["pastSecurityReports"]), 1)


class RecordReviewBridgeTest(unittest.TestCase):
    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="consistency-memory-bridge-"))
        self.addCleanup(self._cleanup)
        self.path = str(self.root / "repo.sqlite")

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def test_bridge_records_and_reports_counts(self):
        request = RecordReviewRequest.from_dict({
            "id": "req-1",
            "action": "record_review",
            "index_path": self.path,
            "job_id": "job-1",
            "reference": "sha1",
            "reported_at": "2026-08-01T00:00:00.000Z",
            "covered_files": ["pkg/beta.py"],
            "findings": [FINDING],
        })
        response = run_record_review_request(request)

        self.assertTrue(response.ok)
        self.assertEqual(response.recorded, 1)
        self.assertEqual(response.resolved, 0)

    def test_rejects_a_request_missing_required_fields(self):
        with self.assertRaises(ValueError):
            RecordReviewRequest.from_dict({
                "id": "req-1",
                "action": "record_review",
                "index_path": "",
                "job_id": "job-1",
                "reference": "sha1",
                "reported_at": "2026-08-01T00:00:00.000Z",
            })


if __name__ == "__main__":
    unittest.main()
