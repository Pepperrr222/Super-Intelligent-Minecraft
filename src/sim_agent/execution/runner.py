"""Task runner: strict decision validation, action polling and verification.

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
from sim_agent.planning.planner import Planner, build_context
from sim_agent.domain.state import StepRecord, TaskState, inventory_snapshot, normalize_observation
from sim_agent.adapters.mineflayer import Backend
from sim_agent.memory.store import ExperienceStore
from sim_agent.memory.retrieval import episode_context
from sim_agent.domain.validation import (
    QUERY_OPS,
    ToolCall,
    canonical_json,
    canonical_observed_name,
    parse_decision,
    position,
)

Notify = Callable[[str], Awaitable[None] | None]

END_STATES = frozenset(
    {"completed", "failed", "cancelled", "needs_clarification", "exhausted"}
)


@dataclass(slots=True)
class TaskOutcome:
    task_id: str
    task_text: str
    end_state: str
    message: str
    started_at: str
    finished_at: str
    duration_seconds: float
    goal: dict[str, Any] | None = None
    verification: dict[str, Any] | None = None
    error: str | None = None
    steps: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)
    final_observation: dict[str, Any] | None = None
    task_version: int = 1

    @property
    def completed(self) -> bool:
        return self.end_state == "completed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "task_version": self.task_version,
            "task": self.task_text,
            "end_state": self.end_state,
            "message": self.message,
            "goal": self.goal,
            "verification": self.verification,
            "error": self.error,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "duration_seconds": round(self.duration_seconds, 3),
            "steps": self.steps,
            "usage": self.usage,
            "final_observation": self.final_observation,
        }


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


class TaskRunner:
    def __init__(
        self,
        backend: Backend,
        planner: Planner,
        config: AppConfig,
        logs: RuntimeLogs | NullLogs | None = None,
        *,
        notify: Notify | None = None,
        request_timeout: float = 10.0,
        clock: Callable[[], float] = time.monotonic,
        task_id_factory: Callable[[], str] | None = None,
        memory: ExperienceStore | None = None,
    ) -> None:
        self._backend = backend
        self._memory = memory
        self._planner = planner
        self._config = config
        self._logs = logs or NullLogs()
        self._notify_cb = notify
        self._request_timeout = request_timeout
        self._clock = clock
        self._task_id_factory = task_id_factory or (
            lambda: "task-" + uuid.uuid4().hex[:12]
        )
        self._verifier = GoalVerifier()
        self._active = False
        self._cancel_event: asyncio.Event | None = None
        self._cancel_reason = ""
        self._stop_lock = asyncio.Lock()
        self._stop_sent = False
        self._task_id = ""
        self._pending_action: tuple[ToolCall, str, str] | None = None
        self._stop_action_id: str | None = None

    @property
    def active(self) -> bool:
        return self._active

    @property
    def task_id(self) -> str:
        return self._task_id

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

    # ------------------------------------------------------------------
    async def run(
        self,
        task_text: str,
        goal_json: dict[str, Any] | None = None,
        *,
        task_id: str | None = None,
        task_version: int = 1,
        continuation_context: dict[str, Any] | None = None,
        requested_by: str | None = None,
    ) -> TaskOutcome:
        if self._active:
            raise RuntimeError("已有任务在运行，不能并发启动第二个任务")
        if not isinstance(task_text, str) or not task_text.strip():
            raise ValidationError("任务内容不能为空")
        if len(task_text) > 1000:
            raise ValidationError("任务内容过长")
        explicit_goal: Goal | None = parse_goal(goal_json) if goal_json is not None else None

        self._active = True
        self._cancel_event = asyncio.Event()
        self._cancel_reason = ""
        self._stop_sent = False
        self._pending_action = None
        self._stop_action_id = None
        self._task_id = task_id or self._task_id_factory()
        state = TaskState(task_id=self._task_id, task_text=task_text.strip())
        state.task_version = task_version
        state.continuation_context = continuation_context
        state.constraints = explicit_constraints(task_text)
        deadline = self._clock() + self._config.agent.task_timeout_seconds
        started_at = utc_now()
        started_monotonic = self._clock()
        cancel_event = self._cancel_event
        end_state = "failed"
        message = ""
        verification: VerificationResult | None = None
        error: str | None = None

        self._logs.task(
            {
                "type": "task_start",
                "task_id": state.task_id,
                "task": state.task_text,
                "explicit_goal": explicit_goal.to_dict() if explicit_goal else None,
                "max_steps": self._config.agent.max_steps,
                "timeout_seconds": self._config.agent.task_timeout_seconds,
            }
        )
        self._logs.trace({"type": "task_start", "task_id": state.task_id, "task": state.task_text,
                          "requested_by": requested_by,
                          "task_version": task_version, "max_steps": self._config.agent.max_steps,
                          "learning_mode": self._config.learning.mode})
        await self._notify(f"任务开始：{_brief(state.task_text, 60)}")

        try:
            await self._ensure_ready(deadline, cancel_event)
            await self._notify("正在观察世界…")
            initial = await self._observe(deadline, cancel_event)
            state.apply_observation(initial)
            self._logs.trace({"type": "observation", "task_id": state.task_id, "observation": initial})
            check_inventory(state.constraints, initial)
            if explicit_goal is not None:
                state.set_goal(explicit_goal)
                await self._prepare_goal(state, deadline, cancel_event)
            pos = initial["position"]
            await self._notify(
                f"已观察：{initial['world_id']}，位置 "
                f"({pos['x']:.1f}, {pos['y']:.1f}, {pos['z']:.1f})"
            )
            if state.goal is not None:
                await self._notify(f"目标：{state.goal.describe()}")

            await self._decision_loop(
                state, explicit_goal, deadline, cancel_event
            )
            # The loop can only leave by raising _Halt.
            raise _Halt("failed", "任务流程异常结束。")
        except _Halt as halt:
            end_state = halt.end_state
            message = halt.message
            verification = halt.verification
            error = halt.error
        except TaskCancelled as exc:
            end_state = "cancelled"
            message = f"任务已取消：{_brief(self._cancel_reason or str(exc), 120)}"
            error = _brief(self._cancel_reason or str(exc), 300)
        except DeadlineExceeded as exc:
            end_state = "failed"
            message = (
                f"任务失败：超过总时间限制 "
                f"{self._config.agent.task_timeout_seconds:g} 秒。"
            )
            error = _brief(str(exc), 300)
            await self._stop_once()
        except asyncio.CancelledError:
            end_state = "cancelled"
            message = "任务已取消：运行被中止。"
            error = "runner task cancelled"
        except TransportError as exc:
            if cancel_event.is_set():
                end_state = "cancelled"
                message = f"任务已取消：{_brief(self._cancel_reason or str(exc), 120)}"
            else:
                end_state = "failed"
                message = f"任务失败：执行器连接错误：{_brief(str(exc), 160)}"
            error = _brief(str(exc), 300)
        except WorldChangedError as exc:
            end_state = "failed"
            message = f"任务失败：{_brief(str(exc), 180)}"
            error = _brief(str(exc), 300)
        except OperationTimeout as exc:
            end_state = "failed"
            message = f"任务失败：操作超时：{_brief(str(exc), 160)}"
            error = _brief(str(exc), 300)
        except ValidationError as exc:
            end_state = "failed"
            message = f"任务失败：{_brief(str(exc), 160)}"
            error = _brief(str(exc), 300)
        except Exception as exc:  # defensive: never let a task vanish silently
            end_state = "failed"
            message = f"任务失败：内部错误（{type(exc).__name__}）。"
            error = _brief(f"{type(exc).__name__}: {exc}", 300)
        finally:
            if end_state == "cancelled" or self._pending_action is not None:
                await self._stop_once()
            if self._pending_action is not None:
                await self._capture_interrupted_action(state)
            self._active = False

        finished_at = utc_now()
        duration = max(0.0, self._clock() - started_monotonic)
        outcome = TaskOutcome(
            task_id=state.task_id,
            task_text=state.task_text,
            end_state=end_state,
            message=message,
            started_at=started_at,
            finished_at=finished_at,
            duration_seconds=duration,
            goal=state.goal.to_dict() if state.goal else None,
            verification=verification.to_dict() if verification else None,
            error=error,
            steps=[step.to_dict() for step in state.steps],
            usage=state.usage_summary(),
            final_observation=state.observation.raw if state.observation else None,
            task_version=state.task_version,
        )
        self._logs.task(
            {
                "type": "task_end",
                **outcome.to_dict(),
                "state": state.to_dict(),
            }
        )
        self._logs.trace({"type": "task_end", "task_id": state.task_id, "task": state.task_text,
                          "requested_by": requested_by,
                          "task_version": task_version, "end_state": end_state, "message": message,
                          "goal": outcome.goal, "verification": outcome.verification,
                          "usage": outcome.usage, "observation": outcome.final_observation,
                          "duration_seconds": outcome.duration_seconds})
        if self._memory is not None and state.world_id:
            try:
                self._memory.record_episode(outcome.to_dict(), world_id=state.world_id,
                                            ruleset_id=self._config.learning.ruleset_id)
            except Exception as exc:
                self._logs.task({"type": "memory_write_failed", "task_id": state.task_id, "error_type": type(exc).__name__})
        return outcome

    async def _ensure_ready(
        self, deadline: float, cancel_event: asyncio.Event
    ) -> None:
        remaining = self._remaining(deadline)
        try:
            await self._race(
                self._backend.start(),
                remaining,
                cancel_event,
                DeadlineExceeded("等待执行器就绪超时"),
            )
        except TransportError:
            raise

    # ------------------------------------------------------------------
    async def _decision_loop(
        self,
        state: TaskState,
        explicit_goal: Goal | None,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> None:
        max_steps = self._config.agent.max_steps
        while True:
            self._remaining(deadline)
            if cancel_event.is_set():
                raise TaskCancelled(self._cancel_reason or "任务已取消")
            if state.decision_count >= max_steps:
                raise _Halt(
                    "exhausted",
                    f"任务未完成：已达到最大步数 {max_steps}。",
                    error=f"max_steps={max_steps}",
                )

            step_index = state.decision_count + 1
            state.decision_count = step_index
            context = build_context(
                task_text=state.task_text,
                state=state,
                step_index=step_index,
                remaining_seconds=self._remaining_or_zero(deadline),
            )
            if self._memory is not None and self._config.learning.mode == "B1" and state.goal and state.world_id:
                context["experience"] = episode_context(
                    self._memory, world_id=state.world_id,
                    ruleset_id=self._config.learning.ruleset_id,
                    goal=state.goal.to_dict(), limit=self._config.learning.max_retrieved,
                )
            await self._notify(f"第 {step_index}/{max_steps} 步：思考中…")
            self._logs.trace({"type": "planning", "task_id": state.task_id, "step": step_index,
                              "remaining_seconds": round(self._remaining_or_zero(deadline), 1),
                              "goal": state.goal.to_dict() if state.goal else None,
                              "constraints": state.constraints,
                              "experience_count": len(context.get("experience", []))})
            try:
                reply = await self._planner_decision(context, deadline, cancel_event)
            except (ModelError, ModelTimeout, OperationTimeout) as exc:
                if self._remaining_or_zero(deadline) <= 0:
                    raise DeadlineExceeded("任务总时间已用尽") from None
                detail = str(exc)
                await self._register_failure(
                    state,
                    step_index,
                    "invalid",
                    {},
                    "rejected",
                    f"模型调用失败：{detail}",
                    f"model|{type(exc).__name__}",
                    error=detail,
                )
                continue
            state.record_usage(
                step_index=step_index,
                model=reply.model,
                usage=reply.usage,
                latency_ms=reply.latency_ms,
                model_call=reply.model_call,
            )
            self._logs.model_usage(
                {
                    "task_id": state.task_id,
                    "step": step_index,
                    "model": reply.model,
                    "model_call": reply.model_call,
                    "usage": reply.usage,
                    "latency_ms": reply.latency_ms,
                }
            )

            try:
                decision = parse_decision(reply.text)
            except ValidationError as exc:
                await self._register_failure(
                    state,
                    step_index,
                    "invalid",
                    {},
                    "rejected",
                    f"模型输出不符合契约：{exc}",
                    f"invalid_decision|{_brief(str(exc), 120)}",
                    error=str(exc),
                )
                continue

            # Only the validated public proposal is logged, never raw model
            # responses, prompts or provider reasoning_content.
            self._logs.trace({"type": "proposal", "task_id": state.task_id, "step": step_index,
                              "goal": decision.goal, "constraints": decision.constraints,
                              "op": decision.step.op, "args": decision.step.args,
                              "message": decision.message, "model": reply.model,
                              "model_call": reply.model_call, "latency_ms": reply.latency_ms,
                              "usage": reply.usage})
            if decision.step.op == "clarify":
                # A question must never trigger a guessed goal's baseline
                # inspection, navigation or new constraints as a side effect.
                decision = replace(decision, goal=None, constraints=None)
            reference_error = unresolved_reference(state.task_text) if not state.continuation_context else None
            if reference_error and decision.step.op != "clarify":
                await self._register_failure(state, step_index, "invalid", {}, "rejected",
                    reference_error, "unbound_reference", error=reference_error)
                continue

            # Goal establishment / immutability.
            proposed_constraints = parse_constraints(decision.constraints)
            merged = merge_constraints(state.constraints, proposed_constraints)
            if state.goal is not None and merged != state.constraints:
                raise ValidationError("任务约束已锁定，模型不能中途更换")
            state.constraints = merged
            if state.observation:
                check_inventory(state.constraints, state.observation.raw)
            if decision.goal is not None:
                try:
                    proposed_goal = parse_goal(decision.goal)
                    if state.goal is None:
                        validate_reserved_goal(proposed_goal, state.constraints, state.task_text)
                except ValidationError as exc:
                    await self._register_failure(
                        state,
                        step_index,
                        decision.step.op,
                        decision.step.args,
                        "rejected",
                        f"目标定义无效：{exc}",
                        f"invalid_goal|{_brief(str(exc), 120)}",
                        error=str(exc),
                    )
                    continue
                if state.goal is None:
                    state.set_goal(proposed_goal)
                    self._logs.trace({"type": "goal_bound", "task_id": state.task_id,
                                      "step": step_index, "goal": state.goal.to_dict(),
                                      "message": state.goal.describe(), "constraints": state.constraints})
                    await self._prepare_goal(state, deadline, cancel_event)
                    await self._notify(f"目标：{state.goal.describe()}")
                elif not state.goal.equivalent(proposed_goal):
                    detail = (
                        "模型试图更改任务目标，任务立即停止；"
                        f"原目标 {state.goal.fingerprint()}，"
                        f"新目标 {proposed_goal.fingerprint()}。"
                    )
                    state.add_step(
                        StepRecord(
                            index=step_index,
                            op=decision.step.op,
                            args=decision.step.args,
                            status="rejected",
                            started_at=utc_now(),
                            finished_at=utc_now(),
                            error=detail,
                        )
                    )
                    raise _Halt("failed", "任务失败：目标不允许中途更改。", error=detail)
            elif state.goal is None and decision.step.op != "clarify":
                await self._register_failure(
                    state,
                    step_index,
                    decision.step.op,
                    decision.step.args,
                    "rejected",
                    "首个决策必须先建立 goal 目标。",
                    "goal|missing",
                    error="first decision missing goal",
                )
                continue

            call = decision.step

            if call.op == "clarify":
                question = (
                    call.args.get("question")
                    or decision.message
                    or "需要玩家提供更多信息。"
                )
                state.add_step(
                    StepRecord(
                        index=step_index,
                        op="clarify",
                        args=call.args,
                        status="succeeded",
                        started_at=utc_now(),
                        finished_at=utc_now(),
                        result={"question": question},
                    )
                )
                raise _Halt(
                    "needs_clarification",
                    f"需要澄清：{_brief(question, 160)}",
                    error="clarification requested",
                )

            if call.op == "finish":
                if state.goal is None:
                    raise _Halt("failed", "任务失败：尚未建立目标，不能完成。")
                if decision.goal is None:
                    await self._register_failure(
                        state,
                        step_index,
                        "finish",
                        {},
                        "rejected",
                        "finish 必须携带与既定目标相同的 goal 谓词。",
                        "finish|missing_predicate",
                        error="finish without goal predicate",
                    )
                    continue
                verification = await self._verify_live(
                    state.goal, state, deadline, cancel_event
                )
                self._logs.trace({"type": "verification", "task_id": state.task_id, "step": step_index,
                                  "verification": verification.to_dict()})
                state.add_step(
                    StepRecord(
                        index=step_index,
                        op="finish",
                        args={},
                        status="succeeded" if verification.ok else "failed",
                        started_at=utc_now(),
                        finished_at=utc_now(),
                        result={"verification": verification.to_dict()},
                        error=None if verification.ok else verification.detail,
                        evidence=verification.evidence,
                    )
                )
                if verification.ok:
                    raise _Halt(
                        "completed",
                        f"任务完成：{verification.detail}",
                        verification=verification,
                    )
                await self._register_failure(
                    state,
                    step_index,
                    "finish",
                    {},
                    "failed",
                    f"目标尚未由程序验证通过：{verification.detail}",
                    f"finish|{state.goal.fingerprint()}|unverified",
                    error=verification.detail,
                    already_recorded=True,
                )
                continue

            await self._notify(
                f"第 {step_index} 步：{self._describe_call(call)}"
            )
            self._logs.trace({"type": "execution", "task_id": state.task_id, "step": step_index,
                              "op": call.op, "args": call.args, "message": self._describe_call(call)})
            try:
                execution = await self._execute(call, state, deadline, cancel_event)
            except (TaskCancelled, DeadlineExceeded, _Halt):
                raise
            except (ExecutorError, TransportTimeout, OperationTimeout, ValidationError) as exc:
                execution = _Execution(
                    status="failed",
                    error=_brief(str(exc), 300),
                    evidence={"error": _brief(str(exc), 300)},
                )
            except TransportError as exc:
                if cancel_event.is_set():
                    raise TaskCancelled(self._cancel_reason or "任务已取消") from exc
                raise _Halt(
                    "failed",
                    f"任务失败：执行器连接中断：{_brief(str(exc), 160)}",
                    error=_brief(str(exc), 300),
                ) from exc

            started_at = utc_now()
            step = StepRecord(
                index=step_index,
                op=call.op,
                args=call.args,
                status=execution.status,
                started_at=started_at,
                finished_at=utc_now(),
                action_id=execution.action_id,
                result=execution.result,
                error=execution.error,
                evidence=execution.evidence,
            )
            state.add_step(step)
            self._logs.trace({"type": "result", "task_id": state.task_id, "step": step_index,
                              "op": call.op, "status": execution.status, "error": execution.error,
                              "result": execution.result, "evidence": execution.evidence,
                              "observation": state.observation.raw if state.observation else None})
            if call.op == "act" and state.observation:
                check_inventory(state.constraints, state.observation.raw)

            if execution.status == "succeeded":
                await self._notify(f"第 {step_index} 步完成。")
                continue

            if execution.status == "cancelled":
                raise TaskCancelled(self._cancel_reason or "动作被取消")

            error_text = execution.error or "步骤失败"
            await self._register_failure(
                state,
                step_index,
                call.op,
                call.args,
                "failed",
                f"步骤失败：{error_text}",
                f"{call.op}|{canonical_json(call.args)}|{_failure_category(error_text)}",
                error=error_text,
                already_recorded=True,
            )

    async def _planner_decision(
        self,
        context: dict[str, Any],
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> Any:
        remaining = self._remaining(deadline)
        timeout = min(self._config.model.timeout_seconds, remaining)
        try:
            reply = await self._race(
                self._planner.decide(context, timeout),
                timeout + 0.1,
                cancel_event,
                OperationTimeout("模型响应超时"),
            )
        except OperationTimeout:
            if self._remaining_or_zero(deadline) <= 0:
                raise DeadlineExceeded("任务总时间已用尽") from None
            raise ModelTimeout("模型响应超时") from None
        if cancel_event.is_set():
            # A decision that arrives after cancellation is never executed.
            raise TaskCancelled(self._cancel_reason or "任务已取消")
        return reply

    async def _register_failure(
        self,
        state: TaskState,
        step_index: int,
        op: str,
        args: dict[str, Any],
        status: str,
        detail: str,
        signature: str,
        *,
        error: str | None,
        already_recorded: bool = False,
    ) -> None:
        if not already_recorded:
            state.add_step(
                StepRecord(
                    index=step_index,
                    op=op,
                    args=args,
                    status=status,
                    started_at=utc_now(),
                    finished_at=utc_now(),
                    error=_brief(error, 400),
                    evidence={"detail": _brief(detail, 400)},
                )
            )
        self._logs.trace({"type": "rejected", "task_id": state.task_id, "step": step_index,
                          "op": op, "status": status, "message": detail, "error": error})
        state.failure_counts[signature] = state.failure_counts.get(signature, 0) + 1
        count = state.failure_counts[signature]
        await self._notify(f"第 {step_index} 步失败：{_brief(detail, 90)}")
        if count >= 2:
            raise _Halt(
                "failed",
                f"任务失败：重复失败两次，停止。{_brief(detail, 120)}",
                error=_brief(detail, 400),
            )

    # ------------------------------------------------------------------
    async def _execute(
        self,
        call: ToolCall,
        state: TaskState,
        deadline: float,
        cancel_event: asyncio.Event,
    ) -> _Execution:
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

    # ------------------------------------------------------------------
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


def _failure_category(text: str | None) -> str:
    if not text:
        return "unknown"
    if "超时" in text:
        return "timeout"
    if "取消" in text:
        return "cancelled"
    if "未连接" in text or "断开" in text:
        return "disconnect"
    return "error"
