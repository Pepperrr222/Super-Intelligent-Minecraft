from __future__ import annotations
import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from sim_agent.app.cli import _parse_goal_arg
from sim_agent.app.config import load_config
from sim_agent.app.demo import run_demo
from sim_agent.domain.errors import ConfigError
from sim_agent.evaluation.metrics import summarize
from sim_agent.app.config import LearningConfig
from sim_agent.execution.runner import TaskRunner
from sim_agent.memory.store import ExperienceStore
from test_planner import FakeBackend, ScriptedPlanner, make_config, observation
from dataclasses import replace

ROOT = Path(__file__).resolve().parents[1]


class ProjectTests(unittest.TestCase):
    def test_b0_does_not_retrieve_b1_does(self):
        async def check(root, mode):
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 4}
            memory = ExperienceStore(root / "experience.sqlite3")
            try:
                memory.record_episode({"task_id": "prior", "task": "取原木", "goal": goal,
                                       "end_state": "failed", "verification": None, "steps": []},
                                      world_id="basic-lab-v1", ruleset_id="r1")
                config = replace(make_config(root), learning=LearningConfig(mode, "r1", 3))
                planner = ScriptedPlanner([
                    {"goal": goal, "step": {"op": "observe", "args": {}}},
                    {"goal": goal, "step": {"op": "finish", "args": {}}},
                ])
                runner = TaskRunner(FakeBackend([observation({"minecraft:oak_log": 4})]), planner, config, memory=memory)
                outcome = await runner.run("取4个原木")
                self.assertEqual(outcome.end_state, "completed")
                contexts = [c.get("experience") for c in planner.calls if c.get("experience")]
                self.assertEqual(bool(contexts), mode == "B1")
                if mode == "B1":
                    self.assertEqual(contexts[0][0]["task_id"], "prior")
                self.assertEqual(memory.db.execute("SELECT COUNT(*) FROM episodes").fetchone()[0], 2)
            finally:
                memory.close()
        with tempfile.TemporaryDirectory() as tmp:
            for mode in ["B0", "B1"]:
                asyncio.run(check(Path(tmp) / mode, mode))

    def test_config_relative_paths_and_future_mode_rejection(self):
        with tempfile.TemporaryDirectory() as tmp:
            # Windows runners can expose TEMP via an 8.3 alias (RUNNER~1).
            # Configuration intentionally resolves it to the canonical path.
            root = Path(tmp).resolve()
            data = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
            path = root / "config.json"
            path.write_text(json.dumps(data), encoding="utf-8")
            config = load_config(path)
            self.assertEqual(config.model.key_file, root / ".secrets/model.key")
            self.assertEqual(config.runtime_dir, root / "runtime")
            data["learning"]["mode"] = "B3"
            path.write_text(json.dumps(data), encoding="utf-8")
            with self.assertRaises(ConfigError):
                load_config(path)

    def test_goal_file_argument(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "goal.json"
            goal = {"type": "inventory_at_least", "item": "minecraft:oak_log", "count": 2}
            path.write_text(json.dumps(goal), encoding="utf-8")
            self.assertEqual(_parse_goal_arg("@" + str(path)), goal)

    def test_mock_end_to_end_and_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp)
            result = asyncio.run(run_demo(ROOT / "config.example.json", out))
            self.assertEqual(result["environment"], "MOCK_ONLY")
            self.assertEqual(result["end_state"], "completed")
            self.assertTrue(result["verification"]["ok"])
            records = [json.loads(s) for s in (out / "tasks.jsonl").read_text(encoding="utf-8").splitlines()]
            report = summarize(records)
            self.assertEqual(report["verified_successes"], 1)
            self.assertEqual(report["mutation_actions"], 3)
            self.assertEqual(report["model_calls"], 0)
            self.assertTrue((out / "memory.sqlite3").exists())

    def test_unverified_completion_not_success_and_failures_kept(self):
        records = [{"type": "task_end", "task_id": str(i), "end_state": state,
                    "duration_seconds": 1, "verification": proof}
                   for i, (state, proof) in enumerate([
                       ("completed", {"ok": True}), ("completed", None), ("cancelled", None), ("failed", None)])]
        report = summarize(records)
        self.assertEqual(report["trials"], 4)
        self.assertEqual(report["success_rate"], 0.25)
        self.assertEqual(report["unverified_completions"], 1)
