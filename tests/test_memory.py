from __future__ import annotations
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from sim_agent.memory.store import ExperienceStore

GOAL = {"type": "inventory_increase", "item": "minecraft:oak_planks", "count": 8}
TEMPLATE = {"parameters": ["n"], "preconditions": ["has logs"], "steps": [], "completion": GOAL}


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = ExperienceStore(Path(self.tmp.name) / "memory.sqlite3")

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def episode(self, task, world="w1", rules="r1", **extra):
        self.store.record_episode({"task_id": task, "task": "做木板", "goal": GOAL,
                                   "end_state": "completed", "verification": {"ok": True}, **extra},
                                  world_id=world, ruleset_id=rules)

    def skill(self):
        return self.store.propose_skill(world_id="w1", ruleset_id="r1", goal=GOAL,
                                        template=TEMPLATE, dependencies={"oak_planks": "fp1"})

    def test_episode_scope_and_limit(self):
        for i in range(5):
            self.episode(str(i))
        self.episode("other-world", world="w2")
        self.episode("other-rules", rules="r2")
        got = self.store.retrieve_episodes(world_id="w1", ruleset_id="r1", goal=GOAL, limit=50)
        self.assertEqual([e["task_id"] for e in got], ["4", "3", "2"])

    def test_episode_is_immutable_and_redacted(self):
        self.episode("a", api_key="must-never-persist")
        with self.assertRaises(sqlite3.IntegrityError):
            self.episode("a")
        row = self.store.db.execute("SELECT outcome FROM episodes").fetchone()[0]
        self.assertNotIn("must-never-persist", row)

    def test_two_independent_verified_replays_required(self):
        sid = self.skill()
        with self.assertRaises(ValueError):
            self.store.promote_skill(sid)
        self.episode("v1", validation_skill_id=sid, scenario_id="scene1")
        self.store.record_validation(sid, scenario_id="scene1", task_id="v1")
        with self.assertRaises(ValueError):
            self.store.promote_skill(sid)
        with self.assertRaises(ValueError):
            self.store.record_validation(sid, scenario_id="scene2", task_id="v1")
        self.episode("v2", validation_skill_id=sid, scenario_id="scene2")
        self.store.record_validation(sid, scenario_id="scene2", task_id="v2")
        self.store.promote_skill(sid)
        got = self.store.retrieve_skills(world_id="w1", ruleset_id="r1", goal=GOAL, dependencies={"oak_planks": "fp1"})
        self.assertEqual([s["skill_id"] for s in got], [sid])
        self.assertEqual(self.store.retrieve_skills(world_id="w1", ruleset_id="r1", goal=GOAL, dependencies={}), [])
        self.assertEqual(self.store.invalidate_changed(world_id="w1", dependencies={"unrelated": "v2"}), 0)
        self.assertEqual(self.store.invalidate_changed(world_id="w1", dependencies={"oak_planks": "fp2"}), 1)
        self.assertEqual(self.store.retrieve_skills(world_id="w1", ruleset_id="r1", goal=GOAL, dependencies={"oak_planks": "fp1"}), [])

    def test_failed_or_unrelated_replay_rejected(self):
        sid = self.skill()
        self.episode("fail", end_state="failed", verification={"ok": False}, validation_skill_id=sid, scenario_id="a")
        self.episode("unrelated")
        self.episode("wrong-scope", world="w2", validation_skill_id=sid, scenario_id="a")
        for task in ["fail", "unrelated", "wrong-scope"]:
            with self.assertRaises(ValueError):
                self.store.record_validation(sid, scenario_id="a", task_id=task)
