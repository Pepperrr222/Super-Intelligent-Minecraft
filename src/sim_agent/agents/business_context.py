"""Coordinator view: outcomes, facts and limitations, without executor protocol."""
import copy

ABILITIES = {
    "observe": "读取自身位置、背包和附近玩家",
    "find_blocks": "调查已加载范围内的资源；远处未知不等于不存在",
    "recipes": "调查原版制作配方",
    "inspect_container": "调查指定容器，可能需要移动，目标须由玩家明确指定",
    "goto": "前往指定位置",
    "follow": "有限时长地跟随玩家",
    "collect": "采集可达方块；所需工具和掉落条件由执行者核对",
    "craft": "使用现有材料和可用工作台制作物品",
    "deposit": "把物品放入玩家指定的容器",
    "withdraw": "从玩家指定的容器取得物品",
    "smelt": "使用指定炉子、原料和燃料进行冶炼",
}
FACT_KINDS = dict(zip( ("observe", "find_blocks", "recipes", "inspect_container", "action", "task_history"),
                      ("world_state", "nearby_resources", "available_recipes", "container_contents", "world_change", "previous_task")))
PRIVATE = {"args", "op", "capabilities", "allowed_capabilities", "acceptance_checks", "settled_actions",
           "fact_fingerprints", "saved_baselines", "spent", "candidate_result"}


def facts_only(value):
    if isinstance(value, dict):
        return {k:facts_only(v) for k,v in value.items() if k not in PRIVATE}
    if isinstance(value, list): return [facts_only(v) for v in value]
    return copy.deepcopy(value)


def coordinator_context(context):
    result = facts_only({k:v for k,v in context.items() if k not in {"root_baselines", "previous_invalid_decision_for_repair"}})
    result["abilities"] = [description for key,description in ABILITIES.items() if key in context.get("capabilities", {})]
    result["limitations"] = ["当前没有直接向玩家交付物品、检查玩家背包或证明玩家已拾取物品的能力；请明确容器交付等可行方式。",
                            "任务结果必须有程序可验证的证据；无法验证时说明限制或请求澄清。"]
    result["evidence"] = [{"id":e["id"], "kind":FACT_KINDS.get(e["kind"], "fact"),
                           "stage_id":e.get("stage_id"), "facts":facts_only(e["payload"])}
                          for e in context.get("evidence", [])]
    # An invalid business proposal is safe to provide for repair, unlike raw executor state.
    if context.get("previous_invalid_decision_for_repair"):
        result["previous_invalid_decision_for_repair"] = context["previous_invalid_decision_for_repair"]
    return result
