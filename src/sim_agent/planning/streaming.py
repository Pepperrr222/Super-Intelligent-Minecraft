"""Bounded SSE decoding for compatible reasoning and final-output channels."""
from __future__ import annotations
import codecs
import json
from typing import Callable

from sim_agent.domain.errors import ModelError

ModelObserver = Callable[[dict], None]
MAX_RESPONSE_BYTES = 2_000_000


class StreamError(ModelError):
    def __init__(self, message: str, status: str = "interrupted"):
        super().__init__(message)
        self.status = status


def usage_counts(raw) -> dict:
    if not isinstance(raw, dict):
        return {}
    result = {k: v for k in ("prompt_tokens", "completion_tokens", "total_tokens")
              if isinstance(v := raw.get(k), int) and not isinstance(v, bool) and v >= 0}
    details = raw.get("completion_tokens_details")
    if isinstance(details, dict):
        value = details.get("reasoning_tokens")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            result["reasoning_tokens"] = value
    return result


class OutputAccumulator:
    def __init__(self, emit: ModelObserver):
        self.emit = emit
        self.parts = {"reasoning": [], "decision": []}
        self.usage = {}
        self.finish_reason = None
        self.done = False

    def append(self, channel, text):
        if text is None or text == "":
            return
        if not isinstance(text, str):
            raise StreamError("模型输出通道格式无效")
        self.parts[channel].append(text)
        self.emit({"type": "model_delta", "channel": channel, "text": text})

    def chunk(self, value):
        if value == "[DONE]":
            self.done = True
            return
        if self.done:
            raise StreamError("模型在结束标记后仍返回数据")
        try:
            raw = json.loads(value)
            if not isinstance(raw, dict) or "error" in raw:
                raise ValueError
            self.usage.update(usage_counts(raw.get("usage")))
            choices = raw.get("choices", [])
            if not isinstance(choices, list):
                raise ValueError
            for choice in choices:
                if not isinstance(choice, dict) or choice.get("index", 0) != 0:
                    raise ValueError
                delta = choice.get("delta") or {}
                if not isinstance(delta, dict) or delta.get("tool_calls"):
                    raise ValueError
                if self.finish_reason is not None and (delta.get("reasoning_content") or delta.get("content")):
                    raise ValueError
                self.append("reasoning", delta.get("reasoning_content"))
                self.append("decision", delta.get("content"))
                reason = choice.get("finish_reason")
                if reason is not None:
                    self.finish_reason = reason
        except (ValueError, TypeError, AttributeError):
            raise StreamError("模型 SSE 数据格式无效") from None

    def text(self, channel):
        return "".join(self.parts[channel])

    def validate(self):
        if self.finish_reason == "length":
            raise StreamError("模型输出达到 token 上限，已拒绝截断结果", "truncated")
        if not self.done or self.finish_reason != "stop":
            raise StreamError("模型流未完整结束，已拒绝部分决策")
        if not self.text("decision").strip():
            raise StreamError("模型最终决策为空")


class SSEDecoder:
    def __init__(self, on_data):
        self.decoder = codecs.getincrementaldecoder("utf-8")()
        self.buffer = ""
        self.data = []
        self.on_data = on_data
        self.size = 0

    def feed(self, payload: bytes):
        self.size += len(payload)
        if self.size > MAX_RESPONSE_BYTES:
            raise StreamError("模型流超过大小上限，已停止接收", "truncated")
        try:
            self.buffer += self.decoder.decode(payload)
        except UnicodeDecodeError:
            raise StreamError("模型流不是有效 UTF-8") from None
        while "\n" in self.buffer:
            line, self.buffer = self.buffer.split("\n", 1)
            self.line(line.removesuffix("\r"))

    def line(self, line):
        if not line:
            if self.data:
                self.on_data("\n".join(self.data))
                self.data.clear()
        elif line.startswith("data:"):
            self.data.append(line[5:].removeprefix(" "))

    def finish(self):
        try:
            self.buffer += self.decoder.decode(b"", final=True)
        except UnicodeDecodeError:
            raise StreamError("模型流在 UTF-8 字符中断开") from None
        if self.buffer:
            self.line(self.buffer.removesuffix("\r"))
        self.line("")
