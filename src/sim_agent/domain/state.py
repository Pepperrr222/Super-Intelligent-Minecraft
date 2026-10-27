"""Program-owned task state: facts, completed steps, goal baseline, usage."""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any

from sim_agent.domain.errors import TransportError, ValidationError, WorldChangedError
from sim_agent.domain.goals import Goal, observation_inventory
from sim_agent.observability.jsonl import utc_now
from sim_agent.domain.validation import canonical_observed_name, position


def _number(value: Any, default: float = 0.0) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return default
    number = float(value)
    return number if math.isfinite(number) else default


def normalize_observation(raw: Any) -> dict[str, Any]:
    """Validate and canonicalise one ``observe`` result."""

    if not isinstance(raw, dict):
        raise ValidationError("observe 结果必须是对象")
    if raw.get("connected") is False:
        raise TransportError("执行器报告当前未连接游戏")
    world_id = raw.get("world_id")
    if not isinstance(world_id, str) or not world_id:
        raise ValidationError("observe 结果缺少 world_id")
    try:
        pos = position(raw.get("position"), "observe.position")
    except ValidationError as exc:
        raise ValidationError(f"observe 位置无效: {exc}") from exc

    inventory_raw = raw.get("inventory")
    if not isinstance(inventory_raw, list):
        raise ValidationError("observe 结果缺少 inventory 列表")
    inventory: list[dict[str, Any]] = []
    for index, entry in enumerate(inventory_raw):
        if not isinstance(entry, dict):
            raise ValidationError(f"observe.inventory[{index}] 必须是对象")
        name = canonical_observed_name(entry.get("name"))
        if name is None:
            raise ValidationError(f"observe.inventory[{index}].name 非法")
        count = entry.get("count")
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            raise ValidationError(f"observe.inventory[{index}].count 非法")
        inventory.append({"name": name, "count": count})

    nearby: list[dict[str, Any]] = []
    nearby_raw = raw.get("nearby_players", [])
    if isinstance(nearby_raw, list):
        for entry in nearby_raw[:50]:
            if not isinstance(entry, dict) or not isinstance(entry.get("name"), str):
                continue
            item: dict[str, Any] = {"name": entry["name"]}
            if isinstance(entry.get("position"), dict):
                try:
                    item["position"] = position(entry["position"])
                except ValidationError:
                    pass
            nearby.append(item)

    capabilities = raw.get("capabilities", [])
    if not isinstance(capabilities, list):
        capabilities = []
    observed_at = raw.get("observed_at")
    if not isinstance(observed_at, str) or not observed_at:
        observed_at = utc_now()

    return {
        "connected": True,
        "world_id": world_id,
        "observed_at": observed_at,
        "username": raw.get("username") if isinstance(raw.get("username"), str) else "",
        "position": pos,
        "health": _number(raw.get("health")),
        "food": _number(raw.get("food")),
        "dimension": raw.get("dimension") if isinstance(raw.get("dimension"), str) else "",
        "inventory": inventory,
        "nearby_players": nearby,
        "capabilities": [str(item) for item in capabilities[:64]],
    }


@dataclass(slots=True)
class Observation:
    raw: dict[str, Any]
    received_at: str = field(default_factory=utc_now)

    def to_dict(self) -> dict[str, Any]:
        return {"raw": self.raw, "received_at": self.received_at}


@dataclass(slots=True)
class StepRecord:
    index: int
    op: str
    args: dict[str, Any]
    status: str
    started_at: str
    finished_at: str = ""
    action_id: str | None = None
    result: dict[str, Any] | None = None
    error: str | None = None
    evidence: dict[str, Any] | None = None
    duration_ms: int | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "index": self.index,
            "op": self.op,
            "args": self.args,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "action_id": self.action_id,
            "result": self.result,
            "error": self.error,
            "evidence": self.evidence,
            "duration_ms": self.duration_ms,
        }


@dataclass(slots=True)
class TaskState:
    task_id: str
    task_text: str
    created_at: str = field(default_factory=utc_now)
    goal: Goal | None = None
    observation: Observation | None = None
    goal_baseline: dict[str, int] = field(default_factory=dict)
    steps: list[StepRecord] = field(default_factory=list)
    facts: dict[str, Any] = field(
        default_factory=lambda: {
            "blocks": [],
            "containers": {},
            "recipes": None,
        }
    )
    failure_counts: dict[str, int] = field(default_factory=dict)
    usage: list[dict[str, Any]] = field(default_factory=list)
    decision_count: int = 0
    observation_count: int = 0
    world_id: str | None = None
    start_inventory: dict[str, int] | None = None

    # -- goal ---------------------------------------------------------
    def set_goal(self, goal: Goal) -> None:
        """Bind the goal once; rebinding must never reset the start snapshot."""

        first_bind = self.goal is None
        if self.goal is not None and not self.goal.equivalent(goal):
            raise ValidationError("任务目标不允许中途更改")
        self.goal = goal
        if first_bind and goal.type == "inventory_increase":
            if self.start_inventory is not None:
                counts = self.start_inventory
            elif self.observation is not None:
                counts = observation_inventory(self.observation.raw)
            else:
                counts = {}
            self.goal_baseline = {
                goal.spec["item"]: counts.get(goal.spec["item"], 0)
            }

    def baseline_count(self, item: str) -> int:
        return int(self.goal_baseline.get(item, 0))

    # -- observations / facts ----------------------------------------
    def check_world(self, world_id: Any) -> None:
        if (
            self.world_id is not None
            and isinstance(world_id, str)
            and world_id != self.world_id
        ):
            # Never silently adopt a new save/world inside an existing task.
            raise WorldChangedError(
                "世界标识从 "
                f"{self.world_id} 变为 {world_id}，已中止旧任务"
            )

    def apply_observation(self, observation: dict[str, Any]) -> None:
        normalized = normalize_observation(observation)
        self.check_world(normalized["world_id"])
        if self.start_inventory is None:
            self.start_inventory = observation_inventory(normalized)
        self.observation = Observation(raw=normalized)
        self.observation_count += 1
        self.world_id = normalized["world_id"]

    def apply_query_result(self, op: str, result: dict[str, Any]) -> None:
        if op == "observe":
            self.apply_observation(result)
            return
        if op == "find_blocks":
            blocks = result.get("blocks")
            if isinstance(blocks, list):
                self.facts["blocks"] = blocks[:32]
            return
        if op == "recipes":
            recipes = result.get("recipes")
            if isinstance(recipes, list):
                self.facts["recipes"] = recipes[:32]
            else:
                self.facts["recipes"] = result
            return
        if op == "inspect_container":
            container = result.get("container")
            if isinstance(container, dict):
                key = self._position_key(container.get("position"))
                containers = self.facts.setdefault("containers", {})
                if isinstance(containers, dict):
                    containers[key] = container
                    while len(containers) > 20:
                        containers.pop(next(iter(containers)))
            return

    @staticmethod
    def _position_key(value: Any) -> str:
        if isinstance(value, dict):
            try:
                return ",".join(f"{float(value[axis]):.2f}" for axis in ("x", "y", "z"))
            except (KeyError, TypeError, ValueError):
                pass
        return "unknown"

    def add_step(self, step: StepRecord) -> None:
        self.steps.append(step)

    def completed_steps(self) -> list[dict[str, Any]]:
        return [step.to_dict() for step in self.steps if step.status == "succeeded"]

    def record_usage(
        self,
        *,
        step_index: int,
        model: str,
        usage: dict[str, Any] | None,
        latency_ms: int,
    ) -> None:
        usage = usage or {}
        integer = lambda key: (
            int(usage[key])
            if isinstance(usage.get(key), int) and not isinstance(usage.get(key), bool)
            else 0
        )
        self.usage.append(
            {
                "step": step_index,
                "model": model,
                "prompt_tokens": integer("prompt_tokens"),
                "completion_tokens": integer("completion_tokens"),
                "total_tokens": integer("total_tokens"),
                "latency_ms": latency_ms,
            }
        )

    def usage_summary(self) -> dict[str, int]:
        return {
            "calls": len(self.usage),
            "prompt_tokens": sum(item.get("prompt_tokens", 0) for item in self.usage),
            "completion_tokens": sum(
                item.get("completion_tokens", 0) for item in self.usage
            ),
            "total_tokens": sum(item.get("total_tokens", 0) for item in self.usage),
        }

    # -- model context ------------------------------------------------
    def summary_for_model(self, step_index: int, remaining_seconds: float) -> dict[str, Any]:
        recent = [step.to_dict() for step in self.steps[-8:]]
        return {
            "step_index": step_index,
            "remaining_seconds": round(max(0.0, remaining_seconds), 2),
            "goal": self.goal.to_dict() if self.goal else None,
            "latest_observation": self.observation.raw if self.observation else None,
            "completed_steps": [
                {
                    "op": step.op,
                    "args": step.args,
                    "status": step.status,
                    "evidence": step.evidence,
                }
                for step in self.steps
                if step.status == "succeeded"
            ][-8:],
            "recent_steps": recent,
            "facts": {
                "blocks": self.facts.get("blocks", [])[:12],
                "recipes": self.facts.get("recipes"),
                "containers": self.facts.get("containers", {}),
            },
        }

    # -- persistence --------------------------------------------------
    def to_dict(self) -> dict[str, Any]:
        return {
            "task_id": self.task_id,
            "task": self.task_text,
            "created_at": self.created_at,
            "goal": self.goal.to_dict() if self.goal else None,
            "goal_baseline": self.goal_baseline,
            "start_inventory": self.start_inventory,
            "world_id": self.world_id,
            "observation_count": self.observation_count,
            "decision_count": self.decision_count,
            "final_observation": self.observation.raw if self.observation else None,
            "steps": [step.to_dict() for step in self.steps],
            "facts": self.facts,
            "usage": self.usage,
            "usage_summary": self.usage_summary(),
        }


def inventory_snapshot(observation: dict[str, Any] | None) -> dict[str, int] | None:
    if not isinstance(observation, dict):
        return None
    return observation_inventory(observation)
