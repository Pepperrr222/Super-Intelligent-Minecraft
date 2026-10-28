"""Two-role orchestration tests. Scripted models are not cloud acceptance."""
import asyncio
import copy
import json
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from sim_agent.agents.coordinator import AgentTeam
from sim_agent.app.config import OrchestrationConfig, load_config
from sim_agent.domain.contracts import TaskContract, parse_stages, parse_proposal
from sim_agent.domain.errors import ValidationError, DeadlineExceeded, TransportError
from sim_agent.domain.lifecycle import transition
from sim_agent.interaction.delivery import split_report
from sim_agent.orchestration.budget import Budget
from sim_agent.orchestration.task_runtime import TaskRuntime
from sim_agent.persistence.task_store import TaskStore
from sim_agent.execution.service import AgentService
from sim_agent.planning.model import ModelResult
from sim_agent.observability.jsonl import RuntimeLogs
from test_planner import make_config, observation, FakeBackend
from sim_agent.adapters.mock import MockBackend, SOURCE, TARGET


def proposal(role, decision_kind, **payload):
    return {"schema_version":role+"-proposal.v1","kind":decision_kind,"summary":"测试决策","payload":payload}


def contract(task="描述你所处的环境", goal=None):
    checks=[{"kind":"state_predicate","goal":goal,"scope":"root"}] if goal else [
        {"kind":"grounded_report","required_topics":["当前可观察环境"],"permitted_evidence_kinds":["observe"]}]
    checks.append({"kind":"delivery_submission","channel":"game_chat"})
    return {"intent_summary":task,"requirements":[{"id":"r1","text":task,"source_refs":[task]}],
            "constraints":{},"deliverables":[{"id":"d1","description":task,"requirement_ids":["r1"],"acceptance_checks":checks}],
            "bindings":[],"unknowns":[]}


def report(context, draft=None):
    es=context["evidence"]
    latest=next(e for e in reversed(es) if e['kind']=='observe')
    inventory=latest['payload'].get('inventory',[])
    statement='当前位于主世界，背包为空。' if not inventory else '当前背包：'+json.dumps(inventory,ensure_ascii=False)
    payload={"report":{"text":statement,"claims":[{"text":statement,"kind":"observed","evidence_refs":[latest["id"]]}],
                       "covered_requirement_ids":["r1"],"limitations":[]},"requirement_ids":["r1"]}
    if draft: payload["contract_draft"]=draft
    return proposal("coordinator","submit_report",**payload)


class ScriptedTeam(AgentTeam):
    # Existing execution fixtures supply compiled checks directly; live roles use business.v2.
    protocol_version="internal.v1"
    def __init__(self, coordinator, worker=(), review=None):
        self.queues={"coordinator":list(coordinator),"worker":list(worker)}
        self.calls=[]; self.review=review
        self.is_real_model=False

    async def call(self,role,context,timeout,observer):
        self.calls.append((role,copy.deepcopy(context)))
        if role=="reviewer": value=self.review or {"verdict":"supported","issues":[]}
        else:
            if not self.queues[role]: raise AssertionError("Scripted model ran out: "+role)
            value=self.queues[role].pop(0)
            if callable(value): value=value(context)
        observer({"type":"model_delta","channel":"reasoning","text":role+" 实际测试输出"})
        observer({"type":"model_delta","channel":"decision","text":json.dumps(value,ensure_ascii=False)})
        return ModelResult(json.dumps(value,ensure_ascii=False),{"total_tokens":10},"scripted")


class ContractTests(unittest.TestCase):
    def test_report_contract_has_no_game_goal(self):
        c=TaskContract.parse(contract(),["描述你所处的环境"],{})
        self.assertFalse(any(k["kind"]=="state_predicate" for k in c.checks))

    def test_fake_source_and_uncovered_requirement_rejected(self):
        d=contract(); d["requirements"][0]["source_refs"]=["假的原文"]
        with self.assertRaises(ValidationError): TaskContract.parse(d,["描述你所处的环境"],{})
        d=contract(); d["requirements"].append({"id":"r2","text":"环境","source_refs":["环境"]})
        with self.assertRaises(ValidationError): TaskContract.parse(d,["描述你所处的环境"],{})

    def test_root_cannot_use_stage_baseline(self):
        d=contract(goal={"type":"inventory_delta","item":"minecraft:oak_log","delta":1})
        d["deliverables"][0]["acceptance_checks"][0]["scope"]="stage"
        with self.assertRaises(ValidationError): TaskContract.parse(d,["描述你所处的环境"],{})

    def test_constraints_cannot_be_relaxed(self):
        d=contract(); d["constraints"]={"no_move":False,"keep_inventory":{"minecraft:oak_planks":1}}
        c=TaskContract.parse(d,["描述你所处的环境"],{"no_move":True,"keep_inventory":{"minecraft:oak_planks":3}})
        self.assertTrue(c.data["constraints"]["no_move"])
        self.assertEqual(c.data["constraints"]["keep_inventory"]["minecraft:oak_planks"],3)

    def test_cycle_and_missing_dependency_rejected(self):
        c=TaskContract.parse(contract(),["描述你所处的环境"],{})
        s={"id":"a","title":"观察","objective":"观察","requirement_ids":["r1"],"dependencies":["a"],
           "allowed_capabilities":["observe"],"acceptance_checks":[{"kind":"evidence_requirement","evidence_kind":"observe","selectors":[],"requirement_ids":["r1"]}]}
        for dep in ["a","missing"]:
            s["dependencies"]=[dep]
            with self.assertRaises(ValidationError): parse_stages([s],c,{"observe"})

    def test_role_cannot_execute_other_role_protocol(self):
        p=proposal("worker","act",kind="goto",args={},purpose="测试")
        with self.assertRaises(ValidationError): parse_proposal(json.dumps(p),"coordinator")

    def test_terminal_cannot_revive(self):
        with self.assertRaises(ValidationError): transition("completed","planning")

    def test_unicode_length_and_command_rejection(self):
        parts=split_report("😀"*200)
        self.assertTrue(all(len(p.encode("utf-16-le"))//2<=190 for p in parts))
        self.assertEqual("".join(p.split(' ',1)[1] for p in parts),"😀"*200)
        for bad in ["/op player","abc\x00"]:
            with self.assertRaises(ValidationError): split_report(bad)

    def test_budget_restore_does_not_reset_counts(self):
        b=Budget(100,3,2); b.take("call"); b.take("tool")
        b=Budget(100,3,2,b.snapshot()); b.take("call")
        with self.assertRaises(DeadlineExceeded): b.take("call")
        self.assertEqual(b.tools,1)

    def test_worker_cannot_own_chat_delivery_stage(self):
        c=TaskContract.parse(contract(),['描述你所处的环境'],{})
        s={'id':'report','title':'报告','objective':'报告','requirement_ids':['r1'],'dependencies':[],
           'allowed_capabilities':['say'],'acceptance_checks':[{'kind':'delivery_submission','channel':'game_chat'}]}
        with self.assertRaisesRegex(ValidationError,'say'): parse_stages([s],c,{'observe'})
        s['allowed_capabilities']=['observe']
        with self.assertRaisesRegex(ValidationError,'Coordinator'): parse_stages([s],c,{'observe'})

    def test_invalid_json_reports_repair_location(self):
        with self.assertRaisesRegex(ValidationError,'右括号'):
            parse_proposal('{"a":1}}','coordinator')

    def test_constraint_revision_requires_explicit_revision_path(self):
        d=contract();d['constraints']={'no_move':False}
        normal=TaskContract.parse(d,['描述你所处的环境'],{'no_move':True})
        revised=TaskContract.parse(d,['描述你所处的环境'],{'no_move':True},user_revision=True)
        self.assertTrue(normal.data['constraints']['no_move'])
        self.assertFalse(revised.data['constraints']['no_move'])

    def test_stage_budget_and_unknown_checks_rejected(self):
        c=TaskContract.parse(contract(),['描述你所处的环境'],{})
        s={'id':'look','title':'观察','objective':'观察','requirement_ids':['r1'],'dependencies':[],
           'allowed_capabilities':['observe'],'acceptance_checks':[{'kind':'semantic_review','rubric':'当前观察','requirement_ids':['r1']}],
           'budget':{'max_tools':False}}
        with self.assertRaises(ValidationError): parse_stages([s],c,{'observe'})
        d=contract();d['deliverables'][0]['acceptance_checks'][0]={'kind':'eval','expression':'True'}
        with self.assertRaises(ValidationError): TaskContract.parse(d,['描述你所处的环境'],{})

    def test_invalid_evidence_field_rejected_before_actions(self):
        d=contract()
        d['deliverables'][0]['acceptance_checks'][0]={'kind':'evidence_requirement','evidence_kind':'action',
            'selectors':[{'path':'args.recipe','equals':'minecraft:oak_planks'}],'requirement_ids':['r1']}
        with self.assertRaisesRegex(ValidationError,'args.item'): TaskContract.parse(d,['描述你所处的环境'],{})

    def test_partial_replan_may_depend_on_verified_previous_stage(self):
        c=TaskContract.parse(contract(),['描述你所处的环境'],{})
        s={'id':'next','title':'后续','objective':'后续观察','requirement_ids':['r1'],'dependencies':['already_done'],
           'allowed_capabilities':['observe'],'acceptance_checks':[{'kind':'evidence_requirement','evidence_kind':'observe',
           'selectors':[],'requirement_ids':['r1']}]}
        parsed=parse_stages([s],c,{'observe'},completed_ids={'already_done'})
        self.assertEqual(parsed[0]['dependencies'],['already_done'])


class HierarchicalTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        base=make_config(Path(self.tmp.name),max_steps=40,task_timeout=12)
        self.config=replace(base,orchestration=OrchestrationConfig(mode="hierarchical"),agent=replace(base.agent,owner="*"))
        self.backend=FakeBackend([observation()])
        self.runtime=None

    async def asyncTearDown(self):
        if self.runtime: self.runtime.store.close()
        self.tmp.cleanup()

    def create(self,team,backend=None,logs=None):
        self.runtime=TaskRuntime(backend or self.backend,team,self.config,logs)
        self.runtime.delivery.interval=0
        return self.runtime

    async def test_environment_description_delivered_without_goal_or_mutation(self):
        team=ScriptedTeam([lambda c:report(c,contract())])
        r=self.create(team)
        result=await r.run("描述你所处的环境",requested_by="PlayerA",raw_chat="!agent 描述你所处的环境")
        self.assertEqual(result.end_state,"completed",result.message)
        self.assertEqual(result.delivery_status,"submitted")
        self.assertEqual(self.backend.act_calls,0)
        self.assertEqual(self.backend.say_calls,["当前位于主世界，背包为空。"])
        self.assertIsNone(r.state.goal)
        ctx=team.calls[0][1]
        self.assertEqual(ctx["original_request"]["raw_chat"],"!agent 描述你所处的环境")

    async def test_independent_worker_context_and_fresh_arrival(self):
        task="去坐标1 64 2，到后告诉我"
        goal={"type":"near_position","position":{"x":1,"y":64,"z":2},"range":1}
        d=contract(task,goal)
        stage={"id":"travel","title":"移动","objective":"到达目标","requirement_ids":["r1"],"dependencies":[],
               "allowed_capabilities":["goto"],"acceptance_checks":[{"kind":"state_predicate","goal":goal,"scope":"root"}]}
        team=ScriptedTeam([proposal("coordinator","propose_contract",contract_draft=d),
            proposal("coordinator","propose_plan",stages=[stage],change_reason="初始计划",based_on_evidence_ids=[]),
            proposal("coordinator","dispatch",stage_id="travel"),lambda c:report(c)],
            [proposal("worker","act",kind="goto",args={"position":goal["position"],"range":1},purpose="到达"),
             proposal("worker","submit_result",summary="申请复核",output_refs=[],evidence_ids=[],unresolved_items=[])])
        backend=FakeBackend([observation(),observation(x=1,z=2)])
        result=await self.create(team,backend).run(task)
        self.assertEqual(result.end_state,"completed",result.message)
        self.assertEqual(backend.act_calls,1)
        roles=[r for r,c in team.calls]
        self.assertIn("worker",roles)
        worker=next(c for r,c in team.calls if r=="worker")
        self.assertEqual(worker["stage"]["id"],"travel")
        self.assertIsNone(team.calls[0][1]["stage"])

    async def test_mismatched_contract_never_mutates(self):
        invalid=contract(); invalid["requirements"][0]["source_refs"]=["不存在的指令"]
        p=proposal("coordinator","propose_contract",contract_draft=invalid)
        team=ScriptedTeam([p]*3)
        result=await self.create(team).run("描述你所处的环境")
        self.assertEqual(result.end_state,"failed")
        self.assertEqual(self.backend.act_calls,0)

    async def test_clarification_preserves_original_and_shared_answer(self):
        team=ScriptedTeam([proposal("coordinator","clarify",question="请给出对象",missing_fields=["对象"]),
                           lambda c:report(c,contract("看环境"))])
        r=self.create(team)
        first=await r.run("看环境")
        second=await r.run("当前位置",continuation_context={"previous_root_task_id":first.root_task_id,"answer":"当前位置"},requested_by="PlayerB")
        self.assertEqual(second.end_state,"completed",second.message)
        self.assertEqual(first.root_task_id,second.root_task_id)
        ctx=[c for role,c in team.calls if role=="coordinator"][-1]
        self.assertEqual(ctx["original_request"]["command_text"],"看环境")
        self.assertEqual(ctx["original_request"]["amendments"][0]["author"],"PlayerB")
        self.assertGreater(second.usage["planning_calls"],first.usage["planning_calls"])

    async def test_unknown_mutation_never_replayed_on_resume(self):
        team=ScriptedTeam([proposal("coordinator","clarify",question="补充信息",missing_fields=[])])
        r=self.create(team)
        first=await r.run("看环境")
        r.store.journal(first.root_task_id,"old-session",{"status":"unknown","op":"act","args":{"kind":"deposit","count":8}})
        saved=r.store.read_task(first.root_task_id); saved["status"]="interrupted"
        r.store.commit_transition(saved["revision"],{"type":"test_crash"},saved)
        before=len(team.calls)
        result=await r.run("看环境",resume_root=first.root_task_id)
        self.assertEqual(result.end_state,"needs_clarification")
        self.assertEqual(len(team.calls),before)
        self.assertEqual(self.backend.act_calls,0)

    async def test_forged_evidence_report_is_rejected(self):
        def bad(c):
            p=report(c,contract()); p["payload"]["report"]["claims"][0]["evidence_refs"]=["fake-evidence"]
            return p
        result=await self.create(ScriptedTeam([bad]*3)).run("描述你所处的环境")
        self.assertEqual(result.end_state,"failed")
        self.assertEqual(self.backend.say_calls,[])

    async def test_delivery_timeout_preserves_verified_work(self):
        class LostSay(FakeBackend):
            async def request(self,op,args,timeout=None):
                if op=="say": raise TransportError("lost receipt")
                return await super().request(op,args,timeout)
        r=self.create(ScriptedTeam([lambda c:report(c,contract())]),LostSay([observation()]))
        outcome=await r.run("描述你所处的环境")
        self.assertEqual(outcome.end_state,"interrupted")
        self.assertEqual(outcome.work_status,"verified")
        self.assertNotEqual(outcome.delivery_status,"submitted")
        resumed=await r.run("描述你所处的环境",resume_root=outcome.root_task_id)
        self.assertNotEqual(resumed.end_state,"completed")
        self.assertEqual(r.state.steps,[])

    async def test_cancel_during_stubborn_model_discards_late_output(self):
        started=asyncio.Event(); release=asyncio.Event()
        class Late(ScriptedTeam):
            async def call(self,role,ctx,timeout,observer):
                started.set()
                try: await release.wait()
                except asyncio.CancelledError: await release.wait()
                return ModelResult(json.dumps(report(ctx,contract())),{},"late")
        r=self.create(Late([]))
        running=asyncio.create_task(r.run("描述你所处的环境"))
        await asyncio.wait_for(started.wait(),2)
        await r.cancel("玩家停止")
        result=await asyncio.wait_for(running,2)
        release.set(); await asyncio.sleep(.02)
        self.assertEqual(result.end_state,"cancelled")
        self.assertGreater(self.backend.stop_calls,0)
        self.assertEqual(self.backend.say_calls,[])

    async def test_root_store_revision_and_recovery_are_conservative(self):
        r=self.create(ScriptedTeam([proposal("coordinator","clarify",question="哪儿",missing_fields=[])]))
        outcome=await r.run("看环境")
        snap=r.store.read_task(outcome.root_task_id)
        with self.assertRaises(ValidationError): r.store.commit_transition(0,{},snap)
        snap["status"]="executing"; r.store.commit_transition(snap["revision"],{},snap)
        r.store.mark_interrupted()
        self.assertEqual(r.store.read_task(outcome.root_task_id)["status"],"interrupted")

    async def test_true_role_archive_and_no_learning_context(self):
        logs=RuntimeLogs(self.config.runtime_dir)
        team=ScriptedTeam([lambda c:report(c,contract())])
        try:
            outcome=await self.create(team,logs=logs).run("描述你所处的环境")
            self.assertEqual(outcome.end_state,"completed",outcome.message)
            calls=[json.loads(p.read_text(encoding="utf-8")) for p in logs.calls_dir.glob('call-*.json')]
            self.assertEqual({c["role"] for c in calls},{"coordinator"})
            self.assertTrue(all(c["status"]=="completed" for c in calls))
            self.assertTrue(all("experience" not in ctx for role,ctx in team.calls))
        finally: logs.close()

    async def test_composite_delivery_preserves_root_baselines(self):
        task="从坐标0 64 0箱取2个原木，制作8块木板放坐标4 64 0箱，保留原有3块木板，不砍树，报告来源"
        goal={"type":"all_of","goals":[
            {"type":"container_delta","position":SOURCE,"item":"minecraft:oak_log","delta":-2},
            {"type":"container_delta","position":TARGET,"item":"minecraft:oak_planks","delta":8},
            {"type":"inventory_delta","item":"minecraft:oak_planks","delta":0},
            {"type":"inventory_delta","item":"minecraft:oak_log","delta":0}]}
        d=contract(task,goal); d["constraints"]={"no_collect":True,"keep_inventory":{"minecraft:oak_planks":3}}
        def stage(sid,depends,cap,goal):
            return {"id":sid,"title":sid,"objective":sid,"requirement_ids":["r1"],"dependencies":depends,
                    "allowed_capabilities":[cap],"acceptance_checks":[{"kind":"state_predicate","goal":goal,"scope":"stage"}]}
        stages=[stage("source",[],"withdraw",{"type":"inventory_increase","item":"minecraft:oak_log","count":2}),
                stage("make",["source"],"craft",{"type":"inventory_increase","item":"minecraft:oak_planks","count":8}),
                stage("deliver",["make"],"deposit",{"type":"container_delta","position":TARGET,"item":"minecraft:oak_planks","delta":8})]
        done=proposal("worker","submit_result",summary="请验收",output_refs=[],evidence_ids=[],unresolved_items=[])
        class ChatMock(MockBackend):
            def __init__(self): super().__init__(); self.inventory={"minecraft:oak_planks":3}; self.messages=[]
            async def request(self,op,args,timeout=None):
                if op=="say": self.messages.append(args['message']); return {"sent":True}
                return await super().request(op,args,timeout)
        backend=ChatMock()
        team=ScriptedTeam([proposal("coordinator","propose_contract",contract_draft=d),
            proposal("coordinator","propose_plan",stages=stages,change_reason="准备、制作与交付",based_on_evidence_ids=[]),
            *[proposal("coordinator","dispatch",stage_id=s["id"]) for s in stages],lambda c:report(c)],
            [proposal("worker","act",kind="withdraw",args={"position":SOURCE,"item":"minecraft:oak_log","count":2},purpose="取料"),done,
             proposal("worker","act",kind="craft",args={"item":"minecraft:oak_planks","count":8},purpose="制作"),done,
             proposal("worker","act",kind="deposit",args={"position":TARGET,"item":"minecraft:oak_planks","count":8},purpose="交付"),done])
        result=await self.create(team,backend).run(task)
        self.assertEqual(result.end_state,"completed",result.message)
        self.assertEqual(backend.inventory.get('minecraft:oak_planks'),3)
        self.assertEqual(backend.containers[4].get('minecraft:oak_planks'),8)
        self.assertEqual(sum(a['kind']=='craft' for a in backend.actions.values()),1)
        self.assertEqual(len(self.runtime.snap['stages']),3)

    async def test_shared_service_delivers_once_and_blocks_pending_new_task(self):
        team=ScriptedTeam([proposal('coordinator','clarify',question='请确认环境范围',missing_fields=['范围']),
                           lambda c:report(c,contract('描述环境'))])
        service=AgentService(self.backend,team,self.config,emit=lambda _:None,chat_progress=False)
        service._runner.delivery.interval=0
        try:
            self.assertEqual(await service.handle_chat('PlayerA','!agent 描述环境'),'started')
            await service._wait_current(3)
            self.assertEqual(service._last_outcome.end_state,'needs_clarification')
            self.assertEqual(await service.handle_chat('PlayerC','!agent 新任务'),'busy')
            self.assertEqual(await service.handle_chat('PlayerB','!agent 回答 当前可观察范围'),'started')
            await service._wait_current(3)
            self.assertTrue(service._last_outcome.completed,service._last_outcome.message)
            self.assertEqual(self.backend.say_calls.count('当前位于主世界，背包为空。'),1)
            self.assertEqual(await service.handle_chat('PlayerC','!agent 回答 再回答'),'idle')
        finally: await service.shutdown()

    async def test_unsupported_request_does_not_substitute_follow(self):
        r=self.create(ScriptedTeam([proposal('coordinator','cannot_complete',reason_code='unsupported',
            explanation='当前原版执行器没有攻击能力，无法执行此要求。',unmet_requirements=['攻击'])]))
        result=await r.run('攻击附近僵尸')
        self.assertEqual(result.end_state,'failed'); self.assertEqual(self.backend.act_calls,0)

    async def test_inspection_without_binding_cannot_navigate(self):
        r=self.create(ScriptedTeam([]))
        r.snap={'request':{'command_text':'放到那个箱子','amendments':[]},'contract':{'bindings':[]}}
        with self.assertRaises(ValidationError): r._bind_position({'x':1,'y':64,'z':2})
        self.assertEqual(self.backend.inspect_calls,0)

    async def test_correction_after_craft_only_delivers_remaining_work(self):
        task='从坐标0 64 0取2根原木，制作8块木板，放到坐标4 64 0箱子，保留3块木板并报告'
        other={'x':8,'y':64,'z':0}
        def build_contract(destination):
            goal={'type':'all_of','goals':[
                {'type':'container_delta','position':SOURCE,'item':'minecraft:oak_log','delta':-2},
                {'type':'container_delta','position':destination,'item':'minecraft:oak_planks','delta':8},
                {'type':'inventory_delta','item':'minecraft:oak_planks','delta':0}]}
            d=contract(task,goal); d['constraints']={'keep_inventory':{'minecraft:oak_planks':3}}
            return d
        made=asyncio.Event()
        class PauseBeforeDelivery(ScriptedTeam):
            async def call(self,role,context,timeout,observer):
                if role=='coordinator' and len(context.get('progress',[]))>=1:
                    made.set(); await asyncio.Event().wait()
                return await super().call(role,context,timeout,observer)
        class ChatMock(MockBackend):
            def __init__(self): super().__init__(); self.inventory={'minecraft:oak_planks':3}; self.containers[8]={}
        initial_stage={'id':'make','title':'准备成品','objective':'取料并制作8块木板','requirement_ids':['r1'],'dependencies':[],
            'allowed_capabilities':['withdraw','craft'],'acceptance_checks':[{'kind':'state_predicate','scope':'stage',
            'goal':{'type':'inventory_increase','item':'minecraft:oak_planks','count':8}}]}
        done=proposal('worker','submit_result',summary='申请验收',output_refs=[],evidence_ids=[],unresolved_items=[])
        team=PauseBeforeDelivery([proposal('coordinator','propose_contract',contract_draft=build_contract(TARGET)),
            proposal('coordinator','propose_plan',stages=[initial_stage],change_reason='准备',based_on_evidence_ids=[]),
            proposal('coordinator','dispatch',stage_id='make')],[
            proposal('worker','act',kind='withdraw',args={'position':SOURCE,'item':'minecraft:oak_log','count':2},purpose='取料'),
            proposal('worker','act',kind='craft',args={'item':'minecraft:oak_planks','count':8},purpose='制作'),done])
        backend=ChatMock(); runtime=self.create(team,backend)
        running=asyncio.create_task(runtime.run(task))
        await asyncio.wait_for(made.wait(),3)
        await runtime.cancel('玩家纠正目标箱')
        first=await running
        saved_calls=runtime.budget.calls
        deliver={'id':'deliver_new','title':'新箱交付','objective':'把成品交到新箱','requirement_ids':['r1'],'dependencies':[],
            'allowed_capabilities':['deposit'],'acceptance_checks':[{'kind':'state_predicate','scope':'stage',
            'goal':{'type':'container_delta','position':other,'item':'minecraft:oak_planks','delta':8}}]}
        runtime.team=ScriptedTeam([proposal('coordinator','propose_contract',contract_draft=build_contract(other)),
            proposal('coordinator','propose_plan',stages=[deliver],change_reason='用户改箱，制作已完成',based_on_evidence_ids=[]),
            proposal('coordinator','dispatch',stage_id='deliver_new'),lambda c:report(c)],[
            proposal('worker','act',kind='deposit',args={'position':other,'item':'minecraft:oak_planks','count':8},purpose='交付已有成品'),done])
        second=await runtime.run('改放坐标8 64 0，其他要求不变',requested_by='PlayerB',continuation_context={
            'previous_root_task_id':first.root_task_id,'correction':'改放坐标8 64 0，其他要求不变'})
        self.assertEqual(second.end_state,'completed',second.message)
        self.assertEqual(backend.containers[8]['minecraft:oak_planks'],8)
        self.assertEqual(backend.containers[4],{})
        self.assertEqual(sum(a['kind']=='craft' for a in backend.actions.values()),1)
        self.assertEqual(backend.inventory['minecraft:oak_planks'],3)
        self.assertGreater(runtime.budget.calls,saved_calls)
        self.assertEqual(first.root_task_id,second.root_task_id)

    async def test_cancelled_pending_question_cannot_be_revived_by_answer(self):
        r=self.create(ScriptedTeam([proposal('coordinator','clarify',question='哪里',missing_fields=[])]))
        first=await r.run('看环境'); r.discard_pending(first.root_task_id)
        with self.assertRaises(ValidationError):
            await r.run('坐标0 64 0',continuation_context={'previous_root_task_id':first.root_task_id,'answer':'坐标0 64 0'})
        with self.assertRaises(ValidationError): await r.run('看环境',resume_root=first.root_task_id)
        self.assertFalse(r.active)

    async def test_repeat_observations_block_instead_of_infinite_loop(self):
        task='描述环境'
        s={'id':'look','title':'补充观察','objective':'观察','requirement_ids':['r1'],'dependencies':[],
           'allowed_capabilities':['observe'],'acceptance_checks':[{'kind':'evidence_requirement','evidence_kind':'observe',
           'selectors':[],'requirement_ids':['r1']}]}
        query=proposal('worker','query',op='observe',args={},purpose='检查')
        team=ScriptedTeam([proposal('coordinator','propose_contract',contract_draft=contract(task)),
            proposal('coordinator','propose_plan',stages=[s],change_reason='观察',based_on_evidence_ids=[]),
            proposal('coordinator','dispatch',stage_id='look'),proposal('coordinator','cannot_complete',reason_code='blocked',explanation='无新增事实',unmet_requirements=['r1'])],
            [query]*5)
        result=await self.create(team).run(task)
        self.assertEqual(result.end_state,'failed')
        self.assertEqual(len([x for x in team.calls if x[0]=='worker']),2)
        self.assertEqual(self.runtime.snap['stages'][0]['status'],'blocked')

    async def test_crash_after_terminal_journal_restores_result_not_action(self):
        r=self.create(ScriptedTeam([proposal('coordinator','clarify',question='哪里',missing_fields=[]),lambda c:report(c,contract('看环境'))]))
        first=await r.run('看环境')
        r.store.journal(first.root_task_id,'old-session',{'status':'settled','op':'act','args':{'kind':'craft','item':'minecraft:oak_planks','count':8},
            'action_id':'old-action','stage_id':'old-stage','result':{'status':'succeeded','action_id':'old-action'}})
        saved=r.store.read_task(first.root_task_id); saved['status']='interrupted'
        r.store.commit_transition(saved['revision'],{},saved)
        second=await r.run('看环境',resume_root=first.root_task_id)
        self.assertEqual(second.end_state,'completed',second.message)
        self.assertEqual(self.backend.act_calls,0)
        self.assertEqual(r.state.steps[0].action_id,'old-action')

    async def test_history_explanation_uses_session_result_not_learning(self):
        task='解释刚才为什么失败'
        def history_report(ctx):
            p=report(ctx,contract(task))
            p['payload']['contract_draft']['deliverables'][0]['acceptance_checks'][0]['permitted_evidence_kinds']=['task_history']
            p['payload']['report']['text']='上次任务因缺少材料而失败。'
            p['payload']['report']['claims']=[{'text':'缺少材料','kind':'observed','evidence_refs':[
                next(e['id'] for e in ctx['evidence'] if e['kind']=='task_history')]}]
            return p
        r=self.create(ScriptedTeam([history_report]))
        result=await r.run(task,continuation_context={'session_previous_outcome':{
            'task_id':'previous','end_state':'failed','message':'缺少材料','steps':[],'world_id':'basic-lab-v1'}})
        self.assertEqual(result.end_state,'completed',result.message)
        self.assertEqual(self.backend.act_calls,0)

    async def test_cli_report_submits_to_terminal_not_game(self):
        def cli_report(ctx):
            p=report(ctx,contract())
            p['payload']['contract_draft']['deliverables'][0]['acceptance_checks'][-1]['channel']='cli'
            return p
        output=[]
        service=AgentService(self.backend,ScriptedTeam([cli_report]),self.config,emit=output.append,chat_progress=False)
        try:
            result=await service.run_single('描述你所处的环境')
            self.assertTrue(result.completed,result.message)
            self.assertIn('当前位于主世界，背包为空。',output)
            self.assertEqual(self.backend.say_calls,[])
        finally: await service.shutdown()

    async def test_program_rejects_old_container_stock_as_new_work(self):
        task='在坐标4 64 0箱子新增8块木板'
        goal={'type':'container_delta','position':TARGET,'item':'minecraft:oak_planks','delta':8}
        d=contract(task,goal)
        # Root baselines must precede any production. Populate an explicit no-change baseline for this verification probe.
        team=ScriptedTeam([proposal('coordinator','propose_contract',contract_draft=d),lambda c:report(c),
            proposal('coordinator','cannot_complete',reason_code='not_done',explanation='尚未新增',unmet_requirements=['r1'])])
        container={'position':TARGET,'items':[{'name':'minecraft:oak_planks','count':100}],'world_id':'basic-lab-v1'}
        r=self.create(team,FakeBackend([observation()],inspect_results=[container]))
        result=await r.run(task)
        self.assertEqual(result.end_state,'failed')
        self.assertEqual(r._backend.say_calls,[])

    async def test_dashboard_projects_task_tree_and_role_archives(self):
        from sim_agent.app.dashboard import snapshot,read_model_call
        logs=RuntimeLogs(self.config.runtime_dir)
        try:
            r=self.create(ScriptedTeam([lambda c:report(c,contract())]),logs=logs)
            outcome=await r.run('描述你所处的环境')
            view=snapshot(self.config.runtime_dir)
            task=view['tasks'][0]
            self.assertEqual(task['mode'],'hierarchical')
            self.assertEqual(task['contract']['intent_summary'],'描述你所处的环境')
            self.assertEqual(task['delivery_status'],'submitted')
            self.assertEqual(task['root_task_id'],outcome.root_task_id)
            self.assertEqual({c['role'] for c in view['model_calls']},{'coordinator'})
            self.assertIsNone(read_model_call(self.config.runtime_dir,'../../config.json'))
        finally: logs.close()

    async def test_removed_reviewer_is_never_called(self):
        team=ScriptedTeam([lambda c:report(c,contract())],review={'verdict':'mismatch','issues':['不应参与']})
        outcome=await self.create(team).run('描述你所处的环境')
        self.assertEqual(outcome.end_state,'completed')
        self.assertEqual([role for role,_ in team.calls],['coordinator'])

    async def test_old_semantic_check_does_not_auto_pass(self):
        d=contract(); d['deliverables'][0]['acceptance_checks'].append(
            {'kind':'semantic_review','rubric':'旧审查器','requirement_ids':['r1']})
        team=ScriptedTeam([lambda c:report(c,d)]*3)
        result=await self.create(team).run('描述你所处的环境')
        self.assertEqual(result.end_state,'failed')
        self.assertEqual(self.backend.say_calls,[])
        self.assertNotIn('reviewer',[role for role,_ in team.calls])


if __name__=="__main__": unittest.main()
