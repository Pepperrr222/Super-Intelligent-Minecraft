"""Owner chat handling, busy rejection and lifecycle around one task at a time."""

from __future__ import annotations

import asyncio
from typing import Any, Callable

from .config import AppConfig
from .errors import AgentError, TransportError
from .jsonl import NullLogs, RuntimeLogs
from .planner import Planner
from .runner import TaskOutcome, TaskRunner
from .transport import Backend

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
        self._runner = TaskRunner(
            backend,
            planner,
            config,
            logs,
            notify=self._notify_progress,
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
        if self._busy:
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
        self._pending_stop = False
        self._current = asyncio.create_task(
            self._chat_task(command), name="basic-agent-chat-task"
        )
        self._current.add_done_callback(self._consume_task_result)
        return "started"

    def _consume_task_result(self, task: asyncio.Task[None]) -> None:
        try:
            task.exception()
        except (asyncio.CancelledError, Exception):
            pass

    async def _chat_task(self, command: str) -> None:
        try:
            if self._pending_stop:
                self._pending_stop = False
                await self._say("已取消任务。", quiet=False)
                return
            try:
                outcome = await self._runner.run(command)
            except Exception as exc:
                self._emit(f"任务启动失败：{type(exc).__name__}: {exc}")
                await self._say(f"任务启动失败：{type(exc).__name__}", quiet=False)
                return
            await self._say(outcome.message, quiet=False)
        finally:
            self._busy = False
            self._current = None

    async def stop_current(self, *, source: str = "chat") -> str:
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
        if self._busy or self._runner.active:
            await self._runner.cancel("代理关闭")
        task = self._current
        if task is not None and not task.done():
            try:
                await asyncio.wait_for(asyncio.shield(task), timeout=6.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
        await self._backend.shutdown()
