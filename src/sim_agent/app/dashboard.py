"""Read-only, bounded local view of public planning summaries and evidence."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
import re
from urllib.parse import urlsplit

from sim_agent.app.config import load_config
from sim_agent.observability.jsonl import redact

MAX_TAIL_BYTES = 2_000_000
MAX_EVENTS = 600
CALL_ID = re.compile(r"call-[a-f0-9]{32}")
MAX_CALL_BYTES = 16_000_000


def read_model_call(runtime_dir: Path, call_id: str) -> dict | None:
    if not CALL_ID.fullmatch(call_id):
        return None
    directory = runtime_dir / "model-calls"
    completed = directory / (call_id + ".json")
    try:
        with completed.open("rb") as stream:
            payload = stream.read(MAX_CALL_BYTES + 1)
        if len(payload) > MAX_CALL_BYTES:
            return {"call_id": call_id, "status": "view_limit", "view_limited": True}
        return redact(json.loads(payload))
    except (OSError, ValueError, UnicodeDecodeError):
        pass
    try:
        with (directory / (call_id + ".jsonl")).open("rb") as stream:
            payload = stream.read(MAX_CALL_BYTES + 1)
    except OSError:
        return None
    limited = len(payload) > MAX_CALL_BYTES
    result = {"call_id": call_id, "status": "receiving", "reasoning": "", "decision": "", "view_limited": limited}
    parts = {"reasoning": [], "decision": []}
    for line in payload[:MAX_CALL_BYTES].splitlines(keepends=True):
        if not line.endswith(b"\n"):
            continue
        try:
            event = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if event.get("type") in {"start", "end"}:
            result.update({k: v for k, v in event.items() if k != "type"})
        elif event.get("type") == "delta" and event.get("channel") in parts and isinstance(event.get("text"), str):
            parts[event["channel"]].append(event["text"])
    result.update({channel: "".join(values) for channel, values in parts.items()})
    return redact(result)


def read_tail(path: Path) -> tuple[list[dict], bool]:
    """Ignore incomplete concurrent writes and bound memory for large logs."""
    try:
        with path.open("rb") as stream:
            size = stream.seek(0, 2)
            offset = max(0, size - MAX_TAIL_BYTES)
            stream.seek(offset)
            if offset:
                stream.readline()  # First line may start before our window.
            payload = stream.read(MAX_TAIL_BYTES)
    except OSError:
        return [], False
    records = []
    for line in payload.splitlines(keepends=True):
        if not line.endswith(b"\n"):
            continue
        try:
            record = json.loads(line)
        except (ValueError, UnicodeDecodeError):
            continue
        if isinstance(record, dict):
            records.append(record)
    return records, bool(offset)


def snapshot(runtime_dir: Path) -> dict:
    records, clipped = read_tail(runtime_dir / "trace.jsonl")
    # Legacy task logs are projected explicitly: never expose state, raw model
    # replies, config files, protocol traffic or arbitrary paths over HTTP.
    legacy, legacy_clipped = read_tail(runtime_dir / "tasks.jsonl")
    known = {r.get("task_id") for r in records}
    fields = ("ts", "task_id", "task", "task_version", "goal", "end_state", "message", "verification", "duration_seconds", "usage")
    history = []
    for record in legacy:
        if record.get("type") != "task_end" or record.get("task_id") in known:
            continue
        event = {"type": "task_end", "historical": True, **{k: record[k] for k in fields if k in record}}
        observation = record.get("final_observation")
        if isinstance(observation, dict):
            event["observation"] = {k: observation[k] for k in ("position", "inventory", "dimension", "world_id", "observed_at", "health", "food") if k in observation}
        history.append(event)
    events = [redact(r) for r in (history[-20:] + records)[-MAX_EVENTS:]]
    tasks: dict[str, dict] = {}
    for event in events:
        task_id = event.get("task_id")
        if not isinstance(task_id, str) or not task_id:
            continue
        task = tasks.setdefault(task_id, {"task_id": task_id, "task": "任务详情不在当前日志窗口内", "status": "unknown", "last_step": 0})
        task["updated_at"] = event.get("ts")
        if event.get("type") in {"task_start", "task_end"}:
            for key in ("task", "task_version", "max_steps", "learning_mode", "historical", "duration_seconds", "requested_by"):
                if key in event:
                    task[key] = event[key]
            task["status"] = event.get("end_state", "running")
        if event.get("type") in {"goal_bound", "planning", "task_end"} and event.get("goal"):
            task["goal"] = event["goal"]
        for key in ("constraints", "observation", "verification"):
            if event.get(key) is not None and event.get("type") != "proposal":
                task[key] = event[key]
        if isinstance(event.get("step"), int):
            task["last_step"] = max(task["last_step"], event["step"])
        if event.get("type") == "proposal":
            task["model"] = event.get("model")
            task["model_call"] = event.get("model_call")
        if event.get("type") == "task_end":
            task["usage"] = event.get("usage", {})
        elif event.get("type") == "proposal":
            usage = task.setdefault("usage", {"model_calls": 0, "total_tokens": 0})
            usage["model_calls"] += int(event.get("model_call") is True)
            value = (event.get("usage") or {}).get("total_tokens", 0)
            usage["total_tokens"] += value if isinstance(value, int) and value >= 0 else 0
    ordered = sorted(tasks.values(), key=lambda t: t.get("updated_at") or "", reverse=True)[:20]
    call_records, calls_clipped = read_tail(runtime_dir / "model-calls/index.jsonl")
    calls = {}
    visible_tasks = {t["task_id"] for t in ordered}
    for record in call_records:
        call_id = record.get("call_id")
        if isinstance(call_id, str) and CALL_ID.fullmatch(call_id) and record.get("task_id") in visible_tasks:
            calls[call_id] = redact(record)
    return {"tasks": ordered, "events": events, "updated_at": events[-1].get("ts") if events else None,
            "model_calls": sorted(calls.values(), key=lambda c: c.get("ts", ""), reverse=True),
            "limited_history": clipped or legacy_clipped or calls_clipped or len(records) > MAX_EVENTS,
            "summary_only": False, "stream": "trace" if records else "legacy"}


class DashboardServer:
    def __init__(self, runtime_dir: Path, host: str = "127.0.0.1", port: int = 8765):
        runtime = Path(runtime_dir).resolve()
        page = Path(__file__).with_name("dashboard.html").read_bytes()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                route = urlsplit(self.path).path
                if route == "/":
                    payload, content_type = page, "text/html; charset=utf-8"
                elif route == "/api/snapshot":
                    payload = json.dumps(snapshot(runtime), ensure_ascii=False).encode("utf-8")
                    content_type = "application/json; charset=utf-8"
                elif route.startswith("/api/calls/"):
                    call = read_model_call(runtime, route[len("/api/calls/"):])
                    if call is None:
                        self.send_error(404)
                        return
                    payload = json.dumps(call, ensure_ascii=False).encode("utf-8")
                    content_type = "application/json; charset=utf-8"
                else:
                    self.send_error(404)
                    return
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(payload)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'")
                self.end_headers()
                try:
                    self.wfile.write(payload)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.http = ThreadingHTTPServer((host, port), Handler)
        self.thread = threading.Thread(target=self.http.serve_forever, daemon=True, name="planner-dashboard")

    @property
    def url(self):
        host, port = self.http.server_address[:2]
        return f"http://{host}:{port}"

    def start(self):
        self.thread.start()
        return self

    def close(self):
        if self.thread.is_alive():
            self.http.shutdown()
            self.thread.join(timeout=2)
        self.http.server_close()


def main(argv=None):
    parser = argparse.ArgumentParser(description="只读规划面板：决策摘要、动作反馈与独立验证")
    parser.add_argument("--config", type=Path, default=Path("config.json"))
    parser.add_argument("--runtime-dir", type=Path, help="直接查看指定运行日志目录，无需模型配置")
    parser.add_argument("--host", default="127.0.0.1", help="默认只在本机访问；显式设为 0.0.0.0 可供局域网查看")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args(argv)
    runtime = args.runtime_dir or load_config(args.config).runtime_dir
    server = DashboardServer(runtime, args.host, args.port).start()
    print(f"规划面板：{server.url}（只读，每秒刷新；Ctrl+C 关闭）", flush=True)
    try:
        while server.thread.is_alive():
            server.thread.join(timeout=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
