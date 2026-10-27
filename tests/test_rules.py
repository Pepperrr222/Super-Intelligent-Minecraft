from __future__ import annotations
import unittest
import tempfile
from pathlib import Path
from sim_agent.planning.rules import parse_command, number, RulePlanner
from sim_agent.execution.runner import TaskRunner
from sim_agent.adapters.mock import MockBackend
from test_planner import make_config


class RuleTests(unittest.IsolatedAsyncioTestCase):
    def test_chinese_numbers_and_unambiguous_binding(self):
        self.assertEqual(number("十二"), 12)
        self.assertEqual(number("两"), 2)
        p = parse_command("从坐标0 64 0的箱子拿两个橡木原木，做成八块橡木木板，放入坐标4 64 0的箱子")
        self.assertEqual(p["input_count"], 2)
        self.assertEqual(p["count"], 8)
        self.assertEqual(p["item"], "minecraft:oak_planks")
        self.assertIsNone(parse_command("放进那个箱子"))

    async def test_rule_delivery_executes_without_api(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = MockBackend()
            backend.containers[4]["minecraft:oak_planks"] = 5
            outcome = await TaskRunner(backend, RulePlanner(), make_config(Path(tmp), max_steps=12)).run(
                "从坐标0 64 0的箱子取2个橡木原木，合成8块橡木木板，放入坐标4 64 0的箱子，不砍树")
            self.assertTrue(outcome.completed, outcome.error)
            self.assertEqual(backend.containers[4]["minecraft:oak_planks"], 13)

    async def test_unknown_command_clarifies(self):
        with tempfile.TemporaryDirectory() as tmp:
            outcome = await TaskRunner(MockBackend(), RulePlanner(), make_config(Path(tmp))).run("把那些东西放进去")
            self.assertEqual(outcome.end_state, "needs_clarification")
