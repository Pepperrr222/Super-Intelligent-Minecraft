"""Persistent JSONL logs for transport requests, tasks and model usage."""

from __future__ import annotations

import json
import threading
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping

_SENSITIVE_KEY_PARTS = (
    "api_key",
    "apikey",
    "authorization",
    "password",
    "secret",
    "access_token",
    "refresh_token",
    "reasoning_content",
    "thinking_content",
    "chain_of_thought",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def redact(value: Any, *, depth: int = 0) -> Any:
    """Return a JSON-safe copy with credential-looking fields removed."""

    if depth > 8:
        return "<max-depth>"
    if isinstance(value, Mapping):
        result: dict[str, Any] = {}
        for raw_key, raw_value in value.items():
            key = str(raw_key)
            lowered = key.lower()
            if any(part in lowered for part in _SENSITIVE_KEY_PARTS):
                result[key] = "<redacted>"
            else:
                result[key] = redact(raw_value, depth=depth + 1)
        return result
    if isinstance(value, (list, tuple)):
        return [redact(item, depth=depth + 1) for item in value[:500]]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return repr(value)[:1000]


class JsonlLog:
    """Small append-only JSONL writer safe to call from the event loop."""

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._fh = self.path.open("a", encoding="utf-8", buffering=1)

    def write(self, record: Mapping[str, Any]) -> None:
        payload = redact(dict(record))
        line = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
        with self._lock:
            if self._fh.closed:
                return
            self._fh.write(line + "\n")
            self._fh.flush()

    def close(self) -> None:
        with self._lock:
            if not self._fh.closed:
                self._fh.close()


class RuntimeLogs:
    """Protocol logs plus a separate public decision-summary event stream."""

    def __init__(self, runtime_dir: Path) -> None:
        self.runtime_dir = Path(runtime_dir)
        self.runtime_dir.mkdir(parents=True, exist_ok=True)
        self.requests = JsonlLog(self.runtime_dir / "requests.jsonl")
        self.tasks = JsonlLog(self.runtime_dir / "tasks.jsonl")
        self.usage = JsonlLog(self.runtime_dir / "usage.jsonl")
        self.traces = JsonlLog(self.runtime_dir / "trace.jsonl")
        self.calls_dir = self.runtime_dir / "model-calls"
        self.calls_dir.mkdir(parents=True, exist_ok=True)
        self.call_index = JsonlLog(self.calls_dir / "index.jsonl")
        self._calls = {}
        self._closed = False

    def request(self, record: Mapping[str, Any]) -> None:
        self.requests.write({"ts": utc_now(), **dict(record)})

    def task(self, record: Mapping[str, Any]) -> None:
        self.tasks.write({"ts": utc_now(), **dict(record)})

    def model_usage(self, record: Mapping[str, Any]) -> None:
        self.usage.write({"ts": utc_now(), **dict(record)})

    def trace(self, record: Mapping[str, Any]) -> None:
        self.traces.write({"ts": utc_now(), **dict(record)})

    def model_event(self, record: Mapping[str, Any]) -> None:
        """Archive approved provider-output channels separately from generic logs."""
        if self._closed:
            return
        call_id = record.get("call_id", "")
        if not isinstance(call_id, str) or not re.fullmatch(r"call-[a-f0-9]{32}", call_id):
            raise ValueError("Invalid model call id")
        kind = record.get("type")
        if kind == "model_start":
            meta = {k: record[k] for k in ("call_id", "task_id", "step", "model", "provider", "thinking", "stream", "role", "purpose", "root_task_id", "task_version", "plan_revision", "stage_id", "attempt_id") if k in record}
            meta.update(status="receiving", ts=utc_now(), reasoning_chars=0, decision_chars=0)
            state = {"meta": meta, "reasoning": [], "decision": [], "last_publish": time.monotonic(),
                     "log": JsonlLog(self.calls_dir / (call_id + ".jsonl"))}
            self._calls[call_id] = state
            state["log"].write({"type": "start", **meta})
            self.call_index.write(meta)
            self.trace({"type": "model_start", **meta})
            return
        state = self._calls.get(call_id)
        if state is None:
            return
        meta = state["meta"]
        if kind == "model_delta":
            channel, text = record.get("channel"), record.get("text")
            if channel not in {"reasoning", "decision"} or not isinstance(text, str):
                raise ValueError("Invalid model output channel")
            state[channel].append(text)
            meta[channel + "_chars"] += len(text)
            state["log"].write({"type": "delta", "channel": channel, "text": text})
            if time.monotonic() - state["last_publish"] >= 0.3:
                meta["ts"] = utc_now()
                self.call_index.write(meta)
                state["last_publish"] = time.monotonic()
        elif kind == "model_end":
            for key in ("status", "finish_reason", "reasoning_status", "usage", "usage_incomplete"):
                if key in record:
                    meta[key] = record[key]
            meta["ts"] = utc_now()
            meta.setdefault("reasoning_status", "provided" if meta["reasoning_chars"] else
                            ("disabled" if meta.get("thinking") is False else "not_provided"))
            state["log"].write({"type": "end", **meta})
            state["log"].close()
            payload = {**meta, "reasoning": "".join(state["reasoning"]), "decision": "".join(state["decision"])}
            temporary = self.calls_dir / (call_id + ".tmp")
            temporary.write_text(json.dumps(redact(payload), ensure_ascii=False), encoding="utf-8")
            temporary.replace(self.calls_dir / (call_id + ".json"))
            self.call_index.write(meta)
            self.trace({"type": "model_end", **meta})
            del self._calls[call_id]

    def close(self) -> None:
        for call_id in list(self._calls):
            self.model_event({"type": "model_end", "call_id": call_id, "status": "interrupted", "usage_incomplete": True})
        self._closed = True
        self.requests.close()
        self.tasks.close()
        self.usage.close()
        self.traces.close()
        self.call_index.close()


class NullLogs:
    """No-op logger used by tests and embedders."""

    def request(self, record: Mapping[str, Any]) -> None:
        return None

    def task(self, record: Mapping[str, Any]) -> None:
        return None

    def model_usage(self, record: Mapping[str, Any]) -> None:
        return None

    def trace(self, record: Mapping[str, Any]) -> None:
        return None

    def model_event(self, record: Mapping[str, Any]) -> None:
        return None

    def close(self) -> None:
        return None
