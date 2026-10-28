"""Independent acceptance mechanics; all queries use the injected guarded controller."""
from sim_agent.domain.contracts import object_value,text_value,list_value,refs
from sim_agent.domain.errors import ValidationError
from sim_agent.domain.goals import parse_goal
import copy


def parse_report(raw, contract, evidence):
    report=copy.deepcopy(object_value(raw,"report",{"text","claims","covered_requirement_ids","limitations"}))
    text_value(report["text"],"report.text",1400)
    refs(report["covered_requirement_ids"],"covered_requirement_ids",contract.requirement_ids,1)
    available={e["id"]:e for e in evidence}
    permitted=set().union(*(set(k["permitted_evidence_kinds"]) for k in contract.checks if k["kind"]=="grounded_report"))
    for claim in list_value(report["claims"],"claims",maximum=32,minimum=1):
        object_value(claim,"claim",{"text","kind","evidence_refs"})
        text_value(claim["text"],"claim.text",1000)
        if claim["kind"] not in {"observed","inferred","limitation"}: raise ValidationError("claim类型错误")
        refs(claim["evidence_refs"],"evidence_refs",available,0 if claim["kind"]=="limitation" else 1)
        if permitted and any(available[eid]["kind"] not in permitted for eid in claim["evidence_refs"]):
            raise ValidationError("报告使用了约定不允许的证据类型")
    for limitation in list_value(report["limitations"],"limitations",maximum=16):
        text_value(limitation,"limitation",1000)
    return report


class VerificationService:
    async def verify(self, checks, *, root_state, scoped_state, evidence, stage_id,
                     input_evidence_ids,stage,
                     root, report, report_verified, delivery_status, delivery_channel,
                     contract, verify_live):
        outcomes=[]
        for c in checks:
            kind=c["kind"]; ok=False; detail=""
            if kind=="state_predicate":
                target=root_state if c["scope"]=="root" else scoped_state
                target.steps=root_state.steps
                result=await verify_live(parse_goal(c["goal"]),target)
                ok=result.ok; detail=result.detail
                if target.observation: root_state.apply_observation(target.observation.raw)
            elif kind=="evidence_requirement":
                candidates=[e for e in evidence if e["kind"]==c["evidence_kind"] and
                            (root or stage_id is None or e.get("stage_id")==stage_id or e["id"] in input_evidence_ids)]
                def matches(e):
                    for selector in c["selectors"]:
                        value=e["payload"]
                        for key in selector["path"].split("."):
                            value=value.get(key) if isinstance(value,dict) else None
                        if value!=selector["equals"]: return False
                    return e["kind"]!="action" or e["payload"].get("status")=="succeeded"
                ok=any(matches(e) for e in candidates); detail="要求的查询/动作证据" if ok else "缺少要求的真实证据"
            elif kind=="grounded_report":
                ok=bool(report and report_verified); detail="报告结构、需求覆盖与证据引用检查；未执行独立模型语义审查"
            elif kind=="delivery_submission":
                ok=bool(report and delivery_status=="submitted" and c["channel"]==delivery_channel)
                detail="回复渠道与提交回执"
            elif kind=="semantic_review":
                # Old snapshots cannot silently turn a removed reviewer into automatic approval.
                ok=False; detail="独立Reviewer已移除；旧语义审查检查不能自动通过，请重新建立可执行验收"
            outcomes.append({"kind":kind,"ok":ok,"detail":detail})
        return all(o["ok"] for o in outcomes),outcomes
