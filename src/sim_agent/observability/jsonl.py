"""Persistent JSONL logs for transport requests, tasks and model usage."""

from __future__ import annotations

import json
import threading
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

    def request(self, record: Mapping[str, Any]) -> None:
        self.requests.write({"ts": utc_now(), **dict(record)})

    def task(self, record: Mapping[str, Any]) -> None:
        self.tasks.write({"ts": utc_now(), **dict(record)})

    def model_usage(self, record: Mapping[str, Any]) -> None:
        self.usage.write({"ts": utc_now(), **dict(record)})

    def trace(self, record: Mapping[str, Any]) -> None:
        self.traces.write({"ts": utc_now(), **dict(record)})

    def close(self) -> None:
        self.requests.close()
        self.tasks.close()
        self.usage.close()
        self.traces.close()


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

    def close(self) -> None:
        return None
