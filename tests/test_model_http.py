"""Model adapter contract against a local HTTP endpoint; no paid API calls."""
from __future__ import annotations
import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from sim_agent.app.config import ModelConfig
from sim_agent.planning.model import DeepSeekClient
from sim_agent.domain.errors import ModelError


class ModelHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_json_request_unicode_usage_and_error_redaction(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append((self.path, self.headers.get("Authorization"), body))
                if body["model"] == "fail":
                    self.send_response(401)
                    self.end_headers()
                    self.wfile.write(b"sensitive-body-must-not-escape")
                    return
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({"choices": [{"message": {"content": '{"message":"中文响应"}'}}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}}).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as tmp:
                key = Path(tmp) / "test.key"
                key.write_text("local-test-key", encoding="utf-8")
                config = ModelConfig(f"http://127.0.0.1:{server.server_port}/v1", "local-test", key, 2)
                result = await DeepSeekClient(config).complete([{"role": "user", "content": "合成木板"}], 2)
                self.assertEqual(json.loads(result.text)["message"], "中文响应")
                self.assertEqual(result.usage["total_tokens"], 15)
                self.assertEqual(received[0][0], "/v1/chat/completions")
                self.assertEqual(received[0][1], "Bearer local-test-key")
                self.assertEqual(received[0][2]["response_format"], {"type": "json_object"})
                self.assertEqual(received[0][2]["messages"][0]["content"], "合成木板")
                bad = ModelConfig(config.base_url, "fail", key, 2)
                with self.assertRaises(ModelError) as exc:
                    await DeepSeekClient(bad).complete([], 2)
                self.assertIn("401", str(exc.exception))
                self.assertNotIn("sensitive-body", str(exc.exception))
        finally:
            await asyncio.to_thread(server.shutdown)
            server.server_close()
            thread.join(timeout=2)
