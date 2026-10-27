"""Program-owned constraints and conservative action guards."""
from __future__ import annotations
import math
import re
from typing import Any
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.validation import canonical_item, position, _exact_keys, _int_range
from sim_agent.domain.goals import container_key, observation_inventory


def parse_constraints(raw: Any) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValidationError("constraints 必须是对象")
    _exact_keys(raw, "constraints", required=set(), optional={"no_move", "no_collect", "keep_inventory", "allowed_sources"})
    result = {}
    for flag in ["no_move", "no_collect"]:
        if flag in raw:
            if not isinstance(raw[flag], bool):
                raise ValidationError(f"constraints.{flag} 必须为布尔值")
            result[flag] = raw[flag]
    if "keep_inventory" in raw:
        items = raw["keep_inventory"]
        if not isinstance(items, dict) or len(items) > 16:
            raise ValidationError("keep_inventory 需要至多16个物品下限")
        result["keep_inventory"] = {canonical_item(k): _int_range(v, "minimum", 0, 2304) for k, v in items.items()}
    if "allowed_sources" in raw:
        values = raw["allowed_sources"]
        if not isinstance(values, list) or not 1 <= len(values) <= 8:
            raise ValidationError("allowed_sources 需要1..8个容器坐标")
        result["allowed_sources"] = [position(p) for p in values]
    return result


def explicit_constraints(text: str) -> dict[str, Any]:
    # These unambiguous clauses cannot be silently dropped by the model.
    result: dict[str, Any] = {}
    if re.search(r"不要移动|先别移动|别移动|禁止移动|不许移动", text):
        result["no_move"] = True
    if re.search(r"不要采集|不采集|不砍树|不要砍树|禁止采集", text):
        result["no_collect"] = True
    names = {"橡木木板": "oak_planks", "木板": "oak_planks", "橡木原木": "oak_log", "原木": "oak_log", "煤": "coal", "铁锭": "iron_ingot", "圆石": "cobblestone"}
    digits = dict(zip("零一二三四五六七八九", range(10))) | {"两": 2}
    for value, label in re.findall(r"保留\s*([0-9零一二两三四五六七八九十]+)\s*[个块根份]?\s*(橡木木板|橡木原木|木板|原木|煤|铁锭|圆石)", text):
        if value.isdigit():
            count = int(value)
        elif "十" in value:
            a, b = value.split("十", 1)
            count = (digits.get(a, 1) * 10) + digits.get(b, 0)
        else:
            count = digits.get(value, -1)
        if not 0 <= count <= 2304:
            raise ValidationError("保留数量无效")
        item = "minecraft:" + names[label]
        result.setdefault("keep_inventory", {})[item] = count
    return result


def merge_constraints(existing: dict, proposed: dict) -> dict:
    result = dict(existing)
    for flag in ["no_move", "no_collect"]:
        if proposed.get(flag):
            result[flag] = True
    keep = dict(existing.get("keep_inventory", {}))
    for item, minimum in proposed.get("keep_inventory", {}).items():
        keep[item] = max(keep.get(item, 0), minimum)
    if keep:
        result["keep_inventory"] = keep
    if "allowed_sources" in proposed:
        allowed = proposed["allowed_sources"]
        if "allowed_sources" in existing:
            keys = {container_key(p) for p in existing["allowed_sources"]}
            allowed = [p for p in allowed if container_key(p) in keys]
        if not allowed:
            raise ValidationError("来源限制互相冲突")
        result["allowed_sources"] = allowed
    return result


def check_inventory(constraints: dict, observation: dict) -> None:
    counts = observation_inventory(observation)
    for item, minimum in constraints.get("keep_inventory", {}).items():
        if counts.get(item, 0) < minimum:
            raise ValidationError(f"保留约束不满足：{item} 至少保留 {minimum}，当前 {counts.get(item, 0)}")


def guard_action(constraints: dict, op: str, args: dict, observation: dict, recipes: list | None = None) -> None:
    check_inventory(constraints, observation)
    if constraints.get("no_move") and (op == "act" or op == "inspect_container"):
        raise ValidationError("不要移动约束：当前只允许无移动的只读查询")
    if op != "act":
        return
    kind = args["kind"]
    if constraints.get("no_collect") and kind == "collect":
        raise ValidationError("禁止采集约束阻止了 collect")
    if kind == "withdraw" and "allowed_sources" in constraints:
        if container_key(args["position"]) not in {container_key(p) for p in constraints["allowed_sources"]}:
            raise ValidationError("来源容器不在允许列表内")
    keep = constraints.get("keep_inventory", {})
    counts = observation_inventory(observation)
    consumed: dict[str, int] = {}
    if kind == "deposit":
        consumed[args["item"]] = args["count"]
    elif kind == "smelt":
        consumed[args["input"]] = args["input_count"]
        consumed[args["fuel"]] = consumed.get(args["fuel"], 0) + args["fuel_count"]
    elif kind == "craft" and keep:
        candidates = [r for r in (recipes or []) if isinstance(r, dict) and isinstance(r.get("result"), dict) and r["result"].get("name") == args["item"]]
        if any(isinstance(r["result"].get("count"), bool) or not isinstance(r["result"].get("count"), int) or r["result"]["count"] <= 0 for r in candidates):
            raise ValidationError("配方产量无效，拒绝消耗保留材料")
        candidates = sorted(candidates, key=lambda r: (bool(r.get("requires_table")), -r["result"]["count"]))
        if not candidates:
            raise ValidationError("保留材料的合成需要先查询真实配方")
        # Reject if any possible backend recipe would consume reserved material.
        for recipe in candidates:
            result = recipe.get("result", {})
            if result.get("name") != args["item"]:
                continue
            repeats = math.ceil(args["count"] / result.get("count", 1))
            for ingredient in recipe.get("ingredients", []):
                item, count = ingredient["name"], ingredient["count"] * repeats
                consumed[item] = max(consumed.get(item, 0), count)
    for item, used in consumed.items():
        if item in keep and counts.get(item, 0) - used < keep[item]:
            raise ValidationError(f"动作会消耗保留材料：{item} 需保留 {keep[item]}")
