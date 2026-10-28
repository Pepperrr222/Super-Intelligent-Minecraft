"""DeepSeek-compatible JSON chat-completions client.

Only ``model.key_file`` is read for credentials.  Environment variables and
other key locations are intentionally ignored.  HTTP error bodies are never
included in exceptions or logs.
"""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from sim_agent.app.config import ModelConfig
from sim_agent.domain.errors import ModelError, ModelTimeout

_MAX_RESPONSE_BYTES = 2_000_000


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        # Never forward a user's credential to a redirected host.
        return None


@dataclass(frozen=True, slots=True)
class ModelResult:
    text: str
    usage: dict[str, Any]
    model: str


class ModelClient(Protocol):
    async def complete(
        self, messages: list[dict[str, str]], timeout: float
    ) -> ModelResult: ...


class DeepSeekClient:
    def __init__(self, config: ModelConfig, *, max_tokens: int | None = None) -> None:
        self._config = config
        self._key_file = Path(config.key_file).expanduser()
        self._max_tokens = config.max_tokens if max_tokens is None else max_tokens
        base = config.base_url.rstrip("/")
        if base.endswith("/chat/completions"):
            self._endpoint = base
        else:
            self._endpoint = base + "/chat/completions"

    def _read_key(self) -> str:
        try:
            key = self._key_file.read_text(encoding="utf-8-sig").strip()
        except OSError as exc:
            # Do not include the path or OS error body; both can leak local
            # details and neither helps the player.
            raise ModelError("无法读取模型密钥文件") from exc
        if not key:
            raise ModelError("模型密钥文件为空")
        if not key.isascii() or any(c.isspace() for c in key):
            raise ModelError("密钥文件应只包含一行 API Key，不含空白或说明文字")
        return key

    def _post(self, key: str, payload: bytes, timeout: float) -> tuple[int, bytes]:
        request = urllib.request.Request(
            self._endpoint,
            data=payload,
            method="POST",
            headers={
                "Authorization": f"Bearer {key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.build_opener(_NoRedirect).open(request, timeout=timeout) as response:
                return response.status, response.read(_MAX_RESPONSE_BYTES)
        except urllib.error.HTTPError as exc:
            # Close without reading/logging the body.
            try:
                exc.close()
            except Exception:
                pass
            raise ModelError(f"模型服务返回 HTTP {exc.code}") from None
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", None)
            if isinstance(reason, TimeoutError):
                raise ModelTimeout("模型网络请求超时") from None
            raise ModelError("模型网络请求失败") from None
        except (TimeoutError, OSError):
            raise ModelTimeout("模型网络请求超时") from None

    async def complete(
        self, messages: list[dict[str, str]], timeout: float
    ) -> ModelResult:
        key = await asyncio.to_thread(self._read_key)
        request_body = {
                "model": self._config.name,
                "messages": messages,
                "temperature": 0,
                "stream": False,
                "response_format": {"type": "json_object"},
                "max_tokens": self._max_tokens,
            }
        if self._config.thinking is not None:
            if self._config.provider == "deepseek":
                request_body["thinking"] = {"type": "enabled" if self._config.thinking else "disabled"}
            elif self._config.provider == "siliconflow":
                request_body["enable_thinking"] = self._config.thinking
        payload = json.dumps(
            request_body,
            ensure_ascii=False,
        ).encode("utf-8")
        try:
            status, body = await asyncio.wait_for(
                asyncio.to_thread(self._post, key, payload, timeout),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            raise ModelTimeout("模型请求超时") from None
        if status != 200:
            raise ModelError(f"模型服务返回 HTTP {status}")
        try:
            parsed = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ModelError("模型响应不是有效 JSON") from None
        try:
            content = parsed["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError):
            raise ModelError("模型响应缺少 choices[0].message.content") from None
        if parsed["choices"][0].get("finish_reason") == "length":
            raise ModelError("模型输出达到 token 上限，已拒绝截断结果")
        if not isinstance(content, str) or not content.strip():
            raise ModelError("模型响应内容为空")
        raw_usage = parsed.get("usage")
        usage: dict[str, Any] = {}
        if isinstance(raw_usage, dict):
            for key_name in ("prompt_tokens", "completion_tokens", "total_tokens"):
                value = raw_usage.get(key_name)
                if isinstance(value, int) and not isinstance(value, bool):
                    usage[key_name] = value
        return ModelResult(text=content, usage=usage, model=self._config.name)
