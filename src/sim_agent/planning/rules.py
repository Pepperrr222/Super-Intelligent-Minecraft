"""Small transparent Chinese command baseline, usable without an API key.

This is deliberately a bounded grammar, not a substitute for general LLM
understanding. Unknown or ambiguous requests ask for clarification.
"""
from __future__ import annotations
import json
import math
import re
from typing import Any
from sim_agent.planning.planner import PlannerReply
from sim_agent.domain.constraints import explicit_constraints
from sim_agent.domain.goals import observation_inventory

ITEMS = {"橡木原木": "oak_log", "橡木木板": "oak_planks", "工作台": "crafting_table",
         "木板": "oak_planks", "原木": "oak_log", "木棍": "stick", "箱子": "chest",
         "圆石": "cobblestone", "铁锭": "iron_ingot", "粗铁": "raw_iron", "煤炭": "coal", "煤": "coal"}
NUM = r"[0-9零一二两三四五六七八九十]+"
ITEM = "(?:" + "|".join(sorted(ITEMS, key=len, reverse=True)) + ")"
COORD = r"(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)\s*[,，\s]\s*(-?\d+(?:\.\d+)?)"


def number(text: str) -> int:
    if text.isdigit():
        return int(text)
    digits = dict(zip("零一二三四五六七八九", range(10))) | {"两": 2}
    if "十" in text:
        a, b = text.split("十", 1)
        return digits.get(a, 1) * 10 + digits.get(b, 0)
    return digits.get(text, 0)


def position(groups) -> dict[str, float]:
    return dict(zip(("x", "y", "z"), map(float, groups)))


def parse_command(text: str) -> dict[str, Any] | None:
    source = re.search(r"从\s*坐标\s*" + COORD + r".*?(?:取出|拿出|取|拿)\s*(" + NUM + r")\s*[个块根份]?\s*(" + ITEM + r")", text)
    target = re.search(r"(?:放入|放进|存入|存进|交付到)\s*坐标\s*" + COORD, text)
    craft = re.search(r"(?:合成|做成|制作)\s*(" + NUM + r")\s*[个块根份]?\s*(" + ITEM + r")", text)
    if source and target and craft:
        return {"kind": "delivery", "source": position(source.groups()[:3]), "target": position(target.groups()),
                "input_count": number(source[4]), "input": "minecraft:" + ITEMS[source[5]],
                "count": number(craft[1]), "item": "minecraft:" + ITEMS[craft[2]]}
    move = re.search(r"(?:去|到|移动到|走到)\s*坐标\s*" + COORD, text)
    if move:
        return {"kind": "goto", "position": position(move.groups())}
    follow = re.search(r"跟随\s*([A-Za-z0-9_]{1,16})\s+(" + NUM + r")\s*秒", text)
    if follow:
        return {"kind": "follow", "player": follow[1], "duration_seconds": number(follow[2])}
    transfer = re.search(r"(?:把|将).*?(" + NUM + r")\s*[个块根份]?\s*(" + ITEM + r")", text)
    if target and transfer:
        return {"kind": "deposit", "target": position(target.groups()), "count": number(transfer[1]), "item": "minecraft:" + ITEMS[transfer[2]]}
    if craft:
        return {"kind": "craft", "count": number(craft[1]), "item": "minecraft:" + ITEMS[craft[2]], "allow_collect": bool(re.search(r"采集|砍树", text))}
    collect = re.search(r"(?:采集|收集|挖取)\s*(" + NUM + r")\s*[个块根份]?\s*(" + ITEM + r")", text)
    if collect:
        return {"kind": "collect", "count": number(collect[1]), "item": "minecraft:" + ITEMS[collect[2]]}
    return None


class RulePlanner:
    async def decide(self, context: dict[str, Any], timeout: float) -> PlannerReply:
        state = context["state"]
        text = context["task"]
        parsed = parse_command(text)
        continuation = state.get("continuation_context") or {}
        if parsed is None and continuation:
            parsed = parse_command(continuation.get("original_task", ""))
            target = re.search(r"(?:放入|放进|存入|改放入|改放进)\s*坐标\s*" + COORD, text)
            if parsed and parsed["kind"] == "delivery" and target:
                parsed = {**parsed, "target": position(target.groups()), "continuation": True}
            else:
                parsed = None
        if not parsed:
            return self.reply(None, {"op": "clarify", "args": {"question": "规则基线需要明确坐标、物品和数量。请使用示例格式，或启用 LLM 规划器。"}})
        if any(not 1 <= parsed[k] <= 64 for k in ("count", "input_count") if k in parsed):
            return self.reply(None, {"op": "clarify", "args": {"question": "规则基线单次支持1到64个物品。请拆分任务。"}})
        if parsed["kind"] == "follow" and not 1 <= parsed["duration_seconds"] <= 60:
            return self.reply(None, {"op": "clarify", "args": {"question": "有限跟随支持1到60秒。"}})
        inventory = observation_inventory(state["latest_observation"])
        completed = state.get("completed_steps", [])
        goal = state.get("goal")
        if not goal:
            goal = self.goal(parsed, state, inventory)
        constraints = explicit_constraints(text)
        if parsed["kind"] == "delivery":
            constraints["no_collect"] = True
            constraints["allowed_sources"] = [parsed["source"]]
        step = self.next_step(parsed, state, inventory, completed, goal)
        return self.reply(goal, step, constraints)

    def goal(self, p, state, inventory):
        kind = p["kind"]
        if kind == "goto":
            return {"type": "near_position", "position": p["position"], "range": 1}
        if kind == "follow":
            return {"type": "action_succeeded", "action": "follow", "player": p["player"], "duration_seconds": p["duration_seconds"]}
        if kind in {"craft", "collect"}:
            return {"type": "inventory_increase", "item": p["item"], "count": p["count"]}
        if kind == "deposit":
            return {"type": "all_of", "goals": [
                {"type": "container_delta", "position": p["target"], "item": p["item"], "delta": p["count"]},
                {"type": "inventory_delta", "item": p["item"], "delta": -p["count"]}]}
        children = [
            {"type": "container_delta", "position": p["target"], "item": p["item"], "delta": p["count"]},
            {"type": "inventory_delta", "item": p["item"], "delta": -p["count"] if p.get("continuation") else 0}]
        if not p.get("continuation"):
            children += [{"type": "container_delta", "position": p["source"], "item": p["input"], "delta": -p["input_count"]},
                         {"type": "inventory_delta", "item": p["input"], "delta": 0}]
        return {"type": "all_of", "goals": children}

    def next_step(self, p, state, inventory, completed, goal):
        def act(kind, **args): return {"op": "act", "args": {"kind": kind, **args}}
        def done(kind): return any(s["op"] == "act" and s["args"].get("kind") == kind for s in completed)
        finish = {"op": "finish", "args": {}}
        kind = p["kind"]
        if kind == "goto":
            current = state["latest_observation"]["position"]
            distance = math.dist([current[a] for a in ("x", "y", "z")], [p["position"][a] for a in ("x", "y", "z")])
            return finish if distance <= 1 else act("goto", position=p["position"], range=1)
        if kind == "follow":
            return finish if done("follow") else act("follow", player=p["player"], duration_seconds=p["duration_seconds"])
        if kind == "deposit":
            return finish if done("deposit") else act("deposit", position=p["target"], item=p["item"], count=p["count"])
        if kind == "delivery" and p.get("continuation"):
            # Only resume without re-crafting when all new output is still held.
            prior = state.get("continuation_context", {})
            if any(s["args"].get("kind") == "deposit" for s in prior.get("verified_steps", [])):
                return {"op": "clarify", "args": {"question": "旧任务已有交付，请确认是否从旧箱搬回。规则基线不会自动重复合成。"}}
            if inventory.get(p["item"], 0) < p["count"] and not done("deposit"):
                return {"op": "clarify", "args": {"question": "纠正时背包没有足量成品，请提供剩余材料或启用 LLM 继续规划。"}}
            return finish if done("deposit") else act("deposit", position=p["target"], item=p["item"], count=p["count"])
        if kind == "delivery":
            if done("deposit"):
                return finish
            if done("craft"):
                return act("deposit", position=p["target"], item=p["item"], count=p["count"])
            if not done("withdraw"):
                recipes = state.get("facts", {}).get("recipes")
                if recipes is None:
                    return {"op": "recipes", "args": {"item": p["item"]}}
                matching = [r for r in recipes if r.get("result", {}).get("name") == p["item"] and
                            len(r.get("ingredients", [])) == 1 and r["ingredients"][0]["name"] == p["input"] and
                            p["count"] % r["result"]["count"] == 0 and
                            r["ingredients"][0]["count"] * (p["count"] // r["result"]["count"]) == p["input_count"]]
                if not matching:
                    return {"op": "clarify", "args": {"question": "取料数量与目标产量未匹配到单一原料配方，请确认数量或启用 LLM 规划器。"}}
                return act("withdraw", position=p["source"], item=p["input"], count=p["input_count"])
        if kind == "collect":
            if done("collect"):
                return finish
            return act("collect", block=p["item"], count=p["count"])
        if done("craft"):
            return finish
        recipes = state.get("facts", {}).get("recipes")
        if recipes is None:
            return {"op": "recipes", "args": {"item": p["item"]}}
        candidates = [r for r in recipes if r.get("result", {}).get("name") == p["item"]]
        if not candidates:
            return {"op": "clarify", "args": {"question": "当前后端未提供目标物品的可用配方。"}}
        recipe = sorted(candidates, key=lambda r: (bool(r.get("requires_table")), -r["result"]["count"]))[0]
        repeats = math.ceil(p["count"] / recipe["result"]["count"])
        for ingredient in recipe["ingredients"]:
            needed = ingredient["count"] * repeats - inventory.get(ingredient["name"], 0)
            if needed > 0:
                if p.get("allow_collect") and ingredient["name"] == "minecraft:oak_log" and not state.get("constraints", {}).get("no_collect"):
                    return act("collect", block="minecraft:oak_log", count=needed)
                return {"op": "clarify", "args": {"question": f"缺少 {needed} 个 {ingredient['name']}，请提供材料或允许采集。"}}
        return act("craft", item=p["item"], count=p["count"])

    @staticmethod
    def reply(goal, step, constraints=None):
        data = {"step": step}
        if goal is not None: data["goal"] = goal
        if constraints: data["constraints"] = constraints
        return PlannerReply(json.dumps(data, ensure_ascii=False), {}, "rules-baseline", 0, model_call=False)
