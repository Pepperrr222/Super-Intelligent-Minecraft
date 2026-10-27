"""Offline wiring demonstration. No model calls or Minecraft server required."""
from __future__ import annotations
import argparse
import asyncio
import json
from pathlib import Path

from sim_agent.adapters.mock import MockBackend, SOURCE, TARGET
from sim_agent.app.config import load_config
from sim_agent.execution.runner import TaskRunner
from sim_agent.memory.store import ExperienceStore
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.planner import PlannerReply


class DemoPlanner:
    def __init__(self):
        self.goal = {"type": "container_at_least", "position": TARGET, "item": "minecraft:oak_planks", "count": 8}
        self.steps = iter([
            {"op": "inspect_container", "args": {"position": SOURCE}},
            {"op": "recipes", "args": {"item": "minecraft:oak_planks"}},
            {"op": "act", "args": {"kind": "withdraw", "position": SOURCE, "item": "minecraft:oak_log", "count": 2}},
            {"op": "act", "args": {"kind": "craft", "item": "minecraft:oak_planks", "count": 8}},
            {"op": "act", "args": {"kind": "deposit", "position": TARGET, "item": "minecraft:oak_planks", "count": 8}},
            {"op": "finish", "args": {}},
        ])

    async def decide(self, context, timeout):
        return PlannerReply(json.dumps({"goal": self.goal, "step": next(self.steps)}), {}, "scripted-demo", 0, model_call=False)


async def run_demo(config_path: Path, output: Path) -> dict:
    config = load_config(config_path)
    logs = RuntimeLogs(output)
    memory = ExperienceStore(output / "memory.sqlite3")
    try:
        runner = TaskRunner(MockBackend(), DemoPlanner(), config, logs, memory=memory)
        outcome = await runner.run("离线夹具：取2个原木，合成8块木板，存入目标箱")
        result = {"environment": "MOCK_ONLY", **outcome.to_dict()}
        (output / "demo-result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        return result
    finally:
        logs.close()
        memory.close()


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Offline mock demo, not a real-game acceptance test")
    parser.add_argument("--config", type=Path, default=Path("config.example.json"))
    parser.add_argument("--output", type=Path, default=Path("runtime/demo"))
    args = parser.parse_args(argv)
    result = asyncio.run(run_demo(args.config, args.output))
    print(json.dumps({"environment": result["environment"], "status": result["end_state"], "steps": len(result["steps"]), "verification": result["verification"]}, ensure_ascii=False, indent=2))
    return 0 if result["end_state"] == "completed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
