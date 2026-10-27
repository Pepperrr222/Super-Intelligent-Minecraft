"""Goal predicates that are verified by program code, never by the model.

Supported completion predicates:

* ``inventory_at_least``   ``{"type","item","count"}``
* ``inventory_increase``   ``{"type","item","count"}`` (relative to task start)
* ``near_position``        ``{"type","position","range"}``
* ``container_at_least``   ``{"type","position","item","count"}``
* ``action_succeeded``     finite ``follow`` only
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Any

from sim_agent.domain.errors import ValidationError
from sim_agent.domain.validation import (
    _exact_keys,
    _int_range,
    canonical_item,
    canonical_json,
    canonical_observed_name,
    player_name,
    position,
)

SUPPORTED_GOAL_TYPES = frozenset(
    {
        "inventory_at_least",
        "inventory_increase",
        "near_position",
        "container_at_least",
        "action_succeeded",
        "all_of",
        "inventory_delta",
        "container_delta",
    }
)


@dataclass(frozen=True, slots=True)
class Goal:
    type: str
    spec: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return dict(self.spec)

    def equivalent(self, other: "Goal | None") -> bool:
        return other is not None and self.type == other.type and self.spec == other.spec

    def fingerprint(self) -> str:
        return canonical_json(self.spec)

    def describe(self) -> str:
        if self.type == "all_of":
            return "；".join(parse_goal(g).describe() for g in self.spec["goals"])
        if self.type in {"inventory_delta", "container_delta"}:
            where = "背包" if self.type == "inventory_delta" else f"容器 {self.spec['position']}"
            return f"{where}中 {self.spec['item']} 相对任务基线变化 {self.spec['delta']:+d}"
        if self.type == "inventory_at_least":
            return (
                f"背包中 {self.spec['item']} 至少 "
                f"{self.spec['count']} 个"
            )
        if self.type == "inventory_increase":
            return (
                f"背包中 {self.spec['item']} 比任务开始时增加至少 "
                f"{self.spec['count']} 个"
            )
        if self.type == "near_position":
            pos = self.spec["position"]
            return (
                f"到达 ({pos['x']:.1f}, {pos['y']:.1f}, {pos['z']:.1f}) "
                f"附近 {self.spec['range']} 格内"
            )
        if self.type == "container_at_least":
            pos = self.spec["position"]
            return (
                f"容器 ({pos['x']:.1f}, {pos['y']:.1f}, {pos['z']:.1f}) 中 "
                f"{self.spec['item']} 至少 {self.spec['count']} 个"
            )
        return (
            f"有限时长跟随 {self.spec.get('player', '(任何玩家)')} "
            f"{self.spec['duration_seconds']} 秒成功"
        )


def parse_goal(raw: Any, *, _depth: int = 0) -> Goal:
    if _depth > 2:
        raise ValidationError("复合目标嵌套过深")
    if not isinstance(raw, dict):
        raise ValidationError("goal 必须是对象")
    goal_type = raw.get("type")
    if not isinstance(goal_type, str) or goal_type not in SUPPORTED_GOAL_TYPES:
        raise ValidationError(
            "goal.type 必须是 " + ", ".join(sorted(SUPPORTED_GOAL_TYPES))
        )

    if goal_type == "all_of":
        _exact_keys(raw, "goal", required={"type", "goals"})
        if not isinstance(raw["goals"], list) or not 1 <= len(raw["goals"]) <= 8:
            raise ValidationError("all_of.goals 必须包含 1..8 个目标")
        children = [parse_goal(g, _depth=_depth + 1).to_dict() for g in raw["goals"]]
        if sum(1 for _ in goal_leaves(Goal(goal_type, {"type": goal_type, "goals": children}))) > 16:
            raise ValidationError("复合目标叶子数量超过16")
        return Goal(goal_type, {"type": goal_type, "goals": children})
    if goal_type in {"inventory_delta", "container_delta"}:
        required = {"type", "item", "delta"}
        if goal_type == "container_delta":
            required.add("position")
        _exact_keys(raw, "goal", required=required)
        spec = {"type": goal_type, "item": canonical_item(raw["item"], "goal.item"),
                "delta": _int_range(raw["delta"], "goal.delta", -2304, 2304)}
        if goal_type == "container_delta":
            spec["position"] = position(raw["position"], "goal.position")
        return Goal(goal_type, spec)
    if goal_type in {"inventory_at_least", "inventory_increase"}:
        _exact_keys(raw, "goal", required={"type", "item", "count"})
        spec = {
            "type": goal_type,
            "item": canonical_item(raw["item"], "goal.item"),
            "count": _int_range(raw["count"], "goal.count", 1, 2304),
        }
        return Goal(goal_type, spec)
    if goal_type == "near_position":
        _exact_keys(raw, "goal", required={"type", "position", "range"})
        spec = {
            "type": goal_type,
            "position": position(raw["position"], "goal.position"),
            "range": _int_range(raw["range"], "goal.range", 1, 16),
        }
        return Goal(goal_type, spec)
    if goal_type == "container_at_least":
        _exact_keys(
            raw, "goal", required={"type", "position", "item", "count"}
        )
        spec = {
            "type": goal_type,
            "position": position(raw["position"], "goal.position"),
            "item": canonical_item(raw["item"], "goal.item"),
            "count": _int_range(raw["count"], "goal.count", 1, 2304),
        }
        return Goal(goal_type, spec)
    # action_succeeded: accept either action or kind, both must mean follow.
    _exact_keys(
        raw,
        "goal",
        required={"type"},
        optional={"action", "kind", "player", "duration_seconds"},
    )
    action = raw.get("action", raw.get("kind", "follow"))
    if "action" in raw and "kind" in raw and raw["action"] != raw["kind"]:
        raise ValidationError("goal.action 与 goal.kind 不一致")
    if action != "follow":
        raise ValidationError("action_succeeded 目前只支持有限的 follow")
    if "duration_seconds" not in raw:
        raise ValidationError("action_succeeded 缺少 duration_seconds")
    spec = {
        "type": "action_succeeded",
        "action": "follow",
        "duration_seconds": _int_range(
            raw["duration_seconds"], "goal.duration_seconds", 1, 60
        ),
    }
    if "player" in raw:
        spec["player"] = player_name(raw["player"], "goal.player")
    return Goal(goal_type, spec)


def goal_leaves(goal: Goal):
    if goal.type == "all_of":
        for child in goal.spec["goals"]:
            yield from goal_leaves(parse_goal(child))
    else:
        yield goal


def container_key(pos: dict[str, Any]) -> str:
    return ",".join(f"{float(pos[axis]):.3f}" for axis in ("x", "y", "z"))


@dataclass(frozen=True, slots=True)
class VerificationResult:
    ok: bool
    detail: str
    evidence: dict[str, Any]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ok": self.ok,
            "detail": self.detail,
            "evidence": self.evidence,
        }


def observation_inventory(observation: dict[str, Any] | None) -> dict[str, int]:
    """Aggregate a canonical inventory list into item -> count."""

    counts: dict[str, int] = {}
    if not isinstance(observation, dict):
        return counts
    inventory = observation.get("inventory")
    if not isinstance(inventory, list):
        return counts
    for entry in inventory:
        if not isinstance(entry, dict):
            continue
        name = canonical_observed_name(entry.get("name"))
        count = entry.get("count")
        if name is None or isinstance(count, bool) or not isinstance(count, int):
            continue
        if count > 0:
            counts[name] = counts.get(name, 0) + count
    return counts


def _position_of(observation: dict[str, Any] | None) -> dict[str, float] | None:
    if not isinstance(observation, dict):
        return None
    raw = observation.get("position")
    if not isinstance(raw, dict):
        return None
    try:
        return {
            axis: float(raw[axis]) for axis in ("x", "y", "z")
        }
    except (KeyError, TypeError, ValueError):
        return None


def _distance(a: dict[str, float], b: dict[str, float]) -> float:
    return math.dist(
        (a["x"], a["y"], a["z"]), (b["x"], b["y"], b["z"])
    )


def _container_counts(container: dict[str, Any] | None) -> dict[str, int]:
    if not isinstance(container, dict):
        return {}
    items = container.get("items")
    if not isinstance(items, list):
        return {}
    counts: dict[str, int] = {}
    for entry in items:
        if not isinstance(entry, dict):
            continue
        name = canonical_observed_name(entry.get("name"))
        count = entry.get("count")
        if name is None or isinstance(count, bool) or not isinstance(count, int):
            continue
        if count > 0:
            counts[name] = counts.get(name, 0) + count
    return counts


class GoalVerifier:
    """Verify a goal from actual observations and recorded action outcomes."""

    def verify(
        self,
        goal: Goal,
        state: Any,
        *,
        observation: dict[str, Any] | None = None,
        container: dict[str, Any] | None = None,
        containers: dict[str, dict[str, Any]] | None = None,
    ) -> VerificationResult:
        obs = observation
        if obs is None and getattr(state, "observation", None) is not None:
            obs = state.observation.raw
        if not isinstance(obs, dict):
            return VerificationResult(
                False, "没有可用观察，无法验证目标。", {"reason": "no_observation"}
            )

        if goal.type == "all_of":
            checks = [self.verify(parse_goal(child), state, observation=obs,
                                  containers=containers, container=container)
                      for child in goal.spec["goals"]]
            return VerificationResult(all(c.ok for c in checks), "；".join(c.detail for c in checks),
                                      {"checks": [c.to_dict() for c in checks]})
        if goal.type == "inventory_delta":
            if getattr(state, "start_inventory", None) is None or not isinstance(obs.get("inventory"), list):
                return VerificationResult(False, "库存增量缺少真实基线或当前库存观察。", {"reason": "missing_inventory_baseline"})
            item = goal.spec["item"]
            before = (getattr(state, "start_inventory", None) or {}).get(item, 0)
            actual = observation_inventory(obs).get(item, 0)
            delta = actual - before
            return VerificationResult(delta == goal.spec["delta"],
                f"背包 {item} 基线 {before}，当前 {actual}，变化 {delta:+d}，要求 {goal.spec['delta']:+d}。",
                {"item": item, "baseline": before, "actual": actual, "delta": delta})
        if goal.type == "container_delta":
            key = container_key(goal.spec["position"])
            current = (containers or {}).get(key, container)
            baseline = getattr(state, "container_baselines", {}).get(key)
            if not current or baseline is None:
                return VerificationResult(False, "容器增量缺少独立基线或当前观察。", {"reason": "missing_container_baseline"})
            if not isinstance(current.get("items"), list) or not isinstance(baseline.get("items"), list):
                return VerificationResult(False, "容器未知库存不能视作空库存。", {"reason": "unobserved_container_inventory"})
            try:
                actual_key = container_key(current.get("position", {}))
            except (KeyError, TypeError, ValueError):
                actual_key = None
            if actual_key != key:
                return VerificationResult(False, "容器坐标与目标不一致。", {"reason": "wrong_container"})
            item = goal.spec["item"]
            before = _container_counts(baseline).get(item, 0)
            actual = _container_counts(current).get(item, 0)
            delta = actual - before
            return VerificationResult(delta == goal.spec["delta"],
                f"容器 {key} 的 {item} 基线 {before}，当前 {actual}，变化 {delta:+d}，要求 {goal.spec['delta']:+d}。",
                {"position": goal.spec["position"], "item": item, "baseline": before, "actual": actual, "delta": delta})
        if goal.type in {"inventory_at_least", "inventory_increase"}:
            counts = observation_inventory(obs)
            item = goal.spec["item"]
            needed = goal.spec["count"]
            if goal.type == "inventory_at_least":
                actual = counts.get(item, 0)
                ok = actual >= needed
                detail = f"背包中 {item} 实际 {actual} 个，目标至少 {needed} 个。"
                evidence = {
                    "item": item,
                    "needed": needed,
                    "actual": actual,
                    "inventory": {
                        key: value for key, value in counts.items() if key == item
                    },
                }
            else:
                baseline = state.baseline_count(item)
                actual = counts.get(item, 0)
                increase = actual - baseline
                ok = increase >= needed
                detail = (
                    f"背包中 {item} 从 {baseline} 个增加到 {actual} 个，"
                    f"实际增加 {increase}，目标增加至少 {needed} 个。"
                )
                evidence = {
                    "item": item,
                    "needed_increase": needed,
                    "baseline": baseline,
                    "actual": actual,
                    "increase": increase,
                }
            return VerificationResult(ok, detail, evidence)

        if goal.type == "near_position":
            current = _position_of(obs)
            if current is None:
                return VerificationResult(
                    False, "观察中缺少位置，无法验证距离目标。", {"reason": "no_position"}
                )
            target = goal.spec["position"]
            distance = _distance(current, target)
            ok = distance <= goal.spec["range"] + 1e-9
            detail = (
                f"当前位置到目标点距离 {distance:.2f} 格，"
                f"目标范围 {goal.spec['range']} 格。"
            )
            return VerificationResult(
                ok,
                detail,
                {
                    "distance": round(distance, 3),
                    "range": goal.spec["range"],
                    "target": target,
                    "actual_position": current,
                },
            )

        if goal.type == "container_at_least":
            container = (containers or {}).get(container_key(goal.spec["position"]), container)
            if not isinstance(container, dict):
                return VerificationResult(
                    False,
                    "尚未复核目标容器，不能确认目标完成。",
                    {"reason": "container_not_inspected"},
                )
            actual_position = container.get("position")
            if isinstance(actual_position, dict):
                try:
                    actual_pos = {
                        axis: float(actual_position[axis])
                        for axis in ("x", "y", "z")
                    }
                    if _distance(actual_pos, goal.spec["position"]) > 0.75:
                        return VerificationResult(
                            False,
                            "复核的容器坐标与目标坐标不一致。",
                            {
                                "expected_position": goal.spec["position"],
                                "actual_position": actual_position,
                            },
                        )
                except (KeyError, TypeError, ValueError):
                    pass
            counts = _container_counts(container)
            item = goal.spec["item"]
            actual = counts.get(item, 0)
            needed = goal.spec["count"]
            ok = actual >= needed
            detail = f"容器中 {item} 实际 {actual} 个，目标至少 {needed} 个。"
            return VerificationResult(
                ok,
                detail,
                {
                    "item": item,
                    "needed": needed,
                    "actual": actual,
                    "container": container,
                },
            )

        # action_succeeded (finite follow)
        action = goal.spec.get("action", "follow")
        duration = goal.spec["duration_seconds"]
        wanted_player = goal.spec.get("player")
        matches: list[dict[str, Any]] = []
        for step in getattr(state, "steps", []):
            if step.status != "succeeded":
                continue
            if step.op != "act" or step.args.get("kind") != action:
                continue
            if wanted_player is not None and step.args.get("player") != wanted_player:
                continue
            if step.args.get("duration_seconds") != duration:
                continue
            matches.append(
                {
                    "action_id": step.action_id,
                    "player": step.args.get("player"),
                    "duration_seconds": step.args.get("duration_seconds"),
                }
            )
        ok = bool(matches)
        if ok:
            player = matches[0].get("player") or "(任何玩家)"
            detail = (
                f"有限时长跟随成功：跟随 {player} {duration} 秒"
                "（按动作有限时长成功报告，不代表持续跟随）。"
            )
        else:
            detail = (
                f"没有找到已成功的 {duration} 秒有限 follow 动作，"
                "不能确认 action_succeeded。"
            )
        return VerificationResult(
            ok,
            detail,
            {"action": action, "duration_seconds": duration, "matches": matches},
        )
