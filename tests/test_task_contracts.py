from __future__ import annotations
import asyncio
from pathlib import Path
import tempfile
import unittest
from sim_agent.adapters.mock import MockBackend, SOURCE, TARGET
from sim_agent.app.demo import DemoPlanner
from sim_agent.domain.constraints import explicit_constraints, guard_action
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.goals import GoalVerifier, parse_goal
from sim_agent.domain.state import TaskState
from sim_agent.execution.runner import TaskRunner
from sim_agent.execution.service import AgentService
from test_planner import make_config, observation, ScriptedPlanner, BlockingPlanner, FakeBackend


def delivery_goal():
    return {"type": "all_of", "goals": [
        {"type": "container_delta", "position": SOURCE, "item": "minecraft:oak_log", "delta": -2},
        {"type": "container_delta", "position": TARGET, "item": "minecraft:oak_planks", "delta": 8},
        {"type": "inventory_delta", "item": "minecraft:oak_planks", "delta": 0},
        {"type": "inventory_delta", "item": "minecraft:oak_log", "delta": 0},
    ]}


class TaskContracts(unittest.IsolatedAsyncioTestCase):
    def test_unknown_delta_inventory_is_not_zero(self):
        state = TaskState("id", "保持库存")
        state.start_inventory = {}
        goal = parse_goal({"type": "inventory_delta", "item": "minecraft:oak_planks", "delta": 0})
        result = GoalVerifier().verify(goal, state, observation={"connected": True})
        self.assertFalse(result.ok)
    async def test_final_position_is_refreshed_after_container_navigation(self):
        with tempfile.TemporaryDirectory() as tmp:
            goal = {"type": "all_of", "goals": [
                {"type": "near_position", "position": {"x": 0, "y": 64, "z": 0}, "range": 1},
                {"type": "container_at_least", "position": {"x": 4, "y": 64, "z": 0}, "item": "minecraft:oak_planks", "count": 8}]}
            backend = FakeBackend([observation(), observation(), observation(x=4)], inspect_results=[{"position": {"x": 4, "y": 64, "z": 0}, "items": [{"name": "minecraft:oak_planks", "count": 8}]}])
            planner = ScriptedPlanner([{"goal": goal, "step": {"op": "finish", "args": {}}}], repeat_last=True)
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("检查箱子后仍需在原点")
            self.assertFalse(outcome.completed)
            self.assertEqual(outcome.final_observation["position"]["x"], 4)

    def test_task_spec_does_not_treat_proposed_bindings_as_observed(self):
        state = TaskState("id", "交付")
        state.apply_observation(observation())
        state.set_goal(parse_goal({"type": "container_at_least", "position": TARGET, "item": "minecraft:oak_planks", "count": 8}))
        binding = next(iter(state.task_spec()["bindings"].values()))
        self.assertFalse(binding["observed"])
        state.apply_query_result("inspect_container", {"container": {"position": TARGET, "items": [], "world_id": "basic-lab-v1", "observed_at": "2026-10-28T00:00:00+08:00"}})
        binding = next(iter(state.task_spec()["bindings"].values()))
        self.assertTrue(binding["observed"])
        self.assertEqual(state.task_spec()["task_version"], 1)

    async def test_clarification_answer_retains_original_request(self):
        class ClarifyingPlanner:
            def __init__(self): self.contexts = []
            async def decide(self, context, timeout):
                from sim_agent.planning.planner import PlannerReply
                import json
                self.contexts.append(context)
                if context["state"].get("continuation_context"):
                    value = {"goal": {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}, "step": {"op": "finish", "args": {}}}
                else:
                    value = {"step": {"op": "clarify", "args": {"question": "请给出来源坐标"}}}
                return PlannerReply(json.dumps(value), {}, "clarification-test", 0)
        with tempfile.TemporaryDirectory() as tmp:
            planner = ClarifyingPlanner()
            config = make_config(Path(tmp))
            service = AgentService(FakeBackend([observation({"minecraft:oak_log": 4})]), planner, config, chat_progress=False)
            await service.handle_chat(config.agent.owner, "!agent 取那些原木")
            await service._wait_current(2)
            self.assertEqual(service._last_outcome.end_state, "needs_clarification")
            await service.handle_chat(config.agent.owner, "!agent 回答 来源坐标0 64 0")
            await service._wait_current(3)
            self.assertTrue(service._last_outcome.completed)
            prior = planner.contexts[-1]["state"]["continuation_context"]
            self.assertEqual(prior["original_task"], "取那些原木")
            self.assertEqual(prior["answer"], "来源坐标0 64 0")
            await service.shutdown()

    async def test_progress_is_coalesced_before_game_chat(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = FakeBackend([observation()])
            service = AgentService(backend, ScriptedPlanner([]), make_config(Path(tmp)), emit=lambda _: None)
            for i in range(10):
                await service._notify_progress(f"进度{i}")
            self.assertEqual(len(backend.say_calls), 1)

    async def test_cancel_preserves_action_that_finished_at_stop(self):
        class PartialBackend(FakeBackend):
            stopped = False
            async def request(self, op, args, timeout=None):
                if self.stopped and op == "observe":
                    return observation({"minecraft:oak_planks": 8})
                if self.stopped and op == "action_status":
                    return {"action_id": args["action_id"], "status": "succeeded", "effect": {"produced": 8}}
                return await super().request(op, args, timeout)
            async def stop(self):
                self.stopped = True
                await super().stop()
                return {"stopped": True, "action_id": "a1"}
        with tempfile.TemporaryDirectory() as tmp:
            goal = {"type": "inventory_increase", "item": "minecraft:oak_planks", "count": 8}
            backend = PartialBackend([observation()], action_statuses=["running"])
            planner = ScriptedPlanner([{"goal": goal, "step": {"op": "act", "args": {"kind": "craft", "item": "minecraft:oak_planks", "count": 8}}}])
            runner = TaskRunner(backend, planner, make_config(Path(tmp)))
            task = asyncio.create_task(runner.run("制作8块木板"))
            async with asyncio.timeout(1):
                while backend.act_calls == 0:
                    await asyncio.sleep(0.01)
            await runner.cancel("更换目标")
            outcome = await task
            self.assertEqual(outcome.end_state, "cancelled")
            self.assertEqual(outcome.final_observation["inventory"][0]["count"], 8)
            self.assertEqual(outcome.steps[-1]["status"], "succeeded")
            self.assertTrue(outcome.steps[-1]["evidence"]["partial_effects_preserved"])

    async def test_stop_invalidates_pending_correction(self):
        with tempfile.TemporaryDirectory() as tmp:
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 2}
            planner = BlockingPlanner({"goal": goal, "step": {"op": "act", "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 2}}})
            backend = FakeBackend([observation()])
            config = make_config(Path(tmp))
            service = AgentService(backend, planner, config, emit=lambda _: None)
            await service.handle_chat(config.agent.owner, "!agent 取原木")
            await planner.started.wait()
            await service.handle_chat(config.agent.owner, "!agent 纠正 改取木板")
            await service.handle_chat(config.agent.owner, "!agent 停止")
            await asyncio.sleep(0.1)
            self.assertEqual(backend.act_calls, 0)
            self.assertFalse(any(c["state"].get("continuation_context") for c in planner.calls))
            await service.shutdown()

    async def test_composite_delivery_uses_existing_stock_baselines(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = MockBackend()
            backend.containers[4]["minecraft:oak_planks"] = 5
            backend.inventory["minecraft:oak_planks"] = 3
            planner = DemoPlanner()
            planner.goal = delivery_goal()
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("取料合成交付")
            self.assertEqual(outcome.end_state, "completed", outcome.error)
            self.assertEqual(backend.containers[4]["minecraft:oak_planks"], 13)
            self.assertEqual(backend.inventory["minecraft:oak_planks"], 3)
            self.assertEqual(len(outcome.verification["evidence"]["checks"]), 4)

    async def test_existing_target_items_cannot_fake_new_delivery(self):
        with tempfile.TemporaryDirectory() as tmp:
            backend = MockBackend()
            backend.containers[4]["minecraft:oak_planks"] = 8
            goal = {"type": "container_delta", "position": TARGET, "item": "minecraft:oak_planks", "delta": 8}
            planner = ScriptedPlanner([{"goal": goal, "step": {"op": "finish", "args": {}}}], repeat_last=True)
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("新增交付8木板")
            self.assertNotEqual(outcome.end_state, "completed")
            self.assertEqual(backend.containers[4]["minecraft:oak_planks"], 8)

    async def test_no_collect_is_enforced_when_model_omits_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 2}
            planner = ScriptedPlanner([{"goal": goal, "step": {"op": "act", "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 2}}}], repeat_last=True)
            backend = FakeBackend([observation()])
            outcome = await TaskRunner(backend, planner, make_config(Path(tmp))).run("不砍树，拿两个原木")
            self.assertNotEqual(outcome.end_state, "completed")
            self.assertEqual(backend.act_calls, 0)

    async def test_correction_cancels_late_plan_and_versions_continuation(self):
        with tempfile.TemporaryDirectory() as tmp:
            old_goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 2}
            late = BlockingPlanner({"goal": old_goal, "step": {"op": "act", "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 2}}})
            backend = FakeBackend([observation()])
            config = make_config(Path(tmp))
            service = AgentService(backend, late, config, emit=lambda _: None)
            await service.handle_chat(config.agent.owner, "!agent 取两个原木")
            await asyncio.wait_for(late.started.wait(), 1)
            self.assertEqual(await service.handle_chat(config.agent.owner, "!agent 纠正 改为查看当前位置"), "correcting")
            async with asyncio.timeout(4):
                while not any(c["state"].get("continuation_context") for c in late.calls):
                    await asyncio.sleep(0.02)
            self.assertEqual(backend.act_calls, 0)
            # Continuation is a new version and receives previous real progress.
            self.assertTrue(any(c["state"].get("continuation_context") for c in late.calls))
            self.assertTrue(any(c["state"]["task_version"] == 2 for c in late.calls))
            await service.shutdown()

    def test_reserved_materials_block_deposit_and_craft(self):
        constraints = explicit_constraints("不要移动，不砍树，保留四块木板")
        self.assertTrue(constraints["no_move"])
        self.assertTrue(constraints["no_collect"])
        self.assertEqual(constraints["keep_inventory"]["minecraft:oak_planks"], 4)
        keep = {"keep_inventory": {"minecraft:oak_planks": 4}}
        obs = observation({"minecraft:oak_planks": 5})
        with self.assertRaises(ValidationError):
            guard_action(keep, "act", {"kind": "deposit", "item": "minecraft:oak_planks", "count": 2}, obs)
        recipe = [{"result": {"name": "minecraft:stick", "count": 4}, "ingredients": [{"name": "minecraft:oak_planks", "count": 2}]}]
        with self.assertRaises(ValidationError):
            guard_action(keep, "act", {"kind": "craft", "item": "minecraft:stick", "count": 4}, obs, recipe)

    def test_composite_depth_is_bounded(self):
        goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 1}
        for _ in range(4):
            goal = {"type": "all_of", "goals": [goal]}
        with self.assertRaises(ValidationError):
            parse_goal(goal)
