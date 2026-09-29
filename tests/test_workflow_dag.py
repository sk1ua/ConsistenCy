"""Tests for the workflow dependency graph."""
import unittest

from engine.workflow.dag import Dag, DagNode, WorkflowGraphError


class DagTest(unittest.TestCase):
    def test_groups_independent_steps_into_one_level(self):
        dag = Dag([
            DagNode("a"),
            DagNode("b"),
            DagNode("c", ("a", "b")),
        ])
        self.assertEqual(dag.levels(), (("a", "b"), ("c",)))

    def test_orders_a_linear_chain(self):
        dag = Dag([
            DagNode("third", ("second",)),
            DagNode("second", ("first",)),
            DagNode("first"),
        ])
        self.assertEqual(dag.levels(), (("first",), ("second",), ("third",)))

    def test_levels_are_deterministic(self):
        nodes = [DagNode("zulu"), DagNode("alpha"), DagNode("mike")]
        self.assertEqual(Dag(nodes).levels(), (("alpha", "mike", "zulu"),))

    def test_rejects_a_cycle(self):
        with self.assertRaisesRegex(WorkflowGraphError, "cycle"):
            Dag([DagNode("a", ("b",)), DagNode("b", ("a",))])

    def test_rejects_a_longer_cycle(self):
        with self.assertRaisesRegex(WorkflowGraphError, "cycle"):
            Dag([DagNode("a", ("c",)), DagNode("b", ("a",)), DagNode("c", ("b",))])

    def test_rejects_self_dependency(self):
        with self.assertRaisesRegex(WorkflowGraphError, "cannot depend on itself"):
            Dag([DagNode("a", ("a",))])

    def test_rejects_unknown_dependency(self):
        with self.assertRaisesRegex(WorkflowGraphError, "unknown step 'ghost'"):
            Dag([DagNode("a", ("ghost",))])

    def test_rejects_duplicate_ids(self):
        with self.assertRaisesRegex(WorkflowGraphError, "Duplicate step id"):
            Dag([DagNode("a"), DagNode("a")])

    def test_transitive_dependents_covers_the_whole_downstream(self):
        dag = Dag([
            DagNode("root"),
            DagNode("mid", ("root",)),
            DagNode("leaf", ("mid",)),
            DagNode("unrelated"),
        ])
        self.assertEqual(dag.transitive_dependents("root"), ("leaf", "mid"))
        self.assertEqual(dag.transitive_dependents("mid"), ("leaf",))
        self.assertEqual(dag.transitive_dependents("leaf"), ())
        self.assertEqual(dag.transitive_dependents("unrelated"), ())

    def test_empty_graph_is_allowed(self):
        self.assertEqual(Dag([]).levels(), ())


if __name__ == "__main__":
    unittest.main()
