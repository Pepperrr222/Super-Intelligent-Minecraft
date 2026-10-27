"""SQLite evidence store. Skill promotion requires two separate verified runs.

This module stores declarative templates, never executable model-generated code.
Scenario IDs are supplied by the experiment harness after resetting the world.
The store cannot prove that a real server was reset; that is a harness obligation.
"""
from __future__ import annotations

import json
import sqlite3
import uuid
from importlib.resources import files
from pathlib import Path
from typing import Any

from sim_agent.observability.jsonl import redact, utc_now


def task_type(goal: dict[str, Any] | None) -> str:
    goal = goal or {}
    return f"{goal.get('type', 'unknown')}:{goal.get('item', '')}"


class ExperienceStore:
    def __init__(self, path: str | Path):
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys = ON")
        version = self.db.execute("PRAGMA user_version").fetchone()[0]
        if version > 1:
            self.db.close()
            raise ValueError("Experience database schema is newer than this application")
        self.db.executescript(files("sim_agent.memory").joinpath("migrations/001_initial.sql").read_text(encoding="utf-8"))

    def close(self) -> None:
        self.db.close()

    def record_episode(self, outcome: dict[str, Any], *, world_id: str, ruleset_id: str) -> None:
        if not world_id or not ruleset_id:
            raise ValueError("World and ruleset scope are required")
        # Task IDs are immutable. Replaying a log cannot replace its evidence.
        with self.db:
            self.db.execute(
                "INSERT INTO episodes VALUES (?, ?, ?, ?, ?, ?, ?)",
                (outcome["task_id"], world_id, ruleset_id, task_type(outcome.get("goal")),
                 outcome.get("task", ""), json.dumps(redact(outcome), ensure_ascii=False), utc_now()),
            )

    def retrieve_episodes(self, *, world_id: str, ruleset_id: str, goal: dict[str, Any], limit: int = 3) -> list[dict[str, Any]]:
        rows = self.db.execute(
            "SELECT outcome FROM episodes WHERE world_id=? AND ruleset_id=? AND task_type=? ORDER BY rowid DESC LIMIT ?",
            (world_id, ruleset_id, task_type(goal), max(0, min(limit, 3))),
        ).fetchall()
        # Evidence is advice to the planner; every action is still independently checked.
        return [json.loads(row["outcome"]) for row in rows]

    def propose_skill(self, *, world_id: str, ruleset_id: str, goal: dict[str, Any], template: dict[str, Any], dependencies: dict[str, str]) -> str:
        required = {"parameters", "preconditions", "steps", "completion"}
        if not world_id or not ruleset_id or not isinstance(template, dict) or not required <= template.keys():
            raise ValueError("Skill needs scope, parameters, preconditions, steps and completion")
        if not isinstance(dependencies, dict) or not dependencies or not all(isinstance(k, str) and isinstance(v, str) and k and v for k, v in dependencies.items()):
            raise ValueError("Skill dependencies need non-empty rule fingerprints")
        skill_id = "skill-" + uuid.uuid4().hex[:12]
        with self.db:
            self.db.execute("INSERT INTO skills VALUES (?, ?, ?, ?, 'candidate', ?, ?, ?)",
                            (skill_id, world_id, ruleset_id, task_type(goal), json.dumps(template, ensure_ascii=False), json.dumps(dependencies), utc_now()))
        return skill_id

    def record_validation(self, skill_id: str, *, scenario_id: str, task_id: str) -> None:
        skill = self.db.execute("SELECT * FROM skills WHERE skill_id=?", (skill_id,)).fetchone()
        episode = self.db.execute("SELECT * FROM episodes WHERE task_id=?", (task_id,)).fetchone()
        if not skill or not episode or not scenario_id:
            raise ValueError("Validation requires an existing skill, episode and reset-scenario ID")
        outcome = json.loads(episode["outcome"])
        if skill["status"] == "invalidated" or any(skill[k] != episode[k] for k in ("world_id", "ruleset_id", "task_type")):
            raise ValueError("Validation scope does not match the candidate")
        if outcome.get("end_state") != "completed" or (outcome.get("verification") or {}).get("ok") is not True:
            raise ValueError("Validation needs a program-verified successful episode")
        if outcome.get("validation_skill_id") != skill_id or outcome.get("scenario_id") != scenario_id:
            raise ValueError("Episode must identify the replayed skill and reset scenario")
        with self.db:
            self.db.execute("INSERT INTO skill_validations VALUES (?, ?, ?)", (skill_id, scenario_id, task_id))

    def promote_skill(self, skill_id: str) -> None:
        row = self.db.execute("SELECT status FROM skills WHERE skill_id=?", (skill_id,)).fetchone()
        count = self.db.execute("SELECT COUNT(*) FROM skill_validations WHERE skill_id=?", (skill_id,)).fetchone()[0]
        if not row or row["status"] != "candidate" or count < 2:
            raise ValueError("Promotion needs a candidate and two independent successful scenarios")
        with self.db:
            self.db.execute("UPDATE skills SET status='verified' WHERE skill_id=?", (skill_id,))

    def retrieve_skills(self, *, world_id: str, ruleset_id: str, goal: dict[str, Any], dependencies: dict[str, str]) -> list[dict[str, Any]]:
        rows = self.db.execute("SELECT * FROM skills WHERE world_id=? AND ruleset_id=? AND task_type=? AND status='verified' ORDER BY rowid DESC",
                               (world_id, ruleset_id, task_type(goal))).fetchall()
        return [{"skill_id": r["skill_id"], "template": json.loads(r["template"])} for r in rows
                if all(dependencies.get(k) == v for k, v in json.loads(r["dependencies"]).items())][:3]

    def invalidate_changed(self, *, world_id: str, dependencies: dict[str, str]) -> int:
        rows = self.db.execute("SELECT skill_id, dependencies FROM skills WHERE world_id=? AND status != 'invalidated'", (world_id,)).fetchall()
        changed = [r["skill_id"] for r in rows if any(k in dependencies and dependencies[k] != v for k, v in json.loads(r["dependencies"]).items())]
        with self.db:
            self.db.executemany("UPDATE skills SET status='invalidated' WHERE skill_id=?", [(k,) for k in changed])
        return len(changed)
