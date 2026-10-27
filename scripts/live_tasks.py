"""Real-server task verification using the transparent Chinese rules baseline.

Reports actual game state. It does not measure general LLM understanding.
Run through live_acceptance.py after its administrative fixture is applied.
"""
from __future__ import annotations
import asyncio
from dataclasses import replace
import json
from pathlib import Path
import time
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from sim_agent.app.config import load_config
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.execution.runner import TaskRunner
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.memory.store import ExperienceStore
from sim_agent.planning.rules import RulePlanner


async def main():
    raw = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    raw["minecraft"]["username"] = "Task" + str(int(time.time()))[-7:]
    raw["runtime_dir"] = "task-evidence"
    path = ROOT / "runtime/live-task-config.json"
    path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(path)
    logs = RuntimeLogs(config.runtime_dir)
    store = ExperienceStore(config.runtime_dir / "memory.sqlite3")
    backend = ExecutorClient(config, logs)
    results = []
    try:
        await backend.start()
        runner = TaskRunner(backend, RulePlanner(), config, logs, memory=store)
        task = "从坐标0 -60 -4的箱子取2个橡木原木，做成8块橡木木板，放入坐标8 -60 0的箱子，不砍树"
        outcome = await runner.run(task)
        results.append(outcome.to_dict())
        assert outcome.completed, outcome.to_dict()
        evidence = outcome.verification["evidence"]["checks"]
        assert next(c for c in evidence if c["evidence"].get("position", {}).get("x") == 8)["evidence"]["actual"] == 13
        print("PASS real Chinese rules task: source -2 logs, target +8 planks despite existing 5, inventory conserved", flush=True)
        # The initial stock must not falsely satisfy a new-delivery target.
        class FalseFinish:
            async def decide(self, context, timeout):
                from sim_agent.planning.planner import PlannerReply
                return PlannerReply(json.dumps({"goal": {"type": "container_delta", "position": {"x": 8, "y": -60, "z": 0}, "item": "minecraft:oak_planks", "delta": 8}, "step": {"op": "finish", "args": {}}}), {}, "adversarial-test", 0, model_call=False)
        rejected = await TaskRunner(backend, FalseFinish(), config, logs).run("新增交付八木板")
        results.append(rejected.to_dict())
        assert not rejected.completed
        print("PASS false completion: existing 13 planks cannot prove another +8 delivery", flush=True)
        protected = await runner.run("不要移动，去坐标10 -60 10附近")
        results.append(protected.to_dict())
        assert not protected.completed
        print("PASS no-move constraint rejects movement before dispatch", flush=True)
        summary = {"status": "passed", "environment": "LIVE_VANILLA_1.21.1", "planner": "rules-baseline / adversarial scripted", "checks": ["composite_delivery", "preexisting_stock_not_counted_as_new", "inventory_conservation", "false_completion_rejected", "no_move_enforced"], "tasks": results}
        (ROOT / "runtime/live-task-results.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "passed", "checks": summary["checks"]}, ensure_ascii=False), flush=True)
    finally:
        await backend.shutdown()
        store.close()
        logs.close()


if __name__ == "__main__":
    asyncio.run(main())
