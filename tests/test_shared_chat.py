"""Shared player access keeps the existing single-task and stop guarantees."""
from dataclasses import replace
from pathlib import Path
import asyncio
import tempfile
import unittest

from sim_agent.execution.service import AgentService
from test_planner import BlockingPlanner, FakeBackend, ScriptedPlanner, make_config, observation, wait_until


class SharedChatTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = make_config(Path(self.tmp.name))
        self.config = replace(config, agent=replace(config.agent, owner="*"))

    async def asyncTearDown(self):
        self.tmp.cleanup()

    async def test_three_players_can_each_start_a_task(self):
        goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}
        planner = ScriptedPlanner([{"goal": goal, "step": {"op": "finish", "args": {}}} for _ in range(3)])
        backend = FakeBackend([observation({"minecraft:oak_log": 4})])
        service = AgentService(backend, planner, self.config, emit=lambda _: None, chat_progress=False)
        try:
            self.assertEqual(await service.handle_chat("PlayerA", "普通聊天"), "ignored")
            self.assertEqual(await service.handle_chat(self.config.minecraft.username, "!agent 测试"), "ignored")
            for player in ["PlayerA", "PlayerB", "PlayerC"]:
                self.assertEqual(await service.handle_chat(player, "!agent 检查四个原木"), "started")
                await service._wait_current(timeout=3)
                self.assertFalse(service.busy)
                self.assertTrue(service._last_outcome.completed)
            self.assertEqual(len(planner.calls), 3)
        finally:
            await service.shutdown()

    async def test_second_player_cannot_overlap_and_third_can_stop(self):
        planner = BlockingPlanner({"goal": {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 1}, "step": {"op": "observe", "args": {}}})
        backend = FakeBackend([observation()])
        service = AgentService(backend, planner, self.config, emit=lambda _: None, chat_progress=False)
        try:
            self.assertEqual(await service.handle_chat("PlayerA", "!agent 收集原木"), "started")
            await asyncio.wait_for(planner.started.wait(), 2)
            self.assertEqual(await service.handle_chat("PlayerB", "!agent 另一个任务"), "busy")
            self.assertEqual(await service.handle_chat("PlayerC", "!agent 停止"), "cancelled")
            planner.release.set()
            await wait_until(lambda: not service.busy)
            self.assertEqual(service._last_outcome.end_state, "cancelled")
            self.assertEqual(len(planner.calls), 1)
            self.assertGreaterEqual(backend.stop_calls, 1)
            self.assertEqual(backend.act_calls, 0)
        finally:
            planner.release.set()
            await service.shutdown()

    async def test_another_player_can_answer_shared_clarification(self):
        planner = ScriptedPlanner([
            {"step": {"op": "clarify", "args": {"question": "要多少原木？"}}},
            {"goal": {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}, "step": {"op": "finish", "args": {}}},
        ])
        service = AgentService(FakeBackend([observation({"minecraft:oak_log": 4})]), planner, self.config, emit=lambda _: None, chat_progress=False)
        try:
            self.assertEqual(await service.handle_chat("PlayerA", "!agent 检查原木"), "started")
            await service._wait_current(timeout=3)
            self.assertEqual(service._last_outcome.end_state, "needs_clarification")
            self.assertEqual(await service.handle_chat("PlayerB", "!agent 回答 四个"), "started")
            await service._wait_current(timeout=3)
            self.assertTrue(service._last_outcome.completed)
            self.assertEqual(planner.calls[-1]["state"]["continuation_context"]["answer"], "四个")
        finally:
            await service.shutdown()
