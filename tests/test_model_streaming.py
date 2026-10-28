"""Real local HTTP streams: channel isolation, partial output and cancellation."""
import asyncio
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest

from sim_agent.app.config import ModelConfig
from sim_agent.app.dashboard import read_model_call, snapshot
from sim_agent.domain.errors import ModelError, ModelTimeout
from sim_agent.execution.runner import TaskRunner
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.model import DeepSeekClient
from sim_agent.planning.planner import LLMPlanner
from sim_agent.planning.streaming import OutputAccumulator, SSEDecoder
from test_planner import FakeBackend, make_config, observation

REASONING = '接口思考原文：检查背包。{"op":"act","args":{"kind":"collect"}}只是文本。'
GOAL = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}
FINAL = json.dumps({"goal": GOAL, "step": {"op": "finish", "args": {}}, "message": "背包已有四根原木，请程序复核。"}, ensure_ascii=False)


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.release = threading.Event()
        self.received = []
        release, received = self.release, self.received

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_GET(self):
                received.append({"unexpected_redirect": True, "auth": self.headers.get("Authorization")})
                self.send_response(200)
                self.end_headers()
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(body)
                mode = body["model"]
                if mode in {"redirect", "denied"}:
                    self.send_response(302 if mode == "redirect" else 401)
                    self.send_header("Location", f"http://localhost:{self.server.server_port}/must-not-follow")
                    self.end_headers()
                    self.wfile.write(b"PRIVATE_ERROR_BODY")
                    return
                if not body.get("stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(json.dumps({"choices": [{"message": {"reasoning_content": REASONING, "content": FINAL},
                        "finish_reason": "length" if mode == "truncated" else "stop"}],
                        "usage": {"total_tokens": 30}}, ensure_ascii=False).encode("utf-8"))
                    return
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                def chunk(delta, finish=None, usage=None):
                    obj = {"choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                    if usage is not None: obj["usage"] = usage
                    self.wfile.write(('data: ' + json.dumps(obj, ensure_ascii=False) + '\r\n\r\n').encode('utf-8'))
                    self.wfile.flush()
                try:
                    if mode != "no_reasoning":
                        chunk({"reasoning_content": REASONING})
                    if mode == "stall":
                        release.wait(4)
                    chunk({"content": FINAL})
                    chunk({}, "length" if mode == "truncated" else "stop",
                          {"prompt_tokens": 20, "completion_tokens": 10, "total_tokens": 30,
                           "completion_tokens_details": {"reasoning_tokens": 5}})
                    if mode != "broken":
                        self.wfile.write(b'data: [DONE]\n\n')
                        self.wfile.flush()
                except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                    pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        key = self.root / "local.key"
        key.write_text("test-only-key", encoding="utf-8")
        self.model = ModelConfig(f"http://127.0.0.1:{self.server.server_port}/v1", "valid", key, 3,
                                 provider="deepseek", thinking=True, stream=True)

    async def asyncTearDown(self):
        self.release.set()
        await asyncio.to_thread(self.server.shutdown)
        self.server.server_close()
        self.thread.join(timeout=2)
        self.tmp.cleanup()

    async def test_provider_flags_and_two_channels_preserve_original_text(self):
        for provider in ["deepseek", "siliconflow", "generic"]:
            events = []
            result = await DeepSeekClient(replace(self.model, provider=provider)).complete_observed([], 3, events.append)
            self.assertEqual(result.reasoning, REASONING)
            self.assertEqual(result.text, FINAL)
            self.assertEqual(events[-1]["status"], "completed")
            self.assertEqual(events[-1]["usage"]["reasoning_tokens"], 5)
            request = self.received[-1]
            self.assertTrue(request["stream"])
            if provider == "deepseek": self.assertEqual(request["thinking"], {"type": "enabled"})
            if provider == "siliconflow": self.assertTrue(request["enable_thinking"])
            if provider == "generic": self.assertNotIn("thinking", request)

    async def test_live_partial_text_is_available_before_final_response(self):
        seen, events = asyncio.Event(), []
        def observe(event):
            events.append(event)
            if event.get("channel") == "reasoning": seen.set()
        task = asyncio.create_task(DeepSeekClient(replace(self.model, name="stall")).complete_observed([], 3, observe))
        try:
            await asyncio.wait_for(seen.wait(), 2)
            self.assertFalse(task.done())
            self.assertFalse(any(e.get("channel") == "decision" for e in events))
            self.release.set()
            await task
        finally:
            self.release.set()
            await asyncio.gather(task, return_exceptions=True)

    async def test_non_streaming_preserves_channels_and_truncated_partial_output(self):
        config = replace(self.model, stream=False)
        events = []
        result = await DeepSeekClient(config).complete_observed([], 3, events.append)
        self.assertEqual(result.reasoning, REASONING)
        self.assertEqual(result.text, FINAL)
        events.clear()
        with self.assertRaises(ModelError):
            await DeepSeekClient(replace(config, name="truncated")).complete_observed([], 3, events.append)
        self.assertEqual(events[-1]["status"], "truncated")
        self.assertEqual(events[-1]["usage"]["total_tokens"], 30)
        self.assertTrue(any(e.get("text") == REASONING for e in events))

    async def test_truncation_interruption_http_errors_never_return_a_decision(self):
        for mode, expected in [("truncated", "truncated"), ("broken", "interrupted"), ("redirect", "error"), ("denied", "error")]:
            events = []
            with self.assertRaises(ModelError) as exc:
                await DeepSeekClient(replace(self.model, name=mode)).complete_observed([], 3, events.append)
            self.assertNotIn("PRIVATE_ERROR_BODY", str(exc.exception))
            self.assertEqual(events[-1]["status"], expected)
        self.assertEqual(len(self.received), 4)

    async def test_no_reasoning_and_timeout_have_explicit_states(self):
        events = []
        result = await DeepSeekClient(replace(self.model, name="no_reasoning", thinking=False)).complete_observed([], 3, events.append)
        self.assertEqual(result.reasoning, "")
        self.assertEqual(events[-1]["reasoning_status"], "disabled")
        events.clear()
        with self.assertRaises(ModelTimeout):
            await DeepSeekClient(replace(self.model, name="stall")).complete_observed([], 0.6, events.append)
        self.assertEqual(events[-1]["status"], "timed_out")

    async def test_cancelled_reasoning_is_archived_and_cannot_execute_late_action(self):
        logs = RuntimeLogs(self.root / "runtime")
        config = replace(make_config(self.root, task_timeout=5), model=replace(self.model, name="stall"))
        backend = FakeBackend([observation({"minecraft:oak_log": 4})])
        runner = TaskRunner(backend, LLMPlanner(DeepSeekClient(config.model)), config, logs)
        task = asyncio.create_task(runner.run("检查四根原木"))
        try:
            async with asyncio.timeout(3):
                while True:
                    calls = snapshot(logs.runtime_dir)["model_calls"]
                    if calls and read_model_call(logs.runtime_dir, calls[0]["call_id"]).get("reasoning"):
                        break
                    await asyncio.sleep(0.01)
            call_id = calls[0]["call_id"]
            started = time.monotonic()
            await runner.cancel("测试停止")
            outcome = await asyncio.wait_for(task, 1)
            self.assertLess(time.monotonic() - started, 1)
            self.assertEqual(outcome.end_state, "cancelled")
            archived = read_model_call(logs.runtime_dir, call_id)
            self.assertEqual(archived["status"], "cancelled")
            self.assertEqual(archived["reasoning"], REASONING)
            self.assertEqual(archived["decision"], "")
            self.release.set()
            await asyncio.sleep(0.05)
            self.assertEqual(backend.act_calls, 0)
            self.assertEqual(read_model_call(logs.runtime_dir, call_id)["decision"], "")
        finally:
            self.release.set()
            await asyncio.gather(task, return_exceptions=True)
            logs.close()

    async def test_reasoning_is_not_parsed_as_an_action_or_as_a_finish(self):
        logs = RuntimeLogs(self.root / "runtime")
        try:
            config = replace(make_config(self.root), model=self.model)
            backend = FakeBackend([observation({"minecraft:oak_log": 4})])
            result = await TaskRunner(backend, LLMPlanner(DeepSeekClient(self.model)), config, logs).run("检查四根原木")
            self.assertTrue(result.completed)
            self.assertEqual(backend.act_calls, 0)
            call_id = snapshot(logs.runtime_dir)["model_calls"][0]["call_id"]
            self.assertEqual(read_model_call(logs.runtime_dir, call_id)["reasoning"], REASONING)
            self.assertIsNone(read_model_call(logs.runtime_dir, "../../local.key"))
            self.assertNotIn(REASONING, (logs.runtime_dir / "trace.jsonl").read_text(encoding="utf-8"))
        finally:
            logs.close()


class SSEDecodingTests(unittest.TestCase):
    def test_utf8_multiline_frames_and_comment_keepalives(self):
        output = OutputAccumulator(lambda event: None)
        decoder = SSEDecoder(output.chunk)
        body = ': heartbeat\r\ndata: {"choices":[{"delta":\ndata: {"reasoning_content":"中文"}}]}\r\n\r\n'
        body += 'data: {"choices":[{"delta":{"content":"{}"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'
        for byte in body.encode("utf-8"):
            decoder.feed(bytes([byte]))
        decoder.finish()
        output.validate()
        self.assertEqual(output.text("reasoning"), "中文")
