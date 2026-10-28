"""asyncio JSONL transport for the Node executor.

The child process is addressed only over stdin/stdout.  Every request has a
unique id, exactly one correlated response, and a hard response deadline.
Events are queued for the service layer; a disconnect fails all in-flight
requests and appends one disconnect event.
"""

from __future__ import annotations

import asyncio
import json
from collections import deque
from pathlib import Path
from typing import Any, Protocol

from sim_agent.app.config import AppConfig
from sim_agent.adapters.node_runtime import resolve_node
from sim_agent.domain.errors import ExecutorError, TransportError, TransportTimeout
from sim_agent.observability.jsonl import NullLogs, RuntimeLogs

_MAX_LINE = 1_000_000
_ALLOWED_EVENTS = {"ready", "chat", "disconnect", "error"}


class Backend(Protocol):
    async def start(self, timeout: float | None = None) -> dict[str, Any]: ...

    async def request(
        self, op: str, args: dict[str, Any], timeout: float | None = None
    ) -> dict[str, Any]: ...

    async def stop(self) -> dict[str, Any]: ...

    async def shutdown(self) -> None: ...

    async def next_event(self, timeout: float | None = None) -> dict[str, Any]: ...


def _sanitize_message(value: Any) -> str:
    if not isinstance(value, str):
        value = str(value)
    value = value.replace("\x00", " ").strip()
    if len(value) > 500:
        value = value[:500] + "…"
    return value


class ExecutorClient:
    def __init__(
        self,
        config: AppConfig,
        logs: RuntimeLogs | NullLogs | None = None,
        *,
        node_executable: str | None = None,
        server_script: str | Path | None = None,
        request_timeout: float = 10.0,
        startup_timeout: float = 30.0,
    ) -> None:
        self._config = config
        self._config_path = config.config_path
        self._logs = logs or NullLogs()
        self._node = node_executable or config.node_executable
        if server_script is not None:
            self._server_script = Path(server_script)
        else:
            self._server_script = Path(__file__).resolve().parents[3] / "executor" / "server.js"
        self._request_timeout = request_timeout
        self._startup_timeout = startup_timeout

        self._proc: asyncio.subprocess.Process | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._pending: dict[str, asyncio.Future[dict[str, Any]]] = {}
        self._events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        self._ready_future: asyncio.Future[dict[str, Any]] | None = None
        self._ready_data: dict[str, Any] | None = None
        self._write_lock = asyncio.Lock()
        self._counter = 0
        self._closed = False
        self._disconnect_reported = False
        self._shutting_down = False
        self._stderr_tail: deque[str] = deque(maxlen=30)

    # ------------------------------------------------------------------
    @property
    def connected(self) -> bool:
        return (
            self._proc is not None
            and self._proc.returncode is None
            and not self._closed
            and self._ready_data is not None
        )

    @property
    def ready_data(self) -> dict[str, Any] | None:
        return self._ready_data

    async def start(self, timeout: float | None = None) -> dict[str, Any]:
        if self._closed:
            raise TransportError("执行器连接已关闭")
        if self._ready_data is not None:
            return self._ready_data
        if self._proc is not None and self._proc.returncode is None:
            assert self._ready_future is not None
            return await asyncio.wait_for(
                asyncio.shield(self._ready_future),
                timeout=self._startup_timeout if timeout is None else timeout,
            )

        if not self._server_script.exists():
            raise TransportError(f"找不到执行器脚本: {self._server_script}")
        node = resolve_node(self._node)

        loop = asyncio.get_running_loop()
        self._ready_future = loop.create_future()
        self._disconnect_reported = False
        self._closed = False
        try:
            self._proc = await asyncio.create_subprocess_exec(
                node,
                str(self._server_script),
                "--config",
                str(self._config_path),
                stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(self._server_script.parent.parent),
                limit=_MAX_LINE,
            )
        except (OSError, ValueError) as exc:
            self._ready_future = None
            raise TransportError(f"无法启动执行器子进程（{type(exc).__name__}）；请检查 Node 路径及执行权限") from exc

        self._reader_task = asyncio.create_task(
            self._reader_loop(), name="executor-stdout"
        )
        self._stderr_task = asyncio.create_task(
            self._stderr_loop(), name="executor-stderr"
        )
        try:
            ready = await asyncio.wait_for(
                asyncio.shield(self._ready_future),
                timeout=self._startup_timeout if timeout is None else timeout,
            )
        except asyncio.TimeoutError:
            await self._terminate_child()
            raise TransportError("等待执行器 ready 超时") from None
        except asyncio.CancelledError:
            await self._terminate_child()
            raise
        except TransportError:
            await self._terminate_child()
            raise
        self._ready_data = ready
        return ready

    async def _terminate_child(self) -> None:
        self._closed = True
        proc = self._proc
        if proc is not None and proc.returncode is None:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=3)
            except asyncio.TimeoutError:
                try:
                    proc.kill()
                except ProcessLookupError:
                    pass
                try:
                    await asyncio.wait_for(proc.wait(), timeout=2)
                except asyncio.TimeoutError:
                    pass
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        self._fail_pending(TransportError("执行器连接已关闭"))
        self._reader_task = None
        self._stderr_task = None

    # ------------------------------------------------------------------
    async def _reader_loop(self) -> None:
        proc = self._proc
        assert proc is not None and proc.stdout is not None
        try:
            while True:
                try:
                    line = await proc.stdout.readline()
                except (ValueError, asyncio.LimitOverrunError):
                    self._logs.request(
                        {"direction": "malformed", "error": "line too long"}
                    )
                    self._mark_disconnected("执行器输出行过长")
                    return
                if not line:
                    break
                if len(line) > _MAX_LINE:
                    self._mark_disconnected("执行器输出行过长")
                    return
                try:
                    message = json.loads(line.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    self._logs.request(
                        {"direction": "malformed", "error": "invalid json line"}
                    )
                    continue
                if not isinstance(message, dict):
                    continue
                if "id" in message and "event" not in message:
                    self._handle_response(message)
                elif "event" in message:
                    self._handle_event(message)
                else:
                    self._logs.request(
                        {"direction": "malformed", "error": "unknown message shape"}
                    )
        except asyncio.CancelledError:
            return
        except Exception as exc:  # never leak a protocol traceback to the player
            self._logs.request(
                {"direction": "reader_error", "error": type(exc).__name__}
            )
        finally:
            if not self._shutting_down and not self._closed:
                self._mark_disconnected("执行器已断开")

    def _handle_response(self, message: dict[str, Any]) -> None:
        request_id = message.get("id")
        if not isinstance(request_id, str):
            return
        future = self._pending.get(request_id)
        if future is None:
            self._logs.request(
                {
                    "direction": "late_response",
                    "id": request_id,
                    "note": "ignored",
                }
            )
            return
        if future.done():
            return
        ok = message.get("ok")
        error = message.get("error")
        result = message.get("result")
        if not isinstance(ok, bool):
            future.set_exception(TransportError("执行器响应缺少布尔 ok"))
            return
        if not ok:
            if isinstance(error, dict):
                code = error.get("code")
                text = error.get("message")
                code = code if isinstance(code, str) and code else "executor_error"
                text = _sanitize_message(text) if text is not None else "执行器操作失败"
            else:
                code = "executor_error"
                text = "执行器操作失败"
            future.set_exception(ExecutorError(code, text))
            return
        if result is None:
            result = {}
        if not isinstance(result, dict):
            future.set_exception(TransportError("执行器 result 不是对象"))
            return
        future.set_result(result)

    def _handle_event(self, message: dict[str, Any]) -> None:
        event = message.get("event")
        if not isinstance(event, str) or event not in _ALLOWED_EVENTS:
            self._logs.request(
                {"direction": "unknown_event", "event": str(event)[:80]}
            )
            return
        data = message.get("data")
        if not isinstance(data, dict):
            data = {}
        if event == "ready":
            if self._ready_future is not None and not self._ready_future.done():
                self._ready_future.set_result(data)
            return
        self._events.put_nowait({"event": event, "data": data})
        if event == "disconnect" and not self._disconnect_reported:
            self._disconnect_reported = True
            self._fail_pending(TransportError("执行器报告连接断开"))

    def _mark_disconnected(self, reason: str) -> None:
        self._closed = True
        self._fail_pending(TransportError(reason))
        if self._ready_future is not None and not self._ready_future.done():
            self._ready_future.set_exception(TransportError(reason))
        if not self._disconnect_reported and not self._shutting_down:
            self._disconnect_reported = True
            self._events.put_nowait(
                {
                    "event": "disconnect",
                    "data": {"reason": reason},
                }
            )

    def _fail_pending(self, error: Exception) -> None:
        for future in list(self._pending.values()):
            if not future.done():
                future.set_exception(error)

    # ------------------------------------------------------------------
    async def _send(self, message: dict[str, Any], timeout: float) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None or proc.returncode is not None:
            raise TransportError("执行器未运行")
        data = (
            json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode("utf-8")

        async def write() -> None:
            async with self._write_lock:
                assert proc.stdin is not None
                proc.stdin.write(data)
                await proc.stdin.drain()

        try:
            await asyncio.wait_for(write(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TransportTimeout("写入执行器超时") from None
        except (BrokenPipeError, ConnectionResetError) as exc:
            self._mark_disconnected("执行器 stdin 已关闭")
            raise TransportError("执行器 stdin 已关闭") from exc

    async def request(
        self, op: str, args: dict[str, Any], timeout: float | None = None
    ) -> dict[str, Any]:
        if not isinstance(op, str) or not op:
            raise TransportError("请求 op 非法")
        if not isinstance(args, dict):
            raise TransportError("请求 args 必须是对象")
        if self._closed or self._proc is None:
            raise TransportError("执行器未连接")
        deadline = self._request_timeout if timeout is None else float(timeout)
        if deadline <= 0:
            raise TransportTimeout("请求超时")
        self._counter += 1
        request_id = f"py-{self._counter}"
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        self._pending[request_id] = future
        self._logs.request(
            {
                "direction": "request",
                "id": request_id,
                "op": op,
                "args": args,
            }
        )
        try:
            await self._send({"id": request_id, "op": op, "args": args}, deadline)
            try:
                result = await asyncio.wait_for(future, timeout=deadline)
            except asyncio.TimeoutError:
                self._logs.request(
                    {
                        "direction": "timeout",
                        "id": request_id,
                        "op": op,
                        "timeout_seconds": deadline,
                    }
                )
                raise TransportTimeout(
                    f"执行器 {op} 响应超时（{deadline:.1f} 秒）"
                ) from None
            self._logs.request(
                {
                    "direction": "response",
                    "id": request_id,
                    "op": op,
                    "ok": True,
                    "result": result,
                }
            )
            return result
        except ExecutorError as exc:
            self._logs.request(
                {
                    "direction": "response",
                    "id": request_id,
                    "op": op,
                    "ok": False,
                    "error": {"code": exc.code, "message": str(exc)},
                }
            )
            raise
        except asyncio.CancelledError:
            raise
        finally:
            self._pending.pop(request_id, None)

    async def next_event(self, timeout: float | None = None) -> dict[str, Any]:
        if timeout is None:
            return await self._events.get()
        try:
            return await asyncio.wait_for(self._events.get(), timeout=timeout)
        except asyncio.TimeoutError:
            raise TransportTimeout("等待执行器事件超时") from None

    async def stop(self) -> dict[str, Any]:
        if self._proc is None or self._proc.returncode is not None or self._closed:
            return {"stopped": False}
        try:
            return await self.request("stop", {}, timeout=5.0)
        except TransportError:
            return {"stopped": False}

    async def shutdown(self) -> None:
        if self._proc is None:
            self._closed = True
            return
        self._shutting_down = True
        if self._proc.returncode is None and not self._closed:
            try:
                await self.request("shutdown", {}, timeout=5.0)
            except (TransportError, asyncio.CancelledError):
                pass
        if self._proc.stdin is not None:
            try:
                self._proc.stdin.close()
            except Exception:
                pass
        try:
            await asyncio.wait_for(self._proc.wait(), timeout=5.0)
        except asyncio.TimeoutError:
            try:
                self._proc.terminate()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=3.0)
            except asyncio.TimeoutError:
                try:
                    self._proc.kill()
                except ProcessLookupError:
                    pass
        self._closed = True
        for task in (self._reader_task, self._stderr_task):
            if task is not None and not task.done():
                task.cancel()
        if self._reader_task is not None:
            await asyncio.gather(self._reader_task, return_exceptions=True)
        if self._stderr_task is not None:
            await asyncio.gather(self._stderr_task, return_exceptions=True)
        self._reader_task = None
        self._stderr_task = None

    async def _stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        try:
            while True:
                line = await proc.stderr.readline()
                if not line:
                    return
                text = line.decode("utf-8", errors="replace").rstrip()
                if text:
                    self._stderr_tail.append(text[:1000])
        except asyncio.CancelledError:
            return
        except Exception:
            return
