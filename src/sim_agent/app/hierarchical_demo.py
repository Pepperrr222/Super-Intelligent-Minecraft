"""Scripted two-role offline wiring demonstration. NO real LLM or Minecraft."""
import argparse
import asyncio
import json
from dataclasses import replace
from pathlib import Path
from sim_agent.agents.coordinator import AgentTeam
from sim_agent.app.config import load_config,OrchestrationConfig
from sim_agent.adapters.mock import MockBackend,SOURCE,TARGET
from sim_agent.orchestration.task_runtime import TaskRuntime
from sim_agent.observability.jsonl import RuntimeLogs
from sim_agent.planning.model import ModelResult


def p(role,operation,**payload):
    return {"schema_version":role+"-proposal.v1","kind":operation,"summary":"离线脚本演示","payload":payload}


class DemoTeam(AgentTeam):
    is_real_model=False
    environment="SCRIPTED_MOCK_ONLY"
    model_name="SCRIPTED_MOCK_ONLY"
    def __init__(self,task):
        goal={"type":"all_of","goals":[
            {"type":"container_delta","position":SOURCE,"item":"minecraft:oak_log","delta":-2},
            {"type":"container_delta","position":TARGET,"item":"minecraft:oak_planks","delta":8},
            {"type":"inventory_delta","item":"minecraft:oak_planks","delta":0}]}
        contract={"intent_summary":task,"requirements":[{"id":"r1","text":task,"source_refs":[task]}],
            "constraints":{"no_collect":True,"keep_inventory":{"minecraft:oak_planks":3}},"bindings":[],"unknowns":[],
            "deliverables":[{"id":"d1","description":"交付本次新产物并说明来源","requirement_ids":["r1"],
                "acceptance_checks":[{"kind":"state_predicate","goal":goal,"scope":"root"},
                                     {"kind":"delivery_submission","channel":"game_chat"}]}]}
        def stage(sid,cap,dep,goal):
            return {"id":sid,"title":sid,"objective":sid,"dependencies":dep,"requirement_ids":["r1"],
                "allowed_capabilities":[cap],"acceptance_checks":[{"kind":"state_predicate","goal":goal,"scope":"stage"}]}
        stages=[stage("取料","withdraw",[],{"type":"inventory_increase","item":"minecraft:oak_log","count":2}),
                stage("制作","craft",["取料"],{"type":"inventory_increase","item":"minecraft:oak_planks","count":8}),
                stage("交付","deposit",["制作"],{"type":"container_delta","position":TARGET,"item":"minecraft:oak_planks","delta":8})]
        # Schema IDs are ASCII, human titles may be Chinese.
        for s,i in zip(stages,["source","make","deliver"]): s["id"]=i
        stages[1]["dependencies"]=["source"]; stages[2]["dependencies"]=["make"]
        root_checks=contract["deliverables"][0].pop("acceptance_checks")
        contract["deliverables"][0]["completion_criteria"]=["源箱减少2根原木，目标箱新增8块木板，保留原有木板并回复玩家"]
        preparations=[]
        for index,s in enumerate(stages):
            checks=s.pop("acceptance_checks"); s.pop("allowed_capabilities")
            s["mode"]="execute"; s["completion_criteria"]=[s["title"]+"完成且数量经核对"]
            preparations.append(p("worker","prepare_verification",
                deliverables=[{"id":"d1","acceptance_checks":root_checks}] if index==0 else [],stage_checks=checks))
        done=p("worker","submit_result",summary="申请阶段验收",output_refs=[],evidence_ids=[],unresolved_items=[])
        self.coordinator=iter([p("coordinator","propose_contract",contract_draft=contract),
            p("coordinator","propose_plan",stages=stages,change_reason="依赖顺序",based_on_evidence_ids=[]),
            *[p("coordinator","dispatch",stage_id=s["id"]) for s in stages],None])
        self.worker=iter([
            preparations[0],p("worker","act",kind="withdraw",args={"position":SOURCE,"item":"minecraft:oak_log","count":2},purpose="取料"),done,
            preparations[1],p("worker","act",kind="craft",args={"item":"minecraft:oak_planks","count":8},purpose="制作"),done,
            preparations[2],p("worker","act",kind="deposit",args={"position":TARGET,"item":"minecraft:oak_planks","count":8},purpose="交付"),done])

    async def call(self,role,context,timeout,observer):
        if role not in {"coordinator","worker"}: raise AssertionError("Unexpected model role")
        value=next(self.coordinator if role=="coordinator" else self.worker)
        if value is None:
            value=p("coordinator","submit_report",requirement_ids=["r1"],report={
                "text":"离线夹具已从(0,64,0)箱取2根原木，制作并交付8块木板到(4,64,0)箱；保留原有3块木板。",
                "claims":[{"text":"制作并交付8块木板","kind":"observed","evidence_refs":[context['evidence'][-1]['id']]}],
                "covered_requirement_ids":["r1"],"limitations":["MOCK_ONLY，脚本模型，无真实游戏或API"]})
        observer({"type":"model_delta","channel":"reasoning","text":"MOCK_ONLY：预设角色输出，用于连线演示，不代表真实模型思考。"})
        observer({"type":"model_delta","channel":"decision","text":json.dumps(value,ensure_ascii=False)})
        return ModelResult(json.dumps(value,ensure_ascii=False),{},"SCRIPTED_MOCK_ONLY")


async def run(config_path,output):
    config=load_config(config_path)
    config=replace(config,runtime_dir=output,orchestration=OrchestrationConfig(mode="hierarchical"),
                   agent=replace(config.agent,max_steps=60,task_timeout_seconds=120))
    task="从坐标0 64 0箱取2根原木做8块木板放到坐标4 64 0箱，保留3块木板，不砍树，报告来源"
    logs=RuntimeLogs(output); backend=MockBackend(); backend.inventory={"minecraft:oak_planks":3}
    runtime=TaskRuntime(backend,DemoTeam(task),config,logs); runtime.delivery.interval=0
    try:
        outcome=await runtime.run(task,requested_by="OfflineDemo")
        result={"environment":"SCRIPTED_MOCK_ONLY","cloud_llm_tested":False,"outcome":outcome.to_dict(),
                "messages":backend.messages,"inventory":backend.inventory,"containers":backend.containers}
        (output/'demo-result.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({"environment":result['environment'],"status":outcome.end_state,"usage":outcome.usage,"output":str(output)},ensure_ascii=False,indent=2))
        return 0 if outcome.completed else 1
    finally: runtime.store.close(); logs.close()


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,default=Path('config.example.json'))
    parser.add_argument('--output',type=Path,default=Path('runtime/hierarchical-demo'))
    args=parser.parse_args()
    raise SystemExit(asyncio.run(run(args.config,args.output)))
