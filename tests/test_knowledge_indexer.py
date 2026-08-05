"""Tests for the incremental code knowledge graph."""
import subprocess
import tempfile
import unittest
from pathlib import Path

from engine.knowledge.indexer import (
    KnowledgeIndex,
    content_sha,
    index_paths,
    language_for,
    module_name_for,
)

ALPHA = """\
from pkg import beta


class Widget:
    def render(self):
        return beta.helper()


def build():
    widget = Widget()
    return widget.render()
"""

BETA = """\
def helper():
    return 1
"""


def _index() -> KnowledgeIndex:
    return KnowledgeIndex(":memory:")


class HelpersTest(unittest.TestCase):
    def test_module_name_strips_package_init(self):
        self.assertEqual(module_name_for("pkg/__init__.py"), "pkg")
        self.assertEqual(module_name_for("pkg/alpha.py"), "pkg.alpha")
        self.assertEqual(module_name_for("pkg\\alpha.py"), "pkg.alpha")

    def test_language_detection(self):
        self.assertEqual(language_for("a.py"), "python")
        self.assertEqual(language_for("a.tsx"), "typescript")
        self.assertEqual(language_for("a.bin"), "unknown")

    def test_content_sha_is_stable(self):
        self.assertEqual(content_sha("x"), content_sha("x"))
        self.assertNotEqual(content_sha("x"), content_sha("y"))
        self.assertEqual(len(content_sha("x")), 64)


class IndexingTest(unittest.TestCase):
    def setUp(self):
        self.index = _index()
        self.addCleanup(self.index.close)

    def test_indexes_symbols_with_line_anchors(self):
        stats = self.index.index_files({"pkg/alpha.py": ALPHA, "pkg/beta.py": BETA})
        self.assertEqual(stats.indexed, 2)

        symbols = {row["name"]: row for row in self.index.symbols_for("pkg/alpha.py")}
        self.assertEqual(set(symbols), {"Widget", "render", "build"})
        self.assertEqual(symbols["Widget"]["kind"], "class")
        self.assertEqual(symbols["render"]["kind"], "method")
        self.assertEqual(symbols["render"]["qualified_name"], "Widget.render")
        self.assertEqual(symbols["build"]["kind"], "function")
        self.assertGreater(symbols["build"]["start_line"], 0)

    def test_records_imports(self):
        self.index.index_files({"pkg/alpha.py": ALPHA, "pkg/beta.py": BETA})
        rows = self.index.connection().execute(
            "SELECT module, symbol FROM imports WHERE file_path = 'pkg/alpha.py'"
        ).fetchall()
        self.assertEqual([(row["module"], row["symbol"]) for row in rows], [("pkg", "beta")])

    def test_builds_cross_file_call_edges(self):
        self.index.index_files({"pkg/alpha.py": ALPHA, "pkg/beta.py": BETA})
        rows = self.index.connection().execute(
            "SELECT caller_file, caller_symbol, callee_file, callee_symbol FROM calls"
            " WHERE callee_file = 'pkg/beta.py'"
        ).fetchall()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["caller_file"], "pkg/alpha.py")
        self.assertEqual(rows[0]["caller_symbol"], "Widget.render")
        self.assertEqual(rows[0]["callee_symbol"], "helper")

    def test_does_not_guess_at_ambiguous_callees(self):
        # `helper` is defined in two files, so no edge may be claimed.
        self.index.index_files({
            "pkg/alpha.py": ALPHA,
            "pkg/beta.py": BETA,
            "pkg/gamma.py": "def helper():\n    return 2\n",
        })
        rows = self.index.connection().execute(
            "SELECT * FROM calls WHERE callee_symbol = 'helper'"
        ).fetchall()
        self.assertEqual(rows, [])

    def test_skips_unparsable_files_without_failing(self):
        stats = self.index.index_files({"broken.py": "def (:\n"})
        self.assertEqual(stats.indexed, 1)
        self.assertEqual(self.index.symbols_for("broken.py"), [])

    def test_records_non_python_files_as_nodes(self):
        stats = self.index.index_files({"app.ts": "export const x = 1;\n"})
        self.assertEqual(stats.indexed, 1)
        row = self.index.connection().execute(
            "SELECT language FROM files WHERE path = 'app.ts'"
        ).fetchone()
        self.assertEqual(row["language"], "typescript")

    def test_skips_oversized_files(self):
        stats = self.index.index_files({"big.py": "x = 1\n" * 10_000}, max_file_bytes=100)
        self.assertEqual(stats.skipped, 1)
        self.assertEqual(stats.indexed, 0)


class IncrementalTest(unittest.TestCase):
    def setUp(self):
        self.index = _index()
        self.addCleanup(self.index.close)

    def test_unchanged_files_are_not_reindexed(self):
        files = {"pkg/alpha.py": ALPHA, "pkg/beta.py": BETA}
        self.assertEqual(self.index.index_files(files).indexed, 2)

        second = self.index.index_files(files)
        self.assertEqual(second.indexed, 0)
        self.assertEqual(second.unchanged, 2)

    def test_only_the_changed_file_is_reindexed(self):
        files = {"pkg/alpha.py": ALPHA, "pkg/beta.py": BETA}
        self.index.index_files(files)

        files["pkg/beta.py"] = "def helper():\n    return 42\n\n\ndef extra():\n    return 0\n"
        stats = self.index.index_files(files)

        self.assertEqual(stats.indexed, 1)
        self.assertEqual(stats.unchanged, 1)
        self.assertIn("extra", {row["name"] for row in self.index.symbols_for("pkg/beta.py")})

    def test_stale_symbols_are_replaced_not_duplicated(self):
        self.index.index_files({"pkg/beta.py": BETA})
        self.index.index_files({"pkg/beta.py": "def renamed():\n    return 1\n"})

        names = {row["name"] for row in self.index.symbols_for("pkg/beta.py")}
        self.assertEqual(names, {"renamed"})

    def test_pruning_removes_deleted_files(self):
        self.index.index_files({"a.py": "x = 1\n", "b.py": "y = 2\n"})
        stats = self.index.index_files({"a.py": "x = 1\n"})

        self.assertEqual(stats.removed, 1)
        self.assertEqual(set(self.index.indexed_files()), {"a.py"})

    def test_pruning_can_be_disabled_for_partial_updates(self):
        self.index.index_files({"a.py": "x = 1\n", "b.py": "y = 2\n"})
        stats = self.index.index_files({"a.py": "x = 2\n"}, prune_missing=False)

        self.assertEqual(stats.removed, 0)
        self.assertEqual(set(self.index.indexed_files()), {"a.py", "b.py"})


class GitIncrementalIntegrationTest(unittest.TestCase):
    """Indexes a real repository across real commits."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(prefix="consistency-knowledge-"))
        self.addCleanup(self._cleanup)
        self._git("init")
        self._git("symbolic-ref", "HEAD", "refs/heads/main")
        self._git("config", "user.name", "Test Runner")
        self._git("config", "user.email", "test@example.com")
        self._git("config", "commit.gpgsign", "false")

        (self.root / "pkg").mkdir()
        (self.root / "pkg" / "__init__.py").write_text("", encoding="utf-8")
        (self.root / "pkg" / "alpha.py").write_text(ALPHA, encoding="utf-8")
        (self.root / "pkg" / "beta.py").write_text(BETA, encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-m", "initial commit")

        self.index = KnowledgeIndex(self.root / ".consistency" / "knowledge_graph.sqlite")
        self.addCleanup(self.index.close)

    def _cleanup(self):
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def _git(self, *args: str) -> str:
        return subprocess.run(
            ["git", *args],
            cwd=self.root,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def _tracked(self) -> list[str]:
        listing = self._git("ls-files")
        return [line for line in listing.splitlines() if line.strip()]

    def test_index_persists_to_disk(self):
        index_paths(self.index, self.root, self._tracked())
        self.assertTrue((self.root / ".consistency" / "knowledge_graph.sqlite").exists())
        self.assertIn("pkg/alpha.py", self.index.indexed_files())

    def test_second_pass_over_an_unchanged_tree_does_no_work(self):
        index_paths(self.index, self.root, self._tracked())
        stats = index_paths(self.index, self.root, self._tracked())

        self.assertEqual(stats.indexed, 0)
        self.assertEqual(stats.unchanged, 3)

    def test_a_commit_reindexes_only_what_changed(self):
        index_paths(self.index, self.root, self._tracked())

        (self.root / "pkg" / "beta.py").write_text(
            "def helper():\n    return 99\n\n\ndef added_after_commit():\n    return 1\n",
            encoding="utf-8",
        )
        self._git("add", ".")
        self._git("commit", "-m", "change beta")

        stats = index_paths(self.index, self.root, self._tracked())
        self.assertEqual(stats.indexed, 1)
        self.assertEqual(stats.unchanged, 2)

        names = {row["name"] for row in self.index.symbols_for("pkg/beta.py")}
        self.assertIn("added_after_commit", names)

    def test_a_new_file_is_picked_up_after_commit(self):
        index_paths(self.index, self.root, self._tracked())

        (self.root / "pkg" / "gamma.py").write_text("def gamma():\n    return 3\n", encoding="utf-8")
        self._git("add", ".")
        self._git("commit", "-m", "add gamma")

        stats = index_paths(self.index, self.root, self._tracked())
        self.assertEqual(stats.indexed, 1)
        self.assertIn("pkg/gamma.py", self.index.indexed_files())


if __name__ == "__main__":
    unittest.main()
