"""Business-role boundary tests; scripted models, no network or Minecraft."""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from dataclasses import replace

import test_hierarchical as fixtures
from sim_agent.agents.coordinator import AgentTeam, COORDINATOR_PROMPT, WORKER_PROMPT
from sim_agent.agents.business_context import coordinator_context
from sim_agent.domain.contracts import TaskContract, parse_proposal, parse_stages
from sim_agent.domain.errors import ValidationError
from sim_agent.app.config import OrchestrationConfig
from sim_agent.orchestration.task_runtime import TaskRuntime
from test_planner import make_config, FakeBackend, observation


class BusinessTeam(fixtures.ScriptedTeam):
    protocol_version="business.v2"


def business_contract(task,goal=None):
    draft=fixtures.contract(task,goal)
    for d in draft["deliverables"]:
        d.pop("acceptance_checks"); d["completion_criteria"]=[task]
    return draft


def stage(task,mode="execute"):
    return {"id":"work","title":"执行阶段","objective":task,"requirement_ids":["r1"],
            "dependencies":[],"mode":mode,"completion_criteria":[task],"input_evidence_ids":[]}


def final_report(ctx):
    evidence=next(e for e in reversed(ctx["evidence"]) if e["kind"]=="world_state")
    return fixtures.proposal("coordinator","submit_report",requirement_ids=["r1"],report={
        "text":"当前背包为空。","claims":[{"text":"当前背包为空。","kind":"observed","evidence_refs":[evidence["id"]]}],
        "covered_requirement_ids":["r1"],"limitations":[]})


class BusinessContractTests(unittest.TestCase):
    def test_business_outcomes_remain_open_text_and_unverified(self):
        task="调查附近有没有适合建家的地方"
        c=TaskContract.parse(business_contract(task),[task],{})
        self.assertFalse(c.checks_ready)
        parsed=parse_stages([stage(task)],c,{"observe","goto"})
        self.assertEqual(parsed[0]["acceptance_checks"],[])
        self.assertEqual(set(parsed[0]["allowed_capabilities"]),{"observe","goto"})

    def test_coordinator_cannot_supply_tool_or_check_protocol(self):
        p=fixtures.proposal("coordinator","propose_contract",contract_draft=fixtures.contract())
        with self.assertRaisesRegex(ValidationError,"Coordinator"):
            parse_proposal(json.dumps(p),"coordinator",business=True)
        p=fixtures.proposal("coordinator","request_information",question="调查条件",evidence_refs=[])
        parse_proposal(json.dumps(p),"coordinator",business=True)
        p["payload"]["requested_capabilities"]=["deposit"]
        with self.assertRaises(ValidationError): parse_proposal(json.dumps(p),"coordinator",business=True)

    def test_context_contains_facts_without_executor_protocol(self):
        raw={"capabilities":{"deposit":{},"observe":{}},"observation":{"capabilities":["deposit"],"inventory":[]},
             "contract":{"deliverables":[{"acceptance_checks":[{"args":{"kind":"deposit"}}],"completion_criteria":["交付"]}]},
             "settled_actions":[{"args":{"kind":"deposit"}}],
             "evidence":[{"id":"e1","kind":"action","payload":{"args":{"kind":"deposit"},"status":"succeeded"}}]}
        projected=coordinator_context(raw)
        rendered=json.dumps(projected)
        for key in ["allowed_capabilities","acceptance_checks","settled_actions",'"args"','"deposit"']:
            self.assertNotIn(key,rendered)
        self.assertEqual(projected["evidence"][0]["id"],"e1")
        self.assertIn("deposit",WORKER_PROMPT)
        self.assertNotIn("deposit",COORDINATOR_PROMPT)


class BusinessRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        base=make_config(Path(self.tmp.name),max_steps=40,task_timeout=12)
        self.config=replace(base,orchestration=OrchestrationConfig(mode="hierarchical"))
        self.backend=FakeBackend([observation()]); self.runtime=None

    async def asyncTearDown(self):
        if self.runtime: self.runtime.store.close()
        self.tmp.cleanup()

    def create(self,team):
        self.runtime=TaskRuntime(self.backend,team,self.config)
        self.runtime.delivery.interval=0
        return self.runtime

    def plan(self,task):
        p=fixtures.proposal
        return [p("coordinator","propose_contract",contract_draft=business_contract(task)),
                p("coordinator","propose_plan",stages=[stage(task)],change_reason="按目标执行",based_on_evidence_ids=[]),
                p("coordinator","dispatch",stage_id="work")]

    async def test_worker_compiles_world_checks_and_only_two_roles_execute(self):
        task="到坐标1 70 2附近"
        goal={"type":"near_position","position":{"x":1,"y":70,"z":2},"range":1}
        p=fixtures.proposal
        checks=fixtures.contract(task,goal)["deliverables"][0]["acceptance_checks"]
        team=BusinessTeam(self.plan(task)+[final_report],[
            p("worker","prepare_verification",deliverables=[{"id":"d1","acceptance_checks":checks}],stage_checks=checks[:1]),
            p("worker","act",kind="goto",args={"position":goal["position"],"range":1},purpose="到达"),
            p("worker","submit_result",summary="申请验收",output_refs=[],evidence_ids=[],unresolved_items=[])])
        self.backend=FakeBackend([observation(),observation(x=1,y=70,z=2)])
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"completed",outcome.message)
        self.assertEqual(self.backend.act_calls,1)
        self.assertEqual(set(role for role,_ in team.calls),{"coordinator","worker"})
        self.assertIn("abilities",team.calls[0][1])
        self.assertNotIn("capabilities",team.calls[0][1])
        worker_contexts=[ctx for role,ctx in team.calls if role=="worker"]
        self.assertIn("capabilities",worker_contexts[0])

    async def test_mutation_without_prepared_checks_is_blocked(self):
        task="前往目标"; p=fixtures.proposal
        act=p("worker","act",kind="goto",args={"position":{"x":1,"y":70,"z":2},"range":1},purpose="到达")
        team=BusinessTeam(self.plan(task)+[p("coordinator","cannot_complete",reason_code="blocked",explanation="验收未准备",unmet_requirements=["r1"])],[act,act])
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"failed")
        self.assertEqual(self.backend.act_calls,0)

    async def test_worker_cannot_replace_frozen_root_checks(self):
        task="检查环境"; p=fixtures.proposal
        checks=fixtures.contract(task)["deliverables"][0]["acceptance_checks"]
        prepare=p("worker","prepare_verification",deliverables=[{"id":"d1","acceptance_checks":checks}],
            stage_checks=[{"kind":"evidence_requirement","evidence_kind":"observe","selectors":[],"requirement_ids":["r1"]}])
        team=BusinessTeam(self.plan(task)+[p("coordinator","cannot_complete",reason_code="blocked",explanation="不能改写验收",unmet_requirements=["r1"])],[prepare,prepare,prepare])
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"failed")
        self.assertIn("冻结",self.runtime.snap["stages"][0]["block_reason"])
        self.assertEqual(self.backend.act_calls,0)

    async def test_report_cannot_complete_without_worker_preparation(self):
        task="描述环境"; p=fixtures.proposal
        team=BusinessTeam([p("coordinator","propose_contract",contract_draft=business_contract(task))]+[final_report]*3)
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"failed")
        self.assertEqual(self.backend.say_calls,[])
        self.assertNotIn("reviewer",[r for r,_ in team.calls])

    async def test_unknown_delivery_can_clarify_without_inventing_tools(self):
        p=fixtures.proposal
        team=BusinessTeam([p("coordinator","clarify",question="工具放在哪个箱子？",missing_fields=["交付方式"])])
        outcome=await self.create(team).run("给我一套石质工具")
        self.assertEqual(outcome.end_state,"needs_clarification")
        self.assertEqual(self.backend.act_calls,0)
        self.assertEqual([role for role,_ in team.calls],["coordinator"])

    async def test_investigation_prepares_report_and_returns_real_evidence(self):
        task="描述环境"; p=fixtures.proposal
        plan=self.plan(task); plan[1]["payload"]["stages"][0]["mode"]="investigate"
        checks=fixtures.contract(task)["deliverables"][0]["acceptance_checks"]
        local=[{"kind":"evidence_requirement","evidence_kind":"observe","selectors":[],"requirement_ids":["r1"]}]
        team=BusinessTeam(plan+[final_report],[
            p("worker","prepare_verification",deliverables=[{"id":"d1","acceptance_checks":checks}],stage_checks=local),
            p("worker","query",op="observe",args={},purpose="调查环境"),
            lambda ctx:p("worker","submit_result",summary="环境已观察",output_refs=[],
                         evidence_ids=[ctx["evidence"][-1]["id"]],unresolved_items=[])])
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"completed",outcome.message)
        self.assertEqual(self.backend.act_calls,0)
        worker=next(ctx for role,ctx in team.calls if role=="worker")
        self.assertEqual(worker["stage"]["allowed_capabilities"],["observe"])

    async def test_final_report_cannot_override_failed_world_check(self):
        task="到坐标100 64 0"; p=fixtures.proposal
        goal={"type":"near_position","position":{"x":100,"y":64,"z":0},"range":1}
        checks=fixtures.contract(task,goal)["deliverables"][0]["acceptance_checks"]
        local=[{"kind":"evidence_requirement","evidence_kind":"action", "selectors":[{"path":"args.kind","equals":"goto"}],"requirement_ids":["r1"]}]
        team=BusinessTeam(self.plan(task)+[final_report]*3,[
            p("worker","prepare_verification",deliverables=[{"id":"d1","acceptance_checks":checks}],stage_checks=local),
            p("worker","act",kind="goto",args={"position":goal["position"],"range":1},purpose="到达"),
            p("worker","submit_result",summary="动作返回成功",output_refs=[],evidence_ids=[],unresolved_items=[])])
        outcome=await self.create(team).run(task)
        self.assertEqual(outcome.end_state,"failed")
        self.assertEqual(self.backend.say_calls,[])
