"""Bounded cloud-LLM tasks in real vanilla Minecraft with external checks.

One run is an engineering acceptance check, not a learning-effect benchmark.
Only the model proposes actions; the harness independently checks world deltas.
"""
from __future__ import annotations
import argparse
import asyncio
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from lab_server import VanillaLab
from live_acceptance import source_manifest
from sim_agent.app.config import load_config
from sim_agent.domain.goals import observation_inventory
from sim_agent.execution.runner import TaskRunner
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.planning.model import DeepSeekClient
from sim_agent.planning.planner import LLMPlanner
from sim_agent.observability.jsonl import RuntimeLogs, JsonlLog


class AuditedClient:
    def __init__(self, model, log):
        self.model, self.log = model, log
        self.attempts = 0
        self.usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
        self.errors = 0

    async def complete(self, messages, timeout):
        return await self.complete_observed(messages, timeout, None)

    async def complete_observed(self, messages, timeout, observer):
        self.attempts += 1
        started = time.monotonic()
        try:
            result = await self.model.complete_observed(messages, timeout, observer)
        except Exception as exc:
            self.errors += 1
            self.log.write({"attempt": self.attempts, "status": "failed", "error_type": type(exc).__name__})
            raise
        for name in self.usage:
            self.usage[name] += result.usage.get(name, 0)
        try:
            proposal = json.loads(result.text)
        except ValueError:
            proposal = {"invalid_json": True}
        self.log.write({"attempt": self.attempts, "status": "returned", "latency_seconds": round(time.monotonic() - started, 3), "usage": result.usage, "proposal": proposal})
        return result


def item_count(container, name):
    return sum(i["count"] for i in container["items"] if i["name"] == name)


async def provider_tasks(provider, lab, directory, max_steps):
    profile = ROOT / f"config.{provider}.local.json"
    config = load_config(profile)
    if config.minecraft.host != "127.0.0.1" or config.minecraft.port != 25575:
        raise RuntimeError("Refusing to test a non-lab Minecraft endpoint")
    raw = json.loads(profile.read_text(encoding="utf-8"))
    raw["minecraft"]["username"] = ("DS" if provider == "deepseek" else "SF") + str(int(time.time()))[-7:]
    raw["agent"].update(max_steps=max_steps, task_timeout_seconds=180)
    raw["runtime_dir"] = str(directory.resolve())
    raw["model"]["key_file"] = str(config.model.key_file)
    raw["learning"]["mode"] = "B0"
    private = directory / "config.json"
    directory.mkdir(parents=True, exist_ok=True)
    private.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(private)
    logs = RuntimeLogs(directory)
    audit_log = JsonlLog(directory / "model-decisions.jsonl")
    audit = AuditedClient(DeepSeekClient(config.model), audit_log)
    backend = ExecutorClient(config, logs)
    runner = TaskRunner(backend, LLMPlanner(audit), config, logs)
    cases = []
    record = {"provider": provider, "model": config.model.name, "thinking": config.model.thinking, "mode": "B0", "cases": cases}
    try:
        await lab.reset_fixture()
        await backend.start()
        # Pre-existing stock is excluded from task deltas. This is fixture setup,
        # not a tool the agent can access and not counted as produced output.
        await lab.commands([f"give {config.minecraft.username} minecraft:oak_planks 3"])
        async with asyncio.timeout(5):
            while observation_inventory(await backend.request("observe", {})).get("minecraft:oak_planks", 0) != 3:
                await asyncio.sleep(0.1)

        async def execute(case_id, text, verify):
            print(f"START {provider} {case_id}", flush=True)
            outcome = await runner.run(text)
            passed, proof = await verify(outcome)
            cases.append({"id": case_id, "task": text, "passed": passed, "end_state": outcome.end_state, "goal": outcome.goal, "usage": outcome.usage, "duration_seconds": round(outcome.duration_seconds, 3), "external_evidence": proof})
            print(json.dumps({"provider": provider, "case": case_id, "passed": passed, "end_state": outcome.end_state, "calls": outcome.usage.get("model_calls"), "error": outcome.error}, ensure_ascii=False), flush=True)

        async def navigation(outcome):
            obs = await backend.request("observe", {})
            p = obs["position"]
            distance = sum((p[a] - b) ** 2 for a, b in zip(("x", "y", "z"), (1, -60, 2))) ** 0.5
            return outcome.completed and distance <= 1, {"distance": round(distance, 3), "position": p}
        await execute("navigation", "请走到 x=1、y=-60、z=2 的位置，距离不超过一格。到达后结束任务。", navigation)

        source_pos = {"x": 0, "y": -60, "z": -4}
        target_pos = {"x": 8, "y": -60, "z": 0}
        before_inventory = observation_inventory(await backend.request("observe", {}))
        source_before = item_count(await backend.request("inspect_container", {"position": source_pos}, timeout=25), "minecraft:oak_log")
        target_before = item_count(await backend.request("inspect_container", {"position": target_pos}, timeout=25), "minecraft:oak_planks")
        async def delivery(outcome):
            source_after = item_count(await backend.request("inspect_container", {"position": source_pos}, timeout=25), "minecraft:oak_log")
            target_after = item_count(await backend.request("inspect_container", {"position": target_pos}, timeout=25), "minecraft:oak_planks")
            inv = observation_inventory(await backend.request("observe", {}))
            proof = {"source_log_delta": source_after - source_before, "target_plank_delta": target_after - target_before,
                     "initial_player_planks": before_inventory.get("minecraft:oak_planks", 0), "final_player_planks": inv.get("minecraft:oak_planks", 0),
                     "player_log_delta": inv.get("minecraft:oak_log", 0) - before_inventory.get("minecraft:oak_log", 0)}
            return outcome.completed and proof["source_log_delta"] == -2 and proof["target_plank_delta"] == 8 and proof["initial_player_planks"] == proof["final_player_planks"] and proof["player_log_delta"] == 0, proof
        await execute("constrained_delivery", "只用坐标(0,-60,-4)箱子里的两根橡木原木，做成八块橡木木板，存进坐标(8,-60,0)的箱子。目标箱要比现在新增8块，不准砍树，也不要动背包里原有的三块木板。", delivery)

        sticks_before = observation_inventory(await backend.request("observe", {})).get("minecraft:stick", 0)
        async def reserved_crafting(outcome):
            inv = observation_inventory(await backend.request("observe", {}))
            minimum = min([observation_inventory(s.get("evidence", {}).get("action", {}).get("after")).get("minecraft:oak_planks", 3) for s in outcome.steps if s["op"] == "act"] or [3])
            proof = {"stick_delta": inv.get("minecraft:stick", 0) - sticks_before, "final_planks": inv.get("minecraft:oak_planks", 0), "minimum_observed_planks": minimum}
            return outcome.completed and proof["stick_delta"] >= 4 and proof["final_planks"] >= 3 and minimum >= 3, proof
        await execute("reserved_materials", "请保留三块橡木木板，用附近原木额外制作四根木棍。可以采集，但不能消耗那三块保留木板。材料不够时先补料。", reserved_crafting)

        async def clarify(outcome):
            mutations = [s for s in outcome.steps if s["op"] == "act"]
            return outcome.end_state == "needs_clarification" and not mutations, {"mutation_count": len(mutations), "message": outcome.message}
        await execute("ambiguous_reference", "把那些东西放到那个箱子里。", clarify)
        record["status"] = "passed" if all(c["passed"] for c in cases) else "failed"
    except Exception as exc:
        record.update(status="failed", error_type=type(exc).__name__)
    finally:
        await backend.shutdown()
        record.update(api_attempts=audit.attempts, api_errors=audit.errors, usage=audit.usage, usage_incomplete=audit.errors > 0)
        (directory / "result.json").write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding="utf-8")
        logs.close()
        audit_log.close()
    return record


async def run(args):
    output = args.output or ROOT / "runtime/cloud-acceptance" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    output.mkdir(parents=True, exist_ok=True)
    before = source_manifest()
    results = []
    async with VanillaLab(output, args.java) as lab:
        for provider in args.providers:
            results.append(await provider_tasks(provider, lab, output / provider, args.max_steps))
    after = source_manifest()
    report = {"status": "passed" if before == after and all(r["status"] == "passed" for r in results) else "failed",
              "environment": "LIVE_VANILLA_1.21.1", "cloud_llm_tested": True, "rules_fallback": False,
              "providers": results, "source_unchanged": before == after, "source_manifest": after,
              "source_hash_format": "SHA-256 after normalizing text line endings to LF", "learning_improvement_measured": False}
    (output / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"status": report["status"], "output": str(output), "providers": [{"provider": r["provider"], "status": r["status"], "api_attempts": r["api_attempts"], "usage": r["usage"]} for r in results]}, ensure_ascii=False, indent=2))
    return 0 if report["status"] == "passed" else 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--providers", nargs="+", choices=["deepseek", "siliconflow"], default=["deepseek", "siliconflow"])
    parser.add_argument("--max-steps", type=int, default=10, choices=range(1, 21))
    parser.add_argument("--java")
    parser.add_argument("--output", type=Path)
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
