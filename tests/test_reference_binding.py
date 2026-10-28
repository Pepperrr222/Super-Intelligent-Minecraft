from __future__ import annotations
import tempfile
from pathlib import Path
import unittest
from sim_agent.domain.references import unresolved_reference
from sim_agent.domain.validation import validate_step
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.constraints import validate_reserved_goal
from sim_agent.domain.goals import parse_goal
from sim_agent.execution.runner import TaskRunner
from test_planner import FakeBackend, ScriptedPlanner, make_config, observation


class ReferenceBindingTests(unittest.IsolatedAsyncioTestCase):
    async def test_reserved_lower_bound_rejects_extra_exact_goal_before_action(self):
        with tempfile.TemporaryDirectory() as tmp:
            product = {"type": "inventory_increase", "item": "minecraft:stick", "count": 4}
            extra = {"type": "inventory_delta", "item": "minecraft:oak_planks", "delta": 0}
            planner = ScriptedPlanner([
                {"goal": {"type": "all_of", "goals": [product, extra]}, "step": {"op": "act", "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 1}}},
                {"goal": product, "step": {"op": "finish", "args": {}}},
            ])
            backend = FakeBackend([observation({"minecraft:oak_planks": 3}), observation({"minecraft:oak_planks": 5, "minecraft:stick": 4})])
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("保留三块橡木木板，额外做四根木棍")
            self.assertEqual(outcome.end_state, "completed")
            self.assertEqual(outcome.goal, product)
            self.assertEqual(backend.act_calls, 0)
            self.assertTrue(any("inventory_delta=0" in (s.get("error") or "") for s in outcome.steps))

    def test_explicit_unchanged_stock_and_delivery_conservation_remain_valid(self):
        stock = {"type": "inventory_delta", "item": "minecraft:oak_planks", "delta": 0}
        keep = {"keep_inventory": {"minecraft:oak_planks": 3}}
        validate_reserved_goal(parse_goal(stock), keep, "保留三块橡木木板，最终数量不变")
        delivery = {"type": "container_delta", "item": "minecraft:oak_planks", "delta": 8, "position": {"x": 8, "y": 64, "z": 0}}
        validate_reserved_goal(parse_goal({"type": "all_of", "goals": [stock, delivery]}), keep, "保留三块橡木木板，再做八块交付")

    async def test_clarification_with_proposed_goal_never_inspects_or_moves(self):
        with tempfile.TemporaryDirectory() as tmp:
            goal = {"type": "container_delta", "position": {"x": 30, "y": 64, "z": 0}, "item": "minecraft:oak_planks", "delta": 8}
            planner = ScriptedPlanner([{"goal": goal, "constraints": {"keep_inventory": {"minecraft:oak_planks": 64}}, "step": {"op": "clarify", "args": {"question": "哪个箱子？"}}}])
            backend = FakeBackend([observation()])
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("把那些东西放到那个箱子")
            self.assertEqual(outcome.end_state, "needs_clarification")
            self.assertIsNone(outcome.goal)
            self.assertEqual(backend.inspect_calls, 0)
            self.assertEqual(backend.act_calls, 0)

    def test_unbound_deictic_references_are_not_coordinates(self):
        self.assertIsNotNone(unresolved_reference("把那些东西放到那个箱子里。"))
        self.assertIsNone(unresolved_reference("把2块橡木木板放入坐标8 -60 0的箱子"))
        self.assertIsNone(unresolved_reference("从坐标0,-60,-4取原木，放进坐标8,-60,0的箱子"))

    async def test_hallucinated_container_goal_is_rejected_before_baseline_inspection(self):
        with tempfile.TemporaryDirectory() as tmp:
            guessed_goal = {"type": "container_delta", "position": {"x": 3, "y": 64, "z": 0}, "item": "minecraft:oak_planks", "delta": 4}
            planner = ScriptedPlanner([
                {"goal": guessed_goal, "step": {"op": "act", "args": {"kind": "deposit", "position": guessed_goal["position"], "item": "minecraft:oak_planks", "count": 4}}},
                {"step": {"op": "clarify", "args": {"question": "请说明物品、数量和目标箱子坐标。"}}},
            ])
            backend = FakeBackend([observation({"minecraft:oak_planks": 4})])
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("把那些东西放到那个箱子里")
            self.assertEqual(outcome.end_state, "needs_clarification")
            self.assertEqual(backend.inspect_calls, 0)
            self.assertEqual(backend.act_calls, 0)
            self.assertIsNone(outcome.goal)

    def test_flat_action_is_rejected_with_a_precise_nested_example(self):
        with self.assertRaises(ValidationError) as exc:
            validate_step({"op": "withdraw", "args": {"position": {"x": 3, "y": 64, "z": 0}, "item": "minecraft:oak_log", "count": 2}})
        self.assertIn('"op":"act"', str(exc.exception))
        self.assertIn('"kind":"withdraw"', str(exc.exception))
