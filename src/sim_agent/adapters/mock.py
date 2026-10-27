"""Deterministic in-memory fixture for development. Never represents a real game.

Only the demo's two-container recipe is modeled. Not a Minecraft simulator.
"""
from __future__ import annotations
import asyncio
import copy
from typing import Any
from sim_agent.observability.jsonl import utc_now
from sim_agent.domain.errors import ExecutorError

SOURCE = {"x": 0, "y": 64, "z": 0}
TARGET = {"x": 4, "y": 64, "z": 0}


class MockBackend:
    def __init__(self):
        self.inventory: dict[str, int] = {}
        self.containers = {0: {"minecraft:oak_log": 2}, 4: {}}
        self.actions: dict[str, dict[str, Any]] = {}
        self.events: asyncio.Queue[dict[str, Any]] = asyncio.Queue()

    async def start(self, timeout=None):
        return {"username": "MockAgent", "version": "mock", "world_id": "mock-world"}

    def _items(self, inventory):
        return [{"name": k, "count": v} for k, v in inventory.items() if v > 0]

    async def request(self, op, args, timeout=None):
        if op == "observe":
            return {"connected": True, "world_id": "mock-world", "observed_at": utc_now(),
                    "username": "MockAgent", "position": {"x": 0, "y": 64, "z": 0},
                    "health": 20, "food": 20, "dimension": "minecraft:overworld",
                    "inventory": self._items(self.inventory), "nearby_players": [],
                    "capabilities": ["observe", "inspect_container", "recipes", "act"]}
        if op == "inspect_container":
            items = self.containers.get(args["position"]["x"])
            if items is None:
                raise ExecutorError("NOT_CONTAINER", "Mock fixture has no container there")
            return {"position": args["position"], "items": self._items(items), "world_id": "mock-world", "observed_at": utc_now()}
        if op == "recipes":
            return {"world_id": "mock-world", "recipes": [{"result": {"name": "minecraft:oak_planks", "count": 4}, "ingredients": [{"name": "minecraft:oak_log", "count": 1}], "requires_table": False}]}
        if op == "act":
            before = copy.deepcopy(self.inventory)
            kind = args["kind"]
            if kind == "craft":
                if args["item"] != "minecraft:oak_planks":
                    raise ExecutorError("UNSUPPORTED", "Mock only models oak planks")
                logs = (args["count"] + 3) // 4
                if self.inventory.get("minecraft:oak_log", 0) < logs:
                    raise ExecutorError("INSUFFICIENT_ITEMS", "Mock inventory lacks logs")
                self.inventory["minecraft:oak_log"] -= logs
                self.inventory["minecraft:oak_planks"] = self.inventory.get("minecraft:oak_planks", 0) + logs * 4
            elif kind in {"withdraw", "deposit"}:
                container = self.containers[args["position"]["x"]]
                source, target = (container, self.inventory) if kind == "withdraw" else (self.inventory, container)
                item, count = args["item"], args["count"]
                if source.get(item, 0) < count:
                    raise ExecutorError("INSUFFICIENT_ITEMS", "Mock source lacks items")
                source[item] -= count
                target[item] = target.get(item, 0) + count
            else:
                raise ExecutorError("UNSUPPORTED", f"Mock does not implement {kind}")
            action_id = f"mock-{len(self.actions) + 1}"
            self.actions[action_id] = {"action_id": action_id, "kind": kind, "status": "succeeded", "effect": {"inventory_before": before, "inventory_after": copy.deepcopy(self.inventory)}}
            return {"action_id": action_id, "status": "running"}
        if op == "action_status":
            return self.actions[args["action_id"]]
        raise ExecutorError("UNSUPPORTED", f"Mock does not implement {op}")

    async def next_event(self, timeout=None):
        return await self.events.get() if timeout is None else await asyncio.wait_for(self.events.get(), timeout)

    async def stop(self):
        return {"stopped": True}

    async def shutdown(self):
        pass
