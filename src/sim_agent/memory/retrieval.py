"""Bounded B1 episode retrieval; B2/B3 automatic skill execution is future work."""
from typing import Any
from sim_agent.memory.store import ExperienceStore


def episode_context(store: ExperienceStore, *, world_id: str, ruleset_id: str, goal: dict[str, Any], limit: int = 3) -> list[dict[str, Any]]:
    return [
        {
            "task_id": e["task_id"], "goal": e.get("goal"),
            "end_state": e.get("end_state"), "verification": e.get("verification"),
            "steps": [{"op": s["op"], "args": s["args"], "status": s["status"], "evidence": s.get("evidence"), "error": s.get("error")} for s in e.get("steps", [])[-4:]],
            "note": "Historical evidence only. Recheck current facts and constraints.",
        }
        for e in store.retrieve_episodes(world_id=world_id, ruleset_id=ruleset_id, goal=goal, limit=limit)
    ]
