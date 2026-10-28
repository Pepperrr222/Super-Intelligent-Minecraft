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
import httpx
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from sim_agent.app.config import ModelConfig
from sim_agent.domain.errors import ModelError, ModelTimeout
from sim_agent.planning.streaming import ModelObserver, OutputAccumulator, SSEDecoder, StreamError, usage_counts

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
    reasoning: str = ""


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
                body = response.read(_MAX_RESPONSE_BYTES + 1)
                if len(body) > _MAX_RESPONSE_BYTES:
                    raise StreamError("模型响应超过大小上限", "truncated")
                return response.status, body
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

    def _request_body(self, messages, *, stream):
        request_body = {
                "model": self._config.name,
                "messages": messages,
                "temperature": 0,
                "stream": stream,
                "response_format": {"type": "json_object"},
                "max_tokens": self._max_tokens,
            }
        if self._config.thinking is not None:
            if self._config.provider == "deepseek":
                request_body["thinking"] = {"type": "enabled" if self._config.thinking else "disabled"}
            elif self._config.provider == "siliconflow":
                request_body["enable_thinking"] = self._config.thinking
        if stream and self._config.provider == "deepseek":
            request_body["stream_options"] = {"include_usage": True}
        return request_body

    async def _complete_json(self, messages, timeout, output) -> ModelResult:
        key = await asyncio.to_thread(self._read_key)
        payload = json.dumps(
            self._request_body(messages, stream=False),
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
        reasoning = parsed["choices"][0]["message"].get("reasoning_content")
        output.append("reasoning", reasoning)
        output.append("decision", content)
        output.usage.update(usage_counts(parsed.get("usage")))
        output.finish_reason = parsed["choices"][0].get("finish_reason", "stop")
        if output.finish_reason == "length":
            raise ModelError("模型输出达到 token 上限，已拒绝截断结果")
        if not isinstance(content, str) or not content.strip():
            raise ModelError("模型响应内容为空")
        return ModelResult(text=content, usage=usage_counts(parsed.get("usage")), model=self._config.name,
                           reasoning=reasoning if isinstance(reasoning, str) else "")

    async def complete(self, messages, timeout) -> ModelResult:
        return await self.complete_observed(messages, timeout, None)

    async def complete_observed(self, messages, timeout, observer: ModelObserver | None) -> ModelResult:
        emit = observer or (lambda event: None)
        output = OutputAccumulator(emit)
        emit({"type": "model_start", "model": self._config.name, "provider": self._config.provider,
              "thinking": self._config.thinking, "stream": self._config.stream})

        def end(status):
            emit({"type": "model_end", "status": status, "finish_reason": output.finish_reason,
                  "reasoning_status": "provided" if output.text("reasoning") else
                      ("disabled" if self._config.thinking is False else "not_provided"),
                  "reasoning_chars": len(output.text("reasoning")), "decision_chars": len(output.text("decision")),
                  "usage": output.usage, "usage_incomplete": "total_tokens" not in output.usage})

        try:
            if self._config.stream:
                key = await asyncio.to_thread(self._read_key)
                async with asyncio.timeout(timeout):
                    async with httpx.AsyncClient(follow_redirects=False, timeout=timeout) as client:
                        async with client.stream("POST", self._endpoint,
                                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "text/event-stream"},
                                content=json.dumps(self._request_body(messages, stream=True), ensure_ascii=False).encode("utf-8")) as response:
                            if response.status_code != 200:
                                raise ModelError(f"模型服务返回 HTTP {response.status_code}")
                            if "text/event-stream" not in response.headers.get("content-type", ""):
                                raise StreamError("模型未返回 SSE 流；请检查接口的流式支持")
                            decoder = SSEDecoder(output.chunk)
                            async for chunk in response.aiter_bytes():
                                decoder.feed(chunk)
                            decoder.finish()
                output.validate()
                result = ModelResult(output.text("decision"), output.usage, self._config.name, output.text("reasoning"))
            else:
                result = await self._complete_json(messages, timeout, output)
            end("completed")
            return result
        except asyncio.CancelledError:
            end("cancelled")
            raise
        except (asyncio.TimeoutError, TimeoutError, httpx.TimeoutException):
            end("timed_out")
            raise ModelTimeout("模型请求超时") from None
        except ModelTimeout:
            end("timed_out")
            raise
        except (httpx.ReadError, httpx.RemoteProtocolError):
            end("interrupted")
            raise ModelError("模型流连接中断，已拒绝部分决策") from None
        except ModelError as exc:
            end(getattr(exc, "status", "truncated" if "token 上限" in str(exc) else "error"))
            raise
        except Exception as exc:
            end("error")
            raise ModelError(f"模型流请求失败（{type(exc).__name__}）") from None
