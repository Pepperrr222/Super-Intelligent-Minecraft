"""Shared execution controller: guarded actions, polling and verification.

Only observations, statuses and effects reported by the executor enter state.
The model never declares completion on its own: a fresh observation (plus a
container inspection for container goals) is verified by code.
"""

from __future__ import annotations

import asyncio
import inspect
import time
import uuid
from dataclasses import dataclass, field, replace
from typing import Any, Awaitable, Callable

from sim_agent.app.config import AppConfig
from sim_agent.domain.errors import (
    AgentError,
    DeadlineExceeded,
    ExecutorError,
    ModelError,
    ModelTimeout,
    OperationTimeout,
    TaskCancelled,
    TransportError,
    TransportTimeout,
    ValidationError,
    WorldChangedError,
)
from sim_agent.domain.goals import Goal, GoalVerifier, VerificationResult, parse_goal, goal_leaves, container_key
from sim_agent.domain.constraints import parse_constraints, explicit_constraints, merge_constraints, guard_action, check_inventory, validate_reserved_goal
from sim_agent.domain.references import unresolved_reference
from sim_agent.observability.jsonl import NullLogs, RuntimeLogs, utc_now
from sim_agent.domain.state import StepRecord, TaskState, inventory_snapshot, normalize_observation
from sim_agent.adapters.mineflayer import Backend
from sim_agent.domain.validation import (
    QUERY_OPS,
    ToolCall,
    canonical_json,
    canonical_observed_name,
    parse_decision,
    position,
)

Notify = Callable[[str], Awaitable[None] | None]

@dataclass(slots=True)
class _Execution:
    status: str
    result: dict[str, Any] | None = None
    error: str | None = None
    evidence: dict[str, Any] | None = None
    action_id: str | None = None


class _Halt(Exception):
    def __init__(
        self,
        end_state: str,
        message: str,
        *,
        verification: VerificationResult | None = None,
        error: str | None = None,
    ) -> None:
        if end_state not in END_STATES:
            raise ValueError(f"bad end state {end_state}")
        self.end_state = end_state
        self.message = message
        self.verification = verification
        self.error = error
        super().__init__(message)


def _brief(text: str | None, limit: int = 180) -> str:
    if not text:
        return ""
    collapsed = " ".join(str(text).split())
    return collapsed if len(collapsed) <= limit else collapsed[: limit - 1] + "…"


def _status_error(status: dict[str, Any]) -> str:
    error = status.get("error")
    if isinstance(error, dict):
        message = error.get("message")
        if isinstance(message, str) and message.strip():
            return _brief(message, 300)
    if isinstance(error, str) and error.strip():
        return _brief(error, 300)
    return "动作失败（执行器未提供详细错误）"


def _discard_task_result(task: "asyncio.Task[Any]") -> None:
    """Consume a late/cancelled operation's result so it cannot affect a task."""

    try:
        task.exception()
    except (asyncio.CancelledError, Exception):
        pass


class ExecutionController:
    """Shared guarded execution, cancellation and fresh state verification."""

    def __init__(self, backend, config, logs=None, *, notify=None,
                 request_timeout=10.0, clock=time.monotonic):
        self._backend = backend
        self._config = config
        self._logs = logs or NullLogs()
        self._notify_cb = notify
        self._request_timeout = request_timeout
        self._clock = clock
        self._verifier = GoalVerifier()
        self._active = False
        self._cancel_event = None
        self._cancel_reason = ""
        self._stop_lock = asyncio.Lock()
        self._stop_sent = False
        self._task_id = ""
        self._pending_action = None
        self._stop_action_id = None
        self._effect_unknown = False

    async def cancel(self, reason: str = "玩家取消任务") -> bool:
        if not self._active or self._cancel_event is None:
            return False
        self._cancel_reason = reason
        self._cancel_event.set()
        await self._stop_once()
        return True

    async def _stop_once(self) -> None:
        async with self._stop_lock:
            if self._stop_sent:
                return
            self._stop_sent = True
            try:
                result = await asyncio.wait_for(self._backend.stop(), timeout=5.0)
                if isinstance(result, dict) and isinstance(result.get("action_id"), str):
                    self._stop_action_id = result["action_id"]
            except (asyncio.TimeoutError, Exception):
                # Stop is best-effort during cancellation; the task still ends
                # honestly as cancelled rather than pretending it succeeded.
                pass

    def _remaining(self, deadline: float) -> float:
        remaining = deadline - self._clock()
        if remaining <= 0:
            raise DeadlineExceeded("任务总时间已用尽")
        return remaining

    def _remaining_or_zero(self, deadline: float) -> float:
        return max(0.0, deadline - self._clock())

    async def _notify(self, message: str) -> None:
        self._logs.trace({"type": "progress", "task_id": self._task_id, "message": message})
        if self._notify_cb is None:
            return
        try:
            result = self._notify_cb(message)
            if inspect.isawaitable(result):
                await asyncio.wait_for(result, timeout=3.0)
        except (asyncio.TimeoutError, asyncio.CancelledError):
            return
        except Exception:
            return

    async def _race(
        self,
        awaitable: Awaitable[Any],
        timeout: float,
        cancel_event: asyncio.Event,
        on_timeout: Exception,
    ) -> Any:
        task = asyncio.ensure_future(awaitable)
        cancel_wait = asyncio.create_task(cancel_event.wait())
        if timeout <= 0:
            task.cancel()
            cancel_wait.cancel()
            task.add_done_callback(_discard_task_result)
            raise on_timeout
        try:
            done, _ = await asyncio.wait(
                {task, cancel_wait},
                timeout=timeout,
                return_when=asyncio.FIRST_COMPLETED,
            )
            if cancel_event.is_set():
                raise TaskCancelled(self._cancel_reason or "任务已取消")
            if task in done:
                return task.result()
            raise on_timeout
        finally:
            cancel_wait.cancel()
            if not task.done():
                task.cancel()
            # Never wait for a late model/tool response after cancel/timeout.
            # Cooperative cancellations complete on this loop turn; anything
            # slower is detached and its result discarded.
            await asyncio.sleep(0)
            task.add_done_callback(_discard_task_result)

    async def _request(
        self,
        op: str,
        args: dict[str, Any],
        deadline: float,
        cancel_event: asyncio.Event,
        *,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        remaining = self._remaining(deadline)
        effective = min(
            remaining, timeout if timeout is not None else self._request_timeout
        )
        try:
            return await self._race(
                self._backend.request(op, args, timeout=effective),
                effective + 0.1,
                cancel_event,
                OperationTimeout(f"执行器 {op} 响应超时"),
            )
        except OperationTimeout:
            if self._remaining_or_zero(deadline) <= 0:
                raise DeadlineExceeded("任务总时间已用尽") from None
            raise OperationTimeout(f"执行器 {op} 响应超时") from None

    async def _observe(
        self, deadline: float, cancel_event: asyncio.Event
    ) -> dict[str, Any]:
        response = await self._request("observe", {}, deadline, cancel_event)
        try:
            return normalize_observation(response)
        except ValidationError:
            raise
        except TransportError:
            raise

    async def _sleep(
        self, seconds: float, deadline: float, cancel_event: asyncio.Event
    ) -> None:
        remaining = self._remaining(deadline)
        delay = min(max(0.0, seconds), remaining)
        if delay <= 0:
            return
        await self._race(
            asyncio.sleep(delay),
            delay + 0.1,
            cancel_event,
            DeadlineExceeded("任务总时间已用尽"),
        )

    async def _execute(
        self,
        call: ToolCall,
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> _Execution:
        if call.op == "act" and self._effect_unknown:
            raise TransportError("上次动作效果未确认，需要人工核对并重新连接，禁止自动重放")
        recipes = None
        if state.constraints and call.op == "act":
            fresh = await self._observe(deadline, cancel_event)
            state.apply_observation(fresh)
            if call.args["kind"] == "craft" and state.constraints.get("keep_inventory"):
                response = await self._request("recipes", {"item": call.args["item"]}, deadline, cancel_event)
                state.check_world(response.get("world_id"))
                recipes = response.get("recipes", [])
        guard_action(state.constraints, call.op, call.args,
                     state.observation.raw if state.observation else {}, recipes)
        if call.op in QUERY_OPS:
            return await self._execute_query(call, state, deadline, cancel_event)
        if call.op == "act":
            return await self._execute_action(call, state, deadline, cancel_event)
        raise ValidationError(f"不支持的步骤 {call.op}")

    async def _execute_query(
        self,
        call: ToolCall,
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> _Execution:
        if call.op == "inspect_container":
            container = await self._inspect_container_payload(
                call.args["position"], state, deadline, cancel_event
            )
            return _Execution("succeeded", result={"container": container})

        response = await self._request(
            call.op, call.args, deadline, cancel_event
        )
        if call.op == "observe":
            state.apply_observation(response)
            return _Execution(
                "succeeded",
                result={
                    "world_id": state.observation.raw["world_id"] if state.observation else None,
                    "position": state.observation.raw["position"] if state.observation else None,
                },
            )
        if call.op == "find_blocks":
            state.check_world(response.get("world_id"))
            blocks = self._validate_blocks(response)
            state.apply_query_result("find_blocks", {"blocks": blocks})
            return _Execution("succeeded", result={"blocks": blocks})
        if call.op == "recipes":
            state.check_world(response.get("world_id"))
            recipes = response.get("recipes")
            if recipes is None:
                recipes = []
            if not isinstance(recipes, list):
                raise ValidationError("recipes 响应的 recipes 必须是列表")
            state.apply_query_result("recipes", {"recipes": recipes})
            return _Execution("succeeded", result={"recipes": recipes[:32]})
        raise ValidationError(f"不支持的查询步骤 {call.op}")

    def _validate_blocks(self, response: dict[str, Any]) -> list[dict[str, Any]]:
        raw_blocks = response.get("blocks")
        if not isinstance(raw_blocks, list):
            raise ValidationError("find_blocks 响应缺少 blocks 列表")
        blocks: list[dict[str, Any]] = []
        for index, entry in enumerate(raw_blocks[:16]):
            if not isinstance(entry, dict):
                raise ValidationError(f"blocks[{index}] 必须是对象")
            name = canonical_observed_name(entry.get("name"))
            if name is None:
                raise ValidationError(f"blocks[{index}].name 非法")
            try:
                pos = position(entry.get("position"), f"blocks[{index}].position")
            except ValidationError:
                raise
            distance = entry.get("distance")
            if isinstance(distance, bool) or not isinstance(distance, (int, float)):
                distance = 0.0
            blocks.append(
                {"name": name, "position": pos, "distance": float(distance)}
            )
        return blocks

    async def _execute_action(
        self,
        call: ToolCall,
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> _Execution:
        before_observation = state.observation.raw if state.observation else None
        self._pending_action = (call, "", utc_now())
        response = await self._request("act", call.args, deadline, cancel_event)
        action_id = response.get("action_id")
        if not isinstance(action_id, str) or not action_id:
            raise ValidationError("act 响应缺少 action_id")
        self._pending_action = (call, action_id, utc_now())
        status_response, fresh_observation = await self._poll_action(
            action_id,
            deadline,
            cancel_event,
            fetch_observation=True,
        )
        if fresh_observation is not None:
            state.apply_observation(fresh_observation)
        status = status_response.get("status")
        if (status_response.get("effect") or {}).get("effect_unknown") is True:
            self._effect_unknown = True
            raise TransportError("执行器报告挖掘效果未确认，停止自动重试并保留现场")
        self._pending_action = None
        after_observation = state.observation.raw if state.observation else None
        evidence = {
            "action_id": action_id,
            "status": status,
            "action": status_response,
            "before_inventory": inventory_snapshot(before_observation),
            "after_inventory": inventory_snapshot(after_observation),
        }
        if status == "succeeded":
            return _Execution(
                "succeeded",
                result=status_response,
                evidence=evidence,
                action_id=action_id,
            )
        if status == "failed":
            return _Execution(
                "failed",
                result=status_response,
                error=_status_error(status_response),
                evidence=evidence,
                action_id=action_id,
            )
        if status == "cancelled":
            if cancel_event.is_set():
                return _Execution(
                    "cancelled",
                    result=status_response,
                    error="动作被取消",
                    evidence=evidence,
                    action_id=action_id,
                )
            return _Execution(
                "failed",
                result=status_response,
                error="动作被外部取消",
                evidence=evidence,
                action_id=action_id,
            )
        raise ValidationError(f"未知动作状态: {status}")

    async def _capture_interrupted_action(self, state: TaskState) -> None:
        """Cancellation ends planning, not our obligation to preserve effects."""
        pending = self._pending_action
        self._pending_action = None
        if pending is None:
            return
        call, action_id, started_at = pending
        action_id = action_id or self._stop_action_id or ""
        status: dict[str, Any] = {"action_id": action_id, "status": "unknown"}
        try:
            if action_id:
                status = await asyncio.wait_for(self._backend.request("action_status", {"action_id": action_id}, timeout=2), 2.1)
            fresh = await asyncio.wait_for(self._backend.request("observe", {}, timeout=2), 2.1)
            state.apply_observation(fresh)
        except Exception as exc:
            status["capture_error"] = type(exc).__name__
        terminal = status.get("status")
        state.add_step(StepRecord(index=state.decision_count, op=call.op, args=call.args,
            status=terminal if terminal in {"succeeded", "failed", "cancelled"} else "interrupted",
            started_at=started_at, finished_at=utc_now(), action_id=action_id,
            result=status, evidence={"action": status, "partial_effects_preserved": True},
            error=None if terminal == "succeeded" else "任务中断，保留实际动作状态和部分效果"))

    async def _poll_action(
        self,
        action_id: str,
        deadline: float,
        cancel_event: asyncio.Event,
        *,
        fetch_observation: bool,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        terminal = {"succeeded", "failed", "cancelled"}
        while True:
            self._remaining(deadline)
            if cancel_event.is_set():
                raise TaskCancelled(self._cancel_reason or "任务已取消")
            response = await self._request(
                "action_status",
                {"action_id": action_id},
                deadline,
                cancel_event,
            )
            returned_id = response.get("action_id")
            if returned_id is not None and returned_id != action_id:
                raise ValidationError("action_status 返回了不匹配的 action_id")
            status = response.get("status")
            if status not in {"running", "succeeded", "failed", "cancelled"}:
                raise ValidationError(f"action_status 返回未知状态: {status}")
            if status in terminal:
                observation: dict[str, Any] | None = None
                if fetch_observation:
                    try:
                        observation = await self._observe(deadline, cancel_event)
                    except (TaskCancelled, DeadlineExceeded):
                        raise
                    except AgentError:
                        if status == "succeeded":
                            # Without a real observation we cannot ground a
                            # successful action in state.
                            raise
                return response, observation
            await self._sleep(
                self._config.agent.poll_seconds, deadline, cancel_event
            )

    async def _inspect_container_payload(
        self,
        target: dict[str, float],
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> dict[str, Any]:
        response = await self._request(
            "inspect_container",
            {"position": target},
            deadline,
            cancel_event,
            timeout=25.0,
        )
        payload: dict[str, Any] = response
        if "action_id" in response:
            action_id = response.get("action_id")
            if not isinstance(action_id, str) or not action_id:
                raise ValidationError("inspect_container 响应缺少 action_id")
            status_response, _ = await self._poll_action(
                action_id,
                deadline,
                cancel_event,
                fetch_observation=False,
            )
            if status_response.get("status") != "succeeded":
                raise ExecutorError(
                    "container_inspect_failed", _status_error(status_response)
                )
            payload = self._payload_from_status(status_response)
        container = self._normalize_container(payload, target, state)
        state.apply_query_result("inspect_container", {"container": container})
        return container

    @staticmethod
    def _payload_from_status(status_response: dict[str, Any]) -> dict[str, Any]:
        for key in ("result", "after", "effect"):
            value = status_response.get(key)
            if isinstance(value, dict):
                if "items" in value:
                    return value
                nested = value.get("container")
                if isinstance(nested, dict):
                    return nested
        return status_response

    def _normalize_container(
        self,
        payload: dict[str, Any],
        target: dict[str, float],
        state: TaskState,
    ) -> dict[str, Any]:
        if not isinstance(payload, dict):
            raise ValidationError("容器结果必须是对象")
        source = payload
        if isinstance(source.get("container"), dict):
            source = source["container"]
        items_raw = source.get("items")
        if not isinstance(items_raw, list):
            raise ValidationError("容器结果缺少 items 列表")
        items: list[dict[str, Any]] = []
        for index, entry in enumerate(items_raw):
            if not isinstance(entry, dict):
                raise ValidationError(f"container.items[{index}] 必须是对象")
            name = canonical_observed_name(entry.get("name"))
            if name is None:
                raise ValidationError(f"container.items[{index}].name 非法")
            count = entry.get("count")
            if isinstance(count, bool) or not isinstance(count, int) or count < 0:
                raise ValidationError(f"container.items[{index}].count 非法")
            items.append({"name": name, "count": count})
        container_position: dict[str, float] = target
        raw_position = source.get("position", source.get("coordinates"))
        if isinstance(raw_position, dict):
            try:
                container_position = position(raw_position)
            except ValidationError:
                container_position = target
        container: dict[str, Any] = {
            "position": container_position,
            "items": items,
        }
        if isinstance(source.get("type"), str):
            container["type"] = source["type"]
        if isinstance(source.get("observed_at"), str):
            container["observed_at"] = source["observed_at"]
        if isinstance(source.get("world_id"), str):
            state.check_world(source["world_id"])
            container["world_id"] = source["world_id"]
        return container

    async def _prepare_goal(self, state: TaskState, deadline: float, cancel_event: asyncio.Event) -> None:
        """Capture container deltas before the first world-changing step."""
        if state.goal is None:
            return
        for goal in goal_leaves(state.goal):
            if goal.type != "container_delta":
                continue
            key = container_key(goal.spec["position"])
            if key not in state.container_baselines:
                guard_action(state.constraints, "inspect_container", {"position": goal.spec["position"]},
                             state.observation.raw if state.observation else {})
                state.container_baselines[key] = await self._inspect_container_payload(
                    goal.spec["position"], state, deadline, cancel_event)
        # Baseline inspection may navigate; keep the planner's location fresh.
        if state.container_baselines:
            state.apply_observation(await self._observe(deadline, cancel_event))

    async def _verify_live(
        self,
        goal: Goal,
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> VerificationResult:
        """Re-observe; container goals additionally require a fresh inspection."""

        await self._notify("正在复核目标…")
        observation = await self._observe(deadline, cancel_event)
        state.apply_observation(observation)
        check_inventory(state.constraints, observation)
        container: dict[str, Any] | None = None
        containers: dict[str, dict[str, Any]] = {}
        for leaf in goal_leaves(goal):
            if leaf.type not in {"container_at_least", "container_delta"}:
                continue
            key = container_key(leaf.spec["position"])
            if key in containers:
                continue
            try:
                guard_action(state.constraints, "inspect_container", {"position": leaf.spec["position"]}, observation)
                container = await self._inspect_container_payload(
                    leaf.spec["position"], state, deadline, cancel_event
                )
                containers[key] = container
            except (TaskCancelled, DeadlineExceeded):
                raise
            except AgentError as exc:
                return VerificationResult(
                    False,
                    f"无法复核目标容器：{_brief(str(exc), 160)}",
                    {"error": _brief(str(exc), 300)},
                )
        # Container inspection may navigate or pick up nearby drops. Never
        # verify position/inventory against the snapshot from before inspection.
        if containers:
            state.apply_observation(await self._observe(deadline, cancel_event))
            check_inventory(state.constraints, state.observation.raw)
        return self._verifier.verify(
            goal,
            state,
            observation=state.observation.raw if state.observation else observation,
            container=container,
            containers=containers,
        )

    def _describe_call(self, call: ToolCall) -> str:
        if call.op == "act":
            kind = call.args.get("kind")
            target = call.args.get("item") or call.args.get("block") or call.args.get("player")
            if kind == "collect":
                return f"采集 {call.args.get('count')} 个 {target}"
            if kind == "craft":
                return f"合成 {call.args.get('count')} 个 {target}"
            if kind in {"deposit", "withdraw"}:
                return f"{'存入' if kind == 'deposit' else '取出'} {call.args.get('count')} 个 {target}"
            if kind == "follow":
                return f"跟随 {target} {call.args.get('duration_seconds')} 秒"
            if kind == "goto":
                pos = call.args.get("position", {})
                return f"移动到 ({pos.get('x')}, {pos.get('y')}, {pos.get('z')})"
            if kind == "smelt":
                return f"熔炼 {call.args.get('input')} x{call.args.get('input_count')}"
        if call.op == "find_blocks":
            return f"寻找方块 {', '.join(call.args.get('names', []))}"
        if call.op == "inspect_container":
            return "检查容器"
        if call.op == "recipes":
            return f"查询配方 {call.args.get('item')}"
        return "观察世界"

