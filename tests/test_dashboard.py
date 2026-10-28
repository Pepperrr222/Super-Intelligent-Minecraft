"""Read-only dashboard contracts and live runner evidence (fake backend)."""
import asyncio
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

from sim_agent.app.dashboard import DashboardServer, read_tail, snapshot
from sim_agent.execution.runner import TaskRunner
from sim_agent.observability.jsonl import RuntimeLogs, redact
from test_planner import FakeBackend, ScriptedPlanner, make_config, observation


class DashboardTests(unittest.TestCase):
    def test_partial_lines_and_large_history_are_bounded(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / "trace.jsonl"
            path.write_bytes(b'{"type":"progress","task_id":"old"}\n' * 20 + b'{"type":"task_end","task_id":"latest","end_state":"completed"}\n' + b'{"unfinished":')
            with patch("sim_agent.app.dashboard.MAX_TAIL_BYTES", 160):
                rows, clipped = read_tail(path)
                self.assertTrue(clipped)
                self.assertEqual(rows[-1]["task_id"], "latest")
                self.assertTrue(snapshot(root)["limited_history"])

    def test_http_only_exposes_trace_and_projected_legacy_summaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "tasks.jsonl").write_text(json.dumps({"type": "task_end", "task_id": "old", "task": "旧任务", "end_state": "failed", "state": {"raw_private_data": "MUST_NOT_EXPOSE"}, "final_observation": {"position": {"x": 1, "y": 64, "z": 0}, "private_field": "MUST_NOT_EXPOSE"}}) + "\n", encoding="utf-8")
            (root / "config.json").write_text('MUST_NOT_SERVE_CONFIG', encoding="utf-8")
            server = DashboardServer(root, port=0).start()
            try:
                with urllib.request.urlopen(server.url + "/api/snapshot") as response:
                    raw = response.read().decode()
                    self.assertEqual(response.headers["Cache-Control"], "no-store")
                self.assertNotIn("MUST_NOT_EXPOSE", raw)
                data = json.loads(raw)
                self.assertEqual(data["tasks"][0]["status"], "failed")
                self.assertTrue(data["tasks"][0]["historical"])
                self.assertEqual(data["tasks"][0]["observation"]["position"]["x"], 1)
                for route in ["/config.json", "/.secrets/model.key", "/../config.json"]:
                    with self.assertRaises(urllib.error.HTTPError) as exc:
                        urllib.request.urlopen(server.url + route)
                    self.assertEqual(exc.exception.code, 404)
                with urllib.request.urlopen(server.url) as response:
                    page = response.read().decode()
                self.assertIn("textContent", page)
                self.assertNotIn("innerHTML", page)
            finally:
                server.close()

    def test_hidden_reasoning_and_credentials_are_redacted(self):
        safe = redact({"reasoning_content": "PRIVATE", "thinking_content": "PRIVATE", "api_key": "PRIVATE", "message": "检查配方后合成"})
        self.assertNotIn("PRIVATE", json.dumps(safe))
        self.assertEqual(safe["message"], "检查配方后合成")


class LiveTraceTests(unittest.IsolatedAsyncioTestCase):
    async def test_proposal_is_visible_before_action_settles(self):
        entered, release = asyncio.Event(), asyncio.Event()
        class WaitingBackend(FakeBackend):
            async def request(self, op, args, timeout=None):
                if op == "act":
                    entered.set()
                    await release.wait()
                return await super().request(op, args, timeout)

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            logs = RuntimeLogs(root / "runtime")
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 1}
            planner = ScriptedPlanner([
                {"goal": goal, "step": {"op": "act", "args": {"kind": "collect", "block": "minecraft:oak_log", "count": 1}}, "message": "背包暂无原木，先采集一根。"},
                {"goal": goal, "step": {"op": "finish", "args": {}}},
            ])
            backend = WaitingBackend([observation(), observation({"minecraft:oak_log": 1})])
            task = asyncio.create_task(TaskRunner(backend, planner, make_config(root), logs).run("采集一根原木", requested_by="PlayerA"))
            try:
                await asyncio.wait_for(entered.wait(), 2)
                data = snapshot(logs.runtime_dir)
                self.assertEqual(data["tasks"][0]["status"], "running")
                self.assertEqual(data["tasks"][0]["requested_by"], "PlayerA")
                proposal = next(e for e in data["events"] if e["type"] == "proposal")
                self.assertEqual(proposal["message"], "背包暂无原木，先采集一根。")
                self.assertFalse(any(e["type"] == "result" for e in data["events"]))
                release.set()
                outcome = await asyncio.wait_for(task, 2)
                self.assertTrue(outcome.completed)
                data = snapshot(logs.runtime_dir)
                self.assertEqual(data["tasks"][0]["status"], "completed")
                self.assertTrue(any(e["type"] == "verification" and e["verification"]["ok"] for e in data["events"]))
            finally:
                release.set()
                await asyncio.gather(task, return_exceptions=True)
                logs.close()

    async def test_false_finish_is_visible_as_failed_verification(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            logs = RuntimeLogs(root / "runtime")
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}
            planner = ScriptedPlanner([{"goal": goal, "step": {"op": "finish", "args": {}}, "message": "请求检查目标"}], repeat_last=True)
            try:
                outcome = await TaskRunner(FakeBackend([observation()]), planner, make_config(root), logs).run("检查四根原木")
                self.assertFalse(outcome.completed)
                data = snapshot(logs.runtime_dir)
                self.assertEqual(data["tasks"][0]["status"], "failed")
                checks = [e for e in data["events"] if e["type"] == "verification"]
                self.assertTrue(checks)
                self.assertTrue(all(e["verification"]["ok"] is False for e in checks))
                self.assertTrue(any(e["type"] == "rejected" for e in data["events"]))
            finally:
                logs.close()
