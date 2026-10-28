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
from sim_agent.execution.controller import ExecutionController
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
    root_task_id: str | None = None
    delivery_status: str = "not_required"
    work_status: str = "unverified"
    recovery_required: bool = False

    @property
    def completed(self) -> bool:
        return self.end_state == "completed"

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "task_version": self.task_version,
            "root_task_id": self.root_task_id,
            "delivery_status": self.delivery_status,
            "work_status": self.work_status,
            "recovery_required": self.recovery_required,
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


class TaskRunner(ExecutionController):
    def __init__(self, backend, planner, config, logs=None, *, notify=None,
                 request_timeout=10.0, clock=time.monotonic, task_id_factory=None,
                 memory=None):
        super().__init__(backend, config, logs, notify=notify,
                         request_timeout=request_timeout, clock=clock)
        self._planner = planner
        self._memory = memory
        self._task_id_factory = task_id_factory or (lambda: "task-" + uuid.uuid4().hex[:12])

    @property
    def active(self) -> bool:
        return self._active

    @property
    def task_id(self) -> str:
        return self._task_id










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
        observed = getattr(self._planner, "decide_observed", None)
        call_id = "call-" + uuid.uuid4().hex
        model_task_id = self._task_id
        call_closed = False
        def emit(event):
            nonlocal call_closed
            if call_closed:
                return
            if event.get("type") == "model_end":
                call_closed = True
            self._logs.model_event({**event, "call_id": call_id, "task_id": model_task_id,
                                    "step": context["state"]["step_index"]})
        decision = observed(context, timeout, emit) if callable(observed) else self._planner.decide(context, timeout)
        try:
            reply = await self._race(
                decision,
                timeout + 0.1,
                cancel_event,
                OperationTimeout("模型响应超时"),
            )
        except (TaskCancelled, asyncio.CancelledError):
            # HTTP cleanup can finish after task cancellation. Close the
            # observation record now and ignore every late output fragment.
            emit({"type": "model_end", "status": "cancelled", "usage_incomplete": True})
            raise
        except OperationTimeout:
            emit({"type": "model_end", "status": "timed_out", "usage_incomplete": True})
            if self._remaining_or_zero(deadline) <= 0:
                raise DeadlineExceeded("任务总时间已用尽") from None
            raise ModelTimeout("模型响应超时") from None
        except ModelTimeout:
            emit({"type": "model_end", "status": "timed_out", "usage_incomplete": True})
            raise
        except Exception:
            emit({"type": "model_end", "status": "error", "usage_incomplete": True})
            raise
        if cancel_event.is_set():
            # A decision that arrives after cancellation is never executed.
            emit({"type": "model_end", "status": "cancelled", "usage_incomplete": True})
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









    # ------------------------------------------------------------------




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
