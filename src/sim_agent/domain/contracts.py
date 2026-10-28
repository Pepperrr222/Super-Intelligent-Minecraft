"""Pure task contracts. Natural-language requirements are independent of goals."""
from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from typing import Any

from sim_agent.domain.constraints import parse_constraints, merge_constraints
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.goals import parse_goal


def object_value(value, where, required=(), optional=()):
    if not isinstance(value, dict):
        raise ValidationError(f"{where} 必须是对象")
    missing = set(required) - value.keys()
    extra = value.keys() - set(required) - set(optional)
    if missing or extra:
        raise ValidationError(f"{where} 字段错误，缺少{sorted(missing)}，多余{sorted(extra)}")
    return value


def text_value(value, where, limit=2000):
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise ValidationError(f"{where} 必须为1..{limit}字符的文本")
    return value


def list_value(value, where, maximum=32, minimum=0):
    if not isinstance(value, list) or not minimum <= len(value) <= maximum:
        raise ValidationError(f"{where} 列表数量必须在{minimum}..{maximum}")
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,96}", value):
        raise ValidationError("标识符非法")
    return value


def refs(value, where, available=None, minimum=0):
    result = [identifier(v) for v in list_value(value, where, minimum=minimum)]
    if len(result) != len(set(result)):
        raise ValidationError(f"{where} 含重复引用")
    if available is not None and not set(result) <= set(available):
        raise ValidationError(f"{where} 不存在的引用: {sorted(set(result)-set(available))}；允许: {sorted(available)}")
    return result


CHECK_FIELDS = {
    "state_predicate": ({"goal", "scope"}, {"baseline_ref", "freshness_policy"}),
    "evidence_requirement": ({"evidence_kind", "selectors", "requirement_ids"}, set()),
    "grounded_report": ({"required_topics", "permitted_evidence_kinds"}, set()),
    "delivery_submission": ({"channel"}, {"report_id"}),
    "semantic_review": ({"rubric", "requirement_ids"}, set()),
}

SELECTOR_PATHS = {
    "action": {"status"} | {"args."+k for k in ("kind","item","count","block","player","duration_seconds","position","range","input","fuel","input_count","fuel_count","wait_seconds")},
    "observe": {"position","dimension","inventory","health","food","nearby_players","world_id"},
    "inspect_container": {"args.position","position","items","world_id","type"},
    "recipes": {"args.item","recipes","world_id"},
    "find_blocks": {"args.names","args.radius","args.limit","blocks","world_id"},
}
for paths in SELECTOR_PATHS.values():
    for prefix in ("position","args.position"):
        if prefix in paths: paths.update(prefix+"."+axis for axis in ("x","y","z"))


def parse_checks(value, requirement_ids):
    checks = copy.deepcopy(list_value(value, "acceptance_checks", maximum=16, minimum=1))
    for c in checks:
        if not isinstance(c, dict) or c.get("kind") not in CHECK_FIELDS:
            raise ValidationError("未知验收机制，不可用容易通过的谓词替代需求")
        required, optional = CHECK_FIELDS[c["kind"]]
        object_value(c, "check", required | {"kind"}, optional)
        if c["kind"] == "state_predicate":
            c["goal"] = parse_goal(c["goal"]).to_dict()
            if c["scope"] not in {"root", "stage"}:
                raise ValidationError("基线scope必须为root或stage")
        elif c["kind"] == "evidence_requirement":
            if c["evidence_kind"] not in {"observe", "find_blocks", "recipes", "inspect_container", "action"}:
                raise ValidationError("未知证据类型")
            refs(c["requirement_ids"], "requirement_ids", requirement_ids, 1)
            for selector in list_value(c["selectors"], "selectors", maximum=16):
                object_value(selector, "selector", {"path", "equals"})
                text_value(selector["path"], "path", 256)
                allowed=SELECTOR_PATHS[c["evidence_kind"]]
                if selector["path"] not in allowed:
                    raise ValidationError(f"证据字段 {selector['path']} 不存在；允许路径 {sorted(allowed)}，制作物品字段是args.item，不是args.recipe")
        elif c["kind"] == "grounded_report":
            for topic in list_value(c["required_topics"], "topics", maximum=16, minimum=1):
                text_value(topic, "topic", 300)
            for kind in list_value(c["permitted_evidence_kinds"], "kinds", maximum=8, minimum=1):
                if kind not in {"observe", "find_blocks", "recipes", "inspect_container", "action", "task_history"}:
                    raise ValidationError("报告证据类型非法")
        elif c["kind"] == "delivery_submission":
            if c["channel"] not in {"game_chat", "cli"}:
                raise ValidationError("未知交付渠道")
        elif c["kind"] == "semantic_review":
            text_value(c["rubric"], "rubric")
            refs(c["requirement_ids"], "requirement_ids", requirement_ids, 1)
    return checks


def parse_criteria(value):
    """Business outcomes are open text, not a menu of executable goals."""
    return [text_value(v, "completion_criteria", 1200)
            for v in list_value(value, "completion_criteria", maximum=16, minimum=1)]


@dataclass(frozen=True)
class TaskContract:
    data: dict[str, Any]

    @property
    def requirement_ids(self):
        return {r["id"] for r in self.data["requirements"]}

    @property
    def required_result_ids(self):
        return {r["id"] for r in self.data["requirements"] if r.get("kind","result")!="permission"}

    @property
    def checks(self):
        return [c for d in self.data["deliverables"] for c in d["acceptance_checks"]]

    @property
    def checks_ready(self):
        return all(d.get("acceptance_checks") for d in self.data["deliverables"])

    def to_dict(self):
        return copy.deepcopy(self.data)

    @classmethod
    def parse(cls, raw, source_texts, inherited_constraints, *, user_revision=False):
        d = copy.deepcopy(object_value(raw, "contract", {"intent_summary", "requirements", "constraints", "deliverables"},
                                      {"bindings", "unknowns", "schema_version"}))
        text_value(d["intent_summary"], "intent_summary")
        if d.get("schema_version","task-contract.v1")!="task-contract.v1":
            raise ValidationError("Contract版本不受支持")
        d["schema_version"]="task-contract.v1"
        proposed=parse_constraints(d["constraints"])
        if user_revision:
            # Explicit corrections may change fields; normal proposals cannot relax constraints.
            revised=copy.deepcopy(inherited_constraints)
            for key,value in proposed.items():
                if key=="keep_inventory": revised[key]={**revised.get(key,{}),**value}
                else: revised[key]=value
            d["constraints"]=parse_constraints(revised)
        else:
            d["constraints"] = merge_constraints(inherited_constraints, proposed)
        ids = set()
        for r in list_value(d["requirements"], "requirements", maximum=24, minimum=1):
            object_value(r, "requirement", {"id", "text", "source_refs"}, {"required","kind"})
            if r.get("kind","result") not in {"result","constraint","permission"}:
                raise ValidationError("requirement.kind必须是result/constraint/permission")
            identifier(r["id"]); text_value(r["text"], "requirement.text")
            if r["id"] in ids or r.get("required", True) is not True:
                raise ValidationError("需求必须唯一且required=true，不可删除用户要求")
            ids.add(r["id"])
            for source in list_value(r["source_refs"], "source_refs", maximum=12, minimum=1):
                text_value(source, "source_ref", 1200)
                if not any(source in t for t in source_texts):
                    raise ValidationError("source_ref必须为原文或有效纠正中的真实片段")
        covered = set(); deliverable_ids = set()
        for dli in list_value(d["deliverables"], "deliverables", maximum=16, minimum=1):
            business = "completion_criteria" in dli
            object_value(dli, "deliverable", {"id", "description", "requirement_ids",
                         "completion_criteria" if business else "acceptance_checks"}, {"required"})
            identifier(dli["id"]); text_value(dli["description"], "description")
            if dli["id"] in deliverable_ids or dli.get("required", True) is not True:
                raise ValidationError("交付必须唯一且required=true")
            deliverable_ids.add(dli["id"])
            covered.update(refs(dli["requirement_ids"], "requirement_ids", ids, 1))
            if business:
                dli["completion_criteria"] = parse_criteria(dli["completion_criteria"])
                dli["acceptance_checks"] = []  # Worker compiles; never treated as verified.
            else:
                dli["acceptance_checks"] = parse_checks(dli["acceptance_checks"], ids)
            if any(c.get("scope") == "stage" for c in dli["acceptance_checks"]):
                raise ValidationError("根交付不能使用stage基线")
        mandatory={r["id"] for r in d["requirements"] if r.get("kind","result")!="permission"}
        if not mandatory: raise ValidationError("任务不能只有许可，至少需要实际结果或约束需求")
        if not mandatory<=covered:
            missing=[{"id":r["id"],"text":r["text"]} for r in d["requirements"] if r["id"] in mandatory-covered]
            raise ValidationError("必需需求未覆盖交付："+json.dumps(missing,ensure_ascii=False)+"；单纯允许的方法可以标记kind=permission，不能把实际结果改成permission")
        list_value(d.setdefault("unknowns", []), "unknowns", maximum=16)
        list_value(d.setdefault("bindings", []), "bindings", maximum=16)
        for b in d["bindings"]:
            object_value(b, "binding", {"id", "kind", "value", "source_refs", "observed_evidence_ids", "resolution_status"})
            identifier(b["id"]); text_value(b["kind"], "binding.kind", 64)
            if b["resolution_status"] not in {"explicit", "candidate", "unresolved"}:
                raise ValidationError("binding状态非法")
            for s in list_value(b["source_refs"], "binding.source_refs", minimum=1):
                if not isinstance(s, str) or not any(s in t for t in source_texts):
                    raise ValidationError("绑定缺少原文依据")
            refs(b["observed_evidence_ids"], "observed_evidence_ids")
        return cls(d)


def parse_stages(raw, contract, capabilities, maximum=12, completed_ids=()):
    stages = copy.deepcopy(list_value(raw, "stages", maximum=maximum, minimum=1))
    ids = set()
    for s in stages:
        business = "completion_criteria" in s
        fields = {"completion_criteria", "mode"} if business else {"allowed_capabilities", "acceptance_checks"}
        object_value(s, "stage", {"id", "title", "objective", "requirement_ids", "dependencies"} | fields,
                     {"input_evidence_ids", "expected_outputs", "budget"})
        identifier(s["id"]); text_value(s["title"], "title", 200); text_value(s["objective"], "objective")
        if s["id"] in ids:
            raise ValidationError("阶段ID重复")
        ids.add(s["id"])
        refs(s["requirement_ids"], "requirement_ids", contract.requirement_ids, 1)
        if business:
            if s["mode"] not in {"investigate", "execute"}:
                raise ValidationError("stage.mode必须是investigate/execute")
            s["completion_criteria"] = parse_criteria(s["completion_criteria"])
            s["information_only"] = s["mode"] == "investigate"
            s["allowed_capabilities"] = [k for k in capabilities
                if not s["information_only"] or k in {"observe", "find_blocks", "recipes"}]
            s["acceptance_checks"] = []
        else:
            refs(s["allowed_capabilities"], "allowed_capabilities", capabilities, 0)
            s["acceptance_checks"] = parse_checks(s["acceptance_checks"], contract.requirement_ids)
        if any(c["kind"] in {"grounded_report","delivery_submission"} for c in s["acceptance_checks"]):
            raise ValidationError("报告与聊天交付由Coordinator完成，不是Worker阶段验收；Worker阶段只收集证据和完成局部工作")
        s.setdefault("input_evidence_ids", [])
        refs(s["input_evidence_ids"], "input_evidence_ids")
        budget=s.setdefault("budget",{})
        object_value(budget,"stage.budget",set(),{"max_tools","max_model_calls","timeout_seconds"})
        for key,value in budget.items():
            maximum=3600 if key=="timeout_seconds" else 100
            if isinstance(value,bool) or not isinstance(value,int) or not 1<=value<=maximum:
                raise ValidationError("阶段预算必须为有效的正整数上限")
        s["status"] = "pending"
    by_id = {s["id"]: s for s in stages}
    visited, visiting = set(), set()
    def visit(key):
        if key in completed_ids and key not in by_id: return
        if key in visiting: raise ValidationError("计划有循环依赖")
        if key in visited: return
        visiting.add(key)
        for dep in refs(by_id[key]["dependencies"], "dependencies", ids | set(completed_ids)): visit(dep)
        visiting.remove(key); visited.add(key)
    for key in ids: visit(key)
    return stages


COORDINATOR_FIELDS = {
    "propose_contract": ({"contract_draft"}, set()),
    "propose_plan": ({"stages", "change_reason", "based_on_evidence_ids"}, set()),
    "dispatch": ({"stage_id"}, set()),
    "request_information": ({"question", "requested_capabilities", "evidence_refs"}, set()),
    "clarify": ({"question", "missing_fields"}, {"alternatives"}),
    "submit_report": ({"report", "requirement_ids"}, {"contract_draft"}),
    "request_completion": ({"deliverable_refs", "evidence_ids"}, set()),
    "cannot_complete": ({"reason_code", "explanation", "unmet_requirements"}, set()),
}
BUSINESS_COORDINATOR_FIELDS = {**COORDINATOR_FIELDS,
    "request_information": ({"question", "evidence_refs"}, set())}
WORKER_FIELDS = {
    "prepare_verification": ({"deliverables", "stage_checks"}, set()),
    "query": ({"op", "args", "purpose"}, set()),
    "act": ({"kind", "args", "purpose"}, set()),
    "submit_result": ({"summary", "output_refs", "evidence_ids", "unresolved_items"}, set()),
    "blocked": ({"category", "explanation", "attempted_evidence_ids", "needed_information"}, set()),
}


def parse_proposal(raw_text, role, *, business=False):
    if not isinstance(raw_text,str) or len(raw_text)>200_000:
        raise ValidationError("提议输出为空或过长")
    try:
        d = json.loads(raw_text, parse_constant=lambda s: (_ for _ in ()).throw(ValueError(s)))
    except json.JSONDecodeError as e:
        raise ValidationError(f"提议JSON非法：{e.msg}，第{e.lineno}行第{e.colno}列；检查多余右括号或尾部文本并完整重输") from e
    except (ValueError, TypeError) as e:
        raise ValidationError("提议不是完整有效JSON") from e
    object_value(d, "proposal", {"schema_version", "kind", "summary", "payload"})
    if d["schema_version"] != role + "-proposal.v1": raise ValidationError("提议版本不匹配")
    if role not in {"coordinator", "worker"}: raise ValidationError("未知模型角色")
    fields = (BUSINESS_COORDINATOR_FIELDS if business else COORDINATOR_FIELDS) if role == "coordinator" else WORKER_FIELDS
    if not isinstance(d["kind"],str) or d["kind"] not in fields: raise ValidationError("此角色不允许该提议")
    required, optional = fields[d["kind"]]
    object_value(d["payload"], "payload", required, optional)
    text_value(d["summary"], "summary", 1000)
    if business and role == "coordinator":
        p = d["payload"]
        if "contract_draft" in p:
            for deliverable in list_value(p["contract_draft"].get("deliverables"), "deliverables", minimum=1):
                if "acceptance_checks" in deliverable or "completion_criteria" not in deliverable:
                    raise ValidationError("Coordinator只描述completion_criteria，底层验收由Worker编译")
        for stage in p.get("stages", []):
            if "allowed_capabilities" in stage or "acceptance_checks" in stage or "completion_criteria" not in stage:
                raise ValidationError("Coordinator阶段只描述目标、mode和completion_criteria，不指定工具或底层检查")
    return d
