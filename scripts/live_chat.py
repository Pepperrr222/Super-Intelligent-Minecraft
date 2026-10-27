"""Real multiplayer chat, finite follow, correction and cancellation acceptance.

A second ordinary Mineflayer connection sends authorized player chat. No LLM
or simulated game state is used; the rules planner is explicitly identified.
"""
from __future__ import annotations
import asyncio
from dataclasses import replace
import json
import math
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from sim_agent.app.config import load_config
from sim_agent.adapters.mineflayer import ExecutorClient
from sim_agent.execution.service import AgentService
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.rules import RulePlanner


class GateAfterCraft(RulePlanner):
    def __init__(self):
        self.waiting = asyncio.Event()

    async def decide(self, context, timeout):
        reply = await super().decide(context, timeout)
        data = json.loads(reply.text)
        if not context["state"].get("continuation_context") and data["step"]["args"].get("kind") == "deposit" and any(s["args"].get("kind") == "craft" for s in context["state"]["completed_steps"]):
            self.waiting.set()
            await asyncio.Event().wait()
        return reply


async def wait_outcome(service, old_id, timeout=45):
    async with asyncio.timeout(timeout):
        while True:
            outcome = service._last_outcome
            if outcome and outcome.task_id != old_id and not service.busy:
                revision = service._revision_task
                if revision is None or revision.done():
                    return outcome
            await asyncio.sleep(0.05)


async def main():
    raw = json.loads((ROOT / "config.json").read_text(encoding="utf-8"))
    suffix = str(int(time.time()))[-6:]
    owner = "Peer" + suffix
    raw["minecraft"]["username"] = "Chat" + suffix
    raw["agent"]["owner"] = owner
    raw["runtime_dir"] = "chat-evidence"
    config_path = ROOT / "runtime/live-chat-config.json"
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    config = load_config(config_path)
    peer_raw = json.loads(json.dumps(raw))
    peer_raw["minecraft"]["username"] = owner
    peer_path = ROOT / "runtime/live-peer-config.json"
    peer_path.write_text(json.dumps(peer_raw), encoding="utf-8")
    logs = RuntimeLogs(config.runtime_dir)
    backend = ExecutorClient(config, logs)
    peer = ExecutorClient(load_config(peer_path))
    planner = GateAfterCraft()
    service = AgentService(backend, planner, config, logs, emit=lambda _: None)
    loop = None
    checks, outcomes = [], []

    async def command(text):
        old = service._last_outcome.task_id if service._last_outcome else None
        await peer.request("say", {"message": "!agent " + text})
        return old

    try:
        await service.start()
        await peer.start()
        loop = asyncio.create_task(service.run_forever())
        await asyncio.sleep(0.3)
        old = await command("去坐标1 -60 2附近")
        result = await wait_outcome(service, old)
        assert result.completed, result.to_dict()
        outcomes.append(result.to_dict())
        checks.append("authorized_real_player_chat_dispatch")
        old = await command(f"跟随{owner} 3秒")
        result = await wait_outcome(service, old)
        assert result.completed, result.to_dict()
        outcomes.append(result.to_dict())
        checks.append("finite_follow_real_player")
        old = await command("去坐标100 -60 100附近")
        async with asyncio.timeout(10):
            while not service.runner.active:
                await asyncio.sleep(0.03)
        await peer.request("say", {"message": "!agent 纠正 去坐标2 -60 -2附近"})
        result = await wait_outcome(service, old)
        assert result.completed and result.goal["position"]["x"] == 2, result.to_dict()
        outcomes.append(result.to_dict())
        checks.append("mid_move_correction_rejects_old_continuation")
        old = await command(f"跟随{owner} 60秒")
        async with asyncio.timeout(10):
            while not service.runner.active:
                await asyncio.sleep(0.03)
        await asyncio.sleep(0.3)
        start = time.monotonic()
        await peer.request("say", {"message": "!agent 停止"})
        result = await wait_outcome(service, old)
        stop_seconds = time.monotonic() - start
        assert result.end_state == "cancelled" and stop_seconds < 5, (result.to_dict(), stop_seconds)
        outcomes.append(result.to_dict())
        checks.append("stop_during_real_follow")
        old = await command("从坐标-4 -60 -4的箱子取2个橡木原木，合成8块橡木木板，放入坐标8 -60 0的箱子，不砍树")
        await asyncio.wait_for(planner.waiting.wait(), timeout=40)
        await peer.request("say", {"message": "!agent 纠正 改放入坐标10 -60 0的箱子"})
        result = await wait_outcome(service, old)
        assert result.completed, result.to_dict()
        outcomes.append(result.to_dict())
        target = await backend.request("inspect_container", {"position": {"x": 10, "y": -60, "z": 0}}, timeout=25)
        previous = await backend.request("inspect_container", {"position": {"x": 8, "y": -60, "z": 0}}, timeout=25)
        count = lambda box: sum(i["count"] for i in box["items"] if i["name"] == "minecraft:oak_planks")
        assert count(target) == 8 and count(previous) == 13, (target, previous)
        checks.append("post_craft_correction_preserves_output_without_recrafting")
        report = {"status": "passed", "environment": "LIVE_VANILLA_1.21.1", "planner": "rules-baseline with cancellation gate", "checks": checks, "stop_seconds": round(stop_seconds, 3), "outcomes": outcomes}
        (ROOT / "runtime/live-chat-results.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"status": "passed", "checks": checks, "stop_seconds": round(stop_seconds, 3)}, ensure_ascii=False, indent=2), flush=True)
    finally:
        if loop:
            loop.cancel()
            await asyncio.gather(loop, return_exceptions=True)
        await service.shutdown()
        await peer.shutdown()
        logs.close()


if __name__ == "__main__":
    asyncio.run(main())
