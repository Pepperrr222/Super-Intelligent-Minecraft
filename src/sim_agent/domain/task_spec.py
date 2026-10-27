"""Serializable task contract projected from program-owned state."""
from __future__ import annotations
from dataclasses import dataclass
from typing import Any
from sim_agent.domain.goals import Goal, goal_leaves, container_key


@dataclass(frozen=True, slots=True)
class TaskSpec:
    intent: str
    goal: dict[str, Any]
    bindings: dict[str, dict[str, Any]]
    constraints: dict[str, Any]
    completion: dict[str, Any]
    task_version: int

    def to_dict(self) -> dict[str, Any]:
        return {name: getattr(self, name) for name in self.__dataclass_fields__}

    @classmethod
    def from_goal(cls, goal: Goal, *, world_id: str | None, constraints: dict, task_version: int, containers: dict) -> "TaskSpec":
        bindings: dict[str, dict[str, Any]] = {}
        seen = set()
        for leaf in goal_leaves(goal):
            if leaf.type not in {"container_at_least", "container_delta"}:
                continue
            key = container_key(leaf.spec["position"])
            if key in seen:
                continue
            seen.add(key)
            role = "source" if leaf.type == "container_delta" and leaf.spec["delta"] < 0 else "target"
            observations = [c for c in containers.values() if isinstance(c, dict) and isinstance(c.get("position"), dict) and container_key(c["position"]) == key]
            bindings[f"{role}_{len(bindings) + 1}"] = {
                "world_id": world_id, "position": leaf.spec["position"], "role": role,
                "observed": bool(observations),
                "observed_at": observations[-1].get("observed_at") if observations else None,
                "source": "container_observation" if observations else "goal_proposal_not_yet_observed",
            }
        intent = "compound_task" if goal.type == "all_of" else goal.type
        return cls(intent, goal.to_dict(), bindings, dict(constraints), goal.to_dict(), task_version)
