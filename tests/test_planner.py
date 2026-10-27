"""Tests for validation, task policy, goal verification and transport use.

These tests use injected fake planner/backend implementations; they never
launch Node, Minecraft or a game server.  The only subprocess is a tiny Python
JSONL fixture used to exercise request correlation/timeouts.
"""

from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from basic_agent.config import (  # noqa: E402
    AgentConfig,
    AppConfig,
    MinecraftConfig,
    ModelConfig,
)
from basic_agent.errors import TransportTimeout, ValidationError  # noqa: E402
from basic_agent.goals import parse_goal  # noqa: E402
from basic_agent.jsonl import RuntimeLogs  # noqa: E402
from basic_agent.planner import PlannerReply  # noqa: E402
from basic_agent.runner import TaskRunner  # noqa: E402
from basic_agent.service import AgentService  # noqa: E402
from basic_agent.state import TaskState  # noqa: E402
from basic_agent.transport import ExecutorClient  # noqa: E402
from basic_agent.validation import parse_decision, validate_step  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------
def observation(
    inventory: dict[str, int] | None = None,
    *,
    world: str = "basic-lab-v1",
    x: float = 0.0,
    y: float = 64.0,
    z: float = 0.0,
) -> dict[str, Any]:
    return {
        "connected": True,
        "world_id": world,
        "observed_at": "2026-10-27T20:00:00+00:00",
        "username": "BasicAgent",
        "position": {"x": x, "y": y, "z": z},
        "health": 20,
        "food": 20,
        "dimension": "minecraft:overworld",
        "inventory": [
            {"name": name, "count": count}
            for name, count in (inventory or {}).items()
        ],
        "nearby_players": [],
        "capabilities": ["observe", "act"],
    }


def make_config(
    root: Path,
    *,
    max_steps: int = 8,
    task_timeout: float = 3.0,
    poll_seconds: float = 0.01,
) -> AppConfig:
    root.mkdir(parents=True, exist_ok=True)
    return AppConfig(
        minecraft=MinecraftConfig(
            host="127.0.0.1",
            port=25575,
            version="1.21.1",
            username="BasicAgent",
            auth="offline",
            world_id="basic-lab-v1",
        ),
        agent=AgentConfig(
            owner="Doctor_Pepper",
            prefix="!agent ",
            max_steps=max_steps,
            task_timeout_seconds=task_timeout,
            poll_seconds=poll_seconds,
        ),
        model=ModelConfig(
            base_url="https://example.invalid",
            name="fake-model",
            key_file=root / "never-read.key",
            timeout_seconds=1.0,
        ),
        runtime_dir=root / "runtime",
        config_path=root / "config.json",
        raw={},
    )


class FakeBackend:
    def __init__(
        self,
        observations: list[dict[str, Any]],
        *,
        inspect_results: list[dict[str, Any]] | None = None,
        action_statuses: list[str] | None = None,
        hang_observe: bool = False,
    ) -> None:
        self.observations = list(observations)
        self.inspect_results = list(inspect_results or [])
        self.action_statuses = list(action_statuses or ["running", "succeeded"])
        self.hang_observe = hang_observe
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.say_calls: list[str] = []
        self.stop_calls = 0
        self.start_calls = 0
        self.shutdown_calls = 0
        self.observe_calls = 0
        self.act_calls = 0
        self.status_calls: dict[str, int] = {}
        self.inspect_calls = 0
        self._observe_index = 0
        self._inspect_index = 0
        self._action_serial = 0
        self._statuses: dict[str, list[str]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def start(self, timeout: float | None = None) -> dict[str, Any]:
        self.start_calls += 1
        return {
            "username": "BasicAgent",
            "version": "1.21.1",
            "world_id": "basic-lab-v1",
        }

    async def next_event(self, timeout: float | None = None) -> dict[str, Any]:
        if timeout is None:
            return await self._events.get()
        return await asyncio.wait_for(self._events.get(), timeout=timeout)

    def push_event(self, event: dict[str, Any]) -> None:
        self._events.put_nowait(event)

    async def request(
        self, op: str, args: dict[str, Any], timeout: float | None = None
    ) -> dict[str, Any]:
        self.calls.append((op, args))
        if op == "observe":
            self.observe_calls += 1
            if self.hang_observe:
                await asyncio.Event().wait()
            if not self.observations:
                raise AssertionError("fake backend has no observations")
            if self._observe_index < len(self.observations):
                value = self.observations[self._observe_index]
                self._observe_index += 1
            else:
                value = self.observations[-1]
            return value
        if op == "act":
            self.act_calls += 1
            self._action_serial += 1
            action_id = f"a{self._action_serial}"
            self._statuses[action_id] = list(self.action_statuses)
            return {"action_id": action_id, "status": "running"}
        if op == "action_status":
            action_id = args.get("action_id")
            if not isinstance(action_id, str) or action_id not in self._statuses:
                return {
                    "action_id": action_id,
                    "status": "failed",
                    "error": {"message": "unknown action"},
                }
            self.status_calls[action_id] = self.status_calls.get(action_id, 0) + 1
            queue = self._statuses[action_id]
            if not queue:
                status = "succeeded"
            elif len(queue) > 1:
                status = queue.pop(0)
            else:
                status = queue[0]
            return {"action_id": action_id, "status": status}
        if op == "inspect_container":
            self.inspect_calls += 1
            if not self.inspect_results:
                raise AssertionError("fake backend has no container results")
            if self._inspect_index < len(self.inspect_results):
                value = self.inspect_results[self._inspect_index]
                self._inspect_index += 1
            else:
                value = self.inspect_results[-1]
            return value
        if op == "say":
            message = args.get("message")
            if isinstance(message, str):
                self.say_calls.append(message)
            return {"sent": True}
        if op == "stop":
            self.stop_calls += 1
            return {"stopped": True}
        if op == "find_blocks":
            return {"blocks": [], "observed_at": "2026-10-27T20:00:00+00:00"}
        if op == "recipes":
            return {"recipes": []}
        if op == "shutdown":
            self.shutdown_calls += 1
            return {}
        raise AssertionError(f"unexpected fake op {op}")

    async def stop(self) -> dict[str, Any]:
        self.stop_calls += 1
        return {"stopped": True}

    async def shutdown(self) -> None:
        self.shutdown_calls += 1


def decision(value: dict[str, Any]) -> PlannerReply:
    return PlannerReply(
        text=json.dumps(value, ensure_ascii=False),
        usage={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
        model="fake-model",
        latency_ms=1,
    )


class ScriptedPlanner:
    def __init__(self, decisions: list[dict[str, Any]], *, repeat_last: bool = False) -> None:
        self.decisions = list(decisions)
        self.repeat_last = repeat_last
        self.calls: list[dict[str, Any]] = []

    async def decide(self, context: dict[str, Any], timeout: float) -> PlannerReply:
        self.calls.append(context)
        if not self.decisions:
            raise AssertionError("scripted planner ran out of decisions")
        index = len(self.calls) - 1
        if index < len(self.decisions):
            value = self.decisions[index]
        elif self.repeat_last:
            value = self.decisions[-1]
        else:
            value = {"step": {"op": "observe", "args": {}}}
        return decision(value)


class BlockingPlanner:
    """Returns after cancellation to simulate a late model response."""

    def __init__(self, late: dict[str, Any]) -> None:
        self.late = late
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.calls: list[dict[str, Any]] = []

    async def decide(self, context: dict[str, Any], timeout: float) -> PlannerReply:
        self.calls.append(context)
        self.started.set()
        try:
            await asyncio.shield(self.release.wait())
        except asyncio.CancelledError:
            return decision(self.late)
        return decision(self.late)


class IgnoringCancellationPlanner:
    """Stubbornly finishes only after cancellation, like a late HTTP response."""

    def __init__(self, late: dict[str, Any]) -> None:
        self.late = late
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.finished = asyncio.Event()
        self.calls = 0

    async def decide(self, context: dict[str, Any], timeout: float) -> PlannerReply:
        self.calls += 1
        self.started.set()
        try:
            await asyncio.sleep(30)
        except asyncio.CancelledError:
            # Deliberately ignore cancellation for a while.
            await self.release.wait()
            self.finished.set()
            return decision(self.late)
        return decision(self.late)


async def wait_until(predicate, timeout: float = 2.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("condition was not reached in time")


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------
class PolicyTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.config = make_config(self.root)

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_unauthorized_player_cannot_start_task(self) -> None:
        backend = FakeBackend([observation()])
        planner = ScriptedPlanner([])
        service = AgentService(
            backend, planner, self.config, emit=lambda text: None, chat_progress=False
        )
        result = await service.handle_chat("EvilPlayer", "!agent 收集 4 个橡木原木")
        self.assertEqual(result, "unauthorized")
        self.assertEqual(planner.calls, [])
        self.assertGreaterEqual(backend.start_calls, 0)
        self.assertEqual(backend.say_calls, [])
        self.assertFalse(service.busy)

    async def test_cancel_ignores_late_planner_output(self) -> None:
        backend = FakeBackend([observation()])
        late = {
            "goal": {
                "type": "inventory_at_least",
                "item": "minecraft:oak_log",
                "count": 1,
            },
            "step": {"op": "finish", "args": {}},
        }
        planner = BlockingPlanner(late)
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        task = asyncio.create_task(runner.run("收集一个原木"))
        await asyncio.wait_for(planner.started.wait(), timeout=2)
        self.assertTrue(await runner.cancel("玩家停止任务"))
        planner.release.set()
        outcome = await asyncio.wait_for(task, timeout=2)
        self.assertEqual(outcome.end_state, "cancelled")
        self.assertIn("取消", outcome.message)
        self.assertGreaterEqual(backend.stop_calls, 1)
        self.assertEqual(backend.act_calls, 0)
        self.assertEqual(len(planner.calls), 1)

    async def test_cancel_does_not_wait_for_stubborn_late_planner(self) -> None:
        backend = FakeBackend([observation()])
        planner = IgnoringCancellationPlanner(
            {
                "goal": {
                    "type": "inventory_at_least",
                    "item": "minecraft:oak_log",
                    "count": 1,
                },
                "step": {"op": "finish", "args": {}},
            }
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        task = asyncio.create_task(runner.run("会被停止"))
        await asyncio.wait_for(planner.started.wait(), timeout=2)
        started = time.monotonic()
        await runner.cancel("玩家停止任务")
        outcome = await asyncio.wait_for(task, timeout=1.0)
        elapsed = time.monotonic() - started
        self.assertEqual(outcome.end_state, "cancelled")
        self.assertLess(elapsed, 0.5)
        # Release the late response; its finish decision must be discarded.
        planner.release.set()
        await asyncio.wait_for(planner.finished.wait(), timeout=2)
        await asyncio.sleep(0)
        self.assertEqual(outcome.end_state, "cancelled")
        self.assertIsNone(outcome.goal)

    async def test_busy_task_is_rejected_without_queue(self) -> None:
        backend = FakeBackend([observation()])
        planner = BlockingPlanner(
            {
                "goal": {
                    "type": "inventory_at_least",
                    "item": "minecraft:oak_log",
                    "count": 1,
                },
                "step": {"op": "observe", "args": {}},
            }
        )
        service = AgentService(
            backend, planner, self.config, emit=lambda text: None, chat_progress=True
        )
        first = await service.handle_chat("Doctor_Pepper", "!agent 做点事情")
        self.assertEqual(first, "started")
        await asyncio.wait_for(planner.started.wait(), timeout=2)
        second = await service.handle_chat("Doctor_Pepper", "!agent 另一个任务")
        self.assertEqual(second, "busy")
        self.assertTrue(any("正在执行" in text for text in backend.say_calls))
        self.assertEqual(len(planner.calls), 1)
        await service.stop_current()
        planner.release.set()
        await wait_until(lambda: not service.busy)
        await service.shutdown()

    async def test_disconnect_cancels_running_task(self) -> None:
        backend = FakeBackend([observation()])
        planner = BlockingPlanner(
            {
                "goal": {
                    "type": "inventory_at_least",
                    "item": "minecraft:oak_log",
                    "count": 1,
                },
                "step": {"op": "observe", "args": {}},
            }
        )
        service = AgentService(
            backend, planner, self.config, emit=lambda text: None, chat_progress=False
        )
        run = asyncio.create_task(service.run_single("测试断线取消"))
        await asyncio.wait_for(planner.started.wait(), timeout=2)
        backend.push_event(
            {"event": "disconnect", "data": {"reason": "test disconnect"}}
        )
        outcome = await asyncio.wait_for(run, timeout=2)
        self.assertEqual(outcome.end_state, "cancelled")
        self.assertGreaterEqual(backend.stop_calls, 1)

    async def test_observe_response_timeout(self) -> None:
        backend = FakeBackend([observation()], hang_observe=True)
        planner = ScriptedPlanner([])
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.05,
        )
        started = time.monotonic()
        outcome = await runner.run("观察")
        elapsed = time.monotonic() - started
        self.assertEqual(outcome.end_state, "failed")
        self.assertLess(elapsed, 1.0)
        self.assertIn("超时", outcome.message)
        self.assertEqual(planner.calls, [])

    async def test_total_task_timeout(self) -> None:
        backend = FakeBackend([observation()])

        class HangingPlanner:
            calls = 0

            async def decide(self, context, timeout):
                self.calls += 1
                await asyncio.Event().wait()
                raise AssertionError("unreachable")

        planner = HangingPlanner()
        short_config = make_config(self.root / "short", task_timeout=0.2)
        runner = TaskRunner(
            backend,
            planner,
            short_config,
            notify=lambda text: None,
            request_timeout=0.5,
        )
        started = time.monotonic()
        outcome = await runner.run("会超时的任务")
        elapsed = time.monotonic() - started
        self.assertEqual(outcome.end_state, "failed")
        self.assertLess(elapsed, 1.5)
        self.assertIn("时间", outcome.message)
        self.assertEqual(planner.calls, 1)


class DecisionAndGoalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.config = make_config(self.root)

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_act_polls_status_then_live_verification(self) -> None:
        backend = FakeBackend(
            [observation(), observation({"minecraft:oak_log": 2})]
        )
        goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 2,
        }
        planner = ScriptedPlanner(
            [
                {
                    "goal": goal,
                    "step": {
                        "op": "act",
                        "args": {
                            "kind": "collect",
                            "block": "minecraft:oak_log",
                            "count": 2,
                        },
                    },
                },
                {"goal": goal, "step": {"op": "finish", "args": {}}},
            ]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("收集两个橡木原木")
        self.assertEqual(outcome.end_state, "completed")
        self.assertIn("任务完成", outcome.message)
        self.assertEqual(outcome.goal, goal)
        self.assertTrue(outcome.verification["ok"])
        # Two decisions only: status polling must not call the planner again.
        self.assertEqual(len(planner.calls), 2)
        self.assertEqual(backend.act_calls, 1)
        self.assertEqual(backend.status_calls["a1"], 2)
        self.assertEqual(backend.observe_calls, 3)
        self.assertEqual(outcome.usage["calls"], 2)

    async def test_zero_inventory_change_cannot_complete(self) -> None:
        backend = FakeBackend([observation()])
        goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 2,
        }
        planner = ScriptedPlanner(
            [
                {
                    "goal": goal,
                    "step": {
                        "op": "act",
                        "args": {
                            "kind": "collect",
                            "block": "minecraft:oak_log",
                            "count": 2,
                        },
                    },
                },
                {"goal": goal, "step": {"op": "finish", "args": {}}},
                {"goal": goal, "step": {"op": "finish", "args": {}}},
            ]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("收集两个橡木原木")
        self.assertNotEqual(outcome.end_state, "completed")
        self.assertEqual(outcome.end_state, "failed")
        self.assertIn("重复失败", outcome.message)
        finish_steps = [step for step in outcome.steps if step["op"] == "finish"]
        self.assertEqual(len(finish_steps), 2)
        self.assertTrue(all(step["status"] == "failed" for step in finish_steps))
        self.assertEqual(
            outcome.final_observation["inventory"], []
        )

    async def test_goal_cannot_change_mid_task(self) -> None:
        backend = FakeBackend([observation()])
        first_goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 4,
        }
        switched_goal = {
            "type": "inventory_at_least",
            "item": "minecraft:diamond",
            "count": 1,
        }
        planner = ScriptedPlanner(
            [
                {"goal": first_goal, "step": {"op": "observe", "args": {}}},
                {"goal": switched_goal, "step": {"op": "observe", "args": {}}},
            ]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("收集四个原木")
        self.assertEqual(outcome.end_state, "failed")
        self.assertIn("目标不允许中途更改", outcome.message)
        self.assertEqual(outcome.goal, first_goal)
        self.assertEqual(len(planner.calls), 2)
        self.assertTrue(
            any(step["status"] == "rejected" for step in outcome.steps)
        )

    async def test_explicit_goal_cannot_be_switched(self) -> None:
        backend = FakeBackend([observation()])
        explicit = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 4,
        }
        other = {
            "type": "inventory_at_least",
            "item": "minecraft:diamond",
            "count": 1,
        }
        planner = ScriptedPlanner(
            [{"goal": other, "step": {"op": "observe", "args": {}}}]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
        )
        outcome = await runner.run("验收目标", explicit)
        self.assertEqual(outcome.end_state, "failed")
        self.assertEqual(outcome.goal, explicit)

    async def test_invalid_action_arguments_never_reach_backend(self) -> None:
        backend = FakeBackend([observation()])
        goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 1,
        }
        bad = {
            "goal": goal,
            "step": {
                "op": "act",
                "args": {
                    "kind": "collect",
                    "block": "minecraft:oak_log",
                    "count": 99,
                },
            },
        }
        planner = ScriptedPlanner([bad, bad])
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("非法参数")
        self.assertEqual(outcome.end_state, "failed")
        self.assertEqual(backend.act_calls, 0)
        self.assertTrue(all(step["op"] == "invalid" for step in outcome.steps))
        self.assertTrue(all(step["status"] == "rejected" for step in outcome.steps))

    async def test_raw_commands_and_code_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            parse_decision(
                json.dumps(
                    {"step": {"op": "say", "args": {"message": "/give @p diamond"}}}
                )
            )
        with self.assertRaises(ValidationError):
            validate_step(
                {
                    "op": "act",
                    "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 1, "code": "x"},
                }
            )
        with self.assertRaises(ValidationError):
            parse_decision(
                '```json\n{"step":{"op":"observe","args":{}}}\n```'
            )

    async def test_step_exhaustion(self) -> None:
        backend = FakeBackend([observation()])
        goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 1,
        }
        planner = ScriptedPlanner(
            [
                {"goal": goal, "step": {"op": "observe", "args": {}}},
                {"step": {"op": "observe", "args": {}}},
            ]
        )
        short = make_config(self.root / "steps", max_steps=2)
        runner = TaskRunner(
            backend,
            planner,
            short,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("一直观察")
        self.assertEqual(outcome.end_state, "exhausted")
        self.assertIn("最大步数", outcome.message)
        self.assertEqual(len(planner.calls), 2)

    async def test_inventory_increase_baseline_is_start_snapshot(self) -> None:
        goal = parse_goal(
            {
                "type": "inventory_increase",
                "item": "minecraft:oak_log",
                "count": 2,
            }
        )
        state = TaskState(task_id="t1", task_text="test")
        state.apply_observation(observation({"minecraft:oak_log": 1}))
        state.set_goal(goal)
        self.assertEqual(state.goal_baseline["minecraft:oak_log"], 1)
        state.apply_observation(observation({"minecraft:oak_log": 5}))
        # Re-binding the same goal in code must not reset the baseline.
        state.set_goal(goal)
        self.assertEqual(state.goal_baseline["minecraft:oak_log"], 1)

        late_goal_state = TaskState(task_id="t2", task_text="test")
        late_goal_state.apply_observation(observation({"minecraft:oak_log": 0}))
        late_goal_state.apply_observation(observation({"minecraft:oak_log": 3}))
        late_goal_state.set_goal(goal)
        self.assertEqual(
            late_goal_state.goal_baseline["minecraft:oak_log"], 0
        )

    async def test_world_id_change_aborts_old_task(self) -> None:
        backend = FakeBackend(
            [observation(world="world-a"), observation(world="world-b")]
        )
        goal = {
            "type": "inventory_at_least",
            "item": "minecraft:oak_log",
            "count": 1,
        }
        planner = ScriptedPlanner(
            [{"goal": goal, "step": {"op": "observe", "args": {}}}]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("观察世界")
        self.assertEqual(outcome.end_state, "failed")
        self.assertIn("世界标识", outcome.message)
        self.assertEqual(outcome.final_observation["world_id"], "world-a")
        self.assertEqual(len(planner.calls), 1)

    async def test_jsonl_persistence_without_secrets(self) -> None:
        logs = RuntimeLogs(self.root / "runtime")
        try:
            backend = FakeBackend(
                [observation(), observation({"minecraft:oak_log": 2})]
            )
            goal = {
                "type": "inventory_at_least",
                "item": "minecraft:oak_log",
                "count": 2,
            }
            planner = ScriptedPlanner(
                [
                    {
                        "goal": goal,
                        "step": {
                            "op": "act",
                            "args": {
                                "kind": "collect",
                                "block": "minecraft:oak_log",
                                "count": 2,
                            },
                        },
                    },
                    {"goal": goal, "step": {"op": "finish", "args": {}}},
                ]
            )
            runner = TaskRunner(
                backend,
                planner,
                self.config,
                logs,
                notify=lambda text: None,
                request_timeout=0.2,
            )
            outcome = await runner.run("持久化测试")
            self.assertEqual(outcome.end_state, "completed")
        finally:
            logs.close()
        request_records = [
            json.loads(line)
            for line in (self.root / "runtime" / "requests.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line
        ]
        task_records = [
            json.loads(line)
            for line in (self.root / "runtime" / "tasks.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line
        ]
        usage_records = [
            json.loads(line)
            for line in (self.root / "runtime" / "usage.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line
        ]
        task_end = next(
            record for record in task_records if record.get("type") == "task_end"
        )
        self.assertEqual(task_end.get("end_state"), "completed")
        self.assertTrue(
            any(
                step.get("op") == "act" and step.get("status") == "succeeded"
                for step in task_end["steps"]
            )
        )
        self.assertTrue(any(record.get("model") == "fake-model" for record in usage_records))
        combined = (
            (self.root / "runtime" / "requests.jsonl").read_text(encoding="utf-8")
            + (self.root / "runtime" / "tasks.jsonl").read_text(encoding="utf-8")
            + (self.root / "runtime" / "usage.jsonl").read_text(encoding="utf-8")
        )
        self.assertNotIn("never-read.key", combined)
        self.assertNotIn("Authorization", combined)

    async def test_flat_inspect_container_result_is_supported(self) -> None:
        flat = {
            "type": "minecraft:chest",
            "position": {"x": 10.0, "y": 64.0, "z": 0.0},
            "items": [{"name": "minecraft:oak_log", "count": 3}],
            "observed_at": "2026-10-27T20:00:00+00:00",
        }
        backend = FakeBackend([observation()], inspect_results=[flat])
        goal = {
            "type": "container_at_least",
            "position": {"x": 10.0, "y": 64.0, "z": 0.0},
            "item": "minecraft:oak_log",
            "count": 2,
        }
        planner = ScriptedPlanner(
            [
                {
                    "goal": goal,
                    "step": {
                        "op": "inspect_container",
                        "args": {"position": {"x": 10, "y": 64, "z": 0}},
                    },
                },
                {"goal": goal, "step": {"op": "finish", "args": {}}},
            ]
        )
        runner = TaskRunner(
            backend,
            planner,
            self.config,
            notify=lambda text: None,
            request_timeout=0.2,
        )
        outcome = await runner.run("检查箱子")
        self.assertEqual(outcome.end_state, "completed")
        self.assertIn("容器", outcome.message)
        self.assertEqual(backend.inspect_calls, 2)
        first_step = outcome.steps[0]
        self.assertEqual(first_step["status"], "succeeded")
        self.assertEqual(
            first_step["result"]["container"]["items"],
            [{"name": "minecraft:oak_log", "count": 3}],
        )


class TransportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.root = Path(self._tmp.name)
        self.config = make_config(self.root)
        self.script = self.root / "fake_executor.py"
        self.script.write_text(
            """
import json, sys, time
print(json.dumps({"event":"ready","data":{"username":"Fake","version":"1.21.1","world_id":"w"}}), flush=True)
for line in sys.stdin:
    req = json.loads(line)
    op = req.get("op")
    if op == "slow":
        time.sleep(0.4)
        print(json.dumps({"id":req["id"],"ok":True,"result":{"op":op}}), flush=True)
    elif op == "shutdown":
        print(json.dumps({"id":req["id"],"ok":True,"result":{}}), flush=True)
        break
    else:
        print(json.dumps({"id":req["id"],"ok":True,"result":{"op":op,"args":req.get("args")}}), flush=True)
""".lstrip(),
            encoding="utf-8",
        )

    async def asyncTearDown(self) -> None:
        self._tmp.cleanup()

    async def test_request_correlation_and_strict_timeout(self) -> None:
        logs = RuntimeLogs(self.root / "runtime")
        client = ExecutorClient(
            self.config,
            logs,
            node_executable=sys.executable,
            server_script=self.script,
            request_timeout=0.2,
            startup_timeout=3.0,
        )
        try:
            ready = await client.start()
            self.assertEqual(ready["username"], "Fake")
            with self.assertRaises(TransportTimeout):
                await client.request("slow", {}, timeout=0.05)
            result = await client.request("echo", {"value": 7}, timeout=1.0)
            self.assertEqual(result["op"], "echo")
            self.assertEqual(result["args"], {"value": 7})
        finally:
            await client.shutdown()
            logs.close()
        records = [
            json.loads(line)
            for line in (self.root / "runtime" / "requests.jsonl")
            .read_text(encoding="utf-8")
            .splitlines()
            if line
        ]
        self.assertTrue(
            any(
                record.get("direction") == "response"
                and record.get("op") == "echo"
                and record.get("result", {}).get("args") == {"value": 7}
                for record in records
            )
        )
        self.assertTrue(
            any(
                record.get("direction") == "timeout"
                and record.get("op") == "slow"
                for record in records
            )
        )
        self.assertFalse(
            any("Authorization" in json.dumps(record) for record in records)
        )


if __name__ == "__main__":
    unittest.main()
