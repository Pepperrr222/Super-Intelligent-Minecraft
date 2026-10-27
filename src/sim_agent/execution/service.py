"""Owner chat handling, busy rejection and lifecycle around one task at a time."""

from __future__ import annotations

import asyncio
import time
from typing import Any, Callable

from sim_agent.app.config import AppConfig
from sim_agent.domain.errors import AgentError, TransportError
from sim_agent.observability.jsonl import NullLogs, RuntimeLogs
from sim_agent.planning.planner import Planner
from sim_agent.execution.runner import TaskOutcome, TaskRunner
from sim_agent.adapters.mineflayer import Backend
from sim_agent.memory.store import ExperienceStore

Emit = Callable[[str], None]
_STOP_COMMANDS = {"停止", "停止任务", "stop", "cancel", "取消"}


class AgentService:
    def __init__(
        self,
        backend: Backend,
        planner: Planner,
        config: AppConfig,
        logs: RuntimeLogs | NullLogs | None = None,
        *,
        emit: Emit | None = None,
        chat_progress: bool = True,
        memory: ExperienceStore | None = None,
    ) -> None:
        self._backend = backend
        self._config = config
        self._logs = logs or NullLogs()
        self._emit = emit or (lambda text: print(text, flush=True))
        self._chat_progress = chat_progress
        self._busy = False
        self._current: asyncio.Task[None] | None = None
        self._pending_stop = False
        self._disconnected = False
        self._task_version = 0
        self._task_text = ""
        self._last_outcome: TaskOutcome | None = None
        self._revision_task: asyncio.Task[None] | None = None
        self._say_lock = asyncio.Lock()
        self._last_say = 0.0
        self._runner = TaskRunner(
            backend,
            planner,
            config,
            logs,
            notify=self._notify_progress,
            memory=memory,
        )

    @property
    def sender(self) -> str:
        return self._config.minecraft.username

    @property
    def busy(self) -> bool:
        return self._busy

    @property
    def runner(self) -> TaskRunner:
        return self._runner

    async def start(self, timeout: float | None = None) -> dict[str, Any]:
        ready = await self._backend.start(timeout=timeout)
        self._disconnected = False
        return ready

    async def _notify_progress(self, message: str) -> None:
        self._emit(message)
        if self._chat_progress:
            await self._say(message)

    async def _say(self, message: str, *, quiet: bool = True) -> bool:
        text = " ".join(str(message).split())
        if not text:
            return False
        if text.startswith("/"):
            text = "（" + text[1:]
        text = text[:190]
        if self._disconnected:
            return False
        try:
            async with self._say_lock:
                delay = 1.2 - (time.monotonic() - self._last_say)
                if delay > 0:
                    if quiet:
                        return False  # Coalesce progress; never queue stale chatter.
                    await asyncio.sleep(delay)
                self._last_say = time.monotonic()
                await self._backend.request("say", {"message": text}, timeout=3.0)
                return True
        except (AgentError, asyncio.TimeoutError):
            return False
        except Exception:
            return False

    # ------------------------------------------------------------------
    async def handle_chat(self, username: str, message: str) -> str:
        if not isinstance(username, str) or not isinstance(message, str):
            return "ignored"
        if username != self._config.agent.owner:
            self._logs.task(
                {
                    "type": "chat_rejected",
                    "username": username[:32],
                    "reason": "unauthorized_player",
                }
            )
            # Do not expose task state or tools to other players.
            return "unauthorized"
        prefix = self._config.agent.prefix
        if not message.startswith(prefix):
            return "ignored"
        command = message[len(prefix) :].strip()
        if command.casefold() in _STOP_COMMANDS:
            return await self.stop_current(source="chat")
        clarification_context = None
        if command.startswith("回答"):
            answer = command[2:].strip(" ：:")
            if self._busy or not self._last_outcome or self._last_outcome.end_state != "needs_clarification":
                await self._say("当前没有等待回答的澄清问题。", quiet=False)
                return "idle"
            if not answer:
                return "empty"
            clarification_context = {
                "original_task": self._task_text,
                "question": self._last_outcome.message,
                "answer": answer,
                "previous_goal": self._last_outcome.goal,
                "verified_steps": [s for s in self._last_outcome.steps if s["status"] == "succeeded"],
                "last_observation": self._last_outcome.final_observation,
            }
            command = answer
        if command.startswith("纠正"):
            correction = command[2:].strip(" ：:")
            if not correction:
                await self._say("请说明如何纠正，例如：!agent 纠正 改放入坐标8 -60 0的箱子。", quiet=False)
                return "empty"
            if not self._busy:
                await self._say("当前没有执行中的任务。", quiet=False)
                return "idle"
            if self._revision_task and not self._revision_task.done():
                return "busy"
            self._task_version += 1
            self._revision_task = asyncio.create_task(self._correct_task(correction, self._task_version))
            self._revision_task.add_done_callback(self._consume_task_result)
            return "correcting"
        if self._busy or (self._revision_task and not self._revision_task.done()):
            await self._say("正在执行另一个任务，请稍后再试。", quiet=False)
            self._logs.task(
                {
                    "type": "chat_rejected",
                    "username": username[:32],
                    "reason": "busy",
                }
            )
            return "busy"
        if not command:
            await self._say("请输入任务内容，例如：!agent 收集 4 个橡木原木。", quiet=False)
            return "empty"

        self._busy = True
        self._task_version += 1
        self._task_text = command
        self._last_outcome = None
        self._pending_stop = False
        self._current = asyncio.create_task(
            self._chat_task(command, self._task_version, clarification_context), name="basic-agent-chat-task"
        )
        self._current.add_done_callback(self._consume_task_result)
        return "started"

    def _consume_task_result(self, task: asyncio.Task[None]) -> None:
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass

    async def _chat_task(self, command: str, version: int = 1, continuation: dict | None = None) -> None:
        try:
            if self._pending_stop:
                self._pending_stop = False
                await self._say("已取消任务。", quiet=False)
                return
            try:
                outcome = await self._runner.run(command, task_version=version, continuation_context=continuation)
                self._last_outcome = outcome
            except Exception as exc:
                self._emit(f"任务启动失败：{type(exc).__name__}: {exc}")
                await self._say(f"任务启动失败：{type(exc).__name__}", quiet=False)
                return
            await self._say(outcome.message, quiet=False)
        finally:
            self._busy = False
            self._current = None

    async def _correct_task(self, correction: str, version: int) -> None:
        current = self._current
        original = self._task_text
        await self._runner.cancel("玩家纠正任务")
        if not self._runner.active:
            self._pending_stop = True
        if current is not None:
            try:
                await asyncio.wait_for(asyncio.shield(current), 8.0)
            except asyncio.TimeoutError:
                await self._say("旧任务仍在停止，未启动纠正后的动作。请稍后重试。", quiet=False)
                return
        if version != self._task_version or self._disconnected:
            return
        prior = self._last_outcome
        continuation = {
            "original_task": original,
            "correction": correction,
            "previous_task_id": prior.task_id if prior else None,
            "previous_goal": prior.goal if prior else None,
            "verified_steps": [s for s in prior.steps if s["status"] == "succeeded"][-8:] if prior else [],
            "last_observation": prior.final_observation if prior else None,
            "note": "Re-observe current state. Preserve completed work; do not repeat material consumption.",
        }
        self._busy = True
        self._pending_stop = False
        self._current = asyncio.create_task(self._chat_task(correction, version, continuation))
        self._current.add_done_callback(self._consume_task_result)

    async def stop_current(self, *, source: str = "chat") -> str:
        self._task_version += 1
        if not self._busy:
            if source == "chat":
                await self._say("当前没有执行中的任务。", quiet=False)
            return "idle"
        was_active = self._runner.active
        cancelled = await self._runner.cancel("玩家停止任务" if source == "chat" else "停止任务")
        if not was_active and not cancelled and self._current is not None:
            self._pending_stop = True
        if source == "chat":
            await self._say("正在停止当前任务。", quiet=False)
        return "cancelled"

    # ------------------------------------------------------------------
    async def run_single(
        self, task_text: str, goal_json: dict[str, Any] | None = None
    ) -> TaskOutcome:
        """Run one task for ``--task`` mode while still watching disconnects."""

        self._busy = True
        monitor = asyncio.create_task(
            self._single_monitor(), name="basic-agent-disconnect-monitor"
        )
        try:
            outcome = await self._runner.run(task_text, goal_json)
            return outcome
        finally:
            monitor.cancel()
            await asyncio.gather(monitor, return_exceptions=True)
            self._busy = False

    async def _single_monitor(self) -> None:
        while True:
            try:
                event = await self._backend.next_event()
            except asyncio.CancelledError:
                raise
            except (TransportError, Exception):
                return
            event_name = event.get("event") if isinstance(event, dict) else None
            if event_name == "disconnect":
                self._disconnected = True
                if self._runner.active:
                    await self._runner.cancel("执行器连接断开")
                return
            if event_name == "chat":
                data = event.get("data") if isinstance(event, dict) else None
                if isinstance(data, dict):
                    # --task mode is terminal-only; never start nested chat work.
                    self._logs.task(
                        {
                            "type": "chat_ignored",
                            "reason": "single_task_mode",
                            "username": str(data.get("username", ""))[:32],
                        }
                    )

    # ------------------------------------------------------------------
    async def run_forever(self) -> None:
        await self._backend.start()
        while True:
            try:
                event = await self._backend.next_event()
            except asyncio.CancelledError:
                raise
            except TransportError:
                break
            if not isinstance(event, dict):
                continue
            name = event.get("event")
            data = event.get("data")
            if not isinstance(data, dict):
                data = {}
            if name == "chat":
                username = data.get("username")
                message = data.get("message")
                if isinstance(username, str) and isinstance(message, str):
                    await self.handle_chat(username, message)
                continue
            if name == "disconnect":
                self._disconnected = True
                reason = data.get("reason")
                self._emit(
                    "执行器连接断开，取消当前任务。"
                    + (f"（{reason}）" if isinstance(reason, str) and reason else "")
                )
                if self._busy:
                    await self._runner.cancel("执行器连接断开")
                break
            if name == "error":
                self._emit("执行器错误事件：" + str(data.get("message", ""))[:160])
                self._logs.task({"type": "executor_error", "data": data})
        await self._wait_current(timeout=5.0)

    async def _wait_current(self, timeout: float) -> None:
        task = self._current
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=timeout)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass

    async def shutdown(self) -> None:
        self._task_version += 1
        if self._busy or self._runner.active:
            await self._runner.cancel("代理关闭")
        task = self._current
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=6.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        await self._backend.shutdown()
        if self._revision_task and not self._revision_task.done():
            self._revision_task.cancel()
            await asyncio.gather(self._revision_task, return_exceptions=True)
