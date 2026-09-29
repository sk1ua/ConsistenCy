"""Tests for the context augmentation API."""
import unittest

from engine.knowledge.context import ContextQuery, get_relevant_context
from engine.knowledge.indexer import KnowledgeIndex

ALPHA = """\
from pkg import beta


def build():
    return beta.helper()
"""

BETA = "def helper():\n    return 1\n"
GAMMA = "from pkg import beta\n\n\ndef also_uses():\n    return beta.helper()\n"
TEST_BETA = "from pkg import beta\n\n\ndef test_helper():\n    assert beta.helper() == 1\n"


class ContextTest(unittest.TestCase):
    def setUp(self):
        self.index = KnowledgeIndex(":memory:")
        self.addCleanup(self.index.close)
        self.index.index_files({
            "pkg/__init__.py": "",
            "pkg/alpha.py": ALPHA,
            "pkg/beta.py": BETA,
            "pkg/gamma.py": GAMMA,
            "tests/test_beta.py": TEST_BETA,
        })

    def test_returns_every_bucket_even_when_empty(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg/alpha.py"))
        self.assertEqual(
            set(context),
            {"historicalFixes", "relatedModules", "pastSecurityReports", "callerGraph"},
        )
        self.assertEqual(context["historicalFixes"], [])
        self.assertEqual(context["pastSecurityReports"], [])

    def test_finds_callers_of_the_queried_file(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        callers = {edge["callerFile"] for edge in context["callerGraph"]}
        self.assertEqual(callers, {"pkg/alpha.py", "pkg/gamma.py", "tests/test_beta.py"})
        for edge in context["callerGraph"]:
            self.assertEqual(edge["calleeSymbol"], "helper")
            self.assertEqual(edge["depth"], 1)

    def test_never_reports_a_file_as_its_own_caller(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertNotIn("pkg/beta.py", {edge["callerFile"] for edge in context["callerGraph"]})

    def test_identifies_importers_and_tests(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        relations = {module["path"]: module["relation"] for module in context["relatedModules"]}

        self.assertEqual(relations.get("pkg/alpha.py"), "imported_by")
        self.assertEqual(relations.get("pkg/gamma.py"), "imported_by")
        self.assertEqual(relations.get("tests/test_beta.py"), "test")

    def test_related_modules_are_ordered_by_weight(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        weights = [module["weight"] for module in context["relatedModules"]]
        self.assertEqual(weights, sorted(weights, reverse=True))

    def test_returns_recorded_project_memory(self):
        self.index.record_historical_fix(
            reference="1a30c2b",
            file="pkg/beta.py",
            summary="Fixed off-by-one in helper",
            fixed_at="2026-08-01T00:00:00.000Z",
            severity="high",
        )
        self.index.record_security_finding(
            job_id="job-1",
            file="pkg/beta.py",
            title="Unvalidated input",
            severity="critical",
            reported_at="2026-08-02T00:00:00.000Z",
        )

        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(len(context["historicalFixes"]), 1)
        self.assertEqual(context["historicalFixes"][0]["reference"], "1a30c2b")
        self.assertEqual(context["historicalFixes"][0]["severity"], "high")
        self.assertEqual(len(context["pastSecurityReports"]), 1)
        self.assertFalse(context["pastSecurityReports"][0]["resolved"])

    def test_memory_is_scoped_to_the_queried_file(self):
        self.index.record_historical_fix(
            reference="deadbee",
            file="pkg/alpha.py",
            summary="Unrelated fix",
            fixed_at="2026-08-01T00:00:00.000Z",
        )
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py"))
        self.assertEqual(context["historicalFixes"], [])

    def test_caps_every_bucket_at_the_limit(self):
        for number in range(30):
            self.index.record_historical_fix(
                reference=f"sha{number}",
                file="pkg/beta.py",
                summary=f"Fix {number}",
                fixed_at=f"2026-08-{(number % 28) + 1:02d}T00:00:00.000Z",
            )
        context = get_relevant_context(self.index, ContextQuery(file="pkg/beta.py", limit=5))
        self.assertEqual(len(context["historicalFixes"]), 5)

    def test_clamps_an_abusive_limit(self):
        self.assertEqual(ContextQuery(file="a.py", limit=10_000).bounded_limit(), 50)
        self.assertEqual(ContextQuery(file="a.py", limit=0).bounded_limit(), 1)

    def test_windows_style_paths_are_normalised(self):
        context = get_relevant_context(self.index, ContextQuery(file="pkg\\beta.py"))
        self.assertTrue(context["callerGraph"])

    def test_unknown_file_returns_empty_buckets_rather_than_failing(self):
        context = get_relevant_context(self.index, ContextQuery(file="not/indexed.py"))
        self.assertEqual(context["historicalFixes"], [])
        self.assertEqual(context["callerGraph"], [])


if __name__ == "__main__":
    unittest.main()
